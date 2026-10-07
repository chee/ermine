# ermine core in C

The spec is `../CORE.tex` (the graph) and `../PROTOCOL.tex` (the harness
contract). DRIVER.tex and PROTECT.tex are out of scope for now; IDEAS.tex is
never implemented. Never edit a .tex file or anything under `../conformance/`.
If a scenario contradicts the spec, the spec wins: report it rather than
bending the code. Where the spec does not decide, do not invent a rule:
ask chee, with the concrete case.

## Build and run

```sh
make -C c                 # c/ermine            (CC ?= cc, CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2, LDLIBS ?= -lm)
make -C c asan            # c/ermine-asan       (-fsanitize=address,undefined)
make -C c check           # json_test.c: numbers, strings, code points, equality, a million-deep value, what a broken line had read
                          # cbor_test.c: ../conformance/cbor_vectors.json both ways, every half, random floats, rejected input, a million-deep value
                          # graph_test.c: ephemeral nodes through the graph's interface: one-place, letting go, a 10,000-deep chain going
cd conformance && ERMINE_REQUIRE=graph ERMINE_HARNESS="$PWD/../c/ermine" deno task test
cd conformance && ERMINE_REQUIRE=graph ERMINE_HARNESS="$PWD/../c/ermine-asan" deno task test
```

`deno task fuzz` saves what it finds under `conformance/fuzz/failures/`;
`scratch/now/fuzz.ts` (scratch is ignored by git) runs the fuzz suite's
generator and invariants against a harness without saving anything:
`deno run --no-check --allow-run --allow-read --allow-env fuzz.ts 1 30 [harness]`.
`scratch/union/agree2.ts` runs the same sessions in agree mode, c against ts
and haskell: `deno run --no-check --allow-run --allow-read --allow-env agree2.ts 1 20 ts,haskell`.
`scratch/union/pipe.ts [harness]` pipes every graph scenario's requests
through a harness and prints any stderr; `scratch/union/cover.ts` counts
what 30 fuzz seeds exercise of the 2026-10-06 rules.
`scratch/now/asan-logged.sh`, given as `ERMINE_HARNESS` (or to `fuzz.ts`),
runs `c/ermine-asan` with its stderr appended to `scratch/now/asan-stderr.log`,
since the suite only prints a harness's stderr for a scenario that fails.

## Status (2026-10-07)

Brought up to the revised CORE.tex and PROTOCOL.tex:

- Values beyond JSON (json.h): bytes and typed arrays are `JSON_BYTES` and
  `JSON_TYPED`, held in buffers of their own C type (int8_t ... uint64_t,
  float, double), never as strings or lists; a live value is `JSON_LIVE`, a
  stand-in that is equal only to itself. Numbers are any binary64: -0 is
  kept, NaN and the infinities are values. `jsonDecode` reads PROTOCOL's "/"
  forms in place, as each value field is checked (agent, value, each patch's
  value, cause), and a malformed one is `wrong-field` on that field; a live
  value only as the whole value of a placement with `"ephemeral": true` or of
  a snapshot. The printer writes every value in its JSON form: -0 as `-0`,
  `{"/":{"number":"NaN"}}`, base64 without padding, 64-bit elements as
  decimal strings, float32 as the shortest number that reads back, and a map
  whose only key is "/" escaped as `{"/":{"map":...}}`. `jsonEqual` is CORE's:
  Object.is for numbers, typed arrays only of one kind, live values by
  identity.
