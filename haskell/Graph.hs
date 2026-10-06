{-# LANGUAGE OverloadedStrings #-}

-- | The bare graph: CORE.tex "The core" (Nodes, Paths, Patches, Changes,
-- Placement, Runs and lookup, Operations, Records); PROTOCOL.tex Encodings
-- and Commands below drive.
--
-- State: one IORef 'St' made in 'graph' (the root, the nodes, the last time,
-- each process's remembered reads, subscriptions, run tags), and an IORef
-- holding the top of the stack. The returned Interface closes over both.
--
-- * Nodes: id -> value, the change that last set it (none for the root's
--   first value), and a directory of non-empty slots, each with the change
--   that last set it. Nothing is ever removed: a node no reachable place
--   holds cannot be addressed, and placing its id again brings it back as
--   it was.
-- * Addresses: a place is names from the root. Its first 'ctxChroot' names,
--   walked from the root as an address on their own, reach its start, its
--   "/"; its other names are walked from there as an address is, followed
--   afresh each time: that is the place's walk, and the node it reaches is
--   ".". An address starts at the start for a first "/"; otherwise at ".",
--   or, for each "..", one step back along the place's walk, to the node it
--   came through, never above the start. A place whose walk stopped on the
--   way has no ".", nor any node past where it stopped; the nodes it came
--   through before it stopped are still there to go back to. The address's
--   names are then walked from where it starts: each selects a slot, and the
--   walk takes the first id in it whose node is here and, unless it is the
--   last name, has the next name.
-- * A read whose address's last name selects a slot gives an item for each
--   member here, in slot order, each with its own value, route and change;
--   the first is the node the address reaches, which writes and places act
--   on. An address with no names reads the one node it starts at. A
--   directory read lists the union of the same members.
-- * Lookup searches the directories the place's walk went through, from "."
--   back up to the start, reading the slot of the name in each through the
--   top of the stack, and takes the nearest slot that holds a node that is
--   here; a refused read ends the search.
-- * Changes are checked in this order: the address (above-root,
--   nothing-there), the time (code time, last), then what the change does
--   (exists, position, not-in-slot, the patches, patch by patch). A failed
--   change uses no time and changes nothing.
-- * Subscriptions follow their address: after each change the address is
--   walked again. A subscription receives each change to the node its
--   address reached, and each placement or unplacement that changed its
--   route (the node it reaches and the route its names take), whether or
--   not it then reaches another node.
-- * Marking, which nothing below drive exercises: for a ctx that is
--   ReadOnly and in its process's current run, every read remembers what it
--   depended on: each slot its walks looked in, each member they tried that
--   was not here, the slot looked for in each member that was, the value or
--   slot or directory it read, and each pending id it listed. A change marks
--   every process whose last finished run or current run depended on what it
--   changed, its own process included. Marked ids are in code point order.
module Graph
  ( graph
  , applyPatches
  ) where

import Control.Monad (foldM, forM_)
import Data.IORef
import Data.List (unsnoc)
import qualified Data.Map.Strict as Map
import Data.Maybe (fromMaybe, isJust, listToMaybe)
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import Json
import Types

-- ===========================================================================
-- state

data Slot = Slot {slotIds :: [Id], slotChange :: Change}

data Node = Node
  { nodeValue :: Value
  , nodeChange :: Maybe Change -- ^ the change that last set the value
  , nodeDir :: Map.Map Name Slot -- ^ slots are never empty
  }

-- | What a read depended on.
data Dep
  = DValue Id -- ^ the node's value
  | DSlot Id Name -- ^ one slot of the node, there or not
  | DDir Id -- ^ the node's whole directory
  | DHere Id -- ^ whether the id's node is here
  deriving (Eq, Ord, Show)

-- | One process's reads: its last finished run's, and its current run's.
data Reads = Reads {readsDone :: Set.Set Dep, readsRun :: Maybe (RunTag, Set.Set Dep)}

data Sub = Sub
  { subCtx :: Ctx
  , subAddress :: Address
  , subReached :: Maybe (Id, Route)
  -- ^ the node the address reached after the last change, and the route its
  -- names took there
  , subSend :: Event -> IO ()
  }

data St = St
  { stRoot :: Id
  , stNodes :: Map.Map Id Node
  , stLast :: Time -- ^ 0 until the first change
  , stReads :: Map.Map Id Reads
  , stSubs :: Map.Map Int Sub
  , stNextSub :: Int
  , stNextTag :: RunTag
  , stEnded :: Set.Set RunTag
  }

-- ===========================================================================
-- the graph

-- | A fresh graph holding one node, its root, whose value is null.
graph :: Id -> IO Interface
graph root = do
  ref <-
    newIORef
      St
        { stRoot = root
        , stNodes = Map.singleton root (Node JNull Nothing Map.empty)
        , stLast = 0
        , stReads = Map.empty
        , stSubs = Map.empty
        , stNextSub = 1
        , stNextTag = 1
        , stEnded = Set.empty
        }
  topRef <- newIORef Nothing
  let self =
        Interface
          { iOp = \ctx stamp o -> do
              top <- fromMaybe self <$> readIORef topRef
              either (Left . withOp (opName o)) Right <$> operate ref top ctx stamp o
          , iSubscribe = subscribe ref
          , iUnsubscribe = unsubscribe ref
          , iRecord = record ref
          , iFinish = finish ref
          , iSetTop = writeIORef topRef . Just
          }
  pure self

operate :: IORef St -> Interface -> Ctx -> Stamp -> Op -> IO (Either Err Result)
operate ref top ctx stamp o = case o of
  OpRead a -> reading $ do
    -- an item for each member here of the slot the last name selects, in
    -- slot order; the first is the node the address reaches
    s <- readIORef ref
    case members s ctx a of
      Left e -> pure (Left e)
      Right (ms, deps) -> do
        let found = [(route, nd) | (m, route) <- ms, Just nd <- [Map.lookup m (stNodes s)]]
        remember ref ctx (deps ++ [DValue m | (m, _) <- ms])
        pure (Right (ResultItems [ItemValue (nodeValue nd) (FromRoute route) (nodeChange nd) | (route, nd) <- found]))
  OpDirectory a mname -> reading $ do
    s <- readIORef ref
    case members s ctx a of
      Left e -> pure (Left e)
      Right (ms, deps) -> case mname of
        Just nm -> do
          let items = concat [slotItems s m route nm | (m, route) <- ms]
          remember ref ctx (deps ++ [DSlot m nm | (m, _) <- ms] ++ pendingDeps items)
          pure (Right (ResultItems items))
        Nothing -> do
          let names = Set.toAscList (Set.unions [Map.keysSet (nodeDir nd) | (m, _) <- ms, Just nd <- [Map.lookup m (stNodes s)]])
              listing = [(nm, concat [slotItems s m route nm | (m, route) <- ms]) | nm <- names]
          remember ref ctx (deps ++ [DDir m | (m, _) <- ms] ++ pendingDeps (concatMap snd listing))
          pure (Right (ResultDirectory listing))
  OpLookup nm -> reading (search ref top ctx nm)
  OpWrite a ps -> changing . target a $ \n ->
    commit ref ctx stamp n (KindWrite ps) $ \c s -> do
      nd <- node s n
      v <- applyPatches ps (nodeValue nd)
      Right s {stNodes = Map.insert n nd {nodeValue = v, nodeChange = Just c} (stNodes s)}
  OpPlace a nm i mpos mvalue -> changing . target a $ \p ->
    commit ref ctx stamp p (KindPlace nm i mpos mvalue) $ \c s -> do
      nodes <- case mvalue of
        Just v
          | Map.member i (stNodes s) -> Left (invalid "exists" [] ("this graph already has " <> i))
          | otherwise -> Right (Map.insert i (Node v (Just c) Map.empty) (stNodes s))
        Nothing -> Right (stNodes s)
      pn <- node s p
      let ids = maybe [] slotIds (Map.lookup nm (nodeDir pn))
      ids' <- case mpos of
        Nothing
          | i `elem` ids -> Right ids
          | otherwise -> Right (ids ++ [i])
        Just k
          | k > toInteger (length ids) ->
              Left (invalid "position" [("length", int (length ids))] "the position is past the slot's length")
          | otherwise ->
              -- put in at the gap, then take its old place out
              let (before, after) = splitAt (fromInteger k) ids in Right (filter (/= i) before ++ [i] ++ filter (/= i) after)
      Right s {stNodes = Map.insert p pn {nodeDir = Map.insert nm (Slot ids' c) (nodeDir pn)} nodes}
  OpUnplace a nm i -> changing . target a $ \p ->
    commit ref ctx stamp p (KindUnplace nm i) $ \c s -> do
      pn <- node s p
      case Map.lookup nm (nodeDir pn) of
        Just sl
          | i `elem` slotIds sl ->
              let ids' = filter (/= i) (slotIds sl)
                  dir'
                    | null ids' = Map.delete nm (nodeDir pn)
                    | otherwise = Map.insert nm (Slot ids' c) (nodeDir pn)
               in Right s {stNodes = Map.insert p pn {nodeDir = dir'} (stNodes s)}
        _ -> Left (invalid "not-in-slot" [] ("the slot " <> nm <> " does not hold " <> i))
  where
    reading k
      | ctxMode ctx == WriteOnly = pure (Left (invalid "write-only" [] "this interface only writes"))
      | otherwise = k
    changing k
      | ctxMode ctx == ReadOnly = pure (Left (invalid "read-only" [] "this interface only reads"))
      | otherwise = k
    target a k = do
      s <- readIORef ref
      case resolve s ctx a of
        Left e -> pure (Left e)
        Right (Just (n, _), _) -> k n
        Right (Nothing, _) -> pure (Left nothingThere)
    node s n = maybe (Left nothingThere) Right (Map.lookup n (stNodes s))
    pendingDeps items = [DHere i | ItemId i _ _ True <- items]

nothingThere :: Err
nothingThere = invalid "nothing-there" [] "the address reaches nothing"

aboveRoot :: Err
aboveRoot = invalid "above-root" [] "the address goes up past the start of the place"

-- | The items of one slot of a node, each from the route to the node.
slotItems :: St -> Id -> Route -> Name -> [Item]
slotItems s m route nm = case Map.lookup m (stNodes s) >>= Map.lookup nm . nodeDir of
  Nothing -> []
  Just sl -> [ItemId i (FromSlot route k) (slotChange sl) (not (Map.member i (stNodes s))) | (k, i) <- zip [0 ..] (slotIds sl)]

-- ===========================================================================
-- walking

-- | One name from a node: the first id in its slot whose node is here and,
-- when a next name is given, has a slot of that name; and what that depended
-- on.
pick :: St -> Id -> Name -> Maybe Name -> (Maybe Step, [Dep])
pick s p nm next = case Map.lookup p (stNodes s) >>= Map.lookup nm . nodeDir of
  Nothing -> (Nothing, [DSlot p nm])
  Just sl -> go (zip [0 ..] (slotIds sl)) [DSlot p nm]
  where
    go [] deps = (Nothing, deps)
    go ((k, i) : rest) deps = case Map.lookup i (stNodes s) of
      Nothing -> go rest (DHere i : deps)
      Just m -> case next of
        Nothing -> (Just (Step p nm i k), deps)
        Just x
          | Map.member x (nodeDir m) -> (Just (Step p nm i k), DSlot i x : deps)
          | otherwise -> go rest (DSlot i x : deps)

-- | Walks names down from a node as far as it goes, and does not go back:
-- the steps it took, whether it walked every name, and what that depended
-- on. The last name's member must have @next@, when given.
trace :: St -> Id -> [Name] -> Maybe Name -> (Route, Bool, [Dep])
trace s start names next = go start names [] []
  where
    go _ [] route deps = (reverse route, True, deps)
    go cur (nm : rest) route deps =
      let (step, d) = pick s cur nm (maybe next Just (listToMaybe rest))
       in case step of
            Nothing -> (reverse route, False, d ++ deps)
            Just st -> go (stepNode st) rest (st : route) (d ++ deps)

-- | Walks names down from a node. The last name's member must have @next@,
-- when given. The node reached and the route, or Nothing.
walk :: St -> Id -> [Name] -> Maybe Name -> (Maybe (Id, Route), [Dep])
walk s start names next = case trace s start names next of
  (route, True, deps) -> (Just (maybe start (stepNode . snd) (unsnoc route), route), deps)
  (_, False, deps) -> (Nothing, deps)

-- | How many names of the place are hidden: those its start is reached by.
hidden :: Ctx -> Int
hidden ctx = min (length (ctxPlace ctx)) (max 0 (ctxChroot ctx))

-- | How many names of the place are below its start: as many ".." as an
-- address may have.
below :: Ctx -> Int
below ctx = length (ctxPlace ctx) - hidden ctx

-- | The place's start, its "/": the node its hidden names reach from the
-- root, walked as an address on their own (PROTOCOL The session: "its / is
-- the node those names reach").
placeStart :: St -> Ctx -> (Maybe Id, [Dep])
placeStart s ctx =
  let (r, deps) = walk s (stRoot s) (take (hidden ctx) (ctxPlace ctx)) Nothing
   in (fst <$> r, deps)

-- | The place's walk (CORE "Place", "Address"): its names below the start,
-- walked from the start as an address is. The nodes it came through, the
-- start first: one more than the place has names below its start when it
-- reaches its ".", fewer when the walk stopped on the way.
placeWalk :: St -> Ctx -> ([Id], [Dep])
placeWalk s ctx = case placeStart s ctx of
  (Nothing, d0) -> ([], d0)
  (Just t, d0) ->
    let (route, _, d1) = trace s t (drop (hidden ctx) (ctxPlace ctx)) Nothing
     in (t : map stepNode route, d0 ++ d1)

-- | The node an address starts from: the place's start for a first "/";
-- otherwise the node the place reaches, or, for each "..", one step back
-- along the place's walk, to the node it came through, never above the
-- start. Where the walk stopped on the way, there is nothing past where it
-- stopped, but the nodes it came through are still there to go back to
-- (a question for chee, in NOTES.md).
startOf :: St -> Ctx -> Address -> Either Err (Maybe Id, [Dep])
startOf s ctx a
  | addressRoot a && addressUp a > 0 = Left aboveRoot
  | addressUp a > below ctx = Left aboveRoot
  | addressRoot a = Right (placeStart s ctx)
  | otherwise =
      let (through, deps) = placeWalk s ctx
       in Right (listToMaybe (drop (below ctx - addressUp a) through), deps)

-- | The node an address reaches and the route its names took.
resolve :: St -> Ctx -> Address -> Either Err (Maybe (Id, Route), [Dep])
resolve s ctx a = do
  (b, d0) <- startOf s ctx a
  pure $ case b of
    Nothing -> (Nothing, d0)
    Just n -> let (r, d1) = walk s n (addressNames a) Nothing in (r, d0 ++ d1)

-- | The nodes a read or a directory read is of, each with its route: for an
-- address with names, every member here of the slot its last name selects
-- (a union, in slot order), the first being the node the address reaches;
-- with none, the node it starts from.
members :: St -> Ctx -> Address -> Either Err ([(Id, Route)], [Dep])
members s ctx a = do
  (b, d0) <- startOf s ctx a
  pure $ case (b, unsnoc (addressNames a)) of
    (Nothing, _) -> ([], d0)
    (Just n, Nothing) -> ([(n, [])], d0)
    (Just n, Just (initial, final)) ->
      let (r, d1) = walk s n initial (Just final)
       in case r of
            Nothing -> ([], d0 ++ d1)
            Just (p, route) ->
              let ids = maybe [] slotIds (Map.lookup p (stNodes s) >>= Map.lookup final . nodeDir)
                  isHere m = Map.member m (stNodes s)
                  ms = [(m, route ++ [Step p final m k]) | (k, m) <- zip [0 ..] ids, isHere m]
               in (ms, d0 ++ d1 ++ DSlot p final : [DHere m | m <- ids, not (isHere m)])

-- | The node an address reaches now, if any, and the route its names take.
reach :: St -> Ctx -> Address -> Maybe (Id, Route)
reach s ctx a = case resolve s ctx a of
  Right (r, _) -> r
  Left _ -> Nothing

-- ===========================================================================
-- lookup (CORE "Lookup")

-- | Searches the directories the place's walk went through, nearest first:
-- the one the place reaches, ".", then each one back along the walk (as
-- ".." reaches it), up to its start. Each step reads the slot of the name
-- there through the top of the stack, as an ordinary read of one slot. The
-- nearest slot that holds a node that is here is found, all its items; a
-- slot whose ids are all absent is passed over. A refused read ends the
-- search, and is not an error.
search :: IORef St -> Interface -> Ctx -> Name -> IO (Either Err Result)
search ref top ctx nm = do
  s <- readIORef ref
  go [(k, back s k) | k <- [0 .. below ctx]] []
  where
    -- the node ".." k times reaches, for the record's searched
    back s k = either (const Nothing) fst (startOf s ctx (Address False k []))
    go [] acc = pure (Right (ResultFound (reverse acc) []))
    go ((k, n) : rest) acc = do
      r <- iOp top ctx noStamp (OpDirectory (Address False k []) (Just nm))
      case r of
        Left e
          | errKind e == Refused -> do
              -- the refused read still counts: a change to that slot marks
              remember ref ctx [DSlot x nm | Just x <- [n]]
              pure (Right (ResultFound (reverse ([Searched x Nothing True | Just x <- [n]] ++ acc)) []))
          | otherwise -> pure (Left e)
        Right (ResultItems items) ->
          let acc' = [Searched x (latest items) False | Just x <- [n]] ++ acc
           in if any isHere items
                then pure (Right (ResultFound (reverse acc') (map (relabel k) items)))
                else go rest acc'
        Right _ -> pure (Left (invalid "nothing-there" [] "a directory read gave something else"))
    isHere item = case item of
      ItemId _ _ _ pending -> not pending
      _ -> False
    relabel k item = case item of
      ItemId i (FromSlot _ pos) c p -> ItemId i (FromPath (Address False k [nm]) pos) c p
      _ -> item

-- | The time of the latest change among some items.
latest :: [Item] -> Maybe Time
latest items = case [changeTime c | Just c <- map itemChange items] of
  [] -> Nothing
  ts -> Just (maximum ts)

-- ===========================================================================
-- changes

-- | Applies one change to node @n@: checks the time, makes the change, lets
-- @apply@ build the new state (Left: invalid, nothing changes), marks, and
-- sends it to the subscriptions it concerns.
commit :: IORef St -> Ctx -> Stamp -> Id -> ChangeKind -> (Change -> St -> Either Err St) -> IO (Either Err Result)
commit ref ctx stamp n kind apply = do
  s <- readIORef ref
  case stampTime stamp of
    Nothing -> pure (Left (invalid "missing" [("field", "time")] "a change needs a time"))
    Just t
      | t <= stLast s ->
          pure (Left (invalid "time" [("last", integer (stLast s))] "the time is not greater than every time in the graph"))
      | otherwise -> do
          let c = Change n t kind (ctxAgent ctx) (ctxProcess ctx) (stampCause stamp)
          case apply c s of
            Left e -> pure (Left e)
            Right s1 -> do
              let marked = [p | (p, rs) <- Map.toAscList (stReads s), any (readBy rs) (touched c)]
                  s2 = s1 {stLast = t}
                  followed = Map.map (follow s2 c) (stSubs s2)
              writeIORef ref s2 {stSubs = Map.map snd followed}
              sequence_ [send | (Just send, _) <- Map.elems followed]
              pure (Right (ResultApplied (Applied c marked)))

-- | A subscription after a change: whether it receives the change, and what
-- its address reaches now. It receives each change to the node its address
-- reached, and each placement or unplacement that changed its route: the
-- node the address reaches, or the route its names take there, whether or
-- not it then reaches another node (CORE Operations, subscribe).
follow :: St -> Change -> Sub -> (Maybe (IO ()), Sub)
follow s c sub = (if receives then Just (subSend sub (EventChange c)) else Nothing, sub {subReached = now})
  where
    now = reach s (subCtx sub) (subAddress sub)
    before = subReached sub
    receives = (fst <$> before) == Just (changeNode c) || (placement && now /= before)
    placement = case changeKind c of
      KindWrite _ -> False
      _ -> True

-- | What a change changed, as reads depend on it (CORE "Changes").
touched :: Change -> [Dep]
touched c = case changeKind c of
  KindWrite _ -> [DValue n]
  KindPlace nm i _ made -> [DSlot n nm, DDir n] ++ [DHere i | isJust made]
  KindUnplace nm _ -> [DSlot n nm, DDir n]
  where
    n = changeNode c

readBy :: Reads -> Dep -> Bool
readBy rs d = Set.member d (readsDone rs) || maybe False (Set.member d . snd) (readsRun rs)

-- | Remembers what a read depended on, when the ctx is a current read-only run.
remember :: IORef St -> Ctx -> [Dep] -> IO ()
remember ref ctx deps = case (ctxMode ctx, ctxProcess ctx, ctxRun ctx) of
  (ReadOnly, Just p, Just tag) -> modifyIORef' ref $ \s -> case Map.lookup p (stReads s) of
    Just rs
      | Just (t, run) <- readsRun rs
      , t == tag ->
          s {stReads = Map.insert p rs {readsRun = Just (t, Set.union run (Set.fromList deps))} (stReads s)}
    _ -> s
  _ -> pure ()

-- ===========================================================================
-- subscriptions

subscribe :: IORef St -> Ctx -> Address -> (Event -> IO ()) -> IO (Either Err Int)
subscribe ref ctx a send = do
  s <- readIORef ref
  case resolve s ctx a of
    Left e -> pure (Left (withOp "subscribe" e))
    Right (r, _) -> atomicModifyIORef' ref $ \s' ->
      let k = stNextSub s'
       in (s' {stSubs = Map.insert k (Sub ctx a r send) (stSubs s'), stNextSub = k + 1}, Right k)

unsubscribe :: IORef St -> Ctx -> Int -> IO (Either Err ())
unsubscribe ref _ k = atomicModifyIORef' ref $ \s ->
  if Map.member k (stSubs s)
    then (s {stSubs = Map.delete k (stSubs s)}, Right ())
    else (s, Left (withOp "unsubscribe" (invalid "wrong-field" [("field", "sub")] "there is no such subscription")))

-- ===========================================================================
-- recordings

record :: IORef St -> Api -> RecordStart -> IO Recording
record ref (Api inner ctx) (RecordStart run marked) = do
  tag <- atomicModifyIORef' ref $ \s ->
    let tag = stNextTag s
        begin mrs = Just ((fromMaybe (Reads Set.empty Nothing) mrs) {readsRun = Just (tag, Set.empty)})
        reads' = case (ctxMode ctx, ctxProcess ctx) of
          (ReadOnly, Just p) -> Map.alter begin p (stReads s)
          _ -> stReads s
     in (s {stNextTag = tag + 1, stReads = reads'}, tag)
  recRef <- newIORef (emptyRecord (fromMaybe "" (ctxProcess ctx)) run (ctxAgent ctx) marked)
  let ended = Set.member tag . stEnded <$> readIORef ref
      guarded i k =
        i
          { iOp = \c st o -> do
              e <- ended
              if e then pure (Left (withOp (opName o) (invalid "stopped" [] "the run has ended"))) else k i c st o
          }
      logged i = guarded i $ \j c st o -> do
        r <- iOp j c st o
        modifyIORef' recRef (logOp o r)
        pure r
      quiet i = guarded i iOp
      tagged c = c {ctxRun = Just tag}
  pure
    Recording
      { recordingTag = tag
      , recordingApi = Api (logged inner) (tagged ctx)
      , recordingWith = \(Api i c) -> Api (logged i) (tagged c)
      , recordingQuiet = Api (quiet inner) (tagged ctx)
      , recordingModify = modifyIORef' recRef
      , recordingCurrent = readIORef recRef
      }

-- | Logs one operation into a record, as 'Recording' in Types.hs says.
logOp :: Op -> Either Err Result -> Record -> Record
logOp o r rec = case r of
  Left e -> rec {recordErrors = recordErrors rec ++ [withOp (opName o) e]}
  Right res -> case (o, res) of
    (OpRead a, ResultItems items) -> entry "read" a Nothing items
    (OpDirectory a nm, ResultItems items) -> entry "directory" a nm items
    (OpDirectory a nm, ResultDirectory listing) -> entry "directory" a nm (concatMap snd listing)
    (OpLookup nm, ResultFound searched items) ->
      rec {recordLookups = recordLookups rec ++ [LookupEntry nm searched [i | ItemId i _ _ _ <- items]]}
    (_, ResultApplied ap) -> rec {recordChanges = recordChanges rec ++ [refOf (appliedChange ap)]}
    _ -> rec
  where
    entry op a nm items = rec {recordReads = recordReads rec ++ [ReadEntry op a nm (routeOf items) (latest items)]}
    routeOf items = case items of
      ItemValue _ (FromRoute route) _ : _ -> route
      ItemId _ (FromSlot route _) _ _ : _ -> route
      _ -> []

-- | Ends a run: its reads replace its process's last finished run's, and its
-- record goes to the subscriptions that reach the process node.
finish :: IORef St -> Recording -> Ending -> IO Record
finish ref rec ending = do
  recordingModify rec (\r -> r {recordEnding = ending})
  r <- recordingCurrent rec
  s <- atomicModifyIORef' ref $ \s ->
    let tag = recordingTag rec
        settle rs = case readsRun rs of
          Just (t, run) | t == tag -> rs {readsDone = run, readsRun = Nothing}
          _ -> rs
        s' = s {stEnded = Set.insert tag (stEnded s), stReads = Map.adjust settle (recordProcess r) (stReads s)}
     in (s', s')
  forM_ [subSend sub | sub <- Map.elems (stSubs s), (fst <$> subReached sub) == Just (recordProcess r)] ($ EventRecord r)
  pure r

-- ===========================================================================
-- patches (CORE "Patches"; PROTOCOL Errors)

-- | Applies patches in order, patch by patch. At the first that is not a
-- patch or does not apply, the whole write is invalid: not-a-patch, no-key,
-- range or wrong-kind, with the patch's index.
applyPatches :: [Value] -> Value -> Either Err Value
applyPatches ps v0 = foldM one v0 (zip [0 :: Int ..] ps)
  where
    one v (i, p) = case applyPatch p v of
      Left (code, details, text) -> Left (invalid code (("index", int i) : details) text)
      Right v' -> Right v'

-- | An error's code, its details after the index, and a text.
type PatchErr = (Text, Fields, Text)

-- | A key of a path, or a set's key: a string, into an object, or a whole
-- number, into a list.
data Key = KName Text | KIndex Integer

keyOf :: Value -> Maybe Key
keyOf v = case v of
  JString t -> Just (KName t)
  _ | Just w <- asWhole v, w >= 0 -> Just (KIndex w)
  _ -> Nothing

-- | One patch. What it is is checked first, from its form alone (an object,
-- a known type, a snapshot's value, a path that is a list of keys, a set's
-- key): not-a-patch. Then it is applied: its path (no-key, wrong-kind),
-- then what it does at the end of it (wrong-kind, range).
applyPatch :: Value -> Value -> Either PatchErr Value
applyPatch p v = case p of
  JObject _ -> case field "type" p >>= asText of
    Just "snapshot" -> maybe (notAPatch "a snapshot has a value") Right (field "value" p)
    Just "splice" -> do
      ks <- path
      at ks v (splice range (field "value" p))
    Just "set" -> do
      ks <- path
      k <- maybe (notAPatch "a set's key is a string") Right (field "key" p >>= keyOf)
      at ks v (set k (field "value" p))
    _ -> notAPatch "a patch's type is snapshot, splice or set"
  _ -> notAPatch "a patch is an object"
  where
    path = case field "path" p >>= asList of
      Nothing -> notAPatch "a patch's path is a list of keys"
      Just ks -> maybe (notAPatch "a key is a string or a whole number") Right (mapM keyOf ks)
    range = case field "range" p >>= asList of
      Just [x, y] | Just a <- asWhole x, Just b <- asWhole y -> Just (a, b)
      _ -> Nothing

notAPatch :: Text -> Either PatchErr a
notAPatch t = Left ("not-a-patch", [], t)

noKey :: Text -> Either PatchErr a
noKey t = Left ("no-key", [], t)

wrongKind :: Text -> Either PatchErr a
wrongKind t = Left ("wrong-kind", [], t)

-- | Changes the value at a path: strings into objects, whole numbers into
-- lists. An object that lacks the key, or a list shorter than the index, is
-- no-key; a key of the wrong kind for where it leads (a string into a list,
-- a number into an object), or a path that goes on into a string, number,
-- boolean or null, where only an object or a list can be gone into, is
-- wrong-kind.
at :: [Key] -> Value -> (Value -> Either PatchErr Value) -> Either PatchErr Value
at [] v f = f v
at (k : ks) v f = case (k, v) of
  (KName name, JObject fs) -> case lookup name fs of
    Just x -> do
      x' <- at ks x f
      Right (JObject [(n, if n == name then x' else y) | (n, y) <- fs])
    Nothing -> noKey "the object lacks the key"
  (KIndex w, JArray xs)
    | w < toInteger (length xs) -> do
        let i = fromInteger w
        x' <- at ks (xs !! i) f
        Right (JArray (take i xs ++ [x'] ++ drop (i + 1) xs))
    | otherwise -> noKey "the list is shorter than the index"
  (KName _, JArray _) -> wrongKind "a string leads into a list"
  (KIndex _, JObject _) -> wrongKind "a number leads into an object"
  _ -> wrongKind "the path goes on into a string, number, boolean or null"

-- | A splice of the half-open range of a string (in code points) or a list.
splice :: Maybe (Integer, Integer) -> Maybe Value -> Value -> Either PatchErr Value
splice range mx target = case target of
  JString s -> do
    (a, b) <- within (Text.length s)
    case mx of
      Nothing -> Right (JString (Text.take a s <> Text.drop b s))
      Just (JString r) -> Right (JString (Text.take a s <> r <> Text.drop b s))
      Just _ -> wrongKind "a splice of a string takes a string"
  JArray xs -> do
    (a, b) <- within (length xs)
    case mx of
      Nothing -> Right (JArray (take a xs ++ drop b xs))
      Just (JArray ys) -> Right (JArray (take a xs ++ ys ++ drop b xs))
      Just _ -> wrongKind "a splice of a list takes a list"
  _ -> wrongKind "a splice applies to a string or a list"
  where
    within len = case range of
      Just (a, b) | 0 <= a, a <= b, b <= toInteger len -> Right (fromInteger a, fromInteger b)
      _ -> Left ("range", [("length", int len)], "the range is not a range inside the value")

-- | Sets, adds or (with no value) deletes a key of an object. A number
-- leads into an object as the wrong kind of key.
set :: Key -> Maybe Value -> Value -> Either PatchErr Value
set key mx target = case (target, key) of
  (JObject fs, KName k) -> Right . JObject $ case mx of
    Nothing -> filter ((/= k) . fst) fs
    Just x
      | any ((== k) . fst) fs -> [(k', if k' == k then x else y) | (k', y) <- fs]
      | otherwise -> fs ++ [(k, x)]
  (JObject _, KIndex _) -> wrongKind "a number leads into an object"
  _ -> wrongKind "a set applies to an object"
