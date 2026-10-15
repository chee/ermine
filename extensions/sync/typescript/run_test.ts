import { assert, assertEquals, assertThrows } from "@std/assert"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, compare, encode, name } from "@ermine/encoding/commit"
import { pack, RunError, unpack } from "./run.ts"
import { createSigner, seal } from "./seal.ts"

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
		out.push(await seal(b, signers[by]))
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
		metadata: [["cause", 1]],
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

Deno.test("run: packs to columns and back to each sealed commit's exact bytes", async () => {
	const sealed = await made()
	const packed = pack(sealed)
	const back = unpack(packed)
	assertEquals(back.length, sealed.length)
	for (let i = 0; i < sealed.length; i++) assertEquals(back[i], sealed[i], `commit ${i}`)
	// the same commits, the same bytes
	assertEquals(pack(back), packed)
	// smaller: a run of typing is about its signatures
	const whole = cbor.encode({ members: sealed }).length
	assert(packed.length < whole / 2.5, `${packed.length} against ${whole}`)
})

Deno.test("run: typing packs to about its signatures", async () => {
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
		sealed.push(await seal(b, s))
		parent = name(b)
	}
	const per = pack(sealed).length / 256
	assert(per < 72, `${per} bytes a commit`)
	assertEquals(unpack(pack(sealed)), sealed)
})

Deno.test("run: what isn't a run is refused", () => {
	assertThrows(() => unpack(new Uint8Array([1])), RunError)
	assertThrows(() => unpack(cbor.encode({ n: 1 })), RunError)
	assertEquals(unpack(pack([])), [])
})
