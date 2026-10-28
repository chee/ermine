// features: changes to how the base works, given to createErmine. hooks only, no functions
//
//   export default {
//     name: "patchy",
//     files: [import.meta.url],
//     needs: [],
//     setup(feature) {
//       feature.onTable((table, next) => overlay(next(table), table.ahead))
//       feature.onRead((x, items, next) => next(x, [...items, ...layersAt(x)]))
//     },
//   }
//
// order: the features list, each one's needs set up first; a need not given, a name given twice
// or needs going round: createErmine throws, naming them. chain order is that order, the first
// outermost: its hook is called first, and next calls the one after it, the base last.
// hooks: middleware with next, every one. next is called with the hook's own arguments, as given
// or changed; not called, what it guards doesn't happen (onWrite: no write; onTeardown: the
// teardown doesn't run; onRecord: the record isn't held).
//   onTable(table, next)            the table places reads, made once before places: next(table)
//                                   is what the features after this one made; table.ahead() what
//                                   is in front of what this hook gives (the layer made over it,
//                                   or places): where its table events and commits go on to
//   onRead(x, items, next)          what reads shows beyond the table: x the node read ({ node,
//                                   part, id, path }), items reads' so far
//   onWrite(context, write, next)    every table write (values, attributes, placements, entries
//                                   gone, rows, statuses, the boot's), as the context it is for
//   onTeardown(scope, why, next)    each teardown(fn) as its scope goes; next runs fn(why)
//   onRecord(record, next)          each run's and send's record as it is written; next holds it
//   onStatus(x, status, next)       what status(x) shows: x the node read ({ node, id }), status the
//                                   base's so far; next gives the inner hooks' (the base's last).
//                                   a field it adds is the feature's to name (pully's provider).
//                                   not called for a node not there
//   onId(kind, next)                each new id: kind "node" (a node's, the root's, the host's) or
//                                   "process"; next gives the base's (uuidv7; proc:<boot>-<n>)
//   onSchedule(pulse, next)         each ask for a pulse soon (one at a time): next(pulse) runs it
//                                   in a microtask; not called: pulse is the hook's to run, or not
//   onCreateFunction(made, next)    each memo, effect and action made (an inspector's)
//   onError(error, fn, next)        each error ermine throws (fn: the function of @ermine/system's
//                                   it came out of; none: ermine's own, start's or closed): what
//                                   the hook gives is thrown (hints.ts adds its advice)
//   onTrace(trace, next)            what a write outside a run keeps: its site, and the whole
//                                   trace text or not (trace.ts turns it on)
//   reserveSlot()                   per-process state only this feature reaches, by context
// and, in a hook (made after setup; before: not-yet), what a feature acts with: context(process?)
// a running process's context (none: the host's); to act as one, context.within(() => …) round
// @ermine/system's functions, which find it (a feature that sends as whoever named something, as
// pully does)
// shown: a hook's throw is rethrown as a FeatureError naming the feature and the hook. PENDING,
// and what next threw, pass as they are; a Refusal the hook throws passes as a Refusal, its
// feature and hook named on it (feature, hook). an item onRead adds names the feature
// (from.feature); a write onWrite changed names it in its metadata (features: every feature that
// changed it, in chain order). sites skip the feature's files, and only those: a feature lists its
// own.
// hooks are setup-only: one added after createErmine has returned throws.
import type { ChangeHeader, Entry } from "@ermine/core/node/entry"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import type { Key as Step } from "@ermine/core/changeable/apply"
import type { Id, Path, Places } from "@ermine/core/places"
import type { Process, Processes } from "@ermine/processes/start"
import type { Call } from "./calls.ts"
import type { Run } from "@ermine/processes/runs"
import { type Computer, PENDING, type Scheduler, type Scope } from "@ermine/core/scheduler"
import type { Key, Table } from "@ermine/core/table"
import { Refusal } from "@ermine/core/places/guard"
import type {
	CreatedFunction,
	Node,
	NodeData,
	ProcessContext,
	Version,
	Why,
	Write,
} from "./context.ts"
import type { ChangeView, Status } from "./system/shapes.ts"

