# tippet wire

What a C implementation sends and checks. cbor: canonical, as `core/encoding/typescript/cbor.ts`'s
header says (vectors in `core/encoding/conformance/cbor`). Whole numbers below: integers, 0 to
2^53 - 1.

## step

One kept write. Bytes: a cbor array.

    [device, n, before, node, part, patches, lamport, when, seq, on, ids]
    [device, n, before, node, part, patches, lamport, when, seq, on, ids, who]

- device: bstr, 32 bytes. the writer's ed25519 public key
- n: whole, from 1, per device, one more each step
- before: bstr, 32 bytes, the hash of this device's step n - 1; null at n = 1
- node: tstr without NUL, the node's id; or [rest]: relative to the writer, the id `ermine:ed01` +
  device's hex (ids: key) then rest, rest a tstr, empty or from `/`. a writer writes a node that is
  its own id or under it so; read back to the same id
- part: tstr without NUL. `value`, `attributes`, `children`, …
- patches: array of patch maps
- lamport: whole. one past the highest any step the writer had seen has. it orders steps (an entry's
  order, puts), and sorts no element
- when: whole. seconds since 1970, the writer's clock
- seq: whole. how many elements its device's steps before it insert (a patch with a range inserts
  its tstr value's code points, its array value's items; a list move, the items it moves): 0 at n =
  1, else step n - 1's seq plus what step n - 1 inserts (a step that says another is not a chain).
  seq plus what the step inserts: at most 2^53 - 1
- on: array. what it was written on: its entry's (node and part) heads at the writer, each a step:
  - k, whole from 1, k < n: this device's own step n - k
  - [device, n]: another device's step n; device bstr 32, not this step's; n whole from 1

  what is made of it: `typescript/history.ts`, heads and versions
