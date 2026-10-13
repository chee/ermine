import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import createNode, { type ChangeHeader, type Node } from "@ermine/node"
import apply from "@ermine/op/apply"
import { createTable, type Key } from "@ermine/graph/table"
import {
	createPlaces,
	type Item,
	path,
	PlacesError,
	type Read,
	ROOT,
	type Setup,
} from "./places.ts"

const h: ChangeHeader = { time: 1, actor: "me" }

// a world: a table per source, each holding children nodes; the hole filled the B way
function world(extra: Partial<Setup> = {}) {
	const tables = new Map<Key, ReturnType<typeof createTable<unknown>>>()
	const table = (source: Key) =>
		tables.get(source) ?? tables.set(source, createTable<unknown>()).get(source)!
	const reads: Read[] = []
	const kids = (source: Key, id: Key, value: Record<string, unknown>) => {
		const n = createNode<unknown>(value, h)
		table(source).sub("children", id, n)
		return n
	}
	const children = (source: Key, id: Key) =>
		table(source).get("children", id) as Node<unknown> | undefined
	const p = createPlaces({ root: ["stored", "R"], children, read: (r) => reads.push(r), ...extra })
	return { p, kids, children, reads, table }
}

const code = (f: () => unknown) => (assertThrows(f, PlacesError) as PlacesError).code
const show = (items: readonly Item[]) => items.map((i) => [i.source, i.id])

Deno.test("places: names walked through children, front first", () => {
	const { p, kids } = world()
	kids("stored", "R", { notes: [["stored", "N"]] })
	kids("stored", "N", { today: [["stored", "T"]] })
	const [t] = p.get(["notes", "today"])
	assertEquals([t.source, t.id, t.name, t.at], ["stored", "T", "today", 0])
	assertEquals(path(t), ["notes", "today"])
	assertEquals(t.up!.id, "N")
	assertEquals(show(p.get([])), [["stored", "R"]])
	assertEquals(p.get(["nope"]), [])
})

Deno.test("places: a root given as an id has the source ROOT", () => {
	const seen: [Key, Key][] = []
	const top = Symbol.for("ermine.places.root")
	assertStrictEquals(ROOT, top)
	const kids = createNode<unknown>({ a: [["stored", "A"]] }, h)
	const p = createPlaces({
		root: "R",
		children: (
			source,
			id,
		) => (seen.push([source, id]), source === top && id === "R" ? kids : undefined),
	})
	assertEquals(show(p.get([])), [[top, "R"]])
	assertEquals(show(p.get(["a"])), [["stored", "A"]])
	assertEquals(seen[0], [top, "R"])
})

Deno.test("places: several at one name, in order, each walked through its own children", () => {
	const { p, kids } = world()
	kids("stored", "R", { today: [["drag", "X"], ["stored", "X"]] })
	kids("drag", "X", { x: [["drag", "D"]] })
	kids("stored", "X", { x: [["stored", "S"]], y: [["stored", "Y"]] })
	assertEquals(show(p.get(["today"])), [["drag", "X"], ["stored", "X"]])
	assertEquals(show(p.get(["today", "x"])), [["drag", "D"], ["stored", "S"]])
	assertEquals(show(p.get(["today", "y"])), [["stored", "Y"]])
})

Deno.test("places: every read told, the ones that found nothing too", () => {
	const { p, kids, reads } = world()
	kids("stored", "R", { a: [["stored", "A"]] })
	p.get(["a", "b", "c"])
	// A has no children node: the read says where something could go
	assertEquals(reads, [
		{ source: "stored", id: "R", path: ["a"] },
		{ source: "stored", id: "A", path: ["b"] },
	])
	assertEquals(p.get(["a", "b"]), [])
})

Deno.test("places: reads are fine: /a/b rests on [a] in R and [b] in A, never on c", () => {
	const { p, kids, reads } = world()
	kids("stored", "R", { a: [["stored", "A"]] })
	kids("stored", "A", { b: [["stored", "B"]], c: [["stored", "C"]] })
	p.get(["a", "b"])
	assertEquals(reads.map((r) => [r.id, r.path]), [["R", ["a"]], ["A", ["b"]]])
})

Deno.test("places: ., .., / and from an item or an entry", () => {
	const { p, kids } = world()
	kids("stored", "R", { a: [["stored", "A"]], z: [["stored", "Z"]] })
	kids("stored", "A", { b: [["stored", "B"]] })
	assertEquals(show(p.get(["a", ".", "b"])), [["stored", "B"]])
	assertEquals(show(p.get(["a", "..", "z"])), [["stored", "Z"]])
	const [b] = p.get(["a", "b"])
	assertEquals(show(p.get(["..", "..", "z"], b)), [["stored", "Z"]])
	assertEquals(show(p.get(["/", "z"], b)), [["stored", "Z"]])
	assertEquals(p.get([".."]), [])
	assertEquals(show(p.get(["b"], ["stored", "A"])), [["stored", "B"]])
	// from an entry: nothing above it
	assertEquals(p.get(["..", "z"], ["stored", "A"]), [])
})

