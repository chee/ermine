// the slice end to end, as a composer makes it: a real table, paths and scheduler, joined by
// places. computes read paths and values; writes are made with a scope open, the host's or a run's,
// and pulsed
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createScheduler, type Moment, SchedulerError } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/graph/table"
import { at, createPlaces, move, place, rename, unplace } from "./places.ts"
import { get, list, lookup, members } from "./lib.ts"
import { createChangeHeader, getWriter } from "./header.ts"

function world() {
	const moments: Moment[] = []
	const s = createScheduler({ forget: (key) => l.release(key), hook: (m) => void moments.push(m) })
	const table = createTable((part, id) => l.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const l = createPlaces({ root: "R", table, paths, scheduler: s })
	const places = l
	// a children entry, to write in
	const kid = (id: Id) => table.get("children", id)!
	// the host's scope, and a program's
	const host = s.root([["actor", "host"]])
	const notes = s.root([["actor", "notes"]])
	const hosted = <T>(f: () => T) => s.run(host, f)
	// a value write: the patches to the entry there, reported; none there: one made with them, added
	function edit(part: Key, id: Id, patches: Patch[]) {
		const h = createChangeHeader(s)
		const there = table.get(part, id)
		if (there === undefined) {
			const node = createEntry<unknown>(undefined, h)
			update(node, patches, h)
			table.add(part, id, node)
			return node
		}
		update(there, patches, h)
		l.markChanged([there])
		return there
	}
	// an entry at id, the host's, as a table event
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, createChangeHeader(s))))
	const value = (id: Id, v: unknown) =>
		hosted(() => table.sub("value", id, createEntry<unknown>(v, createChangeHeader(s))))
	// a compute of notes's: its runs counted, its last value kept
	function watch<T>(f: () => T) {
		const w = { runs: 0, value: undefined as T | undefined }
		s.run(notes, () => s.compute(() => (w.runs++, f()), (v) => void (w.value = v)))
		return w
	}
	// the id at a path, or ""
	const walk = (path: string[]) => String(get(places, path) ?? "")
	return {
		s,
		l,
		table,
		paths,
		places,
		kid,
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

Deno.test("places: at gives what is at a path; nothing there is undefined", () => {
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

Deno.test("places: a read of what isn't there, then something placed there: it reruns and sees it", () => {
	const { s, l, places, hosted, edit, kids, watch, kid } = world()
	kids("R", { notes: "N" })
	kids("N", {})
	const w = watch(() => {
		const id = get(places, ["notes", "today"])
		return id === undefined ? [] : [l.readValue("value", id)]
	})
	s.pulse()
	assertEquals([w.runs, w.value], [1, []])
	// a value nobody reads yet: no rerun
	hosted(() => edit("value", "T", [{ path: [], value: "hello" }]))
	s.pulse()
	assertEquals(w.runs, 1)
	hosted(() => l.markChanged(place(kid("N"), "today", "T", createChangeHeader(s))))
	s.pulse()
	assertEquals([w.runs, w.value], [2, ["hello"]])
})

Deno.test("places: a sibling renamed in a folder: a walker of another name doesn't rerun", () => {
	const { s, l, places, hosted, kids, watch, walk, kid } = world()
	kids("R", { a: "A", b: "B" })
	const a = watch(() => walk(["a"]))
	const c = watch(() => walk(["c"]))
	s.pulse()
	hosted(() => l.markChanged(rename(kid("R"), "b", "c", createChangeHeader(s))))
	s.pulse()
	assertEquals([a.runs, a.value], [1, "A"])
	assertEquals([c.runs, c.value], [2, "B"])
})

Deno.test("places: a keystroke in doc.body: a reader of doc.title doesn't rerun", () => {
	const { s, l, hosted, edit, value, watch } = world()
	value("doc", { title: "hi", body: "abc" })
	const title = watch(() => l.readValue("value", "doc", ["title"]))
	const body = watch(() => l.readValue("value", "doc", ["body"]))
	const all = watch(() => JSON.stringify(l.readValue("value", "doc")))
	s.pulse()
	hosted(() => edit("value", "doc", [{ path: ["body"], range: [3, 3], value: "d" }]))
	s.pulse()
	assertEquals([title.runs, title.value], [1, "hi"])
	assertEquals([body.runs, body.value], [2, "abcd"])
	assertEquals([all.runs, all.value], [2, '{"title":"hi","body":"abcd"}'])
})

Deno.test("places: a node added where a walk stopped (a table event): the reader reruns", () => {
	const { s, kids, watch, walk } = world()
	kids("R", { a: "A" })
	const w = watch(() => walk(["a", "x"]))
	s.pulse()
	assertEquals(w.value, "")
	kids("A", { x: "X" })
	s.pulse()
	assertEquals([w.runs, w.value], [2, "X"])
})

Deno.test("places: one children node under two keys, written through one: both readers rerun", () => {
	const { s, l, table, places, hosted, kids, watch, walk, kid } = world()
	kids("R", { p: "P", q: "Q" })
	hosted(() => {
		const k = createEntry({}, createChangeHeader(s))
		table.add("children", "P", k)
		table.add("children", "Q", k)
	})
	const p = watch(() => walk(["p", "n"]))
	const q = watch(() => walk(["q", "n"]))
	s.pulse()
	hosted(() => l.markChanged(place(kid("P"), "n", "X", createChangeHeader(s))))
	s.pulse()
	assertEquals([p.runs, p.value], [2, "X"])
	assertEquals([q.runs, q.value], [2, "X"])
})

Deno.test("places: a lookup reruns when what it found goes, or a closer one comes; not for farther or unrelated", () => {
	const { s, l, places, hosted, kids, watch, kid } = world()
	kids("R", { a: "A", dog: "D" })
	kids("A", { b: "B" })
	kids("B", {})
	kids("D", { fish: "F0" })
	const w = watch(() => {
		const found = lookup(places, ["dog", "fish"], ["a", "b"])
		return found === undefined ? "" : String(get(places, found))
	})
	const write = (f: () => ReturnType<typeof place>) => hosted(() => l.markChanged(f()))
	s.pulse()
	assertEquals([w.runs, w.value], [1, "F0"])
	// unrelated: a name beside the walk, a fish in another folder
	write(() => place(kid("B"), "cat", "C", createChangeHeader(s)))
	write(() => place(kid("R"), "fish", "F9", createChangeHeader(s)))
	s.pulse()
	assertEquals(w.runs, 1)
	// a closer one: a dog folder at /a, then a fish in it
	kids("A2", {})
	write(() => place(kid("A"), "dog", "A2", createChangeHeader(s)))
	s.pulse()
	assertEquals([w.runs, w.value], [2, "F0"])
	write(() => place(kid("A2"), "fish", "F1", createChangeHeader(s)))
	s.pulse()
	assertEquals([w.runs, w.value], [3, "F1"])
	// farther than what it found: nothing
	write(() => unplace(kid("D"), "fish", createChangeHeader(s)))
	s.pulse()
	assertEquals(w.runs, 3)
	// a closer one again, at /a/b
	kids("B2", { fish: "F2" })
	write(() => place(kid("B"), "dog", "B2", createChangeHeader(s)))
	s.pulse()
	assertEquals([w.runs, w.value], [4, "F2"])
	// what it found goes: the next one out
	write(() => unplace(kid("B"), "dog", createChangeHeader(s)))
	s.pulse()
	assertEquals([w.runs, w.value], [5, "F1"])
})

Deno.test("places: a lookup then a read: a closer one with the same apple reruns the run, and goes no further", () => {
	const { s, l, places, hosted, edit, kids, value, notes, kid } = world()
	kids("R", { a: "A", dog: "D" })
	kids("A", {})
	kids("D", { fish: "F0" })
	value("F0", { apple: "red" })
	let runs = 0, sets = 0, last: unknown
	s.run(notes, () =>
		s.compute(() => {
			runs++
			const found = lookup(places, ["dog", "fish"], ["a"])
			const fish = found && get(places, found)
			return fish && l.readValue("value", fish, ["apple"])
		}, (v) => void (sets++, last = v)))
	s.pulse()
	assertEquals([runs, sets, last], [1, 1, "red"])
	// a closer dog/fish, at /a, with the same apple
	value("F1", { apple: "red", pear: 1 })
	kids("D1", { fish: "F1" })
	hosted(() => l.markChanged(place(kid("A"), "dog", "D1", createChangeHeader(s))))
	s.pulse()
	assertEquals([runs, sets, last], [2, 1, "red"])
	// another apple: it goes on
	value("F1", { apple: "green", pear: 1 })
	s.pulse()
	assertEquals([runs, sets, last], [3, 2, "green"])
	// an edit to the pear: not read, no rerun
	hosted(() => edit("value", "F1", [{ path: ["pear"], value: 2 }]))
	s.pulse()
	assertEquals([runs, sets], [3, 2])
})

Deno.test("places: a move between two folders reports both nodes", () => {
	const { s, l, places, hosted, kids, watch, walk, kid } = world()
	kids("R", { a: "A", b: "B" })
	kids("A", { x: "X" })
	kids("B", {})
	const from = watch(() => walk(["a", "x"]))
	const to = watch(() => walk(["b", "y"]))
	s.pulse()
	hosted(() => l.markChanged(move([kid("A"), "x"], [kid("B"), "y"], createChangeHeader(s))))
	s.pulse()
	assertEquals([from.runs, from.value], [2, ""])
	assertEquals([to.runs, to.value], [2, "X"])
})

Deno.test("places: a path read reruns only on what it rests on", () => {
	const { s, l, places, hosted, kids, watch, kid } = world()
	kids("R", { a: "A", b: "B" })
	kids("A", { x: "X" })
	const w = watch(() => String(get(places, ["a", "x"]) ?? ""))
	s.pulse()
	assertEquals(w.value, "X")
	hosted(() => l.markChanged(place(kid("R"), "c", "C", createChangeHeader(s))))
	s.pulse()
	assertEquals(w.runs, 1)
	hosted(() => {
		l.markChanged(unplace(kid("A"), "x", createChangeHeader(s)))
		l.markChanged(place(kid("A"), "x", "Y", createChangeHeader(s)))
	})
	s.pulse()
	assertEquals([w.runs, w.value], [2, "Y"])
})

Deno.test("places: a spot nobody reads is let go: when its reader goes, or a run reads it no more", () => {
	const { s, l, paths, notes, hosted, edit, kids, value, watch } = world()
	kids("R", { a: "A" })
	value("doc", { t: 1 })
	const c = s.run(notes, () =>
		s.compute(
			() => [l.readValue("children", "R", ["a"]), l.readValue("value", "doc", ["t"])],
			() => {},
		))
	s.pulse()
	assertEquals(paths.kept().spots, 2)
	s.dispose(c)
	assertEquals(paths.kept(), { keys: 0, spots: 0, steps: 0 })
	// each run reads the next path, after what it read changed: the old spot goes
	let i = 0
	const w = watch(() => l.readValue("value", "doc", [`f${i}`]))
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

Deno.test("places: spot names a run's reads, in order, as the run ends; anything else, or a spot let go, is undefined", () => {
	const { s, l, notes, kids, value, moments, places } = world()
	kids("R", { a: "A" })
	value("A", { t: 1 })
	let named: unknown[] = []
	let keys: readonly unknown[] = []
	let n = 0
	const c = s.run(notes, () =>
		s.compute(() => {
			l.readValue("value", "A", ["t"])
			l.readChange("value", "A")
			get(places, ["a"])
			l.readValue("attributes", "A", n++ === 0 ? ["t"] : [])
			return 0
		}, () => {}))
	const ends = () => {
		const m = moments.findLast((m) => "ends" in m && m.ends === c) as Extract<
			Moment,
			{ ends: unknown }
		>
		keys = m.reads
		named = m.reads.map((k) => l.describe(k))
	}
	s.pulse()
	ends()
	assertEquals(named, [
		{ part: "value", id: "A", path: ["t"] },
		{ part: "value", id: "A", path: null },
		{ part: "children", id: "R", path: ["a"] },
		{ part: "attributes", id: "A", path: ["t"] },
	])
	for (const k of ["A", { part: "value" }, undefined]) assertEquals(l.describe(k), undefined)
	// read no more: the attributes' ["t"] spot is let go
	const gone = keys[3]
	s.changed([keys[0]])
	s.pulse()
	ends()
	assertEquals(named.at(-1), { part: "attributes", id: "A", path: [] })
	assertEquals(l.describe(gone), undefined)
})

Deno.test("places: a write in a run is the run's own: reading what it wrote is a loop, whatever scope it opens", () => {
	for (const opened of [false, true]) {
		const { s, l, notes, hosted, edit, value, moments } = world()
		value("X", 0)
		const c = s.run(notes, () =>
			s.compute(() => {
				const v = l.readValue("value", "X") as number
				const write = () => edit("value", "X", [{ path: [], value: v + 1 }])
				if (v < 5) opened ? hosted(write) : write()
				return v
			}, () => {}))
		s.pulse()
		s.pulse()
		const by = moments.some((m) => "due" in m && m.due === c && m.writer === c)
		const looping = moments.some((m) => "ends" in m && m.ends === c && m.ended === "looping")
		assertEquals([by, looping], [true, true])
	}
})

Deno.test("places: a write of the host's, outside any run, is from outside: no writer learned", () => {
	const { s, l, hosted, edit, value, watch, moments } = world()
	value("X", 0)
	watch(() => l.readValue("value", "X"))
	s.pulse()
	hosted(() => edit("value", "X", [{ path: [], value: 1 }]))
	s.pulse()
	assertEquals(moments.filter((m) => "due" in m).map((m) => "writer" in m), [false, false])
})

Deno.test("places: a place write, and a table event, in a run are the run's own too", () => {
	const { s, l, table, places, notes, kids, moments, kid } = world()
	kids("R", {})
	const c = s.run(notes, () =>
		s.compute(() => {
			const n = get(places, ["x"]) === undefined ? 0 : 1
			if (n < 1) l.markChanged(place(kid("R"), "x", "X", createChangeHeader(s)))
			return n
		}, () => {}))
	const d = s.run(notes, () =>
		s.compute(() => {
			const v = l.readValue("value", "Y")
			if (v === undefined) {
				table.add("value", "Y", createEntry<unknown>(1, createChangeHeader(s)))
			}
			return v
		}, () => {}))
	s.pulse()
	for (const x of [c, d]) assert(moments.some((m) => "due" in m && m.due === x && m.writer === x))
})

Deno.test("places: change is tracked at the change spot: any write to the node reruns it", () => {
	const { s, l, hosted, edit, value, watch } = world()
	value("A", { x: 1, y: 2 })
	value("B", 0)
	const c = watch(() => l.readChange("value", "A")?.op?.patches.length ?? 0)
	const x = watch(() => l.readValue("value", "A", ["x"]))
	assertEquals(l.readChange("value", "nope"), undefined)
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

Deno.test("places: a reader of names doesn't rerun on a place inside one of its items, does when a name is added", () => {
	const { s, l, places, hosted, kids, watch, kid } = world()
	kids("R", { a: "A" })
	kids("A", {})
	const w = watch(() => list(places, []).join())
	const write = (f: () => ReturnType<typeof place>) => hosted(() => l.markChanged(f()))
	s.pulse()
	assertEquals([w.runs, w.value], [1, "a"])
	write(() => place(kid("A"), "z", "Z", createChangeHeader(s)))
	s.pulse()
	assertEquals(w.runs, 1)
	write(() => place(kid("R"), "b", "C", createChangeHeader(s)))
	s.pulse()
	assertEquals([w.runs, w.value], [2, "a,b"])
	write(() => unplace(kid("R"), "b", createChangeHeader(s)))
	s.pulse()
	assertEquals([w.runs, w.value], [3, "a"])
})

Deno.test("places: members at a path rerun on a new name there; the level above does not", () => {
	const { s, l, places, hosted, kids, watch, kid } = world()
	kids("R", { a: "A" })
	kids("A", { x: "X" })
	const write = (f: () => ReturnType<typeof place>) => hosted(() => l.markChanged(f()))
	const level = watch(() => members(places, []).map((i) => String(i.id)).join())
	const kept = watch(() => members(places, ["a"]).map((i) => String(i.id)).join())
	s.pulse()
	assertEquals([level.value, kept.value], ["A", "X"])
	write(() => place(kid("A"), "y", "Y", createChangeHeader(s)))
	s.pulse()
	assertEquals([level.runs, kept.runs, kept.value], [1, 2, "X,Y"])
	write(() => place(kid("A"), "z", "Z", createChangeHeader(s)))
	s.pulse()
	assertEquals([level.runs, kept.runs, kept.value], [1, 3, "X,Y,Z"])
	write(() => place(kid("R"), "b", "B", createChangeHeader(s)))
	s.pulse()
	assertEquals([level.runs, level.value], [2, "A,B"])
})

// the header: what the scope open says

Deno.test("places: a header is the pairs of the scope open, from the root down, then the write's own; the time now, its site", () => {
	const { s, l } = world()
	const chee = s.root([["actor", "chee"], ["reader", "juno"], ["why", "test"]])
	const save = s.scope([["cause", "x"], ["why", "again"]], chee)
	const h = s.run(save, () => createChangeHeader(s, [["then", "y"]]))
	assertEquals([h.actor, h.reader], ["chee", "juno"])
	assertEquals(h.metadata, [["why", "test"], ["cause", "x"], ["why", "again"], ["then", "y"]])
	assertEquals(Number.isInteger(h.time), true)
	assertEquals(Math.abs(h.time - Date.now() / 1000) < 5, true)
	// the site is this file, not places.ts
	assertEquals(h.external?.length, 1)
	assertEquals(h.external![0].file.endsWith("places_test.ts"), true)
	// the extra was for that write alone
	assertEquals(s.run(save, () => createChangeHeader(s)).metadata?.at(-1), ["why", "again"])
})

Deno.test("places: a write can't name another actor: the scope decides who; one under it only adds pairs", () => {
	const { s, l, notes } = world()
	const forged = s.run(
		notes,
		() => s.run(s.scope([["actor", "chee"]]), () => createChangeHeader(s)),
	)
	assertEquals(forged.actor, "notes")
	assertEquals(forged.metadata, [["actor", "chee"]])
	assertEquals(s.run(notes, () => createChangeHeader(s, [["actor", "chee"]])).actor, "notes")
})

Deno.test("places: nothing open: a write is unscoped and nothing changes; a read counts for nothing", () => {
	const { s, l, table, places, kids, value, watch, kid } = world()
	kids("R", {})
	value("A", "one")
	const w = watch(() => 0)
	s.pulse()
	assertEquals(getWriter(s), undefined)
	const e = assertThrows(() => place(kid("R"), "x", "X", createChangeHeader(s)))
	assertEquals((e as SchedulerError).code, "unscoped")
	assertEquals(table.get("children", "R")?.value, {})
	// told to the scheduler, tracked by no run
	assertEquals(l.readValue("value", "A"), "one")
	value("A", "two")
	s.pulse()
	assertEquals(w.runs, 1)
})

const settle = () => new Promise((done) => setTimeout(done, 0))

Deno.test("places: after an await in a run nothing is open: a write throws unscoped, a read counts for nothing", async () => {
	const { s, l, notes, hosted, edit, value } = world()
	value("A", "one")
	let runs = 0
	const seen: unknown[] = []
	s.run(notes, () =>
		s.compute(async () => {
			runs++
			seen.push(l.readValue("value", "A"))
			await settle()
			seen.push(getWriter(s))
			try {
				edit("value", "B", [{ path: [], value: 1 }])
			} catch (e) {
				seen.push((e as SchedulerError).code)
			}
			// a read here is no run's
			l.readValue("value", "C")
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

Deno.test("places: a click dispatched in a run is the process's: its scope is under the run's, its write by the run", () => {
	const { s, l, notes, edit, moments } = world()
	let made: ChangeHeader | undefined
	const c = s.run(notes, () =>
		s.compute(() => {
			const v = l.readValue("value", "clicked")
			// dispatchEvent, sync: the click's scope, made under the one open
			if (v === undefined) {
				s.run(s.scope([["event", "click"]]), () => {
					made = edit("value", "clicked", [{ path: [], value: true }]).change
				})
			}
			return v
		}, () => {}))
	s.pulse()
	assertEquals(made?.actor, "notes")
	assertEquals(made?.metadata, [["run", 1], ["mark", 1], ["event", "click"]])
	assert(moments.some((m) => "due" in m && m.due === c && m.writer === c))
})
