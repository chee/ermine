-- apply and invert on the line protocol (the apply and invert suites). Nothing lasts between lines.
module Main (main) where

import Apply
import Form
import Invert
import Json
import Line

main :: IO ()
main = serve () (\_ j -> (answer j, ()))

answer :: J -> J
answer req = case getStr "op" req of
  Just "apply" -> run (\root ps -> either refused (maybe (obj []) (\v -> obj [("value", toForm v)])) (applyPatches root ps))
  Just "invert" -> run (\root ps -> either refused (\u -> obj [("undo", JArr (map (toForm . patchV) u))]) (invertPatches root ps))
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
  where
    run f = case getField "patches" req of
      Just (JArr ps) ->
        let root = either failWith id (traverse fromForm (getField "value" req))
            patches = either failWith id (mapM fromForm ps)
         in root `seq` patches `seq` f root patches
      _ -> failWith "patches: not a list"
    refused (c, i) = obj [("error", obj [("code", JStr c), ("patch", JNum (fromIntegral i))])]
