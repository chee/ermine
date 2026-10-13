// The reference pack.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. Nodes are shown as the node harness shows them (nodes/node/conformance/harness.ts):
// content, change, because, actor and cause any value in its JSON form (form.ts); in a list,
// {"symbol": name} is a symbol.
// Bytes are hex. Another implementation joins by speaking this.
//   {op: "walk" | "pack", root, nodes}: the nodes loaded, then walked or packed from root
//   {op: "unpack", bytes}
//   {op: "encode", node}: one node alone; {op: "decode", bytes}
// answers: {graph: {root, nodes, missing}}, {node}, {bytes}, or {code, id?} for a PackError
import createNode, { type Header, type List, type Node, type Version } from "@ermine/node"
import {
	decode,
	encode,
	type Graph,
	pack,
	PackError,
	unpack,
	walk,
} from "@ermine/encoding/pack"
import { createTable } from "@ermine/graph/table"
import { FormError, fromJson, line, toJson } from "./form.ts"

type V = Version<unknown, unknown>
type N = Node<unknown, unknown>
type Shown = {
	id: string
	value: V[]
	info: [string, V[]][]
	children: [string, V[]][]
	header: Header
}
type Request = { op: string; root?: string; nodes?: Shown[]; node?: Shown; bytes?: string }

const symbol = (e: unknown): string | symbol =>
	typeof e === "object" && e !== null && "symbol" in e ? Symbol.for(String(e.symbol)) : String(e)
const unsymbol = (e: unknown) => typeof e === "symbol" ? { symbol: Symbol.keyFor(e) } : e
const list = (vs: V[]): Version<List, unknown>[] =>
	vs.map((v) => {
		const out: Version<List, unknown> = {
			content: (v.content as unknown[]).map(symbol),
			change: fromJson(v.change),
		}
		if ("because" in v) out.because = fromJson(v.because)
		return out
	})

const values = (vs: V[]): V[] =>
	vs.map((v) => {
		const out: V = { content: fromJson(v.content), change: fromJson(v.change) }
		if ("because" in v) out.because = fromJson(v.because)
		return out
	})
const header = (h: Header, f: (x: unknown) => unknown): Header => {
	const out: Header = { ...h }
	if ("actor" in h) out.actor = f(h.actor)
	if ("cause" in h) out.cause = f(h.cause)
	return out
}

const node = (s: Shown): N =>
	createNode(s.id, {
		value: values(s.value),
		info: s.info.map(([name, vs]) => [name, values(vs)] as const),
		children: s.children.map(([name, vs]) => [name, list(vs)] as const),
	}, { header: header(s.header, fromJson) })

const json = (vs: V[]): V[] =>
	vs.map((v) => {
		const out: V = { content: toJson(v.content), change: toJson(v.change) }
		if ("because" in v) out.because = toJson(v.because)
		return out
	})

const show = (n: N): Shown => ({
	id: n.id,
	value: json(n.value),
	info: [...n.info].map(([name, vs]) => [name, json(vs)]),
	children: [...n.children].map(([name, vs]) => [
		name,
		vs.map((v) => {
			const out: V = { content: v.content.map(unsymbol), change: toJson(v.change) }
			if ("because" in v) out.because = toJson(v.because)
			return out
		}),
	]),
	header: header(n.header, toJson),
})
const graph = (g: Graph<unknown, unknown>) => ({
	graph: { root: g.root, nodes: g.nodes.map(show), missing: g.missing },
})

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

function loaded(nodes: Shown[]) {
	const t = createTable<unknown, unknown>()
	for (const s of nodes) t.intro(node(s))
	return t.get
}

function answer(r: Request): unknown {
	try {
		switch (r.op) {
			case "walk":
				return graph(walk(r.root!, loaded(r.nodes ?? [])))
			case "pack":
				return { bytes: hex(pack(r.root!, loaded(r.nodes ?? []))) }
			case "unpack":
				return graph(unpack(unhex(r.bytes!)))
			case "encode":
				return { bytes: hex(encode(node(r.node!))) }
			case "decode":
				return { node: show(decode(unhex(r.bytes!))) }
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof PackError) {
			return e.id === undefined ? { code: e.code } : { code: e.code, id: e.id }
		}
		// a value whose form stands for none: the C harness's codec refuses it as it encodes
		if (e instanceof FormError) return { code: "cannot-carry" }
		throw e
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		text += line(answer(JSON.parse(l))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
