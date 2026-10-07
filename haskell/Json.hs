{-# LANGUAGE OverloadedStrings #-}

-- | Values (CORE.tex, Values), their JSON forms (PROTOCOL.tex, Values in
-- JSON), the one-line parser and printer, and value equality.
--
-- * Strings are 'Text': sequences of code points. A splice or @$len@ counts
--   code points, which is 'Text.length'. A lone surrogate escape (@\\ud800@),
--   which JSON.parse accepts as one code point, is held in the 'Text' as its
--   generalized UTF-8 (WTF-8) bytes, built with 'surrogate'. 'Text.length',
--   splitting, comparing and iterating all work byte-lead-wise, so such a
--   string counts, splices and sorts as JavaScript's does; the printer escapes
--   it back as @\\udXXX@, as JSON.stringify does. Text.pack or
--   Text.singleton would turn it into U+FFFD, so nothing here rebuilds a
--   string from its Chars.
-- * Numbers are binary64 ('Double'), NaN, the infinities and -0 included.
--   Finite ones print as JavaScript's @JSON.stringify@ prints them, except
--   that -0 is @-0@; NaN and the infinities print in their @"/"@ form.
-- * Bytes and typed arrays are held as buffers: a 'BS.ByteString' of the
--   octets, a typed array's elements little-endian, as the machine holds
--   them. A float element's NaN is held as the one quiet NaN.
-- * A live value is a stand-in: its kind and a number the harness gives it,
--   which is what makes two of them the same thing.
-- * The parser reads plain JSON: a map whose only key is @"/"@ stays a map
--   until 'fromForms' reads it as one of the forms. The printer writes every
--   value in its JSON form, so a map whose only key is @"/"@ is written
--   @{"/": {"map": {"/": v}}}@; no answer's own map has @"/"@ as its only key.
-- * Objects keep their keys in the order written. A repeated key keeps its
--   first position and its last value, as @JSON.parse@ does.
-- * The 'Eq' instance IS value equality (CORE Values): of the same kind with
--   equal parts; numbers as @Object.is@ tells them apart, so 0 and -0 differ
--   and NaN equals NaN; typed arrays only of the same kind, element by
--   element as numbers are; maps with the same keys in any order; live
--   values only when they are the same stand-in.
module Json
  ( Value (..)
  , Fields
  , Kind (..)
  , kindName
  , kindSize
  , Element (..)
  , elements
    -- * reading and writing
  , parseValue
  , decodeLine
  , lineSeq
  , fromForms
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

import Data.Bits (shiftL, shiftR, (.&.), (.|.))
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
import Data.Word (Word8)
import GHC.Float (castDoubleToWord64, castFloatToWord32, castWord32ToFloat, castWord64ToDouble, double2Float, float2Double)
import Numeric (floatToDigits, showHex)

data Value
  = JNull
  | JBool !Bool
  | JNumber !Double
  | JString !Text
  | JArray [Value]
  | JObject [(Text, Value)] -- ^ keys unique, in the order written
  | JBytes !BS.ByteString
  | JTyped !Kind !BS.ByteString -- ^ the elements, little-endian
  | JLive !Text !Int -- ^ a live value's kind, and which stand-in it is
  deriving (Show)

type Fields = [(Text, Value)]

-- | A typed array's kind (CORE Values).
data Kind = Int8 | Uint8 | Int16 | Uint16 | Int32 | Uint32 | Int64 | Uint64 | Float32 | Float64
  deriving (Eq, Ord, Show, Enum, Bounded)

kindName :: Kind -> Text
kindName k = case k of
  Int8 -> "int8"
  Uint8 -> "uint8"
  Int16 -> "int16"
  Uint16 -> "uint16"
  Int32 -> "int32"
  Uint32 -> "uint32"
  Int64 -> "int64"
  Uint64 -> "uint64"
  Float32 -> "float32"
  Float64 -> "float64"

-- | Octets per element.
kindSize :: Kind -> Int
kindSize k = case k of
  Int8 -> 1
  Uint8 -> 1
  Int16 -> 2
  Uint16 -> 2
  Int32 -> 4
  Uint32 -> 4
  Float32 -> 4
  _ -> 8

isFloat :: Kind -> Bool
isFloat k = k == Float32 || k == Float64

-- | The least and greatest element of an integer kind.
bounds :: Kind -> (Integer, Integer)
bounds k
  | k `elem` [Int8, Int16, Int32, Int64] = (negate half, half - 1)
  | otherwise = (0, 2 * half - 1)
  where
    half = 2 ^ (8 * kindSize k - 1)

-- | One element of a typed array: an integer kind's, or a float kind's.
data Element = EInt Integer | EFloat Double
  deriving (Show)

-- | The elements of a typed array's buffer.
elements :: Kind -> BS.ByteString -> [Element]
elements k b = [element (BS.take n (BS.drop (i * n) b)) | i <- [0 .. BS.length b `div` n - 1]]
  where
    n = kindSize k
    element bs =
      let w = foldr (\x acc -> acc `shiftL` 8 .|. toInteger x) 0 (BS.unpack bs)
       in case k of
            Float32 -> EFloat (float2Double (castWord32ToFloat (fromInteger w)))
            Float64 -> EFloat (castWord64ToDouble (fromInteger w))
            _
              | snd (bounds k) < w -> EInt (w - 2 ^ (8 * n))
              | otherwise -> EInt w

-- | A typed array's buffer from its elements, each already of its kind.
buffer :: Kind -> [Element] -> BS.ByteString
buffer k = BS.pack . concatMap octets
  where
    n = kindSize k
    octets e = [fromInteger (w `shiftR` (8 * j)) :: Word8 | j <- [0 .. n - 1]]
      where
        w = case e of
          EInt i -> i `mod` (2 ^ (8 * n))
          EFloat d
            | k == Float32 -> toInteger (if isNaN d then 0x7FC00000 else castFloatToWord32 (double2Float d))
            | otherwise -> toInteger (if isNaN d then 0x7FF8000000000000 else castDoubleToWord64 d)

-- | Numbers as @Object.is@ tells them apart.
sameNumber :: Double -> Double -> Bool
sameNumber a b = (isNaN a && isNaN b) || (a == b && isNegativeZero a == isNegativeZero b)

sameElement :: Element -> Element -> Bool
sameElement (EInt a) (EInt b) = a == b
sameElement (EFloat a) (EFloat b) = sameNumber a b
sameElement _ _ = False

-- | A string literal is a JSON string (with OverloadedStrings).
instance IsString Value where
  fromString = JString . Text.pack

-- | Value equality (CORE Values).
instance Eq Value where
  JNull == JNull = True
  JBool a == JBool b = a == b
  JNumber a == JNumber b = sameNumber a b
  JString a == JString b = a == b
  JArray a == JArray b = length a == length b && and (zipWith (==) a b)
  JObject a == JObject b = Map.fromList a == Map.fromList b
  JBytes a == JBytes b = a == b
  JTyped k a == JTyped k' b = k == k' && BS.length a == BS.length b && and (zipWith sameElement (elements k a) (elements k b))
  JLive k n == JLive k' n' = k == k' && n == n'
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

-- | "null", "boolean", "number", "string", "list", "map", "bytes", a typed
-- array's kind, or "live", for messages.
kindOf :: Value -> Text
kindOf v = case v of
  JNull -> "null"
  JBool _ -> "boolean"
  JNumber _ -> "number"
  JString _ -> "string"
  JArray _ -> "list"
  JObject _ -> "map"
  JBytes _ -> "bytes"
  JTyped k _ -> kindName k
  JLive _ _ -> "live"

-- ---------------------------------------------------------------------------
-- the JSON forms (PROTOCOL Values in JSON)

-- | A value from its JSON form: each map whose only key is "/" read as one of
-- the forms, at any depth. Nothing when one is malformed (wrong-field), or is
-- a live value where none may be: only the whole value, and only when @live@
-- says so. A live value's stand-in number is 0, for the caller to give.
fromForms :: Bool -> Value -> Maybe Value
fromForms live v = case v of
  JArray xs -> JArray <$> mapM (fromForms False) xs
  JObject [("/", form)] -> slash form
  JObject fs -> JObject <$> mapM (\(k, x) -> (,) k <$> fromForms False x) fs
  _ -> Just v
  where
    slash (JObject [(tag, x)]) = case (tag, x) of
      ("bytes", JString t) -> JBytes <$> unbase64 t
      ("number", JString t) -> JNumber <$> nonFinite t
      ("live", JString k) | live -> Just (JLive k 0)
      ("map", JObject [("/", y)]) -> (\y' -> JObject [("/", y')]) <$> fromForms False y
      (_, JArray xs) | Just k <- lookup tag [(kindName k, k) | k <- [minBound .. maxBound]] -> JTyped k . buffer k <$> mapM (elementOf k) xs
      _ -> Nothing
    slash _ = Nothing

