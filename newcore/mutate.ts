// patches applied to one object of a node, as one change (GRAPH.tex, Patches and Edits)
// what a patch touches is new, the rest is shared; a copy made here may change in place,
// since only the end is ever seen. any patch invalid: it throws, and nothing changes
import createChange, { type Change, type Header } from "./change.ts"
import type { Node } from "./node.ts"
import type { Key, Patch } from "./notify.ts"

// which object: the value, an info name, or a name's list
export type Which = "value" | readonly ["info", string] | readonly ["children", string]

// the change's header (change.ts): time, actor, and reader, site, cause when given
export type Options = Header & {
	// told of each patch once the change is in, in order, with the content before it (notify's
	// patched), and the node's id and which object; given: no copy changes in place across
	// patches, so each before stays as it was
	patched?: (patch: Patch, before: unknown, node: string, which: Which) => void
}

export type Code = "not-a-patch" | "no-key" | "range" | "wrong-kind" | "into-itself"

export class MutateError extends Error {
	constructor(readonly code: Code, readonly patch: number) {
		super(`${code} (patch ${patch})`)
	}
}

type Typed = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
const typed = (v: unknown): v is Typed => ArrayBuffer.isView(v) && !(v instanceof DataView)
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

// a string's UTF-16 unit at code point n, walking no further than it must
function unit(s: string, n: number): number {
	let i = 0
	for (let k = 0; k < n; k++) {
		if (i >= s.length) return -1
		const c = s.charCodeAt(i)
		i += c >= 0xd800 && c < 0xdc00 ? 2 : 1
	}
	return i
}
function len(v: unknown): number {
	if (typeof v === "string") {
		let n = 0
		for (let i = 0; i < v.length; i++, n++) {
			const c = v.charCodeAt(i)
			if (c >= 0xd800 && c < 0xdc00) i++
		}
		return n
	}
	return (v as unknown[] | Typed).length
}

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
		return shape(p.move as Patch)
	}
	return true
}

