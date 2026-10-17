-- node's entry and node on the line protocol (the node suite). Nothing lasts between lines.
module Main (main) where

import Form
import Header
import Json
import Line

main :: IO ()
main = serveIO () (\_ j -> do now <- nowSeconds; pure (answer now j, ()))

answer :: Double -> J -> J
answer now req = case getStr "op" req of
  Just "entry" -> obj [("entry", entry (getField "value" req))]
  Just "node" -> case getField "values" req of
    Just (JObj tables) ->
      let made = [(name, entry (Just v)) | (name, v) <- tables]
       in foldr (\(_, e) acc -> e `seq` acc) (obj [("node", JObj made)]) made
    _ -> failWith "values: not a map"
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
  where
    header = case getField "header" req of
      Just (JObj kvs) -> kvs
      Nothing -> []
      Just _ -> failWith "header: not a map"
    withTime = if any ((== "time") . fst) header then header else ("time", JNum now) : header
    entry mv =
      let value = fmap (either failWith toForm . fromForm) mv
       in maybe () (`seq` ()) value `seq`
            JObj (maybe [] (\v -> [("value", v)]) value ++ [("change", change withTime)])
