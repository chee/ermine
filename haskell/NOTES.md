# ermine core in Haskell

The spec is `../CORE.tex` (design) and `../PROTOCOL.tex` (harness contract).
Never edit CORE.tex or PROTOCOL.tex. If a scenario contradicts the spec, the
spec wins: report it rather than bending the code to it.

## Build and run

```sh
. ~/.ghc-wasm/env
cd haskell && wasm32-wasi-ghc -O1 -Wall -outputdir build -o ermine.wasm Main.hs
echo '{"seq":1,"cmd":"reset","stack":"graph"}' | wasmtime run ermine.wasm
cd ../conformance && ERMINE_HARNESS="$HOME/.ghc-wasm/wasmtime/bin/wasmtime run $PWD/../haskell/ermine.wasm" deno task test
```

Use the full wasmtime path in `ERMINE_HARNESS`, because deno's child process
does not see the PATH that `~/.ghc-wasm/env` sets. `ERMINE_PARALLEL` (default 4)
and `ERMINE_TIMEOUT` (ms per scenario, default 10000) are optional.

Unit checks (from `haskell/`):

```sh
wasm32-wasi-ghc -O1 -Wall -i. -outputdir build/tests -o build/JsonTest.wasm tests/JsonTest.hs && wasmtime run build/JsonTest.wasm
wasm32-wasi-ghc -O1 -Wall -i. -outputdir build/tests -o build/TypesTest.wasm tests/TypesTest.hs && wasmtime run build/TypesTest.wasm
```

You may only use boot libraries: base, containers, text, bytestring, mtl and transformers.

## Status (2026-10-05, revised spec)

