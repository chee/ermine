// the scheduler: runs code, and knows nothing else. a compute is tracked: it runs again when a
// key it read changed. an effect is a compute whose value is acted on after the round's last run.
// a setup runs once, untracked. the owners tree holds them: disposing an owner takes everything
// under it.
//
// a pulse runs what is due, in rounds: a round runs the due computations by rank (rank.ts,
// order.ts), then acts on the effects' new values; acting may make more due, for another round.
// a result equal to the last stops there. it holds no values but each computation's last result:
// a compute's goes to its set, whose writer says changed(keys), and what read those keys is due.
// keys are opaque, compared by identity.
import { type Cause, createCauses } from "./causes.ts"
import { isPromise, same } from "./helpers.ts"
import { createOrder } from "./order.ts"
import { createTracker, type Node } from "./tracker.ts"

// a compute returns it while what it needs is not here: its run ends pending
export const PENDING: unique symbol = Symbol.for("ermine.pending")

export class SchedulerError extends Error {
	constructor(readonly code: "stopped" | "disposed", message: string) {
		super(message)
		this.name = "SchedulerError"
	}
}

export type Equal<T = unknown> = (a: T, b: T) => boolean
// a run's own read: after the run returned (an await), it throws stopped
export type Read = (key: unknown) => void

// an owner: the owners and computations under it, and its cleanups, in the order made
export type Owner = {
	readonly n: number
	readonly parent: Owner | undefined
	children: Owner[]
	cleanups: (() => unknown)[]
	state: "alive" | "disposing" | "gone"
}

// a computation is an owner too: what is under it goes before each run of a compute, and
// before each act of an effect
export type Computation = Owner & {
	readonly kind: "compute" | "effect"
	readonly f: (read: Read) => unknown
	readonly set?: (value: never) => void
	readonly act?: (value: never, previous: never) => void
	readonly equal?: Equal
	readonly node: Node<unknown>
	runs: number
	// a compute's: the last result given to set; an effect's: the last acted on
	last?: { value: unknown }
	// the causes of the marks since its last run that ended done (causes.ts)
	kept: Set<Cause<Computation>>
	// the writers of the keys its last run read, and the one it waits after (order.ts)
	values: Set<Computation>
	after?: Computation
	// the keys it is the writer of
	wrote: Set<unknown>
	loop?: Computation[]
	looping: boolean
	acting?: Act
}

export type Ended = "done" | "pending" | "failed" | "stopped" | "looping"

export type Moment =
	| { due: Computation; tick: number }
	| { starts: Computation; run: number; rank: number }
	| {
		ends: Computation
		run: number
		ended: Ended
		equal?: boolean
		error?: unknown
		waits?: Computation
		through?: Computation[]
	}
	| { acts: Computation; run: number; error?: unknown }

export type Options = {
	// told each moment
	hook?: (moment: Moment) => void
	// told when a promise settled: its result waits for the next pulse
	wake?: () => void
}

type Ran = {
	c: Computation
	n: number
	mark: number
	given: Cause<Computation>[]
	cause: Cause<Computation>
	values: Set<Computation>
	open: boolean
	stopped?: Computation
	loop?: Computation[]
}
type Act = { r: Ran; value: unknown }
type Out = { value: unknown } | { error: unknown }
type More = { equal?: boolean; error?: unknown; waits?: Computation; through?: Computation[] }

// thrown at a read of a key whose writer is due: the run stops, and waits after it
class Stop {}

