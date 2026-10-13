# fine-grained: which computations rerun when a node changes

LLM generated working output, 2026-10-13. An opinion that was asked for. Everything here is _mine_
and open; nothing in it is decided.

## My pick

- **Option 4, tracking on patch paths**, in the scheduler, as the only mechanism.
- Additions: spots keyed by address, not by node; a list splice that keeps the list's length marks
  only its span; table add/sub/del count as a patch at `[]`; one spot for reads of the change
  itself.
- Next to it, libraries that read the op stream: anchors (positions kept through edits), keyed
  lists, collection deltas, translators for mutate-nodes.
- The kernel gives the patches and nothing else. Facts go.
- Kept out of tracking: facts and chase (1); compare reads (2), used only as the test oracle;
  selectors built through the graph (3); each source's own tracking (5).

## The rule

A spot is `(source, id, path)`: a read the scheduler saw. A read of P is a deep read, because the
reader was handed the whole subtree at P and may have looked at any of it.

A patch at Q marks the spot P like this:

| patch                                  | marks P when                                             |
| -------------------------------------- | -------------------------------------------------------- |
| any, Q = P or Q under P                | always (the change is inside what P read)                |
| unranged, Q above P                    | always (P's value was replaced or removed)               |
| ranged at a list S, n in for b − a out | P = S+[i]+…, with i in [a, b)                            |
| ranged at S, any other                 | P = S+[i]+…, with i ≥ a                                  |
| unranged remove at S+[k], k a number   | P = S+[i]+…, with i ≥ k (a list removal shifts the rest) |
| move                                   | its take and its landing, each by the rows above         |
| ranged move inside one list            | i ≥ min(take start, landing start)                       |
| neither path a prefix of the other     | never                                                    |

The patch alone decides every row:

- A numeric key means a list, because apply refuses a number into a map.
- A put at a list index is always a replace (apply needs k < length), so it never shifts.
- A landing in a list holds the range's count, or 1.
- Strings and typed arrays are leaves: no path goes into them, so there are no index spots under
  them.
- No before-state is used, and no facts.

**Several patches in one update.** Each patch marks in its own coordinates. This stays sound because
every shift marks the whole suffix: a later patch can only disagree with read-time indices inside a
region that is already marked.

**Table events.** add, sub and del at (part, id) are a patch at `[]` for that key. A node under
several keys: the wiring marks each key (`table.who`).

**Reads of the change** (time, actor, metadata): one spot per (source, id) outside the value's
paths. Every update marks it.

**Why it never misses.** Under copy-on-write, the value at P is a new reference only when:

- a patch path is a prefix of P,
- P is a prefix of a patch path, or
- a shift moved P's index.

Those are the rule's rows. With the length rule, a list spot is marked exactly when its reference
changed. The one exception: a put of an equal value still marks.

## Against the uses

| use                                             | under the pick                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| walker of /a/b while /a/c is renamed            | The patch `{path:[d], move:{path:[c]}}` on a's children marks [c], [d] and readers of [] (names). [b] is untouched.                                                                                                                              |
| a read of nothing, then a put there             | The read (a's children, [x]) found nothing, and a put at [x] marks it. A path through a missing parent: the walk stopped at the missing step, and that step is the spot. A node not made yet: spots are by address, so the table's add marks it. |
| doc.title and doc.body, a keystroke in the body | `{path:[body], range}` marks the [body] and [] readers. The title reader is not marked.                                                                                                                                                          |
| paragraphs                                      | A paragraph per node (identity in ids), so typing touches one node. The paragraphs list node changes only on a split, a join or a move.                                                                                                          |
| cursors, selections                             | Positions are (node id, offset), kept by the anchors library. It maps them through each patch the way ProseMirror's StepMap does: start, size out, size in, a side. All of that is in the patch. This is not a tracking question.                |
| list append                                     | Marks [list] and spots at i ≥ n, of which there are none.                                                                                                                                                                                        |
| list insert at the front                        | Marks every index reader. That is right: index 5 now holds what was at 4. Rows read by node id are untouched, and a keyed map (Solid's mapArray, keyed by id) reuses them.                                                                       |
| big folder: 5000 names, 5000 open walkers       | A rename costs two lookups in the spot trie and marks no walkers. Names readers rerun, and their result did change.                                                                                                                              |
| streams as growing lists                        | Each append marks only the tail. The cost is copy-on-write, O(n) per append, not tracking. The fix is chunk nodes or the draft.                                                                                                                  |
| mutate-nodes (Automerge, mutable, Immer)        | The node kind gives ermine patches for what it did (Automerge's patch callback, Immer's patches, a recording proxy), or one patch at [] (node grain, but honest). No before-state is needed.                                                     |

## Where each part lives

| part                                                                     | lives                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| apply, invert, update, the op on the change, the update hook             | kernel (op, node)                                              |
| spots, a read-path trie per (source, id), the marking rule               | scheduler, in place of notify                                  |
| tracker links, rounds, cutoff                                            | scheduler (as planned)                                         |
| reporting each key a node is under; table events as `[]`                 | wiring (ermine.ts)                                             |
| a mutate-node's patches out: Automerge, Immer, a recording proxy         | that node kind's library                                       |
| anchors: cursors, selections, marks mapped through patches               | library, on the op stream                                      |
| keyed lists (by node id), selectors, collection deltas (filter, join)    | libraries, on top                                              |
| path-shaped reads from property access (a store-like proxy for programs) | library: turns `doc.title` into a read of [title]              |
| reads of shape only (keys, length)                                       | nowhere for now; a spot flag later if measurements call for it |

How precise the pick is depends on reads being path-shaped. A program that reads [] and then digs
through the value in JS gets node grain, so the program API should make path reads the easy way.

## What the kernel must give

Must (already true):

- apply exactly right; the patches that landed are the patches that were given.
- update keeps `op = { patches, undo }` on the new change.
- Positions in code points.

Must (small change):

- `each(patch)` with no facts, or one call per update with its patches, after the value is in. The
  wiring adds (source, id).

Must not have to:

- facts, the before-state, lengths beyond the splice, chasing, readers, queues, or more than the
  latest op.
- What can then go: `Fact` and `Facts` from op, `fact()` and `seq` from apply, the facts plumbing in
  update and places' `each`, the facts half of the C, and the scheduler's import of `Facts`.

Cheap, and keeps doors open (only if a consumer asks):

- **Undo grouped per patch.** apply already has the marks. With them, a library can learn "was it
  there" and "what was there" from the undo, without the before-state.
- **A snapshot flag on mutate-nodes.** The kind says whether what `get()` gives never changes once
  given. Reference cutoff and option 2 are sound only for snapshots. For other kinds, cutoff
  compares the change object, which is new on every update.

## Where each option breaks

| option          | places rename                           | nothing → put | title / body                  | cursors                | splices                        | big list or folder                                                        | hot node, R readers                | mutate-nodes                               | moves                                     |
| --------------- | --------------------------------------- | ------------- | ----------------------------- | ---------------------- | ------------------------------ | ------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------ | ----------------------------------------- |
| 1 notify        | ok                                      | ok            | ok                            | chase, inside tracking | exact                          | ok                                                                        | ok                                 | breaks: facts need the before-state        | chases through moves; moot if moves split |
| 2 compare       | ok (the array at b keeps its reference) | ok            | ok                            | not reads              | exact to reference             | O(R) per change: 10k index readers, every append                          | O(R · depth) lookups per keystroke | breaks for mutable values (same reference) | ok                                        |
| 3 node + cutoff | every walker of the folder reruns       | ok            | every renderer reruns per key | no                     | all rerun                      | 5000 walkers per rename                                                   | R reruns                           | works: needs only "changed"                | ok                                        |
| 4 paths         | exact                                   | exact         | exact                         | anchors library        | ≥ start; span when length kept | exact by name; a front insert marks every index reader (each one changed) | O(\|Q\| + marked)                  | their patches, or [] (node grain)          | take + landing                            |
| 5 source's own  | per source                              | per source    | per source                    | sync's (Automerge's)   | per source                     | per source                                                                | per source                         | it is them                                 | per source                                |

Where each option breaks, beyond the table:

- **1.** Facts are hidden state computed in kernel space, in two languages (~680 lines of TS + 1250
  of C today). Chase and kinds only matter if positions inside a node are identity, and the lean
  puts identity in node ids.
- **2.** Each read keeps what it got, which keeps old values alive. It is unsound under mutable
  sources and under an open draft. The pick does equally well for every use above, and its cost
  grows with the readers of the node, not with what changed. It makes a good oracle.
- **3.** Fine grain has to be built on top, as selectors. If computations depend on each other only
  through the graph (open in plan.org), each selector output is a node write: stored, synced, a run.
- **5.** N mechanisms, invisible as graph data, no C. Automerge's and Immer's reports are patches
  anyway, so they feed 4.

## Cost per change, the pick

- **Kernel:** apply as now, minus one `fact()` walk per patch.
- **Wiring:** `who(node)`, usually one key.
- **Scheduler, per patch:**
  - one Map get for (source, id);
  - |Q| trie steps;
  - each spot under Q, all of which are marked;
  - for a ranged patch at a list, the numeric kids ≥ a (kept sorted, or scanned when few).
- **Total:** O(|Q| + marked). Readers of the node that the patch does not overlap cost nothing. A
  node read only at [] has no trie, only a spot.
- **Memory:** one trie entry per distinct read path per node (shared by everyone who reads that
  path), and one tracker link per (reader, spot).

R = readers of the node, m = marked:

| per change      | 1 notify                        | 2 compare                    | 3 node | 4 paths                     |
| --------------- | ------------------------------- | ---------------------------- | ------ | --------------------------- |
| kernel, extra   | facts per patch                 | none                         | none   | none                        |
| finding readers | O(\|Q\| + m), plus chase upkeep | O(R · depth)                 | O(R)   | O(\|Q\| + m)                |
| reruns          | m (kinds let some skip)         | exact to reference           | R      | m, about exact to reference |
| kept per read   | read record, trie entry         | link, path, the value it got | link   | link, shared trie entry     |

A practical note: the places trie (core/places/typescript/trie.ts) takes only string names. Numeric
keys need a key type, or a string form, before it can hold read paths.

## Prior art, weighed

- **Solid stores.** A signal per property read, made on first read, plus a keys trap. The pick is
  the same granularity without proxies, read off the patch instead of the setter. Solid needs a keys
  signal because mutation keeps the parent's identity. Copy-on-write changes the parent's reference,
  so ermine's deep read already covers keys; a shallow flag would only add precision.
- **MobX.** An observable array is one atom (coarse), and deltas come through `observe()`. That is
  the same split as here: tracking that is coarse enough, plus an op stream for whoever wants
  deltas.
- **Immer.** `[path, op]` patches and inverse patches. List adds and removes are by index, with no
  ranges and no moves. They translate one to one into ermine patches.
- **Automerge.** Patches: put, del (with a length), insert, splice, each with a path. They translate
  directly. JS text indices are UTF-16, so turning them into code points walks the string (walk.ts's
  converters).
- **Incremental, Adapton, self-adjusting computation.** Node grained with cutoff. The programmer
  picks the grain by where the cells are; in ermine the cells are nodes, and the pick adds path
  grain inside a node. Incr_map diffs maps by their shared subtrees (option 2, generalized). ermine
  has the patch itself, which is cheaper.
- **React selectors, useSyncExternalStore.** Store-level subscribe, so every selector runs on every
  change: O(subscribers). react-redux with thousands of connected components is the known cost of
  option 3.
- **ProseMirror, CodeMirror.** Positions are mapped through a map built from the change alone
  (start, old size, new size, with assoc choosing the side). No document is needed. An ermine patch
  carries the same information, and that is the anchors library.
- **Differential dataflow.** Changes as (record, ±1). A collection library over big folders would
  turn patches into those deltas.

## What I'd measure before deciding

1. **Read shapes in the demos:** per node, how many readers and how deep their paths are; what share
   of reads are at [], at depth 1 (places), and deeper. If nearly all are [] or [name], the trie is
   just a Map and the decision costs little.
2. **Wasted reruns:** of the marked reruns, how many end equal (cut off), grouped by why they were
   marked (above, ≥ a). This says whether a shallow flag, or option 2 as a pre-check, would pay.
3. **Typing:** µs per keystroke into doc.body with 10, 100 and 1000 readers of other fields, under
   options 2, 3 and 4.
4. **Folder:** 5000 names, 5000 open walkers, one rename, under 3 and 4.
5. **Streams:** 10k appends with one whole reader and 100 index readers. How the time splits between
   copy-on-write and marking; then the same with chunk nodes or the draft.
6. **Front insert:** into an inline list of 10k with 10k index readers, against 10k row nodes and a
   list of ids.
7. **Memory:** trie entries and links per read, against option 2's links plus kept values.
8. **C:** the same cases, the trie walk against today's notify.

## What I think is missed or underweighted

- **Spots by address, not by node object.** A read of a node that is not there yet has no object to
  hang on.
- **Table events.** sub at a key replaces the node, and readers there must rerun.
- **One node under several keys** (allowed). A change reaches readers under every key.
- **Reads of the change** (who, when, metadata) are not value paths.
- **Mutable values break reference cutoff,** not only facts. Cutoff needs "a snapshot", or the
  change object, per node kind.
- **Pruning spots** when their last reader leaves. The tracker's `end` drops links but tells no one;
  either the tracker reports a spot left empty, or the patch walk prunes lazily.
- **Visibility.** Why something reran = (your read path, that patch, that change), all plain data.
  Kept at mark time, it gives the faithful trace in plan.org's "wanted, later" for free.
- **Conformance.** The rule is a pure function of (patch, read path), so it fits JSON cases shared
  by TS and C. Fuzz it with option 2 as the oracle on copy-on-write values: what is marked must
  include everything whose reference changed, and for lists under the length rule be equal to it,
  apart from puts of an equal value.
- **The draft** (open across changes until someone reads) is orthogonal to the pick, and it breaks
  option 2. Reads close the draft, so what any reader holds is frozen and reference cutoff stays
  sound. The draft pays only if storage and sync read at the end of the round.
- **Lone-surrogate joins.** Anchors can be off by one at a join. The undo widens over the pair, so
  the anchors library can see when it happened.

## The main risk

Path grain pays only where data is split into nodes along identity: rows, paragraphs, chunks.

- A program that keeps a big structure inline in one node gets its container readers rerun on every
  change inside it. That is honest but coarse.
- It also pays O(n) copy-on-write on every change.
- The fix is data modelling and chunking helpers, not more tracking machinery.
- If measurement 2 shows many shape-only readers (length, keys) over hot containers, the way out is
  a shallow flag on a spot. It can still be decided from the patch and the key type, with no
  before-state.

## Checked against what's decided or leaning

| decided or leaning                               | the pick                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| the graph holds no queues                        | Marking happens when the change arrives. Op-stream queues are libraries'. |
| only the latest op on the change                 | Nothing needs the op history.                                             |
| runs are writes                                  | Unchanged. Fewer spurious reruns means fewer writes.                      |
| identity in node ids (lean)                      | Leaned on: positional over-marking is honest, and chase goes.             |
| a move may become delete + add locally (lean)    | No effect on the rule.                                                    |
| the scheduler imports the tracker and op's types | The `Facts` import goes; it needs only `Patch`.                           |
| places reports every read, including of nothing  | Those reads are the spots.                                                |
| ops are local, merging is sync's                 | Sync's changes arrive as patches, or as one patch at [].                  |
