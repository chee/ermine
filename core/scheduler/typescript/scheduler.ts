// the scheduler: runs code. a computer is tracked: it runs again when a key it tracked was
// marked. an effect is a computer whose value is acted on after the round's last run. a setup runs
// once, untracked. the scopes tree holds them: tearing a scope down takes everything under it.
//
// a scope is two things, one tree: an owner (what is made in it is put under it) and the info of
// the changes made in it: pairs, [key, value] in order, opaque, as keys are, then ["owner", the
// info of the scope it is under] (a root: none). so the info nests, innermost first, and
// Object.fromEntries at each level gives a trace. a write's pairs: the info of the scope open
// (getInfo). createScope(info, parent?) makes one under parent, else under the one open;
// createRootScope(info) one with no parent. no pairs given: empty. a scope is open only in a
// bracket, while its code is on the stack: runWithScope(scope, f), and the scheduler's own. a
// computer is a scope under the one open when it was made; its runs, sets and acts open it,
// written by itself (a run by its own Run, a set or act by the computer). its info is its latest
// run's, set as the run starts: its number, the tick of the mark that made it due; before its
// first run, that tick alone. a scope's info is made once, with it: under a computer, it is that
// run's, as what a run made goes before the next (what an act made, before the next act). a
// teardown opens its scope, and what is under a scope goes with it open: a teardown on a plain
// scope under a computer, run by the computer's clean or teardown, is written by it. nothing
// open: making a scope or a computer is unscoped.
//
// a pulse runs what is due, in rounds: a round runs the due computations in order (order.ts: one
// once every due one above it ran; of those, the earliest due, then the oldest), then acts on
// the effects' new values; acting may make more due, for another round.
// a result equal to the last stops there.
//
// early effects ("acts at once and is in an earlier queue so it goes compute, early, effect"; "it
// runs once the moment you create it, and then from then on runs in the early effects queue"):
// made, it is due, runs and acts at once, inside createEffect, pulse or not: in a run, set, act or
// teardown too, its run bracketed in it as any. that first run stopped (a writer due) is due, and
// pending (or awaiting) does not act: either way it acts in an early queue later. after, a round
// is three queues, in order: the runs, in order; the early effects' acts; the other effects' acts.
// each act queue in the order the runs ended, but owners first (E2, chee: "yes, think that's
// right"): an act waits while the act of a computer above it (its owner: the run or act that made
// it, or one above that) is due in the same queue; the owner acts first, and what its act tears
// down never acts. an early act's write marks at once: what it makes
// due runs in the next round, and an effect it makes due does not act in this one (its value is
// old: its next run's does), as with any act. an early act that throws: told (onEffect), the round
// goes on, as any act.
//
// cleanups, like Solid: before a run, what is under the computer goes (a compute's all, an
// effect's what was made since its last act), and its own cleanups are set aside; they run once
// the run is done (its result set, before its end is told), newest first, with no catch: the
// first that throws ends the rest. a computer that goes takes those set aside with it.
//
// thrown out ("finish, then rethrow"): what a listener throws, or a cleanup run after a run, is
// held while what was going on finishes (every listener told; the run, act, mark, read or
// teardown all done), then it is thrown: the first. a pulse is left there; what is still due, or
// to act, waits for the next.
//
// it holds no values but each computation's last result:
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
import { createOrder, type Hold } from "./order.ts"
import { createTracker, type Node } from "./tracker.ts"

// a compute returns it, or throws it (itself, not an error wrapping it), while what it needs is
// not here: its run ends pending (nothing set, its last result kept, an effect does not act). so
// a read of something pending can throw it, and every compute above it is pending unasked. a
// promise resolved to it, or rejected with it, lands pending
export const PENDING: unique symbol = Symbol.for("ermine.pending")

export class SchedulerError extends Error {
	constructor(readonly code: "disposed" | "unscoped" | "empty", message: string) {
		super(message)
		this.name = "SchedulerError"
	}
}

