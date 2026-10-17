-- the tracker on the line protocol (the tracker suite). A node's owner is its name.
module Main (main) where

import Json
import Line
import Tracker
import Prelude hiding (reads)

main :: IO ()
main = serve empty step

step :: Tracker -> J -> (J, Tracker)
step t req = case getStr "op" req of
  Just "begin" -> let f = name "from" in if inRun f t then failWith "begin in a run: end it first" else done (begin f t)
  Just "end" -> let f = name "from" in length f `seq` done (end f t)
  Just "track" -> let f = name "from"; to = name "to" in length f `seq` length to `seq` done (track f to t)
  Just "add" -> let f = name "from"; to = name "to" in length f `seq` length to `seq` if inRun f t then failWith "add in a run: use track" else done (add f to t)
  Just "untrack" -> case getField "to" req of
    Nothing -> let f = name "from" in length f `seq` done (untrackAll f t)
    Just _ -> let f = name "from"; to = name "to" in length f `seq` length to `seq` done (untrack f to t)
  Just "reads" -> (obj [("names", JArr (map JStr (reads (name "of") t)))], t)
  Just "readers" -> (obj [("names", JArr (map JStr (readers (name "of") t)))], t)
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
  where
    name k = maybe (failWith ("no " ++ k)) id (getStr k req)
    done t' = (obj [], t')
