{-# LANGUAGE ScopedTypeVariables #-}
-- The scheduler on the line protocol (the scheduler suite). The harness plays the host: it keeps
-- a value at each key; a compute's result is set at its key (to) and said changed by it.
--
-- Built from the suite's examples: computations are scopes; runs are tracked by the tracker; each
-- mark carries a cause chain (the computations whose changes led to it in this pulse); a run whose
-- own computation is in its chain is flagged, and a flagged run neither sets nor acts on a new
-- result, and its changes do not make due again what is in their chain (a loop, cut there).
module Main (main) where

import Control.Exception
import Control.Monad
import Data.IORef
import Data.List (elemIndex, nub, sortOn)
import qualified Data.Map.Strict as M
import Data.Maybe (fromMaybe, isJust, mapMaybe)
import qualified Data.Set as S
import Json
import Line (getField, getStr, obj, serveIO)
import qualified Tracker as T

-- values -----------------------------------------------------------------------------------

-- | a value as programs see it: JSON, lists and maps with an identity (Object.is), a promise,
-- or PENDING
data SV
  = SNull
  | SBool Bool
  | SNum Double
  | SStr String
  | SArr Int [SV]
  | SObj Int [(String, SV)]
  | SProm Int
  | SPend
  deriving (Show)

data Thrown = Err String | Pend | StopOn Int deriving (Show)

instance Exception Thrown

toJ :: SV -> J
toJ SNull = JNull
toJ (SBool b) = JBool b
toJ (SNum d)
  | isNaN d || isInfinite d = JNull
  | otherwise = JNum d
toJ (SStr s) = JStr s
toJ (SArr _ xs) = JArr (map toJ xs)
toJ (SObj _ kvs) = JObj [(k, toJ v) | (k, v) <- kvs]
toJ (SProm _) = JObj []
toJ SPend = JNull

-- | JSON.stringify's text: -0 as 0, the non-finite as null
jsonText :: SV -> String
jsonText v = render (strip (toJ v))
  where
    strip (JNum d) | d == 0 = JNum 0
    strip (JArr xs) = JArr (map strip xs)
    strip (JObj kvs) = JObj [(k, strip x) | (k, x) <- kvs]
    strip j = j

jsonEq :: SV -> SV -> Bool
jsonEq a b = jsonText a == jsonText b

objectIs :: SV -> SV -> Bool
objectIs (SNum a) (SNum b) = (isNaN a && isNaN b) || (a == b && isNegativeZero a == isNegativeZero b)
objectIs SNull SNull = True
objectIs (SBool a) (SBool b) = a == b
objectIs (SStr a) (SStr b) = a == b
objectIs (SArr i _) (SArr j _) = i == j
objectIs (SObj i _) (SObj j _) = i == j
objectIs (SProm i) (SProm j) = i == j
objectIs SPend SPend = True
objectIs _ _ = False

-- the world --------------------------------------------------------------------------------

data Phase = PRun | PAct deriving (Eq, Show)

-- a compute: its key (to), equal by JSON, its set expression; an effect: its act, early, equal
-- by JSON
data Kind
  = Compute (Maybe String) Bool (Maybe J)
  | Effect J Bool Bool

data Comp = Comp
  { cKind :: Kind
  , cF :: J
  , cMade :: Int
  , cRuns :: Int
  , cDue :: Maybe (Int, [Int]) -- the tick that made it due, the cause chain
  , cWaits :: Maybe Int
  , cPrev :: Maybe SV -- a compute's last given to set; an effect's last acted on
  , cLatest :: Maybe Int -- its latest run
  , cInfoRun :: Int
  , cMark :: Int
  , cVals :: [Int] -- the writers of the keys its last run read, as they were when it ended
  , cAfterW :: Maybe Int
  , cDone :: Int -- runs told their end
  , cFlag :: Bool
  , cAside :: [(Ctx, J)] -- its cleanups set aside before a run, oldest first
  }

data Child = CScope Int | CCleanup Ctx J

data Scope = Scope
  { sName :: Maybe String
  , sParent :: Maybe Int
  , sInfo :: [(String, SV)]
  , sOwner :: Maybe [(String, SV)] -- the owner's pairs as they were when it was made
  , sKids :: [(Phase, Child)] -- newest last
  , sGone :: Bool
  , sComp :: Maybe Comp
  }

data Run = Run
  { rComp :: Int
  , rNo :: Int
  , rChain :: [Int]
  , rPulse :: Maybe Int
  , rCut :: Maybe [Int]
  , rReads :: [String]
  , rEnded :: Bool -- told its end (a pending run is still open)
  , rFlag :: Bool -- its computation's latest mark, when it began, was on a loop through it
  }

data Named = NoOne | ByRun Int | ByComp Int

data Ctx = Ctx
  { xOpen :: Maybe Int
  , xShow :: Maybe Int -- current().writer: a computation
  , xOpenW :: Named -- what a write "open" names
  , xNamed :: Named -- what a plain write names
  , xTrack :: Maybe Int -- the run reads are tracked in
  , xValue :: Maybe SV
  , xPrev :: Maybe SV
  , xPhase :: Phase
  , xComp :: Maybe Int -- the computation of the run form
  }

outside :: Ctx
outside = Ctx Nothing Nothing NoOne NoOne Nothing Nothing Nothing PRun Nothing

data Promise = Promise {pRun :: Maybe Int, pCont :: Maybe (Ctx, J)}

data Outcome = OVal SV | OErr String | OPend

data W = W
  { wScopes :: M.Map Int Scope
  , wNames :: M.Map String Int
  , wRuns :: M.Map Int Run
  , wStore :: M.Map String SV
  , wWriter :: M.Map String Int
  , wTracker :: T.Tracker
  , wTick :: Int
  , wNext :: Int
  , wMoments :: [J] -- newest first
  , wCount :: Int
  , wLog :: [SV]
  , wForgot :: [String]
  , wStarted :: [String]
  , wPromises :: M.Map String Int
  , wPromise :: M.Map Int Promise
  , wSettled :: [(Int, Outcome)]
  , wPulse :: Maybe Int
  , wPulses :: Int
  , wEarlyQ :: [(Int, Int, SV)]
  , wActQ :: [(Int, Int, SV)]
  , wThrown :: Maybe String -- the first error a listener or a cleanup after a run threw, held
  , wArmed :: Maybe (String, Maybe String, String) -- a listener armed to throw, once
  }

type S = IORef W

fresh :: S -> IO Int
fresh s = do
  w <- readIORef s
  writeIORef s w {wNext = wNext w + 1}
  pure (wNext w)

-- | the first error held while what was going on finishes
hold :: S -> String -> IO ()
hold s m = modifyIORef' s (\w -> w {wThrown = maybe (Just m) Just (wThrown w)})

-- | a braced: what is held inside comes out after it is all done; what was held around it is
-- held again
braced :: S -> IO a -> IO a
braced s act = do
  outer <- wThrown <$> readIORef s
  modifyIORef' s (\w -> w {wThrown = Nothing})
  r <- try act
  t <- wThrown <$> readIORef s
  modifyIORef' s (\w -> w {wThrown = outer})
  case t of
    Just m -> throwIO (Err m)
    Nothing -> either (\e -> throwIO (e :: Thrown)) pure r

-- | the armed listener l, told of one of ats: it throws, once
fireL :: S -> String -> [String] -> IO (Maybe String)
fireL s on ats = do
  w <- readIORef s
  case wArmed w of
    Just (o, at, err) | o == on, maybe True (`elem` ats) at -> do
      writeIORef s w {wArmed = Nothing}
      pure (Just err)
    _ -> pure Nothing

holdL :: S -> String -> [String] -> IO ()
holdL s on ats = fireL s on ats >>= maybe (pure ()) (hold s)

fromJ :: S -> J -> IO SV
fromJ s j = case j of
  JNull -> pure SNull
  JBool b -> pure (SBool b)
  JNum d -> pure (SNum d)
  JStr x -> pure (SStr x)
  JArr xs -> SArr <$> fresh s <*> mapM (fromJ s) xs
  JObj kvs -> SObj <$> fresh s <*> mapM (\(k, v) -> (,) k <$> fromJ s v) kvs

-- | a moment told, counted for the pulse's endless guard
moment :: S -> J -> IO ()
moment s m = modifyIORef' s (\w -> w {wMoments = m : wMoments w, wCount = wCount w + 1})

scope :: S -> Int -> IO Scope
scope s i = (M.! i) . wScopes <$> readIORef s

putScope :: S -> Int -> Scope -> IO ()
putScope s i sc = modifyIORef' s (\w -> w {wScopes = M.insert i sc (wScopes w)})

comp :: S -> Int -> IO Comp
comp s i = fromMaybe (error "not a computation") . sComp <$> scope s i

modComp :: S -> Int -> (Comp -> Comp) -> IO ()
modComp s i f = modifyIORef' s (\w -> w {wScopes = M.adjust (\sc -> sc {sComp = f <$> sComp sc}) i (wScopes w)})

nameOf :: S -> Int -> IO String
nameOf s i = fromMaybe "" . sName <$> scope s i

live :: S -> Int -> IO Bool
live s i = maybe False (not . sGone) . M.lookup i . wScopes <$> readIORef s

isComp :: S -> Int -> IO Bool
isComp s i = maybe False (isJust . sComp) . M.lookup i . wScopes <$> readIORef s

isEffect :: Comp -> Bool
isEffect c = case cKind c of Effect {} -> True; _ -> False

-- | the scope of a name: no scope (never made) or the latest made under it
lookupScope :: S -> String -> IO Int
lookupScope s n = do
  w <- readIORef s
  maybe (throwIO (Err ("no scope " ++ n))) pure (M.lookup n (wNames w))

usable :: S -> String -> IO Int
usable s n = do
  i <- lookupScope s n
  g <- sGone <$> scope s i
  when g (throwIO (Err "disposed"))
  pure i

-- pairs ------------------------------------------------------------------------------------

pairsOf :: S -> Int -> IO [(String, SV)]
pairsOf s i = do
  sc <- scope s i
  let owner = maybe [] (\o -> [("owner", pairsSV o)]) (sOwner sc)
  case sComp sc of
    Nothing -> pure (sInfo sc ++ owner)
    Just c -> pure ([("run", SNum (fromIntegral (cInfoRun c))) | cInfoRun c > 0] ++ [("mark", SNum (fromIntegral (cMark c)))] ++ owner)

pairsSV :: [(String, SV)] -> SV
pairsSV ps = SArr 0 [SArr 0 [SStr k, v] | (k, v) <- ps]

-- marks ------------------------------------------------------------------------------------

compNode :: Int -> String
compNode i = 'c' : show i

keyNode :: String -> String
keyNode k = 'k' : k

readersOf :: W -> String -> [Int]
readersOf w k = nub [read (drop 1 n) | n <- T.readers (keyNode k) (wTracker w)]

-- | the writer named: (the computation told, the run its chain comes from)
resolveNamed :: S -> Named -> IO (Maybe Int, Maybe Int)
resolveNamed s n = do
  w <- readIORef s
  case n of
    NoOne -> pure (Nothing, Nothing)
    ByRun r -> pure (fmap rComp (M.lookup r (wRuns w)), Just r)
    ByComp c -> case M.lookup c (wScopes w) >>= sComp of
      Just cc | Just r <- cLatest cc -> pure (Just c, Just r)
      _ -> pure (Nothing, Nothing)

isDue :: Comp -> Bool
isDue c = isJust (cDue c)

-- | one mark of keys, said by a writer
mark :: S -> [String] -> Named -> IO ()
mark s keys named = markBy s keys named True

-- | register: the writer named becomes the keys' writer (not for a run's own writes in its body)
markBy :: S -> [String] -> Named -> Bool -> IO ()
markBy s keys named register = do
  modifyIORef' s (\w -> w {wTick = wTick w + 1})
  (wc, wr) <- resolveNamed s named
  w0 <- readIORef s
  let t = wTick w0
  -- a compute that ran becomes the key's writer
  case wc of
    Just c | Just cc <- M.lookup c (wScopes w0) >>= sComp, not (isEffect cc), register ->
      modifyIORef' s (\w -> w {wWriter = foldl (\m k -> M.insert k c m) (wWriter w) keys})
    _ -> pure ()
  (chain, cutter) <- case wr of
    Nothing -> pure ([], Nothing)
    Just r -> do
      let run = wRuns w0 M.! r
          c = rComp run
          latest = (M.lookup c (wScopes w0) >>= sComp) >>= cLatest
      if latest /= Just r
        then pure ([], Nothing)
        else do
          let chainR = if isJust (rPulse run) && rPulse run == wPulse w0 then rChain run else []
              flagged = rFlag run && not (rEnded run)
          pure (chainR ++ [c], if flagged then Just r else Nothing)
  writerName <- maybe (pure Nothing) (fmap Just . nameOf s) wc
  forM_ keys $ \k -> do
    w <- readIORef s
    forM_ (readersOf w k) $ \y -> do
      ok <- live s y
      when ok $ do
        yc <- comp s y
        case cDue yc of
          Just (dt, ch) -> modComp s y (\c -> c {cDue = Just (dt, ch ++ filter (`notElem` ch) chain), cFlag = y `elem` chain})
          Nothing -> case cutter of
            Just r | y `elem` chain -> do
              let members = drop (fromMaybe 0 (elemIndex y chain)) chain
              through <- byMade s members
              modifyIORef' s (\ww -> ww {wRuns = M.adjust (\rr -> rr {rCut = Just (fromMaybe through (rCut rr))}) r (wRuns ww)})
            _ -> do
              modComp s y (\c -> c {cDue = Just (t, chain), cFlag = y `elem` chain})
              n <- nameOf s y
              moment s (obj ([("due", JStr n), ("tick", JNum (fromIntegral t))] ++ maybe [] (\x -> [("writer", JStr x)]) writerName))
  failed <- fireL s "mark" keys
  maybe (pure ()) (throwIO . Err) failed

