// a device that forgets (history.ts): not a history keeper. it lets a run go once the run is in a
// snapshot and has passed on, its own only once a keeper holds them; a reload keeps what it let go
// let go; a late step older than the newest it holds is passed over
import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key } from "@ermine/table"
import { children, createPlaces } from "@ermine/places"
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
	}
}
type Device = Awaited<ReturnType<typeof device>>

// a link between two devices; keeper: b keeps every run (a's end says so)
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
	// one that comes to it now is sent none of them
	const late = await device()
	join(late, d)
	await tick(100)
	assertEquals(late.log.count(kd), 0)
	closeAll()
	await d.log.close()
	// loaded again: the graph from the snapshot, the steps counted, none to send; more go on from there
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
	// the keeper said it held none when the link began
	await d.history.forget(d.sync)
	assert(await d.log.run(me, 1), "let go before a keeper said it holds them")
	// linked again: its have says 3
	unlink()
	join(d, k, true)
	await tick(100)
	await d.history.forget(d.sync)
	assertEquals(await d.log.run(me, 1), undefined)
	closeAll()
})

Deno.test("forgets: a late step older than the newest is passed over, not merged in", async () => {
	const w1 = createLog({ writes: true }), w2 = createLog({ writes: true })
	await w1.load(), await w2.load()
	const write = (w: Log, node: string, patches: { path: string[]; value: unknown }[]) =>
		w.write({ node, part: "value", patches, when: 0 })
	write(w1, "pig", [{ path: [], value: { a: 1 } }])
	const first = (await w1.run(w1.device!, 1))!
	await w2.take(first)
	for (let i = 0; i < 3; i++) write(w2, "other", [{ path: [], value: i }])
	write(w2, "pig", [{ path: ["b"], value: 2 }])
	// w1, not knowing w2's: older by lamport
	write(w1, "pig", [{ path: ["c"], value: 3 }])
	const lofi = await device({ forgets: true }), keeper = await device()
	for (const d of [lofi, keeper]) {
		await d.log.take(first)
		await d.log.take((await w2.run(w2.device!, 1))!)
		await d.log.take((await w1.run(w1.device!, 2))!)
	}
	assertEquals(lofi.value("pig"), { a: 1, b: 2 })
	assertEquals(keeper.value("pig"), { a: 1, b: 2, c: 3 })
	assertEquals(lofi.history.failed, [])
})
