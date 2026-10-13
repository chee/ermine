// the undo of patches: the patches that take what they make back to the value they were given
//   apply(apply(value, patches, o), invert(value, patches, o), o): value
// on apply's terms (apply.ts): undefined is nothing there, the list option is apply's, a string's
// positions are code points. patches apply refuses: its ApplyError, thrown (apply decides). the
// list option given a value not a list: the undo puts it back, which the list option refuses
// the undo is in the order to apply it, the last patch's first. a patch may take several, or
// none (a removal of a missing map key). a map's key put back goes last in its order: patches
// cannot place a key (the canonical encoding sorts keys anyway)
// a move moves back where that is exact; else what it put is undone and what it took put back
// what the undo holds is shared with the value and the patches: never change it
import apply, { type Key, type Patch, type Target } from "./apply.ts"
import { count, type Hint, near, walk } from "@ermine/util/walk-string"

export type Options = {
	// apply's: nothing there starts as [], anything but a list is wrong-kind, a list left empty is
	// nothing
	list?: boolean
}

type Typed = Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
const isList = Array.isArray

// where nothing is there
const ABSENT = Symbol("absent")

// a lone high met by a lone low is one pair: one position
const high = (c: number) => (c & 0xfc00) === 0xd800
const low = (c: number) => (c & 0xfc00) === 0xdc00

const same = (a: readonly Key[], b: readonly Key[]) =>
	a.length === b.length && a.every((k, i) => k === b[i])
// b is a, or under it
const within = (a: readonly Key[], b: readonly Key[]) =>
	a.length <= b.length && a.every((k, i) => k === b[i])

// apply's into-itself: p's place lies inside what from takes
function under(p: Target, from: Target) {
	const f = from.path, q = p.path
	if (q.length < f.length || !f.every((k, i) => k === q[i])) return false
	if (!from.range) return q.length > f.length
	if (q.length === f.length) return false
	const k = q[f.length]
	return typeof k === "number" && k >= from.range[0] && k < from.range[1]
}

// path, once one element is put in at the gap of at, a list's range
function shift(path: readonly Key[], at: Target): readonly Key[] {
	const n = at.path.length
	if (!at.range || path.length <= n || !within(at.path, path)) return path
	const i = path[n] as number
	if (i < at.range[0]) return path
	const out = path.slice()
	out[n] = i + 1
	return out
}

