// Writes the transport scenarios to newcore/sync/conformance/transport/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/transport/fixtures.ts
// A scenario: {title, steps: [{request, expect}]}, one session started by reset (harness.ts has
// the protocol). Every expected answer is worked out by hand from TRANSPORT.tex, FRAGMENT.tex,
// HISTORY.tex and COMMIT.tex and written here by label; the only things computed are each blop's
// name (blop.ts), its seal and stored id (seal.ts), the documents' ids (id.ts) and, where the
// agreed order falls to names, which of two is the greater. transport.ts is never imported.
// Not here: the refusal lock, which the lock unlocked never gives (its open gives back what it
// is given).
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { sha512 } from "npm:@noble/hashes@1.8.0/sha2"
import { encode, name } from "@ermine/encoding/blop"
import * as cbor from "@ermine/encoding/cbor"
import { seal, stored } from "@ermine/subduction/seal"
import { id } from "@ermine/subduction/id"
import { toJson } from "../pack/form.ts"

const out = new URL("../../extensions/subduction/conformance/transport/", import.meta.url)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const fill = (n: number, len = 32) => new Uint8Array(len).fill(n)
const range = (from: number) => Uint8Array.from({ length: 32 }, (_, i) => from + i)

// ID.tex's vector, and another
const DOC = id("unlocked", range(0x20))
const OTHER = id("unlocked", range(0x40))

type Dev = { name: string; seed: Uint8Array; secret: Uint8Array; key: Uint8Array }
const dev = (name: string, n: number): Dev => {
	const seed = fill(n)
	return { name, seed, secret: seed, key: ed25519.getPublicKey(seed) }
}
const A = dev("a", 1), B = dev("b", 2), C = dev("c", 3)

// another valid signature of the same message: Ed25519 with a random r (seeded by tag) in place of
// the deterministic one, so a different R and S, the same signer; SEAL.tex's strict rule takes it
const little = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n)
const L = ed25519.Point.Fn.ORDER
const signAlt = (d: Dev, tag: number) => (m: Uint8Array) => {
	const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(d.secret)
	const r = little(sha512(new Uint8Array([...d.secret, 0xaa, tag]))) % L
	const R = ed25519.Point.BASE.multiply(r).toBytes()
	const k = little(sha512(new Uint8Array([...R, ...pointBytes, ...m]))) % L
	const S = (r + k * scalar) % L
	const sig = new Uint8Array(64)
	sig.set(R)
	for (let i = 0, x = S; i < 32; i++, x >>= 8n) sig[32 + i] = Number(x & 0xffn)
	return Promise.resolve(sig)
}

// a blop as COMMIT.tex makes it at version 0 (one parent at most): its bytes, name, seal, stored id
type Blop = {
	by: Dev
	parents: Blop[]
	lamport: number
	patches: unknown[]
	nonce: Uint8Array
	node: string
	bytes: Uint8Array
	name: string
	sealed: Uint8Array
	stored: string
}
let nonces = 0
const nextNonce = () => {
	const n = new Uint8Array(8)
	new DataView(n.buffer).setUint32(0, ++nonces)
	return n
}
const blopOf = (by: Dev, node: string, parents: Blop[], patches: unknown[], nonce: Uint8Array) => ({
	node,
	object: "value" as const,
	actor: by.name,
	signer: by.key,
	nonce,
	parents: parents.map((p) => Uint8Array.from(p.name.match(/../g)!, (x) => parseInt(x, 16)))
		.sort((x, y) => hex(x) < hex(y) ? -1 : 1),
	lamport: 1 + Math.max(0, ...parents.map((p) => p.lamport)),
	patches: patches as never,
})
const signer = (d: Dev) => ({
	key: d.key,
	sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, d.secret)),
})

