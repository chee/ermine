-- node's update on the line protocol (the update suite). State: one entry.
module Main (main) where

import Apply
import Form
import Header
import Invert
import Json
import Line

-- the entry: its value (none: Nothing) and its change, as answered
data Entry = Entry (Maybe V) J

main :: IO ()
main = do
  now <- nowSeconds
  serveIO (Entry Nothing (change [("time", JNum now)])) step

step :: Entry -> J -> IO (J, Entry)
step e@(Entry value ch) req = case getStr "op" req of
  Just "start" -> do
    now <- nowSeconds
    let v = either failWith id (traverse fromForm (getField "value" req))
        h = case getField "header" req of
          Just (JObj kvs) -> kvs
          _ -> []
        h' = if any ((== "time") . fst) h then h else ("time", JNum now) : h
        ch' = change h'
    length (render ch') `seq` v `seq` pure (obj [], Entry v ch')
  Just "update" -> case getField "patches" req of
    Just (JArr given0) -> do
      let ps = either failWith id (mapM fromForm given0)
          h = case getField "header" req of
            Just (JObj kvs) -> filter ((/= "op") . fst) kvs
            _ -> [("time", JNum 1), ("actor", JStr "me")]
      case applyPatches value ps of
        Left (c, i) -> pure (obj [("error", obj [("code", JStr c), ("patch", JInt (fromIntegral i))])], e)
        Right v' -> do
          let undo = either (const []) id (invertPatches value ps)
              given = [maybe (failWith "not a patch") (toForm . patchV) (parsePatch p) | p <- ps]
              op = obj [("patches", JArr given), ("undo", JArr (map (toForm . patchV) undo))]
              ch' = change (h ++ [("op", op)])
          length (render ch') `seq` pure (obj [], Entry v' ch')
    _ -> failWith "patches: not a list"
  Just "entry" -> pure (obj [("entry", JObj (maybe [] (\v -> [("value", toForm v)]) value ++ [("change", ch)]))], e)
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
