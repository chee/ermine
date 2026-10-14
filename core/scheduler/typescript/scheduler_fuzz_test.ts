// the scheduler with its tracker, where scheduler_test.ts and the scheduler suite's fuzz do not
// reach: random graphs of computes over host keys and each other's (sums, conditionals, a mod
// that cuts off, failures), effects over them, random writes, disposals and new computations, a
// pulse after each. checked after every pulse, and at every act:
//   - every live compute's value is the model's: everything evaluated again from scratch
//   - effects act once at most per pulse, exactly when the model's value differs from the one
//     acted on last, with that value and the last as previous; at an act, every compute already
//     has the model's value (no half-updated state, diamonds included)
//   - set is never given a value equal to the last (the cut off stops there)
//   - a run starts only for a reason: new, its last run stopped, or a key its last run read was
//     said changed since that run began
//   - the tracker: every live computation's reads are its last run's keys, in first-read order;
//     both lists of every link agree; a disposed computation holds no links
// a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import {
	type By,
	type Computation,
	createScheduler,
	type Moment,
	type Read,
	type Scope,
} from "./scheduler.ts"
import type { Link, Node } from "./tracker.ts"
import { rand } from "../../fuzz/gen.ts"

const SEEDS = 40
const STEPS = 15
const HOST = ["h0", "h1", "h2", "h3", "h4"]

type R = ReturnType<typeof rand>
type Expr =
	| { read: string }
	| { lit: number }
	| { sum: Expr[] }
	| { mod: [Expr, number] }
	| { if: [Expr, Expr, Expr] }
	| { fail: [Expr, number] }

class Fail extends Error {}

// over keys whose values come from look; numbers only, nothing there is 0
function evaluate(e: Expr, look: (key: string) => unknown): number {
	const num = (v: unknown) => typeof v === "number" ? v : 0
	if ("read" in e) return num(look(e.read))
	if ("lit" in e) return e.lit
	if ("sum" in e) return e.sum.reduce((n, x) => n + evaluate(x, look), 0)
	if ("mod" in e) return evaluate(e.mod[0], look) % e.mod[1]
	if ("if" in e) {
		return evaluate(e.if[0], look) % 2 === 0 ? evaluate(e.if[1], look) : evaluate(e.if[2], look)
	}
	const v = evaluate(e.fail[0], look)
	if (v === e.fail[1]) throw new Fail(`fails at ${v}`)
	return v
}

function expr(r: R, keys: string[], depth: number): Expr {
	const k = r.pick(depth > 0 ? 12 : 3)
	if (k < 2) return { read: r.one(keys) }
	if (k < 3) return r.pick(3) ? { read: r.one(keys) } : { lit: r.pick(4) }
	if (k < 6) return { sum: Array.from({ length: 2 + r.pick(2) }, () => expr(r, keys, depth - 1)) }
	if (k < 8) return { mod: [expr(r, keys, depth - 1), 2 + r.pick(2)] }
	if (k < 11) {
		return { if: [expr(r, keys, depth - 1), expr(r, keys, depth - 1), expr(r, keys, depth - 1)] }
	}
	return { fail: [expr(r, keys, depth - 1), r.pick(8)] }
}

// a computation as made here
type Made = {
	name: string
	kind: "compute" | "effect"
	e: Expr
	c: Computation
	// its runs: the one going on or last, and the one before
	run?: { tick: number; reads: Set<string>; ended?: string }
	// an effect's: the value acted on last
	acted?: { value: number }
}

// the readers' list of a key node, both ways; each link's from holds it once in its reads
function readersOf(node: Node<unknown>, at: string): Link<unknown>[] {
	const out: Link<unknown>[] = []
	let before: Link<unknown> | null = null
	for (let l = node.first; l !== null; l = l.after) {
		assert(l.to === node, `${at}: a reader's to`)
		assert(l.before === before, `${at}: a reader's before`)
		let held = 0
		for (let x = l.from.reads; x !== null; x = x.next) if (x === l) held++
		assertEquals(held, 1, `${at}: a reader's link in its from's reads`)
		out.push(l)
		before = l
	}
	assert(node.last === before, `${at}: the readers' last`)
	return out
}
function readsOf(node: Node<unknown>, at: string): Link<unknown>[] {
	const out: Link<unknown>[] = []
	let prev: Link<unknown> | null = null
	for (let l = node.reads; l !== null; l = l.next) {
		assert(l.from === node, `${at}: a read's from`)
		assert(l.prev === prev, `${at}: a read's prev`)
		out.push(l)
		prev = l
	}
	// outside a run: the cursor is the last link
	assert(node.cursor === prev, `${at}: the cursor`)
	assertEquals(node.gen, 0, `${at}: gen outside a run`)
	return out
}

