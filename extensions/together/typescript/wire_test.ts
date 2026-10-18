// the wire between the TypeScript and the C: bytes one makes, the other verifies and applies, both
// ways. seals (for a document), packs (one signature for a run of typing) and snapshots made here are
// unsealed, unpacked and taken into a history by the C harnesses, and replayed to the same tables;
// what the C harnesses make is unsealed, unpacked, taken in and replayed here, and is the same bytes.
// needs the C harnesses built (make extensions/together/c/seal-harness extensions/together/c/packer-harness
// extensions/together/c/history-harness); without them it is ignored
import { assert, assertEquals } from "@std/assert"
import * as cbor from "@ermine/encoding/cbor"
import { ask } from "../../../conformance/typescript/ask.ts"
import { createCommits, type Made, tablesJson } from "./harnesses.ts"
import { createHistory } from "./history.ts"
import { replay } from "./replay.ts"
import { pack, unpack } from "./packer.ts"
import { stored, unseal } from "./seal.ts"
import { snapshot } from "./snapshot.ts"

const c = new URL("../c/", import.meta.url).pathname
const harness = (name: string) => c + name + "-harness"
const built = ["seal", "packer", "history"].every((n) => {
	try {
		return Deno.statSync(harness(n)).isFile
	} catch {
		return false
	}
})
const opts = { ignore: !built, sanitizeOps: false, sanitizeResources: false }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))
// the default document of the harnesses: 2a × 16, then 00 × 16
const DOC = unhex("2a".repeat(16) + "00".repeat(16))

// typing on one node by one signer, a fork by another, as requests the harnesses make by label
const requests = [
	{ name: "a", time: 1760000000, nonce: 1, patches: [{ path: [], value: { body: "" } }] },
	{
		name: "b",
		time: 1760000000,
		nonce: 2,
		parents: ["a"],
		patches: [{ path: ["body"], range: [0, 0], value: "h" }],
	},
	{
		name: "c",
		time: 1760000000,
		nonce: 3,
		parents: ["b"],
		patches: [{ path: ["body"], range: [1, 1], value: "i" }],
	},
	{
		name: "x",
		seed: "02".repeat(32),
		time: 1760000000,
		nonce: 9,
		parents: ["a"],
		patches: [{ path: ["other"], value: [1, 2] }],
	},
]

async function made() {
	const commits = createCommits()
	const out: { m: Made; sealed: Uint8Array }[] = []
	for (const r of requests) {
		const m = await commits.make(r)
		out.push({ m, sealed: await commits.sealed(m, DOC) })
	}
	return out
}

Deno.test({
	name: "wire: what the TypeScript makes, the C unseals, unpacks, takes in and replays the same",
	...opts,
	async fn() {
		const ms = await made()
		// seals
		const unsealed = await ask(
			[harness("seal")],
			ms.map(({ sealed }) => ({ op: "unseal", sealed: hex(sealed) })),
		)
		for (const [i, { m, sealed }] of ms.entries()) {
			const u = unsealed[i] as { bytes: string; name: string; stored: string }
			assertEquals([u.bytes, u.name, u.stored], [hex(m.bytes), hex(m.name), hex(stored(sealed))])
		}
		// a pack: a and b vouched for by the next, c and x signed
		const packed = pack(ms.map(({ sealed }) => sealed))
		const back = unpack(packed)
		assertEquals(back.map((u) => u.sealed === undefined), [true, true, false, false])
		const [answer] = await ask([harness("packer")], [{ op: "unpack", pack: hex(packed) }])
		assertEquals(
			answer,
			{
				sealed: back.map((u) =>
					u.sealed !== undefined
						? hex(u.sealed)
						: { vouched: hex(u.name), stored: hex(u.stored) }
				),
			},
		)
		// each signed seal the pack gives back unseals in the C too
		const again = await ask(
			[harness("seal")],
			back.filter((u) => u.sealed).map((u) => ({ op: "unseal", sealed: hex(u.sealed!) })),
		)
		for (const a of again) assert(!("error" in a), JSON.stringify(a))
		// taken into a history and replayed, from a snapshot made here at b
		const h = createHistory()
		for (const { m } of ms) assertEquals(h.add(m.bytes), "taken")
		const at = replay(h, ms[1].m.name)!
		const tables = replay(h, ms[2].m.name, (n) => hex(n) === hex(ms[1].m.name) ? at : undefined)!
		const asked = await ask([harness("history")], [
			...ms.map(({ m }) => ({ op: "add", bytes: hex(m.bytes) })),
			{ op: "replay", commit: hex(ms[2].m.name) },
			{ op: "replay", commit: hex(ms[3].m.name) },
			{ op: "tables", snapshot: hex(snapshot(at)) },
		])
		for (const a of asked.slice(0, 4)) assertEquals(a, { added: "taken" })
		assertEquals(asked[4], { tables: tablesJson(tables) })
		assertEquals(asked[5], { tables: tablesJson(replay(h, ms[3].m.name)!) })
		assertEquals(asked[6], { tables: tablesJson(at) })
	},
})

Deno.test({
	name:
		"wire: what the C makes, the TypeScript unseals, unpacks, takes in and replays, the same bytes",
	...opts,
	async fn() {
		const ms = await made()
		// seals made by the C, for the default document
		const sealed = await ask(
			[harness("seal")],
			ms.map(({ m }, i) => ({
				op: "seal",
				seed: requests[i].seed ?? "01".repeat(32),
				commit: hex(m.bytes),
			})),
		)
		for (const [i, a] of sealed.entries()) {
			const bytes = unhex((a as { sealed: string }).sealed)
			assertEquals(hex(bytes), hex(ms[i].sealed))
			const u = await unseal(bytes, DOC)
			assertEquals(hex(u.name), hex(ms[i].m.name))
		}
		// a pack packed by the C
		const answers = await ask([harness("packer")], [
			...requests.map((r) => ({ op: "make", ...r })),
			{ op: "pack", commits: requests.map((r) => r.name) },
		])
		const packed = unhex((answers[answers.length - 1] as { pack: string }).pack)
		assertEquals(hex(packed), hex(pack(ms.map(({ sealed }) => sealed))))
		const back = unpack(packed)
		const h = createHistory()
		for (const u of back) {
			if (u.sealed !== undefined) {
				assertEquals(hex((await unseal(u.sealed, DOC)).name), hex(u.name))
			}
			assertEquals(h.add(u.commit), "taken")
		}
		// and the C replays to what this replays to
		const [t] = await ask([harness("history")], [
			...back.map((u) => ({ op: "add", bytes: hex(u.commit) })),
			{ op: "replay", commit: hex(ms[2].m.name) },
		]).then((a) => a.slice(-1))
		assertEquals(t, { tables: tablesJson(replay(h, ms[2].m.name)!) })
		assert(cbor.decode(packed) !== undefined)
	},
})