Deno.test("places: lookup, the nearest enclosing place first; all, each", () => {
	const { p, kids } = world()
	kids("stored", "R", { a: [["stored", "A"]], fonts: [["stored", "F0"]] })
	kids("stored", "A", { b: [["stored", "B"]], fonts: [["stored", "F1"]] })
	kids("stored", "B", {})
	const [b] = p.get(["a", "b"])
	assertEquals(show(p.lookup(["fonts"], b)), [["stored", "F1"]])
	assertEquals(show(p.lookup(["fonts"], b, true)), [["stored", "F1"], ["stored", "F0"]])
	assertEquals(p.lookup(["none"], b), [])
})

Deno.test("places: names in an item's children, as one read of its whole value", () => {
	const { p, kids, reads } = world()
	kids("stored", "R", { b: [["stored", "B"]], a: [["stored", "A"]], bad: 5 })
	assertEquals(p.names(["stored", "R"]), ["b", "a"])
	assertEquals(reads.at(-1), { source: "stored", id: "R", path: [] })
	assertEquals(p.names(["stored", "nobody"]), [])
})

Deno.test("places: one id under two names: its children show in both", () => {
	const { p, kids } = world()
	kids("stored", "R", { a: [["stored", "M"]], b: [["stored", "M"]] })
	kids("stored", "M", { x: [["stored", "X"]] })
	assertEquals(show(p.get(["a", "x"])), [["stored", "X"]])
	assertEquals(show(p.get(["b", "x"])), [["stored", "X"]])
})

Deno.test("places: symbols as source and ids", () => {
	const { p, kids } = world()
	const drag = Symbol("drag"), here = Symbol("here")
	kids("stored", "R", { t: [[drag, here], ["stored", "T"]] })
	assertEquals(show(p.get(["t"])), [[drag, here], ["stored", "T"]])
	p.order([["stored", "R"], "t"], 0, 1, h)
	assertEquals(show(p.get(["t"])), [["stored", "T"], [drag, here]])
})

Deno.test("places: anything else in an array keeps its position and is no item", () => {
	const { p, kids } = world()
	kids("stored", "R", { t: [5, ["stored", "A"], ["x"], ["stored", "B"]] })
	assertEquals(p.get(["t"]).map((i) => [i.id, i.at]), [["A", 1], ["B", 3]])
	p.unplace([["stored", "R"], "t"], 3, h)
	assertEquals(p.get(["t"]).map((i) => i.id), ["A"])
})

Deno.test("places: place, at the end, at an index, a new name, a node with no value", () => {
	const { p, kids, children } = world()
	kids("stored", "R", { t: [["stored", "A"]] })
	const R = ["stored", "R"] as const
	p.place([R, "t"], ["stored", "B"], h)
	p.place([R, "t"], ["drag", "A"], h, 0)
	assertEquals(show(p.get(["t"])), [["drag", "A"], ["stored", "A"], ["stored", "B"]])
	p.place([R, "new"], ["stored", "N"], h)
	assertEquals(show(p.get(["new"])), [["stored", "N"]])
	// the change keeps the edit and its undo
	const n = children("stored", "R")!
	assertEquals(n.change.op!.patches, [{ path: ["new"], value: [["stored", "N"]] }])
	assertEquals(Object.keys(apply(n.value, n.change.op!.undo) as object), ["t"])
	// a children node with no value yet
	const empty = createNode<unknown>(undefined, h)
	world().table("stored")
	const w = world()
	w.table("stored").add("children", "R", empty)
	w.p.place([R, "a"], ["stored", "A"], h)
	assertEquals(show(w.p.get(["a"])), [["stored", "A"]])
})

Deno.test("places: place refuses a non-name, a parent with no children node, an index past the end", () => {
	const { p, kids } = world()
	kids("stored", "R", { t: [["stored", "A"]] })
	const R = ["stored", "R"] as const
	for (const name of [".", "..", "/"]) {
		assertEquals(code(() => p.place([R, name], R, h)), "not-a-name")
	}
	assertEquals(code(() => p.place([["stored", "nobody"], "t"], R, h)), "nothing-there")
	assertEquals(code(() => p.place([R, "t"], R, h, 2)), "range")
	assertEquals(code(() => p.place([R, "t"], R, h, -1)), "range")
})

