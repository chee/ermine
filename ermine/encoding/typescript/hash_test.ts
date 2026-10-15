import { assertEquals, assertNotEquals } from "@std/assert"
import { hash } from "./hash.ts"

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("")

Deno.test("hash: agrees with conformance/hash/vectors.json (C reads the same file)", async () => {
	const vectors = JSON.parse(
		await Deno.readTextFile(new URL("../conformance/hash/vectors.json", import.meta.url)),
	) as { value: never; hash: string }[]
	for (const v of vectors) assertEquals(hex(hash(v.value)), v.hash, JSON.stringify(v.value))
})

Deno.test("hash: canonical, so key order doesn't matter; any change does", () => {
	assertEquals(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }))
	assertNotEquals(hash({ a: 1 }), hash({ a: 2 }))
	assertEquals(hash("x").length, 32)
})
