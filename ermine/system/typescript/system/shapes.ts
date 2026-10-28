import type { Path } from "@ermine/core/places"
import type { Run } from "@ermine/processes/runs"
import type { Equal, Frame, Scope } from "@ermine/core/scheduler"
import type { Key } from "@ermine/core/table"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import type { Call } from "../calls.ts"
import type { Inner, Node, Patch, Step, Target, Version, Why } from "../context.ts"

// the metadata key a write made through a writer has while the page is user-activated
// (a ChangeView's userActivated)
export const USER_ACTIVATED = "userActivated"

// the attribute a memo's or effect's node holds its scope in: the NODE key's id of the nearest
// scope above it with one, written once as the node is made (beside status.ts')
export const SCOPE = "ermine.computer.scope"
// what a pending process waits on, written by what started it (ermine's start)
export const WAITING = "ermine.process.waiting"

// one node a path reaches: its value, where it was found, and a handle to it (reached by this
// process's own path, so its to hold); refused by the policy: no value, no handle
export type Item = {
	readonly value: unknown
	readonly from: string
	readonly node?: Node
	readonly refused?: true
}

// what a pending one waits on: a memo it read that is pending (its node), a send to nothing, a
// process's code not at its path yet, a promise, or nothing it says (it gave PENDING itself)
export type Waiting =
	| { readonly node: Path | null }
	| { readonly code: Path }
	| { readonly send: Path | null; readonly since: number }
	| "a promise"
	| "PENDING"

// a write a feature's onWrite held back, shown where it would have shown: its status write, or a
// stopped process's row's removal [chee: "Held, with a trace", "Held, and shown"]
export type Held = { readonly feature: string; readonly write: "status" | "row" }

export type Status = {
	readonly state: "done" | "pending" | "failed" | "looping"
	// what it shows is so because a feature held a write back
	readonly held?: Held
	readonly error?: unknown
	// failed: in its run, or in an effect's act
	readonly phase?: "run" | "act"
	readonly waiting?: readonly Waiting[]
	// a computer's latest run's: a value from an older run is stale
	readonly n?: number
	// what to do, where ermine has advice (the hints feature, hints.ts)
	readonly hint?: string
	// a feature's own fields (onStatus): pully's provider …
	readonly [field: string]: unknown
}

// what made a change, one step: a computer (a memo or effect; run: its latest record, when that
// still holds the change), a method (call: its record while it is the handler's latest, whether or not it holds the write), a feature's
// thing writing as itself (a scope whose info holds NODE and feature: a pipe), or code outside any
// (site: its last, the nearest; fallback: a process's write with nothing open)
// nodes named by their path from the root (seen; none: moved,
// or placed by no functions): no ids [chee 10-25: "i'm not sure the process api should be able to do
// anything by id"; "not quite true when there is sync"]
export type Writer =
	| { readonly kind: "computer"; readonly path?: Path; readonly run?: RunView }
	| { readonly kind: "method"; readonly path?: Path; readonly call?: CallView }
	| { readonly kind: "outside"; readonly site?: FileLocation }
	// pipe-extension: core gap. a feature's thing that writes as itself (a scope whose info holds
	// NODE and feature): the feature's name, and its node's path
	| { readonly kind: "feature"; readonly feature: string; readonly path?: Path }
// a record's read or write, as the process asking sees it
export type Touched = { readonly part: Key; readonly path?: Path }
// a run's record, as a process sees it (runs.ts' Run, its nodes by path)
export type RunView = {
	readonly n: number
	readonly started?: number
	readonly ended: number
	readonly end: Run["end"]
	readonly error?: unknown
	readonly act?: Run["act"]
	readonly reads: readonly Touched[]
	readonly writes: readonly Touched[]
}
// a call's record, as a process sees it (calls.ts' Call, its nodes by path; no caller: getCaller)
export type CallView = {
	readonly n: number
	readonly args: readonly unknown[]
	readonly end: Call["end"]
	readonly returned?: unknown
	readonly error?: unknown
	readonly started: number
	readonly ended?: number
	readonly reads: readonly Touched[]
	readonly writes: readonly Touched[]
	readonly made?: readonly { readonly kind: "memo" | "effect" | "early"; readonly path?: Path }[]
}
// who called the action running now [chee 10-25: "oh well, it should"]: the actor its writes carry,
// and its process's node by path (none: nothing reaches it)
export type Caller = { readonly actor: unknown; readonly process?: Path }

