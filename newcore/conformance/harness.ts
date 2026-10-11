// The reference trackgraph on the line protocol: one JSON request per line in, one answer per
// line out, in order. A node's owner is its name. Another implementation joins by speaking this.
import { createTrackgraph, type Node } from "../trackgraph.ts"

const g = createTrackgraph<string>()
const nodes = new Map<string, Node<string>>()
const node = (name: string) => {
	let n = nodes.get(name)
	if (n === undefined) nodes.set(name, n = g.node(name))
	return n
}

type Request = { op: string; from?: string; to?: string; of?: string }

function answer(r: Request): unknown {
	switch (r.op) {
		case "begin":
			g.begin(node(r.from!))
			return {}
		case "track":
			g.track(node(r.from!), node(r.to!))
			return {}
		case "end":
			g.end(node(r.from!))
			return {}
		case "add":
			g.add(node(r.from!), node(r.to!))
			return {}
		case "untrack":
			g.untrack(node(r.from!), r.to === undefined ? undefined : node(r.to))
			return {}
		case "reads":
			return { names: g.reads(node(r.of!)).map((n) => n.owner) }
		case "readers":
			return { names: g.readers(node(r.of!)).map((l) => l.from.owner) }
		default:
			return { error: `unknown op ${r.op}` }
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
