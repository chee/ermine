// rank: strongly connected components (Tarjan), each ranked after the ones its members are after.
// members of one component share a rank; a component with nothing after it is 0, or the most
// floor gives its members (what they are after outside these, for a part of a graph)
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
	const visit = (p: T) => {
		index.set(p, next)
		low.set(p, next++)
		stack.push(p)
		on.add(p)
		for (const q of edges(p)) {
			if (!index.has(q)) {
				visit(q)
				low.set(p, Math.min(low.get(p)!, low.get(q)!))
			} else if (on.has(q)) low.set(p, Math.min(low.get(p)!, index.get(q)!))
		}
		if (low.get(p) !== index.get(p)) return
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
	for (const p of all) if (!index.has(p)) visit(p)
	return out
}

export default rank
