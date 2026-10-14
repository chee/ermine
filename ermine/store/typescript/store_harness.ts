// store (store.ts) on the line protocol (conformance/typescript/harness.ts). State lasts for the
// process: one store, one node object per name and one symbol per name, so identity is testable.
// Another implementation joins by speaking this (HARNESS).
//
// a key (source, id): a string, or {"symbol": name}; a node: its name, a string; a part: any
// string
//
// { op: "add" | "sub", source, part, id, node } → {}                          sub never fails
//                                               → { error: "already-there" }  add, a different node there
// { op: "get", source, part, id }               → { node? }                   absent: nothing there
// { op: "del", source, part, id }               → {}
//                                               → { error: "nothing-there" }  nothing to delete
// { op: "who", source, node }                   → { keys }                    [[part, id]], in that source
// { op: "children", source, id }                → { node? }                   places' hole
// { op: "drop", source }                        → {}
// { op: "events" }                              → { events }
//    every table event told since last asked, then forgotten: [source, part, id, node], node the
//    name of what get gives at the key when it is told (null: nothing: it is told after the change)
//
// Anything not understood: { error: why }, not a code.
import createEntry, { type Entry } from "@ermine/node"
import { createStore, type Key, type Part, TableError } from "./store.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

const nodes = new Map<string, Entry<unknown>>()
const names = new Map<object, string>()
const symbols = new Map<string, symbol>()
let events: unknown[][] = []

function node(x: unknown): Entry<unknown> {
	if (typeof x !== "string") throw new Error("node: not a name")
	let n = nodes.get(x)
	if (!n) {
		nodes.set(x, n = createEntry(x, { time: 1, actor: "me" }))
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
function part(x: unknown): Part {
	if (typeof x === "string") return x as Part
	throw new Error("part: not a string")
}
const nameOf = (n: Entry<unknown> | undefined) => n === undefined ? null : names.get(n)

const store = createStore((source, p, id) => {
	events.push([text(source), p, text(id), nameOf(store.get(source, p, id))])
})

function answer(r: Request): Record<string, unknown> {
	if (r === null || typeof r !== "object") throw new Error("not an object")
	try {
		switch (r.op) {
			case "add":
				store.add(key(r.source), part(r.part), key(r.id), node(r.node))
				return {}
			case "sub":
				store.sub(key(r.source), part(r.part), key(r.id), node(r.node))
				return {}
			case "get": {
				const n = store.get(key(r.source), part(r.part), key(r.id))
				return n === undefined ? {} : { node: names.get(n) }
			}
			case "del":
				store.del(key(r.source), part(r.part), key(r.id))
				return {}
			case "who":
				return { keys: store.who(key(r.source), node(r.node)).map(([p, i]) => [p, text(i)]) }
			case "children": {
				const n = store.children(key(r.source), key(r.id))
				return n === undefined ? {} : { node: names.get(n) }
			}
			case "drop":
				store.drop(key(r.source))
				return {}
			case "events": {
				const out = events
				events = []
				return { events: out }
			}
		}
	} catch (e) {
		if (e instanceof TableError) return { error: e.code }
		throw e
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) await serve(answer)
