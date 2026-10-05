{-# LANGUAGE OverloadedStrings #-}

-- | The harness: PROTOCOL.tex Lines, The session, Commands, Encodings.
-- Owner: the Protect+Main agent.
--
-- One JSON object per line each way; answer every request in order with the
-- same seq; nothing else on stdout; exit when stdin closes. A line that is
-- not one JSON object: an invalid error under its seq if it can be read,
-- null otherwise.
--
-- Choices the protocol leaves to the harness:
--
-- * A request needs a string cmd and, except reset and events, an agent;
--   missing required fields are invalid (Main's own check). Argument values
--   are passed to the stack raw, so the graph decides whether they are good.
-- * reset answers @null@. A request before the first reset is invalid.
-- * A request's "process" is the process it acts as, except in fire, where
--   it names the process whose handler runs (fire acts as no process).
-- * "path" is the path a request acts at (lookup needs it). A make's
--   "data" is the new node's fixed data, passed raw; the graph never looks
--   inside it.
-- * Below drive, a change's "time" must be a whole number if given; a missing
--   one is passed on as missing and the graph rejects it. With drive any
--   "time" is ignored: the driver keeps the time.
-- * With drive, every change answer carries "runs" and "stopped" (from the
--   driver's take after the request, failed requests included). Inside a
--   batch each inner answer is built the same way, so an inner change answer
--   has its own (normally empty) runs and the stops its walk caused; the
--   batch's "runs" (and "stopped") are what finished after the last request.
--   fire's answer also carries "stopped".
-- * events on an unknown subscription is invalid; unsubscribing keeps what
--   arrived before, for a later events.
-- * A Haskell exception while answering (a bug) is answered as
--   @{"error": {"kind": "crash", "why": ...}}@ so the run goes on and the
--   failure is visible; it is never one of the protocol's kinds.
module Main (main) where

import Control.Exception (SomeException, evaluate, try)
import qualified Data.ByteString as BS
import qualified Data.ByteString.Char8 as BC
import Data.IORef
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Drive
import qualified Graph
import Json
import qualified Program
import qualified Protect
import System.IO
import Types

-- | One harness session: the stack reset built.
data Session = Session
  { sessionTop :: Interface -- ^ the top of the stack; every request enters here
  , sessionDriver :: Maybe Driver -- ^ Just with stack "drive"
  , sessionEvents :: IORef (Map.Map Int (IORef [Event])) -- ^ per subscription, newest first, since the last "events"
  }

-- | What a request is answered with, before its seq is added.
data Reply
  = ReplyOk Value
  | ReplyError Err
  | ReplyUnsupported Text

-- | The answer without its seq: @{"ok": v}@, @{"error": {"kind","why"}}@ or
-- @{"unsupported": cmd}@. Also the shape of a batch's inner answers.
replyBody :: Reply -> Fields
replyBody r = case r of
  ReplyOk v -> [("ok", v)]
  ReplyError e -> [("error", errToJson e)]
  ReplyUnsupported c -> [("unsupported", str c)]

replyToJson :: Value -> Reply -> Value
replyToJson s r = object (("seq", s) : replyBody r)

-- ===========================================================================
-- the session

-- | reset: builds graph(), protect(graph(), may) or drive(protect(graph(),
-- may), root, Program.load), then calls @iSetTop top top@ once. The driver
-- is also handed the bare graph, for its own bookkeeping (the tree walk and
-- comparing a process's value), which reads beneath protect.
reset :: Value -> IO (Either Err Session)
reset req = case field "stack" req >>= asText of
  Just "graph" -> Graph.graph >>= built Nothing
  Just "protect" -> withRules $ \may -> do
    g <- Graph.graph
    Protect.protect g may >>= built Nothing
  Just "drive" -> case field "root" req >>= asText of
    Nothing -> pure (Left (invalid "a drive reset needs a string root"))
    Just root -> withRules $ \may -> do
      g <- Graph.graph
      p <- Protect.protect g may
      d <- Drive.drive p g root Program.load
      built (Just d) (driverInterface d)
  Just other -> pure (Left (invalid ("there is no stack " <> other)))
  Nothing -> pure (Left (invalid "reset needs a string stack"))
  where
    withRules k = case Protect.rulesFrom (field "rules" req) of
      Left why -> pure (Left (invalid why))
      Right rules -> k (Protect.mayFromRules rules)
    built d top = do
      iSetTop top top
      events <- newIORef Map.empty
      pure (Right (Session top d events))

-- | Answers one request (an object with a string cmd). The session is
-- Nothing until the first reset.
respond :: IORef (Maybe Session) -> Text -> Value -> IO Reply
respond ref "reset" req = do
  r <- reset req
  case r of
    Left e -> pure (ReplyError e)
    Right s -> writeIORef ref (Just s) >> pure (ReplyOk JNull)
respond ref cmd req = do
  ms <- readIORef ref
  case ms of
    Nothing -> pure (ReplyError (invalid "no session: send reset first"))
    Just s -> dispatch s cmd req

-- ===========================================================================
-- commands

-- | Decoding a request: Left is Main's own invalid answer.
type Decode a = Either Err a

need :: Text -> Text -> Value -> Decode Value
need cmd k req = maybe (Left (invalid (cmd <> " needs " <> k))) Right (field k req)

needText :: Text -> Text -> Value -> Decode Text
needText cmd k req = need cmd k req >>= \v -> maybe (Left (invalid (cmd <> "'s " <> k <> " must be a string"))) Right (asText v)

needWhole :: Text -> Text -> Value -> Decode Int
needWhole cmd k req = need cmd k req >>= \v -> maybe (Left (invalid (cmd <> "'s " <> k <> " must be a whole number"))) Right (asWhole v)

-- | The acting context of a request from outside: its agent, the process it
-- acts as, the path it acts at.
ctxOf :: Text -> Value -> Decode Ctx
ctxOf cmd req = do
  agent <- need cmd "agent" req
  process <- if cmd == "fire" then Right Nothing else optionalText "process"
  path <- case (cmd, field "path" req) of
    ("lookup", Nothing) -> Left (invalid "lookup needs a path")
    (_, p) -> maybe (Right []) (either (Left . invalid) Right . pathFrom) p
  Right (outside agent process path)
  where
    optionalText k = case field k req of
      Nothing -> Right Nothing
      Just v -> maybe (Left (invalid (k <> " must be a string"))) (Right . Just) (asText v)

-- | A change's stamp: cause and site as given; below drive the request's
-- time, with drive none (the driver keeps the time).
stampOf :: Session -> Value -> Decode Stamp
stampOf s req = do
  t <- case (sessionDriver s, field "time" req) of
    (Just _, _) -> Right Nothing
    (Nothing, Nothing) -> Right Nothing
    (Nothing, Just v) -> maybe (Left (invalid "time must be a whole number")) (Right . Just) (asWhole v)
  Right (Stamp (field "cause" req) (field "site" req) t)

-- | What the driver finished since the last take (Nothing below drive).
takeRan :: Session -> IO (Maybe Ran)
takeRan s = maybe (pure Nothing) (fmap Just . driverTake) (sessionDriver s)

dispatch :: Session -> Text -> Value -> IO Reply
dispatch s cmd req = case cmd of
  "make" -> change (OpMake <$> need cmd "id" req <*> need cmd "value" req <*> pure (field "data" req))
  "write" -> change (OpWrite <$> need cmd "node" req <*> need cmd "patches" req)
  "place" ->
    change (OpPlace <$> need cmd "parent" req <*> need cmd "name" req <*> need cmd "id" req <*> pure (field "position" req))
  "unplace" -> change (OpUnplace <$> need cmd "parent" req <*> need cmd "name" req <*> need cmd "id" req)
  "read" -> query (OpRead <$> need cmd "node" req)
  "data" -> query (OpData <$> need cmd "node" req)
  "directory" -> query (OpDirectory <$> need cmd "node" req <*> pure (field "name" req))
  "lookup" -> query (OpLookup <$> need cmd "name" req)
  "subscribe" -> decoded ((,) <$> ctxOf cmd req <*> need cmd "node" req) $ \(ctx, node) -> do
    queue <- newIORef []
    r <- iSubscribe top ctx node (\e -> modifyIORef' queue (e :))
    case r of
      Left e -> pure (ReplyError e)
      Right n -> do
        modifyIORef' (sessionEvents s) (Map.insert n queue)
        pure (ReplyOk (object [("sub", int n)]))
  "unsubscribe" -> decoded ((,) <$> ctxOf cmd req <*> needWhole cmd "sub" req) $ \(ctx, n) ->
    either ReplyError (const (ReplyOk JNull)) <$> iUnsubscribe top ctx n
  "events" -> decoded (needWhole cmd "sub" req) $ \n -> do
    subs <- readIORef (sessionEvents s)
    case Map.lookup n subs of
      Nothing -> pure (ReplyError (invalid ("there is no subscription " <> Text.pack (show n))))
      Just queue -> do
        es <- atomicModifyIORef' queue (\q -> ([], q))
        pure (ReplyOk (JArray (map eventJson (reverse es))))
  "batch" -> withDriver $ \d -> decoded (need cmd "requests" req >>= requestList) $ \reqs -> do
    answers <- newIORef []
    driverBatch d $ mapM_ (\r -> inner r >>= \a -> modifyIORef' answers (a :)) reqs
    ran <- takeRan s
    as <- readIORef answers
    pure (ReplyOk (object ([("answers", JArray (reverse as))] ++ ranFields ran)))
  "fire" -> withDriver $ \d ->
    decoded ((,,) <$> ctxOf cmd req <*> needText cmd "process" req <*> needText cmd "handler" req) $ \(ctx, p, h) -> do
      r <- driverFire d ctx p h (field "input" req)
      ran <- takeRan s
      pure $ case r of
        Left e -> ReplyError e
        Right (Fired cs err) ->
          ReplyOk
            ( object
                ( [("changes", JArray (map changeToJson cs))]
                    ++ ranFields ran
                    ++ optional "error" (thrownValue <$> err)
                )
            )
  _ -> pure (ReplyUnsupported cmd)
  where
    top = sessionTop s
    decoded :: Decode a -> (a -> IO Reply) -> IO Reply
    decoded d k = either (pure . ReplyError) k d
    withDriver k = maybe (pure (ReplyUnsupported cmd)) k (sessionDriver s)

    change dop = decoded ((,,) <$> ctxOf cmd req <*> stampOf s req <*> dop) $ \(ctx, st, op) -> do
      r <- iOp top ctx st op
      ran <- takeRan s
      pure $ case r of
        Left e -> ReplyError e
        Right (ResultApplied a) -> ReplyOk (changeAnswer a ran)
        Right _ -> ReplyError (invalid "the stack answered a change with something else")

    query dop = decoded ((,) <$> ctxOf cmd req <*> dop) $ \(ctx, op) -> do
      r <- iOp top ctx noStamp op
      pure $ case r of
        Left e -> ReplyError e
        Right res -> ReplyOk (resultJson res)

    requestList v = maybe (Left (invalid "batch's requests must be a list")) Right (asList v)

    -- one request of a batch, answered without a seq
    inner r = do
      rep <- case (r, field "cmd" r >>= asText) of
        (JObject _, Just "reset") -> pure (ReplyError (invalid "a batch cannot reset"))
        (JObject _, Just c) -> dispatch s c r
        _ -> pure (ReplyError (invalid "a batch's request must be an object with a string cmd"))
      pure (object (replyBody rep))

-- | read, directory and lookup answers.
resultJson :: Result -> Value
resultJson r = case r of
  ResultSeen (Seen v _) -> maybe absent (\x -> object [("value", x)]) v
  ResultData d -> maybe absent (\x -> object [("data", x)]) d
  ResultDir (DirSeen l _) -> case l of
    ListAbsent -> absent
    ListSlot ids -> object [("slot", ids' ids)]
    ListWhole slots -> object [("directory", JArray [JArray [str n, ids' ids] | (n, ids) <- slots])]
  ResultFound (Found ids _) -> object [("found", ids' ids)]
  ResultApplied a -> changeAnswer a Nothing
  where
    absent = object [("absent", JBool True)]
    ids' = JArray . map str

eventJson :: Event -> Value
eventJson (EventChange c) = object [("change", changeToJson c)]
eventJson (EventRecord r) = object [("record", recordToJson r)]

-- | "runs" and "stopped", with drive.
ranFields :: Maybe Ran -> Fields
ranFields Nothing = []
ranFields (Just (Ran runs stopped)) =
  [ ("runs", JArray (map recordToJson runs))
  , ("stopped", JArray [object [("process", str p), ("changes", JArray (map changeToJson cs))] | Stopped p cs <- stopped])
  ]

-- | A change answer: @{"change": c, "marked": [{"process": id, "by": ref}]}@,
-- and with drive also "runs" and "stopped" (always present) from 'Ran'.
changeAnswer :: Applied -> Maybe Ran -> Value
changeAnswer (Applied c marked) ran =
  object
    ( [ ("change", changeToJson c)
      , ("marked", JArray [object [("process", str p), ("by", changeRefToJson (refOf c))] | p <- marked])
      ]
        ++ ranFields ran
    )

-- ===========================================================================
-- lines

-- | One line in, one answer out.
answerLine :: IORef (Maybe Session) -> BS.ByteString -> IO Value
answerLine ref line = case decodeLine line of
  Left why -> pure (replyToJson JNull (ReplyError (invalid why)))
  Right request@(JObject _) -> do
    let s = maybe JNull id (field "seq" request)
    case field "cmd" request >>= asText of
      Nothing -> pure (replyToJson s (ReplyError (invalid "a request needs a string cmd")))
      Just cmd -> replyToJson s <$> respond ref cmd request
  Right _ -> pure (replyToJson JNull (ReplyError (invalid "a request must be one JSON object")))

-- | The answer's bytes, forced, so that a bug becomes a "crash" answer and
-- not a dead harness.
answerBytes :: IORef (Maybe Session) -> BS.ByteString -> IO BS.ByteString
answerBytes ref line = do
  r <- try (answerLine ref line >>= evaluate . encodeLine >>= \b -> BS.length b `seq` pure b)
  case r of
    Right b -> pure b
    Left e -> do
      let s = case decodeLine line of
            Right req -> maybe JNull id (field "seq" req)
            Left _ -> JNull
      pure . encodeLine $
        object [("seq", s), ("error", object [("kind", "crash"), ("why", str (Text.pack (show (e :: SomeException))))])]

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