// depth: whether the stored id must start with a zero byte (a fragment's head), or must not
async function mk(
	by: Dev,
	parents: Blop[] = [],
	value: unknown = nonces,
	{ deep = false, node = DOC } = {},
): Promise<Blop> {
	const patches = [{ path: [], value }]
	for (;;) {
		const nonce = nextNonce()
		const bytes = encode(blopOf(by, node, parents, patches, nonce))
		const sealed = await seal(bytes, signer(by))
		const s = stored(sealed)
		if ((s[0] === 0) !== deep) continue
		return {
			by,
			parents,
			lamport: 1 + Math.max(0, ...parents.map((p) => p.lamport)),
			patches,
			nonce,
			node,
			bytes,
			name: hex(name(bytes)),
			sealed,
			stored: hex(s),
		}
	}
}

// the same blop sealed again, with another valid signature: its name the same, its stored id not
async function resealed(b: Blop, tag: number): Promise<Blop> {
	const sealed = await seal(b.bytes, { key: b.by.key, sign: signAlt(b.by, tag) })
	return { ...b, sealed, stored: hex(stored(sealed)) }
}

// the agreed order: higher lamport first; equal, the greater name
const agreed = (...bs: Blop[]) =>
	[...bs].sort((x, y) =>
		x.lamport !== y.lamport ? y.lamport - x.lamport : x.name < y.name ? 1 : -1
	)

// ---- steps
type Step = { request: Record<string, unknown>; expect: unknown }
const ok = (request: Record<string, unknown>): Step => ({ request, expect: {} })
const reset = () => ok({ op: "reset" })
const device = (d: Dev, store?: string): Step => ({
	request: { op: "device", name: d.name, seed: hex(d.seed), ...(store ? { store } : {}) },
	expect: { key: hex(d.key) },
})
const follow = (d: Dev, doc = DOC) => ok({ op: "follow", device: d.name, doc })
const drop = (d: Dev) => ok({ op: "drop", device: d.name })
const link = (a: Dev, b: Dev) => ok({ op: "link", a: a.name, b: b.name })
const unlink = (a: Dev, b: Dev) => ok({ op: "unlink", a: a.name, b: b.name })
const pump = () => ok({ op: "pump" })
const commit = (b: Blop, layer?: "ephemeral"): Step => ({
	request: {
		op: "commit",
		device: b.by.name,
		doc: b.node,
		object: "value",
		patches: toJson(b.patches),
		actor: b.by.name,
		nonce: hex(b.nonce),
		...(layer ? { layer } : {}),
	},
	// an ephemeral blop is not sealed: no stored id
	expect: layer ? { name: b.name } : { name: b.name, stored: b.stored },
})
const put = (d: Dev, head: string, parents: string[], blob: Uint8Array, doc = DOC) =>
	ok({ op: "put", device: d.name, doc, head, parents, blob: hex(blob) })
// a blop put as a loose commit as TRANSPORT.tex adds one: head its stored id, parents its
// parents' stored ids
const putBlop = (d: Dev, b: Blop) => put(d, b.stored, b.parents.map((p) => p.stored), b.sealed)

type State = {
	heads?: Blop[]
	historyWaiting?: unknown[]
	historyRefused?: unknown[]
	waiting?: { commit: string; waiting: string[] }[]
	refused?: (
		| { commit: string; refused: string }
		| { commit: string; stuck: string[] }
		| { fragment: string; refused: string }
	)[]
}
const first = (r: Record<string, unknown>) => (r.commit ?? r.fragment) as string
const state = (d: Dev, s: State, layer?: "ephemeral"): Step => ({
	request: { op: "state", device: d.name, doc: DOC, ...(layer ? { layer } : {}) },
	expect: {
		heads: (s.heads ?? []).map((b) => b.name),
		history: { waiting: s.historyWaiting ?? [], refused: s.historyRefused ?? [] },
		taking: {
			waiting: s.waiting ?? [],
			refused: [...s.refused ?? []].sort((x, y) => first(x) < first(y) ? -1 : 1),
		},
	},
})
const publish = (d: Dev, doc: string, payload: Uint8Array) =>
	ok({ op: "publish", device: d.name, doc, payload: hex(payload) })
