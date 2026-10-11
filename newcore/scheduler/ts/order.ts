// order: who runs next. the due, each at the time of the change that made it due; and the ranks
// (rank.ts), kept, made again only where what some process is after changed.
//
// a process is after: the running processes whose nodes its last run read (values), and the one
// it waits after (after). the scheduler says when those change (sees, waits), and when a process
// starts and goes; order changes nothing else of a process.
import rank from "./rank.ts"

type Entry<P> = { p: P; rank: number; mark: number }

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

	// the due as a heap, by rank, then mark, then id; made against heapRanks
	const heap: Entry<P>[] = []
	let heapRanks: Map<P, number> | undefined
	const less = (a: Entry<P>, b: Entry<P>) =>
		a.rank !== b.rank
			? a.rank < b.rank
			: a.mark !== b.mark
			? a.mark < b.mark
			: byCodePoint(a.p.id, b.p.id) < 0
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
	const enter = (id: string, mark: number) => {
		const p = get(id)
		if (heapRanks && p) push({ p, rank: heapRanks.get(p) ?? 0, mark })
	}

	return {
		// the due, by id: the time each was made due at
		at: (id: string) => due.get(id),
		has: (id: string) => due.has(id),
		set: (id: string, time: number) => {
			due.set(id, time)
			enter(id, time)
		},
		delete: (id: string) => void due.delete(id),
		size: () => due.size,
		ids: () => [...due.keys()],

		rank: (p: P) => ranks().get(p) ?? 0,

		// the ids of the running processes p is after, sorted
		after: (p: P) => [...new Set(edges(p).map((q) => q.id))].sort(byCodePoint),

		// the due process to run: not waiting after a due one; lowest rank, then earliest made due,
		// then id
		next(): { p: P; rank: number } {
			const rank = ranks()
			// the heap is remade when the ranks are; a popped entry no longer due at its mark is stale
			if (heapRanks !== rank || heap.length > 4 * due.size + 64) {
				heapRanks = rank
				heap.length = 0
				for (const [id, m] of due) push({ p: get(id)!, rank: rank.get(get(id)!) ?? 0, mark: m })
			}
			const waiting: Entry<P>[] = []
			let best: Entry<P> | undefined
			while (heap.length) {
				const e = pop()
				if (due.get(e.p.id) !== e.mark) continue
				if (e.p.after && due.has(e.p.after.id)) {
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
