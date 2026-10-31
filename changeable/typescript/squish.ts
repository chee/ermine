// Squishes patches: fewer patches that give the same end result. It reads patches (apply.ts's)
// and never needs the content they hold. Also encodes patches as run-length columns.
import type { Key, Patch, Span } from "./apply.ts"
import { isTyped, type Typed } from "@ermine/changeable/kinds"
import { count, near } from "@ermine/changeable/walk-string"

type Ranged = Patch & { range: Span }

const isList = Array.isArray
const ranged = (p: Patch): p is Ranged => p.range !== undefined
const plain = (p: Patch) => p.move === undefined && !("value" in p)
const sequence = (v: unknown) => typeof v === "string" || isList(v) || isTyped(v)

// Range ends past 2^53 - 1 are bigints; sums stay exact.
type Pos = number | bigint
const norm = (x: bigint): Pos => x >= -9007199254740991n && x <= 9007199254740991n ? Number(x) : x
const sound = (r: number, x: number, y: number) =>
	Number.isSafeInteger(r) || !Number.isInteger(x) || !Number.isInteger(y)
function add(x: Pos, y: Pos): Pos {
	if (typeof x === "number" && typeof y === "number") {
		const r = x + y
		if (sound(r, x, y)) return r
	}
	return norm(BigInt(x) + BigInt(y))
}
function sub(x: Pos, y: Pos): Pos {
	if (typeof x === "number" && typeof y === "number") {
		const r = x - y
		if (sound(r, x, y)) return r
	}
	return norm(BigInt(x) - BigInt(y))
}

function len(v: unknown): number {
	if (typeof v === "string") return count(v)
	if (isList(v) || isTyped(v)) return v.length
	return NaN
}

const same = (a: readonly Key[], b: readonly Key[]) =>
	a.length === b.length && a.every((k, i) => k === b[i])
const under = (p: readonly Key[], q: readonly Key[]) =>
	q.length <= p.length && q.every((k, i) => k === p[i])

// True when next puts or removes the whole of prev's place. A move is never dead.
function dies(prev: Patch, next: Patch): boolean {
	return next.range === undefined && next.move === undefined && prev.move === undefined &&
		under(prev.path, next.path) &&
		!(plain(prev) && prev.range === undefined && typeof prev.path.at(-1) === "number" &&
			prev.path.length === next.path.length)
}

// The last patch's value as known, so typing one character at a time is cheap.
type Tail = {
	n: number
	simple: boolean
	// Made here and never given out, so it may change in place. A typed array is a view of back.
	own: boolean
	back: Typed | null
}
const fresh = (): Tail => ({ n: -1, simple: false, own: false, back: null })

function splice(t: Tail, v: unknown, x: number, y: number, w: unknown): unknown {
	const n = t.n
	if (typeof v === "string") {
		if (w !== undefined && typeof w !== "string") return undefined
		const s = w ?? "", wn = len(s)
		t.n = n - (y - x) + wn
		if (x === n) return t.simple = t.simple && s.length === wn, v + s
		if (t.simple) return t.simple = s.length === wn, v.slice(0, x) + s + v.slice(y)
		const at = near(v, x, y, false, { n, k: n, i: v.length })
		let out
		if (at) out = v.slice(0, at[0]) + s + v.slice(at[1])
		else {
			const cs = Array.from(v)
			out = cs.slice(0, x).join("") + s + cs.slice(y).join("")
		}
		t.simple = out.length === t.n
		return out
	}
	if (isList(v)) {
		if (w !== undefined && !isList(w)) return undefined
		let out = t.own ? v : v.slice()
		if (x === out.length && y === x && w) { for (const e of w) out.push(e) }
		else if (w && w.length > 1000) out = out.slice(0, x).concat(w, out.slice(y))
		else out.splice(x, y - x, ...(w ?? []))
		t.own = true
		t.n = out.length
		return out
	}
	if (!isTyped(v)) return undefined
	if (w !== undefined && (!isTyped(w) || w.constructor !== v.constructor)) return undefined
	const wn = w ? w.length : 0, size = n - (y - x) + wn
	t.n = size
	if (t.own && t.back && x === n && size <= t.back.length) {
		if (w) t.back.set(w, n)
		return t.back.subarray(0, size)
	}
	const back = new (v.constructor as new (n: number) => Typed)(Math.max(16, size * 2))
	back.set(v.subarray(0, x), 0)
	if (w) back.set(w, x)
	back.set(v.subarray(y), x + wn)
	t.own = true
	t.back = back
	return back.subarray(0, size)
}

