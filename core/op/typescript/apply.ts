// patches applied to one value: the value after them. what a patch touches is new, the rest is
// shared; a copy made here may change in place, since only the end is ever seen. any patch
// invalid: it throws, and nothing changes. asked for, the undo of the patches too (invert.ts says
// what it is), built as each lands: one walk
import { count, type Hint, joins, near, walk } from "@ermine/util/walk-string"

export type Key = string | number
export type Span = readonly [number, number]
// what a patch aims at: a path, and a span of the string, list or typed array there
export type Target = { path: readonly Key[]; range?: Span }
// a value put at the target (none: what is there removed), or what is at move taken there
export type Patch = Target & { value?: unknown; move?: Target }

export type Options = {
	// the value is a list: nothing there starts as [], anything but a list is wrong-kind, and a list
	// left empty is nothing (it was there only when not empty)
	list?: boolean
	// the undo of the patches (invert.ts) is pushed here once all have landed, in the order to
	// apply it; a call that throws leaves it untouched
	undo?: Patch[]
}

export type Code = "not-a-patch" | "no-key" | "range" | "wrong-kind" | "into-itself"

export class ApplyError extends Error {
	constructor(readonly code: Code, readonly patch: number) {
		super(`${code} (patch ${patch})`)
	}
}

// a typed array: a sequence of its elements. bytes, a Uint8Array, are one whole value: never
// spliced (MUTATE.tex)
type Typed = Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
const typed = (v: unknown): v is Typed =>
	ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof Uint8Array)
const isList = Array.isArray
function isMap(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || isList(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}

// where nothing is there yet
const ABSENT = Symbol("absent")

class Fail {
	constructor(readonly code: Code) {}
}
const fail = (code: Code): never => {
	throw new Fail(code)
}

// a lone high met by a lone low is one pair: one position
const high = (c: number) => (c & 0xfc00) === 0xd800
const low = (c: number) => (c & 0xfc00) === 0xdc00

function shape(p: Patch): boolean {
	if (p === null || typeof p !== "object" || !isList(p.path)) return false
	if (!p.path.every((k) => typeof k === "string" || Number.isInteger(k) && k >= 0)) return false
	if (p.range !== undefined) {
		const r = p.range
		if (!isList(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n) && n >= 0)) {
			return false
		}
	}
	if (p.move !== undefined) {
		if ("value" in p) return false
		const m = p.move as Patch
		if (m === null || typeof m !== "object" || "value" in m || "move" in m) return false
		return shape(m)
	}
	return true
}

// a move's take, for the undo: what moved, the gap it left (back), what puts it back there
// (untake), whether the take joined lone surrogates (taking) or was out of a list (listed)
type Took = { m: unknown; back: Target; untake: Patch | null; taking: boolean; listed: boolean }

