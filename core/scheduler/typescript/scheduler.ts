// the scheduler: runs code. a computer is tracked: it runs again when a key it tracked was
// marked. an effect is a computer whose value is acted on after the round's last run. a setup runs
// once, untracked. the scopes tree holds them: tearing a scope down takes everything under it.
//
// a scope is two things, one tree: an owner (what is made in it is put under it) and the info of
// the changes made in it: pairs, [key, value] in order, opaque, as keys are. a write's pairs: the
// info of each scope from the root down to the one open, outermost first (getInfo).
// createScope(info, parent?) makes one under parent, else under the one open; createRootScope(info)
// one with no parent. a scope is open only in a bracket, while its code is on the stack:
// runWithScope(scope, f), and the scheduler's own. a computer is a scope under the one open when
// it was made; its runs, sets and acts open it, written by itself (a run by its own Run, a set or
// act by the computer). its info is its latest run's, set as the run starts: its number, the tick
// of the mark that made it due. a teardown opens its scope, and what is under a scope goes with it
// open: a teardown on a plain scope under a computer, run by the computer's clean or teardown, is
// written by it. nothing open: making a scope or a computer is unscoped.
//
// a pulse runs what is due, in rounds: a round runs the due computations by rank (rank.ts,
// order.ts), then acts on the effects' new values; acting may make more due, for another round.
// a result equal to the last stops there. it holds no values but each computation's last result:
// a compute's goes to its set, whose writer says mark(keys, run), and what tracked those keys is
// due. keys are opaque, compared by identity.
//
// the run: who made the change, told by the caller, never guessed from what is running. a caller
// who knows it passes it: the run open (getRun(): whoever opened the scope said it; in a run, that
// run), kept from before an await for a write after it, or a computer (its latest run). a compute
// named so becomes the keys' writer (what tracked them waits for it while it is due), and the
// change carries the run's cause (loops, causes.ts). with none the change is from outside (the
// host, sync): no writer learned, no cause. runWithScope(scope, f) keeps the run open: a call made
// in a run is that run's doing.
//
// a run lasts until its function returns; for an async function, until its first await. only
// keys tracked while it lasts are its: read what you need before you await. after, a track counts
// for nothing, and nothing is open:
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
	constructor(readonly code: "disposed" | "unscoped", message: string) {
		super(message)
		this.name = "SchedulerError"
	}
}

export type Equal<T = unknown> = (a: T, b: T) => boolean
// one time a computer ran: the run open while it runs (getRun()), kept for a write after an await
export type Run = { readonly computer: Computer; readonly n: number }

export type Pair = readonly [key: string, value: unknown]

// a scope: the scopes and computers under it, and its teardowns, in the order made; its info,
// kept as given (never change it). a computer's: its latest run's
export type Scope = {
	readonly n: number
	readonly parent: Scope | undefined
	info: readonly Pair[]
	children: Scope[]
	teardowns: (() => unknown)[]
	state: "alive" | "disposing" | "gone"
}

// a computer is a scope too: what is under it goes before each run of a compute, and before each
// act of an effect
export type Computer = Scope & {
	readonly kind: "compute" | "effect"
	readonly f: (previous: unknown) => unknown
	readonly set?: (value: never) => void
	readonly effect?: (value: never, previous: never) => void
	readonly equal?: Equal
	readonly node: Node<unknown>
	runs: number
	// a compute's: the last result given to set; an effect's: the last acted on
	last?: { value: unknown }
	// its latest run: what it names when it is given as the run of a change
	ran?: Ran
	// an effect's: at its last act, the scopes made up to then and its teardowns' count. what was
	// made under it since goes before each run
	acted: [number, number]
	// the causes of the marks since its last run that ended done (causes.ts): never a run's
	// given, which its cause holds
	kept: Cause<Computer>[]
	// the pulse it last ran in, and last kept a cause in (causes.ts)
	ranIn: number
	heldIn: number
	// the writers of the keys its last run read, no repeats, and the one it waits after; the
	// tick it became due at (0: not due), its rank and the making it is of, what is after it,
	// a stamp (order.ts)
	values: Computer[]
	after?: Computer
	due: number
	rank: number
	ranked: number
	afters: Map<Computer, number> | undefined
	stamp: number
	// the last run that read a key this one writes, by its number (no repeats in values)
	seen: number
	// the keys it is the writer of
	wrote: Set<unknown>
	loop?: Computer[]
	looping: boolean
	acting?: Act
}

