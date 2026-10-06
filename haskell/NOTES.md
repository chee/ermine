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

- `tests/JsonTest.hs`: the parser, the printer (numbers as JSON.stringify prints them), `$eq`,
  `asWhole` (no cap at 2^53).
- `tests/TypesTest.hs`: addresses, and the encodings of changes, items, froms, errors and records.
- `tests/GraphTest.hs`: what the graph stack's scenarios cannot reach: which
  processes a change marks, recordings, read-only and write-only interfaces,
  patch error codes, and times, positions, indexes and ranges past 2^53.

Boot libraries only: base, containers, text, bytestring, mtl, transformers.

## Status (2026-10-06)

The graph stack matches CORE.tex and PROTOCOL.tex as they now read:

- reads answer lists of items, each with its `from` and the `change` that last
  set its value or slot (none for the root's first value); an address that
  reaches nothing reads as `[]`;
- addresses are lists of parts (`/`, `..`, names) walked from the request's
  `place` and `chroot`; a walk takes the first member here that has the next
  name; a directory read whose last name selects a union lists every member;
- placing makes (with a value), mounts (an absent id, no value: a pending
  item), places again, or moves (a position is a gap, 0 to the slot's length);
  nothing is ever removed;
- lookup searches from `.` up to the place's start, each step a read of one
  slot through the top of the stack;
- subscriptions follow their address, with the change that switched them;
- errors are `{"kind", "op"?, "why": {"code", ...details, "text"?}}` with
  PROTOCOL's codes; a change needs `cause` and `time` (code `missing`);
- whole numbers (time, position, chroot, sub, a path's index, a splice's
  range) have no upper bound: any whole binary64 is one, held exactly as an
  `Integer` (`asWhole`). A time past 2^53, such as 9007199254740994 or 1e21,
  is a time and prints as JSON.stringify prints it (`1e+21`); a position that
  large is code `position`, an index that large `no-key`, a range `range`
  (PROTOCOL Encodings: "a whole number, at least 1", with no cap; Lines only
  promises numbers a binary64 holds exactly);
- reset with stack `protect` or `drive`, `batch` and `fire` answer
  `unsupported`;
- only a line that is not one JSON object is `not-a-request`. Before the
  first reset, as after it, a `cmd` the protocol does not have is
  `unknown-command` `{"cmd": s}` (`{"cmd":"frob"}` included), and `batch` and
  `fire` are `unsupported`; any other command before the first reset is
  `missing` `{"field": "reset"}`, with the command as `op` unless it is
  `events`, as C and TS answer it (the code is open: see the questions).

Builds with `-Wall`, no warnings. Unit checks pass. Conformance suite with
`ERMINE_REQUIRE=graph`: 260 passed, 0 failed, 112 ignored (the 103 protect
and drive scenarios and the one drive encoding test, whose reset is answered
`unsupported`, and the 8 saved fuzz failures, which the suite skips as not
saved by this fuzzer). Every graph scenario passes,
`removal.json` and `removal-cycle.json` included. No scenario or fuzz session
sends a request before its reset. Fuzz (graph stack, no save): invariants 12
seeds and agree with c 12 seeds, all ok.

Protect, the driver and the program interpreter are gone (they were written
for the earlier spec; see git, f3b65b1). The graph keeps CORE's marking:
`iRecord`/`iFinish`, remembered reads and marks, which nothing below drive
uses: `marked` is always `[]`.

## Files

| file | what |
|---|---|
| Json.hs | `Value`, parser, printer that matches JS, `Eq` = `$eq` |
| Types.hs | ids, addresses, routes, froms, changes, items, errors, `Ctx`, `Op`, `Result`, records, `Interface` |
| Graph.hs | `graph :: Id -> IO Interface`, `applyPatches` |
| Main.hs | the line loop, request decoding, answers |

## The interface

```haskell
data Interface = Interface
  { iOp          :: Ctx -> Stamp -> Op -> IO (Either Err Result)   -- read directory lookup write place unplace
  , iSubscribe   :: Ctx -> Address -> (Event -> IO ()) -> IO (Either Err Int)
  , iUnsubscribe :: Ctx -> Int -> IO (Either Err ())
  , iRecord      :: Api -> RecordStart -> IO Recording
  , iFinish      :: Recording -> Ending -> IO Record
  , iSetTop      :: Interface -> IO () }

data Ctx = Ctx { ctxAgent :: Value, ctxProcess :: Maybe Id, ctxPlace :: [Name], ctxChroot :: Int, ctxMode :: Mode, ctxRun :: Maybe RunTag }
data Op  = OpRead Address | OpDirectory Address (Maybe Name) | OpLookup Name
         | OpWrite Address [Value] | OpPlace Address Name Id (Maybe Int) (Maybe Value) | OpUnplace Address Name Id
```

Arguments are decoded by whoever makes the request (PROTOCOL Errors: the
request is checked first, for `missing` and `wrong-field`); patches stay raw,
since whether each is a patch is the graph's to say. A wrapper overrides
`iOp` and passes `iSetTop` on; Main calls `iSetTop top top` once.

## Marking (kept, not exercised)

A read through a ctx that is `ReadOnly` and in its process's current run
remembers what it depended on: each slot its walks looked in, each member they
tried that was not here, the slot looked for in each member that was, the
value, slot or directory it read, and each pending id it listed. A run's
reads count alongside its process's last finished run's and replace them when
it finishes. A change marks every process whose reads it touched, its own
included: a write the value's readers; a place or unplace the slot's and the
directory's; a placement that makes a node also those that passed over its id.

## Choices where the papers are open (questions for chee)

- Places through a union. A place is names from the root. `..` takes one
  name off, and the shorter place is followed afresh from the root, as
  Plan 9's lexical `..` is; lookup searches those shorter places. The
  address's own names are walked from the node that reaches, so the place's
  last name does not look ahead to the address's first. With `u = [m1, m2]`
  where only `m2` has `b`, the place `["u", "b"]` reaches m2's `b`, but
  `[".."]` reaches `m1`, and a lookup from there searches `b`, `m1` and the
  root, never `m2`, which the place's own walk went through. The fuzz model
  reads it this way too.
- Checks inside the graph run in this order: the address, the time, then
  what the change does (`exists`, `position`, `not-in-slot`, patches).
- Patch codes: a patch that is not an object, has no known type, is a
  snapshot without a value, has a path that is not a list, or is a set whose
  key is not a string: `not-a-patch`. A key of the wrong kind for where the
  path is, or a path into a string, number, boolean or null: `no-key`. A
  splice range that is missing or malformed: `range`, with the target's
  length. A splice value of the wrong kind: `wrong-kind`.
- A time not greater than every time, before any change: code `time`,
  `last: 0`; so a time of 0 or below is code `time`, never `wrong-field`. An
  address of the wrong form, a name `.`, `..` or `/`, a fractional time, a
  negative or fractional position or chroot, or a chroot past the place:
  `wrong-field`.
- `events` or `unsubscribe` of a subscription the session does not have:
  `wrong-field` `sub`.
- A known command before the first reset. PROTOCOL's table has no code for
  it: `not-a-request` is only for a line that is not one JSON object, and
  `missing` is for a field a request lacks, which `reset` is not. Sent to a
  fresh harness, `{"seq":2,"cmd":"read","agent":"h","address":[]}` is
  answered `{"kind":"invalid","op":"read","why":{"code":"missing","field":"reset"}}`,
  as C and TS answer it. `batch` or `fire` then is `unsupported`, as C
  answers it; TS answers those `missing` `reset` too.
- A lookup's nearest slot with the name is found even when every id in it is
  pending: its items say so.
- A subscription receives a change only when it changed the node the address
  reached, or the node the address reaches is another one now; a change that
  moves the route but not the node is not sent.