// one edit's content, changed patch by patch
function createWork(root: unknown) {
	// made here: may change in place
	let own = new WeakSet<object>()
	const copy = <T extends object>(v: T): T => {
		if (own.has(v)) return v
		const c = (isList(v) ? v.slice() : { ...v }) as T
		own.add(c)
		return c
	}
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
	// what is at path, unchanged
	function get(path: readonly Key[]): unknown {
		let v = work.root
		if (v === ABSENT && path.length) fail("no-key")
		for (const k of path) v = (v as Record<Key, unknown>)[enter(v, k)]
		return v
	}

	// the span [a, b) of what is at path replaced by w (undefined: removed); what was there
	function splice(path: readonly Key[], a: number, b: number, w: unknown): unknown {
		const v = get(path)
		if (typeof v !== "string" && !isList(v) && !typed(v)) fail("wrong-kind")
		if (a > b || b > len(v)) fail("range")
		let out: unknown, taken: unknown
		if (typeof v === "string") {
			if (w !== undefined && typeof w !== "string") fail("wrong-kind")
			const x = unit(v, a), y = unit(v, b)
			taken = v.slice(x, y)
			out = v.slice(0, x) + (w ?? "") + v.slice(y)
		} else if (isList(v)) {
			if (w !== undefined && !isList(w)) fail("wrong-kind")
			const l = copy(v)
			taken = l.splice(a, b - a, ...(w as unknown[] ?? []))
			out = l
		} else {
			const t = v as Typed
			if (w !== undefined && (!typed(w) || w.constructor !== t.constructor)) fail("wrong-kind")
			const wn = w ? (w as Typed).length : 0
			const n = new (t.constructor as new (n: number) => Typed)(t.length - (b - a) + wn)
			n.set(t.subarray(0, a), 0)
			if (w) n.set(w as Typed, a)
			n.set(t.subarray(b), a + wn)
			taken = t.slice(a, b)
			out = n
		}
		set(path, out)
		return taken
	}
	// what is at path becomes w (undefined: removed, ABSENT at [])
	function set(path: readonly Key[], w: unknown) {
		if (path.length === 0) return void (work.root = w ?? ABSENT)
		const at = parent(path), k = path[path.length - 1]
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
	function take(p: { path: readonly Key[]; range?: readonly [number, number] }): unknown {
		if (p.range) return splice(p.path, p.range[0], p.range[1], undefined)
		const v = get(p.path)
		set(p.path, undefined)
		return v
	}

	function apply(p: Patch) {
		// nothing there: only a put at the whole
		if (work.root === ABSENT && (p.path.length || p.range || !("value" in p))) fail("no-key")
		if (p.move) {
			const from = p.move
			if (under(p, from)) fail("into-itself")
			const was = take(from)
			if (!p.range) return set(p.path, was)
			const v = get(p.path)
			// one element into a list's span: as a list of one
			const w = isList(v) && !from.range ? [was] : was
			return void splice(p.path, p.range[0], p.range[1], w)
		}
		const w = "value" in p ? p.value : undefined
		if (p.range) return void splice(p.path, p.range[0], p.range[1], w)
		if (w === undefined && "value" in p) fail("not-a-patch")
		// removing a missing map key: nothing
		if (w === undefined && p.path.length) {
			const at = get(p.path.slice(0, -1)), k = p.path[p.path.length - 1]
			if (isMap(at) && typeof k === "string" && !Object.hasOwn(at, k)) return
		}
		set(p.path, w)
	}
	// what is made from here on is new: what was made before stays as it is
	const keep = () => void (own = new WeakSet())
	return { work, apply, keep }
}

// p's place lies inside what from takes: under its path, or in its span
function under(p: Patch, from: { path: readonly Key[]; range?: readonly [number, number] }) {
	const f = from.path, q = p.path
	if (q.length < f.length || !f.every((k, i) => k === q[i])) return false
	if (!from.range) return q.length > f.length
	if (q.length === f.length) return false
	const k = q[f.length]
	return typeof k === "number" && k >= from.range[0] && k < from.range[1]
}

// the object's versions on the node; set: replaces them, an empty list removing the object
function versions<V, H>(node: Node<V, H>, which: Which) {
	if (which === "value") {
		return {
			get: () => node.value as { content: unknown; change: H; because?: unknown }[],
			set: (vs: unknown[]) => void (node.value = vs as Node<V, H>["value"]),
		}
	}
	const [part, name] = which
	const m = (part === "info" ? node.info : node.children) as Map<string, unknown[]>
	return {
		get: () => (m.get(name) ?? []) as { content: unknown; change: H; because?: unknown }[],
		set: (vs: unknown[]) => void (vs.length ? m.set(name, vs) : m.delete(name)),
	}
}

// the patches, in order, to the object's first version, as one change; the change answered.
// none there: a put at [] makes it; a list starts as []. a list left empty: its version removed
export default function mutate<V>(
	node: Node<V, Change>,
	which: Which,
	patches: Iterable<Patch>,
	options: Options,
): Change {
	const vs = versions(node, which)
	const before = vs.get()
	const list = which !== "value" && which[0] === "children"
	const start = before.length ? before[0].content : list ? [] : ABSENT
	const { patched, ...header } = options
	const { work, apply, keep } = createWork(start)
	const seen: [Patch, unknown][] = []
	let i = 0
	for (const p of patches) {
		try {
			if (!shape(p)) fail("not-a-patch")
			if (patched) seen.push([p, work.root === ABSENT ? undefined : work.root]), keep()
			apply(p)
		} catch (e) {
			if (e instanceof Fail) throw new MutateError(e.code, i)
			throw e
		}
		i++
	}
	const change = createChange(node.id, header)
	const gone = work.root === ABSENT || list && (work.root as unknown[]).length === 0
	const rest = before.slice(1)
	if (gone) vs.set(rest)
	else {
		const first = { content: work.root, change } as typeof before[0]
		if (before.length && "because" in before[0]) first.because = before[0].because
		vs.set([first, ...rest])
	}
	for (const [p, b] of seen) patched!(p, b, node.id, which)
	return change
}
