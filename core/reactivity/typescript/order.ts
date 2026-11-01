// Decides what runs next: the due computations, and the ranks that order them.
// Ranks are made whole once, then mended where an edge changed. A mended rank only ever rises.
import rank from "./rank.ts"

export type Ordered<P> = {
	n: number
	values: P[]
	after?: P
	state: string
	due: number
	rank: number
	ranked: number
	afters: Map<P, number> | undefined
	stamp: number
}

export function createOrder<P extends Ordered<P>>(
	all: () => Iterable<P>,
): Order<P> {
	let dues = 0
	let making = 0
	let made = 0
	let ranked = 0
	const members = new Set<P>()
	let stamps = 0
	const edge = (p: P, q: P | undefined) => q !== undefined && q !== p && q.state === "alive"
	const rankOf = (p: P) => p.ranked === making ? p.rank : 0

	function link(p: P, q: P) {
		const m = q.afters ??= new Map()
		m.set(p, (m.get(p) ?? 0) + 1)
	}
	function unlink(p: P, q: P) {
		const m = q.afters
		if (m === undefined) return
		const n = (m.get(p) ?? 0) - 1
		if (n > 0) m.set(p, n)
		else m.delete(p)
	}

	function edges(p: P): P[] {
		const out: P[] = []
		for (const q of p.values) if (edge(p, q)) out.push(q)
		if (edge(p, p.after)) out.push(p.after!)
		return out
	}
	function ranks() {
		if (making !== 0) return
		const r = rank([...all()].filter((p) => p.state === "alive"), edges)
		making = ++made
		ranked = r.size
		members.clear()
		for (const [p, k] of r) {
			p.rank = k
			p.ranked = making
		}
		for (const [p, k] of r) {
			for (const q of edges(p)) if (r.get(q) === k) members.add(p).add(q)
		}
		remake()
	}
	function remake() {
		heapLength =
			heapP.length =
			heapRank.length =
			heapMark.length =
				0
		for (const p of all()) if (p.due !== 0) push(p, rankOf(p), p.due)
	}

	function local(start: Iterable<P>) {
		const region = new Set<P>()
		const stack = [...start]
		while (stack.length) {
			const x = stack.pop()!
			if (x.state !== "alive" || region.has(x)) continue
			region.add(x)
			if (x.afters) { for (const y of x.afters.keys()) stack.push(y) }
		}
		const inner = (p: P) => edges(p).filter((q) => region.has(q))
		const floor = (p: P) => {
			let k = 0
			for (const q of edges(p)) if (!region.has(q)) k = Math.max(k, rankOf(q) + 1)
			return k
		}
		const r = rank(region, inner, floor)
		for (const [p, k] of r) {
			members.delete(p)
			if (p.ranked !== making) ranked++
			p.rank = k
			p.ranked = making
			if (p.due !== 0) push(p, k, p.due)
		}
		for (const [p, k] of r) for (const q of inner(p)) if (r.get(q) === k) members.add(p).add(q)
	}

	// Raise each of these to one past its highest edge, then do the same for whatever is after it.
	// Past a limit, or on a cycle, re-rank locally or make the ranks whole at the next pick.
	function mend(work: P[]) {
		if (making === 0) return
		const begun = new Set(work)
		const limit = 4 * ranked + 64
		for (let steps = 0; work.length; steps++) {
			if (steps > limit) return void (making = 0)
			const x = work.pop()!
			if (x.state !== "alive") continue
			if (members.has(x)) return local([x, ...work, ...begun])
			let k = 0
			for (const q of x.values) if (edge(x, q)) k = Math.max(k, rankOf(q) + 1)
			if (edge(x, x.after)) k = Math.max(k, rankOf(x.after!) + 1)
			if (k <= rankOf(x)) continue
			x.rank = k
			x.ranked = making
			if (x.due !== 0) push(x, k, x.due)
			if (x.afters) {
				for (const y of x.afters.keys()) {
					if (begun.has(y)) return local(begun)
					work.push(y)
				}
			}
		}
	}

	const heapP: P[] = []
	const heapRank: number[] = []
	const heapMark: number[] = []
	let heapLength = 0
	const lt = (r: number, m: number, n: number, r2: number, m2: number, n2: number) =>
		r !== r2 ? r < r2 : m !== m2 ? m < m2 : n < n2
	function put(i: number, p: P, rank: number, mark: number) {
		heapP[i] = p
		heapRank[i] = rank
		heapMark[i] = mark
	}
	function move(to: number, from: number) {
		put(to, heapP[from], heapRank[from], heapMark[from])
	}
	function push(p: P, rank: number, mark: number) {
		let i = heapLength++
		while (i > 0) {
			const up = (i - 1) >> 1
			if (!lt(rank, mark, p.n, heapRank[up], heapMark[up], heapP[up].n)) break
			move(i, up)
			i = up
		}
		put(i, p, rank, mark)
	}
	function pop() {
		const last = --heapLength
		const p = heapP[last], rank = heapRank[last], mark = heapMark[last]
		heapP[last] = undefined as unknown as P
		if (last === 0) return
		let i = 0
		for (;;) {
			let c = 2 * i + 1
			if (c >= last) break
			if (
				c + 1 < last &&
				lt(
					heapRank[c + 1],
					heapMark[c + 1],
					heapP[c + 1].n,
					heapRank[c],
					heapMark[c],
					heapP[c].n,
				)
			) c++
			if (!lt(heapRank[c], heapMark[c], heapP[c].n, rank, mark, p.n)) break
			move(i, c)
			i = c
		}
		put(i, p, rank, mark)
	}

	const waiting: P[] = []
	const waitingAt: number[] = []

	return {
		at: (p: P) => p.due !== 0 ? p.due : undefined,
		has: (p: P) => p.due !== 0,
		set: (p: P, mark: number) => {
			if (p.due === 0) dues++
			p.due = mark
			if (making !== 0) push(p, rankOf(p), mark)
		},
		delete: (p: P) => {
			if (p.due === 0) return
			dues--
			p.due = 0
		},
		size: () => dues,

		rank: (p: P) => (ranks(), rankOf(p)),

		next(): { p: P; rank: number } {
			ranks()
			if (heapLength > 4 * dues + 64) remake()
			let best: P | undefined
			let bestRank = 0
			while (heapLength) {
				const p = heapP[0], rank = heapRank[0], mark = heapMark[0]
				pop()
				if (p.due !== mark || rankOf(p) !== rank) continue
				if (p.after && p.after.due !== 0) {
					waiting.push(p)
					waitingAt.push(rank, mark)
					continue
				}
				best = p
				bestRank = rank
				break
			}
			for (let i = 0; i < waiting.length; i++) {
				push(waiting[i], waitingAt[2 * i], waitingAt[2 * i + 1])
			}
			waiting.length = 0
			waitingAt.length = 0
			return { p: best!, rank: bestRank }
		},

		started(p: P) {
			if (making === 0) return
			p.rank = 0
			p.ranked = making
			ranked++
		},

		sees(p: P, next: P[]) {
			const old = p.values
			p.values = next
			if (old.length === next.length) {
				let i = 0
				while (i < old.length && old[i] === next[i]) i++
				if (i === old.length) return
			}
			let changed = false
			const gone = ++stamps
			for (const q of next) q.stamp = gone
			for (const q of old) {
				if (q.stamp === gone) continue
				unlink(p, q)
				if (edge(p, q)) changed = true
			}
			const kept = ++stamps
			for (const q of old) q.stamp = kept
			for (const q of next) {
				if (q.stamp === kept) continue
				link(p, q)
				if (edge(p, q)) changed = true
			}
			if (changed) mend([p])
		},

		waits(p: P, q: P | undefined) {
			if (p.after === q) return
			let changed = false
			if (p.after) {
				unlink(p, p.after)
				if (edge(p, p.after)) changed = true
			}
			p.after = q
			if (q) {
				link(p, q)
				if (edge(p, q)) changed = true
			}
			if (changed) mend([p])
		},

		gone(p: P) {
			if (p.due !== 0) dues--
			p.due = 0
			for (const q of p.values) unlink(p, q)
			p.values = []
			if (p.after) unlink(p, p.after)
			p.after = undefined
			if (p.ranked === making && making !== 0) ranked--
			p.ranked = 0
			const m = p.afters
			p.afters = undefined
			if (members.delete(p) && m) local(m.keys())
		},
	}
}

export type Order<P extends Ordered<P>> = {
	at: (p: P) => number | undefined
	has: (p: P) => boolean
	set: (p: P, mark: number) => void
	delete: (p: P) => void
	size: () => number
	rank: (p: P) => number
	next: () => { p: P; rank: number }
	started: (p: P) => void
	sees: (p: P, next: P[]) => void
	waits: (p: P, q: P | undefined) => void
	gone: (p: P) => void
}
