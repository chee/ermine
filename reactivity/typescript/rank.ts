// Strongly connected components (Tarjan), each ranked after the ones its members are after.
// Members of a component share a rank.
export function rank<T>(
	all: Iterable<T>,
	edges: (t: T) => T[],
	floor?: (t: T) => number,
): Map<T, number> {
	const out = new Map<T, number>()
	const index = new Map<T, number>()
	const low = new Map<T, number>()
	const on = new Set<T>()
	const stack: T[] = []
	let next = 0
	// The walk uses its own stack, not the call stack, so a chain of any depth works (rank.c too).
	const call: T[] = []
	const kids: T[][] = []
	const at: number[] = []
	const enter = (p: T) => {
		index.set(p, next)
		low.set(p, next++)
		stack.push(p)
		on.add(p)
		call.push(p)
		kids.push(edges(p))
		at.push(0)
	}
	const visit = (root: T) => {
		enter(root)
		while (call.length) {
			const top = call.length - 1, p = call[top], es = kids[top]
			if (at[top] < es.length) {
				const q = es[at[top]++]
				if (!index.has(q)) enter(q)
				else if (on.has(q)) low.set(p, Math.min(low.get(p)!, index.get(q)!))
				continue
			}
			call.pop(), kids.pop(), at.pop()
			if (call.length) {
				const up = call[call.length - 1]
				low.set(up, Math.min(low.get(up)!, low.get(p)!))
			}
			if (low.get(p) !== index.get(p)) continue
			const members: T[] = []
			let m: T
			do {
				m = stack.pop()!
				on.delete(m)
				members.push(m)
			} while (m !== p)
			let r = 0
			const inside = new Set(members)
			for (const x of members) {
				if (floor) r = Math.max(r, floor(x))
				for (const q of edges(x)) if (!inside.has(q)) r = Math.max(r, out.get(q)! + 1)
			}
			for (const x of members) out.set(x, r)
		}
	}
	for (const p of all) if (!index.has(p)) visit(p)
	return out
}

export default rank