byMade :: S -> [Int] -> IO [Int]
byMade s xs = do
  ms <- mapM (\x -> (,) x . cMade <$> comp s x) (nub xs)
  pure (map fst (sortOn snd ms))

-- tracking ---------------------------------------------------------------------------------

trackRead :: S -> Int -> String -> IO (Maybe String)
trackRead s r k = do
  w <- readIORef s
  let run = wRuns w M.! r
      before = length (T.readers (keyNode k) (wTracker w))
      tr = T.track (compNode (rComp run)) (keyNode k) (wTracker w)
      after = length (T.readers (keyNode k) tr)
  writeIORef s w {wTracker = tr, wRuns = M.insert r run {rReads = rReads run ++ [k]} (wRuns w), wStarted = if before == 0 && after > 0 then wStarted w ++ [k] else wStarted w}
  if before == 0 && after > 0 then fireL s "started" [k] else pure Nothing

-- | keys no longer read after a change to the tracker are forgotten
retrack :: S -> Int -> (T.Tracker -> T.Tracker) -> IO ()
retrack s c f = do
  w <- readIORef s
  let keys = nub [drop 1 n | n <- T.reads (compNode c) (wTracker w)]
      tr = f (wTracker w)
      gone = [k | k <- keys, null (T.readers (keyNode k) tr)]
  writeIORef s w {wTracker = tr, wForgot = wForgot w ++ gone}
  forM_ gone $ \k -> holdL s "forgotten" [k]

