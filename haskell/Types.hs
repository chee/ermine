{-# LANGUAGE OverloadedStrings #-}

-- | The core's types, the Interface every layer implements, and the
-- protocol's encodings of changes, items, errors and records.
--
-- HOW STATE IS HELD. Each layer is built in IO by its constructor (only
-- 'Graph.graph' exists now), keeps its own state in IORefs it alone can see,
-- and returns an 'Interface': a record of closures over those IORefs. Layers
-- meet only through 'Interface'. Main holds the top of the stack.
--
-- HOW WRAPPERS STACK. A wrapper takes the 'Interface' below it and returns
-- one of the same type, overriding only the fields it changes, e.g.
--
-- >   pure inner { iOp = \ctx st op -> check ... >> iOp inner ctx st op
-- >              , iSetTop = \top -> writeIORef topRef top >> iSetTop inner top }
--
-- Every layer MUST pass 'iSetTop' on to the layer below it.
--
-- THE TOP OF THE STACK. Once the stack is built, the builder (Main) calls
-- @iSetTop top top@ exactly once. Operations a layer makes for others enter
-- at the top, so they pass through every wrapper: the graph's lookup reads
-- each directory it searches with @iOp top@, as an ordinary read of one slot
-- (CORE "Lookup").
--
-- BIND. CORE's @bind(api, {agent, process, place, reads, writes})@ is pairing
-- an 'Interface' with a 'Ctx': 'bind'. The holder of an 'Api' acts as its ctx.
--
-- RECORD / FINISH. 'iRecord' wraps a bound 'Api' into a 'Recording' for one
-- run; 'iFinish' ends it and returns the 'Record'. The graph implements both;
-- wrappers pass them on. Nothing in the graph stack uses them: below drive no
-- process runs, so no process has reads and "marked" is always [].
module Types
  ( -- * names
    Id
  , Name
  , Time
  , RunTag
  , isName
    -- * addresses (CORE "Paths"; PROTOCOL Encodings)
  , Address (..)
  , addressFrom
  , addressToJson
    -- * routes and froms
  , Step (..)
  , Route
  , routeToJson
  , From (..)
  , fromToJson
    -- * changes
  , ChangeKind (..)
  , Change (..)
  , ChangeRef (..)
  , refOf
  , changeToJson
  , changeRefToJson
    -- * items (CORE "Reads are lists")
  , Item (..)
  , itemToJson
  , itemChange
    -- * errors (PROTOCOL Errors)
  , ErrKind (..)
  , Err (..)
  , errKindText
  , err
  , invalid
  , withOp
  , errToJson
    -- * acting
  , Mode (..)
  , Ctx (..)
  , outside
  , Stamp (..)
  , noStamp
    -- * operations
  , Op (..)
  , opName
  , Result (..)
  , Searched (..)
  , Applied (..)
  , Event (..)
    -- * records (CORE Records; PROTOCOL Encodings, Records)
  , Ending (..)
  , endingText
  , ReadEntry (..)
  , LookupEntry (..)
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
  ) where

import Data.Text (Text)
import Json

-- ===========================================================================
-- names

-- | A node id: a string; the core only compares ids.
type Id = Text

-- | A name in a directory.
type Name = Text

-- | A change's time: a whole number, unique and increasing in one graph
-- (CORE "Changes"). An 'Integer': a time has no upper bound (PROTOCOL
-- Encodings), and any whole binary64, 1e21 say, is held exactly.
type Time = Integer

-- | Issued by the graph to each recording; carried in 'ctxRun'.
type RunTag = Int

-- | ".", ".." and "/" are never names (CORE "Address"); anything else is.
isName :: Text -> Bool
isName t = t /= "." && t /= ".." && t /= "/"

-- ===========================================================================
-- addresses

-- | A list of parts: an optional first "/", then any "..", then names
-- (CORE "Address"). 'addressRoot' is the first "/", 'addressUp' the number
-- of "..".
data Address = Address {addressRoot :: Bool, addressUp :: Int, addressNames :: [Name]}
  deriving (Eq, Show)

-- | Nothing when the value is not a list of parts in that order.
addressFrom :: Value -> Maybe Address
addressFrom v = do
  parts <- asList v >>= mapM asText
  let (root, afterRoot) = case parts of
        "/" : rest -> (True, rest)
        _ -> (False, parts)
      (ups, names) = span (== "..") afterRoot
  if all isName names then Just (Address root (length ups) names) else Nothing

addressToJson :: Address -> Value
addressToJson (Address root ups names) =
  JArray (map str ((if root then ["/"] else []) ++ replicate ups ".." ++ names))

-- ===========================================================================
-- routes and froms (PROTOCOL Encodings: route, from)

-- | One name walked: the slot's node, its name, the member taken and the
-- member's position among the slot's ids.
data Step = Step {stepParent :: Id, stepName :: Name, stepNode :: Id, stepPosition :: Int}
  deriving (Eq, Show)

type Route = [Step]

routeToJson :: Route -> Value
routeToJson =
  JArray . map (\(Step p n x k) -> object [("parent", str p), ("name", str n), ("node", str x), ("position", int k)])

-- | Why a reader got an item (CORE "From").
data From
  = -- | an item reached by an address: the route it took
    FromRoute Route
  | -- | an item in a slot: the route to the slot's node, and the position
    FromSlot Route Int
  | -- | a lookup's item: the path from the place to the slot it was found
    -- in, such as @["..", "theme"]@, and its position there
    FromPath Address Int
  deriving (Eq, Show)

fromToJson :: From -> Value
fromToJson f = case f of
  FromRoute r -> object [("route", routeToJson r)]
  FromSlot r k -> object [("route", routeToJson r), ("position", int k)]
  FromPath a k -> object [("path", addressToJson a), ("position", int k)]

-- ===========================================================================
-- changes (CORE "Changes"; PROTOCOL Encodings, Changes)

data ChangeKind
  = -- | the patches as given; each applied
    KindWrite [Value]
  | -- | name, id, the position as given, and the value when the placement
    -- made the node
    KindPlace Name Id (Maybe Integer) (Maybe Value)
  | KindUnplace Name Id
  deriving (Eq, Show)

data Change = Change
  { changeNode :: Id -- ^ the node changed; for a placement, the parent
  , changeTime :: Time
  , changeKind :: ChangeKind
  , changeAgent :: Value
  , changeProcess :: Maybe Id
  , changeCause :: Maybe Value -- ^ Just JNull is a cause of null
  }
  deriving (Eq, Show)

-- | A node and a time name one change in this graph.
data ChangeRef = ChangeRef {refNode :: Id, refTime :: Time}
  deriving (Eq, Ord, Show)

refOf :: Change -> ChangeRef
refOf c = ChangeRef (changeNode c) (changeTime c)

changeRefToJson :: ChangeRef -> Value
changeRefToJson (ChangeRef n t) = object [("node", str n), ("time", integer t)]

changeToJson :: Change -> Value
changeToJson c =
  object $
    [("node", str (changeNode c)), ("time", integer (changeTime c))]
      ++ kind
      ++ [("agent", changeAgent c)]
      ++ optional "process" (str <$> changeProcess c)
      ++ optional "cause" (changeCause c)
  where
    kind = case changeKind c of
      KindWrite ps -> [("kind", "write"), ("patches", JArray ps)]
      KindPlace n i pos v ->
        [("kind", "place"), ("name", str n), ("id", str i)] ++ optional "position" (integer <$> pos) ++ optional "value" v
      KindUnplace n i -> [("kind", "unplace"), ("name", str n), ("id", str i)]

-- ===========================================================================
-- items (CORE "Reads are lists"; PROTOCOL Encodings, item)

data Item
  = -- | a value, why the reader got it, and the change that last set it
    -- (Nothing only for the root's first value)
    ItemValue Value From (Maybe Change)
  | -- | an id in a slot, why, the change that last set the slot, and whether
    -- the id's node is not here yet (pending)
    ItemId Id From Change Bool
  deriving (Eq, Show)

itemChange :: Item -> Maybe Change
itemChange (ItemValue _ _ c) = c
itemChange (ItemId _ _ c _) = Just c

itemToJson :: Item -> Value
itemToJson i = case i of
  ItemValue v f c -> object ([("value", v), ("from", fromToJson f)] ++ optional "change" (changeToJson <$> c))
  ItemId x f c pending ->
    object ([("id", str x), ("from", fromToJson f), ("change", changeToJson c)] ++ [("pending", JBool True) | pending])

-- ===========================================================================
-- errors (PROTOCOL Errors: {"kind", "op"?, "why": {"code", ...details, "text"?}})

data ErrKind = Invalid | Refused
  deriving (Eq, Show)

data Err = Err
  { errKind :: ErrKind
  , errOp :: Maybe Text -- ^ the operation, when there was one
  , errCode :: Text -- ^ from PROTOCOL's fixed table
  , errDetails :: Fields -- ^ the code's details, fixed by the table
  , errText :: Text -- ^ for people; never compared
  }
  deriving (Eq, Show)

errKindText :: ErrKind -> Text
errKindText Invalid = "invalid"
errKindText Refused = "refused"

-- | An error with no op yet.
err :: ErrKind -> Text -> Fields -> Text -> Err
err k = Err k Nothing

-- | An invalid error with no op yet: code, details, text.
invalid :: Text -> Fields -> Text -> Err
invalid = err Invalid

-- | Names the operation, unless one is named already.
withOp :: Text -> Err -> Err
withOp o e = e {errOp = maybe (Just o) Just (errOp e)}

errToJson :: Err -> Value
errToJson (Err k o c ds t) =
  object $
    [("kind", str (errKindText k))]
      ++ optional "op" (str <$> o)
      ++ [("why", object ([("code", str c)] ++ ds ++ [("text", str t) | t /= ""]))]

-- ===========================================================================
-- acting (CORE Operations: "Every operation carries an agent, and may carry
-- a process; changes also carry a time, and a cause when they have one.")

-- | What a bound interface may do.
data Mode
  = -- | from outside any run
    ReadWrite
  | -- | a compute: write, place and unplace are invalid (read-only)
    ReadOnly
  | -- | an effect: read, directory and lookup are invalid (write-only)
    WriteOnly
  deriving (Eq, Show)

-- | The acting context: fixed by 'bind', passed unchanged through every
-- layer down to the graph.
data Ctx = Ctx
  { ctxAgent :: Value
  , ctxProcess :: Maybe Id
  , ctxPlace :: [Name] -- ^ the place: names from the graph's root
  , ctxChroot :: Int -- ^ how many of the place's names are hidden: its "/" is the node they reach
  , ctxMode :: Mode
  , ctxRun :: Maybe RunTag
  -- ^ set only by a 'Recording'. The graph remembers a read for marking
  -- only when ctxMode is ReadOnly and ctxRun is the current run of
  -- ctxProcess, so requests from outside never leave reads behind.
  }
  deriving (Eq, Show)

-- | A request from outside: agent, optional process, place and chroot;
-- ReadWrite, no run.
outside :: Value -> Maybe Id -> [Name] -> Int -> Ctx
outside a p place chroot = Ctx a p place chroot ReadWrite Nothing

-- | Per-call fields of a change: its cause (carried, never looked inside)
-- and its time (from a clock outside the graph). Reads take 'noStamp'.
data Stamp = Stamp {stampCause :: Maybe Value, stampTime :: Maybe Time}
  deriving (Eq, Show)

noStamp :: Stamp
noStamp = Stamp Nothing Nothing

-- ===========================================================================
-- operations (CORE Operations)
--
-- Arguments are decoded by whoever makes the request (PROTOCOL Errors: the
-- request itself is checked first, for missing and wrong-field). Patches stay
-- raw: whether each is a patch, and applies, is the graph's to say.

data Op
  = OpRead Address
  | -- | address, the one slot's name when given
    OpDirectory Address (Maybe Name)
  | OpLookup Name
  | -- | address, patches
    OpWrite Address [Value]
  | -- | address, name, id, position, value
    OpPlace Address Name Id (Maybe Integer) (Maybe Value)
  | -- | address, name, id
    OpUnplace Address Name Id
  deriving (Eq, Show)

-- | The operation's name: the "op" of its errors.
opName :: Op -> Text
opName o = case o of
  OpRead {} -> "read"
  OpDirectory {} -> "directory"
  OpLookup {} -> "lookup"
  OpWrite {} -> "write"
  OpPlace {} -> "place"
  OpUnplace {} -> "unplace"

-- | What an operation answers: read, a directory read with a name, and a
-- lookup give items ('ResultFound' also says which directories the lookup
-- searched); a directory read without a name gives each name with its
-- items; a change gives 'Applied'.
data Result
  = ResultItems [Item]
  | ResultDirectory [(Name, [Item])]
  | ResultFound [Searched] [Item]
  | ResultApplied Applied
  deriving (Eq, Show)

-- | One directory a lookup searched, nearest first: its node, the time of
-- the last change to the slot read there (Nothing: no items), and whether
-- the read was refused, which ends the search.
data Searched = Searched {searchedNode :: Id, searchedSaw :: Maybe Time, searchedRefused :: Bool}
  deriving (Eq, Show)

-- | A change and the processes it marked, in code point order of their ids,
-- the change's own process included (CORE Operations).
data Applied = Applied {appliedChange :: Change, appliedMarked :: [Id]}
  deriving (Eq, Show)

-- | What a subscriber receives: each change to the node its address reaches,
-- and the placement that switched it; and each record of a process there.
data Event = EventChange Change | EventRecord Record
  deriving (Eq, Show)

-- ===========================================================================
-- records

data Ending = Done | Pending | Failed | RefusedEnding
  deriving (Eq, Show)

endingText :: Ending -> Text
endingText e = case e of
  Done -> "done"
  Pending -> "pending"
  Failed -> "failed"
  RefusedEnding -> "refused"

-- | A read a run made: read or directory, its address and name, the route of
-- its first item ([] when it gave none), and the time of the latest change
-- among its items (Nothing when it gave none).
data ReadEntry = ReadEntry
  { readOp :: Text
  , readAddress :: Address
  , readName :: Maybe Name
  , readRoute :: Route
  , readSaw :: Maybe Time
  }
  deriving (Eq, Show)

data LookupEntry = LookupEntry {lookupName :: Name, lookupSearched :: [Searched], lookupFound :: [Id]}
  deriving (Eq, Show)

-- | All lists are in the order things happened (oldest first). 'recordCompute'
-- and 'recordEffect' are the driver's to fill, as it encodes them.
data Record = Record
  { recordProcess :: Id
  , recordRun :: Int
  , recordAgent :: Value
  , recordMarked :: [ChangeRef]
  , recordCompute :: Maybe Value
  , recordEffect :: Maybe Value
  , recordLookups :: [LookupEntry]
  , recordReads :: [ReadEntry]
  , recordValue :: Maybe Value
  , recordCleanup :: [ChangeRef]
  , recordChanges :: [ChangeRef]
  , recordEnding :: Ending
  , recordErrors :: [Err]
  }
  deriving (Eq, Show)

-- | process, run, agent, marked; everything else empty, ending Done.
emptyRecord :: Id -> Int -> Value -> [ChangeRef] -> Record
emptyRecord p n a m = Record p n a m Nothing Nothing [] [] Nothing [] [] Done []

recordToJson :: Record -> Value
recordToJson r =
  object $
    [ ("process", str (recordProcess r))
    , ("run", int (recordRun r))
    , ("agent", recordAgent r)
    , ("marked", JArray (map changeRefToJson (recordMarked r)))
    ]
      ++ optional "compute" (recordCompute r)
      ++ optional "effect" (recordEffect r)
      ++ [ ("lookups", JArray (map lookupJson (recordLookups r)))
         , ("reads", JArray (map readJson (recordReads r)))
         ]
      ++ optional "value" (recordValue r)
      ++ [ ("cleanup", JArray (map changeRefToJson (recordCleanup r)))
         , ("changes", JArray (map changeRefToJson (recordChanges r)))
         , ("ending", str (endingText (recordEnding r)))
         , ("errors", JArray (map errToJson (recordErrors r)))
         ]
  where
    saw = maybe JNull integer
    readJson (ReadEntry o a n route t) =
      object $
        [("op", str o), ("address", addressToJson a)]
          ++ optional "name" (str <$> n)
          ++ [("route", routeToJson route), ("saw", saw t)]
    lookupJson (LookupEntry n s f) =
      object [("name", str n), ("searched", JArray (map searchedJson s)), ("found", JArray (map str f))]
    searchedJson (Searched n t refusedRead)
      | refusedRead = object [("node", str n), ("refused", JBool True)]
      | otherwise = object [("node", str n), ("saw", saw t)]

-- | What a run's record starts with: its run number and the changes that
-- marked it, oldest first.
data RecordStart = RecordStart {startRun :: Int, startMarked :: [ChangeRef]}
  deriving (Eq, Show)

-- | One run being recorded. Made by 'iRecord' (graph), ended by 'iFinish'.
--
-- The recorder logs every operation made through 'recordingApi' or through
-- an api wrapped by 'recordingWith', in order: reads and directory reads in
-- 'recordReads', lookups in 'recordLookups', changes in 'recordChanges', and
-- every error in 'recordErrors'. Operations through 'recordingQuiet' are
-- remembered for marking but logged nowhere. The rest of the record is the
-- driver's to set with 'recordingModify'. After 'iFinish', operations
-- through any of these apis are invalid (code stopped).
--
-- A recording whose api is ReadOnly starts a new run of reads for its
-- process: they count for marking from the moment they are made, alongside
-- the last finished run's, and replace them when the run is finished.
data Recording = Recording
  { recordingTag :: RunTag
  , recordingApi :: Api -- ^ the api given to 'iRecord', recorded (ctxRun set)
  , recordingWith :: Api -> Api -- ^ records another bound api into this same run
  , recordingQuiet :: Api -- ^ recordingApi's ctx, remembered for marking, not logged
  , recordingModify :: (Record -> Record) -> IO ()
  , recordingCurrent :: IO Record
  }

-- ===========================================================================
-- the interface

-- | One layer of the stack. See the module header.
data Interface = Interface
  { iOp :: Ctx -> Stamp -> Op -> IO (Either Err Result)
  -- ^ read, directory, lookup, write, place, unplace
  , iSubscribe :: Ctx -> Address -> (Event -> IO ()) -> IO (Either Err Int)
  -- ^ an address (it may reach nothing) and a callback, called synchronously
  -- with each event as it happens. Answers the subscription's number,
  -- counting from 1 in each graph.
  , iUnsubscribe :: Ctx -> Int -> IO (Either Err ())
  , iRecord :: Api -> RecordStart -> IO Recording
  -- ^ wraps a bound api (which must have a process) for one run
  , iFinish :: Recording -> Ending -> IO Record
  -- ^ sets the ending, ends the recording, sends the record to the
  -- subscribers whose address reaches the process node, and returns it
  , iSetTop :: Interface -> IO ()
  -- ^ told the top of the stack once it is built; pass it on below
  }

-- | A bound interface: CORE's @bind@. The holder acts as 'apiCtx'.
data Api = Api {apiInterface :: Interface, apiCtx :: Ctx}

bind :: Interface -> Ctx -> Api
bind = Api

apiOp :: Api -> Stamp -> Op -> IO (Either Err Result)
apiOp (Api i c) = iOp i c
