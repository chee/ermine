// end to end, small: the scheduler, tracked paths and places together. computers read the graph
// through places (get, lookup, list, members, readValue), each read places tells going to the
// scheduler's track as a paths spot; more computers read those computers' values, and effects act
// on them. writes go through places (or the table), and places' commit and table hook say what
// they changed to the scheduler's mark. after each pulse:
//   - every live compute's value is the graph read again from scratch (places with nothing told)
//   - at every act, every compute already has that value; an effect acts once at most, exactly
//     when its value differs from the one it acted on last
//   - spots no computer tracks any more are released, as the scheduler's onTrackingEnd says; what
//     paths keeps is what the live computers track
// a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import { createPlaces, type Path, type Places, PlacesError } from "@ermine/places"
import { get, list, lookup, members } from "@ermine/places/lib"
import { createPaths } from "@ermine/scheduler/paths"
import { type Computer, createScheduler, type Scope } from "@ermine/scheduler"
import { createTable } from "@ermine/table"
import { rand } from "./gen.ts"
import { createWorld, show } from "./world.ts"

const SEEDS = 40
const STEPS = 30

type Made = {
	name: string
	kind: "walker" | "derived" | "effect"
	what: string
	o: Scope
	c: Computer
	// from scratch: the graph read again, the other computes' values as the model has them
	scratch: (value: (name: string) => string | undefined) => string
	acted?: { value: string }
}

// what the seeds reached, counted
type Reach = { acts: number; runs: number; released: number }

// one seed's run
function seeded(seed: number, reach: Reach) {
	const { pick, one } = rand(seed)
	const s = createScheduler()
	s.onRunStart(() => void reach.runs++)
	const w = createWorld(pick, (spot) => s.track(spot), (spots) => void s.mark(spots))
	// a spot nobody tracks any more is let go, as the scheduler tells
	s.onTrackingEnd((key) => {
		if (typeof key === "object") reach.released++
		w.p.release(key)
	})
	// places over the same table, nothing told: the graph read from scratch
	const plain = createPlaces({
		root: "R",
		table: w.table,
		paths: createPaths(),
		scheduler: { track: () => {}, mark: () => 0, getRun: () => undefined },
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
	function walk(): { what: string; f: (q: Places) => string } {
		const k = pick(6), where = w.path(), names = w.path(2), all = pick(2) === 0
		const what = `${k} ${show(names)} at ${show(where)}`
		if (k === 0) return { what, f: (q) => show(get(q, where)) }
		if (k === 1) {
			return {
				what,
				f: (q) => show(all ? lookup(q, names, where, true) : lookup(q, names, where)),
			}
		}
		if (k === 2) return { what, f: (q) => show([...list(q, where)]) }
		if (k === 3) return { what, f: (q) => show(members(q, where)) }
		if (k === 4) {
			const id = w.entry(), path: Path = w.path(1)
			return {
				what: `value ${show([id, path])}`,
				f: (q) => show(q.readValue("children", id, path)),
			}
		}
		return { what, f: (q) => show(get(q, where)) + show([...list(q, names)]) }
	}
	function compute(m: Made, f: () => string) {
		m.c = s.runWithScope(m.o, () =>
			s.createComputer(
				f,
				(v: string) => {
					store.set(m.name, v)
					s.mark([m.name], m.c)
				},
				undefined,
				m.name,
			))
	}
	function make(kind: Made["kind"]) {
		const name = `${kind[0]}${made.length}`
		const o = s.createRootScope([["actor", name]])
		const m = { name, kind, o } as Made
		const computes = made.filter((x) => x.kind !== "effect")
		if (kind === "walker" || !computes.length) {
			m.kind = "walker"
			const { what, f } = walk()
			m.what = what
			m.scratch = () => f(plain)
			compute(m, () => f(w.p))
		} else {
			// over one or two computes' values
			const over = Array.from({ length: 1 + pick(2) }, () => one(computes).name)
			m.what = `over ${over}`
			const of = (vs: (string | undefined)[]) =>
				vs.map((v) => `${(v ?? "").split(",").length}:${(v ?? "").length % 3}`).join("|")
			m.scratch = (value) => of(over.map(value))
			const look = (key: string) => (s.track(key), store.get(key))
			if (kind === "derived") compute(m, () => of(over.map(look)))
			else {
				m.c = s.runWithScope(
					o,
					() =>
						s.createEffect(() => of(over.map(look)), (v: string, previous?: string) => {
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
						}),
				)
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
		// spots no computer tracks: let go. what is kept is what the live computers track
		const read = new Set<unknown>()
		for (const m of made) {
			if (!alive(m)) continue
			for (let l = m.c.node.reads; l !== null; l = l.next) {
				if (typeof l.to.owner === "object") read.add(l.to.owner)
			}
		}
		assertEquals(w.paths.kept().spots, read.size, `${at}: what paths keeps`)
	}

	pulse(`seed ${seed}: the first pulse`)
	for (let step = 0; step < STEPS; step++) {
		const k = pick(10)
		let what: string
		if (k < 8) {
			let wrote
			try {
				wrote = w.write()
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
			what = wrote?.what ?? "refused"
		} else if (k < 9) {
			const living = made.filter(alive)
			const m = living.length ? one(living) : undefined
			if (m) s.teardown(m.o)
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