// what the seeds reached, counted
type Reach = { acts: number; cut: number; runs: number; failed: number }

// one seed's run
function seeded(seed: number, reach: Reach) {
	const r = rand(seed)
	const label = (s: string) => `seed ${seed}, ${s}`
	// each moment kept, and told to what the pulse checks
	const moments: Moment[] = []
	let told = (_: Moment) => {}
	const s = createScheduler({ hook: (m) => (moments.push(m), told(m)) })
	const store = new Map<string, number>()
	// the tick each key was last said changed at
	const changedAt = new Map<string, number>()
	const changed = (keys: string[], by?: Computation) => {
		const t = s.changed(keys, by)
		for (const k of keys) changedAt.set(k, t)
	}
	const problems: string[] = []
	const root = s.root()
	const scopes: Scope[] = [root]
	for (let i = 0; i < 3; i++) scopes.push(s.scope([], r.one(scopes)))
	const made: Made[] = []
	const byComputation = new Map<Computation, Made>()
	const alive = (m: Made) => m.c.state === "alive"

	// what every compute and effect should come to: from scratch over the host's values; a
	// disposed compute's value stays; one that fails keeps the value it had
	let expected = new Map<string, number | undefined>()
	function model() {
		const out = new Map<string, number | undefined>()
		const look = (key: string): unknown => {
			const m = made.find((x) => x.name === key)
			if (m === undefined || !alive(m)) return store.get(key)
			if (!out.has(key)) {
				let v: number | undefined
				try {
					v = evaluate(m.e, look)
				} catch (e) {
					if (!(e instanceof Fail)) throw e
					v = store.get(key)
				}
				out.set(key, v)
			}
			return out.get(key)
		}
		for (const m of made) {
			if (!alive(m)) continue
			if (m.kind === "compute") look(m.name)
			else {
				try {
					out.set(m.name, evaluate(m.e, look))
				} catch (e) {
					if (!(e instanceof Fail)) throw e
					out.set(m.name, undefined)
				}
			}
		}
		return out
	}
	// at an act: every live compute already has the model's value
	function settled(at: string) {
		for (const m of made) {
			if (m.kind !== "compute" || !alive(m)) continue
			const want = expected.get(m.name)
			if (store.get(m.name) !== want) {
				problems.push(`${at}: ${m.name} is ${store.get(m.name)}, not ${want}`)
			}
		}
	}

	let pulses = 0
	function make(kind: "compute" | "effect") {
		const name = `${kind[0]}${made.length}`
		// over the host's keys and the computes made before it
		const keys = [...HOST, ...made.filter((m) => m.kind === "compute").map((m) => m.name)]
		const e = expr(r, keys, 2 + r.pick(2))
		const o = r.one(scopes.filter((o) => o.state === "alive"))
		const m = { name, kind, e } as Made
		const f = (read: (key: unknown) => void) =>
			evaluate(e, (key) => {
				m.run!.reads.add(key)
				read(key)
				return store.get(key)
			})
		if (kind === "compute") {
			m.c = s.run(o, () =>
				s.compute(f, (v: number) => {
					if (store.has(name) && Object.is(store.get(name), v)) {
						problems.push(`${name}: set the value it had, ${v}`)
					}
					store.set(name, v)
					changed([name], m.c)
				}))
		} else {
			m.c = s.run(o, () =>
				s.effect(f, (v: number, previous: number | undefined) => {
					const at = `pulse ${pulses}: ${name} acts on ${v}`
					if (previous !== m.acted?.value) {
						problems.push(`${at}: previous ${previous}, not ${m.acted?.value}`)
					}
					if (v !== expected.get(name)) problems.push(`${at}, not ${expected.get(name)}`)
					settled(at)
					m.acted = { value: v }
				}))
		}
		made.push(m)
		byComputation.set(m.c, m)
	}
	for (let i = 4 + r.pick(5); i > 0; i--) make("compute")
	for (let i = 1 + r.pick(3); i > 0; i--) make("effect")
	for (let i = 2 + r.pick(4); i > 0; i--) make("compute")
	for (let i = 1 + r.pick(2); i > 0; i--) make("effect")

	// every node seen for each key: one forgotten (no readers left) is made again when read again
	const keyNodes = new Map<string, Set<Node<unknown>>>()
	function pulse(what: string) {
		const at = label(`pulse ${++pulses} (${what})`)
		expected = model()
		const actedBefore = new Map(made.map((m) => [m, m.acted]))
		moments.length = 0
		// each start against the run before it
		told = (m: Moment) => {
			if ("starts" in m) {
				const x = byComputation.get(m.starts)!
				const last = x.run
				if (last && last.ended !== "stopped") {
					const why = [...last.reads].some((k) => (changedAt.get(k) ?? 0) > last.tick)
					if (!why) problems.push(`${at}: ${x.name} ran for no reason`)
				}
				x.run = { tick: s.tick(), reads: new Set() }
				reach.runs++
			} else if ("ends" in m) {
				const x = byComputation.get(m.ends)!
				x.run!.ended = m.ended
				if (m.ended === "done" && m.equal) reach.cut++
				if (m.ended === "failed") reach.failed++
			}
		}
		s.pulse()
		told = () => {}
		assertEquals(problems, [], at)

		// the model's values
		for (const m of made) {
			if (m.kind !== "compute" || !alive(m)) continue
			assertEquals(store.get(m.name), expected.get(m.name), `${at}: ${m.name}`)
		}
		// acts: once at most, exactly when the value differs from the one acted on last
		const acting = new Map<Computation, number>()
		for (const m of moments) {
			if ("acts" in m) acting.set(m.acts, (acting.get(m.acts) ?? 0) + 1)
		}
		for (const m of made) {
			if (m.kind !== "effect") continue
			const n = acting.get(m.c) ?? 0
			assert(n <= 1, `${at}: ${m.name} acted ${n} times`)
			reach.acts += n
			if (!alive(m)) {
				assertEquals(n, 0, `${at}: ${m.name} acted, disposed`)
				continue
			}
			const want = expected.get(m.name), before = actedBefore.get(m)
			const due = want !== undefined && (before === undefined || before.value !== want)
			assertEquals(n, due ? 1 : 0, `${at}: ${m.name} on ${want}, last ${before?.value}`)
		}
		// the tracker: reads are the last run's, in order; both lists agree
		for (const m of made) {
			const node = m.c.node
			const links = readsOf(node, `${at}: ${m.name}`)
			if (!alive(m)) {
				assertEquals(links.length, 0, `${at}: ${m.name} disposed, still reading`)
				continue
			}
			assert(m.run?.ended !== undefined && m.run.ended !== "stopped", `${at}: ${m.name}`)
			// a key met again in order after a new link to it was made keeps both (as the
			// tracker's model does): once each, the keys are the run's, in first-read order
			assertEquals(
				[...new Set(links.map((l) => l.to.owner))],
				[...m.run!.reads],
				`${at}: ${m.name}'s reads`,
			)
			for (const l of links) {
				const key = l.to.owner as string
				if (!keyNodes.has(key)) keyNodes.set(key, new Set())
				keyNodes.get(key)!.add(l.to)
			}
		}
		for (const [key, seen] of keyNodes) {
			const readers: Made[] = []
			let read = 0
			for (const node of seen) {
				const of = readersOf(node, `${at}: ${key}`)
				if (of.length) read++
				for (const l of of) readers.push(byComputation.get(l.from.owner as Computation)!)
			}
			assert(read <= 1, `${at}: ${key} read through ${read} nodes`)
			for (const x of readers) assert(alive(x), `${at}: ${key} read by ${x.name}, disposed`)
			const want = made.filter((x) => alive(x) && x.run!.reads.has(key))
			assertEquals(
				[...new Set(readers.map((x) => x.name))].sort(),
				want.map((x) => x.name).sort(),
				`${at}: ${key}'s readers`,
			)
		}
	}

	pulse("the first")
	for (let step = 0; step < STEPS; step++) {
		const k = r.pick(12)
		if (k < 7) {
			// the host writes a few keys, said changed in one call or one each
			const keys = [...new Set(Array.from({ length: 1 + r.pick(3) }, () => r.one(HOST)))]
			for (const key of keys) store.set(key, r.pick(6))
			if (r.pick(2)) changed(keys)
			else for (const key of keys) changed([key])
			pulse(`wrote ${keys}`)
		} else if (k < 9) {
			const living = made.filter(alive)
			if (living.length) {
				const m = r.one(living)
				s.dispose(m.c)
				pulse(`disposed ${m.name}`)
			}
		} else if (k < 10) {
			const o = r.one(scopes.slice(1))
			if (o.state === "alive") {
				s.dispose(o)
				pulse(`disposed scope ${o.n}`)
			}
		} else if (scopes.some((o) => o.state === "alive")) {
			make(r.pick(3) ? "compute" : "effect")
			pulse(`made ${made[made.length - 1].name}`)
		}
	}
}

