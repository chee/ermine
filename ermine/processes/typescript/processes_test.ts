// processes at paths on a real scheduler, table and places given [processes(R), children]: read
// through lib.ts, and through the path cache. numbers are printed with -- -v
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { type Computer, createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, type Contributor, createPlaces, PlacesError, rename } from "@ermine/places"
import { get, gets, list, lookup, members } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { createPathCache } from "@ermine/places/cache"
import { addProcess, PROCESS, processes, removeProcess } from "./processes.ts"

const verbose = Deno.args.includes("-v")
const say = (...a: unknown[]) => verbose && console.log(...a)

// cached: false, no cache made (plain places, as a host without one has it)
function world(cached = true) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	// the rows' contributor, its steps counted (asked)
	let steps = 0
	const trie = processes("R")
	const counted: Contributor = {
		...trie,
		step: (here, name, r) => (steps++, trie.step(here, name, r)),
	}
	const places = createPlaces({
		root: "R",
		table,
		paths,
		scheduler: s,
		contributors: [counted, children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const cache = cached ? createPathCache({ places, scheduler: s }) : undefined!
	const host = s.createRootScope([["actor", "host"]])
	const notes = s.createRootScope([["actor", "notes"]])
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, header())))
	type W<T> = { runs: number; value: T | undefined; values: T[]; c: Computer }
	function watch<T>(f: () => T): W<T> {
		const w = { runs: 0, value: undefined, values: [] } as unknown as W<T>
		w.c = s.runWithScope(notes, () =>
			s.createComputer(() => (w.runs++, f()), (v) => {
				w.value = v
				w.values.push(v)
			}))
		return w
	}
	// R/work/clock is saved (C0, with on/reset); P is a process's node, with its own on/reset
	function tree() {
		kids("R", { work: "W" })
		kids("W", { clock: "C0", notes: "N" })
		kids("C0", { on: "ON0" })
		kids("ON0", { reset: "RS0" })
		kids("N", {})
		kids("P", { on: "PON" })
		kids("PON", { reset: "PRS" })
	}
	const start = (path: string[], id: Id) =>
		hosted(() => places.commit(addProcess(table, "R", path, id, header())))
	const stop = (path: string[]) =>
		hosted(() => places.commit(removeProcess(table, "R", path, header())))
	const rows = () => table.get(PROCESS, "R")?.value
	const count = () => ({
		...(cache?.kept() ?? { entries: 0, reads: 0 }),
		spots: paths.kept().spots,
	})
	return {
		s,
		table,
		places,
		cache,
		// the steps the rows were asked since last asked
		asked: () => {
			const n = steps
			steps = 0
			return n
		},
		hosted,
		kids,
		watch,
		tree,
		start,
		stop,
		rows,
		count,
		rename: (parent: Id, a: string, b: string) =>
			hosted(() => places.commit(rename(table.get("children", parent)!, a, b, header()))),
	}
}
type World = ReturnType<typeof world>

const refused = (f: () => unknown, code: string) => {
	const e = assertThrows(f, PlacesError)
	assertEquals(e.code, code)
}

Deno.test("a process at /work/clock shadows the saved clock; at its stop the saved one is back", () => {
	const w = world()
	w.tree()
	const top = w.watch(() => get(w.places, ["work", "clock"]))
	w.s.pulse()
	w.start(["work", "clock"], "P")
	assertEquals(get(w.places, ["work", "clock"]), "P")
	assertEquals(gets(w.places, ["work", "clock"]), [
		{ id: "P", from: "process" },
		{ id: "C0", from: "children" },
	])
	// the folder's saved children are as they were
	assertEquals(w.table.get("children", "W")!.value, { clock: "C0", notes: "N" })
	w.s.pulse()
	w.stop(["work", "clock"])
	w.s.pulse()
	assertEquals(top.values, ["C0", "P", "C0"])
	assertEquals(gets(w.places, ["work", "clock"]), [{ id: "C0", from: "children" }])
})

Deno.test("./on/reset under a process: the process's own children, inside its node", () => {
	const w = world()
	w.tree()
	const deep = w.watch(() => get(w.places, ["work", "clock", "on", "reset"]))
	w.s.pulse()
	w.start(["work", "clock"], "P")
	w.s.pulse()
	w.stop(["work", "clock"])
	w.s.pulse()
	assertEquals(deep.values, ["RS0", "PRS", "RS0"])
	// a process where nothing is saved: its inside is all there is
	w.start(["work", "timer"], "P")
	assertEquals(get(w.places, ["work", "timer", "on", "reset"]), "PRS")
	assertEquals([...list(w.places, ["work", "timer"])], ["on"])
})

