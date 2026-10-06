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
  `asWhole` (no cap at 2^53), and the seq of a line that is not one JSON object (`lineSeq`).
- `tests/TypesTest.hs`: addresses, and the encodings of changes, items, froms, errors and records.
- `tests/GraphTest.hs`: what the graph stack's scenarios cannot reach: which
  processes a change marks, recordings, read-only and write-only interfaces,
  patch error codes, and times, positions, indexes and ranges past 2^53; and
  union reads, `..` along the place's walk (one that stopped on the way
  included), a chroot's start, lookup passing over a slot of pending ids,
  and subscriptions following their route.

Boot libraries only: base, containers, text, bytestring, mtl, transformers.

## Status (2026-10-06)

The graph stack matches CORE.tex and PROTOCOL.tex as of commit 643061e:

- reads answer lists of items, each with its `from` and the `change` that last
  set its value or slot (none for the root's first value); an address that
  reaches nothing reads as `[]`;
- a read whose last name selects a slot gives an item for each member here,
  in slot order, each with its own value, route (ending at that member and
  its position) and change; the first is the node the address reaches, the
  one writes, placements and longer walks use. No names, or only `..`: the
  one node. A directory read of the same address lists the same union;
- a place is names from the root. Its first `chroot` names, walked on their
  own as an address, reach its `/` (PROTOCOL: "its / is the node those names
  reach"); its other names are walked from there: that is the place's walk.
  `..` goes back one step along it, to the node it came through, so in a
  union it stays in the member the place went through;
- lookup searches the directories the place's walk went through, from `.`
  back up to the start, each step a read of one slot through the top of the
  stack, and takes the nearest slot holding a node that is here: a slot whose
  ids are all pending is passed over;
- a subscription receives each change to the node its address reaches, and
  each placement or unplacement that changes its route (the node reached and
  the route of the address's names), whether or not it then reaches another
  node;
- placing makes (with a value), mounts (an absent id, no value: a pending
  item), places again, or moves (a position is a gap, 0 to the slot's length);
  placing an id already there with no position leaves the slot as it is, but
  is its last change, which its items carry; nothing is ever removed;
- errors are `{"kind", "op"?, "why": {"code", ...details, "text"?}}` with
  PROTOCOL's codes. A request's fields are checked in PROTOCOL's order (cmd,
  agent, process, place, chroot, address, name, id, position, value, patches,
  cause, time, then sub); then the graph's: the address (`above-root`,
  `nothing-there`, unplace included), the time (`time`), then the change
  (`exists`, `position`, `not-in-slot`, the patches patch by patch);
- a time is a whole number from 1, a position one from 0, else `wrong-field`.
  Whole numbers have no upper bound: any whole binary64 is one, held exactly
  as an `Integer` (`asWhole`); a time of 1e21 prints `1e+21`, a position that
  large is code `position`, an index that large `no-key`, a range `range`;
- patch codes: a path key that is neither a string nor a whole number is
  `not-a-patch` (checked before the patch is applied); an object that lacks
  the key or a list shorter than the index, `no-key`; a string into a list or
  a number into an object, `wrong-kind`; a splice value of the wrong kind,
  `wrong-kind`;
- every request but `reset` and `events` carries an agent. Subscriptions are
  numbered from 1 in each session; after `unsubscribe` the next `events` on
  that number hands over what arrived before, once, and after that it is
  `wrong-field` `sub`, as is a number there never was;
- a request before the first reset is `missing` `{"field": "reset"}`,
  `batch` and `fire` included. `cmd` is checked first, so an unknown one is
  `unknown-command` even then;
- an error names its command as `op` when the command is an operation,
  session or not (chee's ruling, pinned in `lines_test.ts`). The operations
  are the graph's (CORE's table) and `batch`, "the driver's own operation"
  (DRIVER, Outside operations, batches and handlers). `events` and `fire` are
  "the harness's, not operations" (PROTOCOL, The reference protect), and
  `reset` builds the session: their errors name no op, nor do faults in
  `cmd`. So before the first reset `batch` is `missing` `reset` with `op`
  `batch`, and `fire` and `events` have none;
- a line that is not one JSON object is `not-a-request`, kind `invalid`, under
  the seq a parser reading it from its start reaches (`Json.lineSeq`), or
  `null`;
- in a session, reset with stack `protect` or `drive`, `batch` and `fire`
  answer `unsupported`.

Builds with `-Wall`, no warnings. Unit checks pass. Conformance suite with
`ERMINE_REQUIRE=graph`: 322 passed, 4 failed, 104 ignored (the 88 drive and
15 protect scenarios and the one drive encoding test, whose reset is answered
`unsupported`). All 53 graph scenarios pass, and every lines and encoding
test, `an error names its command as op ...` included. The 4 failures are
not the harness's: `fuzz/model_test.ts` runs the model over the graph
scenarios, and its `DISPUTES` list still names steps of `mount.json`,
`routes.json`, `union-walk.json` and `time-zero-invalid.json` that the
scenarios have since been corrected in ("a listed dispute no longer differs:
take it off DISPUTES"). Fuzz (graph stack, no save): invariants 20 seeds;
agree with c, ts and the model 20 seeds; determinism 10 seeds; all ok.

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
         | OpWrite Address [Value] | OpPlace Address Name Id (Maybe Integer) (Maybe Value) | OpUnplace Address Name Id
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
- Patch codes the papers do not name: a path that goes on into a string,
  number, boolean or null is `wrong-kind` (a key needs an object or a list
  and found another kind; `no-key` lists only an object lacking the key and
  a list shorter than the index); a set's key that is a whole number is
  `wrong-kind` (a number into an object), one of no kind (null, a boolean, a
  negative or fractional number) `not-a-patch`; a negative or fractional
  path index is not a whole number, so `not-a-patch`; within one patch, what
  it is comes first (`not-a-patch`, before its path is followed); a
  snapshot without a value, a set without a key, a path that is not a list:
  `not-a-patch`; a splice range that is missing or malformed: `range`, with
  the target's length, checked before the splice value's kind.
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
