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

// a value and its latest change; none: nothing there. where it is kept is a layer above's
export type Node<V> = {
	value?: V
	change: ChangeHeader
}

// kept by the caller; nothing checked: checks are a layer above's. the change given is the
// node's, not copied; one with no time: a new change with the time now, whole seconds since 1970,
// the one given unchanged
export default function createNode<V>(
	value?: V,
	change: ChangeHeader = {} as ChangeHeader,
): Node<V> {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const node: Node<V> = { change }
	if (value !== undefined) node.value = value
	return node
}
