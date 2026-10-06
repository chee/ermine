{-# LANGUAGE OverloadedStrings #-}

-- | JSON values, one-line parser, printer, and the value-equality relation.
--
-- PROTOCOL.tex, Lines and Encodings; the @$eq@ relation of "Programs as data";
-- CORE.tex "Running and wrapping" (two values are equal when ...).
--
-- * Strings are 'Text': sequences of code points. A splice or @$len@ counts
--   code points, which is 'Text.length'. A lone surrogate escape (@\\ud800@),
--   which JSON.parse accepts as one code point, is held in the 'Text' as its
--   generalized UTF-8 (WTF-8) bytes, built with 'surrogate'. 'Text.length',
--   splitting, comparing and iterating all work byte-lead-wise, so such a
--   string counts, splices and sorts as JavaScript's does; the printer escapes
--   it back as @\\udXXX@, as JSON.stringify does. Text.pack or
--   Text.singleton would turn it into U+FFFD, so nothing here rebuilds a
--   string from its Chars. (Concatenating a lone high surrogate with a lone
--   low one keeps two code points, where JavaScript would see one pair.)
-- * Numbers are binary64 ('Double'), printed exactly as JavaScript's
--   @JSON.stringify@ prints them: @3@, @6.5@, @0@ for @-0@, @1e+21@, @1e-7@.
--   The runner compares numbers with @===@, so this matters.
-- * A string literal is a 'JString' under OverloadedStrings.
-- * Objects keep their keys in the order written. A repeated key keeps its
--   first position and its last value, as @JSON.parse@ does.
-- * The 'Eq' instance IS the @$eq@ relation: objects compare in any key order,
--   numbers by value (so @-0 == 0@ and @1.0 == 1@). There is no structural Eq.
module Json
  ( Value (..)
  , Fields
    -- * reading and writing
  , parseValue
  , decodeLine
  , lineSeq
  , render
  , encodeLine
  , renderNumber
    -- * building
  , object
  , optional
  , int
  , integer
  , str
    -- * taking apart
  , field
  , fieldsOf
  , asText
  , asWhole
  , asList
  , asBool
  , asNumber
  , kindOf
  ) where

import Data.Bits (shiftR, (.&.), (.|.))
import qualified Data.ByteString as BS
import Data.Char (chr, digitToInt, isDigit, isHexDigit, ord)
import qualified Data.Map.Strict as Map
import Data.Ratio ((%))
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Data.Text.Array as TA
import Data.Text.Internal (Text (..))
import qualified Data.Text.Encoding as Encoding
import qualified Data.Text.Lazy as Lazy
import qualified Data.Text.Lazy.Builder as B
import Data.String (IsString (..))
import Numeric (floatToDigits, showHex)

data Value
  = JNull
  | JBool !Bool
  | JNumber !Double
  | JString !Text
  | JArray [Value]
  | JObject [(Text, Value)] -- ^ keys unique, in the order written
  deriving (Show)

type Fields = [(Text, Value)]

-- | A string literal is a JSON string (with OverloadedStrings).
instance IsString Value where
  fromString = JString . Text.pack

-- | The @$eq@ relation (PROTOCOL.tex): objects with the same keys holding
-- equal values in any order, lists element by element, numbers by value.
instance Eq Value where
  JNull == JNull = True
  JBool a == JBool b = a == b
  JNumber a == JNumber b = a == b
  JString a == JString b = a == b
  JArray a == JArray b = length a == length b && and (zipWith (==) a b)
  JObject a == JObject b = Map.fromList a == Map.fromList b
  _ == _ = False

-- ---------------------------------------------------------------------------
-- building and taking apart

object :: Fields -> Value
object = JObject

-- | A field that is not there is left out, never given as null.
optional :: Text -> Maybe Value -> Fields
optional key = maybe [] (\v -> [(key, v)])

int :: Int -> Value
int = JNumber . fromIntegral

integer :: Integer -> Value
integer = JNumber . fromInteger

str :: Text -> Value
str = JString

-- | A key of an object; Nothing when missing or not an object. Presence
-- decides: a present null is @Just JNull@.
field :: Text -> Value -> Maybe Value
field key (JObject fs) = lookup key fs
field _ _ = Nothing

fieldsOf :: Value -> Maybe Fields
fieldsOf (JObject fs) = Just fs
fieldsOf _ = Nothing

asText :: Value -> Maybe Text
asText (JString t) = Just t
asText _ = Nothing

asNumber :: Value -> Maybe Double
asNumber (JNumber d) = Just d
asNumber _ = Nothing

-- | A whole number of any size, negative allowed; callers check range.
-- There is no cap at 2^53: a time is "a whole number, at least 1" with no
-- upper bound (PROTOCOL Encodings), and every whole binary64, such as 2^53+2
-- or 1e21, is held exactly, so a position or index that large is simply past
-- the slot or list. An 'Integer', exact for all of them, since 'Int' is 32
-- bits on wasm32.
asWhole :: Value -> Maybe Integer
asWhole (JNumber d)
  | not (isNaN d) && not (isInfinite d) && d == fromInteger r = Just r
  where r = truncate d :: Integer
asWhole _ = Nothing

asList :: Value -> Maybe [Value]
asList (JArray vs) = Just vs
asList _ = Nothing

asBool :: Value -> Maybe Bool
asBool (JBool b) = Just b
asBool _ = Nothing

-- | "null", "boolean", "number", "string", "list" or "object", for messages.
kindOf :: Value -> Text
kindOf v = case v of
  JNull -> "null"
  JBool _ -> "boolean"
  JNumber _ -> "number"
  JString _ -> "string"
  JArray _ -> "list"
  JObject _ -> "object"

-- ---------------------------------------------------------------------------
-- parsing

-- | One line's bytes (without the 0x0a) as one JSON value.
decodeLine :: BS.ByteString -> Either Text Value
decodeLine bytes = case Encoding.decodeUtf8' bytes of
  Left _ -> Left "the line is not UTF-8"
  Right t -> parseValue t

-- | The seq of a line that is not one JSON object (PROTOCOL Lines): a "seq"
-- key of the line's object holding a whole number, that a parser reading
-- the line from its start reaches before the line stops being JSON. The
-- line stops being JSON at its first byte that is not UTF-8, or where the
-- parser finds what JSON cannot have there; a key's value counts once the
-- parser has read all of it. The last such "seq" decides, as JSON.parse
-- keeps a repeated key's last value. Nothing when there is none.
lineSeq :: BS.ByteString -> Maybe Integer
lineSeq bytes = case Text.uncons (skipSpace prefix) of
  Just ('{', rest) -> members (skipSpace rest) Nothing
  _ -> Nothing
  where
    prefix = Encoding.decodeUtf8 (BS.take (fst (Encoding.validateUtf8Chunk bytes)) bytes)
    members t found = case Text.uncons t of
      Just ('"', rest)
        | Right (k, afterKey) <- stringP rest
        , Right afterColon <- expect ':' (skipSpace afterKey)
        , Right (v, afterValue) <- value (skipSpace afterColon) ->
            let found' = if k == "seq" then asWhole v >>= \n -> if n >= 0 then Just n else Nothing else found
             in case Text.uncons (skipSpace afterValue) of
                  Just (',', more) -> members (skipSpace more) found'
                  _ -> found'
      _ -> found

-- | Exactly one JSON value, with only JSON whitespace around it.
parseValue :: Text -> Either Text Value
parseValue input = do
  (v, rest) <- value (skipSpace input)
  if Text.null (skipSpace rest) then Right v else Left "something follows the JSON value"

skipSpace :: Text -> Text
skipSpace = Text.dropWhile (\c -> c == ' ' || c == '\t' || c == '\n' || c == '\r')

value :: Text -> Either Text (Value, Text)
value t = case Text.uncons t of
  Nothing -> Left "the line ends where a value should be"
  Just (c, rest)
    | c == '{' -> objectP (skipSpace rest) []
    | c == '[' -> arrayP (skipSpace rest) []
    | c == '"' -> do (s, after) <- stringP rest; Right (JString s, after)
    | c == '-' || isDigit c -> numberP t
    | Just r <- Text.stripPrefix "true" t -> Right (JBool True, r)
    | Just r <- Text.stripPrefix "false" t -> Right (JBool False, r)
    | Just r <- Text.stripPrefix "null" t -> Right (JNull, r)
    | otherwise -> Left ("not JSON: " <> Text.take 20 t)

objectP :: Text -> Fields -> Either Text (Value, Text)
objectP t acc = case Text.uncons t of
  Just ('}', rest) | null acc -> Right (JObject [], rest)
  Just ('"', rest) -> do
    (k, afterKey) <- stringP rest
    afterColon <- expect ':' (skipSpace afterKey)
    (v, afterValue) <- value (skipSpace afterColon)
    let acc' = (k, v) : acc
    case Text.uncons (skipSpace afterValue) of
      Just (',', more) -> objectP (skipSpace more) acc'
      Just ('}', more) -> Right (JObject (dedupe (reverse acc')), more)
      _ -> Left "an object is not closed"
  _ -> Left "an object's key must be a string"

-- A repeated key keeps its first position and its last value.
dedupe :: Fields -> Fields
dedupe fs = go fs Map.empty
  where
    final = Map.fromList fs
    go [] _ = []
    go ((k, _) : rest) seen
      | Map.member k seen = go rest seen
      | otherwise = (k, final Map.! k) : go rest (Map.insert k () seen)

arrayP :: Text -> [Value] -> Either Text (Value, Text)
arrayP t acc = case Text.uncons t of
  Just (']', rest) | null acc -> Right (JArray [], rest)
  _ -> do
    (v, after) <- value t
    case Text.uncons (skipSpace after) of
      Just (',', more) -> arrayP (skipSpace more) (v : acc)
      Just (']', more) -> Right (JArray (reverse (v : acc)), more)
      _ -> Left "a list is not closed"

expect :: Char -> Text -> Either Text Text
expect c t = case Text.uncons t of
  Just (x, rest) | x == c -> Right rest
  _ -> Left ("expected " <> Text.singleton c)

-- The text after the opening quote.
stringP :: Text -> Either Text (Text, Text)
stringP = go []
  where
    special c = c == '"' || c == '\\' || ord c < 0x20
    go pieces t =
      let (plain, rest) = Text.break special t
       in case Text.uncons rest of
            Nothing -> Left "a string is not closed"
            Just ('"', after) -> Right (Text.concat (reverse (plain : pieces)), after)
            Just ('\\', after) -> do
              (c, after') <- escape after
              go (c : plain : pieces) after'
            Just _ -> Left "a control character inside a string"

escape :: Text -> Either Text (Text, Text)
escape t = case Text.uncons t of
  Just ('"', r) -> one '"' r
  Just ('\\', r) -> one '\\' r
  Just ('/', r) -> one '/' r
  Just ('b', r) -> one '\b' r
  Just ('f', r) -> one '\f' r
  Just ('n', r) -> one '\n' r
  Just ('r', r) -> one '\r' r
  Just ('t', r) -> one '\t' r
  Just ('u', r) -> unicode r
  _ -> Left "an unknown escape inside a string"
  where
    one c r = Right (Text.singleton c, r)

-- A @\\u@ escape. A high surrogate followed by a low one escaped is one code
-- point; any other surrogate is a lone one, kept as JSON.parse keeps it.
unicode :: Text -> Either Text (Text, Text)
unicode t = do
  (u, rest) <- hex4 t
  if u >= 0xD800 && u <= 0xDBFF
    then case Text.stripPrefix "\\u" rest of
      Just r
        | Right (lo, after) <- hex4 r
        , lo >= 0xDC00 && lo <= 0xDFFF ->
            Right (Text.singleton (chr (0x10000 + (u - 0xD800) * 0x400 + (lo - 0xDC00))), after)
      _ -> Right (surrogate u, rest)
    else
      if u >= 0xDC00 && u <= 0xDFFF
        then Right (surrogate u, rest)
        else Right (Text.singleton (chr u), rest)

-- | A one-code-point string holding a lone surrogate, as its three WTF-8
-- bytes (Text cannot be given it any other way).
surrogate :: Int -> Text
surrogate u = Text arr 0 3
  where
    arr = TA.run $ do
      m <- TA.new 3
      TA.unsafeWrite m 0 (fromIntegral (0xE0 .|. (u `shiftR` 12)))
      TA.unsafeWrite m 1 (fromIntegral (0x80 .|. ((u `shiftR` 6) .&. 0x3F)))
      TA.unsafeWrite m 2 (fromIntegral (0x80 .|. (u .&. 0x3F)))
      pure m

hex4 :: Text -> Either Text (Int, Text)
hex4 t =
  let (ds, rest) = Text.splitAt 4 t
   in if Text.length ds == 4 && Text.all isHexDigit ds
        then Right (Text.foldl' (\n d -> n * 16 + digitToInt d) 0 ds, rest)
        else Left "a \\u escape needs four hex digits"

numberP :: Text -> Either Text (Value, Text)
numberP t = do
  let (neg, afterSign) = maybe (False, t) (\r -> (True, r)) (Text.stripPrefix "-" t)
      -- JSON's int is 0, or digits not starting with 0: after a leading 0
      -- the number's whole part ends, and what follows must be something
      -- else, so "01" is the number 0 and then a 1 that cannot follow it
      (whole, afterWhole) = case Text.stripPrefix "0" afterSign of
        Just r -> ("0", r)
        Nothing -> Text.span isDigit afterSign
  if Text.null whole then Left "a number has no digits" else Right ()
  (frac, afterFrac) <- case Text.stripPrefix "." afterWhole of
    Nothing -> Right ("", afterWhole)
    Just r ->
      let (ds, after) = Text.span isDigit r
       in if Text.null ds then Left "a fraction has no digits" else Right (ds, after)
  (pow, afterPow) <- case Text.uncons afterFrac of
    Just (m, r) | m == 'e' || m == 'E' -> do
      let (sign, r') = case Text.uncons r of
            Just ('-', more) -> (-1, more)
            Just ('+', more) -> (1, more)
            _ -> (1, r)
          (ds, after) = Text.span isDigit r'
      if Text.null ds then Left "an exponent has no digits" else Right (sign * digits ds, after)
    _ -> Right (0, afterFrac)
  mag <- toDouble (whole <> frac) (pow - toInteger (Text.length frac))
  Right (JNumber (if neg then negate mag else mag), afterPow)

digits :: Text -> Integer
digits = Text.foldl' (\n d -> n * 10 + toInteger (digitToInt d)) 0

-- The digits times ten to the scale, rounded once to the nearest binary64.
toDouble :: Text -> Integer -> Either Text Double
toDouble ds scale
  | m == 0 = Right 0
  | magnitude > 400 = Left "a number that is not a finite binary64"
  | magnitude < -400 = Right 0
  | isInfinite r = Left "a number that is not a finite binary64"
  | otherwise = Right r
  where
    m = digits ds
    magnitude = scale + toInteger (Text.length ds)
    r | scale >= 0 = fromInteger (m * 10 ^ scale)
      | otherwise = fromRational (m % (10 ^ negate scale))

-- ---------------------------------------------------------------------------
-- printing

render :: Value -> Text
render = Lazy.toStrict . B.toLazyText . build

-- | UTF-8 bytes of 'render', without the line end.
encodeLine :: Value -> BS.ByteString
encodeLine = Encoding.encodeUtf8 . render

build :: Value -> B.Builder
build v = case v of
  JNull -> "null"
  JBool True -> "true"
  JBool False -> "false"
  JNumber d -> B.fromText (renderNumber d)
  JString s -> buildString s
  JArray vs -> "[" <> commas (map build vs) <> "]"
  JObject fs -> "{" <> commas [buildString k <> ":" <> build x | (k, x) <- fs] <> "}"
  where
    commas [] = mempty
    commas (x : xs) = x <> mconcat (map ("," <>) xs)

buildString :: Text -> B.Builder
buildString s
  | Text.any needs s = "\"" <> B.fromText (Text.concatMap esc s) <> "\""
  | otherwise = "\"" <> B.fromText s <> "\""
  where
    needs c = c == '"' || c == '\\' || ord c < 0x20 || isSurrogate c
    isSurrogate c = ord c >= 0xD800 && ord c <= 0xDFFF
    esc c = case c of
      '"' -> "\\\""
      '\\' -> "\\\\"
      '\n' -> "\\n"
      '\r' -> "\\r"
      '\t' -> "\\t"
      '\b' -> "\\b"
      '\f' -> "\\f"
      _ | ord c < 0x20 || isSurrogate c -> "\\u" <> Text.justifyRight 4 '0' (Text.pack (showHex (ord c) ""))
        | otherwise -> Text.singleton c

-- | JavaScript's Number.prototype.toString for finite numbers (ECMA-262
-- Number::toString), which is what JSON.stringify prints. NaN and infinities
-- print as null, as JSON.stringify does; they never arise from parsing.
renderNumber :: Double -> Text
renderNumber d
  | isNaN d || isInfinite d = "null"
  | d == 0 = "0"
  | d < 0 = "-" <> renderNumber (negate d)
  | otherwise = Text.pack (js (floatToDigits 10 d))
  where
    js (ds, n) =
      let k = length ds
          s = concatMap show ds
       in if k <= n && n <= 21
            then s ++ replicate (n - k) '0'
            else if 0 < n && n <= 21
              then take n s ++ "." ++ drop n s
              else if -6 < n && n <= 0
                then "0." ++ replicate (negate n) '0' ++ s
                else
                  let e = n - 1
                      sign = if e >= 0 then "+" else "-"
                      mant = case s of
                        [c] -> [c]
                        (c : rest) -> c : '.' : rest
                        [] -> "0"
                   in mant ++ "e" ++ sign ++ show (abs e)
