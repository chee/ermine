import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import createEntry from "./entry.ts"

const now = () => Math.floor(Date.now() / 1000)

Deno.test("createEntry: the value and the change; no value, none there", () => {
	const n = createEntry({ a: 1 }, {
		time: 0,
		actor: "host",
		frame: { info: {}, parent: undefined },
	})
	assertEquals(n, {
		value: { a: 1 },
		change: { time: 0, actor: "host", frame: { info: {}, parent: undefined } },
	})
	assertEquals("value" in createEntry(undefined), false)
})

Deno.test("createEntry: the change given is the entry's, not copied", () => {
	const h = { time: 1, actor: "me", frame: { info: {}, parent: undefined } }
	assertStrictEquals(createEntry(undefined, h).change, h)
})

Deno.test("createEntry: no time given, the time now, in a new change", () => {
	const before = now()
	const h = { actor: "me", frame: { info: { why: "a test" }, parent: undefined } }
	const n = createEntry(1, h as never)
	const after = now()
	assert(n.change.time >= before && n.change.time <= after, String(n.change.time))
	assertEquals({ ...n.change, time: 0 }, { ...h, time: 0 })
	assertEquals("time" in h, false)
	assert(typeof createEntry(undefined).change.time === "number")
})

Deno.test("createEntry: a time given is kept, 0 included", () => {
	assertEquals(
		createEntry(undefined, { time: 0, actor: "me", frame: { info: {}, parent: undefined } })
			.change.time,
		0,
	)
})

Deno.test("createEntry: the frame kept as given", () => {
	const locations = [{ file: "file:///old.ts", line: 3, external: true }]
	const frame = { info: { a: 1, b: 2, locations }, parent: undefined }
	const n = createEntry(undefined, { time: 1, actor: "me", frame })
	assertStrictEquals(n.change.frame, frame)
	assertStrictEquals(n.change.frame.info.locations, locations)
})

Deno.test("createEntry: the value given is the entry's, not copied", () => {
	const v = { a: [1] }
	assertStrictEquals(createEntry(v).value, v)
})
