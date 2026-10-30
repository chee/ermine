// Applies patches to a value and returns the new value, sharing untouched parts with the input.
// An invalid patch throws and nothing changes. With cow: false the containers given change in
// place, and a throw undoes what was done.
import { count, type Hint, joins, near, walk } from "@ermine/changeable/walk-string"
import { isPojo, isTyped, type Typed } from "@ermine/changeable/kinds"

export type Key = string | number
export type Span = readonly [number, number]
export type Target = { path: readonly Key[]; range?: Span }
export type Patch = Target & { value?: unknown; move?: Target }

export type Options = {
	undo?: Patch[]
	cow?: boolean
	// With cow false, owned decides which containers may change in place (none: all of them).
	owned?: (container: object) => object
}

export type Code = "not-a-patch" | "no-key" | "range" | "wrong-kind" | "into-itself"

export class ApplyError extends Error {
	constructor(readonly code: Code, readonly patch: number) {
		super(`${code} (patch ${patch})`)
	}
}

const isList = Array.isArray
const isObject = (v: unknown): v is object => v !== null && typeof v === "object"

const ABSENT = /* @__PURE__ */ Symbol("absent")

// A bigint index or range end becomes a number (cbor.ts decodes ones past 2^53 - 1 as bigint).
const big = (k: unknown) => typeof k === "bigint"
const unbig = <T>(keys: T): T =>
	isList(keys) && keys.some(big) ? keys.map((k) => big(k) ? Number(k) : k) as T : keys
function numbered(p: Patch): Patch {
	if (!isObject(p)) return p
	const path = unbig(p.path), range = unbig(p.range)
	const move = isObject(p.move) ? numbered(p.move as Patch) : p.move
	if (path === p.path && range === p.range && move === p.move) return p
	const q = { ...p, path } as Patch
	if (range !== undefined) q.range = range
	if (move !== undefined) q.move = move
	return q
}

const index = (n: unknown) => Number.isInteger(n) && (n as number) >= 0
function shape(p: Patch, inner = false): boolean {
	if (!isObject(p) || !isList(p.path)) return false
	if (!p.path.every((k) => typeof k === "string" || index(k))) return false
	const r = p.range
	if (r !== undefined && !(isList(r) && r.length === 2 && r.every(index))) return false
	if (inner) return !("value" in p || "move" in p)
	return p.move === undefined || !("value" in p) && shape(p.move as Patch, true)
}

const define = (o: object, k: string, value: unknown) =>
	Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true })

type Back = { was: Map<object, object>; under: Set<object> }

const gap = (path: readonly Key[], d = 0): Target => {
	const k = (path.at(-1) as number) + d
	return { path: path.slice(0, -1), range: [k, k] }
}
const ins = (path: readonly Key[], list: unknown[], d = 0): Patch => ({
	...gap(path, d),
	value: list,
})
const restore = (path: readonly Key[], old: unknown): Patch =>
	old === ABSENT ? { path } : { path, value: old }
const none = () => {}

