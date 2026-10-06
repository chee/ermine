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

## Status (2026-10-06)

- The graph stack follows CORE.tex and PROTOCOL.tex as read below: reads
  are lists of items with `from` and `change`; addresses are parts (a first
  `/`, then `..`, then names) walked as Plan 9 walks a union; placing makes
  (with a value), mounts (without one, for an id the graph lacks), places
  again or moves (positions are gaps, 0 to the slot's length); nothing is
  ever removed, so an unreachable node keeps its value and directory and
  placing its id again brings it back; errors carry PROTOCOL's codes;
  requests take `place` and `chroot`; changes from outside need `cause`
  (and below drive `time`).
- chee's decisions of 2026-10-06, as the papers now say them:
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
    included), then when (`time`), then what (`exists`, `position`,
    `not-in-slot`, the patches' codes patch by patch); a request's fields
    go cmd, agent, process, place, chroot, address, name, id, position,
    value, patches, cause, time, then the command's own (`sub`, `stack`,
    `root`).
  - a time is a whole number from 1, else `wrong-field` `time`; a position
    not a whole number from 0 is `wrong-field`, past the length `position`.
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
- A whole number is whole however large: PROTOCOL Encodings gives a time
  no upper bound, and Lines only promises numbers a binary64 holds exactly.
  A time is kept as a double (`ErmTime`), so 2^53+2 and 1e21 are times, and
  print as JavaScript does (`1e+21`). A position, path index, splice end,
  `chroot` or `sub` past int64 is held at INT64_MAX or INT64_MIN
  (`jsonIsWhole`), past every length: a position too large is `position`,
  an index too large `no-key`, a range end too large `range`.
- An error names its command as `op` when the command is an operation,
  session or not (chee's ruling of 2026-10-06, which settles fuzz/DESIGN.md
  Question 7): CORE's operations (read, directory, lookup, write, place,
  unplace, subscribe, unsubscribe) and `batch`, "the driver's own operation"
  (DRIVER Outside operations, batches and handlers). So `batch` before the
  first reset is `missing` `reset` with `op` `batch`; after one, the graph
  stack answers it unsupported. No `op` on errors answering `reset`,
  `events` or `fire` (the harness's, not operations: PROTOCOL Errors, The
  reference protect), nor on a fault in `cmd` itself (`missing`,
  `wrong-field`, `unknown-command`).
- `reset` with stack `protect` or `drive` answers `{"unsupported": "reset"}`;
  `batch` and `fire` answer unsupported. protect.c, drive.c and program.c
  are gone: they were written against the old id-based graph and are about
  to be redesigned.
- Marking is kept, dormant: `record` and `finish`, each process's reads
  (its last finished run's and its run under way's, through a read-only
  interface), and what a change marks (CORE Changes: value readers for a
  write, every member of a union read included; slot readers, walks that
  tried the slot and whole-directory readers for a placement; walks that
  passed over an id, and slot reads and lookups that saw it pending, when
  the placement makes its node). Nothing below drive records a run, so
  `marked` is always `[]`. Throwaway tests (`scratch/now/marks.c`,
  `scratch/union/marks2.c`) checked it.
- `ERMINE_REQUIRE=graph deno task test`: 322 passed, 4 failed, 104 ignored
  (protect and drive scenarios), on `c/ermine` and on `c/ermine-asan`.
  Every graph scenario passes, and every lines and encoding test (the new
  "an error names its command as op" one included). The 4 failures run no
  harness: `fuzz/model_test.ts` still lists, in its DISPUTES, steps of
  `graph/mount.json`, `routes.json`, `union-walk.json` and
  `time-zero-invalid.json` that the scenarios have since fixed, and asks
  for them to be taken off. The suite shows a harness's stderr only when a
  scenario fails, so it was also run through `scratch/now/asan-logged.sh`
  (`c/ermine-asan`, stderr appended to `scratch/now/asan-stderr.log`): the
  log stayed empty. Every graph scenario's requests (53 files) piped
  through `c/ermine-asan` leave ASan and UBSan silent. Fuzz seeds 1 to 24
  of the graph generator pass its invariants on `c/ermine`, 25 to 36 on
  `c/ermine-asan` (stderr logged, empty); in agree mode
  (`scratch/union/agree2.ts`), seeds 1 to 20 answer as ts and haskell do.
  The generator sends no `batch`.
- Nothing recurses. json.c parses, prints, frees and compares with stacks
  on the heap; a walk is a loop over names and a patch a loop over its
  path. main runs on the main thread (the old 64 GiB stack thread is gone).
  A 300,000-deep value goes through place, a write along a 299,999-key
  path, and read, under ASan on the default stack.

## Disputes: what the suite expects against the papers

None open. Each new or changed graph scenario of 2026-10-06, and the new
lines and encoding tests, were checked against the papers step by step, not
only against this code; they agree with them as read here.

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
6. An item's `change` is the whole change, as `c` is in events and change
   answers (references are written `ref`).

## Files and interface

| file | what |
|---|---|
| json.h, json.c | `Json`, parser, JS-exact printer, `jsonEqual` (= `$eq`), code points |
| ermine.h, ermine.c | places, addresses, routes, items, changes, ops, results, errors; the vtable; records; encodings; `ErmMap` |
| graph.c | `ermGraph(root)` |
| main.c | the line loop, request decoding, reset, commands |
| json_test.c | `make check` |

```c
struct ErmVtable {
  ErmErr        (*op)(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out);
  ErmErr        (*subscribe)(void *self, const ErmCtx *ctx, const ErmAddress *address, ErmEventFn fn, void *data, int64_t *sub);
  ErmErr        (*unsubscribe)(void *self, const ErmCtx *ctx, int64_t sub);
  ErmRecording *(*record)(void *self, ErmApi api, const ErmRefs *marked);
  ErmRecord    *(*finish)(void *self, ErmRecording *recording, ErmEnding ending);
  void          (*setTop)(void *self, ErmInterface top);
};
ErmCtx   { Json *agent; const char *process; ErmPlace place; ErmMode mode; int64_t run; }
ErmPlace { ErmIds names; int chroot; }          // names from the root; the first chroot are hidden
ErmStamp { Json *cause; ErmTime time; }        // ErmTime: a double, any whole number from 1
ErmOp    { kind; ErmAddress address; name; id; hasPosition, position; Json *value; Json *patches; }
ErmResult{ ErmItems items; ErmListing listing; ErmChange *change; ErmIds marked; }
```

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
parser's failures, a gone slot's ids) is freed. A device that runs for long
would want real ownership; that is not done.
