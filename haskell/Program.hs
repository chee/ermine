{-# LANGUAGE OverloadedStrings #-}

-- | The loader for the test program language: PROTOCOL.tex "Programs as
-- data" (Expressions, Variables, Steps). Owner: the Drive+Program agent.
--
-- * A program node's value must be a list of step objects, else 'load' is
--   Left (the run fails).
-- * Expressions: any JSON; an object with exactly one key starting with "$"
--   is an operator ($, $get, $eq, $not, $absent, $add, $concat, $len,
--   $quote); other lists/objects are evaluated member by member, and a
--   member that evaluates to absent throws (absent is never a value).
--   Absent is a result of evaluation (Maybe Value), never stored in a JSON
--   value; a variable may hold it.
-- * Compute variables: self, path (the process node's data.path, as
--   'pathToJson'), changes (list of
--   'changeToJson'). Effect: self, value, previous (absent on a first run).
--   Handler: self, input (absent if not given). Cleanup: self.
-- * read/directory/lookup in an effect, handler or cleanup are made anyway
--   and come back invalid from the graph (mode WriteOnly), so they land in
--   the record's errors; make/write/place/unplace in a compute likewise
--   (mode ReadOnly). "pending" outside a compute, and "handler"/"cleanup"
--   outside an effect, throw (ThrownOther).
-- * Operation errors become 'thrownFromErr' with the op name; try binds
--   'thrownValue' (null when nothing was thrown). A throw step's message is
--   the error's why, as given (PROTOCOL: {"kind": "thrown", "why": m}).
-- * Change steps pass cause as 'stampCause'; no site, no time (the driver
--   stamps times).
-- * Variables live in one flat scope per part: a let/read/each inside an
--   if, each or try is still bound after it.
-- * Choices the spec leaves open: "$get" answers absent for any key that
--   is not there, including a key into a value that is not an object or a
--   list; "$concat" of no arguments is []; "return" with no value returns
--   null; a directory step on an absent node binds [].
module Program
  ( load
  , evaluate
  ) where

import Control.Monad (foldM, forM_, when)
import Control.Monad.Except (ExceptT, catchError, runExceptT, throwError)
import Control.Monad.State.Strict (StateT, evalStateT, get, lift, modify')
import Data.IORef
import qualified Data.Map.Strict as Map
import Data.Maybe (isNothing)
import Data.Text (Text)
import qualified Data.Text as Text
import Json
import Types

-- ===========================================================================
-- expressions

type Env = Map.Map Text (Maybe Value)

thrown :: Text -> Thrown
thrown m = Thrown ThrownOther (object [("kind", "thrown"), ("why", str m)])

-- | Evaluates an expression; Nothing is absent.
evaluate :: Env -> Value -> Either Thrown (Maybe Value)
evaluate env v = case v of
  JObject [(k, a)] | "$" `Text.isPrefixOf` k -> operator k a
  JObject fs -> Just . JObject <$> mapM (\(k, x) -> (,) k <$> present x) fs
  JArray xs -> Just . JArray <$> mapM present xs
  _ -> Right (Just v)
  where
    present x = evaluate env x >>= maybe (Left (thrown "absent is not a value")) Right
    args a = case a of
      JArray es -> mapM present es
      _ -> present a >>= \x -> case x of
        JArray es -> Right es
        _ -> Left (thrown "an operator needs a list")
    operator k a = case k of
      "$" -> case a of
        JString name -> maybe (Left (thrown ("no variable " <> name))) Right (Map.lookup name env)
        _ -> Left (thrown "$ needs a variable name")
      "$get" -> case a of
        JArray (e : ks) -> do
          x <- present e
          ks' <- mapM present ks
          foldM step (Just x) ks'
        _ -> Left (thrown "$get needs a list of a value and keys")
      "$eq" -> args a >>= \xs -> case xs of
        [x, y] -> Right (Just (JBool (x == y)))
        _ -> Left (thrown "$eq needs two values")
      "$not" -> present a >>= \x -> case x of
        JBool b -> Right (Just (JBool (not b)))
        _ -> Left (thrown ("$not needs a boolean, not " <> kindOf x))
      "$absent" -> Just . JBool . isNothing <$> evaluate env a
      "$add" -> args a >>= \xs -> case mapM asNumber xs of
        Just ns -> Right (Just (JNumber (foldl (+) 0 ns)))
        Nothing -> Left (thrown "$add needs numbers")
      "$concat" -> args a >>= \xs -> case xs of
        [] -> Right (Just (JArray []))
        _
          | Just ts <- mapM asText xs -> Right (Just (JString (Text.concat ts)))
          | Just ls <- mapM asList xs -> Right (Just (JArray (concat ls)))
          | otherwise -> Left (thrown "$concat needs all strings or all lists")
      "$len" -> present a >>= \x -> case x of
        JString t -> Right (Just (int (Text.length t)))
        JArray es -> Right (Just (int (length es)))
        JObject fs -> Right (Just (int (length fs)))
        _ -> Left (thrown ("$len needs a string, list or object, not " <> kindOf x))
      "$quote" -> Right (Just a)
      _ -> Left (thrown ("no operator " <> k))
    step Nothing _ = Right Nothing
    step (Just (JObject fs)) (JString key) = Right (lookup key fs)
    step (Just (JArray es)) key
      | Just i <- asWhole key, i >= 0, i < length es = Right (Just (es !! i))
    step _ _ = Right Nothing

-- ===========================================================================
-- steps

data Kind = KCompute | KEffect | KHandler
  deriving (Eq)

data Part = Part
  { partKind :: Kind
  , partApi :: Api
  , partHandlers :: IORef [(Text, Handler)] -- ^ newest first
  , partCleanup :: IORef (Maybe Handler)
  }

data Ctl = CReturn Value | CPending | CThrow Thrown

type M = ExceptT Ctl (StateT Env IO)

throwM :: Text -> M a
throwM = throwError . CThrow . thrown

io :: IO a -> M a
io = lift . lift

ev :: Value -> M (Maybe Value)
ev e = do
  env <- get
  either (throwError . CThrow) pure (evaluate env e)

evP :: Value -> M Value
evP e = ev e >>= maybe (throwM "absent is not a value") pure

-- | A required field, evaluated, present.
need :: Text -> Value -> M Value
need k s = maybe (throwM ("a step needs " <> k)) evP (field k s)

-- | An optional field, evaluated, present when given.
maybeField :: Text -> Value -> M (Maybe Value)
maybeField k s = maybe (pure Nothing) (fmap Just . evP) (field k s)

nameAt :: Text -> Value -> M Text
nameAt k s = maybe (throwM ("a step needs a string " <> k)) pure (field k s >>= asText)

stepsAt :: Text -> Value -> M [Value]
stepsAt k s = case field k s of
  Just (JArray xs) -> pure xs
  _ -> throwM ("a step needs a list of steps in " <> k)

bindVar :: Text -> Maybe Value -> M ()
bindVar x v = modify' (Map.insert x v)

result :: Text -> IO (Either Err a) -> M a
result name act = io act >>= either (throwError . CThrow . thrownFromErr name) pure

run :: Part -> [Value] -> M ()
run part = mapM_ (runStep part)

runStep :: Part -> Value -> M ()
runStep part s = case field "do" s >>= asText of
  Nothing -> throwM "a step needs a string do"
  Just d -> case d of
    "read" -> do
      n <- need "node" s
      x <- nameAt "as" s
      Seen v _ <- result "read" (apiRead api n)
      bindVar x v
    "directory" -> do
      n <- need "node" s
      nm <- maybeField "name" s
      x <- nameAt "as" s
      DirSeen l _ <- result "directory" (apiDirectory api n nm)
      bindVar x . Just $ case l of
        ListAbsent -> JArray []
        ListSlot ids -> JArray (map str ids)
        ListWhole slots -> JArray [JArray [str name, JArray (map str ids)] | (name, ids) <- slots]
    "lookup" -> do
      n <- need "name" s
      x <- nameAt "as" s
      f <- result "lookup" (apiLookup api n)
      bindVar x (Just (JArray (map str (foundIds f))))
    "let" -> do
      x <- nameAt "as" s
      v <- maybe (throwM "a let needs a value") ev (field "value" s)
      bindVar x v
    "if" -> do
      t <- need "test" s
      case t of
        JBool True -> stepsAt "then" s >>= run part
        JBool False -> case field "else" s of
          Nothing -> pure ()
          Just _ -> stepsAt "else" s >>= run part
        _ -> throwM ("an if needs a boolean test, not " <> kindOf t)
    "each" -> do
      l <- need "list" s
      x <- nameAt "as" s
      body <- stepsAt "steps" s
      case l of
        JArray xs -> forM_ xs $ \v -> bindVar x (Just v) >> run part body
        _ -> throwM ("each needs a list, not " <> kindOf l)
    "return" -> do
      v <- maybe (pure JNull) evP (field "value" s)
      throwError (CReturn v)
    "pending" -> do
      when (partKind part /= KCompute) (throwM "pending is for a compute only")
      throwError CPending
    "throw" -> do
      m <- maybe (pure JNull) evP (field "message" s)
      throwError (CThrow (Thrown ThrownOther (object [("kind", "thrown"), ("why", m)])))
    "try" -> do
      body <- stepsAt "steps" s
      x <- nameAt "as" s
      caught <- (run part body >> pure JNull) `catchError` \c -> case c of
        CThrow t -> pure (thrownValue t)
        _ -> throwError c
      bindVar x (Just caught)
    "make" -> do
      i <- need "id" s
      v <- need "value" s
      dat <- maybeField "data" s
      c <- maybeField "cause" s
      _ <- result "make" (apiMake api (stamp c) i v dat)
      pure ()
    "write" -> do
      n <- need "node" s
      ps <- need "patches" s
      c <- maybeField "cause" s
      _ <- result "write" (apiWrite api (stamp c) n ps)
      pure ()
    "place" -> do
      p <- need "parent" s
      nm <- need "name" s
      i <- need "id" s
      pos <- maybeField "position" s
      c <- maybeField "cause" s
      _ <- result "place" (apiPlace api (stamp c) p nm i pos)
      pure ()
    "unplace" -> do
      p <- need "parent" s
      nm <- need "name" s
      i <- need "id" s
      c <- maybeField "cause" s
      _ <- result "unplace" (apiUnplace api (stamp c) p nm i)
      pure ()
    "handler" -> do
      when (partKind part /= KEffect) (throwM "handler is for an effect only")
      nm <- nameAt "name" s
      body <- stepsAt "steps" s
      io (modifyIORef' (partHandlers part) ((nm, handler True body) :))
    "cleanup" -> do
      when (partKind part /= KEffect) (throwM "cleanup is for an effect only")
      body <- stepsAt "steps" s
      io (writeIORef (partCleanup part) (Just (handler False body)))
    _ -> throwM ("no step " <> d)
  where
    api = partApi part
    stamp c = Stamp c Nothing Nothing

-- | Handler or cleanup steps, run with the lasting interface. A handler has
-- self and input; a cleanup only self.
handler :: Bool -> [Value] -> Handler
handler withInput body = Handler $ \api self input -> do
  part <- newPart KHandler api
  let env = Map.fromList ([("self", Just (str self))] ++ [("input", input) | withInput])
  r <- runPart part env body
  pure $ case r of
    Left (CThrow t) -> Just t
    _ -> Nothing

newPart :: Kind -> Api -> IO Part
newPart k api = Part k api <$> newIORef [] <*> newIORef Nothing

runPart :: Part -> Env -> [Value] -> IO (Either Ctl ())
runPart part env body = evalStateT (runExceptT (run part body)) env

-- ===========================================================================
-- the loader

-- | The host's loader for programs as data.
load :: Loader
load v = case v of
  JArray steps | all isObject steps -> Right (program steps)
  JArray _ -> Left "a program's steps must be objects"
  _ -> Left ("a program must be a list of steps, not " <> kindOf v)
  where
    isObject (JObject _) = True
    isObject _ = False

program :: [Value] -> Program
program steps = Program compute effect
  where
    compute cin = do
      part <- newPart KCompute (computeApi cin)
      let env =
            Map.fromList
              [ ("self", Just (str (computeSelf cin)))
              , ("path", Just (pathToJson (computePath cin)))
              , ("changes", Just (JArray (map changeToJson (computeChanges cin))))
              ]
      r <- runPart part env steps
      pure $ case r of
        Right () -> Returned JNull
        Left (CReturn x) -> Returned x
        Left CPending -> WentPending
        Left (CThrow t) -> Threw t
    effect ein = do
      part <- newPart KEffect (effectApi ein)
      let env =
            Map.fromList
              [ ("self", Just (str (effectSelf ein)))
              , ("value", Just (effectValue ein))
              , ("previous", effectPrevious ein)
              ]
      r <- runPart part env steps
      hs <- reverse <$> readIORef (partHandlers part)
      c <- readIORef (partCleanup part)
      pure
        EffectOut
          { effectThrew = case r of Left (CThrow t) -> Just t; _ -> Nothing
          , effectHandlers = hs
          , effectCleanup = c
          }
