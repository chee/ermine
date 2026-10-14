// entries held in memory, each under keys of a table name and an id: several tables at one id, one
// entry under any number of keys. what a table name or an id means is a layer above's. one
// listener, given at making, is told of every table event, after it landed: an entry added,
// replaced or taken out at a key (the same entry again is nothing, and no event)
import type { Entry } from "@ermine/node/entry"

// the tables, each a name and the shape of the value under it. open: a package adds its own by
// declaration merging, as jsx's IntrinsicElements are added to:
//   declare module "@ermine/graph/table" { interface Tables { run: Run } }
// the table checks no name and no shape
export interface Tables {
	value: unknown
	attributes: Record<string, unknown>
	// places' hole: each name to its entries, in order (anything else under a name is taken)
	children: Record<string, unknown>
}

// a table's name
export type Key = keyof Tables

// an id
export type Id = string | symbol

export type Code = "nothing-there" | "already-there"

export class TableError extends Error {
	// the key asked about, as far as there was one
	constructor(readonly code: Code, readonly part?: Key, readonly id?: Id) {
		super([code, part, id].filter((x) => x !== undefined).map(String).join(" "))
	}
}

// a table event at a key: told after it landed
export type Event = (part: Key, id: Id) => void

export type Table = {
	add: <K extends Key>(part: K, id: Id, node: Entry<Tables[K]>) => void
	sub: <K extends Key>(part: K, id: Id, node: Entry<Tables[K]>) => void
	get: {
		<K extends Key>(part: K, id: Id): Entry<Tables[K]> | undefined
		(part: Key, node: Entry<unknown>): Id[]
		(id: Id): [Key, Entry<unknown>][]
	}
	who: (node: Entry<unknown>) => [Key, Id][]
	del: {
		(part: Key, id: Id): void
		(part: Key, node: Entry<unknown>): void
		(node: Entry<unknown>): void
	}
}

export function createTable(event?: Event): Table {
	type N = Entry<unknown>
	// id → table name → entry, and entry → table name → ids
	const at = new Map<Id, Map<Key, N>>()
	const where = new Map<N, Map<Key, Set<Id>>>()

	function put(part: Key, id: Id, node: N) {
		let parts = at.get(id)
		if (!parts) at.set(id, parts = new Map())
		parts.set(part, node)
		let ids = where.get(node)
		if (!ids) where.set(node, ids = new Map())
		let set = ids.get(part)
		if (!set) ids.set(part, set = new Set())
		set.add(id)
	}

	function take(part: Key, id: Id, node: N) {
		const parts = at.get(id)!
		parts.delete(part)
		if (parts.size === 0) at.delete(id)
		const ids = where.get(node)!
		const set = ids.get(part)!
		set.delete(id)
		if (set.size === 0) ids.delete(part)
		if (ids.size === 0) where.delete(node)
	}

	// the entry under the key; a different entry there already: already-there
	function add(part: Key, id: Id, node: N) {
		const there = at.get(id)?.get(part)
		if (there === node) return
		if (there !== undefined) throw new TableError("already-there", part, id)
		put(part, id, node)
		event?.(part, id)
	}

	// the entry under the key, in place of what was there
	function sub(part: Key, id: Id, node: N) {
		const there = at.get(id)?.get(part)
		if (there === node) return
		if (there !== undefined) take(part, id, there)
		put(part, id, node)
		event?.(part, id)
	}

	// the entry under the key; an entry's ids under the table name, in the order added; every table
	// at an id
	function get(part: Key, id: Id): N | undefined
	function get(part: Key, node: N): Id[]
	function get(id: Id): [Key, N][]
	function get(a: Key | Id, b?: Id | N): N | undefined | Id[] | [Key, N][] {
		if (arguments.length === 1) return [...at.get(a) ?? []]
		if (typeof b === "object") return [...where.get(b)?.get(a as Key) ?? []]
		return at.get(b!)?.get(a as Key)
	}

	// every key the entry is under, as [table name, id]; none: not in the table
	function who(node: N): [Key, Id][] {
		const out: [Key, Id][] = []
		for (const [part, ids] of where.get(node) ?? []) for (const id of ids) out.push([part, id])
		return out
	}

	// the key; the entry from every id under the table name; the entry from every key. nothing
	// there:
	// nothing-there
	function del(part: Key, id: Id): void
	function del(part: Key, node: N): void
	function del(node: N): void
	function del(a: Key | N, b?: Id | N) {
		if (typeof a === "object") {
			const keys = who(a)
			if (keys.length === 0) throw new TableError("nothing-there")
			for (const [part, id] of keys) take(part, id, a)
			if (event) { for (const [part, id] of keys) event(part, id) }
		} else if (typeof b === "object") {
			const ids = get(a, b)
			if (ids.length === 0) throw new TableError("nothing-there", a)
			for (const id of ids) take(a, id, b)
			if (event) { for (const id of ids) event(a, id) }
		} else {
			const there = at.get(b!)?.get(a)
			if (there === undefined) throw new TableError("nothing-there", a, b!)
			take(a, b!, there)
			event?.(a, b!)
		}
	}

	return { add, sub, get, who, del } as Table
}
