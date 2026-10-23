// a log of named writes in memory, in the order they came: what the memory holder, the file
// holder and the history each hold their writes in. its cursor is a count: every write is given a
// number as it comes (1, 2, ...), and since(n) gives those after n. a write let go of keeps its
// number gone, so a cursor stays good across drop
import { MISNAMED, ORPHAN, type Outcome, type Since } from "./holder.ts"
import { named, type Write } from "./write.ts"

type Held = { readonly n: number; readonly write: Write }

export type Log = {
	// what put would say of the write: passed, refused, or undefined when it may be taken
	check(write: Write): Outcome | undefined
	// the write held, numbered next (checked first: nothing is checked here)
	add(write: Write): void
	// the writes numbered after cursor (none: from the start), at most limit
	since(cursor: unknown, limit?: number): Since
	// every write of one node, in the order they came
	get(node: string): Write[]
	// the writes that match let go of; how many
	remove(match: (w: Write) => boolean): number
	has(name: string): boolean
	all(): Write[]
}

export function createLog(): Log {
	let count = 0
	let held: Held[] = []
	const names = new Map<string, Held>()

	function check(write: Write): Outcome | undefined {
		if (names.has(write.name)) return "passed"
		if (!named(write)) return { refused: MISNAMED }
		if (!write.parents.every((p) => names.has(p))) return { refused: ORPHAN }
	}

	function add(write: Write) {
		const h = { n: ++count, write }
		held.push(h)
		names.set(write.name, h)
	}

	function since(cursor: unknown, limit = Infinity): Since {
		const after = typeof cursor === "number" ? cursor : 0
		// held is in number order: the first one after cursor, by halving
		let lo = 0, hi = held.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (held[mid].n <= after) lo = mid + 1
			else hi = mid
		}
		const out = held.slice(lo, lo + limit)
		const end = out.length ? out[out.length - 1].n : after
		return { writes: out.map((h) => h.write), cursor: end, more: lo + out.length < held.length }
	}

	const get = (node: string) => held.filter((h) => h.write.node === node).map((h) => h.write)

	function remove(match: (w: Write) => boolean): number {
		const before = held.length
		held = held.filter((h) => {
			if (!match(h.write)) return true
			names.delete(h.write.name)
			return false
		})
		return before - held.length
	}

	return {
		check,
		add,
		since,
		get,
		remove,
		has: (name: string) => names.has(name),
		all: () => held.map((h) => h.write),
	}
}
