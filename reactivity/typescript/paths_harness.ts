// Paths (paths.ts) on the line protocol (conformance/typescript/harness.ts); HARNESS names
// another implementation that speaks it.
// source, id: a string, or {"symbol": name}. path: whole numbers 0 <= n < 1e15 and strings; 1 and "1"
// differ. patch: {path, range?: [a, b], value?, move?: {path, range?}}. A spot in an answer is its
// path, {"keys": path}, {"here": path}, or "change".
// {"op":"spot","source","id","path","keys"?,"here"?}  -> {}  make or find a read's spot
// {"op":"change","source","id"}                       -> {}  make or find the change spot
// {"op":"mark","source","id","patches"}               -> {"spots":[...]}  spots the patches mark, each once
// {"op":"event","source","id"}                        -> {"spots":[...]}  same as mark of [{"path":[]}]
// {"op":"release","source","id","path"?,"keys"?,"here"?} -> {}  no path: the change spot
// {"op":"marks","patch","paths","keys"?,"here"?}      -> {"marks":[...]}  a boolean per path
// {"op":"held"}                                       -> {"keys","spots","steps"}  counts held
// anything wrong                                      -> {"error": why}  why is not compared
// Order within mark: the change spot first, then each patch's places in turn, each walking down
// its path from the key's top (see paths.ts).
import { createPaths, type Key, marks, type Patch, type Spot } from "./paths.ts"
import { type Answer, type Request, serve } from "../../conformance/typescript/harness.ts"

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
function path(x: unknown): Key[] {
	if (!Array.isArray(x)) throw new Error("a path is a list")
	for (const k of x) {
		if (typeof k === "string") continue
		if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= 1e15) {
			throw new Error("a path key is a string or a whole number below 1e15")
		}
	}
	return x
}
function place(x: unknown): void {
	if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("a patch is a map")
	const m = x as { path?: unknown; range?: unknown }
	path(m.path)
	if (m.range === undefined) return
	if (!Array.isArray(m.range) || m.range.length !== 2 || !m.range.every(Number.isInteger)) {
		throw new Error("a range is two whole numbers")
	}
}
function patches(x: unknown): Patch[] {
	if (!Array.isArray(x)) throw new Error("patches is a list")
	for (const p of x) {
		place(p)
		if (p.move !== undefined) place(p.move)
	}
	return x
}
const shown = (s: Spot<never>) =>
	s.path === null ? "change" : s.keys ? { keys: s.path } : s.here ? { here: s.path } : s.path

function answer(r: Request): Answer {
	switch (r.op) {
		case "spot":
			paths.spot(key(r.source), key(r.id), path(r.path), r.keys === true, r.here === true)
			return {}
		case "change":
			paths.change(key(r.source), key(r.id))
			return {}
		case "mark":
			return { spots: paths.mark(key(r.source), key(r.id), patches(r.patches)).map(shown) }
		case "event":
			return { spots: paths.event(key(r.source), key(r.id)).map(shown) }
		case "release": {
			// Made, then released: a spot that is not there stays not there.
			const s = r.path === undefined
				? paths.change(key(r.source), key(r.id))
				: paths.spot(key(r.source), key(r.id), path(r.path), r.keys === true, r.here === true)
			paths.release(s)
			return {}
		}
		case "marks": {
			if (!Array.isArray(r.paths)) throw new Error("paths is a list")
			const [patch] = patches([r.patch])
			return {
				marks: r.paths.map((p: unknown) =>
					marks(patch, path(p), r.keys === true, r.here === true)
				),
			}
		}
		case "held":
			return paths.held()
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
