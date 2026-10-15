// the slice end to end, as a composer makes it: a real table, paths and scheduler, joined by
// places. computes read paths and values; writes are made with a scope open, the host's or a run's,
// and pulsed
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { type Computer, createScheduler, SchedulerError } from "@ermine/scheduler"
import { type Told, trace } from "@ermine/scheduler/trace"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { at, createPlaces, move, place, rename, unplace } from "./places.ts"
import { get, list, lookup, members } from "./lib.ts"
import { createChangeHeader, getWho } from "./header.ts"

function world() {
	const moments: Told[] = []
	const s = createScheduler()
	s.onTrackingEnd((key) => l.release(key))
	trace(s, (m) => void moments.push(m))
	const table = createTable((part, id) => l.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const l = createPlaces({ root: "R", table, paths, scheduler: s })
	const places = l
	// a children entry, to write in
	const kid = (id: Id) => table.get("children", id)!
	// the host's scope, and a program's
	const host = s.createRootScope([["actor", "host"]])
	const notes = s.createRootScope([["actor", "notes"]])
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
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
		l.commit([there])
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
		s.runWithScope(
			notes,
			() => s.createComputer(() => (w.runs++, f()), (v) => void (w.value = v)),
		)
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
	hosted(() => l.commit(place(kid("N"), "today", "T", createChangeHeader(s))))
	s.pulse()
	assertEquals([w.runs, w.value], [2, ["hello"]])
})