function createWork(
	given: unknown,
	undo: boolean,
	cow: boolean,
	owned?: (container: object) => object,
	back?: Back | null,
) {
	let which = 0
	function fail(code: Code): never {
		throw new ApplyError(code, which)
	}
	let own: object[] | WeakSet<object> = []
	const mine = <T extends object>(c: T): T => {
		if (cow) {
			if (!isList(own)) own.add(c)
			else if (own.length < 16) own.push(c)
			else (own = new WeakSet(own)).add(c)
		}
		return c
	}
	const copy = <T extends object>(v: T): T =>
		!cow
			? owned ? owned(v) as T : v
			: (isList(own) ? own.includes(v) : own.has(v))
			? v
			: mine((isList(v) ? v.slice() : { ...v }) as T)
	const work = {
		root: given,
		back,
		clones: undefined as Map<unknown, unknown> | undefined,
	}

	function note(c: object, old: object, path: readonly Key[], copied = false, n = path.length) {
		if (cow || c === old || work.back === null) return
		if (copied && n === 0 && old === given) return void (work.back = null)
		const { was, under } = work.back ??= { was: new Map(), under: new Set() }
		was.set(c, old)
		let v = work.root as Record<Key, unknown>
		for (let i = 0; i < n; i++) {
			under.add(v)
			v = v[path[i]] as Record<Key, unknown>
		}
	}

	function enter(v: unknown, k: Key): Key {
		const list = isList(v)
		if (typeof k !== (list ? "number" : "string") || !list && !isPojo(v)) fail("wrong-kind")
		if (list ? (k as number) >= v.length : !Object.hasOwn(v as object, k)) fail("no-key")
		return k
	}
	function get(path: readonly Key[], short = 0): unknown {
		let v = work.root
		for (let i = 0; i < path.length - short; i++) {
			v = (v as Record<Key, unknown>)[enter(v, path[i])]
		}
		return v
	}
	function parent(path: readonly Key[]): Record<Key, unknown> {
		let v = work.root, above: Record<Key, unknown> | undefined
		for (let i = 0;; i++) {
			if (!isList(v) && !isPojo(v)) fail("wrong-kind")
			const c = copy(v as object) as Record<Key, unknown>
			if (c !== v) {
				if (i) above![path[i - 1]] = c
				else work.root = c
				note(c, v as object, path, true, i)
			}
			if (i === path.length - 1) return c
			v = c[enter(c, path[i])]
			above = c
		}
	}

	let memo: (Hint & { s: string }) | null = null
	let taken: unknown, size = 0, joined = false

	function splice(path: readonly Key[], a: number, b: number, w: unknown): Patch | null {
		const v = get(path)
		if (v === ABSENT) fail("no-key")
		if (a > b) fail("range")
		let l = 0, back: unknown
		if (typeof v === "string") {
			const at = memo !== null && memo.s === v ? near(v, a, b, false, memo) : walk(v, a, b)
			if (!at) fail("range")
			if (w !== undefined && typeof w !== "string") fail("wrong-kind")
			const [x, y, n] = at!
			const add = (w ?? "") as string, o = v.slice(0, x) + add + v.slice(y), e = x + add.length
			l = +joins(o, x)
			const r = add ? +joins(o, e) : l
			size = add ? count(add) : 0
			joined = l + r > 0
			memo = joined ? null : { s: o, n: n >= 0 ? n - (b - a) + size : -1, k: a + size, i: e }
			taken = v.slice(x, y)
			set(path, o)
			if (joined) back = v.slice(x - l, y + r)
		} else if (isList(v) || isTyped(v)) {
			if (b > v.length) fail("range")
			if (
				w !== undefined &&
				!(isList(v) ? isList(w) : isTyped(w) && w.constructor === v.constructor)
			) {
				fail("wrong-kind")
			}
			size = w ? (w as ArrayLike<unknown>).length : 0
			joined = false
			if (isList(v)) {
				let n = copy(v)
				const put = (w ?? []) as unknown[]
				// Spreading past ~100k arguments overflows the stack, so rebuild instead.
				if (put.length > 10000) {
					taken = mine(n.slice(a, b))
					n = mine(n.slice(0, a).concat(put, n.slice(b)))
				} else taken = mine(n.splice(a, b - a, ...put))
				set(path, n)
				note(n, v, path, true)
			} else {
				const t = v as Typed
				taken = t.slice(a, b)
				const len = t.length - (b - a) + size
				if (!cow && len === t.length) {
					const o = copy(t)
					if (o !== t) set(path, o), note(o, t, path, true)
					if (w) o.set(w as Typed, a)
				} else {
					const n = new (t.constructor as new (n: number) => Typed)(len)
					n.set(t.subarray(0, a))
					if (w) n.set(w as Typed, a)
					n.set(t.subarray(b), a + size)
					set(path, n)
					note(n, t, path)
				}
			}
		} else fail("wrong-kind")
		if (!undone) return null
		back ??= taken
		const start = a - l, end = a + size - (w ? l : 0), u: Patch = { path, range: [start, end] }
		if ((back as ArrayLike<unknown>).length) u.value = back
		else if (start === end) return null
		return u
	}
	function set(path: readonly Key[], w: unknown): unknown {
		if (!path.length) {
			const old = work.root
			work.root = w === undefined ? ABSENT : w
			return old
		}
		const at = parent(path), k = path[path.length - 1]
		let old: unknown
		if (isList(at)) {
			if (typeof k !== "number") fail("wrong-kind")
			if (k >= at.length) fail("no-key")
			old = at[k]
		} else {
			if (typeof k !== "string") fail("wrong-kind")
			old = Object.hasOwn(at, k) ? at[k] : ABSENT
		}
		if (w === undefined) {
			if (isList(at)) at.splice(k as number, 1)
			else delete at[k]
			// "__proto__" is an ordinary key, so define it rather than assign.
		} else if (k === "__proto__") define(at, k, w)
		else at[k] = w
		return old
	}

	function step(p: Patch, i: number): void {
		which = i
		const P = p.path, has = "value" in p, w = p.value
		if (work.root === ABSENT && (P.length || p.range || !has)) fail("no-key")
		if (p.move) return move(p, p.move)
		if (p.range) return void push(splice(P, p.range[0], p.range[1], w))
		if (w === undefined && has) fail("not-a-patch")
		const k = P[P.length - 1], at = w === undefined && P.length ? get(P, 1) : undefined
		if (isPojo(at) && typeof k === "string" && !Object.hasOwn(at, k)) return
		const old = set(P, w)
		if (undone) push(isList(at) ? ins(P, mine([old])) : restore(P, old))
	}

	function move(p: Patch, from: Target): void {
		const P = p.path, F = from.path, r = from.range
		if (under(p, from)) fail("into-itself")
		if (!p.range && !r && within(P, F) && within(F, P)) return void get(F)
		let m: unknown, back: Target = { path: F }, taken0: Patch | null = null, awry = false
		if (r) {
			taken0 = splice(F, r[0], r[1], undefined)
			m = taken
			back = { path: F, range: [r[0], r[0]] }
			awry = joined
		} else {
			m = set(F, undefined)
			if (m === ABSENT) fail("no-key")
			if (undone) {
				awry = F.length > 0 && isList(get(F, 1))
				if (awry) back = gap(F)
				taken0 = awry ? ins(F, mine([m])) : restore(F, m)
			}
		}
		// In place, the undo needs its own copy of what moved, because the tree keeps changing.
		let untake = taken0
		if (!cow && taken0 && "value" in taken0) {
			const c = clone(taken0.value)
			if (c !== taken0.value) (work.clones ??= new Map()).set(c, taken0.value)
			untake = { ...taken0, value: c }
		}
		const to = (there: Target): Patch => ({ ...back, move: there })
		let ups: (Patch | false)[] | undefined, land: Patch | null = null
		try {
			if (!p.range) {
				const listy = undone && P.length > 0 && isList(get(P, 1))
				const old = set(P, owned && r && isList(m) ? owned(m) : m)
				if (undone) {
					land = restore(P, old)
					const at: Target = { path: P }
					if (r) {
						const n = r[1] - r[0]
						if (!awry && !within(P, F)) {
							ups = [
								n > 0 && to({ path: P, range: [0, n] }),
								restore(shift(P, back, n), old),
							]
						}
					} else if (listy) {
						if (!under(back, at)) ups = [ins(P, mine([old]), 1), to(at)]
					} else if (!within(P, back.path)) {
						ups = [to(at), old !== ABSENT && restore(shift(P, back), old)]
					}
				}
			} else {
				const [a, b] = p.range
				const one = isList(get(P)) && !r
				land = splice(P, a, b, one ? [m] : m)
				if (undone) {
					const t = taken as ArrayLike<unknown>
					const at: Target = one ? { path: [...P, a] } : { path: P, range: [a, a + size] }
					if (
						(one || !(awry || joined || typeof m === "string" && joins(m + t, m.length))) &&
						!under(back, at)
					) {
						ups = [
							t.length > 0 && { path: P, range: [a + size, a + size], value: t },
							(size > 0 || !r) && to(at),
						]
					}
				}
			}
		} catch (e) {
			if (!cow) push(taken0)
			throw e
		}
		if (undone) (ups ?? [land, untake]).forEach(push)
	}

	const undone: Patch[] | undefined = undo ? [] : undefined
	const push: (p: Patch | null | false) => void = !undone ? none : (p) => {
		if (!p) return
		if ("value" in p) keep!(p.value)
		undone.push(p)
	}
	const keep = undone && ((v: unknown) => {
		// A stack, not recursion, so deep values work.
		const todo = [v]
		while (todo.length) {
			const x = todo.pop()
			if (!isObject(x)) continue
			if (isList(own)) {
				const i = own.indexOf(x)
				if (i < 0) continue
				own.splice(i, 1)
			} else if (!own.delete(x)) continue
			if (isList(x)) { for (const y of x) todo.push(y) }
			else for (const k in x) todo.push((x as Record<string, unknown>)[k])
		}
	})

	return { work, step, undone }
}

