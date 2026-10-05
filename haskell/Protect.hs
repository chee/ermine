{-# LANGUAGE OverloadedStrings #-}

-- | The reference protect: CORE.tex "Running and wrapping" (protect);
-- PROTOCOL.tex "The reference protect". Owner: the Protect+Main agent.
--
-- protect asks 'May' before every operation that passes through it — every
-- 'iOp' (including each directory a lookup reads, which arrives as its own
-- OpDirectory from the graph via the top of the stack), 'iSubscribe' (op
-- "subscribe", node) and 'iUnsubscribe' (op "unsubscribe", the node of the
-- subscription, when it was made through this protect) — and on
-- no answers @Left (refused why)@ without passing it on. 'iRecord',
-- 'iFinish' pass through; 'iSetTop' passes on below.
--
-- protect's only state is the node of each subscription made through it, so
-- that an unsubscribe is asked about the node it is on (CORE: unsubscribe(node)).
-- It needs no top of its own, because the graph
-- sends a lookup's directory reads through the top, so they come back
-- through here as ordinary "directory" operations with the lookup's ctx.
module Protect
  ( Rule (..)
  , May
  , rulesFrom
  , mayFromRules
  , protect
  ) where

import Data.IORef
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import Json
import Types

-- | @{"agent": a?, "process": id?, "op": s?, "node": id?, "allow": b}@; each
-- given field must equal (Json's Eq, the $eq relation) the operation's.
data Rule = Rule
  { ruleAgent :: Maybe Value
  , ruleProcess :: Maybe Value -- ^ compared with @str <$> ctxProcess@; no process never matches a given one
  , ruleOp :: Maybe Value -- ^ compared with @str (opName op)@
  , ruleNode :: Maybe Value -- ^ compared with 'opNode' (the parent for a placement, the new id for a make)
  , ruleAllow :: Bool
  }
  deriving (Eq, Show)

-- | may(agent, process, op name, node): yes or no.
type May = Value -> Maybe Id -> Text -> Maybe Value -> Bool

-- | The reset request's "rules" field (Nothing: no rules, allow everything).
-- Left why when it is not a list of rule objects with a boolean "allow".
-- Keys other than the five are ignored.
rulesFrom :: Maybe Value -> Either Text [Rule]
rulesFrom Nothing = Right []
rulesFrom (Just (JArray rs)) = mapM rule rs
  where
    rule r@(JObject _) = case field "allow" r >>= asBool of
      Just allow ->
        Right (Rule (field "agent" r) (field "process" r) (field "op" r) (field "node" r) allow)
      Nothing -> Left "a rule needs a boolean allow"
    rule _ = Left "a rule must be an object"
rulesFrom (Just _) = Left "rules must be a list of rules"

-- | The first rule whose given fields all match wins; none: allowed.
mayFromRules :: [Rule] -> May
mayFromRules rules agent process op node = go rules
  where
    go [] = True
    go (r : rest)
      | matches r = ruleAllow r
      | otherwise = go rest
    matches r =
      given (ruleAgent r) (Just agent)
        && given (ruleProcess r) (str <$> process)
        && given (ruleOp r) (Just (str op))
        && given (ruleNode r) node
    -- a field the rule does not give matches anything; a given field matches
    -- only an operation that has that field, with an equal value
    given Nothing _ = True
    given (Just want) have = have == Just want

-- | protect(inner, may).
protect :: Interface -> May -> IO Interface
protect inner may = do
  subNodes <- newIORef (Map.empty :: Map.Map Int Value)
  pure
    inner
      { iOp = \ctx st op ->
          if allowed ctx (opName op) (opNode op)
            then iOp inner ctx st op
            else pure (Left (refusal ctx (opName op) (opNode op)))
      , iSubscribe = \ctx node k ->
          if allowed ctx "subscribe" (Just node)
            then do
              r <- iSubscribe inner ctx node k
              case r of
                Right n -> modifyIORef' subNodes (Map.insert n node)
                Left _ -> pure ()
              pure r
            else pure (Left (refusal ctx "subscribe" (Just node)))
      , iUnsubscribe = \ctx n -> do
          node <- Map.lookup n <$> readIORef subNodes
          if allowed ctx "unsubscribe" node
            then do
              r <- iUnsubscribe inner ctx n
              case r of
                Right () -> modifyIORef' subNodes (Map.delete n)
                Left _ -> pure ()
              pure r
            else pure (Left (refusal ctx "unsubscribe" node))
      , iSetTop = iSetTop inner
      }
  where
    allowed ctx = may (ctxAgent ctx) (ctxProcess ctx)
    refusal ctx op node =
      refused $
        "protect: agent " <> render (ctxAgent ctx)
          <> maybe "" (\p -> " as process " <> render (str p)) (ctxProcess ctx)
          <> " may not " <> op
          <> maybe "" (\n -> " " <> render n) node
