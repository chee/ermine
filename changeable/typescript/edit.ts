// Like immer's produce, but returns the patches a recipe made instead of the value after them.
// Base is never changed; whatever the recipe doesn't touch is shared with it.
//
// Rules:
// - Plain objects, arrays and typed arrays (bytes too) are drafted. Everything else is a
//   leaf, read as it is: strings, numbers, Map, Set, class instances. Changing a leaf in
//   place changes base too, so don't; assign a new one.
// - Strings and typed arrays can be edited in place with the splice helper (the recipe's second
//   argument).
// - Assigning undefined to an object key removes the key. Anywhere in an array (index, push,
//   fill...) it throws: splice the element out instead.
// - Arrays have no holes. Setting an index past the end, a longer length, or `delete` on an
//   element throws.
// - Symbol keys, defineProperty and setPrototypeOf on a draft throw.
// - Assigning a draft somewhere puts a snapshot of its value at that moment, not an alias.
// - Using a draft after edit returns throws.
// - A recipe may return a value instead; it replaces the whole root.
import type { Key, Patch } from "./apply.ts"
import { isTyped, type Typed } from "@ermine/changeable/kinds"
import { walk } from "@ermine/changeable/walk-string"

export const nothing = /* @__PURE__ */ Symbol("nothing")

type Kind = "map" | "list" | "typed"
type Context = { out: Patch[]; done: boolean; top?: string }
type Node = {
	kind: Kind
	base: any
	copy?: any
	dirty: boolean
	parent?: Node
	key?: string
	context: Context
	proxy?: object
}

function plain(v: object) {
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}
function kind(v: unknown): Kind | undefined {
	if (v === null || typeof v !== "object") return
	if (Array.isArray(v)) return "list"
	if (isTyped(v)) return "typed"
	if (plain(v)) return "map"
}

const nodes = /* @__PURE__ */ new WeakMap<object, Node>()
const node = (v: unknown) => typeof v === "object" && v !== null ? nodes.get(v) : undefined

const state = (n: Node) => n.copy ?? n.base
function shallow(v: any, k: Kind) {
	if (k !== "map") return v.slice()
	return Object.getPrototypeOf(v) === null ? { __proto__: null, ...v } : { ...v }
}
const own = (n: Node) => n.copy ??= shallow(n.base, n.kind)
// "__proto__" is an ordinary key.
function put(o: any, k: string, v: unknown) {
	if (k === "__proto__") {
		Object.defineProperty(o, k, {
			value: v,
			writable: true,
			enumerable: true,
			configurable: true,
		})
	} else o[k] = v
}
const alive = (n: Node) => {
	if (n.context.done) throw new TypeError("a draft is used after edit returned")
}

function read(n: Node, key: PropertyKey): unknown {
	const v = state(n)[key]
	if (typeof key === "symbol" || node(v) || !kind(v)) return v
	const d = draft(v, n.context, n, String(key))
	own(n)[key as string] = d
	return d
}

function where(n: Node): Key[] | null {
	if (!n.parent) return []
	const up = where(n.parent)
	if (!up) return null
	const s = state(n.parent)
	if (n.parent.kind === "list") {
		const i = s.indexOf(n.proxy)
		return i < 0 ? null : [...up, i]
	}
	return Object.hasOwn(s, n.key!) && s[n.key!] === n.proxy ? [...up, n.key!] : null
}
function emit(n: Node, make: (path: Key[]) => Patch) {
	for (let p: Node | undefined = n; p; p = p.parent) p.dirty = true
	const path = where(n)
	if (path) n.context.out.push(make(path))
}

