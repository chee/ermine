// Makes a process context from what every context of one ermine shares (Parts) and its own
// state (Inner), which the functions reach and programs never do.
//
//   const o = ermine.getProcessContext(process)   // none: the host's
//   o.resolve("./notes")                          // ["work", "notes"]: the api's paths
//   o.within(() => o.write("value", id, [{ path: ["n"], value: 2 }]))
import createEntry, { type ChangeHeader, type Entry } from "@ermine/graph/entry"
import type { Location } from "@ermine/changeable/stacktrace"
import update from "@ermine/changeable/update"
import apply, { type Key as Step, type Patch } from "@ermine/changeable/apply"
import { crow, type Id, type Path, type Places, type Writer } from "@ermine/places"
import { updateEntry } from "@ermine/places/crowify"
import { address } from "@ermine/places/path"
import { createGuard, target as targetOf } from "@ermine/processes/guard"
import type { Policy, Target as Asked } from "@ermine/protect"
import { type At, PROCESS, type ProcessContext } from "@ermine/processes"
import { inside as stepsInside, type Process } from "@ermine/processes/start"
import type { Computer, Scheduler, Scope } from "@ermine/reactivity"
import { ErmineError } from "./features.ts"
import { enterScheduler, leaveScheduler } from "./registry.ts"
import type { Handle } from "./handles.ts"
import type { Key, Table, Tables } from "@ermine/graph/table"
import type { StatusTables } from "@ermine/processes/status"

export type ErmineTable = Table<Tables & StatusTables>

// What a node handle reaches: its path (walked at each use) or its id, never both.
export type NodeData =
	| { readonly path: Path; readonly id?: undefined; readonly part: Key }
	| { readonly id: Id; readonly path?: undefined; readonly part: Key }
export type Node = Handle
export type Target = Node | string | readonly string[]

export type Why = "ended" | "replaced" | (string & Record<never, never>)

// One table write: patches on (part, id), with the path it was reached by when known. `header`
// is the change as its writer made it; without one it is made from the open scope.
export type Write = {
	readonly part: Key
	readonly id: Id
	readonly path?: Path
	readonly patches: readonly Patch[]
	readonly header?: ChangeHeader
	readonly gone?: true
	readonly features?: readonly string[]
}

export const FEATURES = "features"

// One value a path holds and where it is from. Position 0 is read's; the rest come from onRead.
export type Version = {
	readonly value: unknown
	readonly from: From
	readonly gone?: true
	readonly inside?: true
}

export type From = {
	readonly change?: ChangeHeader
	readonly kind?: string
	readonly feature?: string
	readonly [more: string]: unknown
}

export type CreatedFunction = {
	readonly kind: "memo" | "effect" | "method"
	readonly computer?: Computer
	readonly node: NodeData
	readonly id: Id
	readonly process: Id
}

export type { At, ProcessContext }

export type Parts = {
	readonly scheduler: Scheduler
	readonly table: ErmineTable
	readonly commit: (changed: readonly Entry<unknown>[]) => void
	readonly may?: Policy
	readonly header: () => ChangeHeader
	readonly enter: <T>(cut: unknown, build: Location | undefined, f: () => T) => T
	readonly put: (context: ProcessContext, write: Write, land: (write: Write) => void) => void
	readonly queuePulse: () => void
	readonly onCreateFunction?: (made: CreatedFunction) => void
	readonly alive: () => void
	// In an action's call, the caller's place; asks are made as both.
	readonly caller?: () => { from?: Path; box?: Id } | undefined
}

export type Inner = {
	readonly context: ProcessContext
	readonly places: Places
	readonly box?: Id
	readonly node: Id
	readonly guarded: boolean
	readonly guard: ReturnType<typeof createGuard>
	// Runs f with a scope open: the open one, else the fallen scope.
	inside: <T>(f: () => T) => T
	put: (write: Write) => void
	writer: Writer
}

export const empty = (part: Key) => part === "attributes" || part === "status" ? {} : undefined

