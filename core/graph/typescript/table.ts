// An in-memory table of entries, each under keys of a table name and an id. One id can have
// several tables, and one entry can sit under any number of keys. One listener, given at making,
// hears every event after it landed. Putting the same entry again is no event.
import type { Entry } from "@ermine/graph/entry"

// The tables the graph has, each a name and the shape of its value. Packages with tables of
// their own export them as a type: createTable<Tables & StatusTables>(). Apps may add to this
// interface by declaration merging. Names outside the type are allowed, as Entry<unknown>.
export interface Tables {
	value: unknown
	attributes: Record<string, unknown>
	children: Record<string, unknown>
}

export type Key = string

export type Shape<T, K extends Key> = K extends keyof T ? T[K] : unknown

export type Id = string | symbol

export type Code = "nothing-there" | "already-there"

export class TableError extends Error {
	constructor(readonly code: Code, readonly part?: Key, readonly id?: Id) {
		super([code, part, id].filter((x) => x !== undefined).map(String).join(" "))
	}
}

export type Event = (part: Key, id: Id) => void

// A table holding T's tables. add and sub are methods so Table<Tables & StatusTables> is a Table.
export type Table<T extends Tables = Tables> = {
	add<K extends Key>(part: K, id: Id, node: Entry<Shape<T, K>>): void
	sub<K extends Key>(part: K, id: Id, node: Entry<Shape<T, K>>): void
	get: {
		<K extends Key>(part: K, id: Id): Entry<Shape<T, K>> | undefined
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

export function createTable<T extends Tables = Tables>(event?: Event): Table<T> {
	type N = Entry<unknown>
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

	function add(part: Key, id: Id, node: N) {
		const there = at.get(id)?.get(part)
		if (there === node) return
		if (there !== undefined) throw new TableError("already-there", part, id)
		put(part, id, node)
		event?.(part, id)
	}

	function sub(part: Key, id: Id, node: N) {
		const there = at.get(id)?.get(part)
		if (there === node) return
		if (there !== undefined) take(part, id, there)
		put(part, id, node)
		event?.(part, id)
	}

	function get(part: Key, id: Id): N | undefined
	function get(part: Key, node: N): Id[]
	function get(id: Id): [Key, N][]
	function get(a: Key | Id, b?: Id | N): N | undefined | Id[] | [Key, N][] {
		if (arguments.length === 1) return [...at.get(a) ?? []]
		if (typeof b === "object") return [...where.get(b)?.get(a as Key) ?? []]
		return at.get(b!)?.get(a as Key)
	}

	function who(node: N): [Key, Id][] {
		const out: [Key, Id][] = []
		for (const [part, ids] of where.get(node) ?? []) for (const id of ids) out.push([part, id])
		return out
	}

	// throws TableError "nothing-there" when there is no such entry
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

	return { add, sub, get, who, del } as Table<T>
}
