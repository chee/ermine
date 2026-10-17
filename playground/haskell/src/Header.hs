-- | A change header (node's): time, actor, reader, external, metadata, op, then any other field,
-- answered in that order whatever order it came in. Plain JSON, never the value form.
module Header (change, nowSeconds) where

import Data.List (sortOn)
import Data.Time.Clock.POSIX (getPOSIXTime)
import Json

order :: [String]
order = ["time", "actor", "reader", "external", "metadata", "op"]

-- | the header's own fields in the change's order (no others); a site's as file, line, column,
-- function; a time of -0 is 0; a metadata entry not a [string, value] pair is refused
change :: [(String, J)] -> J
change kvs = JObj (map (site . zero) (sortOn (rank . fst) (filter ((`elem` order) . fst) kvs)))
  where
    zero ("time", JNum t) | t == 0 = ("time", JNum 0)
    zero ("metadata", JArr es) | not (all pair es) = error "metadata: an entry is not a [string, value] pair"
    zero kv = kv
    pair (JArr [JStr _, _]) = True
    pair _ = False
    rank k = maybe (length order) id (lookup k (zip order [0 ..]))
    site ("external", JArr ss) = ("external", JArr (map siteOrder ss))
    site kv = kv
    siteOrder (JObj f) = JObj (sortOn (siteRank . fst) f)
    siteOrder j = j
    siteRank k = maybe (4 :: Int) id (lookup k (zip ["file", "line", "column", "function"] [0 ..]))

nowSeconds :: IO Double
nowSeconds = fromIntegral . (floor :: Double -> Integer) . realToFrac <$> getPOSIXTime
