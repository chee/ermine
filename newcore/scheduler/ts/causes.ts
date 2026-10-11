// causes: within one request, what led to each run: its process, and the causes of each change
// that marked it. so a mark on a process can be asked: did it come out of a run of that same
// process? then it is a loop through it. nothing is kept past the request.
import { byCodePoint } from "./helpers.ts"
import type { Kept } from "./types.ts"

export class Cause {
	constructor(readonly id: string, readonly parents: readonly Cause[]) {}
}

export function createCauses() {
	// the processes that ran in this request
	const ran = new Set<string>()
	// the marks holding causes, forgotten at the request's end
	const stamped: Kept[] = []

	// every cause reached from c
	function walk(c: Cause, each: (x: Cause) => boolean | void): boolean {
		const seen = new Set<Cause>([c])
		const stack = [c]
		while (stack.length) {
			const x = stack.pop()!
			if (each(x)) return true
			for (const q of x.parents) if (!seen.has(q)) (seen.add(q), stack.push(q))
		}
		return false
	}

	return {
		// a run of id, caused by what caused each mark it was given
		run(id: string, kept: readonly Kept[]): Cause {
			const parents = new Set<Cause>()
			for (const k of kept) if (k.causes) parents.add(k.causes)
			ran.add(id)
			return new Cause(id, [...parents])
		},

		// a mark kept on a process: its causes are forgotten at the request's end
		keep(k: Kept) {
			if (k.causes) stamped.push(k)
		},

		// a loop through id: causes came out of a run of id in this request. answers the ids on
		// the loop, or nothing
		loop(causes: Cause | undefined, id: string): string[] | undefined {
			if (!causes || !ran.has(id)) return
			if (!walk(causes, (x) => x.id === id)) return
			const ids = new Set<string>()
			walk(causes, (x) => void ids.add(x.id))
			return [...ids].sort(byCodePoint)
		},

		// the request's end: causes forgotten; which processes ran too, unless calls wait queued
		end(queued: boolean) {
			for (const k of stamped) k.causes = undefined
			stamped.length = 0
			if (!queued) ran.clear()
		},
	}
}
