-- | The tracker: links from a reader to what it reads, kept in read order per reader and in the
-- order made per spot; runs re-read with a cursor and drop what was not read again.
module Tracker
  ( Tracker
  , empty
  , begin
  , end
  , track
  , add
  , untrack
  , untrackAll
  , reads
  , readers
  , inRun
  ) where

import qualified Data.Map.Strict as M
import Prelude hiding (reads)

type Name = String

type LinkId = Int

data Link = Link {lFrom :: Name, lTo :: Name, lEpoch :: Int}

data Run = Run {cursor :: Maybe LinkId, epoch :: Int}

data Tracker = Tracker
  { links :: M.Map LinkId Link
  , readsOf :: M.Map Name [LinkId] -- a reader's links, in read order
  , readersOf :: M.Map Name [LinkId] -- a spot's links, in the order made
  , runs :: M.Map Name Run
  , nextId :: Int
  }

empty :: Tracker
empty = Tracker M.empty M.empty M.empty M.empty 1

get :: Name -> M.Map Name [a] -> [a]
get = M.findWithDefault []

inRun :: Name -> Tracker -> Bool
inRun n t = M.member n (runs t)

begin :: Name -> Tracker -> Tracker
begin n t = t {runs = M.insert n (Run Nothing (nextId t)) (runs t), nextId = nextId t + 1}

-- | the links after the cursor dropped; the run over. outside a run: nothing
end :: Name -> Tracker -> Tracker
end n t = case M.lookup n (runs t) of
  Nothing -> t
  Just r ->
    let ls = get n (readsOf t)
        dropped = case cursor r of
          Nothing -> ls
          Just c -> drop 1 (dropWhile (/= c) ls)
     in (dropLinks dropped t) {runs = M.delete n (runs t)}

dropLinks :: [LinkId] -> Tracker -> Tracker
dropLinks ids t = foldl one t ids
  where
    one acc i = case M.lookup i (links acc) of
      Nothing -> acc
      Just l ->
        acc
          { links = M.delete i (links acc)
          , readsOf = M.adjust (filter (/= i)) (lFrom l) (readsOf acc)
          , readersOf = M.adjust (filter (/= i)) (lTo l) (readersOf acc)
          }

toOf :: Tracker -> LinkId -> Name
toOf t i = maybe "" lTo (M.lookup i (links t))

-- | a new link from → to right after the given link (Nothing: at the front), last among to's readers
newLink :: Name -> Name -> Maybe LinkId -> Int -> Tracker -> (LinkId, Tracker)
newLink from to after ep t =
  let i = nextId t
      ls = get from (readsOf t)
      ls' = case after of
        Nothing -> i : ls
        Just c -> let (a, b) = break (== c) ls in a ++ take 1 b ++ [i] ++ drop 1 b
   in ( i
      , t
          { links = M.insert i (Link from to ep) (links t)
          , readsOf = M.insert from ls' (readsOf t)
          , readersOf = M.insert to (get to (readersOf t) ++ [i]) (readersOf t)
          , nextId = i + 1
          }
      )

track :: Name -> Name -> Tracker -> Tracker
track from to t =
  let ls = get from (readsOf t)
      run = M.findWithDefault (Run (if null ls then Nothing else Just (last ls)) 0) from (runs t)
      setCursor c tr = if inRun from tr then tr {runs = M.insert from run {cursor = Just c} (runs tr)} else tr
      afterCursor = case cursor run of
        Nothing -> take 1 ls
        Just c -> take 1 (drop 1 (dropWhile (/= c) ls))
      lastReader = case get to (readersOf t) of
        [] -> Nothing
        rs -> M.lookup (last rs) (links t)
   in case () of
        _
          | Just c <- cursor run, toOf t c == to -> t
          | [n] <- afterCursor, toOf t n == to ->
              setCursor n t {links = M.adjust (\l -> l {lEpoch = epoch run}) n (links t)}
          | Just l <- lastReader, lFrom l == from, lEpoch l == epoch run -> t
          | otherwise -> let (i, t') = newLink from to (cursor run) (epoch run) t in setCursor i t'

-- | outside a run: appended, unless from already reads to
add :: Name -> Name -> Tracker -> Tracker
add from to t
  | any ((== to) . toOf t) ls = t
  | otherwise = snd (newLink from to (if null ls then Nothing else Just (last ls)) 0 t)
  where
    ls = get from (readsOf t)

untrack :: Name -> Name -> Tracker -> Tracker
untrack from to t =
  let ls = get from (readsOf t)
      gone = filter ((== to) . toOf t) ls
      t' = dropLinks gone t
   in case M.lookup from (runs t) of
        Just r
          | Just c <- cursor r
          , c `elem` gone ->
              let before = reverse (takeWhile (/= c) ls)
                  back = case filter (`notElem` gone) before of (b : _) -> Just b; [] -> Nothing
               in t' {runs = M.insert from r {cursor = back} (runs t')}
        _ -> t'

untrackAll :: Name -> Tracker -> Tracker
untrackAll from t =
  let t' = dropLinks (get from (readsOf t)) t
   in t' {runs = M.adjust (\r -> r {cursor = Nothing}) from (runs t')}

reads :: Name -> Tracker -> [Name]
reads n t = map (toOf t) (get n (readsOf t))

readers :: Name -> Tracker -> [Name]
readers n t = [maybe "" lFrom (M.lookup i (links t)) | i <- get n (readersOf t)]
