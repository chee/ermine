// a graph from a root, as bytes: every node reachable through its lists, and back
// reachable: by any version of any list, not only the first; nothing loaded here, nothing placed
import { Encoder } from "cbor-x"
import createNode, { type Header, type List, type Node, type Version } from "./node.ts"

// get: the node of an id, or none if it is not loaded (table.ts's get)
export type Get<V, H> = (id: string) => Node<V, H> | undefined

// a node as written: info and children as entries in order, as createNode takes them
type Packed<V, H> = {
	id: string
	value: Version<V, H>[]
	info: [string, Version<V, H>[]][]
	children: [string, Version<List, H>[]][]
	header: Header
}

// root: the id walked from; nodes: the root first, then in the order reached;
// missing: ids in a list reached but not loaded, in the order reached
export type Graph<V, H> = { root: string; nodes: Node<V, H>[]; missing: string[] }

export type Code = "nothing-there" | "cannot-carry" | "not-a-graph"

export class PackError extends Error {
	constructor(readonly code: Code, readonly id?: string) {
		super(id === undefined ? code : `${code} (${id})`)
	}
}

// plain CBOR: maps, not cbor-x's records
const cbor = new Encoder({ useRecords: false })

// the root and every node reachable from it; the root not loaded: nothing-there
export function walk<V, H>(root: string, get: Get<V, H>): Graph<V, H> {
	const first = get(root)
	if (first === undefined) throw new PackError("nothing-there", root)
	const nodes: Node<V, H>[] = [first], missing: string[] = []
	const seen = new Set([root])
	for (let i = 0; i < nodes.length; i++) {
		for (const versions of nodes[i].children.values()) {
			for (const v of versions) {
				for (const id of v.content) {
					if (typeof id !== "string" || seen.has(id)) continue
					seen.add(id)
					const n = get(id)
					if (n === undefined) missing.push(id)
					else nodes.push(n)
				}
			}
		}
	}
	return { root, nodes, missing }
}

// the graph from root as one CBOR item; a node holding what CBOR cannot carry (a symbol in a
// list, a function): cannot-carry, with its id
export function pack<V, H>(root: string, get: Get<V, H>): Uint8Array {
	const { nodes, missing } = walk(root, get)
	const packed = nodes.map((n): Packed<V, H> => ({
		id: n.id,
		value: n.value,
		info: [...n.info],
		children: [...n.children],
		header: n.header,
	}))
	try {
		return cbor.encode({ root, nodes: packed, missing })
	} catch {
		// which: each again, only when one failed
		for (const p of packed) {
			try {
				cbor.encode(p)
			} catch {
				throw new PackError("cannot-carry", p.id)
			}
		}
		throw new PackError("cannot-carry")
	}
}

// the nodes back, new objects, headers as written; none loaded: that is the caller's (intro)
export function unpack<V, H>(bytes: Uint8Array): Graph<V, H> {
	const g = cbor.decode(bytes) as { root?: unknown; nodes?: unknown; missing?: unknown }
	if (
		g === null || typeof g !== "object" || typeof g.root !== "string" ||
		!Array.isArray(g.nodes) || !Array.isArray(g.missing)
	) throw new PackError("not-a-graph")
	const nodes = (g.nodes as Packed<V, H>[]).map((p) =>
		createNode<V, H>(p.id, { value: p.value, info: p.info, children: p.children }, {
			header: p.header,
		})
	)
	return { root: g.root, nodes, missing: g.missing as string[] }
}