function putBack(v: unknown, back: Back): unknown {
	if (!isObject(v)) return v
	let o: object = v, w: object | undefined
	while ((w = back.was.get(o)) !== undefined) o = w
	if (o !== v) {
		if (!isTyped(o)) return o
		if (o.length !== (v as Typed).length) return v
		o.set(v as Typed)
		return o
	}
	if (!back.under.has(v) || isTyped(v)) return v
	const m = v as Record<string, unknown>
	for (const k of Object.keys(m)) {
		const r = putBack(m[k], back)
		if (r !== m[k]) define(m, k, r)
	}
	return v
}

function clone(v: unknown): unknown {
	const leaf = (x: unknown) => isList(x) ? [] : isPojo(x) ? {} : isTyped(x) ? x.slice() : x
	const out = leaf(v)
	// A stack, not recursion, so deep values work.
	const todo: [unknown, object][] = [[v, out as object]]
	for (let t; (t = todo.pop());) {
		const [from, to] = t
		if (isList(from)) {
			const into = to as unknown[]
			for (let i = 0; i < from.length; i++) {
				const c = leaf(from[i])
				into.push(c)
				if (c !== from[i]) todo.push([from[i], c as object])
			}
		} else if (isPojo(from)) {
			for (const k of Object.keys(from)) {
				const c = leaf(from[k])
				define(to, k, c)
				if (c !== from[k]) todo.push([from[k], c as object])
			}
		}
	}
	return out
}