// the patches walked on a copy of the value, each undone as it lands. apply has checked them:
// nothing is checked here
function createWork(root: unknown) {
	// made here: may change in place, until the undo holds it
	const own = new Set<object>()
	const mine = <T extends object>(c: T): T => (own.add(c), c)
	const copy = <T extends object>(v: T): T =>
		own.has(v) ? v : mine((isList(v) ? v.slice() : { ...v }) as T)
	// v and what of it was made here: never changed here again
	function keep(v: unknown) {
		if (v === null || typeof v !== "object" || !own.delete(v)) return
		if (isList(v)) { for (const x of v) keep(x) }
		else for (const k in v) keep((v as Record<string, unknown>)[k])
	}
	const undo: Patch[] = []
	const push = (p: Patch | null) => {
		if (p === null) return
		if ("value" in p) keep(p.value)
		undo.push(p)
	}

	function get(path: readonly Key[]): unknown {
		let v = root
		for (const k of path) v = (v as Record<Key, unknown>)[k]
		return v
	}
	// the container holding path's last key, made own along the way
	function parent(path: readonly Key[]): Record<Key, unknown> {
		let v = root = copy(root as object)
		for (let i = 0; i < path.length - 1; i++) {
			const at = v as Record<Key, unknown>
			v = at[path[i]] = copy(at[path[i]] as object)
		}
		return v as Record<Key, unknown>
	}
	// what is at path becomes w (undefined: removed); what was there (ABSENT: nothing)
	function set(path: readonly Key[], w: unknown): unknown {
		if (!path.length) {
			const old = root
			root = w === undefined ? ABSENT : w
			return old
		}
		const at = parent(path), k = path[path.length - 1]
		if (isList(at)) {
			const old = at[k as number]
			if (w === undefined) at.splice(k as number, 1)
			else at[k as number] = w
			return old
		}
		if (!Object.hasOwn(at, k)) {
			// a key of "__proto__" is a key, never the prototype
			if (w === undefined) return ABSENT
			if (k !== "__proto__") at[k] = w
			else {
				Object.defineProperty(at, k, {
					value: w,
					writable: true,
					enumerable: true,
					configurable: true,
				})
			}
			return ABSENT
		}
		const old = at[k]
		if (w === undefined) delete at[k]
		else at[k] = w
		return old
	}

	// the last string made here, and where it was left: the next splice walks from there (apply's)
	let memo: (Hint & { s: string }) | null = null
	// the last splice's: what the span held, how many positions went in, whether a lone high met a
	// lone low at an edge
	let taken: unknown, size = 0, joined = false
	// the span [a, b) at path becomes w (undefined: nothing); its undo (null: nothing changed)
	function splice(path: readonly Key[], a: number, b: number, w: unknown): Patch | null {
		const v = get(path)
		let start = a, end: number, back: unknown
		if (typeof v === "string") {
			const [x, y] =
				(memo !== null && memo.s === v ? near(v, a, b, false, memo) : walk(v, a, b))!
			const add = (w ?? "") as string
			// a lone high met by a lone low: l at the left edge, r at the right; with nothing put
			// in, both edges are one
			let l = 0, r = 0
			if (add) {
				if (high(v.charCodeAt(x - 1)) && low(add.charCodeAt(0))) l = 1
				if (high(add.charCodeAt(add.length - 1)) && low(v.charCodeAt(y))) r = 1
			} else if (high(v.charCodeAt(x - 1)) && low(v.charCodeAt(y))) l = r = 1
			const o = v.slice(0, x) + add + v.slice(y)
			taken = v.slice(x, y)
			size = add ? count(add) : 0
			joined = l + r > 0
			memo = joined ? null : { s: o, n: -1, k: a + size, i: x + add.length }
			set(path, o)
			// the undo widens over a pair made, and puts its other half back with what was there
			start = a - l
			end = start + size + (add ? 0 : l)
			back = v.slice(x - l, y + r)
		} else if (isList(v)) {
			const l = copy(v), add = (w ?? []) as unknown[]
			taken = back = mine(l.splice(a, b - a, ...add))
			size = add.length
			joined = false
			set(path, l)
			end = a + size
		} else {
			const t = v as Typed, add = w as Typed | undefined
			size = add ? add.length : 0
			const n = new (t.constructor as new (n: number) => Typed)(t.length - (b - a) + size)
			n.set(t.subarray(0, a), 0)
			if (add) n.set(add, a)
			n.set(t.subarray(b), a + size)
			taken = back = t.slice(a, b)
			joined = false
			set(path, n)
			end = a + size
		}
		const empty = (back as ArrayLike<unknown>).length === 0
		if (empty && start === end) return null
		return empty ? { path, range: [start, end] } : { path, range: [start, end], value: back }
	}

	function step(p: Patch) {
		if (p.move) return move(p, p.move)
		const path = p.path
		if (p.range) return push(splice(path, p.range[0], p.range[1], p.value))
		if ("value" in p) {
			const old = set(path, p.value)
			return push(old === ABSENT ? { path } : { path, value: old })
		}
		if (!path.length) return push({ path, value: set(path, undefined) })
		const up = path.slice(0, -1), k = path[path.length - 1] as number
		const listed = isList(get(up))
		const old = set(path, undefined)
		// a missing map key: nothing
		if (old === ABSENT) return
		push(listed ? { path: up, range: [k, k], value: mine([old]) } : { path, value: old })
	}

	// a move is a take, then a landing in what is left: its undo is the landing's, then the take's.
	// better, one move back, with what the landing replaced put beside what moved first: exact
	// unless a path back would be into-itself, a lone surrogate met another (a string's), or what
	// moved cannot be moved back whole (the whole, or a string or typed array out of a list)
	function move(p: Patch, from: Target) {
		const P = p.path, F = from.path
		// onto itself: nothing changes
		if (!p.range && !from.range && same(P, F)) return
		let m: unknown, untake: Patch | null, back: Target, taking = false, listed = false
		if (from.range) {
			const c = from.range[0]
			untake = splice(F, c, from.range[1], undefined)
			m = taken, taking = joined
			back = { path: F, range: [c, c] }
		} else {
			const up = F.slice(0, -1), f = F[F.length - 1] as number
			listed = isList(get(up))
			m = set(F, undefined)
			back = listed ? { path: up, range: [f, f] } : { path: F }
			untake = listed ? { path: up, range: [f, f], value: mine([m]) } : { path: F, value: m }
		}
		// what moved stays in the value, still walked: the undo's copy of it is never changed
		const fall = (undone: Patch | null) => (push(undone), push(untake))

		if (!p.range) {
			const up = P.slice(0, -1), k = P[P.length - 1] as number
			const listy = P.length > 0 && isList(get(up))
			const old = set(P, m)
			const unset: Patch = old === ABSENT ? { path: P } : { path: P, value: old }
			if (!P.length) return fall(unset)
			if (from.range) {
				// the span back, out of the sequence it became, which is then put back
				if (taking || within(P, F)) return fall(unset)
				const n = from.range[1] - from.range[0]
				if (n) push({ ...back, move: { path: P, range: [0, n] } })
				return push(unset)
			}
			const there: Patch = { ...back, move: { path: P } }
			if (listy) {
				// what was replaced goes in beside it first
				if (under(there, there.move!)) return fall(unset)
				push({ path: up, range: [k + 1, k + 1], value: mine([old]) })
				return push(there)
			}
			if (old === ABSENT) return under(there, there.move!) ? fall(unset) : push(there)
			// a map's key: put back once what moved has left it
			if (within(P, back.path)) return fall(unset)
			push(there)
			return push({ path: shift(P, back), value: old })
		}

		const [a, b] = p.range
		// one element into a list: as a list of one
		const one = !from.range && isList(get(P))
		const unput = splice(P, a, b, one ? [m] : m)
		const t = taken as ArrayLike<unknown>
		let there: Patch
		if (one) there = { ...back, move: { path: [...P, a] } }
		else {
			// a lone high at the end of what moved would meet a lone low that begins what it replaced
			const meets = typeof m === "string" && m.length > 0 && t.length > 0 &&
				high(m.charCodeAt(m.length - 1)) && low((t as string).charCodeAt(0))
			if (listed || taking || joined || meets) return fall(unput)
			there = { ...back, move: { path: P, range: [a, a + size] } }
		}
		if (under(there, there.move!)) return fall(unput)
		if (t.length) push({ path: P, range: [a + size, a + size], value: t })
		if (size || !from.range) push(there)
	}

	return { step, undo }
}

// the undo of the patches on value, in the order to apply it
export default function invert(
	value: unknown,
	patches: Iterable<Patch>,
	options: Options = {},
): Patch[] {
	const list = options.list === true
	const ps = isList(patches) ? patches as Patch[] : [...patches]
	apply(value, ps, { list })
	const { step, undo } = createWork(value !== undefined ? value : list ? [] : ABSENT)
	// each patch's undo starts at its mark
	const marks: number[] = []
	for (const p of ps) marks.push(undo.length), step(p)
	const out: Patch[] = []
	for (let i = marks.length - 1, end = undo.length; i >= 0; end = marks[i--]) {
		for (let j = marks[i]; j < end; j++) out.push(undo[j])
	}
	return out
}