const storedIds = (d: Dev, bs: Blop[]): Step => ({
	request: { op: "stored", device: d.name, doc: DOC },
	expect: bs.map((b) => b.stored).sort(),
})
const fragments = (d: Dev, fs: { head: Blop; members: Blop[]; boundary: Blop[] }[]): Step => ({
	request: { op: "fragments", device: d.name, doc: DOC },
	expect: fs.map((f) => ({
		head: f.head.stored,
		members: f.members.map((m) => m.stored).sort(),
		boundary: f.boundary.map((m) => m.stored).sort(),
	})).sort((x, y) => x.head < y.head ? -1 : 1),
})
const putFragment = (d: Dev, h: Blop, boundary: Blop[], members: Blop[]): Step =>
	ok({
		op: "putfragment",
		device: d.name,
		doc: DOC,
		head: h.stored,
		boundary: boundary.map((b) => b.stored),
		checkpoints: [],
		blob: hex(cbor.encode(members.map((m) => m.sealed))),
	})
// two devices, both following the document, linked
const two = () => [reset(), device(A), device(B), follow(A), follow(B), link(A, B)]

const all: { name: string; title: string; steps: Step[] }[] = []
const scenario = (name: string, title: string, steps: Step[]) => all.push({ name, title, steps })

// ---- stored blops crossing
{
	const c1 = await mk(A)
	scenario("one-commit", "a commit on one device crosses to the other and is taken in there", [
		...two(),
		commit(c1),
		pump(),
		state(A, { heads: [c1] }),
		state(B, { heads: [c1] }),
		storedIds(B, [c1]),
	])
}
{
	const c1 = await mk(A), c2 = await mk(A, [c1]), c3 = await mk(A, [c2])
	scenario("history", "a history of three commits crosses: one head, three loose commits", [
		...two(),
		commit(c1),
		commit(c2),
		commit(c3),
		pump(),
		state(B, { heads: [c3] }),
		storedIds(B, [c1, c2, c3]),
	])
}
{
	const a1 = await mk(A), b1 = await mk(B)
	scenario("concurrent", "two roots made apart, then linked: both heads, in the agreed order", [
		reset(),
		device(A),
		device(B),
		follow(A),
		follow(B),
		commit(a1),
		commit(b1),
		link(A, B),
		pump(),
		state(A, { heads: agreed(a1, b1) }),
		state(B, { heads: agreed(a1, b1) }),
	])
}
{
	const c1 = await mk(A), a2 = await mk(A, [c1]), b2 = await mk(B, [c1])
	scenario("offline", "unlinked, both commit on a shared head; relinked, both converge", [
		...two(),
		commit(c1),
		pump(),
		unlink(A, B),
		commit(a2),
		commit(b2),
		pump(),
		state(A, { heads: [a2] }),
		state(B, { heads: [b2] }),
		link(A, B),
		pump(),
		state(A, { heads: agreed(a2, b2) }),
		state(B, { heads: agreed(a2, b2) }),
	])
}
{
	const c1 = await mk(A), c2 = await mk(A, [c1]), c3 = await mk(A, [c2])
	scenario("late-joiner", "a device that joins later, linked only to b, gets all of a's", [
		...two(),
		commit(c1),
		commit(c2),
		commit(c3),
		pump(),
		device(C),
		follow(C),
		link(B, C),
		pump(),
		state(C, { heads: [c3] }),
		storedIds(C, [c1, c2, c3]),
	])
}
{
	const c1 = await mk(A)
	scenario("passed-over", "a stored id taken in, arriving again: passed over, nothing refused", [
		...two(),
		commit(c1),
		pump(),
		putBlop(B, c1),
		pump(),
		state(A, { heads: [c1] }),
		state(B, { heads: [c1] }),
	])
}