Deno.test("places: unplace; the last one takes the name too", () => {
	const { p, kids, children } = world()
	kids("stored", "R", { t: [["a", "X"], ["b", "X"], ["c", "X"]] })
	const R = ["stored", "R"] as const
	p.unplace([R, "t"], 1, h)
	assertEquals(show(p.get(["t"])), [["a", "X"], ["c", "X"]])
	p.unplace([R, "t"], 0, h)
	p.unplace([R, "t"], 0, h)
	assertEquals(children("stored", "R")!.value, {})
	assertEquals(code(() => p.unplace([R, "t"], 0, h)), "nothing-there")
	kids("stored", "R", { t: [["a", "X"]] })
	assertEquals(code(() => p.unplace([R, "t"], 1, h)), "range")
})

Deno.test("places: order: to the front chooses the winner; counted with it taken out", () => {
	const { p, kids, children } = world()
	kids("stored", "R", { t: [["a", "X"], ["b", "X"], ["c", "X"]] })
	const R = ["stored", "R"] as const
	p.order([R, "t"], 2, 0, h)
	assertEquals(show(p.get(["t"])), [["c", "X"], ["a", "X"], ["b", "X"]])
	p.order([R, "t"], 0, 2, h)
	assertEquals(show(p.get(["t"])), [["a", "X"], ["b", "X"], ["c", "X"]])
	const before = children("stored", "R")!.change
	p.order([R, "t"], 1, 1, h)
	assertStrictEquals(children("stored", "R")!.change, before)
	assertEquals(code(() => p.order([R, "t"], 3, 0, h)), "range")
	assertEquals(code(() => p.order([R, "t"], 0, 3, h)), "range")
})

Deno.test("places: rename moves everything under a name, one change", () => {
	const { p, kids, children } = world()
	kids("stored", "R", { t: [["a", "X"], ["b", "Y"]], u: [["a", "U"]] })
	const R = ["stored", "R"] as const
	p.rename([R, "t"], "v", h)
	assertEquals(show(p.get(["v"])), [["a", "X"], ["b", "Y"]])
	assertEquals(p.get(["t"]), [])
	assertEquals(children("stored", "R")!.change.op!.patches.length, 1)
	assertEquals(code(() => p.rename([R, "v"], "u", h)), "already-there")
	assertEquals(code(() => p.rename([R, "gone"], "w", h)), "nothing-there")
	assertEquals(code(() => p.rename([R, "v"], "..", h)), "not-a-name")
	const before = children("stored", "R")!.change
	p.rename([R, "v"], "v", h)
	assertStrictEquals(children("stored", "R")!.change, before)
})

Deno.test("places: move, within a name, to another name, to another parent", () => {
	const { p, kids, children } = world()
	kids("stored", "R", { t: [["a", "X"], ["b", "Y"]], u: [["c", "Z"]], d: [["stored", "D"]] })
	kids("stored", "D", {})
	const R = ["stored", "R"] as const, D = ["stored", "D"] as const
	p.move([R, "t"], 1, [R, "t"], h, 0)
	assertEquals(show(p.get(["t"])), [["b", "Y"], ["a", "X"]])
	// another name, one parent: one change
	p.move([R, "t"], 0, [R, "u"], h, 0)
	assertEquals(show(p.get(["u"])), [["b", "Y"], ["c", "Z"]])
	assertEquals(show(p.get(["t"])), [["a", "X"]])
	// to a new name, the last one: the old name goes
	p.move([R, "t"], 0, [R, "w"], h)
	assertEquals(show(p.get(["w"])), [["a", "X"]])
	assertEquals(p.get(["t"]), [])
	// another parent: two changes, the one it goes into first
	p.move([R, "w"], 0, [D, "here"], h)
	assertEquals(show(p.get(["d", "here"])), [["a", "X"]])
	assertEquals(p.get(["w"]), [])
	assertEquals(children("stored", "D")!.change.op!.patches, [{
		path: ["here"],
		value: [["a", "X"]],
	}])
	assertEquals(code(() => p.move([R, "u"], 5, [R, "t"], h)), "range")
	assertEquals(code(() => p.move([R, "u"], 0, [R, "/"], h)), "not-a-name")
})

