// ermine: what a host makes, once. the host is process 0: its code runs in its own scope (its setup,
// or within), where @ermine/system's functions act as it; the ermine object is the rest
//
//   import { createErmine } from "@ermine/system"
//   import patches from "@ermine/patchy/feature"
//
//   const ermine = createErmine({ features: [patches], host: { at: "/host", args, setup } })
//   ermine.within(() => ensureNode("/work/n", 1))          // host code, as the host
//   const running = ermine.start(clock, "/work/clock")    // { process, stop(), status() }
//   running.status()                                       // a setup that threw shows here
//   ermine.close()                                         // every process, then the host's
//
// options, each with a default:
//   features   none (features.ts)
//   scheduler  a new one
//   may        the policy every read and write is asked of; none: all allowed
//   root       the root's id; none: a new one
//   host       the host's node: where it is placed (none: nowhere, reached by ermine.id), the
//              host's args, the machine it publishes, and its setup: run once, untracked, in the
//              host's scope as createErmine ends (a throw: ermine closed, the error thrown)
//   info       the host's scope's info (actor, …), beside its node
// made inside, in order: the scheduler; sites (skipping ermine's files and every feature's files,
// a live list); the table, each feature's setup, then onTable's layers; places over the front layer, with
// processes' rows, released at each tracking end; the root node and the host's node, written as
// the host; scope nodes, processes, statuses, runs and calls; the host's context (context.ts): the
// host's scope at the root, no process.
// the host's code: @ermine/system's functions, imported, in the host's scope (its setup, or
// ermine.within) [chee 10-27: the host is process 0; picked "ermine.within(fn)" and "host setup"
// over the functions on the ermine object]: bare names in the root, folder the root, args the
// host's, an action's caller the host's node, addTeardown(fn) at close.
// the host's node: one plain node, not a process (no row, nothing to stop). its id: a send's
// caller from the host, and its scope's NODE. its attributes: ermine.host.args,
// ermine.host.machine, ermine.features (what ermine.features shows).
// the lifecycle:
//   start(fn, at, { args })   a process at at running fn, its
//                        setup, given nothing, the process's scope open [chee 10-26: "so let's do
//                        ermine.start(fn, path, {args?, box?})": the program given, not looked up
//                        at a path]. its folder: the one it is in. places (a view of the ermine's
//                        own): its "/" and its rows are that view's, and what it starts is in it too. → { process, stop(why?),
//                        status() }, or { refused: "taken", at }. what setup returns: the
//                        process's value (a promise: pending till it settles); setup throwing: its
//                        error in status(process), the process still there; throwing PENDING (a
//                        send to nothing): pending, what it waits on in ermine.process.waiting;
//                        setup is untracked and runs once, never again [chee 10-25: "like solid"]
//   close()              every process ermine started stopped ("ended"), newest first, then the
//                        host's scope, then ermine's own listeners and what features listen to
//                        on the scheduler. its functions and parts (records, node too; a feature's calling) throw
//                        closed after
// getProcessContext(process?): a running process's process context (host and feature code acting
// as a process: context.within(() => executeAction(…)), @ermine/system's functions finding it)
// (none: the host's). scheduler, table, places: the whole thing, for the host and features
// (features also get processes, FeatureAPI). features: each one's name, needs and hooks, in chain order. records: run(id) a
// computer's latest run, call(id) a handler's latest send, waits() every send waiting; tracked.
import type { ChangeHeader } from "@ermine/core/node/entry"
import { children, createPlaces, type Id, type Path, type Places } from "@ermine/core/places"
import { place } from "./names.ts"
import { getStatus } from "./process.ts"
import { enterScheduler, leaveScheduler, registerScheduler, registerScope } from "./registry.ts"
import { isHandle, mint } from "./handles.ts"
import { createChangeHeader, NODE } from "@ermine/core/places/header"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import { createStatus, STATUS, TABLE as STATUS_TABLE } from "@ermine/core/places/status"
import type { Policy } from "@ermine/core/protect"
import { PROCESS, processes as rows } from "@ermine/processes"
import { createRuns, type Run } from "@ermine/processes/runs"
import { createScopeNodes } from "@ermine/processes/scopes"
import {
	createProcesses,
	FILES as START_FILES,
	pathsOf,
	type Process,
	type Processes,
	processIds,
	type Refused,
} from "@ermine/processes/start"
import {
	createScheduler,
	FILES as SCHEDULER_FILES,
	type Info,
	PENDING,
	type Scheduler,
	type Scope,
} from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createSites } from "@ermine/sites"
import { createTable, type Key, type Table } from "@ermine/core/table"
import { type Call, createCalls, type Wait } from "./calls.ts"
import {
	type Ahead,
	type Asked,
	type Calling,
	chain,
	ErmineError,
	type Feature,
	type IdKind,
	install,
	layer,
	type Reading,
	type Recorded,
	type Shown,
	type Trace,
} from "./features.ts"
import {
	type CreatedFunction,
	createProcessContext,
	type Inner,
	isThen,
	type Node,
	type NodeData,
	type Parts,
	type ProcessContext,
	type Version,
	whole,
	type Why,
	type Write,
} from "./context.ts"
import {
	attach,
	type Base,
	type Held,
	innerOf,
	seenIn,
	type Status,
	type System,
	WAITING,
} from "./system.ts"