Deno.test(`scheduler fuzz: ${SEEDS} seeds × ${STEPS} steps, against a model, the tracker kept right`, () => {
	const reach: Reach = { acts: 0, cut: 0, runs: 0, failed: 0 }
	for (let seed = 1; seed <= SEEDS; seed++) seeded(seed, reach)
	const { acts, cut, runs, failed } = reach
	assert(
		acts > 100 && cut > 50 && failed > 10,
		`the fuzz reaches: ${acts} acts, ${cut} cut off, ${failed} failed, ${runs} runs`,
	)
})

// the loops fuzz: where no from-scratch value exists. cyclic systems (any computation reads and
// writes any key), writes in runs, cleanups that write, computations made in runs and acts,
// async computes whose promises settle while they are due again and write after their await
// (with by, or as from outside), computations disposed by their own cleanups. checked after every
// pulse: it ended (past BOUND runs the hook throws), it left nothing due (another pulse runs
// nothing), no f, set or act was called for a computation gone, and an effect's runs pile
// nothing up under it. a few dozen seeds (fuzz runs small)
const LOOP_SEEDS = 40
const LOOP_STEPS = 15
const BOUND = 5000
const KEYS = ["k0", "k1", "k2", "k3", "k4", "k5"]

type Loops = { looping: number; stops: number; landed: number; made: number; runs: number }

