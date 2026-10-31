# tippet wire

What a C implementation sends and checks. cbor: canonical, as `encoding/typescript/cbor.ts`'s header
says (vectors in `encoding/conformance/cbor`). Whole numbers below: integers, 0 to 2^53 - 1.

## step

One kept write. Bytes: a cbor array.

    [device, n, before, node, part, patches, lamport, when, on]
    [device, n, before, node, part, patches, lamport, when, on, who]
    [device, n, before, node, part, patches, lamport, when, on, ids]
    [device, n, before, node, part, patches, lamport, when, on, ids, who]
    [device, n, before, node, part, patches, lamport, when]          an old step
    [device, n, before, node, part, patches, lamport, when, who]     an old step

- device: bstr, 32 bytes. the writer's ed25519 public key
- n: whole, from 1, per device, one more each step
- before: bstr, 32 bytes, the hash of this device's step n - 1; null at n = 1
- node: tstr without NUL, the node's id; or [rest]: relative to the writer, the id `ermine:ed01` +
  device's hex (ids: key) then rest, rest a tstr, empty or from `/`. a writer writes a node that is
  its own id or under it so; read back to the same id. an old step's tstr stays as it was
- part: tstr without NUL. `value`, `attributes`, `children`, …
- patches: array of patch maps
- lamport: whole. one past the highest any step the writer had seen has. it orders, and names
  nothing
- when: whole. seconds since 1970, the writer's clock
- on: array. what it was written on: its entry's (node and part) heads at the writer, each a step:
  - k, whole from 1, k < n: this device's own step n - k
  - [device, n]: another device's step n; device bstr 32, not this step's; n whole from 1

  a writer with a graph says it always ([]: it held none). an old step, from before steps said, has
  none: it is read as on every step of its entry before it, in order of lamport, then device. what
  is made of it: `typescript/history.ts`, heads and versions
