// The scheduler: runs code and decides when it runs again. reactivity/conformance/scheduler holds
// the rules as cases.
//
// A change must say who made it: the run open (getRun()), a Run kept from before an await, or a
// computer. With none, the change is from outside (the host, sync).
//
// A run lasts until its function returns, which for an async function is its first await. Only
// keys tracked before that are the run's, so read what you need before you await.
import type { Info } from "@ermine/changeable"
import { type Cause, createCauses } from "./causes.ts"
import { isPromise, same } from "./helpers.ts"
import { createOrder } from "./order.ts"
import { createTracker, type Node } from "./tracker.ts"

// A compute returns or throws this while what it needs is not here; the run ends pending.
export const PENDING: unique symbol = /* @__PURE__ */ Symbol.for("ermine.pending")

export class SchedulerError extends Error {
	constructor(readonly code: "disposed" | "unscoped" | "empty", message: string) {
		super(message)
		this.name = "SchedulerError"
	}
}

export type Equal<T = unknown> = (a: T, b: T) => boolean
export type Run = { readonly computer: Computer; readonly n: number; readonly frame: Frame }

export type { Info }

// A scope's info is the object given and must never be changed.
// A frame is what a change made now is made as. Frames form a logical call stack, separate from
// ownership.
export type Frame = {
	readonly info: Info
	readonly parent: Frame | undefined
}

export type Scope = {
	readonly n: number
	readonly parent: Scope | undefined
	readonly info: Info
	readonly frame: Frame
	newest: Scope | undefined
	older: Scope | undefined
	newer: Scope | undefined
	teardowns: (() => unknown)[]
	state: "alive" | "disposing" | "gone"
	old: boolean
	deed: boolean
}

export type Computer = Scope & {
	kind: "compute" | "effect"
	f: (previous: unknown) => unknown
	set?: (value: never) => void
	effect?: (value: never, previous: never) => void
	equal?: Equal
	readonly node: Node<unknown>
	runs: number
	last?: { value: unknown }
	ran?: Ran
	before: Scope | undefined
	deeds: (() => unknown)[]
	doing: boolean
	cleaning: boolean
	cleaned: boolean
	kept: Cause<Computer>[]
	ranIn: number
	heldIn: number
	values: Computer[]
	after?: Computer
	due: number
	rank: number
	ranked: number
	afters: Map<Computer, number> | undefined
	stamp: number
	seen: number
	wrote: Set<unknown>
	loop?: Computer[]
	looping: boolean
	acting?: Act
	aside?: (() => unknown)[]
	queuedCleanups?: (() => unknown)[]
	cuts?: Computer[]
	early: boolean
}

export type As =
	| {
		kind: "compute"
		f: (previous: never) => unknown
		set: (value: never) => void
		equal?: Equal<never>
	}
	| {
		kind: "effect"
		f: (previous: never) => unknown
		effect: (value: never, previous: never) => void
		equal?: Equal<never>
		early?: boolean
	}

export type EffectOptions = { early?: boolean }

export type Ended = "done" | "pending" | "failed" | "stopped" | "looping"

export type More = {
	equal?: boolean
	error?: unknown
	waits?: Computer
	through?: Computer[]
	kept?: unknown
}

type By = Run | Computer

type Ran = {
	c: Computer
	own: Run
	n: number
	mark: number
	pulse: number
	given: readonly Cause<Computer>[]
	cause: Cause<Computer>
	values: Computer[]
	id: number
	reads: unknown[]
	stopped?: Computer
	loop?: Computer[]
	cut?: boolean
	paused?: Gen
}
type Act = { r: Ran; value: unknown; at: number }
type Queue = { items: (Act | undefined)[]; head: number; live: number }
type Out = { value: unknown } | { error: unknown }

// A generator compute (f is a function*): a yielded promise pauses the run, and the same run
// goes on when it settles.
type Gen = Generator<unknown, unknown, unknown>
const isGen = (v: unknown): v is Gen => Object.prototype.toString.call(v) === "[object Generator]"
class Paused {
	constructor(readonly gen: Gen, readonly p: PromiseLike<unknown>) {}
}
function advance(gen: Gen, input: unknown, threw: boolean): unknown {
	for (;;) {
		const step = threw ? gen.throw(input) : gen.next(input)
		if (step.done) return step.value
		if (isPromise(step.value)) return new Paused(gen, step.value)
		input = step.value
		threw = false
	}
}
function quit(gen: Gen) {
	try {
		gen.return(undefined)
	} catch { /* let go */ }
}

