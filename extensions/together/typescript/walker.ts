// walker: eg-walker (egwalker.ts) kept between merges for one node. the replay's state stays, and
// a later merge applies only the commits it lacks, then reads the heads' version. same tables as
// egwalker, by its rules; only how differs:
// - ids: (commit, n), commits by (lamport, name), so a commit arriving below applied ones needs no
//   renumbering. the start's: below all
// - a commit's version: a bitset over commits applied here; any causal apply order gives the same
// - a merge: commits since the start the heads follow and not yet applied, in causal order; then
//   read in the heads' version (rule 9 for changes)
// - the start: since's (history.ts), one commit or none
// rebuilt when asked for the history's heads and one does not follow from the start, after more
// than LIMIT commits since built, or for another history. heads before the start it can't give:
// egwalker itself. one head is no reason to drop it (concurrent commits may still come). sync drops
// every walker on a rule switch, and all on reload.
import { type Commit, decode } from "@ermine/encoding/commit"
import type { ChangeHeader } from "@ermine/node/entry"
import { hex } from "./hex.ts"
import { follows, type History, type Kept, since } from "./history.ts"
import { changeOf, type Merge, type Tables } from "./replay.ts"

// more commits than this applied since it was built: built again from a later start, the next
// time the history's heads are asked for (a start as far back gives as many again first)
export const LIMIT = 1024

type Key = string | number
type Patch = Commit["patches"][number]
type Get = Parameters<Merge>[2]

// c: the commit's place here (in the order applied), START the start's; n: its count within
const START = -1
type Id = { c: number; n: number }

type Write = { id: Id; value: Value | undefined }
type Slot = Write[]
type Typed = { new (n: number): ArrayLike<unknown> & { [i: number]: unknown } }
type Value =
	| { kind: "leaf"; leaf: unknown }
	| { kind: "map"; keys: Map<string, Slot> }
	| { kind: "seq"; of: "string" | "list" | "typed"; make?: Typed; items: Item[] }
type Item = { id: Id; origin: Item | null; gone: number[]; slot?: Slot; atom?: unknown }

type Bits = Uint32Array
const has = (b: Bits, c: number) => (c >>> 5) < b.length && ((b[c >>> 5] >>> (c & 31)) & 1) === 1

// a name's hex, once: names are the history's, kept as long as it is
const names = new WeakMap<Uint8Array, string>()
function key(name: Uint8Array): string {
	let k = names.get(name)
	if (k === undefined) names.set(name, k = hex(name))
	return k
}

// the history's own heads
function current(history: History, heads: readonly Kept[]) {
	const now = history.heads()
	if (now.length !== heads.length) return false
	const want = new Set(heads.map((k) => key(k.name)))
	return now.every((k) => want.has(key(k.name)))
}

// a merge by eg-walker that keeps its work between calls, for one node's history. egwalker: the
// rule itself (egwalker.ts), asked when the state can't give the heads; limit: LIMIT, or fewer to
// see it built again
export function createWalker(egwalker: Merge, limit = LIMIT): Merge {
	let state: State | undefined
	return (history, heads, get) => {
		if (state?.history === history) {
			const now = current(history, heads)
			if (!now || state.grown() <= limit) {
				const out = state.merge(heads)
				if (out !== undefined) return out
			}
			if (!now) return egwalker(history, heads, get)
		}
		state = build(history, heads, get)
		return state.merge(heads) ?? egwalker(history, heads, get)
	}
}

type State = {
	history: History
	// the commits applied since it was built
	grown(): number
	// the heads' tables; undefined: they don't follow from all of the start
	merge(heads: readonly Kept[]): Tables | undefined
}

// the state from the start since gives for heads, every commit since applied
function build(history: History, heads: readonly Kept[], get: Get): State {
	let had: { at: string; tables: Tables | undefined } | undefined
	// one commit only: a commit on one of several would not follow from all of them, and the state
	// would be built again at once
	const known = (from: readonly Kept[]) => {
		if (from.length !== 1) return false
		const at = from.map((k) => key(k.name)).join(" ")
		if (had?.at !== at) had = { at, tables: get(from.map((k) => k.name)) }
		return had.tables !== undefined
	}
	const { from, commits } = since(history, heads, known)
	const state = walker(history, from[0], from.length === 0 ? {} : had!.tables!)
	for (const k of commits) state.apply(k)
	state.built = commits.length
	return state
}

