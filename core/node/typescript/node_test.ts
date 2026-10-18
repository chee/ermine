import { assertEquals, assertStrictEquals } from "@std/assert"
import createEntry from "./entry.ts"
import createNode, { type Node } from "./node.ts"

Deno.test("createNode: each table's value made an entry, and no other tables", () => {
	const node = createNode({ value: { a: 1 }, children: { a: "id" } }, { time: 3, actor: "me" })
	assertEquals(Object.keys(node), ["value", "children"])
	assertEquals(node.value, { value: { a: 1 }, change: { time: 3, actor: "me" } })
	assertEquals(node.children.value, { a: "id" })
})

Deno.test("createNode: one change for every table, the same time when none is given", () => {
	const given = { time: 3, actor: "me" }
	const node = createNode({ value: 1, attributes: {} }, given)
	assertStrictEquals(node.value.change, given)
	assertStrictEquals(node.attributes.change, given)
	const now = createNode({ value: 1, attributes: {} }, { actor: "me" } as never)
	assertStrictEquals(now.value.change, now.attributes.change)
	assertEquals(typeof now.value.change.time, "number")
})

Deno.test("createNode: a table given undefined is left out; null is a value", () => {
	const node = createNode({ value: undefined, attributes: null }, { time: 0, actor: "me" })
	assertEquals(Object.keys(node), ["attributes"])
	assertEquals(node.attributes.value, null)
})

Deno.test("createNode: the values not copied", () => {
	const value = { deep: [1] }
	assertStrictEquals(createNode({ value }, { time: 0, actor: "me" }).value.value, value)
})

Deno.test("createNode: no tables, an empty node; any name is a table, __proto__ too", () => {
	assertEquals(createNode({}), {})
	const names = ["", "a/b c", "é 🦊", "toString", "constructor", "__proto__"]
	const values: Record<string, unknown> = {}
	for (const [i, t] of names.entries()) {
		Object.defineProperty(values, t, {
			value: i,
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	const node = createNode(values, { time: 0, actor: "me" })
	assertEquals(Object.keys(node), names)
	assertEquals(node["__proto__"].value, 5)
	assertEquals(Object.getPrototypeOf(node), Object.prototype)
})

Deno.test("createNode: a node made another way is just as good", () => {
	const node: Node<{ value: number }> = { value: createEntry(1, { time: 0, actor: "me" }) }
	assertEquals(node.value.value, 1)
})