-- ranks ------------------------------------------------------------------------------------

-- | what a run's end teaches: the keys it read, and the one it waits after (a stop)
learn :: S -> Int -> Int -> Maybe Int -> IO ()
learn s c r waits = do
  w <- readIORef s
  let run = wRuns w M.! r
  modComp s c (\cc -> cc {cVals = nub (mapMaybe (`M.lookup` wWriter w) (rReads run)), cAfterW = waits})

-- | what a computation is after: the writers of the keys its last run read (then), and the one it
-- waits after; the ones gone or itself left out
afterOf :: W -> Int -> [Int]
afterOf w c = case M.lookup c (wScopes w) >>= sComp of
  Nothing -> []
  Just cc ->
    nub
      [ x
      | x <- cVals cc ++ maybe [] pure (cAfterW cc)
      , x /= c
      , maybe False (not . sGone) (M.lookup x (wScopes w))
      ]

-- | every computation after c, through the ones not due too
reachAfter :: W -> Int -> S.Set Int
reachAfter w start = go S.empty (afterOf w start)
  where
    go seen [] = seen
    go seen (x : xs)
      | S.member x seen = go seen xs
      | otherwise = go (S.insert x seen) (afterOf w x ++ xs)

-- scopes -----------------------------------------------------------------------------------

addKid :: S -> Int -> Phase -> Child -> IO ()
addKid s p ph ch = do
  sc <- scope s p
  putScope s p sc {sKids = sKids sc ++ [(ph, ch)]}

phaseFor :: Ctx -> Int -> Phase
phaseFor ctx p = if xOpen ctx == Just p then xPhase ctx else PRun

-- | the nearest computation at or above a scope
nearestComp :: S -> Int -> IO (Maybe Int)
nearestComp s i = do
  sc <- scope s i
  case sComp sc of
    Just _ -> pure (Just i)
    Nothing -> maybe (pure Nothing) (nearestComp s) (sParent sc)

cleanupCtx :: S -> Int -> Ctx -> IO Ctx
cleanupCtx s i made = do
  nc <- nearestComp s i
  let named = maybe NoOne ByComp nc
  pure made {xOpen = Just i, xShow = nc, xOpenW = named, xNamed = named, xTrack = Nothing, xPhase = PRun, xComp = nc}

runCleanup :: S -> Int -> Ctx -> J -> IO (Maybe String)
runCleanup s i made e = do
  ctx <- cleanupCtx s i made
  r <- try (eval s ctx e)
  pure $ case r of
    Left (Err m) -> Just m
    Left Pend -> Just "pending"
    Left (StopOn _) -> Nothing
    Right _ -> Nothing

-- | dispose a scope: what is under it first, newest first, then its cleanups (those set aside
-- first, oldest), newest first; every one runs, and the first error is thrown after them all
-- (what a listener threw in it comes first)
dispose :: S -> Int -> IO ()
dispose s i = do
  sc <- scope s i
  unless (sGone sc) $ braced s $ do
    putScope s i sc {sGone = True}
    aside <- case sComp sc of
      Just c -> do
        modComp s i (\x -> x {cDue = Nothing, cWaits = Nothing, cAside = []})
        modifyIORef' s (\w -> w {wEarlyQ = filter (\(x, _, _) -> x /= i) (wEarlyQ w), wActQ = filter (\(x, _, _) -> x /= i) (wActQ w)})
        retrack s i (T.untrackAll (compNode i))
        modifyIORef' s (\w -> w {wWriter = M.filter (/= i) (wWriter w)})
        pure (cAside c)
      Nothing -> pure []
    errs <- dropKids s i aside (const True)
    forM_ (msum errs) (hold s)

-- | what is under i of these phases goes: scopes, newest first, then cleanups (aside, older,
-- first), newest first. the errors, in order
dropKids :: S -> Int -> [(Ctx, J)] -> (Phase -> Bool) -> IO [Maybe String]
dropKids s i aside which = do
  sc <- scope s i
  let mine = [k | (ph, k) <- sKids sc, which ph]
      kept = [(ph, k) | (ph, k) <- sKids sc, not (which ph)]
  putScope s i sc {sKids = kept}
  e1 <- forM (reverse [x | CScope x <- mine]) (\x -> either (\(e :: Thrown) -> Just (errText e)) (const Nothing) <$> try (dispose s x))
  e2 <- forM (reverse (aside ++ [(c, e) | CCleanup c e <- mine])) (\(c, e) -> runCleanup s i c e)
  pure (e1 ++ e2)

