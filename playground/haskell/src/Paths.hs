-- | paths: the spots read at each key, kept in a trie of path steps, and which of them a patch
-- marks (the rule, and the order a mark walks them in).
module Paths
  ( PKey (..)
  , Place (..)
  , Spot (..)
  , Paths
  , Key
  , empty
  , spot
  , change
  , release
  , releaseChange
  , mark
  , kept
  , reaches
  ) where

import Data.List (nub, sortOn)
import qualified Data.Map.Strict as M

data PKey = PS String | PN Integer deriving (Eq, Ord, Show)

-- | (source, id), each a string (Left) or a symbol's name (Right)
type Key = (Either String String, Either String String)

-- | a place a patch changes: its path, its span, whether it puts, and how many it puts (Nothing:
-- not known)
data Place = Place {qPath :: [PKey], qRange :: Maybe (Integer, Integer), qPut :: Bool, qN :: Maybe Integer}

data Spot = Change | Plain [PKey] | Keys [PKey] deriving (Eq, Show)

data Step = Step {sSpot :: Bool, sKeys :: Bool, sKids :: [(PKey, Step)]}

data Entry = Entry {eChange :: Bool, eTop :: Step}

newtype Paths = Paths (M.Map Key Entry)

empty :: Paths
empty = Paths M.empty

blank :: Step
blank = Step False False []

hollow :: Step -> Bool
hollow s = not (sSpot s) && not (sKeys s) && null (sKids s)

-- | a read's spot (keys: a read of the keys at path), made or found
spot :: Key -> [PKey] -> Bool -> Paths -> Paths
spot k path keys (Paths m) =
  let e = M.findWithDefault (Entry False blank) k m
   in Paths (M.insert k e {eTop = go path (eTop e)} m)
  where
    go [] s = if keys then s {sKeys = True} else s {sSpot = True}
    go (p : ps) s = case lookup p (sKids s) of
      Just kid -> s {sKids = [(q, if q == p then go ps kid else x) | (q, x) <- sKids s]}
      Nothing -> s {sKids = sKids s ++ [(p, go ps blank)]}

change :: Key -> Paths -> Paths
change k (Paths m) = Paths (M.insert k (M.findWithDefault (Entry False blank) k m) {eChange = True} m)

-- | let the spot go; steps left with nothing go, then the key
release :: Key -> [PKey] -> Bool -> Paths -> Paths
release k path keys (Paths m) = case M.lookup k m of
  Nothing -> Paths m
  Just e -> tidy k e {eTop = go path (eTop e)} (Paths m)
  where
    go [] s = if keys then s {sKeys = False} else s {sSpot = False}
    go (p : ps) s =
      s {sKids = [(q, x') | (q, x) <- sKids s, let x' = if q == p then go ps x else x, not (hollow x')]}

releaseChange :: Key -> Paths -> Paths
releaseChange k (Paths m) = case M.lookup k m of
  Nothing -> Paths m
  Just e -> tidy k e {eChange = False} (Paths m)

tidy :: Key -> Entry -> Paths -> Paths
tidy k e (Paths m)
  | not (eChange e) && hollow (eTop e) = Paths (M.delete k m)
  | otherwise = Paths (M.insert k e m)

-- | (keys, spots, steps)
kept :: Paths -> (Int, Int, Int)
kept (Paths m) = (M.size m, sum (map spots es), sum (map steps es))
  where
    es = M.elems m
    spots e = fromEnum (eChange e) + count (eTop e)
    count s = fromEnum (sSpot s) + fromEnum (sKeys s) + sum (map (count . snd) (sKids s))
    steps e = size (eTop e)
    size s = 1 + sum (map (size . snd) (sKids s))

-- | what the places mark at a key, each spot once: the change spot, then each place's walk
mark :: Key -> [Place] -> Paths -> [Spot]
mark k places (Paths m) = case M.lookup k m of
  Nothing -> []
  Just e -> nub ([Change | eChange e] ++ concatMap (walk (eTop e)) places)

numberKids :: Step -> [(Integer, [PKey] -> [Spot], Step)]
numberKids s = sortOn (\(i, _, _) -> i) [(i, const [], x) | (PN i, x) <- sKids s]

walk :: Step -> Place -> [Spot]
walk top (Place q range put n) = go [] q top
  where
    removalAt = case (range, put, reverse q) of
      (Nothing, False, PN k : _) -> Just k
      _ -> Nothing
    go here rest s = case rest of
      [] -> case range of
        Nothing -> wholly here s
        Just (a, b) ->
          own here s
            ++ concat
              [ wholly (here ++ [PN i]) x
              | (i, _, x) <- numberKids s
              , i >= a
              , n /= Just (b - a) || i < b
              ]
      (p : ps) ->
        [Plain here | sSpot s]
          ++ ( if null ps
                 then
                   [Keys here | sKeys s, range == Nothing]
                     ++ concat [wholly (here ++ [PN i]) x | Just k <- [removalAt], (i, _, x) <- numberKids s, i > k]
                 else []
             )
          ++ maybe [] (go (here ++ [p]) ps) (lookup p (sKids s))

own :: [PKey] -> Step -> [Spot]
own here s = [Plain here | sSpot s] ++ [Keys here | sKeys s]

wholly :: [PKey] -> Step -> [Spot]
wholly here s = own here s ++ concat [wholly (here ++ [p]) x | (p, x) <- sKids s]

-- | the rule: whether a place reaches a read of path (keys: a keys read)
reaches :: Bool -> Place -> [PKey] -> Bool
reaches keys pl p
  | keys && length q > length p = length q == length p + 1 && qRange pl == Nothing && p == take (length p) q
  | otherwise = plain
  where
    q = qPath pl
    plain =
      p == take (length p) q
        || beside
        || (qRange pl == Nothing && length q < length p && take (length q) p == q)
        || spanned
    beside = case (qRange pl, qPut pl, reverse q) of
      (Nothing, False, PN k : parentR) ->
        let parent = reverse parentR
         in length p > length parent && take (length parent) p == parent && case p !! length parent of
              PN j -> j > k
              _ -> False
      _ -> False
    spanned = case qRange pl of
      Just (a, b) | length p > length q && take (length q) p == q -> case p !! length q of
        PN k -> if qN pl == Just (b - a) then k >= a && k < b else k >= a
        _ -> False
      _ -> False