export function createScheduler(options: Options = {}) {
	const pass = options.hook ?? (() => {})
	const wake = options.wake

	// a node per computation, and per key read
	const tracker = createTracker<unknown>()
	const nodes = new Map<unknown, Node<unknown>>()
	// each key's writer: the computation whose run or set last said it changed
	const writers = new Map<unknown, Computation>()
	const live = new Set<Computation>()
	const order = createOrder<Computation>(() => live)
	const causes = createCauses<Computation>()
	// the effects to act, in the order their runs ended; settled promises, for the next pulse
	const acts: Act[] = []
	const landed: { r: Ran; out: Out }[] = []

	let made = 0
	let tick = 0
	let pulsing = false
	// the run whose reads are tracked; the run whose changes these are, and if it writes results
	let reading: Ran | undefined
	let causing: { r: Ran; writes: boolean } | undefined

	// owners

	function owner(parent?: Owner): Owner {
		if (parent && parent.state !== "alive") throw disposed()
		const o: Owner = { n: ++made, parent, children: [], cleanups: [], state: "alive" }
		parent?.children.push(o)
		return o
	}

	// on an owner already gone, f runs now
	function cleanup(o: Owner, f: () => unknown) {
		if (o.state === "alive") o.cleanups.push(f)
		else f()
	}

	// what is under o, newest first, then its cleanups, newest first; o stays. the first error
	function clean(o: Owner): { error: unknown } | undefined {
		let failed: { error: unknown } | undefined
		const kids = o.children
		o.children = []
		for (let i = kids.length - 1; i >= 0; i--) {
			try {
				dispose(kids[i])
			} catch (e) {
				failed ??= { error: e }
			}
		}
		const fs = o.cleanups
		o.cleanups = []
		for (let i = fs.length - 1; i >= 0; i--) {
			try {
				fs[i]()
			} catch (e) {
				failed ??= { error: e }
			}
		}
		return failed
	}

	// children first, newest first, then o's cleanups, newest first. every cleanup runs; the
	// first error is thrown after
	function dispose(o: Owner) {
		if (o.state !== "alive") return
		o.state = "disposing"
		if ("kind" in o) drop(o as Computation)
		const failed = clean(o)
		o.state = "gone"
		const p = o.parent
		if (p) {
			const i = p.children.lastIndexOf(o)
			if (i >= 0) p.children.splice(i, 1)
		}
		if (failed) throw failed.error
	}

	// a computation going: not due, untracked, the writer of nothing, its act undone
	function drop(c: Computation) {
		live.delete(c)
		order.gone(c)
		tracker.untrack(c.node)
		for (const k of c.wrote) if (writers.get(k) === c) writers.delete(k)
		c.wrote.clear()
		if (c.acting) unact(c)
		c.kept.clear()
	}

	const disposed = () => new SchedulerError("disposed", "the owner is disposed")

	// computations

	function make(
		kind: "compute" | "effect",
		o: Owner,
		f: (read: Read) => unknown,
		then: (value: never, previous: never) => void,
		equal?: Equal<never>,
		key?: unknown,
	): Computation {
		if (o.state !== "alive") throw disposed()
		const c = {
			n: ++made,
			parent: o,
			children: [],
			cleanups: [],
			state: "alive",
			kind,
			f,
			[kind === "compute" ? "set" : "act"]: then,
			equal,
			runs: 0,
			kept: new Set(),
			values: new Set(),
			wrote: new Set(),
			looping: false,
		} as unknown as Computation & { node: Node<unknown> }
		c.node = tracker.node(c)
		o.children.push(c)
		live.add(c)
		// the key its results land at, given: its writer from the start, not learned
		if (key !== undefined) write(c, key)
		order.started(c)
		mark(c, ++tick)
		return c
	}

	// marks

	function mark(c: Computation, t: number, by?: Cause<Computation>) {
		if (c.state !== "alive") return
		if (by) causes.keep(c, by)
		const loop = causes.loop(by, c)
		// a run known to loop, marking itself again: not due again
		if (loop && causing?.r.c === c && causing.r.loop) return
		c.loop = loop
		// a looping computation is due again only by a change from outside the loop
		if (c.looping) {
			if (loop) return
			c.looping = false
		}
		if (order.has(c)) return
		order.set(c, t)
		pass({ due: c, tick: t })
	}

	// these keys changed: what read them is due, at the next tick. said in a computation's run or
	// a compute's set, that computation becomes their writer
	function changed(keys: readonly unknown[]): number {
		const t = ++tick
		const by = causing
		for (const key of keys) {
			if (by?.writes && by.r.c.state === "alive") write(by.r.c, key)
			const node = nodes.get(key)
			if (node === undefined) continue
			for (const l of tracker.readers(node)) mark(l.from.owner as Computation, t, by?.r.cause)
		}
		return t
	}

	function write(c: Computation, key: unknown) {
		const was = writers.get(key)
		if (was === c) return
		was?.wrote.delete(key)
		writers.set(key, c)
		c.wrote.add(key)
	}

	// reads

	// a key read in r: tracked. its writer due (and not waiting after r's), the run stops
	function track(r: Ran, key: unknown) {
		if (r.stopped) throw new Stop()
		const c = r.c
		if (c.state !== "alive") return
		let node = nodes.get(key)
		if (node === undefined) nodes.set(key, node = tracker.node(key))
		tracker.track(c.node, node)
		const w = writers.get(key)
		if (w === undefined || w === c) return
		r.values.add(w)
		if (order.has(w) && !waitsAfter(w, c)) {
			r.stopped = w
			throw new Stop()
		}
	}

	function waitsAfter(w: Computation, c: Computation): boolean {
		const seen = new Set<Computation>()
		for (let x = w.after; x && !seen.has(x); x = x.after) {
			if (x === c) return true
			seen.add(x)
		}
		return false
	}

	// the running computation read this key; outside a run, or in run(), nothing
	function read(key: unknown) {
		if (reading) track(reading, key)
	}

	// runs

	function first(c: Computation, rank: number) {
		const mark = order.at(c)!
		order.delete(c)
		order.waits(c, undefined)
		const n = ++c.runs
		const given = [...c.kept]
		const r: Ran = {
			c,
			n,
			mark,
			given,
			cause: causes.run(c, given),
			values: new Set(),
			open: true,
			loop: c.loop,
		}
		c.loop = undefined
		// an effect acts on its latest run's value only
		if (c.acting) unact(c)
		pass({ starts: c, run: n, rank })
		const before = c.kind === "compute" ? clean(c) : undefined
		const own: Read = (key) => {
			if (!r.open) throw new SchedulerError("stopped", "a read after its run returned")
			track(r, key)
		}
		let out: Out
		const was = reading
		const wasCausing = causing
		reading = r
		causing = { r, writes: true }
		tracker.begin(c.node)
		try {
			out = { value: c.f(own) }
		} catch (e) {
			out = { error: e }
		} finally {
			r.open = false
			reading = was
			causing = wasCausing
			tracker.end(c.node)
		}
		if (c.state !== "alive") return
		if (r.stopped) return stop(r)
		if (before) return finish(r, "failed", { error: before.error })
		if ("error" in out) return finish(r, "failed", { error: out.error })
		if (out.value === PENDING) return finish(r, "pending")
		if (isPromise(out.value)) return awaiting(r, out.value)
		result(r, out.value)
	}

	function stop(r: Ran) {
		order.waits(r.c, r.stopped)
		order.set(r.c, r.mark)
		finish(r, "stopped", { waits: r.stopped })
	}

	// a result: equal to the last, it stops there. a compute's goes to set; an effect's waits
	// for the acts, the latest one
	function result(r: Ran, v: unknown) {
		const c = r.c
		let equal: boolean
		try {
			equal = c.last !== undefined && same(c.equal, v, c.last.value)
		} catch (e) {
			return finish(r, "failed", { error: e })
		}
		if (r.loop && !equal) return finish(r, "looping", { equal, through: r.loop })
		if (c.kind === "effect") {
			if (!equal) acts.push(c.acting = { r, value: v })
			return finish(r, "done", { equal })
		}
		if (!equal) {
			let failed: { error: unknown } | undefined
			const was = reading
			const wasCausing = causing
			reading = undefined
			causing = { r, writes: true }
			try {
				;(c.set as (value: unknown) => void)(v)
			} catch (e) {
				failed = { error: e }
			} finally {
				reading = was
				causing = wasCausing
			}
			if (failed) return finish(r, "failed", { equal, error: failed.error })
			c.last = { value: v }
		}
		finish(r, "done", { equal })
	}

	function finish(r: Ran, ended: Ended, more: More = {}) {
		const c = r.c
		if (c.state === "alive") {
			if (ended === "done") { for (const k of r.given) c.kept.delete(k) }
			if (ended === "looping") c.looping = true
			if (ended !== "stopped") order.sees(c, r.values)
		}
		const m: Moment = { ends: c, run: r.n, ended }
		if (more.equal !== undefined) m.equal = more.equal
		if ("error" in more) m.error = more.error
		if (more.waits) m.waits = more.waits
		if (more.through) m.through = more.through
		pass(m)
	}

	// a promise: the run ends pending; its settling, unless run again or gone since, lands at the
	// next pulse
	function awaiting(r: Ran, p: PromiseLike<unknown>) {
		finish(r, "pending")
		const settle = (out: Out) => {
			if (r.c.state !== "alive" || r.c.runs !== r.n) return
			landed.push({ r, out })
			wake?.()
		}
		p.then((value) => settle({ value }), (error) => settle({ error }))
	}

	function land(r: Ran, out: Out) {
		if (r.c.state !== "alive" || r.c.runs !== r.n) return
		if ("error" in out) return finish(r, "failed", { error: out.error })
		if (out.value === PENDING) return finish(r, "pending")
		result(r, out.value)
	}

	// acts

	function unact(c: Computation) {
		acts.splice(acts.indexOf(c.acting!), 1)
		c.acting = undefined
	}

	// what is under the effect goes, then it acts, with the value it acted on last
	function act(a: Act) {
		const c = a.r.c
		c.acting = undefined
		if (c.state !== "alive") return
		let failed = clean(c)
		const was = reading
		const wasCausing = causing
		reading = undefined
		causing = { r: a.r, writes: false }
		try {
			;(c.act as (value: unknown, previous: unknown) => void)(a.value, c.last?.value)
		} catch (e) {
			failed ??= { error: e }
		} finally {
			reading = was
			causing = wasCausing
		}
		c.last = { value: a.value }
		const m: Moment = { acts: c, run: a.r.n }
		if (failed) m.error = failed.error
		pass(m)
	}

	// pulses

	// rounds until nothing is due: the settled promises land, the due run by rank, the effects
	// act. a pulse in a pulse does nothing
	function pulse() {
		if (pulsing) return
		pulsing = true
		try {
			for (;;) {
				while (landed.length) {
					const { r, out } = landed.shift()!
					land(r, out)
				}
				if (!order.size() && !acts.length) break
				while (order.size()) {
					const { p, rank } = order.next()
					first(p, rank)
				}
				while (acts.length) act(acts.shift()!)
			}
		} finally {
			pulsing = false
			causes.end()
			sweep()
		}
	}

	// keys nobody reads, forgotten now and then
	let swept = 0
	function sweep() {
		if (nodes.size < 2 * swept + 64) return
		for (const [k, node] of nodes) if (node.first === null) nodes.delete(k)
		swept = nodes.size
	}

	// once, untracked: a setup. its throw is the caller's
	function run<T>(o: Owner, f: () => T): T {
		if (o.state !== "alive") throw disposed()
		const was = reading
		reading = undefined
		try {
			return f()
		} finally {
			reading = was
		}
	}

	return {
		owner,
		cleanup,
		dispose,
		run,
		// tracked; a result not equal to the last goes to set. first runs at the next pulse. key:
		// where set's results land, when the caller knows; then readers of it wait for this compute
		// from the first pulse, rather than once it has written
		compute: <T>(
			o: Owner,
			f: (read: Read) => T | PromiseLike<T> | typeof PENDING,
			set: (value: T) => void,
			equal?: Equal<T>,
			key?: unknown,
		): Computation => make("compute", o, f, set, equal as Equal<never>, key),
		// tracked; a result not equal to the one it last acted on is acted on after the round's
		// last run. first runs at the next pulse
		effect: <T>(
			o: Owner,
			f: (read: Read) => T | PromiseLike<T> | typeof PENDING,
			act: (value: T, previous: T | undefined) => void,
			equal?: Equal<T>,
		): Computation => make("effect", o, f, act, equal as Equal<never>),
		read,
		changed,
		pulse,
		// the scheduler's counter: each change and each new computation takes the next
		tick: () => tick,
	}
}

export type Scheduler = ReturnType<typeof createScheduler>