function build(n: Node): unknown {
	if (!n.dirty) return n.base
	const s = n.copy
	if (n.kind === "typed") return s.slice()
	if (n.kind === "list") return s.map(out)
	const o: any = Object.getPrototypeOf(n.base) === null ? { __proto__: null } : {}
	for (const k of Object.keys(s)) put(o, k, out(s[k]))
	return o
}
const out = (x: unknown) => {
	const d = node(x)
	return d ? build(d) : x
}
function snap(v: unknown): unknown {
	if (typeof v !== "object" || v === null) return v
	const d = nodes.get(v)
	if (d) return build(d)
	const k = kind(v)
	if (k === "list") {
		let o: unknown[] | undefined
		;(v as unknown[]).forEach((x, i) => {
			const y = snap(x)
			if (y !== x) (o ??= (v as unknown[]).slice())[i] = y
		})
		return o ?? v
	}
	if (k === "map") {
		let o: any
		for (const key of Object.keys(v)) {
			const x = (v as any)[key], y = snap(x)
			if (y !== x) {
				if (!o) {
					o = Object.getPrototypeOf(v) === null ? { __proto__: null } : {}
					for (const j of Object.keys(v)) put(o, j, (v as any)[j])
				}
				put(o, key, y)
			}
		}
		return o ?? v
	}
	return v
}
function value(v: unknown): unknown {
	if (v === undefined) {
		throw new TypeError("undefined is no value: delete the key, splice the element out")
	}
	return snap(v)
}

const index = (key: PropertyKey) =>
	typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && +key < 2 ** 32 - 1 ? +key : -1
const toint = (x: unknown) => Math.trunc(Number(x)) || 0

function setkey(n: Node, key: PropertyKey, v: unknown) {
	if (typeof key === "symbol") throw new TypeError("a symbol is no key")
	if (v === undefined) return delkey(n, key)
	const s = state(n)
	if (Object.hasOwn(s, key) && Object.is(s[key], v)) return
	const x = value(v)
	put(own(n), key as string, x)
	emit(n, (path) => ({ path: [...path, key], value: x }))
}
function delkey(n: Node, key: PropertyKey) {
	if (typeof key === "symbol") throw new TypeError("a symbol is no key")
	if (!Object.hasOwn(state(n), key)) return
	delete own(n)[key]
	emit(n, (path) => ({ path: [...path, key] }))
}

function splice(n: Node, at: number, del: number, items: unknown[]): unknown[] {
	const gone: unknown[] = []
	for (let i = at; i < at + del; i++) gone.push(read(n, i))
	if (del === 0 && items.length === 0) return gone
	own(n).splice(at, del, ...items)
	emit(n, (path) => ({
		path,
		range: [at, at + del],
		...(items.length ? { value: items } : {}),
	}))
	return gone
}
function setindex(n: Node, i: number, v: unknown) {
	const s = state(n)
	if (v === undefined) value(v)
	if (i > s.length) throw new RangeError("a list has no holes: push instead")
	if (i === s.length) return void splice(n, i, 0, [value(v)])
	if (Object.is(s[i], v)) return
	const x = value(v)
	own(n)[i] = x
	emit(n, (path) => ({ path: [...path, i], value: x }))
}
function setlength(n: Node, to: unknown) {
	const len = state(n).length
	if (typeof to !== "number" || !Number.isInteger(to) || to < 0 || to > len) {
		throw new RangeError("a list has no holes: a length is a whole number, no more than its own")
	}
	if (to < len) splice(n, to, len - to, [])
}

function ascending(a: number[]): Set<number> {
	const tails: number[] = [], before: number[] = []
	for (let j = 0; j < a.length; j++) {
		let lo = 0, hi = tails.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (a[tails[mid]] < a[j]) lo = mid + 1
			else hi = mid
		}
		before[j] = lo ? tails[lo - 1] : -1
		tails[lo] = j
	}
	const run = new Set<number>()
	for (let j = tails.length ? tails[tails.length - 1] : -1; j >= 0; j = before[j]) run.add(a[j])
	return run
}
const zero = /* @__PURE__ */ Symbol("-0")

