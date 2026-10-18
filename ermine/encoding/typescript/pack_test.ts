import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import createEntry, { type ChangeHeader, type Entry as NodeEntry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createTable, type Key } from "@ermine/table"
import * as cbor from "./cbor.ts"
import { deflate, inflate } from "./deflate.ts"
import { decode, encode, type Entry, pack, PackError, unpack } from "./pack.ts"

const code = (f: () => unknown) => (assertThrows(f, PackError) as PackError).code
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const h = (time = 1, actor: unknown = "a"): ChangeHeader => ({ time, actor })
const n = (value: unknown, change = h()) => createEntry(value, change)
// a pack's columns, read; and columns written as a pack
const inner = (b: Uint8Array) =>
	cbor.decode(inflate((cbor.decode(b) as { columns: Uint8Array }).columns)) as Record<
		string,
		cbor.Value
	>
const wrap = (columns: cbor.Value) => cbor.encode({ columns: deflate(cbor.encode(columns)) })

Deno.test("pack: one node under one key, written as the module says", () => {
	const b = pack([["value", "a", n("hi", { time: 1, actor: "x" })]])
	assertEquals(Object.keys(cbor.decode(b) as object), ["columns"])
	assertEquals(inner(b), {
		ids: ["a"],
		parts: [["value", 1]],
		which: Uint8Array.of(0), // the key's id: ids[0]
		nodes: Uint8Array.of(0), // a new node
		has: Uint8Array.of(1 | 32), // an actor, a value
		time: Uint8Array.of(2), // 1, the difference from 0, zigzag
		actor: [["x", 1]],
		values: ["hi"],
	})
	// an ermine:// id as its 32 bytes
	const id = "ermine://" + "0f".repeat(32)
	assertEquals(inner(pack([["value", id, n(1)]])).ids, [new Uint8Array(32).fill(15)])
	assertEquals(unpack(pack([["value", id, n(1)]]))[0][1], id)
	// not quite one (upper case hex): its text
	const upper = "ermine://" + "0F".repeat(32)
	assertEquals(inner(pack([["value", upper, n(1)]])).ids, [upper])
})

Deno.test("pack: the same table is the same bytes, whatever order it is given in", () => {
	const a = n(1), b = n(2), c = n(3)
	const es: Entry[] = [["value", "b", b], ["children", "a", c], ["value", "a", a]]
	assertEquals(hex(pack(es)), hex(pack([...es].reverse())))
	// sorted by their encodings: a shorter part first
	assertEquals(unpack(pack(es)).map(([p, i]) => [p, i]), [
		["value", "a"],
		["value", "b"],
		["children", "a"],
	])
})

Deno.test("pack: a node under several keys is one node again", () => {
	const shared = n({ k: 1 }), other = n({ k: 1 })
	const back = unpack(
		pack([["value", "a", shared], ["value", "b", shared], ["value", "c", other]]),
	)
	assertStrictEquals(back[0][2], back[1][2])
	// equal, but two nodes: two again
	assertEquals(back[0][2] === back[2][2], false)
	assertEquals(back[0][2].value, back[2][2].value)
	const raw = inner(pack([["value", "a", shared], ["value", "b", shared]]))
	// key a: a new node; key b: node 0 again
	assertEquals(raw.nodes, Uint8Array.of(0, 1))
	assertEquals(raw.values, [{ k: 1 }])
})

Deno.test("pack: a table's nodes in, a table's nodes out", () => {
	const t = createTable()
	const root = n({ home: [["host", "a"]] }), a = n("hello")
	t.add("children", "root", root as NodeEntry<Record<string, unknown>>)
	t.add("value", "a", a)
	const es: Entry[] = ["root", "a"].flatMap((id) =>
		t.get(id).map(([part, node]) => [part, id, node] as const)
	)
	const u = createTable()
	for (const [part, id, node] of unpack(pack(es))) u.add(part as Key, id, node)
	assertEquals(u.get("children", "root")!.value, root.value)
	assertEquals(u.get("value", "a")!.value, "hello")
})

Deno.test("pack: a change and its op come back as written", () => {
	const node = n({ list: [1, 2, 3], s: "abc" }, {
		time: 1760000000,
		actor: { name: "chee" },
		reader: "r",
		external: [{ file: "a.ts", line: 1, column: 0 }, { file: "b.ts", line: 2, function: "f" }],
		metadata: { sync: { lamport: 1 }, why: "x" },
	})
	update(node, [{ path: ["list"], range: [1, 2] }, { path: ["s"], range: [0, 1], value: "A" }], {
		time: 1760000001,
		actor: "b",
	})
	const back = decode(encode(node))
	assertEquals(back.value, node.value)
	assertEquals(back.change, node.change)
	assertEquals(hex(encode(back)), hex(encode(node)))
})

