// the slice end to end, as a composer makes it: a real table, places, paths and scheduler, joined
// by link. computes read places and values; writes are made with a scope open, the host's or a
// run's, and pulsed
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createPlaces } from "@ermine/places"
import { createScheduler, type Moment, SchedulerError } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/graph/table"
import { at, createLink } from "./link.ts"

function world() {
	const moments: Moment[] = []
	const s = createScheduler({ forget: (key) => l.forget(key), hook: (m) => void moments.push(m) })
	const table = createTable((part, id) => l.event(part as Key, id))
	const paths = createPaths<unknown>()
	const l = createLink({ table, paths, scheduler: s })
	const places = createPlaces({
		root: ["stored", "R"],
		children: (_, id) => table.get("children", id),
		read: l.read,
	})
	// the host's scope, and a program's
	const host = s.root([["actor", "host"]])
	const notes = s.root([["actor", "notes"]])
	const hosted = <T>(f: () => T) => s.run(host, f)
	// a value write: the patches to the entry there, reported; none there: one made with them, added
	function edit(part: Key, id: Id, patches: Patch[]) {
		const h = l.header()
		const there = table.get(part, id)
		if (there === undefined) {
			const node = createEntry<unknown>(undefined, h)
			update(node, patches, h)
			table.add(part, id, node)
			return node
		}
		update(there, patches, h)
		l.wrote([{ node: there }])
		return there
	}
	// an entry at id, the host's, as a table event
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, l.header())))
	const value = (id: Id, v: unknown) =>
		hosted(() => table.sub("value", id, createEntry<unknown>(v, l.header())))
	// a compute of notes's: its runs counted, its last value kept
	function watch<T>(f: () => T) {
		const w = { runs: 0, value: undefined as T | undefined }
		s.run(notes, () => s.compute(() => (w.runs++, f()), (v) => void (w.value = v)))
		return w
	}
	// the items at an address, as source:id
	const walk = (address: string[]) =>
		places.get(address).map((i) => `${String(i.source)}:${String(i.id)}`).join()
	return {
		s,
		l,
		table,
		paths,
		places,
		host,
		notes,
		hosted,
		edit,
		kids,
		value,
		watch,
		walk,
		moments,
	}
}

Deno.test("link: at gives what is at a path; nothing there is undefined", () => {
	const v = { a: [1, { b: "x" }], __proto__x: 1 }
	assertEquals(at(v, []), v)
	assertEquals(at(v, ["a", 1, "b"]), "x")
	assertEquals(at(v, ["a", 5]), undefined)
	assertEquals(at(v, ["a", "0"]), undefined)
	assertEquals(at(v, [0]), undefined)
	assertEquals(at(v, ["toString"]), undefined)
	assertEquals(at(undefined, ["a"]), undefined)
	assertEquals(at("str", [0]), undefined)
})

Deno.test("link: a read of what isn't there, then something placed there: it reruns and sees it", () => {
	const { s, l, places, hosted, edit, kids, watch } = world()
	kids("R", { notes: [["stored", "N"]] })
	kids("N", {})
	const w = watch(() => places.get(["notes", "today"]).map((i) => l.get("value", i.id)))
	s.pulse()
	assertEquals([w.runs, w.value], [1, []])
	// a value nobody reads yet: no rerun
	hosted(() => edit("value", "T", [{ path: [], value: "hello" }]))
	s.pulse()
	assertEquals(w.runs, 1)
	hosted(() => l.wrote(places.place([["stored", "N"], "today"], ["stored", "T"], l.header())))
	s.pulse()
	assertEquals([w.runs, w.value], [2, ["hello"]])
})

Deno.test("link: a sibling renamed in a folder: a walker of another name doesn't rerun", () => {
	const { s, l, places, hosted, kids, watch, walk } = world()
	kids("R", { a: [["stored", "A"]], b: [["stored", "B"]] })
	const a = watch(() => walk(["a"]))
	const c = watch(() => walk(["c"]))
	s.pulse()
	hosted(() => l.wrote(places.rename([["stored", "R"], "b"], "c", l.header())))
	s.pulse()
	assertEquals([a.runs, a.value], [1, "stored:A"])
	assertEquals([c.runs, c.value], [2, "stored:B"])
})

