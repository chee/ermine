import { assertEquals } from "@std/assert"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import { createTable } from "@ermine/core/table"
import { upsert } from "./upsert.ts"

const h: ChangeHeader = { actor: "t", time: 0 }

function world() {
	const events: string[] = []
	const table = createTable((part, id) => void events.push(`${part}:${String(id)}`))
	const value = (id: string) => table.get("value", id)?.value
	return { table, events, value }
}

Deno.test("upsert: no entry, one made holding the nested value; the table tells", () => {
	const { table, events, value } = world()
	assertEquals(upsert(table, "value", "a", ["x", "y"], 1, h), [])
	assertEquals(value("a"), { x: { y: 1 } })
	assertEquals(events, ["value:a"])
})

Deno.test("upsert: an entry, one patch at the path; missing levels nested at the first missing", () => {
	const { table, value } = world()
	table.add("value", "a", createEntry<unknown>({ x: { y: 1 } }, h) as Entry<never>)
	const patches = (path: string[], v: unknown) => {
		const e = upsert(table, "value", "a", path, v, h)
		assertEquals(e.length, 1)
		return e[0].change.op?.patches
	}
	assertEquals(patches(["x", "z"], 2), [{ path: ["x", "z"], value: 2 }])
	assertEquals(patches(["p", "q", "r"], 3), [{ path: ["p"], value: { q: { r: 3 } } }])
	assertEquals(patches(["x", "y", "w"], 4), [{ path: ["x", "y"], value: { w: 4 } }])
	assertEquals(value("a"), { x: { y: { w: 4 }, z: 2 }, p: { q: { r: 3 } } })
})

Deno.test("upsert: the same value already there writes nothing; a scalar root is put over", () => {
	const { table, value } = world()
	table.add("value", "a", createEntry<unknown>({ x: { y: [1, { z: 2 }] } }, h) as Entry<never>)
	assertEquals(upsert(table, "value", "a", ["x"], { y: [1, { z: 2 }] }, h), [])
	assertEquals(upsert(table, "value", "a", ["x", "y"], [1, { z: 2 }], h), [])
	assertEquals(table.get("value", "a")!.change.op, undefined)
	table.add("value", "s", createEntry<unknown>(7, h) as Entry<never>)
	const e = upsert(table, "value", "s", ["p"], 1, h)
	assertEquals(e[0].change.op?.patches, [{ path: [], value: { p: 1 } }])
	assertEquals(value("s"), { p: 1 })
})

Deno.test("upsert: a map with no prototype is a map: written inside and equal to a plain one", () => {
	const { table, value } = world()
	const bare = Object.assign(Object.create(null), { y: 1 })
	table.add("value", "a", createEntry<unknown>({ x: bare }, h) as Entry<never>)
	// the same value there: nothing written
	assertEquals(upsert(table, "value", "a", ["x"], { y: 1 }, h), [])
	// a level that is a bare map is written inside, not put over
	const e = upsert(table, "value", "a", ["x", "z"], 2, h)
	assertEquals(e[0].change.op?.patches, [{ path: ["x", "z"], value: 2 }])
	assertEquals(value("a"), { x: { y: 1, z: 2 } })
})
