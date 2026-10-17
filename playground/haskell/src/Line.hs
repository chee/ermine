-- | The line protocol: one JSON request per line in, one answer per line out, in order. A line
-- that is not JSON, or an answer that fails, is answered { error: "text" } and the loop goes on.
module Line (serve, serveIO, failWith, Failure (..), getStr, getField, obj) where

import Control.Exception
import qualified Data.ByteString.Char8 as B
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import System.IO
import Json

newtype Failure = Failure String deriving (Show)

instance Exception Failure

failWith :: String -> a
failWith = throw . Failure

getField :: String -> J -> Maybe J
getField = field

getStr :: String -> J -> Maybe String
getStr k j = case field k j of Just (JStr s) -> Just s; _ -> Nothing

obj :: [(String, J)] -> J
obj = JObj

-- | serve a pure-per-line adapter with state s
serve :: s -> (s -> J -> (J, s)) -> IO ()
serve s0 f = serveIO s0 (\s j -> pure (f s j))

serveIO :: s -> (s -> J -> IO (J, s)) -> IO ()
serveIO s0 f = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  hSetBuffering stdout (BlockBuffering Nothing)
  let loop s = do
        eof <- isEOF
        if eof
          then hFlush stdout
          else do
            l <- B.hGetLine stdin
            let text = T.unpack (TE.decodeUtf8Lenient l)
            if all (`elem` " \t\r") text
              then loop s
              else do
                (out, s') <- case parseJson text of
                  Left e -> pure (errorLine e, s)
                  Right j -> do
                    r <- try (f s j >>= \(a, s') -> let t = render a in evaluate (length t) >> pure (t, s'))
                    case r of
                      Right (t, s') -> pure (t, s')
                      Left e -> pure (errorLine (shown e), s)
                B.hPut stdout (TE.encodeUtf8 (T.pack out))
                B.hPut stdout (B.pack "\n")
                hFlush stdout
                loop s'
  loop s0
  where
    shown :: SomeException -> String
    shown e = case fromException e of
      Just (Failure m) -> m
      Nothing -> takeWhile (/= '\n') (displayException e)
    errorLine m = render (JObj [("error", JStr m)])
