// end to end, small: the scheduler, tracked paths and places together. computes read the graph
// through places (get, lookup, lib's lookups, names, opened places), each read places tells
// going to the scheduler's read as a paths spot; more computes read those computes' values, and
// effects act on them. writes go through places (or the table), and what they changed is said
// changed by paths' mark (or event). after each pulse:
//   - every live compute's value is the graph read again from scratch (places with nothing told)
//   - at every act, every compute already has that value; an effect acts once at most, exactly
//     when its value differs from the one it acted on last
//   - spots no computation reads any more are released, as the wiring would; what paths keeps is
//     what the computations read
// a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import { type Item, type Places, PlacesError } from "@ermine/places"
import { createPaths, type Spot } from "@ermine/scheduler/paths"
import { type Computation, createScheduler, type Owner } from "@ermine/scheduler"
import { lookups } from "../../filesystem/places/typescript/lib.ts"
import { rand } from "./gen.ts"
import { createWorld, items, show, type Wrote } from "./world.ts"

const SEEDS = 40
const STEPS = 30

type Made = {
	name: string
	kind: "walker" | "derived" | "effect"
	what: string
	o: Owner
	c: Computation
	// from scratch: the graph read again, the other computes' values as the model has them
	scratch: (value: (name: string) => string | undefined) => string
	acted?: { value: string }
}

// what the seeds reached, counted
type Reach = { acts: number; runs: number; released: number }

