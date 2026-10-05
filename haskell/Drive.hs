{-# LANGUAGE OverloadedStrings #-}

-- | The reference driver: CORE.tex "Running and wrapping" (drive) and
-- "Processes"; PROTOCOL.tex "The reference driver" (the tree, marks, rounds,
-- heights, answers), Commands (runs, stopped, batch, fire). Owner: the
-- Drive+Program agent.
--
-- State: IORefs created in 'drive'.
--
-- Conventions this module keeps (other modules rely on them):
--
-- * Time: every change op through the driver's iOp gets @stampTime = Just
--   (last + 1)@, where last is the time of the last change that applied (0
--   at first); a failed op consumes no time.
-- * Process nodes are learnt from the make changes that pass through the
--   driver: a node whose fixed data is an object with a "path"
--   (PROTOCOL "The tree"). Its path is data.path; one that is not a path
--   (pathFrom) fails each of its runs with @{"kind": "invalid", "op":
--   "path"}@, before the program slots are read.
-- * Housekeeping reads (the tree walk, reading a process's current value to
--   compare) use 'hostCtx' on the layer BENEATH protect (the bare graph),
--   since PROTOCOL says they read beneath protect.
-- * Runs are bound from the TOP (told by iSetTop): compute
--   @bind top (Ctx agent (Just p) path ReadOnly Nothing)@ wrapped by
--   @iRecord top@; the program slots and program nodes are read through
--   'recordingQuiet' and reported with 'recordingModify'; the value write
--   and the effect use @recordingWith rec (bind top ctx{ctxMode=WriteOnly})@
--   so their changes land in 'recordChanges' in order; cleanups and handlers
--   use the lasting interface (bind top, WriteOnly, no run), and cleanup
--   changes are put in 'recordCleanup' (or 'Stopped').
-- * A change op from inside a run, a cleanup or a handler, or inside a
--   batch, only queues what it marked; rounds run from the outermost
--   request. Main calls 'driverTake' after every request to get the runs and
--   stopped for the answer.
--
-- How the spec's rules are kept, and readings of it chosen here (NOTES.md
-- lists the open ones):
--
-- * A process whose compute runs twice in one round has two runs: the
--   earlier record is finished (with no effect) just before the later
--   compute starts. The effect runs once, at the end of the round, in the
--   last run's record, if the last compute returned a value and either the
--   process has not returned one since it started or the driver wrote its
--   value at any point in the round.
-- * An effect's @previous@ is the process node's value before this run
--   (read before the compute's value is written), absent on the first run
--   since the process started, or when the node was absent.
-- * The previous effect's cleanup runs whenever the effect would run (the
--   compute returned a value, and it is the first value since the start or
--   the driver wrote it), even when the effect slot is gone.
-- * Handlers and cleanups before an effect use a lasting interface that
--   stops working (every operation is invalid) once the process stops or
--   restarts. The cleanup the stop itself runs keeps working.
-- * @stopped@ lists stops in the order they were decided: within one walk,
--   in the order the previous walk reached them; a stop caused by a stopped
--   process's cleanup comes after it.
-- * When the read of a program node is refused, the record still has the
--   compute (or effect) entry, with node and slot and no saw. When the read
--   of the slot itself is refused, the slot is not known and the entry is
--   left out.
-- * A program node whose value the loader rejects fails the run with an
--   error @{"kind": "invalid", "op": "compute"|"effect"}@, as a gone
--   compute slot does.
-- * A run's ending: refused if any error in its record is a refusal, else
--   failed if there is any error or an uncaught throw, else pending or done.
-- * A cleanup's own errors and throws are dropped: it runs outside any run.
module Drive
  ( drive
  ) where

import Control.Exception (finally)
import Control.Monad (forM_, unless, when)
import Data.IORef
import Data.List (sortOn)
import qualified Data.Map.Strict as Map
import Data.Maybe (fromMaybe)
import qualified Data.Set as Set
import Data.Text (Text)
import Json
import Types

-- | A running process.
data Proc = Proc
  { pAgent :: Value
  , pPath :: Either Text Path -- ^ data.path; Left when it is not a path
  , pGen :: Int -- ^ which start this is (changes on every start)
  , pHeight :: Int
  , pReads :: Set.Set Id -- ^ nodes its last compute read
  , pWrote :: Set.Set Id -- ^ nodes its last effect changed
  , pHandlers :: Map.Map Text Handler
  , pCleanup :: Maybe Handler
  , pReturned :: Bool -- ^ a run of it has returned a value since it started
  , pRan :: Bool -- ^ it has run since it started
  }

