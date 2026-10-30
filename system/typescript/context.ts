// the process context's making (its type, and what each of its functions does: @ermine/processes'
// context.ts): a context from what every context of one ermine shares (Parts), and its own
// beside it (Inner), what the functions reach and programs never do
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
import type { Key, Table } from "@ermine/graph/table"

// what a node handle reaches (handles.ts; the host's and features' side): walked to by its path at
// each use, or its id (a node with no place); never both
export type NodeData =
	| { readonly path: Path; readonly id?: undefined; readonly part: Key }
	| { readonly id: Id; readonly path?: undefined; readonly part: Key }
// a node, as a program holds it: an opaque handle (handles.ts)
export type Node = Handle
export type Target = Node | string | readonly string[]

// why a scope goes, as its teardowns are told: its owner ran again, the process ended, or the
// reason its stop was given
export type Why = "ended" | "replaced" | (string & Record<never, never>)

// one write, every table write: patches on (part, id), the path it was reached by when known
// (protect asks by it). header: the change as its writer made it (its frame); none:
// made from the scope open as it lands. gone: the entry taken out (no patches). features and
// fallback: the base's own, set by it (a hook's own are let go)
export type Write = {
	readonly part: Key
	readonly id: Id
	readonly path?: Path
	readonly patches: readonly Patch[]
	readonly header?: ChangeHeader
	readonly gone?: true
	// the onWrite hooks that changed it, outermost first: its change's frame FEATURES says so (one more frame on top)
	readonly features?: readonly string[]
}

// the info key the base sets: a changed write's hooks (Write.features)
export const FEATURES = "features"

// one value a path holds, and where it is from: position 0 is read's, from its entry's change;
// the rest, what features show (onRead), each naming its feature (from.feature). gone: a delete;
// inside: a write under it is not its own
export type Version = {
	readonly value: unknown
	readonly from: From
	readonly gone?: true
	readonly inside?: true
}

// where a value is from: the change it came from, by reference (its actor, time, locations; explain
// gives its writer), and for a feature's item what the feature says (kind, and its name)
export type From = {
	readonly change?: ChangeHeader
	readonly kind?: string
	readonly feature?: string
	readonly [more: string]: unknown
}

// what onCreateFunction is told: the computer (none for a method), its node, and who made it (the
// process's id, or the host's node's)
export type CreatedFunction = {
	readonly kind: "memo" | "effect" | "method"
	readonly computer?: Computer
	readonly node: NodeData
	readonly id: Id
	readonly process: Id
}

// the one context type is processes'; here for system's own files too
export type { At, ProcessContext }

// what every context of one ermine shares
export type Parts = {
	readonly scheduler: Scheduler
	// the table, and where a write to it is said (the first layer's commit)
	readonly table: Table
	readonly commit: (changed: readonly Entry<unknown>[]) => void
	readonly may?: Policy
	// a write's header now: the frame open's; from outside the graph, with the locations of the call
	readonly header: () => ChangeHeader
	// a call of ermine's from outside the graph (cut: the function called; build: its location, if a
	// build wrote one in): its locations captured once, f run in a frame of its own holding them
	readonly enter: <T>(cut: unknown, build: Location | undefined, f: () => T) => T
	// the onWrite hooks, around land
	readonly put: (context: ProcessContext, write: Write, land: (write: Write) => void) => void
	readonly queuePulse: () => void
	readonly onCreateFunction?: (made: CreatedFunction) => void
	// throws once ermine is closed
	readonly alive: () => void
	// in an action's call, its caller's place (none: the host): asks there are asked as both (guard)
	readonly caller?: () => { from?: Path; box?: Id } | undefined
}

// a process context's own, beside it: what the functions reach and programs never do
export type Inner = {
	readonly context: ProcessContext
	readonly places: Places
	// the box it is in: its places' root, when that is not the ermine's (none: the ermine's own)
	readonly box?: Id
	// who it acts as: the process's node, or the host's
	readonly node: Id
	readonly guarded: boolean
	readonly guard: ReturnType<typeof createGuard>
	// f with a scope open: the one open, else the fallen scope (a process's) or the context's (the
	// host's)
	inside: <T>(f: () => T) => T
	// one write, unasked (a memo's own, a method's after its ask), through onWrite
	put: (write: Write) => void
	// put as places' Writer: for the libraries that write for this context (status)
	writer: Writer
}

// what a part holds when nothing is there: attributes and a status are maps, so {}; a value, nothing
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

	// nothing open: a process's throws nothing-open (its functions are called from its setup, runs, acts
	// and calls; after an await, a timer, a listener: nothing is open [chee 10-25: "we are getting
	// rid of setup(api) right? so we are moving to throw"]; feature code acting as a process opens
	// it: within). the host's falls back to its own scope: process 0's writes from host code lose
	// nothing
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
		// ".." at "/" stays at "/": every process's "/" is as high as it goes (a box's too)
		return stepsInside(steps, from)
	}

	// the write landed: the entry made when there is none (the table event tells its readers),
	// else updated and said
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
		// children and process rows change as places changes them (readers keep what they read)
		if (w.part === "children" || w.part === PROCESS) updateEntry(crow, entry, w.patches, header)
		else update(entry, w.patches, header)
		commit([entry])
	}
	// the change a write lands with: its writer's, or made now; a write a hook changed, that one's
	// copy naming the hooks
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

	// a write at a node, asked edit first (gone: taken out)
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
		// a call of ermine's: from outside the graph, entered once its scope is open (the host's
		// falls back to its own), so a capture of where it was called starts at its caller
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

// a whole value as patches; undefined: taken out
export const whole = (
	v: unknown,
): Patch[] => [v === undefined ? { path: [] } : { path: [], value: v }]

export type { Patch, Step }
