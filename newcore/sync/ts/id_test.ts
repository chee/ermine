import { assertEquals, assertThrows } from "@std/assert"
import { bytes, id, IdError, is } from "./id.ts"

const code = (f: () => unknown) => (assertThrows(f, IdError) as IdError).code
const made = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)
const VECTOR = "ermine://0c8c6f9648e6a9d929cf6d0cd4a04d186434b25d9b58dc1c984d4f31b85217ce"

Deno.test("id: the vector", () => {
	assertEquals(id("unlocked", made), VECTOR)
})

Deno.test("id: another lock, another id", () => {
	assertEquals(id("locked", made) === VECTOR, false)
})

Deno.test("id: bytes and is", () => {
	assertEquals(is(VECTOR), true)
	assertEquals(is(VECTOR.toUpperCase()), false)
	assertEquals(is(VECTOR.replace("0c", "0C")), false)
	assertEquals(is(VECTOR.slice(0, -1)), false)
	assertEquals(is(VECTOR + "0"), false)
	assertEquals(is("ermine:/" + VECTOR.slice(9)), false)
	const b = bytes(VECTOR)
	assertEquals(b.length, 32)
	assertEquals([b[0], b[1], b[31]], [0x0c, 0x8c, 0xce])
})

Deno.test("id: errors", () => {
	assertEquals(code(() => id("unlocked", new Uint8Array(31))), "size")
	assertEquals(code(() => id("unlocked", new Uint8Array(33))), "size")
	assertEquals(code(() => bytes(VECTOR.toUpperCase())), "not-an-id")
	assertEquals(code(() => bytes("nope")), "not-an-id")
})
