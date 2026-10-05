{-# LANGUAGE OverloadedStrings #-}

-- | The bare graph: CORE.tex "The core" (Nodes, Patches, Changes, Placement,
-- Processes, Lookup, Operations, Records); PROTOCOL.tex Encodings and
-- Commands (below drive). Owner: the Graph agent.
--
-- State: one IORef 'St' created in 'graph' (nodes, the last time, every
-- process's remembered reads, subscriptions, run tags), plus an IORef holding
-- the top of the stack. The returned Interface closes over both.
--
-- What it does:
--
-- * Nodes: id -> value, directory (Map Name [Id], slots non-empty, ids
--   unique in a slot), time of latest change, fixed data (null if not
--   given; any JSON, never checked or read here, answered by OpData).
-- * Times: a change's 'stampTime' must be Just t, t greater than every time
--   already in the graph, else invalid. A failed operation uses no time.
-- * Modes: ReadOnly -> make/write/place/unplace invalid; WriteOnly ->
--   read/directory/lookup invalid.
-- * Place: an absent id may be placed; the parent must exist. A position is
--   where the id ends up in the slot after the move, 0..L where L is the
--   slot's length after the move; L (one past the end) is the end, more is
--   invalid (CORE "Placement"; scenario graph/positions). With no position,
--   a new id goes at the end and an id already there stays where it is; it
--   is a change either way.
-- * Unplace: invalid on an absent parent, and (decided here) invalid when the
--   id is not in that slot: there is nothing to take out.
-- * Lookup: the parents of the path's steps, last to first; each slot is read
--   with @iOp top ctx noStamp (OpDirectory parent (Just name))@, so protect
--   can refuse it and the graph remembers it as a slot read. A refused read
--   ends the search (listed last, refused) and the lookup still succeeds.
-- * Remembered reads, for a ctx that is ReadOnly and whose ctxRun is its
--   process's current tag: node reads, slot reads, whole-directory reads.
--   What each is marked by:
--     node read      - the node's making, a write to it (not placements)
--     slot read      - the node's making, a place/unplace of that name in it
--     directory read - the node's making, any place/unplace in it
--   A change never marks its own process. Marked ids in code point order.
--   Reads of stopped processes are kept (the driver ignores such marks).
-- * Subscriptions: per node id (absent ids too), numbered from 1; a change
--   goes to its node's subscribers after it applies, in subscription order;
--   iFinish sends the record to the process node's subscribers.
-- * Recordings: see 'Recording' in Types.hs. iRecord with a ReadOnly api
--   replaces the process's remembered reads with an empty set under a fresh
--   tag. After iFinish, every api of the recording answers invalid.
module Graph
  ( graph
  , applyPatches
  ) where

import Control.Monad (foldM, forM_, when)
import Data.IORef
import qualified Data.Map.Strict as Map
import Data.Maybe (fromMaybe)
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import Json
import Types

-- ===========================================================================
-- state

data Node = Node
  { nodeValue :: Value
  , nodeDir :: Map.Map Name [Id]
  , nodeTime :: Time
  , nodeData :: Value -- ^ fixed data, null when not given; never read by the graph
  }

-- | One process's remembered reads, from the run with this tag.
data Reads = Reads
  { readsTag :: RunTag
  , readsNodes :: Set.Set Id
  , readsSlots :: Set.Set (Id, Name)
  , readsDirs :: Set.Set Id
  }

data St = St
  { stNodes :: Map.Map Id Node
  , stLast :: Time
  , stReads :: Map.Map Id Reads
  , stSubs :: Map.Map Int (Id, Event -> IO ())
  , stNextSub :: Int
  , stNextTag :: RunTag
  , stEnded :: Set.Set RunTag
  }

emptySt :: St
emptySt = St Map.empty 0 Map.empty Map.empty 1 1 Set.empty

-- | What a read remembers.
data Remember = RNode Id | RSlot Id Name | RDir Id

-- ===========================================================================
-- the graph

-- | A fresh, empty bare graph.
graph :: IO Interface
graph = do
  ref <- newIORef emptySt
  topRef <- newIORef Nothing
  let self =
        Interface
          { iOp = \ctx st o -> do
              top <- fromMaybe self <$> readIORef topRef
              operate ref top ctx st o
          , iSubscribe = subscribe ref
          , iUnsubscribe = unsubscribe ref
          , iRecord = record ref
          , iFinish = finish ref
          , iSetTop = writeIORef topRef . Just
          }
  pure self

operate :: IORef St -> Interface -> Ctx -> Stamp -> Op -> IO (Either Err Result)
operate ref top ctx stamp o = case o of
  OpRead n -> reading $ withId "node" n $ \i -> do
    s <- readIORef ref
    remember ref ctx (RNode i)
    pure . Right . ResultSeen $ case Map.lookup i (stNodes s) of
      Nothing -> Seen Nothing Nothing
      Just nd -> Seen (Just (nodeValue nd)) (Just (nodeTime nd))
  OpDirectory n mname -> reading $ withId "node" n $ \i -> case mname of
    Nothing -> do
      s <- readIORef ref
      remember ref ctx (RDir i)
      pure . Right . ResultDir $ case Map.lookup i (stNodes s) of
        Nothing -> DirSeen ListAbsent Nothing
        Just nd -> DirSeen (ListWhole (Map.toAscList (nodeDir nd))) (Just (nodeTime nd))
    Just nv -> withId "name" nv $ \nm -> do
      s <- readIORef ref
      remember ref ctx (RSlot i nm)
      pure . Right . ResultDir $ case Map.lookup i (stNodes s) of
        Nothing -> DirSeen ListAbsent Nothing
        Just nd -> DirSeen (ListSlot (Map.findWithDefault [] nm (nodeDir nd))) (Just (nodeTime nd))
  OpLookup nv -> reading $ withId "name" nv $ \nm -> searchPath top ctx nm
  OpData n -> reading $ withId "node" n $ \i -> do
    s <- readIORef ref
    pure . Right . ResultData $ nodeData <$> Map.lookup i (stNodes s)
  OpMake iv v md -> changing $ withId "id" iv $ \i ->
    commit ref ctx stamp i (KindMake v md) $ \s t -> case Map.lookup i (stNodes s) of
      Just _ -> Left ("a node with id " <> i <> " exists")
      Nothing -> Right (Node v Map.empty t (fromMaybe JNull md))
  OpWrite nv psv -> changing $ withId "node" nv $ \i -> case patchesFrom psv of
    Left why -> pure (Left (invalid why))
    Right ps -> commit ref ctx stamp i (KindWrite ps) $ \s t -> do
      nd <- existing s i
      v' <- applyPatches ps (nodeValue nd)
      Right nd {nodeValue = v', nodeTime = t}
  OpPlace pv nv iv mpos -> changing $ withId "parent" pv $ \p -> withId "name" nv $ \nm -> withId "id" iv $ \i ->
    case traverse whole mpos of
      Left e -> pure (Left e)
      Right pos -> commit ref ctx stamp p (KindPlace nm i pos) $ \s t -> do
        nd <- existing s p
        let slot = Map.findWithDefault [] nm (nodeDir nd)
            rest = filter (/= i) slot
        slot' <- case pos of
          Nothing
            | i `elem` slot -> Right slot
            | otherwise -> Right (slot ++ [i])
          Just k
            | k <= length rest + 1 -> let (a, b) = splitAt k rest in Right (a ++ [i] ++ b)
            | otherwise -> Left "the position is past the end of the slot"
        Right nd {nodeDir = Map.insert nm slot' (nodeDir nd), nodeTime = t}
  OpUnplace pv nv iv -> changing $ withId "parent" pv $ \p -> withId "name" nv $ \nm -> withId "id" iv $ \i ->
    commit ref ctx stamp p (KindUnplace nm i) $ \s t -> do
      nd <- existing s p
      let slot = Map.findWithDefault [] nm (nodeDir nd)
      when (i `notElem` slot) $ Left (i <> " is not in the slot " <> nm)
      let slot' = filter (/= i) slot
          dir' = if null slot' then Map.delete nm (nodeDir nd) else Map.insert nm slot' (nodeDir nd)
      Right nd {nodeDir = dir', nodeTime = t}
  where
    reading k
      | ctxMode ctx == WriteOnly = pure (Left (invalid "this interface only writes"))
      | otherwise = k
    changing k
      | ctxMode ctx == ReadOnly = pure (Left (invalid "this interface only reads"))
      | otherwise = k
    existing s i = maybe (Left ("no node has the id " <> i)) Right (Map.lookup i (stNodes s))
    whole x = maybe (Left (invalid "a position must be a whole number")) Right (asWhole x >>= \k -> if k >= 0 then Just k else Nothing)

-- | Decodes a string argument, or answers invalid.
withId :: Text -> Value -> (Text -> IO (Either Err a)) -> IO (Either Err a)
withId what v k = case asText v of
  Just t -> k t
  Nothing -> pure (Left (invalid ("the " <> what <> " must be a string")))

-- | Remembers a read for marking, when the ctx is a current ReadOnly run.
remember :: IORef St -> Ctx -> Remember -> IO ()
remember ref ctx r = case (ctxMode ctx, ctxProcess ctx, ctxRun ctx) of
  (ReadOnly, Just p, Just tag) -> modifyIORef' ref $ \s -> case Map.lookup p (stReads s) of
    Just rs | readsTag rs == tag -> s {stReads = Map.insert p (add rs) (stReads s)}
    _ -> s
  _ -> pure ()
  where
    add rs = case r of
      RNode i -> rs {readsNodes = Set.insert i (readsNodes rs)}
      RSlot i n -> rs {readsSlots = Set.insert (i, n) (readsSlots rs)}
      RDir i -> rs {readsDirs = Set.insert i (readsDirs rs)}

-- | Applies one change to node @i@: checks the time, builds the node with
-- @f@ (Left: invalid, nothing changes), marks, and sends it to subscribers.
commit
  :: IORef St
  -> Ctx
  -> Stamp
  -> Id
  -> ChangeKind
  -> (St -> Time -> Either Text Node)
  -> IO (Either Err Result)
commit ref ctx stamp i kind f = do
  s <- readIORef ref
  case stampTime stamp of
    Nothing -> pure (Left (invalid "a change needs a time"))
    Just t
      | t <= stLast s -> pure (Left (invalid ("the time " <> Text.pack (show t) <> " is not greater than every time in the graph")))
      | otherwise -> case f s t of
          Left why -> pure (Left (invalid why))
          Right nd -> do
            let change =
                  Change
                    { changeNode = i
                    , changeTime = t
                    , changeKind = kind
                    , changeAgent = ctxAgent ctx
                    , changeProcess = ctxProcess ctx
                    , changeCause = stampCause stamp
                    , changeSite = stampSite stamp
                    }
                marked =
                  [ p
                  | (p, rs) <- Map.toAscList (stReads s)
                  , Just p /= ctxProcess ctx
                  , marks kind i rs
                  ]
                subs = [cb | (n, cb) <- Map.elems (stSubs s), n == i]
            writeIORef ref s {stNodes = Map.insert i nd (stNodes s), stLast = t}
            forM_ subs ($ EventChange change)
            pure (Right (ResultApplied (Applied change marked)))

-- | Whether a change of this kind to node @i@ marks these reads (CORE
-- "Changes": a making or a write marks the readers of the node's value, a
-- placement or an unplacement the readers of that slot or of the whole
-- directory). A making also marks readers of the directory or a slot of the
-- id while it was absent: the directory went from absent to empty.
marks :: ChangeKind -> Id -> Reads -> Bool
marks kind i rs = case kind of
  KindMake {} -> value || Set.member i (readsDirs rs) || any ((== i) . fst) (Set.toList (readsSlots rs))
  KindWrite {} -> value
  KindPlace n _ _ -> slotOrDir n
  KindUnplace n _ -> slotOrDir n
  where
    value = Set.member i (readsNodes rs)
    slotOrDir n = Set.member i (readsDirs rs) || Set.member (i, n) (readsSlots rs)

-- | CORE "Lookup": the parents of the path's steps, last to first; the
-- nearest non-empty slot with the name.
searchPath :: Interface -> Ctx -> Name -> IO (Either Err Result)
searchPath top ctx nm = go (reverse (map stepParent (ctxPath ctx))) []
  where
    go [] acc = done [] acc
    go (p : ps) acc = do
      r <- iOp top ctx noStamp (OpDirectory (str p) (Just (str nm)))
      case r of
        Left (Err Refused _) -> done [] (Searched p Nothing True : acc)
        Left e -> pure (Left e)
        Right (ResultDir (DirSeen l t)) ->
          let acc' = Searched p t False : acc
           in case l of
                ListSlot ids@(_ : _) -> done ids acc'
                _ -> go ps acc'
        Right _ -> pure (Left (invalid "a directory read answered the wrong kind of result"))
    done ids acc = pure (Right (ResultFound (Found ids (reverse acc))))

-- ===========================================================================
-- subscriptions

subscribe :: IORef St -> Ctx -> Value -> (Event -> IO ()) -> IO (Either Err Int)
subscribe ref _ nv cb = case asText nv of
  Nothing -> pure (Left (invalid "the node must be a string"))
  Just i -> atomicModifyIORef' ref $ \s ->
    let n = stNextSub s
     in (s {stSubs = Map.insert n (i, cb) (stSubs s), stNextSub = n + 1}, Right n)

unsubscribe :: IORef St -> Ctx -> Int -> IO (Either Err ())
unsubscribe ref _ n = atomicModifyIORef' ref $ \s ->
  if Map.member n (stSubs s)
    then (s {stSubs = Map.delete n (stSubs s)}, Right ())
    else (s, Left (invalid "no subscription has that number"))

-- ===========================================================================
-- recordings

record :: IORef St -> Api -> RecordStart -> IO Recording
record ref (Api inner ctx) (RecordStart run marked) = do
  let process = fromMaybe "" (ctxProcess ctx)
  tag <- atomicModifyIORef' ref $ \s ->
    let tag = stNextTag s
        reads' = case (ctxMode ctx, ctxProcess ctx) of
          (ReadOnly, Just p) -> Map.insert p (Reads tag Set.empty Set.empty Set.empty) (stReads s)
          _ -> stReads s
     in (s {stNextTag = tag + 1, stReads = reads'}, tag)
  recRef <- newIORef (emptyRecord process run (ctxAgent ctx) marked)
  let ended = Set.member tag . stEnded <$> readIORef ref
      guarded i k = i {iOp = \c st o -> do
                         e <- ended
                         if e then pure (Left (invalid "the run has ended")) else k i c st o}
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
  Left (Err k why) -> rec {recordErrors = recordErrors rec ++ [ErrEntry k (opName o) why]}
  Right res -> case (o, res) of
    (OpRead n, ResultSeen s) ->
      rec {recordReads = recordReads rec ++ [ReadEntry (txt n) (seenTime s)]}
    (OpDirectory n nm, ResultDir d) ->
      rec {recordDirectories = recordDirectories rec ++ [DirEntry (txt n) (txt <$> nm) (dirTime d)]}
    (OpLookup nm, ResultFound f) ->
      rec {recordLookups = recordLookups rec ++ [LookupEntry (txt nm) (foundSearched f) (foundIds f)]}
    (_, ResultApplied a) ->
      rec {recordChanges = recordChanges rec ++ [refOf (appliedChange a)]}
    _ -> rec
  where
    txt = fromMaybe "" . asText

finish :: IORef St -> Recording -> Ending -> IO Record
finish ref rec ending = do
  recordingModify rec (\r -> r {recordEnding = ending})
  r <- recordingCurrent rec
  s <- atomicModifyIORef' ref $ \s ->
    let s' = s {stEnded = Set.insert (recordingTag rec) (stEnded s)} in (s', s')
  forM_ [cb | (n, cb) <- Map.elems (stSubs s), n == recordProcess r] ($ EventRecord r)
  pure r

-- ===========================================================================
-- patches

-- | Applies patches in order; Left why at the first that does not apply
-- (CORE "Patches": path not there, range outside the value, value of the
-- wrong kind). Splices count code points ('Text' indices).
applyPatches :: [Patch] -> Value -> Either Text Value
applyPatches ps v0 = foldM applyPatch v0 ps

applyPatch :: Value -> Patch -> Either Text Value
applyPatch v p = case p of
  Snapshot x -> Right x
  Splice ks a b mx -> at ks v $ \target -> case target of
    JString s
      | a <= b && b <= Text.length s -> case mx of
          Nothing -> Right (JString (Text.take a s <> Text.drop b s))
          Just (JString r) -> Right (JString (Text.take a s <> r <> Text.drop b s))
          Just _ -> Left "a splice of a string takes a string"
      | otherwise -> Left "the range is outside the string"
    JArray xs
      | a <= b && b <= length xs -> case mx of
          Nothing -> Right (JArray (take a xs ++ drop b xs))
          Just (JArray ys) -> Right (JArray (take a xs ++ ys ++ drop b xs))
          Just _ -> Left "a splice of a list takes a list"
      | otherwise -> Left "the range is outside the list"
    _ -> Left "a splice needs a string or a list"
  Set ks k mx -> at ks v $ \target -> case target of
    JObject fs -> Right . JObject $ case mx of
      Nothing -> filter ((/= k) . fst) fs
      Just x
        | any ((== k) . fst) fs -> [(k', if k' == k then x else y) | (k', y) <- fs]
        | otherwise -> fs ++ [(k, x)]
    _ -> Left "a set needs an object"

-- | Changes the value at a path with @f@.
at :: [Key] -> Value -> (Value -> Either Text Value) -> Either Text Value
at [] v f = f v
at (KeyName k : ks) (JObject fs) f = case lookup k fs of
  Just x -> do
    x' <- at ks x f
    Right (JObject [(k', if k' == k then x' else y) | (k', y) <- fs])
  Nothing -> Left ("the path has no key " <> k)
at (KeyIndex i : ks) (JArray xs) f
  | i < length xs = do
      x' <- at ks (xs !! i) f
      Right (JArray (take i xs ++ [x'] ++ drop (i + 1) xs))
  | otherwise = Left "the path's index is outside the list"
at _ _ _ = Left "the path is not there"
