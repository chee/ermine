// crow: in place while crow, copied after a read; what a reader holds, a patch's value, and
// what an undo holds never change. the same values as node's update, at random
import {
	assert,
	assertEquals,
	assertNotStrictEquals,
	assertStrictEquals,
	assertThrows,
} from "@std/assert"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import apply, { ApplyError, type Patch } from "@ermine/changeable/apply"
import { at as read, createPlaces, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable } from "@ermine/graph/table"
import { createCrow } from "./crow.ts"
import { crowify, crowifyTable, updateEntry } from "@ermine/places/crowify"

const h = (time = 1): ChangeHeader => ({
	time,
	actor: "test",
	frame: { info: {}, parent: undefined },
})
type Doc = Record<string, unknown>
const doc = (e: Entry<unknown>) => e.value as Doc

Deno.test("crow: a burst of writes copies once, then changes its copies in place", () => {
	const u = createCrow()
	const start = { a: { x: 0 }, b: 1 }
	const e = createEntry<unknown>(start, h())
	updateEntry(u, e, [{ path: ["a", "x"], value: 1 }], h())
	const root = e.value, a = doc(e).a
	assert(root !== start && a !== start.a)
	assertEquals(start, { a: { x: 0 }, b: 1 })
	updateEntry(u, e, [{ path: ["a", "x"], value: 2 }], h())
	updateEntry(u, e, [{ path: ["b"], value: 3 }], h())
	assert(e.value === root && doc(e).a === a)
	assertEquals(e.value, { a: { x: 2 }, b: 3 })
	assertEquals(e.change.op?.patches, [{ path: ["b"], value: 3 }])
	assertEquals(e.change.op?.undo, [{ path: ["b"], value: 1 }])
})

Deno.test("crow: a read lets go; what the reader holds never changes", () => {
	const u = createCrow()
	const e = createEntry<unknown>({ a: { x: 0 }, b: [1, 2] }, h())
	updateEntry(u, e, [{ path: ["a", "x"], value: 1 }], h())
	u.letGo(e)
	const held = e.value as Doc, a = held.a
	updateEntry(
		u,
		e,
		[{ path: ["a", "x"], value: 2 }, { path: ["b"], range: [0, 1], value: [] }],
		h(),
	)
	assert(e.value !== held && doc(e).a !== a)
	assertEquals(held, { a: { x: 1 }, b: [1, 2] })
	assertEquals(e.value, { a: { x: 2 }, b: [2] })
	// owned again from here
	const root = e.value
	updateEntry(u, e, [{ path: ["a", "x"], value: 3 }], h())
	assert(e.value === root)
})

Deno.test("crow: a patch's value is never changed", () => {
	const u = createCrow()
	const e = createEntry<unknown>({}, h())
	const v = { x: 1, list: [1] }
	updateEntry(u, e, [{ path: ["c"], value: v }], h())
	updateEntry(u, e, [{ path: ["c", "x"], value: 2 }, {
		path: ["c", "list"],
		range: [1, 1],
		value: [2],
	}], h())
	assertEquals(v, { x: 1, list: [1] })
	assertEquals(e.value, { c: { x: 2, list: [1, 2] } })
})

Deno.test("crow: what a write takes out is held by its undo, and never changed after", () => {
	const u = createCrow()
	const e = createEntry<unknown>({ a: { x: 0 }, list: [{ n: 0 }, { n: 1 }] }, h())
	// a and the list's elements owned
	updateEntry(u, e, [{ path: ["a", "x"], value: 1 }, { path: ["list", 0, "n"], value: 5 }], h())
	updateEntry(u, e, [{ path: ["a"], value: { x: 9 } }, {
		path: ["list"],
		range: [0, 1],
		value: [],
	}], h())
	const undo = e.change.op!.undo
	const snapshot = structuredClone(undo)
	// the undo put back (its values go in as given), then written under
	updateEntry(u, e, undo, h())
	assertEquals(e.value, { a: { x: 1 }, list: [{ n: 5 }, { n: 1 }] })
	updateEntry(u, e, [{ path: ["a", "x"], value: 2 }, { path: ["list", 0, "n"], value: 6 }], h())
	assertEquals(undo, snapshot)
	assertEquals(e.value, { a: { x: 2 }, list: [{ n: 6 }, { n: 1 }] })
})