// from: the start's commit, none for nothing; start: its tables
function walker(history: History, from: Kept | undefined, start: Tables) {
	const first = from === undefined ? undefined : key(from.name)
	// the commits applied, by place: each one's version, order, table, whether it applied
	const commits: Kept[] = []
	const index = new Map<string, number>()
	const versions: Bits[] = []
	const lamports: number[] = []
	const order: string[] = []
	// each table: the commits that applied naming it, by place
	const named = new Map<string, number[]>()
	const roots = new Map<string, Slot>()
	const firsts = Object.keys(start)
	const startChanges = new Map<string, ChangeHeader>()

	let me = START, count = 0
	let sees = (_c: number) => true
	let undo: (() => void)[] = []
	const id = (): Id => ({ c: me, n: count++ })
	const after = (a: Id, b: Id) => {
		if (a.c === b.c) return a.n > b.n
		if (a.c === START) return false
		if (b.c === START) return true
		const x = lamports[a.c], y = lamports[b.c]
		return x !== y ? x > y : order[a.c] > order[b.c]
	}

	function make(v: unknown): Value {
		if (typeof v === "string") {
			const out: Value = { kind: "seq", of: "string", items: [] }
			let origin: Item | null = null
			for (const c of v) origin = put(out.items, { id: id(), origin, gone: [], atom: c })
			return out
		}
		if (isList(v)) {
			const out: Value = { kind: "seq", of: "list", items: [] }
			let origin: Item | null = null
			for (const x of v) origin = put(out.items, element(x, origin))
			return out
		}
		if (isTyped(v)) {
			const make = v.constructor as Typed
			const out: Value = { kind: "seq", of: "typed", make, items: [] }
			let origin: Item | null = null
			for (const x of Array.from(v)) {
				origin = put(out.items, { id: id(), origin, gone: [], atom: x })
			}
			return out
		}
		if (isMap(v)) {
			const keys = new Map<string, Slot>()
			for (const k of Object.keys(v)) keys.set(k, [{ id: id(), value: make(v[k]) }])
			return { kind: "map", keys }
		}
		return { kind: "leaf", leaf: v }
	}
	function element(x: unknown, origin: Item | null): Item {
		const i = id()
		return { id: i, origin, gone: [], slot: [{ id: i, value: make(x) }] }
	}
	function put(items: Item[], item: Item): Item {
		let at = item.origin === null ? 0 : items.indexOf(item.origin) + 1
		while (at < items.length && after(items[at].id, item.id)) at++
		items.splice(at, 0, item)
		undo.push(() => items.splice(items.indexOf(item), 1))
		return item
	}

	function read(slot: Slot | undefined): Value | undefined {
		let top: Write | undefined
		for (const w of slot ?? []) {
			if (sees(w.id.c) && (top === undefined || after(w.id, top.id))) top = w
		}
		return top?.value
	}
	const shown = (it: Item) => sees(it.id.c) && !it.gone.some(sees)
	const visible = (v: Value & { kind: "seq" }) => v.items.filter(shown)
	function write(slot: Slot, value: Value | undefined) {
		slot.push({ id: id(), value })
		undo.push(() => slot.pop())
	}
	function remove(it: Item) {
		it.gone.push(me)
		undo.push(() => it.gone.pop())
	}

	function show(v: Value): unknown {
		if (v.kind === "leaf") return v.leaf
		if (v.kind === "map") {
			const out: Record<string, unknown> = {}
			for (const k of [...v.keys.keys()].sort(canonical)) {
				const x = read(v.keys.get(k))
				if (x === undefined) continue
				Object.defineProperty(out, k, {
					value: show(x),
					writable: true,
					enumerable: true,
					configurable: true,
				})
			}
			return out
		}
		const items = visible(v)
		if (v.of === "string") return items.map((it) => it.atom).join("")
		if (v.of === "list") return items.map((it) => show(read(it.slot)!))
		const out = new v.make!(items.length)
		items.forEach((it, i) => out[i] = it.atom)
		return out
	}

	function land(root: Slot, patches: readonly Patch[]) {
		function at(path: readonly Key[], n = path.length): Value {
			let v = read(root) ?? fail()
			for (let i = 0; i < n; i++) {
				const k = path[i]
				if (v.kind === "map" && typeof k === "string") v = read(v.keys.get(k)) ?? fail()
				else if (v.kind === "seq" && v.of === "list" && typeof k === "number") {
					v = read((visible(v)[k] ?? fail()).slot)!
				} else fail()
			}
			return v
		}
		function set(path: readonly Key[], value: unknown) {
			if (path.length === 0) return write(root, make(value))
			const p = at(path, path.length - 1), k = path[path.length - 1]
			if (p.kind === "map" && typeof k === "string") {
				let slot = p.keys.get(k)
				if (slot === undefined) {
					p.keys.set(k, slot = [])
					undo.push(() => p.keys.delete(k))
				}
				write(slot, make(value))
			} else if (p.kind === "seq" && p.of === "list" && typeof k === "number") {
				write((visible(p)[k] ?? fail()).slot!, make(value))
			} else fail()
		}
		function unset(path: readonly Key[]) {
			if (path.length === 0) return write(root, undefined)
			const p = at(path, path.length - 1), k = path[path.length - 1]
			if (p.kind === "map" && typeof k === "string") {
				const slot = p.keys.get(k)
				if (read(slot) !== undefined) write(slot!, undefined)
			} else if (p.kind === "seq" && p.of === "list" && typeof k === "number") {
				remove(visible(p)[k] ?? fail())
			} else fail()
		}
		function splice(path: readonly Key[], a: number, b: number, value: unknown): unknown {
			const v = at(path)
			if (v.kind !== "seq" || a > b) return fail()
			const items = visible(v)
			if (b > items.length) fail()
			let atoms: unknown[] | undefined
			if (value !== undefined) {
				if (v.of === "string" && typeof value === "string") atoms = [...value]
				else if (v.of === "list" && isList(value)) atoms = value
				else if (v.of === "typed" && isTyped(value) && value.constructor === v.make) {
					atoms = Array.from(value)
				} else fail()
			}
			const taken = items.slice(a, b)
			const was = v.of === "string"
				? taken.map((it) => it.atom).join("")
				: v.of === "list"
				? taken.map((it) => show(read(it.slot)!))
				: Object.assign(new v.make!(taken.length), taken.map((it) => it.atom))
			for (const it of taken) remove(it)
			let origin = a > 0 ? items[a - 1] : null
			for (const x of atoms ?? []) {
				origin = put(
					v.items,
					v.of === "list" ? element(x, origin) : { id: id(), origin, gone: [], atom: x },
				)
			}
			return was
		}
		function move(p: Patch, from: NonNullable<Patch["move"]>) {
			if (under(p, from)) fail()
			if (!p.range && !from.range && same(p.path, from.path)) return void at(from.path)
			let m: unknown
			if (from.range) m = splice(from.path, from.range[0], from.range[1], undefined)
			else {
				m = show(at(from.path))
				unset(from.path)
			}
			if (!p.range) return set(p.path, m)
			const there = at(p.path)
			const one = there.kind === "seq" && there.of === "list" && !from.range
			splice(p.path, p.range[0], p.range[1], one ? [m] : m)
		}

		for (const p of patches) {
			if (read(root) === undefined && (p.path.length || p.range || !("value" in p))) fail()
			if (p.move) move(p, p.move)
			else if (p.range) splice(p.path, p.range[0], p.range[1], p.value)
			else if ("value" in p) set(p.path, p.value)
			else unset(p.path)
		}
	}

	for (const [table, entry] of Object.entries(start)) {
		roots.set(table, [{ id: id(), value: make(entry.value) }])
		startChanges.set(table, entry.change)
	}

	// one commit, its follows applied here or in the start: in its version
	function apply(k: Kept) {
		const i = commits.length
		const version: Bits = new Uint32Array((i >>> 5) + 1)
		for (const p of follows(k)) {
			const j = index.get(key(p))
			if (j === undefined) continue
			const b = versions[j]
			for (let w = 0; w < b.length; w++) version[w] |= b[w]
			version[j >>> 5] |= 1 << (j & 31)
		}
		commits.push(k)
		index.set(key(k.name), i)
		versions.push(version)
		lamports.push(k.lamport)
		order.push(key(k.name))
		const c = decode(k.bytes)
		me = i, count = 0, undo = []
		sees = (x) => x === START || x === i || has(version, x)
		let root = roots.get(c.table)
		if (root === undefined) {
			roots.set(c.table, root = [])
			undo.push(() => roots.delete(c.table))
		}
		try {
			land(root, c.patches)
			let list = named.get(c.table)
			if (!list) named.set(c.table, list = [])
			list.push(i)
		} catch (e) {
			if (!(e instanceof Fail)) throw e
			for (let j = undo.length - 1; j >= 0; j--) undo[j]()
		}
		sees = () => true
	}

	// the commits heads follow from, since the start, not applied yet, in causal order; undefined:
	// one of them doesn't follow from the start
	function missing(heads: readonly Kept[]): Kept[] | undefined {
		const out = new Map<string, Kept>()
		const stack = [...heads]
		while (stack.length) {
			const k = stack.pop()!, n = key(k.name)
			if (index.has(n) || n === first || out.has(n)) continue
			const up = follows(k)
			// below the start or beside it: its lamport no higher, or a root
			if (from !== undefined && (k.lamport <= from.lamport || up.length === 0)) return
			out.set(n, k)
			for (const p of up) {
				const q = history.get(p)
				if (q !== undefined) stack.push(q)
			}
		}
		return [...out.values()].sort((a, b) =>
			a.lamport !== b.lamport ? a.lamport - b.lamport : key(a.name) < key(b.name) ? -1 : 1
		)
	}

	// the tables in a version (the commits applied here in it), as the replay ends with
	function tables(version: Bits): Tables {
		sees = (x) => x === START || has(version, x)
		const out: Tables = {}
		// each table's first and latest commit in the version
		const span = new Map<string, [number, number]>()
		for (const [table, list] of named) {
			let lo = -1, hi = -1
			for (const i of list) {
				if (!has(version, i)) continue
				if (lo === -1 || after({ c: lo, n: 0 }, { c: i, n: 0 })) lo = i
				if (hi === -1 || after({ c: i, n: 0 }, { c: hi, n: 0 })) hi = i
			}
			if (lo !== -1) span.set(table, [lo, hi])
		}
		const rest = [...span.keys()].filter((t) => !startChanges.has(t))
		rest.sort((a, b) =>
			after({ c: span.get(a)![0], n: 0 }, { c: span.get(b)![0], n: 0 }) ? 1 : -1
		)
		for (const table of [...firsts, ...rest]) {
			const v = read(roots.get(table))
			if (v === undefined) continue
			const s = span.get(table)
			const change = s === undefined
				? startChanges.get(table)!
				: changeOf(decode(commits[s[1]].bytes), commits[s[1]].name)
			out[table] = { value: show(v), change }
		}
		sees = () => true
		return out
	}

	return {
		history,
		built: 0,
		grown() {
			return commits.length - this.built
		},
		apply,
		merge(heads: readonly Kept[]): Tables | undefined {
			const walked = missing(heads)
			if (walked === undefined) return
			for (const k of walked) apply(k)
			const version: Bits = new Uint32Array((commits.length >>> 5) + 1)
			for (const h of heads) {
				const j = index.get(key(h.name))
				if (j === undefined) continue
				const b = versions[j]
				for (let w = 0; w < b.length; w++) version[w] |= b[w]
				version[j >>> 5] |= 1 << (j & 31)
			}
			return tables(version)
		},
	}
}

// shared with egwalker.ts
export class Fail extends Error {}
export const fail = (): never => {
	throw new Fail()
}

export const isList = Array.isArray
export function isMap(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || isList(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}
// a typed array: a sequence. bytes (a Uint8Array) are one whole value
export const isTyped = (v: unknown): v is ArrayLike<unknown> =>
	ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof Uint8Array)

const utf8 = new TextEncoder()
export function canonical(a: string, b: string): number {
	const x = utf8.encode(a), y = utf8.encode(b)
	if (x.length !== y.length) return x.length - y.length
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}

export const same = (a: readonly Key[], b: readonly Key[]) =>
	a.length === b.length && a.every((k, i) => k === b[i])
// p's place lies inside what from takes: under its path, or in its span (apply.ts's)
export function under(
	p: { path: readonly Key[] },
	from: { path: readonly Key[]; range?: readonly number[] },
) {
	const f = from.path, q = p.path
	if (q.length < f.length || !f.every((k, i) => k === q[i])) return false
	if (!from.range) return q.length > f.length
	if (q.length === f.length) return false
	const k = q[f.length]
	return typeof k === "number" && k >= from.range[0] && k < from.range[1]
}
