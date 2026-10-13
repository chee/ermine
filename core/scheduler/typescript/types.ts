// the scheduler's types, shared by the scheduler (scheduler.ts) and the programs side
// (../programs/): a process, a run, what a part runs as. one definition each.
import type { Api, By, Reader } from "@ermine/graph"
import type { Address, Place, Where } from "@ermine/places"
import type { Agent, Status } from "./records.ts"
import type { Cause } from "./causes.ts"
export type { Cause } from "./causes.ts"

// what a part, handler or cleanup is: a function called with one map
export type Fn = (given: never) => unknown
export type Code = Fn | { readonly compute: Fn; readonly effect?: Fn }

// waiting: a compute returns it, or code gives it, while what it needs is not here
export const PENDING: unique symbol = Symbol.for("ermine.pending")

// a program found by path: its code, and the node and time it came from
export type Found = { code: Code; program: { node: string; time: number } }
// what code is given of a process
export type Process = { id: string; name: string; place: Place; program: Address }
// the host's: finds a process's code by its program's path, reading through view (tracked)
export type Finder = (process: Process, view: Api) => Found | typeof PENDING

export type Ended = "done" | "pending" | "failed" | "stopped" | "looping"

// the moments (SCHEDULER.tex, Hooks)
export type Moment =
	| { due: string; by: number }
	| { starts: string; run?: number; handler?: string; rank?: number }
	| {
		reads: string
		run?: number
		handler?: string
		cleanup?: true
		op: string
		items: unknown[]
		tracked: boolean
	}
	| {
		ends: string
		run?: number
		handler?: string
		ended: Ended
		equal?: boolean
		error?: unknown
		waits?: string
	}
export type Hook = (moment: Moment) => void

export type Kept = { by: By; causes?: Cause }

export type Child = { proc: Proc; name: string; part: string; replaced: number }
export type Cleanup = (given: { killed: boolean; api: Api }) => unknown
export type ReadEntry = {
	op: string
	address?: Where
	name?: string
	tracked: boolean
	times: number[]
}

export type Proc = {
	id: string
	name: string
	// names from the root to its .
	place: string[]
	// its actor, but for its own step
	base: Record<string, unknown>
	prefix: Record<string, unknown>[]
	started: number
	path?: Address
	code?: Code
	program?: { node: string; time: number }
	equal?: (a: unknown, b: unknown) => boolean
	parent?: Proc
	children: Child[]
	// ephemeral nodes it owns, in the order made
	owned: string[]
	runs: number
	replaced: boolean
	replacements: number
	setup: boolean
	// what marked it since a run ended done, by time
	kept: Map<number, Kept>
	last?: { value: unknown }
	status: Status
	since?: number
	// the processes whose nodes its last run that did not stop read
	values: Set<string>
	waiting?: Run
	cleanups: Cleanup[]
	after?: Proc
	previous?: { value: unknown }
	run?: string
	looping: boolean
	loop?: string[]
	state: "running" | "killing" | "gone"
	busy: number
	track: Reader
}

export type Run = {
	p: Proc
	n: number
	mark: number
	given: Kept[]
	causes: Cause
	reads: ReadEntry[]
	wrote: number[]
	values: Set<string>
	rank: number
	part?: "setup" | "effect"
	value?: unknown
	equal?: boolean
	why?: string
	shown?: { value: unknown }
	stopped?: Proc
	replaced: boolean
	loop?: string[]
}

export type PartCall = { part: string; before: Child[]; matched: Set<Child>; replaced: boolean }

export type Ctx = {
	p: Proc
	agent: Agent
	base: { run?: number; handler?: string; cleanup?: true }
	run?: Run
	compute?: boolean
	causes?: Cause
	cause?: unknown
	call?: PartCall
}

export type StartOp = {
	address: Address
	program: Address | Code
	name?: string
	id?: string
	equal?: (a: unknown, b: unknown) => boolean
	// the host's: where the address is read from; default the root
	place?: Place
}
export type CallOp = {
	address: Address
	args?: unknown
	place?: Place
	// the host's: who calls, and whether a person did
	actor?: unknown
	person?: unknown
	trusted?: boolean
}
