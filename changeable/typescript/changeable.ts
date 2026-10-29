// changeable: a value and its latest change, the datatype anything patched is (a table's entry is
// one: node/entry). what changes it is this library's: update (its value patched in place, its
// change with the patches and their undo), apply, invert, squish, edit (a recipe's patches); who
// keeps one is a layer above's
import type { Patch } from "./apply.ts"
import type { Location } from "./stacktrace.ts"

export type { Location }

// what a frame says: a plain object, any keys; the keys some layer reads by name typed here.
// node: the id of the node whose computer made it (table's Id: string | symbol). run, mark: that
// computer's run count and mark. actor, reader: as the header's. caller, trusted-event: a send's.
// place: a path (places' Path). cause, wallclock, message: sync's. locations: where in code, from
// outside the graph, what the frame is began: every line of the stack there, top first
export type Info = {
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
	locations?: Location[]
}

// what a change was made in (a process, a run, a call, a step) and the frame it is under: plain
// data a change points at, shared and never copied (the scheduler's frames are these)
export type Frame = {
	readonly info: Info
	readonly parent: Frame | undefined
}

// what a change says: given by whoever makes it, never read here. frame: what it was made in; where
// it came from is a walk up its parents to the frame that began outside the graph (its
// locations). op: the latest edit, its patches as given and undo, their inverse (op's invert): set
// by update, never by a caller
export type ChangeHeader = {
	time: number
	actor: unknown
	reader?: string
	frame: Frame
	op?: { patches: readonly Patch[]; undo: readonly Patch[] }
}

// a value and its latest change; none: nothing there. where it is kept is a layer above's
export type Changeable<V> = {
	value?: V
	change: ChangeHeader
}
