// order on its own, against the rule said plainly: of the due, not one waiting after a due one;
// of those, the lowest rank, then the earliest due, then the oldest. and the ranks: each one past
// what it is after, a cycle sharing one. random graphs, picks, stops, reads that change, marks
// and computations gone, both asked again at every pick. a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import { createOrder, type Ordered } from "./order.ts"
import { rand } from "../../places/fuzz/gen_harness.ts"

interface P extends Ordered<P> {}

function make(n: number): P {
	return {
		n,
		values: [],
		after: undefined,
		state: "alive",
		due: 0,
		rank: 0,
		ranked: 0,
		afters: undefined,
		stamp: 0,
	}
}

const edges = (p: P) =>
	[...p.values, ...(p.after ? [p.after] : [])].filter((q) => q !== p && q.state === "alive")

// p reaches q going up its edges
function reaches(p: P, q: P): boolean {
	const seen = new Set<P>()
	const stack = edges(p)
	while (stack.length) {
		const x = stack.pop()!
		if (x === q) return true
		if (seen.has(x)) continue
		seen.add(x)
		stack.push(...edges(x))
	}
	return false
}

// the rule, by the ranks order has
function pick(all: P[], rank: (p: P) => number): P {
	const ready = all.filter((p) =>
		p.state === "alive" && p.due !== 0 && !(p.after && p.after.due !== 0)
	)
	ready.sort((a, b) => rank(a) - rank(b) || a.due - b.due || a.n - b.n)
	return ready[0]
}

// each after what it is after: ranked past it, or the same rank on a cycle with it
function ranked(all: P[], rank: (p: P) => number) {
	for (const p of all) {
		if (p.state !== "alive") continue
		for (const q of edges(p)) {
			if (rank(q) < rank(p)) continue
			assert(
				rank(q) === rank(p) && reaches(q, p),
				`${p.n} ranked ${rank(p)}, after ${q.n} at ${rank(q)}`,
			)
		}
	}
}

for (let seed = 1; seed <= 40; seed++) {
	Deno.test(`order: picks as the rule says, seed ${seed}`, () => {
		const { pick: r, one } = rand(seed)
		const all: P[] = []
		const live = () => all.filter((p) => p.state === "alive")
		const order = createOrder<P>(live)
		let tick = 0
		const grow = () => {
			const p = make(all.length + 1)
			all.push(p)
			order.started(p)
			return p
		}
		for (let i = 0; i < 6 + r(10); i++) grow()
		const reads = () => {
			const xs = live()
			const out = new Set<P>()
			for (let k = r(3); k > 0; k--) out.add(one(xs))
			return [...out]
		}
		for (const p of live()) order.sees(p, reads())
		// a few due at once, some at one tick
		const mark = () => {
			const t = ++tick
			for (const p of live()) if (p.due === 0 && r(3) === 0) order.set(p, t)
		}
		mark()
		for (let step = 0; step < 300; step++) {
			if (order.size() === 0) {
				if (r(4) === 0) break
				mark()
				continue
			}
			const rank = (p: P) => order.rank(p)
			ranked(all, rank)
			const want = pick(all, rank)
			const { p: got, rank: k } = order.next()
			assertEquals(got.n, want.n, `step ${step}`)
			assertEquals(k, rank(got), `step ${step}`)
			const p = got
			const at = p.due
			order.delete(p)
			order.waits(p, undefined)
			// stopped: waits after a due one whose waits do not reach it, due again as it was
			const stops = live().filter((q) => {
				if (q.due === 0 || q === p) return false
				for (let x: P | undefined = q; x; x = x.after) if (x === p) return false
				return true
			})
			if (stops.length && r(5) === 0) {
				order.waits(p, one(stops))
				order.set(p, at)
				continue
			}
			order.sees(p, reads())
			// what it wrote: its readers due at a new tick
			if (r(2) === 0) {
				const t = ++tick
				for (const q of live()) if (q.due === 0 && q.values.includes(p)) order.set(q, t)
			}
			if (r(8) === 0) mark()
			if (r(10) === 0) {
				const q = one(live())
				q.state = "gone"
				order.gone(q)
			}
			if (r(10) === 0) {
				const q = grow()
				order.sees(q, reads())
				order.set(q, ++tick)
			}
		}
		assert(tick > 0)
	})
}
