import { assert, assertEquals, assertNotStrictEquals, assertStrictEquals } from "@std/assert"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/graph/entry"
import { createTable } from "@ermine/graph/table"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createCrow } from "@ermine/crow"
import { at as read, createPlaces, type Places } from "./places.ts"
import { createChangeHeader } from "./header.ts"
import { crowify, crowifyTable, updateEntry } from "./crowify.ts"

const h = (): ChangeHeader => ({ time: 1, actor: "test", frame: { info: {}, parent: undefined } })
type Doc = Record<string, unknown>
const doc = (e: Entry<unknown>) => e.value as Doc

Deno.test("updateEntry: the change carries the patches and their undo", () => {
	const u = createCrow()
	const e = createEntry<unknown>({ a: { x: 0 }, b: 1 }, h())
	updateEntry(u, e, [{ path: ["b"], value: 3 }], h())
	assertEquals(e.change.op?.patches, [{ path: ["b"], value: 3 }])
	assertEquals(e.change.op?.undo, [{ path: ["b"], value: 1 }])
})

Deno.test("crowify: what a run read before an await is let go of as it waits: a write then copies it", async () => {
	const s = createScheduler()
	const u = createCrow()
	const e = createEntry<{ list: Record<string, number> }>({ list: { a: 1 } }, h())
	// the crow owns the root and the list from here
	updateEntry(u, e, [{ path: ["list", "b"], value: 2 }], h())
	const key = {}
	crowify(s, u, (k) => k === key ? e.value : undefined)
	let held: Record<string, number> | undefined
	let go!: () => void
	const waited = new Promise<void>((r) => go = r)
	s.runWithScope(s.createRootScope({ actor: "test" }), () =>
		s.createComputer(async () => {
			s.track(key)
			held = e.value!.list
			await waited
			return Object.keys(held).length
		}, () => {}))
	s.pulse()
	updateEntry(u, e, [{ path: ["list", "c"], value: 3 }], h())
	assertEquals(held, { a: 1, b: 2 })
	assertEquals(e.value!.list, { a: 1, b: 2, c: 3 })
	go()
	await waited
})

Deno.test("crowify: through reading, a get is a read; a get of ids is not", () => {
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

Deno.test("crowify: crowify: what a computation keeps past its run is held; what it read and dropped is not", () => {
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

Deno.test("crowify: crowify through places stops at what a run was handed; a run keeping only a count holds nothing", () => {
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

Deno.test("crowify: through places, a reader's value never changes under it, and it is told", () => {
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

Deno.test("crowify: crowify: a stop given twice takes away no other crowify's wiring", () => {
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
