import { assertEquals, assertThrows } from "@std/assert"
import createNode from "./node.ts"
import { createTable, TableError } from "./table.ts"

const code = (f: () => unknown) => (assertThrows(f, TableError) as TableError).code

Deno.test("table: intro, get, outro", () => {
	const t = createTable<unknown, never>()
	const root = createNode<unknown, never>("root")
	t.intro(root)
	t.intro(root)
	assertEquals(t.get("root"), root)
	assertEquals(code(() => t.intro(createNode("root"))), "already-there")
	t.outro("root")
	assertEquals(t.get("root"), undefined)
	assertEquals(code(() => t.outro("root")), "nothing-there")
})
