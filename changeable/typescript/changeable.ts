// A value and its latest change: the datatype for anything that gets patched. Who stores one is
// up to the layer above.
import type { Patch } from "./apply.ts"
import type { Location } from "./stacktrace.ts"

export type { Location }

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

export type Frame = {
	readonly info: Info
	readonly parent: Frame | undefined
}

export type ChangeHeader = {
	time: number
	actor: unknown
	reader?: string
	frame: Frame
	op?: { patches: readonly Patch[]; undo: readonly Patch[] }
}

export type Changeable<V> = {
	value?: V
	change: ChangeHeader
}