// what createErmine and its parts throw, by code
export type Code =
	| "missing-feature"
	| "feature-twice"
	| "needs-loop"
	| "setup-only"
	| "not-yet"
	| "nothing-open"
	// a function found nothing open, but an ermine of a second copy of @ermine/system has
	| "two-copies"
	| "not-a-handle"
	| "not-a-value"
	| "not-patches"
	| "not-a-function"
	| "closed"
	// something made, or a teardown added, in an effect's act (an act makes nothing)
	| "in-act"
	// an act returned something that is no function (its cleanup)
	| "bad-cleanup"
	// createWriter or start called where a process can't (a compute, an act)
	| "not-here"
	// a writer called after its parent ended
	| "gone"
	// a writer called while a scope or run is open
	| "already-inside"

export class ErmineError extends Error {
	constructor(readonly code: Code, message: string) {
		super(`${code}: ${message}`)
		this.name = "ErmineError"
	}
}

// a hook's throw: the feature, the hook, what it threw (cause)
export class FeatureError extends Error {
	constructor(readonly feature: string, readonly hook: Hook, cause: unknown) {
		super(
			`${feature}'s ${hook} threw: ${cause instanceof Error ? cause.message : String(cause)}`,
			{
				cause,
			},
		)
		this.name = "FeatureError"
	}
}

// the table places reads through: get and who, and where table events and commits go on to
export type Layer = Pick<Table, "get" | "who"> & {
	onTableChange: (part: Key, id: Id) => void
	commit: (changed: readonly Entry<unknown>[]) => void
}
// where a layer's table events and commits go on to
export type Ahead = Pick<Layer, "onTableChange" | "commit">
// what onTable is given: the table under it, and what is in front of what the hook gives
export type Under = Pick<Table, "get" | "who"> & { ahead: () => Ahead }

// the node reads is reading, and who reads it (a feature's own fields shown to it name nodes by
// the path it sees: seen)
export type Reading = {
	readonly node: NodeData
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[]
	readonly context: ProcessContext
}

// the node status(x) is asked of; computer: a memo's or effect's
export type Asked = {
	readonly node: NodeData
	readonly id: Id
	readonly computer: boolean
}

// a record as it is written: a computer's run, or a send's call, by its node's id
export type Recorded =
	| { readonly id: Id; readonly run: Run; readonly call?: undefined }
	| { readonly id: Id; readonly call: Call; readonly run?: undefined }

export type Hooks = {
	onTable: (table: Under, next: (table: Under) => Layer) => Layer
	onRead: (
		x: Reading,
		items: readonly Version[],
		next: (x: Reading, items: readonly Version[]) => readonly Version[],
	) => readonly Version[]
	onWrite: (
		context: ProcessContext,
		write: Write,
		next: (context: ProcessContext, write: Write) => void,
	) => void
	onTeardown: (scope: Scope, why: Why, next: (scope: Scope, why: Why) => void) => void
	onRecord: (record: Recorded, next: (record: Recorded) => void) => void
	onStatus: (x: Asked, status: Status, next: (x: Asked, status: Status) => Status) => Status
	onId: (kind: IdKind, next: (kind: IdKind) => string) => string
	onSchedule: (pulse: () => void, next: (pulse: () => void) => void) => void
	onCreateFunction: (made: CreatedFunction, next: (made: CreatedFunction) => void) => void
	onError: (error: unknown, fn: string | undefined, next: Errored) => unknown
	onTrace: (trace: Trace, next: (trace: Trace) => Trace) => Trace
}
// what a write outside a run keeps: its site (built: a build site given, nothing captured) and,
// text, the whole trace text beside the change (traceOf, @ermine/core/places/header)
export type Trace = { readonly text: boolean; readonly built?: FileLocation }
// an error on its way out: what is thrown
export type Errored = (error: unknown, fn: string | undefined) => unknown
// what a new id is for
export type IdKind = "node" | "process"
export type Hook = keyof Hooks
// every hook, written once: a hook added to Hooks is missed here as a type error
const HOOK_KEYS: Record<Hook, true> = {
	onTable: true,
	onRead: true,
	onWrite: true,
	onTeardown: true,
	onRecord: true,
	onStatus: true,
	onId: true,
	onSchedule: true,
	onCreateFunction: true,
	onError: true,
	onTrace: true,
}
export const HOOKS = Object.keys(HOOK_KEYS) as readonly Hook[]