// a change as a process sees it: when, who, and the line that made it; explain takes it back to its
// change (one view per change, base.views). its metadata (node ids) stays the host's
export type ChangeView = {
	readonly time: number
	readonly actor: unknown
	// of its sites (the header's external, oldest first), the last: the nearest
	readonly site?: FileLocation
	// made through a writer (createWriter) that ran while navigator.userActivation.isActive
	// (useractivation.ts): a person had just interacted with the page, no more
	readonly userActivated?: true
}
// a change explained: it and its writer. held (a node's only): the latest write there a feature
// held back, since the change (no change: only that)
export type Explained =
	| {
		readonly change: ChangeView
		readonly writer: Writer
		readonly held?: { readonly feature: string }
	}
	| {
		readonly change?: undefined
		readonly writer?: undefined
		readonly held: { readonly feature: string }
	}

export class SendError extends Error {
	constructor(readonly code: "not-a-method", readonly at: string) {
		super(`${code} (${at})`)
		this.name = "SendError"
	}
}

// what a writer runs as: where it was made, and the mark it was made under (an action's call: its
// info, never the user-activated flag; setup: none, the scope's own), and its own frame
export type WriterAs = {
	readonly inner: Inner
	// what f's makings and asks belong to: the scope createWriter was called in
	readonly parent: Scope
	// the info of the frame it was made under (an action's call), when not that scope's own: its
	// runs are made in a frame of that info under the scope's
	readonly mark: Scope["info"] | undefined
	// the writer's own frame, made as createWriter was called, under that scope's (its site where
	// createWriter was called): its runs are under it
	readonly frame: Frame
}
// a writer: withWriter(f) runs f as the parent createWriter was called in, its writes carrying the
// frame it was made under, each at the writer's site [marks-2026-10-27; scope and frame, frames
// walked, 10-28]
export type WithWriter = <T>(f: () => T) => T

// what start gives a program: where the process is, its stop and its status; or taken
export type Starting = {
	readonly process: { readonly at: Path; readonly folder: Path }
	readonly stop: (why?: Why) => void
	readonly status: () => Status | undefined
}
export type Taken = { readonly refused: "taken"; readonly at: Path }

type Computed<T> = (previous: T | undefined) => T | PromiseLike<T> | symbol

export type System = {
	getNode: (path: string | Path) => Node
	hasNode: (x: Target) => boolean
	ensureNode: (path: string | Path, value?: unknown) => Node
	createNode: (folder: string | Path, value?: unknown) => Node
	ref: <T>(path: string | Path, make: () => T) => Node
	read: (x: Target, key?: readonly Step[]) => unknown
	readAttributes: (x: Target, key?: readonly Step[]) => unknown
	readChildren: (x: Target) => Record<string, Node>
	readAll: (x: Target, key?: readonly Step[]) => Version[]
	readAllAttributes: (x: Target, key?: readonly Step[]) => Version[]
	readAllChildren: (x: Target) => Version[]
	readEntries: (x: Target) => Item[]
	peep: <T>(f: () => T) => T
	patch: (x: Target, patches: readonly Patch[]) => void
	patchAttributes: (x: Target, patches: readonly Patch[]) => void
	patchChildren: (x: Target, patches: readonly Patch[]) => void
	explain: (x: Target | ChangeView, key?: readonly Step[]) => Explained | undefined
	explainAttributes: (x: Target) => Explained | undefined
	explainChildren: (x: Target) => Explained | undefined
	place: (path: string | Path, x: Target) => void
	unplace: (path: string | Path) => void
	rename: (from: string | Path, to: string | Path) => void
	list: (x: Target) => string[]
	createMemo: <T>(name: string | Path, f: Computed<T>, options?: { equal?: Equal<T> }) => Node
	createEffect: <T>(
		name: string | Path,
		f: Computed<T>,
		act: (value: T, before: T | undefined) => void | (() => unknown),
		options?: { equal?: Equal<T>; early?: boolean },
	) => Node
	// deno-lint-ignore no-explicit-any
	createAction: (path: string | Path, fn: (...args: any[]) => unknown) => Node
	executeAction: (path: Target, ...args: unknown[]) => unknown
	getCaller: () => Caller | undefined
	// key: that field alone, read and told alone (a reader of state isn't run again when only n moves)
	getStatus: {
		(x: Target): Status | undefined
		<K extends keyof Status & string>(x: Target, key: K): Status[K] | undefined
	}
	addTeardown: (fn: (why: Why) => unknown) => void
	getArgs: () => readonly string[]
	createWriter: () => WithWriter
	start: (
		fn: () => unknown,
		at: string | Path,
		options?: { args?: readonly string[] },
	) => Starting | Taken
	remove: (x: Target) => void
	pulse: () => void
}
