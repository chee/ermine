-- | op's squish: patches pushed one by one, joined and killed where the later says what the
-- earlier did; and the columns form. Squish never reads content beyond kinds and lengths.
module Squish (squish, encode, decode) where

import Data.List (elemIndex, isPrefixOf)
import Json

-- a patch as given, and what squish reads of it
data P = P
  { raw :: J
  , path :: [J]
  , range :: Maybe (Integer, Integer)
  , value :: Maybe J
  , move :: Maybe J
  }

readP :: J -> P
readP j = P j pth rng (field "value" j) (field "move" j)
  where
    pth = case field "path" j of Just (JArr ks) -> ks; _ -> []
    rng = case field "range" j of
      Just (JArr [ja, jb]) | Just a <- jint ja, Just b <- jint jb -> Just (a, b)
      _ -> Nothing

build :: [J] -> Maybe (Integer, Integer) -> Maybe J -> J
build pth rng v =
  JObj $
    [("path", JArr pth)]
      ++ maybe [] (\(a, b) -> [("range", JArr [JInt a, JInt b])]) rng
      ++ maybe [] (\x -> [("value", x)]) v

-- | a lone surrogate anywhere in a value (strings, list elements, map values; not map keys)
lone :: J -> Bool
lone (JStr s) = any (\c -> c >= '\xD800' && c <= '\xDFFF') s
lone (JArr xs) = any lone xs
lone (JObj kvs) = any (lone . snd) kvs
lone _ = False

atOrUnder :: [J] -> [J] -> Bool
atOrUnder p q = q `isPrefixOf` p -- p at or under q

squish :: [J] -> [J]
squish = map canon . reverse . fst . foldl push ([], [])

-- | a patch answered as path, range, value, move and nothing else; -0 as a key or position is 0
canon :: P -> J
canon p =
  JObj $
    [("path", JArr (map zero (path p)))]
      ++ maybe [] (\(a, b) -> [("range", JArr [JInt a, JInt b])]) (range p)
      ++ maybe [] (\x -> [("value", x)]) (value p)
      ++ maybe [] (\x -> [("move", x)]) (move p)
  where
    zero (JNum d) | d == 0 = JInt 0
    zero k = k

-- kept patches (last first), fouled paths
push :: ([P], [[J]]) -> J -> ([P], [[J]])
push (kept, fouled) j =
  let p = readP j
      fouled1
        | null (path p) && range p == Nothing && move p == Nothing =
            [path p | maybe False lone (value p)]
        | maybe False lone (value p) = path p : fouled
        | Just m <- move p
        , Just (JArr mp) <- field "path" m =
            -- a move from at or under a fouled place fouls where it lands; one from above a fouled
            -- place carries the fouling along to the same place under the landing
            [path p | any (atOrUnder mp) fouled]
              ++ [path p ++ drop (length mp) f | f <- fouled, mp `isPrefixOf` f, length f > length mp]
              ++ fouled
        | otherwise = fouled
   in case (range p, move p) of
        (Nothing, Nothing)
          | null (path p) -> ([p], fouled1)
          | otherwise -> (p : kill p kept, fouled1)
        (_, Just _) -> (p : kept, fouled1)
        (Just _, Nothing) -> case kept of
          (e : rest)
            | not (any (atOrUnder (path p)) fouled)
            , not (maybe False lone (value p))
            , Just joined <- join e p ->
                (reach joined rest, fouled1)
          _ -> (p : kept, fouled1)

-- | merges reach back: the joined patch joined into the one before it, while they join
reach :: P -> [P] -> [P]
reach l (e : rest) | Just j <- join e l = reach j rest
reach l kept = l : kept

-- | drop earlier patches at or under p's path, last first, until one is not
kill :: P -> [P] -> [P]
kill p (e : rest)
  | atOrUnder (path e) (path p)
  , move e == Nothing
  , not (isListRemoval e && path e == path p) =
      kill p rest
  where
    isListRemoval q =
      range q == Nothing && value q == Nothing && case reverse (path q) of
        (JNum _ : _) -> True
        (JInt _ : _) -> True
        _ -> False
kill _ kept = kept

data Kind = KStr | KList | KTyped String | KOther deriving (Eq)

kindOf :: J -> Kind
kindOf (JStr _) = KStr
kindOf (JArr _) = KList
kindOf (JObj [("/", JObj [(k, JArr _)])]) | k `elem` kindNames = KTyped k
kindOf _ = KOther

kindNames :: [String]
kindNames = ["int8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64"]

-- a sequence's elements, and the sequence back from them
elems :: J -> [J]
elems (JStr s) = map (\c -> JStr [c]) s
elems (JArr xs) = xs
elems (JObj [("/", JObj [(_, JArr xs)])]) = xs
elems _ = []