-- | "NaN", "Infinity" or "-Infinity".
nonFinite :: Text -> Maybe Double
nonFinite t = lookup t [("NaN", 0 / 0), ("Infinity", 1 / 0), ("-Infinity", -1 / 0)]

-- | One element of a typed array from its JSON form: an int64 or uint64 one a
-- decimal string; a float one a number, or a number JSON cannot write; any
-- other a number. One out of range for its kind, or a fraction in an
-- integer kind, is Nothing; a float32 is out of range where it would round
-- to an infinity.
elementOf :: Kind -> Value -> Maybe Element
elementOf k v = case v of
  JString t
    | isFloat k -> EFloat <$> nonFinite t
    | k == Int64 || k == Uint64, decimal t -> ranged (read (Text.unpack t))
  JNumber d
    | k == Float32 -> if isInfinite (double2Float d) && not (isInfinite d) then Nothing else Just (EFloat d)
    | k == Float64 -> Just (EFloat d)
    | k /= Int64 && k /= Uint64, Just i <- asWhole v -> ranged i
  _ -> Nothing
  where
    ranged i = let (lo, hi) = bounds k in if lo <= i && i <= hi then Just (EInt i) else Nothing
    decimal t = case Text.stripPrefix "-" t of
      Just r -> digitsOnly r
      Nothing -> digitsOnly t
    digitsOnly r = not (Text.null r) && Text.all isDigit r && (r == "0" || Text.head r /= '0')

