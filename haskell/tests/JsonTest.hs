{-# LANGUAGE OverloadedStrings #-}

-- Json.hs checks. Build and run from haskell/:
--   wasm32-wasi-ghc -O1 -Wall -i. -outputdir build/tests -o build/json-test.wasm tests/JsonTest.hs && wasmtime run build/json-test.wasm
module Main (main) where

import Control.Monad (unless)
import qualified Data.ByteString as BS
import Data.IORef
import qualified Data.Text as Text
import qualified Data.Text.Encoding as Encoding
import Json
import System.Exit

main :: IO ()
main = do
  bad <- newIORef (0 :: Int)
  let check name ok = unless ok $ do
        putStrLn ("FAIL " <> name)
        modifyIORef bad (+ 1)
      roundTrip input expected =
        case parseValue input of
          Left why -> check (Text.unpack input <> ": " <> Text.unpack why) False
          Right v -> do
            let out = render v
            check (Text.unpack input <> " -> " <> Text.unpack out) (out == expected)
            check ("reparse " <> Text.unpack out) (parseValue out == Right v)
      prints d expected = check (show d <> " prints " <> Text.unpack expected) (renderNumber d == expected)
      parsed t = either (error . Text.unpack) id (parseValue t)
      equal a b = check (Text.unpack a <> " $eq " <> Text.unpack b) (parsed a == parsed b)
      unequal a b = check (Text.unpack a <> " not $eq " <> Text.unpack b) (parsed a /= parsed b)
      rejects t = check ("rejects " <> Text.unpack t) (either (const True) (const False) (parseValue t))

  -- numbers as JSON.stringify prints them
  roundTrip "3" "3"
  roundTrip "6.5" "6.5"
  roundTrip "-0" "0"
  roundTrip "1e21" "1e+21"
  roundTrip "1E21" "1e+21"
  roundTrip "1e20" "100000000000000000000"
  roundTrip "123456789012345680000" "123456789012345680000"
  roundTrip "0.1" "0.1"
  roundTrip "1e-7" "1e-7"
  roundTrip "0.000001" "0.000001"
  roundTrip "1.5e-10" "1.5e-10"
  roundTrip "-2.25" "-2.25"
  roundTrip "3.0" "3"
  roundTrip "9007199254740993" "9007199254740992"
  roundTrip "1.7976931348623157e308" "1.7976931348623157e+308"
  roundTrip "5e-324" "5e-324"
  roundTrip "0.30000000000000004" "0.30000000000000004"
  prints (0.1 + 0.2) "0.30000000000000004"
  prints 1e21 "1e+21"
  prints 123e-20 "1.23e-18"
  prints (-1e-7) "-1e-7"

  -- strings: code points, escapes, beyond the BMP
  roundTrip "\"a😀b\"" "\"a😀b\""
  roundTrip "\"\\ud83d\\ude00\"" "\"😀\""
  check "😀 is one code point" (fmap (\v -> Text.length <$> asText v) (parseValue "\"a\\ud83d\\ude00\"") == Right (Just 2))
  roundTrip "\"\\u0001\\n\\t\\\"\\\\/\"" "\"\\u0001\\n\\t\\\"\\\\/\""
  roundTrip "\"a\x2028\&b\x85\&c\"" "\"a\x2028\&b\x85\&c\""
  -- a lone surrogate is one code point, as JSON.parse has it, and prints escaped
  roundTrip "\"\\ud83d\"" "\"\\ud83d\""
  roundTrip "\"\\ude00x\"" "\"\\ude00x\""
  roundTrip "\"\\ud800\\u0041\"" "\"\\ud800A\""
  check "a lone surrogate is one code point" (fmap (\v -> Text.length <$> asText v) (parseValue "\"a\\udc00b\"") == Right (Just 3))
  rejects "\"a\nb\""

  -- structure
  roundTrip " { \"a\" : [1, {\"b\": null, \"c\": [true, false, {}]}], \"d\": {\"e\": {\"f\": []}} } "
    "{\"a\":[1,{\"b\":null,\"c\":[true,false,{}]}],\"d\":{\"e\":{\"f\":[]}}}"
  roundTrip "[]" "[]"
  roundTrip "{\"a\":1,\"b\":2,\"a\":3}" "{\"a\":3,\"b\":2}"
  rejects "{\"seq\": 2, \"cmd\": \"read\""
  rejects "not json"
  rejects "01"
  rejects "1."
  rejects "[1,]"
  rejects "1 2"
  rejects "1e400"
  check "decodeLine utf8" (decodeLine (Encoding.encodeUtf8 "{\"x\":\"é😀\"}") == Right (JObject [("x", JString "é😀")]))
  check "decodeLine bad utf8" (either (const True) (const False) (decodeLine (BS.pack [0x22, 0xff, 0x22])))
  check "encodeLine" (encodeLine (JObject [("s", "😀"), ("n", JNumber 6.5)]) == Encoding.encodeUtf8 "{\"s\":\"😀\",\"n\":6.5}")

  -- value equality ($eq)
  equal "{\"x\":1,\"y\":[1,2]}" "{\"y\":[1,2],\"x\":1}"
  equal "1" "1.0"
  equal "0" "-0"
  equal "{\"a\":{\"b\":1,\"c\":2}}" "{\"a\":{\"c\":2,\"b\":1}}"
  unequal "[1,2]" "[2,1]"
  unequal "{\"a\":1}" "{\"a\":1,\"b\":2}"
  unequal "null" "false"
  unequal "\"1\"" "1"
  unequal "[]" "{}"
  check "0.5+0.5 = 1" (JNumber (0.5 + 0.5) == JNumber 1)

  -- helpers
  check "asWhole 3" (asWhole (JNumber 3) == Just 3)
  check "asWhole 3.5" (asWhole (JNumber 3.5) == Nothing)
  check "asWhole does not wrap past 32 bits" (asWhole (JNumber 4294967297) == Just 4294967297)
  check "asWhole 2^53" (asWhole (JNumber 9007199254740992) == Just 9007199254740992)
  -- no cap: every whole binary64 is a whole number, held exactly
  check "asWhole 2^53+2" (asWhole (JNumber 9007199254740994) == Just 9007199254740994)
  check "asWhole 1e21" (asWhole (JNumber 1e21) == Just (10 ^ (21 :: Int)))
  check "asWhole -(2^53+2)" (asWhole (JNumber (-9007199254740994)) == Just (-9007199254740994))
  check "asWhole 1e300" (asWhole (JNumber 1e300) == Just (truncate (1e300 :: Double)))
  check "asWhole 1.7976931348623157e308" (fmap fromInteger (asWhole (JNumber 1.7976931348623157e308)) == Just (1.7976931348623157e308 :: Double))
  check "asWhole 2^51+0.5 is not whole" (asWhole (JNumber 2251799813685248.5) == Nothing)
  check "asWhole 5e-324" (asWhole (JNumber 5e-324) == Nothing)
  check "field null present" (field "c" (parsed "{\"c\":null}") == Just JNull)
  check "optional" (optional "k" (Nothing :: Maybe Value) == [])

  n <- readIORef bad
  if n == 0 then putStrLn "json: all passed" else do putStrLn (show n <> " failed"); exitFailure
