// deno bench --allow-env newcore/encoding/ts/pack_bench.ts
// pack and the canonical codec (ENCODING.tex) against cbor-x, the speed to reach: cbor-x writes
// no canonical form (integers, keys as made), so it is a bound, not a rival
import { Encoder } from "cbor-x"
import * as cbor from "./cbor.ts"
import createNode, { type Node } from "@ermine/graph/node"
import { decode, encode, pack, unpack } from "./pack.ts"
import { createTable } from "@ermine/graph/table"

const x = new Encoder({ useRecords: false })
const at = <C>(content: C) => ({ content, change: { time: 1760000000000, actor: "a", node: "x" } })

// a tree of 1000 nodes, 10 under each, each a small value, a type and two versions of its list
const t = createTable<unknown, unknown>()
const N = 1000
for (let i = 0; i < N; i++) {
	const kids = Array.from({ length: 10 }, (_, k) => `n${i * 10 + k + 1}`).filter((id) =>
		Number(id.slice(1)) < N
	)
	t.intro(createNode<unknown, unknown>(`n${i}`, {
		value: [at({ title: `note ${i}`, done: i % 2 === 0, size: i * 1.5 })],
		info: [["type", [at("public.folder")]]],
		children: [["home", [at(kids), at(kids.slice(1))]]],
	}, { header: { time: 1760000000000 + i, actor: "host" } }))
}
const graph = pack("n0", t.get)
const one = t.get("n1")!
const node = encode(one)

// values alone
const small = { title: "hello", done: false, size: 12, tags: ["a", "b"] }
const text = { body: "lorem ipsum ".repeat(10_000) }
const numbers = Array.from({ length: 10_000 }, (_, i) => i * 0.25)
const typed = new Float64Array(numbers)
const values = { small, text, numbers, typed }

Deno.bench("pack 1000 nodes", { group: "graph", baseline: true }, () => void pack("n0", t.get))
Deno.bench("unpack 1000 nodes", { group: "graph" }, () => void unpack(graph))
Deno.bench("encode one node", { group: "node", baseline: true }, () => void encode(one))
Deno.bench("decode one node", { group: "node" }, () => void decode(node))

const shaped = (n: Node<unknown, unknown>) => ({
	id: n.id,
	value: n.value,
	info: [...n.info],
	children: [...n.children],
	header: n.header,
})
const all = Array.from({ length: N }, (_, i) => shaped(t.get(`n${i}`)!))
const bound = x.encode({ root: "n0", nodes: all, missing: [] })
Deno.bench(
	"cbor-x: 1000 nodes, encode",
	{ group: "graph" },
	() => void x.encode({ root: "n0", nodes: all, missing: [] }),
)
Deno.bench("cbor-x: 1000 nodes, decode", { group: "graph" }, () => void x.decode(bound))

for (const [name, v] of Object.entries(values)) {
	const c = cbor.encode(v as cbor.Value), b = x.encode(v)
	Deno.bench(
		`${name}: encode`,
		{ group: name, baseline: true },
		() => void cbor.encode(v as cbor.Value),
	)
	Deno.bench(`${name}: decode`, { group: name }, () => void cbor.decode(c))
	Deno.bench(`${name}: cbor-x encode`, { group: name }, () => void x.encode(v))
	Deno.bench(`${name}: cbor-x decode`, { group: name }, () => void x.decode(b))
}
