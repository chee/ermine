-- the table on the line protocol (the table suite). State: one table and its untold events.
module Main (main) where

import Json
import Line
import Table

data S = S Table [(Event, J)]

main :: IO ()
main = serve (S empty []) step

keyOf :: String -> J -> K
keyOf f req = case getField f req of
  Just (JStr s) -> KStr s
  Just (JObj [("symbol", JStr s)]) -> KSym s
  _ -> failWith (f ++ ": not a key")

keyJ :: K -> J
keyJ (KStr s) = JStr s
keyJ (KSym s) = JObj [("symbol", JStr s)]

nodeOf :: J -> String
nodeOf req = case getField "node" req of
  Just (JStr s) -> s
  _ -> failWith "node: not a string"

has :: String -> J -> Bool
has f req = getField f req /= Nothing

step :: S -> J -> (J, S)
step s req = checked req `seq` step' s req

-- the fields an op reads must be there and well formed before anything is answered (laziness
-- would otherwise let an unread bad key through as {})
checked :: J -> ()
checked req = case getStr "op" req of
  Just o | o `elem` ["add", "sub"] -> ks ["part", "id"] `seq` nodeOf req `seq` ()
  Just "get" -> ks ["part", "id"]
  Just "ids" -> keyOf "part" req `seq` nodeOf req `seq` ()
  Just "at" -> ks ["id"]
  Just "who" -> nodeOf req `seq` ()
  Just "del"
    | has "node" req && has "part" req -> ks ["part"] `seq` nodeOf req `seq` ()
    | has "node" req -> nodeOf req `seq` ()
    | otherwise -> ks ["part", "id"]
  _ -> ()
  where
    ks = foldr (\f r -> keyOf f req `seq` r) ()

step' :: S -> J -> (J, S)
step' s@(S t told) req = case getStr "op" req of
  Just "add" -> force3 $ case add (keyOf "part" req) (keyOf "id" req) (nodeOf req) t of
    Left e -> (obj [("error", JStr e)], s)
    Right r -> landed r
  Just "sub" -> force3 $ landed (sub (keyOf "part" req) (keyOf "id" req) (nodeOf req) t)
  Just "get" -> (obj (maybe [] (\n -> [("node", JStr n)]) (get (keyOf "part" req) (keyOf "id" req) t)), s)
  Just "ids" -> (obj [("ids", JArr (map keyJ (ids (keyOf "part" req) (nodeOf req) t)))], s)
  Just "at" -> (obj [("entries", entriesJ (at (keyOf "id" req) t))], s)
  Just "who" -> (obj [("keys", JArr [JArr [keyJ p, keyJ i] | (p, i) <- who (nodeOf req) t])], s)
  Just "del"
    | has "node" req && has "part" req -> done (delPartNode (keyOf "part" req) (nodeOf req) t)
    | has "node" req -> done (delNode (nodeOf req) t)
    | otherwise -> done (delKey (keyOf "part" req) (keyOf "id" req) t)
  Just "events"
    | getField "at" req == Just (JBool True) ->
        (obj [("events", JArr [JArr [keyJ p, keyJ i, snap] | ((p, i), snap) <- told])], S t [])
    | otherwise -> (obj [("events", JArr [JArr [keyJ p, keyJ i] | ((p, i), _) <- told])], S t [])
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
  where
    entriesJ es = JArr [JArr [keyJ p, JStr n] | (p, n) <- es]
    landed (t', evs) = (obj [], S t' (told ++ [(e, entriesJ (at (snd e) t')) | e <- evs]))
    done r = force3 $ either (\e -> (obj [("error", JStr e)], s)) landed r
    force3 (a, S t' ev) = length (entries' t') `seq` length ev `seq` (a, S t' ev)
    entries' = who "" -- touches the table so a bad key fails here, not later
