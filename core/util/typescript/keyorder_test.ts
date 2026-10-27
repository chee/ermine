import { assertEquals } from "@std/assert"
import { keyorder } from "./keyorder.ts"

Deno.test("keyorder: shorter in UTF-8 bytes first, then bytewise", () => {
	assertEquals(["bb", "a", "é", "ab", "z"].sort(keyorder), ["a", "z", "ab", "bb", "é"])
})

Deno.test("keyorder: a lone surrogate is not U+FFFD: distinct keys are never equal", () => {
	const keys = ["�", "\ud800", "\udc00", "𐀀", "a\ud800"]
	for (const a of keys) {
		for (const b of keys) assertEquals(keyorder(a, b) === 0, a === b, `${a} ${b}`)
	}
	// WTF-8: ED A0 80, ED B0 80, then EF BF BD
	assertEquals(["�", "\udc00", "\ud800"].sort(keyorder), ["\ud800", "\udc00", "�"])
	assertEquals(keyorder("\ud800", "\ud800"), 0)
})
