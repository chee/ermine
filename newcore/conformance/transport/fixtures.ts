// Writes the transport scenarios to newcore/sync/conformance/transport/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/transport/fixtures.ts
// A scenario: {title, steps: [{request, expect}]}, one session started by reset (harness.ts has
// the protocol). Every expected answer is worked out by hand from TRANSPORT.tex, FRAGMENT.tex,
// CHAIN.tex and COMMIT.tex and written here by label; the only things computed are each blop's
// name (blop.ts), its seal and stored id (seal.ts), the documents' ids (id.ts) and, where the
// agreed order falls to names, which of two is the greater. transport.ts is never imported.
// Not here: the refusal lock, which the lock unlocked never gives (its open gives back what it
// is given).
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { encode, name } from "../../encoding/ts/blop.ts"
import * as cbor from "../../encoding/ts/cbor.ts"
import { seal, stored } from "../../sync/ts/seal.ts"
import { id } from "../../sync/ts/id.ts"
import { toJson } from "../pack/form.ts"

const out = new URL("../../sync/conformance/transport/", import.meta.url)
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

// the agreed order: higher lamport first; equal, the greater name
const agreed = (...bs: Blop[]) =>
	[...bs].sort((x, y) => x.lamport !== y.lamport ? y.lamport - x.lamport : x.name < y.name ? 1 : -1)

// ---- steps
type Step = { request: Record<string, unknown>; expect: unknown }
const ok = (request: Record<string, unknown>): Step => ({ request, expect: {} })
const reset = () => ok({ op: "reset" })
const device = (d: Dev): Step => ({
	request: { op: "device", name: d.name, seed: hex(d.seed) },
	expect: { key: hex(d.key) },
})
const follow = (d: Dev, doc = DOC) => ok({ op: "follow", device: d.name, doc })
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
	expect: { name: b.name, stored: b.stored },
})
const put = (d: Dev, head: string, parents: string[], blob: Uint8Array, doc = DOC) =>
	ok({ op: "put", device: d.name, doc, head, parents, blob: hex(blob) })
// a blop put as a loose commit as TRANSPORT.tex adds one: head its stored id, parents its
// parents' stored ids
const putBlop = (d: Dev, b: Blop) => put(d, b.stored, b.parents.map((p) => p.stored), b.sealed)

type State = {
	heads?: Blop[]
	chainWaiting?: unknown[]
	chainRefused?: unknown[]
	waiting?: { commit: string; waiting: string[] }[]
	refused?: ({ commit: string; refused: string } | { fragment: string; refused: string })[]
}
const state = (d: Dev, s: State, layer?: "ephemeral"): Step => ({
	request: { op: "state", device: d.name, doc: DOC, ...(layer ? { layer } : {}) },
	expect: {
		heads: (s.heads ?? []).map((b) => b.name),
		chain: { waiting: s.chainWaiting ?? [], refused: s.chainRefused ?? [] },
		taking: { waiting: s.waiting ?? [], refused: s.refused ?? [] },
	},
})
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
	scenario("chain", "a chain of three commits crosses: one head, three loose commits", [
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
		change: b.bytes.slice().buffer,
		signer: A.key.slice().buffer,
		signature: ed25519.sign(m, B.secret).slice().buffer,
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
		"a commit whose parent's seal is not here waits, off the chains; taken in when it comes",
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