errText :: Thrown -> String
errText (Err m) = m
errText Pend = "pending"
errText (StopOn _) = "stopped"

-- | before a run: what is under c of these phases goes (what one threw held), its own cleanups
-- are set aside, to run once the run is done
shed :: S -> Int -> IO ()
shed s c = do
  cc <- comp s c
  sc <- scope s c
  let which = if isEffect cc then (== PRun) else const True
      mine = [(ctx, e) | (ph, CCleanup ctx e) <- sKids sc, which ph]
      kids = [(ph, k) | (ph, k@(CScope _)) <- sKids sc, which ph]
      rest = [(ph, k) | (ph, k) <- sKids sc, not (which ph)]
  putScope s c sc {sKids = rest}
  modComp s c (\x -> x {cAside = cAside x ++ mine})
  e1 <- forM (reverse [x | (_, CScope x) <- kids]) (\x -> either (\(e :: Thrown) -> Just (errText e)) (const Nothing) <$> try (dispose s x))
  forM_ (msum e1) (hold s)

-- | the cleanups set aside before r, once r is done, newest first: no catch, the first that
-- throws ends the rest, its error held
lay :: S -> Int -> Int -> IO ()
lay s c r = do
  cc <- comp s c
  g <- not <$> live s c
  unless (null (cAside cc) || g || cLatest cc /= Just r) $ do
    let fs = cAside cc
    modComp s c (\x -> x {cAside = []})
    let go [] = pure ()
        go ((ctx, e) : rest) = do
          m <- runCleanup s c ctx e
          case m of
            Just err -> hold s err
            Nothing -> go rest
    go (reverse fs)

-- | make a scope or computation's scope under parent
makeScope :: S -> Ctx -> Maybe String -> Int -> [(String, SV)] -> Maybe Comp -> IO Int
makeScope s ctx name parent info c = do
  ps <- pairsOf s parent
  i <- fresh s
  putScope s i (Scope name (Just parent) info (Just ps) [] False c)
  addKid s parent (phaseFor ctx parent) (CScope i)
  forM_ name $ \n -> modifyIORef' s (\w -> w {wNames = M.insert n i (wNames w)})
  pure i

checkName :: S -> String -> IO ()
checkName s n = do
  w <- readIORef s
  case M.lookup n (wNames w) of
    Just i | Just sc <- M.lookup i (wScopes w), not (sGone sc) -> throwIO (Err ("name taken: " ++ n))
    _ -> pure ()

infoOf :: S -> J -> IO [(String, SV)]
infoOf s j = case j of
  JArr ps -> forM ps $ \p -> case p of
    JArr [JStr k, v] -> (,) k <$> fromJ s v
    _ -> throwIO (Err "info: not pairs")
  _ -> pure []

infoSV :: SV -> IO [(String, SV)]
infoSV v = case v of
  SArr _ ps -> forM ps $ \p -> case p of
    SArr _ [SStr k, x] -> pure (k, x)
    _ -> throwIO (Err "info: not pairs")
  SNull -> pure []
  _ -> throwIO (Err "info: not pairs")

-- | a computation made: due at once, at its tick; an early effect runs and acts at once
makeComp :: S -> Ctx -> String -> Int -> Kind -> J -> Bool -> IO ()
makeComp s ctx name parent kind f declared = braced s $ do
  w0 <- readIORef s
  let made = wNext w0
  modifyIORef' s (\w -> w {wTick = wTick w + 1})
  t <- wTick <$> readIORef s
  let c = Comp kind f made 0 (Just (t, [])) Nothing Nothing Nothing 0 t [] Nothing 0 False []
  i <- makeScope s ctx (Just name) parent [] (Just c)
  creator <- maybe (pure Nothing) (fmap Just . nameOf s) (xShow ctx)
  moment s (obj ([("due", JStr name), ("tick", JNum (fromIntegral t))] ++ maybe [] (\x -> [("writer", JStr x)]) creator))
  case kind of
    Compute (Just k) _ _ | declared -> modifyIORef' s (\w -> w {wWriter = M.insert k i (wWriter w)})
    _ -> pure ()
  holdL s "mark" []
  case kind of
    Effect _ True _ -> do
      let held act' = do
            r <- try act'
            case r of
              Left (Err m) -> hold s m
              Left e -> throwIO e
              Right () -> pure ()
      held (runOnce s i)
      w <- readIORef s
      case [e | e@(x, _, _) <- wEarlyQ w, x == i] of
        (e : _) -> do
          modifyIORef' s (\ww -> ww {wEarlyQ = filter (\(x, _, _) -> x /= i) (wEarlyQ ww)})
          held (act s True e)
        [] -> pure ()
    _ -> pure ()

-- runs -------------------------------------------------------------------------------------

endMoment :: S -> Int -> Int -> String -> [(String, J)] -> IO ()
endMoment s c r how extra = do
  lay s c r
  when (how /= "pending") $ do
    modifyIORef' s (\w -> w {wRuns = M.adjust (\rr -> rr {rEnded = True}) r (wRuns w)})
    modComp s c (\x -> x {cDone = cDone x + 1})
  n <- nameOf s c
  w <- readIORef s
  let reads = maybe [] rReads (M.lookup r (wRuns w))
      no = maybe 0 rNo (M.lookup r (wRuns w))
  moment s (obj ([("ends", JStr n), ("run", JNum (fromIntegral no)), ("ended", JStr how)] ++ extra ++ [("reads", JArr (map JStr reads))]))
  holdL s "ends" [n]

throughOf :: S -> Int -> Int -> IO [Int]
throughOf s c r = do
  run <- (M.! r) . wRuns <$> readIORef s
  let full = rChain run ++ [c]
  byMade s (drop (fromMaybe 0 (elemIndex c full)) full)

namesJ :: S -> [Int] -> IO J
namesJ s xs = JArr . map JStr <$> mapM (nameOf s) xs