Deno.test("places: a sibling renamed in a folder: a walker of another name doesn't rerun", () => {
	const { s, l, places, hosted, kids, watch, walk, kid } = world()
	kids("R", { a: "A", b: "B" })
	const a = watch(() => walk(["a"]))
	const c = watch(() => walk(["c"]))
	s.pulse()
	hosted(() => l.commit(rename(kid("R"), "b", "c", createChangeHeader(s))))
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
	hosted(() => l.commit(place(kid("P"), "n", "X", createChangeHeader(s))))
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
	const write = (f: () => ReturnType<typeof place>) => hosted(() => l.commit(f()))
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
	s.runWithScope(notes, () =>
		s.createComputer(() => {
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
	hosted(() => l.commit(place(kid("A"), "dog", "D1", createChangeHeader(s))))
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
	hosted(() => l.commit(move([kid("A"), "x"], [kid("B"), "y"], createChangeHeader(s))))
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
	hosted(() => l.commit(place(kid("R"), "c", "C", createChangeHeader(s))))
	s.pulse()
	assertEquals(w.runs, 1)
	hosted(() => {
		l.commit(unplace(kid("A"), "x", createChangeHeader(s)))
		l.commit(place(kid("A"), "x", "Y", createChangeHeader(s)))
	})
	s.pulse()
	assertEquals([w.runs, w.value], [2, "Y"])
})

Deno.test("places: a spot nobody reads is let go: when its reader goes, or a run reads it no more", () => {
	const { s, l, paths, notes, hosted, edit, kids, value, watch } = world()
	kids("R", { a: "A" })
	value("doc", { t: 1 })
	const c = s.runWithScope(notes, () =>
		s.createComputer(
			() => [l.readValue("children", "R", ["a"]), l.readValue("value", "doc", ["t"])],
			() => {},
		))
	s.pulse()
	assertEquals(paths.kept().spots, 2)
	s.teardown(c)
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
	const c = s.runWithScope(notes, () =>
		s.createComputer(() => {
			l.readValue("value", "A", ["t"])
			l.readChange("value", "A")
			get(places, ["a"])
			l.readValue("attributes", "A", n++ === 0 ? ["t"] : [])
			return 0
		}, () => {}))
	const ends = () => {
		const m = moments.findLast((m) => "ends" in m && m.ends === c) as Extract<
			Told,
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
	s.mark([keys[0]])
	s.pulse()
	ends()
	assertEquals(named.at(-1), { part: "attributes", id: "A", path: [] })
	assertEquals(l.describe(gone), undefined)
})

Deno.test("places: a write in a run is the run's own: reading what it wrote is a loop, whatever scope it opens", () => {
	for (const opened of [false, true]) {
		const { s, l, notes, hosted, edit, value, moments } = world()
		value("X", 0)
		const c = s.runWithScope(notes, () =>
			s.createComputer(() => {
				const v = l.readValue("value", "X") as number
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
	const c = s.runWithScope(notes, () =>
		s.createComputer(() => {
			const n = get(places, ["x"]) === undefined ? 0 : 1
			if (n < 1) l.commit(place(kid("R"), "x", "X", createChangeHeader(s)))
			return n
		}, () => {}))
	const d = s.runWithScope(notes, () =>
		s.createComputer(() => {
			const v = l.readValue("value", "Y")
			if (v === undefined) {
				table.add("value", "Y", createEntry<unknown>(1, createChangeHeader(s)))
			}
			return v
		}, () => {}))
	s.pulse()
	for (const x of [c, d]) assert(moments.some((m) => "due" in m && m.due === x && m.by === x))
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
	const write = (f: () => ReturnType<typeof place>) => hosted(() => l.commit(f()))
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
	const write = (f: () => ReturnType<typeof place>) => hosted(() => l.commit(f()))
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
	const chee = s.createRootScope([["actor", "chee"], ["reader", "juno"], ["why", "test"]])
	const save = s.createScope([["cause", "x"], ["why", "again"]], chee)
	const h = s.runWithScope(save, () => createChangeHeader(s, [["then", "y"]]))
	assertEquals([h.actor, h.reader], ["chee", "juno"])
	assertEquals(h.metadata, [["why", "test"], ["cause", "x"], ["why", "again"], ["then", "y"]])
	assertEquals(Number.isInteger(h.time), true)
	assertEquals(Math.abs(h.time - Date.now() / 1000) < 5, true)
	// the site is this file, not places.ts
	assertEquals(h.external?.length, 1)
	assertEquals(h.external![0].file.endsWith("places_test.ts"), true)
	// the extra was for that write alone
	assertEquals(s.runWithScope(save, () => createChangeHeader(s)).metadata?.at(-1), [
		"why",
		"again",
	])
})

Deno.test("places: a write can't name another actor: the scope decides who; one under it only adds pairs", () => {
	const { s, l, notes } = world()
	const forged = s.runWithScope(
		notes,
		() => s.runWithScope(s.createScope([["actor", "chee"]]), () => createChangeHeader(s)),
	)
	assertEquals(forged.actor, "notes")
	assertEquals(forged.metadata, [["actor", "chee"]])
	assertEquals(
		s.runWithScope(notes, () => createChangeHeader(s, [["actor", "chee"]])).actor,
		"notes",
	)
})

Deno.test("places: nothing open: a write is unscoped and nothing changes; a read counts for nothing", () => {
	const { s, l, table, places, kids, value, watch, kid } = world()
	kids("R", {})
	value("A", "one")
	const w = watch(() => 0)
	s.pulse()
	assertEquals(getWho(s), undefined)
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
	s.runWithScope(notes, () =>
		s.createComputer(async () => {
			runs++
			seen.push(l.readValue("value", "A"))
			await settle()
			seen.push(getWho(s))
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
	const c = s.runWithScope(notes, () =>
		s.createComputer(() => {
			const v = l.readValue("value", "clicked")
			// dispatchEvent, sync: the click's scope, made under the one open
			if (v === undefined) {
				s.runWithScope(s.createScope([["event", "click"]]), () => {
					made = edit("value", "clicked", [{ path: [], value: true }]).change
				})
			}
			return v
		}, () => {}))
	s.pulse()
	assertEquals(made?.actor, "notes")
	assertEquals(made?.metadata, [["run", 1], ["mark", 1], ["event", "click"]])
	assert(moments.some((m) => "due" in m && m.due === c && m.by === c))
})

Deno.test("places: watchPath is told each write's patches at the node at its path, with the change, as it lands", () => {
	const { l, kids, value, edit, hosted } = world()
	kids("R", { notes: "N" })
	value("N", { title: "a", body: "b" })
	const told: unknown[] = []
	const stop = l.watchPath(["notes"], (f) => told.push([f.part, f.id, f.patches, f.change?.actor]))
	hosted(() => edit("value", "N", [{ path: ["title"], value: "z" }]))
	hosted(() => edit("value", "X", [{ path: [], value: 1 }]))
	assertEquals(told, [["value", "N", [{ path: ["title"], value: "z" }], "host"]])
	stop()
	hosted(() => edit("value", "N", [{ path: ["body"], value: "y" }]))
	assertEquals(told.length, 1)
})

Deno.test("places: watchPath is told a table swap as one patch at the root, and a removal as one with no value", () => {
	const { l, table, kids, value, hosted } = world()
	kids("R", { notes: "N" })
	const told: unknown[] = []
	l.watchPath(["notes"], (f) => told.push(f.patches))
	value("N", { title: "a" })
	hosted(() => table.del("value", "N"))
	assertEquals(told, [[{ path: [], value: { title: "a" } }], [{ path: [] }]])
})

Deno.test("places: watchPath only part, only the patches touching at; it follows its path as the tree changes", () => {
	const { l, kids, value, edit, hosted } = world()
	kids("R", { notes: "N", other: "O" })
	value("N", { title: "a", body: "b" })
	value("O", { title: "o" })
	const told: unknown[] = []
	l.watchPath(["notes"], (f) => told.push([f.id, f.patches]), { part: "value", at: ["title"] })
	hosted(() =>
		edit("value", "N", [{ path: ["body"], value: "y" }, { path: ["title"], value: "z" }])
	)
	hosted(() => edit("value", "N", [{ path: [], value: { title: "w" } }]))
	hosted(() => edit("attributes", "N", [{ path: [], value: { title: "no" } }]))
	// /notes now holds O: the watch is told O's writes, not N's
	hosted(() => edit("children", "R", [{ path: ["notes"], value: "O" }]))
	hosted(() => edit("value", "N", [{ path: ["title"], value: "gone" }]))
	hosted(() => edit("value", "O", [{ path: ["title"], value: "here" }]))
	assertEquals(told, [
		["N", [{ path: ["title"], value: "z" }]],
		["N", [{ path: [], value: { title: "w" } }]],
		["O", [{ path: ["title"], value: "here" }]],
	])
})

Deno.test("places: eachEntryChange gives a fact at every key a written entry is under", () => {
	const { s, l, table, hosted } = world()
	const shared = createEntry<unknown>({ a: 1 }, { time: 0, actor: "host" })
	table.add("value", "A", shared)
	table.add("value", "B", shared)
	hosted(() => update(shared, [{ path: ["a"], value: 2 }], createChangeHeader(s)))
	const facts = [...l.eachEntryChange([shared])]
	assertEquals(facts.map((f) => [f.part, f.id, f.patches]), [
		["value", "A", [{ path: ["a"], value: 2 }]],
		["value", "B", [{ path: ["a"], value: 2 }]],
	])
})

Deno.test("places: a watch that writes lands in the writer's run: a pipe's readers are due by it", () => {
	const { s, l, kids, value, edit, hosted, notes, moments } = world()
	kids("R", { a: "A", b: "B" })
	value("A", 1)
	value("B", 2)
	const pipe = s.createScope([["pipe", "a→b"]], notes)
	l.watchPath(
		["a"],
		(f) =>
			s.runWithScope(
				pipe,
				() => edit("value", "B", [{ path: [], value: (f.entry!.value as number) * 2 }]),
			),
	)
	let w!: Computer
	const seen: unknown[] = []
	// a reader of b, run once
	s.runWithScope(
		notes,
		() => s.createComputer(() => l.readValue("value", "B"), (v) => void seen.push(v)),
	)
	s.pulse()
	// then a computer writing a from its set: a run is open, so the pipe's write is by it
	s.runWithScope(notes, () => {
		w = s.createComputer(() => 5, (v) => void edit("value", "A", [{ path: [], value: v }]))
	})
	s.pulse()
	assertEquals(seen, [2, 10])
	assert(moments.some((m) => "due" in m && m.by === w))
	// the pipe's write carries its scope's info
	assertEquals(l.readChange("value", "B")?.metadata?.some(([k]) => k === "pipe"), true)
})

Deno.test("places: many watches, many commits: each is told only its own node's facts, and no path is walked to tell them", () => {
	const { l, table, kids, value, edit, hosted } = world()
	const N = 200
	const names: Record<string, string> = {}
	for (let i = 0; i < N; i++) names[`n${i}`] = `N${i}`
	kids("R", { dir: "D" })
	kids("D", names)
	const counts = new Array<number>(N).fill(0)
	for (let i = 0; i < N; i++) {
		value(`N${i}`, 0)
		l.watchPath(["dir", `n${i}`], () => void counts[i]++)
	}
	// a second watch on a node, and one on a path not there yet
	let twin = 0, later = 0
	l.watchPath(["dir", "n7"], () => void twin++)
	l.watchPath(["dir", "late"], () => void later++)
	// the walks the table is asked for from here on
	const get = table.get.bind(table)
	let walked = 0
	table.get =
		((part: Key, id: Id) => (part === "children" && walked++, get(part, id))) as typeof table.get
	const COMMITS = 1000
	hosted(() => {
		for (let c = 0; c < COMMITS; c++) edit("value", `N${c % 50}`, [{ path: [], value: c }])
	})
	assertEquals(walked, 0)
	for (let i = 0; i < N; i++) assertEquals(counts[i], i < 50 ? COMMITS / 50 : 0, `n${i}`)
	assertEquals([twin, later], [COMMITS / 50, 0])
	// a name placed: the watch at it finds its node and is told from then on
	hosted(() => edit("children", "D", [{ path: ["late"], value: "N3" }]))
	hosted(() => edit("value", "N3", [{ path: [], value: "x" }]))
	assertEquals(later, 1)
	assertEquals(counts[3], COMMITS / 50 + 1)
	// a name pointed at another node: its watch follows, and N9, no longer reached by n9, tells it nothing
	hosted(() => edit("children", "D", [{ path: ["n9"], value: "N10" }]))
	hosted(() => edit("value", "N9", [{ path: [], value: "y" }]))
	hosted(() => edit("value", "N10", [{ path: [], value: "y" }]))
	assertEquals([counts[9], counts[10]], [COMMITS / 50 + 1, COMMITS / 50 + 1])
})