function merge(t: Tail, prev: Patch, next: Patch): Patch | null {
	if (!ranged(prev) || !ranged(next) || prev.move || next.move) return null
	if (!same(prev.path, next.path)) return null
	const [a, b] = prev.range as readonly Pos[], [c, d] = next.range as readonly Pos[]
	const path = prev.path
	const w = "value" in next ? next.value : undefined
	if ("value" in prev) {
		if (t.n < 0) {
			t.n = len(prev.value)
			t.simple = typeof prev.value === "string" && prev.value.length === t.n
		}
		const n = t.n
		let value: unknown, range: readonly Pos[]
		if (a <= c && d <= add(a, n)) {
			value = splice(t, prev.value, sub(c, a) as number, sub(d, a) as number, w), range = [a, b]
		} else if (c === add(a, n) && d > c) {
			value = w === undefined ? prev.value : splice(t, prev.value, n, n, w)
			range = [a, add(b, sub(d, c))]
		} else return null
		if (value === undefined) return null
		return { path, range: range as Span, value }
	}
	if (!plain(prev)) return null
	if (w === undefined) {
		if (c <= a && a <= d) return { path, range: [c, add(b, sub(d, a))] as unknown as Span }
		return null
	}
	if (c === a && d === a && sequence(w)) {
		return Object.assign(t, fresh()), { path, range: [a, b] as unknown as Span, value: w }
	}
	return null
}

function could(t: Tail, prev: Patch, next: Patch): boolean {
	if (!ranged(prev) || !ranged(next)) return false
	const a = prev.range[0] as Pos, [c, d] = next.range as readonly Pos[]
	if (!("value" in prev)) {
		return "value" in next ? c === a && d === a && sequence(next.value) : c <= a && a <= d
	}
	if (t.n >= 0) return (a <= c && d <= add(a, t.n)) || (c === add(a, t.n) && d > c)
	const v = prev.value
	return sequence(v) && a <= c && c <= add(a, (v as string | unknown[] | Typed).length)
}

function lone(v: unknown): boolean {
	if (typeof v === "string") return !v.isWellFormed()
	if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return false
	for (const x of isList(v) ? v : Object.values(v)) if (lone(x)) return true
	return false
}

export type Squish = {
	push(patch: Patch): void
	patches(): Patch[]
	[Symbol.iterator](): Iterator<Patch>
}

// Typing at one place becomes one insert. Moves are never merged.
export default function createSquish(): Squish {
	const buf: Patch[] = []
	// A patch that puts a lone surrogate is never merged, since positions then depend on the
	// surroundings. Known gap: a removal that joins two lone halves is merged wrongly.
	const fouled: (readonly Key[])[] = []
	const isFouled = (path: readonly Key[]) => fouled.some((f) => under(path, f))
	function moved(p: Patch): boolean {
		const from = p.move!
		if (isFouled(from.path)) return true
		for (let i = 0, n = fouled.length; i < n; i++) {
			const f = fouled[i]
			if (f.length <= from.path.length || !under(f, from.path)) continue
			if (p.range !== undefined || from.range !== undefined) return true
			fouled.push([...p.path, ...f.slice(from.path.length)])
		}
		return false
	}
	let tail = fresh()
	const kept: Tail[] = []
	const retire = (t: Tail): Tail => ({ n: t.n, simple: t.simple, own: false, back: null })
	function seen() {
		const last = buf[buf.length - 1]
		if (tail.own && tail.back) {
			buf[buf.length - 1] = { ...last, value: (last.value as Typed).slice() }
		}
		tail = fresh()
	}
	return {
		push(patch) {
			if (patch.path.length === 0 && patch.range === undefined && patch.move === undefined) {
				buf.length = 0, kept.length = 0, fouled.length = 0
			} else {
				while (buf.length && dies(buf[buf.length - 1], patch)) {
					buf.pop(), tail = kept.pop() ?? fresh()
				}
			}
			let m = null
			if (lone(patch.value) || (patch.move && moved(patch))) {
				fouled.push(patch.path)
			} else if (buf.length && !isFouled(patch.path)) {
				m = merge(tail, buf[buf.length - 1], patch)
			}
			if (!m) {
				if (buf.length) kept.push(retire(tail))
				buf.push(patch), tail = fresh()
				return
			}
			let last: Patch = buf[buf.length - 1] = m
			while (kept.length) {
				const t = kept[kept.length - 1], prev = buf[buf.length - 2]
				const back = could(t, prev, last) ? merge(t, prev, last) : null
				if (!back) break
				kept.pop(), buf.pop()
				buf[buf.length - 1] = last = back, tail = t
			}
		},
		patches: () => (seen(), buf.slice()),
		[Symbol.iterator]: () => (seen(), buf.values()),
	}
}

