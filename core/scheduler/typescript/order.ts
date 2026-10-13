// order: what runs next. the due, each at the tick it became due; and the ranks (rank.ts), kept,
// made again only where what some computation is after changed.
//
// a computation is after: the writers of the keys its last run read (values), and the one it
// waits after (after). the scheduler says when those change (sees, waits), and when one is made
// and goes; order changes nothing else of a computation.
import rank from "./rank.ts"

export type Ordered<P> = { n: number; values: Set<P>; after?: P; state: string }

type Entry<P> = { p: P; rank: number; mark: number }

export function createOrder<P extends Ordered<P>>(all: () => Iterable<P>) {
	const due = new Map<P, number>()

	let rankOf: Map<P, number> | undefined
	// how many computations are after each one: one going remakes the ranks
	const named = new Map<P, number>()
	const name = (p: P, d: 1 | -1) => {
		const n = (named.get(p) ?? 0) + d
		if (n > 0) named.set(p, n)
		else named.delete(p)
	}
	const edge = (p: P, q: P | undefined) => q !== undefined && q !== p && q.state === "alive"

	function edges(p: P): P[] {
		const out: P[] = []
		for (const q of p.values) if (edge(p, q)) out.push(q)
		if (edge(p, p.after)) out.push(p.after!)
		return out
	}
	function ranks(): Map<P, number> {
		return rankOf ??= rank([...all()].filter((p) => p.state === "alive"), edges)
	}

	// the due as a heap, by rank, then mark, then the order made; made against heapRanks
	const heap: Entry<P>[] = []
	let heapRanks: Map<P, number> | undefined
	const less = (a: Entry<P>, b: Entry<P>) =>
		a.rank !== b.rank ? a.rank < b.rank : a.mark !== b.mark ? a.mark < b.mark : a.p.n < b.p.n
	function push(e: Entry<P>) {
		let i = heap.push(e) - 1
		while (i > 0) {
			const up = (i - 1) >> 1
			if (!less(e, heap[up])) break
			heap[i] = heap[up]
			i = up
		}
		heap[i] = e
	}
	function pop(): Entry<P> {
		const top = heap[0]
		const last = heap.pop()!
		if (heap.length) {
			let i = 0
			for (;;) {
				let c = 2 * i + 1
				if (c >= heap.length) break
				if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++
				if (!less(heap[c], last)) break
				heap[i] = heap[c]
				i = c
			}
			heap[i] = last
		}
		return top
	}

	return {
		// the due: the tick each became due at
		at: (p: P) => due.get(p),
		has: (p: P) => due.has(p),
		set: (p: P, mark: number) => {
			due.set(p, mark)
			if (heapRanks) push({ p, rank: heapRanks.get(p) ?? 0, mark })
		},
		delete: (p: P) => void due.delete(p),
		size: () => due.size,

		rank: (p: P) => ranks().get(p) ?? 0,

		// the due computation to run: not waiting after a due one; lowest rank, then earliest made
		// due, then the order made
		next(): { p: P; rank: number } {
			const rank = ranks()
			// the heap is remade when the ranks are; a popped entry no longer due at its mark is stale
			if (heapRanks !== rank || heap.length > 4 * due.size + 64) {
				heapRanks = rank
				heap.length = 0
				for (const [p, mark] of due) push({ p, rank: rank.get(p) ?? 0, mark })
			}
			const waiting: Entry<P>[] = []
			let best: Entry<P> | undefined
			while (heap.length) {
				const e = pop()
				if (due.get(e.p) !== e.mark) continue
				if (e.p.after && due.has(e.p.after)) {
					waiting.push(e)
					continue
				}
				best = e
				break
			}
			for (const e of waiting) push(e)
			return { p: best!.p, rank: best!.rank }
		},

		started(p: P) {
			rankOf?.set(p, 0)
		},

		// the writers p's run read: p.values becomes next
		sees(p: P, next: Set<P>) {
			for (const q of p.values) {
				if (next.has(q)) continue
				name(q, -1)
				if (edge(p, q)) rankOf = undefined
			}
			for (const q of next) {
				if (p.values.has(q)) continue
				name(q, 1)
				if (edge(p, q)) rankOf = undefined
			}
			p.values = next
		},

		// p waits after q: p.after becomes q
		waits(p: P, q: P | undefined) {
			if (p.after === q) return
			if (p.after) {
				name(p.after, -1)
				if (edge(p, p.after)) rankOf = undefined
			}
			p.after = q
			if (q) {
				name(q, 1)
				if (edge(p, q)) rankOf = undefined
			}
		},

		// p goes: not due, out of the ranks, after nothing
		gone(p: P) {
			if (named.has(p)) rankOf = undefined
			rankOf?.delete(p)
			due.delete(p)
			for (const q of p.values) name(q, -1)
			p.values = new Set()
			if (p.after) name(p.after, -1)
			p.after = undefined
		},
	}
}

export type Order<P extends Ordered<P>> = ReturnType<typeof createOrder<P>>
