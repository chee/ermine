import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import createNode from "./node.ts"

const now = () => Math.floor(Date.now() / 1000)

Deno.test("createNode: the value and the change; no value, none there", () => {
	const n = createNode({ a: 1 }, { time: 0, actor: "host" })
	assertEquals(n, { value: { a: 1 }, change: { time: 0, actor: "host" } })
	assertEquals("value" in createNode(), false)
})

Deno.test("createNode: the change given is the node's, not copied", () => {
	const h = { time: 1, actor: "me" }
	assertStrictEquals(createNode(undefined, h).change, h)
})

Deno.test("createNode: no time given, the time now, in a new change", () => {
	const before = now()
	const h = { actor: "me", metadata: [["why", "a test"]] as [string, unknown][] }
	const n = createNode(1, h as never)
	const after = now()
	assert(n.change.time >= before && n.change.time <= after, String(n.change.time))
	assertEquals({ ...n.change, time: 0 }, { ...h, time: 0 })
	assertEquals("time" in h, false)
	assert(typeof createNode().change.time === "number")
})

Deno.test("createNode: a time given is kept, 0 included", () => {
	assertEquals(createNode(undefined, { time: 0, actor: "me" }).change.time, 0)
})

Deno.test("createNode: external and metadata kept as given", () => {
	const external = [{ file: "file:///old.ts", line: 3 }]
	const metadata: [string, unknown][] = [["a", 1], ["a", 2]]
	const n = createNode(undefined, { time: 1, actor: "me", external, metadata })
	assertStrictEquals(n.change.external, external)
	assertStrictEquals(n.change.metadata, metadata)
})

Deno.test("createNode: the value given is the node's, not copied", () => {
	const v = { a: [1] }
	assertStrictEquals(createNode(v).value, v)
})
