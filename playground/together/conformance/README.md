# sync conformance

The suites for the new sync, against which a C port is built. The TypeScript is the reference; each
harness's header lists its requests and answers.

| suite     | scenarios                                    | TypeScript harness                                    |
| --------- | -------------------------------------------- | ----------------------------------------------------- |
| commit    | `ermine/encoding/conformance/commit/`        | `ermine/encoding/typescript/commit_harness.ts`        |
| seal      | `playground/together/conformance/seal/`      | `playground/together/typescript/seal_harness.ts`      |
| packer    | `playground/together/conformance/packer/`    | `playground/together/typescript/packer_harness.ts`    |
| history   | `playground/together/conformance/history/`   | `playground/together/typescript/history_harness.ts`   |
| replay    | `playground/together/conformance/replay/`    | history's (`suite.json`)                              |
| snapshot  | `playground/together/conformance/snapshot/`  | history's (`suite.json`)                              |
| transport | `playground/together/conformance/transport/` | `playground/together/typescript/transport_harness.ts` |
| sync      | `playground/together/conformance/sync/`      | `playground/together/typescript/sync_harness.ts`      |
| lists     | `playground/together/conformance/lists/`     | history's (`suite.json`)                              |
| lock      | `playground/together/conformance/lock/`      | `playground/together/typescript/lock_harness.ts`      |

Run: `deno task conformance commit seal packer history replay snapshot transport sync lists lock`. A
scenario with `"typescript": true` runs on the TypeScript harness only (what the C does not do yet:
pause, forget, the shared list, a node not shared, ids of any form). Another implementation: `--c`
(the binary `<package>/c/<suite>-harness`), or `HARNESS="<command>"` for one suite. Format:
`conformance/run.ts` (a scenario, its steps, `expect`, `fails`, `skip`).

## Conventions

- bytes: lowercase hex, two digits a byte. Commits, seals, packs, snapshots, names, stored ids,
  keys, seeds, signer, parents, base, replaces.
- a value (an actor, a metadata value, a patch's value, a table's value): its JSON form,
  `conformance/typescript/form.ts`. JSON for what JSON holds; `{"/": {"bytes": base64}}` (standard,
  unpadded): bytes inside a value are base64, never hex; `{"/": {kind: [...]}}` a typed array;
  `{"/": {"number": "NaN"}}`; `{"/": {"live": kind}}` a stand-in; `{"/": {"bigint": "…"}}` a whole
  number past 2^53 - 1; -0 is 0 (a float typed array keeps its -0); `{"/": {"symbol": name}}` a
  symbol, for refusals only (no encoding). Lone surrogates are taken.
- `value` in a request (decode, unseal, unpack, tables): a value in its JSON form, encoded
  canonically first. How refused bytes are written readably.
- a key (`key`, `signer`, a device's, a sender's): a multikey in hex: the unsigned varint of the key
  type's multicodec code, then the raw key. Ed25519: `ed01` then the 32 bytes (34 bytes). A
  signature in a seal: a varsig header, then the raw signature; Ed25519: `3401ed01ed01135f` (varsig
  v1, EdDSA, ed25519-pub, sha2-512, raw payload) then 64 bytes. Verified by the verifier its header
  names, for a key of its type (`seal.ts`); a header or key type with none, or a key not the
  header's type: refused `signature`. Ed25519 checked strictly, the same everywhere (`ed25519.ts`,
  `ed25519.h`): S below the group order, the key and R canonical and not of small order (seal/10).
