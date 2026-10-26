// tracked paths: which reads a patch reaches (core/scheduler/fine-grained.md, the rule).
// a spot is (source, id, path): a read of path in the value at that key, deep (the reader was
// handed all under path). a keys spot is a read of which keys there are at path, not what is
// under them (see keyed). spots are kept by address, so a read of something not made yet has
// one, and shared by everyone who reads the same path. each key has a trie of path steps; a
// patch walks its own path, then marks what lies under it: O(|path| + marked).
//
// a list's number kids are also kept in order, by key: a range finds those from a on with one
// binary search, and the ones before it cost nothing. a read in index order adds at the end.
//
// pruning: release(spot) lets a spot go, with the steps left empty above it. this file knows no
// readers. the wiring holds a tracker node per spot (spot.owner); one with no readers left
// (node.first === null) is held by no one. it releases those after untrack, and lazily: a spot
// mark gives back with no readers is released, not run.
import type { Key, Patch } from "@ermine/core/op/apply"

export type { Key, Patch }

// owner: the caller's, never read here. path: never changed once given (it is kept, not
// copied); null: the change spot, reads of the change itself (time, actor, metadata)
export type Spot<O> = {
	source: unknown
	id: unknown
	path: readonly Key[] | null
	// a read of the keys at path only
	keys: boolean
	owner: O | undefined
	// the mark call that last gave it, so a call gives it once
	seen: number
	// where it is kept: its step, or its key's root for the change spot
	step: Step<O> | null
	root: Root<O>
}

// one path step in a key's trie; key: in up's kids (null at the top)
type Step<O> = {
	key: Key | null
	up: Step<O> | null
	kids: Map<Key, Step<O>> | null
	// the kids with number keys, by key
	nums: Step<O>[] | null
	spot: Spot<O> | null
	// the keys spot at this path
	keys: Spot<O> | null
}

type Root<O> = { source: unknown; id: unknown; top: Step<O>; change: Spot<O> | null }

// a place a patch changes: a take, a landing, or the patch itself. put: something lands there
// (an unranged put is a replace, never a shift). n: positions in a ranged place, null when not
// known (a value that is not a list: a string or typed array, a leaf)
export type Place = {
	path: readonly Key[]
	range?: readonly [number, number]
	put: boolean
	n: number | null
}

// a move is its take and its landing; a landing holds the take's count, or 1
function places(p: Patch): Place[] {
	if (p.move) {
		const m = p.move
		const n = m.range ? m.range[1] - m.range[0] : 1
		return [
			{ path: m.path, range: m.range, put: false, n: 0 },
			{ path: p.path, range: p.range, put: true, n },
		]
	}
	const put = "value" in p
	const n = !put ? 0 : Array.isArray(p.value) ? p.value.length : null
	return [{ path: p.path, range: p.range, put, n }]
}

// a list's removal at S+[k] shifts the kids of S from k on
const shifts = (q: Place) =>
	!q.range && !q.put && q.path.length > 0 && typeof q.path[q.path.length - 1] === "number"

// whether a place reaches a read of path
function hit(q: Place, path: readonly Key[]): boolean {
	const Q = q.path, n = Q.length
	let i = 0
	while (i < n && i < path.length && path[i] === Q[i]) i++
	// the read is at Q or above it: the change is inside what it read
	if (i === path.length) return true
	// beside Q: only a list removal's shift reaches it, past Q's last step
	if (i < n) return i === n - 1 && shifts(q) && typeof path[i] === "number" && path[i] > Q[i]
	// under Q: an unranged place replaced it; a ranged one reaches it by its index
	if (!q.range) return true
	const k = path[n]
	if (typeof k !== "number") return false
	const [a, b] = q.range
	return q.n === b - a ? k >= a && k < b : k >= a
}

// whether a place reaches a keys read of path: where a read of path would be reached (the place
// at it, or above it), and below it only one unranged step down (a key set, removed, taken or
// landed). deeper, or ranged into a key's value, it is not
export function keyed(q: Place, path: readonly Key[]): boolean {
	const Q = q.path
	if (Q.length <= path.length) return hit(q, path)
	return Q.length === path.length + 1 && !q.range && path.every((k, i) => Q[i] === k)
}

// whether the patch marks a read of path (a keys read when keys): the rule, as a function
export function marks(patch: Patch, path: readonly Key[], keys = false): boolean {
	return places(patch).some((q) => keys ? keyed(q, path) : hit(q, path))
}

// the first of the ordered nums with key >= a
function from<O>(nums: Step<O>[], a: number): number {
	let lo = 0, hi = nums.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if ((nums[mid].key as number) < a) lo = mid + 1
		else hi = mid
	}
	return lo
}