Deno.test("pack: cow: false is kept", () => {
	const inPlace = createEntry([1], h(), { cow: false })
	const back = decode(encode(inPlace))
	assertEquals(back.cow, false)
	assertEquals("cow" in decode(encode(n([1]))), false)
	assertEquals(cbor.decode(encode(inPlace)), {
		change: { time: 1, actor: "a" },
		value: [1],
		cow: false,
	})
	const wrong = { change: { time: 1 }, cow: true }
	assertEquals(code(() => decode(cbor.encode(wrong))), "not-a-node")
})

Deno.test("pack: op written unless asked not to", () => {
	const node = n({ s: "abc" })
	update(node, [{ path: ["s"], range: [0, 1], value: "A" }], h(2))
	assertEquals(decode(encode(node)).change.op, node.change.op)
	const without = decode(encode(node, { op: false })).change
	assertEquals("op" in without, false)
	assertEquals(without.time, 2)
	const [[, , back]] = unpack(pack([["value", "a", node]], { op: false }))
	assertEquals("op" in back.change, false)
})

Deno.test("pack: loosyGoosy reading passes over keys it does not know, in every map", () => {
	const node = {
		change: {
			time: 1,
			later: true,
			external: [{ file: "a", line: 1, extra: 1 }],
			op: {
				patches: [{ path: ["a"], value: 1, extra: 1, move: { path: ["b"], extra: 1 } }],
				undo: [],
				extra: 1,
			},
		},
		value: 1,
		extra: { anything: [1] },
	}
	const b = cbor.encode({ keys: [["value", "a", 0]], nodes: [node], version: 2 })
	assertEquals(code(() => unpack(b)), "not-a-pack")
	const [[, , back]] = unpack(b, { loosyGoosy: true })
	assertEquals(back.value, 1)
	assertEquals(back.change, {
		time: 1,
		external: [{ file: "a", line: 1 }],
		op: { patches: [{ path: ["a"], value: 1, move: { path: ["b"] } }], undo: [] },
	} as unknown as ChangeHeader)
	assertEquals(decode(cbor.encode(node), { loosyGoosy: true }).value, 1)
	assertEquals(code(() => decode(cbor.encode(node))), "not-a-node")
	// loose about keys only: a key it needs, of the kind it needs, still
	assertEquals(
		code(() => decode(cbor.encode({ change: { time: 1.5 } }), { loosyGoosy: true })),
		"not-a-node",
	)
})

Deno.test("pack: no value, nothing written for it", () => {
	const back = decode(encode(createEntry(undefined, h())))
	assertEquals("value" in back, false)
})

Deno.test("pack: values of every kind", () => {
	const value = {
		bytes: new Uint8Array([1, 2]),
		typed: new Float32Array([1.5, NaN]),
		big: new BigInt64Array([-1n]),
		live: new cbor.Stand("canvas"),
		n: [-0, 1e300, null, true],
	}
	const back = decode(encode(n(value)))
	assertEquals(hex(cbor.encode(back.value as cbor.Value)), hex(cbor.encode(value)))
})

Deno.test("pack: a symbol anywhere cannot be carried; getting rid of them is the caller's", () => {
	const s = Symbol("s"), r = Symbol.for("ermine.places.root")
	const at = (es: Entry[]) => {
		const e = assertThrows(() => pack(es), PackError)
		return [e.code, e.part, e.id]
	}
	// a key: that key, the first given
	assertEquals(at([["value", "a", n(1)], [s, "b", n(2)], ["value", r, n(3)]]), [
		"cannot-carry",
		s,
		"b",
	])
	assertEquals(at([["value", r, n(1)]]), ["cannot-carry", "value", r])
	// in a node: its first key
	assertEquals(at([["children", "z", n({ a: [[r, "x"]] })]]), ["cannot-carry", "children", "z"])
	assertEquals(at([["value", "a", n([1, s])]]), ["cannot-carry", "value", "a"])
	for (
		const change of [
			{ time: 1, actor: s },
			{ time: 1, actor: "a", reader: s as unknown as string },
			{ time: 1, actor: "a", metadata: { a: s } },
			{ time: 1, actor: "a", op: { patches: [{ path: ["a"], value: s }], undo: [] } },
		]
	) assertEquals(code(() => encode(n(1, change))), "cannot-carry")
})