- ids: array, one per patch, only after on: the elements a splice (a patch with a range, into a
  string or an array) names, or null: by its range as written (a writer holding no ids, an old step,
  anything else). each [after, gone]:
  - after: the element it goes after, or null: the start
  - gone: array of [id, count], count whole from 1: the elements it takes away, count of them from
    id on (its seq or k on). one named more than once is taken away once
  - an element id: made by a step, its device and seq: the step's seq + i, the i-th element the step
    inserts (from 0, in patch order); or there since a step made its sequence new: that step's
    device and n, and k, its place then. written: this device's x, whole or negative, seq the step's
    seq - x; or [x, k], x whole below n, that step n - x. another's [device, seq] or [device, n, k]
    (device bstr 32, not this step's; n from 1)
  - a step's seq: how many elements its device's steps before it insert (old steps too; a patch with
    a range inserts its tstr value's code points, its array value's items). not written: a reader
    holds a device's steps from n = 1 on, so counts it

  a sequence's elements are counted from its first splice: those there since the step that made it
  new are that step's, k their place. made new: by a put, a removal or a move at its path or above;
  by a move out of or into it (an end with a range: the sequence it is in; at an index of an array:
  that array); and, for those under an array, by a splice into the array (a path through an array is
  by position, as written, so what is under it is new). a removal at an index of an array (a path,
  no range) is a splice of that one element, by its place as written

  applied in the entry's order (history): a splice by ids takes its gone elements away wherever they
  are now, and goes after its after element, past any elements there that sort after its own first:
  by the lamport of the step that made each, then device, then seq (one there since a step: that
  step's lamport and device, before what the step inserts), so two at one place land the same
  whatever came first. an element it names not there (this device's x past the step's seq too): the
  step doesn't apply (passed over, as any). by range: as written, its inserted ones right after the
  element before from. what is made of it: `typescript/elements.ts`
- who: tstr, only when there is one

Anything else is not a step: another length, another kind in a place, a key or hash not 32 bytes, n
of 0, a number not whole, a patch with another field, a node array not one rest, an on item not as
above (k of 0 or of n or more, a pair naming the step's own device, of another length or kind), ids
not as above (not one per patch, on a patch without a range, an id of another shape or naming the
step's own device, another's seq below 0, a number past 2^53 - 1 either way, an [x, k] with x of n
or more, a [device, n, k] with n of 0, a count of 0), a NUL in node (its rest too) or part, or
containers nested 1024 deep (cbor's most; the step's own array counts): a run message holds a step's
patches one deeper.

A peer from before on refuses a step that carries it (not a step): a run with one doesn't pass it.
So does a peer from before ids, a step with ids.

ids' shape is mine (10-30), not decided: per patch beside it, so a patch stays a changeable patch
(squish packs it); an element its device and seq (diamond-types' agent and per-agent sequence
number; Automerge's actor and counter is not this, its counter being lamport's, max + 1): unique by
its device's chain alone, whatever the lamports, and a big paste moves no lamport; seq counted, not
written, so a step says no more than it did; one there since a step by that step's n, which no other
step of its device has; lamport only sorts; this device's own as how far back from the step's seq,
so typing alone (each after the one before) is one run in a pack.

on's shape is mink's pick (10-26), not decided: after when, so an old step reads as it did; heads by
device and n, as the log finds a step (its chain binds n to its bytes), not by hash; this device's
own as how far back, 1 or 2 bytes, and runs in a pack; an old step read as on all before it, so old
logs read as they did.

patch: a map, only the fields it has.

- path: array of tstr or whole
- range: [from, to], two wholes. optional
- value: any value. optional
- move: map {path, range?}, the same rules. optional

hash: blake3 (32 bytes) of the step's bytes. Bytes are never encoded twice: a step is its bytes.

## runs

A device's steps travel in runs: from some n to a signed n.

- closed: by the writer, when 32 steps or 2048 bytes of steps have been written since the last
  close, or when a peer asks for the steps of an open one (it is closed at the latest step)
- sig: ed25519 over the 32-byte hash of the run's last step. one per run; the chain vouches for the
  steps before it
- never cut or joined: a run's end is fixed once signed. anyone passing it on sends it to that end
  with that sig; a peer holding its start is sent only the rest
- at most 2^24 bytes (16 MB) of steps, all told, the first whole one too: the writer closes its run
  before a step that would take it past, and writes no step past it alone. a peer may take less (a
  small device), never more

Taking a run, in order:

1. own device: refused
2. first n past held + 1: a gap, answered with have
3. steps already held: passed over
4. each step: its device the run's, n one more, before the hash of the one before
5. sig good for the last step's hash

Fail 1, 4 or 5, or a pack that does not unpack: refused.

That nothing else is checked is mine (10-30), not decided: whether a run is taken hangs on the run
and its device's chain alone, never on what else the taker holds, so a run good once is good
anywhere, any time. no lamport check: one far past what is held is taken, and the taker's writes go
past it. a lamport near 2^53 - 1 could end everyone's writes, but holding an id is the permission
for now, and one who can write can do worse.

## messages

Each a cbor array. Anything else is dropped, silently.

    ["have", [[device, n], …]]
    ["run", device, sig, pack]
    ["live", id, data]
    ["refused", device, n]

- have: per device, how many steps the sender holds through its last signed step (its own: all).
  sent first on every link. answered with runs of each device the other side lacks, from its n + 1
- run: device 32 bytes, sig 64 bytes, pack as below
- live: id 8 random bytes, data bstr. never kept. ids lately seen (1024) are dropped; a relay sends
  it to its other links
- refused: device 32 bytes, n the refusing side's count of it. that device is sent no more on that
  link

## pack

A run's steps, small.

    [first, lamport, when, node, part, who, count, columns]
    [first, lamport, when, node, part, who, count, columns, on]
    [first, lamport, when, node, part, who, count, columns, on, ids]

- first: whole n, from 2: step n is packed against step n - 1, like the rest; or bstr, the first
  step's bytes, whole (at n = 1, and old runs)
- the rest: one entry per step after step n - 1 (or after the whole first), each a runs list
  `[value, count, value, count, …]`, count whole and at least 1
  - lamport, when: the step from the one before (when may be negative)
  - node: as in a step (tstr or [rest]); part: tstr
  - who: tstr, or null for none
  - count: how many patches the step has
  - on: the step's on, or null for none; another device's n as the difference from the last n this
    column gave that device (from 0, may be negative), so typing by turns makes runs (mink's pick:
    two typing by turns, 38 bytes a step packed without it, 4 with). the column only when a step in
    it says on
  - ids: the step's ids as written, or null for none. the column only when a step in it says ids (on
    is there then too)
- columns: every later step's patches, in order, as below

Unpack: for each step after step n - 1 (the receiver's) or the whole first, from the one before
(prev):

    [prev.device, prev.n + 1, blake3(prev bytes), node, part, the next count patches,
     prev.lamport + lamport, prev.when + when (, on, each difference added back) (, ids) (, who)]

encoded canonically: the same bytes the writer made, so chain and sig check as ever.

Refused before anything is made: not 8, 9 or 10 elements, first neither bstr nor whole from 2, 4096
or more steps in the columns (none, when first is n), more than 65536 patches, a column of another
length, counts not summing to the patches, an on neither null nor an array. A step it makes that
isn't one (an n added back to below 1, ids where it says no on or not as a step has them): refused.
Steps that make more than a run's 2^24 bytes: refused once they do, nothing more made.

Step n - 1 not held: past what is held, a gap (answered with have); all steps held, passed over;
else held but not to be read (forgotten), refused, never guessed.

## columns

squish's (`changeable/typescript/squish.ts`): a map.

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
