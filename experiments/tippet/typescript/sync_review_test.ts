import { assertEquals } from "@std/assert"
import { decode, encode } from "@ermine/encoding/cbor"
import createEntry from "@ermine/graph/entry"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createHistory } from "./history.ts"
import { createLog, createMemoryStore, type Store } from "./log.ts"
import { createSync } from "./sync.ts"
import { port } from "./carriers/messagechannel.ts"

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// one bad message from a peer, and what it does to the side that reads it
for (
	const [name, m] of [
		["a run whose step is not a step", [
			"run",
			new Uint8Array(32),
			new Uint8Array(64),
			[encode("hi"), [], [], [], [], [], [], {}],
		]],
		["a run whose pack is not a pack", ["run", new Uint8Array(32), new Uint8Array(64), [1]]],
		["a have that is null", ["have", null]],
		["a have whose device is not a key", ["have", [["ab", 1]]]],
		["a message that is null", null],
	] as const
) {
	Deno.test(`review: ${name} rejects unhandled`, async () => {
		const caught: unknown[] = []
		const on = (e: PromiseRejectionEvent) => (e.preventDefault(), caught.push(e.reason))
		globalThis.addEventListener("unhandledrejection", on)
		const log = createLog()
		const sync = createSync({ log })
		const { port1, port2 } = new MessageChannel()
		const unlink = sync.link(port(port1))
		port2.postMessage(encode(m as never))
		await tick()
		unlink(), port2.close()
		globalThis.removeEventListener("unhandledrejection", on)
		assertEquals(caught.map(String), [])
	})
}

// one device, as tippet_test makes one
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
		sync,
		value: (id: string) => table.get("value", id)?.value,
		put: (id: string, v: unknown) =>
			run(() => table.sub("value", id, createEntry(v, createChangeHeader(s)))),
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
		await tick(5)
	}
}

Deno.test("review: a device on a new disk is a new device, with every step and value", async () => {
	const a = await device(), b = await device()
	join(a, b)
	a.put("pig", { x: 1 })
	await until(() => b.value("pig") !== undefined)
	closeAll()
	// an empty store: a new disk, say. its key is its own, so it is a new device (restoring a
	// device from its seed alone would fork its steps: a log refuses its own device's steps)
	const again = await device()
	join(again, b)
	await until(() => again.log.have()[a.log.device!] === 1)
	await tick()
	closeAll()
	assertEquals(again.value("pig"), b.value("pig"))
})

Deno.test("review: steps held without their signature are never sent on", async () => {
	const a = await device(), b0store = createMemoryStore()
	const b0 = await device({ store: b0store })
	join(a, b0)
	a.put("pig", { x: 1 })
	await until(() => b0.value("pig") !== undefined)
	await b0.log.saved()
	closeAll()
	// b stopped between a's step record and its signature record
	const records: Uint8Array[] = []
	await b0store.load((r) => void records.push(r))
	const torn = createMemoryStore()
	for (const r of records) if (!("sig" in (decode(r) as object))) await torn.append(r)
	const b = await device({ store: torn })
	assertEquals(b.log.count(a.log.device!), 1)
	// a comes back and says what it has: b holds it all, so takes nothing, and keeps no signature
	join(a, b)
	await tick()
	closeAll()
	const c = await device()
	join(b, c)
	await tick(100)
	closeAll()
	assertEquals(c.log.have()[a.log.device!], 1)
})
