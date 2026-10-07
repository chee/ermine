# ermine core in Haskell

The spec is `../CORE.tex` (the graph) and `../PROTOCOL.tex` (the harness).
Never edit a .tex file. If a scenario contradicts the spec, the spec wins:
report it rather than bending the code to it.

## Build and run

```sh
. ~/.ghc-wasm/env
cd haskell && wasm32-wasi-ghc -O1 -Wall -outputdir build -o ermine.wasm Main.hs
echo '{"seq":1,"cmd":"reset","stack":"graph","root":"root"}' | wasmtime run ermine.wasm
cd ../conformance && ERMINE_REQUIRE=graph ERMINE_HARNESS="$HOME/.ghc-wasm/wasmtime/bin/wasmtime run $PWD/../haskell/ermine.wasm" deno task test
```

Use the full wasmtime path in `ERMINE_HARNESS`: deno's child process does not
see the PATH that `~/.ghc-wasm/env` sets.

Unit checks (from `haskell/`), each `wasm32-wasi-ghc -O1 -Wall -i. -outputdir build/tests -o build/X.wasm tests/X.hs && wasmtime run build/X.wasm`:

- `tests/JsonTest.hs`: the parser, the printer (numbers as JSON.stringify prints them, -0 as `-0`),
  the `"/"` forms both ways (bytes, typed arrays, live, number, map) and the malformed ones,
  value equality (CORE Values), `asWhole`, and the seq of a line that is not one JSON object (`lineSeq`).
- `tests/TypesTest.hs`: addresses, and the encodings of changes, change headers, items (the
  refused one included), froms, errors and records.
- `tests/GraphTest.hs`: what the graph stack's scenarios cannot reach: which
  processes a change marks (a node becoming here, letting go, the first change as `by`),
  one-place (a second slot, a mount, making with a held id, moving within its slot), the
  order a letting go takes things apart in and the ordinary node it leaves here,
  `forget` and `reload` dropping kept reads, recordings, read-only and write-only interfaces,
  the refused lookup item, patch error codes, times and positions past 2^53 at the graph; and
  union reads, `..` along the place's walk (one that stopped on the way included), a chroot's
  start, lookup passing over a slot of pending ids, and subscriptions following their route.

Boot libraries only: base, containers, text, bytestring, mtl, transformers.

## Status (2026-10-07, ephemeral nodes unique)

The graph stack matches CORE.tex and PROTOCOL.tex as revised on 2026-10-07:

- values beyond JSON: bytes and typed arrays held as buffers (`JBytes`, `JTyped` with the
  elements little-endian), numbers as `Double` with NaN, the infinities and -0; live values
  as stand-ins (`JLive kind n`), each a new one per request that gives one. Requests read
  values from their JSON forms (`Json.fromForms`), answers write them (`Json.render`): -0 as
  `-0`, NaN and the infinities under `{"/": {"number": ...}}`, int64 and uint64 elements as
  decimal strings, float32 elements shortest, a map whose only key is `"/"` escaped. A
  malformed form is `wrong-field` of the field holding it. Equality (`Eq Value`) is CORE's:
  `Object.is` for numbers, typed arrays only of one kind, element by element;
- patches on bytes (octets) and typed arrays (elements of the same kind); a path never goes
  into bytes, a typed array or a live value; checked path, then kind, then range;
- ephemeral nodes: `"ephemeral": true` makes one (without a value: `missing` `value`); its
  changes, and placements and unplacements of it, are ephemeral and never a slot's last
  change; making an ordinary node in one is `ephemeral-parent` (after `exists`, before
  `position`); a live value is only an ephemeral node's whole value, else `wrong-field`
  (a snapshot into an ordinary node is found by the graph, after the address and time);
  an ephemeral node is unique: in the one slot it was made in (`nodeHome`), moving only
  within it; a second placement or a mount of its id is `one-place`, and so is making an
  ephemeral node with an id any slot holds (after `exists` and `ephemeral-parent`, before
  `position`, as the fuzz model orders them; PROTOCOL's graph order does not list
  `one-place`); unplaced from its slot it goes at once, taken apart children first
  (`Graph.letGo`; no holder counting, no cycles), each member taken out an ephemeral
  unplacement at the next time, made by the agent and process of the change that let the
  first one go and for its cause; an ordinary node it held stays; the change answer lists
  `gone`; each slot keeps the ids ordinary changes put there (`slotKept`) for reload;
