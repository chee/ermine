// changeable: a value and its latest change, the datatype anything patched is (a table's entry is
// one: node/entry). what changes it is this library's: update (its value patched in place, its
// change with the patches and their undo), apply, invert, squish, edit (a recipe's patches); who
// keeps one is a layer above's
import type { Patch } from "./apply.ts"
import type { FileLocation } from "@ermine/core/util/stacktrace"

// a change's metadata: a plain object, any keys; the keys some layer reads by name typed here.
// node: the id of the node whose computer made it (table's Id: string | symbol). run, mark: that
// computer's run count and mark. actor, reader: as the header's. caller, trusted-event: a send's.
// place: a path (places' Path). cause, wallclock, message: sync's
export type Metadata = {
	[key: string]: unknown
	node?: string | symbol
	run?: number
	mark?: number
	actor?: unknown
	reader?: string
	caller?: unknown
	"trusted-event"?: boolean
	place?: readonly string[]
	cause?: unknown
	wallclock?: number
	message?: string
}

// what a change says: given by whoever makes it, never read here. external: where in code it was
// made, oldest first, a site added after (stacktrace's capture). metadata: an object anyone adds
// keys to (Metadata). op: the latest edit, its patches as given and undo, their inverse (op's invert):
// set by update, never by a caller
export type ChangeHeader = {
	time: number
	actor: unknown
	reader?: string
	external?: FileLocation[]
	metadata?: Metadata
	op?: { patches: readonly Patch[]; undo: readonly Patch[] }
}

// a value and its latest change; none: nothing there. where it is kept is a layer above's
export type Changeable<V> = {
	value?: V
	change: ChangeHeader
}
