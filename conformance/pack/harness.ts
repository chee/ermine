// The reference pack.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. Another implementation joins by speaking this. Bytes are hex.
//   {op: "pack", entries: [[part, id, n], …], nodes: [node, …], options?}: each node under its
//     keys, n its place in nodes, so a node under two keys is one node
//   {op: "unpack", bytes, reading?}
//   {op: "encode", node, options?}: one node alone; {op: "decode", bytes, reading?}
// options: {op?: false}, pack.ts's Options; reading: {loosyGoosy?: true}, its Reading
// answers: {bytes}; {entries, nodes}, the nodes numbered in the order the entries first name them;
// {node}; or {code, part?, id?} for a PackError
// A part or an id: a string, or {"symbol": name}, Symbol.for(name). A node: {value?, change,
// cow?: false}, change {time, actor?, reader?, external?, metadata?, op?}, the value, actor,
// reader, each metadata value and each patch's value in their JSON form (form.ts)
import createNode, { type ChangeHeader, type Node } from "@ermine/node"
import {
	decode,
	encode,
	type Entry,
	type Key,
	type Options,
	pack,
	PackError,
	type Reading,
	unpack,
} from "@ermine/encoding/pack"
import { FormError, fromJson, line, toJson } from "./form.ts"

type Fields = Record<string, unknown>
export type Shown = { value?: unknown; change: Fields; cow?: false }
type Request = {
	op: string
	entries?: [unknown, unknown, number][]
	nodes?: Shown[]
	node?: Shown
	bytes?: string
	options?: Options
	reading?: Reading
}

const key = (k: unknown): Key =>
	typeof k === "object" && k !== null && "symbol" in k ? Symbol.for(String(k.symbol)) : String(k)
// a key as an answer names it
const named = (k: Key) => typeof k === "symbol" ? { symbol: Symbol.keyFor(k) ?? k.description } : k

// each patch's value, through f
const patches = (ps: unknown, f: (x: unknown) => unknown) =>
	(ps as Fields[]).map((p) => "value" in p ? { ...p, value: f(p.value) } : p)

function header(c: Fields, f: (x: unknown) => unknown): Fields {
	const out: Fields = { ...c }
	if ("actor" in c) out.actor = f(c.actor)
	// a string, but a symbol for a test of one
	if ("reader" in c) out.reader = f(c.reader)
	if ("metadata" in c) {
		out.metadata = (c.metadata as [string, unknown][]).map(([k, v]) => [k, f(v)])
	}
	if ("op" in c) {
		const op = c.op as Fields
		out.op = { patches: patches(op.patches, f), undo: patches(op.undo, f) }
	}
	return out
}

const node = (s: Shown): Node<unknown> =>
	createNode(
		"value" in s ? fromJson(s.value) : undefined,
		header(s.change, fromJson) as ChangeHeader,
		s.cow === false ? { cow: false } : {},
	)

function show(n: Node<unknown>): Shown {
	const out: Shown = { change: header(n.change as unknown as Fields, toJson) }
	if ("value" in n) out.value = toJson(n.value)
	if (n.cow === false) out.cow = false
	return out
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

function entries(r: Request): Entry[] {
	const nodes = (r.nodes ?? []).map(node)
	return (r.entries ?? []).map(([part, id, n]) => [key(part), key(id), nodes[n]] as const)
}

// the entries as the protocol shows them, the nodes numbered as first named
function shown(es: Entry[]) {
	const numbers = new Map<Node<unknown>, number>(), nodes: Shown[] = []
	const out = es.map(([part, id, n]) => {
		let i = numbers.get(n)
		if (i === undefined) numbers.set(n, i = nodes.length), nodes.push(show(n))
		return [part, id, i]
	})
	return { entries: out, nodes }
}

function answer(r: Request): unknown {
	try {
		switch (r.op) {
			case "pack":
				return { bytes: hex(pack(entries(r), r.options)) }
			case "unpack":
				return shown(unpack(unhex(r.bytes!), r.reading))
			case "encode":
				return { bytes: hex(encode(node(r.node!), r.options)) }
			case "decode":
				return { node: show(decode(unhex(r.bytes!), r.reading)) }
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof PackError) {
			const out: Fields = { code: e.code }
			if (e.part !== undefined) out.part = named(e.part)
			if (e.id !== undefined) out.id = named(e.id)
			return out
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
if (buffer.trim() !== "") await out.write(encoder.encode(line(answer(JSON.parse(buffer))) + "\n"))
await out.close()
