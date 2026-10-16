// rank on its own: components and their ranks, and a chain deeper than the call stack
import { assertEquals } from "@std/assert"
import rank from "./rank.ts"

const of = (edges: Record<string, string[]>) =>
	Object.fromEntries(rank(Object.keys(edges), (t) => edges[t]))

Deno.test("rank: a chain, a cycle sharing a rank, what is after it one past", () => {
	assertEquals(of({ a: [], b: ["a"], c: ["b"] }), { a: 0, b: 1, c: 2 })
	assertEquals(of({ a: ["b"], b: ["a"], c: ["b"], d: ["c"] }), { a: 0, b: 0, c: 1, d: 2 })
	assertEquals(of({ x: [], a: ["b", "x"], b: ["a"] }), { x: 0, a: 1, b: 1 })
})

Deno.test("rank: the floor raises a component", () => {
	const edges: Record<string, string[]> = { a: [], b: ["a"] }
	const out = rank(["a", "b"], (t) => edges[t], (t) => t === "a" ? 5 : 0)
	assertEquals([out.get("a"), out.get("b")], [5, 6])
})

Deno.test("rank: a chain of 200k after a cycle, deeper than the call stack", () => {
	const n = 200_000
	const edges = (i: number) => i === 0 ? [1] : i === 1 ? [0] : [i - 1]
	const all = Array.from({ length: n }, (_, i) => n - 1 - i)
	const out = rank(all, edges)
	assertEquals([out.get(0), out.get(1), out.get(2), out.get(n - 1)], [0, 0, 1, n - 2])
})
