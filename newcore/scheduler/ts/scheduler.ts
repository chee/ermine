// the reference scheduler, over the graph (graph.ts): the graph hooks
// up newcore's libraries and tells the scheduler when a change reached what a process read; the
// scheduler runs processes, in rounds, ranked (rank.ts).
//
// processes are ephemeral nodes made by start; one is killed when its node goes, by outro.
// a program: a setup, run once; a compute, run again when what it read changes; or an effect, a
// compute whose value is acted on. no history: each process's value and status are versions of its
// node's value, its latest run a node named run inside it; four moments go to the hooks.
// what scheduler() answers is the host's interface.
import type { Change } from "../nodes/change.ts"
import {
	type Acting,
	type Api,
	type By,
	createGraph,
	GraphError,
	type Read,
} from "../graph/graph.ts"
import type { Node, Version } from "../nodes/node.ts"
import type { Address, Depend, Item, Place, Step } from "../graph/places.ts"
import { type Ask, edit, type May, pass as passing } from "../protect.ts"
import { createCode } from "../programs/code.ts"
import { createHandlers } from "../programs/handlers.ts"
import { createProcesses } from "../programs/processes.ts"
import { createOrder } from "./order.ts"
import {
	type CallOp,
	Cause,
	type Ctx,
	type Ended,
	type Fn,
	type Kept,
	type Moment,
	PENDING,
	type Proc,
	type ReadEntry,
	type Run,
	type StartOp,
} from "./types.ts"
import {
	createRecords,
	errorOf,
	isLive,
	normal,
	sameStatus,
	type Status,
} from "../programs/records.ts"
import type { Site } from "../nodes/stacktrace.ts"

export type { Api, By } from "../graph/graph.ts"
export {
	type CallOp,
	type Code,
	type Ended,
	type Finder,
	type Hook,
	type Moment,
	PENDING,
	type StartOp,
} from "./types.ts"
import type { Finder, Hook } from "./types.ts"
export { GraphError as SchedulerError, pidOf } from "../graph/graph.ts"

type N = Node<unknown, Change>
type V = Version<unknown, Change>

export type Options = {
	// the root's id; the host introduces its node (intro), or one is made holding nothing
	root: string
	// who the host's own changes are by
	actor?: unknown
	// the last time given; each change takes the next
	clock?: { time: number }
	hooks?: readonly Hook[]
	// finds the code of a process whose program is a path (LOADERS.tex)
	code?: Finder
	// a fresh id for a node made at a time; "@" and the time if not given
	id?: (time: number) => string
	// who may do what (protect.ts), asked before each operation not the scheduler's own;
	// default anyone
	may?: May
	// the host's site for its changes; default read off the call stack
	site?: () => Site | undefined
}

export type ErrorCode =
	| "stopped"
	| "read-only"
	| "nothing-there"
	| "not-a-handler"
	| "not-a-process"
	| "wrong-field"
	| "refused"

