import type { Changeable, ChangeHeader } from "@ermine/changeable"

export type { ChangeHeader, Frame, Info, Location } from "@ermine/changeable"

// an entry: a changeable kept in a table (where it is kept is a layer above's)
export type Entry<V> = Changeable<V>

// kept by the caller; nothing checked: checks are a layer above's. the change given is the
// entry's, not copied; one with no time: a new change with the time now, whole seconds since 1970,
// the one given unchanged
export default function createEntry<V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
): Entry<V> {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const entry: Entry<V> = { change }
	if (value !== undefined) entry.value = value
	return entry
}
