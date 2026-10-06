# ermine core in C

The spec is `../CORE.tex` (design) and `../PROTOCOL.tex` (harness contract).
Never edit CORE.tex, PROTOCOL.tex or `../conformance/`. If a scenario
contradicts the spec, the spec wins: report it rather than bending the code.
`../haskell/` passes the whole suite: read `../haskell/NOTES.md` for the
readings the spec leaves open, and use it as an oracle.

## Build and run

```sh
make -C c                 # c/ermine            (CC ?= cc, CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2, LDLIBS ?= -lm)
make -C c asan            # c/ermine-asan       (-fsanitize=address,undefined)
make -C c check           # json_test.c: number printing, strings, code points, equality
cd conformance && ERMINE_HARNESS="$PWD/../c/ermine" deno task test
cd conformance && ERMINE_HARNESS="$PWD/../c/ermine-asan" deno task test
cd conformance && ERMINE_REQUIRE=graph,protect,drive ERMINE_HARNESS="$PWD/../c/ermine" deno task test   # once everything is claimed
```

Oracle: pipe the same lines into both and diff.

```sh
printf '%s\n' '{"seq":1,"cmd":"reset","stack":"graph"}' ... > /tmp/in
c/ermine < /tmp/in > /tmp/c.out
$HOME/.ghc-wasm/wasmtime/bin/wasmtime run haskell/ermine.wasm < /tmp/in > /tmp/hs.out
diff /tmp/c.out /tmp/hs.out
```

Key order in an object does not matter to the runner, but matching the
Haskell order (the order of PROTOCOL's listings, which the encoders in
ermine.c use) keeps diffs clean.

## Status (2026-10-05)

- The whole suite passes on `c/ermine` and `c/ermine-asan` with
  `ERMINE_REQUIRE=graph,protect,drive`: 215 passed, 0 failed. ASan and UBSan
  print nothing.
- Every scenario's requests were also piped through `c/ermine-asan` and
  `haskell/ermine.wasm`, and the outputs compared. They are byte for byte the
  same, including `why` texts, key order and number printing.
- The only known text difference from Haskell is the `why` of a line that is
  not JSON (the C parser names the byte offset). The runner does not match on
  it.
- Review fixes (2026-10-05): ids and names may hold U+0000 (see Strings);
  there is no nesting limit and nothing overflows the stack (see Depth); a
  change request with no `time` below drive says "a change needs a time", as
  Haskell does. Re-checked against Haskell on the review's 6,800 generated
  sessions (`scratch/diff`, `run.ts`) and repros (`scratch/review2`,
  `scratch/review3`): no answer differs.
- `scratch/` holds the graph agent's test harnesses. They are not part of
  the build.

## Who owns what

| file | owner | what |
|---|---|---|
| json.h, json.c | done | `Json`, parser, JS-exact printer, `jsonEqual` (= `$eq`), code point helpers, `allocate`/`growArray` |
| ermine.h, ermine.c | done | types, the vtable interface, record/finish types, errors, paths, patch shapes, encodings, ops, apis, `ErmMap` |
| json_test.c, Makefile | done | |
| graph.c | Graph agent | `ermGraph` |
| protect.c | Protect+Main agent | `ermRulesFrom`, `ermMayFromRules`, `ermProtect` |
| main.c | Protect+Main agent | line loop (done), `reset`, `dispatch`, answers, events |
| drive.c | Drive+Program agent | `ermDrive`, `ermDriverInterface`, `ermDriverBatchBegin/End`, `ermDriverFire`, `ermDriverTake` |
| program.c | Drive+Program agent | `ermLoadProgram` |

Do not change a type or signature in ermine.h or json.h on your own: the
other agents code against them. Add static helpers in your own file. If you
truly need a shared change, say so in your report rather than making it.

## The interface

```c
typedef struct ErmInterface { const ErmVtable *vt; void *self; } ErmInterface;
struct ErmVtable {
  ErmErr        (*op)(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out);
  ErmErr        (*subscribe)(void *self, const ErmCtx *ctx, Json *node, ErmEventFn fn, void *data, int64_t *sub);
  ErmErr        (*unsubscribe)(void *self, const ErmCtx *ctx, int64_t sub);
  ErmRecording *(*record)(void *self, ErmApi api, int64_t run, const ErmRefs *marked);
  ErmRecord    *(*finish)(void *self, ErmRecording *recording, ErmEnding ending);
  void          (*setTop)(void *self, ErmInterface top);
};
ErmCtx   { Json *agent; const char *process; ErmPath path; ErmMode mode; int64_t run; }   // fixed by bind
ErmStamp { Json *cause; Json *site; ErmTime time; }                                       // per change
ErmApi   { ErmInterface iface; ErmCtx ctx; }                                              // ermBind
ErmErr   { ErmErrKind kind /* OK INVALID REFUSED THROWN */; const char *op; Json *why; }
```

- **One `op` for every operation** (`ErmOp`, raw `Json *` arguments; the
  graph decodes and answers invalid). A wrapper overrides `op`, looks at
  `ermOpName(op->kind)` and `ermOpNode(op)`, and passes the rest on. Typed
  helpers `ermApiRead`, `ermApiWrite`, ... wrap `ermApiOp`.
