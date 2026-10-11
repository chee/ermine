// one edge: in from's reads, a doubly linked list (shift's), and in to's readers, an array
export type Link<O> = {
	from: Node<O>
	to: Node<O>
	prev: Link<O> | null
	next: Link<O> | null
	at: number
	gen: number
}

// owner: the caller's thing, never read here
// cursor: the last link this run confirmed; outside a run, the last link
export type Node<O> = {
	owner: O
	reads: Link<O> | null
	cursor: Link<O> | null
	gen: number
	readers: (Link<O> | null)[]
	holes: number
}

export function createTrackgraph<O>() {
	type L = Link<O>
	type N = Node<O>

	// kept by the caller; a node with no links is garbage once the caller drops it
	function node(owner: O): N {
		return { owner, reads: null, cursor: null, gen: 0, readers: [], holes: 0 }
	}

	// readers keep the order made; a removed one leaves a hole, filled in by compact
	function compact(n: N) {
		const readers = n.readers
		let j = 0
		for (let i = 0; i < readers.length; i++) {
			const l = readers[i]
			if (l === null) continue
			readers[j] = l
			l.at = j++
		}
		readers.length = j
		n.holes = 0
	}
	function drop(l: L) {
		const to = l.to
		const readers = to.readers
		if (l.at === readers.length - 1) {
			readers.pop()
			// the last reader is always a link: track's check needs it
			while (readers.length !== 0 && readers[readers.length - 1] === null) {
				readers.pop()
				to.holes--
			}
			if (to.holes * 2 > readers.length) compact(to)
		} else {
			readers[l.at] = null
			if (++to.holes * 2 > readers.length) compact(to)
		}
	}
	function link(from: N, to: N, prev: L | null, next: L | null) {
		const l: L = { from, to, prev, next, at: to.readers.length, gen: from.gen }
		if (prev !== null) prev.next = l
		else from.reads = l
		if (next !== null) next.prev = l
		to.readers.push(l)
		return l
	}
	function unlink(l: L) {
		const from = l.from
		if (l.prev !== null) l.prev.next = l.next
		else from.reads = l.next
		if (l.next !== null) l.next.prev = l.prev
		if (from.cursor === l) from.cursor = l.prev
		drop(l)
	}

	function begin(f: N) {
		f.gen++
		f.cursor = null
	}

	// shift's track: in order, the next link is confirmed; else a new one at the cursor
	function track(f: N, t: N) {
		const cursor = f.cursor
		const next = cursor !== null ? cursor.next : f.reads
		if (next !== null && next.to === t) {
			next.gen = f.gen
			f.cursor = next
			return
		}
		if (cursor !== null && cursor.to === t) return
		const tail = t.readers[t.readers.length - 1]
		if (tail != null && tail.from === f && tail.gen === f.gen) return
		f.cursor = link(f, t, cursor, next)
	}

	// whatever this run did not read again is dropped; without a run, nothing
	function end(f: N) {
		const cursor = f.cursor
		let stale: L | null
		if (cursor !== null) {
			stale = cursor.next
			cursor.next = null
		} else {
			stale = f.reads
			f.reads = null
		}
		while (stale !== null) {
			const next = stale.next
			drop(stale)
			stale = next
		}
	}

	// outside a run: at the end, or left where it is
	function add(f: N, t: N) {
		for (let l = f.reads; l !== null; l = l.next) if (l.to === t) return
		f.cursor = link(f, t, f.cursor, null)
	}

	// untrack(from): all of from's. untrack(from, to): that one.
	function untrack(f: N, t?: N) {
		if (t === undefined) {
			for (let l = f.reads; l !== null; l = l.next) drop(l)
			f.reads = null
			f.cursor = null
			return
		}
		for (let l = f.reads; l !== null; l = l.next) if (l.to === t) unlink(l)
	}

	const none: readonly never[] = Object.freeze([])

	function reads(f: N): readonly N[] {
		if (f.reads === null) return none
		const out: N[] = []
		for (let l: L | null = f.reads; l !== null; l = l.next) out.push(l.to)
		return out
	}
	// live, not a copy: each link's from is a reader
	function readers(t: N): readonly L[] {
		if (t.holes !== 0) compact(t)
		return t.readers as L[]
	}

	return { node, begin, track, end, add, untrack, reads, readers }
}