Deno.test("pack: the same key twice: once with one node, already-there with two", () => {
	const a = n(1)
	assertEquals(unpack(pack([["value", "a", a], ["value", "a", a]])).length, 1)
	const e = assertThrows(() => pack([["value", "a", a], ["value", "a", n(1)]]), PackError)
	assertEquals([e.code, e.part, e.id], ["already-there", "value", "a"])
})

Deno.test("pack: cannot-carry, at the first key of the node", () => {
	const bad = n(() => 1)
	const e = assertThrows(() => pack([["value", "b", bad], ["value", "a", bad]]), PackError)
	assertEquals([e.code, e.part, e.id], ["cannot-carry", "value", "a"])
	assertEquals(code(() => pack([["value", "\ud800", n(1)]])), "cannot-carry")
	assertEquals(code(() => encode(n("\udc00"))), "cannot-carry")
	assertEquals(code(() => encode(n(new Map()))), "cannot-carry")
	const time = "1" as unknown as number, reader = 2 as unknown as string
	assertEquals(code(() => encode(n(1, { time, actor: "a" }))), "cannot-carry")
	assertEquals(code(() => encode(n(1, { time: 1, actor: "a", reader }))), "cannot-carry")
})

Deno.test("pack: times, lines, columns, path numbers and range ends are whole; lines, columns and path numbers fit a C long", () => {
	const at = (change: ChangeHeader) => code(() => encode(n(1, change)))
	for (const time of [1.5, NaN, 2 ** 53]) {
		assertEquals(at({ time, actor: "a" }), "cannot-carry")
	}
	assertEquals(at({ time: 1, actor: "a", external: [{ file: "a", line: 1.5 }] }), "cannot-carry")
	// -0 is 0: whole, written 00
	const zero = n(1, { time: -0, actor: "a", external: [{ file: "a", line: 1, column: -0 }] })
	assertEquals(
		encode(zero),
		encode(n(1, { time: 0, actor: "a", external: [{ file: "a", line: 1, column: 0 }] })),
	)
	const op = (p: object) => ({ time: 1, actor: "a", op: { patches: [p as never], undo: [] } })
	assertEquals(at(op({ path: [0.5] })), "cannot-carry")
	assertEquals(at(op({ path: ["a"], range: [0, 1.5] })), "cannot-carry")
	// a line, a column and a path's number: what any C long holds, no more
	assertEquals(
		at({ time: 1, actor: "a", external: [{ file: "a", line: 2 ** 31 }] }),
		"cannot-carry",
	)
	assertEquals(at(op({ path: [2 ** 31] })), "cannot-carry")
	assertEquals(at(op({ path: [-(2 ** 31) - 1] })), "cannot-carry")
	// the largest whole either side, and negatives
	const edge = n(1, {
		time: -(2 ** 53 - 1),
		actor: "a",
		external: [{ file: "a", line: 2 ** 31 - 1, column: 2 ** 31 - 1 }],
		op: {
			patches: [{ path: ["a", 2 ** 31 - 1, -(2 ** 31)], range: [-1, 2 ** 53 - 1] }],
			undo: [],
		},
	})
	assertEquals(decode(encode(edge)).change, edge.change)
	assertEquals(code(() => decode(cbor.encode({ change: { time: 0.5 } }))), "not-a-node")
})