Deno.test("a second start where one runs is refused; above or under one too; a stop where none runs", () => {
	const w = world()
	w.tree()
	w.start(["work", "clock"], "P")
	refused(() => w.start(["work", "clock"], "Q"), "already-there")
	refused(() => w.start(["work", "clock", "x"], "Q"), "already-there")
	refused(() => w.start(["work"], "Q"), "already-there")
	refused(() => w.start([], "Q"), "not-a-name")
	refused(() => w.start(["work", ".."], "Q"), "not-a-name")
	refused(() => w.stop(["work", "timer"]), "nothing-there")
	refused(() => w.stop(["work"]), "nothing-there")
	assertEquals(w.rows(), { work: { clock: "P" } })
	assertEquals(get(w.places, ["work", "clock"]), "P")
})

Deno.test("rows: a start puts one patch at its path, a stop takes the levels it leaves empty", () => {
	const w = world()
	w.tree()
	w.start(["work", "clock"], "P")
	w.start(["work", "timer"], "T")
	assertEquals(w.table.get(PROCESS, "R")!.change.op!.patches, [
		{ path: ["work", "timer"], value: "T" },
	])
	w.start(["dev", "hw", "clock"], "D")
	assertEquals(w.table.get(PROCESS, "R")!.change.op!.patches, [
		{ path: ["dev"], value: { hw: { clock: "D" } } },
	])
	assertEquals(w.rows(), { work: { clock: "P", timer: "T" }, dev: { hw: { clock: "D" } } })
	w.stop(["work", "clock"])
	assertEquals(w.table.get(PROCESS, "R")!.change.op!.patches, [{ path: ["work", "clock"] }])
	w.stop(["dev", "hw", "clock"])
	assertEquals(w.table.get(PROCESS, "R")!.change.op!.patches, [{ path: ["dev"] }])
	w.stop(["work", "timer"])
	assertEquals(w.rows(), {})
})

Deno.test("list(/work) merges the rows' names with the saved ones, each once, and reruns on start and stop", () => {
	const w = world()
	w.tree()
	const names = w.watch(() => [...list(w.places, ["work"])].join())
	const level = w.watch(() => members(w.places, ["work"]).map((m) => `${m.name}:${m.from}`).join())
	w.s.pulse()
	w.start(["work", "timer"], "T")
	w.s.pulse()
	// one clock: the process's, first
	w.start(["work", "clock"], "P")
	w.s.pulse()
	assertEquals(members(w.places, ["work"]), [
		{ name: "clock", id: "P", from: "process" },
		{ name: "notes", id: "N", from: "children" },
		{ name: "timer", id: "T", from: "process" },
	])
	w.stop(["work", "timer"])
	w.s.pulse()
	assertEquals(names.values, ["clock,notes", "clock,notes,timer", "clock,notes"])
	assertEquals(level.values, [
		"clock:children,notes:children",
		"clock:children,notes:children,timer:process",
		"clock:process,notes:children,timer:process",
		"clock:process,notes:children",
	])
	// deeper, through a saved folder: the level is no name of its own
	w.start(["work", "notes", "pad"], "Q")
	w.s.pulse()
	assertEquals([names.value, [...list(w.places, ["work", "notes"])]], ["clock,notes", ["pad"]])
})

Deno.test("lookup by a bare name from inside /work finds the process there", () => {
	const w = world()
	w.tree()
	w.start(["work", "timer"], "T")
	assertEquals(lookup(w.places, ["timer"], ["work"]), ["work", "timer"])
	assertEquals(lookup(w.places, ["timer"], ["work", "notes"]), ["work", "timer"])
	assertEquals(lookup(w.places, ["timer", "on"], ["work", "notes"]), undefined)
	w.start(["work", "notes", "timer"], "P")
	assertEquals(lookup(w.places, ["timer", "on"], ["work", "notes"]), [
		"work",
		"notes",
		"timer",
		"on",
	])
	assertEquals(lookup(w.places, ["timer"], ["work", "notes"], true), [
		["work", "notes", "timer"],
		["work", "timer"],
	])
	// a walk from an id alone, its path not known: the rows have nothing
	assertEquals([...w.places.walk(["timer"], "W")], [])
})

// through the cache

Deno.test("cache: a start, then a read in the same tick, is the new answer; a stop too", () => {
	const w = world()
	w.tree()
	const r = w.watch(() => w.cache.get(["work", "clock", "on", "reset"]))
	w.s.pulse()
	w.start(["work", "clock"], "P")
	assertEquals(w.cache.get(["work", "clock"]), "P")
	assertEquals(w.cache.get(["work", "clock", "on", "reset"]), "PRS")
	assertEquals(w.cache.list(["work"]), ["clock", "notes"])
	w.stop(["work", "clock"])
	assertEquals(w.cache.get(["work", "clock", "on", "reset"]), "RS0")
	w.start(["work", "clock"], "P")
	w.s.pulse()
	assertEquals([r.values, r.runs], [["RS0", "PRS"], 2])
})

