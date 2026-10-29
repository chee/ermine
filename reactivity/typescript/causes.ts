// causes: within one pulse, what led to each run: its computation, and the causes of each change
// that marked it. so a mark on a computation can be asked: did it come out of a run of that same
// computation? then it is a loop through it. nothing is kept past the pulse: a cause from an
// earlier one is cut by the scheduler to its computation alone (scheduler.ts, causeOf).
export class Cause<T> {
	constructor(readonly of: T, readonly parents: readonly Cause<T>[]) {}
}

// kept: the causes of the marks since its last run that ended done. ranIn: the pulse it last ran
// in; heldIn: the pulse it last kept a cause in (causes' own, by number)
export type Caused<T> = {
	n: number
	kept: Cause<T>[]
	ranIn: number
	heldIn: number
}

export function createCauses<T extends Caused<T>>(): {
	run: (t: T, given: readonly Cause<T>[]) => Cause<T>
	keep: (t: T, c: Cause<T>) => void
	loop: (c: Cause<T> | undefined, t: T) => T[] | undefined
	from: (t: T, c: T) => boolean
	end: () => void
} {
	// this pulse's number: a computation ran in it when its ranIn is this
	let pulse = 1
	// the computations holding causes, forgotten at the pulse's end
	const holding: T[] = []

	return {
		// a run of t, caused by what caused each mark it was given
		run(t: T, given: readonly Cause<T>[]): Cause<T> {
			t.ranIn = pulse
			return new Cause(t, given)
		},

		// a mark's causes, kept on t until the pulse's end. the same cause again at once: once
		keep(t: T, c: Cause<T>) {
			if (t.kept[t.kept.length - 1] === c) return
			t.kept.push(c)
			if (t.heldIn === pulse) return
			t.heldIn = pulse
			holding.push(t)
		},

		// a loop through t: c came out of a run of t in this pulse. answers the computations on the
		// loop, in the order made: those of the causes on a path from c back to a run of t. or
		// nothing
		loop(c: Cause<T> | undefined, t: T): T[] | undefined {
			if (!c || t.ranIn !== pulse) return
			// each cause after its parents (causes only point back, so no cycle): on a path back
			// to a run of t when it is of t, or a parent is
			const on = new Set<Cause<T>>()
			const seen = new Set<Cause<T>>([c])
			const stack: [Cause<T>, number][] = [[c, 0]]
			while (stack.length) {
				const top = stack[stack.length - 1]
				const x = top[0]
				if (top[1] < x.parents.length) {
					const q = x.parents[top[1]++]
					if (!seen.has(q)) (seen.add(q), stack.push([q, 0]))
					continue
				}
				stack.pop()
				if (x.of === t || x.parents.some((q) => on.has(q))) on.add(x)
			}
			if (!on.has(c)) return
			return [...new Set([...on].map((x) => x.of))].sort((a, b) => a.n - b.n)
		},

		// a mark kept on t came out of a run of c in this pulse
		from(t: T, c: T): boolean {
			if (c.ranIn !== pulse) return false
			const seen = new Set<Cause<T>>()
			const stack = [...t.kept]
			while (stack.length) {
				const x = stack.pop()!
				if (seen.has(x)) continue
				seen.add(x)
				if (x.of === c) return true
				for (const q of x.parents) stack.push(q)
			}
			return false
		},

		// the pulse's end: causes and runs forgotten
		end() {
			for (const t of holding) t.kept.length = 0
			holding.length = 0
			pulse++
		},
	}
}