Deno.test("crow: a write that throws changes nothing", () => {
	const u = createCrow()
	const e = createEntry<unknown>({ a: { x: 0 } }, h())
	updateEntry(u, e, [{ path: ["a", "x"], value: 1 }], h())
	const root = e.value, change = e.change
	const error = assertThrows(() =>
		updateEntry(
			u,
			e,
			[{ path: ["a", "x"], value: 2 }, { path: ["nope", "deeper"], value: 1 }],
			h(),
		)
	) as ApplyError
	assertEquals([error.code, error.patch], ["no-key", 1])
	assert(e.value === root && e.change === change)
	assertEquals(e.value, { a: { x: 1 } })
})

Deno.test("crow: through reading, a get is a read; a get of ids is not", () => {
	const u = createCrow()
	const table = createTable()
	const t = crowifyTable(table, u)
	const e = createEntry<unknown>({ a: 1 }, h())
	table.add("value", "N", e as never)
	// owned: the next write changes the root in place; read: the next write copies it
	updateEntry(u, e, [{ path: ["a"], value: 2 }], h())
	const owned = e.value
	t.get("value", e as never)
	updateEntry(u, e, [{ path: ["a"], value: 3 }], h())
	assertStrictEquals(e.value, owned)
	t.get("value", "N")
	const held = e.value
	updateEntry(u, e, [{ path: ["a"], value: 4 }], h())
	assertNotStrictEquals(e.value, held)
	const again = e.value
	t.get("N")
	updateEntry(u, e, [{ path: ["a"], value: 5 }], h())
	assertNotStrictEquals(e.value, again)
	assertEquals(e.value, { a: 5 })
})

Deno.test("crow: crowify: what a computation keeps past its run is held; what it read and dropped is not", () => {
	const u = createCrow()
	const s = createScheduler()
	crowify(s, u)
	const e = createEntry<unknown>({ a: { x: 0 }, b: { y: 0 } }, h())
	updateEntry(u, e, [{ path: ["a", "x"], value: 1 }, { path: ["b", "y"], value: 1 }], h())
	const o = s.createRootScope({ actor: "r" })
	let held: unknown
	// keeps a; reads b and keeps only a number
	s.runWithScope(o, () => s.createComputer(() => (s.track("e"), doc(e).a), (v) => void (held = v)))
	s.runWithScope(o, () => s.createComputer(() => (s.track("e"), (doc(e).b as Doc).y), () => {}))
	s.pulse()
	const root = e.value, b = doc(e).b
	updateEntry(u, e, [{ path: ["a", "x"], value: 2 }, { path: ["b", "y"], value: 2 }], h())
	assertEquals(held, { x: 1 })
	assert(e.value === root && doc(e).b === b)
	assertEquals(e.value, { a: { x: 2 }, b: { y: 2 } })
})

Deno.test("crow: kept stops at what was handed: what is owned under it let go, the rest still owned", () => {
	const u = createCrow()
	const e = createEntry<unknown>({ big: { a: { x: 0 }, b: { y: 0 } }, other: { z: 0 } }, h())
	updateEntry(
		u,
		e,
		[{ path: ["big", "a", "x"], value: 1 }, { path: ["other", "z"], value: 1 }],
		h(),
	)
	const root = e.value, big = doc(e).big as Doc, other = doc(e).other
	// a list the run made, holding what it was handed
	u.letGoIn([big], new Set([big]))
	updateEntry(
		u,
		e,
		[{ path: ["big", "a", "x"], value: 2 }, { path: ["other", "z"], value: 2 }],
		h(),
	)
	assert(e.value === root && doc(e).other === other)
	assert(doc(e).big !== big && (doc(e).big as Doc).a !== big.a)
	assertEquals(big, { a: { x: 1 }, b: { y: 0 } })
	assertEquals(e.value, { big: { a: { x: 2 }, b: { y: 0 } }, other: { z: 2 } })
})

