// order: what runs next. the due, each at the tick it became due; a due one runs once every due
// one above it ran (what it is after, and what that is after.., a cycle it is in aside); of those,
// the earliest due, then the oldest (made first). the ranks are how order finds what is above:
// made whole once (rank.ts), then mended where an edge changed, only ever rising.
//
// a computation is after: the writers of the keys its last run read (values), and the one it
// waits after (after). the scheduler says when those change (sees, waits), and when one is made
// and goes; order changes nothing else of a computation, but its own fields on it (Ordered).
//
// mending: a computation whose edges changed rises to one past the most of what it is after, if
// that is more than its rank now, and what is after it does the same, as far as a rank rises.
// a rank never falls (an edge gone, a computation gone: nothing lowered), so it is at least
// rank.ts's, never less: still after everything it is after. a cycle (a component of more than
// one) is rank.ts's alone, ranked over the part of the graph from the change on (local): when a
// mend reaches one of its members, a member goes, or a mend comes back round to where it began
// (a cycle made now). so one above another is ranked lower, unless they are one cycle, which
// shares a rank.
//
// above: a due one with a lower rank, reached walking up from it (what it is after, and on);
// nothing ranked under the lowest due rank has anything due above it, so the walk stops there.
// one found above is held: set aside on what was found, with the way down from it; when that one
// is no longer due, the first due one along the way holds it again, else it is looked at anew. an
// edge gone, or a cycle joined, lets every held one be looked at anew
import rank from "./rank.ts"

// what order keeps on a computation. values: the writers its last run read, no repeats.
// due: the tick it became due at; 0, not due. rank: its rank, good while ranked is the making
// now. afters: what is after it, each with how many edges. stamp: for telling two lists apart.
// counted: the rank it is counted at while due. walked, via: a walk up's own (the walk it was reached in, and from what below). held: what
// holds it, and the way down from there; holding: those it holds
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
	counted: number
	walked: number
	via: P | undefined
	held: Hold<P> | undefined
	holding: Hold<P>[] | undefined
}

// a due one held: on the way down from it (way[at]), while it is due at mark and nothing has let
// the held go since (loose)
export type Hold<P> = { p: P; way: P[]; at: number; mark: number; loose: number }

