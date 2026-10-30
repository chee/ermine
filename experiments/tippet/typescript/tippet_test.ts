import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createLog, createMemoryStore, type Store } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSync } from "./sync.ts"
import { decodeStep, encodeStep, hashStep } from "./step.ts"
import { port } from "./carriers/messagechannel.ts"

async function device(o: { store?: Store } = {}) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({
		root: "root",
		table,
		paths: createPaths(),
		scheduler: s,
		contributors: [children],
	})
	s.onTrackingEnd((k) => places.release(k))
	const scope = s.createRootScope({ actor: "test" })
	const run = <T>(f: () => T) => s.runWithScope(scope, f)
	const log = createLog({ store: o.store, writes: true })
	const history = createHistory({ log, table, places, run })
	await history.load()
	const sync = createSync({ log })
	return {
		log,
		history,
		sync,
		table,
		value: (id: string) => table.get("value", id)?.value,
		put: (id: string, v: unknown) =>
			run(() => table.sub("value", id, createEntry(v, createChangeHeader(s)))),
		edit: (id: string, patches: Patch[]) =>
			run(() => {
				const e = table.get("value", id)!
				update(e, patches, createChangeHeader(s))
				places.commit([e])
			}),
	}
}

const ports: MessagePort[] = []
function join(
	a: { sync: ReturnType<typeof createSync> },
	b: { sync: ReturnType<typeof createSync> },
) {
	const { port1, port2 } = new MessageChannel()
	ports.push(port1, port2)
	return [a.sync.link(port(port1)), b.sync.link(port(port2))]
}
const closeAll = () => ports.splice(0).forEach((p) => p.close())

async function until(f: () => boolean, ms = 2000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise((r) => setTimeout(r, 5))
	}
}

Deno.test("a write here is a step there", async () => {
	const a = await device(), b = await device()
	join(a, b)
	a.put("pig", { x: 1, y: 2 })
	await until(() => b.value("pig") !== undefined)
	assertEquals(b.value("pig"), { x: 1, y: 2 })
	b.edit("pig", [{ path: ["x"], value: 5 }])
	await until(() => (a.value("pig") as { x: number }).x === 5)
	assertEquals(a.value("pig"), { x: 5, y: 2 })
	closeAll()
})

Deno.test("two writes made apart: both sides end the same, both writes kept as versions", async () => {
	const a = await device(), b = await device()
	a.put("pig", { x: 1 })
	b.put("pig", { x: 2 })
	join(a, b)
	await until(() => a.log.have()[b.log.device!] === 1 && b.log.have()[a.log.device!] === 1)
	await until(() => JSON.stringify(a.value("pig")) === JSON.stringify(b.value("pig")))
	assertEquals(a.history.failed.length + b.history.failed.length, 0)
	const values = (d: typeof a) => d.history.versions("pig", "value").map((v) => v.value)
	assertEquals(values(a), values(b))
	assertEquals(values(a).map((v) => JSON.stringify(v)).sort(), ['{"x":1}', '{"x":2}'])
	a.edit("pig", [{ path: ["y"], value: 0 }])
	await until(() => b.history.versions("pig", "value").length === 1)
	assertEquals(values(b), [{ ...a.value("pig") as object }])
	closeAll()
})

Deno.test("a restart keeps an entry's heads: the same versions after it", async () => {
	const store = createMemoryStore()
	const a = await device({ store }), b = await device()
	a.put("pig", { x: 1 })
	b.put("pig", { x: 2 })
	join(a, b)
	await until(() => a.log.have()[b.log.device!] === 1)
	closeAll()
	const before = a.history.versions("pig", "value")
	assertEquals(before.length, 2)
	await a.history.snapshot()
	await a.log.saved()
	a.history.stop()
	const again = await device({ store })
	assertEquals(again.history.versions("pig", "value"), before)
})

Deno.test("writes to different keys both stand", async () => {
	const a = await device(), b = await device()
	join(a, b)
	a.put("pig", { x: 0, y: 0 })
	await until(() => b.value("pig") !== undefined)
	closeAll()
	a.edit("pig", [{ path: ["x"], value: 1 }])
	b.edit("pig", [{ path: ["y"], value: 1 }])
	join(a, b)
	await until(() => JSON.stringify(a.value("pig")) === JSON.stringify(b.value("pig")))
	assertEquals(a.value("pig"), { x: 1, y: 1 })
	assertEquals(a.history.versions("pig", "value").length, 1)
	assertEquals(a.history.versions("pig", "value")[0].from.heads.length, 2)
	closeAll()
})

