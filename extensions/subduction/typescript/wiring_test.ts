import { assertEquals, assertRejects } from "@std/assert"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import type { Changed } from "@ermine/graph"
import { createScheduler } from "@ermine/scheduler"
import { id } from "./id.ts"
import { createDevice } from "./transport.ts"
import { createWiring, fresh } from "./wiring.ts"
import createNode from "@ermine/graph/node"

const ROOT = id("unlocked", Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i))

function party() {
	const secret = new Uint8Array(32).fill(7), key = ed25519.getPublicKey(secret)
	const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, secret)) }
	const device = createDevice({ signer })
	let calls = 0
	const random = (n: number) => {
		const b = new Uint8Array(n)
		new DataView(b.buffer).setUint32(0, ++calls)
		return b
	}
	const records: Changed[] = []
	// deno-lint-ignore no-explicit-any
	const held: { s?: any } = {}
	const wiring = createWiring(device, {
		versions: (...a) => held.s.internal.versions(...a),
		signer,
		random,
	})
	const s = held.s = createScheduler({
		root: createNode(ROOT, {}),
		actor: "a",
		site: () => undefined,
		id: () => fresh(random),
		changed: (r) => (records.push(r), wiring.changed(r)),
	})
	return { s, device, wiring, records }
}

const put = (value: unknown) => [{ path: [], value }]

Deno.test("a change is taken in to its histories at once, before the next operation", () => {
	const { s, device } = party()
	s.write([], put(1))
	assertEquals(device.histories(ROOT).heads("value").map((h) => h.blop.lamport), [1])
	s.write([], put(2))
	// one history: the second names the first
	assertEquals(device.histories(ROOT).heads("value").map((h) => h.blop.lamport), [2])
	const v = s.get(ROOT)!.value
	assertEquals(v.map((x: { content: unknown }) => x.content), [2])
	assertEquals((v[0].because as { layer: string }).layer, "sync")
})

Deno.test("sealing, storing and sending come after: idle waits for them", async () => {
	const { s, device, wiring } = party()
	s.write([], put(1))
	assertEquals((await device.stored(ROOT)).length, 0)
	await wiring.idle()
	await device.idle()
	assertEquals((await device.stored(ROOT)).length, 1)
})

Deno.test("records: one per object changed, none for a refused operation", () => {
	const { s, records } = party()
	s.insert(ROOT, "old", "x")
	s.rename(ROOT, "old", "new")
	assertEquals(records.map((r) => [r.object, r.at]), [
		[["children", "old"], 0],
		[["children", "old"], 0],
		[["children", "new"], 0],
	])
	const before = records.length
	try {
		s.pop(ROOT, "none", 0)
	} catch { /* range */ }
	try {
		s.write(["nowhere"], put(1))
	} catch { /* nothing-there */ }
	assertEquals(records.length, before)
	s.pop(ROOT, "new", 0)
	assertEquals(records.at(-1)!.at, { pop: 0 })
	assertEquals(records.at(-1)!.patches, [])
})

Deno.test("a node whose id is not ermine:// is not committed; versions makes no record", () => {
	const { s, device, records } = party()
	const plain = s.create("p", { id: "plain" })
	assertEquals(records.map((r) => [r.node, r.ephemeral]), [["plain", false]])
	assertEquals(device.histories(ROOT).heads("value").length, 0)
	s.internal.versions(plain, "value", [])
	assertEquals(records.length, 1)
	assertEquals(s.get(plain)!.value, [])
})

Deno.test("the scheduler's interface does not hold versions", () => {
	const { s } = party()
	assertEquals("versions" in s, false)
	assertEquals(typeof s.internal.versions, "function")
})

Deno.test("a commit that cannot be made is reported by idle, not thrown at the operation", async () => {
	const { s, wiring } = party()
	// the graph holds two versions the histories do not: a write at the second has no head to follow
	const change = { node: ROOT, time: 0, actor: "x" }
	s.internal.versions(ROOT, "value", [{ content: 1, change }, { content: 2, change }] as never)
	s.write([], put(3), undefined, 1)
	await assertRejects(() => wiring.idle())
})