- Patches splice bytes (octets) and typed arrays (elements, a value of the
  same kind); a path never goes into bytes, a typed array or a live value
  (`wrong-kind`). A splice is checked path, then kind (its target's, then its
  value's), then range.
- Ephemeral nodes: `ephemeral` on a node and on a change (a write to one, or
  a placement or unplacement of one or into one); `ephemeral-parent` after
  `exists`, before `position`; a snapshot of a live value into an ordinary
  node is `wrong-field` `patches`, checked before the patches. An ephemeral
  change never becomes a slot's last change. An ephemeral node is unique:
  each keeps its one parent and slot name (`Node.parent`, `Node.slot`), set
  when it is made and never changed. Placing it, or mounting its id, in any
  other slot is `one-place`; so is making an ephemeral node with an id any
  slot holds (a search of every slot, `heldAnywhere`, only when one is
  made). No holder counting, no cycles: unplacing an ephemeral node from its
  slot lets it go (`letGo`, a loop over a stack of the nodes being taken
  apart): its slots by name, ids in slot order, each member taken out an
  ephemeral unplacement of its own at the next time, with the first
  change's agent, process and cause, sent to subscribers and marking; an
  ephemeral member is taken apart before the next and goes after what it
  held; an ordinary member stays, here. The answer's `gone` lists them in
  the order they went. A gone node's id names nothing.
- `reload` keeps each ordinary node with the ids its slots got from changes
  that were not ephemeral (`Slot.kept`), drops ephemeral nodes, every
  subscription (numbering goes on) and every reader's reads, keeps the last
  time. It is not an operation: no agent, no `op`.
- A change that makes an id's node here marks the readers of every slot
  holding the id (`readHolder`, which replaces the old record of absent ids
  a walk passed over).
- A change answer's `marked` is `{"process", "by": t}`, `by` the first change
  that marked it, its letting go's included; change references are times
  (`ErmTimes`). Items carry the change's header: no `patches`, no placement's
  `value`.
- Subscription rows are `{"change": c}`, or `{"change": c, "reaches":
  [item]}` for a change to the route, the items read just after it.
- Lookup's refused step gives the item `{"refused": true, "from": {"path":
  [".." x up]}}`; only a wrapper can refuse, and C has none yet.
- `forget(process)` and `reload` are on the vtable.
- A time is a whole number from 1 to 2^53-1 (`ERM_LAST_TIME`), else
  `wrong-field`. `cause` is `missing` only on a request that does not carry
  `process`. `ephemeral` that is not a boolean is `wrong-field`, after
  `value`.
- `reset` with stack `protect` or `schedule` answers `{"unsupported":
  "reset"}`; `batch`, `start` and `fire` answer unsupported. `batch` and
  `start` are operations, so their errors name `op` (`missing` `reset` before
  the first reset); `fire`, `reset`, `reload` and `events` are not.

- Still so from 2026-10-06:
    - `read` gives an item for each member here of the slot its address's
      last name selects, in slot order, each with its own value, route
      (ending at that member and its position) and change; the first is the
      node the address reaches, the only one writes, placements and further
      walking use. An address with no names, or only `..`, reads one node.
    - `..` goes back one step along the place's own walk (`resolve`: the
      place walked only that far, each step taking the member that has the
      place's next name), not the place less one name walked afresh.
    - lookup reads `directory([".." x up], name)` for up = 0 to the start,
      and takes the nearest slot holding a node that is here; a slot whose
      ids are all absent is passed over.
    - a subscriber is sent each placement or unplacement that changes its
      route (the node it reaches, or any step of its own names: parent,
      member or position), whether or not it then reaches another node, and
      each change to its node (`follow`, `deliver`).
    - placing an id again with no position leaves the slot as it is and is
      its last change (it already was).
    - the graph checks where (`above-root`, `nothing-there`, unplace
      included), then when (`time`), then what (`exists`,
      `ephemeral-parent`, `position`, `not-in-slot`, the patches' codes
      patch by patch); a request's fields go cmd, agent, process, place,
      chroot, address, name, id, position, value, ephemeral, patches, cause,
      time, then the command's own (`sub`, `stack`, `root`).
    - a position not a whole number from 0 is `wrong-field`, past the
      length `position`.
    - patch codes: a path key neither a string nor a whole number is
      `not-a-patch`; an object without the key or a list without the index
      `no-key`; a key of the wrong kind for where it leads, or a splice value
      of the wrong kind, `wrong-kind`.
    - a request before the first reset is `missing` `reset`; `events` needs
      no agent; subscriptions are numbered from 1 per session, and after
      `unsubscribe` the next `events` hands over what arrived before, once,
      then `sub` is `wrong-field` (as for a number there never was, or a
      second `unsubscribe`).
    - a line that is not one JSON object is `not-a-request`, under the
      `"seq"` a parser reading it from the start had read whole (a whole
      number, a key of the outermost object) before it stopped being JSON
      (`jsonParseRead`), else under `null`.
- An error names its command as `op` when the command is an operation,
  session or not (chee's ruling of 2026-10-06, which settles fuzz/DESIGN.md
  Question 7): CORE's operations (read, directory, lookup, write, place,
  unplace, subscribe, unsubscribe) and `batch` and `start`, the scheduler's
  own. So `batch` before the first reset is `missing` `reset` with `op`
  `batch`; after one, the graph stack answers it unsupported. No `op` on
  errors answering `reset`, `reload`, `events` or `fire` (the harness's, not
  operations), nor on a fault in `cmd` itself (`missing`, `wrong-field`,
  `unknown-command`).
- Marking is kept, dormant: `record` and `finish`, each process's reads
  (its last finished run's and its run under way's, through a read-only
  interface), and what a change marks (CORE Changes: value readers for a
  write, every member of a union read included; slot readers, walks that
  tried the slot and whole-directory readers for a placement; the readers
  of every slot holding an id, when the placement makes its node). Nothing
  below schedule records a run, so `marked` is always `[]`. Throwaway tests
  (`scratch/now/marks.c`, `scratch/union/marks2.c`) checked it before the
  2026-10-07 changes.
- `ERMINE_REQUIRE=graph`, conformance_test.ts: every graph scenario passes
  (108 of 108 on 2026-10-07, while the scenarios for unique ephemeral nodes
  were being rewritten), on `c/ermine` and on `c/ermine-asan`; protect and schedule
  scenarios are ignored (unsupported reset). Through
  `scratch/now/asan-logged.sh` the ASan/UBSan log stayed empty. lines_test
  and encoding_test: 14 passed, 3 failed, 1 ignored; the 3 are the dispute
  below. `make check` passes.
- Nothing recurses. json.c parses, decodes, prints, frees and compares with
  stacks on the heap; letting ephemeral nodes go keeps a stack of the nodes
  being taken apart; a walk is a loop over names and a patch a loop over its
  path. main runs on the main thread (the old 64 GiB stack thread is gone).
  A 300,000-deep value goes through place, a write along a 299,999-key
  path, and read, under ASan on the default stack.

## Disputes: what the suite expects against the papers

1. lines_test.ts ("lines end at 0x0a and nowhere else") and encoding_test.ts
   ("an address that reaches nothing reads as no items ...", "each item of a
   union read carries its own change ...") expect an item's `change` to carry
   the placement's `value`. CORE Paths says an item carries the change's
   header, "never its patches, nor the value a placement made a node with",
   and PROTOCOL Items "without patches and without a placement's value"; the
   graph scenarios agree with the papers. The code follows the papers.


## Readings the papers leave open (asked of chee)

1. A place reaches `.` by its own walk (its last name takes the first id
   whose node is here, whatever the address's names); an address walks
   from there, and its route lists only its own names. The hidden
   (`chroot`) names are walked as an address on their own to the start.
2. `..` when the place's walk stops short: it goes back along the walk as
   far as the walk got. Place `["a","b"]` with `a = [A]` and `A`'s `b`
   holding only an absent id: `.` is nothing, `[".."]` reaches `A`, and
   lookup goes on to `A`'s slot. (The other reading: no way back from a
   place not reached, so `..` reaches nothing.) TS, Haskell and the fuzz
   model read it as here.
3. A subscription's route is the address's own route, as a read's first
   item gives it, and the node. A placement that changes only the place's
   walk, leaving the start and that route as they were, is not sent:
   place `["a"]`, address `[]`, `a = [A]`, then a pending id placed at
   position 0 of `a` (`A` moves to position 1) is not sent; nor one that
   only moves where the walk of an address reaching nothing stops. The
   fuzz model leaves both open (DESIGN.md, Questions 1).
4. Patch codes still open: a whole number is 0, 1, 2 ..., so a path key of
   -1 is `not-a-patch`; a set's key that is a whole number is `wrong-kind`
   (a number into an object); a set without a key, or with one neither a
   string nor a whole number, is `not-a-patch`; a path that goes on into a
   string, number, boolean or null is `wrong-kind`; a missing path or a
   snapshot without a value is `not-a-patch`; a splice with no range, or a
   range not two whole numbers, is `range` with the length. A patch's form
   (type, path keys, a set's key) is checked before its path is walked; a
   splice checks its target's kind, then its range, then its value's kind.
   The fuzz model accepts each of these among the codes it allows.
5. Request-level: a missing, unknown or non-string `cmd` comes first
   (`missing`, `wrong-field`, `unknown-command`), then the session
   (`missing` `reset`, for `batch` and `fire` too), then the fields. An
   object line with no string `cmd` is `missing` or `wrong-field` `cmd` (it
   is one JSON object, so not `not-a-request`). What the papers say is
   never a name (`.`, `..` after a name, `/` after the first part) where a
   name, a place's name or an address's part goes, and a chroot past the
   place, are `wrong-field` on that field. Which errors carry `op` is
   ruled, not open: see Status.
6. The unplacements an ephemeral node's letting go makes (CORE Ephemeral
   nodes) carry the agent and process of the change that let the first node
   go, as CORE says, and its cause too, which CORE does not give. The fuzz
   model reads it the same way. Where `one-place` comes among the graph's
   checks PROTOCOL does not list; here it comes after `exists` and
   `ephemeral-parent`, before `position`, as the fuzz model does.
7. A live value's stand-in is a thing of its own for each request that gives
   one, equal only to itself; a snapshot of the same kind is a new thing.

## Files and interface

| file | what |
|---|---|
| json.h, json.c | `Json` (JSON, bytes, typed arrays, live values), parser, "/" forms (`jsonDecode`), printer, `jsonEqual` (CORE's equality), code points |
| ermine.h, ermine.c | places, addresses, routes, items, changes, ops, results, errors; the vtable; records; encodings; `ErmMap` |
| graph.c | `ermGraph(root)` |
| main.c | the line loop, request decoding, reset, commands |
| json_test.c | `make check` |
| graph_test.c | `make check`: ephemeral nodes |
| cbor.h, cbor.c | deterministic CBOR for values (the CBOR details are fixed in cbor.h's comment); not linked into `ermine` yet |
| cbor_test.c | `make check`; its fixed vectors are `../conformance/cbor_vectors.json`, for every codec |
| term/ | ermine-term, a toy OS over this graph: its own Makefile and NOTES.md |

```c
struct ErmVtable {
  ErmErr        (*op)(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out);
  ErmErr        (*subscribe)(void *self, const ErmCtx *ctx, const ErmAddress *address, ErmEventFn fn, void *data, int64_t *sub);
  ErmErr        (*unsubscribe)(void *self, const ErmCtx *ctx, int64_t sub);
  void          (*forget)(void *self, const char *process);
  void          (*reload)(void *self);
  ErmRecording *(*record)(void *self, ErmApi api, const ErmTimes *marked);
  ErmRecord    *(*finish)(void *self, ErmRecording *recording, ErmEnding ending);
  void          (*setTop)(void *self, ErmInterface top);
};
ErmCtx   { Json *agent; const char *process; ErmPlace place; ErmMode mode; int64_t run; }
ErmPlace { ErmIds names; int chroot; }          // names from the root; the first chroot are hidden
ErmStamp { Json *cause; ErmTime time; }        // ErmTime: a double, a whole number from 1 to 2^53-1
ErmOp    { kind; ErmAddress address; name; id; hasPosition, position; Json *value; bool ephemeral; Json *patches; }
ErmResult{ ErmItems items; ErmListing listing; ErmChange *change; ErmMarks marked; ErmIds gone; }
ErmEventFn(void *data, const ErmChange *change, const ErmItems *reaches)   // reaches: NULL unless the route changed
```

For a host holding the bare graph: `ermGraphLast(graph)`, the latest time in
it, and `ermGraphRelease(graph, ctx, stamp, id, out)`, CORE's `release`, which unplaces an
ephemeral node from its one slot with no address (an unplace at its parent),
as a scheduler's kill does (term/ uses both).

Operations take decoded arguments: main answers `missing` and `wrong-field`
before the graph sees a request. The graph's lookup reads each level
through the top of the stack, so a wrapper can refuse one. A recording's
api logs every operation with what it got (items carry routes and the
change that set what was read), so a driver can build PROTOCOL's record.

## Strings

U+0000 is held as the two bytes C0 80 (Java's "modified UTF-8"): the parser
makes it from `\u0000`, the printer writes it back as `\u0000`, and it counts
as one code point. So no string holds a NUL byte, every string is C text,
and ids and names with U+0000 are `const char *` like any other. Order ids
and names with `textCompare`, never `strcmp`; equality with `strcmp` is fine.

## Memory

A harness session is short-lived, so little is freed while it runs: every
`Json`, change, id and list, once stored or handed on, lives until exit and
is never changed, so pointers are kept without copying. A write builds the
new value by copying only the containers along each patch's path and swaps
the node's pointer. Scratch that never escapes (walk routes not used, the
parser's failures, a gone slot's ids) is freed. An ephemeral node that goes,
or that reload drops, is freed with its directory, and its id maps to NULL in
the node map (the map never removes a key, so it keeps one entry per id ever
made). Its value, a live stand-in included, is not freed: the placement that
made it holds it, and changes are kept and handed on. A device that runs for
long would want real ownership of values and changes; that is not done.
