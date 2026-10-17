-- | op's apply: JSON-ish patches on a value, refused whole with the first patch's code.
module Apply
  ( Key (..)
  , Patch (..)
  , Span
  , Code
  , parsePatch
  , applyPatches
  , applyOne
  , keyV
  , patchV
  , getAt
  , slice
  , splice
  ) where

import Form

data Key = KS String | KN Integer
  deriving (Eq, Show)

type Span = (Integer, Integer)

type Code = String

data Patch = Patch
  { pPath :: [Key]
  , pRange :: Maybe Span
  , pValue :: Maybe V
  , pMove :: Maybe ([Key], Maybe Span)
  }
  deriving (Show)

keyV :: Key -> V
keyV (KS s) = VStr s
keyV (KN n) = VNum (fromInteger n)

-- | a patch back as a value: fields in the order path, range, value, move
patchV :: Patch -> V
patchV (Patch p r v m) =
  VMap $
    [("path", VList (map keyV p))]
      ++ maybe [] (\s -> [("range", spanV s)]) r
      ++ maybe [] (\x -> [("value", x)]) v
      ++ maybe [] (\(mp, mr) -> [("move", VMap ([("path", VList (map keyV mp))] ++ maybe [] (\s -> [("range", spanV s)]) mr))]) m
  where
    spanV (a, b) = VList [VNum (fromInteger a), VNum (fromInteger b)]

whole :: V -> Maybe Integer
whole (VNum d)
  | not (isNaN d || isInfinite d) && d >= 0 && d == fromInteger (round d) = Just (round d)
whole _ = Nothing

parsePath :: V -> Maybe [Key]
parsePath (VList ks) = mapM k ks
  where
    k (VStr s) = Just (KS s)
    k v = KN <$> whole v
parsePath _ = Nothing

parseSpan :: V -> Maybe Span
parseSpan (VList [a, b]) = (,) <$> whole a <*> whole b
parseSpan _ = Nothing

-- | a patch from its value; Nothing: not-a-patch
parsePatch :: V -> Maybe Patch
parsePatch (VMap kvs) = do
  path <- lookup "path" kvs >>= parsePath
  range <- opt "range" parseSpan kvs
  let value = lookup "value" kvs
  move <- case lookup "move" kvs of
    Nothing -> Just Nothing
    Just (VMap m) -> do
      mp <- lookup "path" m >>= parsePath
      mr <- opt "range" parseSpan m
      case (value, lookup "value" m, lookup "move" m) of
        (Nothing, Nothing, Nothing) -> Just (Just (mp, mr))
        _ -> Nothing
    Just _ -> Nothing
  pure (Patch path range value move)
  where
    opt k f m = case lookup k m of
      Nothing -> Just Nothing
      Just v -> Just <$> f v
parsePatch _ = Nothing

-- | the patches in order; Left (code, index) for the first refused
applyPatches :: Maybe V -> [V] -> Either (Code, Int) (Maybe V)
applyPatches root ps = go root (zip [0 ..] ps)
  where
    go r [] = Right r
    go r ((i, p) : rest) = case parsePatch p of
      Nothing -> Left ("not-a-patch", i)
      Just q -> case applyOne r q of
        Left c -> Left (c, i)
        Right r' -> go r' rest

applyOne :: Maybe V -> Patch -> Either Code (Maybe V)
applyOne Nothing (Patch [] Nothing (Just v) Nothing) = Right (Just v)
applyOne Nothing _ = Left "no-key"
applyOne (Just root) p@(Patch path range value move) = case move of
  Nothing -> case (range, value) of
    (Nothing, Just v) -> Just <$> putAt path v root
    (Nothing, Nothing) -> removeAt path root
    (Just s, v) -> Just <$> modifyAt path (spanPut s v) root
  Just (mpath, mrange) -> moveOne p root mpath mrange

-- | the span replaced by a value of the target's kind, or removed (Nothing)
spanPut :: Span -> Maybe V -> V -> Either Code V
spanPut (a, b) what target
  | a > b = Left "range"
  | not (isSeq target) = Left "wrong-kind"
  | b > fromIntegral (vlen target) = Left "range"
  | otherwise = case what of
      Nothing -> Right (splice target a b (emptyOf target))
      Just v ->
        if sameKind target v then Right (splice target a b v) else Left "wrong-kind"

emptyOf :: V -> V
emptyOf (VStr _) = VStr ""
emptyOf (VList _) = VList []
emptyOf (VTyped k _) = VTyped k []
emptyOf v = v

sameKind :: V -> V -> Bool
sameKind (VStr _) (VStr _) = True
sameKind (VList _) (VList _) = True
sameKind (VTyped k _) (VTyped l _) = k == l
sameKind _ _ = False

-- | the span a .. b-1 of a sequence replaced by the elements of w (of its kind)
splice :: V -> Integer -> Integer -> V -> V
splice (VStr s) a b (VStr w) = VStr (normS (take (fromInteger a) s ++ w ++ drop (fromInteger b) s))
splice (VListI i s) a b (VList w) = VListI i (take (fromInteger a) s ++ w ++ drop (fromInteger b) s)
splice (VTyped k s) a b (VTyped _ w) = VTyped k (take (fromInteger a) s ++ w ++ drop (fromInteger b) s)
splice v _ _ _ = v