async function loops(seed: number, reach: Loops) {
	const r = rand(seed)
	const at = (s: string) => `loops seed ${seed}, ${s}`
	let runs = 0
	const s = createScheduler({
		hook: (m) => {
			if ("starts" in m && ++runs > BOUND) throw new Error(at(`a pulse past ${BOUND} runs`))
			if ("starts" in m) reach.runs++
			if ("ends" in m && m.ended === "looping") reach.looping++
			if ("ends" in m && m.ended === "stopped") reach.stops++
		},
	})
	const store = new Map<string, number>()
	const write = (key: string, v: number, by?: By) => {
		store.set(key, v)
		s.changed([key], by)
	}
	const problems: string[] = []
	// told it is called: f, set or act of c
	const called = (c: Computation, what: string) => {
		if (c.state !== "alive") problems.push(`${what} of ${c.n}, gone`)
	}
	const effects: Computation[] = []
	const scopes: Scope[] = [s.root()]
	const living: Computation[] = []
	// the settling of each pending promise
	const pending: (() => void)[] = []

	// a sum of a few keys' values, read through read, kept small so loops come round
	const sum = (read: Read, keys: string[]) => {
		let n = 0
		for (const k of keys) {
			read(k)
			n += store.get(k) ?? 0
		}
		return n % 5
	}
	const keys = () => Array.from({ length: 1 + r.pick(3) }, () => r.one(KEYS))

	// what a computation is, drawn once: one made in a run or act is the same each time. near: the
	// keys its maker reads; one made by a computation is a compute, mostly writing those
	type Plan = {
		kind: number
		ins: string[]
		out: string
		other: string
		// a cleanup's that disposes it; an async one's write after its await names it
		dies: boolean
		named: boolean
		// what it makes, in each run or act; or under a scope
		makes?: Plan
	}
	function plan(depth = 0, near = KEYS): Plan {
		const ins = keys()
		const p: Plan = {
			kind: r.pick(depth > 0 ? 3 : 7),
			ins,
			out: r.one(r.pick(3) ? near : KEYS),
			other: r.one(KEYS),
			dies: r.pick(4) === 0,
			named: r.pick(3) !== 0,
		}
		if (p.kind === 3 && r.pick(2) === 0) p.makes = plan(depth + 1, ins)
		if (p.kind === 5) p.makes = plan(depth + 1, ins)
		if (p.kind === 6) p.makes = plan(depth + 1)
		return p
	}

	function make(o: Scope, p: Plan): Computation | undefined {
		if (o.state !== "alive") return
		return s.run(o, () => build(p))
	}
	// p, made under the scope open
	function build(p: Plan): Computation | undefined {
		const { ins, out, other } = p
		let c!: Computation
		if (p.kind === 0) {
			// a compute whose set writes its key
			c = s.compute((read) => (called(c, "f"), sum(read, ins)), (v) => {
				called(c, "set")
				write(out, v, c)
			})
		} else if (p.kind === 1) {
			// a compute writing in its run
			c = s.compute((read) => {
				called(c, "f")
				const v = sum(read, ins)
				write(other, (v + 1) % 5, read)
				return v % 2
			}, () => called(c, "set"))
		} else if (p.kind === 2) {
			// a compute whose cleanup writes, and now and then disposes it
			c = s.compute((read) => {
				called(c, "f")
				const v = sum(read, ins)
				s.cleanup(() => {
					write(other, (v + 1) % 5, c)
					if (p.dies && (store.get(other) ?? 0) > 2) s.dispose(c)
				})
				return v
			}, (v) => {
				called(c, "set")
				write(out, v, c)
			})
		} else if (p.kind === 3) {
			// an effect: each run makes a scope under it; its act writes, and may make a compute
			c = s.effect((read) => {
				called(c, "f")
				s.scope()
				return sum(read, ins)
			}, (v) => {
				called(c, "act")
				write(other, (v + 1) % 5, c)
				if (p.makes && make(c, p.makes)) reach.made++
			})
			effects.push(c)
		} else if (p.kind === 4) {
			// an async compute: after its await it writes, with by or from outside
			c = s.compute((read) => {
				called(c, "f")
				const v = sum(read, ins)
				return new Promise<number>((done) => pending.push(() => done(v))).then((v) => {
					write(other, (v + 1) % 5, p.named ? read : undefined)
					return v
				})
			}, (v: number) => {
				called(c, "set")
				reach.landed++
				write(out, v, c)
			})
		} else if (p.kind === 5) {
			// a compute making a compute under itself in each run
			c = s.compute((read) => {
				called(c, "f")
				if (make(c, p.makes!)) reach.made++
				return sum(read, ins)
			}, (v) => {
				called(c, "set")
				write(out, v, c)
			})
		} else {
			// a scope, with one under it
			const under = s.scope()
			scopes.push(under)
			return make(under, p.makes!)
		}
		living.push(c)
		return c
	}
	for (let i = 6 + r.pick(6); i > 0; i--) make(r.one(scopes), plan())

	let pulses = 0
	function pulse(what: string) {
		const label = at(`pulse ${++pulses} (${what})`)
		runs = 0
		s.pulse()
		runs = 0
		s.pulse()
		assertEquals(runs, 0, `${label}: left something due`)
		assertEquals(problems, [], label)
		for (const e of effects) {
			if (e.state !== "alive") continue
			assert(e.children.length <= 2, `${label}: ${e.children.length} scopes under an effect`)
		}
	}

	pulse("the first")
	for (let step = 0; step < LOOP_STEPS; step++) {
		const k = r.pick(10)
		if (k < 4) {
			const ks = keys()
			for (const key of ks) store.set(key, r.pick(5))
			s.changed(ks)
			pulse(`wrote ${ks}`)
		} else if (k < 6) {
			// some promises settle; their writes after the await reach the scheduler
			const now = pending.splice(0, 1 + r.pick(pending.length + 1))
			for (const settle of now) settle()
			await new Promise((done) => setTimeout(done, 0))
			pulse(`settled ${now.length}`)
		} else if (k < 7) {
			const alive = living.filter((c) => c.state === "alive")
			if (alive.length) s.dispose(r.one(alive))
			pulse("disposed")
		} else if (k < 8) {
			const o = r.one(scopes.slice(1).concat(scopes[0]))
			if (o !== scopes[0] && o.state === "alive") s.dispose(o)
			pulse("disposed a scope")
		} else {
			make(r.one(scopes.filter((o) => o.state === "alive")), plan())
			pulse("made")
		}
	}
	for (const settle of pending.splice(0)) settle()
	await new Promise((done) => setTimeout(done, 0))
	pulse("the last settled")
}

Deno.test(`scheduler loops fuzz: ${LOOP_SEEDS} seeds × ${LOOP_STEPS} steps, every pulse ends`, async () => {
	const reach: Loops = { looping: 0, stops: 0, landed: 0, made: 0, runs: 0 }
	for (let seed = 1; seed <= LOOP_SEEDS; seed++) await loops(seed, reach)
	const { looping, stops, landed, made, runs } = reach
	assert(
		looping > 20 && stops > 5 && landed > 20 && made > 20,
		`the fuzz reaches: ${looping} looping, ${stops} stops, ${landed} landed, ${made} made, ${runs} runs`,
	)
})
