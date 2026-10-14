// the scheduler: runs code. a compute is tracked: it runs again when a
// key it read changed. an effect is a compute whose value is acted on after the round's last run.
// a setup runs once, untracked. the scopes tree holds them: disposing a scope takes everything
// under it.
//
// a scope is two things, one tree: an owner (what is made in it is put under it) and the info of
// the changes made in it: pairs, [key, value] in order, opaque, as keys are. a write's pairs: the
// info of each scope from the root down to the one open, outermost first. scope(info, parent?)
// makes one under parent, else under the one open; root(info) one with no parent. a scope is open
// only in a bracket, while its code is on the stack: run(scope, f), and the scheduler's own. a
// computation is a scope under the one open when it was made; its runs, sets and acts open it,
// written by itself (a run by its own read, a set or act by the computation). its info is its
// latest run's, set as the run starts: its number, the tick of the mark that made it due. a
// cleanup opens its scope, and what is under a scope goes with it open: a cleanup on a plain
// scope under a computation, run by the computation's clean or dispose, is written by it.
// nothing open: making a scope, a computation or a cleanup is unscoped.
//
// a pulse runs what is due, in rounds: a round runs the due computations by rank (rank.ts,
// order.ts), then acts on the effects' new values; acting may make more due, for another round.
// a result equal to the last stops there. it holds no values but each computation's last result:
// a compute's goes to its set, whose writer says changed(keys, by), and what read those keys is
// due. keys are opaque, compared by identity.
//
// by: who made the change, told by the caller, never guessed from what is running. a caller who
// knows the writer passes it: the writer open (current().by: whoever opened the scope said it),
// a run's own read (that run), or a computation (its latest run). a compute named so becomes the
// keys' writer (its readers wait for it while it is due), and the change carries the run's cause
// (loops, causes.ts). without by the change is from outside (the host, sync): no writer learned,
// no cause. run(scope, f) keeps the writer open: a call made in a run is that run's doing.
//
// a run lasts until its function returns; for an async function, until its first await. only
// reads made while it lasts are its reads: read what you need before you await. after, the run's
// own read throws stopped, the global read (read(key)) counts for nothing, and nothing is open:
// no scope, so nothing is made there and no write is somebody else's. why: javascript has no
// async context, so after an await nothing says which run the code is part of; every bracket has
// closed by then, as code after an await runs on an empty stack. the web has the same rule for
// the same reason: a handler's preventDefault() after an await does nothing, the event is already
// gone
import { type Cause, createCauses } from "./causes.ts"
import { isPromise, same } from "./helpers.ts"
import { createOrder } from "./order.ts"
import { createTracker, type Node } from "./tracker.ts"

// a compute returns it, or throws it (itself, not an error wrapping it), while what it needs is
// not here: its run ends pending (nothing set, its last result kept, an effect does not act). so
// a read of something pending can throw it, and every compute above it is pending unasked. a
// promise resolved to it, or rejected with it, lands pending
export const PENDING: unique symbol = Symbol.for("ermine.pending")

export class SchedulerError extends Error {
	constructor(readonly code: "stopped" | "disposed" | "unscoped", message: string) {
		super(message)
		this.name = "SchedulerError"
	}
}

export type Equal<T = unknown> = (a: T, b: T) => boolean
// a run's own read: after the run returned (an await), it throws stopped
export type Read = (key: unknown) => void

export type Pair = readonly [key: string, value: unknown]

// a scope: the scopes and computations under it, and its cleanups, in the order made; its info,
// kept as given (never change it). a computation's: its latest run's
export type Scope = {
	readonly n: number
	readonly parent: Scope | undefined
	info: readonly Pair[]
	children: Scope[]
	cleanups: (() => unknown)[]
	state: "alive" | "disposing" | "gone"
}

// what is open: the scope, the pairs of a write made now (the info of each scope from the root
// down to it), and its writer; none: from outside
export type Open = { readonly scope: Scope; readonly pairs: readonly Pair[]; readonly by?: By }

