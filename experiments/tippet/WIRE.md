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
  its tstr value's code points, its array value's items): 0 at n = 1, else step n - 1's seq plus
  what step n - 1 inserts (a step that says another is not a chain). seq plus what the step inserts:
  at most 2^53 - 1
- on: array. what it was written on: its entry's (node and part) heads at the writer, each a step:
  - k, whole from 1, k < n: this device's own step n - k
  - [device, n]: another device's step n; device bstr 32, not this step's; n whole from 1

  what is made of it: `typescript/history.ts`, heads and versions
- ids: array, one per patch: the elements it names:
  - null: a patch with no range and no index in its path; a move's too
  - [through]: a patch with an index in its path and no range
  - [after, gone, before, through]: a splice (a patch with a range, into a string or an array)
  - after: the element it goes after, or null: the start
  - gone: array of [id, count], count whole from 1: the elements it takes away, count of them from
    id on (its seq or k on). one named more than once is taken away once
  - before: the element it goes before, the one right after after at the writer (gone ones too): an
    id; true, after's own before (after not null); null, the end
  - through: array, one per whole in the patch's path, in order (empty when none): the element of
    the array item that index named at the writer
  - an element id: made by a step, its device and seq: the step's seq + i, the i-th element the step
    inserts (from 0, in patch order); or there since a step made its sequence new: that step's
    device and n, and k, its place then. written: this device's x, whole or negative, seq the step's
    seq - x; or [x, k], x whole below n, that step n - x. another's [device, seq] or [device, n, k]
    (device bstr 32, not this step's; n from 1). in a through this device's is c, whole: its seq; or
    [m, k], m from 1 to n: step m, k its place then

  a sequence's elements are counted from its first splice: those there since the step that made it
  new are that step's, k their place. a sequence under an array item goes with the item, wherever it
  is. made new: by a put, a removal or a move at its path or above; by a move out of or into it (an
  end with a range: the sequence it is in; at an index of an array: that array). a splice into a
  sequence no put made (its put not held yet: it applies once the put lands): the step doesn't
  apply. a removal at an index of an array (a path, no range) is a splice of that one element, its
  through's last, taken away wherever it is now (gone already: nothing)

  a path by through: each index the place now of the element named, among those not gone; one gone
  (but a removal's last) or not there, or an index not into an array: the step doesn't apply

  applied in the entry's order (history): a splice takes its gone elements away wherever they are
  now, then its first inserted one goes between after and before, among those put there since
  (FugueMax's rule), the rest each right after the one before:

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

  a reader that forgets: holds per entry its sequences' elements (in its snapshot too), per path the
  newest step that made it new, per sequence its newest splice, the place of its newest step that is
  one put of the whole value, and the graph's value (no steps, no second value). it ends at the same
  value as a reader that holds every step.

  a late step (ordered before a step applied) on a reader that forgets:
  - goes in as it is, unless a step after it made new a path at or above where it goes; it is a
    move; it is a put, and a step after it made new or spliced a sequence at or under that path
  - passed over, as applied: one put of the whole value, when a step ordered after it is one put of
    the whole value and no failed step of its entry is ordered after it (overwritten, as in order;
    nothing read, nothing failed)
  - else the entry is worked out again from every step of it the log holds, once the run landing is
    in: so too a late step that doesn't apply as it is, and one that applies in an entry with a
    failed step ordered after it
  - after a cut (the log has let go any device's first step): no entry is worked out again. a late
    step needing that fails (late, and the steps after it let go); when a failed step of an entry is
    ordered after a late one, the failed steps of its entry are tried again as they are, on that
    reader alone: its value can differ from then on

  what is made of it: `typescript/history.ts`
- who: tstr, only when there is one

Anything else is not a step: another length, another kind in a place, a key or hash not 32 bytes, n
of 0, a number not whole, a patch with another field, a node array not one rest, an on item not as
above (k of 0 or of n or more, a pair naming the step's own device, of another length or kind), a
seq past 2^53 - 1 with what the step inserts, ids not as above (not one per patch, null on a patch
that names elements, anything but null on one that names none, a through of another count than its
path's wholes, a before of true with a null after, an id of another shape or naming the step's own
device, another's seq below 0, a number past 2^53 - 1 either way, an [x, k] with x of n or more, a
through's [c, k] with c of 0 or past n, a [device, n, k] with n of 0, a count of 0, another length),
a NUL in node (its rest too) or part, or containers nested 1024 deep (cbor's most; the step's own
array counts): a run message holds a step's patches one deeper.

ids' shape is mine, not decided: per patch beside it, so a patch stays a changeable patch (squish
packs it); an element its device and seq (diamond-types), unique by its device's chain alone.

seq is mine, not decided: written after when, the numbers about a step's place together, so no log
need count it: a run is taken with step n - 1 held (its seq and what it inserts give the next); the
pack has no column for it.

sorting by device and seq is mine, not decided: lamport made runs cut whenever a write elsewhere
came between keystrokes; device and seq (Fugue, Yjs: the replica id) cost no run.

through is mine, not decided: an item by its element, so typing into an item survives an insert, a
removal or Enter above it; its own as seq c, a whole number, so typing into one item is one run in a
pack.

a write that can't be named is mine, not decided: a write here whose splices or array items its
entry's elements can't name (they differ from the graph's, as when host code updates twice before
one commit) goes as the graph's whole value for the entry, one put, which starts the entry's
elements again, so later writes name ids; the host is told in `unkept`.

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
- move: map {path, range?}, the same rules. optional

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

Fail 1, 4 or 5, or a pack that does not unpack: refused.

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
  sent first on every link. answered with runs of each device the other side lacks, from its n + 1
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
  dropped and not passed. a taker lists it for its host: `typescript/log.ts` forks and onFork,
  `c/tippet.h` tp_log_forks, and the `sync` node's forks
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