export function createOrder<P extends Ordered<P>>(
	all: () => Iterable<P>,
): Order<P> {
	// how many are due
	let dues = 0
	// the making of the ranks now (0: none, made at the next pick); how many it ranks; whether
	// some component of it has more than one member
	let making = 0
	let made = 0
	let ranked = 0
	// the members of a component of more than one, at the making now
	const members = new Set<P>()
	let stamps = 0
	const edge = (p: P, q: P | undefined) => q !== undefined && q !== p && q.state === "alive"
	const rankOf = (p: P) => p.ranked === making ? p.rank : 0
	// bumped when an edge goes, or the ranks are made again (a cycle may have joined): every held
	// one is looked at anew at the next pick
	let loose = 0
	let looked = 0

	// p is after q by one more edge, or one less
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
		loose++
		members.clear()
		for (const [p, k] of r) {
			p.rank = k
			p.ranked = making
		}
		for (const [p, k] of r) {
			for (const q of edges(p)) if (r.get(q) === k) members.add(p).add(q)
		}
		recount()
	}
	// the due counted by rank (at, each one's counted), and the ranks with some, lowest first (a
	// heap, a rank there twice, or none due at it, stale): the lowest rank due
	let at: number[] = []
	const lows: number[] = []
	function count(p: P, r: number) {
		p.counted = r
		at[r] = (at[r] ?? 0) + 1
		if (at[r] !== 1) return
		let i = lows.length
		lows.push(r)
		while (i > 0) {
			const up = (i - 1) >> 1
			if (lows[up] <= r) break
			lows[i] = lows[up]
			i = up
		}
		lows[i] = r
	}
	function lowest(): number {
		while (lows.length && !(at[lows[0]] > 0)) {
			const r = lows.pop()!
			if (!lows.length) break
			let i = 0
			for (;;) {
				let c = 2 * i + 1
				if (c >= lows.length) break
				if (c + 1 < lows.length && lows[c + 1] < lows[c]) c++
				if (lows[c] >= r) break
				lows[i] = lows[c]
				i = c
			}
			lows[i] = r
		}
		return lows.length ? lows[0] : 0
	}
	// counted again, from the due
	function recount() {
		at = []
		lows.length = 0
		for (const p of all()) if (p.due !== 0) count(p, rankOf(p))
	}
	// a due one's rank changed
	function moved(p: P, r: number) {
		at[p.counted]--
		count(p, r)
	}

	// ranked again from start and everything after it (the region): rank.ts over the region's own
	// edges, each at least one past what it is after outside it. nothing outside is after the
	// region, so nothing outside changes. its members found again
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
		loose++
		for (const [p, k] of r) {
			members.delete(p)
			if (p.ranked !== making) ranked++
			p.rank = k
			p.ranked = making
			if (p.due !== 0) moved(p, k)
		}
		for (const [p, k] of r) for (const q of inner(p)) if (r.get(q) === k) members.add(p).add(q)
	}

	// the edges of these changed: each rises to one past its edges' most, and what is after it
	// too, as far as a rank rises. a due one mended goes in the heap again at its new rank. a
	// cycle's member reached, or one of these reached again (after what is after it: a cycle made
	// now): ranked again from these on (local). mending longer than a whole making would take:
	// made whole at the next
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
			if (x.due !== 0) moved(x, k)
			if (x.afters) {
				for (const y of x.afters.keys()) {
					if (begun.has(y)) return local(begun)
					work.push(y)
				}
			}
		}
	}

	// the due again, by mark, then the order made, to pick from: two lists side by side. an entry
	// whose computation is no longer due at its mark, or is held, is stale
	const dueP: P[] = []
	const dueMark: number[] = []
	let dueLength = 0
	const before = (m: number, n: number, m2: number, n2: number) => m !== m2 ? m < m2 : n < n2
	function enter(p: P, mark: number) {
		let i = dueLength++
		while (i > 0) {
			const up = (i - 1) >> 1
			if (!before(mark, p.n, dueMark[up], dueP[up].n)) break
			dueP[i] = dueP[up]
			dueMark[i] = dueMark[up]
			i = up
		}
		dueP[i] = p
		dueMark[i] = mark
	}
	function leave() {
		const last = --dueLength
		const p = dueP[last], mark = dueMark[last]
		dueP[last] = undefined as unknown as P
		if (last === 0) return
		let i = 0
		for (;;) {
			let c = 2 * i + 1
			if (c >= last) break
			if (c + 1 < last && before(dueMark[c + 1], dueP[c + 1].n, dueMark[c], dueP[c].n)) c++
			if (!before(dueMark[c], dueP[c].n, mark, p.n)) break
			dueP[i] = dueP[c]
			dueMark[i] = dueMark[c]
			i = c
		}
		dueP[i] = p
		dueMark[i] = mark
	}
	function reenter() {
		dueLength = dueP.length = dueMark.length = 0
		for (const p of all()) if (p.due !== 0 && p.held === undefined) enter(p, p.due)
	}

	// holds: every one made since the held were last let go; those let go when what held them is
	// no longer due
	const holds: Hold<P>[] = []
	const freed: Hold<P>[] = []
	function hold(h: Hold<P>) {
		h.p.held = h
		;(h.way[h.at].holding ??= []).push(h)
	}
	// p is due no longer: what it held is looked at again
	function free(p: P) {
		const hs = p.holding
		if (hs === undefined) return
		p.holding = undefined
		for (const h of hs) freed.push(h)
	}
	const live = (h: Hold<P>) => h.p.held === h && h.p.due === h.mark && h.loose === loose
	function release(p: P) {
		p.held = undefined
		enter(p, p.due)
	}
	// a held one whose holder is due no longer: the next due one down the way holds it, else it is
	// picked from again
	function again(h: Hold<P>) {
		if (!live(h)) return
		const k = rankOf(h.p)
		for (let i = h.at; i < h.way.length; i++) {
			const y = h.way[i]
			if (y.state !== "alive" || y.due === 0 || rankOf(y) >= k) continue
			h.at = i
			hold(h)
			return
		}
		release(h.p)
	}

	// the walk up from p for a due one above it (ranked under it), seen no lower than floor: the
	// way down from it to p (p not in it), or none
	let walks = 0
	const reached: P[] = []
	function above(p: P, floor: number): P[] | undefined {
		const w = ++walks
		const k = rankOf(p)
		p.walked = w
		reached.length = 0
		reached.push(p)
		for (let i = 0; i < reached.length; i++) {
			const x = reached[i]
			const n = x.values.length
			for (let j = 0; j <= n; j++) {
				const q = j < n ? x.values[j] : x.after
				if (q === undefined || !edge(x, q) || q.walked === w) continue
				q.walked = w
				q.via = x
				const r = rankOf(q)
				if (r < floor) continue
				if (q.due !== 0 && r < k) {
					const way = [q]
					for (let y = x; y !== p; y = y.via!) way.push(y)
					reached.length = 0
					return way
				}
				reached.push(q)
			}
		}
		reached.length = 0
		return undefined
	}

	// the entries next sets aside, waiting after a due one: computations, and marks
	const waiting: P[] = []
	const waitingAt: number[] = []

	return {
		// the due: the tick each became due at
		at: (p: P) => p.due !== 0 ? p.due : undefined,
		has: (p: P) => p.due !== 0,
		set: (p: P, mark: number) => {
			if (p.due === 0) dues++
			else if (making !== 0) at[p.counted]--
			p.due = mark
			p.held = undefined
			enter(p, mark)
			if (making !== 0) count(p, rankOf(p))
		},
		delete: (p: P) => {
			if (p.due === 0) return
			dues--
			p.due = 0
			if (making !== 0) at[p.counted]--
			p.held = undefined
			free(p)
		},
		size: () => dues,

		rank: (p: P) => (ranks(), rankOf(p)),

		// the due computation to run: not waiting after a due one, nothing due above it; of those
		// the earliest made due, then the oldest
		next(): { p: P; rank: number } {
			ranks()
			// stale entries past four times the due: made again
			if (dueLength > 4 * dues + 64) reenter()
			// an edge gone or a cycle joined since: every held one is picked from again
			if (looked !== loose) {
				looked = loose
				freed.length = 0
				for (const h of holds) if (h.p.held === h) release(h.p)
				holds.length = 0
			} else if (holds.length > 4 * dues + 64) {
				let k = 0
				for (const h of holds) if (live(h)) holds[k++] = h
				holds.length = k
			}
			for (let i = 0; i < freed.length; i++) again(freed[i])
			freed.length = 0
			// no due one is above what is ranked under the lowest rank due
			const floor = lowest()
			let best: P | undefined
			while (dueLength) {
				const p = dueP[0], mark = dueMark[0]
				leave()
				if (p.due !== mark || p.held !== undefined) continue
				if (p.after && p.after.due !== 0) {
					waiting.push(p)
					waitingAt.push(mark)
					continue
				}
				if (rankOf(p) > floor) {
					const way = above(p, floor)
					if (way) {
						const h: Hold<P> = { p, way, at: 0, mark, loose }
						holds.push(h)
						hold(h)
						continue
					}
				}
				best = p
				break
			}
			for (let i = 0; i < waiting.length; i++) enter(waiting[i], waitingAt[i])
			waiting.length = 0
			waitingAt.length = 0
			if (best === undefined) throw new Error("order: nothing to run")
			return { p: best, rank: rankOf(best) }
		},

		started(p: P) {
			if (making === 0) return
			p.rank = 0
			p.ranked = making
			ranked++
		},

		// the writers p's run read: p.values becomes next
		sees(p: P, next: P[]) {
			const old = p.values
			p.values = next
			// the same, in the same order: nothing changed
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
				if (edge(p, q)) {
					changed = true
					loose++
				}
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

		// p waits after q: p.after becomes q
		waits(p: P, q: P | undefined) {
			if (p.after === q) return
			let changed = false
			if (p.after) {
				unlink(p, p.after)
				if (edge(p, p.after)) {
					changed = true
					loose++
				}
			}
			p.after = q
			if (q) {
				link(p, q)
				if (edge(p, q)) changed = true
			}
			if (changed) mend([p])
		},

		// p goes: not due, out of the ranks, after nothing; what was after it keeps its rank. a
		// cycle's member: what was after it ranked again (local)
		gone(p: P) {
			if (p.due !== 0) {
				dues--
				if (making !== 0) at[p.counted]--
			}
			p.due = 0
			p.held = undefined
			free(p)
			loose++
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