Deno.test("link: a keystroke in doc.body: a reader of doc.title doesn't rerun", () => {
	const { s, l, hosted, edit, value, watch } = world()
	value("doc", { title: "hi", body: "abc" })
	const title = watch(() => l.get("value", "doc", ["title"]))
	const body = watch(() => l.get("value", "doc", ["body"]))
	const all = watch(() => JSON.stringify(l.get("value", "doc")))
	s.pulse()
	hosted(() => edit("value", "doc", [{ path: ["body"], range: [3, 3], value: "d" }]))
	s.pulse()
	assertEquals([title.runs, title.value], [1, "hi"])
	assertEquals([body.runs, body.value], [2, "abcd"])
	assertEquals([all.runs, all.value], [2, '{"title":"hi","body":"abcd"}'])
})

Deno.test("link: a node added where a walk stopped (a table event): the reader reruns", () => {
	const { s, kids, watch, walk } = world()
	kids("R", { a: [["stored", "A"]] })
	const w = watch(() => walk(["a", "x"]))
	s.pulse()
	assertEquals(w.value, "")
	kids("A", { x: [["stored", "X"]] })
	s.pulse()
	assertEquals([w.runs, w.value], [2, "stored:X"])
})

Deno.test("link: one children node under two keys, written through one: both readers rerun", () => {
	const { s, l, table, places, hosted, kids, watch, walk } = world()
	kids("R", { p: [["stored", "P"]], q: [["stored", "Q"]] })
	hosted(() => {
		const k = createEntry({ n: [] }, l.header())
		table.add("children", "P", k)
		table.add("children", "Q", k)
	})
	const p = watch(() => walk(["p", "n"]))
	const q = watch(() => walk(["q", "n"]))
	s.pulse()
	hosted(() => l.wrote(places.place([["stored", "P"], "n"], ["stored", "X"], l.header())))
	s.pulse()
	assertEquals([p.runs, p.value], [2, "stored:X"])
	assertEquals([q.runs, q.value], [2, "stored:X"])
})

Deno.test("link: a move between two folders reports both nodes", () => {
	const { s, l, places, hosted, kids, watch, walk } = world()
	kids("R", { a: [["stored", "A"]], b: [["stored", "B"]] })
	kids("A", { x: [["stored", "X"]] })
	kids("B", {})
	const from = watch(() => walk(["a", "x"]))
	const to = watch(() => walk(["b", "y"]))
	s.pulse()
	hosted(() => l.wrote(places.move([["stored", "A"], "x"], 0, [["stored", "B"], "y"], l.header())))
	s.pulse()
	assertEquals([from.runs, from.value], [2, ""])
	assertEquals([to.runs, to.value], [2, "stored:X"])
})

Deno.test("link: held places rerun only on what they rest on; one held walks again for the run that asks", () => {
	const { s, l, places, hosted, kids, watch } = world()
	kids("R", { a: [["stored", "A"]], b: [["stored", "B"]] })
	kids("A", { x: [["stored", "X"]] })
	const held = places.open(["a", "x"])
	const w = watch(() => held.items().map((i) => String(i.id)).join())
	s.pulse()
	assertEquals(w.value, "X")
	hosted(() => l.wrote(places.place([["stored", "R"], "b"], ["stored", "C"], l.header())))
	s.pulse()
	assertEquals(w.runs, 1)
	hosted(() => l.wrote(places.place([["stored", "A"], "x"], ["stored", "Y"], l.header())))
	s.pulse()
	assertEquals([w.runs, w.value], [2, "X,Y"])
	held.drop()
})

