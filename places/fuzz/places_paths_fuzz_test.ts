// places' reads as tracked paths' spots: walkers (get, lookup, list, members) over a
// small graph, each read places tells a spot. after each random write, said written, or table
// event, the spots places says changed:
//   - include a spot of every walker whose result changed
//   - include every spot whose children entry, or whose value at the spot's path, is not the same
//     reference as before (the oracle: values are copy-on-write)
// spots no walker holds any more are released, as the scheduler's forget would; what is held is
// what is held. a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import { PlacesError } from "@ermine/places"
import { get, list, lookup, members } from "@ermine/places/lib"
import type { Spot } from "@ermine/reactivity/paths"
import { isMap, rand } from "../../conformance/typescript/gen.ts"
import { createWorld, show, type Wrote } from "./world_harness.ts"

const SEEDS = 40
const STEPS = 50
const MISSING = Symbol("missing")

type Walker = { what: string; walk: () => string; spots: Spot<unknown>[]; result: string }

// what the seeds reached, counted
type Reach = { changed: number; marked: number }

// one seed's run
function seeded(seed: number, reach: Reach) {
	const { pick } = rand(seed)
	let current: Spot<unknown>[] | undefined
	const made = new Set<Spot<unknown>>()
	const marks = new Set<unknown>()
	const w = createWorld(
		pick,
		(s) => {
			made.add(s)
			current?.push(s)
		},
		(spots) => spots.forEach((s) => marks.add(s)),
	)
	const { p, paths } = w
	function walker(): Walker {
		const k = pick(5), where = w.path(), names = w.path(2), all = pick(2) === 0
		const what = `${k} ${show(names)} at ${show(where)}`
		const walk = k <= 1
			? () => show(get(p, where))
			: k === 2
			? () => show(all ? lookup(p, names, where, true) : lookup(p, names, where))
			: k === 3
			? () => show([...list(p, where)])
			: () => show(members(p, where))
		return { what, walk, spots: [], result: "" }
	}
	const run = (x: Walker) => {
		current = []
		x.result = x.walk()
		x.spots = current
		current = undefined
	}
	const walkers = Array.from({ length: 10 }, walker)
	walkers.forEach(run)

	// what a spot rests on: its key's entry, and the value at its path in it
	const rest = (s: Spot<unknown>) => {
		const node = w.children(s.id as never)
		const v = node?.value
		if (s.path!.length === 0) return [node, v]
		const name = s.path![0] as string
		return [node, isMap(v) && Object.hasOwn(v, name) ? v[name] : MISSING]
	}

	for (let step = 0; step < STEPS; step++) {
		const rests = new Map(walkers.flatMap((x) => x.spots).map((s) => [s, rest(s)]))
		marks.clear()
		let wrote: Wrote | undefined
		try {
			wrote = w.write()
		} catch (e) {
			if (!(e instanceof PlacesError)) throw e
		}
		const at = `seed ${seed}, step ${step}: ${wrote?.what ?? "refused"}`
		// every spot whose entry or value there is another reference
		for (const [s, [node, v]] of rests) {
			const [nodeNow, vNow] = rest(s)
			if (node === nodeNow && v === vNow) continue
			reach.changed++
			assert(marks.has(s), `${at}: ${show([s.id, s.path])} changed, not marked`)
		}
		// every walker whose result changed
		for (const x of walkers) {
			const was = x.result, spots = x.spots
			run(x)
			if (x.result === was) continue
			reach.marked++
			assert(
				spots.some((s) => marks.has(s)),
				`${at}: ${x.what} changed, none of its spots marked\n${was}\n${x.result}`,
			)
		}
		// spots no walker holds: let go
		const held = new Set(walkers.flatMap((x) => x.spots))
		for (const s of made) {
			if (held.has(s)) continue
			paths.release(s)
			made.delete(s)
		}
		assertEquals(paths.held().spots, held.size, `${at}: what is held`)
	}
}

Deno.test(`places + paths fuzz: ${SEEDS} seeds × ${STEPS} writes, what changed is marked`, () => {
	const reach: Reach = { changed: 0, marked: 0 }
	for (let seed = 1; seed <= SEEDS; seed++) seeded(seed, reach)
	const { changed, marked } = reach
	assert(changed > 300 && marked > 200, `the fuzz reaches: ${changed} spots, ${marked} walkers`)
})
