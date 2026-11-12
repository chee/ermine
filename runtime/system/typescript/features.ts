// Features run once, as createErmine makes the ermine, with what they need to build on it. Setup
// order follows the features list, each feature's needs first.
//
//   export default {
//     name: "log",
//     needs: [],
//     setup(feature) {
//       feature.scheduler.onRunEnd((c) => console.log(c))
//     },
//   }
import type { ChangeHeader } from "@ermine/graph/entry"
import type { Id, Path, Places } from "@ermine/places"
import type { Process, Processes } from "@ermine/processes/start"
import type { Call } from "./calls.ts"
import type { Scheduler } from "@ermine/reactivity"
import type { ErmineTable, Node, NodeData, ProcessContext } from "./context.ts"
import type { ChangeView } from "./system/shapes.ts"

export type Code =
	| "missing-feature"
	| "feature-twice"
	| "needs-loop"
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

export type Errored = (error: unknown, fn: string | undefined) => unknown

export type FeatureAPI = {
	readonly scheduler: Scheduler
	readonly table: Pick<ErmineTable, "get" | "who">
	readonly places: Places
	readonly processes: Processes
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
	// Inside a service handler: the send being answered and its record so far.
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
): void {
	for (const f of order(features)) {
		const got = <T>(name: string, get: () => T | undefined) => {
			const v = get()
			if (v === undefined) {
				throw new ErmineError("not-yet", `${name} is made after setup: use it later`)
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
}
