import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import createEntry from "./entry.ts"

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
	const h = { actor: "me", metadata: { why: "a test" } }
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
	const metadata = { a: 1, b: 2 }
	const n = createEntry(undefined, { time: 1, actor: "me", external, metadata })
	assertStrictEquals(n.change.external, external)
	assertStrictEquals(n.change.metadata, metadata)
})

Deno.test("createEntry: the value given is the entry's, not copied", () => {
	const v = { a: [1] }
	assertStrictEquals(createEntry(v).value, v)
})