Deno.test("link: a spot nobody reads is let go: when its reader goes, or a run reads it no more", () => {
	const { s, l, paths, notes, hosted, edit, kids, value, watch } = world()
	kids("R", { a: [["stored", "A"]] })
	value("doc", { t: 1 })
	const c = s.run(notes, () =>
		s.compute(
			() => [l.get("children", "R", ["a"]), l.get("value", "doc", ["t"])],
			() => {},
		))
	s.pulse()
	assertEquals(paths.kept().spots, 2)
	s.dispose(c)
	assertEquals(paths.kept(), { keys: 0, spots: 0, steps: 0 })
	// each run reads the next path, after what it read changed: the old spot goes
	let i = 0
	const w = watch(() => l.get("value", "doc", [`f${i}`]))
	s.pulse()
	for (i = 1; i < 300; i++) {
		hosted(() => edit("value", "doc", [{ path: [`f${i - 1}`], value: i }]))
		s.pulse()
	}
	assertEquals(paths.kept().spots, 1)
	// what is still read is still told
	i = 299
	hosted(() => edit("value", "doc", [{ path: ["f299"], value: "last" }]))
	s.pulse()
	assertEquals(w.value, "last")
})

Deno.test("link: spot names a run's reads, in order, as the run ends; anything else, or a spot let go, is undefined", () => {
	const { s, l, notes, kids, value, moments, places } = world()
	kids("R", { a: [["stored", "A"]] })
	value("A", { t: 1 })
	let named: unknown[] = []
	let keys: readonly unknown[] = []
	let n = 0
	const c = s.run(notes, () =>
		s.compute(() => {
			l.get("value", "A", ["t"])
			l.change("value", "A")
			places.get(["a"])
			l.get("attributes", "A", n++ === 0 ? ["t"] : [])
			return 0
		}, () => {}))
	const ends = () => {
		const m = moments.findLast((m) => "ends" in m && m.ends === c) as Extract<
			Moment,
			{ ends: unknown }
		>
		keys = m.reads
		named = m.reads.map((k) => l.spot(k))
	}
	s.pulse()
	ends()
	assertEquals(named, [
		{ part: "value", id: "A", path: ["t"] },
		{ part: "value", id: "A", path: null },
		{ part: "children", id: "R", path: ["a"] },
		{ part: "attributes", id: "A", path: ["t"] },
	])
	for (const k of ["A", { part: "value" }, undefined]) assertEquals(l.spot(k), undefined)
	// read no more: the attributes' ["t"] spot is let go
	const gone = keys[3]
	s.changed([keys[0]])
	s.pulse()
	ends()
	assertEquals(named.at(-1), { part: "attributes", id: "A", path: [] })
	assertEquals(l.spot(gone), undefined)
})

Deno.test("link: a write in a run is the run's own: reading what it wrote is a loop, whatever scope it opens", () => {
	for (const opened of [false, true]) {
		const { s, l, notes, hosted, edit, value, moments } = world()
		value("X", 0)
		const c = s.run(notes, () =>
			s.compute(() => {
				const v = l.get("value", "X") as number
				const write = () => edit("value", "X", [{ path: [], value: v + 1 }])
				if (v < 5) opened ? hosted(write) : write()
				return v
			}, () => {}))
		s.pulse()
		s.pulse()
		const by = moments.some((m) => "due" in m && m.due === c && m.by === c)
		const looping = moments.some((m) => "ends" in m && m.ends === c && m.ended === "looping")
		assertEquals([by, looping], [true, true])
	}
})

Deno.test("link: a write of the host's, outside any run, is from outside: no writer learned", () => {
	const { s, l, hosted, edit, value, watch, moments } = world()
	value("X", 0)
	watch(() => l.get("value", "X"))
	s.pulse()
	hosted(() => edit("value", "X", [{ path: [], value: 1 }]))
	s.pulse()
	assertEquals(moments.filter((m) => "due" in m).map((m) => "by" in m), [false, false])
})

