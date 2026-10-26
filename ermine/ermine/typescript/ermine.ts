// ermine: what a host makes, once. the host's handle, and the host's words on it
//
//   import { createErmine } from "@ermine/ermine"
//   import patches from "@ermine/patchy/feature"
//
//   const ermine = createErmine({ features: [patches], host: { at: "/host", args } })
//   ermine.open("/code/clock", clock)                     // the host's words, on ermine
//   const running = ermine.start("/code/clock", { cwd: "/work" })   // { process, stop(), status() }
//   running.status()                                       // a setup that threw shows here
//   ermine.close()                                         // every process, then the host's
//
// options, each with a default:
//   features   none (features.ts)
//   scheduler  a new one
//   id         a new node's id, processes' too; none: uuidv7 (nodes), proc:<boot>-<n> (processes)
//   may        the policy every read and write is asked of; none: all allowed
//   schedule   how a pulse is asked for: f run soon, once; none: a microtask
//   onCreateFunction
//              told of each memo, effect and method made, for an inspector
//   root       the root's id; none: a new one
//   host       the host's node: where it is placed (none: nowhere, reached by ermine.node), the
//              host's args, the machine it publishes
//   info       the host's scope's info (actor, …), beside its node
//   calls      sends' records held: "latest" per handler (none), or "never" (onRecord still told)
// made inside, in order: the scheduler; sites (skipping ermine's files and every feature's files,
// a live list); the table, each feature's setup, then onTable's layers; places over the front layer, with
// processes' rows, released at each tracking end; the root node and the host's node, written as
// the host; scope nodes, processes, statuses, runs and calls; the host's context (context.ts): the
// host's scope at the root, no process.
// the host's words: a process's (words.ts), from the host's context: bare names in the root, cwd
// the root, args the host's, a send's caller the host's node, teardown(fn) at close. each opens
// the host's scope when nothing is open.
// the host's node: one plain node, not a process (no row, nothing to stop). its id: a send's
// caller from the host, and its scope's NODE. its attributes: ermine.host.args,
// ermine.host.machine, ermine.features (what ermine.features shows).
// the lifecycle:
//   start(at, { args, cwd, box })   a process at at (in box, none: the root) running the function
//                        the node at at holds, its setup, given its api, the process's scope open.
//                        → { process, stop(why?), status() }, or { refused: "taken", at }. what
//                        setup returns: the process's value (a promise: pending till it settles);
//                        setup throwing: its error in status(process), the process still there;
//                        throwing PENDING (a send to nothing): pending, what it waits on in
//                        ermine.process.waiting; setup is untracked and runs once, never again
//                        [chee 10-25: "like solid"]. no function there: pending,
//                        waiting { code: at }, till the saved node there holds one; then that
//                        runs, once
//   close()              every process ermine started stopped ("ended"), newest first, then the
//                        host's scope, then ermine's own listeners and what features listen to
//                        on the scheduler. its words and parts (records, calling, node too) throw
//                        closed after
// calling(): the send being answered now, its record so far, with the caller's context.
// api(context): a process's api from a process context; getProcessContext(process?): a running
// process's process context
// (none: the host's). scheduler, table, places, processes: the whole thing, for the host and
// features. features: each one's name, needs and hooks, in chain order. records: run(id) a
// computer's latest run, call(id) a handler's latest send, waits() every send waiting; tracked.
import type { ChangeHeader } from "@ermine/core/node/entry"
import type { Box, Host } from "@ermine/boxes"
import { children, createPlaces, type Id, type Path, type Places } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { registerMakers, registerScheduler, registerScope } from "./registry.ts"
import { isHandle, mint } from "./handles.ts"
import { createChangeHeader, NODE } from "@ermine/places/header"
import { createStatus, STATUS, TABLE as STATUS_TABLE } from "@ermine/places/status"
import type { Policy } from "@ermine/protect"
import { PROCESS, processes as rows } from "@ermine/processes"
import { createRuns, type Run } from "@ermine/processes/runs"
import { createScopeNodes } from "@ermine/processes/scopes"
import {
	createProcesses,
	pathsOf,
	type Process,
	type Processes,
	type Refused,
} from "@ermine/processes/start"
import {
	createScheduler,
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
	chain,
	ErmineError,
	type Feature,
	install,
	layer,
	type Reading,
	type Recorded,
	type Shown,
} from "./features.ts"
import {
	type CreatedFunction,
	createProcessContext,
	type Inner,
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
	type API,
	type Base,
	type BoxNode,
	createWords,
	type Held,
	type HostAPI,
	seenIn,
	type Status,
	WAITING,
} from "./words.ts"

