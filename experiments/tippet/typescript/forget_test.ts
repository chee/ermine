// A device that forgets (history.ts) lets a run go once it is in a snapshot and has passed on.
import { assert, assertEquals } from "@std/assert"
import { encode } from "@ermine/encoding/cbor"
import createEntry from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import { decodeStep, unhex } from "./step.ts"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { createPlaces } from "@ermine/places"
import { children } from "@ermine/places/children"
import { createChangeHeader } from "@ermine/places/header"
import { createLog, type Log, type Store } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSync, type Link } from "./sync.ts"
import { fileStore } from "./store_file.ts"
import { port } from "./carriers/messagechannel.ts"

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 3000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await tick(5)
	}
}

// ids for a writer that holds the entry's newest put of the whole value: a container under its root
function named(w: Log, node: string, patches: { path: (string | number)[]; move?: unknown }[]) {
	let root: [number, string, number] | undefined, at = ""
	for (const d of Object.keys(w.have())) {
		for (let n = 1; n <= w.count(d); n++) {
			const s = decodeStep(w.step(d, n)), p = s.patches[0], key = `${s.lamport} ${d}`
			if (s.node === node && p && !p.path.length && p.value !== undefined && key > at) {
				root = [n, d, 0], at = key
			}
		}
	}
	return patches.map((p) => {
		if (p.move) return null
		if (!p.path.length) return [null, []]
		const [n, d, i] = root!, rel = p.path.slice(0, -1)
		return [d === w.device ? [n, i, ...rel] : [unhex(d), n, i, ...rel], []]
	})
}

async function device(o: { store?: Store; forgets?: boolean } = {}) {
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
	const history = createHistory({ log, table, places, run, forgets: o.forgets })
	await history.load()
	const sync = createSync({ log })
	return {
		log,
		history,
		sync,
		value: (id: string) => table.get("value", id)?.value,
		put: (id: string, v: unknown) =>
			run(() => table.sub("value", id, createEntry(v, createChangeHeader(s)))),
		twice: (
			id: string,
			one: { path: string[]; range: [number, number]; value: string }[],
			two: typeof one,
		) =>
			run(() => {
				const e = table.get("value", id)!
				update(e, one, createChangeHeader(s))
				update(e, two, createChangeHeader(s))
				places.commit([e])
			}),
		patch: (
			id: string,
			patches: { path: string[]; range?: [number, number]; value?: unknown }[],
		) =>
			run(() => {
				const e = table.get("value", id)!
				update(e, patches, createChangeHeader(s))
				places.commit([e])
			}),
	}
}
type Device = Awaited<ReturnType<typeof device>>

const ports: MessagePort[] = []
function join(a: Device, b: Device, keeper = false) {
	const { port1, port2 } = new MessageChannel()
	ports.push(port1, port2)
	const near: Link = { ...port(port1), keeper }
	const unlink = a.sync.link(near)
	b.sync.link(port(port2))
	return () => (unlink(), port2.close())
}
const closeAll = () => ports.splice(0).forEach((p) => p.close())