class Stop {
	constructor(readonly at: Proc) {}
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const isPromise = (v: unknown) =>
	v !== null && (typeof v === "object" || typeof v === "function") &&
	typeof (v as { then?: unknown }).then === "function"
const isMap = (v: unknown) =>
	v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype

// why an effect part ran: its value not the same (SCHEDULER.tex, Processes, Why)
function whyNew(v: unknown, given: boolean): string {
	if (given) return "not equal by its comparison"
	if (Array.isArray(v)) return "a new list"
	if (v instanceof Uint8Array) return "new bytes"
	if (ArrayBuffer.isView(v)) return "a new typed array"
	if (isMap(v)) return "a new map"
	if (typeof v === "object" && v !== null || isLive(v)) return "a new live value"
	return "not equal"
}

export function createScheduler(options: Options) {
	const clock = options.clock ?? { time: 0 }
	const hooks = options.hooks ?? []
	const hostActor = options.actor ?? "host"
	const finder = options.code

	const g = createGraph<Proc>({
		root: options.root,
		site: options.site,
		actor: hostActor,
		clock,
		id: options.id,
		may: options.may,
		marked: (q, change, causes) => {
			if (q.state === "running") mark(q, change, causes as Cause | undefined)
		},
		owned: (p, id) => void p.owned.push(id),
		released: (id, owner) => {
			if (owner) owner.owned = owner.owned.filter((x) => x !== id)
			const r = runs.get(id)
			if (r) {
				runs.delete(id)
				r.run = undefined
			}
		},
	})
	const { places } = g

	const procs = new Map<string, Proc>()
	const order = createOrder<Proc>((id) => procs.get(id), () => procs.values())
	const runs = new Map<string, Proc>()
	const waiting: Run[] = []
	const queue: (() => void)[] = []

	let depth = 0
	let inRound = false
	const ran = new Set<string>()
	const stamped: Kept[] = []

	const pass = (m: Moment) => {
		for (const h of hooks) h(m)
	}

	// no longer loaded; a process whose node it was, killed; ephemeral nodes it owned, released
	function outro(id: string, who: Acting = { actor: hostActor }) {
		const cause: By = { ...who, time: ++clock.time, node: id, which: "loaded" }
		g.release(id, cause)
		const p = procs.get(id)
		if (p?.state === "running") processes.kill([p], cause)
	}

	// causes and loops

	function caused(c: Cause | undefined, id: string): boolean {
		if (!c || !ran.has(id)) return false
		const seen = new Set<Cause>([c])
		const stack = [c]
		while (stack.length) {
			const x = stack.pop()!
			if (x.id === id) return true
			for (const q of x.parents) if (!seen.has(q)) (seen.add(q), stack.push(q))
		}
		return false
	}
	function idsOf(c: Cause): string[] {
		const ids = new Set<string>()
		const seen = new Set<Cause>([c])
		const stack = [c]
		while (stack.length) {
			const x = stack.pop()!
			ids.add(x.id)
			for (const q of x.parents) if (!seen.has(q)) (seen.add(q), stack.push(q))
		}
		return [...ids].sort(byCodePoint)
	}

	// records: status, value and the latest run, written at the process's node

	const records = createRecords<Proc>(g)
	const { runAgent } = records

	function pendingAt(p: Proc) {
		const status = { ...p.status, pending: p.since ?? order.at(p.id)! }
		if (!sameStatus(status, p.status)) records.status(p, status)
	}

	// the latest run, as records writes it
	function writeRun(p: Proc, run: Run, ended: Ended, error?: unknown) {
		const value: Record<string, unknown> = {
			run: run.n,
			program: p.program ?? null,
			by: run.given.map((k) => k.by.time),
			reads: run.reads,
			wrote: run.wrote,
			rank: run.rank,
			ended,
			after: afterOf(p),
		}
		if (ended === "stopped" && run.stopped) value.waits = run.stopped.id
		if (run.equal !== undefined) value.equal = run.equal
		if (error !== undefined) value.error = error
		const made = records.run(p, run.n, value, run.causes)
		if (made !== undefined) runs.set(made, p)
	}

	// marks

	function mark(q: Proc, change: By, causes?: Cause) {
		if (!q.kept.has(change.time!)) {
			const k: Kept = { by: change, causes }
			q.kept.set(change.time!, k)
			if (causes) stamped.push(k)
		}
		const loop = caused(causes, q.id)
		q.looping = loop ? idsOf(causes!) : undefined
		if (q.parked) {
			if (loop) return
			q.parked = false
		}
		becomes(q, change.time!)
	}

	function becomes(q: Proc, time: number) {
		if (order.has(q.id)) return
		order.set(q.id, time)
		q.since ??= time
		pass({ due: q.id, by: time })
	}

	// reads

	// items of process nodes that are due: a compute's read stops, unless that process waits
	// after it; otherwise their pending is written first
	function reached(items: readonly { id: string; node?: unknown }[]): Proc[] {
		const out: Proc[] = []
		for (const it of items) {
			const q = procs.get(it.id)
			if (q && it.node && order.has(q.id) && !out.includes(q)) out.push(q)
		}
		return out
	}

	function waitsAfter(q: Proc, r: Proc): boolean {
		const seen = new Set<Proc>()
		for (let x = q.after; x && !seen.has(x); x = x.after) {
			if (x === r) return true
			seen.add(x)
		}
		return false
	}

	// a read: as ctx's process, tracked when given a depend; the hooks and the run see it
	function reading(
		op: string,
		f: Read,
		depend: Depend | undefined,
		ctx?: Ctx,
		args: { address?: Address; name?: string } = {},
	): unknown {
		let out = f(depend)
		const items = (Array.isArray(out) ? out : []).filter((x) => typeof x === "object") as Item<
			unknown,
			Change
		>[]
		const due = op === "children" ? [] : reached(items)
		if (due.length) {
			if (ctx?.compute && ctx.run) {
				for (const q of due) {
					if (q !== ctx.p && !waitsAfter(q, ctx.p)) {
						ctx.run.stopped = q
						throw new Stop(q)
					}
				}
			}
			const before = clock.time
			for (const q of due) pendingAt(q)
			if (clock.time !== before) out = f(undefined)
		}
		if (ctx) {
			const tracked = depend !== undefined
			pass({ reads: ctx.p.id, ...ctx.base, op, items: Array.isArray(out) ? out : [], tracked })
			const run = ctx.run
			if (run) {
				const entry: ReadEntry = {
					op,
					tracked,
					times: records.times(Array.isArray(out) ? out : []),
				}
				if (args.address !== undefined) entry.address = args.address
				if (args.name !== undefined) entry.name = args.name
				run.reads.push(entry)
				if (ctx.compute && op !== "children") {
					for (const it of items) if (it.node && procs.has(it.id)) run.values.add(it.id)
				}
			}
		}
		return out
	}

	// what every interface of a process binds: its actor, pid, place
	function processApi(
		ctx: Ctx,
		o: { tracked?: boolean; writes: boolean; alive: () => boolean },
	): Api {
		const p = ctx.p
		const depend = o.tracked ? p.track.depend : undefined
		return g.bound({
			place: p.place,
			agent: ctx.agent,
			reader: p.id,
			cause: ctx.cause,
			depend,
			writes: o.writes,
			alive: o.alive,
			owner: p,
			tag: ctx.causes,
			wrote: ctx.run?.wrote,
			reading: (op, f, args) => reading(op, f, depend, ctx, args),
			around: request,
		})
	}

	// protect, as the programs side is given it: one check for each thing it does, never protect
	// itself. each passes the item's route, then asks the one thing

	function mayStart(
		actor: unknown,
		item: { id: string; route: Step[] },
		name?: string,
		id?: string,
	) {
		const place: Ask = { op: "place", args: { node: item.id, name, id } }
		g.asking(actor, [...passing(item.route), place], "start")
	}
	function mayCall(actor: unknown, item: { id: string; route: Step[] }) {
		const read: Ask = { op: "read", args: { node: item.id, object: "value" } }
		g.asking(actor, [...passing(item.route), read], "call")
	}

	// processes: starting, parts, cleanups, killing

	const processes = createProcesses({
		g,
		clock,
		actor: hostActor,
		site: options.site,
		finder,
		procs,
		records,
		mayStart,
		api: processApi,
		started: (p) => order.started(p),
		due(p, k) {
			p.kept.set(k.by.time!, k)
			if (k.causes) stamped.push(k)
			becomes(p, k.by.time!)
		},
		mark,
		ending(p) {
			order.killing(p)
			const w = p.waiting
			if (w) {
				waiting.splice(waiting.indexOf(w), 1)
				p.waiting = undefined
				pass({ ends: p.id, run: w.n, ended: "stopped" })
			}
		},
		gone: (p) => order.gone(p),
	})
	const { start, starter, replacing, part, partCall, settleChildren, cleaner, cleanups } =
		processes

	// code, when a program is a path

	const code = createCode({ finder, api: processApi, part })

	// handler calls

	const handlers = createHandlers({
		g,
		pass,
		mayCall,
		api: processApi,
		starter,
		part,
		request,
		busy: () => inRound || processes.active() > 0,
		queue: (f) => void queue.push(f),
	})

	// runs

	const same = (p: Proc, v: unknown) =>
		p.last !== undefined && (p.equal ? p.equal(v, p.last.value) : Object.is(v, p.last.value))

	// a value a part may give: anything but undefined; a setup's not a promise
	function valueOf(v: unknown, setup: boolean): unknown {
		if (v === undefined || setup && isPromise(v)) {
			throw new GraphError("wrong-field", "value: a part gives a value")
		}
		return v
	}

	// a run's first half: code, if the program is a path; then a compute runs, and a setup or an
	// effect's part waits for the second half
	function first(p: Proc, picked: number) {
		let rank = picked
		const earlier = p.waiting
		if (earlier) {
			waiting.splice(waiting.indexOf(earlier), 1)
			p.waiting = undefined
			finish(earlier, "done", undefined, true)
			rank = order.rank(p)
		}
		const markTime = order.at(p.id)!
		order.delete(p.id)
		order.waits(p, undefined)
		const n = ++p.runs
		const given = [...p.kept.values()]
		const parents = new Set<Cause>()
		for (const k of given) if (k.causes) parents.add(k.causes)
		const causes = new Cause(p.id, [...parents])
		ran.add(p.id)
		const run: Run = {
			p,
			n,
			mark: markTime,
			rank,
			given,
			causes,
			reads: [],
			wrote: [],
			values: new Set(),
			replaced: p.replaced,
			looping: p.looping,
		}
		p.looping = undefined
		pass({ starts: p.id, run: n, rank })
		p.track.begin()
		try {
			const ctx: Ctx = { p, agent: runAgent(p, n), base: { run: n }, run, compute: true, causes }
			const found = code.find(ctx)
			if (found === "stopped") return stop(run)
			if (found === "pending") return finish(run, "pending")
			if (found) return finish(run, "failed", found.failed)
			const c = p.code!
			if (typeof c === "function") {
				if (p.setup && !p.replaced) return finish(run, "done")
				run.part = "setup"
				p.waiting = run
				waiting.push(run)
				return
			}
			// the compute
			const cctx: Ctx = { ...ctx, call: partCall(p, "compute", run.replaced) }
			let open = true
			const out = part(p, () =>
				(c.compute as (g: unknown) => unknown)({
					api: processApi(cctx, { tracked: true, writes: false, alive: () => open }),
					peep: processApi(cctx, { writes: false, alive: () => open }),
					start: starter(cctx, () => open),
					by: given.map((k) => k.by),
					pending: PENDING,
					self: p.id,
					name: p.name,
				}))
			open = false
			if (run.stopped) return stop(run)
			if ("error" in out) return finish(run, "failed", out.error)
			if (out.value === PENDING) return finish(run, "pending")
			if (isPromise(out.value)) return awaiting(run, out.value as Promise<unknown>, cctx)
			computed(run, cctx, out.value)
		} finally {
			p.track.end()
		}
	}

	// a compute's value: compared, written, its effect part waiting if new
	function computed(run: Run, cctx: Ctx, v: unknown) {
		const p = run.p
		const c = p.code as { compute: Fn; effect?: Fn }
		let value: unknown
		try {
			value = valueOf(v, false)
		} catch (e) {
			return finish(run, "failed", e)
		}
		settleChildren(cctx)
		let equals: boolean
		try {
			equals = same(p, value)
		} catch (e) {
			return finish(run, "failed", e)
		}
		run.equal = equals
		if (run.looping && !equals) {
			run.value = value
			return finish(run, "parked")
		}
		if (!equals) {
			run.why = p.last === undefined ? "a first value" : whyNew(value, p.equal !== undefined)
			records.value(p, value, shownStatus(run), run.n, run.causes)
		}
		if (c.effect && (!equals || run.replaced)) {
			if (run.replaced) run.why = "replaced"
			run.part = "effect"
			run.value = value
			p.waiting = run
			waiting.push(run)
			return
		}
		finish(run, "done")
	}

	// an async compute: its run ends pending; the settling, unless rerun or killed since, a
	// request finishing that run
	function awaiting(run: Run, promise: Promise<unknown>, cctx: Ctx) {
		const p = run.p
		finish(run, "pending")
		const settle = (f: () => void) => {
			if (p.state !== "running" || p.runs !== run.n) return
			try {
				request(() => {
					run.reads = run.reads.slice()
					f()
				})
			} catch (e) {
				// nobody awaits a settle: what escaped is the run's failure
				try {
					request(() => finish(run, "failed", e))
				} catch { /* shows in the moments */ }
			}
		}
		promise.then(
			(v) => settle(() => v === PENDING ? finish(run, "pending") : computed(run, cctx, v)),
			(e) => settle(() => finish(run, "failed", e)),
		)
	}

	const shownStatus = (run: Run): Status => (run.shown ? { new: run.shown.value } : {})

	// a run's second half: the cleanups before, then the setup, or the effect part
	function second(run: Run) {
		const p = run.p
		waiting.splice(waiting.indexOf(run), 1)
		p.waiting = undefined
		if (p.state !== "running") return
		const agent = runAgent(p, run.n)
		let error = cleanups(p, false, run)
		if (p.state !== "running") return finish(run, error === undefined ? "done" : "failed", error)
		const ctx: Ctx = {
			p,
			agent,
			base: { run: run.n },
			run,
			causes: run.causes,
			call: partCall(p, run.part!, run.replaced),
		}
		if (run.part === "effect") ctx.cause = run.why
		let alive = true
		const given: Record<string, unknown> = {
			api: processApi(ctx, { writes: true, alive: () => alive }),
			start: starter(ctx, () => alive),
			call: handlers.callerOf(ctx),
			onCleanup: cleaner(p, () => alive),
			self: p.id,
			name: p.name,
		}
		const c = p.code!
		if (run.part === "effect") {
			given.value = run.value
			if (p.previous) given.previous = p.previous.value
			const effect = (c as { effect: Fn }).effect
			const out = part(p, () => (effect as (g: unknown) => unknown)(given))
			alive = false
			p.previous = { value: run.value }
			if ("error" in out) error ??= out.error
			else if (p.state === "running") settleChildren(ctx)
			return finish(run, error === undefined ? "done" : "failed", error)
		}
		const out = part(p, () => (c as (g: unknown) => unknown)(given))
		alive = false
		p.setup = true
		if ("error" in out) return finish(run, "failed", error ?? out.error)
		let value: unknown
		try {
			value = valueOf(out.value, true)
		} catch (e) {
			return finish(run, "failed", error ?? e)
		}
		if (p.state !== "running") return finish(run, error === undefined ? "done" : "failed", error)
		settleChildren(ctx)
		const equals = same(p, value)
		run.equal = equals
		if (!equals) records.value(p, value, shownStatus(run), run.n, run.causes)
		finish(run, error === undefined ? "done" : "failed", error)
	}

	function stop(run: Run) {
		const p = run.p
		order.waits(p, run.stopped!)
		if (p.state === "running") order.set(p.id, run.mark)
		finish(run, "stopped")
	}

	function finish(run: Run, ended: Ended, error?: unknown, keep = false) {
		const p = run.p
		const json = error === undefined ? undefined : errorOf(error)
		if (p.state === "running") {
			if (ended === "done" && !keep) {
				for (const k of run.given) p.kept.delete(k.by.time!)
				p.replaced = false
			}
			if (ended === "parked") p.parked = true
			if (ended !== "stopped") order.sees(p, run.values)
			if (ended !== "pending" && ended !== "stopped") p.since = order.at(p.id)
			const status: Status = {}
			if (ended === "pending" || ended === "stopped") status.pending = p.since ?? run.mark
			if (ended === "failed") status.error = json
			if (ended === "parked") {
				const loop: { through: string[]; value?: unknown } = { through: run.looping ?? [p.id] }
				if (!isLive(run.value)) loop.value = run.value
				status.loop = loop
			}
			if (run.shown) status.new = run.shown.value
			if (!sameStatus(status, p.status)) records.status(p, status, run.n, run.causes)
			writeRun(p, run, ended, json)
		}
		const ends: Moment = { ends: p.id, run: run.n, ended }
		if (ended === "stopped" && run.stopped) ends.waits = run.stopped.id
		if (run.equal !== undefined) ends.equal = run.equal
		if (json !== undefined) ends.error = json
		pass(ends)
	}

	// what a process is after, as its latest run shows it
	function afterOf(p: Proc): string[] {
		const out = new Set<string>()
		for (const id of p.values) if (id !== p.id && procs.get(id)?.state === "running") out.add(id)
		if (p.after && p.after !== p && p.after.state === "running") out.add(p.after.id)
		return [...out].sort(byCodePoint)
	}

	// requests and rounds

	function round() {
		inRound = true
		try {
			while (order.size()) {
				const next = order.next()
				first(next.p, next.rank)
			}
			while (waiting.length) second(waiting[0])
		} finally {
			inRound = false
		}
		while (queue.length) queue.shift()!()
	}

	function request<T>(fn: () => T): T {
		if (depth > 0 || processes.active() > 0) return fn()
		depth++
		let out: T
		try {
			out = fn()
			while (order.size() || queue.length || waiting.length) round()
		} finally {
			depth--
			for (const id of order.ids()) {
				const p = procs.get(id)
				if (p?.state === "running") pendingAt(p)
			}
			for (const k of stamped) k.causes = undefined
			stamped.length = 0
			if (!queue.length) ran.clear()
		}
		return out
	}

	// the host's interface
	const host = g.bound({
		place: [],
		agent: hostActor,
		site: true,
		writes: true,
		alive: () => true,
		reading: (op, f, args) => reading(op, f, undefined, undefined, args),
		around: request,
	})
	return {
		...host,
		get: g.get,
		intro: (node: N) => request(() => g.intro(node)),
		outro: (id: string) => request(() => outro(id)),
		ephemeral: g.ephemeral,
		start: (op: StartOp) => request(() => start(op)),
		call(op: CallOp) {
			let agent: unknown = op.actor ?? hostActor
			if (op.person !== undefined || op.trusted !== undefined) {
				const a = { ...normal(agent) }
				if (op.person !== undefined) a.person = op.person
				if (op.trusted !== undefined) a.trusted = op.trusted
				agent = a
			}
			return handlers.call(op, { place: op.place ?? [], agent })
		},
		replace(op: { address: Address; place?: Place }) {
			return request(() => {
				const item = places.look(op.place ?? [], op.address).find((it) => it.node)
				if (!item) throw new GraphError("nothing-there", "the address reaches nothing")
				g.asking(
					hostActor,
					[...passing(item.route), edit("write", item.id, "value")],
					"replace",
				)
				const p = procs.get(item.id)
				if (!p || p.state !== "running") {
					throw new GraphError("not-a-process", "the node is no process")
				}
				replacing(p, { actor: hostActor })
			})
		},
		batch(fn: () => void) {
			let thrown: { e: unknown } | undefined
			request(() => {
				try {
					fn()
				} catch (e) {
					thrown = { e }
				}
			})
			if (thrown) throw thrown.e
		},
	}
}

export type Scheduler = ReturnType<typeof createScheduler>