export function createProcessContext(
	parts: Parts,
	o: {
		scope: Scope
		places: Places
		folder: Path
		at: Path
		args: readonly string[]
		process?: Process
		node: Id
		box?: Id
	},
): Inner {
	const { scheduler: s, table, commit } = parts
	const { places } = o
	const guarded = parts.may !== undefined
	const guard = createGuard({
		places,
		scheduler: s,
		table,
		may: parts.may,
		from: o.at,
		...o.box !== undefined && { box: o.box },
		...parts.caller !== undefined && { caller: parts.caller },
	})

	// With nothing open (after an await, a timer, a listener), a process's functions throw
	// nothing-open. The host falls back to its own scope.
	const inside = <T>(f: () => T): T => {
		parts.alive()
		if (s.getCurrentScope() !== undefined) return f()
		if (o.process !== undefined) {
			throw new ErmineError(
				"nothing-open",
				"nothing is open here (after an await, a timer, a listener): write from a setup, a memo, " +
					"an effect or an action, or open the process (within)",
			)
		}
		return s.runWithScope(o.scope, f)
	}

	function resolve(p: string | Path): Path {
		parts.alive()
		const steps = address(p)
		const first = steps[0]
		const from = first === "/" ? [] : first === "." || first === ".." ? o.folder : o.at
		// ".." at "/" stays at "/".
		return stepsInside(steps, from)
	}

	function land(w: Write) {
		const entry = table.get(w.part, w.id) as Entry<unknown> | undefined
		if (w.gone) {
			if (entry !== undefined) table.del(w.part, w.id)
			return
		}
		const header = headerOf(w)
		if (entry === undefined) {
			const v = apply(empty(w.part), w.patches)
			if (v !== undefined) table.add(w.part, w.id, createEntry(v, header) as never)
			return
		}
		if (w.part === "children" || w.part === PROCESS) updateEntry(crow, entry, w.patches, header)
		else update(entry, w.patches, header)
		commit([entry])
	}
	function headerOf(w: Write): ChangeHeader {
		const header = w.header ?? parts.header()
		if (w.features === undefined) return header
		return { ...header, frame: { info: { [FEATURES]: w.features }, parent: header.frame } }
	}

	const ask = (op: string, ...targets: Asked[]) => {
		if (guarded) guard.write(op, ...targets)
	}
	const aimed = (w: { id: Id; path?: Path }, part: Key) =>
		targetOf(w.path === undefined ? { id: w.id } : { id: w.id, path: w.path }, part)

	const put = (w: Write) =>
		inside(() => parts.put(context, w, (x) => (x.gone || x.patches.length) && land(x)))

	const change = (part: Key, at: At, patches: readonly Patch[], gone?: true) => {
		const t = typeof at === "object" ? at : { id: at }
		inside(() => {
			ask("edit", aimed(t, part))
			put({
				part,
				id: t.id,
				...t.path !== undefined && { path: t.path },
				patches,
				...gone && { gone },
			})
		})
		parts.queuePulse()
	}

	const context: ProcessContext = {
		scope: o.scope,
		folder: o.folder,
		at: o.at,
		args: o.args,
		...o.process !== undefined && { process: o.process },
		resolve,
		within: <T>(f: () => T): T => {
			parts.alive()
			enterScheduler(s)
			try {
				return s.runWithScope(o.scope, f)
			} finally {
				leaveScheduler()
			}
		},
		write: function write(part, at, patches) {
			return inside(() => parts.enter(write, undefined, () => change(part, at, patches)))
		},
		remove: function remove(part, at) {
			return inside(() => parts.enter(remove, undefined, () => change(part, at, [], true)))
		},
		ask,
		queuePulse: parts.queuePulse,
	}
	const writer: Writer = (part, id, patches, header) => put({ part, id, patches, header })
	return {
		context,
		places,
		...o.box !== undefined && { box: o.box },
		node: o.node,
		guarded,
		guard,
		inside,
		put,
		writer,
	}
}

export const whole = (
	v: unknown,
): Patch[] => [v === undefined ? { path: [] } : { path: [], value: v }]

export type { Patch, Step }
