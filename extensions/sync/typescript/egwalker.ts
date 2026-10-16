// the merge rule "eg-walker" (extensions/subduction/plan.org, Merging): a node's heads merged by
// replaying the commits since their common ancestor into a throwaway CRDT, each commit's patches
// read in the version it was made on, as eg-walker does. pure and deterministic: the same history
// and heads give the same tables on every device. a commit is the same in TS and C, so is this.
//
// the rules, exactly:
// 1. the start (history.ts, since): the latest commit, or set of commits, every commit since follows
//    from (all of it), whose tables get gives (one commit's had without merging, or several merged
//    by this rule, as a device remembers them); else nothing (empty tables). which start is taken
//    does not change the merge. the commits since it are replayed in causal order: lower lamport
//    first, equal lamport the lesser name first. a commit's place in that order is its rank; the
//    start's content has rank -1
// 2. ids: every map write, list element, string code point and typed array element made gets an id
//    (rank, n), n counting up from 0 for what its commit (or the start) makes, in the order made.
//    a value put in is taken apart as it is read: a map's keys in the order they are given, a
//    list's elements and a string's code points first to last, depth first. a later id: the higher
//    rank, then the higher n
// 3. versions: a commit's version is the commits it follows from (history.ts, follows: a merge's
//    parents, a based commit's base, a commit's one parent), and theirs, back to the start, and the
//    commit itself as its patches land. the merge is the version of every commit since
// 4. what a version holds: each table a slot; a slot, a map key or a list element holds the write
//    with the latest id in the version (a removal writes nothing there: absent). a sequence (string,
//    list, typed array) holds its elements made in the version and not removed by a commit in it,
//    in the sequence's order (5)
// 5. a sequence's order (RGA): each element made after the one left of where it went in, in its
//    version (its origin; none at the start). an element is put after its origin, past every
//    element there with a later id; so an element's followers come right after it, the later first
// 6. a patch is read in its commit's version, as apply reads it (core/op apply.ts): a put at a
//    path writes the slot, map key or list element there; a removal writes absent at a map key or
//    the slot, or removes a list element; a splice removes the elements in its range and puts the
//    new ones after the element before it; a move is a removal at its from, then a put of a copy of
//    what was there (new ids) at its path. positions count code points, as patches do
// 7. what follows: concurrent puts at one place, the later id wins (so the later commit, by lamport
//    then name). a put or removal of a value wins over concurrent edits inside it: they were made
//    on what it replaced. concurrent inserts at one place: the later commit's first (5), each
//    commit's run kept whole. text inserted inside a range removed concurrently stays. concurrent
//    edits to a moved value are lost: they land on the place it left
// 8. a commit whose patches do not apply to its version here (a merge by another rule may differ)
//    is left out whole
// 9. each table's change: the change of the latest commit since the start that names it, else the
//    start's. a map's keys come out in canonical order (shorter first, then bytewise)
import { type Commit, decode } from "@ermine/encoding/commit"
import type { ChangeHeader } from "@ermine/node/entry"
import { hex } from "./hex.ts"
import { follows, type Kept, since } from "./history.ts"
import { changeOf, type Merge, type Tables } from "./replay.ts"
import {
	canonical,
	createWalker,
	Fail,
	fail,
	isList,
	isMap,
	isTyped,
	same,
	under,
} from "./walker.ts"

export const name = "eg-walker"

type Key = string | number
type Patch = Commit["patches"][number]

// rank: the commit's place in the replay, -1 the start's; n: its count within
type Id = { rank: number; n: number }
const after = (a: Id, b: Id) => a.rank !== b.rank ? a.rank > b.rank : a.n > b.n

// what is at a place: every write made there; the latest seen holds it (value none: absent)
type Write = { id: Id; value: Value | undefined }
type Slot = Write[]
type Typed = { new (n: number): ArrayLike<unknown> & { [i: number]: unknown } }
type Value =
	| { kind: "leaf"; leaf: unknown }
	| { kind: "map"; keys: Map<string, Slot> }
	| { kind: "seq"; of: "string" | "list" | "typed"; make?: Typed; items: Item[] }
// an element of a sequence: a list's holds a slot, a string's or typed array's an atom
type Item = { id: Id; origin: Item | null; gone: number[]; slot?: Slot; atom?: unknown }