Updated to the revised CORE.tex and PROTOCOL.tex: fixed `data` replaces the
make `path`, a `data` command, placement marks only slot and directory
readers, the driver's walk and value comparison read beneath protect, errors
are `{"kind", "op"?, "why"}` (a throw's message is its why), and a refused
program read is `{"node", "refused": true, "slot"}`. Builds with `-Wall`, no
warnings. Conformance suite: 166 passed, 0 failed (24 graph, 8 protect, 43
drive scenarios, plus the well-formedness, lines, encoding and runner tests).
Unit checks `tests/JsonTest.hs` and `tests/TypesTest.hs` pass;
`scratch/GraphTest.hs` exercises recording and marking directly.

## Who owns what

| file | owner | what |
|---|---|---|
| Json.hs | done | `Value`, parser, printer that matches JS, `Eq` = `$eq` |
| Types.hs | done | ids, paths, patches, changes, records, encodings, `Interface`, `Api`, `Recording`, loader types, `Driver` |
| Graph.hs | Graph agent | `graph :: IO Interface`, `applyPatches` |
| Protect.hs | Protect+Main agent | `Rule`, `May`, `rulesFrom`, `mayFromRules`, `protect` |
| Main.hs | Protect+Main agent | line loop (done), `reset`, `respond`, answers, events |
| Drive.hs | Drive+Program agent | `drive :: Interface -> Interface -> Id -> Loader -> IO Driver` (protect, the bare graph beneath it, root, loader) |
| Program.hs | Drive+Program agent | `load :: Loader` |

Do not change a type or signature in Types.hs or Json.hs on your own: the
other agents are coding against them. You may add helpers in your own
module, and you may export more from it.

## The interface

```haskell
data Interface = Interface
  { iOp          :: Ctx -> Stamp -> Op -> IO (Either Err Result)   -- make read directory lookup write place unplace
  , iSubscribe   :: Ctx -> Value -> (Event -> IO ()) -> IO (Either Err Int)
  , iUnsubscribe :: Ctx -> Int -> IO (Either Err ())
  , iRecord      :: Api -> RecordStart -> IO Recording
  , iFinish      :: Recording -> Ending -> IO Record
  , iSetTop      :: Interface -> IO () }

data Ctx   = Ctx { ctxAgent :: Value, ctxProcess :: Maybe Id, ctxPath :: Path, ctxMode :: Mode, ctxRun :: Maybe RunTag }
data Mode  = ReadWrite | ReadOnly | WriteOnly
data Stamp = Stamp { stampCause, stampSite :: Maybe Value, stampTime :: Maybe Time }
data Op    = OpMake id value data? | OpRead node | OpData node | OpDirectory node name? | OpLookup name
           | OpWrite node patches | OpPlace parent name id position? | OpUnplace parent name id   -- all raw Values
data Result = ResultApplied Applied | ResultSeen Seen | ResultData (Maybe Value) | ResultDir DirSeen | ResultFound Found
data Api   = Api { apiInterface :: Interface, apiCtx :: Ctx }   -- bind = Api
```

- **One `iOp` for every operation.** A wrapper overrides the one function
  `iOp`, sees `opName op` ("make", "read", ...) and `opNode op` (the new id
  for a make, the parent for a placement, nothing for a lookup), and passes
  the rest on unchanged. The typed helpers `apiRead`, `apiWrite` and the
  others wrap `apiOp`.
- **Arguments are raw JSON.** The graph decodes them with `asText`,
  `pathFrom`, `patchesFrom` and `asWhole`, and answers `invalid` for a bad
  one. That way an id from a program that is not a string fails in the graph,
  and the error passes back up through every layer and the run's recording.
  Main can still reject a malformed request itself.
- **Wrappers stack** by record update: `pure inner { iOp = ..., iSetTop = \t -> keep t >> iSetTop inner t }`.
  Every layer passes `iSetTop` on to the layer below it.
- **The top of the stack.** After building, Main calls `iSetTop top top`
  once. The graph's lookup reads each directory through `iOp top` with the
  lookup's own ctx, so protect can refuse it and the graph remembers it.
  The driver binds each run's interfaces, its value writes and its lasting
  interfaces from the top.
- **Errors.** `Err Invalid why` comes from the graph, which rejected the
  operation. `Err Refused why` comes from a wrapper that said no. An
  operation that fails changes nothing.

## Conventions every agent shares

1. **Times.** Under graph and protect, Main passes the request's `"time"`
   as `stampTime`. The graph rejects a missing time, or one that is not
   greater than every time already in the graph, as `invalid`. Under drive,
   requests carry no time. The driver sets `stampTime = Just (last+1)` on
   every change operation that passes through it. A change operation that
   fails uses up no time.
2. **Sites and causes** are stored as given (`Maybe Value`). Changes made by
   processes carry no site.
3. **The graph remembers reads** only for a ctx where `ctxMode == ReadOnly`
   and `ctxRun` is the current tag of `ctxProcess`. Only recordings set
   `ctxRun`. Requests from outside therefore never leave reads behind, and
   below drive, `marked` is always `[]`. When `iRecord` is given a ReadOnly
   api, it replaces that process's remembered reads with an empty set under
   a new tag.
4. **What marks what.** A read of a node's value is marked by its making
   and by writes to it (an empty patch list included), not by placements.
   A read of one slot is marked by a place or unplace of that name in that
   node, and by the node's making. A read of the whole directory is marked
   by any place or unplace in it, and by the node's making. The process that
   made a change is never marked by it. `appliedMarked` lists ids in code
   point order (`Ord Text` gives that order).
5. **Recording** (see the comment on `Recording` in Types.hs).
   - `recordingApi` and anything passed through `recordingWith` are logged:
     reads, directories, lookups, refs of changes, and every `Left` as
     `ErrEntry kind (opName op) why`.
   - `recordingQuiet` is remembered for marking but not logged. The driver
     uses it to read the program slots and program nodes, and reports those
     in `recordCompute` and `recordEffect`.
   - The driver sets the compute, effect, value, cleanup and ending fields
     with `recordingModify`.
   - `iFinish` sets the ending, sends `EventRecord` to the subscribers of
     the process node, and stops the recording. After that, its apis answer
     `invalid`.
   - Program reads therefore never show up in `reads`.
6. **Modes.**
   - Outside requests and driver housekeeping are `ReadWrite`.
   - A compute is `ReadOnly`, so a change operation in it is `invalid`.
   - Effects, the driver's value write, cleanups and handlers (the lasting
     interface) are `WriteOnly`, so a read, directory or lookup in them is
     `invalid`.
   - The graph enforces modes, so these errors land in the record.
