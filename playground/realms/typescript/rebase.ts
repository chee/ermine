// rebase: a realm's patches, made on the value it saw, moved past the page's that landed since. OT
// with one authority: ours are moved past the page's, never the page's past ours
//
//   rebase(theirs, ours)   ours as landing after theirs: positions moved, what theirs took out gone
//
// by a page patch at path L:
//   a span [a, b) replaced by n: positions after it move by n − (b − a); elements inside it are
//     gone. ours over it: split around what theirs put in; ours inside it: after what theirs put in
//   a put at L: nothing moves; taken out, anything of ours under L is gone; ours at L lands after
//   a move: its take, then its landing; ours in what moved goes with it
// same-spot inserts: ours after theirs. ours as a sequence: each moved past theirs, then theirs
// past it for the next
//
// open: lone surrogates not counted in code points; ours inside what theirs replaced whole left as
// is; a move of ours that splits or loses its source or landing is dropped
import type { Key, Patch, Span, Target } from "@ermine/op/apply"

type Path = readonly Key[]
// one change to positions: a span replaced by n, or a put at a path (removed: taken out)
type Step =
	| { kind: "splice"; path: Path; a: number; b: number; n: number }
	| { kind: "put"; path: Path; removed: boolean }
	| {
		kind: "move"
		take: Step
		land: Step
		// an element or key taken, and where it went: what was under it goes there
		from: Path
		range?: Span
		to: Path
	}

const same = (x: Path, y: Path) => x.length === y.length && x.every((k, i) => k === y[i])
const under = (x: Path, y: Path) => x.length > y.length && y.every((k, i) => k === x[i])

function size(v: unknown): number {
	if (typeof v === "string") {
		let n = 0
		for (const _ of v) n++
		return n
	}
	if (Array.isArray(v)) return v.length
	if (ArrayBuffer.isView(v)) return (v as unknown as ArrayLike<unknown>).length
	return 0
}

// a patch's change to positions
function stepOf(p: Patch): Step {
	if (p.move !== undefined) {
		const f = p.move
		const k = f.range ? f.range[1] - f.range[0] : 1
		const last = f.path[f.path.length - 1]
		let take: Step, from: Path, range: Span | undefined
		if (f.range) {
			take = { kind: "splice", path: f.path, a: f.range[0], b: f.range[1], n: 0 }
			from = f.path
			range = f.range
		} else if (typeof last === "number") {
			take = { kind: "splice", path: f.path.slice(0, -1), a: last, b: last + 1, n: 0 }
			from = f.path.slice(0, -1)
			range = [last, last + 1]
		} else {
			take = { kind: "put", path: f.path, removed: true }
			from = f.path
		}
		const land: Step = p.range
			? { kind: "splice", path: p.path, a: p.range[0], b: p.range[1], n: k }
			: { kind: "put", path: p.path, removed: false }
		return {
			kind: "move",
			take,
			land,
			from,
			range,
			to: p.range ? [...p.path, p.range[0]] : p.path,
		}
	}
	if (p.range) {
		return { kind: "splice", path: p.path, a: p.range[0], b: p.range[1], n: size(p.value) }
	}
	return { kind: "put", path: p.path, removed: !("value" in p) }
}

// a target past one step: none (gone), or one or more (a span split around what the step put in).
// after: a tie (an insert at the step's own spot) goes after it
function past(t: Target, s: Step, after: boolean): Target[] {
	if (s.kind === "put") {
		if (s.removed && (under(t.path, s.path) || (same(t.path, s.path) && t.range))) return []
		return [t]
	}
	if (s.kind === "move") {
		// what was under the taken element goes with it
		if (s.range && under(t.path, s.from) && typeof t.path[s.from.length] === "number") {
			const i = t.path[s.from.length] as number
			if (i >= s.range[0] && i < s.range[1]) {
				const to = s.to.length > 0 && s.land.kind === "splice"
					? [...s.land.path, s.land.a + (i - s.range[0])]
					: s.to
				return [{ ...t, path: [...to, ...t.path.slice(s.from.length + 1)] }]
			}
		}
		if (!s.range && under(t.path, s.from)) {
			return [{ ...t, path: [...s.to, ...t.path.slice(s.from.length)] }]
		}
		return past(t, s.take, after).flatMap((x) => past(x, s.land, after))
	}
	const { path: L, a, b, n } = s
	const delta = n - (b - a)
	// an element through L
	if (under(t.path, L) && typeof t.path[L.length] === "number") {
		const i = t.path[L.length] as number
		if (i < a) return [t]
		if (i >= b) {
			const path = [...t.path]
			path[L.length] = i + delta
			return [{ ...t, path }]
		}
		return []
	}
	if (!same(t.path, L) || t.range === undefined) return [t]
	const [c, d] = t.range
	// before the step's span, or at its start when it takes something (an insert there is first)
	if (d < a || (d === a && (c < a || b > a || !after))) return [t]
	// after it
	if (c > b || (c === b && (a < b || after))) return [{ ...t, range: [c + delta, d + delta] }]
	// over it: the part before, the part after, what the step put in kept between
	const out: Target[] = []
	if (c < a) out.push({ ...t, range: [c, Math.min(d, a)] })
	if (d > b) out.push({ ...t, range: [a + n, d + delta] })
	if (out.length === 0) out.push({ ...t, range: [a + n, a + n] })
	return out
}

// a patch past a step: the patches it is now (none: gone). split, the value goes in the first
// piece, the rest are removals, each in the coordinates the ones before leave
function patchPast(p: Patch, s: Step, after: boolean): Patch[] {
	if (p.move !== undefined) {
		const at = past({ path: p.path, range: p.range }, s, after)
		const from = past(p.move, s, after)
		if (at.length !== 1 || from.length !== 1) return []
		return [{ ...tidy(at[0]), move: tidy(from[0]) }]
	}
	const pieces = past({ path: p.path, range: p.range }, s, after)
	if (pieces.length <= 1) return pieces.map((t) => withValue(p, t))
	const out: Patch[] = []
	let shift = 0
	pieces.forEach((t, j) => {
		const [c, d] = t.range!
		const q: Patch = j === 0 && "value" in p
			? { path: t.path, range: [c + shift, d + shift], value: p.value }
			: { path: t.path, range: [c + shift, d + shift] }
		out.push(q)
		shift += (j === 0 ? size(p.value) : 0) - (d - c)
	})
	return out
}

const tidy = (t: Target): Target => t.range ? { path: t.path, range: t.range } : { path: t.path }
function withValue(p: Patch, t: Target): Patch {
	const q: Patch = t.range ? { path: t.path, range: t.range } : { path: t.path }
	return "value" in p ? { ...q, value: p.value } : q
}

// ours past theirs: theirs landed first, ours made on the value before them
export function rebase(theirs: readonly Patch[], ours: readonly Patch[]): Patch[] {
	let out = [...ours]
	for (const t of theirs) {
		const next: Patch[] = []
		// t as each of ours sees it: moved past the ones of ours before
		let cur: Patch[] = [t]
		for (const o of out) {
			let mine: Patch[] = [o]
			for (const c of cur) mine = mine.flatMap((m) => patchPast(m, stepOf(c), true))
			next.push(...mine)
			cur = cur.flatMap((c) => patchPast(c, stepOf(o), false))
		}
		out = next
	}
	return out
}