// per-process state, by context: only who holds the slot reaches it
export type Slot<T> = {
	get: (context: ProcessContext) => T | undefined
	set: (context: ProcessContext, value: T) => void
}

export type FeatureAPI = {
	readonly scheduler: Scheduler
	readonly table: Table
	// made after setup: read them in a hook (before: not-yet)
	readonly places: Places
	readonly processes: Processes
	onTable: (hook: Hooks["onTable"]) => void
	onRead: (hook: Hooks["onRead"]) => void
	onWrite: (hook: Hooks["onWrite"]) => void
	onTeardown: (hook: Hooks["onTeardown"]) => void
	onRecord: (hook: Hooks["onRecord"]) => void
	onStatus: (hook: Hooks["onStatus"]) => void
	onId: (hook: Hooks["onId"]) => void
	onSchedule: (hook: Hooks["onSchedule"]) => void
	onCreateFunction: (hook: Hooks["onCreateFunction"]) => void
	onError: (hook: Hooks["onError"]) => void
	onTrace: (hook: Hooks["onTrace"]) => void
	reserveSlot: <T>() => Slot<T>
	// in a hook (before: not-yet): the host's process context; a process's while it runs (stopped,
	// or not this ermine's: undefined). acting as one: context.within(() => …), @ermine/system's
	// functions finding it
	getProcessContext: {
		(): ProcessContext
		(process?: Process): ProcessContext | undefined
	}
	// the host's and features' side of handles (handles.ts): a handle minted for node (an id, any
	// part: features have that power; a path from the root); and what a handle reaches (not this
	// ermine's handle: undefined). a handle names a place, no one's power [chee 10-26]
	handleOf: (node: NodeData) => Node
	dataOf: (x: unknown) => { node: NodeData } | undefined
	// a node's path from the root (none: moved, or placed by no
	// functions): what a feature shows a process in place of an id
	seen: (id: Id, context: ProcessContext) => Path | undefined
	// in a hook or a service's handler (before: not-yet): the send being answered where the code runs
	// now (the scope open, or one above it), its record so far, the caller's context in it; none:
	// undefined. for a service acting for its caller (patchy's land)
	calling: () => Calling | undefined
	// pipe-extension: core gap. a change (a table fact's, an entry's) as a process is shown it:
	// the view reads give, so explain takes it back. one view for each change
	viewOf: (change: ChangeHeader) => ChangeView
	// pipe-extension: core gap. where a memo or effect was made: a build site, the process's site
	// when made in its setup, else the line that called the function (read now: the first read
	// parses the stack held at the make)
	siteOf: (computer: Computer) => FileLocation | undefined
}

// a send being answered: its record so far
export type Calling = Omit<Call, "end" | "reads" | "writes" | "made" | "ended">

export type Feature = {
	readonly name: string
	// import.meta.url …: the sites skip them
	readonly files?: readonly string[]
	// other features' names: set up first
	readonly needs?: readonly string[]
	setup: (feature: FeatureAPI) => void
}

// what ermine.features shows: each feature's name, its needs and its hooks, in chain order
export type Shown = {
	readonly name: string
	readonly needs: readonly string[]
	readonly hooks: readonly Hook[]
}

// the features in chain order: each one's needs first, else the order given
export function order(features: readonly Feature[]): Feature[] {
	const named = new Map<string, Feature>()
	for (const f of features) {
		if (named.has(f.name)) throw new ErmineError("feature-twice", f.name)
		named.set(f.name, f)
	}
	const out: Feature[] = []
	const state = new Map<string, "doing" | "done">()
	const visit = (f: Feature, way: readonly string[]) => {
		const s = state.get(f.name)
		if (s === "done") return
		if (s === "doing") throw new ErmineError("needs-loop", [...way, f.name].join(" → "))
		state.set(f.name, "doing")
		for (const n of f.needs ?? []) {
			const g = named.get(n)
			if (g === undefined) throw new ErmineError("missing-feature", `${f.name} needs ${n}`)
			visit(g, [...way, f.name])
		}
		state.set(f.name, "done")
		out.push(f)
	}
	for (const f of features) visit(f, [])
	return out
}