export function createPaths<O>(): {
	spot: (source: unknown, id: unknown, path: readonly Key[], keys?: boolean) => Spot<O>
	change: (source: unknown, id: unknown) => Spot<O>
	mark: (source: unknown, id: unknown, patches: Iterable<Patch>) => Spot<O>[]
	event: (source: unknown, id: unknown) => Spot<O>[]
	release: (s: Spot<O>) => void
	kept: () => { keys: number; spots: number; steps: number }
} {
	type S = Spot<O>
	type T = Step<O>
	type R = Root<O>

	const roots = new Map<unknown, Map<unknown, R>>()
	const counts = { keys: 0, spots: 0, steps: 0 }
	// every mark call takes the next tick
	let tick = 0

	const step = (key: Key | null, up: T | null): T => {
		counts.steps++
		return { key, up, kids: null, nums: null, spot: null, keys: null }
	}
	function root(source: unknown, id: unknown, make: boolean): R | undefined {
		let ids = roots.get(source)
		let r = ids?.get(id)
		if (r !== undefined || !make) return r
		if (ids === undefined) roots.set(source, ids = new Map())
		ids.set(id, r = { source, id, top: step(null, null), change: null })
		counts.keys++
		return r
	}
	function made(r: R, path: readonly Key[] | null, at: T | null, keys = false): S {
		counts.spots++
		return {
			source: r.source,
			id: r.id,
			path,
			keys,
			owner: undefined,
			seen: 0,
			step: at,
			root: r,
		}
	}

	// the spot of a read of path at (source, id): made or found
	function spot(source: unknown, id: unknown, path: readonly Key[], keys = false): S {
		const r = root(source, id, true)!
		let at = r.top
		for (const k of path) {
			let next = at.kids?.get(k)
			if (next === undefined) {
				next = step(k, at)
				;(at.kids ??= new Map()).set(k, next)
				if (typeof k === "number") {
					const nums = at.nums ??= []
					const last = nums.length ? nums[nums.length - 1].key as number : -1
					if (k > last) nums.push(next)
					else nums.splice(from(nums, k), 0, next)
				}
			}
			at = next
		}
		if (keys) return at.keys ??= made(r, path, at, true)
		return at.spot ??= made(r, path, at)
	}

	// the spot of reads of the change itself at (source, id): made or found
	function change(source: unknown, id: unknown): S {
		const r = root(source, id, true)!
		return r.change ??= made(r, null, null)
	}

	// what a call marks, each spot once
	let out: S[] = []
	const give = (s: S | null) => {
		if (s === null || s.seen === tick) return
		s.seen = tick
		out.push(s)
	}
	// every spot at or under at
	function all(at: T) {
		give(at.spot)
		give(at.keys)
		if (at.kids !== null) { for (const kid of at.kids.values()) all(kid) }
	}
	// the kids of at, ordered, from a on, up to b when given
	function span(at: T, a: number, b = Infinity) {
		const nums = at.nums
		if (nums === null) return
		for (let i = from(nums, a); i < nums.length; i++) {
			if ((nums[i].key as number) >= b) return
			all(nums[i])
		}
	}
	function place(r: R, q: Place) {
		const Q = q.path
		let at: T = r.top
		for (let i = 0; i < Q.length; i++) {
			give(at.spot)
			// a keys read one step above an unranged place
			if (i === Q.length - 1 && !q.range) give(at.keys)
			if (i === Q.length - 1 && shifts(q)) span(at, (Q[i] as number) + 1)
			const next = at.kids?.get(Q[i])
			if (next === undefined) return
			at = next
		}
		if (!q.range) return all(at)
		give(at.spot)
		give(at.keys)
		const [a, b] = q.range
		span(at, a, q.n === b - a ? b : Infinity)
	}

	// the spots the patches at (source, id) mark, each once, the change spot with them: one
	// update's patches, each in its own coordinates (a shift marks all after it, so a later
	// patch differs from what was read only where it is already marked)
	function mark(source: unknown, id: unknown, patches: Iterable<Patch>): S[] {
		const r = root(source, id, false)
		if (r === undefined) return []
		tick++
		out = []
		give(r.change)
		for (const p of patches) for (const q of places(p)) place(r, q)
		return out
	}

	// a whole-node event: the table adding, replacing or removing the node at (source, id). every
	// spot of that key, as a patch at [] would
	function event(source: unknown, id: unknown): S[] {
		return mark(source, id, [{ path: [] }])
	}

	// lets a spot go; a step left with no spot and no kids goes, then the key with nothing left.
	// released already: nothing
	function release(s: S) {
		const r = s.root
		if (s.path === null) {
			if (r.change !== s) return
			r.change = null
		} else {
			let at = s.step!
			if ((s.keys ? at.keys : at.spot) !== s) return
			if (s.keys) at.keys = null
			else at.spot = null
			while (at.up !== null && at.spot === null && at.keys === null && at.kids === null) {
				const up: T = at.up
				up.kids!.delete(at.key!)
				if (up.kids!.size === 0) up.kids = null
				if (typeof at.key === "number") {
					up.nums!.splice(from(up.nums!, at.key), 1)
					if (up.nums!.length === 0) up.nums = null
				}
				counts.steps--
				at = up
			}
		}
		counts.spots--
		const top = r.top
		if (r.change !== null || top.spot !== null || top.keys !== null || top.kids !== null) return
		const ids = roots.get(r.source)!
		ids.delete(r.id)
		if (ids.size === 0) roots.delete(r.source)
		counts.keys--
		counts.steps--
	}

	// what is kept: keys with a spot, spots, and trie steps (a kept key's [] and every other
	// prefix of a kept spot's path)
	const kept = () => ({ ...counts })

	return { spot, change, mark, event, release, kept }
}
