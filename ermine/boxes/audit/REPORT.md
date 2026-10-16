# Box isolation audit

Defensive audit of `ermine/boxes` against chee's promise (10-15):

> "if i box something in a folder that i share, it's a choice i've made. i just don't want it
> seeing above that folder, it can look in that folder and place stuff".

So code given a box may read and write at or below the box's folder, and must not read or change
anything above or beside it (values, attributes, children, names, ids, changes, processes, status).
Whatever was deliberately boxed in is fine.

Tests: `ermine/boxes/audit/isolation_audit.ts` (run: `deno test --no-check --allow-all
ermine/boxes/audit/isolation_audit.ts`). `--no-check` is only because `start.ts`/`build.ts` have an
in-flight type error unrelated to this audit (see Finding 3 / Caveats). **9 tests fail (each pins an
open gap); 8 pass (held promises).**

## The root cause (Findings 1, 2, 4, 6 are one thing)

A box is `{ root, places }` with `places = hostPlaces.view(root, [processes(root), children])`. A
view re-roots the **same shared, id-addressed places**; it does not confine an id space. Every read
and the `view`/`walk` entry points take a raw `Id`, and an `Id` grants access wherever the node
lives. So containment holds only as long as no id above or beside the box is known. The suite
confirms (held) that reading *down* a box never surfaces such an id, so in a strictly closed world (a
process handed only its box, never an outside id) the box behaves. But isolation rests on
id-secrecy, not structure — a guessed, leaked, or well-known id (memory: the root is a device-id
document) escapes completely. The tests use the host root `"R"` as that stand-in id.

---

## Findings (ranked)

### 1. CRITICAL — `b.places.view(anyRoot)` re-roots the box anywhere
- **Exposed:** the box's own `places` object carries `view`. `b.places.view("R", [children])` returns
  an unrestricted places rooted at the parent/root; read or write anything.
- **Shown by:** `the box's places must not re-root above/beside itself (view)` — reads the sibling
  `tools` and the `secret` value beside the box.
- **Cause:** `view` is a public method on the shared places (places.ts `view`) and takes any root id.
  A box is itself just a `view`; nothing stops a further `view` to an ancestor.
- **Fix idea:** the box's handed-out `places` should not expose `view` (or should clamp it to roots
  reachable at/below `b.root`). Give boxes a narrowed facade — only the reads/writes a box needs —
  rather than the full host `Places`.

### 2. CRITICAL — `b.places` reads any node by raw id
- **Exposed:** `readValue`, `readKeys`, `readChange`, and `walk(path, fromId)` on `b.places` reach a
  sibling/parent when given its id; `readKeys("children", parentId)` even enumerates the names (and,
  with `get`, the ids) of everything beside the box.
- **Shown by:** `...must not read a sibling/parent by raw id (readValue)`; `...read a sibling's
  attributes by raw id (readValue)`; `...enumerate the parent's children by raw id (readKeys)`;
  `...read a node's change by raw id (readChange)`; `...walk from an id above/beside it (walk)`.
- **Cause:** same as Finding 1 — the places is id-addressed and shared; the root is only a starting
  point for path walks, not a confinement of the id space.
- **Fix idea:** the box facade's `readValue`/`readKeys`/`readChange`/`walk` should accept only ids
  the box has itself surfaced (track ids reachable from `b.root`, or require path-addressed reads at
  the box boundary and resolve ids internally). Decide this with Finding 1 — one facade fixes both.

### 3. HIGH — `programs.start` trusts a Way's ids; no containment check
- **Exposed:** `start(box, way, at)` reads `table.get("value", way.program.id)` and runs it, and reads
  each `chain` step by id, with no check that those ids sit inside the box. A `Way` pointing at a
  node beside the box makes `start` read and execute it.
- **Shown by:** `start must not read/run a program whose id is outside the box (crafted Way)` — a
  hand-built Way names the `secret` node as the program; `start` runs the host runner on the secret's
  value.
