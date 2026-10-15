// places' contributors (places.ts): children given as the one contributor reads as places given
// none; a second contributor going by path (a map of rows in a value entry, a stand-in for
// ermine/processes) answers first, and its names merge with children's
import { assertEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { asId, children, type Contributor, createPlaces } from "./places.ts"
import { entries, get, list, lookup, members } from "./lib.ts"
import { createChangeHeader } from "./header.ts"

// rows by path: the value entry "rows", a level a map, a leaf an id
const rows: Contributor = {
	from: "rows",
	step: ({ path }, name, r) =>
		path === undefined ? undefined : asId(r.read("value", "rows", [...path, name])),
	names: ({ path }, r) => path === undefined ? [] : r.keys("value", "rows", path, true),
}

function world(contributors?: Contributor[]) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table, paths, scheduler: s, contributors })
	s.onTrackingEnd((key) => places.release(key))
	const host = s.createRootScope([["actor", "host"]])
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v as never, createChangeHeader(s))))
	put("children", "R", { work: "W" })
	put("children", "W", { clock: "C0", notes: "N", junk: 1 })
	put("children", "C0", { on: "ON0" })
	put("children", "P", { on: "PON" })
	// what each read of a run tracked, as places names it
	const reads: unknown[] = []
	s.onRunEnd((_c, _n, _e, keys) => reads.push(keys.map((k) => places.describe(k))))
	const notes = s.createRootScope([["actor", "notes"]])
	const tracked = (f: () => unknown) => {
		reads.length = 0
		s.runWithScope(notes, () => s.createComputer(f, () => {}))
		s.pulse()
		return reads[0]
	}
	return { s, places, put, tracked }
}

Deno.test("contributors: children given alone answers and reads as places given none", () => {
	const plain = world()
	const given = world([children])
	const reads = (w: ReturnType<typeof world>) => [
		w.tracked(() => get(w.places, ["work", "clock", "on"])),
		w.tracked(() => list(w.places, ["work"])),
		w.tracked(() => lookup(w.places, ["on"], ["work", "clock"])),
	]
	const r = reads(plain)
	assertEquals(r.map((x) => (x as unknown[]).length), [3, 2, 3])
	assertEquals(reads(given), r)
	for (const p of [[], ["work"], ["work", "clock"], ["nope"]]) {
		assertEquals(get(given.places, p), get(plain.places, p))
		assertEquals(list(given.places, p), list(plain.places, p))
		assertEquals(
			members(given.places, p).map(({ name, id }) => ({ name, id })),
			members(plain.places, p),
		)
	}
	assertEquals(entries(given.places, ["work", "clock"]), [{ id: "C0", from: "children" }])
	assertEquals(entries(plain.places, ["work", "clock"]), [{ id: "C0", from: "children" }])
})

Deno.test("contributors: the first answer wins, entries has them all, names merge each once", () => {
	const w = world([rows, children])
	w.put("value", "rows", { work: { clock: "P", timer: "T" } })
	assertEquals(get(w.places, ["work", "clock", "on"]), "PON")
	assertEquals(entries(w.places, ["work", "clock"]), [
		{ id: "P", from: "rows" },
		{ id: "C0", from: "children" },
	])
	assertEquals(list(w.places, ["work"]), ["clock", "timer", "notes", "junk"])
	assertEquals(members(w.places, ["work"]), [
		{ name: "clock", id: "P", from: "rows" },
		{ name: "timer", id: "T", from: "rows" },
		{ name: "notes", id: "N", from: "children" },
	])
	assertEquals(lookup(w.places, ["timer"], ["work", "notes"]), ["work", "timer"])
	// children first: the saved one wins
	const c = world([children, rows])
	c.put("value", "rows", { work: { clock: "P" } })
	assertEquals(get(c.places, ["work", "clock"]), "C0")
})

Deno.test("contributors: a walk from an id alone knows no path; one from a here does", () => {
	const w = world([rows, children])
	w.put("value", "rows", { work: { timer: "T" } })
	assertEquals([...w.places.walk(["timer"], "W")], [])
	assertEquals([...w.places.walk(["timer"], { id: "W", path: ["work"] })], [
		{ name: "timer", id: "T", from: "rows" },
	])
	assertEquals([...w.places.walk(["work", "timer"], "R")], [
		{ name: "work", id: "W", from: "children" },
		{ name: "timer", id: "T", from: "rows" },
	])
})