Deno.test("places: a write gives back the nodes it changed, in order; none when nothing changed", () => {
	const { p, kids } = world()
	const r = kids("stored", "R", { t: [["a", "X"], ["c", "X"]] })
	const d = kids("drag", "D", {})
	const ids = (cs: { source: Key; id: Key }[]) => cs.map((c) => [c.source, c.id])
	const placed = p.place([["stored", "R"], "t"], ["b", "X"], h)
	assertEquals(ids(placed), [["stored", "R"]])
	assertStrictEquals(placed[0].node, r)
	assertEquals(r.change.op?.patches, [{ path: ["t"], range: [2, 2], value: [["b", "X"]] }])
	// across parents: the one it went into first
	const moved = p.move([["stored", "R"], "t"], 0, [["drag", "D"], "u"], h)
	assertEquals(ids(moved), [["drag", "D"], ["stored", "R"]])
	assertStrictEquals(moved[0].node, d)
	assertStrictEquals(moved[1].node, r)
	assertEquals(p.order([["stored", "R"], "t"], 0, 0, h), [])
	assertEquals(p.rename([["stored", "R"], "t"], "t", h), [])
})

Deno.test("places: open: the same list while nothing changed; walked again from what changed", () => {
	const { p, kids, reads } = world()
	kids("stored", "R", { a: [["stored", "A"]] })
	kids("stored", "A", { b: [["stored", "B"]] })
	const held = p.open(["a", "b"])
	const first = held.items()
	assertEquals(show(first), [["stored", "B"]])
	assertStrictEquals(held.items(), first)
	// each call tells every read the held place rests on
	reads.length = 0
	held.items()
	assertEquals(reads.map((r) => [r.id, r.path]), [["R", ["a"]], ["A", ["b"]]])
	// a rename above: the place now resolves to whatever is there
	p.rename([["stored", "A"], "b"], "c", h)
	assertEquals(held.items(), [])
	p.place([["stored", "A"], "b"], ["drag", "B2"], h)
	assertEquals(show(held.items()), [["drag", "B2"]])
	held.drop()
	assertEquals(held.items(), [])
})

Deno.test("places: places opened with the same beginning never keep a stale step", () => {
	const { p, kids } = world()
	kids("stored", "R", { a: [["stored", "A"]] })
	kids("stored", "A", { b: [["stored", "B"]] })
	kids("stored", "B", { c: [["stored", "C"]] })
	kids("stored", "A2", { b: [["stored", "B2"]] })
	kids("stored", "B2", { c: [["stored", "C2"]] })
	const short = p.open(["a", "b"]), long = p.open(["a", "b", "c"])
	assertEquals(show(long.items()), [["stored", "C"]])
	kids("stored", "R", { a: [["stored", "A2"]] })
	// the short hold walks again first; the long one must still see its last step is stale
	assertEquals(show(short.items()), [["stored", "B2"]])
	assertEquals(show(long.items()), [["stored", "C2"]])
	short.drop()
	assertEquals(show(long.items()), [["stored", "C2"]])
	long.drop()
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 60
const NAMES = ["a", "b", "c"]
const IDS = ["R", "A", "B", "C", "D"]
const SOURCES = ["stored", "drag"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

Deno.test(`places: fuzz, ${SEEDS} seeds × ${STEPS} writes: opened places agree with get`, () => {
	const key = (items: readonly Item[]) =>
		JSON.stringify(items.map((i) => [String(i.source), String(i.id), path(i), i.at]))
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const { p, kids } = world({ read: undefined })
		for (const source of SOURCES) for (const id of IDS) kids(source, id, {})
		const addresses = Array.from(
			{ length: 6 },
			() => Array.from({ length: 1 + pick(3) }, () => NAMES[pick(NAMES.length)]),
		)
		const holds = addresses.map((a) => p.open(a))
		const parent = () => [SOURCES[pick(SOURCES.length)], IDS[pick(IDS.length)]] as const
		for (let step = 0; step < STEPS; step++) {
			const at = `seed ${seed}, step ${step}`
			const k = pick(5)
			try {
				if (k === 0 || k === 1) {
					p.place(
						[parent(), NAMES[pick(3)]],
						[SOURCES[pick(2)], IDS[1 + pick(4)]],
						h,
						pick(2) ? undefined : 0,
					)
				} else if (k === 2) p.unplace([parent(), NAMES[pick(3)]], pick(2), h)
				else if (k === 3) p.order([parent(), NAMES[pick(3)]], pick(2), pick(2), h)
				else if (pick(2)) p.rename([parent(), NAMES[pick(3)]], NAMES[pick(3)], h)
				else p.move([parent(), NAMES[pick(3)]], pick(2), [parent(), NAMES[pick(3)]], h)
			} catch (e) {
				assert(e instanceof PlacesError, `${at}: ${e}`)
			}
			for (let i = 0; i < holds.length; i++) {
				assertEquals(key(holds[i].items()), key(p.get(addresses[i])), `${at}, hold ${i}`)
			}
		}
		for (const held of holds) held.drop()
	}
})