Deno.test("a forged, broken or early batch is refused", async () => {
	const a = await device(), b = await device(), c = await device()
	a.put("p", 1)
	a.put("p", 2)
	const good = (await a.log.run(a.log.device!, 1))!
	const other = (await c.log.run(c.log.device!, 1)) ?? { sig: new Uint8Array(64) }
	assertEquals(await b.log.take({ ...good, sig: other.sig }), { refused: "signature" })
	assertEquals(await b.log.take({ ...good, steps: [good.steps[1]] }), { refused: "gap" })
	const bent = encodeStep({ ...decodeStep(good.steps[1]), before: hashStep(good.steps[1]) })
	assertEquals(await b.log.take({ ...good, steps: [good.steps[0], bent] }), { refused: "chain" })
	assertEquals(await b.log.take(good), { added: 2 })
	assertEquals(await b.log.take(good), { added: 0 })
	assertEquals(b.value("p"), 2)
})

Deno.test("a restart: the snapshot and the steps after it, and on it goes", async () => {
	const store = createMemoryStore()
	const a = await device({ store })
	a.put("pig", { x: 1 })
	a.edit("pig", [{ path: ["x"], value: 2 }])
	await a.history.snapshot()
	a.edit("pig", [{ path: ["x"], value: 3 }])
	await a.log.saved()
	a.history.stop()

	const again = await device({ store })
	assertEquals(again.log.device, a.log.device)
	assertEquals(again.value("pig"), { x: 3 })
	assertEquals(again.log.have()[again.log.device!], 3)
	again.edit("pig", [{ path: ["y"], value: 1 }])
	const b = await device()
	join(again, b)
	await until(() => b.log.have()[again.log.device!] === 4)
	assertEquals(b.value("pig"), { x: 3, y: 1 })
	closeAll()
})

Deno.test("a peer with no graph carries steps and live things between two", async () => {
	const a = await device(), b = await device()
	const galaxy = { sync: createSync({ log: createLog(), relay: true }) }
	join(a, galaxy)
	join(galaxy, b)
	a.put("room", { pigs: 3 })
	await until(() => b.value("room") !== undefined)
	assertEquals(b.value("room"), { pigs: 3 })
	const heard: Uint8Array[] = []
	b.sync.onLive((d) => heard.push(d))
	a.sync.live(new Uint8Array([1, 2, 3]))
	await until(() => heard.length === 1)
	assert(heard[0].every((x, i) => x === i + 1))
	closeAll()
})

Deno.test("a batch of typing packs small and unpacks to the same bytes", async () => {
	const { pack, unpack } = await import("./pack.ts")
	const { encode } = await import("@ermine/encoding/cbor")
	const a = await device()
	a.put("note", { text: "" })
	const text = "the quick brown fox jumps over the lazy dog. ".repeat(3)
	for (let i = 0; i < text.length; i++) {
		a.edit("note", [{ path: ["text"], range: [i, i], value: text[i] }])
	}
	const steps = [...a.log.steps(a.log.device!)]
	const packed = pack(steps)
	assertEquals(unpack(packed), steps)
	const raw = steps.reduce((n, b) => n + b.length, 0), small = encode(packed as never).length
	assert(small * 20 < raw, `${small} packed, ${raw} raw`)
})

Deno.test("a store that refuses an append doesn't crash: saved() says it, no run is sent, writes stop", async () => {
	const base = createMemoryStore()
	const store: Store = {
		...base,
		open: undefined,
		append: () => Promise.reject(new Error("ENOSPC")),
	}
	const log = createLog({ store, writes: true })
	await log.load()
	const s = log.write({ node: "x", part: "value", patches: [], when: 1, on: [] })
	assertEquals(s.n, 1)
	await new Promise((r) => setTimeout(r, 10))
	let said = ""
	await log.saved().catch((e) => said = e.message)
	assertEquals(said, "ENOSPC")
	assertEquals(await log.run(log.device!, 1), undefined)
	let threw = ""
	try {
		log.write({ node: "x", part: "value", patches: [], when: 2, on: [] })
	} catch (e) {
		threw = (e as Error).message
	}
	assertEquals(threw, "the store failed")
})