Deno.test("link: a place write, and a table event, in a run are the run's own too", () => {
	const { s, l, table, places, notes, kids, moments } = world()
	kids("R", {})
	const c = s.run(notes, () =>
		s.compute(() => {
			const n = places.get(["x"]).length
			if (n < 1) l.wrote(places.place([["stored", "R"], "x"], ["stored", "X"], l.header()))
			return n
		}, () => {}))
	const d = s.run(notes, () =>
		s.compute(() => {
			const v = l.get("value", "Y")
			if (v === undefined) table.add("value", "Y", createEntry<unknown>(1, l.header()))
			return v
		}, () => {}))
	s.pulse()
	for (const x of [c, d]) assert(moments.some((m) => "due" in m && m.due === x && m.by === x))
})

Deno.test("link: change is tracked at the change spot: any write to the node reruns it", () => {
	const { s, l, hosted, edit, value, watch } = world()
	value("A", { x: 1, y: 2 })
	value("B", 0)
	const c = watch(() => l.change("value", "A")?.op?.patches.length ?? 0)
	const x = watch(() => l.get("value", "A", ["x"]))
	assertEquals(l.change("value", "nope"), undefined)
	s.pulse()
	assertEquals([c.runs, x.runs], [1, 1])
	hosted(() => edit("value", "A", [{ path: ["y"], value: 3 }]))
	s.pulse()
	// the change reader reruns on any write; the reader of x doesn't rerun on a write to y
	assertEquals([c.runs, x.runs], [2, 1])
	hosted(() => edit("value", "B", [{ path: [], value: 1 }]))
	s.pulse()
	assertEquals([c.runs, x.runs], [2, 1])
	hosted(() => edit("value", "A", [{ path: ["x"], value: 9 }]))
	s.pulse()
	assertEquals([c.runs, x.runs, x.value], [3, 2, 9])
})

Deno.test("link: a reader of names doesn't rerun when an entry is placed under an existing name, does when a name is added", () => {
	const { s, l, places, hosted, kids, watch } = world()
	kids("R", { a: [["stored", "A"]] })
	const w = watch(() => places.names(["stored", "R"]).join())
	const write = (f: () => ReturnType<typeof places.place>) => hosted(() => l.wrote(f()))
	s.pulse()
	assertEquals([w.runs, w.value], [1, "a"])
	write(() => places.place([["stored", "R"], "a"], ["stored", "B"], l.header()))
	s.pulse()
	assertEquals(w.runs, 1)
	write(() => places.place([["stored", "R"], "b"], ["stored", "C"], l.header()))
	s.pulse()
	assertEquals([w.runs, w.value], [2, "a,b"])
	write(() => places.unplace([["stored", "R"], "b"], 0, l.header()))
	s.pulse()
	assertEquals([w.runs, w.value], [3, "a"])
})

Deno.test("link: members of a level, and of an opened place, rerun on a new entry or name", () => {
	const { s, l, places, hosted, kids, watch } = world()
	kids("R", { a: [["stored", "A"]] })
	kids("A", { x: [["stored", "X"]] })
	const write = (f: () => ReturnType<typeof places.place>) => hosted(() => l.wrote(f()))
	const level = watch(() => places.members(["stored", "R"]).map((i) => String(i.id)).join())
	const held = places.open(["a"])
	const kept = watch(() => held.members().map((i) => String(i.id)).join())
	s.pulse()
	assertEquals([level.value, kept.value], ["A", "X"])
	write(() => places.place([["stored", "A"], "x"], ["stored", "Y"], l.header()))
	s.pulse()
	assertEquals([level.runs, kept.runs, kept.value], [1, 2, "X,Y"])
	write(() => places.place([["stored", "A"], "z"], ["stored", "Z"], l.header()))
	s.pulse()
	assertEquals([level.runs, kept.runs, kept.value], [1, 3, "X,Y,Z"])
	write(() => places.place([["stored", "R"], "a"], ["stored", "B"], l.header()))
	s.pulse()
	assertEquals([level.runs, level.value], [2, "A,B"])
	held.drop()
})

// the header: what the scope open says