// work is old in another order. Emits few moves: the longest run already in order stays, and
// each other element is taken out and put back at the gap after the element that precedes it.
function reorder(n: Node, old: any[], work: any[]) {
	const slots = new Map<unknown, number[]>()
	const key = (x: unknown) => Object.is(x, -0) ? zero : x
	for (let i = old.length - 1; i >= 0; i--) {
		const k = key(old[i]), at = slots.get(k)
		if (at) at.push(i)
		else slots.set(k, [i])
	}
	const was = work.map((x) => slots.get(key(x))!.pop()!)
	const stay = ascending(was), cur = Array.from({ length: old.length }, (_, i) => i)
	for (let j = 0; j < was.length; j++) {
		const id = was[j]
		if (stay.has(id)) continue
		const f = cur.indexOf(id)
		cur.splice(f, 1)
		const k = j === 0 ? 0 : cur.indexOf(was[j - 1]) + 1
		cur.splice(k, 0, id)
		if (f === k) continue
		emit(n, (path) => ({ path, range: [k, k], move: { path, range: [f, f + 1] } }))
	}
}

function rewrite(n: Node, fn: (work: any) => void, reordered = false) {
	const old = state(n), work = old.slice()
	fn(work)
	if (n.kind === "list") {
		const seen = new Set<Node>()
		for (let i = 0; i < work.length; i++) {
			const d = node(work[i])
			if (d) seen.has(d) ? work[i] = build(d) : seen.add(d)
		}
	}
	if (reordered) {
		n.copy = work
		return reorder(n, old, work)
	}
	let a = 0, b = old.length
	while (a < b && Object.is(old[a], work[a])) a++
	if (a === b) return
	while (Object.is(old[b - 1], work[b - 1])) b--
	n.copy = work
	const span = work.slice(a, b)
	const value = n.kind === "list" ? span.map(out) : span
	emit(n, (path) => ({ path, range: [a, b], value }))
}

const from = (x: unknown, len: number) => {
	const i = toint(x)
	return i < 0 ? Math.max(len + i, 0) : Math.min(i, len)
}
const lists = /* @__PURE__ */ new Map<string, (n: Node, ...a: any[]) => unknown>([
	["push", (n, ...xs) => {
		splice(n, state(n).length, 0, xs.map(value))
		return state(n).length
	}],
	["unshift", (n, ...xs) => {
		splice(n, 0, 0, xs.map(value))
		return state(n).length
	}],
	["pop", (n) => {
		const len = state(n).length
		return len ? splice(n, len - 1, 1, [])[0] : undefined
	}],
	["shift", (n) => state(n).length ? splice(n, 0, 1, [])[0] : undefined],
	["splice", (n, ...a) => {
		const len = state(n).length
		if (a.length === 0) return []
		const at = from(a[0], len)
		const del = a.length === 1 ? len - at : Math.min(Math.max(toint(a[1]), 0), len - at)
		return splice(n, at, del, a.slice(2).map(value))
	}],
	["sort", (n, cmp) => (rewrite(n, (w) => w.sort(cmp), true), n.proxy)],
	["reverse", (n) => (rewrite(n, (w) => w.reverse(), true), n.proxy)],
	["fill", (n, v, s, e) => {
		const x = value(v)
		return rewrite(n, (w) => w.fill(x, s, e)), n.proxy
	}],
	["copyWithin", (n, ...a) => (rewrite(n, (w) => w.copyWithin(...a)), n.proxy)],
])
const typeds = /* @__PURE__ */ new Set(["sort", "reverse", "fill", "copyWithin", "set"])

