import type { Path } from "@ermine/places"
import type { Run } from "@ermine/processes/runs"
import type { Equal, Frame, Scope } from "@ermine/reactivity"
import type { Key } from "@ermine/graph/table"
import type { Location } from "@ermine/changeable/stacktrace"
import type { Call } from "../calls.ts"
import type { Inner, Node, Patch, Step, Target, Version, Why } from "../context.ts"

// The info key a write made through a writer has while the page is user-activated.
export const USER_ACTIVATED = "userActivated"

// The attribute holding the node key of the nearest enclosing scope that has one.
export const SCOPE = "ermine.computer.scope"
export const WAITING = "ermine.process.waiting"

// One node a path reaches: its value, where it was found and a handle. A refused one has neither.
export type Item = {
	readonly value: unknown
	readonly from: string
	readonly node?: Node
	readonly refused?: true
}

export type Waiting =
	| { readonly node: Path | null }
	| { readonly code: Path }
	| { readonly send: Path | null; readonly since: number }
	| "a promise"
	| "PENDING"

// A write a feature's onWrite held back, shown where it would have shown.
export type Held = { readonly feature: string; readonly write: "status" | "row" }

export type Status = {
	readonly state: "done" | "pending" | "failed" | "looping"
	readonly held?: Held
	readonly error?: unknown
	readonly phase?: "run" | "act"
	readonly waiting?: readonly Waiting[]
	readonly n?: number
	// what to do, where ermine has advice (the hints feature, hints.ts)
	readonly hint?: string
	// a feature's own fields (onStatus): pully's provider …
	readonly [field: string]: unknown
}

// What made a change: a computer, a method, a feature writing as itself, or code outside the
// graph (locations). Nodes are named by path from the root, never by id.
export type Writer =
	| { readonly kind: "computer"; readonly path?: Path; readonly run?: RunView }
	| { readonly kind: "method"; readonly path?: Path; readonly call?: CallView }
	| { readonly kind: "outside"; readonly locations?: readonly Location[] }
	// pipe-extension: core gap. A feature writing as itself: its name and its node's path.
	| { readonly kind: "feature"; readonly feature: string; readonly path?: Path }
export type Touched = { readonly part: Key; readonly path?: Path }
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
// Who called the running action: the actor its writes carry and its process's node by path.
export type Caller = { readonly actor: unknown; readonly process?: Path }

// A change as a process sees it; explain takes it back to its change.
export type ChangeView = {
	readonly time: number
	readonly actor: unknown
	readonly locations?: readonly Location[]
	// Made through a writer while the page was user-activated.
	readonly userActivated?: true
}
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

// What a writer runs as: its scope, the mark it was made under, and its own frame.
export type WriterAs = {
	readonly inner: Inner
	readonly parent: Scope
	readonly mark: Scope["info"] | undefined
	readonly frame: Frame
}
// A writer: withWriter(f) runs f as the scope createWriter was called in.
export type WithWriter = <T>(f: () => T) => T

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