-- | one run of a due computation, a braced of its own: what a listener or a cleanup after it
-- threw comes out once it is done
runOnce :: S -> Int -> IO ()
runOnce s c = braced s $ do
  cc <- comp s c
  let (dueT, chain) = fromMaybe (cMark cc, []) (cDue cc)
  r <- fresh s
  w0 <- readIORef s
  let no = cRuns cc + 1
  modifyIORef' s (\w -> w {wRuns = M.insert r (Run c no chain (wPulse w0) Nothing [] False (cFlag cc)) (wRuns w)})
  modComp s c (\x -> x {cDue = Nothing, cWaits = Nothing, cRuns = no, cLatest = Just r})
  n <- nameOf s c
  moment s (obj [("starts", JStr n), ("run", JNum (fromIntegral no))])
  holdL s "starts" [n]
  -- what the last run made goes first, its cleanups set aside
  shed s c
  stillHere <- live s c
  when stillHere $ runBody s c r no dueT chain

runBody :: S -> Int -> Int -> Int -> Int -> [Int] -> IO ()
runBody s c r no dueT chain = do
  cc <- comp s c
  modComp s c (\x -> x {cInfoRun = no, cMark = dueT})
  modifyIORef' s (\w -> w {wTracker = T.begin (compNode c) (wTracker w)})
  let ctx = Ctx (Just c) (Just c) (ByRun r) (ByRun r) (Just r) Nothing (cPrev cc) PRun (Just c)
  out <- try (eval s ctx (cF cc))
  gone <- not <$> live s c
  if gone
    then modifyIORef' s (\w -> w {wTracker = T.end (compNode c) (wTracker w)})
    else do
      retrack s c (T.end (compNode c))
      case out of
        Left (StopOn wtr) -> do
          learn s c r (Just wtr)
          modComp s c (\x -> x {cDue = Just (dueT, chain), cWaits = Just wtr})
          wn <- nameOf s wtr
          endMoment s c r "stopped" [("waits", JStr wn)]
          dropQueued s c
        _ -> do
          learn s c r Nothing
          case out of
            Left Pend -> pending s c r
            Left (Err e) -> failed s c r e
            Right (SProm p) -> do
              modifyIORef' s (\w -> w {wPromise = M.adjust (\pr -> pr {pRun = Just r}) p (wPromise w)})
              pending s c r
            Right SPend -> pending s c r
            Right v -> finish s c r v

dropQueued :: S -> Int -> IO ()
dropQueued s c = modifyIORef' s (\w -> w {wEarlyQ = filter (\(x, _, _) -> x /= c) (wEarlyQ w), wActQ = filter (\(x, _, _) -> x /= c) (wActQ w)})

pending :: S -> Int -> Int -> IO ()
pending s c r = do
  run <- (M.! r) . wRuns <$> readIORef s
  case rCut run of
    Just th -> do
      tj <- namesJ s th
      endMoment s c r "looping" [("through", tj)]
    Nothing -> endMoment s c r "pending" []
  dropQueued s c

failed :: S -> Int -> Int -> String -> IO ()
failed s c r e = do
  run <- (M.! r) . wRuns <$> readIORef s
  case rCut run of
    Just th -> do
      tj <- namesJ s th
      endMoment s c r "looping" [("error", JStr e), ("through", tj)]
    Nothing -> endMoment s c r "failed" [("error", JStr e)]
  dropQueued s c

-- | a run ended with a result: equal stops there; a flagged run's new result is a loop; else set,
-- or queued to act
finish :: S -> Int -> Int -> SV -> IO ()
finish s c r v = do
  cc <- comp s c
  run <- (M.! r) . wRuns <$> readIORef s
  let json = case cKind cc of Compute _ j _ -> j; Effect _ _ j -> j
      eq a b = if json then jsonEq a b else objectIs a b
      equal = maybe False (`eq` v) (cPrev cc)
      flagged = rFlag run
  case rCut run of
    Just th -> do
      tj <- namesJ s th
      endMoment s c r "looping" [("equal", JBool equal), ("through", tj)]
      dropQueued s c
    Nothing
      | equal -> do
          endMoment s c r "done" [("equal", JBool True)]
          dropQueued s c
      | flagged -> do
          th <- throughOf s c r
          tj <- namesJ s th
          endMoment s c r "looping" [("equal", JBool False), ("through", tj)]
          dropQueued s c
      | otherwise -> case cKind cc of
          Compute to _ setE -> do
            let setting = do
                  forM_ to $ \k -> do
                    modifyIORef' s (\w -> w {wStore = M.insert k v (wStore w)})
                    markBy s [k] (ByRun r) True
                  forM_ setE $ \e ->
                    eval s (Ctx (Just c) (Just c) (ByComp c) (ByComp c) Nothing (Just v) (Just v) PRun (Just c)) e
            out <- try setting
            let res = case out of
                  Left (Err m) -> Just m
                  Left Pend -> Just "pending"
                  _ -> Nothing
            case res of
              Just m -> do
                modComp s c (\x -> x {cPrev = Nothing})
                endMoment s c r "failed" [("equal", JBool False), ("error", JStr m)]
              Nothing -> do
                modComp s c (\x -> x {cPrev = Just v})
                endMoment s c r "done" [("equal", JBool False)]
          Effect _ early _ -> do
            endMoment s c r "done" [("equal", JBool False)]
            dropQueued s c
            modifyIORef' s $ \w ->
              if early then w {wEarlyQ = wEarlyQ w ++ [(c, r, v)]} else w {wActQ = wActQ w ++ [(c, r, v)]}

-- | an effect acts on a run's value: what is under it goes, then it acts. a braced: what a
-- listener threw comes out after
act :: S -> Bool -> (Int, Int, SV) -> IO ()
act s early (c, r, v) = braced s $ do
  errs <- dropKids s c [] (const True)
  here <- live s c
  when here $ act' s early (c, r, v) (msum errs)

act' :: S -> Bool -> (Int, Int, SV) -> Maybe String -> IO ()
act' s early (c, r, v) cleaned = do
  cc <- comp s c
  let ctx = Ctx (Just c) (Just c) (ByComp c) (ByComp c) Nothing (Just v) (cPrev cc) PAct (Just c)
  case cKind cc of
    Effect a _ _ -> do
      out <- try (eval s ctx a)
      ok <- live s c
      when ok $ modComp s c (\x -> x {cPrev = Just v})
      n <- nameOf s c
      no <- maybe 0 rNo . M.lookup r . wRuns <$> readIORef s
      let thrown = case out of
            Left (Err m) -> Just m
            Left Pend -> Just "pending"
            _ -> Nothing
          err = [("error", JStr m) | Just m <- [maybe thrown Just cleaned]]
      moment s (obj ([("acts", JStr n), ("run", JNum (fromIntegral no))] ++ [("early", JBool True) | early] ++ err))
      holdL s "acts" [n]
    _ -> pure ()

