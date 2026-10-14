// the store: a table per source (the stored graph one, a drag layer another, pending another),
// each holding nodes under (part, id). a part is a name; any string is one, and Parts gives the
// shape of the value under each one known. a source's table is made when first written to, and
// dropped whole when the source ends. one listener is told of every table event: a node added,
// replaced or removed at a key
import type { Entry } from "@ermine/node/entry"
import { createTable, type Key, TableError } from "@ermine/graph/table"

export type { Key }
export { TableError }

// the parts, each a name and the shape of the value under it. open: a package adds its own by
// declaration merging, as jsx's IntrinsicElements are added to:
//   declare module "@ermine/store" { interface Parts { run: Run } }
// the store checks no name and no shape
export interface Parts {
	value: unknown
	attributes: Record<string, unknown>
	// places' hole: each name to its entries, in order (anything else under a name is taken)
	children: Record<string, unknown>
}

export type Part = keyof Parts & string

// a table event at a key: told after it landed
export type Event = (source: Key, part: Part, id: Key) => void

type Table = ReturnType<typeof createTable<unknown>>

export function createStore(event?: Event): Store {
	// each source's table, and the ids it holds something at (the table lists no keys)
	const tables = new Map<Key, { table: Table; ids: Set<Key> }>()

	function made(source: Key) {
		let t = tables.get(source)
		if (t === undefined) tables.set(source, t = { table: createTable(), ids: new Set() })
		return t
	}

	// the node under the key; none: undefined. a read makes no table
	function get<P extends Part>(source: Key, part: P, id: Key): Entry<Parts[P]> | undefined {
		return tables.get(source)?.table.get(part, id) as Entry<Parts[P]> | undefined
	}

	// the node under the key; another node there already: already-there (the table's). the same
	// node again: nothing, and no event
	function add<P extends Part>(source: Key, part: P, id: Key, node: Entry<Parts[P]>) {
		const t = made(source)
		if (t.table.get(part, id) === node) return
		t.table.add(part, id, node)
		t.ids.add(id)
		event?.(source, part, id)
	}

	// the node under the key, in place of what was there. the same node: nothing, and no event
	function sub<P extends Part>(source: Key, part: P, id: Key, node: Entry<Parts[P]>) {
		const t = made(source)
		if (t.table.get(part, id) === node) return
		t.table.sub(part, id, node)
		t.ids.add(id)
		event?.(source, part, id)
	}

	// the node under the key taken out; nothing there: nothing-there (the table's)
	function del(source: Key, part: Part, id: Key) {
		const t = tables.get(source)
		if (t === undefined) throw new TableError("nothing-there", part, id)
		t.table.del(part, id)
		if (t.table.get(id).length === 0) t.ids.delete(id)
		event?.(source, part, id)
	}

	// every key the node is under in the source's table, as [part, id]; none: not there
	const who = (source: Key, node: Entry<unknown>): [Part, Key][] =>
		(tables.get(source)?.table.who(node) ?? []) as [Part, Key][]

	// places' hole: the children node of id as source has it
	const children = (source: Key, id: Key) => get(source, "children", id)

	// the source's whole table gone, then an event at each key it held. none: nothing
	function drop(source: Key) {
		const t = tables.get(source)
		if (t === undefined) return
		tables.delete(source)
		if (event === undefined) return
		for (const id of t.ids) {
			for (const [part] of t.table.get(id)) event(source, part as Part, id)
		}
	}

	return { get, add, sub, del, who, children, drop }
}

export type Store = {
	get: <P extends Part>(source: Key, part: P, id: Key) => Entry<Parts[P]> | undefined
	add: <P extends Part>(source: Key, part: P, id: Key, node: Entry<Parts[P]>) => void
	sub: <P extends Part>(source: Key, part: P, id: Key, node: Entry<Parts[P]>) => void
	del: (source: Key, part: Part, id: Key) => void
	who: (source: Key, node: Entry<unknown>) => [Part, Key][]
	children: (source: Key, id: Key) => Entry<Parts["children"]> | undefined
	drop: (source: Key) => void
}
