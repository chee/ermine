import {
	assert,
	assertEquals,
	assertInstanceOf,
	assertStrictEquals,
	assertThrows,
} from "@std/assert"
import createEntry from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createPlaces } from "@ermine/places"
import { createGuard, Refusal } from "./guard.ts"
import { createChangeHeader } from "@ermine/places/header"
import { no, yes } from "@ermine/protect"
import { createTable, type Key } from "@ermine/graph/table"
import { createScheduler, PENDING } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createRuns, type Read } from "./runs.ts"

// a world: each computer given a node has its latest run in the runs' table as its runs end
function world() {
	const s = createScheduler()
	s.onTrackingEnd((k) => places.release(k))
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	const runs = createRuns({ places, table, scheduler: s })
	const o = s.createRootScope({ actor: "host" })
	const other = s.createRootScope({ actor: "other" })
	for (const k of ["a", "b"]) {
		table.add(
			"value",
			k,
			createEntry<unknown>({ x: 0, y: 0 }, {
				time: 0,
				actor: "host",
				frame: { info: {}, parent: undefined },
			}),
		)
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
	const run = runs.read("C")!
	assertEquals(run.n, 1)
	assertEquals(run.end, "done")
	assert(run.started! <= run.ended)
	assertEquals(run.reads.map(where), [
		{ part: "value", id: "b", path: ["x"] },
		{ part: "value", id: "a", path: [] },
	])
	assertEquals(run.writes, [])
})

Deno.test("runs: the record is not in the graph's table, and no table event is made", () => {
	const { s, table, places, runs, o } = world()
	let events = 0
	places.watchAll(() => void events++)
	const c = s.runWithScope(
		o,
		() => s.createComputer(() => places.readValue("value", "a"), () => {}),
	)
	runs.give(c, "C")
	s.pulse()
	assertEquals(runs.read("C")!.n, 1)
	assertEquals([...table.get("C")], [])
	assertEquals(events, 0)
})

Deno.test("runs: a rerun reading the same keeps its reads; a reader of reads does not rerun, a reader of n does", () => {
	const { s, places, runs, o } = world()
	const tick = {}
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			s.track(tick)
			return places.readValue("value", "a", ["x"])
		}, () => {}))
	runs.give(c, "C")
	let reads = 0, ns = 0
	s.runWithScope(
		o,
		() => s.createComputer(() => runs.read("C", "reads") ?? null, () => void reads++),
	)
	s.runWithScope(o, () => s.createComputer(() => runs.read("C", "n") ?? null, () => void ns++))
	s.pulse()
	const first = runs.read("C")!
	assertEquals(first.reads.map(where), [{ key: tick }, { part: "value", id: "a", path: ["x"] }])
	assertEquals([reads, ns], [1, 1])
	s.mark([tick])
	s.pulse()
	const second = runs.read("C")!
	assertEquals(second.n, 2)
	assertStrictEquals(second.reads, first.reads)
	assertEquals([reads, ns], [1, 2])
})

Deno.test("runs: a read's change is the entry's header itself; a rerun reading differently replaces the reads", () => {
	const { s, table, places, runs, o, other, edit } = world()
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			const x = places.readValue("value", "a", ["x"])
			return x === 1 ? places.readValue("value", "b", ["y"]) : x
		}, () => {}))
	runs.give(c, "C")
	s.pulse()
	const before = runs.read("C")!.reads[0] as Exclude<Read, { key: unknown }>
	assertStrictEquals(before.change, table.get("value", "a")!.change)
	assertEquals(before.change!.actor, "host")
	edit("a", [{ path: ["x"], value: 1 }], other)
	s.pulse()
	const run = runs.read("C")!
	assertEquals(run.reads.map(where), [
		{ part: "value", id: "a", path: ["x"] },
		{ part: "value", id: "b", path: ["y"] },
	])
	const after = run.reads[0] as Exclude<Read, { key: unknown }>
	assertStrictEquals(after.change, table.get("value", "a")!.change)
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
	const pending = runs.read("C")!
	assertEquals(pending.end, "pending")
	assertEquals(pending.reads.map(where), [{ part: "value", id: "a", path: ["x"] }])
	resolve(1)
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	const done = runs.read("C")!
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
	assertEquals(runs.read("W")!.end, "pending")
	assertEquals(runs.read("W")!.reads.map(where), [{ part: "value", id: "b", path: [] }])
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
	const run = runs.read("C")!
	assertEquals(run.end, "failed")
	assertInstanceOf(run.error, Error)
	assertEquals((run.error as Error).message, "boom")
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
	const looped = runs.read("L")!
	assertEquals(looped.end, "looping")
	assertEquals((looped.error as Error).message, "looping")
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
	const run = runs.read("C")!
	assertEquals(run.writes.map((w) => [w.part, w.id, w.change?.op?.patches]), [
		["value", "a", [{ path: ["y"], value: 0 }]],
		["value", "b", [{ path: ["x"], value: 0 }]],
	])
	assertStrictEquals(run.writes[1].change, table.get("value", "b")!.change)
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
	assertEquals(runs.read("E")!.writes.map((w) => [w.part, w.id]), [["value", "a"]])
	// a write from outside lands in no record
	const writes = runs.read("C")!.writes
	edit("b", [{ path: ["y"], value: 9 }])
	assertStrictEquals(runs.read("C")!.writes, writes)
})