Deno.test("crow: kept walks a cycle of the run's own once", () => {
	const u = createCrow()
	const loop: Record<string, unknown> = { n: 1 }
	loop.self = loop
	loop.list = [loop, { deeper: loop }]
	u.letGoIn(loop)
	u.letGoIn(loop, new Set())
})

Deno.test("crow: crowify through places stops at what a run was handed; a run keeping only a count holds nothing", () => {
	const u = createCrow()
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places: Places = createPlaces({
		root: "R",
		table,
		paths: createPaths(),
		scheduler: s,
	})
	crowify(s, u, (key) => {
		const where = places.describe(key)
		return where?.path ? read(table.get(where.part, where.id)?.value, where.path) : undefined
	})
	const host = s.createRootScope({ actor: "host" })
	const header = () => s.runWithScope(host, () => createChangeHeader(s))
	table.sub("value", "N", createEntry({ folder: { a: "A" }, n: 0 }, header()) as never)
	const e = table.get("value", "N")!
	updateEntry(u, e, [{ path: ["folder", "b"], value: "B" }], header())
	places.commit([e])
	const folder = doc(e).folder
	// a count: holds nothing, so the folder goes on changing in place
	let count: unknown
	s.runWithScope(s.createRootScope({ actor: "r" }), () =>
		s.createComputer(
			() => ({ count: Object.keys(places.readValue("value", "N", ["folder"]) as Doc).length }),
			(v) => void (count = v),
		))
	s.pulse()
	updateEntry(u, e, [{ path: ["folder", "c"], value: "C" }], header())
	places.commit([e])
	s.pulse()
	assert(doc(e).folder === folder)
	assertEquals(count, { count: 3 })
	// the folder itself, kept: the next write copies it
	let held: unknown
	s.runWithScope(
		s.createRootScope({ actor: "r" }),
		() =>
			s.createComputer(() => places.readValue("value", "N", ["folder"]), (v) => void (held = v)),
	)
	s.pulse()
	updateEntry(u, e, [{ path: ["folder", "d"], value: "D" }], header())
	places.commit([e])
	assert(doc(e).folder !== folder)
	assertEquals(held, { a: "A", b: "B", c: "C" })
})

Deno.test("crow: through places, a reader's value never changes under it, and it is told", () => {
	const u = createCrow()
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places: Places = createPlaces({
		root: "R",
		table: crowifyTable(table, u),
		paths: createPaths(),
		scheduler: s,
	})
	const host = s.createRootScope({ actor: "host" })
	const header = () => s.runWithScope(host, () => createChangeHeader(s))
	table.sub("children", "F", createEntry({ a: "A" }, header()) as never)
	const held: unknown[] = []
	s.runWithScope(
		s.createRootScope({ actor: "r" }),
		() => s.createComputer(() => places.readValue("children", "F"), (v) => void held.push(v)),
	)
	s.pulse()
	const e = table.get("children", "F")!
	for (const [name, id] of [["b", "B"], ["c", "C"], ["d", "D"]]) {
		updateEntry(u, e, [{ path: [name], value: id }], header())
		places.commit([e])
	}
	s.pulse()
	assertEquals(held, [{ a: "A" }, { a: "A", b: "B", c: "C", d: "D" }])
})

Deno.test("crow: crowify: a stop given twice takes away no other crowify's wiring", () => {
	const u = createCrow()
	const s = createScheduler()
	const stop = crowify(s, u)
	crowify(s, u)
	stop()
	stop()
	const e = createEntry<unknown>({ a: { x: 0 } }, h())
	updateEntry(u, e, [{ path: ["a", "x"], value: 1 }], h())
	const o = s.createRootScope({ actor: "r" })
	let held: unknown
	// writes where the run read, in its set: past its body's return, so what it read is let go first
	s.runWithScope(o, () =>
		s.createComputer(() => (s.track("e"), doc(e).a), (v) => {
			held = v
			updateEntry(u, e, [{ path: ["a", "x"], value: 2 }], h())
		}))
	s.pulse()
	assertEquals(held, { x: 1 })
	assertEquals(e.value, { a: { x: 2 } })
})
