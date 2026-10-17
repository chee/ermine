# sync conformance

The suites for the new sync, against which a C port is built. The TypeScript is the reference; each
harness's header lists its requests and answers.

| suite     | scenarios                                | TypeScript harness                                |
| --------- | ---------------------------------------- | ------------------------------------------------- |
| commit    | `ermine/encoding/conformance/commit/`    | `ermine/encoding/typescript/commit_harness.ts`    |
| seal      | `extensions/sync/conformance/seal/`      | `extensions/sync/typescript/seal_harness.ts`      |
| run       | `extensions/sync/conformance/run/`       | `extensions/sync/typescript/run_harness.ts`       |
| history   | `extensions/sync/conformance/history/`   | `extensions/sync/typescript/history_harness.ts`   |
| replay    | `extensions/sync/conformance/replay/`    | history's (`suite.json`)                          |
| snapshot  | `extensions/sync/conformance/snapshot/`  | history's (`suite.json`)                          |
| transport | `extensions/sync/conformance/transport/` | `extensions/sync/typescript/transport_harness.ts` |
| sync      | `extensions/sync/conformance/sync/`      | `extensions/sync/typescript/sync_harness.ts`      |
| egwalker  | `extensions/sync/conformance/egwalker/`  | history's (`suite.json`)                          |

Run: `deno task conformance commit seal run history replay snapshot transport sync egwalker`.
Another implementation: `--c` (the binary `<package>/c/<suite>-harness`), or `HARNESS="<command>"`
for one suite. Format: `conformance/run.ts` (a scenario, its steps, `expect`, `fails`, `skip`).

## Conventions

- bytes: lowercase hex, two digits a byte. Commits, seals, runs, snapshots, names, stored ids, keys,
  seeds, signer, parents, base.
- a value (an actor, a metadata value, a patch's value, a table's value): its JSON form,
  `conformance/typescript/form.ts`. JSON for what JSON holds; `{"/": {"bytes": base64}}` (standard,
  unpadded): bytes inside a value are base64, never hex; `{"/": {kind: [...]}}` a typed array;
  `{"/": {"number": "NaN"}}`; `{"/": {"live": kind}}` a stand-in; `-0` written `-0`;
  `{"/": {"symbol": name}}` a symbol, for refusals only (no encoding). Lone surrogates are taken.
- `value` in a request (decode, unseal, unpack, tables): a value in its JSON form, encoded
  canonically first. How refused bytes are written readably.
- a key (`key`, `signer`, a device's, a sender's): a multikey in hex: the unsigned varint of the key
  type's multicodec code, then the raw key. Ed25519: `ed01` then the 32 bytes (34 bytes). A
  signature in a seal: a varsig header, then the raw signature; Ed25519: `3401ed01ed01135f` (varsig
  v1, EdDSA, ed25519-pub, sha2-512, raw payload) then 64 bytes. Verified by the verifier its header
  names, for a key of its type (`seal.ts`); a header or key type with none, or a key not the
  header's type: refused `signature`. Ed25519 checked strictly, the same everywhere (`ed25519.ts`,
  `ed25519.h`): S below the group order, the key and R canonical and not of small order (seal/10).
- what a seal signs: `"ermine/v0/commit"`, the document's 32 bytes, then the commit's name: a seal
  is good in its own document only. A seal in a request or an answer is for the request's document:
  `doc`, default `ermine://2a…2a00…00` (16 bytes each; the seal and run harnesses take its 32 bytes,
  hex, and seal for it when given none). The transport harness seals a label for each document it is
  used in.
- a commit in JSON: its fields as `commit.ts` names them. signer, each parent, base: hex. actor,
  metadata values, patch values: values. external `[{file, line, column?, function?}]`. patches
  `[{path, range?, value?, move?: {path, range?}}]`, merge: a rule's name. An optional field absent:
  left out.