export type Equal<T = unknown> = (a: T, b: T) => boolean
// one time a computer ran: the run open while it runs (getRun()), kept for a write after an await
export type Run = { readonly computer: Computer; readonly n: number }

export type Pair = readonly [key: string, value: unknown]

// a scope: the scopes and computers under it, in the order made (a list: newest, the newest under
// it; older and newer, the one made before and after it under the same scope), and its teardowns;
// its info: the pairs given, then ["owner", its owner's info] (never change it). a computer's: its
// latest run's
export type Scope = {
	readonly n: number
	readonly parent: Scope | undefined
	info: readonly Pair[]
	newest: Scope | undefined
	older: Scope | undefined
	newer: Scope | undefined
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
	// a stamp, a walk's marks, what holds it and what it holds (order.ts)
	values: Computer[]
	after?: Computer
	due: number
	rank: number
	ranked: number
	afters: Map<Computer, number> | undefined
	stamp: number
	counted: number
	walked: number
	via: Computer | undefined
	held: Hold<Computer> | undefined
	holding: Hold<Computer>[] | undefined
	// the last run that read a key this one writes, by its number (no repeats in values)
	seen: number
	// the keys it is the writer of
	wrote: Set<unknown>
	loop?: Computer[]
	looping: boolean
	acting?: Act
	// its cleanups set aside before its run, till the run is done (lay)
	aside?: (() => unknown)[]
	// an effect's: it acts in the round's early queue
	readonly early: boolean
}

// early: acted on in the round's early queue, and its first run and act when made
export type EffectOptions = { early?: boolean }

// how a run ended
export type Ended = "done" | "pending" | "failed" | "stopped" | "looping"

