// paths (paths.ts) on the line protocol (conformance/typescript/harness.ts). Another implementation
// joins by speaking this (HARNESS).
//
//   source, id   a string, or {"symbol": name}: one symbol per name, never equal to a string.
//                strings equal by content, any string ("", NUL, lone surrogates). a key: (source, id)
//   path         a list of keys: whole numbers 0 <= n < 1e15 (list indices; -0 is 0, written back
//                as 0) and strings (map keys, any string); 1 and "1" differ; anything else an error
//   patch        op's, as apply takes it: {path, range?: [a, b], value?, move?: {path, range?}};
//                one malformed (not a map, a path not a path, a range not two whole numbers) is an error
//   keys         true: a keys read; anything else, a plain read
//
// the rule (marks; mark is it per spot). a patch's places: a move's take {path: move.path, range:
// move.range, put: no, n: 0} then its landing {path, range, put: yes, n: the take's b - a, or 1};
// else one {path, range, put: has value, n: value's length when a list, 0 when no value, else not
// known}. a removal at an index: unranged, no put, its last key a number. a place Q reaches a
// plain read of P when
//   P is Q or a prefix of it (the change is inside what was read)
//   Q is a removal at an index k, P runs beside it to Q's parent then a number > k, then anything
//   Q is a proper prefix of P and Q unranged (what P read was replaced or removed)
//   Q ranged [a, b), P = Q + [k, ...], k a number: k in [a, b) when n is b - a (the length held),
//     else k >= a (past the end too)
// a keys read of P: when Q is no longer than P, as a plain read; else only when Q is P plus one
// key and unranged (a key set, removed, taken or landed). a batch marks what any patch marks, each
// patch in its own coordinates
//
// spots: held by key, in a trie of path steps per key; a step is held while a spot is at or under
// it. a spot in an answer: its path, {"keys": path} for a keys spot, {"here": path} for a here
// spot, "change" for the change spot.
// mark's order: the change spot, then each patch's places in turn; a spot already given is
// skipped. a place walks from the key's top down its path: at each step above the place, its
// spot, then its here spot when the place's next step is a number (into a list); at the step just above an unranged place, its keys spot too; above a removal at index k,
// the number kids past k in index order, wholly; then on into the next step (none held: the place
// is done). at the place's step: unranged, wholly; ranged [a, b), its spot, its keys spot, its here spot, then
// its number kids from a in index order, below b when n is b - a, each wholly. wholly: the
// step's spot, its keys spot, its here spot, then each kid wholly in the order the kid steps were made (a step
// let go and made again comes last)
//
//   {"op":"spot","source","id","path","keys"?,"here"?}  {}  a read's spot, made or found; keys: true,
//                                                 a read of the keys at path only, a spot of its own;
//                                                 here: true, a read of what is at path itself (a map
//                                                 as a map), a spot of its own
//   {"op":"change","source","id"}            {}  the change spot, made or found
//   {"op":"mark","source","id","patches"}    {"spots":[...]}  what the patches mark, each once; a key
//                                                 with no spots: [] (nothing is made)
//   {"op":"event","source","id"}             {"spots":[...]}  a whole-node event at that key: a mark
//                                                 of [{"path":[]}]
//   {"op":"release","source","id","path"?,"keys"?,"here"?}  {}  lets the spot go (no path: the change spot);
//                                                 not there: nothing. steps left with nothing go, then
//                                                 the key
//   {"op":"marks","patch","paths","keys"?,"here"?}   {"marks":[...]}  the rule, a boolean per path in
//                                                 order (keys: for a keys read; here: for a here read);
//                                                 no key, nothing held
//   {"op":"held"}                            {"keys","spots","steps"}  what is held: keys with a spot,
//                                                 spots, and steps (per key its top, and each other
//                                                 prefix of its spots' paths, once)
//   anything wrong                           {"error": why}; why is not compared. no op, an unknown
//                                                 op, a source or id neither string nor symbol, spot
//                                                 with no path or a bad one, mark with no list of
//                                                 patches (held key or not) or a malformed patch, marks
//                                                 with no patch or paths or a bad path. nothing is held
//                                                 by one
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
// a path: a list of whole numbers 0 <= n < 1e15 and strings; anything else is an error
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
// a place of a patch: a map with a path, and a range of two whole numbers when it has one
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
			// made, then let go: a spot not there stays not there
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
