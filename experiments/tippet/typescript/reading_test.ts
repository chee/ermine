import { assertEquals } from "@std/assert"
import { reading } from "./reading.ts"

Deno.test("reading: the cells history holds beside the shown one come after read's own item", () => {
	let hook: ((x: unknown, items: unknown[], next: (x: unknown, items: unknown[]) => unknown[]) => unknown[]) | undefined
	const asked: unknown[] = []
	const feature = reading({
		versions: (node, part, path) => {
			asked.push([node, part, path])
			return [
				{ value: 2, from: { heads: [["c", 1]] } },
				{ value: 1, from: { heads: [["b", 1]] } },
			]
		},
	})
	feature.setup({ onRead: (h: typeof hook) => void (hook = h) } as never)
	const out = hook!({ id: "n1", part: "value", path: ["dst"] }, [{ value: 2, from: {} }], (_, items) => items)
	assertEquals(asked, [["n1", "value", ["dst"]]])
	assertEquals(out, [
		{ value: 2, from: {} },
		{ value: 1, from: { feature: "tippet-reading", heads: [["b", 1]] } },
	])
})