// one edit's content, changed patch by patch; undo: the undo is wanted
function createWork(root: unknown, undo: boolean) {
	// made here: may change in place, until the undo holds it. few, scanned; past 16, a WeakSet
	let own: object[] | WeakSet<object> | undefined
	const mine = <T extends object>(c: T): T => {
		if (own === undefined) own = [c]
		else if (!Array.isArray(own)) own.add(c)
		else if (own.length < 16) own.push(c)
		else (own = new WeakSet(own)).add(c)
		return c
	}
	const copy = <T extends object>(v: T): T =>
		own !== undefined && (Array.isArray(own) ? own.includes(v) : own.has(v))
			? v
			: mine((isList(v) ? v.slice() : { ...v }) as T)
	const work = { root }

	// the container holding path's last key, made own along the way; [] has none
	function parent(path: readonly Key[]): Record<Key, unknown> {
		let v = work.root = copyIn(work.root)
		for (let i = 0; i < path.length - 1; i++) {
			const at = v as Record<Key, unknown>
			const next = at[enter(at, path[i])]
			v = at[path[i]] = copyIn(next)
		}
		return v as Record<Key, unknown>
	}
	function copyIn(v: unknown): object {
		if (v === ABSENT) return fail("no-key")
		if (!isList(v) && !isMap(v)) return fail("wrong-kind")
		return copy(v)
	}
	// k into v, which must be there
	function enter(v: unknown, k: Key): Key {
		if (isList(v)) {
			if (typeof k !== "number") fail("wrong-kind")
			if ((k as number) >= v.length) fail("no-key")
		} else if (isMap(v)) {
			if (typeof k !== "string") fail("wrong-kind")
			if (!Object.hasOwn(v, k)) fail("no-key")
		} else fail("wrong-kind")
		return k
	}
	// what is at path, unchanged; n: only so far along it
	function get(path: readonly Key[], n = path.length): unknown {
		let v = work.root
		if (v === ABSENT && n > 0) fail("no-key")
		for (let i = 0; i < n; i++) v = (v as Record<Key, unknown>)[enter(v, path[i])]
		return v
	}

	// the last string made here, and what is known of it: the next patch to it walks from there
	// (typing: from where the last left off). any string with its content: the same hint
	let memo: (Hint & { s: string }) | null = null
	// the last splice's: what the span held, how many positions went in, whether a lone high met a
	// lone low at an edge
	let taken: unknown, size = 0, joined = false

	// the span [a, b) of what is at path replaced by w (undefined: removed); its undo (null: nothing
	// changed, or none wanted)
	function splice(path: readonly Key[], a: number, b: number, w: unknown): Patch | null {
		const v = get(path)
		if (a > b) fail("range")
		if (typeof v !== "string" && !isList(v) && !typed(v)) fail("wrong-kind")
		let start = a, end: number, back: unknown
		if (typeof v === "string") {
			const at = memo !== null && memo.s === v ? near(v, a, b, false, memo) : walk(v, a, b)
			if (!at) return fail("range")
			if (w !== undefined && typeof w !== "string") fail("wrong-kind")
			const [x, y, n] = at
			const add = (w ?? "") as string, o = v.slice(0, x) + add + v.slice(y), e = x + add.length
			// a lone high met by a lone low: l at the left edge, r at the right (nothing put in: both
			// edges are one). one pair now, a position fewer, and the finger may be inside it. rare:
			// forget, the next walks
			const l = joins(o, x) ? 1 : 0, r = add ? joins(o, e) ? 1 : 0 : l
			size = add ? count(add) : 0
			joined = l + r > 0
			memo = joined ? null : { s: o, n: n >= 0 ? n - (b - a) + size : -1, k: a + size, i: e }
			taken = v.slice(x, y)
			set(path, o)
			// the undo widens over a pair made, and puts its other half back with what was there
			start = a - l
			end = start + size + (add ? 0 : l)
			back = joined ? v.slice(x - l, y + r) : taken
		} else if (isList(v)) {
			if (b > v.length) fail("range")
			if (w !== undefined && !isList(w)) fail("wrong-kind")
			const l = copy(v)
			taken = back = mine(l.splice(a, b - a, ...(w as unknown[] ?? [])))
			size = w ? (w as unknown[]).length : 0
			joined = false
			set(path, l)
			end = a + size
		} else {
			const t = v as Typed
			if (b > t.length) fail("range")
			if (w !== undefined && (!typed(w) || w.constructor !== t.constructor)) fail("wrong-kind")
			size = w ? (w as Typed).length : 0
			joined = false
			const n = new (t.constructor as new (n: number) => Typed)(t.length - (b - a) + size)
			n.set(t.subarray(0, a), 0)
			if (w) n.set(w as Typed, a)
			n.set(t.subarray(b), a + size)
			taken = back = t.slice(a, b)
			set(path, n)
			end = a + size
		}
		if (!un) return null
		const empty = (back as ArrayLike<unknown>).length === 0
		if (empty && start === end) return null
		return empty ? { path, range: [start, end] } : { path, range: [start, end], value: back }
	}
	// what is at path becomes w (undefined: removed, ABSENT at []); what was there (ABSENT: nothing)
	function set(path: readonly Key[], w: unknown): unknown {
		if (path.length === 0) {
			const old = work.root
			work.root = w === undefined ? ABSENT : w
			return old
		}
		const at = parent(path), k = path[path.length - 1]
		if (isList(at)) {
			if (typeof k !== "number") fail("wrong-kind")
			if ((k as number) >= at.length) fail("no-key")
			const old = at[k as number]
			if (w === undefined) at.splice(k as number, 1)
			else at[k as number] = w
			return old
		}
		if (typeof k !== "string") fail("wrong-kind")
		const old = Object.hasOwn(at, k) ? at[k] : ABSENT
		if (w === undefined) delete at[k]
		// a key of "__proto__" is a key: an engine with the setter would set the prototype
		else if (k === "__proto__") {
			Object.defineProperty(at, k, {
				value: w,
				writable: true,
				enumerable: true,
				configurable: true,
			})
		} else at[k] = w
		return old
	}

	// the patch landed: its undo pushed when wanted
	function step(p: Patch): void {
		// nothing there: only a put at the whole
		if (work.root === ABSENT && (p.path.length || p.range || !("value" in p))) fail("no-key")
		if (p.move) return move(p, p.move)
		const w = "value" in p ? p.value : undefined
		if (p.range) {
			const u = splice(p.path, p.range[0], p.range[1], w)
			if (un) un.push(u)
			return
		}
		if (w === undefined && "value" in p) fail("not-a-patch")
		if (w !== undefined || !p.path.length) {
			const old = set(p.path, w)
			if (un) un.push(old === ABSENT ? { path: p.path } : { path: p.path, value: old })
			return
		}
		// removing a missing map key: nothing
		const at = get(p.path, p.path.length - 1), k = p.path[p.path.length - 1]
		if (isMap(at) && typeof k === "string" && !Object.hasOwn(at, k)) return
		const old = set(p.path, undefined)
		if (un) {
			un.push(
				isList(at)
					? {
						path: p.path.slice(0, -1),
						range: [k as number, k as number],
						value: mine([old]),
					}
					: { path: p.path, value: old },
			)
		}
	}

	// a move is a take, then a landing in what is left
	function move(p: Patch, from: Target): void {
		const P = p.path, F = from.path
		if (under(p, from)) fail("into-itself")
		// onto itself, a key or an element or the whole: nothing changes, once it is there
		if (!p.range && !from.range && same(P, F)) {
			get(F)
			return
		}
		let m: unknown, took: Took | undefined
		if (from.range) {
			const c = from.range[0]
			const untake = splice(F, c, from.range[1], undefined)
			m = taken
			if (un) {
				took = { m, back: { path: F, range: [c, c] }, untake, taking: joined, listed: false }
			}
		} else {
			m = set(F, undefined)
			// a missing map key: nothing to take
			if (m === ABSENT) fail("no-key")
			if (un) {
				const listed = F.length > 0 && isList(get(F, F.length - 1)),
					f = F[F.length - 1] as number
				const back: Target = listed ? { path: F.slice(0, -1), range: [f, f] } : { path: F }
				const untake = listed ? { ...back, value: mine([m]) } : { path: F, value: m }
				took = { m, back, untake, taking: false, listed }
			}
		}
		if (!p.range) {
			const listy = un !== undefined && P.length > 0 && isList(get(P, P.length - 1))
			const old = set(P, m)
			if (took) un!.unland(p, from, took, old, listy)
			return
		}
		// one element into a list's span: as a list of one
		const one = isList(get(P)) && !from.range
		const unput = splice(P, p.range[0], p.range[1], one ? [m] : m)
		if (took) un!.unfill(p, from, took, one, unput)
	}

	// the undo's part, made only when wanted
	const un = undo ? undoer() : undefined
	function undoer() {
		// v and what of it was made here: never changed here again, the undo holds it
		function keep(v: unknown) {
			if (v === null || typeof v !== "object" || own === undefined) return
			if (Array.isArray(own)) {
				const i = own.indexOf(v)
				if (i < 0) return
				own[i] = own[own.length - 1]
				own.pop()
			} else if (!own.delete(v)) return
			if (isList(v)) { for (const x of v) keep(x) }
			else for (const k in v) keep((v as Record<string, unknown>)[k])
		}
		// each patch's undo as it lands (null: nothing); the undo of all is read off it last patch
		// first
		const undone: Patch[] = []
		const push = (p: Patch | null) => {
			if (p === null) return
			if ("value" in p) keep(p.value)
			undone.push(p)
		}

		// a move's undo is the landing's, then the take's. better, one move back, with what the
		// landing replaced put beside what moved first: exact unless a path back would be
		// into-itself, a lone surrogate met another (a string's), or what moved cannot be moved back
		// whole (the whole, or a string or typed array out of a list)

		// the landing at P, unranged: old was there (ABSENT: nothing), listy: in a list
		function unland(p: Patch, from: Target, took: Took, old: unknown, listy: boolean) {
			const P = p.path, F = from.path, { back, untake } = took
			// what moved stays in the value, still walked: the undo's copy of it is never changed
			const fall = (undone: Patch) => (push(undone), push(untake))
			const unset: Patch = old === ABSENT ? { path: P } : { path: P, value: old }
			if (!P.length) return fall(unset)
			if (from.range) {
				// the span back, out of the sequence it became, which is then put back
				if (took.taking || within(P, F)) return fall(unset)
				const n = from.range[1] - from.range[0]
				if (n) push({ ...back, move: { path: P, range: [0, n] } })
				// P's place moved by the n put back in front of it, if both are in one list
				return push(
					!n ? unset : old === ABSENT ? { path: shift(P, back, n) } : { path: shift(P, back, n), value: old },
				)
			}
			const there: Patch = { ...back, move: { path: P } }
			if (listy) {
				// what was replaced goes in beside it first
				if (under(there, there.move!)) return fall(unset)
				const k = P[P.length - 1] as number
				push({ path: P.slice(0, -1), range: [k + 1, k + 1], value: mine([old]) })
				return push(there)
			}
			if (old === ABSENT) return under(there, there.move!) ? fall(unset) : push(there)
			// a map's key: put back once what moved has left it
			if (within(P, back.path)) return fall(unset)
			push(there)
			push({ path: shift(P, back), value: old })
		}
		// the landing in a span of P; one: one element into a list; unput undoes it (null: nothing)
		function unfill(p: Patch, from: Target, took: Took, one: boolean, unput: Patch | null) {
			const P = p.path, [a] = p.range!, { m, back, untake } = took
			const fall = (undone: Patch | null) => (push(undone), push(untake))
			const t = taken as ArrayLike<unknown>
			let there: Patch
			if (one) there = { ...back, move: { path: [...P, a] } }
			else {
				// a lone high at the end of what moved would meet a lone low that begins what it replaced
				const meets = typeof m === "string" && m.length > 0 && t.length > 0 &&
					high(m.charCodeAt(m.length - 1)) && low((t as string).charCodeAt(0))
				if (took.listed || took.taking || joined || meets) return fall(unput)
				there = { ...back, move: { path: P, range: [a, a + size] } }
			}
			if (under(there, there.move!)) return fall(unput)
			if (t.length) push({ path: P, range: [a + size, a + size], value: t })
			if (size || !from.range) push(there)
		}

		return { undone, push, unland, unfill }
	}

	return { work, step, undone: un?.undone }
}

