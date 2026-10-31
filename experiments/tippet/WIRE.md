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
- ids: array, one per patch, only after on: the elements a patch names, or null: by its range and
  path as written (a writer holding no ids, an old step, anything else). each [through], or, a
  splice (a patch with a range, into a string or an array), [after, gone], [after, gone, before] or
  [after, gone, before or null (none), through]:
  - after: the element it goes after, or null: the start
  - gone: array of [id, count], count whole from 1: the elements it takes away, count of them from
    id on (its seq or k on). one named more than once is taken away once
  - through: array, one per whole in its path, in order (in [through], at least one): the element
    of the array item that index named at the writer; this device's x above minus what the step
    inserts. none: its path by place as written; a move's by place always (its ids passed over). a
    writer says it, empty when its path has no whole, for each splice into an array it names
  - before: the element it goes before, the one right after after at the writer (gone ones too): an
    id; or true, after's own before (after not null). none: the end (an old step's too). a writer
    says it only for a splice that inserts
  - an element id: made by a step, its device and seq: the step's seq + i, the i-th element the step
    inserts (from 0, in patch order); or there since a step made its sequence new: that step's
    device and n, and k, its place then. written: this device's x, whole or negative, seq the step's
    seq - x; or [x, k], x whole below n, that step n - x. another's [device, seq] or [device, n, k]
    (device bstr 32, not this step's; n from 1)
  - a step's seq: how many elements its device's steps before it insert (old steps too; a patch with
    a range inserts its tstr value's code points, its array value's items). not written: a reader
    holds a device's steps from n = 1 on, so counts it

  a sequence's elements are counted from its first splice: those there since the step that made it
  new are that step's, k their place. a sequence under an array item goes with the item, wherever
  it is. made new: by a put, a removal or a move at its path or above; by a move out of or into
  it (an end with a range: the sequence it is in; at an index of an array: that array); and, for
  those under an array, by a splice into the array with no through (by place as written, or ids
  from before through). a removal at an index of an array (a path, no range) is a splice of that
  one element: by place as written, or its through's last, taken away wherever it is now (gone
  already: nothing); at an index of anything else, a removal at its path, as any

  a path by through: each index the place now of the element named, among those not gone; one gone
  (but a removal's last) or not there, or an index not into an array: the step doesn't apply

  applied in the entry's order (history): a splice by ids takes its gone elements away wherever they
  are now, then its first inserted one goes between after and before, among those put there since
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
  splice's, but after the one before it when its splice put that one too; by range or with no
  before, before the end; one there since a step, after the one before it (the first, the start),
  before the end. sorts: by the lamport of the step that made it, then device, then seq (one there
  since a step: that step's lamport and device, before what the step inserts), so two at one place
  land the same whatever came first. an element it names not there (this device's x past the step's
  seq too), or a before not after its after: the step doesn't apply (passed over, as any). by range:
  as written, its inserted ones right after the element before from. what is made of it:
  `typescript/elements.ts`
- who: tstr, only when there is one

Anything else is not a step: another length, another kind in a place, a key or hash not 32 bytes, n
of 0, a number not whole, a patch with another field, a node array not one rest, an on item not as
above (k of 0 or of n or more, a pair naming the step's own device, of another length or kind), ids
not as above (not one per patch, but [through] on a patch without a range, a through of another
count than its path's wholes, an empty [through], a through's x of this device at or below minus
what its step inserts, a before of null without a through, an id of another shape or naming the
step's own device, another's seq below 0, a number past 2^53 - 1 either way, an [x, k] with x of n
or more, a [device, n, k] with n of 0, a count of 0, a before of true with a null after, another
length), a NUL in node (its rest too) or part, or containers nested 1024 deep (cbor's most; the
step's own array counts): a run message holds a step's patches one deeper.

A peer from before on refuses a step that carries it (not a step): a run with one doesn't pass it.
So does a peer from before ids, a step with ids, and one from before before or through, ids that
say it.

ids' shape is mine (10-30), not decided: per patch beside it, so a patch stays a changeable patch
(squish packs it); an element its device and seq (diamond-types' agent and per-agent sequence
number; Automerge's actor and counter is not this, its counter being lamport's, max + 1): unique by
its device's chain alone, whatever the lamports, and a big paste moves no lamport; seq counted, not
written, so a step says no more than it did; one there since a step by that step's n, which no other
step of its device has; lamport only sorts; this device's own as how far back from the step's seq,
so typing alone (each after the one before) is one run in a pack.

through is mine (10-31), not decided: an item by its element, as a splice names, so typing into an
item survives an insert, a removal or Enter above it, and a splice into an array that says one
leaves what is under its items as it was; beside the patch, so a patch stays a changeable patch
(squish packs it); one per whole, so a reader knows which index each names; its own as how far back,
in the pack shifted by what the run inserts, so typing into one item costs nothing a step after the
first. steps without through go by place, as they did, and a splice into an array without one makes
what is under it new, as it did (mine, 10-31, not decided): per step, the same on every
reader, so a log from before through reads as it did, and a step with a through into an item an old
splice made new names its elements as made new. the cost: an old splice ordered before a through's
typing makes new what that typing names (passed over). this device's x above minus what the step
inserts: an element of this device made by now, and the pack's shift stays within 2^53 - 1. a move
goes by place: an edit into an item another moved, ordered after the move, names an element made new
by it, and is passed over.

before and FugueMax are mine (10-31), not decided: Weidner and Kleppmann's FugueMax ("The Art of the
Fugue"), in its list form (Gentle's YjsMod: Yjs's origin left and right, its scan fixed), not a
tree, so it works on the runs as held; a splice naming only after (RGA) interleaves two typing at
one place backward or at the start, naming before too it doesn't, in any direction. with every
before none (old steps) the scan is RGA's (each passed one sorting above, with its own), so old logs
merge as they did. before none for the end, so typing at the end says no more than it did; true for
after's own, so typing forward in the middle says 1 byte more a step; this device's last insert is 1
byte already (x 1), so typing backward is 1 byte more. typing backward is one run held too, each
element before the one after it.

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
3. steps already held: passed over when the run's step at the lower of its last and the count held
   is the held one; else a fork (forks): refused, `fork` (`own` for this device's)
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
    ["fork", device, sig, pack, sig, pack]

- have: per device, how many steps the sender holds through its last signed step (its own: all).
  sent first on every link. answered with runs of each device the other side lacks, from its n + 1
- run: device 32 bytes, sig 64 bytes, pack as below
- live: id 8 random bytes, data bstr. never kept. ids lately seen (1024) are dropped; a relay sends
  it to its other links
- refused: device 32 bytes, n the refusing side's count of it. that device is sent no more on that
  link
- fork: device 32 bytes; two runs of it, each a sig and a pack with its first step whole (bstr), as
  runs; a proof (forks). dropped when it does not check. sent on every link but the one it came
  from, and after have on a new link

## forks

Mine (10-31), not decided. A device that signs two chains, differing from some n on: its key in two
places, a backup restored and written on. Nobody is told by a refusal on one link; a fork is.

- proof: two runs of one device, each as `fork` says: a pack whose first step is whole, its steps
  one after another from n, each before the hash of the one before, sig good for the last's hash.
  the two start at the same n, with steps of another hash there (the chains differ at n, and may
  differ before it: n is a step where they differ, not the first); their bytes at most 2^24 all
  told. checked by whoever gets it, from the message alone: it holds neither chain or one
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
  - ids: the step's ids as written, or null for none, but through's ids of this device: x as x less
    what the steps before it in the pack insert (the whole first's too), [x, k] as x less how many
    steps come before it (so typing into one item is one run; added back to unpack). the column
    only when a step in it says ids (on is there then too)
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