Deno.test("cache: a first read is right in one run; a run starting a process then reading it, too, as plain places", () => {
	const out: Record<string, unknown> = {}
	for (const kind of ["cache", "places"] as const) {
		const w = world()
		w.tree()
		const ends: string[] = []
		let started = false
		const read = (p: string[]) => kind === "cache" ? w.cache.get(p) : get(w.places, p)
		const r = w.watch(() => {
			const before = read(["work", "timer"])
			if (!started) {
				started = true
				w.places.commit(
					addProcess(w.table, "R", ["work", "timer"], "T", createChangeHeader(w.s)),
				)
			}
			return [before, read(["work", "timer"]), read(["work", "clock", "on", "reset"])]
		})
		w.s.onRunEnd((c, _n, ended) => c === r.c && ends.push(ended))
		w.s.pulse()
		out[kind] = { values: r.values, ends }
	}
	// the first run right; due again by its own write, which the scheduler ends as a loop
	assertEquals(out.cache, { values: [[undefined, "T", "RS0"]], ends: ["done", "looping"] })
	assertEquals(out.cache, out.places)
})

Deno.test("cache: the equal cut, a change under a shadowed name reruns an entries reader, no get reader", () => {
	const w = world()
	w.tree()
	w.start(["work", "clock"], "P")
	const at = w.watch(() => w.cache.get(["work", "clock"]))
	const all = w.watch(() => w.cache.gets(["work", "clock"]).map((a) => a.id).join())
	const deep = w.watch(() => w.cache.get(["work", "clock", "on"]))
	w.s.pulse()
	w.rename("W", "clock", "clock2")
	w.s.pulse()
	assertEquals([at.runs, all.runs, deep.runs], [1, 2, 1])
	assertEquals(all.values, ["P,C0", "P"])
	// a start elsewhere, deeper or beside: no reader of /work/clock runs
	w.start(["work", "timer"], "T")
	w.start(["dev", "clock"], "D")
	w.s.pulse()
	assertEquals([at.runs, all.runs, deep.runs], [1, 2, 1])
})

Deno.test("cache: teardown leaves nothing, no entry, no spot", () => {
	const w = world()
	w.tree()
	w.start(["work", "clock"], "P")
	const rs = [
		w.watch(() => w.cache.get(["work", "clock", "on", "reset"])),
		w.watch(() => w.cache.list(["work"])),
		w.watch(() => w.cache.members(["work", "clock"])),
		w.watch(() => w.cache.gets(["work", "clock"])),
	]
	w.s.pulse()
	assert(w.count().entries > 0)
	w.stop(["work", "clock"])
	w.s.pulse()
	for (const r of rs) w.s.teardown(r.c)
	assertEquals(w.count(), { entries: 0, reads: 0, spots: 0 })
})

Deno.test("cache: pruning, the rows asked once on a path they have nothing on; a start under it works out only what changed", () => {
	const w = world()
	w.tree()
	w.start(["apps", "x"], "X")
	w.asked()
	const deep = w.watch(() => w.cache.get(["work", "clock", "on", "reset"]))
	const top = w.watch(() => w.cache.get(["work"]))
	w.s.pulse()
	assertEquals([deep.value, top.value], ["RS0", "W"])
	// at /work: none, so no entry under it asks
	assertEquals(w.asked(), 1)
	// a start under /work, beside the path: /work's entry asks again (now a level), its gone changes,
	// so /work/clock's asks again (none there); its gone is the same, so nothing deeper; no reader reruns
	w.start(["work", "timer"], "T")
	w.s.pulse()
	assertEquals([deep.runs, top.runs], [1, 1])
	assertEquals(w.asked(), 2)
	// one start elsewhere: nothing asked, nothing reruns
	w.start(["apps", "y"], "Y")
	w.s.pulse()
	assertEquals([deep.runs, top.runs, w.asked()], [1, 1, 0])
	// one on the path: each entry down to it asks again, as its gone changes; its reader reruns
	w.start(["work", "clock", "on", "reset"], "P")
	w.s.pulse()
	assertEquals([deep.runs, deep.value, top.runs], [2, "P", 1])
	assertEquals(w.asked(), 4)
	// the same through plain places: a walk asks down to where the rows part from its path
	w.stop(["work", "clock", "on", "reset"])
	w.asked()
	assertEquals(get(w.places, ["work", "notes"]), "N")
	assertEquals(w.asked(), 2)
	assertEquals(get(w.places, ["work", "clock", "on", "reset"]), "RS0")
	assertEquals(w.asked(), 2)
})