export { ErmineError, FeatureError } from "./features.ts"
export type {
	Asked,
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
	Change,
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
export { SCOPE, SendError, WAITING } from "./words.ts"
export type {
	API,
	BoxNode,
	Caller,
	CallView,
	ChangeView,
	Explained,
	Held,
	HostAPI,
	Item,
	RunView,
	Sent,
	Status,
	Touched,
	Waiting,
	Watched,
	Writer,
} from "./words.ts"
export type { Call, Wait } from "./calls.ts"

// the host's node's attributes
export const ARGS = "ermine.host.args"
export const MACHINE = "ermine.host.machine"
export const FEATURES = "ermine.features"

export type Options = {
	features?: readonly Feature[]
	scheduler?: Scheduler
	id?: () => string
	may?: Policy
	schedule?: (f: () => void) => void
	onCreateFunction?: (made: CreatedFunction) => void
	root?: Id
	host?: { at?: string | Path; args?: readonly string[]; machine?: unknown }
	info?: Info
	calls?: "latest" | "never"
}

export type StartOptions = {
	args?: readonly string[]
	cwd?: string | Path
	// a box: box(at)'s handle, or one made with @ermine/boxes
	box?: Box | BoxNode
}

export type Started = {
	readonly process: Process
	stop: (why?: Why) => void
	status: () => ReturnType<API["status"]>
}

export type Ermine = HostAPI & {
	// refused: taken, and when by a stopped process whose row's removal a feature held back, which
	start: (
		at: string | Path,
		options?: StartOptions,
	) => Started | (Refused & { held?: { process: Id; feature: string } })
	close: () => void
	api: (context: ProcessContext) => API
	getProcessContext: (process?: Process) => ProcessContext | undefined
	// the host's side of handles (handles.ts): one minted for node (an id, any part), as context's
	// (none: the host's); and what a handle reaches, and whose (none of this ermine's: undefined)
	handleOf: (node: NodeData, context?: ProcessContext) => Node
	dataOf: (x: unknown) => { node: NodeData; context: ProcessContext } | undefined
	readonly scheduler: Scheduler
	readonly table: Table
	readonly places: Places
	readonly processes: Processes
	readonly features: readonly Shown[]
	// the host's node's id
	readonly node: Id
	// the send being answered where the code runs now (the scope open, or one above it): its record
	// so far, the caller's context in it; none: undefined. for a service acting for its caller: the
	// host's and features' side only, never a program's
	calling: () => Omit<Call, "end" | "reads" | "writes" | "made" | "ended"> | undefined
	readonly records: {
		run: (id: Id) => Run | undefined
		call: (id: Id) => Call | undefined
		waits: () => Wait[]
	}
}

// ermine's own files: a site is the first frame outside them (and the features')
const OURS = [
	"ermine.ts",
	"words.ts",
	"context.ts",
	"calls.ts",
	"features.ts",
	"found.ts",
	"registry.ts",
	"handles.ts",
	"system.ts",
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

const isThen = (v: unknown): v is PromiseLike<unknown> =>
	(typeof v === "object" || typeof v === "function") && v !== null &&
	typeof (v as PromiseLike<unknown>).then === "function"

export function createErmine(options: Options = {}): Ermine {
	let closed = false
	const alive = () => {
		if (closed) throw new ErmineError("closed", "ermine is closed")
	}

	// 1. the scheduler
	const s = options.scheduler ?? createScheduler()
	const newId = options.id ?? uuidv7

	// 2. sites: skipping ermine's files, the scheduler's and processes' start, and (added as the
	// features are set up: the skip list is live) every feature's files
	const ours = new Set<string>([
		...OURS,
		import.meta.resolve("@ermine/core/scheduler"),
		import.meta.resolve("@ermine/processes/start"),
	])
	const sites = createSites(s, { ours })

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
			api: (context: ProcessContext) => API
			handleOf: (node: NodeData, context?: ProcessContext) => Node
			dataOf: (x: unknown) => { node: NodeData; context: ProcessContext } | undefined
			seen: (id: Id, context: ProcessContext) => Path | undefined
		}
		| undefined
	const table: Table = createTable((part, id) => first.onTableChange(part as Key, id))
	// the scheduler as features see it: what they listen to on it (each on…'s off) taken out at
	// close, as ermine's own listeners are (a scheduler given in options outlives ermine)
	const listening = new Set<() => void>()
	const heard = new Proxy(s, {
		get(t, k) {
			const v = Reflect.get(t, k)
			if (typeof k !== "string" || !/^on[A-Z]/.test(k) || typeof v !== "function") return v
			return (...a: unknown[]) => {
				const off = (v as (...a: unknown[]) => unknown)(...a)
				if (typeof off !== "function") return off
				const once = () => {
					listening.delete(once)
					off()
				}
				listening.add(once)
				return once
			}
		},
	})
	const features = install(options.features ?? [], {
		scheduler: heard,
		table,
		places: () => places,
		processes: () => processes,
		getProcessContext: () => made?.getProcessContext,
		handleOf: () => made?.handleOf,
		dataOf: () => made?.dataOf,
		seen: () => made?.seen,
		api: () => made?.api,
	})
	const { hooks } = features
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
	const schedule = options.schedule ?? queueMicrotask
	function queuePulse() {
		if (queued || closed) return
		queued = true
		schedule(() => {
			queued = false
			if (!closed) s.pulse()
		})
	}
	const offSettle = s.onSettle(queuePulse)

	// a write's site: outside a run, the caller of the public word called innermost (entry); in a
	// run, the running computer's own
	let entry: unknown
	const header = (): ChangeHeader => {
		const run = s.getRun()
		return run === undefined
			? createChangeHeader(s, undefined, ours, entry)
			: createChangeHeader(s, undefined, undefined, undefined, sites.siteOf(run.computer))
	}
	const entered = <F extends (...args: never[]) => unknown>(f: F): F => {
		const g = function (this: unknown, ...args: unknown[]) {
			const was = entry
			entry = g
			try {
				return (f as unknown as (...a: unknown[]) => unknown).apply(this, args)
			} finally {
				entry = was
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
	const parts: Parts = {
		scheduler: s,
		table,
		commit,
		may: options.may,
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
		onCreateFunction: options.onCreateFunction,
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
	const rootBox: Box = { root, places: p }
	const hostInner = createProcessContext(parts, {
		scope: hostScope,
		box: rootBox,
		cwd: [],
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
		...options.id !== undefined && { id: options.id },
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
		keep: options.calls !== "never",
		hold: (id, call, keep) =>
			recorded({ id, call }, (r) => {
				if (r.call !== undefined) keep(r.call)
			}),
	})
	const host: Host = { places: p, table, scheduler: s, commit }
	// each process's node: its box's folder and where it runs (words.ts seenIn)
	const running = new Map<Id, { box: Id; at: Path }>()
	const boxes = new WeakMap<BoxNode, Box>()
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
		methods: new Map(),
		whys,
		newId,
		handles: new WeakMap(),
		words: new WeakMap(),
		running,
		views: new WeakMap(),
		changes: new WeakMap(),
		host,
		boxes,
		entered,
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

	const inners = new WeakMap<ProcessContext, Inner>([[hostInner.context, hostInner]])
	// each running process's context, by its node's id
	const contexts = new Map<Id, Inner>()
	const words = createWords(base, hostInner)
	// the imported words (found.ts) find the host's by its scope, a process's by its
	const unregister = registerScheduler(s)
	// a handle of this ermine's used with nothing open: its maker, its scope opened (registry.ts)
	const unmakers = registerMakers((x) => {
		const d = isHandle(x) ? base.handles.get(x) : undefined
		const words = d === undefined ? undefined : base.words.get(d.maker)
		return words === undefined ? undefined : { words, within: d!.maker.context.within }
	})
	registerScope(hostScope, words)
	features.done()

	// the host's node placed where the host says
	if (options.host?.at !== undefined) {
		words.place(options.host.at, mint(base.handles, { id: node, part: "value" }, hostInner))
	}

	// the processes ermine started, oldest first, and each one's box's root
	const started: Process[] = []
	const roots = new Map<Id, Id>()

	function stop(process: Process, why: Why = "ended") {
		whys.set(process.id, why)
		const root = roots.get(process.id) ?? rootBox.root
		try {
			processes!.stop(process)
		} finally {
			whys.delete(process.id)
			roots.delete(process.id)
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

	function start(
		at: string | Path,
		o: StartOptions = {},
	): Started | (Refused & { held?: { process: Id; feature: string } }) {
		alive()
		const given = o.box === undefined ? undefined : boxes.get(o.box as BoxNode) ?? o.box
		if (given !== undefined && !("places" in given)) {
			throw new ErmineError("not-yet", "a box this ermine did not make")
		}
		const box = (given as Box | undefined) ?? rootBox
		const paths = pathsOf(at, o.cwd)
		const id = get(box.places, paths.at)
		const code = id === undefined ? undefined : table.get("value", id)?.value
		const made = processes!.start(box, paths.at, { args: o.args, cwd: paths.cwd }, (inside) => {
			const pid = inside.id
			const inner = createProcessContext(parts, {
				scope: inside.scope,
				box,
				cwd: inside.cwd,
				at: inside.at,
				args: inside.args,
				process: { id: pid, at: inside.at, cwd: inside.cwd, scope: inside.scope },
				node: pid,
			})
			inners.set(inner.context, inner)
			contexts.set(pid, inner)
			// its node's place, for seen (its rows name it: no children entry has it)
			running.set(pid, { box: box.root, at: inside.at })
			// its words, made once: found by its scope (found.ts); setup is given nothing [chee 10-25: "we
			// are getting rid of setup(api) right?"]
			const { remove: _, ...own } = createWords(base, inner)
			registerScope(inside.scope, own)
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
					if (v !== undefined) inner.put({ part: "value", id: pid, patches: whole(v) })
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
				try {
					out = s.runWithScope(at, () => setup())
				} catch (e) {
					if (e !== PENDING) return failed(e)
					const ws = calls.waits(pid)
					const waits = ws.map((w) => ({ send: w.path ?? w.id, box: w.box, since: w.since }))
					attrs([{ path: [WAITING], value: waits.length ? waits : ["PENDING"] }])
					return
				}
				if (!isThen(out)) return done(out)
				attrs([{ path: [WAITING], value: ["a promise"] }])
				out.then(done, failed)
			}
			if (typeof code === "function") return run(code as () => unknown)
			// no code there yet: pending, waiting on the path. the saved node there (the row shadows
			// it: read under children alone) is read tracked till it holds a function, then that is
			// run once; what is written there after is not (no reload)
			attrs([{ path: [WAITING], value: [{ code: paths.at }] }])
			const saved = box.places.view(box.root, [children])
			let ran = false
			s.runWithScope(inside.scope, () =>
				s.createEffect<unknown>(
					() => {
						if (ran) return undefined
						const there = get(saved, paths.at)
						const v = there === undefined ? undefined : saved.readValue("value", there)
						return typeof v === "function" ? v : PENDING
					},
					(setup) => {
						if (ran || typeof setup !== "function") return
						ran = true
						s.runWithScope(inside.scope, () => run(setup as () => unknown))
					},
				))
			queuePulse()
		})
		if ("refused" in made) {
			// taken by a stopped process whose row a feature held: said, naming both
			const under = (a: Path, b: Path) => a.every((n, i) => b[i] === n)
			for (const process of [...heldRows.keys()]) {
				const r = rowHeld(process)
				if (r === undefined || r.root !== box.root) continue
				if (!(under(r.at, made.at) || under(made.at, r.at))) continue
				return { ...made, held: { process, feature: r.feature } }
			}
			return made
		}
		roots.set(made.id, box.root)
		started.push(made)
		return {
			process: made,
			stop: (why?: Why) => stop(made, why),
			status: () => words.status(mint(base.handles, { id: made.id, part: "value" }, hostInner)),
		}
	}

	function close() {
		if (closed) return
		for (const p of [...started].reverse()) stop(p, "ended")
		s.teardown(hostScope)
		statuses.stop()
		runs.stop()
		calls.stop()
		offSettle()
		offRelease()
		for (const off of [...listening]) off()
		unregister()
		unmakers()
		closed = true
	}

	// the host's words: closed, they throw
	const hostWords = {} as Record<string, unknown>
	for (const [k, v] of Object.entries(words)) {
		hostWords[k] = typeof v === "function"
			? (...a: unknown[]) => {
				alive()
				return (v as (...a: unknown[]) => unknown)(...a)
			}
			: v
	}
	const part = <T>(v: T) => () => {
		alive()
		return v
	}
	const ermine = Object.defineProperties(hostWords, {
		start: { value: start },
		close: { value: close },
		api: {
			value: (context: ProcessContext): API => {
				alive()
				const inner = inners.get(context)
				if (inner === undefined) {
					throw new ErmineError("not-yet", "a process context this ermine did not make")
				}
				return createWords(base, inner)
			},
		},
		getProcessContext: {
			value: (process?: Process): ProcessContext | undefined => {
				alive()
				return process === undefined ? hostInner.context : contexts.get(process.id)?.context
			},
		},
		scheduler: { get: part(s) },
		table: { get: part(table) },
		places: { get: part(p) },
		processes: { get: part(processes) },
		features: { get: part(features.shown) },
		node: { get: part(node) },
		calling: {
			value: () => {
				alive()
				return calls.calling(s.getCurrentScope())
			},
		},
		handleOf: {
			value: (node: NodeData, context?: ProcessContext): Node => {
				alive()
				const inner = context === undefined ? hostInner : inners.get(context)
				if (inner === undefined) {
					throw new ErmineError("not-yet", "a process context this ermine did not make")
				}
				return mint(base.handles, node, inner)
			},
		},
		dataOf: {
			value: (x: unknown) => {
				alive()
				const d = isHandle(x) ? base.handles.get(x) : undefined
				return d === undefined ? undefined : { node: d.node, context: d.maker.context }
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
		api: (context) => ermine.api(context),
		handleOf: (node, context) => ermine.handleOf(node, context),
		dataOf: (x) => ermine.dataOf(x),
		seen: (id, context) => {
			const inner = inners.get(context)
			return inner === undefined ? undefined : seenIn(base, inner, id)
		},
	}
	return ermine
}
