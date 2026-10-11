// The reference node.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. Content, change, because, actor and cause are any JSON, given back as is; in a
// list, {"symbol": name} is a symbol. Another implementation joins by speaking this.
import make, { type Header, type List, type Node, type Version } from "../../node.ts"

type V = Version<unknown, unknown>
type Request = {
	op: string
	id?: string
	contents?: { value?: V[]; info?: [string, V[]][]; children?: [string, V[]][] }
	header?: Header
	outside?: boolean
}

const symbol = (e: unknown): string | symbol =>
	typeof e === "object" && e !== null && "symbol" in e ? Symbol.for(String(e.symbol)) : String(e)
const unsymbol = (e: unknown) => typeof e === "symbol" ? { symbol: Symbol.keyFor(e) } : e
const list = (vs: V[]): Version<List, unknown>[] =>
	vs.map((v) => ({ ...v, content: (v.content as unknown[]).map(symbol) }))

function show(n: Node<unknown, unknown>) {
	return {
		id: n.id,
		value: n.value,
		info: [...n.info],
		children: [...n.children].map(([name, vs]) => [
			name,
			vs.map((v) => ({ ...v, content: v.content.map(unsymbol) })),
		]),
		header: n.header,
	}
}

function answer(r: Request): unknown {
	switch (r.op) {
		case "make": {
			const c = r.contents ?? {}
			const n = make(r.id!, {
				value: c.value,
				info: c.info,
				children: c.children?.map(([name, vs]) => [name, list(vs)] as const),
			}, { header: r.header, outside: r.outside })
			return { node: show(n as Node<unknown, unknown>) }
		}
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