slice :: V -> Integer -> Integer -> V
slice (VStr s) a b = VStr (take (fromInteger (b - a)) (drop (fromInteger a) s))
slice (VList s) a b = VList (take (fromInteger (b - a)) (drop (fromInteger a) s))
slice (VTyped k s) a b = VTyped k (take (fromInteger (b - a)) (drop (fromInteger a) s))
slice v _ _ = v

normS :: String -> String
normS (h : l : rest)
  | h >= '\xD800' && h <= '\xDBFF' && l >= '\xDC00' && l <= '\xDFFF' =
      toEnum (0x10000 + (fromEnum h - 0xD800) * 0x400 + (fromEnum l - 0xDC00)) : normS rest
normS (c : rest) = c : normS rest
normS [] = []

-- | the value at path changed by f; the walk's errors on the way
modifyAt :: [Key] -> (V -> Either Code V) -> V -> Either Code V
modifyAt [] f v = f v
modifyAt (k : ks) f v = case (v, k) of
  (VListI ident xs, KN i)
    | i < fromIntegral (length xs) -> do
        let n = fromInteger i
        x' <- modifyAt ks f (xs !! n)
        Right (VListI ident (take n xs ++ [x'] ++ drop (n + 1) xs))
    | otherwise -> Left "no-key"
  (VMapI ident kvs, KS s) -> case lookup s kvs of
    Just x -> do
      x' <- modifyAt ks f x
      Right (VMapI ident [(k', if k' == s then x' else y) | (k', y) <- kvs])
    Nothing -> Left "no-key"
  _ -> Left "wrong-kind"

getAt :: [Key] -> V -> Either Code V
getAt [] v = Right v
getAt (k : ks) v = case (v, k) of
  (VList xs, KN i)
    | i < fromIntegral (length xs) -> getAt ks (xs !! fromInteger i)
    | otherwise -> Left "no-key"
  (VMap kvs, KS s) -> maybe (Left "no-key") (getAt ks) (lookup s kvs)
  _ -> Left "wrong-kind"

putAt :: [Key] -> V -> V -> Either Code V
putAt [] v _ = Right v
putAt path v root = modifyAt (init path) (putIn (last path)) root
  where
    putIn (KN i) (VListI ident xs)
      | i < fromIntegral (length xs) = let n = fromInteger i in Right (VListI ident (take n xs ++ [v] ++ drop (n + 1) xs))
      | otherwise = Left "no-key"
    putIn (KS s) (VMapI ident kvs)
      | any ((== s) . fst) kvs = Right (VMapI ident [(k', if k' == s then v else y) | (k', y) <- kvs])
      | otherwise = Right (VMapI ident (kvs ++ [(s, v)]))
    putIn _ _ = Left "wrong-kind"

removeAt :: [Key] -> V -> Either Code (Maybe V)
removeAt [] _ = Right Nothing
removeAt path root = Just <$> modifyAt (init path) (removeIn (last path)) root
  where
    removeIn (KN i) (VListI ident xs)
      | i < fromIntegral (length xs) = let n = fromInteger i in Right (VListI ident (take n xs ++ drop (n + 1) xs))
      | otherwise = Left "no-key"
    removeIn (KS s) (VMapI ident kvs) = Right (VMapI ident (filter ((/= s) . fst) kvs))
    removeIn _ _ = Left "wrong-kind"

-- | take what is at the move's path (whole or a span) out: (what was taken, what is left)
takeOut :: [Key] -> Maybe Span -> V -> Either Code (V, Maybe V)
takeOut [] Nothing root = Right (root, Nothing)
takeOut mpath Nothing root = do
  got <- getAt mpath root
  left <- removeAt mpath root
  pure (got, left)
takeOut mpath (Just (a, b)) root = do
  target <- getAt mpath root
  _ <- spanPut (a, b) Nothing target
  left <- modifyAt mpath (spanPut (a, b) Nothing) root
  pure (slice target a b, Just left)

moveOne :: Patch -> V -> [Key] -> Maybe Span -> Either Code (Maybe V)
moveOne (Patch path range _ _) root mpath mrange
  | intoItself = Left "into-itself"
  | path == mpath && range == Nothing && mrange == Nothing = getAt path root >> Right (Just root)
  | otherwise = do
      (taken, left) <- takeOut mpath mrange root
      case left of
        Nothing -> case (path, range) of
          ([], Nothing) -> Right (Just taken)
          -- the whole taken, then a span of it as the landing: nothing is left there
          _ -> Left "no-key"
        Just rest -> case range of
          Nothing -> Just <$> putAt path taken rest
          Just s -> Just <$> modifyAt path (land s taken) rest
  where
    intoItself = case mrange of
      Nothing -> isProperPrefix mpath path
      Just (a, b) -> case drop (length mpath) path of
        (KN k : _) | take (length mpath) path == mpath -> k >= a && k < b
        _ -> False
    land s taken target = case (target, mrange) of
      (VList _, Nothing) -> spanPut s (Just (VList [taken])) target
      _ -> spanPut s (Just taken) target

isProperPrefix :: Eq a => [a] -> [a] -> Bool
isProperPrefix a b = length a < length b && take (length a) b == a
