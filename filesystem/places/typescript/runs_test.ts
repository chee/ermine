import { assert, assertEquals, assertInstanceOf, assertStrictEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createTable, type Key } from "@ermine/table"
import { createScheduler, PENDING } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createChangeHeader } from "./header.ts"
import { createPlaces } from "./places.ts"
import { createRuns, latest, type Read, RUN } from "./runs.ts"

// a world: each computer given a node has its latest run written on it as its runs end
function world() {
	const s = createScheduler()
	s.onTrackingEnd((k) => places.release(k))
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	const runs = createRuns({ places, table, scheduler: s })
	const o = s.createRootScope([["actor", "host"]])
	const other = s.createRootScope([["actor", "other"]])
	for (const k of ["a", "b"]) {
		table.add("value", k, createEntry<unknown>({ x: 0, y: 0 }, { time: 0, actor: "host" }))
	}
	// patches to the value under k, from outside, with scope open (the host: o)
	const edit = (k: string, patches: Patch[], scope = o) =>
		s.runWithScope(scope, () => {
			const e = table.get("value", k)!
			update(e, patches, createChangeHeader(s))
			places.commit([e])
		})
	return { s, table, places, runs, o, other, edit }
}

// a read's where, without its change
const where = (r: Read) => "key" in r ? { key: r.key } : { part: r.part, id: r.id, path: r.path }

Deno.test("runs: a computer reading two nodes records both, in the order first read, each once", () => {
	const { s, places, runs, o } = world()
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			places.readValue("value", "b", ["x"])
			places.readValue("value", "a")
			places.readValue("value", "b", ["x"])
			return 1
		}, () => {}))
	runs.give(c, "C")
	s.pulse()
	const run = latest(places, "C")!
	assertEquals(run.n, 1)
	assertEquals(run.end, "done")
	assert(run.started! <= run.ended)
	assertEquals(run.reads.map(where), [
		{ part: "value", id: "b", path: ["x"] },
		{ part: "value", id: "a", path: [] },
	])
	assertEquals(run.writes, [])
})

Deno.test("runs: a rerun reading the same writes nothing to reads; its number and times are written", () => {
	const { s, places, runs, o } = world()
	const tick = {}
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			s.track(tick)
			return places.readValue("value", "a", ["x"])
		}, () => {}))
	runs.give(c, "C")
	let seen = 0
	s.runWithScope(
		o,
		() =>
			s.createComputer(
				() => places.readValue("attributes", "C", [RUN, "reads"]),
				() => void seen++,
			),
	)
	s.pulse()
	const first = latest(places, "C")!
	assertEquals(first.reads.map(where), [{ key: tick }, { part: "value", id: "a", path: ["x"] }])
	assertEquals(seen, 1)
	s.mark([tick])
	s.pulse()
	const second = latest(places, "C")!
	assertEquals(second.n, 2)
	assertStrictEquals(second.reads, first.reads)
	// the reader of reads did not run again
	assertEquals(seen, 1)
})

Deno.test("runs: a rerun reading differently replaces the reads; the version seen changes when the node is written", () => {
	const { s, table, places, runs, o, other, edit } = world()
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			const x = places.readValue("value", "a", ["x"])
			return x === 1 ? places.readValue("value", "b", ["y"]) : x
		}, () => {}))
	runs.give(c, "C")
	s.pulse()
	const before = latest(places, "C")!.reads[0] as Exclude<Read, { key: unknown }>
	assertStrictEquals(before.change, table.get("value", "a")!.change)
	assertEquals(before.change!.actor, "host")
	edit("a", [{ path: ["x"], value: 1 }], other)
	s.pulse()
	const run = latest(places, "C")!
	assertEquals(run.reads.map(where), [
		{ part: "value", id: "a", path: ["x"] },
		{ part: "value", id: "b", path: ["y"] },
	])
	const after = run.reads[0] as Exclude<Read, { key: unknown }>
	assert(after.change !== before.change)
	assertEquals(after.change!.actor, "other")
	assertEquals(after.change!.op!.patches, [{ path: ["x"], value: 1 }])
})

Deno.test("runs: a pending run records what it read before pending; its landing, done, the same reads", async () => {
	const { s, places, runs, o } = world()
	let resolve!: (v: number) => void
	const gate = new Promise<number>((r) => resolve = r)
	const c = s.runWithScope(o, () =>
		s.createComputer(async () => {
			places.readValue("value", "a", ["x"])
			return await gate
		}, () => {}))
	runs.give(c, "C")
	s.pulse()
	const pending = latest(places, "C")!
	assertEquals(pending.end, "pending")
	assertEquals(pending.reads.map(where), [{ part: "value", id: "a", path: ["x"] }])
	resolve(1)
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	const done = latest(places, "C")!
	assertEquals([done.n, done.end, done.started], [1, "done", pending.started])
	assertStrictEquals(done.reads, pending.reads)
	// and a compute returning the scheduler's PENDING
	const w = s.runWithScope(o, () =>
		s.createComputer(() => {
			places.readValue("value", "b")
			return PENDING
		}, () => {}))
	runs.give(w, "W")
	s.pulse()
	assertEquals(latest(places, "W")!.end, "pending")
	assertEquals(latest(places, "W")!.reads.map(where), [{ part: "value", id: "b", path: [] }])
})