export { ErmineError, FeatureError } from "./features.ts"
export type {
	Asked,
	Calling,
	Feature,
	FeatureAPI,
	Hook,
	Hooks,
	Layer,
	Reading,
	Recorded,
	Slot,
	Under,
} from "./features.ts"
export type {
	At,
	CreatedFunction,
	From,
	Node,
	NodeData,
	ProcessContext,
	Target,
	Version,
	Why,
	Write,
} from "./context.ts"
export { SCOPE, SendError, WAITING } from "./system.ts"
export type {
	Caller,
	CallView,
	ChangeView,
	Explained,
	Held,
	Item,
	RunView,
	Sent,
	Status,
	System,
	Touched,
	Waiting,
	Watched,
	Writer,
} from "./system.ts"
export type { Call, Wait } from "./calls.ts"

// the host's node's attributes
export const ARGS = "ermine.host.args"
export const MACHINE = "ermine.host.machine"
export const FEATURES = "ermine.features"

export type Options = {
	features?: readonly Feature[]
	scheduler?: Scheduler
	may?: Policy
	root?: Id
	host?: {
		at?: string | Path
		args?: readonly string[]
		machine?: unknown
		setup?: () => unknown
	}
	info?: Info
}

// a process's folder: the one it is in (its path but the last name) [chee 10-26: "im not sure if
// the cwd being a separate thing is a good idea": none given]
export type StartOptions = {
	args?: readonly string[]
	// the places the process lives in: its "/" is their root, its rows are on that root (a view of
	// this ermine's places, such as @ermine/boxes makes). none: the ermine's own
	places?: Places
}

export type Started = {
	readonly process: Process
	stop: (why?: Why) => void
	status: () => ReturnType<System["getStatus"]>
}

export type Ermine = {
	// f run in the host's scope (process 0's): @ermine/system's functions in it act as the host
	within: <T>(f: () => T) => T
	// refused: taken, and when by a stopped process whose row's removal a feature held back, which
	start: (
		fn: () => unknown,
		at: string | Path,
		options?: StartOptions,
	) => Started | (Refused & { held?: { process: Id; feature: string } })
	close: () => void
	getProcessContext: (process?: Process) => ProcessContext | undefined
	// the host's side of handles (handles.ts): one minted for node (an id, any part), as context's
	// (none: the host's); and what a handle reaches, and whose (none of this ermine's: undefined)
	handleOf: (node: NodeData) => Node
	dataOf: (x: unknown) => { node: NodeData } | undefined
	readonly scheduler: Scheduler
	readonly table: Table
	readonly places: Places
	readonly features: readonly Shown[]
	// the host's node's id
	readonly id: Id
	readonly records: {
		run: (id: Id) => Run | undefined
		call: (id: Id) => Call | undefined
		waits: () => Wait[]
	}
}

// ermine's own files: a site is the first frame outside them (and the features')
const OURS = [
	"ermine.ts",
	"context.ts",
	"calls.ts",
	"features.ts",
	"registry.ts",
	"handles.ts",
	"system.ts",
	"acting.ts",
	"nodes.ts",
	"reading.ts",
	"patching.ts",
	"explaining.ts",
	"names.ts",
	"computing.ts",
	"actions.ts",
	"process.ts",
].map((f) => new URL(`./${f}`, import.meta.url).href)

