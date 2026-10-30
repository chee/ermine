// Tracks, within one pulse, what led to each run, so a mark on a computation can be traced back
// to a run of that same computation (a loop). Nothing outlives the pulse.
export class Cause<T> {
	constructor(readonly of: T, readonly parents: readonly Cause<T>[]) {}
}

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
	let pulse = 1
	const holding: T[] = []

	return {
		run(t: T, given: readonly Cause<T>[]): Cause<T> {
			t.ranIn = pulse
			return new Cause(t, given)
		},

		keep(t: T, c: Cause<T>) {
			if (t.kept[t.kept.length - 1] === c) return
			t.kept.push(c)
			if (t.heldIn === pulse) return
			t.heldIn = pulse
			holding.push(t)
		},

		loop(c: Cause<T> | undefined, t: T): T[] | undefined {
			if (!c || t.ranIn !== pulse) return
			// Causes only point back, so there is no cycle. A cause is on the path if it is a run of t
			// or one of its parents is.
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

		end() {
			for (const t of holding) t.kept.length = 0
			holding.length = 0
			pulse++
		},
	}
}
