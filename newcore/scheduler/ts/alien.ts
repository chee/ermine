// alien: the push-pull scheduler (push.ts) on alien-signals' reactive system in place of shift's
// core and the trackgraph. one link graph holds both what a process read of the graph (a spot: a
// part of a node, as graph.ts tracks it) and the processes whose nodes it read:
//   - a change reaches a process (the graph's marked): it is dirty, and alien's propagate makes the
//     processes that read its node pending, and theirs
//   - a read of a process's node pulls it: a pending one asks alien's checkDirty, which runs the
//     processes it read that are dirty, and says whether one wrote something new; a dirty one runs
//   - computes are lazy; effects and setups are eager, queued by alien's notify, pulled when the
//     request ends
// no ranks, no stopped runs, no loops (a flush that goes on too long throws, so tests end).
// deno-lint-ignore no-import-prefix
import { createReactiveSystem, type Link, type ReactiveNode } from "npm:alien-signals@3.1.2/system"
import type { Change } from "../../nodes/ts/change.ts"
import {
	type Acting,
	type By,
	createGraph,
	GraphError,
	type Read,
	type Tracked,
	type Tracker,
} from "../../graph/ts/graph.ts"
import type { Node } from "../../nodes/ts/node.ts"
import type { Address, Depend, Item, Place, Step, Where } from "../../graph/ts/places.ts"
import { type Ask, edit, pass as passing } from "../../protect/ts/protect.ts"
import { createCode } from "../../programs/ts/code.ts"
import { createHandlers } from "../../programs/ts/handlers.ts"
import { createProcesses } from "../../programs/ts/processes.ts"
import { createProcessApi } from "../../programs/ts/process-api.ts"
import { isPromise, same, valueOf, whyNew } from "./helpers.ts"
import {
	type CallOp,
	type Cause,
	type Ctx,
	type Ended,
	type Fn,
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
	normal,
	sameStatus,
	type Status,
} from "../../programs/ts/records.ts"
import type { Options } from "./scheduler.ts"

type N = Node<unknown, Change>

// alien's flags
const MUTABLE = 1
const WATCHING = 2
const RUNNING = 4
const DIRTY = 16
const STALE = 32

// a process's or a spot's node in alien's graph
type Alien = ReactiveNode & { proc?: Proc }

