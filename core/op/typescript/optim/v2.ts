// patches applied to one value: the value after them. what a patch touches is new, the rest is
// shared; a copy made here may change in place, since only the end is ever seen. any patch
// invalid: it throws, and nothing changes
import { count, type Hint, joins, near, walk } from "@ermine/util/walk-string"

export type Key = string | number
export type Span = readonly [number, number]
// what a patch aims at: a path, and a span of the string, list or typed array there
export type Target = { path: readonly Key[]; range?: Span }
// a value put at the target (none: what is there removed), or what is at move taken there
export type Patch = Target & { value?: unknown; move?: Target }

// what a patch found where it landed, in the value before it: a list there, how long (code
// points for a string), and whether the key was there
export type Fact = { list: boolean; length: number; had: boolean }
export type Facts = {
	// the patch's target, as it is when the patch lands (a move's: with what left gone).
	// ranged: the sequence at its path; else its parent, had: its last key there.
	// at [], unranged: had: the value there
	place: Fact
	// a move: where it came from, as place is
	from?: Fact
	// a ranged move: how many places what moved fills where it lands
	size?: number
}

export type Options = {
	// told of each patch once all have landed, in order, with what it found
	each?: (patch: Patch, facts: Facts) => void
	// the value is a list: nothing there starts as [], anything but a list is wrong-kind, and a list
	// left empty is nothing (it was there only when not empty)
	list?: boolean
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

const sur = /[\uD800-\uDFFF]/
// no surrogate in s: every position is its unit, and no edit joins a pair
function plain(s: string): boolean {
	if (s.length < 32) {
		for (let i = 0; i < s.length; i++) if ((s.charCodeAt(i) & 0xf800) === 0xd800) return false
		return true
	}
	return s.search(sur) < 0
}

// a string's positions: code points (walk.ts)
function len(v: unknown): number {
	if (typeof v === "string") return count(v)
	return (v as unknown[] | Typed).length
}

// a key, as every() saw it: a hole skipped
function keys(path: readonly unknown[]): boolean {
	for (let i = 0; i < path.length; i++) {
		const k = path[i]
		if (typeof k === "string") continue
		if (Number.isInteger(k) && (k as number) >= 0) continue
		if (k === undefined && !(i in path)) continue
		return false
	}
	return true
}
function span(r: readonly unknown[]): boolean {
	for (let i = 0; i < r.length; i++) {
		const n = r[i]
		if (Number.isInteger(n) && (n as number) >= 0) continue
		if (n === undefined && !(i in r)) continue
		return false
	}
	return true
}
function shape(p: Patch): boolean {
	if (p === null || typeof p !== "object" || !isList(p.path)) return false
	if (!keys(p.path)) return false
	if (p.range !== undefined) {
		const r = p.range
		if (!isList(r) || r.length !== 2 || !span(r)) return false
	}
	if (p.move !== undefined) {
		if ("value" in p) return false
		const m = p.move as Patch
		if (m === null || typeof m !== "object" || "value" in m || "move" in m) return false
		return shape(m)
	}
	return true
}

// a map's copy: its own enumerable keys, in order, as data. Object.assign's is fast whatever the
// shapes seen (a spread's is not, once many are); a key "__proto__" it would set the prototype
// with: a spread
const clone = (v: object): object => Object.hasOwn(v, "__proto__") ? { ...v } : Object.assign({}, v)

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

// what notify reads of the container at path's first n keys, as the content is now; nothing
// checked
function look(root: unknown, path: readonly Key[], n: number): unknown {
	let v = root === ABSENT ? undefined : root
	for (let i = 0; i < n; i++) {
		v = v !== null && typeof v === "object" ? (v as Record<Key, unknown>)[path[i]] : undefined
	}
	return v
}

type Place = { path: readonly Key[]; range?: readonly [number, number] }
// never read before a splice sets it
const NOSEQ: Fact = { list: false, length: 0, had: true }

// one edit's content, changed patch by patch; list: a name's list, there only when not empty
class Work {
	// made here: may change in place. few, scanned; past 16, a WeakSet
	own: object[] | WeakSet<object> | undefined = undefined
	// the last splice's sequence, as it was: its fact (a string counted only when asked)
	seq: Fact = NOSEQ
	// the last string made here, and what is known of it: the next patch to it walks from there
	// (typing: from where the last left off). any string with its content: the same hint.
	// plain: no surrogate in it, every position its unit. wf: no lone surrogate (undefined: not
	// known)
	memo: (Hint & { s: string; plain: boolean; wf: boolean | undefined }) | null = null
	constructor(public root: unknown, readonly list: boolean) {}

	copy<T extends object>(v: T): T {
		const own = this.own
		if (own !== undefined && (isList(own) ? own.includes(v) : own.has(v))) return v
		const c = (isList(v) ? v.slice() : clone(v)) as T
		if (own === undefined) this.own = [c]
		else if (!isList(own)) own.add(c)
		else if (own.length < 16) own.push(c)
		else (this.own = new WeakSet(own)).add(c)
		return c
	}
	copyIn(v: unknown): object {
		if (v === ABSENT) return fail("no-key")
		if (!isList(v) && !isMap(v)) return fail("wrong-kind")
		return this.copy(v)
	}
	// the container holding path's last key, made own along the way; [] has none
	parent(path: readonly Key[]): Record<Key, unknown> {
		let v = this.root = this.copyIn(this.root)
		for (let i = 0; i < path.length - 1; i++) {
			const at = v as Record<Key, unknown>, k = path[i]
			const next = at[enter(at, k)]
			v = this.copyIn(next)
			if (v !== next) at[k] = v
		}
		return v as Record<Key, unknown>
	}
	// what is at path's first n keys, unchanged
	get(path: readonly Key[], n = path.length): unknown {
		let v = this.root
		if (v === ABSENT && n) fail("no-key")
		for (let i = 0; i < n; i++) v = (v as Record<Key, unknown>)[enter(v, path[i])]
		return v
	}

	// the span [a, b) of what is at path replaced by w (undefined: removed); what was there, when
	// keep. all: a string's positions are all counted, for seq. the path walked once: its
	// containers made own on the way in, the sequence put back at the end
	splice(path: readonly Key[], a: number, b: number, w: unknown, all = false, keep = false): unknown {
		let at: Record<Key, unknown> | undefined, k: Key = 0, v: unknown
		if (path.length === 0) v = this.root
		else {
			at = this.parent(path)
			k = path[path.length - 1]
			v = at[enter(at, k)]
		}
		if (a > b) fail("range")
		if (typeof v !== "string" && !isList(v) && !typed(v)) fail("wrong-kind")
		let out: unknown, taken: unknown
		if (typeof v === "string") {
			const memo = this.memo
			const m = memo !== null && memo.s === v ? memo : null
			const p = m !== null ? m.plain : plain(v)
			let x: number, y: number, n: number
			if (p) {
				if (b > v.length) fail("range")
				x = a, y = b, n = v.length
			} else {
				const at = m !== null ? near(v, a, b, all, m) : walk(v, a, b, all)
				if (!at) return fail("range")
				;[x, y, n] = at
			}
			if (w !== undefined && typeof w !== "string") fail("wrong-kind")
			this.seq = { list: false, length: n, had: true }
			if (keep) taken = v.slice(x, y)
			const add = (w ?? "") as string
			const o = v.slice(0, x) + add + v.slice(y), e = x + add.length
			out = o
			const ap = plain(add)
			const wn = ap ? add.length : count(add)
			const nn = n >= 0 ? n - (b - a) + wn : -1
			if (p && ap) this.memo = { s: o, plain: true, wf: true, n: nn, k: 0, i: 0 }
			else {
				// a lone high met by a lone low at either edge: one pair now, a position fewer, and the
				// finger may be inside it. rare: forget, the next walks. none when both sides are well
				// formed, or v has no surrogate
				const wa = ap || add.isWellFormed()
				const wv = p || (m !== null && m.wf !== undefined ? m.wf : v.isWellFormed())
				if (!p && !(wv && wa) && (joins(o, x) || joins(o, e))) this.memo = null
				else this.memo = { s: o, plain: false, wf: wv && wa, n: nn, k: a + wn, i: e }
			}
		} else if (isList(v)) {
			if (b > v.length) fail("range")
			if (w !== undefined && !isList(w)) fail("wrong-kind")
			this.seq = { list: true, length: v.length, had: true }
			const l = this.copy(v)
			if (w === undefined) taken = l.splice(a, b - a)
			else {
				const ws = w as unknown[]
				// at the end: pushed, the list grows in place
				if (a === l.length && !keep) for (let i = 0; i < ws.length; i++) l.push(ws[i])
				else if (ws.length === 1) taken = l.splice(a, b - a, ws[0])
				else taken = l.splice(a, b - a, ...ws)
			}
			out = l
		} else {
			const t = v as Typed
			if (b > t.length) fail("range")
			this.seq = { list: false, length: t.length, had: true }
			if (w !== undefined && (!typed(w) || w.constructor !== t.constructor)) fail("wrong-kind")
			const wn = w ? (w as Typed).length : 0
			const n = new (t.constructor as new (n: number) => Typed)(t.length - (b - a) + wn)
			if (a > 0) n.set(a === t.length ? t : t.subarray(0, a), 0)
			if (wn) n.set(w as Typed, a)
			if (b < t.length) n.set(b === 0 ? t : t.subarray(b), a + wn)
			if (keep) taken = t.slice(a, b)
			out = n
		}
		if (at === undefined) this.root = out
		else if (at[k] !== out) at[k] = out
		return taken
	}
	// what is at path becomes w (undefined: removed, ABSENT at [])
	set(path: readonly Key[], w: unknown) {
		if (path.length === 0) return void (this.root = w === undefined ? ABSENT : w)
		const at = this.parent(path), k = path[path.length - 1]
		if (isList(at)) {
			if (typeof k !== "number") fail("wrong-kind")
			if ((k as number) >= at.length) fail("no-key")
			if (w === undefined) at.splice(k as number, 1)
			else at[k as number] = w
		} else {
			if (typeof k !== "string") fail("wrong-kind")
			if (w === undefined) delete at[k]
			else at[k] = w
		}
	}

	// takes what is at a place out; what it was
	take(p: Place, all: boolean): unknown {
		if (p.range) return this.splice(p.path, p.range[0], p.range[1], undefined, all, true)
		const v = this.get(p.path)
		this.set(p.path, undefined)
		return v
	}

	// what notify reads at an unranged place, as the content is now; nothing checked
	// a ranged place's: seq, from its splice, so a string is walked once
	fact(p: { path: readonly Key[] }): Fact {
		const path = p.path
		if (!path.length) {
			const r = this.root
			return {
				list: false,
				length: 0,
				had: r !== ABSENT && !(this.list && isList(r) && r.length === 0),
			}
		}
		const v = look(this.root, path, path.length - 1), k = path[path.length - 1]
		// a list's: the index is in it
		if (isList(v)) {
			return { list: true, length: v.length, had: typeof k === "number" && k < v.length }
		}
		return {
			list: false,
			length: 0,
			had: v !== null && typeof v === "object" && Object.hasOwn(v, k),
		}
	}

	// tell: answers the patch's facts
	apply(p: Patch, tell: boolean): Facts | undefined {
		// nothing there: only a put at the whole
		if (this.root === ABSENT && (p.path.length || p.range || !("value" in p))) fail("no-key")
		if (p.move) {
			const from = p.move
			if (under(p, from)) fail("into-itself")
			// onto itself, a key or an element or the whole: nothing changes, once it is there
			if (!p.range && !from.range && same(p.path, from.path)) {
				this.get(from.path)
				if (!tell) return
				const here = this.fact(p)
				return { place: here, from: here }
			}
			let was = tell && !from.range ? this.fact(from) : undefined
			const moved = this.take(from, tell)
			if (tell && from.range) was = this.seq
			if (!p.range) {
				const place = tell ? this.fact(p) : undefined
				this.set(p.path, moved)
				return tell ? { place: place!, from: was } : undefined
			}
			const v = this.get(p.path)
			// one element into a list's span: as a list of one
			const w = isList(v) && !from.range ? [moved] : moved
			this.splice(p.path, p.range[0], p.range[1], w, tell)
			if (!tell) return
			const size = from.range ? from.range[1] - from.range[0] : isList(v) ? 1 : len(moved)
			return { place: this.seq, from: was, size }
		}
		const w = "value" in p ? p.value : undefined
		if (p.range) {
			this.splice(p.path, p.range[0], p.range[1], w, tell)
			return tell ? { place: this.seq } : undefined
		}
		const facts = tell ? { place: this.fact(p) } : undefined
		if (w === undefined && "value" in p) fail("not-a-patch")
		// removing a missing map key: nothing
		if (w === undefined && p.path.length) {
			const at = this.get(p.path, p.path.length - 1), k = p.path[p.path.length - 1]
			if (isMap(at) && typeof k === "string" && !Object.hasOwn(at, k)) return facts
		}
		this.set(p.path, w)
		return facts
	}
}

function same(a: readonly Key[], b: readonly Key[]): boolean {
	if (a.length !== b.length) return false
	// as every(): a hole in a skipped
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && i in a) return false
	return true
}

