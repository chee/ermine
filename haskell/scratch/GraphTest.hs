{-# LANGUAGE OverloadedStrings #-}
module Main (main) where

import Control.Monad (unless)
import Data.IORef
import Json
import Types
import Graph
import System.Exit

check :: String -> Bool -> IO ()
check name ok = unless ok (putStrLn ("FAIL " ++ name) >> exitFailure) >> putStrLn ("ok " ++ name)

main :: IO ()
main = do
  g <- graph
  iSetTop g g
  tRef <- newIORef (0 :: Int)
  let host = outside "host" Nothing []
      st = do modifyIORef tRef (+1); t <- readIORef tRef; pure (Stamp Nothing Nothing (Just t))
      h = bind g host
      ok r = either (error . show) id r
      mk i v = st >>= \s -> ok <$> apiMake h s i v Nothing
      wr n v = st >>= \s -> ok <$> apiWrite h s n (JArray [object [("type","snapshot"),("value",v)]])
      pl p n i = st >>= \s -> ok <$> apiPlace h s p n i Nothing
      up p n i = st >>= \s -> ok <$> apiUnplace h s p n i
  _ <- mk "a" (int 1); _ <- mk "d" (object []); _ <- mk "r" (object []); _ <- mk "g" (object [])
  let pctx = Ctx "alice" (Just "p") [Step "r" "s" "g", Step "g" "e" "p"] ReadOnly Nothing
  rec1 <- iRecord g (bind g pctx) (RecordStart 1 [ChangeRef "a" 1])
  let api = recordingApi rec1
  _ <- apiRead api "a"
  _ <- apiRead api "ghost"
  _ <- apiDirectory api "d" (Just "x")
  _ <- apiPlace api noStamp "d" "x" "y" Nothing   -- invalid: read only
  _ <- pl "r" "theme" "dark"
  f <- apiLookup api "theme"
  check "lookup found" (fmap foundIds f == Right ["dark"])
  _ <- apiRead (recordingQuiet rec1) "q"
  r1 <- recordingCurrent rec1
  check "reads logged" (map readNode (recordReads r1) == ["a","ghost"])
  check "dirs logged" (length (recordDirectories r1) == 1)
  check "lookup logged" (map lookupName (recordLookups r1) == ["theme"] && map searchedNode (lookupSearched (head (recordLookups r1))) == ["g","r"])
  check "error logged" (map errEntryOp (recordErrors r1) == ["place"])
  m1 <- wr "a" (int 2)
  check "write marks reader" (appliedMarked m1 == ["p"])
  m2 <- pl "d" "z" "n"
  check "other slot no mark" (appliedMarked m2 == [])
  m3 <- pl "d" "x" "n"
  check "slot mark" (appliedMarked m3 == ["p"])
  m4 <- mk "ghost" JNull
  check "absent read marked by make" (appliedMarked m4 == ["p"])
  m5 <- mk "q" JNull
  check "quiet read marks" (appliedMarked m5 == ["p"])
  m6 <- pl "g" "theme" "light"
  check "lookup slot marks" (appliedMarked m6 == ["p"])
  m6b <- pl "g" "other" "light"
  check "lookup other name no mark" (appliedMarked m6b == [])
  -- own change not marked
  s <- st
  own <- apiWrite (bind g host { ctxProcess = Just "p" }) s "a" (JArray [object [("type","snapshot"),("value",int 5)]])
  check "own change" (fmap appliedMarked own == Right [])
  -- subscribe to p for records
  evs <- newIORef []
  _ <- iSubscribe g host "p" (\e -> modifyIORef evs (e:))
  rr <- iFinish g rec1 Done
  check "ending" (recordEnding rr == Done)
  es <- readIORef evs
  check "record event" (length es == 1)
  after <- apiRead api "a"
  check "ended api invalid" (either ((== Invalid) . errKind) (const False) after)
  -- reads replaced by next run
  rec2 <- iRecord g (bind g pctx) (RecordStart 2 [])
  _ <- apiDirectory (recordingApi rec2) "d" Nothing
  m7 <- wr "a" (int 3)
  check "reads replaced" (appliedMarked m7 == [])
  m8 <- up "d" "z" "n"
  check "whole dir mark" (appliedMarked m8 == ["p"])
  -- write-only cannot read
  wo <- apiRead (bind g host { ctxMode = WriteOnly }) "a"
  check "write only read invalid" (either ((== Invalid) . errKind) (const False) wo)
  s2 <- st
  bad <- apiUnplace h s2 "d" "x" "nope"
  check "unplace missing invalid" (either ((== Invalid) . errKind) (const False) bad)
  putStrLn "all ok"