Deno.test("pack: reading takes exactly what writing gives", () => {
	const good = inner(pack([["value", "a", n(1)], ["value", "b", n(2)]]))
	const bad: [string, cbor.Value][] = [
		["another column", { ...good, extra: [] }],
		["an id named before the ids before it", { ...good, which: Uint8Array.of(1, 0) }],
		["an id never named", { ...good, ids: ["a", "b", "c"] }],
		["an id past the ids", { ...good, which: Uint8Array.of(0, 2) }],
		["keys out of order", { ...good, ids: ["b", "a"] }],
		["a key twice", {
			...good,
			ids: ["a"],
			which: Uint8Array.of(0, 0),
			nodes: Uint8Array.of(0, 1),
		}],
		["a node named before it is new", { ...good, nodes: Uint8Array.of(0, 2) }],
		["a node under no key", { ...good, nodes: Uint8Array.of(0, 1) }],
		["fewer keys than parts", { ...good, which: Uint8Array.of(0) }],
		["a run of none", { ...good, parts: [["value", 2], ["value", 0]] }],
		["a node with bits past cow", { ...good, has: Uint8Array.of(32 | 128, 1, 32) }],
		["a value too few", { ...good, values: [1] }],
		["a value too many", { ...good, values: [1, 2, 3] }],
		["an ermine:// id as its text", { ...good, ids: ["ermine://" + "00".repeat(32), "b"] }],
		["a varint that never ends", { ...good, time: Uint8Array.of(0x80) }],
	]
	for (const [name, x] of bad) assertEquals(code(() => unpack(wrap(x))), "not-a-pack", name)
	assertEquals(
		code(() => unpack(cbor.encode({ columns: Uint8Array.of(0xff, 0xff) }))),
		"not-a-pack",
	)
	assertEquals(code(() => unpack(cbor.encode({ columns: 1 }))), "not-a-pack")
	assertEquals(
		code(() => unpack(pack([["value", "a", n("x".repeat(5000))]]), { limit: 100 })),
		"not-a-pack",
	)
	assertEquals(code(() => unpack(new Uint8Array([0x01]))), "not-a-pack")
	assertEquals(code(() => decode(cbor.encode({ change: {} }))), "not-a-node")
	assertEquals(code(() => decode(pack([]))), "not-a-node")
})

Deno.test("pack: metadata in the old form, [key, value] pairs, is read as an object, of a key repeated the first", () => {
	const old = { change: { time: 1, metadata: [["why", "x"], ["a", 1], ["why", "y"]] } }
	const back = decode(cbor.encode(old))
	assertEquals(back.change.metadata, { why: "x", a: 1 })
	// written again: a map
	assertEquals(
		cbor.decode(encode(back)),
		{ change: { time: 1, metadata: { a: 1, why: "x" } } },
	)
	const proto = decode(cbor.encode({ change: { time: 1, metadata: [["__proto__", 1]] } }))
	assertEquals(Object.getPrototypeOf(proto.change.metadata), Object.prototype)
	assertEquals(Object.keys(proto.change.metadata!), ["__proto__"])
})

Deno.test("pack: the first form ({keys, nodes}) is read, as exactly as it was written", () => {
	const node = (value: number) => ({ change: { time: 1, actor: "a" }, value })
	const good = { keys: [["value", "a", 0], ["value", "b", 1]], nodes: [node(1), node(2)] }
	const back = unpack(cbor.encode(good))
	assertEquals(back.map(([p, i, e]) => [p, i, e.value, e.change.time]), [["value", "a", 1, 1], [
		"value",
		"b",
		2,
		1,
	]])
	const one = (x: cbor.Value) => ({ keys: [good.keys[0]], nodes: [x] })
	const bad: [string, cbor.Value][] = [
		["not a map", [1]],
		["another key", { ...good, extra: 1 }],
		["keys out of order", { keys: [good.keys[1], good.keys[0]], nodes: good.nodes }],
		["a key twice", { keys: [["value", "a", 0], ["value", "a", 1]], nodes: good.nodes }],
		["numbered out of order", {
			keys: [["value", "a", 1], ["value", "b", 0]],
			nodes: good.nodes,
		}],
		["a node under no key", { keys: [good.keys[0]], nodes: good.nodes }],
		["a number past the nodes", { keys: [["value", "a", 2]], nodes: good.nodes }],
		["a node with another key", one({ change: { time: 1 }, x: 1 })],
		["a change with no time", one({ change: { actor: "a" } })],
		["a site with no line", one({ change: { time: 1, external: [{ file: "a" }] } })],
		["a metadata entry of three", one({ change: { time: 1, metadata: [["a", 1, 2]] } })],
		["metadata a string", one({ change: { time: 1, metadata: "a" } })],
		[
			"a patch with another key",
			one({ change: { time: 1, op: { patches: [{ path: [], x: 1 }], undo: [] } } }),
		],
	]
	for (const [name, x] of bad) assertEquals(code(() => unpack(cbor.encode(x))), "not-a-pack", name)
})

Deno.test("pack: an empty pack", () => {
	assertEquals(inner(pack([])), {})
	assertEquals(unpack(pack([])), [])
})

Deno.test("pack: round trips keep bytes", () => {
	const nodes: NodeEntry<unknown>[] = [n(null), n([1, [2]]), n({ "": "" }), n("日本")]
	const es: Entry[] = nodes.map((node, i) => ["value", `n${i}`, node])
	const b = pack(es)
	assertEquals(hex(pack(unpack(b))), hex(b))
})
