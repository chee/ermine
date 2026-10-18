-- paths on the line protocol (the paths suite). State: the spots kept, per key.
module Main (main) where

import Json
import Line
import Paths

main :: IO ()
main = serve empty step

step :: Paths -> J -> (J, Paths)
step ps req = case getStr "op" req of
  Just "spot" -> let k = key; p = needPath (getField "path" req) in force k p (obj [], spot k p keys ps)
  Just "change" -> let k = key in force k [] (obj [], change k ps)
  Just "mark" -> let k = key; pl = places in force k (concatMap qPath pl) (spotsAnswer (mark k pl ps), ps)
  Just "event" -> let k = key in force k [] (spotsAnswer (mark k [Place [] Nothing False (Just 0)] ps), ps)
  Just "release" ->
    let k = key
     in force k [] $ case getField "path" req of
          Nothing -> (obj [], releaseChange k ps)
          Just j -> let p = needPath (Just j) in force k p (obj [], release k p keys ps)
  Just "marks" ->
    let pl = case getField "patch" req of
          Just pj -> patchPlaces pj
          Nothing -> failWith "no patch"
        paths = case getField "paths" req of
          Just (JArr xs) -> map (needPath . Just) xs
          _ -> failWith "no paths"
        answer = [any (\q -> reaches keys q p) pl | p <- paths]
     in length (show (map qPath pl)) `seq` length (show answer) `seq` (obj [("marks", JArr (map JBool answer))], ps)
  Just "kept" -> let (k, s, t) = kept ps in (obj [("keys", num k), ("spots", num s), ("steps", num t)], ps)
  Just o -> failWith ("unknown op " ++ o)
  Nothing -> failWith "no op"
  where
    keys = getField "keys" req == Just (JBool True)
    key = (side "source", side "id")
    side f = case getField f req of
      Just (JStr s) -> Left s
      Just (JObj [("symbol", JStr s)]) -> Right s
      _ -> failWith (f ++ ": neither string nor symbol")
    places = case getField "patches" req of
      Just (JArr xs) -> concatMap patchPlaces xs
      _ -> failWith "patches: not a list"
    force :: Key -> [PKey] -> r -> r
    force k p r = length (show k) `seq` length (show p) `seq` r
    num = JInt . fromIntegral
    spotsAnswer ss = obj [("spots", JArr (map spotJ ss))]

spotJ :: Spot -> J
spotJ Change = JStr "change"
spotJ (Plain p) = pathJ p
spotJ (Keys p) = obj [("keys", pathJ p)]

pathJ :: [PKey] -> J
pathJ = JArr . map k
  where
    k (PS s) = JStr s
    k (PN n) = JInt n

-- | a path: strings and whole numbers 0 <= n < 1e15 (-0 is 0); anything else an error
needPath :: Maybe J -> [PKey]
needPath (Just (JArr ks)) = let p = map k ks in length (show p) `seq` p
  where
    k (JStr s) = PS s
    k j | Just n <- jint j, n >= 0, n < 10 ^ (15 :: Int) = PN n
    k _ = failWith "bad path"
needPath _ = failWith "bad path"

-- | a patch's places: a move's take then its landing; else one
patchPlaces :: J -> [Place]
patchPlaces pj@(JObj _) =
  let path = needPath (field "path" pj)
      range = case field "range" pj of
        Just (JArr [ja, jb]) | Just a <- jint ja, Just b <- jint jb -> Just (a, b)
        _ -> Nothing
   in case field "move" pj of
        Just m ->
          let mpath = needPath (field "path" m)
              mrange = case field "range" m of
                Just (JArr [ja, jb]) | Just a <- jint ja, Just b <- jint jb -> Just (a, b)
                _ -> Nothing
              n = maybe 1 (\(a, b) -> b - a) mrange
           in [Place mpath mrange False (Just 0), Place path range True (Just n)]
        Nothing ->
          let n = case field "value" pj of
                Nothing -> Just 0
                Just (JArr xs) -> Just (fromIntegral (length xs))
                Just _ -> Nothing
           in length (show path) `seq` [Place path range (field "value" pj /= Nothing) n]
patchPlaces _ = failWith "a patch is not a map"
