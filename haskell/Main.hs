{-# LANGUAGE OverloadedStrings #-}

-- | The harness: PROTOCOL.tex Lines, Errors, The session, Commands,
-- Encodings, for the graph stack.
--
-- One JSON object per line each way; every request answered in order with
-- its seq; nothing else on stdout; exit when stdin closes. A line that is not
-- one JSON object is answered with code not-a-request, of kind invalid,
-- under the seq a parser reading it from its start reaches before it stops
-- being JSON ('lineSeq'), and under null when there is none.
--
-- * reset with stack "graph" builds graph(root); "protect" and "schedule"
--   answer @{"unsupported": "reset"}@, as do batch, start and fire.
-- * A request is checked before the stack sees it, its fields in
--   PROTOCOL's order (Errors): cmd, agent, process, place, chroot, address,
--   name, id, position, value, ephemeral, patches, cause, time, then any
--   field only that command has (sub). A field that is not there is
--   @missing@, one of the wrong kind @wrong-field@, with the command as the
--   error's op. A time is a whole number from 1 to 2^53-1, a position one
--   from 0. A value is read from its JSON form ('fromForms'): a live value
--   only as the value of a placement making an ephemeral node or of a
--   snapshot, each a new stand-in; whether the snapshot's node may take it
--   is the graph's to say. A request acting as a process may leave its
--   cause out.
-- * Every request but reset, reload and events carries an agent.
-- * Subscriptions are numbered from 1 in each session. After unsubscribe,
--   the next events on that number hands over what arrived before it, once;
--   after that, and for a number there never was, sub is wrong-field.
-- * A cmd the protocol does not have is unknown-command, before the first
--   reset as after it: cmd is checked first. Any other request but reset
--   before the first reset is missing "reset", batch and fire included,
--   since there is no stack yet to not have them.
-- * An error names its command as op when the command is an operation,
--   session or not: the graph's (CORE Operations), and batch and start, the
--   scheduler's (SCHEDULER.tex). events, fire and reload
--   are the harness's, not operations (PROTOCOL The reference protect), and
--   reset builds the session: their errors name no op.
-- * A Haskell exception while answering (a bug) is answered as
--   @{"error": {"kind": "crash", ...}}@ so the run goes on and the failure
--   is visible; it is never one of the protocol's kinds.
module Main (main) where

import Control.Exception (SomeException, evaluate, try)
import Control.Monad (when)
import qualified Data.ByteString as BS
import qualified Data.ByteString.Char8 as BC
import Data.IORef
import qualified Data.Map.Strict as Map
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Graph
import Json
import System.IO
import Types

-- | One harness session: the stack reset built, and each subscription's
-- queue.
data Session = Session
  { sessionTop :: Interface
  , sessionEvents :: IORef (Map.Map Int Queue)
  , sessionLive :: IORef Int -- ^ the last live stand-in given
  }

-- | What arrived for one subscription since the last "events" (newest
-- first), and whether it is still subscribed. After unsubscribe, the next
-- events hands over what is left, once, and the number is gone.
data Queue = Queue {queueEvents :: IORef [Event], queueOpen :: Bool}

-- | What a request is answered with, before its seq is added.
data Reply
  = ReplyOk Value
  | ReplyError Err
  | ReplyUnsupported Text

replyToJson :: Value -> Reply -> Value
replyToJson s r = object (("seq", s) : body)
  where
    body = case r of
      ReplyOk v -> [("ok", v)]
      ReplyError e -> [("error", errToJson e)]
      ReplyUnsupported c -> [("unsupported", str c)]

-- ===========================================================================
-- decoding requests (PROTOCOL Errors: missing, wrong-field)

type Decode a = Either Err a

missing :: Text -> Err
missing f = invalid "missing" [("field", str f)] ("the request has no " <> f)

wrongField :: Text -> Err
wrongField f = invalid "wrong-field" [("field", str f)] ("the request's " <> f <> " is of the wrong kind")

need :: Text -> (Value -> Maybe a) -> Value -> Decode a
need k decode req = case field k req of
  Nothing -> Left (missing k)
  Just v -> maybe (Left (wrongField k)) Right (decode v)

maybeField :: Text -> (Value -> Maybe a) -> Value -> Decode (Maybe a)
maybeField k decode req = case field k req of
  Nothing -> Right Nothing
  Just v -> maybe (Left (wrongField k)) (Right . Just) (decode v)

asName :: Value -> Maybe Name
asName v = asText v >>= \t -> if isName t then Just t else Nothing

-- | A position: a gap in a slot, a whole number from 0.
asPosition :: Value -> Maybe Integer
asPosition v = asWhole v >>= \k -> if k >= 0 then Just k else Nothing

-- | A value in its JSON form, with no live value in it.
asValue :: Value -> Maybe Value
asValue = fromForms False

-- | The acting context: agent, process, place (names from the root) and
-- chroot (how many of them are hidden, 0 to the place's length).
ctxOf :: Value -> Decode Ctx
ctxOf req = do
  agent <- need "agent" asValue req
  process <- maybeField "process" asText req
  place <- fromMaybe [] <$> maybeField "place" (\v -> asList v >>= mapM asName) req
  chroot <- fromMaybe 0 <$> maybeField "chroot" asWhole req
  when (chroot < 0 || chroot > toInteger (length place)) (Left (wrongField "chroot"))
  Right (outside agent process place (fromInteger chroot))

-- | A change from outside carries its cause, which stands for its site; one
-- acting as a process may leave it out, as a process's change has a cause
-- only if its program gives one. Below schedule it carries its time: a
-- whole number from 1 to 2^53-1 (PROTOCOL Encodings, The session).
stampOf :: Value -> Decode Stamp
stampOf req = do
  cause <- maybe (Just <$> need "cause" asValue req) (const (maybeField "cause" asValue req)) (field "process" req)
  time <- need "time" asTime req
  Right (Stamp cause (Just time))
  where
    asTime v = asWhole v >>= \t -> if t >= 1 && t <= 2 ^ (53 :: Int) - 1 then Just t else Nothing

-- | A write's patches: a list, each patch's value read from its JSON form,
-- a live value only as a snapshot's whole value. A patch keeps only the
-- fields a patch has; what is not a map stays as it is, for the graph to
-- find it is not a patch.
asPatches :: Value -> Maybe [Value]
asPatches v = asList v >>= mapM patch
  where
    patch p = case p of
      JObject fs -> do
        let live = lookup "type" fs == Just "snapshot"
        value <- mapM (fromForms live) (lookup "value" fs)
        Just (JObject ([(k, x) | (k, x) <- fs, k `elem` ["type", "path", "range", "key"]] ++ optional "value" value))
      _ -> Just p

-- ===========================================================================
-- the session

-- | reset {stack, root}: a fresh session holding graph(root).
reset :: Value -> IO (Either Reply Session)
reset req = case need "stack" asText req of
  Left e -> pure (Left (ReplyError e))
  Right "graph" -> case need "root" asText req of
    Left e -> pure (Left (ReplyError e))
    Right root -> do
      top <- Graph.graph root
      iSetTop top top
      events <- newIORef Map.empty
      live <- newIORef 0
      pure (Right (Session top events live))
  Right stack
    | stack `elem` ["protect", "schedule"] -> pure (Left (ReplyUnsupported "reset"))
    | otherwise -> pure (Left (ReplyError (wrongField "stack")))

-- | Answers one request, an object. cmd is checked first: whether the
-- protocol has it does not depend on the session, so an unknown one is
-- unknown-command even before the first reset. Any other request but reset
-- before the first reset is missing "reset" (PROTOCOL The session).
respond :: IORef (Maybe Session) -> Value -> IO Reply
respond ref req = case field "cmd" req of
  Nothing -> pure (ReplyError (missing "cmd"))
  Just (JString "reset") -> do
    r <- reset req
    case r of
      Left reply -> pure reply
      Right s -> writeIORef ref (Just s) >> pure (ReplyOk JNull)
  Just (JString cmd)
    | cmd `notElem` commands && cmd `notElem` scheduleCommands -> pure (ReplyError (unknownCommand cmd))
    | otherwise -> do
        ms <- readIORef ref
        case ms of
          Nothing -> pure (ReplyError (opOf cmd noSession))
          Just s
            | cmd `elem` scheduleCommands -> pure (ReplyUnsupported cmd)
            | otherwise -> dispatch s cmd req
  Just _ -> pure (ReplyError (wrongField "cmd"))

-- | A request before the first reset (PROTOCOL The session).
noSession :: Err
noSession = invalid "missing" [("field", "reset")] "there is no session: send reset first"

-- | The commands only schedule has, which the graph stack answers
-- unsupported.
scheduleCommands :: [Text]
scheduleCommands = ["batch", "start", "fire"]

unknownCommand :: Text -> Err
unknownCommand cmd = invalid "unknown-command" [("cmd", str cmd)] "the protocol has no such command"

-- ===========================================================================
-- commands

-- | CORE's operations, which the graph stack answers.
graphOperations :: [Text]
graphOperations = ["read", "directory", "lookup", "write", "place", "unplace", "subscribe", "unsubscribe"]

-- | The operations, which an error answering one names in its op (PROTOCOL
-- Errors), session or not: the graph's, and batch and start, the
-- scheduler's. events, fire and reload are the harness's, not operations
-- (PROTOCOL The reference protect, Commands), and reset builds the session.
operations :: [Text]
operations = graphOperations ++ ["batch", "start"]

-- | What a session answers: the graph's operations, and events and reload,
-- the harness's own, whose errors name no op. reset, batch, start and fire
-- are answered before.
commands :: [Text]
commands = graphOperations ++ ["events", "reload"]

-- | An error answering the command, with the command as its op when it is
-- one of the 'operations'.
opOf :: Text -> Err -> Err
opOf cmd e = if cmd `elem` operations then withOp cmd e else e

-- | One of 'commands', for the session.
dispatch :: Session -> Text -> Value -> IO Reply
dispatch s cmd req = case cmd of
  "read" -> query (OpRead <$> address)
  "directory" -> query (OpDirectory <$> address <*> maybeField "name" asName req)
  "lookup" -> query (OpLookup <$> need "name" asName req)
  "write" -> change (OpWrite <$> address <*> need "patches" asPatches req)
  "place" ->
    change $ do
      a <- address
      nm <- need "name" asName req
      i <- need "id" asText req
      pos <- maybeField "position" asPosition req
      -- "ephemeral": true makes the node ephemeral, and needs a value; a
      -- live value is only the whole value of such a node
      let making = field "ephemeral" req == Just (JBool True)
      value <- if making then Just <$> need "value" (fromForms True) req else maybeField "value" asValue req
      eph <- fromMaybe False <$> maybeField "ephemeral" asBool req
      Right (OpPlace a nm i pos value eph)
  "unplace" -> change (OpUnplace <$> address <*> need "name" asName req <*> need "id" asText req)
  "subscribe" -> decoded ((,) <$> ctxOf req <*> address) $ \(ctx, a) -> do
    queue <- newIORef []
    r <- iSubscribe top ctx a (\e -> modifyIORef' queue (e :))
    case r of
      Left e -> pure (ReplyError e)
      Right n -> do
        modifyIORef' (sessionEvents s) (Map.insert n (Queue queue True))
        pure (ReplyOk (object [("sub", int n)]))
  "unsubscribe" -> decoded ((,) <$> ctxOf req <*> need "sub" asWhole req) $ \(ctx, n) -> do
    r <- iUnsubscribe top ctx (subNumber n)
    case r of
      Left e -> pure (ReplyError e)
      Right () -> do
        -- what arrived before is still handed over, once, by the next events
        modifyIORef' (sessionEvents s) (Map.adjust (\q -> q {queueOpen = False}) (subNumber n))
        pure (ReplyOk JNull)
  -- events is the harness's, not an operation: it needs no agent, and its
  -- errors name no op
  -- reload is the harness's: it carries no agent and is not a change
  "reload" -> do
    iReload top
    writeIORef (sessionEvents s) Map.empty
    pure (ReplyOk JNull)
  "events" -> case need "sub" asWhole req of
    Left e -> pure (ReplyError e)
    Right n -> do
      subs <- readIORef (sessionEvents s)
      case Map.lookup (subNumber n) subs of
        Nothing -> pure (ReplyError (invalid "wrong-field" [("field", "sub")] "there is no such subscription"))
        Just queue -> do
          es <- atomicModifyIORef' (queueEvents queue) (\q -> ([], q))
          if queueOpen queue then pure () else modifyIORef' (sessionEvents s) (Map.delete (subNumber n))
          pure (ReplyOk (JArray (map eventJson (reverse es))))
  _ -> pure (ReplyError (unknownCommand cmd))
  where
    top = sessionTop s
    address = need "address" addressFrom req
    -- a number no subscription has, for one too big to be any
    subNumber n = if n > 0 && n <= toInteger (maxBound :: Int) then fromInteger n else 0
    decoded :: Decode a -> (a -> IO Reply) -> IO Reply
    decoded d k = either (pure . ReplyError . withOp cmd) k d

    change dop = decoded ((,,) <$> ctxOf req <*> dop <*> stampOf req) $ \(ctx, op0, stamp) -> do
      op <- standIns op0
      r <- iOp top ctx stamp op
      pure $ case r of
        Left e -> ReplyError e
        Right (ResultApplied a) -> ReplyOk (changeAnswer a)
        Right _ -> ReplyError (invalid "nothing-there" [] "the stack answered a change with something else")

    query dop = decoded ((,) <$> ctxOf req <*> dop) $ \(ctx, op) -> do
      r <- iOp top ctx noStamp op
      pure $ case r of
        Left e -> ReplyError e
        Right res -> ReplyOk (resultJson res)

    -- each live value a request gives is a new stand-in
    standIns op = case op of
      OpPlace a nm i pos (Just v) eph -> (\v' -> OpPlace a nm i pos (Just v') eph) <$> stand v
      OpWrite a ps -> OpWrite a <$> mapM (\p -> maybe (pure p) (fmap (\v -> setField "value" v p) . stand) (field "value" p)) ps
      _ -> pure op
    stand v = case v of
      JLive k _ -> JLive k <$> atomicModifyIORef' (sessionLive s) (\n -> (n + 1, n + 1))
      _ -> pure v
    setField k v (JObject fs) = JObject [(k', if k' == k then v else x) | (k', x) <- fs]
    setField _ _ p = p

-- | read, directory and lookup answers.
resultJson :: Result -> Value
resultJson r = case r of
  ResultItems items -> object [("items", JArray (map itemToJson items))]
  ResultFound _ items -> object [("items", JArray (map itemToJson items))]
  ResultDirectory listing -> object [("directory", JArray [JArray [str n, JArray (map itemToJson is)] | (n, is) <- listing])]
  ResultApplied a -> changeAnswer a

-- | @{"change": c, "marked": [{"process": id, "by": t}], "gone": [id]?}@.
changeAnswer :: Applied -> Value
changeAnswer (Applied c marked gone) =
  object $
    [ ("change", changeToJson c)
    , ("marked", JArray [object [("process", str p), ("by", integer t)] | (p, t) <- marked])
    ]
      ++ [("gone", JArray (map str gone)) | not (null gone)]

eventJson :: Event -> Value
eventJson (EventChange c reaches) = object ([("change", changeToJson c)] ++ optional "reaches" (JArray . map itemToJson <$> reaches))
eventJson (EventRecord r) = object [("record", recordToJson r)]

-- ===========================================================================
-- lines

-- | The answer to a line that is not one JSON object: under the seq that can
-- be read from it, or null.
notARequest :: BS.ByteString -> Text -> Value
notARequest line why = replyToJson (maybe JNull integer (lineSeq line)) (ReplyError (invalid "not-a-request" [] why))

-- | The seq a line's answer goes under.
seqOf :: BS.ByteString -> Value
seqOf line = case decodeLine line of
  Right request@(JObject _) -> fromMaybe JNull (field "seq" request)
  _ -> maybe JNull integer (lineSeq line)

-- | One line in, one answer out.
answerLine :: IORef (Maybe Session) -> BS.ByteString -> IO Value
answerLine ref line = case decodeLine line of
  Left why -> pure (notARequest line why)
  Right request@(JObject _) -> replyToJson (fromMaybe JNull (field "seq" request)) <$> respond ref request
  Right _ -> pure (notARequest line "a request is one JSON object")

-- | The answer's bytes, forced, so that a bug becomes a "crash" answer and
-- not a dead harness.
answerBytes :: IORef (Maybe Session) -> BS.ByteString -> IO BS.ByteString
answerBytes ref line = do
  r <- try (answerLine ref line >>= evaluate . encodeLine >>= \b -> BS.length b `seq` pure b)
  case r of
    Right b -> pure b
    Left e ->
      pure . encodeLine $
        object [("seq", seqOf line), ("error", object [("kind", "crash"), ("why", object [("code", "crash"), ("text", str (Text.pack (show (e :: SomeException))))])])]

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  hSetBuffering stdout (BlockBuffering Nothing)
  ref <- newIORef Nothing
  let loop = do
        done <- isEOF
        if done
          then pure ()
          else do
            line <- BC.hGetLine stdin
            answer <- answerBytes ref line
            BS.hPut stdout (answer <> "\n")
            hFlush stdout
            loop
  loop
