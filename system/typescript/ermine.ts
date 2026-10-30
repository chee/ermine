// // ermine: what a host makes, once. The host is process 0: its code runs in its own scope, where
// // the functions of @ermine/system act as it.
// //
// //   import { createErmine } from "@ermine/system"
// //
// //   const ermine = createErmine({ host: { at: "/host", args, setup } })
// //   ermine.within(() => ensureNode("/work/n", 1))          // host code, as the host
// //   const running = ermine.start(clock, "/work/clock")    // { process, stop(), status() }
// //   running.status()                                       // a setup that threw shows here
// //   ermine.close()                                         // every process, then the host's
// //
// // Options all have defaults: features (none), scheduler (a new one), may (the policy every read
// // and write is asked of; none allows all), root (a new id), host (where its node is placed, its
// // args, and a setup run once untracked as createErmine ends), info (the host scope's info).
// //
// // start(fn, at, { args }) runs fn as the setup of a process at `at`, given nothing. What setup
// // returns is the process's value, and a throw shows in status(). Throwing PENDING leaves the
// // process pending, with what it waits on in ermine.process.waiting. Setup runs once.
// // close() stops every process ermine started, newest first, then the host's scope.
import type { ChangeHeader } from "@ermine/graph/entry"
import { children, createPlaces, crow, type Id, type Path, type Places } from "@ermine/places"
import { crowify } from "@ermine/places/crowify"
import { keepStackTraceLimit } from "@ermine/changeable/stacktrace"
import { place } from "./system/names.ts"
import { getStatus } from "./system/status.ts"
import { enterScheduler, leaveScheduler, registerScheduler, registerScope } from "./registry.ts"
import { isHandle, mint } from "./handles.ts"
import { callFrame, createChangeHeader, locationsHere, outsideAt } from "@ermine/places/header"
import type { Location } from "@ermine/changeable/stacktrace"
import {
	createStatus,
	STATUS,
	type StatusTables,
	TABLE as STATUS_TABLE,
} from "@ermine/processes/status"
import type { Policy } from "@ermine/protect"
import { idAt, PROCESS, processes as rows } from "@ermine/processes"
import { createRuns, type Run } from "@ermine/processes/runs"
import { createScopeNodes } from "@ermine/processes/scopes"
import {
	createProcesses,
	pathsOf,
	type Process,
	type Processes,
	processIds,
	type Refused,
} from "@ermine/processes/start"
import {
	createScheduler,
	type Frame,
	type Info,
	PENDING,
	type Scheduler,
	type Scope,
} from "@ermine/reactivity"
import { isPromise } from "@ermine/reactivity/helpers"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key, type Table, type Tables } from "@ermine/graph/table"
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
} from "./features.ts"
import {
	type CreatedFunction,
	createProcessContext,
	type ErmineTable,
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
import { seenIn, viewOf } from "./system/addressing.ts"
import type { Base } from "./system/base.ts"
import { computerAt } from "./system/made.ts"
import { putStatus, setKey } from "./system/status.ts"
import { callAbove } from "./system/scopes.ts"
import { attach, innerOf } from "./system/setting.ts"
import { type ChangeView, type Held, type Status, type System, WAITING } from "./system/shapes.ts"

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
export { SCOPE, SendError, WAITING } from "./system/shapes.ts"
export type {
	Caller,
	CallView,
	ChangeView,
	Explained,
	Held,
	Item,
	RunView,
	Status,
	System,
	Touched,
	Waiting,
	Writer,
} from "./system/shapes.ts"
export type { Call, Wait } from "./calls.ts"

export const ARGS = "ermine.host.args"
export const FEATURES = "ermine.features"

export type Options = {
	features?: readonly Feature[]
	scheduler?: Scheduler
	may?: Policy
	root?: Id
	host?: {
		at?: string | Path
		args?: readonly string[]
		setup?: () => unknown
	}
	info?: Info
	// The clock every change's time is taken from, ms since 1970. Defaults to Date.now.
	now?: () => number
}

export type StartOptions = {
	args?: readonly string[]
	// The places the process lives in (such as a box's). Defaults to the ermine's own.
	places?: Places
}

export type Started = {
	readonly process: Process
	stop: (why?: Why) => void
	status: () => Status | undefined
}

export type Ermine = {
	// Runs f in the host's scope.
	within: <T>(f: () => T) => T
	// A start is refused as taken, and `held` is set when a stopped process's row removal was held back by a feature.
	start: (
		fn: () => unknown,
		at: string | Path,
		options?: StartOptions,
	) => Started | (Refused & { held?: { process: Id; feature: string } })
	close: () => void
	getProcessContext: (process?: Process) => ProcessContext | undefined
	// Handles for the host: one minted for a node, and what a handle reaches (undefined if not ours).
	handleOf: (node: NodeData) => Node
	dataOf: (x: unknown) => { node: NodeData } | undefined
	readonly scheduler: Scheduler
	readonly table: ErmineTable
	readonly places: Places
	readonly features: readonly Shown[]
	readonly id: Id
	readonly records: {
		run: (id: Id) => Run | undefined
		call: (id: Id) => Call | undefined
		waits: () => Wait[]
	}
}

// A uuidv7 (rfc 9562): 48 bits of ms, then a 12-bit counter, then random. A clock going back
// or a full counter borrows the next ms, so later ids always sort after.
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
	// Errors from ermine itself (start, closed) go through the onError hooks like a function's.
	const hinted = (e: ErmineError, fn?: string) => errored(e, fn)
	const alive = () => {
		if (closed) throw hinted(new ErmineError("closed", "ermine is closed"))
	}

	const s = options.scheduler ?? createScheduler()
	// Capturing stacks keeps the host's Error.stackTraceLimit.
	keepStackTraceLimit()

	// deno-lint-ignore prefer-const
	let places: Places | undefined
	// deno-lint-ignore prefer-const
	let processes: Processes | undefined
	// deno-lint-ignore prefer-const
	let first: Ahead
	let made:
		| {
			getProcessContext: (process?: Process) => ProcessContext | undefined
			handleOf: (node: NodeData) => Node
			dataOf: (x: unknown) => { node: NodeData } | undefined
			seen: (id: Id, context: ProcessContext) => Path | undefined
			calling: () => Calling | undefined
			// pipe-extension: core gap
			viewOf: (change: ChangeHeader) => ChangeView
		}
		| undefined
	const table: ErmineTable = createTable<Tables & StatusTables>((part, id) =>
		first.onTableChange(part as Key, id)
	)
	// A copy of the scheduler for features. Each on... function is wrapped so its off runs at close,
	// because a scheduler passed in options outlives ermine.
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
		viewOf: () => made?.viewOf,
	})
	const { hooks } = features
	const processId = processIds()
	const idFor = chain<[IdKind], string>(
		hooks.onId,
		"onId",
		(kind) => kind === "process" ? processId() : uuidv7(),
	)
	const newId = () => idFor("node")
	const errored = chain<[unknown, string | undefined], unknown>(hooks.onError, "onError", (e) => e)
	const toPlaces: Ahead = {
		onTableChange: (part, id) => places!.onTableChange(part, id),
		commit: (changed) => places!.commit(changed),
	}
	const layered = layer(hooks.onTable, table, () => toPlaces)
	first = layered.first
	const commit = (changed: Parameters<Places["commit"]>[0]) => first.commit(changed)

	const root = options.root ?? newId()
	places = createPlaces({
		root,
		table: layered.front as Table,
		paths: createPaths<unknown>(),
		scheduler: s,
		contributors: [rows(root), children],
		now: options.now,
	})
	const offRelease = s.onTrackingEnd((key) => places!.release(key))
	// Each run borrows what it reads: crow lets go of what outlives the run, so a later write copies
	// it rather than changing it in place.
	const offCrow = crowify(s, crow)
	const p = places

	const node = newId()
	const hostScope = s.createRootScope({ ...options.info, node: node })

	let queued = false
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

	const header = (): ChangeHeader => createChangeHeader(s, { now: options.now })
	// A call from outside the graph captures its locations once and runs f in a frame holding them,
	// so what f writes captures nothing again. Inside the graph, f runs as it is.
	function enter<T>(cut: unknown, build: Location | undefined, f: () => T): T {
		const scope = s.getCurrentScope()
		const locations = scope === undefined ? undefined : outsideAt(s, build, cut)
		return locations === undefined ? f() : s.runWith(scope!, callFrame(s, locations), f)
	}

	// Writes held back by a hook (one that did not call next) are remembered per (part, id) until a
	// write there lands or the node goes.
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
	// When a node goes, the writes held at its parts go too, unless a part is still there.
	const dropHeld = (id: Id) => {
		const at = heldWrites.get(id)
		if (at === undefined) return
		let told = false
		for (const part of [...at.keys()]) {
			if (table.get(part, id) === undefined) told = unhold(part, id) || told
		}
		if (told) s.mark([heldKey])
	}
	const heldAt = (part: Key, id: Id) => {
		s.track(heldKey)
		const h = heldOf(part, id)
		return h === undefined ? undefined : { feature: h.feature }
	}
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
	// Stopped processes whose row removal a feature held back, by the process's node.
	const heldRows = new Map<Id, { feature: string; root: Id; at: Path }>()
	const rowAt = (root: Id, at: Path): Id | undefined => idAt(table.get(PROCESS, root)?.value, at)
	// A held row that a later write already took out is dropped silently.
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
	// The caller of the open call, as a place: a process's at, or a computer's process's. The host has none.
	const caller = (): { from?: Path; box?: Id } | undefined => {
		const o = callAbove(s.getCurrentFrame())
		if (o === undefined) return undefined
		const by = (o.info.caller as { node?: Id } | undefined)?.node
		if (by === undefined || by === node) return {}
		const ctx = contexts.get(by) ?? computerAt(madeNodes, by)?.inner
		if (ctx?.context.process === undefined) return {}
		return { from: ctx.context.at, ...ctx.box !== undefined && { box: ctx.box } }
	}
	const parts: Parts = {
		scheduler: s,
		table,
		commit,
		may: options.may,
		caller,
		header,
		enter,
		put: (o, w, land) => {
			const was = deepest
			deepest = undefined
			let landed = false
			written(o, w, (x) => {
				landed = true
				let told = unhold(x.part, x.id)
				if (!told && x.part === PROCESS) {
					for (const r of heldRows.values()) if (r.root === x.id) told = true
				}
				// A mark only schedules the rerun, so it is made before the write lands.
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

	const hostInner = createProcessContext(parts, {
		scope: hostScope,
		places: p,
		folder: [],
		at: [],
		args: options.host?.args ?? [],
		node,
	})
	hostInner.context.within(() => {
		hostInner.put({ part: "children", id: root, patches: [{ path: [], value: {} }] })
		const attrs: Record<string, unknown> = {
			[ARGS]: options.host?.args ?? [],
			[FEATURES]: features.shown,
		}
		hostInner.put({ part: "attributes", id: node, patches: [{ path: [], value: attrs }] })
	})

	const madeNodes: Base["made"] = new Map()
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
		owner,
		write: hostInner.writer,
		id: () => idFor("process"),
		now: options.now,
	})
	const statuses = createStatus({
		places: { commit },
		table,
		scheduler: s,
		write: (part, id, patches, header) =>
			(computerAt(madeNodes, id)?.inner ?? hostInner).writer(part, id, patches, header),
		now: options.now,
	})
	const runs = createRuns({
		places: { describe: p.describe, watchAll: p.watchAll },
		table,
		scheduler: s,
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
	const contexts = new Map<Id, Inner>()
	const whys = new Map<Id, Why>()
	const base: Base = {
		parts,
		locations: () => locationsHere(s),
		statuses,
		runs,
		calls,
		made: madeNodes,
		missing: new Map(),
		setting: new Set(),
		pulse: () => s.pulse(),
		methods: new Map(),
		whys,
		stop: () => {},
		start: () => {
			throw new ErmineError("closed", "not started")
		},
		newId,
		errored,
		handles: new WeakMap(),
		writers: new WeakMap(),
		processes: contexts,
		views: new WeakMap(),
		changes: new WeakMap(),
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

	attach(base, hostInner)
	const unregister = registerScheduler(s, hooks.onError.length ? errored : undefined)
	try {
		registerScope(hostScope, hostInner)
		features.done()

		if (options.host?.at !== undefined) {
			const at = options.host.at
			hostInner.context.within(() => place(at, mint(base.handles, { id: node, part: "value" })))
		}

		const started: Process[] = []

		function stop(process: Process, why: Why = "ended") {
			const world = contexts.get(process.id)?.places.root ?? root
			whys.set(process.id, why)
			try {
				processes!.stop(process)
			} finally {
				whys.delete(process.id)
				dropHeld(process.id)
				const i = started.indexOf(process)
				if (i !== -1) started.splice(i, 1)
			}
			const h = heldOf(PROCESS, world)
			if (rowAt(world, process.at) === process.id && h !== undefined) {
				heldRows.set(process.id, { feature: h.feature, root: world, at: process.at })
				s.mark([heldKey])
			}
		}

		base.start = (fn, at, o, under) => start(fn, at, o, under)

		base.stop = (id) => {
			const process = started.find((p) => p.id === id)
			if (process !== undefined) stop(process)
		}

		function start(
			fn: () => unknown,
			at: string | Path,
			o: StartOptions = {},
			under?: Scope,
			cut?: unknown,
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
					{
						args: o.args,
						folder: paths.folder,
						...under !== undefined && { under },
						...cut !== undefined && { cut },
					},
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
							...here.root !== root && { box: here.root },
						})
						contexts.set(pid, inner)
						attach(base, inner)
						registerScope(inside.scope, inner)
						s.registerTeardown(inside.scope, () => {
							contexts.delete(pid)
						})
						let setupFrame = inside.scope.frame
						const done = (v: unknown) => {
							if (inside.scope.state !== "alive") return
							// A promise settles with nothing open, so the scope is reopened with the setup's frame.
							s.runWith(inside.scope, setupFrame, () => {
								if (v !== undefined) {
									inner.put({ part: "value", id: pid, patches: whole(v) })
								}
								putStatus(inner, pid, [setKey(STATUS), setKey(WAITING)])
							})
							queuePulse()
						}
						const failed = (e: unknown) => {
							if (inside.scope.state !== "alive") return
							const error = e === undefined ? new Error("undefined") : e
							s.runWith(
								inside.scope,
								setupFrame,
								() => putStatus(inner, pid, [setKey(STATUS, error), setKey(WAITING)]),
							)
							queuePulse()
						}
						// Setup runs once, untracked, in its own scope. Throwing PENDING leaves the process pending.
						const run = (setup: () => unknown) => {
							const at = s.createScope({ process: inside.at }, inside.scope)
							setupFrame = at.frame
							let out: unknown
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
								for (const p of paths) waits.push({ missing: p })
								putStatus(inner, pid, [setKey(WAITING, waits.length ? waits : ["PENDING"])])
								return
							}
							missed()
							if (!isPromise(out)) return done(out)
							putStatus(inner, pid, [setKey(WAITING, ["a promise"])])
							out.then(done, failed)
						}
						run(fn)
					},
				)
			} finally {
				leaveScheduler()
			}
			if ("refused" in made) {
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

		// Every step runs even if an earlier one threw; the first error is thrown at the end.
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
			step(offCrow)
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
				value: function startFrom(fn: () => unknown, at: string | Path, o?: StartOptions) {
					return start(fn, at, o, undefined, startFrom)
				},
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
				return calls.calling(s.getCurrentFrame())
			},
			// pipe-extension: core gap
			viewOf: (change) => (alive(), viewOf(base, change)),
		}
		// A throw in the host's setup closes ermine and is thrown from here.
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
		// A throw after registration is undone.
		unregister()
		throw e
	}
}