function told<A extends unknown[]>() {
	const t = {
		fs: [] as ((...a: A) => void)[],
		on: (f: (...a: A) => void) => {
			if (!t.fs.includes(f)) t.fs = [...t.fs, f]
			return () => void (t.fs = t.fs.filter((g) => g !== f))
		},
		tell: (...a: A) => {
			let failed: { error: unknown } | undefined
			for (const f of t.fs) {
				try {
					f(...a)
				} catch (e) {
					failed ??= { error: e }
				}
			}
			return failed
		},
	}
	return t
}

type Told<K extends keyof Scheduler> = Scheduler[K] extends (f: (...a: infer A) => void) => unknown
	? A
	: never

class Stop {}

const blank = (info: Info) => {
	for (const _ in info) return false
	return true
}
const none = /* @__PURE__ */ Object.freeze([]) as never[]

const inside: unique symbol = /* @__PURE__ */ Symbol("inside")
type Own = Run & { [inside]: Ran }

export function createScheduler(): Scheduler {
	const tracks = told<Told<"onTrack">>()
	const marks = told<Told<"onMark">>()
	const starts = told<Told<"onRunStart">>()
	const returns = told<Told<"onRunReturn">>()
	const ends = told<Told<"onRunEnd">>()
	const effects = told<Told<"onEffect">>()
	const settles = told<Told<"onSettle">>()
	const afterPulses = told<Told<"onAfterPulse">>()
	const untracks = told<Told<"onTrackingEnd">>()
	const firstTracks = told<Told<"onTrackingStart">>()

	const tracker = createTracker<unknown>()
	// An untracked key stays as undefined, since a Map that loses and gains keys slows in V8.
	let nodes = new Map<unknown, Node<unknown> | undefined>()
	let untracked = 0
	const writers = new Map<unknown, Computer>()
	const live = new Set<Computer>()
	const order = createOrder<Computer>(() => live)
	const causes = createCauses<Computer>()
	const acts: Queue = { items: [], head: 0, live: 0 }
	const earlies: Queue = { items: [], head: 0, live: 0 }
	const landed: ({ r: Ran; out: Out; gen?: Gen } | undefined)[] = []
	let steps = 0
	let landedHead = 0
	const queued: Computer[] = []

	let made = 0
	let runs = 0
	let tick = 0
	let pulses = 0
	let pulsing = false
	let reading: Ran | undefined
	let running: Ran | undefined
	let open: { scope: Scope; frame: Frame; by?: By } | undefined
	let thrown: { error: unknown } | undefined
	const hold = (e: unknown) => void (thrown ??= { error: e })
	const holdFirst = (failed: typeof thrown) => void (thrown ??= failed)
	let escaped: { error: unknown } | undefined
	function rethrow(outer: typeof thrown) {
		const t = thrown
		thrown = outer
		if (t) throw t.error
	}

	function enter<T>(next: typeof open, f: () => T): T {
		const was = open
		open = next
		try {
			return f()
		} finally {
			open = was
		}
	}

	function parent(): Scope {
		if (open === undefined) throw unscoped()
		if (open.scope.state !== "alive") throw disposed()
		return open.scope
	}

	const frameUnder = (up: Scope | undefined): Frame | undefined =>
		up !== undefined && open?.scope === up ? open.frame : up?.frame

	function grow(up: Scope | undefined, info: Info): Scope {
		if (blank(info)) throw empty()
		const o: Scope = {
			n: ++made,
			parent: up,
			info,
			frame: { info, parent: frameUnder(up) },
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

	const doing = (up: Scope | undefined) => up !== undefined && (up as Computer).doing === true

	function link(up: Scope, o: Scope) {
		const l = up.newest
		o.older = l
		if (l) l.newer = o
		up.newest = o
	}
	function unlink(o: Scope) {
		const p = o.parent
		if (o.newer) o.newer.older = o.older
		else if (p?.newest === o) p.newest = o.older
		else if (p !== undefined && (p as Computer).before === o) (p as Computer).before = o.older
		if (o.older) o.older.newer = o.newer
		o.older = o.newer = undefined
		o.old = false
	}
	function cut(o: Scope, old = false): Scope[] {
		const c = o as Computer
		const newest = old ? undefined : o.newest
		if (newest === undefined && c.before === undefined) return none
		const kids: Scope[] = []
		for (let x = newest; x !== undefined; x = x.older) kids.push(x)
		for (let x = c.before; x !== undefined; x = x.older) kids.push(x)
		if (newest !== undefined) o.newest = undefined
		if (c.before !== undefined) c.before = undefined
		for (const x of kids) {
			x.older = x.newer = undefined
			x.old = false
		}
		return kids
	}

	function createScope(info: Info, up?: Scope): Scope {
		if (up === undefined) up = parent()
		if (up.state !== "alive") throw disposed()
		return grow(up, info)
	}

	// Live, so read it now and do not keep it.
	function getInfo(): Info | undefined {
		return open?.frame.info
	}

	function createFrame(info: Info, up?: Frame): Frame {
		return { info, parent: up ?? open?.frame }
	}

	function getRun(): Run | undefined {
		const by = open?.by
		return by === undefined || !("kind" in by) ? by : by.ran?.own
	}

	const latest = (c: Computer) => c.ran?.own.frame ?? c.frame

	const opens = (o: Scope) => ({
		scope: o,
		frame: "kind" in o ? latest(o as Computer) : o.frame,
		by: "kind" in o ? o as Computer : open?.by,
	})

	function registerTeardown(o: Scope, f: () => unknown) {
		if (o.state !== "alive") enter(opens(o), f)
		else if ((o as Computer).doing === true) (o as Computer).deeds.push(f)
		else o.teardowns.push(f)
	}

	// Children first, newest first, then o's teardowns, newest first. Every one runs; the first
	// error is given back.
	function down(o: Scope, kids: Scope[], fs: (() => unknown)[]): { error: unknown } | undefined {
		if (kids.length === 0 && fs.length === 0) return
		let failed: { error: unknown } | undefined
		const was = open
		open = opens(o)
		try {
			for (const kid of kids) {
				const e = dispose(kid)
				failed ??= e
			}
			for (let i = fs.length - 1; i >= 0; i--) {
				const f = fs[i]
				try {
					f()
				} catch (e) {
					failed ??= { error: e }
				}
			}
		} finally {
			open = was
		}
		return failed
	}

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

	function claim(c: Computer, as?: As, again = true): boolean {
		if (!c.old || c.state !== "alive") return false
		if (as !== undefined) become(c, as)
		unlink(c)
		link(c.parent!, c)
		if (!again) return true
		if (running?.loop) running.cut = true
		const t = ++tick
		const now = due(c, t, running) ? [c] : none
		const failed = marks.tell([], running?.own, now, t)
		if (failed) throw failed.error
		return true
	}

	function become(c: Computer, as: As) {
		if (c.acting) unact(c)
		const was = c.kind
		c.kind = as.kind
		c.f = as.f as Computer["f"]
		c.equal = as.equal as Equal | undefined
		c.set = as.kind === "compute" ? as.set : undefined
		c.effect = as.kind === "effect" ? as.effect : undefined
		c.early = as.kind === "effect" && as.early === true
		if (was === as.kind) return
		c.last = undefined
		if (as.kind === "effect") {
			unwrite(c)
			return
		}
		for (let x = c.newest; x !== undefined; x = x.older) x.deed = false
		if (c.deeds.length) {
			c.teardowns = c.teardowns.concat(c.deeds)
			c.deeds = []
		}
	}

	function dropUnclaimedChildren(c: Computer, r: Ran) {
		if (c.before !== undefined) {
			const kids = cut(c, true)
			const was = reading
			const wasRunning = running
			reading = undefined
			running = r
			try {
				holdFirst(down(c, kids, none))
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

	function teardown(o: Scope) {
		if (o.state !== "alive") return
		const outer = thrown
		thrown = undefined
		holdFirst(dispose(o))
		rethrow(outer)
	}

	function dispose(o: Scope): { error: unknown } | undefined {
		if (o.state !== "alive") return
		o.state = "disposing"
		const c = "kind" in o ? o as Computer : undefined
		let fs = o.teardowns
		if (c) {
			drop(c)
			if (c.queuedCleanups || c.aside || c.deeds.length) {
				fs = [...c.queuedCleanups ?? none, ...c.aside ?? none, ...c.deeds, ...fs]
				c.queuedCleanups = c.aside = undefined
				c.deeds = []
			}
		}
		o.teardowns = []
		const failed = down(o, cut(o), fs)
		o.state = "gone"
		if (c?.ran?.paused !== undefined) letGo(c.ran)
		if (c) c.ran = undefined
		unlink(o)
		return failed
	}

	function drop(c: Computer) {
		live.delete(c)
		order.gone(c)
		const read = tracker.reads(c.node)
		tracker.untrack(c.node)
		for (const node of read) unread(node)
		unwrite(c)
		if (c.acting) unact(c)
		c.kept.length = 0
	}

	function unwrite(c: Computer) {
		for (const k of c.wrote) if (writers.get(k) === c) writers.delete(k)
		c.wrote.clear()
	}

	const disposed = () => new SchedulerError("disposed", "the scope is disposed")
	const unscoped = () => new SchedulerError("unscoped", "no scope is open")
	const empty = () => new SchedulerError("empty", "a scope's info has no keys")

	function unread(node: Node<unknown>) {
		if (node.first !== null || nodes.get(node.owner) !== node) return
		nodes.set(node.owner, undefined)
		if (++untracked > nodes.size >> 1 && nodes.size > 64) {
			const kept = new Map<unknown, Node<unknown> | undefined>()
			for (const [k, n] of nodes) if (n !== undefined) kept.set(k, n)
			nodes = kept
			untracked = 0
		}
		holdFirst(untracks.tell(node.owner))
	}

	function trim(n: Node<unknown>) {
		let l = n.cursor !== null ? n.cursor.next : n.reads
		if (l === null) return
		const stale: Node<unknown>[] = []
		for (; l !== null; l = l.next) stale.push(l.to)
		tracker.trim(n)
		for (const node of stale) unread(node)
	}

	function make(
		kind: "compute" | "effect",
		f: (previous: unknown) => unknown,
		then: (value: never, previous: never) => void,
		equal?: Equal<never>,
		key?: unknown,
		options?: EffectOptions,
		info?: Info,
	): Computer {
		const o = parent()
		const c = {
			n: ++made,
			parent: o,
			info: undefined,
			frame: undefined,
			newest: undefined,
			older: undefined,
			newer: undefined,
			teardowns: [],
			state: "alive",
			old: false,
			deed: doing(o),
			kind,
			f,
			set: kind === "compute" ? then : undefined,
			effect: kind === "effect" ? then : undefined,
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
			cleaning: false,
			cleaned: false,
			before: undefined,
			deeds: [],
			doing: false,
			early: kind === "effect" && options?.early === true,
		} as unknown as Computer & { node: Node<unknown> }
		c.node = tracker.node(c)
		link(o, c)
		live.add(c)
		if (key !== undefined) write(c, key)
		order.started(c)
		if (running?.loop) running.cut = true
		const t = ++tick
		;(c as { info: Info }).info = { ...info, mark: t }
		;(c as { frame: Frame }).frame = { info: c.info, parent: frameUnder(o) }
		const now = due(c, t, running) ? [c] : []
		const outer = thrown
		thrown = undefined
		holdFirst(marks.tell([], running?.own, now, t))
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
		escaped ??= thrown
		thrown = outer
		return c
	}

	// A run's cause. One from an earlier pulse is cut to its computation alone.
	function causeOf(r: Ran): Cause<Computer> {
		if (r.pulse !== pulses) {
			r.cause = causes.run(r.c, [])
			r.pulse = pulses
		}
		return r.cause
	}

	function due(c: Computer, t: number, by?: Ran, old?: boolean): boolean {
		if (c.state !== "alive") return false
		const cause = by && by === by.c.ran ? causeOf(by) : undefined
		if (cause) causes.keep(c, cause)
		let loop = causes.loop(cause, c)
		if (loop && by && by.c === c && c.cleaning && !c.cleaned) loop = undefined
		if (loop && by!.loop) {
			if (!old) by!.cut = true
			return false
		}
		if (!old) c.loop = loop
		if (c.looping) {
			if (loop) return false
			c.looping = false
		}
		if (order.has(c)) return false
		order.set(c, t)
		return true
	}

	function mark(keys: readonly unknown[], by?: By): number {
		const t = ++tick
		const r = by === undefined ? undefined : "kind" in by ? by.ran : (by as Own)[inside]
		const w = r?.c.kind === "compute" && r.c.state === "alive" ? r.c : undefined
		const now: Computer[] = marks.fs.length ? [] : none
		for (const key of keys) {
			if (w) write(w, key)
			const node = nodes.get(key)
			if (node === undefined) continue
			for (let l = node.first; l !== null; l = l.after) {
				const c = l.from.owner as Computer
				const old = tracker.old(l)
				if (old && running?.c === c) continue
				if (due(c, t, r, old) && now !== none) now.push(c)
			}
		}
		const failed = marks.tell(keys, r?.own, now, t)
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
		let failed = first ? firstTracks.tell(key) : undefined
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

	function track(key: unknown) {
		if (reading) follow(reading, key)
	}

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
		const own = { computer: c, n, frame: { info: { run: n, mark }, parent: c.frame } } as Own
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
		if (c.ran?.paused !== undefined) letGo(c.ran)
		c.ran = r
		if (c.acting) unact(c)
		for (const f of starts.fs) {
			try {
				f(c, n, rank, own.frame)
			} catch (e) {
				hold(e)
			}
		}
		own[inside] = r
		if (c.state !== "alive") return
		liftChildren(c)
		let value: unknown
		let failed: { error: unknown } | undefined
		const was = reading
		const wasRunning = running
		reading = running = r
		tracker.begin(c.node)
		const wasOpen = open
		open = { scope: c, frame: own.frame, by: own }
		try {
			value = c.f(c.last?.value)
			if (isGen(value)) value = advance(value, undefined, false)
		} catch (e) {
			if (e === PENDING) value = PENDING
			else failed = { error: e }
		} finally {
			open = wasOpen
			reading = was
			running = wasRunning
			tracker.leave(c.node)
		}
		ended(r, value, failed)
	}

	function letGo(r: Ran) {
		const gen = r.paused
		if (gen === undefined) return
		r.paused = undefined
		const wasOpen = open
		const was = reading
		const wasRunning = running
		open = undefined
		reading = running = undefined
		try {
			quit(gen)
		} finally {
			open = wasOpen
			reading = was
			running = wasRunning
		}
	}

	function ended(r: Ran, value: unknown, failed: { error: unknown } | undefined) {
		const c = r.c
		if (c.state !== "alive") return value instanceof Paused ? quit(value.gen) : undefined
		if (r.stopped) return stop(r)
		if (failed) return finish(r, "failed", failed)
		if (value === PENDING) return finish(r, "pending")
		if (value instanceof Paused) return paused(r, value)
		if (isPromise(value)) return awaiting(r, value)
		result(r, value)
	}

	function paused(r: Ran, w: Paused) {
		r.paused = w.gen
		finish(r, "pending")
		const settle = (out: Out) => {
			if (r.paused !== w.gen) return
			if (r.c.state !== "alive" || r.c.runs !== r.n) return letGo(r)
			landed.push({ r, out, gen: w.gen })
			escaped ??= settles.tell()
		}
		Promise.resolve(w.p).then(
			(value) => settle({ value }),
			(error) => settle({ error }),
		)
	}

	function resume(r: Ran, gen: Gen, out: Out) {
		const c = r.c
		if (r.paused !== gen) return
		if (c.state !== "alive" || c.runs !== r.n || order.has(c)) return letGo(r)
		r.paused = undefined
		r.values = r.values.slice()
		const outer = thrown
		thrown = undefined
		try {
			let value: unknown
			let failed: { error: unknown } | undefined
			const was = reading
			const wasRunning = running
			reading = running = r
			tracker.resume(c.node)
			const wasOpen = open
			open = { scope: c, frame: { info: { step: ++steps }, parent: r.own.frame }, by: r.own }
			try {
				value = "error" in out ? advance(gen, out.error, true) : advance(gen, out.value, false)
			} catch (e) {
				if (e === PENDING) value = PENDING
				else failed = { error: e }
			} finally {
				open = wasOpen
				reading = was
				running = wasRunning
				tracker.leave(c.node)
			}
			ended(r, value, failed)
		} finally {
			rethrow(outer)
		}
	}

	function stop(r: Ran) {
		if (!order.has(r.c)) r.c.loop = r.loop
		order.waits(r.c, r.stopped)
		order.set(r.c, r.mark)
		finish(r, "stopped", { waits: r.stopped })
	}

	function result(r: Ran, v: unknown) {
		const c = r.c
		for (const f of returns.fs) {
			try {
				f(c, r.n, v)
			} catch (e) {
				hold(e)
			}
		}
		if (c.state !== "alive") return
		let equal: boolean
		try {
			equal = c.last !== undefined && same(c.equal, v, c.last.value)
		} catch (e) {
			return finish(r, "failed", { error: e })
		}
		if (r.loop && (!equal || r.cut)) {
			return finish(r, "looping", { equal, through: r.loop })
		}
		if (equal) return finish(r, "done", { equal })
		if (c.kind === "effect") {
			const q = c.early ? earlies : acts
			const a: Act = c.acting = { r, value: v, at: q.items.length }
			q.items.push(a)
			q.live++
			return finish(r, "done", { equal, kept: v })
		}
		let failed: { error: unknown } | undefined
		const was = reading
		const wasRunning = running
		const wasOpen = open
		reading = undefined
		running = r
		open = { scope: c, frame: latest(c), by: c }
		try {
			;(c.set as (value: unknown) => void)(v)
		} catch (e) {
			failed = { error: e }
		} finally {
			open = wasOpen
			reading = was
			running = wasRunning
		}
		if (failed) {
			c.last = undefined
			return finish(r, "failed", { equal, error: failed.error, kept: v })
		}
		c.last = { value: v }
		finish(r, "done", { equal, kept: v })
	}

	function finish(r: Ran, ended: Ended, more: More = {}) {
		const c = r.c
		if (r.loop && r.cut && (ended === "failed" || ended === "done" && more.equal)) {
			return finish(r, "looping", { ...more, through: r.loop })
		}
		if (c.ran === r && c.state === "alive") {
			if (ended === "done") {
				trim(c.node)
				dropUnclaimedChildren(c, r)
			} else tracker.dedupe(c.node)
		}
		if (c.state === "alive") {
			if (ended !== "done" && r.given.length) {
				c.kept = r.given.concat(c.kept)
			}
			r.given = none
			if (ended === "looping") c.looping = true
			if (ended !== "stopped") order.sees(c, r.values)
		}
		if (ended !== "pending") r.loop = undefined
		for (const f of ends.fs) {
			try {
				f(c, r.n, ended, r.reads, more)
			} catch (e) {
				hold(e)
			}
		}
	}

	function awaiting(r: Ran, p: PromiseLike<unknown>) {
		finish(r, "pending")
		const settle = (out: Out) => {
			if (r.c.state !== "alive" || r.c.runs !== r.n) return
			landed.push({ r, out })
			escaped ??= settles.tell()
		}
		Promise.resolve(p).then(
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

	function unact(c: Computer) {
		const q = c.early ? earlies : acts
		q.items[c.acting!.at] = undefined
		q.live--
		c.acting = undefined
	}

	function take(q: Queue) {
		const outer = thrown
		thrown = undefined
		try {
			while (q.items[q.head] === undefined) q.head++
			perform(q.items[q.head]!, q)
		} finally {
			rethrow(outer)
		}
	}
	function perform(a: Act, q: Queue) {
		const c = a.r.c
		unact(c)
		if (q.live) {
			for (let o = c.parent; o !== undefined; o = o.parent) {
				const x = "kind" in o ? (o as Computer).acting : undefined
				if (x === undefined || (o as Computer).early !== c.early) continue
				perform(x, q)
				break
			}
		}
		act(a)
	}
	function clear(q: Queue) {
		q.items.length = 0
		q.head = 0
	}

	function act(a: Act) {
		const c = a.r.c
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
		c.cleaning = true
		let failed = down(c, deeds, fs)
		c.cleaning = false
		if (c.state !== "alive") {
			reading = was
			running = wasRunning
			holdFirst(failed)
			return
		}
		if (order.has(c)) {
			c.cleaned = true
			reading = was
			running = wasRunning
			holdFirst(failed)
			return
		}
		c.cleaned = false
		c.doing = true
		const wasOpen = open
		open = { scope: c, frame: latest(c), by: c }
		try {
			const effect = c.effect as (value: unknown, previous: unknown) => void
			effect(a.value, c.last?.value)
		} catch (e) {
			failed ??= { error: e }
		} finally {
			open = wasOpen
			c.doing = false
			reading = was
			running = wasRunning
		}
		c.last = { value: a.value }
		holdFirst(effects.tell(c, a.r.n, failed ?? {}))
	}

	function pulse() {
		if (pulsing) return
		pulsing = true
		const outer = thrown
		thrown = undefined
		let failed: { error: unknown } | undefined
		try {
			for (;;) {
				// Taken from a head as each lands, since shift is linear and many may settle at once.
				while (landedHead < landed.length) {
					const { r, out, gen } = landed[landedHead]!
					landed[landedHead++] = undefined
					if (gen !== undefined) resume(r, gen, out)
					else land(r, out)
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
			holdFirst(afterPulses.tell())
		}
		thrown = escaped ?? failed ?? thrown
		escaped = undefined
		rethrow(outer)
	}

	let swept = 0
	function sweep() {
		if (nodes.size < 2 * swept + 64) return
		for (const node of nodes.values()) if (node !== undefined) unread(node)
		swept = nodes.size
	}

	function runWithScope<T>(o: Scope, f: () => T): T {
		if (o.state !== "alive") throw disposed()
		const was = reading
		reading = undefined
		try {
			return enter({ scope: o, frame: o.frame, by: open?.by }, f)
		} finally {
			reading = was
		}
	}

	function runWith<T>(o: Scope, frame: Frame, f: () => T): T {
		if (o.state !== "alive") throw disposed()
		const was = reading
		reading = undefined
		try {
			return enter({ scope: o, frame, by: open?.by }, f)
		} finally {
			reading = was
		}
	}

	return {
		createRootScope: (info: Info) => grow(undefined, info),
		createScope,
		runWithScope,
		runWith,
		createFrame,
		getCurrentScope: () => open?.scope,
		getCurrentFrame: () => open?.frame,
		getInfo,
		getRun,
		registerTeardown,
		teardown,
		claim,
		// key: where set's results land when known, so readers wait for this compute from the first
		// pulse. info: copied into its info.
		createComputer: <T>(
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			set: (value: T) => void,
			equal?: Equal<T>,
			key?: unknown,
			info?: Info,
		): Computer =>
			make("compute", f as Computer["f"], set, equal as Equal<never>, key, undefined, info),
		// early: acted on in the round's early queue.
		createEffect: <T>(
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			effect: (value: T, previous: T | undefined) => void,
			equal?: Equal<T>,
			options?: EffectOptions,
			info?: Info,
		): Computer =>
			make(
				"effect",
				f as Computer["f"],
				effect,
				equal as Equal<never>,
				undefined,
				options,
				info,
			),
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

export type Scheduler = {
	createRootScope: (info: Info) => Scope
	createScope: (info: Info, parent?: Scope) => Scope
	runWithScope: <T>(o: Scope, f: () => T) => T
	runWith: <T>(o: Scope, frame: Frame, f: () => T) => T
	createFrame: (info: Info, up?: Frame) => Frame
	getCurrentScope: () => Scope | undefined
	getCurrentFrame: () => Frame | undefined
	getInfo: () => Info | undefined
	getRun: () => Run | undefined
	registerTeardown: (o: Scope, f: () => unknown) => void
	teardown: (o: Scope) => void
	claim: (c: Computer, as?: As, again?: boolean) => boolean
	createComputer: <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		set: (value: T) => void,
		equal?: Equal<T>,
		key?: unknown,
		info?: Info,
	) => Computer
	createEffect: <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		effect: (value: T, previous: T | undefined) => void,
		equal?: Equal<T>,
		options?: EffectOptions,
		info?: Info,
	) => Computer
	track: (key: unknown) => void
	mark: (keys: readonly unknown[], run?: Run | Computer) => number
	pulse: () => void
	onTrack: (f: (key: unknown, run: Run) => void) => () => void
	onMark: (
		f: (
			keys: readonly unknown[],
			run: Run | undefined,
			due: Computer[],
			tick: number,
		) => void,
	) => () => void
	onRunStart: (
		f: (computer: Computer, n: number, rank: number, frame: Frame) => void,
	) => () => void
	// Told once per run with the value its body returned; not for a throw, PENDING or a stopped run.
	onRunReturn: (
		f: (computer: Computer, n: number, value: unknown) => void,
	) => () => void
	onRunEnd: (
		f: (
			computer: Computer,
			n: number,
			ended: Ended,
			reads: readonly unknown[],
			more: More,
		) => void,
	) => () => void
	onEffect: (
		f: (computer: Computer, n: number, more: { error?: unknown }) => void,
	) => () => void
	onSettle: (f: () => void) => () => void
	onAfterPulse: (f: () => void) => () => void
	// Told when a key's last tracker lets go of it.
	onTrackingEnd: (f: (key: unknown) => void) => () => void
	// Told in the reading run, so a write made now is that run's.
	onTrackingStart: (f: (key: unknown) => void) => () => void
}