7. **Driver housekeeping** uses `hostCtx` (agent null, no process) on the
   bare graph, which Main hands the driver as well as protect: the tree walk
   and reading a process's value to compare read beneath protect. The driver
   learns which nodes are process nodes from the make changes that pass
   through it: fixed data that is an object with a `"path"`. data.path
   decoded by `pathFrom` is the process's path; one that does not decode
   fails each run with `{"kind": "invalid", "op": "path"}`.
8. **Drive's extras.** Main calls `driverTake` after every request under
   drive, to get `Ran { ranRuns, ranStopped }` for the answer's `"runs"`
   and `"stopped"`. Both lists are always present under drive. `batch` is
   `driverBatch (mapM_ ... requests)`; Main collects the inner answers in an
   IORef. `fire` is `driverFire ctx process handler input`.
9. **Programs.**
   - `Loader = Value -> Either Text Program`.
   - `Program` gives a compute (`ComputeIn -> IO ComputeOut`) and an
     effect (`EffectIn -> IO EffectOut`).
   - `ComputeOut` is `Returned v | WentPending | Threw t`.
   - An effect returns the handlers registered during it, in order, and its
     last cleanup.
   - `Handler` takes the lasting api, self and input.
   - A caught error, and a fire's `"error"`, is `thrownValue`. For an
     operation it is `{"kind":"invalid"|"refused","op","why"}`; for a throw
     step or an operator error (an unknown operator included) it is
     `{"kind":"thrown","why"}`, a throw step's message as its why.
10. **Events.** `iSubscribe` numbers subscriptions from 1 in each graph. Main
    queues each subscription's events (in an IORef map) for `events`.
11. **Encodings** live in Types.hs: `changeToJson`, `changeRefToJson`,
    `recordToJson`, `pathToJson`, `patchToJson` and `errToJson`. A field that
    is not there is left out. In `reads` and `directories`, an absent node's
    `saw` is `null`. A refused `searched` entry is `{"node", "refused": true}`
    with no `saw`.

## Points the spec leaves open (decided here; tell chee)

- A making marks readers of the new node's directory or of one of its slots
  as well as of its value: those reads saw it absent. CORE lists only "the
  readers of the node's value" for a making. A program cannot tell the
  difference (a directory step on an absent node binds `[]`), only `saw`.
- The lasting interface is `WriteOnly`, like the effect's. The spec does not
  say whether a handler may read.
- `fire` on a process that is not running, or with a handler it does not
  have, answers `{"error": {"kind": "invalid"}}`, not an ok answer with an
  `error`: its handlers stop working with it.
- A handler whose own operation stops its process (unplacing it) gets
  `invalid` on its next operation, which ends it and is the fire's error.
  Handlers and lasting interfaces of an earlier start stay invalid after a
  restart. The cleanup run by the stop itself still works.
- If the cleanup run before an effect stops the process, the effect does not
  run.
- A process node whose data.path is not a path fails each run before its
  program slots are read, so `compute` and `effect` are left out and the run
  reads nothing: only a restart runs it again.
- A refused read of the program slot itself (a rule on `directory` of the
  process node) leaves the record's `compute`/`effect` entry out: the slot is
  unknown.
- `data` is not remembered as a read (fixed data never changes), and is
  invalid through a write-only interface; no program step makes one.
- `lookup` without a `path` is `invalid`. A make's `path`, if a request gives
  one, is only the path it acts at.
- Lone surrogate escapes (`\ud800`) are accepted as one code point, as
  JSON.parse does (scenarios never send them). Text holds them as WTF-8
  bytes (`Json.surrogate`).
- A program the loader rejects, or a gone compute slot, fails the run with
  `{"kind":"invalid","op":"compute"|"effect"}`. An absent program leaves it
  pending.
- A run's ending: `refused` if any error in it is a refusal, else `failed`
  on any error or uncaught throw, else pending or done.
- A cleanup's own errors and throws are dropped (it runs outside any run).
- Inside a batch each inner change answer carries its own (normally empty)
  `runs` and `stopped`. A Haskell exception answering a line becomes
  `{"error":{"kind":"crash",...}}`; that kind only marks a bug.
- Marks for stopped processes: the graph keeps a stopped process's
  remembered reads. A later change may therefore list that process in
  `"marked"`. The driver ignores such marks.
