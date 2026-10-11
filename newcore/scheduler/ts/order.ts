// order: who runs next. the due, each at the time of the change that made it due; and the ranks
// (rank.ts), kept, made again only where what some process is after changed.
//
// a process is after: the running processes whose nodes its last run read (values), and the one
// it waits after (after). the scheduler says when those change (sees, waits), and when a process
// starts and goes; order changes nothing else of a process.
import rank from "./rank.ts"

export type Ordered<P> = { id: string; values: Set<string>; after?: P; state: string }

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function createOrder<P extends Ordered<P>>(
	get: (id: string) => P | undefined,
	all: () => Iterable<P>,
) {
	const due = new Map<string, number>()

	let rankOf: Map<P, number> | undefined
	// how many processes are after each id: a process starting under one remakes the ranks
	const named = new Map<string, number>()
	const name = (id: string, d: 1 | -1) => {
		const n = (named.get(id) ?? 0) + d
		if (n > 0) named.set(id, n)
		else named.delete(id)
	}
	const edge = (p: P, q: P | undefined) => q !== undefined && q !== p && q.state === "running"

	function edges(p: P): P[] {
		const out: P[] = []
		for (const id of p.values) {
			const q = id === p.id ? undefined : get(id)
			if (q?.state === "running") out.push(q)
		}
		if (p.after && p.after !== p && p.after.state === "running") out.push(p.after)
		return out
	}
	function ranks(): Map<P, number> {
		return rankOf ??= rank([...all()].filter((p) => p.state === "running"), edges)
	}

	return {
		// the due, by id: the time each was made due at
		at: (id: string) => due.get(id),
		has: (id: string) => due.has(id),
		set: (id: string, time: number) => void due.set(id, time),
		delete: (id: string) => void due.delete(id),
		size: () => due.size,
		ids: () => [...due.keys()],

		rank: (p: P) => ranks().get(p) ?? 0,

		// the due process to run: not waiting after a due one; lowest rank, then earliest made due,
		// then id
		next(): { p: P; rank: number } {
			const rank = ranks()
			let best: P | undefined
			let bestMark = 0
			for (const [id, m] of due) {
				const p = get(id)!
				if (p.after && due.has(p.after.id)) continue
				const r = rank.get(p) ?? 0
				const b = best && (rank.get(best) ?? 0)
				if (
					!best || r < b! ||
					(r === b && (m < bestMark || (m === bestMark && byCodePoint(p.id, best.id) < 0)))
				) {
					best = p
					bestMark = m
				}
			}
			return { p: best!, rank: rank.get(best!) ?? 0 }
		},

		started(p: P) {
			if (named.has(p.id)) rankOf = undefined
			else rankOf?.set(p, 0)
		},

		// the processes p's run read: p.values becomes next
		sees(p: P, next: Set<string>) {
			for (const id of p.values) {
				if (next.has(id)) continue
				name(id, -1)
				if (edge(p, get(id))) rankOf = undefined
			}
			for (const id of next) {
				if (p.values.has(id)) continue
				name(id, 1)
				if (edge(p, get(id))) rankOf = undefined
			}
			p.values = next
		},

		// p waits after q: p.after becomes q
		waits(p: P, q: P | undefined) {
			if (p.after === q) return
			if (p.after) {
				name(p.after.id, -1)
				if (edge(p, p.after)) rankOf = undefined
			}
			p.after = q
			if (q) {
				name(q.id, 1)
				if (edge(p, q)) rankOf = undefined
			}
		},

		// p is being killed: not due, out of the ranks
		killing(p: P) {
			if (named.has(p.id)) rankOf = undefined
			rankOf?.delete(p)
			due.delete(p.id)
		},

		// p is gone: after nothing
		gone(p: P) {
			for (const id of p.values) name(id, -1)
			p.values = new Set()
			if (p.after) name(p.after.id, -1)
			p.after = undefined
		},
	}
}

export type Order<P extends Ordered<P>> = ReturnType<typeof createOrder<P>>
