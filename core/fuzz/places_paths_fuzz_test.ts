// places' reads as tracked paths' spots: walkers (get, lookup, names, opened places, lib's
// lookups) over a small graph, each read places tells made a spot. after each random write
// through places, or table event, the spots marked by the changed nodes' patches (paths' mark)
// and by the events (paths' event):
//   - include a spot of every walker whose result changed
//   - include every spot whose children node, or whose value at the spot's path, is not the same
//     reference as before (the oracle: values are copy-on-write)
// spots no walker holds any more are released, as the wiring would; what is kept is what is
// held. a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import { type Item, PlacesError } from "@ermine/places"
import { createPaths, type Spot } from "@ermine/scheduler/paths"
import { lookups } from "../places/typescript/lib.ts"
import { isMap, rand } from "./gen.ts"
import { createWorld, items, show, type Wrote } from "./world.ts"

const SEEDS = 40
const STEPS = 50
const MISSING = Symbol("missing")

type Walker = {
	what: string
	walk: () => string
	held?: { items: () => readonly Item[]; drop: () => void }
	spots: Spot<never>[]
	result: string
}

// what the seeds reached, counted
type Reach = { changed: number; marked: number }

// one seed's run
function seeded(seed: number, reach: Reach) {
	const { pick } = rand(seed)
	const paths = createPaths<never>()
	let current: Spot<never>[] | undefined
	const made = new Set<Spot<never>>()
	const w = createWorld(pick, (r) => {
		const s = paths.spot(r.source, r.id, r.path)
		made.add(s)
		current?.push(s)
	})
	const { p } = w
	function walker(): Walker {
		const k = pick(6), address = w.address(), from = w.from(), all = pick(2) === 0
		if (k === 0) {
			const held = p.open(address)
			return {
				what: `open ${show(address)}`,
				held,
				walk: () => items(held.items()).join(),
				spots: [],
				result: "",
			}
		}
		const walk = k === 1
			? () => items(p.get(address, from)).join()
			: k === 2
			? () => items(p.lookup(address, from, all)).join()
			: k === 3
			? () => items(lookups(p, address, p.get([], from)[0] ?? p.get([])[0])).join()
			: () => p.get(address, from).map((i) => p.names(i).join("+")).join()
		return { what: `${k} ${show(address)} from ${show(from)}`, walk, spots: [], result: "" }
	}
	const run = (x: Walker) => {
		current = []
		x.result = x.walk()
		x.spots = current
		current = undefined
	}
	const walkers = Array.from({ length: 10 }, walker)
	walkers.forEach(run)

	// what a spot rests on: its key's node, and the value at its path in it
	const rest = (s: Spot<never>) => {
		const node = w.children(s.source as never, s.id as never)
		const v = node?.value
		if (s.path!.length === 0) return [node, v]
		const name = s.path![0] as string
		return [node, isMap(v) && Object.hasOwn(v, name) ? v[name] : MISSING]
	}

	for (let step = 0; step < STEPS; step++) {
		const rests = new Map(walkers.flatMap((x) => x.spots).map((s) => [s, rest(s)]))
		let wrote: Wrote | undefined
		try {
			wrote = w.write()
		} catch (e) {
			if (!(e instanceof PlacesError)) throw e
		}
		const at = `seed ${seed}, step ${step}: ${wrote?.what ?? "refused"}`
		const marks = new Set<Spot<never>>()
		for (const c of wrote?.changed ?? []) {
			for (const s of paths.mark(c.source, c.id, c.node.change.op!.patches)) marks.add(s)
		}
		for (const e of wrote?.events ?? []) {
			for (const s of paths.event(e.source, e.id)) marks.add(s)
		}
		// every spot whose node or value there is another reference
		for (const [s, [node, v]] of rests) {
			const [nodeNow, vNow] = rest(s)
			if (node === nodeNow && v === vNow) continue
			reach.changed++
			assert(marks.has(s), `${at}: ${show([s.source, s.id, s.path])} changed, not marked`)
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
		assertEquals(paths.kept().spots, held.size, `${at}: what is kept`)
	}
	for (const x of walkers) x.held?.drop()
}

Deno.test(`places + paths fuzz: ${SEEDS} seeds × ${STEPS} writes, what changed is marked`, () => {
	const reach: Reach = { changed: 0, marked: 0 }
	for (let seed = 1; seed <= SEEDS; seed++) seeded(seed, reach)
	const { changed, marked } = reach
	assert(changed > 300 && marked > 200, `the fuzz reaches: ${changed} spots, ${marked} walkers`)
})
