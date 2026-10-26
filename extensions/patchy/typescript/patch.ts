// patch nodes: a node that lives in one place and changes another. its "patch" entry: on (the
// target's id), part (which of its entries), at (that entry's change time when made) and op's
// patches, laid over that entry. it counts while it is loaded: placed in my tree, only I load it;
// in a shared folder, everyone who has the folder
//
//   const table = createTable((part, id) => overlay.onTableChange(part, id))
//   const overlay = createOverlay(table, () => places)
//   const places = createPlaces({ root, table: overlay, paths, scheduler })
//   update(entry, patches, header); overlay.commit([entry]) // a write: to the table, said here
//
// the overlay: a table in front of places' (get and who only). no patch nodes over (part, id): the
// table's entry. some: an entry made here, the table's value with each patch node's patches applied
// in the order they came, in one apply (one whose patches throw: set aside). kept, and made again
// when the table's entry or a patch node changes. its change is the table's without its op, with
// overlay: the patch nodes applied, set in a copy of its metadata. a write not said here is not seen
// telling: a patch node added, changed or taken out, or a write under patch nodes, tells places'
// commit one change of the key whose patches put, whole, what differs at the patch nodes' spots
// (and the write's): a reader of anything else is not told. a table event, or a key nobody read
// since patch nodes came over it: the whole key
// in place: a made entry shares what no patch touched with its base, so while one is kept those are
// copied on write
// stale: made against an older version than its target's latest change: still applied, and said
// (stale in its layer). patches that no longer apply: set aside, with the error. what to do (make
// it again, land it, take it out) is the maker's
// writes go to the table, never the overlay; never change what it makes. land puts a patch node's
// patches on its target for real
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import apply, { ApplyError, type Key as Step, type Patch } from "@ermine/core/op/apply"
import { at, type Places, unread } from "@ermine/places"
import type { Id, Key, Table } from "@ermine/core/table"

declare module "@ermine/core/table" {
	interface Tables {
		patch: PatchNode
	}
}

// a patch node's "patch" entry
export type PatchNode = {
	// the target's id, and which of its entries
	readonly on: Id
	readonly part: Key
	// the target entry's change time it was made against
	readonly at: number
	readonly patches: readonly Patch[]
}

// the table's own layer
export const TABLE = "table"

// one layer of a read, front first: the value, and where it is from (a patch node's id; the
// table's own: TABLE). stale: made against an older version than the target's latest change,
// still applied. error: its patches don't apply over what is under it: set aside, its value
// what is under it
export type Item = {
	readonly value: unknown
	readonly from: Id
	readonly stale?: true
	readonly error?: unknown
}

export type Overlay = Pick<Table, "get" | "who"> & {
	// a target's id → its patch nodes, in the order they came (a changed one keeps its place). kept
	// from table events and commits on "patch": nothing is searched. never change it
	readonly index: ReadonlyMap<Id, readonly Id[]>
	// the table's hook, in front of places' onTableChange
	onTableChange: (part: Key, id: Id) => void
	// after a write to the table, in front of places' commit
	commit: (changed: readonly Entry<unknown>[]) => void
	// the layers of the entry under (part, id), front first; none there: none. untold (entries
	// tells)
	layers: (part: Key, id: Id) => readonly Item[]
}

export type Code = "nothing-there"

export class PatchError extends Error {
	constructor(readonly code: Code, readonly id: Id) {
		super(`${code} (${String(id)})`)
	}
}

const isId = (v: unknown): v is Id => typeof v === "string" || typeof v === "symbol"

type Target = { readonly on: Id; readonly part: Key }

// what a patch node's value is over; not a patch node: undefined
function target(v: unknown): Target | undefined {
	if (typeof v !== "object" || v === null) return undefined
	const { on, part, patches } = v as Partial<PatchNode>
	if (!isId(on) || typeof part !== "string" || !Array.isArray(patches)) return undefined
	return { on, part }
}