export const egwalker: Merge = (history, heads, get) => {
	// the start's tables, read once
	let had: { at: string; tables: Tables | undefined } | undefined
	const known = (from: readonly Kept[]) => {
		const at = from.map((k) => hex(k.name)).join(" ")
		if (had?.at !== at) had = { at, tables: get(from.map((k) => k.name)) }
		return had.tables !== undefined
	}
	const { from, commits } = since(history, heads, known)
	const start: Tables = from.length === 0 ? {} : had!.tables!

	// each commit's rank, and the ranks in its version
	const rank = new Map<string, number>()
	commits.forEach((k, i) => rank.set(hex(k.name), i))
	const versions: Set<number>[] = commits.map(() => new Set())
	commits.forEach((k, i) => {
		for (const p of follows(k)) {
			const j = rank.get(hex(p))
			if (j === undefined) continue
			versions[i].add(j)
			for (const x of versions[j]) versions[i].add(x)
		}
	})

	// the replay's state: a slot per table, the change each shows
	const roots = new Map<string, Slot>()
	const changes = new Map<string, ChangeHeader>()
	let me = -1, count = 0
	let sees = (_rank: number) => true
	// what the commit being read did, to take back if it does not apply
	let undo: (() => void)[] = []
	const id = (): Id => ({ rank: me, n: count++ })

	for (const [table, entry] of Object.entries(start)) {
		roots.set(table, [{ id: id(), value: make(entry.value) }])
		changes.set(table, entry.change)
	}

	// a value taken apart, new ids
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
	// an element into its sequence: after its origin, past every later one there
	function put(items: Item[], item: Item): Item {
		let at = item.origin === null ? 0 : items.indexOf(item.origin) + 1
		while (at < items.length && after(items[at].id, item.id)) at++
		items.splice(at, 0, item)
		undo.push(() => items.splice(items.indexOf(item), 1))
		return item
	}

	// what a slot holds in the version seen
	function read(slot: Slot | undefined): Value | undefined {
		let top: Write | undefined
		for (const w of slot ?? []) {
			if (sees(w.id.rank) && (top === undefined || after(w.id, top.id))) top = w
		}
		return top?.value
	}
	const shown = (it: Item) => sees(it.id.rank) && !it.gone.some(sees)
	const visible = (v: Value & { kind: "seq" }) => v.items.filter(shown)
	function write(slot: Slot, value: Value | undefined) {
		slot.push({ id: id(), value })
		undo.push(() => slot.pop())
	}
	function remove(it: Item) {
		it.gone.push(me)
		undo.push(() => it.gone.pop())
	}

	// the value a version shows
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

	// one commit's patches, in its version
	function land(root: Slot, patches: readonly Patch[]) {
		// what is at path's first n keys
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
				// removing a missing key: nothing
				if (read(slot) !== undefined) write(slot!, undefined)
			} else if (p.kind === "seq" && p.of === "list" && typeof k === "number") {
				remove(visible(p)[k] ?? fail())
			} else fail()
		}
		// the span [a, b) of the sequence at path taken out, what was there given back, value's
		// elements put in its place
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
				// a missing key or element: nothing to take
				m = show(at(from.path))
				unset(from.path)
			}
			if (!p.range) return set(p.path, m)
			const there = at(p.path)
			const one = there.kind === "seq" && there.of === "list" && !from.range
			splice(p.path, p.range[0], p.range[1], one ? [m] : m)
		}

		for (const p of patches) {
			// nothing there: only a put at the whole
			if (read(root) === undefined && (p.path.length || p.range || !("value" in p))) fail()
			if (p.move) move(p, p.move)
			else if (p.range) splice(p.path, p.range[0], p.range[1], p.value)
			else if ("value" in p) set(p.path, p.value)
			else unset(p.path)
		}
	}

	commits.forEach((k, i) => {
		const c = decode(k.bytes)
		me = i, count = 0, undo = []
		sees = (r) => r === -1 || r === i || versions[i].has(r)
		let root = roots.get(c.table)
		if (root === undefined) {
			roots.set(c.table, root = [])
			undo.push(() => roots.delete(c.table))
		}
		try {
			land(root, c.patches)
			changes.set(c.table, changeOf(c))
		} catch (e) {
			if (!(e instanceof Fail)) throw e
			for (let j = undo.length - 1; j >= 0; j--) undo[j]()
		}
	})

	sees = () => true
	const out: Tables = {}
	for (const [table, root] of roots) {
		const v = read(root)
		if (v !== undefined) out[table] = { value: show(v), change: changes.get(table)! }
	}
	return out
}

// the same rule, its replay kept between merges of one node (walker.ts)
egwalker.keeping = () => createWalker(egwalker)
