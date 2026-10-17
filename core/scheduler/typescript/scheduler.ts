// the scheduler: runs code. a computer is tracked: it runs again when a key it tracked was
// marked. an effect is a computer whose value is acted on after the round's last run. a setup runs
// once, untracked. the scopes tree holds them: tearing a scope down takes everything under it.
//
// a scope is two things: an owner (what is made in it is put under it; the tree is parent) and the
// info of the changes made in it: the pairs given, [key, value] in order, opaque, as keys are,
// nothing appended. a write's pairs: the info of the scope open (getInfo). createScope(info,
// parent?) makes one under parent, else under the one open; createRootScope(info) one with no
// parent. no pairs given: empty. a scope is open only in a bracket, while its code is on the
// stack: runWithScope(scope, f), and the scheduler's own. a computer is a scope under the one open
// when it was made; its runs, sets and acts open it, written by itself (a run by its own Run, a set
// or act by the computer). its info is its latest run's, set as the run starts: [["run", n],
// ["mark", t]], n its number, t the tick of the mark that made it due; before its first run
// [["mark", t]]. a scope's info is made once, with it; under a computer, it belongs to that run (a
// plain scope is never claimed: it goes once a later run is done; what an act made, before the
// next act; a computer claimed is a scope whose info is its own run's). a teardown opens its
// scope, and what is under a scope goes with it open: a teardown on a plain scope under a
// computer, run by the computer's teardown, its run's end or its act, is written by it. nothing
// open: making a scope or a computer is unscoped.
//
// a pulse runs what is due, in rounds: a round runs the due computations by rank (rank.ts,
// order.ts), then acts on the effects' new values; acting may make more due, for another round.
// a result equal to the last stops there.
//
// early effects ("acts at once and is in an earlier queue so it goes compute, early, effect"; "it
// runs once the moment you create it, and then from then on runs in the early effects queue"):
// made, it is due, runs and acts at once, inside createEffect, pulse or not: in a run, set, act or
// teardown too, its run bracketed in it as any. that first run stopped (a writer due) is due, and
// pending (or awaiting) does not act: either way it acts in an early queue later. after, a round
// is three queues, in order: the runs, by rank; the early effects' acts; the other effects' acts.
// each act queue in the order the runs ended, but owners first (E2, chee: "yes, think that's
// right"): an act waits while the act of a computer above it (its owner: the run or act that made
// it, or one above that) is due in the same queue; the owner acts first, and what its act tears
// down never acts. an early act's write marks at once: what it makes
// due runs in the next round, and an effect it makes due does not act in this one (its value is
// old: its next run's does), as with any act. an early act that throws: told (onEffect), the round
// goes on, as any act.
//
// a rerun keeps what it makes again (chee 10-17: a parent rerun does not destroy its children).
// as a run starts, what the computer's earlier runs made (a compute's all; an effect's, not what
// its act made) is old: still alive while the new run goes (it runs, is read, writes), and its own
// cleanups are set aside. claim(child), in the run: an old child is back under it, made due (a
// tick, told as a mark with no keys). the run done: what is still old goes, newest first, before
// its end is told (mine: at the run's end, not the round's, so a child not made again never runs
// again); the cleanups set aside run "like solidjs2.0" once the round's runs are done (before its
// acts), newest first, with no catch: the first that throws ends the rest of that computer's. a
// run ending any other way (failed, pending, stopped, looping) keeps both ("keep them until the
// parent is actually destroyed"): the next run finds them old with what it made; a promise
// landing done lets them go then. a computer that goes takes what is old and set aside with it.
// before each act, what its last act made goes, and the cleanups made in it run.
//
// thrown out ("finish, then rethrow"): what a listener throws, or a cleanup run after a run, is
// held while what was going on finishes (every listener told; the run, act, mark, read or
// teardown all done), then it is thrown: the first. a pulse is left there; what is still due, or
// to act, waits for the next. a teardown's: what a listener threw, else a cleanup's; before an
// act, a cleanup's (its own, or one under it) is the act's error, a listener's comes out after
// the act. where nothing can throw it (mine): a promise settling has no caller, and
// createComputer and createEffect give back the computer; what a listener threw then comes out of
// a pulse, the one going on or else the next, once it is done, before the pulse's own error.
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
import { createOrder } from "./order.ts"
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
// its info: the pairs given (never change it); the tree is parent. a computer's: its latest run's
export type Scope = {
	readonly n: number
	readonly parent: Scope | undefined
	info: readonly Pair[]
	newest: Scope | undefined
	older: Scope | undefined
	newer: Scope | undefined
	teardowns: (() => unknown)[]
	state: "alive" | "disposing" | "gone"
	// old: made by an earlier run of its computer, not made again by the run going on yet (claim),
	// alive till that run is done. deed: made in its effect's act, gone before the next act
	old: boolean
	deed: boolean
}