// ---- taking in: each refusal, in order
{
	const head = hex(fill(0x11))
	scenario("refused-shape", "a blob that is no seal: refused shape, on both devices", [
		...two(),
		put(A, head, [], new TextEncoder().encode("not a seal")),
		pump(),
		state(A, { refused: [{ commit: head, refused: "shape" }] }),
		state(B, { refused: [{ commit: head, refused: "shape" }] }),
	])
}
{
	// signed by b's key, but naming a's as signer; head wrong too: signature comes first
	const b = await mk(A)
	const m = new Uint8Array([...new TextEncoder().encode("ermine/v0/change"), ...name(b.bytes)])
	const forged = cbor.encode({
		change: b.bytes,
		signer: A.key,
		signature: ed25519.sign(m, B.secret),
	})
	const head = hex(fill(0x22))
	scenario(
		"refused-signature",
		"a seal whose signature is not its signer's: refused signature, before stored",
		[
			...two(),
			put(A, head, [], forged),
			pump(),
			state(B, { refused: [{ commit: head, refused: "signature" }] }),
		],
	)
}
{
	// another document's blop too: stored comes first
	const b = await mk(A, [], 1, { node: OTHER })
	const head = hex(fill(0x33))
	scenario("refused-stored", "a head that is not the seal's stored id: refused stored", [
		...two(),
		put(A, head, [], b.sealed),
		pump(),
		state(A, { refused: [{ commit: head, refused: "stored" }] }),
		state(B, { refused: [{ commit: head, refused: "stored" }] }),
	])
}
{
	// parents not matching too: document comes first
	const b = await mk(A, [], 1, { node: OTHER })
	scenario("refused-document", "a blop of another document in this tree: refused document", [
		...two(),
		put(A, b.stored, [hex(fill(0x44))], b.sealed),
		pump(),
		state(A, { refused: [{ commit: b.stored, refused: "document" }] }),
		state(B, { refused: [{ commit: b.stored, refused: "document" }] }),
	])
}
{
	const p = await mk(A), r = await mk(A, [p])
	scenario(
		"refused-parents",
		"a commit whose parents are not its blop's parents' stored ids, the parent here: refused parents",
		[
			...two(),
			commit(p),
			pump(),
			put(A, r.stored, [], r.sealed),
			pump(),
			state(A, { heads: [p], refused: [{ commit: r.stored, refused: "parents" }] }),
			state(B, { heads: [p], refused: [{ commit: r.stored, refused: "parents" }] }),
		],
	)
}
{
	const x = await mk(A), q = await mk(A, [x])
	scenario(
		"waiting-parent",
		"a commit whose parent's seal is not here waits, off the histories; taken in when it comes",
		[
			...two(),
			putBlop(A, q),
			pump(),
			state(A, { waiting: [{ commit: q.stored, waiting: [x.name] }] }),
			state(B, { waiting: [{ commit: q.stored, waiting: [x.name] }] }),
			putBlop(A, x),
			pump(),
			state(A, { heads: [q] }),
			state(B, { heads: [q] }),
			storedIds(B, [x, q]),
		],
	)
}
{
	const x = await mk(A), q = await mk(A, [x]), z = await mk(A, [q])
	scenario(
		"child-first",
		"a line put child first, then linked to a device that never saw it: one head on both",
		[
			reset(),
			device(A),
			device(B),
			follow(A),
			putBlop(A, z),
			putBlop(A, q),
			putBlop(A, x),
			follow(B),
			link(A, B),
			pump(),
			state(A, { heads: [z] }),
			state(B, { heads: [z] }),
		],
	)
}

// ---- fragments
{
	const c1 = await mk(A), c2 = await mk(A, [c1])
	const d3 = await mk(A, [c2], 3, { deep: true })
	const c4 = await mk(A, [d3])
	const f = { head: d3, members: [c1, c2, d3], boundary: [] }
	scenario(
		"fragment",
		"a commit of depth 1 makes a fragment on the device that added it and the one that took it in; a late joiner takes it in",
		[
			...two(),
			commit(c1),
			commit(c2),
			commit(d3),
			commit(c4),
			pump(),
			fragments(A, [f]),
			fragments(B, [f]),
			device(C),
			follow(C),
			link(B, C),
			pump(),
			state(C, { heads: [c4] }),
			fragments(C, [f]),
		],
	)
}

