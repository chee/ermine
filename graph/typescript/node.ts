import createEntry, { type ChangeHeader, type Entry } from "./entry.ts"

// Everything at an id: table names to their entries.
export type Node<T extends Record<string, unknown> = Record<string, unknown>> = {
	readonly [K in keyof T]: Entry<T[K]>
}

// Makes a node from plain values, each made an entry with createEntry. All entries share the one
// change, with the time now if it has none. Tables given undefined are left out. Nothing is
// checked or copied.
export default function createNode<T extends Record<string, unknown>>(
	values: T,
	change: ChangeHeader = {} as ChangeHeader,
	{ now = Date.now }: { now?: () => number } = {},
): Node<T> {
	if (change.time === undefined) change = { ...change, time: Math.floor(now() / 1000) }
	const node: Record<string, Entry<unknown>> = {}
	for (const table of Object.keys(values)) {
		const value = values[table]
		if (value === undefined) continue
		Object.defineProperty(node, table, {
			value: createEntry(value, change),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return node as Node<T>
}
