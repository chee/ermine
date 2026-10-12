import { assertEquals, assertThrows } from "@std/assert"
import createNode, { type Node } from "../../nodes/ts/node.ts"
import { encode as encodeValue } from "./cbor.ts"
import { decode, encode, pack, PackError, unpack, walk } from "./pack.ts"
import { createTable } from "../../graph/ts/table.ts"

const code = (f: () => unknown) => (assertThrows(f, PackError) as PackError).code
const at = <C>(content: C) => ({ content, change: { time: 1, actor: "a", node: "x" } })

function graph() {
	const t = createTable<unknown, unknown>()
	const add = (n: Node<unknown, unknown>) => (t.intro(n), n)
	add(createNode("root", {
		value: [at(null)],
		children: [["home", [at(["a", "gone"]), at(["b"])]]],
	}, { header: { time: 0, actor: "host" } }))
	add(createNode<unknown, unknown>("a", {
		value: [at(new Uint16Array([1, 2]))],
		info: [["type", [at("public.folder")]]],
		children: [["up", [at(["root"])]]],
	}))
	add(createNode("b", { value: [at("hi")] }))
	add(createNode("far", { value: [at("not reached")] }))
	return t
}

Deno.test("pack: walk reaches every version's ids, once; missing listed", () => {
	const g = walk("root", graph().get)
	assertEquals(g.nodes.map((n) => n.id), ["root", "a", "b"])
	assertEquals(g.missing, ["gone"])
})

Deno.test("pack: round trip", () => {
	const t = graph()
	const back = unpack(pack("root", t.get))
	assertEquals(back.root, "root")
	assertEquals(back.missing, ["gone"])
	const want = walk("root", t.get).nodes
	assertEquals(back.nodes, want)
	assertEquals(back.nodes[1].value[0].content, new Uint16Array([1, 2]))
	assertEquals(back.nodes[0].header, { time: 0, actor: "host" })
	const t2 = createTable<unknown, unknown>()
	for (const n of back.nodes) t2.intro(n)
	assertEquals(t2.get("a")?.info.get("type")?.[0].content, "public.folder")
})

Deno.test("pack: errors", () => {
	const t = graph()
	assertEquals(code(() => pack("nope", t.get)), "nothing-there")
	t.intro(
		createNode("s", { children: [["x", [at<readonly (string | symbol)[]>([Symbol("#")])]]] }),
	)
	t.get("b")!.children.set("more", [at(["s"])])
	const e = assertThrows(() => pack("root", t.get), PackError) as PackError
	assertEquals([e.code, e.id], ["cannot-carry", "s"])
	assertEquals(code(() => unpack(new Uint8Array([0xf6]))), "not-a-graph")
})

// found by the audit of 10-11

Deno.test("pack: bytes that are not a graph are not-a-graph, whatever is wrong with them", () => {
	const good = pack("root", graph().get)
	const wrong: Uint8Array[] = [
		good.slice(0, -3),
		new Uint8Array([...good, 0]),
		new Uint8Array(),
		encodeValue({ root: "a", nodes: [null], missing: [] }),
		encodeValue({ root: "a", nodes: [5], missing: [] }),
		encodeValue({ root: "a", nodes: [{}], missing: [] }),
		encodeValue({ root: "a", nodes: [{ id: "a", info: 5 }], missing: [] }),
		encodeValue({ root: "a", nodes: [], missing: [5] }),
		encodeValue({
			root: "a",
			nodes: [{
				id: "a",
				value: [],
				info: [],
				children: [["x", [{ content: [1] }]]],
				header: {},
			}],
			missing: [],
		}),
		new Uint8Array([0xa1, 0x64, 0x72, 0x6f, 0x6f, 0x74, 0x01]),
	]
	for (const bytes of wrong) assertEquals(code(() => unpack(bytes)), "not-a-graph")
})

Deno.test("pack: one node alone, and back", () => {
	const t = graph()
	const a = t.get("a")!
	const back = decode(encode(a))
	assertEquals(back, walk("a", t.get).nodes[0])
	assertEquals(code(() => decode(encodeValue({ id: 5 }))), "not-a-node")
	assertEquals(code(() => decode(pack("root", t.get))), "not-a-node")
	const live = createNode<unknown, unknown>("live", { value: [at(new Map())] })
	const e = assertThrows(() => encode(live), PackError) as PackError
	assertEquals([e.code, e.id], ["cannot-carry", "live"])
})

Deno.test("pack: the same graph is the same bytes, whatever order its maps were made in", () => {
	const one = createNode("r", { value: [at({ a: 1, b: [2.5] })] }, {
		header: { time: 1, actor: "x" },
	})
	const two = createNode("r", {
		value: [{ change: one.value[0].change, content: { b: [2.5], a: 1 } }],
	}, {
		header: { actor: "x", time: 1 },
	})
	assertEquals(encode(one), encode(two))
	// numbers are floats: time 1 is f93c00
	const hex = Array.from(encode(one), (x) => x.toString(16).padStart(2, "0")).join("")
	assertEquals(hex.includes("6474696d65f93c00"), true)
})