// one seed's run
function seeded(seed: number, reach: Reach) {
	const { pick, one } = rand(seed)
	const s = createScheduler({ hook: (m) => void ("starts" in m && reach.runs++) })
	const paths = createPaths<never>()
	const spots = new Set<Spot<never>>()
	const w = createWorld(pick, (r) => {
		const spot = paths.spot(r.source, r.id, r.path)
		spots.add(spot)
		s.read(spot)
	})
	const store = new Map<string, string>()
	const made: Made[] = []
	const alive = (m: Made) => m.c.state === "alive"
	const problems: string[] = []

	// the model: every live compute from scratch, a disposed one's value as it was left
	function model() {
		const out = new Map<string, string | undefined>()
		const value = (name: string): string | undefined => {
			const m = made.find((x) => x.name === name)!
			if (!alive(m)) return store.get(name)
			if (!out.has(name)) out.set(name, m.scratch(value))
			return out.get(name)
		}
		for (const m of made) if (alive(m)) value(m.name)
		return out
	}
	let expected = model()

	// a walk of the graph, on the places given
	function walk(): { what: string; f: (q: Places) => string; open?: string[] } {
		const k = pick(6), address = w.address(), from = w.from(), all = pick(2) === 0
		const what = `${k} ${show(address)} from ${show(from)}`
		if (k === 0) {
			return {
				what: `open ${show(address)}`,
				f: (q) => items(q.get(address)).join(),
				open: [...address],
			}
		}
		if (k === 1) return { what, f: (q) => items(q.get(address, from)).join() }
		if (k === 2) return { what, f: (q) => items(q.lookup(address, from, all)).join() }
		if (k === 3) {
			return {
				what,
				f: (q) => items(lookups(q, address, q.get([], from)[0] ?? q.get([])[0])).join(),
			}
		}
		return { what, f: (q) => q.get(address, from).map((i) => q.names(i).join("+")).join() }
	}
	function compute(m: Made, f: (read: unknown) => string) {
		m.c = s.compute(m.o, f, (v: string) => {
			store.set(m.name, v)
			s.changed([m.name])
		})
	}
	function make(kind: Made["kind"]) {
		const name = `${kind[0]}${made.length}`
		const o = s.owner()
		const m = { name, kind, o } as Made
		const computes = made.filter((x) => x.kind !== "effect")
		if (kind === "walker" || !computes.length) {
			m.kind = "walker"
			const { what, f, open } = walk()
			m.what = what
			let held: { items: () => readonly Item[]; drop: () => void } | undefined
			if (open) {
				held = w.p.open(open)
				s.cleanup(o, () => held!.drop())
			}
			m.scratch = () => f(w.plain)
			compute(m, () => held ? items(held.items()).join() : f(w.p))
		} else {
			// over one or two computes' values
			const over = Array.from({ length: 1 + pick(2) }, () => one(computes).name)
			m.what = `over ${over}`
			const of = (vs: (string | undefined)[]) =>
				vs.map((v) => `${(v ?? "").split(",").length}:${(v ?? "").length % 3}`).join("|")
			m.scratch = (value) => of(over.map(value))
			const look = (key: string) => (s.read(key), store.get(key))
			if (kind === "derived") compute(m, () => of(over.map(look)))
			else {
				m.c = s.effect(o, () => of(over.map(look)), (v: string, previous?: string) => {
					const at = `${name} acts on ${v}`
					if (previous !== m.acted?.value) problems.push(`${at}: previous ${previous}`)
					if (v !== expected.get(name)) problems.push(`${at}, not ${expected.get(name)}`)
					// every compute already as from scratch
					for (const x of made) {
						if (x.kind === "effect" || !alive(x)) continue
						if (store.get(x.name) !== expected.get(x.name)) {
							problems.push(`${at}: ${x.name} is ${store.get(x.name)}`)
						}
					}
					m.acted = { value: v }
				})
			}
		}
		made.push(m)
	}
	for (let i = 0; i < 8; i++) make("walker")
	for (let i = 0; i < 4; i++) make(pick(2) ? "derived" : "effect")

	function pulse(at: string) {
		expected = model()
		const before = new Map(made.map((m) => [m, m.acted]))
		s.pulse()
		assertEquals(problems, [], at)
		for (const m of made) {
			if (!alive(m)) continue
			if (m.kind !== "effect") {
				assertEquals(store.get(m.name), expected.get(m.name), `${at}: ${m.name}, ${m.what}`)
				continue
			}
			const was = before.get(m), now = m.acted
			const due = was?.value !== expected.get(m.name)
			assertEquals(now !== was, due, `${at}: ${m.name} acted`)
			if (now !== was) reach.acts++
		}
		// spots no computation reads: let go. what is kept is what is read
		const read = new Set<unknown>()
		for (const m of made) {
			for (let l = m.c.node.reads; l !== null; l = l.next) read.add(l.to.owner)
		}
		for (const spot of spots) {
			if (read.has(spot)) continue
			paths.release(spot)
			spots.delete(spot)
			reach.released++
		}
		assertEquals(paths.kept().spots, spots.size, `${at}: what paths keeps`)
	}

	pulse(`seed ${seed}: the first pulse`)
	for (let step = 0; step < STEPS; step++) {
		const k = pick(10)
		let what: string
		if (k < 8) {
			let wrote: Wrote | undefined
			try {
				wrote = w.write()
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
			for (const c of wrote?.changed ?? []) {
				s.changed(paths.mark(c.source, c.id, c.node.change.op!.patches))
			}
			for (const e of wrote?.events ?? []) s.changed(paths.event(e.source, e.id))
			what = wrote?.what ?? "refused"
		} else if (k < 9) {
			const living = made.filter(alive)
			const m = living.length ? one(living) : undefined
			if (m) s.dispose(m.o)
			what = `disposed ${m?.name}`
		} else {
			make(one(["walker", "walker", "derived", "effect"] as const))
			what = `made ${made[made.length - 1].name}`
		}
		pulse(`seed ${seed}, step ${step}: ${what}`)
	}
}

Deno.test(`end to end fuzz: ${SEEDS} seeds × ${STEPS} writes, computes over places as from scratch`, () => {
	const reach: Reach = { acts: 0, runs: 0, released: 0 }
	for (let seed = 1; seed <= SEEDS; seed++) seeded(seed, reach)
	const { acts, runs, released } = reach
	assert(
		acts > 50 && released > 100,
		`the fuzz reaches: ${acts} acts, ${runs} runs, ${released} released`,
	)
})
