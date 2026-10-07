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
  roundTrip "-0" "-0"
  roundTrip "[-0,0,{\"k\":-0}]" "[-0,0,{\"k\":-0}]"
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

  -- the seq of a line that is not one JSON object: a "seq" key of its object
  -- holding a whole number, reached before the line stops being JSON
  let seqOf t = lineSeq (Encoding.encodeUtf8 t)
  check "seq of an unclosed object" (seqOf "{\"seq\": 2, \"cmd\": \"read\"" == Just 2)
  check "seq at the very end" (seqOf "{\"seq\": 12" == Just 12)
  check "seq before something that is not JSON" (seqOf "{\"seq\":29} trailing" == Just 29)
  check "seq after another key" (seqOf "{\"a\":[1,{\"b\":2}],\"seq\":30,\"c\":" == Just 30)
  check "no seq after the line stops being JSON" (seqOf "{\"a\":x,\"seq\":3}" == Nothing)
  check "a half-read seq is not reached" (seqOf "{\"seq\":1." == Nothing && seqOf "{\"seq\":1e" == Nothing && seqOf "{\"seq\":-" == Nothing)
  check "a seq read whole before what cannot follow it" (seqOf "{\"seq\":12x" == Just 12 && seqOf "{\"seq\":01}" == Just 0)
  check "a seq that is not a whole number" (seqOf "{\"seq\":\"7\"" == Nothing && seqOf "{\"seq\":1.5," == Nothing && seqOf "{\"seq\":-1," == Nothing)
  check "only the object's own seq" (seqOf "{\"a\":{\"seq\":4}," == Nothing)
  check "not an object" (seqOf "[{\"seq\":1}]" == Nothing && seqOf "42" == Nothing && seqOf "\"seq\"" == Nothing && seqOf "not json" == Nothing)
  check "the line stops being JSON at a byte that is not UTF-8" (lineSeq (BS.concat [Encoding.encodeUtf8 "{\"seq\":5,\"x\":\"", BS.pack [0xff], Encoding.encodeUtf8 "\",\"seq\":6}"]) == Just 5)

  -- value equality ($eq)
  equal "{\"x\":1,\"y\":[1,2]}" "{\"y\":[1,2],\"x\":1}"
  equal "1" "1.0"
  unequal "0" "-0"
  equal "{\"a\":{\"b\":1,\"c\":2}}" "{\"a\":{\"c\":2,\"b\":1}}"
  unequal "[1,2]" "[2,1]"
  unequal "{\"a\":1}" "{\"a\":1,\"b\":2}"
  unequal "null" "false"
  unequal "\"1\"" "1"
  unequal "[]" "{}"
  check "0.5+0.5 = 1" (JNumber (0.5 + 0.5) == JNumber 1)

  -- values beyond JSON, read from their forms and written back the same
  let form t = fromForms False (parsed t)
      liveForm t = fromForms True (parsed t)
      forms t = check ("form " <> Text.unpack t) (fmap render (form t) == Just t)
      malformed t = check ("malformed " <> Text.unpack t) (form t == Nothing)
  mapM_
    forms
    [ "{\"/\":{\"bytes\":\"aGVsbG8\"}}"
    , "{\"/\":{\"bytes\":\"+/8\"}}"
    , "{\"/\":{\"bytes\":\"\"}}"
    , "{\"/\":{\"number\":\"NaN\"}}"
    , "[{\"/\":{\"number\":\"Infinity\"}},{\"/\":{\"number\":\"-Infinity\"}},-0]"
    , "{\"/\":{\"map\":{\"/\":1}}}"
    , "{\"/\":{\"map\":{\"/\":{\"/\":{\"map\":{\"/\":null}}}}}}"
    , "{\"/\":1,\"x\":2}"
    , "{\"/\":{\"int8\":[-128,0,127]}}"
    , "{\"/\":{\"uint32\":[0,4294967295]}}"
    , "{\"/\":{\"int64\":[\"-9223372036854775808\",\"9007199254740993\",\"9223372036854775807\"]}}"
    , "{\"/\":{\"uint64\":[\"18446744073709551615\"]}}"
    , "{\"/\":{\"float64\":[1.5,-0,\"NaN\",\"Infinity\",\"-Infinity\",0.1,1e+300,-2.5e-300]}}"
    , "{\"/\":{\"float32\":[-2.5,-0,\"NaN\",0.5]}}"
    , "{\"/\":{\"int16\":[]}}"
    ]
  check "a float32 is written shortest" (fmap render (form "{\"/\":{\"float32\":[0.1,3.141592653589793,16777217,123456.789]}}") == Just "{\"/\":{\"float32\":[0.1,3.1415927,16777216,123456.79]}}")
  check "a string that looks like base64 stays a string" (form "\"aGk\"" == Just (JString "aGk"))
  check "a live value only where one may be" (liveForm "{\"/\":{\"live\":\"canvas\"}}" == Just (JLive "canvas" 0) && form "{\"/\":{\"live\":\"canvas\"}}" == Nothing)
  check "a live value is never inside a list or map" (liveForm "[{\"/\":{\"live\":\"canvas\"}}]" == Nothing && liveForm "{\"a\":{\"/\":{\"live\":\"canvas\"}}}" == Nothing)
  check "a live value is written as its kind" (render (JLive "canvas" 3) == "{\"/\":{\"live\":\"canvas\"}}")
  mapM_
    malformed
    [ "{\"/\":{\"bytes\":\"aGVsbG8=\"}}"
    , "{\"/\":{\"bytes\":\"aGVsb\"}}"
    , "{\"/\":{\"bytes\":\"-_8\"}}"
    , "{\"/\":{\"bytes\":\"aGl=\"}}"
    , "{\"/\":{\"bytes\":\"aGm\"}}"
    , "{\"/\":{\"bytes\":5}}"
    , "{\"/\":{\"number\":\"nan\"}}"
    , "{\"/\":{\"number\":\"-0\"}}"
    , "{\"/\":{\"number\":5}}"
    , "{\"/\":\"x\"}"
    , "{\"/\":{}}"
    , "{\"/\":{\"blob\":1}}"
    , "{\"/\":{\"bytes\":\"aGk\",\"int8\":[1]}}"
    , "{\"/\":{\"map\":5}}"
    , "{\"/\":{\"map\":{\"/\":{\"/\":{}}}}}"
    , "{\"/\":{\"int8\":[128]}}"
    , "{\"/\":{\"uint8\":[-1]}}"
    , "{\"/\":{\"int32\":[1.5]}}"
    , "{\"/\":{\"int8\":[\"NaN\"]}}"
    , "{\"/\":{\"int64\":[5]}}"
    , "{\"/\":{\"int64\":[\"9223372036854775808\"]}}"
    , "{\"/\":{\"int64\":[\"01\"]}}"
    , "{\"/\":{\"uint64\":[\"-1\"]}}"
    , "{\"/\":{\"float32\":[1e39]}}"
    , "{\"/\":{\"float64\":[\"inf\"]}}"
    , "{\"/\":{\"float16\":[1]}}"
    , "{\"/\":{\"int8\":\"AQI\"}}"
    , "{\"k\":[{\"/\":{\"uint8\":[1,256]}}]}"
    ]

  -- value equality as CORE Values has it
  let v t = either (error . Text.unpack) id (parseValue t >>= maybe (Left "malformed") Right . fromForms False)
      same a b = check (Text.unpack a <> " = " <> Text.unpack b) (v a == v b)
      differ a b = check (Text.unpack a <> " /= " <> Text.unpack b) (v a /= v b)
  same "{\"/\":{\"number\":\"NaN\"}}" "{\"/\":{\"number\":\"NaN\"}}"
  same "{\"/\":{\"float32\":[\"NaN\",0]}}" "{\"/\":{\"float32\":[\"NaN\",0]}}"
  differ "{\"/\":{\"float32\":[-0]}}" "{\"/\":{\"float32\":[0]}}"
  differ "{\"/\":{\"int8\":[1]}}" "{\"/\":{\"uint8\":[1]}}"
  differ "{\"/\":{\"uint8\":[104,105]}}" "{\"/\":{\"bytes\":\"aGk\"}}"
  differ "{\"/\":{\"int8\":[1]}}" "[1]"
  differ "{\"/\":{\"bytes\":\"aGk\"}}" "\"aGk\""
  same "{\"/\":{\"bytes\":\"aGk\"}}" "{\"/\":{\"bytes\":\"aGk\"}}"
  check "live values are equal only when the same stand-in" (JLive "c" 1 == JLive "c" 1 && JLive "c" 1 /= JLive "c" 2)

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
