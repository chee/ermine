import { walk } from "./walk.ts"
import { assertEquals, assertThrows } from "jsr:@std/assert"

const id = (zeros: number, n: number) => {
	const b = new Uint8Array(32)
	b[zeros] = 1 + (n % 200)
	b[31] = n
	return b
}
const h = (b: Uint8Array) => Array.from(b).join(",")
const hs = (a: Uint8Array[]) => a.map(h)
const store = (m: [Uint8Array, Uint8Array[]][]) => {
	const t = new Map(m.map(([k, v]) => [h(k), v]))
	return (x: Uint8Array) => t.get(h(x))
}

Deno.test("members, checkpoints, boundary", () => {
	const root = id(0, 1), a = id(1, 2), b = id(0, 3), big = id(3, 4), head = id(2, 5)
	const p = store([[head, [b, big]], [b, [a]], [a, [root]], [root, []], [big, []]])
	const r = walk(head, p, [])
	assertEquals(hs(r.members), hs([a, b, head, root].sort((x, y) => h(x) < h(y) ? -1 : 1)).sort())
	assertEquals(hs(r.boundary), [h(big)])
	assertEquals(hs(r.checkpoints), [h(a)])
})

Deno.test("same depth is boundary, known stripped", () => {
	const x = id(1, 1), y = id(0, 2), head = id(1, 3)
	const p = store([[head, [y]], [y, [x]], [x, []]])
	const r = walk(head, p, [])
	assertEquals(hs(r.boundary), [h(x)])
	const r2 = walk(head, p, [{ head: x, members: [y], checkpoints: [] }])
	assertEquals(hs(r2.members), [h(head)])
})

Deno.test("depth-0 head and missing throw", () => {
	const z = id(0, 1), head = id(1, 2)
	assertThrows(() => walk(z, store([[z, []]]), []))
	assertThrows(() => walk(head, store([[head, [z]]]), []))
})
