import { assert, assertEquals, assertThrows } from "@std/assert"
import { createErmine, ErmineError } from "./ermine.ts"

Deno.test("a handle is not data: JSON, a string, a template throw; inspected it says [node]", () => {
	const e = createErmine({ schedule: () => {} })
	const h = e.ensureNode("/a", 1)
	assertThrows(() => JSON.stringify({ h }), ErmineError, "not-a-value")
	assertThrows(() => `${h}`, ErmineError, "not-a-value")
	assertThrows(() => String(h), ErmineError, "not-a-value")
	assertEquals(Deno.inspect(h), "[node]")
	e.close()
})

Deno.test("an object shaped like a node is no handle; nor is another ermine's", () => {
	const one = createErmine({ schedule: () => {} })
	const two = createErmine({ schedule: () => {} })
	const h = one.ensureNode("/a", 1)
	assertThrows(
		() => one.read({ path: ["a"], part: "value" } as never),
		ErmineError,
		"not-a-handle",
	)
	assertThrows(() => one.read({ id: "x", part: "value" } as never), ErmineError, "not-a-handle")
	assertThrows(() => two.read(h), ErmineError, "not-a-handle")
	assertEquals(one.read(h), 1)
	one.close()
	two.close()
})

Deno.test("the host mints a handle from an id; dataOf says what one reaches (a place from the root, no maker)", () => {
	const e = createErmine({ schedule: () => {} })
	const h = e.ensureNode("/a", 1)
	const d = e.dataOf(h)!
	assertEquals(d.node, { path: ["a"], part: "value" })
	const id = e.dataOf(e.readEntries("/a")[0].node)!.node.id!
	assertEquals(e.read(e.handleOf({ id, part: "value" })), 1)
	assertEquals(e.dataOf({ path: ["a"] }), undefined)
	e.close()
})
