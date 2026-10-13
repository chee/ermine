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

// owner: the caller's thing, never read here
// cursor: the last link this run confirmed; outside a run, the last link
// gen: the tick this node's run began at; 0 outside a run
// kept: gen, once the run has confirmed a link in order
// touched: the tick of the last link made to this node
// first, last: the readers' list
export type Node<O> = {
	owner: O
	reads: Link<O> | null
	cursor: Link<O> | null
	gen: number
	kept: number
	touched: number
	first: Link<O> | null
	last: Link<O> | null
}

export function createTracker<O>() {
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
			kept: 0,
			touched: 0,
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
		const l: L = { from, to, prev, next, before: to.last, after: null, gen: from.gen }
		to.touched = tick
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

	function begin(f: N) {
		f.gen = ++tick
		f.cursor = null
	}

	// a link of f's to t, made or confirmed in f's run
	function read(f: N, t: N) {
		for (let l = t.last; l !== null; l = l.before) {
			if (l.from === f && l.gen === f.gen) return true
		}
		return false
	}

	// shift's track: in order, the next link is confirmed; else a new one at the cursor.
	// not in order: f may have read t already in this run, only if it confirmed a link in
	// order, or a link was made to t since f began; else t is not looked through.
	// in order, but t read already: t was linked anew in this run (so made since f began), and
	// the next link is an old second one; it goes
	function track(f: N, t: N) {
		const cursor = f.cursor
		const next = cursor !== null ? cursor.next : f.reads
		if (next !== null && next.to === t) {
			if (t.touched >= f.gen && read(f, t)) return unlink(next)
			next.gen = f.gen
			f.cursor = next
			f.kept = f.gen
			return
		}
		if (cursor !== null && cursor.to === t) return
		if ((f.kept === f.gen || t.touched >= f.gen) && read(f, t)) return
		f.cursor = link(f, t, cursor, next)
	}

	// whatever this run did not read again is dropped; without a run, nothing
	function end(f: N) {
		f.gen = 0
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

	// outside a run: at the end, or left where it is. in a run it would mean track
	function add(f: N, t: N) {
		if (f.gen !== 0) throw new Error("add in a run: use track")
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
	// a copy, in the order made: each link's from is a reader
	function readers(t: N): readonly L[] {
		if (t.first === null) return none
		const out: L[] = []
		for (let l: L | null = t.first; l !== null; l = l.after) out.push(l)
		return out
	}

	return { node, begin, track, end, add, untrack, reads, readers }
}