// ---- ephemeral blops
{
	const e1 = await mk(A), e2 = await mk(A, [e1])
	scenario("ephemeral", "ephemeral blops heard and taken in to their own layer, never stored", [
		...two(),
		commit(e1, "ephemeral"),
		commit(e2, "ephemeral"),
		pump(),
		state(A, { heads: [e2] }, "ephemeral"),
		state(B, { heads: [e2] }, "ephemeral"),
		state(B, {}),
		storedIds(A, []),
		storedIds(B, []),
	])
}

// ---- taking in, after the papers' counterexamples (lean/transport)
{
	const x = await mk(A), q = await mk(A, [x])
	scenario(
		"waiting-synced",
		"a child waits on both devices; its parent made on one crosses to the other: taken in on both",
		[
			reset(),
			device(A),
			device(B),
			follow(A),
			follow(B),
			putBlop(A, q),
			link(A, B),
			pump(),
			state(A, { waiting: [{ commit: q.stored, waiting: [x.name] }] }),
			state(B, { waiting: [{ commit: q.stored, waiting: [x.name] }] }),
			putBlop(B, x),
			pump(),
			state(A, { heads: [q] }),
			state(B, { heads: [q] }),
			storedIds(A, [x, q]),
		],
	)
}
for (const order of [[1, 2], [2, 1]]) {
	const x1 = await mk(A), x2 = await resealed(x1, 1), q = await mk(A, [x1])
	const seals = [x1, x2]
	scenario(
		`two-seals-${order[0] === 1 ? "first" : "second"}`,
		`one blop sealed twice, a child over the second seal: taken in, the ${
			order[0] === 1 ? "first" : "second"
		} seal first`,
		[
			reset(),
			device(A),
			follow(A),
			...order.map((i) => putBlop(A, seals[i - 1])),
			put(A, q.stored, [x2.stored], q.sealed),
			pump(),
			state(A, { heads: [q] }),
			storedIds(A, [x1, x2, q]),
		],
	)
}
for (const forgedFirst of [true, false]) {
	const x = await mk(A)
	const forged = put(A, x.stored, [hex(fill(0x77))], x.sealed)
	scenario(
		`forged-${forgedFirst ? "before" : "after"}-honest`,
		`a commit under an honest head with made-up parents, ${
			forgedFirst ? "before" : "after"
		} the honest one: nothing refused once both have come`,
		[
			reset(),
			device(A),
			follow(A),
			...(forgedFirst
				? [forged, pump(), state(A, { refused: [{ commit: x.stored, refused: "parents" }] })]
				: []),
			putBlop(A, x),
			...(forgedFirst ? [] : [forged]),
			pump(),
			state(A, { heads: [x] }),
		],
	)
}
{
	const c1 = await mk(A), c2 = await mk(A, [c1])
	const d3 = await mk(A, [c2], 3, { deep: true })
	scenario(
		"fake-fragment",
		"a fragment holding only the head's seal, then the honest one: not passed over, every member taken in",
		[
			reset(),
			device(A),
			follow(A),
			putFragment(A, d3, [], [d3]),
			pump(),
			state(A, { waiting: [{ commit: d3.stored, waiting: [c2.name] }] }),
			putFragment(A, d3, [], [c1, c2, d3]),
			pump(),
			state(A, { heads: [d3] }),
		],
	)
}
{
	const p = await mk(A), q = await mk(A, [p]), r = await mk(A, [q])
	const wrong = hex(fill(0x55))
	const stuck = [
		{ commit: wrong, refused: "stored" },
		{ commit: q.stored, stuck: [p.name] },
		{ commit: r.stored, stuck: [q.name] },
	]
	scenario(
		"stuck",
		"a commit whose parent is refused is stuck, listed with that parent; its own child with it",
		[
			...two(),
			put(A, wrong, [], p.sealed),
			putBlop(A, q),
			putBlop(A, r),
			pump(),
			state(A, { refused: stuck }),
			state(B, { refused: stuck }),
		],
	)
}
{
	const x = await mk(A), e = await mk(A, [x])
	scenario(
		"ephemeral-on-stored",
		"an ephemeral blop building on a stored one is taken in to the ephemeral layer on both devices",
		[
			...two(),
			commit(x),
			pump(),
			commit(e, "ephemeral"),
			pump(),
			state(A, { heads: [e] }, "ephemeral"),
			state(B, { heads: [e] }, "ephemeral"),
			state(B, { heads: [x] }),
			storedIds(B, [x]),
		],
	)
}

