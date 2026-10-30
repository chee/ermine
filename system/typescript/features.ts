// Features change how the base works. They are given to createErmine and only add hooks.
// Each hook is middleware: it is called with the hook's arguments and `next`, and what it guards
// does not happen unless it calls next. Chain order follows the features list, each feature's
// needs first and the first feature outermost. Hooks can only be added during setup.
//
//   export default {
//     name: "patchy",
//     needs: [],
//     setup(feature) {
//       feature.onTable((table, next) => overlay(next(table), table.ahead))
//       feature.onRead((x, items, next) => next(x, [...items, ...layersAt(x)]))
//     },
//   }
//
//   onTable(table, next)           the table places reads; table.ahead is what lies in front of it
//   onRead(x, items, next)         adds items to what reads show
//   onWrite(context, write, next)  every table write, as the context it is for
//   onTeardown(scope, why, next)   each teardown as its scope goes
//   onRecord(record, next)         each run's and send's record
//   onStatus(x, status, next)      what status(x) shows; not called for a node that is not there
//   onId(kind, next)               each new id, kind "node" or "process"
//   onSchedule(pulse, next)        each ask for a pulse; not calling next means the hook runs it
//   onCreateFunction(made, next)   each memo, effect and action made
//   onError(error, fn, next)       each error ermine throws
//   reserveSlot()                  per-process state only this feature reaches
//
// A hook that throws is rethrown as a FeatureError naming the feature and hook. PENDING and
// whatever next threw pass through, and a Refusal passes with its feature and hook named.
import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import type { Key as Step } from "@ermine/changeable/apply"
import type { Id, Path, Places } from "@ermine/places"
import type { Process, Processes } from "@ermine/processes/start"
import type { Call } from "./calls.ts"
import type { Run } from "@ermine/processes/runs"
import { PENDING, type Scheduler, type Scope } from "@ermine/reactivity"
import type { Key, Table } from "@ermine/graph/table"
import { Refusal } from "@ermine/processes/guard"
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

export type Code =
	| "missing-feature"
	| "feature-twice"
	| "needs-loop"
	| "setup-only"
	| "not-yet"
	| "nothing-open"
	| "two-copies"
	| "not-a-handle"
	| "not-a-value"
	| "not-patches"
	| "not-a-function"
	| "closed"
	| "in-act"
	| "outside"
	| "bad-cleanup"
	| "not-here"
	| "gone"
	| "already-inside"

export class ErmineError extends Error {
	constructor(readonly code: Code, message: string) {
		super(`${code}: ${message}`)
		this.name = "ErmineError"
	}
}

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

export type Layer = Pick<Table, "get" | "who"> & {
	onTableChange: (part: Key, id: Id) => void
	commit: (changed: readonly Entry<unknown>[]) => void
}
export type Ahead = Pick<Layer, "onTableChange" | "commit">
export type Under = Pick<Table, "get" | "who"> & { ahead: () => Ahead }

export type Reading = {
	readonly node: NodeData
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[]
	readonly context: ProcessContext
}

export type Asked = {
	readonly node: NodeData
	readonly id: Id
	readonly computer: boolean
}

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
}
export type Errored = (error: unknown, fn: string | undefined) => unknown
export type IdKind = "node" | "process"
export type Hook = keyof Hooks
// Every hook is listed once, so a hook added to Hooks and missed here is a type error.
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
}
export const HOOKS = Object.keys(HOOK_KEYS) as readonly Hook[]

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
	reserveSlot: <T>() => Slot<T>
	// The host's process context, or a running process's. To act as one, wrap code in
	// context.within(() => ...). Not available before setup finishes.
	getProcessContext: {
		(): ProcessContext
		(process?: Process): ProcessContext | undefined
	}
	// Handles for the host and features. A handle names a place and gives no one any power.
	handleOf: (node: NodeData) => Node
	dataOf: (x: unknown) => { node: NodeData } | undefined
	// A node's path from the root, shown to a process in place of an id.
	seen: (id: Id, context: ProcessContext) => Path | undefined
	// Inside a hook or service handler: the send being answered and its record so far.
	calling: () => Calling | undefined
	// pipe-extension: core gap. A change as a process is shown it, so explain can take it back.
	viewOf: (change: ChangeHeader) => ChangeView
}

