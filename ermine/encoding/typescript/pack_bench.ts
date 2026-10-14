// deno bench --allow-env ermine/encoding/typescript/pack_bench.ts
// pack and the canonical codec against cbor-x, the speed to reach: cbor-x writes no canonical form
// (integers, keys as made), so it is a bound, not a rival
import { Encoder } from "cbor-x"
import * as cbor from "./cbor.ts"
import createEntry, { type Entry as NodeEntry } from "@ermine/node/entry"
import { decode, encode, type Entry, pack, unpack } from "./pack.ts"

const x = new Encoder({ useRecords: false })
const at = (time: number) => ({ time, actor: "host" })

// a tree of 1000 ids, 10 under each: each a small value, a type attribute and its children
const N = 1000
const entries: Entry[] = []
for (let i = 0; i < N; i++) {
	const kids = Array.from({ length: 10 }, (_, k) => i * 10 + k + 1).filter((k) => k < N)
	const id = `n${i}`, time = 1760000000 + i
	entries.push([
		"value",
		id,
		createEntry({ title: `note ${i}`, done: i % 2 === 0, size: i * 1.5 }, at(time)),
	])
	entries.push(["attributes", id, createEntry({ type: "public.folder" }, at(time))])
	entries.push([
		"children",
		id,
		createEntry({ home: kids.map((k) => ["host", `n${k}`]) }, at(time)),
	])
}
const graph = pack(entries)
const one: NodeEntry<unknown> = entries[0][2]
const node = encode(one)

// values alone
const small = { title: "hello", done: false, size: 12, tags: ["a", "b"] }
const text = { body: "lorem ipsum ".repeat(10_000) }
const numbers = Array.from({ length: 10_000 }, (_, i) => i * 0.25)
const typed = new Float64Array(numbers)
const values = { small, text, numbers, typed }

Deno.bench("pack 3000 nodes", { group: "graph", baseline: true }, () => void pack(entries))
Deno.bench("unpack 3000 nodes", { group: "graph" }, () => void unpack(graph))
Deno.bench("encode one node", { group: "node", baseline: true }, () => void encode(one))
Deno.bench("decode one node", { group: "node" }, () => void decode(node))

const shaped = entries.map(([part, id, n]) => [part, id, { value: n.value, change: n.change }])
const bound = x.encode(shaped)
Deno.bench("cbor-x: 3000 nodes, encode", { group: "graph" }, () => void x.encode(shaped))
Deno.bench("cbor-x: 3000 nodes, decode", { group: "graph" }, () => void x.decode(bound))

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
