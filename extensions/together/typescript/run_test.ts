import { assert, assertEquals, assertThrows } from "@std/assert"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, compare, encode, name } from "@ermine/encoding/commit"
import { pack, RunError, unpack, type Unpacked } from "./run.ts"
import { createSigner, seal, stored } from "./seal.ts"

const DOC = new Uint8Array(32).fill(0x2a)

const signers = [
	await createSigner(new Uint8Array(32).fill(1)),
	await createSigner(new Uint8Array(32).fill(2)),
]

// a run: typing on one node, then a fork by another signer, a merge, a move, a set, a removal,
// optional fields here and there. each commit sealed
async function made() {
	const out: Uint8Array[] = []
	const names: Uint8Array[] = []
	let n = 1000
	const add = async (
		c: Omit<Commit, "signer" | "nonce" | "time">,
		by = 0,
		time = 1_760_000_000,
	) => {
		const commit: Commit = { ...c, signer: signers[by].key, nonce: n++, time }
		const b = encode(commit)
		names.push(name(b))
		out.push(await seal(b, signers[by], DOC))
		return names[names.length - 1]
	}
	let head = await add({
		table: "value",
		actor: "chee",
		parents: [],
		lamport: 1,
		patches: [{ path: ["body"], value: "" }],
	})
	for (let i = 0; i < 40; i++) {
		head = await add(
			{
				table: "value",
				actor: "chee",
				parents: [head],
				lamport: i + 2,
				patches: [{ path: ["body"], range: [i, i], value: i % 7 === 0 ? "é🦊" : "x" }],
			},
			0,
			1_760_000_000 + (i >> 3),
		)
	}
	// a fork by the other signer on an older commit, with optional fields
	const fork = await add({
		table: "children",
		actor: { name: "juno" },
		reader: "r",
		external: [{ file: "a.ts", line: 2 }],
		metadata: { cause: 1 },
		parents: [names[10]],
		lamport: 12,
		patches: [{ path: ["new"], move: { path: ["old"] } }],
	}, 1)
	const both = [head, fork].sort(compare)
	head = await add({
		table: "value",
		actor: "chee",
		parents: both,
		base: head,
		lamport: 43,
		patches: [],
	})
	head = await add({
		table: "attributes",
		actor: "chee",
		parents: [head],
		lamport: 44,
		patches: [{ path: [], value: { k: [1, 2] } }],
	})
	// a parent not in the run: by its name
	await add({
		table: "value",
		actor: "chee",
		parents: [new Uint8Array(32).fill(9)],
		lamport: 2,
		patches: [{ path: [] }],
	})
	return out
}

// what was packed, as unpack gives it back: each one's seal, or only its commit and stored id when
// the next one vouches for it
const members = (back: Unpacked[]) =>
	back.map((u) => u.sealed ?? { commit: u.commit, stored: u.stored })

// each commit back exactly, its stored id its seal's, and its seal when it is not vouched for
function same(back: Unpacked[], sealed: Uint8Array[]) {
	assertEquals(back.length, sealed.length)
	sealed.forEach((s, i) => {
		const o = cbor.decode(s) as { commit: Uint8Array }
		assertEquals(back[i].commit, o.commit, `commit ${i}`)
		assertEquals(back[i].stored, stored(s), `commit ${i}`)
		if (back[i].sealed !== undefined) assertEquals(back[i].sealed, s, `commit ${i}`)
	})
}

Deno.test("run: packs to columns and back to each commit's exact bytes, signed ones' seals too", async () => {
	const sealed = await made()
	const packed = pack(sealed)
	const back = unpack(packed)
	same(back, sealed)
	// the same commits, the same bytes
	assertEquals(pack(members(back)), packed)
	// smaller: a run of typing is about its signatures
	const whole = cbor.encode({ members: sealed }).length
	assert(packed.length < whole / 2.5, `${packed.length} against ${whole}`)
})

Deno.test("run: typing is one signature: each commit but the last vouched for by the next", async () => {
	const s = signers[0]
	const sealed: Uint8Array[] = []
	let parent: Uint8Array | undefined
	for (let i = 0; i < 256; i++) {
		const c: Commit = {
			table: "value",
			actor: "chee",
			time: 1_760_000_000 + (i >> 3),
			signer: s.key,
			nonce: 77 + i,
			parents: parent ? [parent] : [],
			lamport: i + 1,
			patches: [{ path: ["body"], range: [i, i], value: "x" }],
		}
		const b = encode(c)
		sealed.push(await seal(b, s, DOC))
		parent = name(b)
	}
	const per = pack(sealed).length / 256
	assert(per < 44, `${per} bytes a commit`)
	const back = unpack(pack(sealed))
	same(back, sealed)
	assertEquals(back.filter((u) => u.sealed !== undefined).length, 1)
})

Deno.test("run: what isn't a run is refused", () => {
	assertThrows(() => unpack(new Uint8Array([1])), RunError)
	assertThrows(() => unpack(cbor.encode({ n: 1 })), RunError)
	assertEquals(unpack(pack([])), [])
	// one that must be signed, given without its seal
	assertThrows(() => pack([{ commit: new Uint8Array(1), stored: new Uint8Array(32) }]))
})

Deno.test("run: differences exact to 2^53 - 1 either way; a commit before its parent names it", async () => {
	const s = signers[0]
	const sealed: Uint8Array[] = []
	const names: Uint8Array[] = []
	const add = async (nonce: number, time: number, parents: Uint8Array[] = []) => {
		const b = encode({
			table: "value",
			actor: null,
			time,
			signer: s.key,
			nonce,
			parents,
			lamport: parents.length + 1,
			patches: [],
		})
		names.push(name(b))
		sealed.push(await seal(b, s, DOC))
	}
	await add(2 ** 53 - 1, 0)
	await add(0, 2 ** 53 - 1)
	await add(1, 5, [names[0]])
	same(unpack(pack(sealed)), sealed)
	// the child first: its parent by name, never by a place after its own
	const backwards = [sealed[2], sealed[0]]
	same(unpack(pack(backwards)), backwards)
})

Deno.test("run: refused with a code, and the column", () => {
	const e = assertThrows(() => unpack(cbor.encode({ ...cbor.decode(pack([])) as object, x: 1 })))
	assert(e instanceof RunError)
	assertEquals([e.code, e.column], ["not-a-run", "x"])
	// a run's count past n is refused before it is spread
	const big = assertThrows(() =>
		unpack(
			cbor.encode({
				...cbor.decode(pack([])) as object,
				n: 1,
				signatures: [new Uint8Array(64)],
				ids: [],
				table: [["value", 2 ** 50]],
			}),
		)
	)
	assert(big instanceof RunError)
	assertEquals([big.code, big.column], ["runs", "table"])
})