// a hook, and the feature it is of
export type Hooked<H extends Hook> = { readonly feature: string; readonly fn: Hooks[H] }

// the features, set up: their hooks by kind in chain order, what to show, the files the sites skip
export type Installed = {
	readonly hooks: { readonly [H in Hook]: readonly Hooked<H>[] }
	readonly shown: readonly Shown[]
	readonly files: readonly string[]
	// hooks are setup-only from now on
	done: () => void
}

// each feature's setup run with its own FeatureAPI, in chain order. parts: what the FeatureAPI
// gives (places and processes: getters, not-yet until made)
export function install(
	features: readonly Feature[],
	parts: {
		scheduler: Scheduler
		table: Table
		places: () => Places | undefined
		processes: () => Processes | undefined
		// none till ermine is made
		getProcessContext: () => ((process?: Process) => ProcessContext | undefined) | undefined
		handleOf: () => ((node: NodeData) => Node) | undefined
		dataOf: () =>
			| ((x: unknown) => { node: NodeData } | undefined)
			| undefined
		seen: () => ((id: Id, context: ProcessContext) => Path | undefined) | undefined
		calling: () => (() => Calling | undefined) | undefined
		viewOf: () => ((change: ChangeHeader) => ChangeView) | undefined
		siteOf: (computer: Computer) => FileLocation | undefined
	},
): Installed {
	const hooks = Object.fromEntries(HOOKS.map((h) => [h, []])) as unknown as {
		[H in Hook]: Hooked<H>[]
	}
	const shown: Shown[] = []
	const files = new Set<string>()
	let open = true
	for (const f of order(features)) {
		for (const file of f.files ?? []) files.add(file)
		const used: Hook[] = []
		const adder = <H extends Hook>(h: H) => {
			const add = (fn: Hooks[H]) => {
				if (!open) {
					throw new ErmineError(
						"setup-only",
						`${f.name}'s ${h}: add the feature to createErmine`,
					)
				}
				;(hooks[h] as Hooked<H>[]).push({ feature: f.name, fn })
				if (!used.includes(h)) used.push(h)
			}
			return add
		}
		const got = <T>(name: string, get: () => T | undefined) => {
			const v = get()
			if (v === undefined) {
				throw new ErmineError("not-yet", `${name} is made after setup: use it in a hook`)
			}
			return v
		}
		const api: FeatureAPI = {
			scheduler: parts.scheduler,
			table: parts.table,
			get places() {
				return got("places", parts.places)
			},
			get processes() {
				return got("processes", parts.processes)
			},
			...Object.fromEntries(HOOKS.map((h) => [h, adder(h)])) as Pick<FeatureAPI, Hook>,
			getProcessContext: ((process?: Process) =>
				got("getProcessContext", parts.getProcessContext)(process)) as FeatureAPI[
					"getProcessContext"
				],
			handleOf: (node) =>
				got("handleOf", parts.handleOf)(node),
			dataOf: (x) => got("dataOf", parts.dataOf)(x),
			seen: (id, context) => got("seen", parts.seen)(id, context),
			calling: () => got("calling", parts.calling)(),
			viewOf: (change) => got("viewOf", parts.viewOf)(change),
			siteOf: parts.siteOf,
			reserveSlot: <T>(): Slot<T> => {
				if (!open) throw new ErmineError("setup-only", `${f.name}'s reserveSlot`)
				const held = new WeakMap<ProcessContext, T>()
				return { get: (o) => held.get(o), set: (o, v) => void held.set(o, v) }
			},
		}
		f.setup(api)
		shown.push({ name: f.name, needs: [...(f.needs ?? [])], hooks: used })
	}
	return { hooks, shown, files: [...files], done: () => void (open = false) }
}

// how a hook's arguments, changed by it, are marked as its (onRead's new items, onWrite's write)
type Mark<A extends unknown[]> = (feature: string, given: A, passed: A) => A
// and how what it gives back is (onRead's items it added after next)
type After<A extends unknown[], R> = (feature: string, given: A, inner: R | undefined, out: R) => R