const same = (a: readonly Key[], b: readonly Key[]) =>
	a.length === b.length && a.every((k, i) => k === b[i])
// b is a, or under it
const within = (a: readonly Key[], b: readonly Key[]) =>
	a.length <= b.length && a.every((k, i) => k === b[i])

// p's place lies inside what from takes: under its path, or in its span
function under(p: Target, from: Target) {
	const f = from.path, q = p.path
	if (q.length < f.length || !f.every((k, i) => k === q[i])) return false
	if (!from.range) return q.length > f.length
	if (q.length === f.length) return false
	const k = q[f.length]
	return typeof k === "number" && k >= from.range[0] && k < from.range[1]
}

// path, once n elements are put in at the gap of at, a list's range
function shift(path: readonly Key[], at: Target, n = 1): readonly Key[] {
	const d = at.path.length
	if (!at.range || path.length <= d || !within(at.path, path)) return path
	const i = path[d] as number
	if (i < at.range[0]) return path
	const out = path.slice()
	out[d] = i + n
	return out
}

// the undo of all the patches: each patch's (from its mark in undone), the last patch's first
function unroll(undone: Patch[], marks: number[], out: Patch[]) {
	for (let j = marks.length - 1, end = undone.length; j >= 0; end = marks[j--]) {
		for (let k = marks[j]; k < end; k++) out.push(undone[k])
	}
}

// the patches, in order, on value (undefined: nothing there); the value after them (undefined:
// nothing there). a put at [] makes a value where there is none
export default function apply(
	value: unknown,
	patches: Iterable<Patch>,
	options: Options = {},
): unknown {
	const list = options.list === true, undo = options.undo
	const empty = (v: unknown) => list && isList(v) && v.length === 0
	const { work, step, undone } = createWork(
		value !== undefined ? value : list ? [] : ABSENT,
		undo !== undefined,
	)
	// each patch's undo starts at its mark
	const marks: number[] = []
	let i = 0
	for (const p of patches) {
		try {
			if (!shape(p)) fail("not-a-patch")
			if (undo) marks.push(undone!.length)
			step(p)
			if (list && work.root !== ABSENT && !isList(work.root)) fail("wrong-kind")
		} catch (e) {
			if (e instanceof Fail) throw new ApplyError(e.code, i)
			throw e
		}
		i++
	}
	if (undo) unroll(undone!, marks, undo)
	return work.root === ABSENT || empty(work.root) ? undefined : work.root
}
