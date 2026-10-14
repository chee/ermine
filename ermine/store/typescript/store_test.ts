import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import createNode from "@ermine/node"
import { createStore, type Key, type Part, TableError } from "./store.ts"

const h = { time: 1, actor: "me" }

function setup() {
	const events: [Key, Part, Key][] = []
	const s = createStore((source, part, id) => void events.push([source, part, id]))
	return { s, events }
}

Deno.test("store: a table per source; get of a source never written is nothing", () => {
	const { s } = setup()
	const a = createNode("a", h), b = createNode("b", h)
	s.add("stored", "value", "x", a)
	s.add("drag", "value", "x", b)
	assertStrictEquals(s.get("stored", "value", "x"), a)
	assertStrictEquals(s.get("drag", "value", "x"), b)
	assertEquals(s.get("pending", "value", "x"), undefined)
	assertEquals(s.get("stored", "children", "x"), undefined)
})

Deno.test("store: add refuses a taken key; the same node again is nothing, no event", () => {
	const { s, events } = setup()
	const a = createNode("a", h), b = createNode("b", h)
	s.add("stored", "value", "x", a)
	s.add("stored", "value", "x", a)
	const e = assertThrows(() => s.add("stored", "value", "x", b), TableError) as TableError
	assertEquals(e.code, "already-there")
	assertEquals(events, [["stored", "value", "x"]])
})

Deno.test("store: sub replaces, del takes out, each one event; del of nothing throws", () => {
	const { s, events } = setup()
	const a = createNode({ name: "a" }, h), b = createNode({ name: "b" }, h)
	s.sub("stored", "attributes", "x", a)
	s.sub("stored", "attributes", "x", b)
	s.sub("stored", "attributes", "x", b)
	assertStrictEquals(s.get("stored", "attributes", "x"), b)
	s.del("stored", "attributes", "x")
	assertEquals(s.get("stored", "attributes", "x"), undefined)
	assertEquals(events.length, 3)
	const code = (f: () => void) => (assertThrows(f, TableError) as TableError).code
	assertEquals(code(() => s.del("stored", "attributes", "x")), "nothing-there")
	assertEquals(code(() => s.del("never", "value", "x")), "nothing-there")
	assertEquals(events.length, 3)
})

Deno.test("store: who gives every key of a node in its source; children is places' hole", () => {
	const { s } = setup()
	const k = createNode({ a: [] }, h)
	s.add("stored", "children", "x", k)
	s.add("stored", "children", "y", k)
	s.add("drag", "children", "z", k)
	assertEquals(s.who("stored", k), [["children", "x"], ["children", "y"]])
	assertEquals(s.who("drag", k), [["children", "z"]])
	assertEquals(s.who("pending", k), [])
	assertStrictEquals(s.children("stored", "y"), k)
	assertEquals(s.children("stored", "w"), undefined)
})

Deno.test("store: drop takes a source's whole table, an event at each key it held", () => {
	const { s, events } = setup()
	s.add("drag", "value", "x", createNode(1, h))
	s.add("drag", "children", "x", createNode({}, h))
	s.add("drag", "value", "y", createNode(2, h))
	s.add("drag", "value", "z", createNode(3, h))
	s.del("drag", "value", "z")
	s.add("stored", "value", "x", createNode(4, h))
	events.length = 0
	s.drop("drag")
	assertEquals(events, [["drag", "value", "x"], ["drag", "children", "x"], ["drag", "value", "y"]])
	assertEquals(s.get("drag", "value", "x"), undefined)
	assertEquals(s.get("stored", "value", "x")?.value, 4)
	events.length = 0
	s.drop("drag")
	s.drop("never")
	assertEquals(events, [])
	// written again: a new table
	s.add("drag", "value", "x", createNode(5, h))
	assertEquals(s.get("drag", "value", "x")?.value, 5)
})

Deno.test("store: an event is told after the change is in", () => {
	const seen: unknown[] = []
	const s = createStore((source, part, id) => void seen.push(s.get(source, part, id)?.value))
	s.add("stored", "value", "x", createNode(1, h))
	s.sub("stored", "value", "x", createNode(2, h))
	s.del("stored", "value", "x")
	s.add("drag", "value", "x", createNode(3, h))
	s.drop("drag")
	assertEquals(seen, [1, 2, undefined, 3, undefined])
})

// a part of the tests' own, as a package adds one: its name and the shape of its value. a name
// no package uses: two shapes for one name do not merge
declare module "./store.ts" {
	interface Parts {
		tally: { n: number }
	}
}

Deno.test("store: a part added by declaration merging is a part like the others", () => {
	const { s, events } = setup()
	const r = createNode({ n: 1 }, h), v = createNode("v", h)
	s.add("stored", "tally", "x", r)
	s.add("stored", "value", "x", v)
	const n: number | undefined = s.get("stored", "tally", "x")?.value?.n
	assertEquals(n, 1)
	assertEquals(s.who("stored", r), [["tally", "x"]])
	assertEquals(s.children("stored", "x"), undefined)
	s.del("stored", "tally", "x")
	assertEquals(s.get("stored", "tally", "x"), undefined)
	assertStrictEquals(s.get("stored", "value", "x"), v)
	assertEquals(events, [["stored", "tally", "x"], ["stored", "value", "x"], [
		"stored",
		"tally",
		"x",
	]])
})