function mapTraps(n: Node): ProxyHandler<any> {
	return {
		get(_, key) {
			alive(n)
			const s = state(n)
			return Object.hasOwn(s, key) ? read(n, key) : Reflect.get(s, key, s)
		},
		has: (_, key) => (alive(n), Reflect.has(state(n), key)),
		ownKeys: () => (alive(n), Reflect.ownKeys(state(n))),
		getOwnPropertyDescriptor(_, key) {
			alive(n)
			if (!Object.hasOwn(state(n), key)) return
			return { value: read(n, key), writable: true, enumerable: true, configurable: true }
		},
		getPrototypeOf: () => Object.getPrototypeOf(state(n)),
		set: (_, key, v) => (alive(n), setkey(n, key, v), true),
		deleteProperty: (_, key) => (alive(n), delkey(n, key), true),
		defineProperty() {
			throw new TypeError("a draft is changed by assignment")
		},
		setPrototypeOf() {
			throw new TypeError("a draft keeps its prototype")
		},
	}
}
function listTraps(n: Node): ProxyHandler<any> {
	return {
		get(_, key, receiver) {
			alive(n)
			const s = state(n)
			if (key === "length") return s.length
			const i = index(key)
			if (i >= 0) return i < s.length ? read(n, i) : undefined
			const m = typeof key === "string" ? lists.get(key) : undefined
			return m ? (...a: unknown[]) => m(n, ...a) : Reflect.get(Array.prototype, key, receiver)
		},
		has: (_, key) => (alive(n), Reflect.has(state(n), key)),
		ownKeys: () => (alive(n), Reflect.ownKeys(state(n))),
		getOwnPropertyDescriptor(_, key) {
			alive(n)
			const s = state(n)
			if (key === "length") {
				return { value: s.length, writable: true, enumerable: false, configurable: false }
			}
			const i = index(key)
			if (i < 0 || i >= s.length) return
			return { value: read(n, i), writable: true, enumerable: true, configurable: true }
		},
		getPrototypeOf: () => Array.prototype,
		set(_, key, v) {
			alive(n)
			if (key === "length") setlength(n, v)
			else {
				const i = index(key)
				if (i < 0) throw new TypeError("a list has only elements")
				setindex(n, i, v)
			}
			return true
		},
		deleteProperty() {
			throw new TypeError("delete leaves a hole in a list: splice it out")
		},
		defineProperty() {
			throw new TypeError("a draft is changed by assignment")
		},
		setPrototypeOf() {
			throw new TypeError("a draft keeps its prototype")
		},
	}
}
function typedTraps(n: Node): ProxyHandler<any> {
	return {
		get(_, key) {
			alive(n)
			const s = state(n), i = index(key)
			if (i >= 0) return s[i]
			if (typeof key === "string" && typeds.has(key)) {
				return (...a: unknown[]) => {
					if (key === "set") a[0] = snap(a[0])
					return rewrite(n, (w) => w[key](...a), key === "sort" || key === "reverse"), n.proxy
				}
			}
			const v = Reflect.get(s, key, s)
			return typeof v === "function" ? v.bind(s) : v
		},
		has: (_, key) => (alive(n), Reflect.has(state(n), key)),
		ownKeys: () => (alive(n), Reflect.ownKeys(state(n))),
		getOwnPropertyDescriptor(_, key) {
			alive(n)
			const s = state(n), i = index(key)
			if (i < 0 || i >= s.length) return
			return { value: s[i], writable: true, enumerable: true, configurable: true }
		},
		getPrototypeOf: () => Object.getPrototypeOf(state(n)),
		set(_, key, v) {
			alive(n)
			const i = index(key), s = state(n)
			if (i < 0) throw new TypeError("a typed array has only elements")
			if (i >= s.length) return true
			const w = new s.constructor(1)
			w[0] = v
			if (!Object.is(w[0], s[i])) {
				own(n)[i] = w[0]
				emit(n, (path) => ({ path, range: [i, i + 1], value: w }))
			}
			return true
		},
		deleteProperty() {
			throw new TypeError("a typed array has no holes")
		},
		defineProperty() {
			throw new TypeError("a draft is changed by assignment")
		},
		setPrototypeOf() {
			throw new TypeError("a draft keeps its prototype")
		},
	}
}