const within = (a: readonly Key[], b: readonly Key[]) =>
	a.length <= b.length && a.every((k, i) => k === b[i])

function under(p: Target, from: Target) {
	const f = from.path, q = p.path, r = from.range, k = q[f.length]
	return within(f, q) &&
		(r ? typeof k === "number" && k >= r[0] && k < r[1] : q.length > f.length)
}

function shift(path: readonly Key[], at: Target, n = 1): readonly Key[] {
	const d = at.path.length, i = path[d] as number
	if (!n || !at.range || path.length <= d || !within(at.path, path) || i < at.range[0]) return path
	const out = path.slice()
	out[d] = i + n
	return out
}

function unroll(undone: Patch[], marks: number[], out: Patch[] = []) {
	for (let j = marks.length - 1, end = undone.length; j >= 0; end = marks[j--]) {
		for (let k = marks[j]; k < end; k++) out.push(undone[k])
	}
	return out
}

export default function apply(
	value: unknown,
	patches: Iterable<Patch>,
	options: Options = {},
): unknown {
	const undo = options.undo, cow = options.cow !== false
	// In place, the undo is always built, because it is how a refused patch is taken back.
	const { work, step, undone } = createWork(
		value !== undefined ? value : ABSENT,
		undo !== undefined || !cow,
		cow,
		options.owned,
	)
	const marks: number[] = []
	let i = 0
	try {
		for (const given of patches) {
			const p = numbered(given)
			if (!shape(p)) throw new ApplyError("not-a-patch", i)
			if (undone) marks.push(undone.length)
			step(p, i++)
		}
	} catch (e) {
		if (!cow) {
			const b = work.back
			const again = createWork(
				work.root,
				false,
				false,
				b ? (c) => (b.under.add(c), c) : undefined,
				b,
			)
			for (const p of unroll(undone!, marks)) {
				const c = work.clones?.get(p.value)
				again.step(c ? { ...p, value: c } : p, i)
			}
			if (b) putBack(again.work.root, b)
		}
		throw e
	}
	if (undo) unroll(undone!, marks, undo)
	return work.root === ABSENT ? undefined : work.root
}
