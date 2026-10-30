// One edge in two doubly linked lists: from's reads (prev, next) and to's readers (before, after).
export type Link<O> = {
	from: Node<O>
	to: Node<O>
	prev: Link<O> | null
	next: Link<O> | null
	before: Link<O> | null
	after: Link<O> | null
	gen: number
}

// owner: the caller's, never read here.
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

	let tick = 0

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

	function begin(f: N) {
		if (f.open) throw new Error("begin in a run: end it first")
		f.open = true
		f.gen = ++tick
		f.cursor = null
	}

	// Follows alien-signals and solid 2.0. Duplicates are allowed where the cheap checks miss: reads
	// b, a, b over old [a, b] end with two b.
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

	function end(f: N) {
		f.open = false
		trim(f)
	}

	function leave(f: N) {
		f.open = false
	}

	function resume(f: N) {
		if (f.open) throw new Error("resume in a run: end it first")
		f.open = true
	}

	function old(l: L): boolean {
		return !l.from.open && l.gen !== l.from.gen
	}

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

	function add(f: N, t: N) {
		if (f.open) throw new Error("add in a run: use track")
		for (let l = f.reads; l !== null; l = l.next) if (l.to === t) return
		f.cursor = link(f, t, f.cursor, f.cursor !== null ? f.cursor.next : f.reads)
	}

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
	function readers(t: N): readonly L[] {
		if (t.first === null) return none
		const out: L[] = []
		for (let l: L | null = t.first; l !== null; l = l.after) out.push(l)
		return out
	}

	return { node, begin, track, end, leave, resume, old, trim, dedupe, add, untrack, reads, readers }
}
