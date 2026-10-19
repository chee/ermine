import { assertEquals, assertThrows } from "@std/assert"
import { build, depth, FragmentError, walk } from "./fragment.ts"

const id = (zeros: number, tag: number) => {
	const b = new Uint8Array(32).fill(tag)
	b.fill(0, 0, zeros)
	return b
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const dag = (...commits: [Uint8Array, Uint8Array[]][]) => {
	const m = new Map(commits.map(([i, p]) => [hex(i), p]))
	return (i: Uint8Array) => m.get(hex(i))
}
const none = () => undefined

Deno.test("fragment: depth counts leading zero bytes", () => {
	assertEquals(depth(id(0, 5)), 0)
	assertEquals(depth(id(2, 5)), 2)
})

Deno.test("fragment: a head of depth 0 is refused, a missing commit is missing", () => {
	const a = id(0, 1), b = id(1, 2)
	assertEquals(assertThrows(() => walk(a, dag([a, []]), none), FragmentError).code, "depth-zero")
	assertEquals(assertThrows(() => walk(b, dag([b, [a]]), none), FragmentError).code, "missing")
})

Deno.test("fragment: a line walks to a root", () => {
	const a = id(0, 1), b = id(0, 2), h = id(1, 3)
	const f = walk(h, dag([a, []], [b, [a]], [h, [b]]), none)
	assertEquals(f.members.map(hex).sort(), [a, b, h].map(hex).sort())
	assertEquals(f.boundary, [])
})

Deno.test("fragment: build skips a head with a commit missing", () => {
	const a = id(0, 1), h = id(1, 3)
	assertEquals(build([h], dag([h, [a]]), none), [])
})
