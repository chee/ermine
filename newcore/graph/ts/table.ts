// nodes held in memory, by id: loaded or not (GRAPH.tex, create and free)
// placing them is places.ts's: table is about ids
import type { Node } from "../../nodes/ts/node.ts"

export type Code = "nothing-there" | "already-there"

export class TableError extends Error {
	constructor(readonly code: Code, readonly id: string) {
		super(`${code} (${id})`)
	}
}

export function createTable<V, H>() {
	type N = Node<V, H>
	const nodes = new Map<string, N>()

	const get = (id: string): N | undefined => nodes.get(id)

	// loaded: a root, a new node, or one back from storage; not a change; placing is places'
	// a different node by that id already loaded: already-there
	function intro(node: N) {
		const there = nodes.get(node.id)
		if (there !== undefined && there !== node) throw new TableError("already-there", node.id)
		nodes.set(node.id, node)
	}

	// no longer loaded; lists holding its id keep it; not a change
	function outro(id: string) {
		if (!nodes.has(id)) throw new TableError("nothing-there", id)
		nodes.delete(id)
	}

	return { get, intro, outro }
}
