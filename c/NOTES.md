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
make -C c check           # json_test.c: numbers, strings, code points, equality, a million-deep value
cd conformance && ERMINE_REQUIRE=graph ERMINE_HARNESS="$PWD/../c/ermine" deno task test
cd conformance && ERMINE_REQUIRE=graph ERMINE_HARNESS="$PWD/../c/ermine-asan" deno task test
```

`deno task fuzz` saves what it finds under `conformance/fuzz/failures/`;
`scratch/now/fuzz.ts` (scratch is ignored by git) runs the fuzz suite's
generator and invariants against a harness without saving anything:
`deno run --no-check --allow-run --allow-read --allow-env fuzz.ts 1 30 [harness]`.
`scratch/now/agree.ts` runs the same sessions in agree mode, c against ts
and haskell: `deno run --no-check --allow-run --allow-read --allow-env agree.ts 1 20`.

## Status (2026-10-06)

- The graph stack follows CORE.tex and PROTOCOL.tex as read below: reads
  are lists of items with `from` and `change`; addresses are parts (a first
  `/`, then `..`, then names) walked as Plan 9 walks a union; placing makes
  (with a value), mounts (without one, for an id the graph lacks), places
  again or moves (positions are gaps, 0 to the slot's length); nothing is
  ever removed, so an unreachable node keeps its value and directory and
  placing its id again brings it back; lookup searches from the place's `.`
  up to its start; subscribe follows its address, and is sent the placement
  that switched it; errors carry PROTOCOL's codes; requests take `place`
  and `chroot`; changes from outside need `cause` (and below drive `time`).
- A whole number is whole however large: PROTOCOL Encodings gives a time
  no upper bound, and Lines only promises numbers a binary64 holds exactly.
  A time is kept as a double (`ErmTime`), so 2^53+2 and 1e21 are times, and
  print as JavaScript does (`1e+21`). A position, path index, splice end,
  `chroot` or `sub` past int64 is held at INT64_MAX or INT64_MIN
  (`jsonIsWhole`), past every length: a position too large is `position`,
  an index too large `no-key`, a range end too large `range`.
- `op` is on the errors answering CORE's operations (read, directory,
  lookup, write, place, unplace, subscribe, unsubscribe), never on those
  answering `reset` or `events`: those are the harness's, not operations
  (PROTOCOL Errors, The reference protect; CORE's table of operations).
- `reset` with stack `protect` or `drive` answers `{"unsupported": "reset"}`;
  `batch` and `fire` answer unsupported. protect.c, drive.c and program.c
  are gone: they were written against the old id-based graph and are about
  to be redesigned.
- Marking is kept, dormant: `record` and `finish`, each process's reads
  (its last finished run's and its run under way's, through a read-only
  interface), and what a change marks (CORE Changes: value readers for a
  write; slot readers, walks that tried the slot and whole-directory readers
  for a placement; walks that passed over an id when the placement makes
  its node). Nothing below drive records a run, so `marked` is always `[]`.
  A throwaway test (`scratch/now/marks.c`) checked it once.
- `ERMINE_REQUIRE=graph deno task test`: 260 passed, 0 failed, 112 ignored
  (protect and drive scenarios), on `c/ermine` and on `c/ermine-asan`.
  Every graph scenario's requests piped through `c/ermine-asan` leave ASan
  and UBSan silent. Fuzz seeds 1 to 30 of the graph generator pass its
  invariants on `c/ermine`, 31 to 40 on `c/ermine-asan`; in agree mode
  (`scratch/now/agree.ts`), seeds 1 to 20 answer as ts and haskell do.
- Nothing recurses. json.c parses, prints, frees and compares with stacks
  on the heap; a walk is a loop over names and a patch a loop over its
  path. main runs on the main thread (the old 64 GiB stack thread is gone).
  A 300,000-deep value goes through place, a write along a 299,999-key
  path, and read, under ASan on the default stack.

## Disputes: what the suite expects against the papers

None open. The suite now agrees with the papers on the two raised before:
unplacing removes nothing (`graph/removal.json`, `graph/removal-cycle.json`)
and every item carries its `change` (`lines_test.ts`, `encoding_test.ts`).

## Readings the papers leave open (asked of chee)

1. A place reaches `.` by its own walk (its last name takes the first id
   whose node is here); an address walks from there, and its route lists
   only its own names. `..` is the place less one name, walked afresh, so
   with `u = [m1, m2]` and only `m2` holding `y`, place `["u","y"]` reaches
   `m2`'s `y` but `[".."]` reaches `m1`. Lookup reads one directory per
   level, never a union. The fuzz model reads it the same way.
2. The graph checks in this order: `above-root`, `time`, `nothing-there`,
   then `exists`, `position`, `not-in-slot` or the patches'.
3. A time of 0 or less on a fresh graph is code `time` with `"last": 0`.
4. Patch codes the scenarios leave open: a splice value of the wrong kind
   is `wrong-kind`; a path key of the wrong kind for its container, or out
   of range, is `no-key`; a missing path, a key neither a string nor a
   whole number, a set without a string key, a snapshot without a value are
   `not-a-patch`; a splice with no range is `range`, with its length.
5. Request-level: a request before the first reset is `missing` with
   `"field": "reset"`; an unknown or already unsubscribed `sub` is
   `wrong-field`; an object line with no string `cmd` is `missing` or
   `wrong-field` `cmd` (it is one JSON object, so not `not-a-request`); a
   negative or fractional position is `wrong-field`. Fields are checked in
   the order agent, process, place, chroot, address, name, id, position,
   value, patches, cause, time. Haskell answers a request before the
   first reset `not-a-request` instead (TS as here). Which errors carry
   `op` is ruled, not open: see Status.
6. An item's `change` is the whole change, as `c` is in events and change
   answers (references are written `ref`). Placing an id again with no
   position leaves the slot as it is but is still its last change.

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