- **Wrappers stack**: each keeps the `ErmInterface` below and implements all
  six entries, forwarding what it does not change. Every layer forwards
  `setTop`.
- **The top**: main calls `top.vt->setTop(top.self, top)` once after
  building. The graph's lookup reads each slot through the top (with the
  lookup's ctx, so protect can refuse it and the graph remembers it); drive
  binds runs, value writes and lasting interfaces from the top. Drive also
  holds `beneath`, the bare graph, for the tree walk, data reads and value
  comparison (ermHostCtx), which read beneath protect.
- **Records**: `record` (graph; wrappers forward) returns an `ErmRecording`
  with `api` (logs), `quiet` (remembered, not logged), `with` (log another api
  into the same run) and the plain `record` struct drive fills
  (compute/effect/value/cleanup). `finish` sets the ending, ends the run
  (apis then answer invalid), sends the record to the process node's
  subscribers, returns `&recording->record`.
- **Drive** intercepts change ops (stamps time, applies, queues marks, walks
  the tree, runs rounds unless busy or batching); main calls
  `ermDriverTake` after every request under drive for "runs" and "stopped".
  `batch` is `ermDriverBatchBegin`, each inner request through the top (each
  inner answer with its own take), `ermDriverBatchEnd`, then a take.
- **Programs**: `ErmLoader` (`ermLoadProgram`) turns a value into an
  `ErmProgram {self, compute, effect}`; effects return handlers and a
  cleanup as `ErmHandler {self, run}`, run later with the lasting interface.

The full rules are the CONVENTIONS block at the top of ermine.h: memory,
absent, ids, raw arguments, errors, time, modes, remembered reads, what
marks what, wrappers, the top, recording, drive's interception. Read it.

## Errors, briefly

A layer returns `ermInvalid(...)` (the graph rejected it) or `ermRefused(...)`
(a wrapper said no) with `op == NULL`. The recording logs it as `{kind, op:
ermOpName, why}`; program.c raises it as the thrown value
`ermErrToJson(ermWithOp(err, ermOpName(kind)))`; main answers
`{"error": ermErrToJson(err)}` (no op). `ERM_THROWN` is program.c's only:
a throw step (why = its message, any value) or an operator error. The run's
ending: refused if any record error is a refusal, else failed on any error
or uncaught throw, else pending or done.

## Strings

U+0000 is held as the two bytes C0 80 (Java's "modified UTF-8"): the parser
makes it from `\u0000`, the printer writes it back as `\u0000`, and it counts
as one code point. So no string holds a NUL byte, every string is C text
(`jsonText` fails only on a non-string), and ids and names with U+0000 are
`const char *` like any other. Raw C0 80 is not UTF-8, so a line can never
spell it. Byte order is code point order except for C0 80, so order ids and
names with `textCompare` (or `utf8Compare`), never `strcmp`; equality with
`strcmp` is fine.

## Depth

The protocol sets no nesting limit (a line that is one JSON object is a
request; JSON.parse takes any depth), and a value can also grow deeper write
by write. Parsing, printing, cloning, equality, patching and program
evaluation recurse once per level, so main runs the session on a thread with
a 64 GiB stack (reserved, touched only as deep as a session goes; it falls
back to smaller sizes, then the main thread). Checked: a 1,000,000-deep
value parses, stores and prints; the review's 58,000-level write chain and a
40,000-deep process chain (the tree walk, which also now keeps its own
stack) answer every line, plain and under ASan.

## Memory

A harness session is short-lived, so nothing is freed while it runs: every
`Json`, change, record, id and list, once returned, stored or handed on,
lives until exit and is never changed. Pointers can therefore be kept
without copying, and there is no use-after-free to make. To change a node's
value the graph builds a new value (clone, then patch the clone before
anyone sees it) and swaps its pointer. Main never frees a parsed request
(the graph may hold its parts) and frees only each printed answer string.
`jsonFree` is for scratch that never escaped (the parser's failures). The
ASan build has no leak checking on macOS; on Linux run it with
`ASAN_OPTIONS=detect_leaks=0`.

## Readings to keep (from ../haskell/NOTES.md, which passes the suite)

- A make marks readers of the new node's value, of its whole directory and
  of any slot of it.
- The lasting interface is WRITE_ONLY. A stopped process's lasting
  interfaces (and those of an earlier start) answer invalid.
- `fire` on a process that is not running, or with no such handler, is an
  `invalid` error answer.
- A refused read of a program slot itself leaves `compute`/`effect` out; a
  refused read of the program node gives `{"node", "refused": true, "slot"}`.
- A loader-rejected program or a gone compute slot fails the run with
  `{"kind":"invalid","op":"compute"|"effect"}`; an absent program node
  leaves it pending. A data.path that is not a path fails with `"op":"path"`
  before the slots are read.
- A cleanup's own errors are dropped. If the cleanup before an effect stops
  the process, the effect does not run.
- `lookup` without a `path` is invalid; reset answers `null`; a request
  before the first reset is invalid; `events` on an unknown subscription is
  invalid; unsubscribing keeps what already arrived.
- Inside a batch each inner change answer has its own `runs`/`stopped`.
- The graph keeps a stopped process's remembered reads; drive ignores marks
  for processes it is not running.
