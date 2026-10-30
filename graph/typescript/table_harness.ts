// The table (table.ts) on the line protocol. State lasts for the process: one table, one node
// object and one symbol per name.
//
// A key is a string or {"symbol": name}; a node is its name, a string. Strings are equal when
// the text is the same (NUL, lone surrogates, "__proto__" and "" are keys like any other). A
// symbol never equals a string; two symbols of one name are one symbol. Node names and key names
// are separate.
//
// { op: "add" | "sub", part, id, node }  → {}, or { error: "already-there" } for an add over a
//                                           different node. sub never fails.
// { op: "get", part, id }                → { node? }
// { op: "ids", part, node }              → { ids }      the node's ids under the part
// { op: "at", id }                       → { entries }  [[part, node]], every part at the id
// { op: "who", node }                    → { keys }     [[part, id]], every key it is under
// { op: "del", part, id }                → {}
// { op: "del", part, node }              → {}  the node from every id under the part
// { op: "del", node }                    → {}  the node from every key
//                                          (a del of nothing: { error: "nothing-there" })
// { op: "events" }                       → { events }   [[part, id]], every event since last asked
// { op: "events", at: true }             → { events }   [[part, id, entries]], each with every part
//                                                       at its id as it was when told
//
// Adding the node already there changes nothing and tells nothing; so does a sub of it. A sub of
// a different node removes the old node's key only, with one event. An error changes nothing. A
// node or id with no keys is not there.
//
// Events: one per key added, replaced or removed, told after it landed. A del of many keys takes
// them all, then tells one event per key, in who's order (for del part node, the ids order).
//
// Lists are never sorted:
//   ids  the order each id was put under the node and part
//   at   the order each part was put at the id; a sub of a different node puts the key last
//   who  grouped by part, parts in the order the node first took them, ids in ids order; a part
//        whose last id is gone leaves, and goes last when taken again
//   a key removed and put back is new, and goes last everywhere
//
// Anything not understood (unknown or missing op, missing field, bad key or node): { error: why },
// why being any text. The next line is answered as usual.
import { createTable, type Event, type Id, TableError } from "./table.ts"
import { type Answer, type Request, serve } from "../../conformance/typescript/harness.ts"
import type { Entry } from "@ermine/graph/entry"

// The table checks no name and no shape, so here any key is a table name and any entry goes.
type Loose = {
	add: (part: Id, id: Id, node: Entry<unknown>) => void
	sub: (part: Id, id: Id, node: Entry<unknown>) => void
	get: {
		(part: Id, id: Id): Entry<unknown> | undefined
		(part: Id, node: Entry<unknown>): Id[]
		(id: Id): [Id, Entry<unknown>][]
	}
	who: (node: Entry<unknown>) => [Id, Id][]
	del: {
		(part: Id, id: Id): void
		(part: Id, node: Entry<unknown>): void
		(node: Entry<unknown>): void
	}
}
const loose = (event?: (part: Id, id: Id) => void) =>
	createTable(event as Event | undefined) as unknown as Loose

// A node by name: an object the table never reads.
type N = Entry<unknown>

// Every table event until asked, with every part at its id as it was when told.
const events: [Id, Id, [Id, N][]][] = []
const table: Loose = loose((part, id) => events.push([part, id, table.get(id)]))
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
function key(x: unknown): Id {
	if (typeof x === "string") return x
	if (x !== null && typeof x === "object" && typeof (x as Request).symbol === "string") {
		const name = (x as Request).symbol as string
		let s = symbols.get(name)
		if (!s) symbols.set(name, s = Symbol(name))
		return s
	}
	throw new Error("key: not a string or a symbol")
}
const text = (k: Id) => typeof k === "symbol" ? { symbol: k.description } : k

function answer(r: Request): Answer {
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
			case "events":
				return {
					events: events.splice(0).map(([p, i, at]) =>
						r.at === true
							? [text(p), text(i), at.map(([q, n]) => [text(q), names.get(n as object)])]
							: [text(p), text(i)]
					),
				}
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

if (import.meta.main) await serve(answer)
