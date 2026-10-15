import type { Patch } from "@ermine/op/apply"
import type { FileLocation } from "@ermine/util/stacktrace"

// what a change says: given by whoever makes it, never read here. external: where in code it was
// made, oldest first, a site added after (stacktrace's capture). metadata: entries anyone adds
// to, in order. op: the latest edit, its patches as given and undo, their inverse (op's invert):
// set by update, never by a caller
export type ChangeHeader = {
	time: number
	actor: unknown
	reader?: string
	external?: FileLocation[]
	metadata?: [string, unknown][]
	op?: { patches: readonly Patch[]; undo: readonly Patch[] }
}

// a value and its latest change; none: nothing there. cow: false (only ever that: given at
// creation, or set by the layer keeping it as it comes in, before anything reads it): update changes
// the value in place, not a copy of it. where it is kept is a layer above's
export type Entry<V> = {
	value?: V
	change: ChangeHeader
	cow?: false
}

export type Options = {
	// false: the entry's value is changed in place by update, and is the caller's to keep from
	// others: put in nothing you do not want changed, or structuredClone it first
	cow?: false
}

// kept by the caller; nothing checked: checks are a layer above's. the change given is the
// entry's, not copied; one with no time: a new change with the time now, whole seconds since 1970,
// the one given unchanged
export default function createEntry<V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
	options: Options = {},
): Entry<V> {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const entry: Entry<V> = { change }
	if (value !== undefined) entry.value = value
	if (options.cow === false) entry.cow = false
	return entry
}
