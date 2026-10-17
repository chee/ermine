-- | Values in their JSON form (conformance/typescript/form.ts): plain JSON, plus bytes, typed
-- arrays, the number words, stand-ins, the "/" map and test-only symbols.
{-# LANGUAGE PatternSynonyms #-}

module Form
  ( V (VNull, VBool, VNum, VStr, VList, VMap, VBytes, VTyped, VLive, VSym, VListI, VMapI)
  , idOf
  , Kind
  , TE (..)
  , fromForm
  , toForm
  , kindNames
  , vlen
  , isSeq
  ) where

import Data.Bits (shiftL, shiftR, (.&.), (.|.))
import Data.Char (isDigit)
import Data.List (elemIndex)
import Data.Word (Word8)
import GHC.Float (double2Float, float2Double)
import Json

type Kind = String

-- | a typed array's element: a whole number (integer kinds, 64-bit too) or a float
data TE = TI Integer | TF Double
  deriving (Show)

instance Eq TE where
  TI a == TI b = a == b
  TF a == TF b = (isNaN a && isNaN b) || (a == b && isNegativeZero a == isNegativeZero b)
  _ == _ = False

data V
  = VNull
  | VBool Bool
  | VNum Double
  | VStr String
  | VListI !Int [V] -- a list and its identity (0: none yet); only unread reads identities
  | VMapI !Int [(String, V)]
  | VBytes [Word8]
  | VTyped Kind [TE]
  | VLive V
  | VSym String
  deriving (Show)

pattern VList :: [V] -> V
pattern VList xs <- VListI _ xs
  where
    VList xs = VListI 0 xs

pattern VMap :: [(String, V)] -> V
pattern VMap kvs <- VMapI _ kvs
  where
    VMap kvs = VMapI 0 kvs

{-# COMPLETE VNull, VBool, VNum, VStr, VList, VMap, VBytes, VTyped, VLive, VSym #-}

idOf :: V -> Int
idOf (VListI i _) = i
idOf (VMapI i _) = i
idOf _ = 0

-- | equal as content (numbers as Object.is would have them: -0 and 0 differ, NaN is NaN)
instance Eq V where
  VNull == VNull = True
  VBool a == VBool b = a == b
  VNum a == VNum b = (isNaN a && isNaN b) || (a == b && isNegativeZero a == isNegativeZero b)
  VStr a == VStr b = a == b
  VList a == VList b = a == b
  VMap a == VMap b = a == b
  VBytes a == VBytes b = a == b
  VTyped k a == VTyped l b = k == l && a == b
  VLive a == VLive b = a == b
  VSym a == VSym b = a == b
  _ == _ = False

kindNames :: [Kind]
kindNames = ["int8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64"]

isSeq :: V -> Bool
isSeq (VStr _) = True
isSeq (VList _) = True
isSeq (VTyped _ _) = True
isSeq _ = False

vlen :: V -> Int
vlen (VStr s) = length s
vlen (VList l) = length l
vlen (VTyped _ l) = length l
vlen _ = 0

-- reading ----------------------------------------------------------------------------------

-- | a value from its JSON form (revive): Left for a form that stands for none
fromForm :: J -> Either String V
fromForm JNull = Right VNull
fromForm (JBool b) = Right (VBool b)
fromForm (JNum d) = Right (VNum d)
fromForm (JStr s) = Right (VStr s)
fromForm (JArr xs) = VList <$> mapM fromForm xs
fromForm (JObj [("/", f)]) = slashForm f
fromForm (JObj kvs) = VMap <$> mapM (\(k, v) -> (,) k <$> fromForm v) kvs

slashForm :: J -> Either String V
slashForm (JObj [(tag, body)]) = case tag of
  "map" -> case body of
    JObj [("/", x)] -> (\v -> VMap [("/", v)]) <$> fromForm x
    _ -> Left "map"
  "live" -> VLive <$> fromForm body
  "symbol" -> case body of JStr s -> Right (VSym s); _ -> Left "symbol"
  "bytes" -> case body of JStr s -> VBytes <$> unb64 s; _ -> Left "bytes"
  "number" -> case body of
    JStr "NaN" -> Right (VNum (0 / 0))
    JStr "Infinity" -> Right (VNum (1 / 0))
    JStr "-Infinity" -> Right (VNum (-1 / 0))
    _ -> Left "number"
  k | k `elem` kindNames -> case body of
    JArr es -> VTyped k <$> mapM (element k) es
    _ -> Left "typed"
  _ -> Left "unknown form"
slashForm _ = Left "form"

element :: Kind -> J -> Either String TE
element k e
  | k == "int64" || k == "uint64" = case e of
      JStr s | ok s -> let n = read (dropWhile (== '+') s) :: Integer in inRange n
      _ -> Left "typed"
  | k == "float32" = TF . f32 <$> fl
  | k == "float64" = TF <$> fl
  | otherwise = case e of
      JNum d | isWhole d -> inRange (round d)
      _ -> Left "typed"
  where
    ok s = case s of
      ('-' : ds) -> not (null ds) && all isDigit ds
      ds -> not (null ds) && all isDigit ds
    fl = case e of
      JNum d -> Right d
      JStr "NaN" -> Right (0 / 0)
      JStr "Infinity" -> Right (1 / 0)
      JStr "-Infinity" -> Right (-1 / 0)
      _ -> Left "typed"
    inRange n = let (lo, hi) = range k in if n < lo || n > hi then Left "typed" else Right (TI n)

f32 :: Double -> Double
f32 = float2Double . double2Float

range :: Kind -> (Integer, Integer)
range k = case k of
  "int8" -> (-128, 127)
  "int16" -> (-32768, 32767)
  "uint16" -> (0, 65535)
  "int32" -> (-(2 ^ (31 :: Int)), 2 ^ (31 :: Int) - 1)
  "uint32" -> (0, 2 ^ (32 :: Int) - 1)
  "int64" -> (-(2 ^ (63 :: Int)), 2 ^ (63 :: Int) - 1)
  _ -> (0, 2 ^ (64 :: Int) - 1)

digits :: String
digits = ['A' .. 'Z'] ++ ['a' .. 'z'] ++ ['0' .. '9'] ++ "+/"

-- | base64, standard alphabet, unpadded, unused bits zero
unb64 :: String -> Either String [Word8]
unb64 s
  | length s `mod` 4 == 1 = Left "bytes"
  | otherwise = go s (0 :: Int) (0 :: Int) []
  where
    go [] bits _ acc = if bits /= 0 then Left "bytes" else Right (reverse acc)
    go (c : cs) bits held acc = case elemIndex c digits of
      Nothing -> Left "bytes"
      Just d ->
        let bits' = (bits `shiftL` 6) .|. d
            held' = held + 6
         in if held' >= 8
              then
                let h = held' - 8
                 in go cs (bits' .&. ((1 `shiftL` h) - 1)) h (fromIntegral ((bits' `shiftR` h) .&. 0xff) : acc)
              else go cs bits' held' acc

