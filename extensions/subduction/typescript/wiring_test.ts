import { assertEquals, assertRejects } from "@std/assert"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { id } from "./id.ts"
import { createDevice } from "./transport.ts"
import { type Changed, fromFact } from "./wiring.ts"
import { createWorld } from "./world.ts"

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
	const w = createWorld(device, { root: ROOT, actor: "a", signer, random })
	return { w, device, wiring: w.wiring }
}

const put = (value: unknown) => [{ path: [], value }]
const heads = (device: ReturnType<typeof party>["device"], object: Changed["object"]) =>
	device.histories(ROOT).heads(object).map((h) => h.blop.lamport)

Deno.test("a change is taken in to its histories at once, before the next operation", () => {
	const { w, device } = party()
	w.write("value", ROOT, put(1))
	assertEquals(heads(device, "value"), [1])
	w.write("value", ROOT, put(2))
	// one history: the second names the first
	assertEquals(heads(device, "value"), [2])
	assertEquals(w.table.get("value", ROOT)!.value, 2)
})

Deno.test("sealing, storing and sending come after: idle waits for them", async () => {
	const { w, device, wiring } = party()
	w.write("value", ROOT, put(1))
	assertEquals((await device.stored(ROOT)).length, 0)
	await wiring.idle()
	await device.idle()
	assertEquals((await device.stored(ROOT)).length, 1)
})

Deno.test("children: one object a name, a rename taking the old name out", () => {
	const { w, device } = party()
	w.write("children", ROOT, [{ path: [], value: {} }, { path: ["old"], value: "x" }])
	assertEquals(heads(device, ["children", "old"]), [1])
	w.write("children", ROOT, [{ path: ["new"], move: { path: ["old"] } }])
	assertEquals(heads(device, ["children", "old"]), [2])
	assertEquals(heads(device, ["children", "new"]), [1])
	assertEquals(w.table.get("children", ROOT)!.value, { new: "x" })
	// the sides: the old name is emptied
	assertEquals(device.histories(ROOT).heads(["children", "old"]).length, 1)
})

Deno.test("fromFact: the value as it is; the table itself and a table taken out make none", () => {
	const header = { time: 1, actor: "a" }
	const fact = (part: string, patches: unknown[], change: unknown = header) =>
		({ part, id: ROOT, patches, change, entry: undefined }) as never
	const gone = { part: "value", id: ROOT, patches: put(1), change: undefined } as never
	assertEquals(fromFact(fact("value", put(1)), 0).map((r) => [r.object, r.at]), [["value", 0]])
	assertEquals(fromFact(fact("children", put({}))), [])
	assertEquals(fromFact(gone), [])
	assertEquals(fromFact(fact("other", put(1))), [])
	assertEquals(
		fromFact(fact("attributes", [{ path: ["k", "j"], value: 1 }])).map((
			r,
		) => [r.object, r.patches]),
		[[["info", "k"], [{ path: ["j"], value: 1 }]]],
	)
})

Deno.test("a node whose id is not ermine:// is not committed", () => {
	const { w, device } = party()
	w.write("value", "plain", put(1))
	assertEquals(device.histories(ROOT).heads("value").length, 0)
	assertEquals(w.table.get("value", "plain")!.value, 1)
})

Deno.test("versions taken in are written to the table and not sent out", () => {
	const { w, device } = party()
	const because = {
		layer: "sync" as const,
		place: { lamport: 1, name: "n" },
		why: { signer: "s" },
	}
	const from = { actor: "b", signer: "s", name: "n" }
	w.versions(ROOT, "value", [{ content: 5, change: { time: 3, actor: "b" }, because }], from)
	assertEquals(w.table.get("value", ROOT)!.value, 5)
	assertEquals(w.table.get("value", ROOT)!.change.actor, "b")
	w.versions(ROOT, ["info", "k"], [{ content: 1, change: { time: 3, actor: "b" }, because }], from)
	assertEquals(w.table.get("attributes", ROOT)!.value, { k: 1 })
	w.versions(ROOT, ["info", "k"], [], from)
	assertEquals(w.table.get("attributes", ROOT)!.value, {})
	assertEquals(device.histories(ROOT).heads("value").length, 0)
})

Deno.test("a commit that cannot be made is reported by idle, not thrown at the operation", async () => {
	const { wiring } = party()
	// a version the histories do not have: a write at it has no head to follow
	wiring.changed({
		node: ROOT,
		object: "value",
		patches: put(3),
		header: { time: 0, actor: "x" },
		at: 1,
		ephemeral: false,
	})
	await assertRejects(() => wiring.idle())
})
