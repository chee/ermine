import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import createEntry, { createNode } from "./node.ts"

const now = () => Math.floor(Date.now() / 1000)

Deno.test("createEntry: the value and the change; no value, none there", () => {
	const n = createEntry({ a: 1 }, { time: 0, actor: "host" })
	assertEquals(n, { value: { a: 1 }, change: { time: 0, actor: "host" } })
	assertEquals("value" in createEntry(undefined), false)
})

Deno.test("createEntry: the change given is the entry's, not copied", () => {
	const h = { time: 1, actor: "me" }
	assertStrictEquals(createEntry(undefined, h).change, h)
})

Deno.test("createEntry: no time given, the time now, in a new change", () => {
	const before = now()
	const h = { actor: "me", metadata: [["why", "a test"]] as [string, unknown][] }
	const n = createEntry(1, h as never)
	const after = now()
	assert(n.change.time >= before && n.change.time <= after, String(n.change.time))
	assertEquals({ ...n.change, time: 0 }, { ...h, time: 0 })
	assertEquals("time" in h, false)
	assert(typeof createEntry(undefined).change.time === "number")
})

Deno.test("createEntry: a time given is kept, 0 included", () => {
	assertEquals(createEntry(undefined, { time: 0, actor: "me" }).change.time, 0)
})

Deno.test("createEntry: external and metadata kept as given", () => {
	const external = [{ file: "file:///old.ts", line: 3 }]
	const metadata: [string, unknown][] = [["a", 1], ["a", 2]]
	const n = createEntry(undefined, { time: 1, actor: "me", external, metadata })
	assertStrictEquals(n.change.external, external)
	assertStrictEquals(n.change.metadata, metadata)
})

Deno.test("createEntry: the value given is the entry's, not copied", () => {
	const v = { a: [1] }
	assertStrictEquals(createEntry(v).value, v)
})

Deno.test("createEntry: cow: false is remembered, and only that", () => {
	assertEquals(createEntry(1, undefined, { cow: false }).cow, false)
	assertEquals("cow" in createEntry(1), false)
	assertEquals("cow" in createEntry(1, undefined, {}), false)
})

Deno.test("createNode: the entries given, by table name, and nothing more", () => {
	const value = createEntry({ a: 1 }, { time: 0, actor: "me" })
	const children = createEntry([["a", "id"]], { time: 1, actor: "me" })
	const n = createNode({ value, children })
	assertEquals(Object.keys(n), ["value", "children"])
	assertStrictEquals(n.value, value)
	assertStrictEquals(n.children, children)
})

Deno.test("createNode: the object given is the node, not copied; the entries too", () => {
	const entries = { value: createEntry(1, { time: 0, actor: "me" }) }
	assertStrictEquals(createNode(entries), entries)
})

Deno.test("createNode: no tables, an empty node; any name is a table", () => {
	assertEquals(createNode({}), {})
	const names = ["", "a/b c", "é 🦊", "toString", "attributes"]
	const n = createNode(
		Object.fromEntries(names.map((t, i) => [t, createEntry(i, { time: i, actor: "me" })])),
	)
	assertEquals(Object.keys(n), names)
	assertEquals(n["toString"].value, 3)
})

Deno.test("createNode: nothing checked, an entry with no value is fine", () => {
	const n = createNode({ attributes: createEntry(undefined, { time: 0, actor: "me" }) })
	assertEquals("value" in n.attributes, false)
})
