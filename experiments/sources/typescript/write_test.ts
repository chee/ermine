import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert"
import { fresh, name, named, same, type Unnamed } from "./write.ts"

const one: Unnamed = {
	node: "N",
	part: "value",
	parents: [],
	patches: [{ path: [], value: { a: [1, 2] } }],
	change: { time: 1, actor: "A" },
}

Deno.test("a name is the content's: the same content, the same name; any change, another", () => {
	assertEquals(name(one).name, name({ ...one }).name)
	assertEquals(name(one).name.length, 64)
	assertNotEquals(name(one).name, name({ ...one, node: "M" }).name)
	assertNotEquals(name(one).name, name({ ...one, change: { time: 2, actor: "A" } }).name)
	// parents in any order, and undefined fields left out: one name
	const p = { ...one, parents: ["b", "a"] }
	assertEquals(name(p).name, name({ ...p, parents: ["a", "b"] }).name)
	assertEquals(name(one).name, name({ ...one, change: { ...one.change, reader: undefined } }).name)
})

Deno.test("a named write shares nothing with what was given; a changed one is not named", () => {
	const value = { a: [1, 2] }
	const w = name({ ...one, patches: [{ path: [], value }] })
	value.a.push(3)
	assertEquals(w.patches[0].value, { a: [1, 2] })
	assert(named(w))
	assert(!named({ ...w, node: "M" }))
	assert(!named({ ...w, name: "0".repeat(64) }))
})

Deno.test("what has no encoding is not named", () => {
	assertThrows(() => name({ ...one, patches: [{ path: [], value: () => 1 }] }))
	assert(!named({ ...name(one), patches: [{ path: [], value: Symbol("s") }] }))
})

Deno.test("fresh and same", () => {
	const v = { x: new Uint8Array([1, 2]) }
	assertEquals(fresh(v), v)
	assert(fresh(v) !== v)
	assert(same({ a: 1, b: 2 }, { b: 2, a: 1 }))
	assert(!same(1, 2))
	assert(same(undefined, undefined))
	assert(!same(undefined, null))
	assert(!same(() => 1, () => 1))
})