// what more a run's end says: its result equal to the last; what it threw; the computer it waits
// after (stopped); the loop it went through (looping); kept: its result, when held past the run
// (a compute's given to set, even one that threw; an effect's to be acted on): only when not equal
// to the last. there when held, though the result may be undefined
export type More = {
	equal?: boolean
	error?: unknown
	waits?: Computer
	through?: Computer[]
	kept?: unknown
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
// an act, at its place in its queue (at)
type Act = { r: Ran; value: unknown; at: number }
// acts in the order queued, from head; one taken out leaves a hole (live: how many are not holes)
type Queue = { items: (Act | undefined)[]; head: number; live: number }
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
	// the effects to act, in the order their runs ended, the early ones apart; settled promises,
	// for the next pulse
	const acts: Queue = { items: [], head: 0, live: 0 }
	const earlies: Queue = { items: [], head: 0, live: 0 }
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
	// the first error a listener, or a cleanup after a run, threw: held while what was going on
	// finishes, then it comes out ("finish, then rethrow"); each of those a bracket of its own
	let thrown: { error: unknown } | undefined
	const hold = (e: unknown) => void (thrown ??= { error: e })
	// what was held since the bracket began comes out; what was held around it is held again
	function rethrow(outer: typeof thrown) {
		const t = thrown
		thrown = outer
		if (t) throw t.error
	}

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

	// no pairs: empty
	function grow(up: Scope | undefined, info: Iterable<Pair>): Scope {
		const pairs: Pair[] = [...info]
		if (pairs.length === 0) throw empty()
		if (up) pairs.push(["owner", up.info])
		const o: Scope = {
			n: ++made,
			parent: up,
			info: pairs,
			newest: undefined,
			older: undefined,
			newer: undefined,
			teardowns: [],
			state: "alive",
		}
		if (up) link(up, o)
		return o
	}

	// o under up, the newest
	function link(up: Scope, o: Scope) {
		const l = up.newest
		o.older = l
		if (l) l.newer = o
		up.newest = o
	}
	// o out from under its scope, if it is there
	function unlink(o: Scope) {
		const p = o.parent
		if (o.newer) o.newer.older = o.older
		else if (p?.newest === o) p.newest = o.older
		if (o.older) o.older.newer = o.newer
		o.older = o.newer = undefined
	}
	// what is under o made after the after-th, newest first, taken out from under it together
	function cut(o: Scope, after: number): Scope[] {
		let x = o.newest
		if (x === undefined || x.n <= after) return none
		const kids: Scope[] = []
		while (x !== undefined && x.n > after) {
			kids.push(x)
			x = x.older
		}
		o.newest = x
		if (x) x.newer = undefined
		kids[kids.length - 1].older = undefined
		return kids
	}

	// a new scope under up, else under the one open; gone: disposed
	function createScope(info: Iterable<Pair>, up?: Scope): Scope {
		if (up === undefined) return grow(parent(), info)
		if (up.state !== "alive") throw disposed()
		return grow(up, info)
	}

	// the pairs of a write made now: the info of the scope open; nothing open: undefined
	function getInfo(): readonly Pair[] | undefined {
		return open?.scope.info
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
		const kids = cut(o, after)
		enter(opens(o), () => {
			for (const kid of kids) {
				try {
					teardown(kid)
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

	// before a run ("like Solid"): what is under c goes, newest first (what one threw held), and
	// its cleanups are set aside, to run once the run is done (lay). after, from: as clean's
	function shed(c: Computer, after = 0, from = 0) {
		const kids = cut(c, after)
		if (kids.length) {
			enter(opens(c), () => {
				for (const kid of kids) {
					try {
						teardown(kid)
					} catch (e) {
						hold(e)
					}
				}
			})
		}
		if (c.teardowns.length > from) {
			const fs = c.teardowns.slice(from)
			c.teardowns.length = from
			c.aside = c.aside ? c.aside.concat(fs) : fs
		}
	}

	// the cleanups set aside before r, once r is done (its value landed), newest first, as
	// teardowns run; no catch: one that throws ends the rest, its error held
	function lay(c: Computer, r: Ran) {
		const fs = c.aside!
		c.aside = undefined
		const was = reading
		const wasRunning = running
		reading = undefined
		running = r
		try {
			for (let i = fs.length - 1; i >= 0; i--) enter(opens(c), fs[i])
		} catch (e) {
			hold(e)
		} finally {
			reading = was
			running = wasRunning
		}
	}

	// children first, newest first, then o's teardowns, newest first. every teardown runs; the
	// first error is thrown after
	function teardown(o: Scope) {
		if (o.state !== "alive") return
		const outer = thrown
		thrown = undefined
		o.state = "disposing"
		if ("kind" in o) {
			const c = o as Computer
			drop(c)
			// set aside before its run: older than the rest
			if (c.aside) {
				c.teardowns = c.aside.concat(c.teardowns)
				c.aside = undefined
			}
		}
		const failed = clean(o)
		o.state = "gone"
		// gone: as the run of a change it names none
		if ("kind" in o) (o as Computer).ran = undefined
		unlink(o)
		thrown ??= failed
		rethrow(outer)
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
	const empty = () => new SchedulerError("empty", "a scope's info has no pairs")

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
		for (const f of untracks.fs) {
			try {
				f(node.owner)
			} catch (e) {
				hold(e)
			}
		}
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
		options?: EffectOptions,
	): Computer {
		const o = parent()
		const c = {
			n: ++made,
			parent: o,
			info: nothing,
			newest: undefined,
			older: undefined,
			newer: undefined,
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
			counted: 0,
			walked: 0,
			via: undefined,
			held: undefined,
			holding: undefined,
			seen: 0,
			wrote: new Set(),
			looping: false,
			early: kind === "effect" && options?.early === true,
		} as unknown as Computer & { node: Node<unknown> }
		c.acted = [c.n, 0]
		c.node = tracker.node(c)
		link(o, c)
		live.add(c)
		// the key its results land at, given: its writer from the start, not learned
		if (key !== undefined) write(c, key)
		order.started(c)
		// made in a run, set, act or teardown: it carries that run's cause, so a loop through what
		// it changes is seen. made in a run known to loop: the loop is cut there, as a dropped
		// loop mark cuts it
		if (running?.loop) running.cut = true
		const t = ++tick
		// its info till its first run: the tick that made it due, its making
		c.info = [["mark", t], ["owner", o.info]]
		const now = due(c, t, running) ? [c] : []
		const outer = thrown
		thrown = undefined
		for (const f of marks.fs) {
			try {
				f([], running?.own, now, t)
			} catch (e) {
				hold(e)
			}
		}
		// early: its first run now, and its act
		if (c.early && now.length) {
			try {
				first(c, order.rank(c))
			} catch (e) {
				hold(e)
			}
			const a = c.acting
			if (a) {
				unact(c)
				act(a)
			}
		}
		rethrow(outer)
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
		// every listener told; the first error after
		let failed: { error: unknown } | undefined
		for (const f of marks.fs) {
			try {
				f(keys, r?.own, now, t)
			} catch (e) {
				failed ??= { error: e }
			}
		}
		if (failed) throw failed.error
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
		// every listener told; what one threw comes out after the read is all done
		let failed: { error: unknown } | undefined
		if (first) {
			for (const f of firstTracks.fs) {
				try {
					f(key)
				} catch (e) {
					failed ??= { error: e }
				}
			}
		}
		if (ends.fs.length) {
			if (r.reads === none) r.reads = []
			r.reads.push(key)
		}
		for (const f of tracks.fs) {
			try {
				f(key, r.own)
			} catch (e) {
				failed ??= { error: e }
			}
		}
		const w = writers.get(key)
		if (w !== undefined && w !== c) {
			if (w.seen !== r.id) {
				w.seen = r.id
				r.values.push(w)
			}
			if (order.has(w) && !waitsAfter(w, c) && !causes.from(w, c)) r.stopped = w
		}
		if (failed) throw failed.error
		if (r.stopped) throw new Stop()
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

	// a run, its own bracket: what a listener or a cleanup after it threw comes out once it is done
	function first(c: Computer, rank: number) {
		const outer = thrown
		thrown = undefined
		try {
			begin(c, rank)
		} finally {
			rethrow(outer)
		}
	}

	function begin(c: Computer, rank: number) {
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
		for (const f of starts.fs) {
			try {
				f(c, n, rank)
			} catch (e) {
				hold(e)
			}
		}
		own[inside] = r
		const was = reading
		const wasRunning = running
		running = r
		// what is under it goes first: all of a compute's; of an effect's, what was made since its
		// last act. its cleanups wait till the run is done (lay). torn down by a teardown: nothing
		// more
		if (c.kind === "compute") shed(c)
		else shed(c, ...c.acted)
		if (c.state !== "alive") {
			running = wasRunning
			return
		}
		// its info, from here: this run's number, and the tick of the mark that made it due
		c.info = [["run", n], ["mark", mark], ["owner", c.parent!.info]]
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
			if (!equal) {
				const q = c.early ? earlies : acts
				const a: Act = c.acting = { r, value: v, at: q.items.length }
				q.items.push(a)
				q.live++
				return finish(r, "done", { equal, kept: v })
			}
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
				return finish(r, "failed", { equal, error: failed.error, kept: v })
			}
			c.last = { value: v }
			return finish(r, "done", { equal, kept: v })
		}
		finish(r, "done", { equal })
	}

	function finish(r: Ran, ended: Ended, more: More = {}) {
		const c = r.c
		if (c.aside !== undefined && c.ran === r && c.state === "alive") lay(c, r)
		// flagged, and cut a loop (in its cleanups too): a failure ends looping, and so does a
		// result equal to the last
		if (r.loop && r.cut && (ended === "failed" || ended === "done" && more.equal)) {
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
		for (const f of ends.fs) {
			try {
				f(c, r.n, ended, r.reads, more)
			} catch (e) {
				hold(e)
			}
		}
	}

	// a promise: the run ends pending; its settling, unless run again or gone since, lands at the
	// next pulse. due again by then (what it read changed): it lands nowhere, the next run does
	function awaiting(r: Ran, p: PromiseLike<unknown>) {
		finish(r, "pending")
		const settle = (out: Out) => {
			if (r.c.state !== "alive" || r.c.runs !== r.n) return
			landed.push({ r, out })
			let failed: { error: unknown } | undefined
			for (const f of settles.fs) {
				try {
					f()
				} catch (e) {
					failed ??= { error: e }
				}
			}
			if (failed) throw failed.error
		}
		p.then(
			(value) => settle({ value }),
			(error) => settle(error === PENDING ? { value: PENDING } : { error }),
		)
	}

	function land(r: Ran, out: Out) {
		if (r.c.state !== "alive" || r.c.runs !== r.n || order.has(r.c)) return
		const outer = thrown
		thrown = undefined
		try {
			if ("error" in out) finish(r, "failed", { error: out.error })
			else if (out.value === PENDING) finish(r, "pending")
			else result(r, out.value)
		} finally {
			rethrow(outer)
		}
	}

	// acts

	// a out of its queue: a hole where it was
	function unqueue(q: Queue, a: Act) {
		q.items[a.at] = undefined
		q.live--
	}

	function unact(c: Computer) {
		unqueue(c.early ? earlies : acts, c.acting!)
		c.acting = undefined
	}

	// the next act of q, owners first: the nearest computer above it with an act in q acts before
	// it (and its owner before that); what that tears down does not act. a bracket: what a
	// listener threw comes out after
	function take(q: Queue) {
		const outer = thrown
		thrown = undefined
		try {
			while (q.items[q.head] === undefined) q.head++
			const a = q.items[q.head]!
			unqueue(q, a)
			a.r.c.acting = undefined
			if (q.live) owners(a.r.c, q)
			act(a)
		} finally {
			rethrow(outer)
		}
	}
	function owners(c: Computer, q: Queue) {
		for (let o = c.parent; o !== undefined; o = o.parent) {
			const x = "kind" in o ? (o as Computer).acting : undefined
			if (x === undefined || (o as Computer).early !== c.early) continue
			unqueue(q, x)
			x.r.c.acting = undefined
			owners(x.r.c, q)
			act(x)
			return
		}
	}
	// a queue all taken: made new
	function clear(q: Queue) {
		q.items.length = 0
		q.head = 0
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
		for (const f of effects.fs) {
			try {
				f(c, a.r.n, failed ?? {})
			} catch (e) {
				hold(e)
			}
		}
	}

	// pulses

	// rounds until nothing is due: the settled promises land, the due run in order, the early
	// effects act, the effects act. a pulse in a pulse does nothing
	function pulse() {
		if (pulsing) return
		pulsing = true
		const outer = thrown
		thrown = undefined
		let failed: { error: unknown } | undefined
		try {
			for (;;) {
				while (landed.length) {
					const { r, out } = landed.shift()!
					land(r, out)
				}
				if (!order.size() && !earlies.live && !acts.live) break
				while (order.size()) {
					const { p, rank } = order.next()
					first(p, rank)
				}
				while (earlies.live) take(earlies)
				clear(earlies)
				while (acts.live) take(acts)
				clear(acts)
			}
		} catch (e) {
			failed = { error: e }
		} finally {
			pulsing = false
			causes.end()
			pulses++
			sweep()
		}
		if (failed === undefined) {
			for (const f of afterPulses.fs) {
				try {
					f()
				} catch (e) {
					hold(e)
				}
			}
		}
		thrown = failed ?? thrown
		rethrow(outer)
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
		createRootScope: (info: Iterable<Pair>) => grow(undefined, info),
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
		// undefined). early: acted on in the round's early queue (above)
		createEffect: <T>(
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			effect: (value: T, previous: T | undefined) => void,
			equal?: Equal<T>,
			options?: EffectOptions,
		): Computer =>
			make("effect", f as Computer["f"], effect, equal as Equal<never>, undefined, options),
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
	createRootScope: (info: Iterable<Pair>) => Scope
	createScope: (info: Iterable<Pair>, parent?: Scope) => Scope
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
		options?: EffectOptions,
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
