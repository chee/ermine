// Tracked paths: which readers a patch reaches. A spot is (source, id, path): a read of path in the
// value at that key. Spots are shared, and each key has a trie of path steps, so a patch walks its
// own path and marks what lies under it: O(|path| + marked). This file knows no readers.
import type { Key, Patch } from "@ermine/changeable/apply"

export type { Key, Patch }

// owner: the caller's, never read here. path is held, not copied, and never changed.
export type Spot<O> = {
	source: unknown
	id: unknown
	path: readonly Key[] | null
	keys: boolean
	here: boolean
	owner: O | undefined
	seen: number
	step: Step<O> | null
	root: Root<O>
}

type Step<O> = {
	key: Key | null
	up: Step<O> | null
	kids: Map<Key, Step<O>> | null
	nums: Step<O>[] | null
	spot: Spot<O> | null
	keys: Spot<O> | null
	here: Spot<O> | null
}

type Root<O> = { source: unknown; id: unknown; top: Step<O>; change: Spot<O> | null }

// A place a patch changes. put: something lands there (an unranged put replaces, never shifts).
export type Place = {
	path: readonly Key[]
	range?: readonly [number, number]
	put: boolean
	n: number | null
}

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

// A list removal at S+[k] shifts the kids of S from k on.
const shifts = (q: Place) =>
	!q.range && !q.put && q.path.length > 0 && typeof q.path[q.path.length - 1] === "number"

function hit(q: Place, path: readonly Key[]): boolean {
	const Q = q.path, n = Q.length
	let i = 0
	while (i < n && i < path.length && path[i] === Q[i]) i++
	if (i === path.length) return true
	if (i < n) return i === n - 1 && shifts(q) && typeof path[i] === "number" && path[i] > Q[i]
	if (!q.range) return true
	const k = path[n]
	if (typeof k !== "number") return false
	const [a, b] = q.range
	return q.n === b - a ? k >= a && k < b : k >= a
}

export function keyed(q: Place, path: readonly Key[]): boolean {
	const Q = q.path
	if (Q.length <= path.length) return hit(q, path)
	return Q.length === path.length + 1 && !q.range && path.every((k, i) => Q[i] === k)
}

export function placed(q: Place, path: readonly Key[]): boolean {
	const Q = q.path
	if (Q.length <= path.length) return hit(q, path)
	return typeof Q[path.length] === "number" && path.every((k, i) => Q[i] === k)
}

export function marks(patch: Patch, path: readonly Key[], keys = false, here = false): boolean {
	return places(patch).some((q) => keys ? keyed(q, path) : here ? placed(q, path) : hit(q, path))
}

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
	spot: (
		source: unknown,
		id: unknown,
		path: readonly Key[],
		keys?: boolean,
		here?: boolean,
	) => Spot<O>
	change: (source: unknown, id: unknown) => Spot<O>
	mark: (source: unknown, id: unknown, patches: Iterable<Patch>) => Spot<O>[]
	event: (source: unknown, id: unknown) => Spot<O>[]
	release: (s: Spot<O>) => void
	held: () => { keys: number; spots: number; steps: number }
} {
	type S = Spot<O>
	type T = Step<O>
	type R = Root<O>

	const roots = new Map<unknown, Map<unknown, R>>()
	const counts = { keys: 0, spots: 0, steps: 0 }
	let tick = 0

	const step = (key: Key | null, up: T | null): T => {
		counts.steps++
		return { key, up, kids: null, nums: null, spot: null, keys: null, here: null }
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
	function made(r: R, path: readonly Key[] | null, at: T | null, keys = false, here = false): S {
		counts.spots++
		return {
			source: r.source,
			id: r.id,
			path,
			keys,
			here,
			owner: undefined,
			seen: 0,
			step: at,
			root: r,
		}
	}

	function spot(
		source: unknown,
		id: unknown,
		path: readonly Key[],
		keys = false,
		here = false,
	): S {
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
		if (here) return at.here ??= made(r, path, at, false, true)
		return at.spot ??= made(r, path, at)
	}

	function change(source: unknown, id: unknown): S {
		const r = root(source, id, true)!
		return r.change ??= made(r, null, null)
	}

	let out: S[] = []
	const give = (s: S | null) => {
		if (s === null || s.seen === tick) return
		s.seen = tick
		out.push(s)
	}
	function all(at: T) {
		give(at.spot)
		give(at.keys)
		give(at.here)
		if (at.kids !== null) { for (const kid of at.kids.values()) all(kid) }
	}
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
			if (typeof Q[i] === "number") give(at.here)
			if (i === Q.length - 1 && !q.range) give(at.keys)
			if (i === Q.length - 1 && shifts(q)) span(at, (Q[i] as number) + 1)
			const next = at.kids?.get(Q[i])
			if (next === undefined) return
			at = next
		}
		if (!q.range) return all(at)
		give(at.spot)
		give(at.keys)
		give(at.here)
		const [a, b] = q.range
		span(at, a, q.n === b - a ? b : Infinity)
	}

	// Each patch is in its own coordinates, so a later patch differs from what was read only where
	// already marked.
	function mark(source: unknown, id: unknown, patches: Iterable<Patch>): S[] {
		const r = root(source, id, false)
		if (r === undefined) return []
		tick++
		out = []
		give(r.change)
		for (const p of patches) for (const q of places(p)) place(r, q)
		return out
	}

	function event(source: unknown, id: unknown): S[] {
		return mark(source, id, [{ path: [] }])
	}

	function release(s: S) {
		const r = s.root
		if (s.path === null) {
			if (r.change !== s) return
			r.change = null
		} else {
			let at = s.step!
			if ((s.keys ? at.keys : s.here ? at.here : at.spot) !== s) return
			if (s.keys) at.keys = null
			else if (s.here) at.here = null
			else at.spot = null
			while (
				at.up !== null && at.spot === null && at.keys === null && at.here === null &&
				at.kids === null
			) {
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
		if (
			r.change !== null || top.spot !== null || top.keys !== null || top.here !== null ||
			top.kids !== null
		) return
		const ids = roots.get(r.source)!
		ids.delete(r.id)
		if (ids.size === 0) roots.delete(r.source)
		counts.keys--
		counts.steps--
	}

	const held = () => ({ ...counts })

	return { spot, change, mark, event, release, held }
}
