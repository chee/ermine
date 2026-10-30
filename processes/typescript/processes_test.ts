import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry from "@ermine/graph/entry"
import { type Computer, createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Id, type Key } from "@ermine/graph/table"
import { children, type Contributor, createPlaces, PlacesError, rename } from "@ermine/places"
import { get, gets, list, lookup, members } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { addProcess, PROCESS, processes, removeProcess } from "./processes.ts"

function world() {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
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
	const host = s.createRootScope({ actor: "host" })
	const notes = s.createRootScope({ actor: "notes" })
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
	return {
		s,
		table,
		places,
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
		rename: (parent: Id, a: string, b: string) =>
			hosted(() => places.commit(rename(table.get("children", parent)!, a, b, header()))),
	}
}

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
	w.start(["work", "timer"], "P")
	assertEquals(get(w.places, ["work", "timer", "on", "reset"]), "PRS")
	assertEquals([...list(w.places, ["work", "timer"])], ["on"])
})

Deno.test("a second start where one runs is refused, above or under one is not; a stop where none runs", () => {
	const w = world()
	w.tree()
	w.start(["work", "clock"], "P")
	refused(() => w.start(["work", "clock"], "Q"), "already-there")
	refused(() => w.start([], "Q"), "not-a-name")
	refused(() => w.start(["work", ".."], "Q"), "not-a-name")
	refused(() => w.stop(["work", "timer"]), "nothing-there")
	refused(() => w.stop(["work"]), "nothing-there")
	assertEquals(w.rows(), { work: { clock: "P" } })
	assertEquals(get(w.places, ["work", "clock"]), "P")
})

Deno.test("a process at /work and one at /work/clock: listed, walked, stopped one at a time", () => {
	const w = world()
	w.tree()
	w.start(["work", "clock"], "P")
	w.start(["work"], "W")
	w.start(["work", "clock", "x"], "X")
	assertEquals(w.rows(), { work: { "": "W", clock: { "": "P", x: "X" } } })
	assertEquals(get(w.places, ["work"]), "W")
	assertEquals(get(w.places, ["work", "clock"]), "P")
	assertEquals(get(w.places, ["work", "clock", "x"]), "X")
	assertEquals([...list(w.places, ["work"])].sort(), ["clock", "notes"])
	refused(() => w.start(["work"], "Q"), "already-there")
	w.stop(["work"])
	assertEquals(w.rows(), { work: { clock: { "": "P", x: "X" } } })
	assertEquals(get(w.places, ["work", "clock", "x"]), "X")
	w.stop(["work", "clock", "x"])
	w.stop(["work", "clock"])
	assertEquals(w.rows(), {})
	w.start(["work", "a", "b"], "B")
	w.start(["work", "a"], "A")
	assertEquals(w.rows(), { work: { a: { "": "A", b: "B" } } })
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
	assertEquals([...w.places.walk(["timer"], "W")], [])
})

Deno.test("a walk goes on through a level of the rows as if it were a folder, with no saved folder", () => {
	const w = world()
	w.tree()
	w.start(["dev", "clock"], "P")
	assertEquals(get(w.places, ["dev", "clock"]), "P")
	assertEquals(get(w.places, ["dev", "clock", "on", "reset"]), "PRS")
	assertEquals(get(w.places, ["dev"]), undefined)
	assertEquals(get(w.places, ["dev", "nothing"]), undefined)
	w.stop(["dev", "clock"])
	assertEquals(get(w.places, ["dev", "clock"]), undefined)
})