// ---- ephemeral blops refused: never sealed, so the checks are on the blop itself. A refused one is
// listed by its name, the BLAKE3 hash of its bytes; publish gives the bytes as they are, and the
// sender refuses them too as a receiver would, then sends them
{
	const junk = Uint8Array.from([9, 9, 9])
	const c = await mk(C)
	scenario(
		"ephemeral-signature",
		"an ephemeral blop whose signer is not the device that sent it: refused signature, not taken in",
		[
			...two(),
			publish(A, DOC, c.bytes),
			pump(),
			state(B, { refused: [{ commit: c.name, refused: "signature" }] }, "ephemeral"),
			state(A, { refused: [{ commit: c.name, refused: "signature" }] }, "ephemeral"),
			storedIds(B, []),
		],
	)
	scenario(
		"ephemeral-shape",
		"an ephemeral payload that is not a blop: refused shape, not taken in",
		[
			...two(),
			publish(A, DOC, junk),
			pump(),
			state(B, { refused: [{ commit: hex(blake3(junk)), refused: "shape" }] }, "ephemeral"),
			storedIds(B, []),
		],
	)
}

// ---- ephemeral blops over Subduction's 65 536 bytes: split into parts, each at most 60 000 bytes of
// the payload in the map {whole, part, parts, bytes}, and rejoined. A part is published by hand, as
// the sender's own message; a blop of 2 500 bytes in three parts of 1 000 stands for a longer one
const parts = (b: Uint8Array, size: number, whole = blake3(b)) => {
	const n = Math.ceil(b.length / size)
	return Array.from(
		{ length: n },
		(_, i) =>
			cbor.encode({ whole, part: i, parts: n, bytes: b.subarray(i * size, (i + 1) * size) }),
	)
}
const expire = () => ok({ op: "expire" })
{
	const big = await mk(A, [], "x".repeat(200000))
	scenario(
		"ephemeral-parts",
		"an ephemeral blop of about 200 KB is split into parts, crosses, is joined and taken in",
		[
			...two(),
			commit(big, "ephemeral"),
			pump(),
			state(A, { heads: [big] }, "ephemeral"),
			state(B, { heads: [big] }, "ephemeral"),
			storedIds(B, []),
		],
	)
}
{
	const e = await mk(A, [], "y".repeat(2500))
	const [p0, p1, p2] = parts(e.bytes, 1000)
	scenario(
		"ephemeral-parts-out-of-order",
		"parts arriving out of order, one twice, still join and are taken in",
		[
			...two(),
			publish(A, DOC, p2),
			publish(A, DOC, p0),
			publish(A, DOC, p0),
			pump(),
			state(B, {}, "ephemeral"),
			publish(A, DOC, p1),
			pump(),
			state(B, { heads: [e] }, "ephemeral"),
			storedIds(B, []),
		],
	)
	scenario(
		"ephemeral-parts-missing",
		"a part set with one part missing is dropped after the timeout: nothing is taken in, even when the part comes late",
		[
			...two(),
			publish(A, DOC, p0),
			publish(A, DOC, p1),
			pump(),
			expire(),
			publish(A, DOC, p2),
			pump(),
			state(B, {}, "ephemeral"),
		],
	)
	const other = await mk(A, [], "z".repeat(2500))
	scenario(
		"ephemeral-parts-hash",
		"parts that join to a payload other than the whole they name are dropped; the honest set after is taken in",
		[
			...two(),
			...parts(e.bytes, 1000, blake3(other.bytes)).map((p) => publish(A, DOC, p)),
			pump(),
			state(B, {}, "ephemeral"),
			...parts(e.bytes, 1000).map((p) => publish(A, DOC, p)),
			pump(),
			state(B, { heads: [e] }, "ephemeral"),
		],
	)
}

