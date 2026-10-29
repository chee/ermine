// one edge, in two doubly linked lists: from's reads (prev, next; shift's) and to's readers
// (before, after; the order made)
export type Link<O> = {
	from: Node<O>
	to: Node<O>
	prev: Link<O> | null
	next: Link<O> | null
	before: Link<O> | null
	after: Link<O> | null
	gen: number
}

// links may repeat: a reader can have two links to one spot (see track)
// owner: the caller's thing, never read here
// cursor: the last link this run confirmed; outside a run, the last link (after leave: the last
// its run confirmed, the ones it did not reach after it, old, till trim)
// gen: the tick its latest run began at; 0 before any. open: in a run
// first, last: the readers' list
export type Node<O> = {
	owner: O
	reads: Link<O> | null
	cursor: Link<O> | null
	gen: number
	open: boolean
	first: Link<O> | null
	last: Link<O> | null
}

export function createTracker<O>(): {
	node: (owner: O) => Node<O>
	begin: (f: Node<O>) => void
	track: (f: Node<O>, t: Node<O>) => void
	end: (f: Node<O>) => void
	leave: (f: Node<O>) => void
	resume: (f: Node<O>) => void
	old: (l: Link<O>) => boolean
	trim: (f: Node<O>) => void
	dedupe: (f: Node<O>) => void
	add: (f: Node<O>, t: Node<O>) => void
	untrack: (f: Node<O>, t?: Node<O>) => void
	reads: (f: Node<O>) => readonly Node<O>[]
	readers: (t: Node<O>) => readonly Link<O>[]
} {
	type L = Link<O>
	type N = Node<O>

	// every begin takes the next tick
	let tick = 0

	// kept by the caller; a node with no links is garbage once the caller drops it
	function node(owner: O): N {
		return {
			owner,
			reads: null,
			cursor: null,
			gen: 0,
			open: false,
			first: null,
			last: null,
		}
	}

	// out of to's readers
	function drop(l: L) {
		if (l.before !== null) l.before.after = l.after
		else l.to.first = l.after
		if (l.after !== null) l.after.before = l.before
		else l.to.last = l.before
	}
	function link(from: N, to: N, prev: L | null, next: L | null) {
		const l: L = {
			from,
			to,
			prev,
			next,
			before: to.last,
			after: null,
			gen: from.open ? from.gen : 0,
		}
		if (prev !== null) prev.next = l
		else from.reads = l
		if (next !== null) next.prev = l
		if (to.last !== null) to.last.after = l
		else to.first = l
		to.last = l
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

	// not in a run already: end it first
	function begin(f: N) {
		if (f.open) throw new Error("begin in a run: end it first")
		f.open = true
		f.gen = ++tick
		f.cursor = null
	}

	// link's track (alien-signals, solid 2.0): the same spot as the last read, the next link in
	// order, or t's newest reader being this run, are free; else a new link at the cursor.
	// duplicates are allowed where these miss: reads b, a, b over old [a, b] ends with two b
	function track(f: N, t: N) {
		const cursor = f.cursor
		if (cursor !== null && cursor.to === t) return
		const next = cursor !== null ? cursor.next : f.reads
		if (next !== null && next.to === t) {
			next.gen = f.gen
			f.cursor = next
			return
		}
		const last = t.last
		if (last !== null && last.from === f && last.gen === f.gen) return
		f.cursor = link(f, t, cursor, next)
	}

	// whatever this run did not read again is dropped; without a run, nothing: leave, then trim
	function end(f: N) {
		f.open = false
		trim(f)
	}

	// the run ends, no link dropped: the ones it did not reach stay after the cursor, old, for trim
	// or dedupe (or the next run) to find
	function leave(f: N) {
		f.open = false
	}

	// the run left goes on (a generator compute's next step): open again, its tick and cursor as
	// leave left them, so its reads go on after the ones it made before
	function resume(f: N) {
		if (f.open) throw new Error("resume in a run: end it first")
		f.open = true
	}

	// a link from an earlier run that the latest run did not read: old (its run over). the next
	// run reading it takes it back; trim lets the old ones go when a run is done
	function old(l: L): boolean {
		return !l.from.open && l.gen !== l.from.gen
	}

	// outside a run: the links after the cursor (all, with no cursor) are dropped
	function trim(f: N) {
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

	// outside a run: the links after the cursor stay, but one to a spot linked before it, or after
	// it already, is dropped: a run left (leave) with its reads in a new order piles up no repeats
	function dedupe(f: N) {
		const cursor = f.cursor
		let l = cursor !== null ? cursor.next : f.reads
		if (l === null) return
		const seen = new Set<N>()
		for (let x = f.reads; x !== l; x = x!.next) seen.add(x!.to)
		while (l !== null) {
			const next: L | null = l.next
			if (seen.has(l.to)) unlink(l)
			else seen.add(l.to)
			l = next
		}
	}

	// outside a run: at the cursor (the end, after end), the cursor on it; or left where it is. in
	// a run it would mean track
	function add(f: N, t: N) {
		if (f.open) throw new Error("add in a run: use track")
		for (let l = f.reads; l !== null; l = l.next) if (l.to === t) return
		f.cursor = link(f, t, f.cursor, f.cursor !== null ? f.cursor.next : f.reads)
	}

	// untrack(from): all of from's. untrack(from, to): every link of from's to that one.
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

	// every link, so a spot read twice is listed twice
	function reads(f: N): readonly N[] {
		if (f.reads === null) return none
		const out: N[] = []
		for (let l: L | null = f.reads; l !== null; l = l.next) out.push(l.to)
		return out
	}
	// a copy, in the order made: each link's from is a reader
	function readers(t: N): readonly L[] {
		if (t.first === null) return none
		const out: L[] = []
		for (let l: L | null = t.first; l !== null; l = l.after) out.push(l)
		return out
	}

	return { node, begin, track, end, leave, resume, old, trim, dedupe, add, untrack, reads, readers }
}