// how a run ended
export type Ended = "done" | "pending" | "failed" | "stopped" | "looping"

// what more a run's end says: its result equal to the last; what it threw; the computer it waits
// after (stopped); the loop it went through (looping)
export type More = {
	equal?: boolean
	error?: unknown
	waits?: Computer
	through?: Computer[]
}

// who made a change: a run, or a computer (its latest run)
type By = Run | Computer

// a run, inside. own: its Run. pulse: the pulse its cause is of (causeOf). cut: a loop mark it
// made was dropped
type Ran = {
	c: Computer
	own: Run
	n: number
	mark: number
	pulse: number
	given: readonly Cause<Computer>[]
	cause: Cause<Computer>
	values: Computer[]
	// its number among all runs (seen)
	id: number
	// the keys it tracked, in order, for its end (kept only while someone listens to onRunEnd;
	// none till then)
	reads: unknown[]
	stopped?: Computer
	loop?: Computer[]
	cut?: boolean
}
type Act = { r: Ran; value: unknown }
type Out = { value: unknown } | { error: unknown }

// listeners, each told in the order added; adding gives back the remove
function told<A extends unknown[]>() {
	const t = {
		fs: [] as ((...a: A) => void)[],
		on: (f: (...a: A) => void) => {
			if (!t.fs.includes(f)) t.fs = [...t.fs, f]
			return () => void (t.fs = t.fs.filter((g) => g !== f))
		},
	}
	return t
}

// thrown at a read of a key whose writer is due: the run stops, and waits after it
class Stop {}

const nothing: readonly Pair[] = Object.freeze([])
// an empty list shared, never added to
const none = Object.freeze([]) as never[]

// a Run carries the run inside, under a key only this file has
const inside: unique symbol = Symbol("inside")
type Own = Run & { [inside]: Ran }

