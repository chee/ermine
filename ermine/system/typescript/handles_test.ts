import { assertEquals, assertThrows } from "@std/assert"
import { createErmine, ErmineError } from "./ermine.ts"
import { ensureNode, read, readEntries } from "@ermine/system"
import { manual } from "./manual_fixture.ts"

Deno.test("a handle is not data: JSON, a string, a template throw; inspected it says [node]", () => {
	const e = createErmine({ features: [manual] })
	const h = e.within(() => ensureNode("/a", 1))
	assertThrows(() => JSON.stringify({ h }), ErmineError, "not-a-value")
	assertThrows(() => `${h}`, ErmineError, "not-a-value")
	assertThrows(() => String(h), ErmineError, "not-a-value")
	assertEquals(Deno.inspect(h), "[node]")
	e.close()
})

Deno.test("an object shaped like a node is no handle; nor is another ermine's", () => {
	const one = createErmine({ features: [manual] })
	const two = createErmine({ features: [manual] })
	const h = one.within(() => ensureNode("/a", 1))
	assertThrows(
		() => one.within(() => read({ path: ["a"], part: "value" } as never)),
		ErmineError,
		"not-a-handle",
	)
	assertThrows(
		() => one.within(() => read({ id: "x", part: "value" } as never)),
		ErmineError,
		"not-a-handle",
	)
	assertThrows(() => two.within(() => read(h)), ErmineError, "not-a-handle")
	assertEquals(one.within(() => read(h)), 1)
	one.close()
	two.close()
})

Deno.test("the host mints a handle from an id; dataOf says what one reaches (a place from the root, no maker)", () => {
	const e = createErmine({ features: [manual] })
	const h = e.within(() => ensureNode("/a", 1))
	const d = e.dataOf(h)!
	assertEquals(d.node, { path: ["a"], part: "value" })
	const id = e.dataOf(e.within(() => readEntries("/a"))[0].node)!.node.id!
	assertEquals(e.within(() => read(e.handleOf({ id, part: "value" }))), 1)
	assertEquals(e.dataOf({ path: ["a"] }), undefined)
	e.close()
})