Deno.test("forgets: a run in a snapshot that every link has is let go, and never sent; a reload keeps it gone", async () => {
	const dir = await Deno.makeTempDir()
	const k = await device(), d = await device({ store: fileStore(dir), forgets: true })
	join(d, k, true)
	for (let i = 1; i <= 40; i++) k.put("pig", { n: i })
	await until(() => (d.value("pig") as { n: number } | undefined)?.n === 40)
	await d.history.forget(d.sync)
	await d.log.saved()
	const kd = k.log.device!
	assertEquals([d.log.have()[kd], await d.log.run(kd, 1), await d.log.run(kd, 40)], [
		40,
		undefined,
		undefined,
	])
	const late = await device()
	join(late, d)
	await tick(100)
	assertEquals(late.log.count(kd), 0)
	closeAll()
	await d.log.close()
	const again = await device({ store: fileStore(dir), forgets: true })
	assertEquals([again.value("pig"), again.log.have()[kd], await again.log.run(kd, 1)], [
		{ n: 40 },
		40,
		undefined,
	])
	join(again, k, true)
	k.put("pig", { n: 41 })
	await until(() => again.log.count(kd) === 41)
	assertEquals(again.value("pig"), { n: 41 })
	closeAll()
	await again.log.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("forgets: its own steps go only once a link to a keeper has said it holds them", async () => {
	const k = await device(), plain = await device(), d = await device({ forgets: true })
	join(d, plain)
	const unlink = join(d, k, true)
	d.put("pig", 1), d.put("pig", 2), d.put("pig", 3)
	const me = d.log.device!
	await until(() => k.log.count(me) === 3 && plain.log.count(me) === 3)
	await d.history.forget(d.sync)
	assert(await d.log.run(me, 1), "let go before a keeper said it holds them")
	unlink()
	join(d, k, true)
	await tick(100)
	await d.history.forget(d.sync)
	assertEquals(await d.log.run(me, 1), undefined)
	closeAll()
})

Deno.test("forgets: a late step older than the newest is merged in, as on a device holding every step", async () => {
	const w1 = createLog({ writes: true }), w2 = createLog({ writes: true })
	await w1.load(), await w2.load()
	const write = (w: Log, node: string, patches: { path: string[]; value: unknown }[]) =>
		w.write({ node, part: "value", patches, when: 0, ids: named(w, node, patches) })
	write(w1, "pig", [{ path: [], value: { a: 1 } }])
	const first = (await w1.run(w1.device!, 1))!
	await w2.take(first)
	for (let i = 0; i < 3; i++) write(w2, "other", [{ path: [], value: i }])
	write(w2, "pig", [{ path: ["b"], value: 2 }])
	write(w1, "pig", [{ path: ["c"], value: 3 }])
	const lofi = await device({ forgets: true }), keeper = await device()
	for (const d of [lofi, keeper]) {
		await d.log.take(first)
		await d.log.take((await w2.run(w2.device!, 1))!)
		await d.log.take((await w1.run(w1.device!, 2))!)
	}
	assertEquals(lofi.value("pig"), { a: 1, b: 2, c: 3 })
	assertEquals(keeper.value("pig"), { a: 1, b: 2, c: 3 })
	assertEquals(lofi.history.failed, [])
})

Deno.test("forgets: a late step needing steps after it works the entry out again from the log; once runs are let go it is passed over", async () => {
	const [w1, w2, w3] = [0, 1, 2].map(() => createLog({ writes: true }))
	for (const w of [w1, w2, w3]) await w.load()
	const write = (
		w: Log,
		patches: { path: string[]; value?: unknown; move?: { path: string[] } }[],
	) => w.write({ node: "pig", part: "value", patches, when: 0, ids: named(w, "pig", patches) })
	const last = async (w: Log) => (await w.run(w.device!, w.count(w.device!)))!
	write(w2, [{ path: [], value: { a: 1 } }])
	await w1.take(await last(w2))
	write(w1, [{ path: [], value: { a: 2, b: {} } }])
	await w3.take(await last(w1))
	write(w3, [{ path: ["b", "x"], value: 3 }])
	const runs = [await last(w1), await last(w3), await last(w2)]
	const late = await device({ forgets: true }), keeper = await device()
	for (const d of [late, keeper]) for (const r of runs) await d.log.take(r)
	assertEquals(keeper.value("pig"), { a: 2, b: { x: 3 } })
	assertEquals([late.value("pig"), late.history.failed], [{ a: 2, b: { x: 3 } }, []])
	const gone = await device({ forgets: true })
	join(gone, keeper, true)
	await until(() => gone.log.count(w3.device!) === 1 && gone.log.count(w2.device!) === 1)
	await gone.history.forget(gone.sync)
	closeAll()
	write(w3, [{ path: ["d"], value: 4 }])
	// names a container whose maker's step has not landed there
	w2.write({
		node: "pig",
		part: "value",
		patches: [{ path: ["z"], value: 5 }],
		when: 0,
		ids: [[[unhex(w3.device!), 99, 0], []]],
	})
	await gone.log.take(await last(w3))
	await gone.log.take(await last(w2))
	assertEquals(gone.value("pig"), { a: 2, b: { x: 3 }, d: 4 })
	assertEquals(gone.history.failed.map((f) => f.why), ["late, and the steps after it let go"])
})

const last = async (w: Log) => (await w.run(w.device!, w.count(w.device!)))!
async function all(to: Device, w: Log) {
	while (to.log.count(w.device!) < w.count(w.device!)) {
		await to.log.take((await w.run(w.device!, to.log.count(w.device!) + 1))!)
	}
}
async function drain(to: Log, w: Log) {
	while (to.count(w.device!) < w.count(w.device!)) {
		await to.take((await w.run(w.device!, to.count(w.device!) + 1))!)
	}
}
// log.step reads counted from now on
function reads(d: Device) {
	const step = d.log.step.bind(d.log), seen = { n: 0 }
	d.log.step = (device: string, n: number) => (seen.n++, step(device, n))
	return seen
}
const put = (w: Log, node: string, path: (string | number)[], value: unknown) =>
	w.write({
		node,
		part: "value",
		patches: [{ path, value }],
		when: 0,
		ids: named(w, node, [{ path }]),
	})

Deno.test("forgets: a late step after a reload goes in as it is, the log held or let go; never dropped", async () => {
	const w1 = createLog({ writes: true }), w2 = createLog({ writes: true })
	await w1.load(), await w2.load()
	put(w1, "pig", [], { a: 1 })
	await w2.take(await last(w1))
	put(w2, "bump", [], 1)
	put(w2, "pig", ["b"], 2)
	put(w1, "pig", ["c"], 3)
	for (const let_go of [false, true]) {
		const dir = await Deno.makeTempDir()
		const d = await device({ store: fileStore(dir), forgets: true })
		await d.log.take((await w1.run(w1.device!, 1))!)
		await d.log.take((await w2.run(w2.device!, 1))!)
		await d.history.snapshot()
		if (let_go) d.log.drop({ [w1.device!]: 1, [w2.device!]: 1 })
		await d.log.saved()
		await d.log.close()
		const again = await device({ store: fileStore(dir), forgets: true })
		await again.log.take((await w1.run(w1.device!, 2))!)
		assertEquals(again.value("pig"), { a: 1, b: 2, c: 3 })
		assertEquals(again.history.failed, [])
		await again.log.close()
		await Deno.remove(dir, { recursive: true })
	}
})

Deno.test("forgets: a late keystroke into an entry with a step that fails for good reads nothing of the log", async () => {
	const [wa, wb, wo, wc] = [0, 1, 2, 3].map(() => createLog({ writes: true }))
	for (const w of [wa, wb, wo, wc]) await w.load()
	put(wa, "doc", [], { s: "hello" })
	await wb.take(await last(wa))
	for (let i = 0; i < 300; i++) put(wc, `n${i % 20}`, [], i)
	wo.write({
		node: "doc",
		part: "value",
		patches: [{ path: ["s", "y"], value: 1 }],
		when: 0,
		ids: [[[unhex(wa.device!), 1, 0, "s"], []]],
	})
	const r = await device({ forgets: true })
	await all(r, wa), await all(r, wc), await all(r, wo)
	assertEquals(r.history.failed.length, 1)
	const seen = reads(r)
	const late = [wa, wb].sort((x, y) => x.device! < y.device! ? 1 : -1)
	for (let i = 0; i < 20; i++) {
		put(wa, "doc", [`a${i}`], i), put(wb, "doc", [`b${i}`], i)
		for (const w of late) await r.log.take((await w.run(w.device!, w.count(w.device!)))!)
	}
	assertEquals(r.history.failed.length, 1)
	assert(seen.n < 100, `read ${seen.n} steps of the log`)
})

Deno.test("forgets: the log is read once for all the entries a catch-up lands early in", async () => {
	const [wa, wc] = [0, 1].map(() => createLog({ writes: true }))
	for (const w of [wa, wc]) await w.load()
	const E = 10
	for (let i = 0; i < E; i++) put(wa, `e${i}`, [], { x: 0 })
	await wc.take((await wa.run(wa.device!, 1))!)
	for (let i = 0; i < 200; i++) put(wa, "fill", [], i)
	for (let i = 0; i < E; i++) put(wa, `e${i}`, ["x"], 1)
	for (let i = 0; i < E; i++) put(wc, `e${i}`, [], { x: 2, y: 2 })
	const r = await device({ forgets: true })
	await all(r, wa)
	const seen = reads(r)
	await all(r, wc)
	// wa's edits name the roots it put, which wc's puts of the whole value replaced
	for (let i = 0; i < E; i++) assertEquals(r.value(`e${i}`), { x: 2, y: 2 })
	assert(
		seen.n < 3 * (wa.count(wa.device!) + wc.count(wc.device!)),
		`read ${seen.n} steps of the log`,
	)
})

// a writes "hello" and b types X at 0; the forgetting device takes both and reloads; a types Y after
// the o, not having seen X
async function typed(let_go: boolean) {
	const a = await device(), b = await device(), A = a.log.device!, B = b.log.device!
	const dir = await Deno.makeTempDir()
	const f = await device({ store: fileStore(dir), forgets: true })
	a.put("doc", { s: "hello" })
	await all(f, a.log), await all(b, a.log)
	b.patch("doc", [{ path: ["s"], range: [0, 0], value: "X" }])
	await all(f, b.log)
	await tick()
	await f.history.snapshot()
	if (let_go) f.log.drop({ [A]: 1, [B]: 1 })
	await f.log.saved(), await f.log.close()
	const g = await device({ store: fileStore(dir), forgets: true })
	a.put("bump", 1)
	a.patch("doc", [{ path: ["s"], range: [5, 5], value: "Y" }])
	await all(g, a.log), await all(b, a.log)
	await all(a, b.log)
	await tick(100)
	return { a, b, g, dir }
}

Deno.test("forgets: after a reload a step by ids that lands last goes in by its ids", async () => {
	const { a, g, dir } = await typed(false)
	assertEquals([a.value("doc"), g.value("doc"), g.history.failed], [{ s: "XhelloY" }, {
		s: "XhelloY",
	}, []])
	await g.log.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("forgets: after a reload with runs let go a step by ids that lands last goes in by its ids, its snapshot holding the elements", async () => {
	const { g, dir } = await typed(true)
	assertEquals([g.value("doc"), g.history.failed], [{ s: "XhelloY" }, []])
	await g.log.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("forgets: after a reload the device's own writes name ids", async () => {
	const a = await device()
	const dir = await Deno.makeTempDir()
	const f = await device({ store: fileStore(dir), forgets: true })
	a.put("doc", { s: "hello" })
	await all(f, a.log)
	await tick()
	await f.history.snapshot(), await f.log.saved(), await f.log.close()
	const g = await device({ store: fileStore(dir), forgets: true })
	g.patch("doc", [{ path: ["s"], range: [5, 5], value: "!" }])
	const me = g.log.device!
	assert(decodeStep(g.log.step(me, 1)).ids?.some(Boolean), "written by its range")
	await g.log.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("forgets: a late put of the whole value under a newer one is passed over, reading nothing of the log, failing nothing", async () => {
	const [wa, wb] = [0, 1].map(() => createLog({ writes: true }))
	for (const w of [wa, wb]) await w.load()
	const [lo, hi] = [wa, wb].sort((x, y) => x.device! < y.device! ? -1 : 1)
	put(wa, "pig", [], { n: 0 })
	await wb.take(await last(wa))
	for (let i = 0; i < 200; i++) put(wa, `n${i % 20}`, [], i)
	const r = await device({ forgets: true }), keeper = await device()
	await all(r, wa), await all(keeper, wa), await drain(wb, wa)
	await r.history.forget({ passed: () => r.log.have() })
	const seen = reads(r)
	for (let i = 1; i <= 5; i++) {
		put(lo, "pig", [], { n: i, by: "lo" }), put(hi, "pig", [], { n: i, by: "hi" })
		for (const d of [r, keeper]) await all(d, hi), await all(d, lo)
		await drain(lo, hi), await drain(hi, lo)
		await tick()
	}
	assertEquals([r.value("pig"), r.history.failed], [{ n: 5, by: "hi" }, []])
	assertEquals([keeper.value("pig"), keeper.history.failed], [{ n: 5, by: "hi" }, []])
	assertEquals(seen.n, 0)
})

Deno.test("forgets: a late put of the whole value under a newer one is passed over after a reload too", async () => {
	const [wa, wb] = [0, 1].map(() => createLog({ writes: true }))
	for (const w of [wa, wb]) await w.load()
	const [lo, hi] = [wa, wb].sort((x, y) => x.device! < y.device! ? -1 : 1)
	put(hi, "pig", [], { n: 0 })
	await lo.take(await last(hi))
	put(lo, "pig", [], { n: 1, by: "lo" }), put(hi, "pig", [], { n: 1, by: "hi" })
	const dir = await Deno.makeTempDir()
	let r = await device({ store: fileStore(dir), forgets: true })
	await all(r, hi)
	await r.history.forget({ passed: () => r.log.have() })
	await r.log.saved()
	await r.log.close()
	r = await device({ store: fileStore(dir), forgets: true })
	await all(r, lo)
	await tick(100)
	assertEquals([r.value("pig"), r.history.failed], [{ n: 1, by: "hi" }, []])
	await r.log.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("forgets: a write its elements can't name goes as the graph's whole value, and later typing names elements again", async () => {
	for (const forgets of [false, true]) {
		const a = createLog({ writes: true }), f = await device({ forgets }), r = await device()
		await a.load()
		put(a, "doc", [], { s: "hello" })
		await all(f, a), await all(r, a)
		f.twice("doc", [{ path: ["s"], range: [5, 5], value: "1" }], [{
			path: ["s"],
			range: [6, 6],
			value: "2",
		}])
		assertEquals(f.history.unkept.length, 1)
		f.patch("doc", [{ path: ["s"], range: [0, 0], value: "X" }])
		f.patch("doc", [{ path: ["s"], range: [0, 0], value: "Y" }])
		assertEquals(f.value("doc"), { s: "YXhello12" })
		assertEquals(f.log.count(f.log.device!), 3)
		await all(r, f.log)
		await tick()
		assertEquals([r.value("doc"), r.history.failed], [{ s: "YXhello12" }, []])
		assertEquals(f.history.unkept.length, 1)
	}
})

// the entry's step that fails for good: a key put into a string
const bad = (w: Log, y: string) =>
	w.write({
		node: "doc",
		part: "value",
		patches: [{ path: ["s", "y"], value: 1 }],
		when: 0,
		ids: [[[unhex(y), 1, 0, "s"], []]],
	})

Deno.test("forgets: a null whole value is still there after a reload, with the runs let go", async () => {
	for (const forgets of [true, false]) {
		const a = await device(), A = a.log.device!, dir = await Deno.makeTempDir()
		const f = await device({ store: fileStore(dir), forgets })
		a.put("doc", null)
		a.put("other", 1)
		await all(f, a.log)
		await f.history.snapshot()
		f.log.drop({ [A]: 2 })
		await f.log.saved(), await f.log.close()
		const g = await device({ store: fileStore(dir), forgets })
		assertEquals([g.value("doc"), g.value("other")], [null, 1])
		assertEquals(g.history.versions("doc", "value").map((v) => v.value), forgets ? [null] : [])
		await g.log.close()
		await Deno.remove(dir, { recursive: true })
	}
})

Deno.test("forgets: after a reload with runs let go a late step that applies is applied once, a failed step after it", async () => {
	const a = await device(), b = await device(), A = a.log.device!
	const o = createLog({ writes: true })
	await o.load()
	const dir = await Deno.makeTempDir()
	const f = await device({ store: fileStore(dir), forgets: true })
	a.put("doc", { s: "hello" })
	await all(f, a.log), await all(b, a.log)
	await o.take((await a.log.run(A, 1))!)
	await f.history.snapshot()
	f.log.drop({ [A]: 1 })
	await f.log.saved(), await f.log.close()
	const g = await device({ store: fileStore(dir), forgets: true })
	b.patch("doc", [{ path: ["s"], range: [5, 5], value: "!" }])
	for (let i = 0; i < 9; i++) put(o, "bump", [], i)
	bad(o, A)
	await all(g, o)
	assertEquals(g.history.failed.length, 1)
	await all(g, b.log)
	assertEquals(g.value("doc"), { s: "hello!" })
	await g.log.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("forgets: a step that failed before a reload is tried again when the step it needed lands", async () => {
	for (const reload of [false, true]) {
		const y = createLog({ writes: true }), x = createLog({ writes: true })
		await y.load(), await x.load()
		put(y, "doc", [], { a: 1 })
		await x.take(await last(y))
		x.write({
			node: "doc",
			part: "value",
			patches: [{ path: ["z"], value: 5 }],
			when: 0,
			ids: [[[unhex(y.device!), 1, 0], []]],
		})
		for (let i = 0; i < 3; i++) put(x, "bump", [], i)
		const dir = await Deno.makeTempDir()
		let f = await device({ store: fileStore(dir), forgets: true })
		await drain(f.log, x)
		assertEquals(f.history.failed.length, 1)
		if (reload) {
			await f.history.snapshot(), await f.log.saved(), await f.log.close()
			f = await device({ store: fileStore(dir), forgets: true })
			assertEquals(f.history.failed.length, 1)
		}
		await drain(f.log, y)
		await tick()
		assertEquals([f.value("doc"), f.history.failed], [{ a: 1, z: 5 }, []])
		await f.log.close()
		await Deno.remove(dir, { recursive: true })
	}
})

Deno.test("forgets: a snapshot from before its format mark is still read", async () => {
	for (const forgets of [true, false]) {
		const dir = await Deno.makeTempDir()
		const f = await device({ store: fileStore(dir), forgets })
		await f.log.snapshot(encode({
			count: {},
			entries: [["value", "m", { a: 1 }, [], [], null], ["value", "n", 5, [], [], null], [
				"value",
				"x",
				null,
				[],
				[],
				null,
			]],
		} as never))
		await f.log.saved(), await f.log.close()
		const g = await device({ store: fileStore(dir), forgets })
		assertEquals([g.value("m"), g.value("n"), g.value("x")], [{ a: 1 }, 5, undefined])
		await g.log.close()
		await Deno.remove(dir, { recursive: true })
	}
})