export function createScheduler(): Scheduler {
	const tracks = told<[key: unknown, run: Run]>()
	const marks = told<
		[
			keys: readonly unknown[],
			run: Run | undefined,
			due: Computer[],
			tick: number,
		]
	>()
	const starts = told<[computer: Computer, n: number, rank: number]>()
	const ends = told<
		[
			computer: Computer,
			n: number,
			ended: Ended,
			reads: readonly unknown[],
			more: More,
		]
	>()
	const effects = told<
		[computer: Computer, n: number, more: { error?: unknown }]
	>()
	const settles = told<[]>()
	const afterPulses = told<[]>()
	const untracks = told<[key: unknown]>()
	const firstTracks = told<[key: unknown]>()

	// a node per computation, and per key read
	const tracker = createTracker<unknown>()
	// a key untracked stays as undefined (a Map losing and gaining the same key slows as it grows, in
	// V8): nodes is made again once they are half
	let nodes = new Map<unknown, Node<unknown> | undefined>()
	let untracked = 0
	// each key's writer: the compute last named by a change of it
	const writers = new Map<unknown, Computer>()
	const live = new Set<Computer>()
	const order = createOrder<Computer>(() => live)
	const causes = createCauses<Computer>()
	// the effects to act, in the order their runs ended; settled promises, for the next pulse
	const acts: Act[] = []
	const landed: { r: Ran; out: Out }[] = []

	let made = 0
	// runs, all told
	let runs = 0
	let tick = 0
	// pulses ended: the one going on, or next
	let pulses = 0
	let pulsing = false
	// the run whose tracks count; the run whose f, set, act or teardowns are going on (what is
	// made then carries its cause)
	let reading: Ran | undefined
	let running: Ran | undefined
	// what is open: the scope, and who a change made now is by; none: undefined
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
			teardowns: [],
			state: "alive",
		}
		up?.children.push(o)
		return o
	}

	// a new scope under up, else under the one open; gone: disposed
	function createScope(info: Iterable<Pair> = nothing, up?: Scope): Scope {
		if (up === undefined) return grow(parent(), info)
		if (up.state !== "alive") throw disposed()
		return grow(up, info)
	}

	// the pairs of a write made now: the info of each scope from the root down to the one open;
	// nothing open: undefined
	function getInfo(): readonly Pair[] | undefined {
		if (open === undefined) return
		const chain: Scope[] = []
		for (let o: Scope | undefined = open.scope; o; o = o.parent) chain.push(o)
		const pairs: Pair[] = []
		for (let i = chain.length - 1; i >= 0; i--) pairs.push(...chain[i].info)
		return pairs
	}

	// the run a change made now is by: in a run, that run; in a computer's set, act or teardown,
	// its latest run; else what was open when the scope was opened; none: undefined
	function getRun(): Run | undefined {
		const by = open?.by
		return by === undefined || !("kind" in by) ? by : by.ran?.own
	}

	// a teardown opens its scope: a computer's by it, any other's by the run open
	const opens = (o: Scope) => ({
		scope: o,
		by: "kind" in o ? o as Computer : open?.by,
	})

	// on scope; already gone, f runs now
	function registerTeardown(o: Scope, f: () => unknown) {
		if (o.state === "alive") o.teardowns.push(f)
		else enter(opens(o), f)
	}

	// what is under o, newest first, then its teardowns, newest first; o stays. the first error.
	// after, from: only the scopes made after the after-th, and the teardowns from the from-th on.
	// what is under o goes with o open, as its teardowns do: under a computer, by it
	function clean(
		o: Scope,
		after = 0,
		from = 0,
	): { error: unknown } | undefined {
		let failed: { error: unknown } | undefined
		let k = o.children.length
		while (k > 0 && o.children[k - 1].n > after) k--
		const kids = o.children.slice(k)
		o.children.length = k
		enter(opens(o), () => {
			for (let i = kids.length - 1; i >= 0; i--) {
				try {
					teardown(kids[i])
				} catch (e) {
					failed ??= { error: e }
				}
			}
		})
		const fs = o.teardowns.slice(from)
		o.teardowns.length = Math.min(from, o.teardowns.length)
		for (let i = fs.length - 1; i >= 0; i--) {
			try {
				enter(opens(o), fs[i])
			} catch (e) {
				failed ??= { error: e }
			}
		}
		return failed
	}

	// children first, newest first, then o's teardowns, newest first. every teardown runs; the
	// first error is thrown after
	function teardown(o: Scope) {
		if (o.state !== "alive") return
		o.state = "disposing"
		if ("kind" in o) drop(o as Computer)
		const failed = clean(o)
		o.state = "gone"
		// gone: as the run of a change it names none
		if ("kind" in o) (o as Computer).ran = undefined
		const p = o.parent
		if (p) {
			const i = p.children.lastIndexOf(o)
			if (i >= 0) p.children.splice(i, 1)
		}
		if (failed) throw failed.error
	}

	// a computer going: not due, untracked, the writer of nothing, its act undone. the keys nobody
	// tracks now are untracked
	function drop(c: Computer) {
		live.delete(c)
		order.gone(c)
		const read = tracker.reads(c.node)
		tracker.untrack(c.node)
		for (const node of read) unread(node)
		for (const k of c.wrote) if (writers.get(k) === c) writers.delete(k)
		c.wrote.clear()
		if (c.acting) unact(c)
		c.kept.length = 0
	}

	const disposed = () => new SchedulerError("disposed", "the scope is disposed")
	const unscoped = () => new SchedulerError("unscoped", "no scope is open")

	// a key nobody tracks now: untracked, and told
	function unread(node: Node<unknown>) {
		if (node.first !== null || nodes.get(node.owner) !== node) return
		nodes.set(node.owner, undefined)
		if (++untracked > nodes.size >> 1 && nodes.size > 64) {
			const kept = new Map<unknown, Node<unknown> | undefined>()
			for (const [k, n] of nodes) if (n !== undefined) kept.set(k, n)
			nodes = kept
			untracked = 0
		}
		for (const f of untracks.fs) f(node.owner)
	}

	// a run's end: the tracker drops the links after its cursor, what the run did not track
	// again; the keys nobody tracks now are untracked
	function end(n: Node<unknown>) {
		let l = n.cursor !== null ? n.cursor.next : n.reads
		if (l === null) return tracker.end(n)
		const stale: Node<unknown>[] = []
		for (; l !== null; l = l.next) stale.push(l.to)
		tracker.end(n)
		for (const node of stale) unread(node)
	}

	// computers

	// a scope under the one open
	function make(
		kind: "compute" | "effect",
		f: (previous: unknown) => unknown,
		then: (value: never, previous: never) => void,
		equal?: Equal<never>,
		key?: unknown,
	): Computer {
		const o = parent()
		const c = {
			n: ++made,
			parent: o,
			info: nothing,
			children: [],
			teardowns: [],
			state: "alive",
			kind,
			f,
			[kind === "compute" ? "set" : "effect"]: then,
			equal,
			runs: 0,
			kept: [],
			ranIn: 0,
			heldIn: 0,
			values: [],
			due: 0,
			rank: 0,
			ranked: 0,
			afters: undefined,
			stamp: 0,
			seen: 0,
			wrote: new Set(),
			looping: false,
		} as unknown as Computer & { node: Node<unknown> }
		c.acted = [c.n, 0]
		c.node = tracker.node(c)
		o.children.push(c)
		live.add(c)
		// the key its results land at, given: its writer from the start, not learned
		if (key !== undefined) write(c, key)
		order.started(c)
		// made in a run, set, act or teardown: it carries that run's cause, so a loop through what
		// it changes is seen. made in a run known to loop: the loop is cut there, as a dropped
		// loop mark cuts it
		if (running?.loop) running.cut = true
		const t = ++tick
		const now = due(c, t, running) ? [c] : []
		for (const f of marks.fs) f([], running?.own, now, t)
		return c
	}

	// marks

	// a run's cause; one from an earlier pulse is cut to its computation alone, of this pulse:
	// nothing is kept past the pulse
	function causeOf(r: Ran): Cause<Computer> {
		if (r.pulse !== pulses) {
			r.cause = causes.run(r.c, [])
			r.pulse = pulses
		}
		return r.cause
	}

	// c due, by the run that made the change: true when it was not already
	function due(c: Computer, t: number, by?: Ran): boolean {
		if (c.state !== "alive") return false
		// a run since run again: no loop through its changes
		const cause = by && by === by.c.ran ? causeOf(by) : undefined
		if (cause) causes.keep(c, cause)
		const loop = causes.loop(cause, c)
		// a loop mark from a run known to loop: the loop is cut there, and the run ends looping
		if (loop && by!.loop) {
			by!.cut = true
			return false
		}
		c.loop = loop
		// a looping computer is due again only by a change from outside the loop
		if (c.looping) {
			if (loop) return false
			c.looping = false
		}
		if (order.has(c)) return false
		order.set(c, t)
		return true
	}

	// these keys changed: what tracked them is due, at the next tick. run: who made the change (the
	// header); a compute named so becomes their writer. an effect is no one's writer: it writes in
	// its acts, after the round's runs
	function mark(keys: readonly unknown[], by?: By): number {
		const t = ++tick
		const r = by === undefined ? undefined : "kind" in by ? by.ran : (by as Own)[inside]
		const w = r?.c.kind === "compute" && r.c.state === "alive" ? r.c : undefined
		const now: Computer[] = marks.fs.length ? [] : none
		for (const key of keys) {
			if (w) write(w, key)
			const node = nodes.get(key)
			if (node === undefined) continue
			// walked in place: due changes no links
			for (let l = node.first; l !== null; l = l.after) {
				const c = l.from.owner as Computer
				if (due(c, t, r) && now !== none) now.push(c)
			}
		}
		for (const f of marks.fs) f(keys, r?.own, now, t)
		return t
	}

	function write(c: Computer, key: unknown) {
		const was = writers.get(key)
		if (was === c) return
		was?.wrote.delete(key)
		writers.set(key, c)
		c.wrote.add(key)
	}

	// reads

	// a key read in r: tracked. its writer due, the run stops: unless the writer waits after r's,
	// or is due by r's own doing (a loop, with no after in it)
	function follow(r: Ran, key: unknown) {
		if (r.stopped) throw new Stop()
		const c = r.c
		if (c.state !== "alive") return
		let node = nodes.get(key)
		const first = node === undefined
		if (first) {
			if (nodes.has(key)) untracked--
			nodes.set(key, node = tracker.node(key))
		}
		tracker.track(c.node, node!)
		if (first) { for (const f of firstTracks.fs) f(key) }
		if (ends.fs.length) {
			if (r.reads === none) r.reads = []
			r.reads.push(key)
		}
		for (const f of tracks.fs) f(key, r.own)
		const w = writers.get(key)
		if (w === undefined || w === c) return
		if (w.seen !== r.id) {
			w.seen = r.id
			r.values.push(w)
		}
		if (order.has(w) && !waitsAfter(w, c) && !causes.from(w, c)) {
			r.stopped = w
			throw new Stop()
		}
	}

	function waitsAfter(w: Computer, c: Computer): boolean {
		const seen = new Set<Computer>()
		for (let x = w.after; x && !seen.has(x); x = x.after) {
			if (x === c) return true
			seen.add(x)
		}
		return false
	}

	// the running computer read this key; outside a run, or in runWithScope, nothing
	function track(key: unknown) {
		if (reading) follow(reading, key)
	}

	// runs

	function first(c: Computer, rank: number) {
		const mark = order.at(c)!
		order.delete(c)
		order.waits(c, undefined)
		const n = ++c.runs
		const given = c.kept.length ? c.kept : none
		if (given !== none) c.kept = []
		const own = { computer: c, n } as Own
		const r: Ran = {
			c,
			own,
			n,
			mark,
			pulse: pulses,
			given,
			cause: causes.run(c, given),
			values: [],
			id: ++runs,
			reads: ends.fs.length ? [] : none,
			loop: c.loop,
		}
		c.loop = undefined
		c.ran = r
		// an effect acts on its latest run's value only
		if (c.acting) unact(c)
		for (const f of starts.fs) f(c, n, rank)
		own[inside] = r
		const was = reading
		const wasRunning = running
		running = r
		// what is under it goes first: all of a compute's; of an effect's, what was made since its
		// last act. torn down by a teardown: nothing more
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
		// enter's bracket, written out: no closure per run
		const wasOpen = open
		open = { scope: c, by: own }
		try {
			out = { value: c.f(c.last?.value) }
		} catch (e) {
			out = e === PENDING ? { value: PENDING } : { error: e }
		} finally {
			open = wasOpen
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
		if (r.loop && (!equal || r.cut)) {
			return finish(r, "looping", { equal, through: r.loop })
		}
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
				enter(
					{ scope: c, by: c },
					() => (c.set as (value: unknown) => void)(v),
				)
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
		// flagged, and cut a loop: a failure ends looping too
		if (ended === "failed" && r.loop && r.cut) {
			return finish(r, "looping", { ...more, through: r.loop })
		}
		if (c.state === "alive") {
			if (ended !== "done" && r.given.length) {
				c.kept = r.given.concat(c.kept)
			}
			r.given = none
			if (ended === "looping") c.looping = true
			if (ended !== "stopped") order.sees(c, r.values)
		}
		// ended, unless awaited: no longer a run known to loop
		if (ended !== "pending") r.loop = undefined
		for (const f of ends.fs) f(c, r.n, ended, r.reads, more)
	}

	// a promise: the run ends pending; its settling, unless run again or gone since, lands at the
	// next pulse. due again by then (what it read changed): it lands nowhere, the next run does
	function awaiting(r: Ran, p: PromiseLike<unknown>) {
		finish(r, "pending")
		const settle = (out: Out) => {
			if (r.c.state !== "alive" || r.c.runs !== r.n) return
			landed.push({ r, out })
			for (const f of settles.fs) f()
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

	function unact(c: Computer) {
		acts.splice(acts.indexOf(c.acting!), 1)
		c.acting = undefined
	}

	// what is under the effect goes, then it acts, with the value it acted on last. due again (an
	// earlier act this round changed what it read): its value is old, so it does not act; its
	// next run does. torn down by a teardown: nothing more
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
			const effect = c.effect as (value: unknown, previous: unknown) => void
			enter({ scope: c, by: c }, () => effect(a.value, c.last?.value))
		} catch (e) {
			failed ??= { error: e }
		} finally {
			reading = was
			running = wasRunning
		}
		c.last = { value: a.value }
		c.acted = [made, c.teardowns.length]
		for (const f of effects.fs) f(c, a.r.n, failed ?? {})
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
		for (const f of afterPulses.fs) f()
	}

	// keys nobody tracks, untracked now and then: any the ends and teardowns left
	let swept = 0
	function sweep() {
		if (nodes.size < 2 * swept + 64) return
		for (const node of nodes.values()) if (node !== undefined) unread(node)
		swept = nodes.size
	}

	// once, untracked, with o open, the run open the same: a setup, a host's write, a call. its
	// throw is the caller's
	function runWithScope<T>(o: Scope, f: () => T): T {
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
		createRootScope: (info: Iterable<Pair> = nothing) => grow(undefined, info),
		createScope,
		runWithScope,
		getCurrentScope: () => open?.scope,
		getInfo,
		getRun,
		registerTeardown,
		teardown,
		// tracked; a result not equal to the last goes to set. first runs at the next pulse. f is
		// given its last result (the last given to set; none yet: undefined).
		// key: where set's results land, when the caller knows; then readers of it wait for this
		// compute from the first pulse, rather than once it has written
		createComputer: <T>(
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			set: (value: T) => void,
			equal?: Equal<T>,
			key?: unknown,
		): Computer => make("compute", f as Computer["f"], set, equal as Equal<never>, key),
		// tracked; a result not equal to the one it last acted on is acted on after the round's
		// last run. first runs at the next pulse. f is given the last value acted on (none yet:
		// undefined)
		createEffect: <T>(
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			effect: (value: T, previous: T | undefined) => void,
			equal?: Equal<T>,
		): Computer => make("effect", f as Computer["f"], effect, equal as Equal<never>),
		track,
		mark,
		pulse,
		onTrack: tracks.on,
		onMark: marks.on,
		onRunStart: starts.on,
		onRunEnd: ends.on,
		onEffect: effects.on,
		onSettle: settles.on,
		onAfterPulse: afterPulses.on,
		onTrackingEnd: untracks.on,
		onTrackingStart: firstTracks.on,
	}
}

