// Fuzzes the scheduler with its tracker over random graphs of computes and effects, writes and
// disposals. After every pulse and act it checks values against a model, that effects act once
// per pulse, the rank order of runs, and the tracker's reads and links.
import { assert, assertEquals } from "@std/assert"
import { type Computer, createScheduler, type Run, type Scope } from "./scheduler.ts"
import { type Told, trace } from "./scheduler_harness.ts"
import type { Link, Node } from "./tracker.ts"
import { rand } from "../../conformance/typescript/gen.ts"

const under = (o: Scope) => {
	let n = 0
	for (let x = o.newest; x; x = x.older) n++
	return n
}

const SEEDS = 40
const STEPS = 15
const HOST = ["h0", "\uD83D", "\uDE00", "😀", "h\u0000", "👍🏽"]
const TEXTS = ["", "a", "é", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\u0000", "\uD83D\uDE00"]
const ENDS = ["", "é", "\uD83D", "\uDE00", "\u0000"]

type R = ReturnType<typeof rand>
type Expr =
	| { read: string }
	| { lit: number }
	| { sum: Expr[] }
	| { mod: [Expr, number] }
	| { if: [Expr, Expr, Expr] }
	| { fail: [Expr, number] }
	| { text: [Expr, Expr] }
	| { len: Expr }

class Fail extends Error {}

type Value = number | string
const num = (v: unknown) => typeof v === "number" ? v : typeof v === "string" ? [...v].length : 0
function evaluate(e: Expr, look: (key: string) => unknown): Value {
	const n = (x: Expr) => num(evaluate(x, look))
	if ("read" in e) {
		const v = look(e.read)
		return typeof v === "string" ? v : num(v)
	}
	if ("lit" in e) return e.lit
	if ("sum" in e) return e.sum.reduce((a: number, x) => a + n(x), 0)
	if ("mod" in e) return n(e.mod[0]) % e.mod[1]
	if ("if" in e) return n(e.if[0]) % 2 === 0 ? evaluate(e.if[1], look) : evaluate(e.if[2], look)
	if ("text" in e) return TEXTS[n(e.text[0]) % TEXTS.length] + TEXTS[n(e.text[1]) % TEXTS.length]
	if ("len" in e) return n(e.len)
	const v = evaluate(e.fail[0], look)
	if (num(v) === e.fail[1]) throw new Fail(`fails at ${v}`)
	return v
}

function expr(r: R, keys: string[], depth: number): Expr {
	const k = r.pick(depth > 0 ? 15 : 3)
	if (k >= 13) {
		return k === 13
			? { text: [expr(r, keys, depth - 1), expr(r, keys, depth - 1)] }
			: { len: expr(r, keys, depth - 1) }
	}
	if (k < 2) return { read: r.one(keys) }
	if (k < 3) return r.pick(3) ? { read: r.one(keys) } : { lit: r.pick(4) }
	if (k < 6) return { sum: Array.from({ length: 2 + r.pick(2) }, () => expr(r, keys, depth - 1)) }
	if (k < 8) return { mod: [expr(r, keys, depth - 1), 2 + r.pick(2)] }
	if (k < 11) {
		return { if: [expr(r, keys, depth - 1), expr(r, keys, depth - 1), expr(r, keys, depth - 1)] }
	}
	return { fail: [expr(r, keys, depth - 1), r.pick(8)] }
}

type Made = {
	name: string
	kind: "compute" | "effect"
	e: Expr
	c: Computer
	run?: { tick: number; reads: Set<string>; sources: Set<Made>; ended?: string }
	held: Set<string>
	edges: Set<Made>
	rank: number
	wrote: boolean
	acted?: { value: Value }
}

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
function readsOf(node: Node<unknown>, at: string, done: boolean): Link<unknown>[] {
	const out: Link<unknown>[] = []
	let prev: Link<unknown> | null = null
	for (let l = node.reads; l !== null; l = l.next) {
		assert(l.from === node, `${at}: a read's from`)
		assert(l.prev === prev, `${at}: a read's prev`)
		out.push(l)
		prev = l
	}
	if (done) assert(node.cursor === prev, `${at}: the cursor`)
	assertEquals(node.open, false, `${at}: open outside a run`)
	return out
}

type Reach = { acts: number; cut: number; runs: number; failed: number }

function seeded(seed: number, reach: Reach) {
	const r = rand(seed)
	const label = (s: string) => `seed ${seed}, ${s}`
	const moments: Told[] = []
	let told = (_: Told) => {}
	const s = createScheduler()
	trace(s, (m) => (moments.push(m), told(m)))
	let tick = 0
	s.onMark((_keys, _run, _due, t) => void (tick = t))
	const store = new Map<string, Value>()
	const changedAt = new Map<string, number>()
	const changed = (keys: string[], by?: Computer) => {
		const t = s.mark(keys, by)
		for (const k of keys) changedAt.set(k, t)
	}
	const problems: string[] = []
	const root = s.createRootScope({ actor: "test" })
	const scopes: Scope[] = [root]
	for (let i = 0; i < 3; i++) scopes.push(s.createScope({ why: "test" }, r.one(scopes)))
	const made: Made[] = []
	const byComputation = new Map<Computer, Made>()
	const alive = (m: Made) => m.c.state === "alive"

	let expected = new Map<string, Value | undefined>()
	function model() {
		const out = new Map<string, Value | undefined>()
		const look = (key: string): unknown => {
			const m = made.find((x) => x.name === key)
			if (m === undefined || !alive(m)) return store.get(key)
			if (!out.has(key)) {
				let v: Value | undefined
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
		const name = `${kind[0]}${made.length}${r.one(ENDS)}`
		const keys = [...HOST, ...made.filter((m) => m.kind === "compute").map((m) => m.name)]
		const e = expr(r, keys, 2 + r.pick(2))
		const o = r.one(scopes.filter((o) => o.state === "alive"))
		const m = { name, kind, e, held: new Set(), edges: new Set(), rank: 0, wrote: false } as Made
		const f = () =>
			evaluate(e, (key) => {
				m.run!.reads.add(key)
				const y = made.find((x) => x.name === key)
				if (y?.wrote) m.run!.sources.add(y)
				s.track(key)
				return store.get(key)
			})
		if (kind === "compute") {
			m.c = s.runWithScope(o, () =>
				s.createComputer(f, (v: Value) => {
					if (store.has(name) && Object.is(store.get(name), v)) {
						problems.push(`${name}: set the value it had, ${v}`)
					}
					store.set(name, v)
					changed([name], m.c)
					m.wrote = true
				}))
		} else {
			m.c = s.runWithScope(
				o,
				() =>
					s.createEffect(f, (v: Value, previous: Value | undefined) => {
						const at = `pulse ${pulses}: ${name} acts on ${v}`
						if (previous !== m.acted?.value) {
							problems.push(`${at}: previous ${previous}, not ${m.acted?.value}`)
						}
						if (v !== expected.get(name)) problems.push(`${at}, not ${expected.get(name)}`)
						settled(at)
						m.acted = { value: v }
					}),
			)
		}
		made.push(m)
		byComputation.set(m.c, m)
	}
	for (let i = 4 + r.pick(5); i > 0; i--) make("compute")
	for (let i = 1 + r.pick(3); i > 0; i--) make("effect")
	for (let i = 2 + r.pick(4); i > 0; i--) make("compute")
	for (let i = 1 + r.pick(2); i > 0; i--) make("effect")

	const keyNodes = new Map<string, Set<Node<unknown>>>()
	function pulse(what: string) {
		const at = label(`pulse ${++pulses} (${what})`)
		expected = model()
		const actedBefore = new Map(made.map((m) => [m, m.acted]))
		moments.length = 0
		told = (m: Told) => {
			if ("starts" in m) {
				const x = byComputation.get(m.starts)!
				const last = x.run
				if (last && last.ended !== "stopped") {
					const why = [...x.held].some((k) => (changedAt.get(k) ?? 0) > last.tick)
					if (!why) problems.push(`${at}: ${x.name} ran for no reason`)
				}
				for (const y of x.edges) {
					if (alive(y) && m.rank <= y.rank) {
						problems.push(
							`${at}: ${x.name} at rank ${m.rank}, not above ${y.name}'s ${y.rank}`,
						)
					}
				}
				x.rank = m.rank
				x.run = { tick, reads: new Set(), sources: new Set() }
				reach.runs++
			} else if ("ends" in m) {
				const x = byComputation.get(m.ends)!
				x.run!.ended = m.ended
				x.held = m.ended === "done" ? new Set(x.run!.reads) : x.held.union(x.run!.reads)
				if (m.ended !== "stopped") x.edges = x.run!.sources
				if (m.ended === "done" && m.equal) reach.cut++
				if (m.ended === "failed") reach.failed++
			}
		}
		s.pulse()
		told = () => {}
		assertEquals(problems, [], at)

		for (const m of made) {
			if (m.kind !== "compute" || !alive(m)) continue
			assertEquals(store.get(m.name), expected.get(m.name), `${at}: ${m.name}`)
		}
		const acting = new Map<Computer, number>()
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
		for (const m of made) {
			const node = m.c.node
			const links = readsOf(node, `${at}: ${m.name}`, m.run?.ended === "done")
			if (!alive(m)) {
				assertEquals(links.length, 0, `${at}: ${m.name} disposed, still reading`)
				continue
			}
			assert(m.run?.ended !== undefined && m.run.ended !== "stopped", `${at}: ${m.name}`)
			const reads = [...m.run!.reads]
			assertEquals(
				[...new Set(links.map((l) => l.to.owner))].slice(0, reads.length),
				reads,
				`${at}: ${m.name}'s reads`,
			)
			assertEquals(
				new Set(links.map((l) => l.to.owner)),
				m.held,
				`${at}: ${m.name}'s keys held`,
			)
			const old: unknown[] = []
			for (let l = node.cursor ? node.cursor.next : node.reads; l !== null; l = l.next) {
				old.push(l.to.owner)
			}
			assertEquals(new Set(old).size, old.length, `${at}: ${m.name} holds a key twice`)
			for (const k of old) assert(!m.run!.reads.has(k as string), `${at}: ${m.name} holds ${k}`)
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
				for (const l of of) readers.push(byComputation.get(l.from.owner as Computer)!)
			}
			assert(read <= 1, `${at}: ${key} read through ${read} nodes`)
			for (const x of readers) assert(alive(x), `${at}: ${key} read by ${x.name}, disposed`)
			const want = made.filter((x) => alive(x) && x.held.has(key))
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
			const keys = [...new Set(Array.from({ length: 1 + r.pick(3) }, () => r.one(HOST)))]
			for (const key of keys) store.set(key, r.pick(4) ? r.pick(6) : r.one(TEXTS) + r.one(TEXTS))
			if (r.pick(2)) changed(keys)
			else for (const key of keys) changed([key])
			pulse(`wrote ${keys}`)
		} else if (k < 9) {
			const living = made.filter(alive)
			if (living.length) {
				const m = r.one(living)
				s.teardown(m.c)
				pulse(`disposed ${m.name}`)
			}
		} else if (k < 10) {
			const o = r.one(scopes.slice(1))
			if (o.state === "alive") {
				s.teardown(o)
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

// The loops fuzz, for cyclic systems with no from-scratch value. After every pulse it checks that
// the pulse ended, nothing is left due, and nothing was called for a gone computation.
const LOOP_SEEDS = 40
const LOOP_STEPS = 15
const BOUND = 5000
const KEYS = ["k0", "\uD83D", "\uDE00", "😀", "k\u0000", "中"]

type Loops = { looping: number; stops: number; landed: number; made: number; runs: number }

async function loops(seed: number, reach: Loops) {
	const r = rand(seed)
	const at = (s: string) => `loops seed ${seed}, ${s}`
	let runs = 0
	const s = createScheduler()
	const due = new Set<Computer>()
	// A mark made while c or a scope under it is open (its last act's cleanups) is left out; tests
	// 34 and 48 pin that it acts then.
	const inside = (c: Computer) => {
		for (let o = s.getCurrentScope(); o !== undefined; o = o.parent) if (o === c) return true
		return false
	}
	s.onMark((_keys, _run, now) => {
		for (const c of now) due.add(c)
	})
	s.onRunStart((c) => {
		due.delete(c)
		if (++runs > BOUND) throw new Error(at(`a pulse past ${BOUND} runs`))
		reach.runs++
	})
	s.onRunEnd((_c, _n, ended) => {
		if (ended === "looping") reach.looping++
		if (ended === "stopped") reach.stops++
	})
	const store = new Map<string, number>()
	const write = (key: string, v: number, by?: Run | Computer) => {
		store.set(key, v)
		s.mark([key], by)
	}
	const problems: string[] = []
	const called = (c: Computer, what: string) => {
		if (c.state !== "alive") problems.push(`${what} of ${c.n}, gone`)
	}
	const effects: Computer[] = []
	const scopes: Scope[] = [s.createRootScope({ actor: "test" })]
	const living: Computer[] = []
	const pending: (() => void)[] = []

	const sum = (read: (key: unknown) => void, keys: string[]) => {
		let n = 0
		for (const k of keys) {
			read(k)
			n += store.get(k) ?? 0
		}
		return n % 5
	}
	const keys = () => Array.from({ length: 1 + r.pick(3) }, () => r.one(KEYS))

	type Plan = {
		kind: number
		ins: string[]
		out: string
		other: string
		dies: boolean
		named: boolean
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

	function make(o: Scope, p: Plan): Computer | undefined {
		if (o.state !== "alive") return
		return s.runWithScope(o, () => build(p))
	}
	function build(p: Plan): Computer | undefined {
		const { ins, out, other } = p
		let c!: Computer
		if (p.kind === 0) {
			c = s.createComputer(() => (called(c, "f"), sum(s.track, ins)), (v) => {
				called(c, "set")
				write(out, v, c)
			})
		} else if (p.kind === 1) {
			c = s.createComputer(() => {
				const writer = s.getRun()
				called(c, "f")
				const v = sum(s.track, ins)
				write(other, (v + 1) % 5, writer)
				return v % 2
			}, () => called(c, "set"))
		} else if (p.kind === 2) {
			c = s.createComputer(() => {
				const writer = s.getRun()
				called(c, "f")
				const v = sum(s.track, ins)
				s.registerTeardown(s.getCurrentScope()!, () => {
					write(other, (v + 1) % 5, c)
					if (p.dies && (store.get(other) ?? 0) > 2) s.teardown(c)
				})
				return v
			}, (v) => {
				called(c, "set")
				write(out, v, c)
			})
		} else if (p.kind === 3) {
			c = s.createEffect(() => {
				const writer = s.getRun()
				called(c, "f")
				s.createScope({ why: "test" })
				return sum(s.track, ins)
			}, (v) => {
				called(c, "act")
				if (due.has(c)) problems.push(`act of ${c.n}, due again`)
				write(other, (v + 1) % 5, c)
				if (p.makes && make(c, p.makes)) reach.made++
			})
			effects.push(c)
		} else if (p.kind === 4) {
			c = s.createComputer(() => {
				const writer = s.getRun()
				called(c, "f")
				const v = sum(s.track, ins)
				return new Promise<number>((done) => pending.push(() => done(v))).then((v) => {
					write(other, (v + 1) % 5, p.named ? writer : undefined)
					return v
				})
			}, (v: number) => {
				called(c, "set")
				reach.landed++
				write(out, v, c)
			})
		} else if (p.kind === 5) {
			c = s.createComputer(() => {
				const writer = s.getRun()
				called(c, "f")
				if (make(c, p.makes!)) reach.made++
				return sum(s.track, ins)
			}, (v) => {
				called(c, "set")
				write(out, v, c)
			})
		} else {
			const under = s.createScope({ why: "test" })
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
			assert(under(e) <= 2, `${label}: ${under(e)} scopes under an effect`)
		}
	}

	pulse("the first")
	for (let step = 0; step < LOOP_STEPS; step++) {
		const k = r.pick(10)
		if (k < 4) {
			const ks = keys()
			for (const key of ks) store.set(key, r.pick(5))
			s.mark(ks)
			pulse(`wrote ${ks}`)
		} else if (k < 6) {
			const now = pending.splice(0, 1 + r.pick(pending.length + 1))
			for (const settle of now) settle()
			await new Promise((done) => setTimeout(done, 0))
			pulse(`settled ${now.length}`)
		} else if (k < 7) {
			const alive = living.filter((c) => c.state === "alive")
			if (alive.length) s.teardown(r.one(alive))
			pulse("disposed")
		} else if (k < 8) {
			const o = r.one(scopes.slice(1).concat(scopes[0]))
			if (o !== scopes[0] && o.state === "alive") s.teardown(o)
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
