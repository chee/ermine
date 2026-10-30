import type { Changeable, ChangeHeader } from "@ermine/changeable"

export type { ChangeHeader, Frame, Info, Location } from "@ermine/changeable"

// An entry: a changeable stored in a table.
export type Entry<V> = Changeable<V>

// The change is the entry's own, not copied, unless it has no time: then a copy gets the time now
// in whole seconds since 1970. `now` is the clock in ms since 1970 (default Date.now).
export default function createEntry<V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
	{ now = Date.now }: { now?: () => number } = {},
): Entry<V> {
	if (change.time === undefined) change = { ...change, time: Math.floor(now() / 1000) }
	const entry: Entry<V> = { change }
	if (value !== undefined) entry.value = value
	return entry
}
