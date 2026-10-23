# tippet wire

What a C implementation sends and checks. cbor: canonical, as `ermine/encoding/typescript/cbor.ts`'s
header says (vectors in `ermine/encoding/conformance/cbor`). Whole numbers below: integers, 0 to
2^53 - 1.

## step

One kept write. Bytes: a cbor array.

    [device, n, before, node, part, patches, lamport, when]
    [device, n, before, node, part, patches, lamport, when, who]

- device: bstr, 32 bytes. the writer's ed25519 public key
- n: whole, from 1, per device, one more each step
- before: bstr, 32 bytes, the hash of this device's step n - 1; null at n = 1
- node: tstr, the node's id; or [rest]: relative to the writer, the id `ermine:ed01` + device's hex
  (ermine/ids: key) then rest, rest a tstr, empty or from `/`. a writer writes a node that is its
  own id or under it so; read back to the same id. an old step's tstr stays as it was
- part: tstr. `value`, `attributes`, `children`, …
- patches: array of patch maps
- lamport: whole. one past the highest the writer had seen
- when: whole. seconds since 1970, the writer's clock
- who: tstr, only when there is one

Anything else is not a step: another length, another kind in a place, a key or hash not 32 bytes, n
of 0, a number not whole, a patch with another field, a node array not one rest.

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

Taking a run, in order:

1. own device: refused
2. first n past held + 1: a gap, answered with have
3. steps already held: passed over
4. each step: its device the run's, n one more, before the hash of the one before
5. lamport at most the highest held + 2^20
6. sig good for the last step's hash

Fail 1, 4, 5 or 6, or a pack that does not unpack: refused.

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

- first: whole n, from 2: step n is packed against step n - 1, like the rest; or bstr, the first
  step's bytes, whole (at n = 1, and old runs)
- the rest: one entry per step after step n - 1 (or after the whole first), each a runs list
  `[value, count, value, count, …]`, count whole and at least 1
  - lamport, when: the step from the one before (when may be negative)
  - node: as in a step (tstr or [rest]); part: tstr
  - who: tstr, or null for none
  - count: how many patches the step has
- columns: every later step's patches, in order, as below

Unpack: for each step after step n - 1 (the receiver's) or the whole first, from the one before
(prev):

    [prev.device, prev.n + 1, blake3(prev bytes), node, part, the next count patches,
     prev.lamport + lamport, prev.when + when (, who)]

encoded canonically: the same bytes the writer made, so chain and sig check as ever.

Refused before anything is made: not 8 elements, first neither bstr nor whole from 2, 4096 or more
steps in the columns (none, when first is n), more than 65536 patches, a column of another length,
counts not summing to the patches.

Step n - 1 not held: past what is held, a gap (answered with have); all steps held, passed over;
else held but not to be read (forgotten), refused, never guessed.

## columns

squish's (`core/op/typescript/squish.ts`): a map.

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
