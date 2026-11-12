import { assertEquals } from "@std/assert"
import { reading } from "./reading.ts"

Deno.test("reading: the cells history holds beside the shown one, without the shown one", () => {
	const asked: unknown[] = []
	const answerer = reading({
		versions: (node, part, path) => {
			asked.push([node, part, path])
			return [
				{ value: 2, from: { heads: [["c", 1]] } },
				{ value: 1, from: { heads: [["b", 1]] } },
			]
		},
	})
	assertEquals(answerer.from, "tippet-reading")
	assertEquals(answerer.read!("value", "n1", ["dst"]), [{ value: 1, from: { heads: [["b", 1]] } }])
	assertEquals(asked, [["n1", "value", ["dst"]]])
})
