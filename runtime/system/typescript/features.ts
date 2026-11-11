// Features change how the base works. They are given to createErmine and only add hooks.
// Each hook is middleware: it is called with the hook's arguments and `next`, and what it guards
// does not happen unless it calls next. Chain order follows the features list, each feature's
// needs first and the first feature outermost. Hooks can only be added during setup.
//
//   export default {
//     name: "log",
//     needs: [],
//     setup(feature) {
//       feature.onCreateFunction((made, next) => {
//         console.log(made.kind, made.id)
//         next(made)
//       })
//     },
//   }
//
//   onRead(x, items, next)         adds items to what reads show
//   onCreateFunction(made, next)   each memo, effect and action made
//
// A hook that throws is rethrown as a FeatureError naming the feature and hook. PENDING and
// whatever next threw pass through, and a Refusal passes with its feature and hook named.
import type { ChangeHeader } from "@ermine/graph/entry"
import type { Key as Step } from "@ermine/changeable/apply"
import type { Id, Path, Places } from "@ermine/places"
import type { Process, Processes } from "@ermine/processes/start"
import type { Call } from "./calls.ts"
import { PENDING, type Scheduler } from "@ermine/reactivity"
import type { Key } from "@ermine/graph/table"
import { Refusal } from "@ermine/processes/guard"
import type {
	CreatedFunction,
	ErmineTable,
	Node,
	NodeData,
	ProcessContext,
	Version,
} from "./context.ts"
import type { ChangeView } from "./system/shapes.ts"

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
	readonly code = "feature"
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

export type Reading = {
	readonly node: NodeData
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[]
	readonly context: ProcessContext
}

export type Hooks = {
	onRead: (
		x: Reading,
		items: readonly Version[],
		next: (x: Reading, items: readonly Version[]) => readonly Version[],
	) => readonly Version[]
	onCreateFunction: (made: CreatedFunction, next: (made: CreatedFunction) => void) => void
}
export type Errored = (error: unknown, fn: string | undefined) => unknown
export type Hook = keyof Hooks
// Every hook is listed once, so a hook added to Hooks and missed here is a type error.
const HOOK_KEYS: Record<Hook, true> = {
	onRead: true,
	onCreateFunction: true,
}
export const HOOKS = Object.keys(HOOK_KEYS) as readonly Hook[]

export type FeatureAPI = {
	readonly scheduler: Scheduler
	readonly table: Pick<ErmineTable, "get" | "who">
	readonly places: Places
	readonly processes: Processes
	onRead: (hook: Hooks["onRead"]) => void
	onCreateFunction: (hook: Hooks["onCreateFunction"]) => void
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
	// A node id made as the ermine makes them (createId). Not available before setup finishes.
	newId: () => string
}

export type Calling = Omit<Call, "end" | "reads" | "writes" | "made" | "ended">

export type Feature = {
	readonly name: string
	readonly needs?: readonly string[]
	setup: (feature: FeatureAPI) => void
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
	done: () => void
}

export function install(
	features: readonly Feature[],
	parts: {
		scheduler: Scheduler
		table: Pick<ErmineTable, "get" | "who">
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
		newId: () => (() => string) | undefined
	},
): Installed {
	const hooks = Object.fromEntries(HOOKS.map((h) => [h, []])) as unknown as {
		[H in Hook]: Hooked<H>[]
	}
	let open = true
	for (const f of order(features)) {
		const adder = <H extends Hook>(h: H) => {
			const add = (fn: Hooks[H]) => {
				if (!open) {
					throw new ErmineError(
						"setup-only",
						`${f.name}'s ${h}: add the feature to createErmine`,
					)
				}
				;(hooks[h] as Hooked<H>[]).push({ feature: f.name, fn })
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
			newId: () => got("newId", parts.newId)(),
		}
		f.setup(api)
	}
	return { hooks, done: () => void (open = false) }
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
