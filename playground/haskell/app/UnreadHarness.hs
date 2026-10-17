-- unread on the line protocol (the unread suite). State: one entry, what it owns (may change in
-- place), what was held and what was marked.
--
-- Lists and maps carry an identity (Form's VListI / VMapI). A write applies the patches as values
-- (op's apply), then settles: a container the write changed keeps its identity when owned (changed
-- in place) and gets a new one, owned, when not (copied); one the write made is new and owned. What
-- leaves the tree is owned no more; a read lets go of everything, a keep of what it keeps.
module Main (main) where

import qualified Data.Map.Strict as M
import qualified Data.Set as S
import Apply
import Form
import Invert
import Json
import Line

-- what `same` compares: a container by identity, anything else by content
data Token = Ident Int | Leaf V

-- a container's own content: its keys and its children's tokens
data Shallow = SMap [(String, Tok)] | SList [Tok] deriving (Eq)

data Tok = TId Int | TLeaf V deriving (Eq)

data St = St
  { root :: Maybe V
  , owned :: S.Set Int
  , records :: M.Map Int Shallow
  , next :: Int
  , held :: M.Map String (Maybe V)
  , marks :: M.Map String (Maybe Token)
  , lastUndo :: Maybe [V]
  }

fresh :: St
fresh = St Nothing S.empty M.empty 1 M.empty M.empty Nothing

main :: IO ()
main = serve fresh step

tok :: V -> Tok
tok v = if idOf v /= 0 then TId (idOf v) else TLeaf v

shallow :: V -> Maybe Shallow
shallow (VMap kvs) = Just (SMap [(k, tok x) | (k, x) <- kvs])
shallow (VList xs) = Just (SList (map tok xs))
shallow _ = Nothing

-- | give every container with no identity a new one (recorded), children first
ident :: St -> V -> (V, St, [Int])
ident st v = case v of
  VListI i xs -> let (xs', st', made) = many st xs in finish (\j -> VListI j xs') i st' made
  VMapI i kvs ->
    let (vs', st', made) = many st (map snd kvs)
     in finish (\j -> VMapI j (zip (map fst kvs) vs')) i st' made
  _ -> (v, st, [])
  where
    many s [] = ([], s, [])
    many s (x : xs) =
      let (x', s1, m1) = ident s x
          (xs', s2, m2) = many s1 xs
       in (x' : xs', s2, m1 ++ m2)
    finish build i s made
      | i /= 0 = (build i, s, made)
      | otherwise =
          let j = next s
              out = build j
           in (out, s {next = j + 1, records = M.insert j (maybe (SList []) id (shallow out)) (records s)}, j : made)

-- | after a write: changed containers copied unless owned; new ones owned
settle :: St -> V -> (V, St)
settle st v = case v of
  VListI i xs -> let (xs', st') = many st xs in decide (VListI i xs') i st' (\j -> VListI j xs')
  VMapI i kvs ->
    let (vs', st') = many st (map snd kvs)
        kvs' = zip (map fst kvs) vs'
     in decide (VMapI i kvs') i st' (\j -> VMapI j kvs')
  _ -> (v, st)
  where
    many s [] = ([], s)
    many s (x : xs) = let (x', s1) = settle s x; (xs', s2) = many s1 xs in (x' : xs', s2)
    decide out i s build =
      let sh = maybe (SList []) id (shallow out)
          same = i /= 0 && M.lookup i (records s) == Just sh
       in if same
            then (out, s)
            else
              if i /= 0 && S.member i (owned s)
                then (out, s {records = M.insert i sh (records s)})
                else
                  let j = next s
                      out' = build j
                   in (out', s {next = j + 1, records = M.insert j sh (records s), owned = S.insert j (owned s)})

-- | an undo's values: a container this write changed and did not own is a copy of what was taken
-- (TS copies it before changing it): no identity, so it lands as a new one. one owned (changed in
-- place) or untouched is the very container, and keeps its identity
cut :: St -> V -> V
cut st v = case v of
  VListI i xs -> VListI (keep i v) (map (cut st) xs)
  VMapI i kvs -> VMapI (keep i v) [(k, cut st x) | (k, x) <- kvs]
  _ -> v
  where
    keep i x
      | i /= 0 && (S.member i (owned st) || M.lookup i (records st) == shallow x) = i
      | otherwise = 0

idsIn :: V -> S.Set Int
idsIn v = case v of
  VList xs -> self (S.unions (map idsIn xs))
  VMap kvs -> self (S.unions (map (idsIn . snd) kvs))
  _ -> S.empty
  where
    self s = if idOf v /= 0 then S.insert (idOf v) s else s

-- | what is at a path: a string into a map, a whole number into a list; else nothing
at :: [V] -> Maybe V -> Maybe V
at [] v = v
at (k : ks) (Just (VMap kvs)) | VStr s <- k = at ks (lookup s kvs)
at (k : ks) (Just (VList xs))
  | VNum d <- k
  , d >= 0
  , d == fromInteger (round d)
  , round d < (fromIntegral (length xs) :: Integer) =
      at ks (Just (xs !! fromInteger (round d)))
at _ _ = Nothing

pathOf :: J -> [V]
pathOf req = case getField "path" req of
  Just (JArr ks) -> map (either failWith id . fromForm) ks
  _ -> []

nameOf :: J -> String
nameOf req = maybe (failWith "no name") id (getStr "name" req)

token :: V -> Token
token v = if idOf v /= 0 then Ident (idOf v) else Leaf v

sameToken :: Maybe Token -> Maybe Token -> Bool
sameToken Nothing Nothing = True
sameToken (Just (Ident a)) (Just (Ident b)) = a == b
sameToken (Just (Leaf (VNum a))) (Just (Leaf (VNum b))) = a == b -- as ===: -0 is 0, NaN is not NaN
sameToken (Just (Leaf a)) (Just (Leaf b)) = a == b
sameToken _ _ = False

valueAnswer :: Maybe V -> J
valueAnswer v = obj (maybe [] (\x -> [("value", toForm x)]) v)

holdAs :: J -> Maybe V -> St -> St
holdAs req v st = case getStr "hold" req of
  Just n -> st {held = M.insert n v (held st)}
  Nothing -> st

-- | write patches (values), as a write: the answer and the state after
write :: J -> [V] -> St -> (J, St)
write req ps0 st0 =
  let (ps, st1, _) = identAll st0 ps0
      puts = [v | VMap kvs <- ps, Just v <- [lookup "value" kvs]]
      st2 = holdAs req (Just (VList puts)) st1
      -- one patch at a time, as unread does: each settles (copies what it changed that is not
      -- owned) in the tree the ones before it left
      run r st _ [] = Right (r, st)
      run r st k (p : rest) = case applyPatches r [p] of
        Left (c, _) -> Left (c, k)
        Right r0 ->
          let (r1, st') = maybe (Nothing, st) (\x -> let (y, s') = settle st x in (Just y, s')) r0
           in run r1 st' (k + 1 :: Int) rest
   in case run (root st2) st2 0 ps of
        Left (c, i) -> (obj [("error", JStr c), ("patch", JNum (fromIntegral i))], st2)
        Right (r', st3) -> do
          let undo = either (const []) (map (cut st2 . patchV)) (invertPatches (root st2) ps)
              live = maybe S.empty idsIn r'
              st4 = st3 {root = r', owned = S.intersection (owned st3) live, lastUndo = Just undo}
          (obj [("undo", JArr (map toForm undo))], st4)
  where
    identAll s [] = ([], s, [])
    identAll s (x : xs) =
      let (x', s1, m1) = ident s x
          (xs', s2, m2) = identAll s1 xs
       in (x' : xs', s2, m1 ++ m2)

step :: St -> J -> (J, St)
step st req = case getStr "op" req of
  Just "start" ->
    let v = either failWith id (traverse fromForm (getField "value" req))
        (v', st', _) = maybe (Nothing, fresh {next = next st}, []) (\x -> let (y, s, m) = ident (fresh {next = next st}) x in (Just y, s, m)) v
     in (obj [], st' {root = v'})
  Just "write" -> case getField "patches" req of
    Just (JArr raw) -> write req (map (either failWith id . fromForm) raw) st
    _ -> failWith "patches: not a list"
  Just "unwrite" -> case lastUndo st of
    Nothing -> (obj [("error", JStr "nothing-written")], st)
    Just undo -> write req undo st
  Just "read" -> (valueAnswer (root st), holdAs req (root st) st {owned = S.empty})
  Just "keep" ->
    let v = at (pathOf req) (root st)
        wrapped = getField "wrap" req == Just (JBool True)
        kept = if wrapped then Just (VList [maybe VNull id v]) else v
        letGo = maybe S.empty idsIn v
     in (obj [], holdAs req kept st {owned = S.difference (owned st) letGo})
  Just "held" -> (valueAnswer (maybe Nothing id (M.lookup (nameOf req) (held st))), st)
  Just "value" -> (valueAnswer (root st), st)
  Just "mark" -> (obj [], st {marks = M.insert (nameOf req) (token <$> at (pathOf req) (root st)) (marks st)})
  Just "same" ->
    let now = token <$> at (pathOf req) (root st)
        was = maybe Nothing id (M.lookup (nameOf req) (marks st))
     in (obj [("same", JBool (sameToken was now))], st)
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
