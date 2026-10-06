{-# LANGUAGE OverloadedStrings #-}

-- Graph.hs checks for what the graph stack's scenarios cannot reach: what a
-- run's reads depend on and which processes a change marks, recordings, and
-- read-only and write-only interfaces. From haskell/:
--   wasm32-wasi-ghc -O1 -Wall -i. -outputdir build/tests -o build/GraphTest.wasm tests/GraphTest.hs && wasmtime run build/GraphTest.wasm
module Main (main) where

import Control.Monad (unless, void)
import Data.IORef
import Data.Text (Text)
import Graph
import Json
import System.Exit
import Types

main :: IO ()
main = do
  bad <- newIORef (0 :: Int)
  let check :: String -> Bool -> IO ()
      check name ok = unless ok $ do
        putStrLn ("FAIL " <> name)
        modifyIORef bad (+ 1)
  g <- graph "r"
  iSetTop g g
  clock <- newIORef (0 :: Time)
  let host = outside "host" Nothing [] 0
      tick = modifyIORef clock (+ 1) >> readIORef clock
      addr names = Address False 0 names
      change :: Ctx -> Op -> IO Applied
      change ctx o = do
        t <- tick
        r <- iOp g ctx (Stamp (Just JNull) (Just t)) o
        case r of
          Right (ResultApplied a) -> pure a
          other -> error ("a change failed: " <> show other)
      place p n i v = change host (OpPlace (addr p) n i Nothing v)
      write p v = change host (OpWrite (addr p) [object [("type", "snapshot"), ("value", v)]])
      marks a = appliedMarked a
      items r = case r of
        Right (ResultItems is) -> is
        Right (ResultFound _ is) -> is
        _ -> []

  -- r: a=1, d={}, u=[m1 m2], m2/y=c, w=[ghost real], kids/kids
  mapM_ (\(n, i) -> place [] n i (Just (int 0))) [("a", "a"), ("d", "d"), ("u", "m1"), ("u", "m2"), ("kids", "k1")]
  void (place ["u"] "z" "z" (Just (int 0)))
  void (change host (OpPlace (addr []) "m2" "m2" Nothing Nothing))
  void (place ["m2"] "y" "c" (Just "C"))
  void (place [] "w" "ghost" Nothing)
  void (place [] "w" "real" (Just "R"))
  void (place ["kids"] "kids" "k2" (Just (int 0)))

  -- a run of process p, at the place kids/kids
  let pctx = Ctx "alice" (Just "p") ["kids", "kids"] 0 ReadOnly Nothing
  rec1 <- iRecord g (bind g pctx) (RecordStart 1 [ChangeRef "a" 1])
  let api = recordingApi rec1
      run o = apiOp api noStamp o
  ra <- run (OpRead (Address True 0 ["a"]))
  check "a run reads by address" (map itemValue (items ra) == [Just (int 0)])
  void (run (OpRead (Address True 0 ["u", "y"])))
  void (run (OpRead (Address True 0 ["w"])))
  void (run (OpDirectory (Address True 0 ["d"]) (Just "x")))
  void (run (OpLookup "theme"))
  wro <- run (OpWrite (Address True 0 ["a"]) [])
  check "a read-only interface cannot write" (either errCode (const "") wro == "read-only")
  void (apiOp (recordingQuiet rec1) noStamp (OpRead (Address True 0 ["d"])))
  r1 <- recordingCurrent rec1
  check "reads are logged" (map readOp (recordReads r1) == ["read", "read", "read", "directory"])
  check "the route of a read" (map readRoute (take 1 (recordReads r1)) == [[Step "r" "a" "a" 0]])
  check "a lookup is logged with what it searched" (map (map searchedNode . lookupSearched) (recordLookups r1) == [["k2", "k1", "r"]])
  check "an error is logged with its op" (map errOp (recordErrors r1) == [Just "write"])

  m1 <- write ["a"] (int 2)
  check "a write marks the reader of the value" (marks m1 == ["p"])
  m2 <- place ["d"] "y" "n" (Just (int 0))
  check "another slot marks nobody" (marks m2 == [])
  m3 <- place ["d"] "x" "n" Nothing
  check "a placement in the slot read marks" (marks m3 == ["p"])
  m4 <- place ["u"] "y" "e" (Just (int 0))
  check "a walk is marked by the member it passed over getting the name" (marks m4 == ["p"])
  m5 <- place ["d"] "ghost-maker" "ghost" (Just "G")
  check "a walk is marked by a member it passed over becoming here" (marks m5 == ["p"])
  m6 <- place ["kids"] "theme" "t" (Just (int 0))
  check "a lookup is marked by the name appearing in a directory it searched" (marks m6 == ["p"])
  m7 <- place ["kids"] "other" "t" Nothing
  check "a lookup is not marked by other names" (marks m7 == [])
  m8 <- write ["d"] (int 1)
  check "a quiet read marks" (marks m8 == ["p"])
  own <- change host {ctxProcess = Just "p"} (OpWrite (addr ["a"]) [])
  check "a change marks its own process too" (marks own == ["p"])

  -- an outside read leaves nothing behind
  void (iOp g host noStamp (OpRead (addr ["d"])))
  void (iOp g host {ctxProcess = Just "q"} noStamp (OpRead (addr ["d"])))
  mq <- write ["d"] (int 2)
  check "outside reads are not remembered" (marks mq == ["p"])

  -- finishing sends the record to whoever reaches the process node
  events <- newIORef []
  void (place [] "p" "p" (Just JNull))
  _ <- iSubscribe g host (addr ["p"]) (\e -> modifyIORef events (e :))
  done1 <- iFinish g rec1 Done
  check "ending" (recordEnding done1 == Done)
  es <- readIORef events
  check "the record is sent" (length [() | EventRecord _ <- es] == 1)
  after <- run (OpRead (addr ["a"]))
  check "an ended run's interface is stopped" (either errCode (const "") after == "stopped")

  -- the next run's reads count alongside the last finished run's, and
  -- replace them when it is finished
  rec2 <- iRecord g (bind g pctx) (RecordStart 2 [])
  void (apiOp (recordingApi rec2) noStamp (OpDirectory (Address True 0 ["d"]) Nothing))
  both <- write ["a"] (int 3)
  check "the last finished run's reads still count" (marks both == ["p"])
  void (iFinish g rec2 Done)
  gone <- write ["a"] (int 4)
  check "a finished run's reads replace the last" (marks gone == [])
  whole <- place ["d"] "q" "n" Nothing
  check "a whole-directory read is marked by any slot" (marks whole == ["p"])

  -- a write-only interface cannot read
  wo <- iOp g host {ctxMode = WriteOnly} noStamp (OpRead (addr ["a"]))
  check "write-only" (either errCode (const "") wo == "write-only")

  -- a wrapper that refuses one directory a lookup searches: the search ends
  -- there, it is not an error, and the refused read still counts
  g2 <- graph "r"
  let refusing =
        g2
          { iOp = \c st o -> case o of
              OpDirectory (Address False 1 []) (Just "theme") -> pure (Left (err Refused "rule" [("rule", int 0)] ""))
              _ -> iOp g2 c st o
          }
      change2 o = do
        t <- tick
        r <- iOp refusing host (Stamp (Just JNull) (Just t)) o
        case r of
          Right (ResultApplied a) -> pure a
          other -> error ("a change failed: " <> show other)
  iSetTop refusing refusing
  void (change2 (OpPlace (addr []) "kids" "k1" Nothing (Just (int 0))))
  void (change2 (OpPlace (addr ["kids"]) "kids" "k2" Nothing (Just (int 0))))
  rec3 <- iRecord refusing (bind refusing pctx) (RecordStart 1 [])
  found <- apiOp (recordingApi rec3) noStamp (OpLookup "theme")
  check "a refused read ends the search" (fmap (\r -> case r of ResultFound ss _ -> map (\x -> (searchedNode x, searchedRefused x)) ss; _ -> []) found == Right [("k2", False), ("k1", True)])
  r3 <- recordingCurrent rec3
  check "and is not an error" (null (recordErrors r3) && length (recordLookups r3) == 1)
  atRefused <- change2 (OpPlace (addr ["kids"]) "theme" "t1" Nothing (Just (int 0)))
  check "the refused read still counts" (marks atRefused == ["p"])
  above <- change2 (OpPlace (addr []) "theme" "t2" Nothing (Just (int 0)))
  check "nothing above it was searched" (marks above == [])

  -- ".." takes a name off the place, which is followed afresh from the root:
  -- with u = [m1, m2] and only m2 holding b, the place u/b reaches m2's b,
  -- but [".."] reaches m1, the first member of u
  g3 <- graph "r"
  iSetTop g3 g3
  let change3 o = do
        t <- tick
        r <- iOp g3 host (Stamp (Just JNull) (Just t)) o
        either (error . show) (const (pure ())) r
      read3 c a = do
        r <- iOp g3 c noStamp (OpRead a)
        pure [v | Right (ResultItems is) <- [r], ItemValue v _ _ <- is]
      at3 = host {ctxPlace = ["u", "b"]}
  change3 (OpPlace (addr []) "u" "m1" Nothing (Just "one"))
  change3 (OpPlace (addr []) "u" "m2" Nothing (Just "two"))
  change3 (OpPlace (addr []) "m2" "m2" Nothing Nothing)
  change3 (OpPlace (addr ["m2"]) "b" "b" Nothing (Just "B"))
  here3 <- read3 at3 (addr [])
  check "the place walks through the member that has its next name" (here3 == ["B"])
  up3 <- read3 at3 (Address False 1 [])
  check "\"..\" is the shorter place, followed afresh" (up3 == ["one"])
  change3 (OpPlace (addr ["m2"]) "theme" "t2" Nothing (Just "T2"))
  found3 <- iOp g3 at3 noStamp (OpLookup "theme")
  check "lookup searches the shorter places, not the members passed through" (fmap (\r -> case r of ResultFound ss is -> (map searchedNode ss, length is); _ -> ([], 0)) found3 == Right (["b", "m1", "r"], 0))

  -- patches
  let patched ps v = applyPatches ps v
      code r = either errCode (const "") r
      p t = either (error . show) id (parseValue t)
  check "splice counts code points" (patched [p "{\"type\":\"splice\",\"path\":[],\"range\":[1,2],\"value\":\"x\"}"] "a😀b" == Right "axb")
  check "a path that is not a list is not a patch" (code (patched [p "{\"type\":\"set\",\"path\":\"a\",\"key\":\"k\"}"] (object [])) == "not-a-patch")
  check "a set key that is not a string is not a patch" (code (patched [p "{\"type\":\"set\",\"path\":[],\"key\":1}"] (object [])) == "not-a-patch")
  check "a snapshot with no value is not a patch" (code (patched [p "{\"type\":\"snapshot\"}"] JNull) == "not-a-patch")
  check "a key into a scalar is no key" (code (patched [p "{\"type\":\"set\",\"path\":[\"a\",\"b\"],\"key\":\"k\"}"] (p "{\"a\":1}")) == "no-key")
  check "a negative index is no key" (code (patched [p "{\"type\":\"set\",\"path\":[-1],\"key\":\"k\"}"] (p "[{}]")) == "no-key")
  check "a range is checked after the path" (code (patched [p "{\"type\":\"splice\",\"path\":[\"x\"],\"range\":\"no\"}"] (object [])) == "no-key")
  check "the first bad patch, in order" (fmap (const ()) (patched [p "{\"type\":\"set\",\"path\":[\"x\"],\"key\":\"k\"}", p "5"] (object [])) == Left (invalid "no-key" [("index", int 0)] "the patch's path is not in the value"))
  -- whole numbers have no cap at 2^53: one that large is simply past the list
  check "an index past 2^53 is no key" (code (patched [p "{\"type\":\"set\",\"path\":[9007199254740994],\"key\":\"k\",\"value\":1}"] (p "[{},{}]")) == "no-key")
  check "a range past 2^53 is outside the value" (whyOf (patched [p "{\"type\":\"splice\",\"path\":[],\"range\":[0,9007199254740994]}"] (p "[1,2]")) == Just (Nothing, "range", [("index", int 0), ("length", int 2)]))

  -- times and positions past 2^53 (PROTOCOL Encodings: a time is a whole
  -- number, at least 1, with no upper bound)
  g4 <- graph "r"
  iSetTop g4 g4
  let at4 t o = iOp g4 host (Stamp (Just JNull) (Just t)) o
      big = 9007199254740994 :: Time
  made4 <- at4 big (OpPlace (addr []) "a" "a" Nothing (Just (p "[1,2]")))
  check "a time past 2^53 is a time" (fmap (\r -> case r of ResultApplied a -> render (changeToJson (appliedChange a)); _ -> "") made4 == Right "{\"node\":\"r\",\"time\":9007199254740994,\"kind\":\"place\",\"name\":\"a\",\"id\":\"a\",\"value\":[1,2],\"agent\":\"host\",\"cause\":null}")
  past4 <- at4 (10 ^ (21 :: Int)) (OpPlace (addr []) "a" "b" (Just big) Nothing)
  check "a position past 2^53 is past the slot" (whyOf past4 == Just (Just "place", "position", [("length", int 1)]))
  same4 <- at4 big (OpWrite (addr ["a"]) [])
  check "a time past 2^53 is compared exactly" (whyOf same4 == Just (Just "write", "time", [("last", integer big)]))
  next4 <- at4 (10 ^ (21 :: Int)) (OpWrite (addr ["a"]) [])
  check "1e21 is a time" (fmap (\r -> case r of ResultApplied a -> render (changeRefToJson (refOf (appliedChange a))); _ -> "") next4 == Right "{\"node\":\"a\",\"time\":1e+21}")

  n <- readIORef bad
  if n == 0 then putStrLn "graph: all passed" else do putStrLn (show n <> " failed"); exitFailure
  where
    itemValue :: Item -> Maybe Value
    itemValue (ItemValue v _ _) = Just v
    itemValue _ = Nothing
    -- an error's op, code and details, which are compared (its text is not)
    whyOf :: Either Err a -> Maybe (Maybe Text, Text, Fields)
    whyOf (Left e) = Just (errOp e, errCode e, errDetails e)
    whyOf (Right _) = Nothing