- ids: array, one per patch: the container it changes, and the elements it names:
  - [container, pred]: a put or removal at a key, or of the whole value
  - [container, pred, element]: a put at an index of an array
  - [container, after, gone, before]: a splice (a patch with a range, into a string or an array); a
    removal at an index of an array (a path, no range), where after is null, gone the one element
    and before null; a list move, where gone is what it moves
  - container: the node of the map, array or string the patch changes (a key put or removal: the
    map; an index: the array; a splice: the sequence); null for a put or removal of the whole value
    when the writer holds none. a reader finds the container by this id, not by the patch's path,
    which it reads only to the last key or index (its length is not looked at)
  - node: `[device, n, i, rel…]`: the step that made it (device, n), its patch (i), and its place in
    that patch's value (rel: tstr, a map's key, or whole, an array item's place when the array was
    made; at most 1021 of them, mine, not decided: C walks a node 1024 parts long). a put's value is
    `[device, n, i]`; an item a splice inserts is `[device, n, i, x]`, x its place in the value it
    inserts. made once, never changes, a move keeps it. written: this device's `[n, i, rel…]` (n
    whole from 1 to the step's; the step's only with i below the patch's own index), another's
    `[device, n, i, rel…]` (device bstr 32, not this step's)
  - pred: array of nodes, the cells the patch replaces (assignments, below)
  - element: the array item a put at an index replaces: an element id
  - after: the element it goes after, or null: the start
  - gone: array of [id, count], count whole from 1: the elements it takes away, count of them from
    id on (its seq or k on). one named more than once is taken away once. a list move's: the
    elements that show the items it moves at its writer, in the array's order (a run that goes back,
    one by one), their counts summing to the items it moves
  - before: the element it goes before, the one right after after at the writer (gone ones too): an
    id; true, after's own before (after not null); null, the end
  - an element id: made by a step, its device and seq: the step's seq + i, the i-th element the step
    inserts (from 0, in patch order); or there since a step made its sequence's node: that step's
    device and n, and k, its place then. written: this device's x, whole or negative, seq the step's
    seq - x; or [x, k], x whole below n, that step n - x. another's [device, seq] or [device, n, k]
    (device bstr 32, not this step's; n from 1)

  a sequence's elements are counted from its first splice: those there since the step that made its
  node are that step's, k their place. a container whose maker's step has not landed: the step
  doesn't apply (it applies once that lands). a container removed or replaced is trash (below), so
  the patch applies there. with trash only a forged id reaches a path of cells and places that leads
  to none: the patch is skipped, the rest of the step applies. a removal at an index of an array is
  a splice of that one element, taken away wherever its item is now (gone already: nothing)

  list move (a patch with a range [j, j] and a move; the only kind of move a step has, and a step
  may hold several): one item of an array ({path: the array, range: [j, j], move: {path: the array
  and the item's place}}) or 1 to 4096 of them (move: {path: the array, range: [a, b]}), to the gap
  j, counted in the array without them. its ids are a splice's: it makes as many elements as it
  moves, after and before as a splice's, gone at first, and they show an item by its register
  (below). a move of a key, of an item to another place than its array or of a span of a text is no
  step: a span of a text is a removal and an insertion (chee, 11-01), so typing into the span
  meanwhile is dropped, written so by a writer; any other the writer puts the whole value instead
  (unkept). a list move that moves nothing at its writer is not written

  items and registers (Kleppmann 2020's move register, as Da and Kleppmann 2024 use it for lists):
  - origin: the element an item was inserted as, its own or a splice's. every element a move makes
    for an item is linked to its origin (a run of new elements to a run of origins, one on each).
    cells (assignments) and the containers an item holds are by origin, so a put at an item, a pred
    and an edit into it follow it wherever a move puts it
  - register: per origin, the event with the greatest stamp (the step's lamport, device, n, then the
    patch) shows: a move shows the element it made for the item, a removal (a splice taking away an
    element of the item, a removal at an index) shows none. every other element of the item is gone.
    an origin with no event shows as it was inserted. the later in the order wins, a move or a
    removal (chee, 11-01): a removal later than a move takes the item away wherever the move put it,
    a move later than a removal brings it back with its value, and what was typed into it meanwhile.
    ranges are runs: origins one on, one stamp, their new elements one on
  - the effect of an event is a register (the greater stamp stays), so moves and removals go in as
    is in any order, late ones too. a move that loses makes its elements, gone
  - an item taken away holds its value for a move to bring back: with the trash (below), a scalar
    too. a move that finds none (the host emptied it) brings back nothing, on that device alone
  - cost: a move's step is 144 to 156 bytes stored (a by-place move 129 to 133) and about 62 packed
    (was 38). C on a device that forgets: a move of one item holds 321 bytes (was 126): its source
    run cut in two, its new run 40, a register 56, an origin 32 (the elements it made are linked to
    their item by a table, so a run stays 40 bytes), and the run index (32 a run) once the list has
    more than 32; ten items 410 (was 787); a range of 4096 of 8192 at once 400, a run and a
    register, not an item each. the same item moved again and again holds 169 bytes a move for good
    (was 157): each move leaves its new run and origin, and its gone runs stay, since another device
    may name any of them; its register is one (the origin's) and is taken over, not added. a removal
    at an index or of a range of an array holds a register (56) beside its cut runs and its piece; a
    string holds none

  assignments. a put or removal at a slot (a key of a map, an element of an array, the root) makes a
  cell, [cell id, node]: the cell id is the node id of what the patch made there,
  `[device, n,
  i]`, a scalar's too; a key a put's value holds has the cell its put made,
  `[…, key]`, and needs no record until a patch assigns at it. a cell is visible until an assignment
  names it in pred. many cells at a slot are all visible, a multi-value register: what a read shows
  is the one with the greatest id (its step's lamport, device, n, then its patch), readAll shows
  all. pred holds every visible cell at the slot the writer holds, hidden ones too, so one honest
  put or removal clears them all. a container item a splice inserts has a cell and is named in pred
  as any; a scalar item has none, and any put at its element supersedes it (its writer saw it). a
  removal names what it saw and takes away only that: a cell it did not name stays visible. an edit
  into a container of a cell that does not show applies to that cell's held value; when the cell
  shown goes, the next greatest shows with it. a cell named before it landed is held at its slot
  (`named`) and is not visible when it lands (a container it holds is trash); a name whose step has
  landed and whose cell is not at the slot is ignored. the effect of an assignment is a set (cells
  in, preds out), so one goes in as is in any order. a pred hides only a cell of a lesser step
  (lamport, then device), at a key as at an element, mine, not decided: an honest pred names cells
  its writer saw, which are lesser, so a put at an item never removes it; preds that name each other
  leave the greater cell, in any order (a name held for a cell not landed keeps its greatest namer).
  `readAll` shows conflicts only: `history.versions(node, part, path)` is the cells at the path, the
  shown first, each from the step that made it (a key its parent's put made, with no cell of its
  own: that put's); every device, keeper or forgetting, returns the same. `typescript/reading.ts` is
  the feature for @ermine/system's `onRead`, adding all but the first (read's own)

  trash (chee, 11-02: removals hide; only the host empties; readAll never shows it): a container a
  put replaced, a removal or a splice took away, or that landed after a pred named its cell, is held
  hidden with its value and what is under it (sequences, cells, held values), like a cell that does
  not show. a read, readAll and versions never show it. a patch naming a container in trash applies
  there, to its held value, so a step applies whole; so does a put at an element gone (an item a
  move may bring back, below). a scalar replaced or removed in a map leaves nothing. tippet never
  lets go of trash itself and never decides it from what other devices hold: a device cannot know
  who still writes into a removed container (documents travel through a server, then peer to peer,
  then a stick). a device that forgets holds trash too, and its snapshot does
  - empty: the host lets go of trash: `history.empty()` in TS, `tp_history_empty` in C. every
    container in trash goes with what is under it; the count returned is every container in trash
    before, those under another included. a patch naming a container emptied is then skipped on that
    device alone, the rest of its step applying. values agree after honest steps, since trash never
    shows; a malformed patch into emptied trash (a splice naming a map) fails where trash is held
    and applies where it was emptied, so values can differ then. keeping each emptied container's
    kind would close that, and is not built
  - trash(): `history.trash()` in TS, `tp_history_trash` in C: how many values are in trash (cells
    in trash, the values held for items gone, in their cells or in pieces, a scalar's too) and the
    bytes they hold, so a host can decide when to empty. TS counts the contents of the values; C
    counts memory, each cell and value, a value shared with the graph's structure whole
  - mine, not decided: a pred naming a cell already in trash is ignored. an item a splice or a move
    leaves gone holds its value (a move may bring it back): in the cell that shows at its slot, if a
    patch assigned there, else in a piece of the origins (a cell is made for a container when a
    patch names it). a put at a gone item assigns as at one that shows, pred and cells, a scalar
    too, its value held by the cell that shows and the graph not written; a move brings back the
    cell that shows, the piece only when the slot has no cell. emptying lets all of these go. no cap
    on trash (a cap would make readers differ). a keeper marks the newest step each entry had at an
    empty, and working the entry out again applies steps up to it without making trash, so a late
    step does not bring back what was let go; the mark is not in a snapshot, so after a reload the
    trash may come back
  - cost, C on a device that forgets: a container removed or replaced leaves its cell, 40 bytes and
    its id (17 for a key of five letters, 57 in all), and its value, which stays alive, outside the
    library's heap counter (tp_mem): a map `{"x": n}` is 208 bytes. a put of the whole value leaves
    the old root so, and the old value with it: a dens-style map of 87 bytes (five keys and one
    nested map) put again and again costs about 0.9 KB in trash a put counted by `tp_history_trash`
    and about 1.1 KB resident, until the host empties. the library's own heap sees 77 bytes a put.
    an item taken away holds a piece: a number removed from a list holds 274 bytes in the library's
    heap (126 for its runs; 56 a register, the rest its piece, which names its list), and its value,
    which stays alive, is in `tp_history_trash`

  applied in the entry's order (history): a splice takes its gone elements away (an array's items:
  an event on each one's register), then its first inserted one goes between after and before, among
  those put there since (FugueMax's rule), the rest each right after the one before. a list move's
  new elements go so, gone, and the events of its items then show them:

      at = spot = right after after; scanning = no
      loop:
        unless scanning: spot = at
        at before, or the end: stop
        e = the element at at; a, b its after and before
        a before ours: stop
        a ours: b ours and e sorts below ours: stop
                scanning = b before ours
        at = the next element
      it goes at spot

  places as they are now, gone ones too; the start before all, the end after all; how a reader holds
  elements (in runs, however cut) never changes where one goes. an element's after and before: its
  splice's, but after the one before it when its splice put that one too; one there since a step,
  after the one before it (the first, the start), before the end. sorts: by device, then seq (one
  there since a step: that step's device, before what the step inserts), greater first, so two at
  one place land the same whatever came first. an element it names not there (this device's seq past
  the step's too), or a before not after its after: the step doesn't apply (passed over, as any).
  what is made of it: `typescript/elements.ts`

  a reader that forgets: holds per entry its sequences' elements, the cells assigned and still
  visible (about 40 bytes of cell and its id in C, a hidden one and its value more), `named`, the
  newest step of each device that landed, the registers of its arrays' items, and the graph's value
  (no steps, no second value), all in its snapshot too. it ends at the same value as a reader that
  holds every step. a removal of a scalar leaves no cell, and a put replacing one leaves one; trash
  (above) stays until the host empties it.

  snapshot (mine, not decided): `v` 1, the format (a value is `[v]`, so a whole value of null is not
  none); a snapshot with no `v` is read as before it (a value, null for none). `failed`, when there
  are any, for every reader: [device, n, node, part, lamport], lamport null only for a step that
  could not be read; they come back with why "failed before a reload", so after a reload a late step
  still lets the failed steps after it be tried again. a snapshot a reader refuses is let go and
  every step the log holds lands, its host told. the emptied mark is not saved, so after an empty
  and a reload a failed list can keep a failure the device had cleared by skipping into emptied
  trash (only a stale or malformed step does that). cut: the log has let go a device's first step,
  however it was dropped (`forget`, or the log's `drop`, or a reload), asked of the log each time

  a late step (ordered before a step applied) on a reader that forgets:
  - goes in as it is: a put, a removal, an edit, a splice, a list move commute (cells, preds,
    elements and registers)
  - else the entry is worked out again from every step of it the log holds, once the run landing is
    in: so too a late step that doesn't apply as it is, and one that applies in an entry with a
    failed step ordered after it
  - after a cut (the log has let go any device's first step): no entry is worked out again. a late
    step needing that fails (late, and the steps after it let go); a step with nothing of it in the
    value, its container gone, fails too (`failed`, so a host sees it); when a failed step of an
    entry is ordered after a late one, the failed steps of its entry are tried again as they are, on
    that reader alone: its value can differ from then on

  what is made of it: `typescript/history.ts`
- who: tstr, only when there is one

Anything else is not a step: another length, another kind in a place, a key or hash not 32 bytes, n
of 0, a number not whole, a patch with another field, a node array not one rest, an on item not as
above (k of 0 or of n or more, a pair naming the step's own device, of another length or kind), a
seq past 2^53 - 1 with what the step inserts, ids not as above (not one per patch, null on a patch,
a container null on a patch but a put of the whole value, a move that is no list move or whose
elements don't sum to its items, a node of another shape or naming the step's own device whole or a
step past its own, an n of 0 or past the step's, a pred that is not an array of nodes, an element
missing on a put at an index or there on another, a before of true with a null after, an id of
another shape or naming the step's own device, another's seq below 0, a number past 2^53 - 1 either
way, an [x, k] with x of n or more, a [device, n, k] with n of 0, a count of 0, a removal at an
index whose ids are not no after, one element once and no before, another length), a NUL in node
(its rest too) or part, or containers nested 1024 deep (cbor's most; the step's own array counts): a
run message holds a step's patches one deeper.

ids' shape is mine, not decided: per patch beside it, so a patch stays a changeable patch (squish
packs it); an element its device and seq (diamond-types), unique by its device's chain alone.

a container id is mine, not decided: a patch names the node it changes by the patch that made it, so
what a reader holds is keyed by id and no place is held (a node never changes its id; a move keeps
it); the path stays as the changeable patch has it. this device's node is written by its step n, not
how far back, so typing into one text is one run in a pack.

list moves are mine, not decided (after Kleppmann, "A highly-available move operation for replicated
trees", 2020, and Da and Kleppmann, PaPoC 2024): a move keeps its item (its slot, container and
cells), so an edit, a put and a pred follow it and an insert beside its old place stays beside it;
it makes new elements for FugueMax to place and a register per origin to show one. what a move takes
of a run is an event on a register, and the trash and pieces above hold the values an item gone had
(a scalar's too). a move of anything else than an item or items of an array is put as the whole
value by its writer (unkept), and one that moves nothing is not written. a move that finds the value
of the item it brings back let go (emptied) takes the register and shows nothing there: values can
differ from devices that hold the trash.

cells are mine, not decided (after Da and Kleppmann, "Extending JSON CRDTs with Move Operations",
PaPoC 2024): every assignment names the cells it replaces, so puts commute and none is lost at a key
to one that did not see it; a held value per hidden cell has no cap (a cap would let readers
differ). `named` costs a cell (about 60 bytes in C) for each name whose cell never lands, held for
good. a pred naming a device a C reader does not know adds its 32-byte key to the reader's device
table for good.

seq is mine, not decided: written after when, the numbers about a step's place together, so no log
need count it: a run is taken with step n - 1 held (its seq and what it inserts give the next); the
pack has no column for it.

sorting by device and seq is mine, not decided: lamport made runs cut whenever a write elsewhere
came between keystrokes; device and seq (Fugue, Yjs: the replica id) cost no run.

a write that can't be named is mine, not decided: a write here whose container or elements its
entry's state can't name (they differ from the graph's, as when host code updates twice before one
commit) goes as the graph's whole value for the entry, one put, which starts the entry's state
again, so later writes name ids; the host is told in `unkept`.

forgets is mine, not decided: a late splice by ids commutes (FugueMax), so it needs only the
elements, which its snapshot holds; the rest is rare, so the log is read for it. elements cost a
forgetting device about 40 bytes a run in C, typing one run, and 32 more a run in a sequence of more
than 32 runs (its index).

before and FugueMax are mine, not decided: Weidner and Kleppmann's FugueMax, in its list form
(Gentle's YjsMod), so it works on the runs as held; naming before, two typing at one place don't
interleave, in any direction.

devices is mine, not decided: a table per pack, so a pack reads on its own and a stored run is its
pack; a key named once costs nothing (no table), each time more 1 byte (was 34). by turns, 3
devices, bursts of 10: 3 bytes a keystroke packed (of 23); bursts of 1: 23 (of 183). a key's index
in a device's chain would cut more, and a device that forgets would hold it.

the bytes close is mine, not decided: 32 keystrokes (110 to 200 bytes a step) share a run and a
signature: 200 keystrokes at the end, 12.8 bytes a keystroke stored (was 19.0), 6.0 packed (was
8.1). 16384 is past a keystroke burst and keeps the worst run a peer takes small: a fresh C peer
takes a 16384-byte run in about 33 KB of heap (31 to 33 KB for steps of 500 to 8000 bytes), and a
message of that size; with no byte close, 32 steps of 4 KB took 392 KB. one close for everyone: a
run once closed is never cut, so a close a peer could ask to be smaller would strand it on every run
closed before it asked.

on's shape is mink's pick (10-26), not decided: heads by device and n, as the log finds a step (its
chain binds n to its bytes), not by hash; this device's own as how far back, and runs in a pack.

patch: a map, only the fields it has.

- path: array of tstr or whole
- range: [from, to], two wholes. optional
- value: any value. optional
- move: map {path, range?}, the same rules. optional. a step has a list move only

hash: blake3 (32 bytes) of the step's bytes. Bytes are never encoded twice: a step is its bytes.

## runs

A device's steps travel in runs: from some n to a signed n.

- closed: by the writer, when 32 steps have been written since the last close, or before a step that
  would take its steps' bytes past the close, or when a peer asks for the steps of an open one (it
  is closed at the latest step, in runs within the close). a step alone may be past it
- close: 16384 bytes of steps, unpacked, for every device
- sig: ed25519 over the 32-byte hash of the run's last step. one per run; the chain vouches for the
  steps before it
- never cut or joined: a run's end is fixed once signed. anyone passing it on sends it to that end
  with that sig; a peer holding its start is sent only the rest
- at most 2^24 bytes (16 MB) of steps, all told, the first whole one too: the writer closes its run
  before a step that would take it past, and writes no step past it alone. a taker may take less (a
  host's setting, `max`: `typescript/sync.ts` createSync, `c/tippet.h` tp_sync_options), never more;
  a run past it is refused `bound`

Taking a run, in order:

1. own device: refused
2. first n past held + 1: a gap, answered with have
3. steps already held: passed over when the run's step at the lower of its last and the count held
   is the held one; else a fork (forks): refused, `fork` (`own` for this device's)
4. each step: its device the run's, n one more, before the hash of the one before, seq the one after
   the steps before it
5. sig good for the last step's hash

Fail 1, 4 or 5, or a pack that does not unpack: refused. a pack not shaped as below (columns, its
first whole from 2 or a step), or whose later steps are not steps, is refused though every step of
it is held.

That nothing else is checked is mine, not decided: whether a run is taken hangs on the run and its
device's chain alone, so a run good once is good anywhere, any time. no lamport check: one far past
what is held is taken (holding an id is the permission for now, and one who can write can do worse).

## messages

Each a cbor array. Anything else is dropped, silently.

    ["have", [[device, n], …]]
    ["run", device, sig, pack]
    ["live", id, data]
    ["refused", device, n, why?]
    ["fork", device, sig, pack, sig, pack]

- have: per device, how many steps the sender holds through its last signed step (its own: all).
  sent first on every link. answered with runs of each device the other side lacks, from its n + 1.
  at most 4096 devices (C: the log's `tp_limits.devices`, a host's setting; TypeScript takes 4096):
  a longer one is dropped
- run: device 32 bytes, sig 64 bytes, pack as below
- live: id 8 random bytes, data bstr. never kept. ids lately seen (1024) are dropped; a relay sends
  it to its other links
- refused: device 32 bytes, n the refusing side's count of it. that device is sent no more on that
  link. why: text, `bound` for a run past what the refuser takes; `memory` for one it had no memory
  for (C only): not for good, below; none otherwise. both sides' hosts are told, once a device a
  link (`typescript/sync.ts` onRefused, `c/tippet.h` tp_sync_options refused)
- memory: the writer counts the device as holding n (the refuser's count), so a peer that lets go of
  what its links hold keeps what this one lacks, and sends it no more of the device until the
  refuser's next have or a newer step of the device; the refuser, until it takes a run of the
  device, answers no gap with a have, so a pipeline of runs makes one try, not a loop. its host is
  told again after each try
- fork: device 32 bytes; two runs of it, each a sig and a pack with its first step whole (bstr), as
  runs; a proof (forks). dropped when it does not check. sent on every link but the one it came
  from, and after have on a new link

## forks

Mine, not decided. A device that signs two chains, differing from some n on: its key in two places,
a backup restored and written on. Nobody is told by a refusal on one link; a fork is.

- proof: two runs of one device, each as `fork` says: a pack whose first step is whole, its steps
  one after another from n, each before the hash of the one before, seq the one after the steps
  before it, sig good for the last's hash. the two start at the same n, with steps of another hash
  there (the chains differ at n, and may differ before it: n is a step where they differ, not the
  first). checked by whoever gets it, from the message alone: it holds neither chain or one
- found: taking a run whose first n is at most held, m the lower of its last and the count held; its
  step m has another hash than the held one. the proof: the run from m to its end, and the held run
  from m to its signed end (every held step is in a signed run, this device's own closed first).
  nothing of what is held is read, and no open run is closed, until the run's own steps follow one
  another and its sig is good; a run that fails that, meeting the last step held with another hash,
  is refused `signature` (a pack against a step held that is not the writer's), and meeting an
  earlier one is passed over, as before: not a fork, and as cheap as before
- held: a proof only for a device the taker holds steps of, and at most 2^25 bytes of steps in all
  the proofs it holds (past it, dropped: a run that would make one is refused `signature`)
- told: the proof goes to every link but the one a `fork` came from, and, when a link says in its
  have that it holds steps of the device, to it (once); once a device: a second proof of it is
  dropped and not passed. it goes with the lower hash first, as made, whichever order it came in. a
  link has the proof only once one has checked: a `fork` that does not check stops nothing. a taker
  lists it for its host: `typescript/log.ts` forks and onFork, `c/tippet.h` tp_log_forks, and the
  `sync` node's forks
- answered: a run refused `chain` or `signature`, its first n at least 2 and step n - 1 held, is
  answered with the taker's own run of that device from n - 1, a pack with its first whole, once a
  device a link, unless a fork of it is known. the other side meets steps of another hash there: the
  fork is found. a run from n shows nothing of step n - 1, so the taker is the one to show it
- nothing is decided: the held chain stays, a run of the other is refused (`fork`), the device is
  not stopped. whether to freeze it, pick a chain or show both is the host's. a fork is not held
  past a restart: found again when a run of the other chain meets
- not found: two peers with the same count of a device, each its own chain: have says counts only,
  so nothing is sent and nothing meets, until one holds more

## pack

A run's steps, small.

    [first, lamport, when, node, part, who, count, columns, on, ids]
    [first, lamport, when, node, part, who, count, columns, on, ids, devices]

- first: whole n, from 2: step n is packed against step n - 1, like the rest; or bstr, the first
  step's bytes, whole (at n = 1)
- the rest: one entry per step after step n - 1 (or after the whole first), each a runs list
  `[value, count, value, count, …]`, count whole and at least 1
  - lamport, when: the step from the one before (when may be negative)
  - node: as in a step (tstr or [rest]); part: tstr
  - who: tstr, or null for none
  - count: how many patches the step has
  - on: the step's on; another device's n as the difference from the last n this column gave that
    device (from 0, may be negative), so typing by turns makes runs (mink's pick: two typing by
    turns, 38 bytes a step packed without it, 4 with)
  - ids: the step's ids as written
  - key (a device's, in on or ids): whole (bstr, 32 bytes), or 1 byte: its place in devices
  - seq: none: the one after the steps before it (the whole first's, or step n - 1's)
- columns: every later step's patches, in order, as below
- devices: array of 1 to 256 keys (bstr, 32 bytes): the keys of on, then of ids, in the order first
  named (so TS and C make the same bytes); one past 256 stays whole. a writer adds it only when its
  pack is shorter with it (not when equal); a reader takes any valid table. an index past it, a
  1-byte bstr with no devices, a bstr of another length: not a pack

Unpack: for each step after step n - 1 (the receiver's) or the whole first, from the one before
(prev):

    [prev.device, prev.n + 1, blake3(prev bytes), node, part, the next count patches,
     prev.lamport + lamport, prev.when + when, seq, on (each difference added back), ids (, who)]

encoded canonically: the same bytes the writer made, so chain and sig check as ever.

Refused before anything is made: not 10 or 11 elements, devices not as above, first neither bstr nor
whole from 2, 4096 or more steps in the columns (none, when first is n), more than 65536 patches, a
column of another length, counts not summing to the patches, an on or ids entry not an array. A step
it makes that isn't one (an n added back to below 1, a seq past 2^53 - 1 with what it inserts, ids
not as a step has them): refused. Steps that make more than the taker's max (at most a run's 2^24
bytes): refused `bound` once they do, nothing more made.

Step n - 1 not held: past what is held, a gap (answered with have); all steps held, passed over;
else held but not to be read (forgotten), refused, never guessed.

## columns

squish's (`lib/changeable/typescript/squish.ts`): a map.

- paths: array, each distinct path once, in first-seen order
- path: runs: per patch, its index in paths
- shape: runs: per patch, 1 has range | 2 has value | 4 has move (0 to 7)
- from: runs: per ranged patch, range's from minus the last ranged patch's from (0 at first); may be
  negative
- size: runs: per ranged patch, to - from
- value: array, per patch with a value, the value
- move: array, per patch with a move, the move map

## http long-poll

Frames: a 4-byte big-endian length, then a message; back to back.

    POST url/send?link=<id>&ack=<k>&n=<j>   body: frames, 1 MB at most (413)
    GET  url/recv?link=<id>&ack=<k>         answer: a 4-byte big-endian number, then frames

- link: a fresh id each time a client links, 64 chars at most. room=<bytes> on the first request:
  the most an answer carries (one message at least)
- numbers: each side numbers what it sends on a link from 1
- recv: number is that of the answer's last message; ack the last the client got. unacked messages
  are sent again. nothing queued: an empty answer after about 25 s
- send: n, the number of its first message. those already taken are passed over
- closed: no recv for 60 s, or more than 8 MB queued. it takes more while under 1 MB queued. a
  client holding more than 1 MB it couldn't send closes
- 410: link closed here, or ack > 0 or n > 1 on an unknown link. 409: ack behind what is held or
  past what was sent, or n past what was taken. either way the client links again, with a new id

galaxy: `/tippet/<room>` a websocket, one message per binary frame; `/tippet/<room>/send` and
`/recv` the long-poll. unix sockets: the same frames.
