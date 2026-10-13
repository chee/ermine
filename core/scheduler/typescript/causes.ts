// causes: within one pulse, what led to each run: its computation, and the causes of each change
// that marked it. so a mark on a computation can be asked: did it come out of a run of that same
// computation? then it is a loop through it. nothing is kept past the pulse.
export class Cause<T> {
	constructor(readonly of: T, readonly parents: readonly Cause<T>[]) {}
}

// kept: the causes of the marks since its last run that ended done
export type Caused<T> = { n: number; kept: Set<Cause<T>> }

export function createCauses<T extends Caused<T>>() {
	// the computations that ran in this pulse
	const ran = new Set<T>()
	// the computations holding causes, forgotten at the pulse's end
	const holding = new Set<T>()

	// every cause reached from c
	function walk(c: Cause<T>, each: (x: Cause<T>) => boolean | void): boolean {
		const seen = new Set<Cause<T>>([c])
		const stack = [c]
		while (stack.length) {
			const x = stack.pop()!
			if (each(x)) return true
			for (const q of x.parents) if (!seen.has(q)) (seen.add(q), stack.push(q))
		}
		return false
	}

	return {
		// a run of t, caused by what caused each mark it was given
		run(t: T, given: readonly Cause<T>[]): Cause<T> {
			ran.add(t)
			return new Cause(t, given)
		},

		// a mark's causes, kept on t until the pulse's end
		keep(t: T, c: Cause<T>) {
			t.kept.add(c)
			holding.add(t)
		},

		// a loop through t: c came out of a run of t in this pulse. answers the computations on
		// the loop, in the order made, or nothing
		loop(c: Cause<T> | undefined, t: T): T[] | undefined {
			if (!c || !ran.has(t)) return
			if (!walk(c, (x) => x.of === t)) return
			const on = new Set<T>()
			walk(c, (x) => void on.add(x.of))
			return [...on].sort((a, b) => a.n - b.n)
		},

		// the pulse's end: causes and runs forgotten
		end() {
			for (const t of holding) t.kept.clear()
			holding.clear()
			ran.clear()
		},
	}
}