- `reload` (`iReload`): ephemeral nodes and changes dropped, slots keep their kept ids
  (a mount of a gone ephemeral node's id, made by an ordinary change, stays, pending), subscriptions and their
  queues dropped, subscription numbers and the highest time kept;
- marking: a change that makes an id's node here marks the readers of every slot holding
  the id; `marked` gives each process with `by`, the time of the first change that marked
  it, its own or one its letting go made; `forget` (`iForget`) drops a process's reads;
- change references are times (`marked`'s `by`, records' `marked`, `cleanup`, `changes`);
  items carry the change's header (no patches, no placement value, `ephemeral` when so);
- subscriptions: a change to the route comes with `reaches`, the items reading the address
  then gives; a lookup a refused read ended gives `{"refused": true, "from": {"path": p}}`;
- times are whole numbers from 1 to 2^53-1 at the request (`wrong-field` otherwise); the
  graph itself holds `Integer` times; lines are UTF-8, ending at 0x0a only;
- a request acting as a process may leave its cause out; fields are checked in PROTOCOL's
  order, `ephemeral` after `value`; `reload` and `events` carry no agent and name no op;
  stacks `protect` and `schedule`, and `batch`, `start` and `fire`, answer `unsupported`.

Builds with `-Wall`, no warnings. Unit checks pass. Conformance (`conformance_test.ts`,
`ERMINE_REQUIRE=graph`): 108 passed, 0 failed, 110 ignored (protect and schedule
scenarios, whose reset is answered `unsupported`). `lines_test.ts` and `encoding_test.ts`:
three fail on the same stale expectation, an item's change carrying a placement's `value`,
which PROTOCOL now leaves out of an item's change header.

Protect, the scheduler and the program interpreter are gone (they were written
for an earlier spec; see git, f3b65b1). The graph keeps CORE's marking:
`iRecord`/`iFinish`, kept reads and marks, which nothing below schedule uses: `marked` is
always `[]`.

## Files

| file | what |
|---|---|
| Json.hs | `Value` (JSON, bytes, typed arrays, live), parser, the `"/"` forms, printer, `Eq` = CORE's equality |
| Types.hs | ids, addresses, routes, froms, changes and headers, items, errors, `Ctx`, `Op`, `Result`, records, `Interface` |
| Graph.hs | `graph :: Id -> IO Interface`, `applyPatches` |
| Main.hs | the line loop, request decoding, live stand-ins, answers |

## The interface

```haskell
data Interface = Interface
  { iOp          :: Ctx -> Stamp -> Op -> IO (Either Err Result)   -- read directory lookup write place unplace
  , iSubscribe   :: Ctx -> Address -> (Event -> IO ()) -> IO (Either Err Int)
  , iUnsubscribe :: Ctx -> Int -> IO (Either Err ())
  , iRecord      :: Api -> RecordStart -> IO Recording
  , iFinish      :: Recording -> Ending -> IO Record
  , iReload      :: IO ()
  , iForget      :: Id -> IO ()
  , iSetTop      :: Interface -> IO () }

data Ctx = Ctx { ctxAgent :: Value, ctxProcess :: Maybe Id, ctxPlace :: [Name], ctxChroot :: Int, ctxMode :: Mode, ctxRun :: Maybe RunTag }
data Op  = OpRead Address | OpDirectory Address (Maybe Name) | OpLookup Name
         | OpWrite Address [Value] | OpPlace Address Name Id (Maybe Integer) (Maybe Value) Bool | OpUnplace Address Name Id
```

Arguments are decoded by whoever makes the request (PROTOCOL Errors: the
request is checked first, for `missing` and `wrong-field`); patches keep only a
patch's fields, their values read from their forms, since whether each is a
patch is the graph's to say. A wrapper overrides `iOp` and passes `iSetTop`,
`iReload` and `iForget` on; Main calls `iSetTop top top` once.

## Marking (kept, not exercised)

A read through a ctx that is `ReadOnly` and in its process's current run
keeps what it depended on: each slot its walks looked in, the slot looked for
in each member that was here, and the value, slot or directory it read. A
run's reads count alongside its process's last finished run's and replace them
when it finishes. A change marks every process whose reads it touched, its own
included: a write the value's readers; a place or unplace the slot's and the
directory's; a placement that makes a node also the readers of every slot that
holds its id. Each unplacement a letting go makes marks as any change does.

## Choices where the papers are open (questions for chee)

- `..` from a place whose walk stopped on the way. CORE: "goes back one step
  the way the place was reached, to the node its walk came through"; Lookup:
  "the directories its place's walk went through". The walk stops where no
  member will do; I go back along the nodes it came through before it
  stopped, and there is nothing past where it stopped. With `u = [m1, m2]`,
  only `m2` holding `b`, and `b`'s slot `kid` holding only a pending id, the
  place `["u", "b", "kid"]` reaches nothing, `[".."]` reaches `b`, and a
  lookup from it searches `b`, `m2` and the root. The other reading: a place
  that was not reached has no way it was reached, so every `..` and every
  lookup from it give nothing. C, TS and the fuzz model read it as I do; no
  scenario reaches it.
- What a subscription's route is. I take it to be the node the address
  reaches and the route of the address's own names, as a read's `from`
  gives it. A placement that moves only the place's walk, such as a pending
  id put in front of the member a place goes through, while the address
  starts at the same node, is not sent. C, TS and the model harness do the
  same (the fuzz model's oracle leaves it open); no scenario moves only the
  place's walk.
- Patch codes the papers do not name: a set's key that is a whole number is
  `wrong-kind` (a number into a map), one of no kind (null, a boolean, a
  negative or fractional number) `not-a-patch`; a negative or fractional
  path index is not a whole number, so `not-a-patch`; within one patch, what
  it is comes first (`not-a-patch`, before its path is followed); a
  snapshot without a value, a set without a key, a path that is not a list:
  `not-a-patch`; a splice range that is missing or malformed: `range`, with
  the target's length, after the splice value's kind (PROTOCOL: path, then
  kind, then range).
- A float32 element is written from the shortest digits that read back as
  the same float32 (`floatToDigits` on the `Float`), printed as JavaScript
  prints a number. A float element's NaN is held as the one quiet NaN.
- A reset with a stack the protocol does not have, `"drive"` included, is
  `wrong-field` `stack`.
- A chroot past the place's length, or not a whole number from 0:
  `wrong-field`.
- Where the first reset is checked among a request's fields. PROTOCOL: "A
  request before the first reset is invalid, with code missing and field
  reset", and fields are checked "cmd, agent, ...". I check `cmd` first
  (`missing`, `wrong-field`, `unknown-command`), then the session, then the
  rest, as C and TS do: before the first reset `{"cmd":"frob"}` is
  `unknown-command`, `{"cmd":"read"}` with no agent is `missing` `reset`,
  and `batch` and `fire` are `missing` `reset` too, since there is no stack
  yet to not have them. The other reading puts the session before `cmd`.
- The seq of a line that is not one JSON object: only the object's own
  `"seq"` key counts, not one nested deeper; its value must be read whole; a
  whole number is one from 0; with a repeated key, the last read decides;
  the line stops being JSON at its first byte that is not UTF-8.
- `events` reads only `sub`; its other fields are not looked at.
