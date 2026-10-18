-- squish on the line protocol (the squish suite). Each line is its own squisher.
module Main (main) where

import Form (normJ)
import Json
import Line
import Squish

main :: IO ()
main = serve () (\_ j -> (answer j, ()))

answer :: J -> J
answer req = case getStr "op" req of
  Just "squish" -> obj [("patches", JArr (squish (list "patches")))]
  Just "encode" -> obj [("columns", encode (list "patches"))]
  Just "decode" -> case getField "columns" req of
    Just c@(JObj _) -> either failWith (\ps -> obj [("patches", JArr ps)]) (decode (normJ c))
    _ -> failWith "columns: not a map"
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
  where
    list k = case getField k req of
      Just (JArr xs) -> map normJ xs
      _ -> failWith (k ++ ": not a list")