function draft(base: unknown, context: Context, parent?: Node, key?: string): any {
	const k = kind(base)!
	const n: Node = { kind: k, base, dirty: false, parent, key, context }
	const traps = k === "map" ? mapTraps(n) : k === "list" ? listTraps(n) : typedTraps(n)
	n.proxy = new Proxy(k === "list" ? [] : {}, traps)
	nodes.set(n.proxy!, n)
	return n.proxy
}

//   splice(parent, key, start, remove, insert?) replaces a span of the string or typed array at
//   parent[key] (counting code points for a string, as apply does) and returns the new value.
//   splice(text, start, remove, insert?) does the same to the root when base is the string text.
export type Splice = {
	(text: string, start: number, remove: number, insert?: string): string
	(parent: object, key: string | number, start: number, remove: number, insert?: unknown): unknown
}
export type Helpers = { splice: Splice; nothing: typeof nothing }

function helpers(context: Context): Helpers {
	const splice = (...a: any[]): unknown => {
		if (context.done) throw new TypeError("splice is used after edit returned")
		const top = typeof a[0] === "string"
		let at: Node | undefined, key: string | number = ""
		if (top) {
			if (context.top === undefined) throw new TypeError("base is no string")
		} else {
			at = node(a[0])
			key = a[1]
			if (!at) throw new TypeError("splice is given a draft and a key")
			if (at.kind === "list" ? index(String(key)) < 0 : typeof key !== "string") {
				throw new TypeError("not a key")
			}
			if (!Object.hasOwn(state(at), key)) throw new RangeError("no such key")
		}
		const [start, remove, insert] = top ? a.slice(1) : a.slice(2)
		if (!Number.isInteger(start) || !Number.isInteger(remove) || start < 0 || remove < 0) {
			throw new RangeError("a span is whole numbers")
		}
		const end = start + remove
		const v = top ? context.top : state(at!)[key]
		let next: unknown, ins: unknown
		if (typeof v === "string") {
			if (insert !== undefined && typeof insert !== "string") throw new TypeError("not a string")
			const w = walk(v, start, end)
			if (!w) throw new RangeError("past the end")
			next = v.slice(0, w[0]) + (insert ?? "") + v.slice(w[1])
			ins = insert || undefined
		} else {
			const t = node(v) ? state(node(v)!) : v
			if (!isTyped(t)) throw new TypeError("not a string or a typed array")
			const w = insert === undefined ? undefined : snap(insert) as Typed | undefined
			if (w !== undefined && (!isTyped(w) || w.constructor !== t.constructor)) {
				throw new TypeError("not the same kind of typed array")
			}
			if (end > t.length) throw new RangeError("past the end")
			const size = w ? w.length : 0
			const made = new (t.constructor as any)(t.length - remove + size)
			made.set(t.subarray(0, start), 0)
			if (w) made.set(w, start)
			made.set(t.subarray(end), start + size)
			next = made
			ins = size ? w : undefined
		}
		if (remove === 0 && ins === undefined) return v
		const range: [number, number] = [start, end]
		const value = ins === undefined ? {} : { value: ins }
		if (top) {
			context.top = next as string
			context.out.push({ path: [], range, ...value })
		} else {
			put(own(at!), String(key), next)
			emit(at!, (path) => ({ path: [...path, key], range, ...value }))
		}
		return next
	}
	return { splice: splice as Splice, nothing }
}

// Returns the patches the recipe made; a returned value becomes a put at [].
export default function edit<T>(
	base: T,
	recipe: (draft: T, helpers: Helpers) => T | void | typeof nothing,
): Patch[] {
	const context: Context = { out: [], done: false }
	if (typeof base === "string") context.top = base
	try {
		const d = kind(base) ? draft(base, context) : base
		const r = recipe(d, helpers(context))
		if (r === undefined || r === d || Object.is(r, base)) return context.out
		if (context.out.length) throw new TypeError("a recipe changed the draft and returned a value")
		return [r === nothing ? { path: [] } : { path: [], value: value(r) }]
	} finally {
		context.done = true
	}
}
