-- | op's invert: the undo of patches on a value, in the order to apply it (last patch's first).
module Invert (invertPatches, invertGroups, invertOne) where

import Apply
import Form

invertPatches :: Maybe V -> [V] -> Either (Code, Int) [Patch]
invertPatches root ps = concat <$> invertGroups root ps

-- | each patch's own undo, the last patch's first
invertGroups :: Maybe V -> [V] -> Either (Code, Int) [[Patch]]
invertGroups root ps = go root [] (zip [0 ..] ps)
  where
    go _ acc [] = Right acc
    go r acc ((i, pv) : rest) = case parsePatch pv of
      Nothing -> Left ("not-a-patch", i)
      Just p -> case applyOne r p of
        Left c -> Left (c, i)
        Right r' -> go r' (invertOne r p : acc) rest

-- | the undo of one patch that applies to the value
invertOne :: Maybe V -> Patch -> [Patch]
invertOne Nothing _ = [Patch [] Nothing Nothing Nothing]
invertOne (Just root) p@(Patch path range value move) = case move of
  Just (mpath, mrange) -> invertMove root p mpath mrange
  Nothing -> case range of
    Just (a, b) -> fst (spanUndo path (at path root) a b value)
    Nothing -> case value of
      Just _ -> putUndo path root
      Nothing -> removalUndo path root

applyAll :: Maybe V -> [Patch] -> Either Code (Maybe V)
applyAll r [] = Right r
applyAll r (p : ps) = applyOne r p >>= \r' -> applyAll r' ps

-- | equal by content, a map's keys in any order (an undo may put a key back last)
sameLoose :: V -> V -> Bool
sameLoose (VMap a) (VMap b) =
  length a == length b && all (\(k, v) -> maybe False (sameLoose v) (lookup k b)) a
sameLoose (VList a) (VList b) = length a == length b && and (zipWith sameLoose a b)
sameLoose a b = a == b

at :: [Key] -> V -> V
at path v = either (const VNull) id (getAt path v)

exists :: [Key] -> V -> Bool
exists path v = either (const False) (const True) (getAt path v)

putUndo :: [Key] -> V -> [Patch]
putUndo path root
  | exists path root = [Patch path Nothing (Just (at path root)) Nothing]
  | otherwise = [Patch path Nothing Nothing Nothing]

removalUndo :: [Key] -> V -> [Patch]
removalUndo [] root = [Patch [] Nothing (Just root) Nothing]
removalUndo path root = case last path of
  KN k -> [Patch (init path) (Just (k, k)) (Just (VList [at path root])) Nothing]
  KS _
    | exists path root -> [Patch path Nothing (Just (at path root)) Nothing]
    | otherwise -> []

isHigh, isLow :: Char -> Bool
isHigh c = c >= '\xD800' && c <= '\xDBFF'
isLow c = c >= '\xDC00' && c <= '\xDFFF'

-- | the undo of the span a .. b-1 of target replaced by w (Nothing: removed), and whether a lone
-- high met a lone low at an edge (then the undo widens over the pair and gives back the units)
spanUndo :: [Key] -> V -> Integer -> Integer -> Maybe V -> ([Patch], Bool)
spanUndo path target a b w = case target of
  VStr s ->
    let ws = case w of Just (VStr x) -> x; _ -> ""
        ai = fromInteger a
        bi = fromInteger b
        before = take ai s
        after = drop bi s
        lastB = if null before then Nothing else Just (last before)
        left = case (lastB, ws ++ after) of
          (Just h, c : _) -> isHigh h && isLow c
          _ -> False
        right = not (null ws) && isHigh (last ws) && case after of (c : _) -> isLow c; _ -> False
        a0 = if left then ai - 1 else ai
        b0 = if right || (left && null ws) then bi + 1 else bi
        r = length (normJoin (before ++ ws ++ after))
        end = r - (length s - b0)
        old = take (b0 - a0) (drop a0 s)
     in ( undoOf (fromIntegral a0) (fromIntegral end) (if null old then Nothing else Just (VStr old))
        , left || right
        )
  _ ->
    let n = maybe 0 vlen w
        old = slice target a b
     in (undoOf a (a + fromIntegral n) (if vlen old == 0 then Nothing else Just old), False)
  where
    undoOf x y v
      | x == y && v == Nothing = []
      | otherwise = [Patch path (Just (x, y)) v Nothing]

