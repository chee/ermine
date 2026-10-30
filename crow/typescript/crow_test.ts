// crow: in place while crow, copied after a read; what a reader holds, a patch's value, and
// what an undo holds never change
import { assert, assertEquals, assertThrows } from "@std/assert"
import type { ApplyError } from "@ermine/changeable/apply"
import { createCrow } from "./crow.ts"
import { createRoot, type Root, write } from "./root_harness.ts"

type Doc = Record<string, unknown>
const doc = (e: Root) => e.value as Doc

Deno.test("crow: a burst of writes copies once, then changes its copies in place", () => {
	const u = createCrow()
	const start = { a: { x: 0 }, b: 1 }
	const e = createRoot(start)
	write(u, e, [{ path: ["a", "x"], value: 1 }])
	const root = e.value, a = doc(e).a
	assert(root !== start && a !== start.a)
	assertEquals(start, { a: { x: 0 }, b: 1 })
	write(u, e, [{ path: ["a", "x"], value: 2 }])
	write(u, e, [{ path: ["b"], value: 3 }])
	assert(e.value === root && doc(e).a === a)
	assertEquals(e.value, { a: { x: 2 }, b: 3 })
	assertEquals(e.undo, [{ path: ["b"], value: 1 }])
})

Deno.test("crow: a read lets go; what the reader holds never changes", () => {
	const u = createCrow()
	const e = createRoot({ a: { x: 0 }, b: [1, 2] })
	write(u, e, [{ path: ["a", "x"], value: 1 }])
	u.letGo(e)
	const held = e.value as Doc, a = held.a
	write(
		u,
		e,
		[{ path: ["a", "x"], value: 2 }, { path: ["b"], range: [0, 1], value: [] }],
	)
	assert(e.value !== held && doc(e).a !== a)
	assertEquals(held, { a: { x: 1 }, b: [1, 2] })
	assertEquals(e.value, { a: { x: 2 }, b: [2] })
	// owned again from here
	const root = e.value
	write(u, e, [{ path: ["a", "x"], value: 3 }])
	assert(e.value === root)
})

Deno.test("crow: a patch's value is never changed", () => {
	const u = createCrow()
	const e = createRoot({})
	const v = { x: 1, list: [1] }
	write(u, e, [{ path: ["c"], value: v }])
	write(u, e, [{ path: ["c", "x"], value: 2 }, {
		path: ["c", "list"],
		range: [1, 1],
		value: [2],
	}])
	assertEquals(v, { x: 1, list: [1] })
	assertEquals(e.value, { c: { x: 2, list: [1, 2] } })
})

Deno.test("crow: what a write takes out is held by its undo, and never changed after", () => {
	const u = createCrow()
	const e = createRoot({ a: { x: 0 }, list: [{ n: 0 }, { n: 1 }] })
	// a and the list's elements owned
	write(u, e, [{ path: ["a", "x"], value: 1 }, { path: ["list", 0, "n"], value: 5 }])
	write(u, e, [{ path: ["a"], value: { x: 9 } }, {
		path: ["list"],
		range: [0, 1],
		value: [],
	}])
	const undo = e.undo!
	const snapshot = structuredClone(undo)
	// the undo put back (its values go in as given), then written under
	write(u, e, undo)
	assertEquals(e.value, { a: { x: 1 }, list: [{ n: 5 }, { n: 1 }] })
	write(u, e, [{ path: ["a", "x"], value: 2 }, { path: ["list", 0, "n"], value: 6 }])
	assertEquals(undo, snapshot)
	assertEquals(e.value, { a: { x: 2 }, list: [{ n: 6 }, { n: 1 }] })
})

Deno.test("crow: a write that throws changes nothing", () => {
	const u = createCrow()
	const e = createRoot({ a: { x: 0 } })
	write(u, e, [{ path: ["a", "x"], value: 1 }])
	const root = e.value, undo = e.undo
	const error = assertThrows(() =>
		write(u, e, [{ path: ["a", "x"], value: 2 }, { path: ["nope", "deeper"], value: 1 }])
	) as ApplyError
	assertEquals([error.code, error.patch], ["no-key", 1])
	assert(e.value === root && e.undo === undo)
	assertEquals(e.value, { a: { x: 1 } })
})

Deno.test("crow: kept stops at what was handed: what is owned under it let go, the rest still owned", () => {
	const u = createCrow()
	const e = createRoot({ big: { a: { x: 0 }, b: { y: 0 } }, other: { z: 0 } })
	write(
		u,
		e,
		[{ path: ["big", "a", "x"], value: 1 }, { path: ["other", "z"], value: 1 }],
	)
	const root = e.value, big = doc(e).big as Doc, other = doc(e).other
	// a list the run made, holding what it was handed
	u.letGoIn([big], new Set([big]))
	write(
		u,
		e,
		[{ path: ["big", "a", "x"], value: 2 }, { path: ["other", "z"], value: 2 }],
	)
	assert(e.value === root && doc(e).other === other)
	assert(doc(e).big !== big && (doc(e).big as Doc).a !== big.a)
	assertEquals(big, { a: { x: 1 }, b: { y: 0 } })
	assertEquals(e.value, { big: { a: { x: 2 }, b: { y: 0 } }, other: { z: 2 } })
})

Deno.test("crow: kept walks a cycle of the run's own once", () => {
	const u = createCrow()
	const loop: Record<string, unknown> = { n: 1 }
	loop.self = loop
	loop.list = [loop, { deeper: loop }]
	u.letGoIn(loop)
	u.letGoIn(loop, new Set())
})
