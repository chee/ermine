{-# LANGUAGE OverloadedStrings #-}

-- Types.hs encoding checks. From haskell/:
--   wasm32-wasi-ghc -O1 -Wall -i. -outputdir build/tests -o build/TypesTest.wasm tests/TypesTest.hs && wasmtime run build/TypesTest.wasm
module Main (main) where

import Control.Monad (unless)
import Data.IORef
import Data.Text (Text)
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
      renders name v t = check name (render v == t)
      address t = addressFrom (parsed t)

  -- addresses: an optional first "/", then any "..", then names
  check "empty address" (address "[]" == Just (Address False 0 []))
  check "root" (address "[\"/\"]" == Just (Address True 0 []))
  check "up and names" (address "[\"..\",\"..\",\"a\",\"b\"]" == Just (Address False 2 ["a", "b"]))
  check "root then up" (address "[\"/\",\"..\"]" == Just (Address True 1 []))
  check "a name may hold a slash" (address "[\"a/b\"]" == Just (Address False 0 ["a/b"]))
  check "no up after a name" (address "[\"a\",\"..\"]" == Nothing)
  check "no dot" (address "[\".\"]" == Nothing)
  check "no root after the first part" (address "[\"a\",\"/\"]" == Nothing)
  check "not strings" (address "[1]" == Nothing)
  check "not a list" (address "\"a\"" == Nothing)
  let roundTrip t = check ("address " <> Text.unpack t) (fmap (render . addressToJson) (address t) == Just t)
  mapM_ roundTrip ["[]", "[\"/\"]", "[\"..\",\"a\"]", "[\"/\",\"x\",\"y\"]"]

  -- changes
  let site = parsed "{\"file\":\"s.js\",\"line\":1,\"column\":1}"
      change k = Change "a" 3 k "host" Nothing (Just site)
  renders
    "a mount: no position, no value"
    (changeToJson (change (KindPlace "x" "b" Nothing Nothing)))
    "{\"node\":\"a\",\"time\":3,\"kind\":\"place\",\"name\":\"x\",\"id\":\"b\",\"agent\":\"host\",\"cause\":{\"file\":\"s.js\",\"line\":1,\"column\":1}}"
  renders
    "a making with a position, by a process, with a null cause"
    (changeToJson (Change "a" 3 (KindPlace "x" "b" (Just 0) (Just JNull)) (int 7) (Just "p") (Just JNull)))
    "{\"node\":\"a\",\"time\":3,\"kind\":\"place\",\"name\":\"x\",\"id\":\"b\",\"position\":0,\"value\":null,\"agent\":7,\"process\":\"p\",\"cause\":null}"
  renders
    "a write without a cause"
    (changeToJson (Change "a" 4 (KindWrite [parsed "{\"type\":\"snapshot\",\"value\":1}"]) "host" Nothing Nothing))
    "{\"node\":\"a\",\"time\":4,\"kind\":\"write\",\"patches\":[{\"type\":\"snapshot\",\"value\":1}],\"agent\":\"host\"}"
  renders
    "an unplace"
    (changeToJson (change (KindUnplace "x" "b")))
    "{\"node\":\"a\",\"time\":3,\"kind\":\"unplace\",\"name\":\"x\",\"id\":\"b\",\"agent\":\"host\",\"cause\":{\"file\":\"s.js\",\"line\":1,\"column\":1}}"

  -- items and froms
  let step = Step "root" "a" "a" 0
      made = Change "root" 1 (KindPlace "a" "a" Nothing (Just (int 1))) "host" Nothing Nothing
  renders
    "a value item"
    (itemToJson (ItemValue (int 1) (FromRoute [step]) (Just made)))
    "{\"value\":1,\"from\":{\"route\":[{\"parent\":\"root\",\"name\":\"a\",\"node\":\"a\",\"position\":0}]},\"change\":{\"node\":\"root\",\"time\":1,\"kind\":\"place\",\"name\":\"a\",\"id\":\"a\",\"value\":1,\"agent\":\"host\"}}"
  renders "the root's first value has no change" (itemToJson (ItemValue JNull (FromRoute []) Nothing)) "{\"value\":null,\"from\":{\"route\":[]}}"
  check
    "a pending slot item"
    (itemToJson (ItemId "g" (FromSlot [] 2) made True) == parsed "{\"id\":\"g\",\"from\":{\"route\":[],\"position\":2},\"change\":{\"node\":\"root\",\"time\":1,\"kind\":\"place\",\"name\":\"a\",\"id\":\"a\",\"value\":1,\"agent\":\"host\"},\"pending\":true}")
  check "a slot item here says nothing of pending" (field "pending" (itemToJson (ItemId "g" (FromSlot [] 0) made False)) == Nothing)
  check
    "a lookup's from"
    (fromToJson (FromPath (Address False 1 ["theme"]) 0) == parsed "{\"path\":[\"..\",\"theme\"],\"position\":0}")

  -- errors
  renders
    "an error with its op and details"
    (errToJson (withOp "place" (invalid "position" [("length", int 3)] "")))
    "{\"kind\":\"invalid\",\"op\":\"place\",\"why\":{\"code\":\"position\",\"length\":3}}"
  renders
    "an error's text"
    (errToJson (invalid "unknown-command" [("cmd", "frob")] "no"))
    "{\"kind\":\"invalid\",\"why\":{\"code\":\"unknown-command\",\"cmd\":\"frob\",\"text\":\"no\"}}"
  check "withOp keeps the first op" (errOp (withOp "lookup" (withOp "directory" (invalid "x" [] ""))) == Just "directory")
  check "refused" (errToJson (err Refused "rule" [("rule", int 0)] "") == parsed "{\"kind\":\"refused\",\"why\":{\"code\":\"rule\",\"rule\":0}}")

  -- names
  check "names" (all isName ["a", "", "a/b", "...", ". "] && not (any isName [".", "..", "/" :: Text]))

  -- records
  let r =
        (emptyRecord "p1" 1 "host" [ChangeRef "init" 6])
          { recordLookups = [LookupEntry "theme" [Searched "g" (Just 1) False, Searched "h" Nothing True] []]
          , recordReads = [ReadEntry "read" (Address False 0 ["a"]) Nothing [Step "r" "a" "a" 0] (Just 2), ReadEntry "directory" (Address True 0 []) (Just "x") [] Nothing]
          , recordValue = Just (JNumber 1)
          , recordChanges = [ChangeRef "p1" 7]
          , recordErrors = [withOp "read" (invalid "write-only" [] "")]
          }
  check
    "record"
    ( recordToJson r
        == parsed
          "{\"process\":\"p1\",\"run\":1,\"agent\":\"host\",\"marked\":[{\"node\":\"init\",\"time\":6}],\"lookups\":[{\"name\":\"theme\",\"searched\":[{\"node\":\"g\",\"saw\":1},{\"node\":\"h\",\"refused\":true}],\"found\":[]}],\"reads\":[{\"op\":\"read\",\"address\":[\"a\"],\"route\":[{\"parent\":\"r\",\"name\":\"a\",\"node\":\"a\",\"position\":0}],\"saw\":2},{\"op\":\"directory\",\"address\":[\"/\"],\"name\":\"x\",\"route\":[],\"saw\":null}],\"value\":1,\"cleanup\":[],\"changes\":[{\"node\":\"p1\",\"time\":7}],\"ending\":\"done\",\"errors\":[{\"kind\":\"invalid\",\"op\":\"read\",\"why\":{\"code\":\"write-only\"}}]}"
    )
  check "op names" (map opName [OpRead (Address False 0 []), OpLookup "x", OpUnplace (Address False 0 []) "x" "y"] == ["read", "lookup", "unplace"])

  n <- readIORef bad
  if n == 0 then putStrLn "types: all passed" else do putStrLn (show n <> " failed"); exitFailure
