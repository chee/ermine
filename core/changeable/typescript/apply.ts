// patches applied to one value: the value after them. what a patch touches is new, the rest is
// shared; a copy made here may change in place, since only the end is ever seen. any patch
// invalid: it throws, and nothing changes. asked for, the undo of the patches too (invert.ts says
// what it is), built as each lands: one walk. with cow: false nothing is copied: the containers
// given change in place (a string, or a typed array that changes length, is put new in its
// parent), and a throw undoes what was done, by the undo built on the way: then each container
// put new in another's place (owned's copies, a typed array grown or shrunk) is the one it
// replaced again, as it was, so a refused call changes nothing, which is where too
//
// a map's key order is not part of its value: a map is its keys and what is at each. nothing owes
// an order (a key put may come back anywhere among the others); maps are compared by content
import { count, type Hint, joins, near, walk } from "@ermine/core/util/walk-string"
import { isPojo, isTyped, type Typed } from "@ermine/core/util/kinds"

export type Key = string | number
export type Span = readonly [number, number]
// what a patch aims at: a path, and a span of the string, list or typed array there
export type Target = { path: readonly Key[]; range?: Span }
// a value put at the target (none: what is there removed), or what is at move taken there
export type Patch = Target & { value?: unknown; move?: Target }

export type Options = {
	// the undo of the patches (invert.ts) is pushed here once all have landed, in the order to
	// apply it; a call that throws leaves it untouched
	undo?: Patch[]
	// false: change the value given in place, not a copy of it. the value returned is the one given
	// unless the whole was replaced. default true
	cow?: boolean
	// with cow false: which containers may change where they are. a list, map or typed array about
	// to change is given to owned first, which gives back the one to change: the same, or a copy it
	// made, which goes in its place (the root's too: then it is the value returned). so is the list
	// a span move takes out of a list, landing whole (not in a span): it holds what the span held.
	// none: every container changes where it is
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

// where nothing is there yet
const ABSENT = /* @__PURE__ */ Symbol("absent")

// a bigint index or range end is the whole number it is (cbor.ts reads one past 2^53 - 1 as a
// bigint: past every end); the patch as given when it has none
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
// a move's own move is none, and neither has a value beside it
function shape(p: Patch, inner = false): boolean {
	if (!isObject(p) || !isList(p.path)) return false
	if (!p.path.every((k) => typeof k === "string" || index(k))) return false
	const r = p.range
	if (r !== undefined && !(isList(r) && r.length === 2 && r.every(index))) return false
	if (inner) return !("value" in p || "move" in p)
	return p.move === undefined || !("value" in p) && shape(p.move as Patch, true)
}

// a key put as an own one, whatever its name
const define = (o: object, k: string, value: unknown) =>
	Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true })

// in place: each container put new in another's place, by what it replaced (was), and the
// containers that may hold one now (under), for a refused call to put back. none once owned
// copied the root given: nothing of it changed
type Back = { was: Map<object, object>; under: Set<object> }

// the gap before path's last key, in the list that holds it (d: that many further along)
const gap = (path: readonly Key[], d = 0): Target => {
	const k = (path.at(-1) as number) + d
	return { path: path.slice(0, -1), range: [k, k] }
}
// list put in at that gap
const ins = (path: readonly Key[], list: unknown[], d = 0): Patch => ({
	...gap(path, d),
	value: list,
})
// what was at path (ABSENT: nothing), put back
const restore = (path: readonly Key[], old: unknown): Patch =>
	old === ABSENT ? { path } : { path, value: old }
// where no undo is wanted, what is pushed
const none = () => {}