- a name (a commit's, in parents, base, heads, acks, conflicts and every column): a multihash of the
  commit's bytes, `1e20` then the 32 bytes of their BLAKE3 (34 bytes, 68 hex digits): the varint of
  the hash's multicodec code (BLAKE3, `1e`), the varint of its length (`20`), then the digest. A
  name of another code, or of a length that is not its code's, is refused wherever a commit is
  decoded (`not-a-commit`, `parents` or `base`). A stored id (below), a tree id and a topic are not
  names: 32 bytes, as Subduction has them.
- a document: any string within the wire's limits (well-formed, no U+0000), compared as its bytes;
  no id's form decides anything (sync/61, transport/19). Subduction files it under its tree id, made
  inside the stack from the id's UTF-8 (`subduction.ts` treeOf, `sb_tree`); a tree the storage holds
  whose id is not named yet is listed (`unnamed`), taken in when its document is followed. Every
  write is a commit, stored; it is sent only while its document is followed (shared: sync/54, 55),
  and a pause stops that (sync/56).
- not shared means not stored: a device stores its own commits, followed or not, and another's only
  for a document it follows. A peer's put or fetch for a tree not followed is turned away at the
  policy, never a throw (the connection stays up), counted once a connection: `heard` at a document
  named here, `offered` (by tree id) for one not named (transport/30, 31, 32, sync/62, 63; lock/16,
  17). Nothing of it is stored or listed (`unnamed` counts only a device's own trees). A paused
  document never changes from outside: what was under way (a save let in before the pause, what
  waited on the lock, a load) is taken in only if it is the device's own (sync/62). The C stack does
  not do this yet: these scenarios are TypeScript's only.
- a seal: `{id, commit, signature}`, canonical CBOR: the id it is for (text), the commit's bytes,
  the signature. Unsealed for a document: its id not that one's, refused `id`, with the why "the
  seal is for another id" (seal/11, transport/15, transport/21); no id, or one not text: `shape`
  (seal/07).
- a stored id (a commit's name in Subduction: its loose commit's id, parents, a fragment's head,
  members and boundary, a pack's `ids`): BLAKE3 of the pieces `"ermine/v1/stored"`, the id's UTF-8
  and the commit's name, each its length (an unsigned varint) then its bytes. What is signed,
  without the signature: anyone holding the commit and the id works it out (a commit a pack vouches
  for has no seal), two seals of one commit for one id have one, and one commit for two documents
  has two (seal/15).
- what a seal signs: `"ermine/v1/commit"`, the length of the document's id's UTF-8 (an unsigned
  varint), that UTF-8, the signature's varsig header, then the commit's name: a seal is good in its
  own document only, and a header put on another signature is no longer good (the varsig spec
  recommends the header be signed over). An id is any well-formed string without U+0000, compared as
  its bytes, never normalised; any other is refused `shape` (seal/11, seal/16). A seal in a request
  or an answer is for the request's document: `doc`, default `ermine:0010` then `2a` × 16 (the seal
  harness takes any string and seals for it). The transport harness seals a label for each document
  it is used in.
- an envelope: what the Subduction stack stores and sends, before the lock closes it: a map of the
  node's id and what it carries, `{id, sealed}` (a loose commit), `{id, commit}` (an ephemeral
  commit), `{id, run, snapshot?}` (a fragment).
- the door: what Subduction is about to store under a name is read first, the lock opened: the
  envelope's id must make this tree, a seal in it must be for that id, and the stored id it gives
  the commit must be the name given; a fragment's head must be one of its members, and each member's
  stored id (a vouched one's too, as its pack says it) the one its commit gives; and a fragment must
  be closed: each member's parent a member, or one of the head's depth or more and in the boundary;
  one of less depth left out only with a boundary (Subduction's build takes out the members of every
  fragment below, transport/26, 28); none such, the boundary exactly the parents the members reach
  out of, no more. No signature is checked for this. One that fails is passed over, noted when the
  document is followed and the name is not held: `id` with the why "the envelope is for another id"
  or "the seal is for another id", `stored`, or `boundary` (not closed) (transport/12, 15, 20, 21,
  22, 23, 24, 25, sync/53). One the lock cannot open yet is stored unopened.
- a sealed message (a channel's bytes on a topic, littlesync's say): `{bytes, signer, signature}`,
  the signer's multikey in it. What it signs: `"ermine/v0/message"`, the BLAKE3 of the bytes, the
  signature's varsig header, then the topic's UTF-8 (1 to 256 bytes): good on its own topic only.
  Refused as a seal is: `shape` (not exactly those three, each bytes; a signer not a multikey; a
  topic that is not one) or `signature` (seal/13, seal/14).
- a commit in JSON: its fields as `commit.ts` names them. signer, each parent, base, each name a
  patch replaces: hex. actor, patch values: values. metadata: a map, its values values. external
  `[{file, line, column?, function?}]`. patches
  `[{path, range?, value?, move?: {path, range?}, replaces?: [name]}]`, merge: a rule's name. An
  optional field absent: left out.
- a commit by label (history, replay, snapshot, packer, transport): made from the fields the request
  gives, labelled `name`. Defaults: table `"value"`, actor `null`, time `0`, seed `"01"` × 32 (the
  signer is its Ed25519 key as a multikey, `ed01` then the 32 bytes; transport: the device's seed),
  nonce `0`, parents `[]`, lamport 1 + the highest lamport of its parents made here (0 for one not),
  patches `[]`; reader, external, metadata, base, merge: absent. parents, base: labels, or names as
  68 hex digits; parents sorted by name. A lamport is derived: a history refuses any other than 1 +
  the highest of its parents' (`lamport`). A commit that heads a fragment (a stored id with a
  leading zero byte, in its document) is made so by its nonce, found for that document.
- a pack (`packer.ts`): a commit the next one in it goes on alone, by the same signer, is vouched
  for by that one's signature: its own is left out, its header `null`, its stored id in `ids` (only
  said: the door works it out and checks it, transport/23). `id`: runs of the id each signed one is
  sealed for, `null` for each vouched (packer/16). Unpacked, a signed one is its seal (a label, else
  hex); one vouched for is `{vouched: label (or its name,
  hex), stored?}`, `stored` (hex) when it
  is not its label's seal's.
- a commit in an answer: its label, else its name as hex (transport: its seal's stored id too).
- a table's change from a commit (a replay, a merge, sync's table): the commit's header, its
  metadata with `signer` (key) and `commit` (name), both hex, over any of those keys it carried
  (`changeOf`, replay.ts). A new commit never carries those two from its change; its sites' files as
  the host's roots say.
- refused, with a code: `{error: code, ...where}`, exact. commit: `not-a-commit` | `cannot-carry`,
  `field`. seal: `shape` | `signature` | `id`; a commit's own refusal as commit's. packer:
  PackError's code, `column`. snapshot: PackError's code. A history's refusal is an answer:
  `{added: {refused}}` (`shape` | `lamport` | `patches` | `parent` | `merge`: a merge by a rule the
  harness doesn't know); one the check cannot judge yet waits on it: `{added: {waiting: []}}`
  (history's `hold` and `again`). The transport's: `lock` | `shape` | `signature` | `stored` |
  `parents` | `boundary` (a fragment's members, boundary or checkpoints not as Subduction's build
  makes them: its shape; with the head here, that build's, transport/13, 28) | `id` (an envelope for
  another id; or a seal in it for another id, with its why); `stored` a name the commit does not
  give (a fragment: a head none of its members, a member's stored id not its own).
- a snapshot from elsewhere is a hint: kept only when a replay to its commit gives the same tables
  (history's `hint`; the transport checks one a fragment carries once, when its head is in).
- the transport admits to Subduction's storage only what passes the door and is taken in: a good
  seal under its stored id, a fragment checked whole; what it passes over or refuses (the lock's
  refusal too) is never stored, so never sent from storage, and the save returns as if it were: the
  storage never throws, as Subduction (0.23) drops the connection on a throw (a relay's, every
  follower's) (transport/29, lock/18). Subduction still adds such a name to its own tree in memory,
  lists it (`stored`) and pushes it to a peer subscribed, whose door judges it too, and does not ask
  a peer for it again until it restarts (transport/12, lock/06); one the policy turns away (a tree
  not followed) it holds nothing of (lock/16, 17). A name already held, put with other bytes that
  are not good, is passed over unnoted (transport/22). A device's `limits` (the most it holds for
  others: `pending`, `refused`, `waiting`, `joins`, `parts`) let go of the oldest past them.
- anything else wrong in a request (an unknown op, a label not made, hex that isn't):
  `{error: text}`. A scenario meets it only with `fails: true`.

## The lock (lock)

- a lock (`typescript/lock.ts`, `c/lock.h`): close(doc, name, parents, bytes) before a commit
  leaves, open(doc, bytes) where it lands: the bytes, wait or refused (with a text). Unlocked gives
  back what it is given. Closed: a stored commit's seal (name: the commit's, parents: its), a
  fragment's blob (name: a multihash of its BLAKE3 as a commit's name is; parents: its boundary's
  names, sorted), an ephemeral commit's bytes (name, parents: the commit's). Opened: the same three
  where they land, and what the store holds as a device starts. An own commit is never opened (a
  fragment built here is, as it is stored).
- wait: a stored commit or a fragment is held and opened again on the device's changed, once however
  often it is told before it gets to it; an ephemeral commit is dropped, and heard when sent again.
  A loose commit that waits is stored and shown waiting (no parents named) until it is opened or
  gets in another way (a fragment's member); a fragment that waits is stored and shown waiting by
  its head with its boundary (`{fragment, boundary}`; sync's status: `{fragment, authority: true}`).
  Held at most `pending` of each (loose commits, fragments), the oldest let go of past it: stored
  still, it comes in again as the device starts.
- refused: the code `lock` with the lock's text beside it (`why`), the two noted as one: a loose
  commit by its stored id, a fragment by its head (refused whole), an ephemeral commit by the name
  of the bytes as they arrived (closed). Not asked again when the lock changes. A refusal as
  something arrives (any code) is told at once: sync's status shows it then.
- the harness (`lock_harness.ts`, `c/lock_harness.c`) is transport's with a device's `lock`:
  `"unlocked"`, or `"tag"` (`tag_lock.ts`, `c/tag_lock.h`: closes by a byte, 0xff, before the bytes;
  opens by taking it off, refusing bytes without it). `lock` sets what a tag lock's open does
  (`tag`, `wait`, `refuse`); `calls` says what it was asked to close since last asked and whether it
  was asked to open; `opens` how often it was asked to open since last asked; `changed` tells the
  device (`times`: so often before any of it runs); `again` sends an ephemeral commit again;
  `closed` reads the first byte of what the store holds; `closed: true` on `put` and `fragment`
  closes the blob first, as another tag lock's device would. The sync harness takes the same tag
  lock as a host's `lock`, with `lock` and `changed` ops.

## Deterministic hosts (sync, transport)

- seeds given. a host's random: call k (from 0, across restarts) is the first bytes of BLAKE3 of
  `"<host>/<k>"`. So its nonce start (the first 4 bytes, big-endian) and its minted ids are fixed.
- a write's change: the request's, else
  `{time: 1760000000, actor: <host>, external: [{file:
  "scenario", line: 1}]}`. What sync stamps
  with now (a removal, a settle with no change): the request's `time`, default 1760000000.
- quiet: every host idle, and no message crossing any pipe for five rounds of 2 ms.
- sync's clock (ephemeral beats, 1000 ms, and ttl, 4000 ms): from 1760000000000 ms, moved by
  `advance` (then every host ticked or run). The C's devices share it, and its quiet and connect
  move it a few ms a round too, so the ephemeral scenarios keep hundreds of ms from every boundary.
- pipes: in memory, in order; cut, a waiting receive fails.
- a sync host's shared list: its value at `<host>/shared` unless the host is given `shared`. Its
  commits count apart (their nonce from the start's other half, the top bit flipped), so a share
  leaves the counts of the writes as they are, on the C (no list yet) too.

## Merge rules (history, sync)

- the rules a harness knows: `"serial"` (`typescript/rules_harness.ts`, `c/rules_harness.c`, its
  header the rule), a rule for testing merging only; history's `merge` op defaults to it. A harness
  built with other rules: `history_harness.ts`'s and `sync_harness.ts`'s `run`, the C's
  `rules_harness.h` (`playground/egwalker`: the rule eg-walker and its suites).
- a sync host is given `merge` (the rule it merges by) and `merges` (the rules it knows, default
  `[merge]`): none, it is as without merging.

## What is not covered

- an ephemeral commit heard again by a device that never took the one before it (a joiner mid-drag):
  it waits for good, as nothing ephemeral is fetched; pinned only as "sees nothing" (29).
- a lock that really encrypts (the lock suite has a tag lock: a byte put before the bytes, no
  cryptography); an ephemeral payload over Subduction's limit (sent as parts); channels (presence);
  the joins and parts limits.
- a check that cannot judge a commit yet, in the transport (only the history's, `hold`): the C's
  integration never answers so; the TypeScript's a throw (`transport_test.ts`).
- equivocation (one signer, two commits on the same parents with the same nonce): nothing tells of
  it.
- a commit stored unopened because the lock waits is not read at the door (lock/16's m holds one).
- a fragment under a real head with a member's parent of less depth left out and a boundary (as a
  fragment below would take it out): closed, so it passes the door and the checks of a device that
  does not hold the head yet (only one that does builds the head's fragment, and the fragments below
  it, to compare); it is stored, and the head waits on that parent for good, the real fragment never
  fetched (Subduction keeps one fragment a head). An extra boundary id beside such a gap passes the
  door too. Subduction itself checks no fragment's members: only its signature, its blob's digest
  and the storage's policy.
- the wire between the TypeScript and the C, beyond the suites' shared bytes:
  `playground/together/typescript/wire_test.ts` (seals, packs and snapshots made by one, taken in by
  the other), with the C harnesses built.
