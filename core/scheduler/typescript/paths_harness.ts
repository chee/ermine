// paths (paths.ts) on the line protocol (conformance/typescript/harness.ts). Another implementation
// joins by speaking this (HARNESS).
//
//   source, id   a string, or {"symbol": name}: one symbol per name, never equal to a string
//   path         a list of keys: numbers (list indices) and strings (map keys)
//   a spot       in an answer: its path, {"keys": path} for a keys spot, or "change" for the change
//                spot; spots in any order
//
//   {"op":"spot","source","id","path","keys"?}  {}  a read's spot, made or found; keys: true, a read
//                                                 of the keys at path only
//   {"op":"change","source","id"}            {}  the change spot, made or found
//   {"op":"mark","source","id","patches"}    {"spots":[...]}  what the patches mark, each once
//   {"op":"event","source","id"}             {"spots":[...]}  a whole-node event at that key
//   {"op":"release","source","id","path","keys"?}  {}  lets the spot go (no path: the change spot);
//                                                 not there: nothing
//   {"op":"marks","patch","paths","keys"?}   {"marks":[...]}  the rule, a boolean per path (keys: for
//                                                 a keys read)
//   {"op":"kept"}                            {"keys","spots","steps"}  what is kept
//   anything wrong                           {"error": why}
import { createPaths, type Key, marks, type Patch, type Spot } from "./paths.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"

const paths = createPaths<never>()
const symbols = new Map<string, symbol>()
const key = (k: unknown): unknown => {
	if (typeof k === "string") return k
	const name = (k as { symbol?: unknown })?.symbol
	if (typeof name !== "string") throw new Error("a source or id is a string or a symbol")
	let s = symbols.get(name)
	if (s === undefined) symbols.set(name, s = Symbol(name))
	return s
}
const shown = (s: Spot<never>) => s.path === null ? "change" : s.keys ? { keys: s.path } : s.path

function answer(r: Request): Answer {
	switch (r.op) {
		case "spot":
			paths.spot(key(r.source), key(r.id), r.path, r.keys === true)
			return {}
		case "change":
			paths.change(key(r.source), key(r.id))
			return {}
		case "mark":
			return { spots: paths.mark(key(r.source), key(r.id), r.patches).map(shown) }
		case "event":
			return { spots: paths.event(key(r.source), key(r.id)).map(shown) }
		case "release": {
			// made, then let go: a spot not there stays not there
			const s = r.path === undefined
				? paths.change(key(r.source), key(r.id))
				: paths.spot(key(r.source), key(r.id), r.path, r.keys === true)
			paths.release(s)
			return {}
		}
		case "marks":
			return { marks: r.paths.map((p: Key[]) => marks(r.patch, p, r.keys === true)) }
		case "kept":
			return paths.kept()
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