base64Alphabet :: Text
base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

-- | Base64, standard alphabet, no padding.
base64 :: BS.ByteString -> Text
base64 b = Text.pack (go (BS.unpack b))
  where
    sym :: Integer -> Char
    sym i = Text.index base64Alphabet (fromInteger i)
    quad :: Word8 -> Word8 -> Word8 -> Int -> String
    go (x : y : z : rest) = quad x y z 4 ++ go rest
    go [x, y] = quad x y 0 3
    go [x] = quad x 0 0 2
    go [] = []
    quad x y z n =
      let w = (toInteger x `shiftL` 16) .|. (toInteger y `shiftL` 8) .|. toInteger z
       in take n [sym ((w `shiftR` s) .&. 63) | s <- [18, 12, 6, 0 :: Int]]

-- | The bytes base64 with no padding spells, in its one spelling: Nothing
-- for padding, another alphabet, a length no base64 has, or bits set past
-- the last byte.
unbase64 :: Text -> Maybe BS.ByteString
unbase64 t = do
  sixes <- mapM (\c -> toInteger <$> Text.findIndex (== c) base64Alphabet) (Text.unpack t)
  let groups = chunk sixes
  bytes <- concat <$> mapM group groups
  let b = BS.pack bytes
  if base64 b == t then Just b else Nothing
  where
    chunk [] = []
    chunk xs = take 4 xs : chunk (drop 4 xs)
    group g
      | length g < 2 = Nothing
      | otherwise =
          let w = foldl (\acc x -> acc `shiftL` 6 .|. x) 0 (take 4 (g ++ repeat 0))
           in Just (take (length g - 1) [fromInteger ((w `shiftR` s) .&. 255) | s <- [16, 8, 0 :: Int]])

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
  JNumber d
    | isNaN d || isInfinite d -> form "number" (buildString (number d))
    | otherwise -> B.fromText (renderNumber d)
  JString s -> buildString s
  JArray vs -> "[" <> commas (map build vs) <> "]"
  JObject [("/", x)] -> form "map" ("{\"/\":" <> build x <> "}")
  JObject fs -> "{" <> commas [buildString k <> ":" <> build x | (k, x) <- fs] <> "}"
  JBytes b -> form "bytes" (buildString (base64 b))
  JTyped k b -> form (kindName k) ("[" <> commas (map (element k) (elements k b)) <> "]")
  JLive k _ -> form "live" (buildString k)
  where
    commas [] = mempty
    commas (x : xs) = x <> mconcat (map ("," <>) xs)
    form tag x = "{\"/\":{" <> buildString tag <> ":" <> x <> "}}"
    number d
      | isNaN d = "NaN"
      | d > 0 = "Infinity"
      | otherwise = "-Infinity"
    -- an int64 or uint64 element is a decimal string; a float that is not a
    -- finite number is a string; a float32 is the shortest number that reads
    -- back as the same float32
    element k e = case e of
      EInt i
        | k == Int64 || k == Uint64 -> "\"" <> B.fromString (show i) <> "\""
        | otherwise -> B.fromString (show i)
      EFloat d
        | isNaN d || isInfinite d -> buildString (number d)
        | k == Float32 -> B.fromText (renderFloat32 (double2Float d))
        | otherwise -> B.fromText (renderNumber d)

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
-- Number::toString), which is what JSON.stringify prints, except that -0 is
-- @-0@ (PROTOCOL Values in JSON). NaN and the infinities have no number form
-- ('build' writes them under "/"); here they print as null.
renderNumber :: Double -> Text
renderNumber d
  | isNaN d || isInfinite d = "null"
  | isNegativeZero d = "-0"
  | d == 0 = "0"
  | d < 0 = "-" <> renderNumber (negate d)
  | otherwise = Text.pack (js (floatToDigits 10 d))

-- | A finite float32 as the shortest number that reads back as it, printed
-- as JavaScript prints that number.
renderFloat32 :: Float -> Text
renderFloat32 f
  | isNegativeZero f = "-0"
  | f == 0 = "0"
  | f < 0 = "-" <> renderFloat32 (negate f)
  | otherwise = Text.pack (js (floatToDigits 10 f))

-- | Number::toString from the shortest digits and the exponent.
js :: ([Int], Int) -> String
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