-- | A due process: the changes that marked it, oldest first, and the time
-- of the first.
data Due = Due {dueMarks :: [Change], dueFirst :: Time}

data Outcome = OValue Value | OPending | OFailed | OThrew ThrownKind

-- | A run whose compute has run in this round and whose record is not yet
-- finished.
data RunState = RunState
  { rsRec :: Recording
  , rsGen :: Int
  , rsCtx :: Ctx -- ^ the run's ctx (ReadOnly)
  , rsOutcome :: Outcome
  , rsEffect :: Maybe Value -- ^ the effect program's value, read before the compute
  , rsPrevious :: Maybe Value -- ^ the process's value before this run; Nothing on its first run
  }

-- | A process's path, [] when its data.path is not a path (its runs fail
-- before anything uses it).
pathOf :: Proc -> Path
pathOf = either (const []) id . pPath

isChange :: Op -> Bool
isChange o = case o of
  OpMake {} -> True
  OpWrite {} -> True
  OpPlace {} -> True
  OpUnplace {} -> True
  _ -> False

-- | An interface that also collects the changes made through it.
collecting :: IORef [Change] -> Interface -> Interface
collecting ref i =
  i
    { iOp = \c s o -> do
        r <- iOp i c s o
        case r of
          Right (ResultApplied a) -> modifyIORef' ref (appliedChange a :)
          _ -> pure ()
        pure r
    }

