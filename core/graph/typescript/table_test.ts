import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import createNode from "@ermine/node"
import { createTable, TableError } from "./table.ts"

const code = (f: () => unknown) => (assertThrows(f, TableError) as TableError).code
const node = (value?: unknown) => createNode(value, { time: 0, actor: "host" })

Deno.test("table: several parts at one id, got by part and id, and all at the id", () => {
	const t = createTable<unknown>()
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
	const t = createTable<unknown>()
	const n = node(1)
	t.add("value", "a", n)
	t.add("value", "a", n)
	assertEquals(code(() => t.add("value", "a", node(2))), "already-there")
	assertStrictEquals(t.get("value", "a"), n)
})

Deno.test("table: sub replaces; the old node loses that key only", () => {
	const t = createTable<unknown>()
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
	const t = createTable<unknown>()
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
	const t = createTable<unknown>()
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
	const t = createTable<unknown>()
	const part = Symbol("drag"), id = Symbol("here")
	const n = node(1)
	t.add(part, id, n)
	assertStrictEquals(t.get(part, id), n)
	assertEquals(t.get(id), [[part, n]])
	assertEquals(t.who(n), [[part, id]])
	t.del(part, id)
	assertEquals(t.who(n), [])
})