Deno.test("runs: records read in a loop (its own, each other's) end looping, as the scheduler sees any loop", () => {
	const { s, places, runs, o, edit } = world()
	const counts = { S: 0, P: 0, Q: 0 }
	const self = s.runWithScope(o, () =>
		s.createComputer(() => {
			counts.S++
			places.readValue("value", "a", ["x"])
			return runs.read("S", "n") ?? null
		}, () => {}))
	const p = s.runWithScope(o, () =>
		s.createComputer(() => {
			counts.P++
			places.readValue("value", "a", ["x"])
			return runs.read("Q", "n") ?? null
		}, () => {}))
	const q = s.runWithScope(o, () =>
		s.createComputer(() => {
			counts.Q++
			return runs.read("P", "n") ?? null
		}, () => {}))
	runs.give(self, "S")
	runs.give(p, "P")
	runs.give(q, "Q")
	s.pulse()
	assertEquals([runs.read("S")!.end, runs.read("P")!.end, runs.read("Q")!.end], [
		"looping",
		"looping",
		"looping",
	])
	const before = { ...counts }
	edit("a", [{ path: ["x"], value: 1 }])
	s.pulse()
	assertEquals(runs.read("S")!.end, "looping")
	// each ran again a bounded number of times
	assert(counts.S - before.S <= 2 && counts.P - before.P <= 3 && counts.Q - before.Q <= 3)
})

Deno.test("runs: a read asks the reader's guard as reading the computer's node; a no throws", () => {
	const { s, table, places, runs, o } = world()
	const c = s.runWithScope(
		o,
		() => s.createComputer(() => places.readValue("value", "a"), () => {}),
	)
	runs.give(c, "C")
	s.pulse()
	const asked: unknown[] = []
	const guard = createGuard({
		places,
		table,
		scheduler: s,
		may: (
			ask,
		) => (asked.push([ask.op, ask.target.id, ask.target.part]),
			ask.target.id === "C" ? no("not yours") : yes),
	})
	assertThrows(() => s.runWithScope(o, () => runs.read("C", guard)), Refusal)
	assertThrows(() => s.runWithScope(o, () => runs.read("C", "reads", guard)), Refusal)
	assertEquals(asked, [["read", "C", undefined], ["read", "C", undefined]])
	const open = createGuard({ places, table, scheduler: s, may: () => yes })
	assertEquals(s.runWithScope(o, () => runs.read("C", "n", open)), 1)
})

Deno.test("runs: drop takes the record out and tells its readers; a computer not given a node has none; stop stops", () => {
	const { s, places, runs, o, edit } = world()
	const c = s.runWithScope(
		o,
		() => s.createComputer(() => places.readValue("value", "a"), () => {}),
	)
	s.runWithScope(o, () => s.createComputer(() => places.readValue("value", "a"), () => {}))
	runs.give(c, "C")
	let seen: unknown = "never"
	s.runWithScope(
		o,
		() => s.createComputer(() => runs.read("C", "n") ?? null, (v) => void (seen = v)),
	)
	s.pulse()
	assertEquals(seen, 1)
	runs.drop("C")
	s.pulse()
	assertEquals(seen, null)
	assertEquals(runs.read("C"), undefined)
	edit("a", [{ path: ["x"], value: 1 }])
	s.pulse()
	assertEquals(runs.read("C")!.n, 2)
	runs.stop()
	edit("a", [{ path: ["x"], value: 2 }])
	s.pulse()
	assertEquals(runs.read("C")!.n, 2)
})

Deno.test("runs: a throw that is not an Error is kept as thrown, in a run's error and an act's", () => {
	const { s, places, runs, o } = world()
	const thrown = { code: 7 }
	const f = s.runWithScope(o, () =>
		s.createComputer(() => {
			places.readValue("value", "a")
			throw thrown
		}, () => {}))
	runs.give(f, "F")
	const g = s.runWithScope(
		o,
		() =>
			s.createEffect(() => places.readValue("value", "b", ["x"]), () => {
				throw "plain"
			}),
	)
	runs.give(g, "G")
	s.pulse()
	assertStrictEquals(runs.read("F")!.error, thrown)
	assertEquals(runs.read("G")!.act, { end: "failed", error: "plain" })
})

Deno.test("runs: an act that does not throw is done; one that throws is failed; none before it ran", () => {
	const { s, places, runs, o, edit } = world()
	let bad = false
	const e = s.runWithScope(
		o,
		() =>
			s.createEffect(() => places.readValue("value", "a", ["x"]), () => {
				if (bad) throw new Error("act boom")
			}),
	)
	runs.give(e, "E")
	s.pulse()
	assertEquals(runs.read("E")!.act, { end: "done" })
	bad = true
	edit("a", [{ path: ["x"], value: 1 }])
	s.pulse()
	const act = runs.read("E")!.act!
	assertEquals(act.end, "failed")
	assertEquals((act as { error: Error }).error.message, "act boom")
	// a compute has none
	const c = s.runWithScope(o, () => s.createComputer(() => 1, () => {}))
	runs.give(c, "C")
	s.pulse()
	assertEquals(runs.read("C")!.act, undefined)
})

Deno.test("runs: a run that reads a node and then writes it names the change before its write", () => {
	const { s, places, table, runs, o } = world()
	const before = table.get("value", "a")!.change
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			places.readValue("value", "a", ["y"])
			const e = table.get("value", "a")!
			update(e, [{ path: ["x"], value: 5 }], createChangeHeader(s))
			places.commit([e])
			return 1
		}, () => {}))
	runs.give(c, "C")
	s.pulse()
	const run = runs.read("C")!
	const read = run.reads[0] as { change: unknown }
	assertStrictEquals(read.change, before)
	assert(table.get("value", "a")!.change !== before)
	assertEquals(run.writes.length, 1)
})