Deno.test("link: a header is the pairs of the scope open, from the root down, then the write's own; the time now, its site", () => {
	const { s, l } = world()
	const chee = s.root([["actor", "chee"], ["reader", "juno"], ["why", "test"]])
	const save = s.scope([["cause", "x"], ["why", "again"]], chee)
	const h = s.run(save, () => l.header([["then", "y"]]))
	assertEquals([h.actor, h.reader], ["chee", "juno"])
	assertEquals(h.metadata, [["why", "test"], ["cause", "x"], ["why", "again"], ["then", "y"]])
	assertEquals(Number.isInteger(h.time), true)
	assertEquals(Math.abs(h.time - Date.now() / 1000) < 5, true)
	// the site is this file, not link's
	assertEquals(h.external?.length, 1)
	assertEquals(h.external![0].file.endsWith("link_test.ts"), true)
	// the extra was for that write alone
	assertEquals(s.run(save, () => l.header()).metadata?.at(-1), ["why", "again"])
})

Deno.test("link: a write can't name another actor: the scope decides who; one under it only adds pairs", () => {
	const { s, l, notes } = world()
	const forged = s.run(notes, () => s.run(s.scope([["actor", "chee"]]), () => l.header()))
	assertEquals(forged.actor, "notes")
	assertEquals(forged.metadata, [["actor", "chee"]])
	assertEquals(s.run(notes, () => l.header([["actor", "chee"]])).actor, "notes")
})

Deno.test("link: nothing open: a write is unscoped and nothing changes; a read counts for nothing", () => {
	const { s, l, table, places, kids, value, watch } = world()
	kids("R", {})
	value("A", "one")
	const w = watch(() => 0)
	s.pulse()
	assertEquals(l.who(), undefined)
	const e = assertThrows(() => places.place([["stored", "R"], "x"], ["stored", "X"], l.header()))
	assertEquals((e as SchedulerError).code, "unscoped")
	assertEquals(table.get("children", "R")?.value, {})
	// told to the scheduler, tracked by no run
	assertEquals(l.get("value", "A"), "one")
	value("A", "two")
	s.pulse()
	assertEquals(w.runs, 1)
})

const settle = () => new Promise((done) => setTimeout(done, 0))

Deno.test("link: after an await in a run nothing is open: a write throws unscoped, a read counts for nothing", async () => {
	const { s, l, notes, hosted, edit, value } = world()
	value("A", "one")
	let runs = 0
	const seen: unknown[] = []
	s.run(notes, () =>
		s.compute(async () => {
			runs++
			seen.push(l.get("value", "A"))
			await settle()
			seen.push(l.who())
			try {
				edit("value", "B", [{ path: [], value: 1 }])
			} catch (e) {
				seen.push((e as SchedulerError).code)
			}
			// a read here is no run's
			l.get("value", "C")
			return 0
		}, () => {}))
	s.pulse()
	await settle()
	assertEquals(seen, ["one", undefined, "unscoped"])
	hosted(() => edit("value", "C", [{ path: [], value: 1 }]))
	s.pulse()
	assertEquals(runs, 1)
	// tracked before the await: a change reruns it
	hosted(() => edit("value", "A", [{ path: [], value: "two" }]))
	s.pulse()
	await settle()
	assertEquals(runs, 2)
})

Deno.test("link: a click dispatched in a run is the process's: its scope is under the run's, its write by the run", () => {
	const { s, l, notes, edit, moments } = world()
	let header: ReturnType<typeof l.header> | undefined
	const c = s.run(notes, () =>
		s.compute(() => {
			const v = l.get("value", "clicked")
			// dispatchEvent, sync: the click's scope, made under the one open
			if (v === undefined) {
				s.run(s.scope([["event", "click"]]), () => {
					header = edit("value", "clicked", [{ path: [], value: true }]).change
				})
			}
			return v
		}, () => {}))
	s.pulse()
	assertEquals(header?.actor, "notes")
	assertEquals(header?.metadata, [["run", 1], ["mark", 1], ["event", "click"]])
	assert(moments.some((m) => "due" in m && m.due === c && m.by === c))
})