-- | drive(inner, root, load), with @beneath@, the bare graph under protect,
-- for the driver's own bookkeeping.
drive :: Interface -> Interface -> Id -> Loader -> IO Driver
drive inner beneath root loader = do
  topRef <- newIORef inner
  lastTime <- newIORef (0 :: Time)
  procNodes <- newIORef (Map.empty :: Map.Map Id (Either Text Path))
  procs <- newIORef (Map.empty :: Map.Map Id Proc)
  runCounts <- newIORef (Map.empty :: Map.Map Id Int)
  genRef <- newIORef (0 :: Int)
  dueRef <- newIORef (Map.empty :: Map.Map Id Due)
  lastOrder <- newIORef ([] :: [Id])
  busy <- newIORef False
  ranRef <- newIORef ([] :: [Record]) -- newest first
  stoppedRef <- newIORef ([] :: [(Int, Stopped)]) -- newest first, with the order the stop was decided in
  stopSeq <- newIORef (0 :: Int)
  -- the current round
  roundRuns <- newIORef (Map.empty :: Map.Map Id RunState)
  roundOrder <- newIORef ([] :: [Id]) -- order computes last ran, newest first
  roundWrote <- newIORef (Set.empty :: Set.Set Id)

  let top = readIORef topRef

      addDue p c =
        modifyIORef' dueRef $
          Map.insertWith (\_ old -> old {dueMarks = dueMarks old ++ [c]}) p (Due [c] (changeTime c))

      lastingCtx p st = Ctx (pAgent st) (Just p) (pathOf st) WriteOnly Nothing

      -- an interface that works only while the process runs this same start
      alive p g i =
        i
          { iOp = \c s o -> do
              ps <- readIORef procs
              case Map.lookup p ps of
                Just cur | pGen cur == g -> iOp i c s o
                _ -> pure (Left (invalid ("process " <> p <> " has stopped: its lasting interface no longer works")))
          }

      -- runs a handler or cleanup with the process's lasting interface,
      -- collecting the changes it made; guarded, the interface stops working
      -- when the process stops
      runLasting guarded p st h input = do
        t <- top
        ref <- newIORef []
        let i = if guarded then alive p (pGen st) t else t
        err <- runHandler h (bind (collecting ref i) (lastingCtx p st)) p input
        chs <- reverse <$> readIORef ref
        pure (chs, err)

      -- the tree: process nodes reached beneath the root, in walk order
      walk = do
        nodes <- readIORef procNodes
        visited <- newIORef (Set.singleton root)
        out <- newIORef []
        let go n = do
              r <- iOp beneath hostCtx noStamp (OpDirectory (str n) Nothing)
              case r of
                Right (ResultDir (DirSeen (ListWhole slots) _)) ->
                  forM_ slots $ \(name, ids) ->
                    unless (name == "compute" || name == "effect") $
                      forM_ ids $ \i -> when (Map.member i nodes) $ do
                        v <- readIORef visited
                        unless (Set.member i v) $ do
                          modifyIORef' visited (Set.insert i)
                          modifyIORef' out (i :)
                          go i
                _ -> pure ()
        go root
        reverse <$> readIORef out

      reconcile c = do
        reached <- walk
        running <- readIORef procs
        before <- readIORef lastOrder
        nodes <- readIORef procNodes
        let reachedSet = Set.fromList reached
            index = Map.fromList (zip before [0 :: Int ..])
            toStop =
              sortOn (\p -> (fromMaybe maxBound (Map.lookup p index), p)) $
                [p | p <- Map.keys running, not (Set.member p reachedSet)]
            toStart = [p | p <- reached, not (Map.member p running)]
        writeIORef lastOrder reached
        forM_ toStart $ \p -> do
          g <- atomicModifyIORef' genRef (\x -> (x + 1, x + 1))
          let st =
                Proc
                  { pAgent = changeAgent c
                  , pPath = fromMaybe (Right []) (Map.lookup p nodes)
                  , pGen = g
                  , pHeight = 0
                  , pReads = Set.empty
                  , pWrote = Set.empty
                  , pHandlers = Map.empty
                  , pCleanup = Nothing
                  , pReturned = False
                  , pRan = False
                  }
          modifyIORef' procs (Map.insert p st)
          addDue p c
        let stopping = [(p, st) | p <- toStop, Just st <- [Map.lookup p running]]
        numbered <- mapM (\x -> atomicModifyIORef' stopSeq (\n -> (n + 1, (n, x)))) stopping
        forM_ stopping $ \(p, _) -> do
          modifyIORef' procs (Map.delete p)
          modifyIORef' dueRef (Map.delete p)
        forM_ numbered $ \(n, (p, st)) -> do
          chs <- case pCleanup st of
            Nothing -> pure []
            Just h -> fst <$> runLasting False p st h Nothing
          modifyIORef' stoppedRef ((n, Stopped p chs) :)

      afterChange a = do
        let c = appliedChange a
        writeIORef lastTime (changeTime c)
        case changeKind c of
          KindMake _ (Just d@(JObject _))
            | Just pv <- field "path" d -> modifyIORef' procNodes (Map.insert (changeNode c) (pathFrom pv))
          _ -> pure ()
        running <- readIORef procs
        forM_ (appliedMarked a) $ \m ->
          when (Map.member m running && Just m /= changeProcess c) (addDue m c)
        reconcile c

      -- runs act holding rounds; the outermost holder then runs rounds
      held act = do
        was <- readIORef busy
        writeIORef busy True
        if was
          then act
          else (act >>= \r -> runRounds >> pure r) `finally` writeIORef busy False

      driveOp ctx st op
        | isChange op = held $ do
            t <- readIORef lastTime
            r <- iOp inner ctx st {stampTime = Just (t + 1)} op
            case r of
              Right (ResultApplied a) -> afterChange a
              _ -> pure ()
            pure r
        | otherwise = iOp inner ctx st op

      -- ---------------------------------------------------------------
      -- rounds

      runRounds = do
        d <- readIORef dueRef
        unless (Map.null d) (runRound >> runRounds)

      runRound = do
        writeIORef roundRuns Map.empty
        writeIORef roundOrder []
        writeIORef roundWrote Set.empty
        computes
        order <- reverse <$> readIORef roundOrder
        forM_ order finishRun

      computes = do
        d <- readIORef dueRef
        running <- readIORef procs
        let candidates =
              [ ((pHeight st, dueFirst du, p), (p, du))
              | (p, du) <- Map.toList d
              , Just st <- [Map.lookup p running]
              ]
        case sortOn fst candidates of
          [] -> writeIORef dueRef Map.empty
          ((_, (p, du)) : _) -> do
            modifyIORef' dueRef (Map.delete p)
            runCompute p du
            computes

      -- the ending of a run from its errors and outcome
      endingOf rec outcome = do
        r <- recordingCurrent rec
        let errs = recordErrors r
        pure $
          if any ((== Refused) . errEntryKind) errs
            then RefusedEnding
            else
              if not (null errs)
                then Failed
                else case outcome of
                  OValue _ -> Done
                  OPending -> Pending
                  OFailed -> Failed
                  OThrew ThrownRefused -> RefusedEnding
                  OThrew _ -> Failed

      finishWith rec ending = do
        t <- top
        r <- iFinish t rec ending
        modifyIORef' ranRef (r :)

      addError rec k op why =
        recordingModify rec (\r -> r {recordErrors = recordErrors r ++ [ErrEntry k op why]})

      -- reads a program slot quietly: Left on error, Right Nothing when the
      -- slot is gone, Right (Just (seen, value)) otherwise
      readProgram rec slot = do
        let q = recordingQuiet rec
            p = fromMaybe "" (ctxProcess (apiCtx q))
        rd <- apiDirectory q (str p) (Just (str slot))
        case rd of
          Left e -> pure (Left (e, "directory", Nothing))
          Right (DirSeen (ListSlot (c : rest)) _) -> do
            rv <- apiRead q (str c)
            case rv of
              Left e -> pure (Left (e, "read", Just (ProgramSeen c Nothing (c : rest) True)))
              Right (Seen v t) -> pure (Right (Just (ProgramSeen c t (c : rest) False, v)))
          Right _ -> pure (Right Nothing)

      runCompute p du = do
        -- a run of p earlier in this round is finished first
        earlier <- Map.lookup p <$> readIORef roundRuns
        forM_ earlier $ \rs -> do
          e <- endingOf (rsRec rs) (rsOutcome rs)
          finishWith (rsRec rs) e
        modifyIORef' roundRuns (Map.delete p)
        modifyIORef' roundOrder (\o -> p : filter (/= p) o)
        Just st <- Map.lookup p <$> readIORef procs
        modifyIORef' procs (Map.adjust (\s -> s {pRan = True}) p)
        prevRef <- newIORef Nothing
        n <- do
          modifyIORef' runCounts (Map.insertWith (+) p 1)
          fromMaybe 1 . Map.lookup p <$> readIORef runCounts
        t <- top
        let ctx = Ctx (pAgent st) (Just p) (pathOf st) ReadOnly Nothing
            marks = dueMarks du
        rec <- iRecord t (bind t ctx) (RecordStart n (map refOf marks))
        let save outcome eff = do
              prev <- readIORef prevRef
              modifyIORef' roundRuns (Map.insert p (RunState rec (pGen st) ctx outcome eff prev))
            programError set (e, opn, seen) = do
              forM_ seen $ \x -> recordingModify rec (set x)
              addError rec (errKind e) opn (errWhy e)
              save OFailed Nothing
        rc <- case pPath st of
          Left why -> pure (Left (invalid why, "path", Nothing))
          Right _ -> readProgram rec "compute"
        case rc of
          Left x -> programError (\x' r -> r {recordCompute = Just x'}) x
          Right Nothing -> do
            addError rec Invalid "compute" "the compute slot is gone"
            save OFailed Nothing
          Right (Just (cseen, code)) -> do
            recordingModify rec (\r -> r {recordCompute = Just cseen})
            re <- readProgram rec "effect"
            case re of
              Left x -> programError (\x' r -> r {recordEffect = Just x'}) x
              Right eff -> do
                forM_ eff $ \(eseen, _) -> recordingModify rec (\r -> r {recordEffect = Just eseen})
                case (code, traverse snd eff) of
                  (Just ccode, Just ecode) -> case loader ccode of
                    Left why -> do
                      addError rec Invalid "compute" why
                      save OFailed Nothing
                    Right prog -> do
                      out <- programCompute prog (ComputeIn (recordingApi rec) p (pathOf st) marks)
                      cur <- recordingCurrent rec
                      outcome <-
                        if not (null (recordErrors cur))
                          then pure OFailed
                          else case out of
                            WentPending -> pure OPending
                            Threw th -> pure (OThrew (thrownKind th))
                            Returned v -> do
                              recordingModify rec (\r -> r {recordValue = Just v})
                              now <- iOp beneath hostCtx noStamp (OpRead (str p))
                              let old = case now of
                                    Right (ResultSeen (Seen o _)) -> o
                                    _ -> Nothing
                                  same = old == Just v
                              when (pRan st) (writeIORef prevRef old)
                              if same
                                then pure (OValue v)
                                else do
                                  let w = recordingWith rec (bind t ctx {ctxMode = WriteOnly})
                                  wr <- apiWrite w noStamp (str p) (JArray [object [("type", "snapshot"), ("value", v)]])
                                  case wr of
                                    Left _ -> pure OFailed
                                    Right _ -> do
                                      modifyIORef' roundWrote (Set.insert p)
                                      pure (OValue v)
                      save outcome ecode
                      -- heights: readers of p's value go above p
                      let readSet = Set.fromList (map readNode (recordReads cur))
                      modifyIORef' procs (Map.adjust (\s -> s {pReads = readSet}) p)
                      raise p (\q -> Set.member p (pReads q))
                  _ -> save OPending Nothing

      -- every other process q that isReader goes above p
      raise p isReader = do
        ps <- readIORef procs
        forM_ (Map.lookup p ps) $ \st ->
          writeIORef procs $
            Map.mapWithKey
              (\q s -> if q /= p && isReader s && pHeight s <= pHeight st then s {pHeight = pHeight st + 1} else s)
              ps

      finishRun p = do
        Just rs <- Map.lookup p <$> readIORef roundRuns
        modifyIORef' roundRuns (Map.delete p)
        let rec = rsRec rs
        mst <- Map.lookup p <$> readIORef procs
        wrote <- Set.member p <$> readIORef roundWrote
        effThrew <- case (rsOutcome rs, mst) of
          (OValue v, Just st) | pGen st == rsGen rs -> do
            let runEffect = not (pReturned st) || wrote
            modifyIORef' procs (Map.adjust (\s -> s {pReturned = True}) p)
            if not runEffect
              then pure Nothing
              else do
                -- the previous effect's cleanup runs, whether or not there is an effect
                forM_ (pCleanup st) $ \h -> do
                  modifyIORef' procs (Map.adjust (\s -> s {pCleanup = Nothing}) p)
                  (chs, _) <- runLasting True p st h Nothing
                  recordingModify rec (\r -> r {recordCleanup = map refOf chs})
                still <- maybe False ((== rsGen rs) . pGen) . Map.lookup p <$> readIORef procs
                case rsEffect rs of
                  Just ecode | still -> effect p rs v ecode
                  _ -> pure Nothing
          _ -> pure Nothing
        let outcome = case effThrew of
              Just k -> OThrew k
              Nothing -> rsOutcome rs
        e <- endingOf rec outcome
        finishWith rec e

      effect p rs v ecode = do
        let rec = rsRec rs
        case loader ecode of
          Left why -> do
            addError rec Invalid "effect" why
            pure (Just ThrownInvalid)
          Right prog -> do
            t <- top
            before <- length . recordChanges <$> recordingCurrent rec
            let api = recordingWith rec (bind t (rsCtx rs) {ctxMode = WriteOnly})
            out <- programEffect prog (EffectIn api p v (rsPrevious rs))
            after <- recordChanges <$> recordingCurrent rec
            let wroteNodes = Set.fromList (map refNode (drop before after))
            modifyIORef' procs $
              Map.adjust
                ( \s ->
                    s
                      { pHandlers = foldl (\m (k, h) -> Map.insert k h m) (pHandlers s) (effectHandlers out)
                      , pCleanup = effectCleanup out
                      , pWrote = wroteNodes
                      }
                )
                p
            raise p (\q -> not (Set.null (Set.intersection wroteNodes (pReads q))))
            pure (thrownKind <$> effectThrew out)

      fire _ctx p name input = do
        running <- readIORef procs
        case Map.lookup p running of
          Nothing -> pure (Left (invalid ("no process " <> p <> " is running")))
          Just st -> case Map.lookup name (pHandlers st) of
            Nothing -> pure (Left (invalid ("process " <> p <> " has no handler " <> name)))
            Just h -> held $ do
              (chs, err) <- runLasting True p st h input
              pure (Right (Fired chs err))

      takeRan = do
        rs <- reverse <$> readIORef ranRef
        ss <- map snd . sortOn fst <$> readIORef stoppedRef
        writeIORef ranRef []
        writeIORef stoppedRef []
        pure (Ran rs ss)

      interface =
        inner
          { iOp = driveOp
          , iSetTop = \t -> writeIORef topRef t >> iSetTop inner t
          }

  pure
    Driver
      { driverInterface = interface
      , driverBatch = \act -> held act
      , driverFire = fire
      , driverTake = takeRan
      }
