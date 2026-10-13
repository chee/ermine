// The reference table (core/graph/typescript/table.ts) on the line protocol: one JSON request per
// line in, one answer per line out, in order. State lasts for the process: one table, one node
// object per name and one symbol per name, so identity is testable. Another implementation joins
// by speaking this (TABLE_HARNESS).
//
// key: a string, or {"symbol": name}; a node: its name, a string; both are the request's "part",
// "id" and "node" fields
//
// { op: "add" | "sub", part, id, node }   → {}                         sub never fails
//                                         → { error: "already-there" } add, a different node there
// { op: "get", part, id }                 → { node? }                  absent: nothing there
// { op: "ids", part, node }               → { ids }                    the node's ids under the part
// { op: "at", id }                        → { entries }                [[part, node]], every part at the id
// { op: "who", node }                     → { keys }                   [[part, id]], every key it is under
// { op: "del", part, id }                 → {}                         the key
// { op: "del", part, node }               → {}                         the node from every id under the part
// { op: "del", node }                     → {}                         the node from every key
//                                         → { error: "nothing-there" } nothing to delete
//
// Orders are the order added (table.ts). Anything not understood: { error: why }, not a code.
import { createTable, TableError } from "@ermine/graph/table"
import type { Key } from "@ermine/graph/table"
import type { Node } from "@ermine/node"

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// a node by name: an object the table never reads
type N = Node<unknown>

const table = createTable<unknown>()
const nodes = new Map<string, N>()
const names = new Map<object, string>()
const symbols = new Map<string, symbol>()

function node(x: unknown): N {
	if (typeof x !== "string") throw new Error("node: not a name")
	let n = nodes.get(x)
	if (!n) {
		nodes.set(x, n = { name: x } as unknown as N)
		names.set(n, x)
	}
	return n
}
function key(x: unknown): Key {
	if (typeof x === "string") return x
	if (x !== null && typeof x === "object" && typeof (x as Request).symbol === "string") {
		const name = (x as Request).symbol as string
		let s = symbols.get(name)
		if (!s) symbols.set(name, s = Symbol(name))
		return s
	}
	throw new Error("key: not a string or a symbol")
}
const text = (k: Key) => typeof k === "symbol" ? { symbol: k.description } : k

function answer(r: Request): unknown {
	if (r === null || typeof r !== "object") throw new Error("not an object")
	try {
		switch (r.op) {
			case "add":
				table.add(key(r.part), key(r.id), node(r.node))
				return {}
			case "sub":
				table.sub(key(r.part), key(r.id), node(r.node))
				return {}
			case "get": {
				const n = table.get(key(r.part), key(r.id))
				return n === undefined ? {} : { node: names.get(n as object) }
			}
			case "ids":
				return { ids: table.get(key(r.part), node(r.node)).map(text) }
			case "at":
				return {
					entries: table.get(key(r.id)).map(([p, n]) => [text(p), names.get(n as object)]),
				}
			case "who":
				return { keys: table.who(node(r.node)).map(([p, i]) => [text(p), text(i)]) }
			case "del":
				if (r.part === undefined) table.del(node(r.node))
				else if (r.node !== undefined) table.del(key(r.part), node(r.node))
				else table.del(key(r.part), key(r.id))
				return {}
		}
	} catch (e) {
		if (e instanceof TableError) return { error: e.code }
		throw e
	}
	throw new Error(`unknown op ${r.op}`)
}

function safe(line: string): string {
	try {
		return JSON.stringify(answer(JSON.parse(line)))
	} catch (e) {
		return JSON.stringify({ error: String(e) })
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
		text += safe(l) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
