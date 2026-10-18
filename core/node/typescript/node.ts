import createEntry, { type ChangeHeader, type Entry } from "./entry.ts"

// everything at an id: table names to their entries (value, attributes, children, or any other
// name). no id: that is the table's key, a layer above's
export type Node<T extends Record<string, unknown> = Record<string, unknown>> = {
	readonly [K in keyof T]: Entry<T[K]>
}

// a node made from plain values: each table's value made an entry with createEntry, the one change
// given shared by them all (with no time, the time now, the same for every table). a table given undefined is left out. nothing checked, the values not copied. a node made
// another way is just as good: const node: Node = { value: createEntry(…) }
export default function createNode<T extends Record<string, unknown>>(
	values: T,
	change: ChangeHeader = {} as ChangeHeader,
): Node<T> {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const node: Record<string, Entry<unknown>> = {}
	for (const table of Object.keys(values)) {
		const value = values[table]
		if (value === undefined) continue
		// any name is a table, "__proto__" too
		Object.defineProperty(node, table, {
			value: createEntry(value, change),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return node as Node<T>
}