Deno.test("cost: 300 paths and 300 processes, the cache against plain places", () => {
	const N = 300, P = 300
	const out: Record<string, Record<string, number>> = {}
	// each twice, the second kept: the first warms the engine up
	for (const kind of ["cache", "places", "cache", "places"] as const) {
		const w: World = world(kind === "cache")
		const top: Record<string, string> = {}
		for (let i = 0; i < N; i++) top[`d${i}`] = `D${i}`
		w.kids("R", top)
		for (let i = 0; i < N; i++) w.kids(`D${i}`, { x: `X${i}` })
		for (let i = 0; i < P; i++) w.start([`p${i}`], `PR${i}`)
		const rs: { runs: number; values: unknown[]; value: unknown; c: Computer }[] = []
		for (let i = 0; i < N; i++) {
			const p = [`d${i}`, "x"]
			rs.push(w.watch(() => kind === "cache" ? w.cache.get(p) : get(w.places, p)))
		}
		const runs = () => rs.reduce((n, r) => n + r.runs, 0)
		const ms = (x: number) => Math.round(x * 10) / 10
		let t = performance.now()
		w.s.pulse()
		const first = performance.now() - t
		const c0 = w.count()
		t = performance.now()
		w.start(["one", "more"], "M")
		w.s.pulse()
		const start = performance.now() - t
		const startRuns = runs() - N
		// a process over each /dI/x: every reader runs again. one header for all (a header made
		// outside a run reads a stack, ~0.8 ms: header.ts' cost, not the walk's)
		t = performance.now()
		w.hosted(() => {
			const h = createChangeHeader(w.s)
			for (let i = 0; i < N; i++) {
				w.places.commit(addProcess(w.table, "R", [`d${i}`, "x"], "P", h))
			}
		})
		w.s.pulse()
		const shadow = performance.now() - t
		const shadowRuns = runs() - N - startRuns
		for (const r of rs) w.s.teardown(r.c)
		const c1 = w.count()
		out[kind] = {
			entries: c0.entries,
			spots: c0.spots,
			firstMs: ms(first),
			startMs: ms(start),
			startRuns,
			shadowMs: ms(shadow),
			shadowRuns,
			afterEntries: c1.entries,
			afterSpots: c1.spots,
		}
		assert(rs.every((r, i) => r.values[0] === `X${i}` && r.value === "P"))
	}
	say("cost,", N, "paths,", P, "processes:", out)
	assertEquals([out.cache.entries, out.cache.startRuns, out.cache.shadowRuns], [2 * N, 0, N])
	assertEquals([out.places.startRuns, out.places.shadowRuns], [0, N])
	assertEquals([out.cache.afterEntries, out.cache.afterSpots], [0, 0])
})

Deno.test("a walk goes on through a level of the rows as if it were a folder, with no saved folder", () => {
	const w = world()
	w.tree()
	w.start(["dev", "clock"], "P")
	assertEquals(get(w.places, ["dev", "clock"]), "P")
	assertEquals(get(w.places, ["dev", "clock", "on", "reset"]), "PRS")
	// the level itself is no id
	assertEquals(get(w.places, ["dev"]), undefined)
	assertEquals(get(w.places, ["dev", "nothing"]), undefined)
	assertEquals(w.cache.get(["dev", "clock"]), "P")
	w.stop(["dev", "clock"])
	assertEquals(get(w.places, ["dev", "clock"]), undefined)
})

Deno.test("watchPath finds its path through the contributors, and again as a process starts and stops", () => {
	const w = world(false)
	w.tree()
	w.start(["work", "clock"], "P")
	const told: string[] = []
	const stop = w.places.watchPath(["work", "clock"], (f) => told.push(String(f.id)))
	w.kids("P", { on: "PON", more: "X" })
	w.kids("C0", { on: "ON0", other: "Y" })
	w.stop(["work", "clock"])
	w.kids("P", { on: "PON", again: "X" })
	w.kids("C0", { on: "ON0", other: "Z" })
	// a level with no saved folder
	stop()
	const deep: string[] = []
	w.places.watchPath(["dev", "clock"], (f) => deep.push(String(f.id)))
	w.start(["dev", "clock"], "P")
	w.kids("P", { on: "PON", third: "X" })
	assertEquals(told, ["P", "C0"])
	assertEquals(deep, ["P"])
})
