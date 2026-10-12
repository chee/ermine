import { assertEquals, assertNotEquals } from "@std/assert"
import { fresh } from "./fresh.ts"
import { is } from "./id.ts"

Deno.test("fresh: an ermine id, its last 16 bytes zero, new each time", () => {
	const a = fresh(), b = fresh()
	assertEquals(is(a), true)
	assertEquals(a.slice(-32), "0".repeat(32))
	assertNotEquals(a, b)
})