b64 :: [Word8] -> String
b64 [] = []
b64 [a] = take 2 (quad a 0 0)
b64 [a, b] = take 3 (quad a b 0)
b64 (a : b : c : rest) = quad a b c ++ b64 rest

quad :: Word8 -> Word8 -> Word8 -> String
quad a b c =
  let n = (fromIntegral a `shiftL` 16) .|. (fromIntegral b `shiftL` 8) .|. fromIntegral c :: Int
   in [digits !! ((n `shiftR` s) .&. 63) | s <- [18, 12, 6, 0]]

-- writing ----------------------------------------------------------------------------------

slash :: J -> J
slash x = JObj [("/", x)]

num :: Double -> J
num d
  | isNaN d = slash (JObj [("number", JStr "NaN")])
  | isInfinite d = slash (JObj [("number", JStr (if d > 0 then "Infinity" else "-Infinity"))])
  | otherwise = JNum d

toForm :: V -> J
toForm VNull = JNull
toForm (VBool b) = JBool b
toForm (VNum d) = num d
toForm (VStr s) = JStr s
toForm (VList xs) = JArr (map toForm xs)
toForm (VMap [("/", v)]) = slash (JObj [("map", slash (toForm v))])
toForm (VMap kvs) = JObj [(k, toForm v) | (k, v) <- kvs]
toForm (VBytes bs) = slash (JObj [("bytes", JStr (b64 bs))])
toForm (VTyped k es) = slash (JObj [(k, JArr (map el es))])
  where
    el (TI n)
      | k == "int64" || k == "uint64" = JStr (show n)
      | otherwise = JNum (fromInteger n)
    el (TF d)
      | isNaN d = JStr "NaN"
      | isInfinite d = JStr (if d > 0 then "Infinity" else "-Infinity")
      | otherwise = JNum d
toForm (VLive v) = slash (JObj [("live", toForm v)])
toForm (VSym s) = slash (JObj [("symbol", JStr s)])
