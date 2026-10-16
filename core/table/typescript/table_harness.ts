// the table (table.ts) on the line protocol (conformance/typescript/harness.ts). State lasts for the
// process: one table, one node object per name and one symbol per name, so identity is testable.
// Another implementation joins by speaking this (HARNESS).
//
// key: a string, or {"symbol": name}; a node: its name, a string; both are the request's "part",
// "id" and "node" fields. strings are equal when the same text, whole: NUL, lone surrogates,
// "__proto__", "" are keys like any other. a symbol is never equal to a string, even of its name;
// two {"symbol": name} of one name are one symbol. node names and key names are apart: a node "n"
// and a part "n" have nothing to do with each other
//
// { op: "add" | "sub", part, id, node }   → {}                         sub never fails
//                                         → { error: "already-there" } add, a different node there
// { op: "get", part, id }                 → { node? }                  absent: nothing there
// { op: "ids", part, node }               → { ids }                    the node's ids under the part
// { op: "at", id }                        → { entries }                [[part, node]], every part at the id
// { op: "who", node }                     → { keys }                   [[part, id]], every key it is under
// { op: "del", part, id }                 → {}                         the key
// { op: "del", part, node }               → {}                         the node from every id under the part
//                                                                      (an id given too is not read)
// { op: "del", node }                     → {}                         the node from every key
//                                         → { error: "nothing-there" } nothing to delete
// { op: "events" }                        → { events }                 [[part, id]], every table event
//                                                                      since last asked, in order
// { op: "events", at: true }              → { events }                 [[part, id, entries]]: the same,
//                                                                      each with every part at its id
//                                                                      as it was when told ("at")
//
// add of the node already there: {}, nothing changes, no event. sub of the node already there: the
// same. sub of a different node: the old node loses that key only; one event. sub with nothing
// there: an add. an error changes nothing and tells nothing. no answer ever lists a node's or an
// id's empty leftovers: what has no keys is not there.
//
// events: one per key added, replaced or taken out, told after it landed. a del of many keys takes
// them all, then tells one event per key, in who's order (del part node: the ids order).
//
// orders (lists in answers, never sorted):
//   ids    the order each id was put under the node and part
//   at     the order each part was put at the id; sub of a different node puts the key last
//   who    grouped by part, the parts in the order each was first taken by the node; within a part,
//          ids order. a part whose last id is gone leaves; taken again, it goes last
//   a key taken out and put back is new: it goes last everywhere
//
// anything not understood (an unknown or missing op, a field missing, a key not a string or a
// {"symbol": string}, a node not a string): { error: why }, why any text that is not a code; the
// next line is answered as ever.
import { createTable, type Event, type Id, TableError } from "./table.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import type { Entry } from "@ermine/node/entry"

// the table checks no name and no shape: here, any key is a table name and any entry goes
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

// a node by name: an object the table never reads
type N = Entry<unknown>

// every table event, until asked, with every part at its id as it was when told
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
