// unread: in place while unread, copied after a read; what a reader holds, a patch's value, and
// what an undo holds never change. the same values as node's update, at random
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import apply, { ApplyError, type Patch } from "@ermine/core/changeable/apply"
import { at as read, createPlaces, type Places } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable } from "@ermine/core/table"
import { createUnread, keeping, reading } from "./unread.ts"
import { unread_conformance_hook_owned } from "./unread_conformance_hook.ts"

const h = (time = 1): ChangeHeader => ({ time, actor: "test" })
type Doc = Record<string, unknown>
const doc = (e: Entry<unknown>) => e.value as Doc

Deno.test("unread: a burst of writes copies once, then changes its copies in place", () => {
	const u = createUnread()
	const start = { a: { x: 0 }, b: 1 }
	const e = createEntry<unknown>(start, h())
	u.update(e, [{ path: ["a", "x"], value: 1 }], h())
	const root = e.value, a = doc(e).a
	assert(root !== start && a !== start.a)
	assertEquals(start, { a: { x: 0 }, b: 1 })
	u.update(e, [{ path: ["a", "x"], value: 2 }], h())
	u.update(e, [{ path: ["b"], value: 3 }], h())
	assert(e.value === root && doc(e).a === a)
	assertEquals(e.value, { a: { x: 2 }, b: 3 })
	assertEquals(e.change.op?.patches, [{ path: ["b"], value: 3 }])
	assertEquals(e.change.op?.undo, [{ path: ["b"], value: 1 }])
})

Deno.test("unread: a read lets go; what the reader holds never changes", () => {
	const u = createUnread()
	const e = createEntry<unknown>({ a: { x: 0 }, b: [1, 2] }, h())
	u.update(e, [{ path: ["a", "x"], value: 1 }], h())
	u.read(e)
	const held = e.value as Doc, a = held.a
	u.update(e, [{ path: ["a", "x"], value: 2 }, { path: ["b"], range: [0, 1], value: [] }], h())
	assert(e.value !== held && doc(e).a !== a)
	assertEquals(held, { a: { x: 1 }, b: [1, 2] })
	assertEquals(e.value, { a: { x: 2 }, b: [2] })
	// owned again from here
	const root = e.value
	u.update(e, [{ path: ["a", "x"], value: 3 }], h())
	assert(e.value === root)
})

Deno.test("unread: a patch's value is never changed", () => {
	const u = createUnread()
	const e = createEntry<unknown>({}, h())
	const v = { x: 1, list: [1] }
	u.update(e, [{ path: ["c"], value: v }], h())
	u.update(
		e,
		[{ path: ["c", "x"], value: 2 }, { path: ["c", "list"], range: [1, 1], value: [2] }],
		h(),
	)
	assertEquals(v, { x: 1, list: [1] })
	assertEquals(e.value, { c: { x: 2, list: [1, 2] } })
})

Deno.test("unread: what a write takes out is held by its undo, and never changed after", () => {
	const u = createUnread()
	const e = createEntry<unknown>({ a: { x: 0 }, list: [{ n: 0 }, { n: 1 }] }, h())
	// a and the list's elements owned
	u.update(e, [{ path: ["a", "x"], value: 1 }, { path: ["list", 0, "n"], value: 5 }], h())
	u.update(
		e,
		[{ path: ["a"], value: { x: 9 } }, { path: ["list"], range: [0, 1], value: [] }],
		h(),
	)
	const undo = e.change.op!.undo
	const snapshot = structuredClone(undo)
	// the undo put back (its values go in as given), then written under
	u.update(e, undo, h())
	assertEquals(e.value, { a: { x: 1 }, list: [{ n: 5 }, { n: 1 }] })
	u.update(e, [{ path: ["a", "x"], value: 2 }, { path: ["list", 0, "n"], value: 6 }], h())
	assertEquals(undo, snapshot)
	assertEquals(e.value, { a: { x: 2 }, list: [{ n: 6 }, { n: 1 }] })
})

Deno.test("unread: a write that throws changes nothing", () => {
	const u = createUnread()
	const e = createEntry<unknown>({ a: { x: 0 } }, h())
	u.update(e, [{ path: ["a", "x"], value: 1 }], h())
	const root = e.value, change = e.change
	const error = assertThrows(() =>
		u.update(e, [{ path: ["a", "x"], value: 2 }, { path: ["nope", "deeper"], value: 1 }], h())
	) as ApplyError
	assertEquals([error.code, error.patch], ["no-key", 1])
	assert(e.value === root && e.change === change)
	assertEquals(e.value, { a: { x: 1 } })
})