-- | land a settled promise: only on its computation's latest run, not gone, not due again
land :: S -> (Int, Outcome) -> IO ()
land s (p, o) = braced s $ do
  w <- readIORef s
  case M.lookup p (wPromise w) >>= pRun of
    Nothing -> pure ()
    Just r -> do
      let run = wRuns w M.! r
          c = rComp run
      ok <- live s c
      when ok $ do
        cc <- comp s c
        when (cLatest cc == Just r && not (isDue cc)) $ case o of
          OVal v -> finish s c r v
          OErr e -> failed s c r e
          OPend -> pending s c r

-- pulses -----------------------------------------------------------------------------------

-- | does a wait after b: the one it waits after, that one's, and on
waitsOn :: W -> Int -> Int -> Bool
waitsOn w a b = go S.empty a
  where
    go seen x
      | S.member x seen = False
      | otherwise = case M.lookup x (wScopes w) >>= sComp >>= cAfterW of
          Just y -> y == b || go (S.insert x seen) y
          Nothing -> False

-- | no due computation is above i: what it is after, and what that is after, through the ones not
-- due, but for one on a cycle with it
noneAbove :: W -> Int -> Bool
noneAbove w i = not (any above (S.toList (reachAfter w i)))
  where
    above d = d /= i && maybe False isDue (M.lookup d (M.mapMaybe sComp (wScopes w))) && not (S.member i (reachAfter w d))

runnable :: W -> [(Int, Comp)]
runnable w =
  [ (i, c)
  | (i, sc) <- M.toList (wScopes w)
  , not (sGone sc)
  , Just c <- [sComp sc]
  , isDue c
  , case cWaits c of
      Nothing -> True
      Just y -> not (maybe False (\yc -> not (sGone (wScopes w M.! y)) && isDue yc) (M.lookup y (wScopes w) >>= sComp))
  ]