export function squish(patches: Iterable<Patch>): Patch[] {
	const s = createSquish()
	for (const p of patches) s.push(p)
	return s.patches()
}

// Patches as columns. Each column is run-length encoded as [value, count, ...].
export type Columns = {
	paths: (readonly Key[])[]
	path: number[]
	shape: number[]
	from: number[]
	size: number[]
	value: unknown[]
	move: NonNullable<Patch["move"]>[]
}

function runs(xs: number[]): number[] {
	const out: number[] = []
	for (const x of xs) {
		const n = out.length
		if (n && out[n - 2] === x) out[n - 1]++
		else out.push(x, 1)
	}
	return out
}
function* unruns(rs: number[]): Generator<number> {
	for (let i = 0; i < rs.length; i += 2) for (let n = 0; n < rs[i + 1]; n++) yield rs[i]
}

export function encode(patches: Iterable<Patch>): Columns {
	const paths: (readonly Key[])[] = []
	const seen = new Map<string, number>()
	const path: number[] = [], shape: number[] = [], from: number[] = [], size: number[] = []
	const value: unknown[] = [], move: Columns["move"] = []
	let last: Pos = 0
	for (const p of patches) {
		const id = JSON.stringify(p.path)
		let i = seen.get(id)
		if (i === undefined) seen.set(id, i = paths.push(p.path) - 1)
		path.push(i)
		shape.push((p.range ? 1 : 0) | ("value" in p ? 2 : 0) | (p.move ? 4 : 0))
		if (p.range) {
			from.push(sub(p.range[0], last) as number)
			size.push(sub(p.range[1], p.range[0]) as number)
			last = p.range[0]
		}
		if ("value" in p) value.push(p.value)
		if (p.move) move.push(p.move)
	}
	return {
		paths,
		path: runs(path),
		shape: runs(shape),
		from: runs(from),
		size: runs(size),
		value,
		move,
	}
}

export function decode(c: Columns): Patch[] {
	const path = unruns(c.path),
		shape = unruns(c.shape),
		from = unruns(c.from),
		size = unruns(c.size)
	const short = (what: string) => new RangeError(`columns: ${what} does not cover the shapes`)
	const take = (rs: Generator<number>, what: string) => {
		const r = rs.next()
		if (r.done) throw short(what)
		return r.value
	}
	const out: Patch[] = []
	let last: Pos = 0, v = 0, m = 0
	for (const s of shape) {
		const x = take(path, "path")
		if (!(x >= 0 && x < c.paths.length)) throw short("paths")
		const p: Patch = { path: c.paths[x] }
		if (s & 1) {
			last = add(last, take(from, "from"))
			p.range = [last, add(last, take(size, "size"))] as unknown as Span
		}
		if (s & 2) {
			if (v >= c.value.length) throw short("value")
			p.value = c.value[v++]
		}
		if (s & 4) {
			if (m >= c.move.length) throw short("move")
			p.move = c.move[m++]
		}
		out.push(p)
	}
	return out
}