- **Cause:** `start` takes the `Way` as trusted. A real `Way` comes from `satisfy`, which is clamped
  (held), so normal use is fine; but `start` verifies nothing itself, and `createProcessAPI`'s
  `Context` additionally hands the program author the full `table` and `scheduler` (api.ts wraps them,
  but a host's own `createProcessAPI` need not).
- **Fix idea:** `start` should verify `way.program.at`/`chain[].at` resolve, in the box's places, to
  the given ids (reject otherwise), or only accept Ways produced by a `satisfy`/`openwith` over this
  box. Separately, narrow the `Context` so the default power is the box facade, not the raw table.
- **Caveat:** `start.ts` is being rewritten by another agent and currently calls `s.createScope()`
  with no `info`, which the live scheduler rejects (both "missing" and "empty"). The test wraps the
  scheduler to supply a neutral owner pair *only* when `start` passes none, so the gap can be
  exercised. **Recheck this test once `start` settles how it opens its owner scope.**

### 4. HIGH — `openwith(places, file, from)` takes the file id from the caller
- **Exposed:** `openwith` reads the given file id's type/attributes and yields ways to open it, with
  no check that the file is inside the box.
- **Shown by:** `openwith must not open a file whose id is outside the box` — opening the `secret`
  node (id handed in directly) yields a way via an opener placed inside the box.
- **Cause:** same id-trust as Finding 2/3; `openwith` is reached from the box but addresses the file
  by id.
- **Fix idea:** resolve the file through the box (require a path, or confirm the id is reachable at/
  below `b.root`) before reading its attributes.

### 5. MEDIUM (availability) — `satisfy` ways blow up factorially in a shared box
- **Exposed:** in a box others may place loaders in, one process can place many interchangeable
  loaders (each taking+giving the same type). Enumerating `satisfy` ways is then `~e·k!` — a DoS for
  any UI or caller that lists chains.
- **Shown by:** `satisfy's ways must stay bounded when many interchangeable loaders share the box`
  — 7 JS->JS loaders yield >=3000 ways (test caps the walk).
- **Cause:** `satisfy` enumerates every order of every subset of equivalent loaders
  (programs_bench.ts: breadth k ≈ e·k!). `start` only takes the first way, so this bites listing, not
  starting.
- **Fix idea:** collapse interchangeable loaders (same takes/gives/identity) to one representative
  when enumerating, or bound/paginate the generator; and let a box policy limit who may place
  loaders in a shared folder.

### 6. HIGH — the C code mirrors Findings 1, 2, 4 (not drivable through the harness)
- **Exposed:** `filesystem/places/c` — `pl_view(l, root, ...)` re-roots to any id; `pl_read`/`pl_change`/
  `pl_keys`/`pl_walk` are all id-addressed. `ermine/boxes/c` — `bx_create_id(host, id, parent, out)`
  places a box at any id (refused only when a `parent` is given, matching TS). Same root cause as 1-4.
- **Shown by (code inspection only):** the boxes harness protocol offers only path-scoped ops, so the
  id-level escape cannot be driven through it. `C: the boxes harness keeps the path-level promise`
  confirms the behaviour the harness *can* reach (a box path read sees no sibling) holds.
- **Fix idea:** whatever facade fixes the TS boundary (Findings 1-2) must have a C twin; keep
  `bx_places` from returning something with `pl_view`/id reads over the whole table.

---

## What held (8 passing tests)

- **Reads down never leak an outside id** — `get`/`gets`/`members`/`list`/`lookup` from inside only
  yield ids at/below the box; `lookup` up stops at the box root. (This is what the whole closed-world
  argument leans on.) *(`HELD: reads down the box never surface an id above or beside it`)*
- **`box`/`unbox` clamp inside the folder** — `../..`, `/`, leading-`/` addresses resolve within the
  box; writes never touch the host's sibling/parent. *(`HELD: box() and unbox() clamp inside...`)*
- **Nested boxes stay narrower** — an inner box does not see the outer box's own children, and a
  nested box made at `..` stays at its own root rather than climbing. *(`HELD: a nested box stays
  narrower...`)*
- **`createBox({id}, parent)` is refused** — a nested box cannot be pointed at an arbitrary id.
  *(`HELD: createBox by {id} with a parent is refused`)* (But `createBox(host, {id})` *without* a
  parent places a box at any id — that is the host's power, and needs `host`, which a box alone does
  not carry.)
- **Box watches are not told of writes beside/above them** — a `watchPath` inside the box ignores
  sibling/parent writes. *(`HELD: a box watch is not told of a write beside/above it`)*
- **`satisfy` is clamped to the box** — a runner placed beside/above the box is never a candidate.
  *(`HELD: satisfy from a box does not reach a loader placed above/beside it`)*
- **Process rows are per-root** — a process started at the host root is invisible to the box.
  *(`HELD: a box does not see a process started at the host root beside it`)*
- **C path-level promise** — the prebuilt C harness: a box path read sees no sibling. *(`C: the boxes
  harness keeps the path-level promise`)*

## Notes (checked, not bugs in the box itself)

- **Pins / status / why-nots are clean:** a process's `PIN` records `box.root` and box-relative paths/
  ids, and `satisfy`/`openwith` whynots only name candidates within the box (because the search is
  clamped). No outside id leaks through them.
- **Change headers can still carry outside data the host put there:** a box-internal write's header is
  the caller's (actor/site), but `metadata` is whatever the writing scope set — the box does not
  sanitise it. Not a box defect, but worth stating where headers surface to boxed code.
- **Build cache sharing is a host decision, not a box mechanism:** `createBuilds({ cache })` takes the
  cache folder id at setup; two boxes share a cache only if the host points both at it (by design —
  content-addressed, shareable). A box does not see the cache unless it is inside the box.
- **`b.places` also exposes host-shared hooks** (`onTableChange`, `release`, `hold`, `record`,
  `commit`, `eachEntryChange`, `describe`): these mutate or report state shared by all views. They are
  not id-escapes on their own (they need entries/keys obtained elsewhere), but they are more surface
  than a boxed program should have — fold into the Finding 1 facade.

## Caveats

- Run with `--no-check`: `start.ts` and `build.ts` currently call `s.createScope()` with no `info`,
  which fails type-check and runtime against the live scheduler (another agent is mid-rewrite of
  `start`). The `start` test wraps the scheduler to work around this; **recheck Finding 3's test once
  `start` stabilises** its owner-scope creation and its `(box | plain places, string at, {cwd})`
  shape.
- All id-based escapes (Findings 1-4, 6) require a known outside id. The report's position is that
  this is the finding: the boundary should not depend on id-secrecy.
