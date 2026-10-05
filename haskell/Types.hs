{-# LANGUAGE OverloadedStrings #-}

-- | The core's types, the Interface every layer implements, and the
-- protocol's encodings of changes and records.
--
-- HOW STATE IS HELD. Each layer (graph, protect, drive) is built in IO by its
-- constructor ('Graph.graph', 'Protect.protect', 'Drive.drive'), keeps its
-- own state in IORefs it alone can see, and returns an 'Interface': a record
-- of closures over those IORefs. No layer looks inside another's state; they
-- meet only through 'Interface'. Main holds the top of the stack.
--
-- HOW WRAPPERS STACK. A wrapper takes the 'Interface' below it and returns
-- one of the same type, overriding only the fields it changes, e.g.
--
-- >   pure inner { iOp = \ctx st op -> check ... >> iOp inner ctx st op
-- >              , iSetTop = \top -> writeIORef topRef top >> iSetTop inner top }
--
-- Everything it does not change it passes on untouched (record update syntax
-- keeps the inner closures). Every layer MUST pass 'iSetTop' on to the layer
-- below it.
--
-- THE TOP OF THE STACK. Once the stack is built, the builder (Main) calls
-- @iSetTop top top@ exactly once. Each layer keeps the top it is told.
-- Operations a layer makes for others enter at the top, so they pass through
-- every wrapper: the graph's lookup reads each directory with @iOp top@ (so
-- protect can refuse one, and the graph remembers it as a slot read); the
-- driver binds every run's interfaces, its value writes and its lasting
-- interfaces from the top.
--
-- BIND. CORE's @bind(api, {agent, process, path, writes})@ is just pairing an
-- 'Interface' with a 'Ctx': 'bind'. The holder of an 'Api' acts as its ctx.
--
-- RECORD / FINISH. 'iRecord' wraps a bound 'Api' into a 'Recording' for one
-- run; 'iFinish' ends it and returns the 'Record'. The graph implements both;
-- wrappers pass them on. See 'Recording' for exactly what is logged.
module Types
  ( -- * names
    Id
  , Name
  , Time
  , RunTag
    -- * paths
  , Step (..)
  , Path
  , pathFrom
  , pathToJson
    -- * patches
  , Key (..)
  , Patch (..)
  , patchFrom
  , patchesFrom
  , patchToJson
    -- * changes
  , ChangeKind (..)
  , Change (..)
  , ChangeRef (..)
  , refOf
  , changeToJson
  , changeRefToJson
    -- * errors
  , ErrKind (..)
  , Err (..)
  , invalid
  , refused
  , errKindText
  , errToJson
    -- * acting
  , Mode (..)
  , Ctx (..)
  , outside
  , hostCtx
  , Stamp (..)
  , noStamp
    -- * operations
  , Op (..)
  , opName
  , opNode
  , Result (..)
  , Seen (..)
  , Listing (..)
  , DirSeen (..)
  , Searched (..)
  , Found (..)
  , Applied (..)
  , Event (..)
    -- * records
  , Ending (..)
  , endingText
  , ProgramSeen (..)
  , ReadEntry (..)
  , DirEntry (..)
  , LookupEntry (..)
  , ErrEntry (..)
  , Record (..)
  , emptyRecord
  , recordToJson
  , RecordStart (..)
  , Recording (..)
    -- * the interface
  , Interface (..)
  , Api (..)
  , bind
  , apiOp
  , apiMake
  , apiRead
  , apiData
  , apiDirectory
  , apiLookup
  , apiWrite
  , apiPlace
  , apiUnplace
    -- * programs (the loader's seam between Drive and Program)
  , ThrownKind (..)
  , Thrown (..)
  , thrownFromErr
  , ComputeIn (..)
  , ComputeOut (..)
  , EffectIn (..)
  , EffectOut (..)
  , Handler (..)
  , Program (..)
  , Loader
    -- * the driver's extras (Drive builds one, Main uses it)
  , Stopped (..)
  , Ran (..)
  , Fired (..)
  , Driver (..)
  ) where

import Data.Text (Text)
import Json

-- ===========================================================================
-- names

-- | A node id: a string given by the node's maker; the core only compares ids.
type Id = Text

-- | A name in a directory.
type Name = Text

-- | A change's time: a whole number, at least 1, unique and increasing in
-- one graph (CORE "Changes").
type Time = Int

-- | Issued by the graph to each recording; carried in 'ctxRun'.
type RunTag = Int

-- ===========================================================================
-- paths (CORE "Path"; PROTOCOL Encodings: path step)

data Step = Step {stepParent :: Id, stepName :: Name, stepNode :: Id}
  deriving (Eq, Show)

-- | A list of steps. Only its shape is checked ('pathFrom'): each step has
-- three strings, and each step's parent is the node of the step before
-- (PROTOCOL Encodings). Whether the steps exist in the graph is not checked
-- (PROTOCOL: "A process's path is taken as given; only its shape is
-- checked"). The graph never checks paths at make: a process node's path is
-- in its fixed data, which only the driver reads.
type Path = [Step]

-- | A list of @{"parent": id, "name": s, "node": id}@, all three strings,
-- each step's parent the node of the step before. Extra keys are ignored.
pathFrom :: Value -> Either Text Path
pathFrom v = case v of
  JArray steps -> mapM step steps >>= chained
  _ -> Left "a path must be a list of steps"
  where
    chained ps
      | and (zipWith (\a b -> stepNode a == stepParent b) ps (drop 1 ps)) = Right ps
      | otherwise = Left "a path step's parent must be the node of the step before"
    step s = do
      p <- textAt "parent" s
      n <- textAt "name" s
      x <- textAt "node" s
      Right (Step p n x)
    textAt k s = case field k s >>= asText of
      Just t -> Right t
      Nothing -> Left ("a path step needs a string " <> k)

pathToJson :: Path -> Value
pathToJson = JArray . map (\(Step p n x) -> object [("parent", str p), ("name", str n), ("node", str x)])

-- ===========================================================================
-- patches (CORE "Patches")

-- | A key of a patch path: a string into an object, a whole number (>= 0)
-- into a list.
data Key = KeyName Text | KeyIndex Int
  deriving (Eq, Show)

data Patch
  = -- | @{"type":"snapshot","value":v}@
    Snapshot Value
  | -- | @{"type":"splice","path":[k],"range":[from,to],"value":v?}@: replace
    -- [from,to) of the string (counted in code points; value a string) or
    -- list (value a list) at path; no value deletes the range.
    Splice [Key] Int Int (Maybe Value)
  | -- | @{"type":"set","path":[k],"key":k,"value":v?}@: set or add key k of
    -- the object at path; no value deletes the key.
    Set [Key] Text (Maybe Value)
  deriving (Eq, Show)

-- | Decodes one patch's SHAPE. Whether it applies to a value (path there,
-- range inside, value of the right kind) is the graph's to check. A bad shape
-- is an invalid write: callers turn @Left why@ into @invalid why@.
patchFrom :: Value -> Either Text Patch
patchFrom v = case field "type" v >>= asText of
  Just "snapshot" -> case field "value" v of
    Just x -> Right (Snapshot x)
    Nothing -> Left "a snapshot needs a value"
  Just "splice" -> do
    ks <- keysAt
    (a, b) <- case field "range" v >>= asList of
      Just [x, y] | Just a <- asWhole x, Just b <- asWhole y, a >= 0, b >= 0 -> Right (a, b)
      _ -> Left "a splice needs a range of two whole numbers"
    Right (Splice ks a b (field "value" v))
  Just "set" -> do
    ks <- keysAt
    k <- maybe (Left "a set needs a string key") Right (field "key" v >>= asText)
    Right (Set ks k (field "value" v))
  _ -> Left "a patch's type must be snapshot, splice or set"
  where
    keysAt = case field "path" v of
      Just (JArray ks) -> mapM key ks
      _ -> Left "a patch needs a path, a list of keys"
    key (JString t) = Right (KeyName t)
    key k | Just i <- asWhole k, i >= 0 = Right (KeyIndex i)
    key _ = Left "a key must be a string or a whole number"

-- | A write's patches: a list of patches.
patchesFrom :: Value -> Either Text [Patch]
patchesFrom (JArray ps) = mapM patchFrom ps
patchesFrom _ = Left "patches must be a list"

patchToJson :: Patch -> Value
patchToJson p = case p of
  Snapshot v -> object [("type", "snapshot"), ("value", v)]
  Splice ks a b v ->
    object ([("type", "splice"), ("path", keys ks), ("range", JArray [int a, int b])] ++ optional "value" v)
  Set ks k v -> object ([("type", "set"), ("path", keys ks), ("key", str k)] ++ optional "value" v)
  where
    keys = JArray . map (\k -> case k of KeyName t -> str t; KeyIndex i -> int i)

-- ===========================================================================
-- changes (CORE "Changes"; PROTOCOL Encodings, Changes)

data ChangeKind
  = -- | value, and the fixed data when the maker gave it
    KindMake Value (Maybe Value)
  | KindWrite [Patch]
  | -- | name, id, position if one was given
    KindPlace Name Id (Maybe Int)
  | KindUnplace Name Id
  deriving (Eq, Show)

data Change = Change
  { changeNode :: Id -- ^ the node changed; for a placement, the parent
  , changeTime :: Time
  , changeKind :: ChangeKind
  , changeAgent :: Value
  , changeProcess :: Maybe Id
  , changeCause :: Maybe Value -- ^ Just JNull is a cause of null
  , changeSite :: Maybe Value -- ^ stored as given, never captured
  }
  deriving (Eq, Show)

-- | A node and a time name one change in this graph.
data ChangeRef = ChangeRef {refNode :: Id, refTime :: Time}
  deriving (Eq, Ord, Show)

refOf :: Change -> ChangeRef
refOf c = ChangeRef (changeNode c) (changeTime c)

changeRefToJson :: ChangeRef -> Value
changeRefToJson (ChangeRef n t) = object [("node", str n), ("time", int t)]

changeToJson :: Change -> Value
changeToJson c =
  object $
    [("node", str (changeNode c)), ("time", int (changeTime c))]
      ++ kind
      ++ [("agent", changeAgent c)]
      ++ optional "process" (str <$> changeProcess c)
      ++ optional "cause" (changeCause c)
      ++ optional "site" (changeSite c)
  where
    kind = case changeKind c of
      KindMake v d -> [("kind", "make"), ("value", v)] ++ optional "data" d
      KindWrite ps -> [("kind", "write"), ("patches", JArray (map patchToJson ps))]
      KindPlace n i pos -> [("kind", "place"), ("name", str n), ("id", str i)] ++ optional "position" (int <$> pos)
      KindUnplace n i -> [("kind", "unplace"), ("name", str n), ("id", str i)]

-- ===========================================================================
-- errors (PROTOCOL Lines: invalid when the graph rejected it, refused when a
-- wrapper said no)

data ErrKind = Invalid | Refused
  deriving (Eq, Show)

data Err = Err {errKind :: ErrKind, errWhy :: Text}
  deriving (Eq, Show)

invalid :: Text -> Err
invalid = Err Invalid

refused :: Text -> Err
refused = Err Refused

errKindText :: ErrKind -> Text
errKindText Invalid = "invalid"
errKindText Refused = "refused"

-- | @{"kind": k, "why": text}@, the body of an error answer.
errToJson :: Err -> Value
errToJson (Err k w) = object [("kind", str (errKindText k)), ("why", str w)]

-- ===========================================================================
-- acting (CORE Operations: "Every operation carries an agent, and may carry
-- a process; writes also carry a time and a site, and may carry a cause.")

-- | What a bound interface may do.
data Mode
  = -- | from outside any run, and the driver's own housekeeping
    ReadWrite
  | -- | a compute: make/write/place/unplace are invalid
    ReadOnly
  | -- | an effect, the value write, cleanups, handlers (the lasting
    -- interface): read/directory/lookup are invalid
    WriteOnly
  deriving (Eq, Show)

-- | The acting context: fixed by 'bind', passed unchanged through every
-- layer down to the graph.
data Ctx = Ctx
  { ctxAgent :: Value
  , ctxProcess :: Maybe Id
  , ctxPath :: Path -- ^ what lookup searches; [] finds nothing
  , ctxMode :: Mode
  , ctxRun :: Maybe RunTag
  -- ^ set only by a 'Recording' (never by hand). The graph remembers a read
  -- for marking iff ctxRun is the CURRENT tag of ctxProcess and ctxMode is
  -- ReadOnly. Outside requests have Nothing, so "below drive nothing runs,
  -- so no process has reads".
  }
  deriving (Eq, Show)

-- | A request from outside: agent, optional process, path ([] if none),
-- ReadWrite, no run.
outside :: Value -> Maybe Id -> Path -> Ctx
outside a p path = Ctx a p path ReadWrite Nothing

-- | The context the driver uses for its own housekeeping (walking the tree,
-- reading a process's current value to compare): agent null, no process, no
-- path, ReadWrite, no run. The driver sends these to the bare graph,
-- beneath protect (PROTOCOL "The tree"), so they neither re-enter the driver
-- nor are checked by protect.
hostCtx :: Ctx
hostCtx = Ctx JNull Nothing [] ReadWrite Nothing

-- | Per-call fields of a change. The cause is carried and not looked inside;
-- the site is stored as given; the time is given by whoever holds the bare
-- graph: in a graph or protect stack the request's "time", with drive the
-- driver (which fills it when Nothing: one more than the last change it saw
-- applied). Reads take 'noStamp'.
data Stamp = Stamp
  { stampCause :: Maybe Value
  , stampSite :: Maybe Value
  , stampTime :: Maybe Time
  }
  deriving (Eq, Show)

noStamp :: Stamp
noStamp = Stamp Nothing Nothing Nothing

-- ===========================================================================
-- operations (CORE Operations)
--
-- Arguments are raw JSON values as the caller had them (a request field, or
-- what a program's expression evaluated to), so that the GRAPH decides what
-- is invalid (an id that is not a string, a bad path, bad patches, a position
-- that is not a whole number) and the error passes back up through every
-- layer, including a run's recording. Use 'asText', 'pathFrom',
-- 'patchesFrom', 'asWhole' to decode.

data Op
  = -- | id, value, fixed data (null when not given)
    OpMake Value Value (Maybe Value)
  | -- | node
    OpRead Value
  | -- | node: its fixed data
    OpData Value
  | -- | node, name (one slot when given)
    OpDirectory Value (Maybe Value)
  | -- | name; searches 'ctxPath'
    OpLookup Value
  | -- | node, patches (a list)
    OpWrite Value Value
  | -- | parent, name, id, position
    OpPlace Value Value Value (Maybe Value)
  | -- | parent, name, id
    OpUnplace Value Value Value
  deriving (Eq, Show)

-- | The command's name: what protect's rule "op" matches, and the "op" of a
-- record's error.
opName :: Op -> Text
opName o = case o of
  OpMake {} -> "make"
  OpRead {} -> "read"
  OpData {} -> "data"
  OpDirectory {} -> "directory"
  OpLookup {} -> "lookup"
  OpWrite {} -> "write"
  OpPlace {} -> "place"
  OpUnplace {} -> "unplace"

-- | The node an operation is on, for protect's rule "node": the new id for a
-- make, the parent for a placement, none for a lookup.
opNode :: Op -> Maybe Value
opNode o = case o of
  OpMake i _ _ -> Just i
  OpRead n -> Just n
  OpData n -> Just n
  OpDirectory n _ -> Just n
  OpLookup _ -> Nothing
  OpWrite n _ -> Just n
  OpPlace p _ _ _ -> Just p
  OpUnplace p _ _ -> Just p

-- | What an operation answers: OpMake/OpWrite/OpPlace/OpUnplace give
-- 'Applied', OpRead 'Seen', OpData 'ResultData' (Nothing: absent),
-- OpDirectory 'DirSeen', OpLookup 'Found'.
data Result
  = ResultApplied Applied
  | ResultSeen Seen
  | ResultData (Maybe Value)
  | ResultDir DirSeen
  | ResultFound Found
  deriving (Eq, Show)

-- | A read: the value or absent (Nothing), and the time of the node's latest
-- change, Nothing if absent.
data Seen = Seen {seenValue :: Maybe Value, seenTime :: Maybe Time}
  deriving (Eq, Show)

data Listing
  = -- | the node is absent
    ListAbsent
  | -- | one slot's ids, in slot order; [] when the slot is gone
    ListSlot [Id]
  | -- | the whole directory, names in code point order, slots non-empty
    ListWhole [(Name, [Id])]
  deriving (Eq, Show)

-- | A directory read and the time of its node's latest change (Nothing if
-- absent).
data DirSeen = DirSeen {dirListing :: Listing, dirTime :: Maybe Time}
  deriving (Eq, Show)

-- | One directory a lookup searched. 'searchedRefused' is True for the
-- directory whose read was refused, which ends the search and is last; its
-- time is then Nothing (it was not read).
data Searched = Searched {searchedNode :: Id, searchedTime :: Maybe Time, searchedRefused :: Bool}
  deriving (Eq, Show)

-- | The ids of the nearest slot with the name ([] if none), and every
-- directory searched, nearest first.
data Found = Found {foundIds :: [Id], foundSearched :: [Searched]}
  deriving (Eq, Show)

-- | A change and the processes it marked, in code point order of their ids,
-- never including the change's own process. Each was marked by this change.
data Applied = Applied {appliedChange :: Change, appliedMarked :: [Id]}
  deriving (Eq, Show)

-- | What a subscriber receives: each change to the node, and each record of
-- a process at that node (sent by 'iFinish').
data Event = EventChange Change | EventRecord Record
  deriving (Eq, Show)

-- ===========================================================================
-- records (CORE Records; PROTOCOL Encodings, Records)

data Ending = Done | Pending | Failed | RefusedEnding
  deriving (Eq, Show)

endingText :: Ending -> Text
endingText e = case e of
  Done -> "done"
  Pending -> "pending"
  Failed -> "failed"
  RefusedEnding -> "refused"

-- | A program slot: the first id (the one used), when it was last changed
-- (Nothing: absent), and every id the slot held. 'programRefused' is True
-- when the read of the program node was refused: the slot is known but the
-- node was not seen, so the encoding gives @"refused": true@ and no saw.
data ProgramSeen = ProgramSeen {programNode :: Id, programTime :: Maybe Time, programSlot :: [Id], programRefused :: Bool}
  deriving (Eq, Show)

data ReadEntry = ReadEntry {readNode :: Id, readTime :: Maybe Time}
  deriving (Eq, Show)

data DirEntry = DirEntry {dirNode :: Id, dirName :: Maybe Name, dirSaw :: Maybe Time}
  deriving (Eq, Show)

data LookupEntry = LookupEntry {lookupName :: Name, lookupSearched :: [Searched], lookupFound :: [Id]}
  deriving (Eq, Show)

data ErrEntry = ErrEntry {errEntryKind :: ErrKind, errEntryOp :: Text, errEntryWhy :: Text}
  deriving (Eq, Show)

-- | All lists are in the order things happened (oldest first).
data Record = Record
  { recordProcess :: Id
  , recordRun :: Int
  , recordAgent :: Value
  , recordMarked :: [ChangeRef]
  , recordCompute :: Maybe ProgramSeen -- ^ Nothing when the compute slot is gone
  , recordEffect :: Maybe ProgramSeen -- ^ Nothing when the effect slot is gone
  , recordLookups :: [LookupEntry]
  , recordReads :: [ReadEntry]
  , recordDirectories :: [DirEntry]
  , recordValue :: Maybe Value -- ^ what the compute returned, if it returned
  , recordCleanup :: [ChangeRef]
  , recordChanges :: [ChangeRef] -- ^ the value change, if any, then the effect's
  , recordEnding :: Ending
  , recordErrors :: [ErrEntry]
  }
  deriving (Eq, Show)

-- | process, run, agent, marked; everything else empty, ending Done.
emptyRecord :: Id -> Int -> Value -> [ChangeRef] -> Record
emptyRecord p n a m = Record p n a m Nothing Nothing [] [] [] Nothing [] [] Done []

recordToJson :: Record -> Value
recordToJson r =
  object $
    [ ("process", str (recordProcess r))
    , ("run", int (recordRun r))
    , ("agent", recordAgent r)
    , ("marked", JArray (map changeRefToJson (recordMarked r)))
    ]
      ++ optional "compute" (programJson <$> recordCompute r)
      ++ optional "effect" (programJson <$> recordEffect r)
      ++ [ ("lookups", JArray (map lookupJson (recordLookups r)))
         , ("reads", JArray [object [("node", str n), ("saw", saw t)] | ReadEntry n t <- recordReads r])
         , ( "directories"
           , JArray [object ([("node", str n)] ++ optional "name" (str <$> nm) ++ [("saw", saw t)]) | DirEntry n nm t <- recordDirectories r]
           )
         ]
      ++ optional "value" (recordValue r)
      ++ [ ("cleanup", JArray (map changeRefToJson (recordCleanup r)))
         , ("changes", JArray (map changeRefToJson (recordChanges r)))
         , ("ending", str (endingText (recordEnding r)))
         , ("errors", JArray [object [("kind", str (errKindText k)), ("op", str o), ("why", str w)] | ErrEntry k o w <- recordErrors r])
         ]
  where
    saw = maybe JNull int
    programJson (ProgramSeen n t slot refusedRead) =
      object $
        [("node", str n)]
          ++ (if refusedRead then [("refused", JBool True)] else maybe [("absent", JBool True)] (\x -> [("saw", int x)]) t)
          ++ [("slot", JArray (map str slot))]
    lookupJson (LookupEntry n s f) =
      object
        [ ("name", str n)
        , ("searched", JArray (map searchedJson s))
        , ("found", JArray (map str f))
        ]
    searchedJson (Searched n t ref)
      | ref = object [("node", str n), ("refused", JBool True)]
      | otherwise = object [("node", str n), ("saw", saw t)]

-- | What a run's record starts with: its run number (the driver counts runs
-- per process from 1) and the changes that marked it, oldest first.
data RecordStart = RecordStart {startRun :: Int, startMarked :: [ChangeRef]}
  deriving (Eq, Show)

-- | One run being recorded. Made by 'iRecord' (graph), ended by 'iFinish'.
--
-- The recorder logs every operation made through 'recordingApi' or through
-- an api wrapped by 'recordingWith', in order:
--
--   * OpRead ok      -> 'recordReads'       += ReadEntry node (seenTime)
--   * OpDirectory ok -> 'recordDirectories' += DirEntry node name (dirTime)
--   * OpLookup ok    -> 'recordLookups'     += LookupEntry name searched found
--   * a change ok    -> 'recordChanges'     += refOf change
--   * any Left err   -> 'recordErrors'      += ErrEntry kind (opName op) why
--
-- Operations through 'recordingQuiet' are remembered by the graph for marking
-- (same ctxRun) but logged nowhere; the driver uses it to read the program
-- slots and program nodes, which it reports in 'recordCompute' /
-- 'recordEffect' via 'recordingModify'. Everything else in the record
-- (compute, effect, value, cleanup, ending) is the driver's to set with
-- 'recordingModify'. After 'iFinish', operations through any of these apis
-- answer @invalid "the run has ended"@.
--
-- Creating a recording whose api is ReadOnly REPLACES the process's
-- remembered reads with an empty set under the new tag ("each run's reads
-- replace the previous run's"); the run's compute reads, the quiet program
-- reads, and every slot read by its lookups then accumulate there.
data Recording = Recording
  { recordingTag :: RunTag
  , recordingApi :: Api -- ^ the api given to 'iRecord', recorded (ctxRun set)
  , recordingWith :: Api -> Api -- ^ records another bound api into this same run (the effect's, the value write's)
  , recordingQuiet :: Api -- ^ recordingApi's ctx, remembered for marking, not logged
  , recordingModify :: (Record -> Record) -> IO ()
  , recordingCurrent :: IO Record
  }

-- ===========================================================================
-- the interface

-- | One layer of the stack. See the module header for how wrappers stack and
-- how the top is passed.
data Interface = Interface
  { iOp :: Ctx -> Stamp -> Op -> IO (Either Err Result)
  -- ^ make, read, directory, lookup, write, place, unplace
  , iSubscribe :: Ctx -> Value -> (Event -> IO ()) -> IO (Either Err Int)
  -- ^ node (may be absent; an id that is not a string is invalid) and a
  -- callback, called synchronously with each event as it happens. Answers the
  -- subscription number, counting from 1 in each graph.
  , iUnsubscribe :: Ctx -> Int -> IO (Either Err ())
  -- ^ an unknown number is invalid
  , iRecord :: Api -> RecordStart -> IO Recording
  -- ^ wraps a bound api (which must have a process) for one run
  , iFinish :: Recording -> Ending -> IO Record
  -- ^ sets the ending, ends the recording, sends the record to the process
  -- node's subscribers, and returns it
  , iSetTop :: Interface -> IO ()
  -- ^ told the top of the stack once it is built; pass it on below
  }

-- | A bound interface: CORE's @bind@. The holder acts as 'apiCtx'.
data Api = Api {apiInterface :: Interface, apiCtx :: Ctx}

bind :: Interface -> Ctx -> Api
bind = Api

apiOp :: Api -> Stamp -> Op -> IO (Either Err Result)
apiOp (Api i c) = iOp i c

wrong :: Either Err a
wrong = Left (invalid "an operation answered the wrong kind of result")

applied :: Either Err Result -> Either Err Applied
applied r = r >>= \x -> case x of ResultApplied a -> Right a; _ -> wrong

apiMake :: Api -> Stamp -> Value -> Value -> Maybe Value -> IO (Either Err Applied)
apiMake a s i v p = applied <$> apiOp a s (OpMake i v p)

apiRead :: Api -> Value -> IO (Either Err Seen)
apiRead a n = (>>= \x -> case x of ResultSeen s -> Right s; _ -> wrong) <$> apiOp a noStamp (OpRead n)

-- | A node's fixed data; Nothing when the node is absent.
apiData :: Api -> Value -> IO (Either Err (Maybe Value))
apiData a n = (>>= \x -> case x of ResultData d -> Right d; _ -> wrong) <$> apiOp a noStamp (OpData n)

apiDirectory :: Api -> Value -> Maybe Value -> IO (Either Err DirSeen)
apiDirectory a n nm = (>>= \x -> case x of ResultDir d -> Right d; _ -> wrong) <$> apiOp a noStamp (OpDirectory n nm)

apiLookup :: Api -> Value -> IO (Either Err Found)
apiLookup a nm = (>>= \x -> case x of ResultFound f -> Right f; _ -> wrong) <$> apiOp a noStamp (OpLookup nm)

apiWrite :: Api -> Stamp -> Value -> Value -> IO (Either Err Applied)
apiWrite a s n ps = applied <$> apiOp a s (OpWrite n ps)

apiPlace :: Api -> Stamp -> Value -> Value -> Value -> Maybe Value -> IO (Either Err Applied)
apiPlace a s p n i pos = applied <$> apiOp a s (OpPlace p n i pos)

apiUnplace :: Api -> Stamp -> Value -> Value -> Value -> IO (Either Err Applied)
apiUnplace a s p n i = applied <$> apiOp a s (OpUnplace p n i)

-- ===========================================================================
-- programs: the loader (CORE "The graph marks; the driver runs": the host
-- gives the driver a loader, which turns a program node's value into a
-- function it can call). Program.hs implements 'Loader'; Drive.hs calls it.

data ThrownKind
  = -- | an operation was refused
    ThrownRefused
  | -- | an operation was invalid
    ThrownInvalid
  | -- | a throw step, or an operator given the wrong kind of value
    ThrownOther
  deriving (Eq, Show)

-- | An error raised in a program. 'thrownValue' is what @try ... as x@ binds
-- and what a fire answer's "error" holds:
--
--   * an operation's error: @{"kind": "invalid"|"refused", "op": s, "why": text}@
--   * a throw step:         @{"kind": "thrown", "why": m}@
--   * an operator's error:  @{"kind": "thrown", "why": text}@
data Thrown = Thrown {thrownKind :: ThrownKind, thrownValue :: Value}
  deriving (Eq, Show)

-- | An operation's error as a program sees it.
thrownFromErr :: Text -> Err -> Thrown
thrownFromErr op (Err k w) =
  Thrown
    (if k == Refused then ThrownRefused else ThrownInvalid)
    (object [("kind", str (errKindText k)), ("op", str op), ("why", str w)])

-- | What a compute is given (PROTOCOL Variables: self, path, changes).
data ComputeIn = ComputeIn
  { computeApi :: Api -- ^ read-only, recorded
  , computeSelf :: Id
  , computePath :: Path
  , computeChanges :: [Change] -- ^ the changes that marked the run, oldest first; the variable holds them as 'changeToJson'
  }

data ComputeOut
  = Returned Value -- ^ a compute that ends without return returns null
  | WentPending
  | Threw Thrown -- ^ uncaught: the run ends refused if a refusal, failed otherwise
  deriving (Eq, Show)

-- | What an effect is given (PROTOCOL Variables: self, value, previous).
data EffectIn = EffectIn
  { effectApi :: Api -- ^ write-only, recorded into the same run
  , effectSelf :: Id
  , effectValue :: Value
  , effectPrevious :: Maybe Value -- ^ absent on the first run since started
  }

-- | Handlers registered during the effect, in the order registered (a later
-- one of the same name replaces an earlier, and replaces the process's
-- existing handler of that name), and the effect's cleanup (the last cleanup
-- step run; Nothing if none). Registrations made before an uncaught throw
-- still count.
data EffectOut = EffectOut
  { effectThrew :: Maybe Thrown
  , effectHandlers :: [(Text, Handler)]
  , effectCleanup :: Maybe Handler
  }

-- | Handler or cleanup steps, closed over nothing but their steps. Run with
-- the process's LASTING interface (bound from the top: agent = the process's
-- agent, process = Just it, path = its path, mode WriteOnly, no run), the
-- process id ("self"), and "input" (Nothing: absent; always Nothing for a
-- cleanup). Answers the uncaught error, if any.
newtype Handler = Handler {runHandler :: Api -> Id -> Maybe Value -> IO (Maybe Thrown)}

-- | A loaded program: the same steps, run as a compute or as an effect
-- according to the slot the program node sits in.
data Program = Program
  { programCompute :: ComputeIn -> IO ComputeOut
  , programEffect :: EffectIn -> IO EffectOut
  }

-- | A program node's value to a program; Left when the value is not a list of
-- steps (the run then fails).
type Loader = Value -> Either Text Program

-- ===========================================================================
-- the driver's extras (PROTOCOL Commands: runs, stopped, batch, fire)

-- | A process the walk no longer reached, with the changes its cleanup made.
data Stopped = Stopped {stoppedProcess :: Id, stoppedChanges :: [Change]}
  deriving (Eq, Show)

-- | Everything finished since the last 'driverTake': records in the order
-- they were finished, stopped processes in the order the walk last reached
-- them.
data Ran = Ran {ranRuns :: [Record], ranStopped :: [Stopped]}
  deriving (Eq, Show)

-- | A fire's handler: the changes it made (in order), and its uncaught error.
data Fired = Fired {firedChanges :: [Change], firedError :: Maybe Thrown}
  deriving (Eq, Show)

data Driver = Driver
  { driverInterface :: Interface
  -- ^ the drive layer: the top of the stack. Its iOp stamps times, applies,
  -- queues what was marked, walks the tree, and (unless already running
  -- rounds or inside a batch) runs rounds until nothing is due before it
  -- returns.
  , driverBatch :: IO () -> IO ()
  -- ^ runs the action with rounds held, then runs rounds once
  , driverFire :: Ctx -> Id -> Text -> Maybe Value -> IO (Either Err Fired)
  -- ^ requester's ctx, process, handler name, input. Runs the handler with
  -- the process's lasting interface outside any run, then runs what it
  -- marked. Left (invalid) when the process is not running or has no such
  -- handler.
  , driverTake :: IO Ran
  -- ^ takes (and clears) what finished since the last take
  }
