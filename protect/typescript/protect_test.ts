// Unit tests for what a line protocol cannot send, such as policies that are functions. The
// conformance suite in protect/conformance/protect/ holds the behaviour for both languages.
import { assertEquals } from "@std/assert"
import { all, any, may, no, type Policy, same, yes } from "./protect.ts"

const ask = { who: {}, op: "read", target: {} }
const reader = () => undefined

Deno.test("protect: policies stop at the answer", () => {
	let asked = 0
	const count: Policy = () => (asked++, yes)
	assertEquals(may(all(() => no("n"), count), reader)(ask), no("n"))
	assertEquals(may(any(() => yes, count), reader)(ask), yes)
	assertEquals(asked, 0)
})

Deno.test("protect: same: bytes and typed arrays by content and kind", () => {
	assertEquals(same(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true)
	assertEquals(same(Uint8Array.of(1, 2), Uint8Array.of(1, 3)), false)
	assertEquals(same(Uint8Array.of(1, 2), Uint8Array.of(1)), false)
	assertEquals(same(new Int16Array([1, 2]), new Int16Array([1, 2])), true)
	assertEquals(same(new Int16Array([1, 2]), new Uint16Array([1, 2])), false)
	assertEquals(same({ a: Uint8Array.of(7) }, { a: Uint8Array.of(7) }), true)
	assertEquals(same(Uint8Array.of(1), [1]), false)
})
