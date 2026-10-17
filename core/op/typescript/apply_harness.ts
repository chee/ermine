// apply (apply.ts) and invert (invert.ts) on the line protocol (conformance/typescript/harness.ts).
// Nothing lasts between lines. Another implementation joins by speaking this (HARNESS). A first
// argument: another module's apply to test instead (core/op/typescript/optim/*.ts). The suites
// apply and invert are both asked of it.
//
// { op: "apply", value?, patches, cow? }
//    value: the value the patches are applied to; absent: nothing there (null is a value)
//    patches: a list, each as apply.ts has them (anything else in it: not-a-patch)
//    cow: false: the patches change the value in place (apply's cow option). The answer is the
//    same as without it. Anything but false: a copy. Other fields of the request: not read
//    → { value? }                  the value after them; absent ({}): nothing there
//    → { error: { code, patch } }  an ApplyError: its code and the patch's index (from 0)
//
// { op: "invert", value?, patches, cow? }
//    the undo of the patches on value (invert.ts); value, patches, cow as apply's. With
//    cow: false the undo is the one apply builds changing the value in place: the same undo
//    → { undo }                    the undo's patches, in the order to apply them, a value in
//                                  them in the JSON form, an index or position of -0 as 0.
//                                  none: []. Which patches is each implementation's: the suite
//                                  pins only that they undo (suite.json "undoes", conformance/
//                                  run.ts): asked back of the harness, apply(value after, undo)
//                                  is value, and apply(value, the undo of that undo) is the value
//                                  after again; maps by content. An error is pinned exactly
//    → { error: { code, patch } }  an ApplyError: its code and the patch's index; as apply's
//
// A move's undo: moved back, else fallen back. decided by the patch's shape and these checks,
// never by trying it. fallen back: the landing's undo (a put's or a span's), then what was taken
// put back (its removal's undo). back: the gap the take left: a span's [c, c], a list element's
// list [i, i], else the take's path. raised: an index of P through back's list, at or past the
// gap, plus what was put back there
//    landing unranged at P (old: what it replaced, if anything), the first that fits:
//      P []: fallen back
//      a span taken (n positions): fallen back if a lone surrogate met another at its edges, or
//      the take's path is P or under it. else { back, move: { path: P, range: [0, n] } } (none
//      when n is 0), then old put at P raised by n, or P raised removed
//      P a list's index k: old put after it first ({ P's list, range: [k + 1, k + 1], value:
//      [old] }), then { back, move: { path: P } }. fallen back if back's path is under P (P
//      itself is fine)
//      P a map key: { back, move: { path: P } }, then old put at P raised by 1 (the key goes
//      last; nothing there before: the move alone). fallen back if back's path is P or under it
//    landing in a span [a, b) at P (what moved now its [a, a + size]; t what the span held):
//      t put after what landed ({ path: P, range: [a + size, a + size], value: t }, none when
//      t is empty), then { back, move: [...P, a] for one element into a list, else P's
//      [a, a + size] } (none when an empty span was taken). fallen back if back lies inside what
//      that move takes, a list's element landed in a string or typed array, a lone surrogate met
//      another at the take's edges or the landing's, or what moved ends in a lone high and t
//      begins with a lone low
//
// A patch: { path, range?, value?, move? }; fields beyond these, here or in move, not read
//    path: a list of keys. a string: a map's key (any string: "", "__proto__", NUL, a lone
//    surrogate). a whole number >= 0: a list's index (-0 is 0; 2^53, 1e300: numbers, past the end)
//    range: [a, b], whole numbers >= 0: the span a ... b - 1 of the string (in code points, a lone
//    surrogate one, a lone high then a lone low one pair), list or typed array at path. bytes
//    have no span: one whole value
//    value: put there. without value or move: a removal
//    move: { path, range? }: what is there taken out first, then put at the target, in what is
//    left, as a value. with value, or a move holding value or move: not-a-patch
// What each does (the patches in order, each on what the last left):
//    path, value: put. a map's key kept in its place, a new key last; a list's index must be
//    there (no append); [] the whole
//    path alone: removed. a list's element: the rest close up. a missing map key: nothing. []:
//    nothing there after
//    range, value: the span replaced; value of the sequence's kind (a string; a list, its
//    elements go in; a typed array of the same kind)
//    range alone: the span removed
//    move, ranged from: the span taken is a string, list or typed array of its kind (empty too)
//    move, unranged from, to a span: into a list as one element; into a string or typed array
//    only a string or one of its kind
//    move onto itself (one path, neither ranged): nothing changes, but it must be there
//    nothing there: only a put at [] makes a value; any other patch no-key
// The code: of the first patch refused, nothing of the call kept. Within the patch, the first of:
//    not-a-patch   a shape no patch has, before anything else of the patch
//    no-key        nothing there, and not a put at []
//    into-itself   a move to a place inside what it takes, before its paths are walked
//    the path walked, key by key: into a list a number (else wrong-kind) there (else no-key);
//    into a map a string (else wrong-kind) there (else no-key); into anything else wrong-kind.
//    the last key of a put or a removal: wrong-kind as along the way, no-key for a list's index
//    a span: reversed (a > b) range; the target no string, list or typed array wrong-kind; past
//    the end range; the value not of the target's kind wrong-kind
//    a move: its take first (as a removal or a span: a missing map key no-key), then its landing.
//    a span of the root as the landing of the root's own take: nothing there, no-key
// A map's keys are answered in their order (the suites are ordered); keys that read as array
// indices ("0", "10") are not compared in order (the runner parses answers in JavaScript)
//
// Values (the request's, a patch's, the answer's) in ENCODING.tex's JSON form
// (conformance/typescript/form.ts). Unlike ENCODING.tex, a string may hold lone surrogates
// (\udxxx): apply counts each as a position. -0 is written -0 and kept as a value. A form that
// stands for no value (bytes not in base64, an element out of its kind's range, an unknown tag):
// not understood
//
// Checked here, for every implementation: the value given and the patches' values are unchanged
// after the call (an invert's too). With cow: false instead: a refused call leaves the value and
// the patches' values as they were (by content, a key put back going last); a good one answers the
// value given itself, when that is a list or a map and no patch has the whole for a place.
// Anything not understood (an unknown op, patches missing or not a list, a value not in the JSON
// form, a line not JSON), or that broken: { error: why }, a string, its words free; the next line
// is answered as ever.
import { ApplyError as Refused, type Patch } from "@ermine/op/apply"
import invert from "@ermine/op/invert"
import { line, revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

// the apply to test: @ermine/op/apply, or a module given as the first argument (a path from the
// working directory), such as core/op/typescript/optim/final.ts
const { default: apply, ApplyError } =
	(Deno.args[0] === undefined ? await import("@ermine/op/apply") : await import(
		new URL(Deno.args[0], `file://${Deno.cwd()}/`).href
	)) as typeof import("@ermine/op/apply")

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

const whole = (v: unknown) => line(toJson(v))
// by content: a key put back by an undo goes last in its order
const sorted = (v: unknown) =>
	isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
const content = (v: unknown) => line(toJson(v), sorted)

function answer(r: Request): Record<string, unknown> {
	if (!isMap(r) || (r.op !== "apply" && r.op !== "invert")) {
		return { error: `unknown op ${isMap(r) ? r.op : r}` }
	}
	if (!Array.isArray(r.patches)) return { error: "patches: not a list" }
	const value = Object.hasOwn(r, "value") ? revive(r.value) : undefined
	const patches = r.patches.map((p: unknown) =>
		isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: revive(p.value) } : p
	) as Patch[]
	const inPlace = r.cow === false
	const form = inPlace ? content : whole
	const before = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
	const same = (after: string[]) => after.every((a, i) => a === before[i])
	const wholes = patches.some((p) =>
		!isMap(p) || !Array.isArray(p.path) || p.path.length === 0 ||
		isMap(p.move) && Array.isArray(p.move.path) && p.move.path.length === 0
	)
	if (r.op === "invert") {
		let out: Record<string, unknown>
		try {
			let undo: Patch[]
			if (inPlace) {
				undo = []
				apply(value, patches, { undo, cow: false })
			} else undo = invert(value, patches)
			out = { undo: undo.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p) }
		} catch (e) {
			if (!(e instanceof Refused)) throw e
			out = { error: { code: e.code, patch: e.patch } }
		}
		const after = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
		return (inPlace && !out.error) || same(after) ? out : { error: "a value given changed" }
	}
	let out: Record<string, unknown>
	let v: unknown
	try {
		v = apply(value, patches, { cow: !inPlace })
		out = v === undefined ? {} : { value: toJson(v) }
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		out = { error: { code: e.code, patch: e.patch } }
	}
	const after = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
	if (inPlace && !out.error) {
		if (
			!wholes && v !== undefined &&
			(Array.isArray(value) || isMap(value) && !ArrayBuffer.isView(value)) && v !== value
		) {
			return { error: "not the value given" }
		}
		return out
	}
	if (!same(after)) return { error: "a value given changed" }
	return out
}

if (import.meta.main) await serve(answer)