Deno.test("unread: through reading, a get is a read; a get of ids is not", () => {
	const u = createUnread()
	const table = createTable()
	const t = reading(table, u)
	const e = createEntry<unknown>({ a: 1 }, h())
	table.add("value", "N", e as never)
	u.update(e, [{ path: ["a"], value: 2 }], h())
	assert(unread_conformance_hook_owned(u, e) !== undefined)
	t.get("value", e as never)
	assert(unread_conformance_hook_owned(u, e) !== undefined)
	t.get("value", "N")
	assertEquals(unread_conformance_hook_owned(u, e), undefined)
	u.update(e, [{ path: ["a"], value: 3 }], h())
	t.get("N")
	assertEquals(unread_conformance_hook_owned(u, e), undefined)
})

Deno.test("unread: keeping: what a computation keeps past its run is held; what it read and dropped is not", () => {
	const u = createUnread()
	const s = createScheduler()
	keeping(s, u)
	const e = createEntry<unknown>({ a: { x: 0 }, b: { y: 0 } }, h())
	u.update(e, [{ path: ["a", "x"], value: 1 }, { path: ["b", "y"], value: 1 }], h())
	const o = s.createRootScope({ actor: "r" })
	let held: unknown
	// keeps a; reads b and keeps only a number
	s.runWithScope(o, () => s.createComputer(() => (s.track("e"), doc(e).a), (v) => void (held = v)))
	s.runWithScope(o, () => s.createComputer(() => (s.track("e"), (doc(e).b as Doc).y), () => {}))
	s.pulse()
	const root = e.value, b = doc(e).b
	u.update(e, [{ path: ["a", "x"], value: 2 }, { path: ["b", "y"], value: 2 }], h())
	assertEquals(held, { x: 1 })
	assert(e.value === root && doc(e).b === b)
	assertEquals(e.value, { a: { x: 2 }, b: { y: 2 } })
})

Deno.test("unread: kept stops at what was handed: what is owned under it let go, the rest still owned", () => {
	const u = createUnread()
	const e = createEntry<unknown>({ big: { a: { x: 0 }, b: { y: 0 } }, other: { z: 0 } }, h())
	u.update(e, [{ path: ["big", "a", "x"], value: 1 }, { path: ["other", "z"], value: 1 }], h())
	const root = e.value, big = doc(e).big as Doc, other = doc(e).other
	// a list the run made, holding what it was handed
	u.kept([big], new Set([big]))
	u.update(e, [{ path: ["big", "a", "x"], value: 2 }, { path: ["other", "z"], value: 2 }], h())
	assert(e.value === root && doc(e).other === other)
	assert(doc(e).big !== big && (doc(e).big as Doc).a !== big.a)
	assertEquals(big, { a: { x: 1 }, b: { y: 0 } })
	assertEquals(e.value, { big: { a: { x: 2 }, b: { y: 0 } }, other: { z: 2 } })
})

Deno.test("unread: kept walks a cycle of the run's own once", () => {
	const u = createUnread()
	const loop: Record<string, unknown> = { n: 1 }
	loop.self = loop
	loop.list = [loop, { deeper: loop }]
	u.kept(loop)
	u.kept(loop, new Set())
})

Deno.test("unread: keeping through places stops at what a run was handed; a run keeping only a count holds nothing", () => {
	const u = createUnread()
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places: Places = createPlaces({
		root: "R",
		table,
		paths: createPaths(),
		scheduler: s,
	})
	keeping(s, u, (key) => {
		const where = places.describe(key)
		return where?.path ? read(table.get(where.part, where.id)?.value, where.path) : undefined
	})
	const host = s.createRootScope({ actor: "host" })
	const header = () => s.runWithScope(host, () => createChangeHeader(s))
	table.sub("value", "N", createEntry({ folder: { a: "A" }, n: 0 }, header()) as never)
	const e = table.get("value", "N")!
	u.update(e, [{ path: ["folder", "b"], value: "B" }], header())
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
	u.update(e, [{ path: ["folder", "c"], value: "C" }], header())
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
	u.update(e, [{ path: ["folder", "d"], value: "D" }], header())
	places.commit([e])
	assert(doc(e).folder !== folder)
	assertEquals(held, { a: "A", b: "B", c: "C" })
})

Deno.test("unread: through places, a reader's value never changes under it, and it is told", () => {
	const u = createUnread()
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places: Places = createPlaces({
		root: "R",
		table: reading(table, u),
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
		u.update(e, [{ path: [name], value: id }], header())
		places.commit([e])
	}
	s.pulse()
	assertEquals(held, [{ a: "A" }, { a: "A", b: "B", c: "C", d: "D" }])
})
