{-# LANGUAGE OverloadedStrings #-}

-- Types.hs encoding checks. From haskell/:
--   wasm32-wasi-ghc -O1 -Wall -i. -outputdir build/tests -o build/types-test.wasm tests/TypesTest.hs && wasmtime run build/types-test.wasm
module Main (main) where

import Control.Monad (unless)
import Data.IORef
import qualified Data.Text as Text
import Json
import System.Exit
import Types

main :: IO ()
main = do
  bad <- newIORef (0 :: Int)
  let check name ok = unless ok $ do
        putStrLn ("FAIL " <> name)
        modifyIORef bad (+ 1)
      parsed t = either (error . Text.unpack) id (parseValue t)
      patchTrip t = check ("patch " <> Text.unpack t) (fmap patchToJson (patchFrom (parsed t)) == Right (parsed t))
      patchBad t = check ("bad patch " <> Text.unpack t) (either (const True) (const False) (patchFrom (parsed t)))
  patchTrip "{\"type\":\"snapshot\",\"value\":{\"a\":[1]}}"
  patchTrip "{\"type\":\"splice\",\"path\":[\"a\",0],\"range\":[0,2],\"value\":\"xy\"}"
  patchTrip "{\"type\":\"splice\",\"path\":[],\"range\":[1,1]}"
  patchTrip "{\"type\":\"set\",\"path\":[\"a\"],\"key\":\"k\",\"value\":null}"
  patchTrip "{\"type\":\"set\",\"path\":[],\"key\":\"k\"}"
  patchBad "{\"type\":\"snapshot\"}"
  patchBad "{\"type\":\"splice\",\"path\":[],\"range\":[1]}"
  patchBad "{\"type\":\"splice\",\"path\":[1.5],\"range\":[0,0]}"
  patchBad "{\"type\":\"set\",\"path\":[],\"key\":1}"
  patchBad "{\"type\":\"move\"}"
  check "path" (fmap pathToJson (pathFrom (parsed "[{\"parent\":\"a\",\"name\":\"run\",\"node\":\"p\"}]")) == Right (parsed "[{\"parent\":\"a\",\"name\":\"run\",\"node\":\"p\"}]"))
  check "bad path" (either (const True) (const False) (pathFrom (parsed "[{\"parent\":\"a\"}]")))
  check "bad path 2" (either (const True) (const False) (pathFrom "nope"))
  let c = Change "a" 3 (KindPlace "x" "b" Nothing) "host" Nothing (Just JNull) (Just (parsed "{\"file\":\"s.js\",\"line\":1,\"column\":1}"))
  check "place change" (render (changeToJson c) == "{\"node\":\"a\",\"time\":3,\"kind\":\"place\",\"name\":\"x\",\"id\":\"b\",\"agent\":\"host\",\"cause\":null,\"site\":{\"file\":\"s.js\",\"line\":1,\"column\":1}}")
  let r = (emptyRecord "p1" 1 "host" [ChangeRef "init" 6])
        { recordCompute = Just (ProgramSeen "show" (Just 3) ["show"] False)
        , recordEffect = Just (ProgramSeen "eff" Nothing ["eff"] False)
        , recordReads = [ReadEntry "a" (Just 2), ReadEntry "gone" Nothing]
        , recordDirectories = [DirEntry "d" (Just "x") (Just 4), DirEntry "d" Nothing Nothing]
        , recordLookups = [LookupEntry "theme" [Searched "g" (Just 1) False, Searched "h" Nothing True] []]
        , recordValue = Just (JNumber 1)
        , recordChanges = [ChangeRef "p1" 7]
        , recordErrors = [ErrEntry Invalid "read" "no"]
        }
  check "record" (recordToJson r == parsed "{\"process\":\"p1\",\"run\":1,\"agent\":\"host\",\"marked\":[{\"node\":\"init\",\"time\":6}],\"compute\":{\"node\":\"show\",\"saw\":3,\"slot\":[\"show\"]},\"effect\":{\"node\":\"eff\",\"absent\":true,\"slot\":[\"eff\"]},\"lookups\":[{\"name\":\"theme\",\"searched\":[{\"node\":\"g\",\"saw\":1},{\"node\":\"h\",\"refused\":true}],\"found\":[]}],\"reads\":[{\"node\":\"a\",\"saw\":2},{\"node\":\"gone\",\"saw\":null}],\"directories\":[{\"node\":\"d\",\"name\":\"x\",\"saw\":4},{\"node\":\"d\",\"saw\":null}],\"value\":1,\"cleanup\":[],\"changes\":[{\"node\":\"p1\",\"time\":7}],\"ending\":\"done\",\"errors\":[{\"kind\":\"invalid\",\"op\":\"read\",\"why\":\"no\"}]}")
  let site = parsed "{\"file\":\"s.js\",\"line\":1,\"column\":1}"
      made d = Change "p" 2 (KindMake JNull d) "host" Nothing Nothing (Just site)
  check "make change with data" (render (changeToJson (made (Just (parsed "{\"path\":[]}")))) == "{\"node\":\"p\",\"time\":2,\"kind\":\"make\",\"value\":null,\"data\":{\"path\":[]},\"agent\":\"host\",\"site\":{\"file\":\"s.js\",\"line\":1,\"column\":1}}")
  check "make change with null data" (render (changeToJson (made (Just JNull))) == "{\"node\":\"p\",\"time\":2,\"kind\":\"make\",\"value\":null,\"data\":null,\"agent\":\"host\",\"site\":{\"file\":\"s.js\",\"line\":1,\"column\":1}}")
  check "make change without data" (render (changeToJson (made Nothing)) == "{\"node\":\"p\",\"time\":2,\"kind\":\"make\",\"value\":null,\"agent\":\"host\",\"site\":{\"file\":\"s.js\",\"line\":1,\"column\":1}}")
  let refusedProgram = (emptyRecord "p1" 1 "host" []) {recordCompute = Just (ProgramSeen "prog" Nothing ["prog", "other"] True), recordEnding = RefusedEnding}
  check "refused program read" (field "compute" (recordToJson refusedProgram) == Just (parsed "{\"node\":\"prog\",\"refused\":true,\"slot\":[\"prog\",\"other\"]}"))
  check "thrown from an op" (thrownValue (thrownFromErr "write" (refused "no")) == parsed "{\"kind\":\"refused\",\"op\":\"write\",\"why\":\"no\"}")
  check "data op" (opName (OpData "a") == "data" && opNode (OpData "a") == Just "a")
  check "lookup has no node" (opNode (OpLookup "theme") == Nothing)
  patchBad "{\"type\":\"splice\",\"path\":[],\"range\":[-1,0]}"
  patchBad "{\"type\":\"splice\",\"path\":[],\"range\":[0.5,1]}"
  patchBad "{\"type\":\"splice\",\"path\":[],\"range\":[0,1,2]}"
  check "chained path" (either (const True) (const False) (pathFrom (parsed "[{\"parent\":\"a\",\"name\":\"x\",\"node\":\"b\"},{\"parent\":\"c\",\"name\":\"y\",\"node\":\"d\"}]")))
  n <- readIORef bad
  if n == 0 then putStrLn "types: all passed" else do putStrLn (show n <> " failed"); exitFailure