// how many processes one flush may pull before it is a loop
const LIMIT = 100_000

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function createScheduler(options: Options) {
	const clock = options.clock ?? { time: 0 }
	const hooks = options.hooks ?? []
	const hostActor = options.actor ?? "host"
	const finder = options.code

	// alien's system: update runs a process, saying whether it wrote something new; notify queues
	// an eager one; a spot nobody reads any more is left to the graph
	let cycle = 0
	const { link, unlink, propagate, checkDirty } = createReactiveSystem({
		update: (n: Alien) => run(n.proc!),
		notify(n: Alien) {
			if (n.proc) enqueue(n.proc)
		},
		unwatched() {},
	})
	const nodes = new Map<Proc, Alien>()
	const nodeOf = (p: Proc): Alien => {
		let n = nodes.get(p)
		if (!n) {
			nodes.set(p, n = { flags: MUTABLE, proc: p })
		}
		return n
	}
	const spotNode = (): Alien => ({ flags: 0 })

	// the graph's tracker: alien's links. a run: depsTail reset, then each read linked in order,
	// then what was not read again unlinked
	const tracker: Tracker<Tracked<Proc>, Alien> = {
		node: (w) => ("owner" in w ? nodeOf(w.owner) : spotNode()),
		begin(n) {
			n.depsTail = undefined
			++cycle
		},
		track: (n, to) => link(to, n, cycle),
		end(n) {
			let l = n.depsTail !== undefined ? n.depsTail.nextDep : n.deps
			while (l !== undefined) l = unlink(l, n)
		},
		untrack(n) {
			let l = n.deps
			while (l !== undefined) l = unlink(l, n)
		},
		owners(n) {
			const out: { owner: Proc }[] = []
			for (let l: Link | undefined = n.subs; l !== undefined; l = l.nextSub) {
				const p = (l.sub as Alien).proc
				if (p) out.push({ owner: p })
			}
			return out
		},
	}

	const g = createGraph<Proc>({
		root: options.root,
		site: options.site,
		actor: hostActor,
		clock,
		id: options.id,
		may: options.may,
		tracker,
		marked: (q, change) => {
			if (q.state === "running") mark(q, change)
		},
		owned: (p, id) => void p.owned.push(id),
		released: (id, owner) => {
			if (owner) {
				const o = owner.owned
				if (o[o.length - 1] === id) o.pop()
				else {
					const i = o.lastIndexOf(id)
					if (i >= 0) o.splice(i, 1)
				}
			}
			const r = runs.get(id)
			if (r) {
				runs.delete(id)
				r.run = undefined
			}
		},
	})
	const { places } = g

	const procs = new Map<string, Proc>()
	const runs = new Map<string, Proc>()
	const waiting: Run[] = []
	const queue: (() => void)[] = []

	// when each process was last made due
	const marks = new Map<Proc, number>()
	const eager = (p: Proc) => typeof p.code !== "object" || p.code.effect !== undefined
	const queued = new Set<Proc>()
	const effects: Proc[] = []

	let depth = 0
	let flushing = false

	const pass = (m: Moment) => {
		for (const h of hooks) h(m)
	}

	function outro(id: string, who: Acting = { actor: hostActor }) {
		const cause: By = { ...who, time: ++clock.time, node: id, which: "loaded" }
		g.release(id, cause)
		const p = procs.get(id)
		if (p?.state === "running") processes.kill([p], cause)
	}

	const records = createRecords<Proc>(g)
	const { runAgent } = records

	// marks: a change reached q: dirty, what read its node pending (propagate)

	function mark(q: Proc, change: By) {
		if (!q.kept.has(change.time!)) q.kept.set(change.time!, { by: change })
		dirty(q, change.time!)
	}

	function dirty(q: Proc, time: number) {
		const n = nodeOf(q)
		if (n.flags & DIRTY) return
		if (!(n.flags & STALE)) {
			marks.set(q, time)
			pass({ due: q.id, by: time })
		}
		n.flags |= DIRTY
		if (eager(q)) enqueue(q)
		if (n.subs !== undefined) propagate(n.subs)
	}

	function enqueue(q: Proc) {
		if (queued.has(q)) return
		queued.add(q)
		effects.push(q)
	}

	// pulls: alien's run of an effect

	function pull(p: Proc) {
		const n = nodeOf(p)
		if (n.flags & RUNNING || p.state !== "running") return
		const f = n.flags
		if (
			f & DIRTY || (f & STALE && n.deps !== undefined && checkDirty(n.deps, n)) ||
			n.flags & DIRTY
		) {
			run(p)
		} else n.flags &= ~STALE
	}

	// a run: whether it wrote something new at its node
	function run(p: Proc): boolean {
		const n = nodeOf(p)
		if (p.state !== "running") return false
		const last = p.last
		const status = p.status
		n.flags = (n.flags & (MUTABLE | WATCHING)) | RUNNING
		try {
			first(p)
		} finally {
			n.flags &= ~RUNNING
		}
		return p.last !== last || p.status !== status
	}

	// reads

	// a read: the processes whose nodes it reached are pulled first, then it is read again
	function reading(
		op: string,
		f: Read,
		depend: Depend | undefined,
		ctx?: Ctx,
		args: { address?: Where; name?: string } = {},
	): unknown {
		let out = f(depend)
		const items = (Array.isArray(out) ? out : []).filter((x) => typeof x === "object") as Item<
			unknown,
			Change
		>[]
		if (op !== "children") {
			let stale: Proc[] | undefined
			// what it reached, and the processes it went through to get there
			const due = (q: Proc | undefined) => {
				if (q && q !== ctx?.p && nodeOf(q).flags & (DIRTY | STALE) && !stale?.includes(q)) {
					;(stale ??= []).push(q)
				}
			}
			for (const it of items) {
				for (const step of it.route) due(procs.get(step.node))
				if (it.node) due(procs.get(it.id))
			}
			if (stale) {
				const pulling = stale
				const before = clock.time
				request(() => {
					for (const q of pulling) pull(q)
				})
				if (clock.time !== before) out = f(undefined)
			}
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
					for (const it of items) {
						const q = it.node ? procs.get(it.id) : undefined
						if (!q) continue
						run.values.add(it.id)
						if (q !== ctx.p && depend !== undefined) link(nodeOf(q), nodeOf(ctx.p), cycle)
					}
				}
			}
		}
		return out
	}

	const given = createProcessApi(g, {
		reading,
		request,
		starter: (ctx, alive) => processes.starter(ctx, alive),
		callerOf: (ctx) => handlers.callerOf(ctx),
		cleaner: (p, alive) => processes.cleaner(p, alive),
	})

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

	const processes = createProcesses({
		g,
		clock,
		actor: hostActor,
		site: options.site,
		finder,
		procs,
		records,
		mayStart,
		cleanup: given.cleanup,
		started(p) {
			const n = nodeOf(p)
			if (eager(p)) n.flags |= WATCHING
		},
		due(p, k) {
			p.kept.set(k.by.time!, k)
			dirty(p, k.by.time!)
			// a new process is due whatever its flags: it has not run
			if (eager(p)) enqueue(p)
		},
		mark,
		ending(p) {
			const w = p.waiting
			if (w) {
				waiting.splice(waiting.indexOf(w), 1)
				p.waiting = undefined
				pass({ ends: p.id, run: w.n, ended: "stopped" })
			}
		},
		gone(p) {
			p.values = new Set()
			nodes.delete(p)
			marks.delete(p)
			queued.delete(p)
		},
	})
	const { start, replacing, part, partCall, settleChildren, cleanups } = processes

	const code = createCode({ finder, view: given.view, part })

	const handlers = createHandlers({
		g,
		pass,
		mayCall,
		given: given.handler,
		part,
		request,
		busy: () => flushing || processes.active() > 0,
		queue: (f) => void queue.push(f),
	})

	// runs: as scheduler.ts's, without ranks and stops

	function first(p: Proc) {
		const earlier = p.waiting
		if (earlier) {
			waiting.splice(waiting.indexOf(earlier), 1)
			p.waiting = undefined
			finish(earlier, "done", undefined, true)
		}
		const markTime = marks.get(p) ?? clock.time
		const n = ++p.runs
		const kept = [...p.kept.values()]
		const run: Run = {
			p,
			n,
			mark: markTime,
			rank: 0,
			given: kept,
			causes: undefined as unknown as Cause,
			reads: [],
			wrote: [],
			values: new Set(),
			replaced: p.replaced,
		}
		pass({ starts: p.id, run: n, rank: 0 })
		p.track.begin()
		try {
			const ctx: Ctx = { p, agent: runAgent(p, n), base: { run: n }, run, compute: true }
			const found = code.find(ctx)
			if (found === "pending") return finish(run, "pending")
			if (found && found !== "stopped") return finish(run, "failed", found.failed)
			const c = p.code!
			if (typeof c === "function") {
				if (p.setup && !p.replaced) return finish(run, "done")
				run.part = "setup"
				p.waiting = run
				waiting.push(run)
				return
			}
			const cctx: Ctx = { ...ctx, call: partCall(p, "compute", run.replaced) }
			let open = true
			const out = part(p, () =>
				(c.compute as (g: unknown) => unknown)(
					given.compute(cctx, kept.map((k) => k.by), () => open),
				))
			open = false
			if ("error" in out) return finish(run, "failed", out.error)
			if (out.value === PENDING) return finish(run, "pending")
			if (isPromise(out.value)) return awaiting(run, out.value as Promise<unknown>, cctx)
			computed(run, cctx, out.value)
		} finally {
			p.track.end()
		}
	}

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
		if (!equals) {
			run.why = p.last === undefined ? "a first value" : whyNew(value, p.equal !== undefined)
			records.value(p, value, shownStatus(run), run.n)
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
			call: partCall(p, run.part!, run.replaced),
		}
		if (run.part === "effect") ctx.cause = run.why
		let alive = true
		const c = p.code!
		if (run.part === "effect") {
			const effect = (c as { effect: Fn }).effect
			const e = given.effect(ctx, () => alive, run.value, p.previous)
			const out = part(p, () => (effect as (g: unknown) => unknown)(e))
			alive = false
			p.previous = { value: run.value }
			if ("error" in out) error ??= out.error
			else if (p.state === "running") settleChildren(ctx)
			return finish(run, error === undefined ? "done" : "failed", error)
		}
		const setup = given.setup(ctx, () => alive)
		const out = part(p, () => (c as (g: unknown) => unknown)(setup))
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
		if (!equals) records.value(p, value, shownStatus(run), run.n)
		finish(run, error === undefined ? "done" : "failed", error)
	}

	function finish(run: Run, ended: Ended, error?: unknown, keep = false) {
		const p = run.p
		const json = error === undefined ? undefined : errorOf(error)
		if (p.state === "running") {
			if (ended === "done" && !keep) {
				for (const k of run.given) p.kept.delete(k.by.time!)
				p.replaced = false
			}
			p.values = run.values
			const status: Status = {}
			if (ended === "pending") status.pending = run.mark
			if (ended === "failed") status.error = json
			if (run.shown) status.new = run.shown.value
			const changed = sameStatus(status, p.status) ? undefined : status
			const after = [...p.values].filter((id) =>
				id !== p.id && procs.get(id)?.state === "running"
			)
				.sort(byCodePoint)
			const made = records.run(p, run, ended, json, after, changed)
			if (made !== undefined) runs.set(made, p)
		}
		const ends: Moment = { ends: p.id, run: run.n, ended }
		if (run.equal !== undefined) ends.equal = run.equal
		if (json !== undefined) ends.error = json
		pass(ends)
	}

	// the flush: the queued pulled, their waiting halves run, the handler calls queued, until none

	function flush() {
		if (flushing) return
		flushing = true
		let pulled = 0
		try {
			while (effects.length || waiting.length || queue.length) {
				for (let i = 0; i < effects.length; i++) {
					const p = effects[i]
					queued.delete(p)
					if (p.state !== "running") continue
					if (++pulled > LIMIT) throw new Error("alien: a flush ran too long (a loop?)")
					pull(p)
				}
				effects.length = 0
				while (waiting.length) second(waiting[0])
				flushing = false
				while (queue.length && !effects.length) queue.shift()!()
				flushing = true
			}
		} finally {
			flushing = false
		}
	}

	function request<T>(fn: () => T): T {
		if (depth > 0 || processes.active() > 0) return fn()
		depth++
		let out: T | undefined
		let failed: { e: unknown } | undefined
		try {
			try {
				out = fn()
			} catch (e) {
				failed = { e }
			}
			flush()
		} finally {
			depth--
		}
		if (failed) throw failed.e
		return out as T
	}

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
			request(fn)
		},
	}
}

export type Scheduler = ReturnType<typeof createScheduler>