// a uuidv7 (rfc 9562): 48 bits of ms, then a 12-bit count within the ms (started random), then
// random. later ones sort after: a clock going back, or 4096 in one ms, borrows the next ms
let last = 0
let count = 0
export function uuidv7(): string {
	const now = Date.now()
	if (now > last) {
		last = now
		count = crypto.getRandomValues(new Uint16Array(1))[0] & 0x7ff
	} else if (++count > 0xfff) {
		last++
		count = 0
	}
	const b = crypto.getRandomValues(new Uint8Array(16))
	for (let i = 0; i < 6; i++) b[i] = Math.floor(last / 2 ** (8 * (5 - i))) & 0xff
	b[6] = 0x70 | (count >> 8)
	b[7] = count & 0xff
	b[8] = 0x80 | (b[8] & 0x3f)
	const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function createErmine(options: Options = {}): Ermine {
	let closed = false
	// ermine's own errors outside a function (start's, closed) through the onError hooks, as a
	// function's are (errored: made once the features are set up)
	const hinted = (e: ErmineError, fn?: string) => errored(e, fn)
	const alive = () => {
		if (closed) throw hinted(new ErmineError("closed", "ermine is closed"))
	}

	// 1. the scheduler
	const s = options.scheduler ?? createScheduler()

	// 2. sites: skipping ermine's files, the scheduler's and processes' start, and (added as the
	// features are set up: the skip list is live) every feature's files
	const ours = new Set<string>([...OURS, ...SCHEDULER_FILES, ...START_FILES])
	// the build site of the public function called innermost (enter's), if it was given one
	let built: FileLocation | undefined
	const sites = createSites(s, { ours, given: () => built })

	// 3. the table; each feature's setup; onTable's layers over it
	// made later, reached from closures made now
	// deno-lint-ignore prefer-const
	let places: Places | undefined
	// deno-lint-ignore prefer-const
	let processes: Processes | undefined
	// deno-lint-ignore prefer-const
	let first: Ahead
	// what a feature acts with in its hooks, once ermine is made
	let made:
		| {
			getProcessContext: (process?: Process) => ProcessContext | undefined
			handleOf: (node: NodeData) => Node
			dataOf: (x: unknown) => { node: NodeData } | undefined
			seen: (id: Id, context: ProcessContext) => Path | undefined
			calling: () => Calling | undefined
		}
		| undefined
	const table: Table = createTable((part, id) => first.onTableChange(part as Key, id))
	// the scheduler as features see it: a copy of its functions (a scheduler is a plain object of
	// closures: no getters, no prototype, no this), each on… wrapped by name so its off is taken out
	// at close, as ermine's own listeners are (a scheduler given in options outlives ermine)
	const listening = new Set<() => void>()
	const heard: Scheduler = { ...s }
	for (const k of Object.keys(s)) {
		const on = (s as unknown as Record<string, unknown>)[k]
		if (!/^on[A-Z]/.test(k) || typeof on !== "function") continue
		;(heard as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
			const off = (on as (...a: unknown[]) => unknown)(...a)
			if (typeof off !== "function") return off
			const once = () => {
				listening.delete(once)
				off()
			}
			listening.add(once)
			return once
		}
	}
	const features = install(options.features ?? [], {
		scheduler: heard,
		table,
		places: () => places,
		processes: () => processes,
		getProcessContext: () => made?.getProcessContext,
		handleOf: () => made?.handleOf,
		dataOf: () => made?.dataOf,
		seen: () => made?.seen,
		calling: () => made?.calling,
	})
	const { hooks } = features
	// each new id through onId: the base's a uuidv7 (a node's), proc:<boot>-<n> (a process's)
	const processId = processIds()
	const idFor = chain<[IdKind], string>(
		hooks.onId,
		"onId",
		(kind) => kind === "process" ? processId() : uuidv7(),
	)
	const newId = () => idFor("node")
	// what a write outside a run keeps, through onTrace: the base's its site only
	const traced = chain<[Trace], Trace>(hooks.onTrace, "onTrace", (t) => t)
	// each error ermine throws through onError: the base's as it is
	const errored = chain<[unknown, string | undefined], unknown>(hooks.onError, "onError", (e) => e)
	const toPlaces: Ahead = {
		onTableChange: (part, id) => places!.onTableChange(part, id),
		commit: (changed) => places!.commit(changed),
	}
	const layered = layer(hooks.onTable, table, () => toPlaces)
	first = layered.first
	const commit = (changed: Parameters<Places["commit"]>[0]) => first.commit(changed)

	for (const f of features.files) ours.add(f)

	// 4. places over the front
	const root = options.root ?? newId()
	places = createPlaces({
		root,
		table: layered.front as Table,
		paths: createPaths<unknown>(),
		scheduler: s,
		contributors: [rows(root), children],
	})
	const offRelease = s.onTrackingEnd((key) => places!.release(key))
	const p = places

	// 5. the root node and the host's node, written as the host
	const node = newId()
	const hostScope = s.createRootScope({ ...options.info, [NODE]: node })

	// pulses: one soon, however many ask
	let queued = false
	// a pulse asked for through onSchedule: the base's in a microtask
	const schedule = chain<[() => void], void>(hooks.onSchedule, "onSchedule", queueMicrotask)
	function queuePulse() {
		if (queued || closed) return
		queued = true
		schedule(() => {
			queued = false
			if (closed) return
			enterScheduler(s)
			try {
				base.pulse()
			} finally {
				leaveScheduler()
			}
		})
	}
	const offSettle = s.onSettle(queuePulse)

	// a write's site: in a run, the running computer's own; outside one, a build site given (built),
	// nothing captured, else the caller of the public function called innermost (entry), found in
	// the nearest 10 frames. what onTrace gives: the whole trace text kept beside it too (text)
	let entry: unknown
	const header = (): ChangeHeader => {
		const run = s.getRun()
		if (run !== undefined) {
			return createChangeHeader(s, undefined, undefined, undefined, sites.siteOf(run.computer))
		}
		const t = traced({ text: false, ...built !== undefined && { built } })
		if (t.built !== undefined && !t.text) {
			return createChangeHeader(s, undefined, undefined, undefined, t.built)
		}
		const h = createChangeHeader(s, undefined, ours, entry, undefined, t.text)
		if (t.built !== undefined) h.external = [t.built]
		return h
	}
	// f(inner, ...a) with enter as the entry: a write's site is found from enter's caller on, or is
	// site, a build's
	function enter<A extends unknown[], T>(
		f: (inner: Inner, ...a: A) => T,
		inner: Inner,
		a: A,
		site?: FileLocation,
	): T {
		const was = entry
		const had = built
		entry = enter
		built = site
		try {
			return f(inner, ...a)
		} finally {
			entry = was
			built = had
		}
	}
	const entered = <F extends (...args: never[]) => unknown>(f: F): F => {
		const g = function (this: unknown, ...args: unknown[]) {
			const was = entry
			const had = built
			entry = g
			built = undefined
			try {
				return (f as unknown as (...a: unknown[]) => unknown).apply(this, args)
			} finally {
				entry = was
				built = had
			}
		}
		return g as unknown as F
	}

	// the hooks: onWrite around each write, onRead around reads' items, onTeardown around each
	// teardown, onRecord around each record held
	// writes held back: the latest held at each (part, id), by the hook that didn't call next (the
	// innermost one called); gone once a write there lands, or once its node goes holding nothing
	// there (dropHeld). tracked by one key
	let deepest: string | undefined
	const heldWrites = new Map<Id, Map<Key, { feature: string; write: Write }>>()
	const heldKey = {}
	const heldOf = (part: Key, id: Id) => heldWrites.get(id)?.get(part)
	const unhold = (part: Key, id: Id) => {
		const at = heldWrites.get(id)
		if (at === undefined || !at.delete(part)) return false
		if (at.size === 0) heldWrites.delete(id)
		return true
	}
	// a node gone (a memo not made again, a node removed, a process stopped): what was held at a
	// part of it holding nothing goes too. a part still there (its removal held) keeps its own
	const dropHeld = (id: Id) => {
		const at = heldWrites.get(id)
		if (at === undefined) return
		let told = false
		for (const part of [...at.keys()]) {
			if (table.get(part, id) === undefined) told = unhold(part, id) || told
		}
		if (told) s.mark([heldKey])
	}
	// the write held at (part, id), tracked; none: undefined
	const heldAt = (part: Key, id: Id) => {
		s.track(heldKey)
		const h = heldOf(part, id)
		return h === undefined ? undefined : { feature: h.feature }
	}
	// a held write at a node's status (its own table): { feature, write: "status" }
	const statusHeld = (id: Id): Held | undefined => {
		const h = heldOf(STATUS_TABLE, id)
		if (h === undefined) return undefined
		const touches = h.write.gone || h.write.patches.some((p) =>
			p.path[0] === STATUS ||
			(p.path.length === 0 && typeof p.value === "object" && p.value !== null &&
				STATUS in p.value)
		)
		return touches ? { feature: h.feature, write: "status" } : undefined
	}
	// stopped processes whose row's removal a feature held: by the process's node, its root and path
	// (kept while the row is: read through rowHeld, which lets an entry go once its row has)
	const heldRows = new Map<Id, { feature: string; root: Id; at: Path }>()
	// the id the row at at under root holds; none: undefined
	const rowAt = (root: Id, at: Path): unknown => {
		let v: unknown = table.get(PROCESS, root)?.value
		for (const name of at) {
			v = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[name] : undefined
		}
		return v
	}
	// a stopped process's held row, as it is now: its row gone (a later write took it out), the
	// entry goes and nothing is said (show what's true now)
	const rowHeld = (id: Id) => {
		const r = heldRows.get(id)
		if (r === undefined) return undefined
		if (rowAt(r.root, r.at) === id) return r
		heldRows.delete(id)
		return undefined
	}
	const written = chain<[ProcessContext, Write, (w: Write) => void], void>(
		hooks.onWrite.map((h) => ({
			feature: h.feature,
			fn: (
				o: ProcessContext,
				w: Write,
				_land: unknown,
				next: (o: ProcessContext, w: Write) => void,
			) => {
				deepest = h.feature
				return h.fn(o, w, next)
			},
		})),
		"onWrite",
		(_o, w, land) => land(w),
		// a write a hook changed: the base's own fields from what that hook was given, its name added
		(feature, [, w, land], [o2, w2]) => {
			if (w2 === w) return [o2 as ProcessContext, w, land]
			const { features: _, ...rest } = w2 as Write
			const tagged: Write = {
				...rest,
				features: [...w.features ?? [], feature],
			}
			return [o2 as ProcessContext, tagged, land]
		},
	)
	// the open call's caller (the nearest call scope's), as a place: a process's at, a computer's its
	// process's, the host none; no call open: undefined [chee 10-25: "so it should run as both"]
	const caller = (): { from?: Path } | undefined => {
		for (let o = s.getCurrentScope(); o !== undefined; o = o.parent) {
			if (o.info.call === undefined || o.info.handler === undefined) continue
			const by = (o.info.caller as { node?: Id } | undefined)?.node
			if (by === undefined || by === node) return {}
			const ctx = contexts.get(by) ?? computerContexts.get(by)
			return ctx?.context.process === undefined ? {} : { from: ctx.context.at }
		}
		return undefined
	}
	const parts: Parts = {
		scheduler: s,
		table,
		commit,
		may: options.may,
		caller,
		header,
		put: (o, w, land) => {
			const was = deepest
			deepest = undefined
			let landed = false
			written(o, w, (x) => {
				landed = true
				let told = unhold(x.part, x.id)
				// a write at a root a held row is under: whoever read that row's status is told
				if (!told && x.part === PROCESS) {
					for (const r of heldRows.values()) if (r.root === x.id) told = true
				}
				// marked before it lands: a mark only schedules the rerun, which reads after
				if (told) s.mark([heldKey])
				land(x)
			})
			const by = deepest
			deepest = was
			if (!landed && by !== undefined) {
				let at = heldWrites.get(w.id)
				if (at === undefined) heldWrites.set(w.id, at = new Map())
				at.set(w.part, { feature: by, write: w })
				s.mark([heldKey])
			}
		},
		queuePulse,
		onCreateFunction: chain<[CreatedFunction], void>(
			hooks.onCreateFunction,
			"onCreateFunction",
			() => {},
		),
		alive,
	}
	const tag = (feature: string, item: Version): Version =>
		item.from.feature !== undefined ? item : { ...item, from: { ...item.from, feature } }
	const fresh = (feature: string, before: readonly Version[], after: readonly Version[]) => {
		const had = new Set(before)
		return after.map((i) => had.has(i) ? i : tag(feature, i))
	}
	const shown = chain<[Reading, readonly Version[]], readonly Version[]>(
		hooks.onRead,
		"onRead",
		(_x, items) => items,
		(
			feature,
			[, items],
			[x2, items2],
		) => [x2 as never, fresh(feature, items, items2 as Version[])],
		(feature, [, items], inner, out) => fresh(feature, inner ?? items, out),
	)
	const torn = chain<[Scope, Why, (why: Why) => unknown], void>(
		hooks.onTeardown.map((h) => ({
			feature: h.feature,
			fn: (sc: Scope, why: Why, _fn: unknown, next: (sc: Scope, why: Why) => void) =>
				h.fn(sc, why, next),
		})),
		"onTeardown",
		(_sc, why, fn) => void fn(why),
		(_f, [, , fn], [sc, why]) => [sc as Scope, why as Why, fn],
	)
	const statused = chain<[Asked, Status], Status>(
		hooks.onStatus,
		"onStatus",
		(_x, st) => st,
	)
	const recorded = chain<[Recorded, (r: Recorded) => void], void>(
		hooks.onRecord.map((h) => ({
			feature: h.feature,
			fn: (r: Recorded, _keep: unknown, next: (r: Recorded) => void) => h.fn(r, next),
		})),
		"onRecord",
		(r, keep) => keep(r),
		(_f, [, keep], [r]) => [r as Recorded, keep],
	)

	// the host's context (made before what writes as the host: rows, scope nodes, the boot)
	const hostInner = createProcessContext(parts, {
		scope: hostScope,
		places: p,
		folder: [],
		at: [],
		args: options.host?.args ?? [],
		node,
	})
	// the root node and the host's node, written as the host (through onWrite)
	hostInner.context.within(() => {
		hostInner.put({ part: "children", id: root, patches: [{ path: [], value: {} }] })
		const attrs: Record<string, unknown> = {
			[ARGS]: options.host?.args ?? [],
			[FEATURES]: features.shown,
		}
		if (options.host?.machine !== undefined) attrs[MACHINE] = options.host.machine
		hostInner.put({ part: "attributes", id: node, patches: [{ path: [], value: attrs }] })
	})

	// 6. scope nodes, processes, statuses, records: every write of theirs through onWrite, as
	// the host's (rows, start's attributes, scope nodes going) or as the context that made the
	// computer (its status)
	const computerContexts = new Map<Id, Inner>()
	const scopes = createScopeNodes({
		scheduler: s,
		table: {
			get: table.get,
			del: ((part: Key, id: Id) =>
				hostInner.put({ part, id, patches: [], gone: true })) as never,
		},
	})
	const owner = s.createScope({ processes: "start" }, hostScope)
	processes = createProcesses({
		scheduler: s,
		table,
		places: { commit },
		scopes,
		sites,
		owner,
		ours,
		write: hostInner.writer,
		id: () => idFor("process"),
	})
	const statuses = createStatus({
		places: { commit },
		table,
		scheduler: s,
		write: (part, id, patches, header) =>
			(computerContexts.get(id) ?? hostInner).writer(part, id, patches, header),
	})
	const runs = createRuns({
		places: { describe: p.describe, watchAll: p.watchAll },
		table,
		scheduler: s,
		// a run whose status write was held back: its record says so, naming the feature
		hold: (id, run, keep) => {
			const h = statusHeld(id)
			recorded({ id, run: h === undefined ? run : { ...run, held: h } as Run }, (r) => {
				if (r.run !== undefined) keep(r.run)
			})
		},
	})
	const calls = createCalls({
		scheduler: s,
		places: p,
		table,
		hold: (id, call, keep) =>
			recorded({ id, call }, (r) => {
				if (r.call !== undefined) keep(r.call)
			}),
	})
	// each process's node: where it runs (system.ts seenIn)
	const running = new Map<Id, Path>()
	const whys = new Map<Id, Why>()
	const base: Base = {
		parts,
		sited: sites,
		statuses,
		runs,
		calls,
		memos: new Set(),
		computers: new Set(),
		contexts: computerContexts,
		awaiting: new Set(),
		missing: new Map(),
		setting: new Set(),
		pipes: new Set(),
		piped: [],
		pipeDepth: 0,
		// what pipes heard told (those heard while telling: at the pulse after), then the pulse
		pulse: () => {
			const now = base.piped.splice(0)
			for (const tell of now) tell()
			s.pulse()
		},
		methods: new Map(),
		whys,
		// set once start's stop is made (below)
		stop: () => {},
		start: () => {
			throw new ErmineError("closed", "not started")
		},
		newId,
		errored,
		handles: new WeakMap(),
		writers: new WeakMap(),
		running,
		views: new WeakMap(),
		changes: new WeakMap(),
		entered,
		enter,
		shown,
		torn,
		statused,
		held: {
			at: heldAt,
			status: (id) => {
				s.track(heldKey)
				return statusHeld(id)
			},
			row: (id) => {
				s.track(heldKey)
				const r = rowHeld(id)
				return r === undefined ? undefined : { feature: r.feature, write: "row" }
			},
			drop: dropHeld,
		},
	}

	// each running process's context, by its node's id
	const contexts = new Map<Id, Inner>()
	attach(base, hostInner)
	// @ermine/system's functions find the host's context by its scope, a process's by its
	const unregister = registerScheduler(s, hooks.onError.length ? errored : undefined)
	try {
		registerScope(hostScope, hostInner)
		features.done()

		// the host's node placed where the host says
		if (options.host?.at !== undefined) {
			const at = options.host.at
			hostInner.context.within(() => place(at, mint(base.handles, { id: node, part: "value" })))
		}

		// the processes ermine started, oldest first
		const started: Process[] = []

		function stop(process: Process, why: Why = "ended") {
			whys.set(process.id, why)
			try {
				processes!.stop(process)
			} finally {
				whys.delete(process.id)
				dropHeld(process.id)
				const i = started.indexOf(process)
				if (i !== -1) started.splice(i, 1)
			}
			// its row still there: its removal was held back, and the path says so [chee: "Held, and shown"]
			const h = heldOf(PROCESS, root)
			if (rowAt(root, process.at) === process.id && h !== undefined) {
				heldRows.set(process.id, { feature: h.feature, root, at: process.at })
				s.mark([heldKey])
			}
		}

		// a process a program started: under the scope that started it
		base.start = (fn, at, o, under) => start(fn, at, o, under)

		// a running process stopped by its node (unplace, remove: system.ts)
		base.stop = (id) => {
			const process = started.find((p) => p.id === id)
			if (process !== undefined) stop(process)
		}

		function start(
			fn: () => unknown,
			at: string | Path,
			o: StartOptions = {},
			under?: Scope,
		): Started | (Refused & { held?: { process: Id; feature: string } }) {
			alive()
			if (typeof fn !== "function") {
				throw hinted(
					new ErmineError("not-a-function", "start takes the program: its function"),
					"start",
				)
			}
			const paths = pathsOf(at)
			const here = o.places ?? p
			enterScheduler(s)
			let made: ReturnType<Processes["start"]>
			try {
				made = processes!.start(
					here,
					paths.at,
					{ args: o.args, folder: paths.folder, ...under !== undefined && { under } },
					(inside) => {
						const pid = inside.id
						const inner = createProcessContext(parts, {
							scope: inside.scope,
							places: here,
							folder: inside.folder,
							at: inside.at,
							args: inside.args,
							process: {
								id: pid,
								at: inside.at,
								folder: inside.folder,
								scope: inside.scope,
							},
							node: pid,
						})
						contexts.set(pid, inner)
						// its node's place, for seen (its rows name it: no children entry has it)
						running.set(pid, inside.at)
						// its context, found by its scope (system.ts): no api object [chee 10-25: ">Drop the
						// objects. ye"]; setup is given nothing [chee 10-25: "we are getting rid of setup(api)
						// right?"]
						attach(base, inner)
						registerScope(inside.scope, inner)
						s.registerTeardown(inside.scope, () => {
							contexts.delete(pid)
							running.delete(pid)
						})
						// the process's status and value, written as it settles (its status in the status table)
						const attrs = (patches: Write["patches"]) =>
							inner.put({ part: STATUS_TABLE, id: pid, patches })
						const done = (v: unknown) => {
							if (inside.scope.state !== "alive") return
							// the base's own writes for the process: its scope opened (a promise settles with nothing open)
							s.runWithScope(inside.scope, () => {
								if (v !== undefined) {
									inner.put({ part: "value", id: pid, patches: whole(v) })
								}
								attrs([{ path: [STATUS] }, { path: [WAITING] }])
							})
							queuePulse()
						}
						const failed = (e: unknown) => {
							if (inside.scope.state !== "alive") return
							const error = e === undefined ? new Error("undefined") : e
							s.runWithScope(
								inside.scope,
								() => attrs([{ path: [STATUS], value: error }, { path: [WAITING] }]),
							)
							queuePulse()
						}
						// setup run once, given nothing (its functions imported), untracked, in a scope of its own
						// under the process's
						// [chee 10-25: "setup is untracked, runs once. like solid."]. throwing PENDING (a send to
						// nothing, a node not there): the process pending, what it waited on in its status; setup
						// is not run again (read or send in a memo or effect to wait)
						const run = (setup: () => unknown) => {
							// its info the process's own key again (a scope's info has keys): a write's metadata
							// the same as from the process's scope
							const at = s.createScope({ process: inside.at }, inside.scope)
							let out: unknown
							// the nodes it reads that aren't there, kept while it runs (system.ts waitFor)
							base.setting.add(pid)
							const missed = () => {
								base.setting.delete(pid)
								const paths = base.missing.get(pid)?.paths ?? []
								base.missing.delete(pid)
								return paths
							}
							try {
								out = s.runWithScope(at, () => setup())
							} catch (e) {
								const paths = missed()
								if (e !== PENDING) return failed(e)
								const ws = calls.waits(pid)
								const waits: unknown[] = ws.map((w) => ({
									send: w.path ?? w.id,
									since: w.since,
								}))
								// the nodes it read that weren't there (paths from the root, shown as each sees them)
								for (const p of paths) waits.push({ missing: p })
								attrs([{ path: [WAITING], value: waits.length ? waits : ["PENDING"] }])
								return
							}
							missed()
							if (!isThen(out)) return done(out)
							attrs([{ path: [WAITING], value: ["a promise"] }])
							out.then(done, failed)
						}
						run(fn)
					},
				)
			} finally {
				leaveScheduler()
			}
			if ("refused" in made) {
				// taken by a stopped process whose row a feature held: said, naming both
				const under = (a: Path, b: Path) => a.every((n, i) => b[i] === n)
				for (const process of [...heldRows.keys()]) {
					const r = rowHeld(process)
					if (r === undefined) continue
					if (!(under(r.at, made.at) || under(made.at, r.at))) continue
					return { ...made, held: { process, feature: r.feature } }
				}
				return made
			}
			started.push(made)
			// stopped from above (the scope it was started under going): out of the list
			s.registerTeardown(made.scope, () => {
				const i = started.indexOf(made)
				if (i !== -1) started.splice(i, 1)
			})
			return {
				process: made,
				stop: (why?: Why) => {
					enterScheduler(s)
					try {
						stop(made, why)
					} finally {
						leaveScheduler()
					}
				},
				status: () =>
					hostInner.context.within(() =>
						getStatus(mint(base.handles, { id: made.id, part: "value" }))
					),
			}
		}

		// every step runs, whatever an earlier one threw; the first error is thrown at the end
		function close() {
			if (closed) return
			let first: { e: unknown } | undefined
			const step = (f: () => void) => {
				try {
					f()
				} catch (e) {
					first ??= { e }
				}
			}
			enterScheduler(s)
			try {
				for (const p of [...started].reverse()) step(() => stop(p, "ended"))
				step(() => s.teardown(hostScope))
			} finally {
				leaveScheduler()
			}
			step(() => statuses.stop())
			step(() => runs.stop())
			step(() => calls.stop())
			step(offSettle)
			step(offRelease)
			for (const off of [...listening]) step(off)
			step(unregister)
			closed = true
			if (first) throw first.e
		}

		const part = <T>(v: T) => () => {
			alive()
			return v
		}
		const ermine = Object.defineProperties({}, {
			within: { value: <T>(f: () => T): T => hostInner.context.within(f) },
			start: {
				value: (fn: () => unknown, at: string | Path, o?: StartOptions) => start(fn, at, o),
			},
			close: { value: close },
			getProcessContext: {
				value: (process?: Process): ProcessContext | undefined => {
					alive()
					return process === undefined ? hostInner.context : contexts.get(process.id)?.context
				},
			},
			scheduler: { get: part(s) },
			table: { get: part(table) },
			places: { get: part(p) },
			features: { get: part(features.shown) },
			id: { get: part(node) },
			handleOf: {
				value: (node: NodeData): Node => {
					alive()
					return mint(base.handles, node)
				},
			},
			dataOf: {
				value: (x: unknown) => {
					alive()
					const d = isHandle(x) ? base.handles.get(x) : undefined
					return d === undefined ? undefined : { node: d.node }
				},
			},
			records: {
				value: {
					run: (id: Id) => (alive(), runs.read(id)),
					call: (id: Id) => (alive(), calls.latest(id)),
					waits: () => (alive(), calls.waits()),
				},
			},
		}) as unknown as Ermine
		made = {
			getProcessContext: (process) => ermine.getProcessContext(process),
			handleOf: (node) => ermine.handleOf(node),
			dataOf: (x) => ermine.dataOf(x),
			seen: (id, context) => {
				const inner = innerOf(context, base)
				return inner === undefined ? undefined : seenIn(base, inner, id)
			},
			calling: () => {
				alive()
				return calls.calling(s.getCurrentScope())
			},
		}
		// the host's setup: run once, untracked, in the host's scope; a throw closes ermine and is
		// thrown here (no process status to show it in), what it returns not kept
		const setup = options.host?.setup
		if (setup !== undefined) {
			try {
				hostInner.context.within(setup)
			} catch (e) {
				close()
				throw e
			}
		}
		return ermine
	} catch (e) {
		// a throw after the registration: undone, as the C's abandon does
		unregister()
		throw e
	}
}
