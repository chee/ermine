// unit tests; the conformance suite (filesystem/protect/conformance/protect/) holds the behaviour for both languages.
// what is here is what a line protocol cannot send: policies that are functions
import { assertEquals } from "@std/assert"
import { all, any, may, no, type Policy, yes } from "./protect.ts"

const ask = { who: {}, op: "read", target: {} }
const reader = () => undefined

Deno.test("protect: policies stop at the answer", () => {
	let asked = 0
	const count: Policy = () => (asked++, yes)
	assertEquals(may(all(() => no("n"), count), reader)(ask), no("n"))
	assertEquals(may(any(() => yes, count), reader)(ask), yes)
	assertEquals(asked, 0)
})