export type Calling = Omit<Call, "end" | "reads" | "writes" | "made" | "ended">

export type Feature = {
	readonly name: string
	readonly needs?: readonly string[]
	setup: (feature: FeatureAPI) => void
}

export type Shown = {
	readonly name: string
	readonly needs: readonly string[]
	readonly hooks: readonly Hook[]
}

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

export type Hooked<H extends Hook> = { readonly feature: string; readonly fn: Hooks[H] }

export type Installed = {
	readonly hooks: { readonly [H in Hook]: readonly Hooked<H>[] }
	readonly shown: readonly Shown[]
	done: () => void
}

export function install(
	features: readonly Feature[],
	parts: {
		scheduler: Scheduler
		table: Table
		places: () => Places | undefined
		processes: () => Processes | undefined
		getProcessContext: () => ((process?: Process) => ProcessContext | undefined) | undefined
		handleOf: () => ((node: NodeData) => Node) | undefined
		dataOf: () =>
			| ((x: unknown) => { node: NodeData } | undefined)
			| undefined
		seen: () => ((id: Id, context: ProcessContext) => Path | undefined) | undefined
		calling: () => (() => Calling | undefined) | undefined
		viewOf: () => ((change: ChangeHeader) => ChangeView) | undefined
	},
): Installed {
	const hooks = Object.fromEntries(HOOKS.map((h) => [h, []])) as unknown as {
		[H in Hook]: Hooked<H>[]
	}
	const shown: Shown[] = []
	let open = true
	for (const f of order(features)) {
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
			reserveSlot: <T>(): Slot<T> => {
				if (!open) throw new ErmineError("setup-only", `${f.name}'s reserveSlot`)
				const held = new WeakMap<ProcessContext, T>()
				return { get: (o) => held.get(o), set: (o, v) => void held.set(o, v) }
			},
		}
		f.setup(api)
		shown.push({ name: f.name, needs: [...(f.needs ?? [])], hooks: used })
	}
	return { hooks, shown, done: () => void (open = false) }
}

type Mark<A extends unknown[]> = (feature: string, given: A, passed: A) => A
type After<A extends unknown[], R> = (feature: string, given: A, inner: R | undefined, out: R) => R

// A hook's throw becomes a FeatureError, except PENDING, FeatureErrors and Refusals, which pass.
function own(feature: string, hook: Hook, e: unknown, passed: { e: unknown } | undefined) {
	if (e === PENDING || e instanceof FeatureError || (passed && passed.e === e)) return e
	if (e instanceof Refusal) {
		const named = e as Refusal & { feature?: string; hook?: Hook }
		if (named.feature === undefined) Object.assign(named, { feature, hook })
		return e
	}
	return new FeatureError(feature, hook, e)
}

// Wraps inner in the hooks, the first outermost.
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

// The onTable hooks laid over the table in chain order.
export function layer(
	hooks: readonly Hooked<"onTable">[],
	table: Pick<Table, "get" | "who">,
	places: () => Pick<Layer, "onTableChange" | "commit">,
): { front: Pick<Table, "get" | "who">; first: Pick<Layer, "onTableChange" | "commit"> } {
	const ahead = new Map<object, Pick<Layer, "onTableChange" | "commit">>()
	const aheadOf = (l: object) => ahead.get(l) ?? places()
	const asAhead = (l: Partial<Layer> & object): Pick<Layer, "onTableChange" | "commit"> => ({
		onTableChange: (part, id) =>
			l.onTableChange ? l.onTableChange(part, id) : aheadOf(l).onTableChange(part, id),
		commit: (changed) => l.commit ? l.commit(changed) : aheadOf(l).commit(changed),
	})
	const raw = { get: table.get, who: table.who } as Pick<Table, "get" | "who">
	const wraps = new Map<object, object>()
	const unwrap = (l: object) => {
		while (wraps.has(l)) l = wraps.get(l)!
		return l
	}
	const at = (i: number, t: Pick<Table, "get" | "who">): Pick<Table, "get" | "who"> => {
		if (i === hooks.length) return t
		const h = hooks[i]
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
