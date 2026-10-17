-- | The table: (part, id) keys to nodes, with orders kept as the suite has them, and its events.
module Table
  ( K (..)
  , Table
  , Event
  , empty
  , add
  , sub
  , get
  , ids
  , at
  , who
  , delKey
  , delPartNode
  , delNode
  ) where

import Data.List (nub)

-- | a key: a string or a symbol of a name (never equal to a string)
data K = KStr String | KSym String deriving (Eq, Show)

type Node = String

-- | keys in the order each was last put; per node, its parts in the order first taken
data Table = Table
  { entries :: [(K, K, Node)]
  , parts :: [(Node, [K])]
  }

-- | (part, id)
type Event = (K, K)

empty :: Table
empty = Table [] []

get :: K -> K -> Table -> Maybe Node
get p i t = case [n | (p', i', n) <- entries t, p' == p, i' == i] of
  (n : _) -> Just n
  [] -> Nothing

ids :: K -> Node -> Table -> [K]
ids p n t = [i | (p', i, n') <- entries t, p' == p, n' == n]

at :: K -> Table -> [(K, Node)]
at i t = [(p, n) | (p, i', n) <- entries t, i' == i]

who :: Node -> Table -> [(K, K)]
who n t = [(p, i) | p <- maybe [] id (lookup n (parts t)), i <- ids p n t]

-- the node's part order, mended after a change: a part with no ids leaves, a new one goes last
mend :: Node -> Table -> Table
mend n t =
  let have = nub [p | (p, _, n') <- entries t, n' == n]
      old = maybe [] id (lookup n (parts t))
      kept = filter (`elem` have) old
      order = kept ++ filter (`notElem` kept) have
      others = filter ((/= n) . fst) (parts t)
   in t {parts = if null order then others else others ++ [(n, order)]}

put :: K -> K -> Node -> Table -> Table
put p i n t = mend n t {entries = entries t ++ [(p, i, n)]}

remove :: K -> K -> Table -> Table
remove p i t = case get p i t of
  Nothing -> t
  Just n -> mend n t {entries = filter (\(p', i', _) -> not (p' == p && i' == i)) (entries t)}

-- | Left: already-there
add :: K -> K -> Node -> Table -> Either String (Table, [Event])
add p i n t = case get p i t of
  Just m | m == n -> Right (t, [])
  Just _ -> Left "already-there"
  Nothing -> Right (put p i n t, [(p, i)])

sub :: K -> K -> Node -> Table -> (Table, [Event])
sub p i n t = case get p i t of
  Just m | m == n -> (t, [])
  _ -> (put p i n (remove p i t), [(p, i)])

-- | Left: nothing-there
delKey :: K -> K -> Table -> Either String (Table, [Event])
delKey p i t = case get p i t of
  Nothing -> Left "nothing-there"
  Just _ -> Right (remove p i t, [(p, i)])

delPartNode :: K -> Node -> Table -> Either String (Table, [Event])
delPartNode p n t = delMany [(p, i) | i <- ids p n t] t

delNode :: Node -> Table -> Either String (Table, [Event])
delNode n t = delMany (who n t) t

delMany :: [(K, K)] -> Table -> Either String (Table, [Event])
delMany [] _ = Left "nothing-there"
delMany ks t = Right (foldl (\acc (p, i) -> remove p i acc) t ks, ks)
