-- | Plain JSON as the line protocol has it: objects keep their key order, strings keep lone
-- surrogates (a Char in D800..DFFF; a high then a low is joined into one code point), numbers
-- are doubles (as JavaScript reads them) and -0 is kept.
module Json
  ( J (..)
  , parseJson
  , render
  , renderNum
  , norm
  , str
  , field
  , isWhole
  ) where

import Data.Char (chr, ord, isDigit, isHexDigit, digitToInt)
import Data.List (intercalate)
import Numeric (showHex)

data J
  = JNull
  | JBool Bool
  | JNum Double
  | JStr String
  | JArr [J]
  | JObj [(String, J)]
  deriving (Eq, Show)

str :: String -> J
str = JStr

field :: String -> J -> Maybe J
field k (JObj kvs) = lookup k kvs
field _ _ = Nothing

isWhole :: Double -> Bool
isWhole d = not (isNaN d || isInfinite d) && d == fromInteger (round d)

-- | Join each lone high surrogate followed by a lone low one into one code point.
norm :: String -> String
norm (h : l : rest)
  | isHigh h && isLow l = chr (0x10000 + (ord h - 0xD800) * 0x400 + (ord l - 0xDC00)) : norm rest
norm (c : rest) = c : norm rest
norm [] = []

isHigh, isLow :: Char -> Bool
isHigh c = c >= '\xD800' && c <= '\xDBFF'
isLow c = c >= '\xDC00' && c <= '\xDFFF'

-- parsing ----------------------------------------------------------------------------------

parseJson :: String -> Either String J
parseJson s = case value (ws s) of
  Right (j, rest) | all isSpace' rest -> Right j
  Right _ -> Left "trailing text"
  Left e -> Left e

isSpace' :: Char -> Bool
isSpace' c = c == ' ' || c == '\t' || c == '\n' || c == '\r'

ws :: String -> String
ws = dropWhile isSpace'

type P a = String -> Either String (a, String)

value :: P J
value ('{' : r) = object (ws r) []
value ('[' : r) = array (ws r) []
value ('"' : r) = do (s, r') <- string r; pure (JStr s, r')
value ('t' : 'r' : 'u' : 'e' : r) = Right (JBool True, r)
value ('f' : 'a' : 'l' : 's' : 'e' : r) = Right (JBool False, r)
value ('n' : 'u' : 'l' : 'l' : r) = Right (JNull, r)
value s@(c : _) | c == '-' || isDigit c = number s
value _ = Left "bad json"

object :: String -> [(String, J)] -> Either String (J, String)
object ('}' : r) [] = Right (JObj [], r)
object ('"' : r) acc = do
  (k, r1) <- string r
  case ws r1 of
    ':' : r2 -> do
      (v, r3) <- value (ws r2)
      let acc' = put k v acc
      case ws r3 of
        ',' : r4 -> object (ws r4) acc'
        '}' : r4 -> Right (JObj (reverse acc'), r4)
        _ -> Left "bad object"
    _ -> Left "bad object"
  where
    -- a repeated key keeps its first place and its last value (as JSON.parse)
    put k v kvs
      | any ((== k) . fst) kvs = [if k' == k then (k', v) else (k', v') | (k', v') <- kvs]
      | otherwise = (k, v) : kvs
object _ _ = Left "bad object"

array :: String -> [J] -> Either String (J, String)
array (']' : r) [] = Right (JArr [], r)
array s acc = do
  (v, r) <- value s
  case ws r of
    ',' : r' -> array (ws r') (v : acc)
    ']' : r' -> Right (JArr (reverse (v : acc)), r')
    _ -> Left "bad array"

string :: P String
string = go []
  where
    go acc ('"' : r) = Right (norm (reverse acc), r)
    go acc ('\\' : c : r) = case c of
      '"' -> go ('"' : acc) r
      '\\' -> go ('\\' : acc) r
      '/' -> go ('/' : acc) r
      'b' -> go ('\b' : acc) r
      'f' -> go ('\f' : acc) r
      'n' -> go ('\n' : acc) r
      'r' -> go ('\r' : acc) r
      't' -> go ('\t' : acc) r
      'u' | (h, r') <- splitAt 4 r, length h == 4, all isHexDigit h ->
        go (chr (foldl (\a d -> a * 16 + digitToInt d) 0 h) : acc) r'
      _ -> Left "bad escape"
    go acc (c : r) = go (c : acc) r
    go _ [] = Left "unterminated string"

number :: P J
number s =
  let (neg, s1) = case s of ('-' : r) -> (True, r); _ -> (False, s)
      (int, s2) = span isDigit s1
      (frac, s3) = case s2 of
        ('.' : r) -> let (f, r') = span isDigit r in (f, r')
        _ -> ("", s2)
      (ex, s4) = case s3 of
        (e : r) | e == 'e' || e == 'E' ->
          let (sg, r1) = case r of
                ('+' : q) -> ("", q)
                ('-' : q) -> ("-", q)
                _ -> ("", r)
              (ds, r2) = span isDigit r1
           in (sg ++ ds, r2)
        _ -> ("", s3)
   in if null int then Left "bad number"
        else
          let mant = read (int ++ frac) :: Integer
              e = (if null ex then 0 else read ex :: Integer) - fromIntegral (length frac)
              mag
                | mant == 0 = 0
                | e > 400 = 1 / 0
                | e < -400 = 0
                | e >= 0 = fromRational (fromInteger (mant * 10 ^ e))
                | otherwise = fromRational (fromInteger mant / fromInteger (10 ^ negate e))
              d = if neg then negate mag else mag :: Double
           in Right (JNum d, s4)

-- rendering --------------------------------------------------------------------------------

render :: J -> String
render JNull = "null"
render (JBool b) = if b then "true" else "false"
render (JNum d) = renderNum d
render (JStr s) = renderStr s
render (JArr xs) = "[" ++ intercalate "," (map render xs) ++ "]"
render (JObj kvs) = "{" ++ intercalate "," [renderStr k ++ ":" ++ render v | (k, v) <- kvs] ++ "}"

renderNum :: Double -> String
renderNum d
  | isNaN d || isInfinite d = "null"
  | isNegativeZero d = "-0"
  | isWhole d && abs d < 1e21 = show (round d :: Integer)
  | otherwise = show d

renderStr :: String -> String
renderStr s = '"' : concatMap esc s ++ "\""
  where
    esc '"' = "\\\""
    esc '\\' = "\\\\"
    esc '\n' = "\\n"
    esc '\r' = "\\r"
    esc '\t' = "\\t"
    esc c
      | ord c < 0x20 || (ord c >= 0xD800 && ord c <= 0xDFFF) = "\\u" ++ pad (showHex (ord c) "")
      | otherwise = [c]
    pad h = replicate (4 - length h) '0' ++ h