- a commit by label (history, replay, snapshot, run, transport): made from the fields the request
  gives, labelled `name`. Defaults: table `"value"`, actor `null`, time `0`, seed `"01"` × 32 (the
  signer is its Ed25519 key as a multikey, `ed01` then the 32 bytes; transport: the device's seed),
  nonce `0`, parents `[]`, lamport 1 + the highest lamport of its parents made here (0 for one not),
  patches `[]`; reader, external, metadata, base, merge: absent. parents, base: labels, or names as
  64 hex digits; parents sorted by name. A lamport is derived: a history refuses any other than 1 +
  the highest of its parents' (`lamport`). A commit that heads a fragment (a stored id with a
  leading zero byte, in its document) is made so by its nonce, found for that document.
- a run (`run.ts`): a commit the next one in it goes on alone, by the same signer, is vouched for by
  that one's signature: its own is left out, its header `null`, its stored id in `ids`. Unpacked, a
  signed one is its seal (a label, else hex); one vouched for is
  `{vouched: label (or its name,
  hex), stored?}`, `stored` (hex) when it is not its label's
  seal's.
- a commit in an answer: its label, else its name as hex (transport: its seal's stored id too).
- a table's change from a commit (a replay, a merge, sync's table): the commit's header, its
  metadata then `["signer", key]` and `["commit", name]`, both hex (`changeOf`, replay.ts). A new
  commit never carries those two from its change; its sites' files as the host's roots say.
- refused, with a code: `{error: code, ...where}`, exact. commit: `not-a-commit` | `cannot-carry`,
  `field`. seal: `shape` | `signature`; a commit's own refusal as commit's. run: RunError's code,
  `column`. snapshot: PackError's code. A history's refusal is an answer: `{added: {refused}}`
  (`shape` | `lamport` | `patches` | `parent` | `merge`: a merge by a rule the harness doesn't
  know); one the check cannot judge yet waits on it: `{added: {waiting: []}}` (history's `hold` and
  `again`). The transport's: `lock` | `shape` | `signature` | `stored` | `parents` | `boundary` (a
  fragment's members, boundary or checkpoints not its head's walk's).
- a snapshot from elsewhere is a hint: kept only when a replay to its commit gives the same tables
  (history's `hint`; the transport checks one a fragment carries once, when its head is in).
- the transport admits to Subduction's storage only what it takes in: a seal under its stored id, a
  fragment checked whole; what it refuses is never stored, so never sent. A device's `limits` (the
  most it holds for others: `pending`, `refused`, `waiting`, `joins`, `parts`) let go of the oldest
  past them.
- anything else wrong in a request (an unknown op, a label not made, hex that isn't):
  `{error: text}`. A scenario meets it only with `fails: true`.

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

## Merge rules (egwalker, sync)

- the rules a harness knows: `"eg-walker"` (`extensions/sync/typescript/egwalker.ts`, its header the
  exact rules). The egwalker suite pins merged tables for small histories (history's `merge` and
  `since` ops), so another implementation matches exactly.
- a sync host is given `merge` (the rule it merges by) and `merges` (the rules it knows, default
  `[merge]`): none, it is as without merging.

## What is not covered

- an ephemeral commit heard again by a device that never took the one before it (a joiner mid-drag):
  it waits for good, as nothing ephemeral is fetched; pinned only as "sees nothing" (29).
- locks other than unlocked; an ephemeral payload over Subduction's limit (sent as parts); channels
  (presence); the joins and parts limits.
- a check that cannot judge a commit yet, in the transport (only the history's, `hold`): the C's
  integration never answers so; the TypeScript's a throw (`transport_test.ts`).
- equivocation (one signer, two commits on the same parents with the same nonce): nothing tells of
  it.
- the wire between the TypeScript and the C, beyond the suites' shared bytes:
  `extensions/sync/typescript/wire_test.ts` (seals, runs and snapshots made by one, taken in by the
  other), with the C harnesses built.
