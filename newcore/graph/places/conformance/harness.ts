// The reference places on the line protocol: one JSON request per line in, one answer per line
// out, in order. State lasts for the process: a graph, and the heres cd made. Another
// implementation joins by speaking this.
//
// { op: "graph", root, nodes }           → {}          a fresh table: these nodes loaded, time 0
//    node: { id, value?, info?, children? }; info, children: [[name, versions]], in order
//    version: { content, change, because? }; a list's content: ids, and {"$symbol": name}
// { op: "intro", node } → {}             { op: "outro", id } → {}
// { op: "node", id }                     → { node: { id, value, info, children } | null }
//
// reads, at a place (names) or a here (as cd named it); depend: true adds said
// { op: "look", place | here, address }              → { items }
// { op: "lookup" | "lookups", place | here, path }    → { items }
// { op: "children", place | here, address, name? }   → { names } | { items }
// { op: "content", place | here, address }           → { items }, each with versions
// { op: "info", place | here, address, name }        → { items }, each with versions
//    item: { id, route, loaded, up?, versions? }; said: [[id, part]], in the order read
// { op: "cd", address, here?, as }                   → { names, trail }; from here, if given
//
// changes; by() gives { actor: "me", time }, time counting from 1 after each graph
// { op: "write", place | here, address, patches, index?, slotindex? }      → { change }
// { op: "set", place | here, address, name, patches, index?, slotindex? } → { change }
// { op: "insert", id, name, child, index?, slotindex? }  → { change }
// { op: "remove", id, name, index, slotindex? }         → { change }
// { op: "pop", id, name, slotindex }                     → { change }
// { op: "rename", id, name, to }                         → { changes }
// { op: "move", id, name, index, toid, toname, toindex? } → { changes }
//
// a PlacesError, MutateError or TableError: { fail: code }. Anything else wrong: { error }
import { MutateError } from "../../../opstreams/mutate.ts"
import createNode, { type List, type Node } from "../../../nodes/node.ts"
import { createPlaces, type Item, type Part, PlacesError, type Read } from "../../places.ts"
import { createTable, TableError } from "../../table.ts"

type N = Node<unknown, unknown>
type Json = unknown
// deno-lint-ignore no-explicit-any
type Request = Record<string, any>

const symbols = new Map<string, symbol>()
const symbol = (name: string) => {
	let s = symbols.get(name)
	if (s === undefined) symbols.set(name, s = Symbol(name))
	return s
}

const list = (ids: Json[]): List =>
	ids.map((x) => typeof x === "string" ? x : symbol((x as { $symbol: string }).$symbol))
const unlist = (ids: List): Json[] =>
	ids.map((x) => typeof x === "string" ? x : { $symbol: x.description })

type V = { content: Json; change: Json; because?: Json }
const version = (v: V, isList: boolean) => {
	const out: V = { content: isList ? list(v.content as Json[]) : v.content, change: v.change }
	if ("because" in v) out.because = v.because
	return out
}
const unversion = (
	v: { content: unknown; change: unknown; because?: unknown },
	isList: boolean,
) => {
	const out: V = {
		content: isList ? unlist(v.content as List) : v.content,
		change: v.change,
	}
	if ("because" in v) out.because = v.because
	return out
}

function make(n: Request): N {
	return createNode(n.id, {
		value: (n.value ?? []).map((v: V) => version(v, false)),
		info: (n.info ?? []).map(([k, vs]: [string, V[]]) => [k, vs.map((v) => version(v, false))]),
		children: (n.children ?? []).map((
			[k, vs]: [string, V[]],
		) => [k, vs.map((v) => version(v, true))]),
	})
}
function dump(n: N) {
	return {
		id: n.id,
		value: n.value.map((v) => unversion(v, false)),
		info: [...n.info].map(([k, vs]) => [k, vs.map((v) => unversion(v, false))]),
		children: [...n.children].map(([k, vs]) => [k, vs.map((v) => unversion(v, true))]),
	}
}

let table = createTable<unknown, unknown>()
let time = 0
let places = createPlaces(table.get, "")
// deno-lint-ignore no-explicit-any
let heres = new Map<string, any>()

function item(it: Item<unknown, unknown> | Read<unknown, unknown>) {
	const out: Request = { id: it.id, route: it.route, loaded: it.node !== undefined }
	if (it.up !== undefined) out.up = it.up
	if ("versions" in it && it.versions !== undefined) {
		out.versions = it.versions.map((v) => unversion(v, false))
	}
	return out
}

function answer(r: Request): Json {
	const said: [string, Part][] = []
	const depend = r.depend ? (id: string, part: Part) => void said.push([id, part]) : undefined
	const with_said = (a: Request) => r.depend ? { ...a, said } : a
	// a read at a place or at a here
	const at = (name: string, ...args: unknown[]) => {
		if (r.here !== undefined) {
			const h = heres.get(r.here)
			if (h === undefined) throw new Error(`no here ${r.here}`)
			return h[name](...args)
		}
		// deno-lint-ignore no-explicit-any
		return (places as any)[name](r.place, ...args)
	}
	switch (r.op) {
		case "graph":
			table = createTable()
			time = 0
			places = createPlaces(table.get, r.root, { by: () => ({ actor: "me", time: ++time }) })
			heres = new Map()
			for (const n of r.nodes) table.intro(make(n))
			return {}
		case "intro":
			table.intro(make(r.node))
			return {}
		case "outro":
			table.outro(r.id)
			return {}
		case "node": {
			const n = table.get(r.id)
			return { node: n === undefined ? null : dump(n) }
		}
		case "look":
			return with_said({ items: at("look", r.address, depend).map(item) })
		case "lookup":
		case "lookups":
			return with_said({ items: at(r.op, r.path, depend).map(item) })
		case "children": {
			const out = at("children", r.address, r.name, depend)
			return with_said(r.name === undefined ? { names: out } : { items: out.map(item) })
		}
		case "content":
			return with_said({ items: at("content", r.address, depend).map(item) })
		case "info":
			return with_said({ items: at("info", r.address, r.name, depend).map(item) })
		case "cd": {
			let h
			if (r.here !== undefined) {
				const from = heres.get(r.here)
				if (from === undefined) throw new Error(`no here ${r.here}`)
				h = from.cd(r.address, depend)
			} else h = places.cd(r.address, depend)
			heres.set(r.as, h)
			return with_said({ names: h.names, trail: h.trail })
		}
		case "write":
			return { change: at("write", r.address, r.patches, r.index, r.slotindex) }
		case "set":
			return { change: at("set", r.address, r.name, r.patches, r.index, r.slotindex) }
		case "insert":
			return { change: places.insert(r.id, r.name, r.child, r.index, r.slotindex) }
		case "remove":
			return { change: places.remove(r.id, r.name, r.index, r.slotindex) }
		case "pop":
			return { change: places.pop(r.id, r.name, r.slotindex) }
		case "rename":
			return { changes: places.rename(r.id, r.name, r.to) }
		case "move":
			return {
				changes: places.move(r.id, r.name, r.index, r.toid, r.toname, r.toindex),
			}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

function safe(r: Request): Json {
	try {
		return answer(r)
	} catch (e) {
		if (e instanceof PlacesError || e instanceof MutateError || e instanceof TableError) {
			return { fail: e.code }
		}
		return { error: String(e) }
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
		text += JSON.stringify(safe(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