// p's place lies inside what from takes: under its path, or in its span
function under(p: Patch, from: Place) {
	const f = from.path, q = p.path
	if (q.length < f.length) return false
	for (let i = 0; i < f.length; i++) if (f[i] !== q[i] && i in f) return false
	if (!from.range) return q.length > f.length
	if (q.length === f.length) return false
	const k = q[f.length]
	return typeof k === "number" && k >= from.range[0] && k < from.range[1]
}

// the patches, in order, on value (undefined: nothing there); the value after them (undefined:
// nothing there). a put at [] makes a value where there is none
export default function apply(
	value: unknown,
	patches: Iterable<Patch>,
	options: Options = {},
): unknown {
	const list = options.list === true
	const work = new Work(value !== undefined ? value : list ? [] : ABSENT, list)
	const seen: (Patch | Facts)[] = []
	let i = 0
	for (const p of patches) {
		try {
			if (!shape(p)) fail("not-a-patch")
			const facts = work.apply(p, options.each !== undefined)
			if (list && work.root !== ABSENT && !isList(work.root)) fail("wrong-kind")
			if (facts) seen.push(p, facts)
		} catch (e) {
			if (e instanceof Fail) throw new ApplyError(e.code, i)
			throw e
		}
		i++
	}
	for (let j = 0; j < seen.length; j += 2) options.each!(seen[j] as Patch, seen[j + 1] as Facts)
	const r = work.root
	return r === ABSENT || list && isList(r) && r.length === 0 ? undefined : r
}
