// One test per hardening.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import createEntry from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createLog, createMemoryStore, type Log, type Run, type Store } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSync } from "./sync.ts"
import { createSigner } from "./sign.ts"
import { decodeStep, encodeStep, hashStep, type Step, unhex } from "./step.ts"
import { pack, RUN, unpack } from "./pack.ts"
import { fileStore } from "./store_file.ts"
import { port } from "./carriers/messagechannel.ts"

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 2000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await tick(5)
	}
}

const kept = (device: string, steps: Uint8Array[], sig: Uint8Array = new Uint8Array(64)) =>
	encode(["run", unhex(device), sig, pack(steps)] as Value)

async function writer(o: { store?: Store; seed?: Uint8Array } = {}) {
	const log = createLog({ ...o, writes: true })
	await log.load()
	return log
}
const put = (log: Log, value: unknown, node = "pig") =>
	log.write({ node, part: "value", patches: [{ path: [], value }], when: 0 })
const size = (b: Run) => b.steps.reduce((n, s) => n + s.length, 0)

async function device(o: { store?: Store; run?: <T>(f: () => T) => T } = {}) {
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
	const history = createHistory({ log, table, places, run: o.run ?? run })
	await history.load()
	const sync = createSync({ log })
	return {
		log,
		history,
		sync,
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
	a.sync.link(port(port1)), b.sync.link(port(port2))
}
const closeAll = () => ports.splice(0).forEach((p) => p.close())

Deno.test("0. a store keeps its key: the same device again, another seed refused, a new store a new device", async () => {
	const store = createMemoryStore()
	const a = await writer({ store })
	put(a, 1)
	const again = await writer({ store })
	assertEquals(again.device, a.device)
	assertEquals(again.count(a.device!), 1)
	await assertRejects(() => createLog({ store, seed: new Uint8Array(32) }).load())
	assert((await writer()).device !== a.device)
})

Deno.test("0. a log refuses its own device's steps: one seed in two fresh stores forks nothing", async () => {
	const seed = crypto.getRandomValues(new Uint8Array(32))
	const one = await writer({ seed }), two = await writer({ seed })
	put(one, 1), put(one, 2)
	const taking = two.take((await one.run(one.device!, 1))!)
	put(two, 3)
	assertEquals(await taking, { refused: "own" })
	assertEquals(two.steps(two.device!).map((b) => decodeStep(b).n), [1])
})

Deno.test("0. this device's steps leave only once they are in its store", async () => {
	const mem = createMemoryStore()
	let open!: () => void
	const opened = new Promise<void>((r) => open = r)
	const slow: Store = { ...mem, append: (r, at) => mem.append(r, at).then(() => opened) }
	const a = await writer({ store: slow })
	put(a, 1)
	let sent = false
	const batch = a.run(a.device!, 1).then((b) => (sent = true, b))
	await tick()
	assert(!sent, "sent before it was saved")
	open()
	assertEquals((await batch)!.steps.length, 1)
})

Deno.test("1. a pack that says more than it holds is refused before anything is made", () => {
	const first = encodeStep({
		device: "ab".repeat(32),
		n: 1,
		before: null,
		node: "x",
		part: "value",
		patches: [],
		lamport: 1,
		when: 0,
	})
	// Many steps: nothing as long as k is made (an on column of nulls once took 5 s at this k).
	const k = 50_000_000, none = pack([first])[7]
	const bomb = [first, [0, k], [0, k], ["x", k], ["value", k], [null, k], [0, k], none]
	const t = performance.now()
	assertThrows(() => unpack(bomb), TypeError, "not a pack")
	assert(performance.now() - t < 50)
	const three = [first, [0, 3], [0, 3], ["x", 3], ["value", 3]]
	assertThrows(() => unpack([...three, [null, 3], [1, 3], none]), TypeError, "not a pack")
	assertThrows(() => unpack([...three, [null, 2], [0, 3], none]), TypeError, "not a pack")
	assertThrows(() => unpack([...pack([first]), 0]), TypeError, "not a pack")
	assertThrows(() => unpack(pack([first]).slice(0, 7)), TypeError, "not a pack")
})

Deno.test("2. a step far past the highest lamport is refused, and write never passes 2^53 - 1", async () => {
	const far = await createSigner()
	const bytes = encodeStep({
		device: far.device,
		n: 1,
		before: null,
		node: "x",
		part: "value",
		patches: [],
		lamport: Number.MAX_SAFE_INTEGER,
		when: 0,
	})
	const h = await writer()
	const sig = await far.sign(hashStep(bytes))
	assertEquals(await h.take({ device: far.device, steps: [bytes], sig }), { refused: "lamport" })
	const store = createMemoryStore()
	await store.append(kept(far.device, [bytes], sig))
	const old = await writer({ store })
	assertEquals(old.lamport, Number.MAX_SAFE_INTEGER)
	assertThrows(() => put(old, 1), RangeError)
	assertEquals(old.count(old.device!), 0)
})

Deno.test("4. a run's steps and its signature are one record: after a restart, both or neither", async () => {
	const a = await device(), store = createMemoryStore()
	const b0 = await device({ store })
	join(a, b0)
	a.put("pig", { x: 1 })
	await until(() => b0.value("pig") !== undefined)
	await b0.log.saved()
	closeAll()
	const records: Uint8Array[] = []
	await store.load((r) => void records.push(r))
	const whole = createMemoryStore(), torn = createMemoryStore()
	for (const r of records) await whole.append(r)
	const b = await device({ store: whole }), cut = await device({ store: torn })
	assertEquals([b.log.have()[a.log.device!], cut.log.have()[a.log.device!]], [1, undefined])
	assertEquals([b.value("pig"), cut.value("pig")], [{ x: 1 }, undefined])
})

Deno.test("5. load passes over a record that breaks its chain, and keeps every one after it", async () => {
	const a = await writer(), c = await writer()
	put(a, 1), put(a, 2), put(c, 1)
	const [a1, a2] = a.steps(a.device!), [c1] = c.steps(c.device!)
	const bent = encodeStep({ ...decodeStep(a2), before: hashStep(a2) })
	const store = createMemoryStore()
	const records = [
		kept(a.device!, [a1]),
		encode("not a record"),
		kept(a.device!, [bent]),
		kept(c.device!, [c1]),
		kept(a.device!, [a2]),
	]
	for (const r of records) await store.append(r)
	const g = createLog({ store })
	await g.load()
	assertEquals([g.count(a.device!), g.count(c.device!)], [2, 1])
	assertEquals(g.step(a.device!, 2), a2)
})

Deno.test("7. runs are small, and a relay passes them on as they were made, on disk too", async () => {
	const d = await writer()
	for (let i = 0; i < 200; i++) put(d, "y".repeat(50))
	const store = createMemoryStore(), relay = createLog({ store })
	for (let n = 1; n <= 200;) {
		const r = (await d.run(d.device!, n))!
		assert(
			r.steps.length <= 32 && size(r) <= 2048 + 512,
			`${r.steps.length} steps, ${size(r)} bytes`,
		)
		assertEquals(await relay.take(r), { added: r.steps.length })
		n += r.steps.length
	}
	const first = (await d.run(d.device!, 1))!, passed = (await relay.run(d.device!, 1))!
	assertEquals(passed, first)
	const again = createLog({ store })
	await again.load()
	assertEquals(await again.run(d.device!, 1), first)
})

Deno.test("8. a step is only what tippet writes: others are refused, and write throws", async () => {
	const base: Step = {
		device: "ab".repeat(32),
		n: 1,
		before: null,
		node: "x",
		part: "value",
		patches: [{ path: ["t"], range: [0, 1], value: "a" }],
		lamport: 1,
		when: 0,
	}
	const bad = [
		{ when: 0.5 },
		{ when: NaN },
		{ when: 2 ** 60 },
		{ lamport: -1 },
		{ n: 0 },
		{ before: new Uint8Array(31) },
		{ patches: [{ path: [], value: 1, op: "x" }] },
		{ patches: [{ path: ["t"], range: [1, 2, 3], value: "a" }] },
		{ patches: [{ path: ["t"], move: { path: ["u"], value: 1 } }] },
	]
	for (const b of bad) {
		assertThrows(() => decodeStep(encodeStep({ ...base, ...b } as Step)), TypeError, "not a step")
	}
	const good = decode(encodeStep(base)) as unknown[]
	const arrays = [
		[...good, "who", 1],
		[...good, 7],
		good.slice(0, 7),
		[new Uint8Array(31), ...good.slice(1)],
		["ab".repeat(32), ...good.slice(1)],
		[good[0], "1", ...good.slice(2)],
		[...good.slice(0, 3), 1, ...good.slice(4)],
		{ device: good[0], n: 1 },
	]
	for (const a of arrays) {
		assertThrows(() => decodeStep(encode(a as never)), TypeError, "not a step")
	}
	assertEquals(decodeStep(encode([...good, "who"] as never)).who, "who")
	assertThrows(() => encodeStep({ ...base, device: "AB".repeat(32) }), TypeError)
	const a = await writer()
	assertThrows(() => a.write({ node: "x", part: "value", patches: [], when: 0.5 }), TypeError)
	assertEquals(a.count(a.device!), 0)
	const writes: Patch[][] = [
		[{ path: ["t"], range: [0, 0], value: "héllo 🦊" }],
		[{ path: ["l", 2], move: { path: ["l", 0] } }],
		[{ path: ["l"], range: [1, 2], move: { path: ["m"], range: [0, 1] } }],
		[{ path: ["b"], value: new Uint8Array([1, 2, 3]) }],
		[{ path: ["big"], value: 2n ** 70n }],
		[{ path: [], value: { a: [1, { b: null }], f: 1.5 } }],
	]
	for (const patches of writes) a.write({ node: "x", part: "value", patches, when: 1 })
	assertEquals(unpack(pack(a.steps(a.device!))), a.steps(a.device!))
})

Deno.test("9. a log's steps are read from its store: from disk after a restart, the same bytes", async () => {
	const dir = await Deno.makeTempDir()
	const a = await writer({ store: fileStore(dir) })
	put(a, 1), put(a, 2)
	const written = a.steps(a.device!)
	await a.close()
	const again = await writer({ store: fileStore(dir) })
	assertEquals(again.device, a.device)
	const b = (await again.run(again.device!, 1))!
	assertEquals(b.steps, written)
	assertEquals(await createLog().take(b), { added: 2 })
	await again.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("10. a sign that fails fails once: the next batch signs", async () => {
	const w = await writer()
	put(w, 1)
	const subtle = crypto.subtle as { sign: unknown }, real = subtle.sign
	subtle.sign = () => Promise.reject(new Error("no key just now"))
	try {
		assertEquals(await w.run(w.device!, 1), undefined)
	} finally {
		subtle.sign = real
	}
	assertEquals((await w.run(w.device!, 1))?.steps.length, 1)
})

Deno.test("10. a listener that throws stops no other, nor does a landing that throws", async () => {
	const [hi, lo] = (await Promise.all([writer(), writer()])).sort((x, y) =>
		x.device! < y.device! ? 1 : -1
	)
	put(hi, 1), put(lo, 2)
	const r = await device({
		run: () => {
			throw new Error("no room")
		},
	})
	let told = 0
	r.log.on(() => {
		throw new Error("mine")
	})
	r.log.on(() => void told++)
	assertEquals(await r.log.take((await hi.run(hi.device!, 1))!), { added: 1 })
	assertEquals(await r.log.take((await lo.run(lo.device!, 1))!), { added: 1 })
	assertEquals(told, 2)
	assertEquals(r.history.failed.length, 2)
})

Deno.test("11. an entry whose write wasn't kept sends no patch until a whole write is kept", async () => {
	const a = await device()
	a.put("pig", { x: 1, f: () => 1 })
	a.edit("pig", [{ path: ["x"], value: 2 }])
	assertEquals(a.log.count(a.log.device!), 0)
	assertEquals(a.history.unkept.length, 2)
	a.put("pig", { x: 3 })
	a.edit("pig", [{ path: ["x"], value: 4 }])
	assertEquals(a.log.count(a.log.device!), 2)
})

Deno.test("12. a run's steps make at most 16 MB: a big step closes the run before it, one past it isn't written", async () => {
	const log = await writer()
	// the two past RUN together, each under it and under a run's 2 KB alone
	put(log, "y".repeat(1500))
	put(log, "x".repeat(RUN - 1000))
	assertEquals((await log.run(log.device!, 1))?.steps.length, 1)
	assertThrows(() => put(log, "x".repeat(RUN)), RangeError)
	assertEquals(log.count(log.device!), 2)
})