pulse :: S -> IO (Maybe String)
pulse s = do
  modifyIORef' s (\w -> w {wPulses = wPulses w + 1, wPulse = Just (wPulses w + 1), wCount = 0})
  r <- try (landing >> rounds)
  modifyIORef' s (\w -> w {wPulse = Nothing})
  pure $ case r of
    Left (Err m) -> Just m
    Left _ -> Nothing
    Right () -> Nothing
  where
    -- the settled land first, one at a time: one that threw leaves the rest for the next pulse
    landing = do
      settled <- wSettled <$> readIORef s
      case settled of
        [] -> pure ()
        (x : rest) -> do
          modifyIORef' s (\w -> w {wSettled = rest})
          land s x
          landing
    endless = do
      n <- wCount <$> readIORef s
      when (n > 10000) (throwIO (Err "endless"))
    rounds = do
      runAll
      acts
      w <- readIORef s
      unless (null (runnable w) && null (wEarlyQ w) && null (wActQ w)) rounds
    runAll = do
      endless
      w <- readIORef s
      case sortOn (\(_, c) -> (maybe 0 fst (cDue c), cMade c)) (filter (noneAbove w . fst) (runnable w)) of
        [] -> pure ()
        ((i, _) : _) -> runOnce s i >> runAll
    acts = do
      w <- readIORef s
      let early = wEarlyQ w
          rest = wActQ w
      modifyIORef' s (\ww -> ww {wEarlyQ = [], wActQ = []})
      early' <- ownersFirst early
      rest' <- ownersFirst rest
      let go [] = pure ()
          go ((e, q@(c, r, _)) : more) = do
            endless
            res <- try $ do
              ok <- live s c
              when ok $ do
                cc <- comp s c
                when (not (isDue cc) && cLatest cc == Just r) (act s e q)
            case res of
              Right () -> go more
              Left (ex :: Thrown) -> do
                -- what is not taken yet waits in its queue for the next pulse
                modifyIORef' s (\ww -> ww {wEarlyQ = [y | (True, y) <- more] ++ wEarlyQ ww, wActQ = [y | (False, y) <- more] ++ wActQ ww})
                throwIO ex
      go (map ((,) True) early' ++ map ((,) False) rest')
    -- an owner's act before what it made
    ownersFirst q = do
      owners <- forM q $ \(c, _, _) -> ancestors c
      let inQ = [c | (c, _, _) <- q]
          deps = zip q owners
          go [] done = pure (reverse done)
          go pend done = case [x | x@((c, _, _), os) <- pend, all (\o -> o `notElem` inQ || o `elem` [d | (d, _, _) <- done] || o == c) os] of
            (x@(e, _) : _) -> go (filter (\(e', _) -> fst3 e' /= fst3 (fst x)) pend) (e : done)
            [] -> pure (reverse done ++ map fst pend)
      go deps []
    fst3 (a, _, _) = a
    ancestors c = do
      sc <- scope s c
      case sParent sc of
        Nothing -> pure []
        Just p -> (p :) <$> ancestors p

-- expressions ------------------------------------------------------------------------------

num :: SV -> IO Double
num SNull = pure 0
num (SNum d) = pure d
num _ = throwIO (Err "not a number")

eval :: S -> Ctx -> J -> IO SV
eval s ctx j = case j of
  JNull -> pure SNull
  JBool b -> pure (SBool b)
  JNum d -> pure (SNum d)
  JStr x -> pure (SStr x)
  JArr xs -> do
    vs <- mapM (eval s ctx) xs
    i <- fresh s
    pure (SArr i vs)
  JObj [] -> throwIO (Err "unknown form undefined")
  JObj ((form, arg) : _) -> evalForm s ctx form arg

args :: J -> [J]
args (JArr xs) = xs
args j = [j]

evalForm :: S -> Ctx -> String -> J -> IO SV
evalForm s ctx form arg = case form of
  "read" -> do
    k <- eval s ctx arg >>= keyOf
    w <- readIORef s
    let v = fromMaybe SNull (M.lookup k (wStore w))
    case xTrack ctx of
      Nothing -> pure v
      Just r -> do
        failedStart <- trackRead s r k
        let me = rComp (wRuns w M.! r)
        case M.lookup k (wWriter w) of
          Just wr | wr /= me -> do
            okW <- live s wr
            when okW $ do
              wc <- comp s wr
              w' <- readIORef s
              when (isDue wc && not (waitsOn w' wr me) && me `notElem` maybe [] snd (cDue wc)) (throwIO (StopOn wr))
          _ -> pure ()
        maybe (pure ()) (throwIO . Err) failedStart
        pure v
  "sum" -> do
    vs <- mapM (eval s ctx) (args arg)
    ns <- mapM num vs
    pure (SNum (sum ns))
  "mod" -> case args arg of
    [a, b] -> do
      x <- eval s ctx a >>= num
      y <- eval s ctx b >>= num
      when (y == 0) (throwIO (Err "mod by 0"))
      pure (SNum (x - y * fromInteger (truncate (x / y))))
    _ -> throwIO (Err "mod: two")
  "eq" -> case args arg of
    [a, b] -> do
      x <- eval s ctx a
      y <- eval s ctx b
      pure (SBool (jsonEq x y))
    _ -> throwIO (Err "eq: two")
  "if" -> case args arg of
    [t, a, b] -> do
      v <- eval s ctx t
      case v of
        SBool True -> eval s ctx a
        _ -> eval s ctx b
    _ -> throwIO (Err "if: three")
  "given" -> case arg of
    JStr "value" -> pure (fromMaybe SNull (xValue ctx))
    JStr "previous" -> pure (fromMaybe SNull (xPrev ctx))
    _ -> throwIO (Err "given: value or previous")
  "log" -> do
    v <- eval s ctx arg
    modifyIORef' s (\w -> w {wLog = wLog w ++ [v]})
    pure v
  "do" -> foldM (\_ e -> eval s ctx e) SNull (args arg)
  "write" -> case args arg of
    (kj : ej : rest) -> do
      k <- eval s ctx kj >>= keyOf
      named <- case rest of
        [] -> pure (xNamed ctx)
        (JNull : _) -> pure NoOne
        (JStr "open" : _) -> pure (xOpenW ctx)
        (JStr c : _) -> do
          i <- lookupScope s c
          isC <- isComp s i
          pure (if isC then ByComp i else NoOne)
        _ -> throwIO (Err "write: by")
      v <- eval s ctx ej
      modifyIORef' s (\w -> w {wStore = M.insert k v (wStore w)})
      markBy s [k] named True
      pure v
    _ -> throwIO (Err "write: key and value")
  "throw" -> do
    v <- eval s ctx arg
    case v of
      SPend -> throwIO Pend
      SStr m -> throwIO (Err m)
      other -> throwIO (Err (render (toJ other)))
  "pending" -> pure SPend
  "wait" -> case args arg of
    (pj : rest) -> do
      p <- eval s ctx pj >>= keyOf
      i <- fresh s
      let cont = case rest of
            (e : _) -> Just (ctx {xOpen = Nothing, xShow = Nothing, xOpenW = NoOne, xTrack = Nothing}, e)
            [] -> Nothing
          owner = xTrack ctx
      modifyIORef' s (\w -> w {wPromises = M.insert p i (wPromises w), wPromise = M.insert i (Promise owner cont) (wPromise w)})
      pure (SProm i)
    _ -> throwIO (Err "wait: a promise")
  "run" -> eval s ctx {xTrack = Nothing} arg
  "in" -> case args arg of
    [sj, e] -> do
      n <- eval s ctx sj >>= keyOf
      i <- usable s n
      eval s ctx {xOpen = Just i, xTrack = Nothing, xPhase = PRun} e
    _ -> throwIO (Err "in: scope and expression")
  "scope" -> case args arg of
    (nj : ij : rest) -> do
      n <- eval s ctx nj >>= keyOf
      info <- eval s ctx ij >>= infoSV
      checkName s n
      parent <- case rest of
        (pj : _) -> eval s ctx pj >>= keyOf >>= usable s
        [] -> openScope
      when (null info) (throwIO (Err "empty"))
      _ <- makeScope s ctx (Just n) parent info Nothing
      pure SNull
    _ -> throwIO (Err "scope: name and info")
  "within" -> case args arg of
    [ij, e] -> do
      info <- eval s ctx ij >>= infoSV
      parent <- openScope
      when (null info) (throwIO (Err "empty"))
      i <- makeScope s ctx Nothing parent info Nothing
      eval s ctx {xOpen = Just i, xTrack = Nothing, xPhase = PRun} e
    _ -> throwIO (Err "within: info and expression")
  "current" -> current s ctx
  "cleanup" -> case args arg of
    [sj, e] -> do
      target <- case sj of
        JNull -> do
          o <- openScope
          pure (Left o)
        _ -> Right <$> (eval s ctx sj >>= keyOf >>= lookupScope s)
      case target of
        Left o -> do
          g <- sGone <$> scope s o
          if g
            then do
              r <- runCleanup s o ctx e
              maybe (pure ()) (throwIO . Err) r
            else addKid s o (phaseFor ctx o) (CCleanup ctx e)
        Right i -> do
          g <- sGone <$> scope s i
          if g
            then do
              r <- runCleanup s i ctx e
              maybe (pure ()) (throwIO . Err) r
            else addKid s i (phaseFor ctx i) (CCleanup ctx e)
      pure SNull
    _ -> throwIO (Err "cleanup: scope and expression")
  "effect" -> case args arg of
    (cj : fj : aj : rest) -> do
      n <- eval s ctx cj >>= keyOf
      parent <- openScope
      checkName s n
      early <- case rest of
        (ej : _) -> do
          v <- eval s ctx ej
          pure (case v of SBool True -> True; _ -> False)
        [] -> pure False
      makeComp s ctx n parent (Effect aj early False) fj False
      pure SNull
    _ -> throwIO (Err "effect: name, f, act")
  "dispose" -> do
    n <- eval s ctx arg >>= keyOf
    i <- lookupScope s n
    dispose s i
    pure SNull
  "quote" -> fromJ s arg
  other -> throwIO (Err ("unknown form " ++ other))
  where
    openScope = case xOpen ctx of
      Nothing -> throwIO (Err "unscoped")
      Just o -> do
        g <- sGone <$> scope s o
        if g && form /= "cleanup" then throwIO (Err "disposed") else pure o

keyOf :: SV -> IO String
keyOf (SStr k) = pure k
keyOf _ = throwIO (Err "not a string")

current :: S -> Ctx -> IO SV
current s ctx = case xOpen ctx of
  Nothing -> pure SNull
  Just i -> do
    sc <- scope s i
    ps <- pairsOf s i
    wn <- maybe (pure Nothing) (fmap Just . nameOf s) (xShow ctx)
    i1 <- fresh s
    pv <- fromJ s (toJ (pairsSV ps))
    pure (SObj i1 ([("scope", maybe SNull SStr (sName sc)), ("pairs", pv)] ++ maybe [] (\x -> [("writer", SStr x)]) wn))

-- requests ---------------------------------------------------------------------------------

main :: IO ()
main = do
  s <- newIORef (W M.empty M.empty M.empty M.empty M.empty T.empty 0 1 [] 0 [] [] [] M.empty M.empty [] Nothing 0 [] [] Nothing Nothing)
  serveIO () (\_ j -> (\a -> (a, ())) <$> answer s j)

answer :: S -> J -> IO J
answer s req = do
  r <- try (request s req)
  pure $ case r of
    Right a -> a
    Left (Err m) -> obj [("error", JStr m)]
    Left Pend -> obj [("error", JStr "pending")]
    Left (StopOn _) -> obj [("error", JStr "stopped")]

need :: J -> String -> IO String
need req k = maybe (throwIO (Err ("no " ++ k))) pure (getStr k req)

request :: S -> J -> IO J
request s req = case getStr "op" req of
  Just "root" -> do
    n <- need req "name"
    checkName s n
    info <- infoOf s (fromMaybe JNull (getField "info" req))
    when (null info) (throwIO (Err "empty"))
    i <- fresh s
    putScope s i (Scope (Just n) Nothing info Nothing [] False Nothing)
    modifyIORef' s (\w -> w {wNames = M.insert n i (wNames w)})
    pure (obj [])
  Just "scope" -> do
    n <- need req "name"
    checkName s n
    parent <- case getStr "parent" req of
      Just p -> usable s p
      Nothing -> throwIO (Err "unscoped")
    info <- infoOf s (fromMaybe JNull (getField "info" req))
    when (null info) (throwIO (Err "empty"))
    _ <- makeScope s outside (Just n) parent info Nothing
    pure (obj [])
  Just "compute" -> do
    n <- need req "name"
    sc <- need req "scope" >>= usable s
    checkName s n
    let to = getStr "to" req
        json = getStr "equal" req == Just "json"
        declared = getField "declared" req == Just (JBool True)
    makeComp s outside n sc (Compute to json (getField "set" req)) (fromMaybe JNull (getField "f" req)) declared
    pure (obj [])
  Just "effect" -> do
    n <- need req "name"
    sc <- need req "scope" >>= usable s
    checkName s n
    let json = getStr "equal" req == Just "json"
        early = getField "early" req == Just (JBool True)
    makeComp s outside n sc (Effect (fromMaybe JNull (getField "act" req)) early json) (fromMaybe JNull (getField "f" req)) False
    pure (obj [])
  Just "cleanup" -> do
    i <- need req "scope" >>= usable s
    addKid s i PRun (CCleanup outside (fromMaybe JNull (getField "do" req)))
    pure (obj [])
  Just "dispose" -> do
    i <- need req "scope" >>= lookupScope s
    dispose s i
    pure (obj [])
  Just "run" -> do
    i <- need req "scope" >>= usable s
    isC <- isComp s i
    let named = if isC then ByComp i else NoOne
        ctx = outside {xOpen = Just i, xNamed = named, xComp = if isC then Just i else Nothing}
    v <- eval s ctx (fromMaybe JNull (getField "do" req))
    pure $ case v of
      SPend -> obj []
      SProm _ -> obj []
      _ -> obj [("value", toJ v)]
  Just "write" -> case getField "values" req of
    Just (JObj kvs) -> do
      forM_ kvs $ \(k, v) -> do
        sv <- fromJ s v
        modifyIORef' s (\w -> w {wStore = M.insert k sv (wStore w)})
      mark s (map fst kvs) NoOne
      t <- wTick <$> readIORef s
      pure (obj [("tick", JNum (fromIntegral t))])
    _ -> throwIO (Err "values: not a map")
  Just "changed" -> case getField "keys" req of
    Just (JArr ks) -> do
      keys <- forM ks $ \k -> case k of
        JStr x -> pure x
        _ -> throwIO (Err "a key is not a string")
      mark s keys NoOne
      t <- wTick <$> readIORef s
      pure (obj [("tick", JNum (fromIntegral t))])
    _ -> throwIO (Err "keys: not a list")
  Just "listener" -> do
    l <- need req "on"
    unless (l `elem` ["mark", "starts", "ends", "acts", "forgotten", "started"]) (throwIO (Err ("unknown listener " ++ l)))
    e <- need req "throw"
    modifyIORef' s (\w -> w {wArmed = Just (l, getStr "at" req, e)})
    pure (obj [])
  Just "pulse" -> do
    r <- pulse s
    pure (maybe (obj []) (\m -> obj [("error", JStr m)]) r)
  Just "resolve" -> settle (\v -> OVal v)
  Just "reject" -> settle (const (OErr (fromMaybe "" (getStr "error" req))))
  Just "get" -> do
    k <- need req "key"
    w <- readIORef s
    pure (obj [("value", toJ (fromMaybe SNull (M.lookup k (wStore w))))])
  Just "log" -> do
    w <- readIORef s
    writeIORef s w {wLog = []}
    pure (obj [("log", JArr (map toJ (wLog w)))])
  Just "moments" -> do
    w <- readIORef s
    writeIORef s w {wMoments = []}
    let reads = getField "reads" req == Just (JBool True)
        strip (JObj kvs) = JObj [(k, v) | (k, v) <- kvs, reads || k /= "reads"]
        strip m = m
    pure (obj [("moments", JArr (map strip (reverse (wMoments w))))])
  Just "forgotten" -> do
    w <- readIORef s
    writeIORef s w {wForgot = []}
    pure (obj [("keys", JArr (map JStr (wForgot w)))])
  Just "started" -> do
    w <- readIORef s
    writeIORef s w {wStarted = []}
    pure (obj [("keys", JArr (map JStr (wStarted w)))])
  Just "tick" -> do
    t <- wTick <$> readIORef s
    pure (obj [("tick", JNum (fromIntegral t))])
  Just "current" -> do
    v <- current s outside
    pure (obj [("value", toJ v)])
  Just o -> throwIO (Err ("unknown op " ++ o))
  Nothing -> throwIO (Err "unknown op undefined")
  where
    settle mk = do
      p <- need req "promise"
      w <- readIORef s
      case M.lookup p (wPromises w) of
        Nothing -> throwIO (Err ("no promise " ++ p))
        Just i -> do
          modifyIORef' s (\ww -> ww {wPromises = M.delete p (wPromises ww)})
          v <- fromJ s (fromMaybe JNull (getField "value" req))
          let base = mk v
              pr = wPromise w M.! i
          out <- case (base, pCont pr) of
            (OVal _, Just (ctx, e)) -> do
              r <- try (eval s ctx e)
              pure $ case r of
                Right SPend -> OPend
                Right y -> OVal y
                Left Pend -> OPend
                Left (Err m) -> OErr m
                Left (StopOn _) -> OPend
            (OVal SPend, Nothing) -> pure OPend
            (o, _) -> pure o
          modifyIORef' s (\ww -> ww {wSettled = wSettled ww ++ [(i, out)]})
          pure (obj [])