// each on… is told as it happens, and gives back its remove
export type Scheduler = {
	createRootScope: (info?: Iterable<Pair>) => Scope
	createScope: (info?: Iterable<Pair>, parent?: Scope) => Scope
	runWithScope: <T>(o: Scope, f: () => T) => T
	// the scope open now; none: undefined
	getCurrentScope: () => Scope | undefined
	getInfo: () => readonly Pair[] | undefined
	getRun: () => Run | undefined
	registerTeardown: (o: Scope, f: () => unknown) => void
	teardown: (o: Scope) => void
	createComputer: <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		set: (value: T) => void,
		equal?: Equal<T>,
		key?: unknown,
	) => Computer
	createEffect: <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		effect: (value: T, previous: T | undefined) => void,
		equal?: Equal<T>,
	) => Computer
	track: (key: unknown) => void
	// the tick it took
	mark: (keys: readonly unknown[], run?: Run | Computer) => number
	pulse: () => void
	// a key tracked in a run
	onTrack: (f: (key: unknown, run: Run) => void) => () => void
	// a mark (and a new computer, due at once: no keys): what it made due, and its tick
	onMark: (
		f: (
			keys: readonly unknown[],
			run: Run | undefined,
			due: Computer[],
			tick: number,
		) => void,
	) => () => void
	onRunStart: (
		f: (computer: Computer, n: number, rank: number) => void,
	) => () => void
	// reads: every key the run tracked, in order, again when tracked again (kept only while
	// someone listens here)
	onRunEnd: (
		f: (
			computer: Computer,
			n: number,
			ended: Ended,
			reads: readonly unknown[],
			more: More,
		) => void,
	) => () => void
	// an effect ran its effect, with the value: more.error, what it threw
	onEffect: (
		f: (computer: Computer, n: number, more: { error?: unknown }) => void,
	) => () => void
	// a promise settled: its result waits for the next pulse
	onSettle: (f: () => void) => () => void
	// a pulse ended: nothing due, every act done (not told when one threw). a pulse called here is
	// a new one
	onAfterPulse: (f: () => void) => () => void
	// a key nobody tracks any more: at once when its last tracker's run did not track it again or
	// it was torn down (a sweep now and then catches any other)
	onTrackingEnd: (f: (key: unknown) => void) => () => void
	// a key tracked by someone again, after nobody did (or the first time): a provider can start
	// making it then, and stop at onTrackingEnd. told in the reading run: a write made now is that run's,
	// so start the work and write once it arrives
	onTrackingStart: (f: (key: unknown) => void) => () => void
}