// ---- a device starting takes in what its storage holds (TRANSPORT.tex, A device)
{
	const c1 = await mk(A), c2 = await mk(A, [c1]), d3 = await mk(A, [c2], undefined, { deep: true })
	const c4 = await mk(A, [d3])
	const f = { head: d3, members: [c1, c2, d3], boundary: [] }
	const A2 = { ...A, name: "a2" }
	scenario(
		"restart",
		"a device dropped and made again on its storage, linked to none: its histories hold every commit and its fragment",
		[
			reset(),
			device(A, "s"),
			follow(A),
			commit(c1),
			commit(c2),
			commit(d3),
			commit(c4),
			pump(),
			fragments(A, [f]),
			drop(A),
			device(A2, "s"),
			state(A2, { heads: [c4] }),
			fragments(A2, [f]),
			storedIds(A2, [c4]),
		],
	)
	const head = hex(fill(0x33))
	scenario(
		"restart-refused",
		"the same with one stored commit whose blob is no seal: refused shape, as when it arrived; the rest taken in",
		[
			reset(),
			device(A, "s"),
			follow(A),
			commit(c1),
			commit(c2),
			put(A, head, [], new TextEncoder().encode("not a seal")),
			pump(),
			drop(A),
			device(A2, "s"),
			state(A2, { heads: [c2], refused: [{ commit: head, refused: "shape" }] }),
		],
	)
}

// ---- the order of follow and commit does not matter
{
	const c1 = await mk(A), c2 = await mk(A, [c1])
	scenario(
		"commit-then-follow",
		"commits added before the document is followed cross when it is followed",
		[
			reset(),
			device(A),
			device(B),
			follow(B),
			link(A, B),
			commit(c1),
			commit(c2),
			follow(A),
			pump(),
			state(B, { heads: [c2] }),
			storedIds(B, [c1, c2]),
		],
	)
}
{
	const c1 = await mk(A), c2 = await mk(A, [c1])
	scenario(
		"follow-then-commit",
		"commits added after the document is followed, on a link made after, cross",
		[
			reset(),
			device(A),
			device(B),
			follow(A),
			follow(B),
			link(A, B),
			commit(c1),
			commit(c2),
			pump(),
			state(B, { heads: [c2] }),
			storedIds(B, [c1, c2]),
		],
	)
}
{
	const cs = [await mk(A)]
	for (let i = 1; i < 8; i++) cs.push(await mk(A, [cs[i - 1]]))
	scenario(
		"burst-on-new",
		"a burst of writes to a freshly made document, followed in the middle of it, all cross",
		[
			reset(),
			device(A),
			device(B),
			follow(B),
			link(A, B),
			...cs.slice(0, 4).map((c) => commit(c)),
			follow(A),
			...cs.slice(4).map((c) => commit(c)),
			pump(),
			state(B, { heads: [cs[7]] }),
			storedIds(B, cs),
		],
	)
}

// ---- write
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
for (const [i, s] of all.entries()) {
	const file = `${String(i + 1).padStart(2, "0")}-${s.name}.json`
	await Deno.writeTextFile(
		new URL(file, out),
		JSON.stringify({ title: s.title, steps: s.steps }, null, "\t") + "\n",
	)
}
console.log(`${all.length} scenarios written`)
