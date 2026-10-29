import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import createEntry, { type Entry } from "@ermine/graph/entry"
import { createTable, type Event, type Id, TableError } from "./table.ts"

// the table checks no name and no shape: here, any key is a table name and any entry goes
type Loose = {
	add: (part: Id, id: Id, node: Entry<unknown>) => void
	sub: (part: Id, id: Id, node: Entry<unknown>) => void
	get: {
		(part: Id, id: Id): Entry<unknown> | undefined
		(part: Id, node: Entry<unknown>): Id[]
		(id: Id): [Id, Entry<unknown>][]
	}
	who: (node: Entry<unknown>) => [Id, Id][]
	del: {
		(part: Id, id: Id): void
		(part: Id, node: Entry<unknown>): void
		(node: Entry<unknown>): void
	}
}
const loose = (event?: (part: Id, id: Id) => void) =>
	createTable(event as Event | undefined) as unknown as Loose

const code = (f: () => unknown) => (assertThrows(f, TableError) as TableError).code
const node = (value?: unknown) =>
	createEntry(value, { time: 0, actor: "host", frame: { info: {}, parent: undefined } })

Deno.test("table: several parts at one id, got by part and id, and all at the id", () => {
	const t = loose()
	const value = node(1), kids = node({ b: "id-b" })
	t.add("value", "a", value)
	t.add("children", "a", kids)
	assertStrictEquals(t.get("value", "a"), value)
	assertStrictEquals(t.get("children", "a"), kids)
	assertEquals(t.get("a"), [["value", value], ["children", kids]])
	assertEquals(t.get("attributes", "a"), undefined)
	assertEquals(t.get("b"), [])
})

Deno.test("table: add refuses a different node under a taken key; the same node again is fine", () => {
	const t = loose()
	const n = node(1)
	t.add("value", "a", n)
	t.add("value", "a", n)
	assertEquals(code(() => t.add("value", "a", node(2))), "already-there")
	assertStrictEquals(t.get("value", "a"), n)
})

Deno.test("table: sub replaces; the old node loses that key only", () => {
	const t = loose()
	const old = node(1), next = node(2)
	t.add("value", "a", old)
	t.add("value", "b", old)
	t.sub("value", "a", next)
	assertStrictEquals(t.get("value", "a"), next)
	assertEquals(t.who(old), [["value", "b"]])
	t.sub("value", "c", next)
	assertEquals(t.who(next), [["value", "a"], ["value", "c"]])
})

Deno.test("table: one node under several keys; who gives them all, get its ids by part", () => {
	const t = loose()
	const n = node(1)
	t.add("value", "a", n)
	t.add("value", "b", n)
	t.add("children", "a", n)
	assertEquals(t.who(n), [["value", "a"], ["value", "b"], ["children", "a"]])
	assertEquals(t.get("value", n), ["a", "b"])
	assertEquals(t.get("children", n), ["a"])
	assertEquals(t.get("attributes", n), [])
	assertEquals(t.who(node()), [])
})

Deno.test("table: del by key, by part and node, and the node from everywhere", () => {
	const t = loose()
	const n = node(1), m = node(2)
	t.add("value", "a", n)
	t.add("value", "b", n)
	t.add("children", "a", n)
	t.add("children", "b", m)
	t.del("value", "a")
	assertEquals(t.who(n), [["value", "b"], ["children", "a"]])
	t.del("value", n)
	assertEquals(t.who(n), [["children", "a"]])
	t.add("value", "c", n)
	t.del(n)
	assertEquals([t.who(n), t.get("a"), t.get("c")], [[], [], []])
	assertEquals(t.get("b"), [["children", m]])
	assertEquals(code(() => t.del("value", "a")), "nothing-there")
	assertEquals(code(() => t.del("value", n)), "nothing-there")
	assertEquals(code(() => t.del(n)), "nothing-there")
})

Deno.test("table: symbols as parts and ids", () => {
	const t = loose()
	const part = Symbol("drag"), id = Symbol("here")
	const n = node(1)
	t.add(part, id, n)
	assertStrictEquals(t.get(part, id), n)
	assertEquals(t.get(id), [[part, n]])
	assertEquals(t.who(n), [[part, id]])
	t.del(part, id)
	assertEquals(t.who(n), [])
})

Deno.test("table: one listener told of every event, after it landed; the same node again, none", () => {
	const told: [unknown, unknown, unknown][] = []
	const t = loose((part, id) => told.push([part, id, t.get(part, id)?.value]))
	const a = createEntry(1, { time: 0, actor: "me", frame: { info: {}, parent: undefined } }),
		b = createEntry(2, { time: 0, actor: "me", frame: { info: {}, parent: undefined } })
	t.add("value", "x", a)
	t.add("value", "x", a)
	t.sub("value", "x", a)
	t.sub("value", "x", b)
	t.add("children", "x", a)
	t.add("value", "y", a)
	t.del("value", "x")
	t.del("value", a)
	t.add("value", "z", b)
	t.del(b)
	assertEquals(told, [
		["value", "x", 1],
		["value", "x", 2],
		["children", "x", 1],
		["value", "y", 1],
		["value", "x", undefined],
		["value", "y", undefined],
		["value", "z", 2],
		["value", "z", undefined],
	])
})