like :: J -> [J] -> J
like (JStr _) es = JStr (norm (concat [s | JStr s <- es]))
like (JArr _) es = JArr es
like (JObj [("/", JObj [(k, _)])]) es = JObj [("/", JObj [(k, JArr es)])]
like v _ = v

len :: J -> Integer
len = fromIntegral . length . elems

cut :: J -> Integer -> Integer -> J
cut v a b = let es = elems v in like v (take (fromInteger a) es ++ drop (fromInteger b) es)

ins :: J -> Integer -> J -> J
ins v at w = let es = elems v in like v (take (fromInteger at) es ++ elems w ++ drop (fromInteger at) es)

-- | the earlier and the later as one patch, when they join
join :: P -> P -> Maybe P
join e l
  | path e /= path l || move e /= Nothing = Nothing
  | Just (a, b) <- range e
  , Just (c, d) <- range l =
      case value e of
        Just v
          | kindOf v == KOther -> Nothing
          | maybe False (\w -> kindOf w /= kindOf v) (value l) -> Nothing
          | lone v -> Nothing
          | otherwise ->
              let n = len v
                  w = maybe (emptyOf v) id (value l)
               in if a <= c && d <= a + n
                    then Just (mk (a, b) (Just (ins (cut v (c - a) (d - a)) (c - a) w)))
                    else
                      if c == a + n && d > a + n
                        then Just (mk (a, b + d - (a + n)) (Just (ins v n w)))
                        else Nothing
        Nothing -> case value l of
          Nothing | c <= a && a <= d -> Just (mk (c, b + d - a) Nothing)
          Just w | c == a && d == a && kindOf w /= KOther -> Just (mk (a, b) (Just w))
          _ -> Nothing
  | otherwise = Nothing
  where
    mk r v = readP (build (path e) (Just r) v)
    emptyOf v = like v []

-- columns ----------------------------------------------------------------------------------

runs :: [Integer] -> [J]
runs [] = []
runs (x : xs) = let (same, rest) = span (== x) xs in JInt x : JInt (fromIntegral (1 + length same)) : runs rest

unruns :: [J] -> [Integer]
unruns (jx : jn : rest) | Just x <- jint jx, Just n <- jint jn = replicate (fromInteger n) x ++ unruns rest
unruns _ = []

encode :: [J] -> J
encode js =
  let ps = map readP js
      paths = foldl (\acc p -> if path p `elem` acc then acc else acc ++ [path p]) [] ps
      idx p = maybe 0 fromIntegral (elemIndex (path p) paths)
      shape p =
        (if range p /= Nothing then 1 else 0)
          + (if value p /= Nothing then 2 else 0)
          + (if move p /= Nothing then 4 else 0)
      ranges = [r | Just r <- map range ps]
      froms = zipWith (-) (map fst ranges) (0 : map fst ranges)
   in JObj
        [ ("paths", JArr (map JArr paths))
        , ("path", JArr (runs (map idx ps)))
        , ("shape", JArr (runs (map shape ps)))
        , ("from", JArr (runs froms))
        , ("size", JArr (runs [b - a | (a, b) <- ranges]))
        , ("value", JArr [v | Just v <- map value ps])
        , ("move", JArr [m | Just m <- map move ps])
        ]

-- | the patches from columns; Left when the columns don't cover their shapes
decode :: J -> Either String [J]
decode cols = go (unruns (col "path")) (unruns (col "shape")) (unruns (col "from")) (unruns (col "size")) (col "value") (col "move") 0
  where
    col k = case field k cols of Just (JArr xs) -> xs; _ -> []
    paths = col "paths"
    go [] [] _ _ _ _ _ = Right []
    go (i : is) (s : ss) fs zs vs ms last = do
      (rng, fs', zs', last') <-
        if odd s
          then case (fs, zs) of
            (f : fr, z : zr) -> let a = last + f in Right (Just (a, a + z), fr, zr, a)
            _ -> Left "no from or size for a range"
          else Right (Nothing, fs, zs, last)
      (v, vs') <- takeIf (s `div` 2 `mod` 2 == 1) vs
      (m, ms') <- takeIf (s `div` 4 `mod` 2 == 1) ms
      pth <- case drop (fromInteger i) paths of
        (JArr p : _) | i >= 0 -> Right p
        _ -> Left "no such path"
      let patch = JObj ([("path", JArr pth)] ++ maybe [] (\(a, b) -> [("range", JArr [JInt a, JInt b])]) rng ++ maybe [] (\x -> [("value", x)]) v ++ maybe [] (\x -> [("move", x)]) m)
      (patch :) <$> go is ss fs' zs' vs' ms' last'
    go _ _ _ _ _ _ _ = Left "path and shape cover different patches"
    takeIf False xs = Right (Nothing, xs)
    takeIf True (x : r) = Right (Just x, r)
    takeIf True [] = Left "a column runs short"
