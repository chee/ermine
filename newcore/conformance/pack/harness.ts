// The reference pack.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. Nodes are shown as the node harness shows them (conformance/node/harness.ts):
// content, change, because, actor and cause any JSON; in a list, {"symbol": name} is a symbol.
// Bytes are hex. Another implementation joins by speaking this.
//   {op: "walk" | "pack", root, nodes}: the nodes loaded, then walked or packed from root
//   {op: "unpack", bytes}
// answers: {graph: {root, nodes, missing}}, {bytes}, or {code, id?} for a PackError
import createNode, { type Header, type List, type Node, type Version } from "../../node.ts"
import { type Graph, pack, PackError, unpack, walk } from "../../pack.ts"
import { createTable } from "../../table.ts"

type V = Version<unknown, unknown>
type N = Node<unknown, unknown>
type Shown = {
	id: string
	value: V[]
	info: [string, V[]][]
	children: [string, V[]][]
	header: Header
}
type Request = { op: string; root?: string; nodes?: Shown[]; bytes?: string }

const symbol = (e: unknown): string | symbol =>
	typeof e === "object" && e !== null && "symbol" in e ? Symbol.for(String(e.symbol)) : String(e)
const unsymbol = (e: unknown) => typeof e === "symbol" ? { symbol: Symbol.keyFor(e) } : e
const list = (vs: V[]): Version<List, unknown>[] =>
	vs.map((v) => ({ ...v, content: (v.content as unknown[]).map(symbol) }))

const node = (s: Shown): N =>
	createNode(s.id, {
		value: s.value,
		info: s.info,
		children: s.children.map(([name, vs]) => [name, list(vs)] as const),
	}, { header: s.header })

const show = (n: N): Shown => ({
	id: n.id,
	value: n.value,
	info: [...n.info],
	children: [...n.children].map(([name, vs]) => [
		name,
		vs.map((v) => ({ ...v, content: v.content.map(unsymbol) })),
	]),
	header: n.header,
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
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof PackError) return e.id === undefined ? { code: e.code } : { code: e.code, id: e.id }
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
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		text += JSON.stringify(answer(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