normJoin :: String -> String
normJoin (h : l : rest)
  | isHigh h && isLow l = toEnum (0x10000 + (fromEnum h - 0xD800) * 0x400 + (fromEnum l - 0xDC00)) : normJoin rest
normJoin (c : rest) = c : normJoin rest
normJoin [] = []

-- | a path in the value after the take, in the value before it
beforeTake :: [Key] -> Maybe Span -> [Key] -> [Key]
beforeTake mpath mrange path = case mrange of
  Just (a, b) -> shift mpath a (b - a)
  Nothing -> case reverse mpath of
    (KN k : parentR) -> shift (reverse parentR) k 1
    _ -> path
  where
    shift parent from by
      | take (length parent) path == parent
      , (KN j : rest) <- drop (length parent) path
      , j >= from =
          parent ++ (KN (j + by) : rest)
      | otherwise = path

invertMove :: V -> Patch -> [Key] -> Maybe Span -> [Patch]
invertMove root (Patch path range _ _) mpath mrange
  | path == mpath && range == Nothing && mrange == Nothing = []
  | otherwise =
      let (taken, s1) = takeOut root
          target = at path s1
          intoList = mrange == Nothing && isList target && range /= Nothing
          inserted = if intoList then VList [taken] else taken
          (landUndo, landMerged) = case range of
            Just (a, b) -> spanUndo path target a b (Just inserted)
            Nothing -> (putUndo path s1, False)
          (takeUndo, takeMerged) = case mrange of
            Just (a, b) -> spanUndo mpath (at mpath root) a b Nothing
            Nothing -> (removalUndo mpath root, False)
          n = fromIntegral (vlen taken) :: Integer
          emptyTake = mrange /= Nothing && n == 0
          landedInSeq = range /= Nothing && not intoList
          cannot =
            (range == Nothing && isPrefix path mpath)
              || landMerged
              || takeMerged
              || emptyTake
              || (mrange == Nothing && isIndex mpath && landedInSeq)
          back = moveBack taken target s1 n intoList
          s2 = either (const Nothing) id (applyOne (Just s1) (Patch path range (Just inserted) Nothing))
          backWorks = case applyAll s2 back of
            Right (Just v) -> sameLoose v root
            _ -> False
       in if cannot || not backWorks then landUndo ++ takeUndo else back
  where
    takeOut r = case mrange of
      Just (a, b) -> (slice (at mpath r) a b, either (const r) id (applyOneV r (Patch mpath (Just (a, b)) Nothing Nothing)))
      Nothing -> (at mpath r, either (const r) id (applyOneV r (Patch mpath Nothing Nothing Nothing)))
    applyOneV r q = applyOne (Just r) q >>= maybe (Left "gone") Right
    isList (VList _) = True
    isList _ = False
    isIndex ks = case reverse ks of (KN _ : _) -> True; _ -> False
    isPrefix a b = length a <= length b && take (length a) b == a
    moveBack _ target s1 n intoList =
      let (utPath, utRange) = case range of
            Nothing -> case mrange of
              Just _ -> (path, Just (0, n))
              Nothing -> (path, Nothing)
            Just (a, _) ->
              if intoList then (path ++ [KN a], Nothing) else (path, Just (a, a + n))
          (ulPath, ulRange) = case mrange of
            Just (a, _) -> (mpath, Just (a, a))
            Nothing -> case reverse mpath of
              (KN k : parentR) -> (reverse parentR, Just (k, k))
              _ -> (mpath, Nothing)
          back = Patch ulPath ulRange Nothing (Just (utPath, utRange))
          existed = exists path s1
          old = at path s1
          beforeP = case range of
            Just (a, b)
              | b > a ->
                  let p = a + (if intoList then 1 else n)
                   in [Patch path (Just (p, p)) (Just (slice target a b)) Nothing]
            Nothing
              | utRange == Nothing
              , (KN j : parentR) <- reverse path ->
                  [Patch (reverse parentR) (Just (j + 1, j + 1)) (Just (VList [old])) Nothing]
            _ -> []
          afterP = case range of
            Nothing
              | utRange /= Nothing ->
                  [Patch (beforeTake mpath mrange path) Nothing (if existed then Just old else Nothing) Nothing]
              | existed, (KS _ : _) <- reverse path ->
                  [Patch (beforeTake mpath mrange path) Nothing (Just old) Nothing]
            _ -> []
       in beforeP ++ [back] ++ afterP