// an entry made for (part, id), and what it was made from
type Made = {
	base: Entry<unknown> | undefined
	ids: readonly Id[]
	nodes: readonly Entry<unknown>[]
	changes: readonly ChangeHeader[]
	// the patch nodes' values it was made with
	values: readonly unknown[]
	entry: Entry<unknown>
	// the paths their patches aim at and move from, copied, each once
	spots: readonly (readonly Step[])[]
	// its layers, made at the first ask
	items?: readonly Item[]
}

// what readers of a key had: the value, and the spots of the patch nodes over it then
type Seen = { value: unknown; spots: readonly (readonly Step[])[] }

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)

// a is b, or a step above it
function above(a: readonly Step[], b: readonly Step[]): boolean {
	if (a.length > b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

// where a patch's place changes things: its path; a taking out at a list's number with no range
// (or a move from there) shifts the rest of the list, so the list's
function spotOf(path: readonly Step[], range: unknown, put: boolean): Step[] {
	const last = path[path.length - 1]
	return range === undefined && !put && typeof last === "number" ? path.slice(0, -1) : [...path]
}

// the paths patch nodes' patches aim at and move from, each once; malformed: none
function spotsOf(values: readonly unknown[]): Step[][] {
	const out: Step[][] = [], seen = new Set<string>()
	const add = (s: Step[]) => {
		const k = JSON.stringify(s)
		if (!seen.has(k)) seen.add(k), out.push(s)
	}
	for (const v of values) {
		for (const p of (v as PatchNode).patches as readonly Partial<Patch>[]) {
			if (!Array.isArray(p?.path)) continue
			const m = p.move
			add(spotOf(p.path, p.range, m !== undefined || "value" in p))
			if (Array.isArray(m?.path)) add(spotOf(m.path, m.range, false))
		}
	}
	return out
}

const same = (a: readonly unknown[], b: readonly unknown[]) =>
	a.length === b.length && a.every((x, i) => x === b[i])

// each patch node's patches applied in order over what is under it, one at a time: every layer,
// front first, and what is applied
function stack(base: Entry<unknown> | undefined, ids: readonly Id[], values: readonly unknown[]) {
	const time = base?.change.time
	const items: Item[] = [], applied: Id[] = []
	let value = base?.value
	for (let i = 0; i < ids.length; i++) {
		const n = values[i] as PatchNode
		const stale = time !== undefined && time > n.at ? { stale: true as const } : {}
		try {
			value = apply(value, n.patches)
			applied.push(ids[i])
			items.push({ value, from: ids[i], ...stale })
		} catch (error) {
			items.push({ value, from: ids[i], ...stale, error })
		}
	}
	items.reverse()
	if (base !== undefined) items.push({ value: base.value, from: TABLE })
	return { value, items, applied }
}

// s, or the step above it nearest, where a patch putting what now has there applies to before:
// a name into a map both have (one taken out: before has it), a number into a list both have it in
function fit(before: unknown, now: unknown, s: readonly Step[]): readonly Step[] {
	for (let k = s.length; k > 0; k--) {
		const up = s.slice(0, k - 1), key = s[k - 1]
		const a = at(before, up), b = at(now, up)
		if (typeof key === "string") {
			if (isMap(a) && isMap(b) && (Object.hasOwn(b, key) || Object.hasOwn(a, key))) {
				return s.slice(0, k)
			}
		} else if (Array.isArray(a) && Array.isArray(b) && key < a.length && key < b.length) {
			return s.slice(0, k)
		}
	}
	return []
}

// the patches turning before into now where they can differ: at each spot, where what is there is
// not the same (at fit's spot), or a written patch touched it (at the spot itself, both having
// it: the write, in the table's coordinates, is put right for a watch), what now has there put
// whole; one under another left out
function fixes(
	before: unknown,
	now: unknown,
	spots: readonly (readonly Step[])[],
	written: readonly Patch[],
): Patch[] {
	const touched = (s: readonly Step[]) =>
		written.some((w) =>
			above(w.path, s) || above(s, w.path) ||
			(w.move !== undefined && (above(w.move.path, s) || above(s, w.move.path)))
		)
	const out: (readonly Step[])[] = []
	// a list of the same length, or a map of the same names: what differs in it, one step down
	function diff(a: unknown, b: unknown, s: readonly Step[]) {
		if (a === b) return
		if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
			for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push([...s, i])
			return
		}
		if (isMap(a) && isMap(b)) {
			const names = Object.keys(a)
			if (names.length === Object.keys(b).length && names.every((k) => Object.hasOwn(b, k))) {
				for (const k of names) if (a[k] !== b[k]) out.push([...s, k])
				return
			}
		}
		out.push(fit(before, now, s))
	}
	for (const s of spots) {
		if (touched(s) && fit(before, now, s).length === s.length) out.push(s)
		else diff(at(before, s), at(now, s), s)
	}
	out.sort((a, b) => a.length - b.length)
	const kept: (readonly Step[])[] = []
	for (const s of out) if (!kept.some((k) => above(k, s))) kept.push(s)
	return kept.map((path) => {
		const value = at(now, path)
		return value === undefined ? { path } : { path, value }
	})
}

export function createOverlay(
	table: Pick<Table, "get" | "who">,
	places: () => Pick<Places, "onTableChange" | "commit">,
): Overlay {
	const index = new Map<Id, Id[]>()
	// a patch node → what it is over, as indexed
	const targets = new Map<Id, Target>()
	// a target → a part → what was made for it
	const made = new Map<Id, Map<Key, Made>>()
	// an entry made here → the key it was made for
	const keys = new WeakMap<Entry<unknown>, [Key, Id]>()
	// the change being said to places' commit now, and its key
	let telling: { entry: Entry<unknown>; key: [Key, Id] } | undefined
	// a made entry shares what no patch touched with its base, and holds its patch nodes' values:
	// read, for places' unread (an entry written through it), so its next write copies and what
	// readers had never changes under them
	function hold(m: Made) {
		for (const e of [m.base, ...m.nodes]) if (e !== undefined) unread.read(e)
	}

	const tell = (part: Key, id: Id) => places().onTableChange(part, id)

	// the patch nodes in all that are over part
	function over(part: Key, all: readonly Id[]): Id[] {
		const out: Id[] = []
		for (const p of all) if (targets.get(p)!.part === part) out.push(p)
		return out
	}

	// the change of a made entry: the table's, its op left out, the patch nodes applied set as
	// overlay in a copy of its metadata; nothing under it: time 0, no actor
	function header(base: Entry<unknown> | undefined, applied: Id[]): ChangeHeader {
		if (base === undefined) return { time: 0, actor: undefined, metadata: { overlay: applied } }
		const { op: _, ...change } = base.change
		return { ...change, metadata: { ...change.metadata, overlay: applied } }
	}

	// the table's entry under (part, id), each patch node in ps applied over it in order: all their
	// patches in one apply, so what they touch is copied once. one whose patches throw is set aside,
	// and the rest applied again; a throw op can't place, one at a time (stack). was: what was made
	// before, its spots kept while every patch node's entry and change are the ones it had
	function make(part: Key, id: Id, ps: readonly Id[], was?: Made): Made {
		const base = table.get(part, id)
		const nodes = ps.map((p) => table.get("patch", p)!)
		const values = nodes.map((node) => node.value)
		const changes = nodes.map((node) => node.change)
		const kept = was !== undefined && same(was.nodes, nodes) && same(was.changes, changes)
		const spots = kept ? was.spots : spotsOf(values)
		let on = ps.map((_, i) => i), value: unknown, applied: Id[] | undefined
		while (applied === undefined) {
			const list: Patch[] = [], owner: number[] = []
			for (const i of on) {
				for (const patch of (values[i] as PatchNode).patches) list.push(patch), owner.push(i)
			}
			try {
				value = apply(base?.value, list)
				applied = on.map((i) => ps[i])
			} catch (error) {
				const bad = error instanceof ApplyError ? owner[error.patch] : undefined
				if (bad === undefined) ({ value, applied } = stack(base, ps, values))
				else on = on.filter((i) => i !== bad)
			}
		}
		const entry = createEntry(value, header(base, applied))
		keys.set(entry, [part, id])
		return { base, ids: ps, nodes, changes, values, entry, spots }
	}

	// what is made for (part, id) from all its patch nodes: the one kept (kept only while patch
	// nodes are over it, let go at every change the overlay is told of that it doesn't make again),
	// or made now; again: made now. none over part: undefined
	function layered(part: Key, id: Id, all: readonly Id[] | undefined, again = false) {
		let parts = made.get(id)
		const m = parts?.get(part)
		if (m !== undefined && !again) return m
		const ps = all === undefined ? [] : over(part, all)
		if (ps.length === 0) {
			if (m !== undefined) forget(part, id)
			return undefined
		}
		const n = make(part, id, ps, m)
		if (parts === undefined) made.set(id, parts = new Map())
		parts.set(part, n)
		hold(n)
		return n
	}

	// what was made for (part, id) let go: made again at the next read
	function forget(part: Key, id: Id) {
		const parts = made.get(id)
		const m = parts?.get(part)
		if (m === undefined) return
		parts!.delete(part)
		if (parts!.size === 0) made.delete(id)
	}

	// the entry a read of (part, id) sees: one Map check, then the table's, or the one made
	function entry(part: Key, id: Id): Entry<unknown> | undefined {
		const all = index.get(id)
		if (all === undefined) return table.get(part, id)
		return layered(part, id, all)?.entry ?? table.get(part, id)
	}

	function get(part: Key, id: Id): Entry<unknown> | undefined
	function get(part: Key, node: Entry<unknown>): Id[]
	function get(id: Id): [Key, Entry<unknown>][]
	function get(
		a: Key | Id,
		b?: Id | Entry<unknown>,
	): Entry<unknown> | undefined | Id[] | [Key, Entry<unknown>][] {
		if (isId(b)) return entry(a as Key, b)
		if (arguments.length === 1) {
			const out = table.get(a).map(([part]): [Key, Entry<unknown>] => [part, entry(part, a)!])
			for (const p of index.get(a) ?? []) {
				const { part } = targets.get(p)!
				if (out.some(([k]) => k === part)) continue
				const e = entry(part, a)
				if (e !== undefined) out.push([part, e])
			}
			return out
		}
		const k = b === telling?.entry ? telling!.key : keys.get(b!)
		if (k === undefined) return table.get(a as Key, b!)
		return k[0] === a ? [k[1]] : []
	}

	// every key an entry is under; one made here, or being said: the key it is for
	function who(node: Entry<unknown>): [Key, Id][] {
		const k = node === telling?.entry ? telling.key : keys.get(node)
		return k === undefined ? table.who(node) : [k]
	}

	// what readers of (part, id) had: the entry made for it; none made and no patch node over it,
	// the table's; patch nodes over it and none made, nobody read it since they came: undefined
	function seen(part: Key, id: Id): Seen | undefined {
		const m = made.get(id)?.get(part)
		if (m !== undefined) return { value: m.entry.value, spots: m.spots }
		const all = index.get(id)
		if (all !== undefined && over(part, all).length) return undefined
		return { value: table.get(part, id)?.value, spots: [] }
	}

	// (part, id) made again now, and readers told what changed from what they had, at the spots of
	// the patch nodes over it before and now (written: the table entry's patches, said already):
	// one change of the key to places' commit, its op the fixes. had undefined: the whole key
	function retell(part: Key, id: Id, had: Seen | undefined, written: readonly Patch[] = []) {
		if (had === undefined) return tell(part, id)
		const m = layered(part, id, index.get(id), true)
		const now = m?.entry ?? table.get(part, id)
		const spots = m === undefined || m.spots === had.spots
			? had.spots
			: [...had.spots, ...m.spots]
		const ps = fixes(had.value, now?.value, spots, written)
		// a write's own spots, and the change's, are said already (places' commit)
		if (ps.length === 0 && written.length) return
		const undo = ps.map(({ path }): Patch => {
			const value = at(had.value, path)
			return value === undefined ? { path } : { path, value }
		})
		const { op: _, ...change } = now?.change ?? { time: 0, actor: undefined }
		const entry: Entry<unknown> = { change: { ...change, op: { patches: ps, undo } } }
		if (now?.value !== undefined) entry.value = now.value
		telling = { entry, key: [part, id] }
		try {
			places().commit([entry])
		} finally {
			telling = undefined
		}
	}

	// a patch node's entry came, changed or went: indexed again, and the keys it was and is over
	// told
	function reindex(p: Id) {
		const was = targets.get(p)
		const now = target(table.get("patch", p)?.value)
		const same = was !== undefined && now !== undefined && was.on === now.on &&
			was.part === now.part
		const before = was && seen(was.part, was.on)
		const after = now && !same ? seen(now.part, now.on) : undefined
		if (was !== undefined && !same) {
			const list = index.get(was.on)!
			list.splice(list.indexOf(p), 1)
			if (list.length === 0) index.delete(was.on)
			targets.delete(p)
		}
		if (now !== undefined && !same) {
			let list = index.get(now.on)
			if (list === undefined) index.set(now.on, list = [])
			list.push(p)
			targets.set(p, now)
		}
		if (was !== undefined) retell(was.part, was.on, before)
		if (now !== undefined && !same) retell(now.part, now.on, after)
	}

	function onTableChange(part: Key, id: Id) {
		if (part === "patch") reindex(id)
		else forget(part, id)
		tell(part, id)
	}

	// places' commit, then: a patch node changed, indexed again and its target told; a target's
	// entry changed under patch nodes, told at their spots
	function commit(changed: readonly Entry<unknown>[]) {
		places().commit(changed)
		for (const e of changed) {
			const op = e.change.op
			if (op === undefined) continue
			for (const [part, id] of table.who(e)) {
				if (part === "patch") reindex(id)
				else {
					const all = index.get(id)
					if (all !== undefined && over(part, all).length) {
						retell(part, id, seen(part, id), op.patches)
					}
				}
			}
		}
	}

	function layers(part: Key, id: Id): readonly Item[] {
		const m = layered(part, id, index.get(id))
		if (m !== undefined) return m.items ??= stack(m.base, m.ids, m.values).items
		const base = table.get(part, id)
		return base === undefined ? [] : [{ value: base.value, from: TABLE }]
	}

	return { index, get: get as Table["get"], who, onTableChange, commit, layers }
}

// every layer at path in the entry under (part, id), front first: each patch node's, then the
// table's. the read told at path, as readValue tells it. path: kept by paths, never change it
export function entries(
	places: Pick<Places, "readValue">,
	overlay: Pick<Overlay, "layers">,
	part: Key,
	id: Id,
	path: readonly Step[] = [],
): Item[] {
	places.readValue(part, id, path)
	return overlay.layers(part, id).map((item) => ({ ...item, value: at(item.value, path) }))
}

// a patch node's patches put on its target for real, and its entry taken out of the table: the
// override committed. table: the table itself, never the overlay. gives back the entries changed,
// for the overlay's commit; a target with no entry: one made and added, its table event tells.
// its patches don't apply: it throws, and nothing changes. where it is placed is the placer's
export function land(
	table: Pick<Table, "get" | "add" | "del">,
	id: Id,
	header: ChangeHeader,
): Entry<unknown>[] {
	const v = table.get("patch", id)?.value
	const t = target(v)
	if (t === undefined) throw new PatchError("nothing-there", id)
	const { patches } = v as PatchNode
	const base = table.get(t.part, t.on)
	if (base === undefined) {
		const made = createEntry<unknown>(undefined, header)
		update(made, patches, header)
		table.del("patch", id)
		table.add(t.part, t.on, made as never)
		return []
	}
	update(base, patches, header)
	table.del("patch", id)
	return [base]
}