// what a hook's throw is thrown as: PENDING, a FeatureError and what its next threw as they are; a
// Refusal as it is, the feature and hook named on it (the first to throw it); else a FeatureError
function own(feature: string, hook: Hook, e: unknown, passed: { e: unknown } | undefined) {
	if (e === PENDING || e instanceof FeatureError || (passed && passed.e === e)) return e
	if (e instanceof Refusal) {
		const named = e as Refusal & { feature?: string; hook?: Hook }
		if (named.feature === undefined) Object.assign(named, { feature, hook })
		return e
	}
	return new FeatureError(feature, hook, e)
}

// the hooks around inner, as one function: the first outermost. a hook's own throw is a
// FeatureError; PENDING, a FeatureError, and what its next threw pass as they are
export function chain<A extends unknown[], R>(
	// deno-lint-ignore no-explicit-any
	hooks: readonly { readonly feature: string; readonly fn: (...a: any[]) => R }[],
	hook: Hook,
	inner: (...a: A) => R,
	mark?: Mark<A>,
	after?: After<A, R>,
): (...a: A) => R {
	if (hooks.length === 0) return inner
	const at = (i: number, a: A): R => {
		if (i === hooks.length) return inner(...a)
		const h = hooks[i]
		let passed: { e: unknown } | undefined
		let got: R | undefined
		const next = (...b: unknown[]): R => {
			try {
				return got = at(i + 1, (mark ? mark(h.feature, a, b as A) : b) as A)
			} catch (e) {
				passed = { e }
				throw e
			}
		}
		let out: R
		try {
			out = h.fn(...a, next)
		} catch (e) {
			throw own(h.feature, hook, e, passed)
		}
		return after ? after(h.feature, a, got, out) : out
	}
	return (...a: A) => at(0, a)
}

// onTable's hooks over the table, in chain order: what places reads, and where the table's own
// events and commits go first. each layer's ahead: the layer made over it, or places
export function layer(
	hooks: readonly Hooked<"onTable">[],
	table: Pick<Table, "get" | "who">,
	places: () => Pick<Layer, "onTableChange" | "commit">,
): { front: Pick<Table, "get" | "who">; first: Pick<Layer, "onTableChange" | "commit"> } {
	// a layer → what is in front of it
	const ahead = new Map<object, Pick<Layer, "onTableChange" | "commit">>()
	const aheadOf = (l: object) => ahead.get(l) ?? places()
	// a layer as somewhere to go on to: its own, else on through it
	const asAhead = (l: Partial<Layer> & object): Pick<Layer, "onTableChange" | "commit"> => ({
		onTableChange: (part, id) =>
			l.onTableChange ? l.onTableChange(part, id) : aheadOf(l).onTableChange(part, id),
		commit: (changed) => l.commit ? l.commit(changed) : aheadOf(l).commit(changed),
	})
	const raw = { get: table.get, who: table.who } as Pick<Table, "get" | "who">
	// what each hook was given stands for the table under it
	const wraps = new Map<object, object>()
	const unwrap = (l: object) => {
		while (wraps.has(l)) l = wraps.get(l)!
		return l
	}
	const at = (i: number, t: Pick<Table, "get" | "who">): Pick<Table, "get" | "who"> => {
		if (i === hooks.length) return t
		const h = hooks[i]
		// what this hook gives, once it has
		// deno-lint-ignore prefer-const
		let made: object | undefined
		const under: Under = {
			get: t.get,
			who: t.who,
			ahead: () => made === undefined ? places() : aheadOf(made),
		}
		wraps.set(under, t)
		let inner: object | undefined
		let passed: { e: unknown } | undefined
		let out: Layer
		try {
			out = h.fn(under, (u) => {
				try {
					const got = at(i + 1, u)
					inner = unwrap(got)
					return got as Layer
				} catch (e) {
					passed = { e }
					throw e
				}
			})
		} catch (e) {
			throw own(h.feature, "onTable", e, passed)
		}
		made = unwrap(out)
		if (inner !== undefined && inner !== made) ahead.set(inner, asAhead(made as Layer))
		return out
	}
	const front = at(0, raw)
	return { front, first: asAhead(raw) }
}