// a computer is a scope too: what is under it is old as each run starts (an effect's act's, gone
// before each act)
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
	// what its earlier runs made, old while a newer run goes: newest first, through older (claim,
	// dropUnclaimedChildren)
	before: Scope | undefined
	// an effect's: the cleanups made in its last act, and whether one is going on
	deeds: (() => unknown)[]
	doing: boolean
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
	// its cleanups set aside before its run, till a run is done; then queued, till the round's
	// runs are (runQueuedCleanups)
	aside?: (() => unknown)[]
	queuedCleanups?: (() => unknown)[]
	// the loop of a run known to loop that queued them: their loop marks are cut, as its own are
	cuts?: Computer[]
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
	const returns = told<[computer: Computer, n: number, value: unknown]>()
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
	// settled promises from landedHead on; one landed leaves a hole
	const landed: ({ r: Ran; out: Out } | undefined)[] = []
	let landedHead = 0
	// the computers with cleanups queued, for once the round's runs are done (runQueuedCleanups)
	const queued: Computer[] = []

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
	// the first error held where nothing can throw it (mine): a promise settling (no caller) and a
	// computer made (createComputer, createEffect give it back, so cannot throw too). it comes out
	// of a pulse, the one going on, else the next, once that pulse is done, before its own
	let escaped: { error: unknown } | undefined
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
		const o: Scope = {
			n: ++made,
			parent: up,
			info: pairs,
			newest: undefined,
			older: undefined,
			newer: undefined,
			teardowns: [],
			state: "alive",
			old: false,
			deed: doing(up),
		}
		if (up) link(up, o)
		return o
	}

	// up an effect whose act is going on: what is made under it now is the act's
	const doing = (up: Scope | undefined) => up !== undefined && (up as Computer).doing === true

	// o under up, the newest
	function link(up: Scope, o: Scope) {
		const l = up.newest
		o.older = l
		if (l) l.newer = o
		up.newest = o
	}
	// o out from under its scope, or off its before list, if it is there
	function unlink(o: Scope) {
		const p = o.parent
		if (o.newer) o.newer.older = o.older
		else if (p?.newest === o) p.newest = o.older
		else if (p !== undefined && (p as Computer).before === o) (p as Computer).before = o.older
		if (o.older) o.older.newer = o.newer
		o.older = o.newer = undefined
		o.old = false
	}
	// what is under o, newest first, then what is old on it, newest first: taken out together
	function cut(o: Scope): Scope[] {
		const c = o as Computer
		if (o.newest === undefined && c.before === undefined) return none
		const kids: Scope[] = []
		for (let x = o.newest; x !== undefined; x = x.older) kids.push(x)
		for (let x = c.before; x !== undefined; x = x.older) kids.push(x)
		o.newest = undefined
		if (c.before !== undefined) c.before = undefined
		for (const x of kids) {
			x.older = x.newer = undefined
			x.old = false
		}
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

	// on scope (an effect's in its act: the act's); already gone, f runs now
	function registerTeardown(o: Scope, f: () => unknown) {
		if (o.state !== "alive") enter(opens(o), f)
		else if ((o as Computer).doing === true) (o as Computer).deeds.push(f)
		else o.teardowns.push(f)
	}

	// kids, newest first, then fs, newest first, every one with o open (under a computer, by it):
	// the first cleanup error. what a listener throws in a kid's teardown is held (the bracket
	// around), never a cleanup's error
	function down(o: Scope, kids: Scope[], fs: (() => unknown)[]): { error: unknown } | undefined {
		let failed: { error: unknown } | undefined
		if (kids.length) {
			enter(opens(o), () => {
				for (const kid of kids) {
					const e = dispose(kid)
					failed ??= e
				}
			})
		}
		for (let i = fs.length - 1; i >= 0; i--) {
			try {
				enter(opens(o), fs[i])
			} catch (e) {
				failed ??= { error: e }
			}
		}
		return failed
	}

	// as a run starts: what its runs made is old (an effect's act's stays), on the before list
	// ahead of what is old there already; its cleanups are set aside
	function liftChildren(c: Computer) {
		let head: Scope | undefined
		let tail: Scope | undefined
		for (let x = c.newest; x !== undefined;) {
			const next = x.older
			if (!x.deed) {
				unlink(x)
				x.old = true
				if (tail) {
					tail.older = x
					x.newer = tail
				} else head = x
				tail = x
			}
			x = next
		}
		if (tail) {
			tail.older = c.before
			if (c.before) c.before.newer = tail
			c.before = head
		}
		if (c.teardowns.length) {
			c.aside = c.aside ? c.aside.concat(c.teardowns) : c.teardowns
			c.teardowns = []
		}
	}

	// an old child of the run open's computer, claimed: back under it, the newest, and due (a
	// tick, told as a mark with no keys, by the run open). not old: false
	function claim(c: Computer): boolean {
		if (!c.old || c.state !== "alive") return false
		unlink(c)
		link(c.parent!, c)
		// as a computer made: in a run known to loop, the loop is cut there
		if (running?.loop) running.cut = true
		const t = ++tick
		const now = due(c, t, running) ? [c] : none
		const outer = thrown
		thrown = undefined
		for (const f of marks.fs) {
			try {
				f([], running?.own, now, t)
			} catch (e) {
				hold(e)
			}
		}
		rethrow(outer)
		return true
	}

	// r done: what is still old on c goes, newest first (the first error held); its cleanups set
	// aside are queued, to run once the round's runs are done (runQueuedCleanups)
	function dropUnclaimedChildren(c: Computer, r: Ran) {
		if (c.before !== undefined) {
			const kids: Scope[] = []
			for (let x: Scope | undefined = c.before; x; x = x.older) kids.push(x)
			c.before = undefined
			for (const x of kids) {
				x.older = x.newer = undefined
				x.old = false
			}
			const was = reading
			const wasRunning = running
			reading = undefined
			running = r
			try {
				const failed = down(c, kids, none)
				if (failed) hold(failed.error)
			} finally {
				reading = was
				running = wasRunning
			}
		}
		if (c.aside !== undefined && c.state === "alive") {
			if (c.queuedCleanups === undefined) queued.push(c)
			c.queuedCleanups = c.queuedCleanups ? c.queuedCleanups.concat(c.aside) : c.aside
			if (r.loop) c.cuts = r.loop
			c.aside = undefined
		}
	}

	// the cleanups queued, once the round's runs are done: each computer's newest first, as teardowns
	// run; no catch: one that throws ends the rest of that computer's, its error held. a bracket
	function runQueuedCleanups() {
		if (queued.length === 0) return
		const outer = thrown
		thrown = undefined
		const was = reading
		const wasRunning = running
		try {
			for (let i = 0; i < queued.length; i++) {
				const c = queued[i]
				const fs = c.queuedCleanups
				const cuts = c.cuts
				c.queuedCleanups = c.cuts = undefined
				if (fs === undefined || c.state !== "alive") continue
				const r = c.ran!
				const flag = r.loop
				if (cuts) r.loop = cuts
				reading = undefined
				running = r
				try {
					for (let j = fs.length - 1; j >= 0; j--) enter(opens(c), fs[j])
				} catch (e) {
					hold(e)
				} finally {
					r.loop = flag
				}
			}
		} finally {
			queued.length = 0
			reading = was
			running = wasRunning
			rethrow(outer)
		}
	}

	// children first, newest first, then o's teardowns, newest first. every teardown runs; the
	// first error is thrown after: what a listener threw (held), else a cleanup's
	function teardown(o: Scope) {
		if (o.state !== "alive") return
		const outer = thrown
		thrown = undefined
		const failed = dispose(o)
		thrown ??= failed
		rethrow(outer)
	}

	// o gone, as teardown, in the bracket open: what a listener throws is held there; the first
	// cleanup error given back
	function dispose(o: Scope): { error: unknown } | undefined {
		if (o.state !== "alive") return
		o.state = "disposing"
		let fs = o.teardowns
		if ("kind" in o) {
			const c = o as Computer
			drop(c)
			// queued and set aside before its runs, then its act's: older than the rest
			if (c.queuedCleanups || c.aside || c.deeds.length) {
				fs = [...c.queuedCleanups ?? none, ...c.aside ?? none, ...c.deeds, ...fs]
				c.queuedCleanups = c.aside = undefined
				c.deeds = []
			}
		}
		o.teardowns = []
		const failed = down(o, cut(o), fs)
		o.state = "gone"
		// gone: as the run of a change it names none
		if ("kind" in o) (o as Computer).ran = undefined
		unlink(o)
		return failed
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
			old: false,
			deed: doing(o),
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
			before: undefined,
			deeds: [],
			doing: false,
			early: kind === "effect" && options?.early === true,
		} as unknown as Computer & { node: Node<unknown> }
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
		c.info = [["mark", t]]
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
		// made: given back, so what was held waits for a pulse
		escaped ??= thrown
		thrown = outer
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
		// what its runs made is old, its cleanups set aside, till a run is done (dropUnclaimedChildren). torn
		// down by a listener: nothing more
		if (c.state !== "alive") {
			running = wasRunning
			return
		}
		liftChildren(c)
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

	// a result: told first (onRunReturn), as the body gave it. equal to the last, it stops there. a
	// compute's goes to set; an effect's waits for the acts, the latest one
	function result(r: Ran, v: unknown) {
		const c = r.c
		for (const f of returns.fs) {
			try {
				f(c, r.n, v)
			} catch (e) {
				hold(e)
			}
		}
		// torn down by a listener: nothing more
		if (c.state !== "alive") return
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
		// flagged, and cut a loop: a failure ends looping, and so does a result equal to the last
		if (r.loop && r.cut && (ended === "failed" || ended === "done" && more.equal)) {
			return finish(r, "looping", { ...more, through: r.loop })
		}
		// done, its latest: what it did not make again goes, its old cleanups are queued
		if (ended === "done" && c.ran === r && c.state === "alive") dropUnclaimedChildren(c, r)
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
			// every listener told; nobody to throw to: what one threw waits for a pulse
			for (const f of settles.fs) {
				try {
					f()
				} catch (e) {
					escaped ??= { error: e }
				}
			}
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

	// what the effect's last act made goes, and the cleanups made in it run (a cleanup's error is the
	// act's; a listener's is held, out once the act is done); then it acts, with the value it acted
	// on last. due again (an earlier act this round changed what it read): its value
	// is old, so it does not act; its next run does. torn down by a teardown: nothing more
	function act(a: Act) {
		const c = a.r.c
		c.acting = undefined
		if (c.state !== "alive" || order.has(c)) return
		const was = reading
		const wasRunning = running
		reading = undefined
		running = a.r
		const deeds: Scope[] = []
		for (let x = c.newest; x !== undefined;) {
			const next = x.older
			if (x.deed) {
				unlink(x)
				deeds.push(x)
			}
			x = next
		}
		const fs = c.deeds
		c.deeds = []
		let failed = down(c, deeds, fs)
		if (c.state !== "alive") {
			reading = was
			running = wasRunning
			return
		}
		c.doing = true
		try {
			const effect = c.effect as (value: unknown, previous: unknown) => void
			enter({ scope: c, by: c }, () => effect(a.value, c.last?.value))
		} catch (e) {
			failed ??= { error: e }
		} finally {
			c.doing = false
			reading = was
			running = wasRunning
		}
		c.last = { value: a.value }
		for (const f of effects.fs) {
			try {
				f(c, a.r.n, failed ?? {})
			} catch (e) {
				hold(e)
			}
		}
	}

	// pulses

	// rounds until nothing is due: the settled promises land, the due run by rank, the early
	// effects act, the effects act. a pulse in a pulse does nothing
	function pulse() {
		if (pulsing) return
		pulsing = true
		const outer = thrown
		thrown = undefined
		let failed: { error: unknown } | undefined
		try {
			for (;;) {
				// by a head, each taken out as it lands (shift is linear: many settled at once)
				while (landedHead < landed.length) {
					const { r, out } = landed[landedHead]!
					landed[landedHead++] = undefined
					land(r, out)
				}
				landed.length = landedHead = 0
				if (!order.size() && !earlies.live && !acts.live) break
				while (order.size()) {
					const { p, rank } = order.next()
					first(p, rank)
				}
				runQueuedCleanups()
				while (earlies.live) take(earlies)
				clear(earlies)
				while (acts.live) take(acts)
				clear(acts)
			}
		} catch (e) {
			failed = { error: e }
		} finally {
			// left early: the cleanups queued run all the same, what they throw after the first
			try {
				runQueuedCleanups()
			} catch (e) {
				failed ??= { error: e }
			}
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
		// what was held for a pulse (a settling's, a making's) first, then the pulse's own
		thrown = escaped ?? failed ?? thrown
		escaped = undefined
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
		claim,
		// tracked; a result not equal to the last goes to set. first runs at the next pulse. f is
		// given its last result (the last given to set; none yet: undefined). what a listener throws
		// as it is made comes out of a pulse (above).
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
		onRunReturn: returns.on,
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
	// a computer its owner's earlier run made, made again by its run going on: kept, back under the
	// owner and due. not old (made or claimed in this run already, or no run of its owner since):
	// false
	claim: (c: Computer) => boolean
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
	// a run's body returned a value (an awaited one: its promise landed with it), told before
	// anything is done with it (compared, given to set, queued to act): once per run at most, for
	// computes and effects. not told for a throw, PENDING, a stopped run, or one torn down in its
	// body. a write made in the run before this is the run's own; one after, its set's (unread's
	// keeping tells them apart this way)
	onRunReturn: (
		f: (computer: Computer, n: number, value: unknown) => void,
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
	// a promise settled: its result waits for the next pulse (what f throws comes out of it)
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