Deno.test("runs: a failed run, its error; looping too", () => {
	const { s, table, places, runs, o } = world()
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			places.readValue("value", "a")
			throw new Error("boom")
		}, () => {}))
	runs.give(c, "C")
	s.pulse()
	const run = latest(places, "C")!
	assertEquals(run.end, "failed")
	assertInstanceOf(run.error, Error)
	assertEquals(run.error.message, "boom")
	assertEquals(run.reads.map(where), [{ part: "value", id: "a", path: [] }])
	// a compute setting what it reads: a loop through itself
	const l = s.runWithScope(
		o,
		() =>
			s.createComputer(() => places.readValue("value", "b", ["x"]) as number, (v) => {
				const e = table.get("value", "b")!
				update(e, [{ path: ["x"], value: v + 1 }], createChangeHeader(s))
				places.commit([e])
			}),
	)
	runs.give(l, "L")
	s.pulse()
	const looped = latest(places, "L")!
	assertEquals(looped.end, "looping")
	assertEquals(looped.error!.message, "looping")
})

Deno.test("runs: writes, each with its change: the run's code, its set, an effect's act; a host's write in it is not", () => {
	const { s, table, places, runs, o, edit } = world()
	// a compute whose set writes b, and whose run writes a's y
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			const x = places.readValue("value", "a", ["x"]) as number
			const e = table.get("value", "a")!
			update(e, [{ path: ["y"], value: x }], createChangeHeader(s))
			places.commit([e])
			return x
		}, (v) => {
			const e = table.get("value", "b")!
			update(e, [{ path: ["x"], value: v }], createChangeHeader(s))
			places.commit([e])
		}))
	runs.give(c, "C")
	s.pulse()
	const run = latest(places, "C")!
	assertEquals(run.writes.map((w) => [w.part, w.id, w.change?.op?.patches]), [
		["value", "a", [{ path: ["y"], value: 0 }]],
		["value", "b", [{ path: ["x"], value: 0 }]],
	])
	// its own run in the metadata
	assertEquals(run.writes[0].change!.metadata![0], ["run", 1])
	// an effect: its act's writes come after its run's end
	const e = s.runWithScope(
		o,
		() =>
			s.createEffect(() => places.readValue("value", "b", ["x"]), (v) => {
				const there = table.get("value", "a")!
				update(there, [{ path: ["x"], value: v }], createChangeHeader(s))
				places.commit([there])
			}),
	)
	runs.give(e, "E")
	s.pulse()
	assertEquals(latest(places, "E")!.writes.map((w) => [w.part, w.id]), [["value", "a"]])
	// a write from outside lands in no record
	const writes = latest(places, "C")!.writes
	edit("b", [{ path: ["y"], value: 9 }])
	assertStrictEquals(latest(places, "C")!.writes, writes)
})

Deno.test("runs: a run that read a record writes none, so readers of records stop", () => {
	const { s, places, runs, o, edit } = world()
	let runsOfSelf = 0
	const self = s.runWithScope(o, () =>
		s.createComputer(() => {
			runsOfSelf++
			places.readValue("value", "a", ["x"])
			return places.readValue("attributes", "S")
		}, () => {}))
	runs.give(self, "S")
	// two reading each other's
	const p = s.runWithScope(o, () =>
		s.createComputer(() => {
			places.readValue("value", "a", ["x"])
			return places.readValue("attributes", "Q", [RUN, "n"])
		}, () => {}))
	const q = s.runWithScope(
		o,
		() => s.createComputer(() => places.readValue("attributes", "P", [RUN, "n"]), () => {}),
	)
	runs.give(p, "P")
	runs.give(q, "Q")
	s.pulse()
	edit("a", [{ path: ["x"], value: 1 }])
	s.pulse()
	// its first run read no record yet, so it ran once more, then stopped
	assertEquals(runsOfSelf, 3)
	assertEquals(latest(places, "S")!.n, 1)
	assertEquals(latest(places, "P"), undefined)
	assertEquals(latest(places, "Q"), undefined)
})

Deno.test("runs: a computer not given a node writes none; stop stops", () => {
	const { s, table, places, runs, o, edit } = world()
	const c = s.runWithScope(
		o,
		() => s.createComputer(() => places.readValue("value", "a"), () => {}),
	)
	s.runWithScope(o, () => s.createComputer(() => places.readValue("value", "a"), () => {}))
	runs.give(c, "C")
	s.pulse()
	assertEquals([...table.get("C")].map(([part]) => part), ["attributes"])
	runs.stop()
	edit("a", [{ path: ["x"], value: 1 }])
	s.pulse()
	assertEquals(latest(places, "C")!.n, 1)
})