// one edit's content, changed patch by patch; undo: the undo is wanted. back: in place, where what
// it puts new in a container's place is noted (none: made at the first; null: owned copied the
// root given, so nothing of it changed and nothing is noted)
function createWork(
	given: unknown,
	undo: boolean,
	cow: boolean,
	owned?: (container: object) => object,
	back?: Back | null,
) {
	// the patch being applied, for a refusal to name
	let which = 0
	function fail(code: Code): never {
		throw new ApplyError(code, which)
	}
	// made here: may change in place, until the undo holds it. few, scanned; past 16, a WeakSet
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

	// in place: c put new where old was, at path's first n keys: noted, with the containers above
	// it. copied: by owned, old as it was (the root given: nothing of it changes, nor needs putting
	// back)
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

	// k into v, which must be there
	function enter(v: unknown, k: Key): Key {
		const list = isList(v)
		if (typeof k !== (list ? "number" : "string") || !list && !isPojo(v)) fail("wrong-kind")
		if (list ? (k as number) >= v.length : !Object.hasOwn(v as object, k)) fail("no-key")
		return k
	}
	// what is at path, unchanged; short: that many keys short of it
	function get(path: readonly Key[], short = 0): unknown {
		let v = work.root
		for (let i = 0; i < path.length - short; i++) {
			v = (v as Record<Key, unknown>)[enter(v, path[i])]
		}
		return v
	}
	// the container holding path's last key, made own along the way; [] has none
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
		// the root taken by a move: nothing there, as at a key
		if (v === ABSENT) fail("no-key")
		if (a > b) fail("range")
		// l: a lone high met a lone low at the left edge, which the undo widens over
		let l = 0, back: unknown
		if (typeof v === "string") {
			const at = memo !== null && memo.s === v ? near(v, a, b, false, memo) : walk(v, a, b)
			if (!at) fail("range")
			if (w !== undefined && typeof w !== "string") fail("wrong-kind")
			const [x, y, n] = at!
			const add = (w ?? "") as string, o = v.slice(0, x) + add + v.slice(y), e = x + add.length
			// a lone high met by a lone low: l at the left edge, r at the right (nothing put in: both
			// edges are one). one pair now, a position fewer, and the finger may be inside it. rare:
			// forget, the next walks
			l = +joins(o, x)
			const r = add ? +joins(o, e) : l
			size = add ? count(add) : 0
			joined = l + r > 0
			memo = joined ? null : { s: o, n: n >= 0 ? n - (b - a) + size : -1, k: a + size, i: e }
			taken = v.slice(x, y)
			set(path, o)
			// the undo puts the other half of a pair made back, with what was there
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
				// spread past ~100k arguments overflows the stack: rebuild
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
				// in place only when the length stays
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
	// what is at path becomes w (undefined: removed, ABSENT at []); what was there (ABSENT: nothing)
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
			// a key of "__proto__" is a key: an engine with the setter would set the prototype
		} else if (k === "__proto__") define(at, k, w)
		else at[k] = w
		return old
	}

	// the patch landed: its undo pushed when wanted
	function step(p: Patch, i: number): void {
		which = i
		const P = p.path, has = "value" in p, w = p.value
		// nothing there: only a put at the whole
		if (work.root === ABSENT && (P.length || p.range || !has)) fail("no-key")
		if (p.move) return move(p, p.move)
		if (p.range) return void push(splice(P, p.range[0], p.range[1], w))
		if (w === undefined && has) fail("not-a-patch")
		// removing a missing map key: nothing
		const k = P[P.length - 1], at = w === undefined && P.length ? get(P, 1) : undefined
		if (isPojo(at) && typeof k === "string" && !Object.hasOwn(at, k)) return
		const old = set(P, w)
		if (undone) push(isList(at) ? ins(P, mine([old])) : restore(P, old))
	}

	// a move is a take, then a landing in what is left
	function move(p: Patch, from: Target): void {
		const P = p.path, F = from.path, r = from.range
		if (under(p, from)) fail("into-itself")
		// onto itself, a key or an element or the whole: nothing changes, once it is there
		if (!p.range && !r && within(P, F) && within(F, P)) return void get(F)
		// the gap the take leaves (back), what puts it back there (taken0), whether the take joined
		// lone surrogates or was out of a list (awry: the undo cannot move it back whole)
		let m: unknown, back: Target = { path: F }, taken0: Patch | null = null, awry = false
		if (r) {
			taken0 = splice(F, r[0], r[1], undefined)
			m = taken
			back = { path: F, range: [r[0], r[0]] }
			awry = joined
		} else {
			m = set(F, undefined)
			// a missing map key: nothing to take
			if (m === ABSENT) fail("no-key")
			if (undone) {
				awry = F.length > 0 && isList(get(F, 1))
				if (awry) back = gap(F)
				taken0 = awry ? ins(F, mine([m])) : restore(F, m)
			}
		}
		// in place, what the undo holds of what moved is a copy: the tree goes on changing
		// (a refused call takes back with what moved itself: clones, copy then it)
		let untake = taken0
		if (!cow && taken0 && "value" in taken0) {
			const c = clone(taken0.value)
			if (c !== taken0.value) (work.clones ??= new Map()).set(c, taken0.value)
			untake = { ...taken0, value: c }
		}
		// the move back to the gap, from where what moved landed
		const to = (there: Target): Patch => ({ ...back, move: there })
		// the undo of the landing (ups), or what undoes it alone (land), then the take's
		let ups: (Patch | false)[] | undefined, land: Patch | null = null
		// a move's undo is the landing's, then the take's. better, one move back, with what the
		// landing replaced put beside what moved first: exact unless a path back would be
		// into-itself, a lone surrogate met another (a string's), or what moved cannot be moved back
		// whole (the whole, or a string or typed array out of a list)
		try {
			if (!p.range) {
				const listy = undone && P.length > 0 && isList(get(P, 1))
				// a span out of a list lands whole: owned's to keep
				const old = set(P, owned && r && isList(m) ? owned(m) : m)
				if (undone) {
					land = restore(P, old)
					const at: Target = { path: P }
					if (r) {
						// the span back, out of the sequence it became, which is then put back, its place
						// moved by the n put back in front of it, if both are in one list
						const n = r[1] - r[0]
						if (!awry && !within(P, F)) {
							ups = [
								n > 0 && to({ path: P, range: [0, n] }),
								restore(shift(P, back, n), old),
							]
						}
					} else if (listy) {
						// what was replaced goes in beside it first
						if (!under(back, at)) ups = [ins(P, mine([old]), 1), to(at)]
					} else if (!within(P, back.path)) {
						// a map's key: put back once what moved has left it
						ups = [to(at), old !== ABSENT && restore(shift(P, back), old)]
					}
				}
			} else {
				const [a, b] = p.range
				// one element into a list's span: as a list of one
				const one = isList(get(P)) && !r
				land = splice(P, a, b, one ? [m] : m)
				if (undone) {
					const t = taken as ArrayLike<unknown>
					const at: Target = one ? { path: [...P, a] } : { path: P, range: [a, a + size] }
					// a lone high at the end of what moved would meet a lone low that begins what it
					// replaced
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
			// in place the take stands: the undo must have it put back
			if (!cow) push(taken0)
			throw e
		}
		if (undone) (ups ?? [land, untake]).forEach(push)
	}

	// each patch's undo as it lands (null: nothing); the undo of all is read off it last patch first
	const undone: Patch[] | undefined = undo ? [] : undefined
	const push: (p: Patch | null | false) => void = !undone ? none : (p) => {
		if (!p) return
		if ("value" in p) keep!(p.value)
		undone.push(p)
	}
	// v and what of it was made here: never changed here again, the undo holds it
	const keep = undone && ((v: unknown) => {
		// by a stack, not recursion: a value may be nested deeper than the call stack holds
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

// in place, a refused call taken back: what is at v's place once each container put new in
// another's place is the one it replaced again (a typed array given what it holds now: it may
// have changed in place before it was replaced). only the containers that may hold one are walked
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

// lists, maps and typed arrays copied all the way down; the rest (strings, numbers, bytes) as is
function clone(v: unknown): unknown {
	const leaf = (x: unknown) => isList(x) ? [] : isPojo(x) ? {} : isTyped(x) ? x.slice() : x
	const out = leaf(v)
	// by a stack, not recursion: a value may be nested deeper than the call stack holds
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

// b is a, or under it
const within = (a: readonly Key[], b: readonly Key[]) =>
	a.length <= b.length && a.every((k, i) => k === b[i])

// p's place lies inside what from takes: under its path, or in its span
function under(p: Target, from: Target) {
	const f = from.path, q = p.path, r = from.range, k = q[f.length]
	return within(f, q) &&
		(r ? typeof k === "number" && k >= r[0] && k < r[1] : q.length > f.length)
}

// path, once n elements are put in at the gap of at, a list's range
function shift(path: readonly Key[], at: Target, n = 1): readonly Key[] {
	const d = at.path.length, i = path[d] as number
	if (!n || !at.range || path.length <= d || !within(at.path, path) || i < at.range[0]) return path
	const out = path.slice()
	out[d] = i + n
	return out
}

// the undo of all the patches: each patch's (from its mark in undone), the last patch's first
function unroll(undone: Patch[], marks: number[], out: Patch[] = []) {
	for (let j = marks.length - 1, end = undone.length; j >= 0; end = marks[j--]) {
		for (let k = marks[j]; k < end; k++) out.push(undone[k])
	}
	return out
}

// the patches, in order, on value (undefined: nothing there); the value after them (undefined:
// nothing there). a put at [] makes a value where there is none
export default function apply(
	value: unknown,
	patches: Iterable<Patch>,
	options: Options = {},
): unknown {
	const undo = options.undo, cow = options.cow !== false
	// in place the undo is built even if not asked for: it is how a refused patch is taken back
	const { work, step, undone } = createWork(
		value !== undefined ? value : ABSENT,
		undo !== undefined || !cow,
		cow,
		options.owned,
	)
	// each patch's undo starts at its mark
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
			// what the taking back changes may come to hold what was put new: walked after
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
