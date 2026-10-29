import { assertEquals } from "@std/assert"
import { blake3 } from "@ermine/encoding/blake3"
import { hashed, kind } from "./ids.ts"

Deno.test("hashed: an input of any size (300 kB), its pieces each a varint length then its bytes", () => {
	const big = new Uint8Array(300000).fill(7)
	const id = hashed("d", big)
	assertEquals(kind(id), "hashed")
	// "d" is one byte: 0x01 0x64; 300000 as a varint: e0 a7 12
	const want = new Uint8Array(2 + 3 + big.length)
	want.set([1, 0x64, 0xe0, 0xa7, 0x12])
	want.set(big, 5)
	assertEquals(id.subarray(2), blake3(want).subarray(0, 16))
})