// a computation is a scope too: what is under it goes before each run of a compute, and
// before each act of an effect
export type Computation = Scope & {
	readonly kind: "compute" | "effect"
	readonly f: (read: Read) => unknown
	readonly set?: (value: never) => void
	readonly act?: (value: never, previous: never) => void
	readonly equal?: Equal
	readonly node: Node<unknown>
	runs: number
	// a compute's: the last result given to set; an effect's: the last acted on
	last?: { value: unknown }
	// its latest run: what by names when it is given the computation
	ran?: Ran
	// an effect's: at its last act, the scopes made up to then and its cleanups' count. what was
	// made under it since goes before each run
	acted: [number, number]
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
	// by: the computation of the run that made the change, when told
	| { due: Computation; tick: number; by?: Computation }
	| { starts: Computation; run: number; rank: number }
	| {
		ends: Computation
		run: number
		ended: Ended
		// every read the run made, in order, a key read again read again (the tracker keeps it
		// once): the keys as read
		reads: readonly unknown[]
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
	// told each key it stops tracking: one nobody reads any more, at once when its last reader's
	// run did not read it again or its last reader was disposed (a sweep now and then catches any
	// other)
	forget?: (key: unknown) => void
}

// who made a change: a run's own read (that run), or a computation (its latest run)
export type By = Read | Computation

// a run. pulse: the pulse its cause is of (causeOf). cut: a loop mark it made was dropped
export type Ran = {
	c: Computation
	n: number
	mark: number
	pulse: number
	given: Cause<Computation>[]
	cause: Cause<Computation>
	values: Set<Computation>
	// the keys it read, in order, for the moment it ends (kept only for a hook)
	reads: unknown[]
	open: boolean
	stopped?: Computation
	loop?: Computation[]
	cut?: boolean
}
type Act = { r: Ran; value: unknown }
type Out = { value: unknown } | { error: unknown }
type More = { equal?: boolean; error?: unknown; waits?: Computation; through?: Computation[] }

// thrown at a read of a key whose writer is due: the run stops, and waits after it
class Stop {}

const nothing: readonly Pair[] = Object.freeze([])

export function createScheduler(options: Options = {}): Scheduler {
	const pass = options.hook ?? (() => {})
	// a run's reads, in order, are kept for the hook only
	const trace = options.hook !== undefined
	const wake = options.wake
	const forget = options.forget

	// a node per computation, and per key read
	const tracker = createTracker<unknown>()
	const nodes = new Map<unknown, Node<unknown>>()
	// each key's writer: the compute last named by a change of it
	const writers = new Map<unknown, Computation>()
	// each run's own read, to the run: what by names
	const handles = new WeakMap<Read, Ran>()
	const live = new Set<Computation>()
	const order = createOrder<Computation>(() => live)
	const causes = createCauses<Computation>()
	// the effects to act, in the order their runs ended; settled promises, for the next pulse
	const acts: Act[] = []
	const landed: { r: Ran; out: Out }[] = []

	let made = 0
	let tick = 0
	// pulses ended: the one going on, or next
	let pulses = 0
	let pulsing = false
	// the run whose reads are tracked; the run whose f, set, act or cleanups are going on (what
	// is made then carries its cause)
	let reading: Ran | undefined
	let running: Ran | undefined
	// what is open: the scope, and the writer; none: undefined
	let open: { scope: Scope; by?: By } | undefined

	// scopes

	// f with next open, whole: what was open before is back after, whatever f did
	function enter<T>(next: typeof open, f: () => T): T {
		const was = open
		open = next
		try {
			return f()
		} finally {
			open = was
		}
	}

	// the scope open, to make something under: none, unscoped; gone, disposed
	function parent(): Scope {
		if (open === undefined) throw unscoped()
		if (open.scope.state !== "alive") throw disposed()
		return open.scope
	}

	function grow(up: Scope | undefined, info: Iterable<Pair>): Scope {
		const o: Scope = {
			n: ++made,
			parent: up,
			info: [...info],
			children: [],
			cleanups: [],
			state: "alive",
		}
		up?.children.push(o)
		return o
	}

	// a new scope under up, else under the one open; gone: disposed
	function scope(info: Iterable<Pair> = nothing, up?: Scope): Scope {
		if (up === undefined) return grow(parent(), info)
		if (up.state !== "alive") throw disposed()
		return grow(up, info)
	}

	// what is open, with the pairs of a write made now; nothing: undefined
	function current(): Open | undefined {
		if (open === undefined) return
		const chain: Scope[] = []
		for (let o: Scope | undefined = open.scope; o; o = o.parent) chain.push(o)
		const pairs: Pair[] = []
		for (let i = chain.length - 1; i >= 0; i--) pairs.push(...chain[i].info)
		return { scope: open.scope, pairs, by: open.by }
	}

	// a cleanup opens its scope: a computation's written by it, any other's by the writer open
	const opens = (o: Scope) => ({ scope: o, by: "kind" in o ? o as Computation : open?.by })

	// on the scope open; already gone, f runs now
	function cleanup(f: () => unknown) {
		if (open === undefined) throw unscoped()
		const o = open.scope
		if (o.state === "alive") o.cleanups.push(f)
		else enter(opens(o), f)
	}

	// what is under o, newest first, then its cleanups, newest first; o stays. the first error.
	// after, from: only the scopes made after the after-th, and the cleanups from the from-th on.
	// what is under o goes with o open, as its cleanups do: under a computation, written by it
	function clean(o: Scope, after = 0, from = 0): { error: unknown } | undefined {
		let failed: { error: unknown } | undefined
		let k = o.children.length
		while (k > 0 && o.children[k - 1].n > after) k--
		const kids = o.children.slice(k)
		o.children.length = k
		enter(opens(o), () => {
			for (let i = kids.length - 1; i >= 0; i--) {
				try {
					dispose(kids[i])
				} catch (e) {
					failed ??= { error: e }
				}
			}
		})
		const fs = o.cleanups.slice(from)
		o.cleanups.length = Math.min(from, o.cleanups.length)
		for (let i = fs.length - 1; i >= 0; i--) {
			try {
				enter(opens(o), fs[i])
			} catch (e) {
				failed ??= { error: e }
			}
		}
		return failed
	}

	// children first, newest first, then o's cleanups, newest first. every cleanup runs; the
	// first error is thrown after
	function dispose(o: Scope) {
		if (o.state !== "alive") return
		o.state = "disposing"
		if ("kind" in o) drop(o as Computation)
		const failed = clean(o)
		o.state = "gone"
		// gone: by it names no run
		if ("kind" in o) (o as Computation).ran = undefined
		const p = o.parent
		if (p) {
			const i = p.children.lastIndexOf(o)
			if (i >= 0) p.children.splice(i, 1)
		}
		if (failed) throw failed.error
	}

	// a computation going: not due, untracked, the writer of nothing, its act undone. the keys
	// nobody reads now are forgotten
	function drop(c: Computation) {
		live.delete(c)
		order.gone(c)
		const read = tracker.reads(c.node)
		tracker.untrack(c.node)
		for (const node of read) unread(node)
		for (const k of c.wrote) if (writers.get(k) === c) writers.delete(k)
		c.wrote.clear()
		if (c.acting) unact(c)
		c.kept.clear()
	}

	const disposed = () => new SchedulerError("disposed", "the scope is disposed")
	const unscoped = () => new SchedulerError("unscoped", "no scope is open")

	// a key nobody reads now: forgotten
	function unread(node: Node<unknown>) {
		if (node.first !== null || nodes.get(node.owner) !== node) return
		nodes.delete(node.owner)
		forget?.(node.owner)
	}

	// a run's end: the tracker drops the links after its cursor, what the run did not read
	// again; the keys nobody reads now are forgotten
	function end(n: Node<unknown>) {
		let l = n.cursor !== null ? n.cursor.next : n.reads
		if (l === null) return tracker.end(n)
		const stale: Node<unknown>[] = []
		for (; l !== null; l = l.next) stale.push(l.to)
		tracker.end(n)
		for (const node of stale) unread(node)
	}

	// computations

	// a scope under the one open
	function make(
		kind: "compute" | "effect",
		f: (read: Read) => unknown,
		then: (value: never, previous: never) => void,
		equal?: Equal<never>,
		key?: unknown,
	): Computation {
		const o = parent()
		const c = {
			n: ++made,
			parent: o,
			info: nothing,
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
		c.acted = [c.n, 0]
		c.node = tracker.node(c)
		o.children.push(c)
		live.add(c)
		// the key its results land at, given: its writer from the start, not learned
		if (key !== undefined) write(c, key)
		order.started(c)
		// made in a run, set, act or cleanup: it carries that run's cause, so a loop through what
		// it changes is seen. made in a run known to loop: the loop is cut there, as a dropped
		// loop mark cuts it
		if (running?.loop) running.cut = true
		mark(c, ++tick, running)
		return c
	}

	// marks

	// a run's cause; one from an earlier pulse is cut to its computation alone, of this pulse:
	// nothing is kept past the pulse
	function causeOf(r: Ran): Cause<Computation> {
		if (r.pulse !== pulses) {
			r.cause = causes.run(r.c, [])
			r.pulse = pulses
		}
		return r.cause
	}

	// by: the run that made the change
	function mark(c: Computation, t: number, by?: Ran) {
		if (c.state !== "alive") return
		const cause = by && causeOf(by)
		if (cause) causes.keep(c, cause)
		const loop = causes.loop(cause, c)
		// a loop mark from a run known to loop: the loop is cut there, and the run ends looping
		if (loop && by!.loop) {
			by!.cut = true
			return
		}
		c.loop = loop
		// a looping computation is due again only by a change from outside the loop
		if (c.looping) {
			if (loop) return
			c.looping = false
		}
		if (order.has(c)) return
		order.set(c, t)
		pass(by ? { due: c, tick: t, by: by.c } : { due: c, tick: t })
	}

	// these keys changed: what read them is due, at the next tick. by: who made the change (the
	// header); a compute named so becomes their writer. an effect is no one's writer: it writes
	// in its acts, after the round's runs
	function changed(keys: readonly unknown[], by?: By): number {
		const t = ++tick
		const r = by === undefined ? undefined : typeof by === "function" ? handles.get(by) : by.ran
		const w = r?.c.kind === "compute" && r.c.state === "alive" ? r.c : undefined
		for (const key of keys) {
			if (w) write(w, key)
			const node = nodes.get(key)
			if (node === undefined) continue
			for (const l of tracker.readers(node)) mark(l.from.owner as Computation, t, r)
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

	// a key read in r: tracked. its writer due, the run stops: unless the writer waits after r's,
	// or is due by r's own doing (a loop, with no after in it)
	function track(r: Ran, key: unknown) {
		if (r.stopped) throw new Stop()
		const c = r.c
		if (c.state !== "alive") return
		let node = nodes.get(key)
		if (node === undefined) nodes.set(key, node = tracker.node(key))
		tracker.track(c.node, node)
		if (trace) r.reads.push(key)
		const w = writers.get(key)
		if (w === undefined || w === c) return
		r.values.add(w)
		if (order.has(w) && !waitsAfter(w, c) && !causes.from(w, c)) {
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
			pulse: pulses,
			given,
			cause: causes.run(c, given),
			values: new Set(),
			reads: [],
			open: true,
			loop: c.loop,
		}
		c.loop = undefined
		c.ran = r
		// an effect acts on its latest run's value only
		if (c.acting) unact(c)
		pass({ starts: c, run: n, rank })
		const own: Read = (key) => {
			if (!r.open) throw new SchedulerError("stopped", "a read after its run returned")
			track(r, key)
		}
		handles.set(own, r)
		const was = reading
		const wasRunning = running
		running = r
		// what is under it goes first: all of a compute's; of an effect's, what was made since its
		// last act. disposed by a cleanup: nothing more
		const before = c.kind === "compute" ? clean(c) : clean(c, ...c.acted)
		if (c.state !== "alive") {
			running = wasRunning
			return
		}
		// its info, from here: this run's number, and the tick of the mark that made it due
		c.info = [["run", n], ["mark", mark]]
		let out: Out
		reading = r
		tracker.begin(c.node)
		try {
			out = { value: enter({ scope: c, by: own }, () => c.f(own)) }
		} catch (e) {
			out = e === PENDING ? { value: PENDING } : { error: e }
		} finally {
			r.open = false
			reading = was
			running = wasRunning
			end(c.node)
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
		// no mark reached it in the stopped run: it runs again as flagged as it was
		if (!order.has(r.c)) r.c.loop = r.loop
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
		// flagged: a new result, or a loop it cut, ends looping
		if (r.loop && (!equal || r.cut)) return finish(r, "looping", { equal, through: r.loop })
		if (c.kind === "effect") {
			if (!equal) acts.push(c.acting = { r, value: v })
			return finish(r, "done", { equal })
		}
		if (!equal) {
			let failed: { error: unknown } | undefined
			const was = reading
			const wasRunning = running
			reading = undefined
			running = r
			try {
				enter({ scope: c, by: c }, () => (c.set as (value: unknown) => void)(v))
			} catch (e) {
				failed = { error: e }
			} finally {
				reading = was
				running = wasRunning
			}
			// a set that threw may have written part: the last is forgotten, so the next result is
			// given to set, equal or not
			if (failed) {
				c.last = undefined
				return finish(r, "failed", { equal, error: failed.error })
			}
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
		const m: Moment = { ends: c, run: r.n, ended, reads: r.reads }
		if (more.equal !== undefined) m.equal = more.equal
		if ("error" in more) m.error = more.error
		if (more.waits) m.waits = more.waits
		if (more.through) m.through = more.through
		pass(m)
	}

	// a promise: the run ends pending; its settling, unless run again or gone since, lands at the
	// next pulse. due again by then (what it read changed): it lands nowhere, the next run does
	function awaiting(r: Ran, p: PromiseLike<unknown>) {
		finish(r, "pending")
		const settle = (out: Out) => {
			if (r.c.state !== "alive" || r.c.runs !== r.n) return
			landed.push({ r, out })
			wake?.()
		}
		p.then(
			(value) => settle({ value }),
			(error) => settle(error === PENDING ? { value: PENDING } : { error }),
		)
	}

	function land(r: Ran, out: Out) {
		if (r.c.state !== "alive" || r.c.runs !== r.n || order.has(r.c)) return
		if ("error" in out) return finish(r, "failed", { error: out.error })
		if (out.value === PENDING) return finish(r, "pending")
		result(r, out.value)
	}

	// acts

	function unact(c: Computation) {
		acts.splice(acts.indexOf(c.acting!), 1)
		c.acting = undefined
	}

	// what is under the effect goes, then it acts, with the value it acted on last. due again (an
	// earlier act this round changed what it read): its value is old, so it does not act; its
	// next run does. disposed by a cleanup: nothing more
	function act(a: Act) {
		const c = a.r.c
		c.acting = undefined
		if (c.state !== "alive" || order.has(c)) return
		const was = reading
		const wasRunning = running
		reading = undefined
		running = a.r
		let failed = clean(c)
		if (c.state !== "alive") {
			reading = was
			running = wasRunning
			return
		}
		try {
			const act = c.act as (value: unknown, previous: unknown) => void
			enter({ scope: c, by: c }, () => act(a.value, c.last?.value))
		} catch (e) {
			failed ??= { error: e }
		} finally {
			reading = was
			running = wasRunning
		}
		c.last = { value: a.value }
		c.acted = [made, c.cleanups.length]
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
			pulses++
			sweep()
		}
	}

	// keys nobody reads, forgotten now and then: any the ends and disposals left
	let swept = 0
	function sweep() {
		if (nodes.size < 2 * swept + 64) return
		for (const node of nodes.values()) unread(node)
		swept = nodes.size
	}

	// once, untracked, with o open, the writer open the same: a setup, a host's write, a call.
	// its throw is the caller's
	function run<T>(o: Scope, f: () => T): T {
		if (o.state !== "alive") throw disposed()
		const was = reading
		reading = undefined
		try {
			return enter({ scope: o, by: open?.by }, f)
		} finally {
			reading = was
		}
	}

	return {
		root: (info: Iterable<Pair> = nothing) => grow(undefined, info),
		scope,
		current,
		cleanup,
		dispose,
		run,
		// tracked; a result not equal to the last goes to set. first runs at the next pulse. key:
		// where set's results land, when the caller knows; then readers of it wait for this compute
		// from the first pulse, rather than once it has written
		compute: <T>(
			f: (read: Read) => T | PromiseLike<T> | typeof PENDING,
			set: (value: T) => void,
			equal?: Equal<T>,
			key?: unknown,
		): Computation => make("compute", f, set, equal as Equal<never>, key),
		// tracked; a result not equal to the one it last acted on is acted on after the round's
		// last run. first runs at the next pulse
		effect: <T>(
			f: (read: Read) => T | PromiseLike<T> | typeof PENDING,
			act: (value: T, previous: T | undefined) => void,
			equal?: Equal<T>,
		): Computation => make("effect", f, act, equal as Equal<never>),
		read,
		changed,
		pulse,
		// the scheduler's counter: each change and each new computation takes the next
		tick: () => tick,
	}
}

export type Scheduler = {
	root: (info?: Iterable<Pair>) => Scope
	scope: (info?: Iterable<Pair>, parent?: Scope) => Scope
	current: () => Open | undefined
	cleanup: (f: () => unknown) => void
	dispose: (o: Scope) => void
	run: <T>(o: Scope, f: () => T) => T
	compute: <T>(
		f: (read: Read) => T | PromiseLike<T> | typeof PENDING,
		set: (value: T) => void,
		equal?: Equal<T>,
		key?: unknown,
	) => Computation
	effect: <T>(
		f: (read: Read) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, previous: T | undefined) => void,
		equal?: Equal<T>,
	) => Computation
	read: (key: unknown) => void
	changed: (keys: readonly unknown[], by?: By) => number
	pulse: () => void
	tick: () => number
}
