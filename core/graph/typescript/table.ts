// nodes held in memory, each under keys of a part and an id: several parts at one id, one node
// under any number of keys. what a part or an id means is a layer above's
import type { Node } from "@ermine/node"

export type Key = string | symbol

export type Code = "nothing-there" | "already-there"

export class TableError extends Error {
	// the key asked about, as far as there was one
	constructor(readonly code: Code, readonly part?: Key, readonly id?: Key) {
		super([code, part, id].filter((x) => x !== undefined).map(String).join(" "))
	}
}

export function createTable<V>(): {
	add: (part: Key, id: Key, node: Node<V>) => void
	sub: (part: Key, id: Key, node: Node<V>) => void
	get: {
		(part: Key, id: Key): Node<V> | undefined
		(part: Key, node: Node<V>): Key[]
		(id: Key): [Key, Node<V>][]
	}
	who: (node: Node<V>) => [Key, Key][]
	del: {
		(part: Key, id: Key): void
		(part: Key, node: Node<V>): void
		(node: Node<V>): void
	}
} {
	type N = Node<V>
	// id → part → node, and node → part → ids
	const at = new Map<Key, Map<Key, N>>()
	const where = new Map<N, Map<Key, Set<Key>>>()

	function put(part: Key, id: Key, node: N) {
		let parts = at.get(id)
		if (!parts) at.set(id, parts = new Map())
		parts.set(part, node)
		let ids = where.get(node)
		if (!ids) where.set(node, ids = new Map())
		let set = ids.get(part)
		if (!set) ids.set(part, set = new Set())
		set.add(id)
	}

	function take(part: Key, id: Key, node: N) {
		const parts = at.get(id)!
		parts.delete(part)
		if (parts.size === 0) at.delete(id)
		const ids = where.get(node)!
		const set = ids.get(part)!
		set.delete(id)
		if (set.size === 0) ids.delete(part)
		if (ids.size === 0) where.delete(node)
	}

	// the node under the key; a different node there already: already-there
	function add(part: Key, id: Key, node: N) {
		const there = at.get(id)?.get(part)
		if (there === node) return
		if (there !== undefined) throw new TableError("already-there", part, id)
		put(part, id, node)
	}

	// the node under the key, in place of what was there
	function sub(part: Key, id: Key, node: N) {
		const there = at.get(id)?.get(part)
		if (there === node) return
		if (there !== undefined) take(part, id, there)
		put(part, id, node)
	}

	// the node under the key; a node's ids under the part, in the order added; every part at an id
	function get(part: Key, id: Key): N | undefined
	function get(part: Key, node: N): Key[]
	function get(id: Key): [Key, N][]
	function get(a: Key, b?: Key | N): N | undefined | Key[] | [Key, N][] {
		if (arguments.length === 1) return [...at.get(a) ?? []]
		if (typeof b === "object") return [...where.get(b)?.get(a) ?? []]
		return at.get(b!)?.get(a)
	}

	// every key the node is under, as [part, id]; none: not in the table
	function who(node: N): [Key, Key][] {
		const out: [Key, Key][] = []
		for (const [part, ids] of where.get(node) ?? []) for (const id of ids) out.push([part, id])
		return out
	}

	// the key; the node from every id under the part; the node from every key. nothing there:
	// nothing-there
	function del(part: Key, id: Key): void
	function del(part: Key, node: N): void
	function del(node: N): void
	function del(a: Key | N, b?: Key | N) {
		if (typeof a === "object") {
			const keys = who(a)
			if (keys.length === 0) throw new TableError("nothing-there")
			for (const [part, id] of keys) take(part, id, a)
		} else if (typeof b === "object") {
			const ids = get(a, b)
			if (ids.length === 0) throw new TableError("nothing-there", a)
			for (const id of ids) take(a, id, b)
		} else {
			const there = at.get(b!)?.get(a)
			if (there === undefined) throw new TableError("nothing-there", a, b!)
			take(a, b!, there)
		}
	}

	return { add, sub, get, who, del }
}
