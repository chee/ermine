// a patch, and the content before it, into fine-grained notifies on reads of that content
// patches are GRAPH.tex's; the caller applies them, then says so with patched(patch, facts):
// the few things about the content before it that notify reads, never the content
// only listened places are walked: reads sit in a trie of their paths
// no patch walks the content: a long string or list costs what the patch touches
import { count, slice as cut } from "../../opstreams/ts/walk.ts"

export type Key = string | number
export type Span = readonly [number, number]
// keys, then maybe a span: ["items", [3, 5]]
export type Path = readonly (Key | Span)[]
export type Place = { path: readonly Key[]; range?: Span }
export type Patch = Place & { value?: unknown; move?: Place }
// one place in the content before a patch: is it a list, how long (code points for a string),
// and was the key there
export type Fact = { list: boolean; length: number; had: boolean }
export type Facts = {
	// the patch's place, as it is when the patch lands (a move's: with what left gone).
	// ranged: the sequence at its path; else its parent, had: its last key there.
	// at [], unranged: had: the object there
	place: Fact
	// a move: where it came from, as place is
	from?: Fact
	// a ranged move: how many places what moved fills where it lands
	size?: number
}
export type Kind = "value" | "keys" | "length" | "moved" | "gone"
export type Edge = "in" | "out"
export type Options = {
	// also hear patches under the path
	deep?: boolean
	// hold the thing, not the position
	chase?: boolean
	// a chased span: an insert exactly at its start, at its end, comes in or stays out
	edges?: readonly [Edge, Edge]
	// a chased span: all of it removed
	empty?: "keep" | "gone"
}

export type Read = {
	readonly value: unknown
	readonly path: Path
	on(f: (kind: Kind) => void): () => void
	stop(): void
}

type R = {
	keys: Key[]
	span: [number, number] | null
	deep: boolean
	chase: boolean
	edges: readonly [Edge, Edge]
	empty: "keep" | "gone"
	// where it sits in the trie; null: not in it
	at: T | null
	handlers: Set<(kind: Kind) => void>
	live: boolean
	// this patch's, kept on the read so a patch reaching 10k reads makes no map of them:
	// tick: the patch it last heard; heard: what it heard then; held: the step that carried it
	tick: number
	heard: Kind[]
	held: number
	// in a move, where it was: its whole path, or one key of it (d, k) when only shifted
	was: Key[] | null
	wasD: number
	wasK: Key
	wasSpan: [number, number] | null
	marked: number
}

// reads: whose path ends here; spans: whose path ends in a span of the sequence here
// nums: the numeric keys of kids, in order, so a patch finds the first it reaches
type T = {
	up: T | null
	key: Key | null
	kids: Map<Key, T>
	nums: number[]
	reads: Set<R>
	spans: Set<R>
}

// a chased read carried by a move: where it is inside what moved
type Carried = { r: R; rel: (Key | Span)[]; single: boolean }

// what a step sees at a path: the value, and for a move's second step, what the first took out
type Seen = { v: unknown; less: number; lost?: Key }
type Look = (path: readonly Key[]) => Seen

const isList = Array.isArray

// strings count code points (utf16: UTF-16 units): walk.ts
function len(v: unknown, utf16 = false): number {
	if (typeof v === "string") return count(v, utf16)
	if (isList(v)) return v.length
	if (ArrayBuffer.isView(v)) return (v as unknown as { length: number }).length
	return 0
}
// a string's positions [a, b), walking no further than b
function slice(v: unknown, a: number, b: number, utf16 = false): unknown {
	if (typeof v === "string") return cut(v, a, b, utf16)
	if (isList(v)) return v.slice(a, b)
	if (ArrayBuffer.isView(v)) {
		return (v as unknown as { slice(a: number, b: number): unknown }).slice(a, b)
	}
	return undefined
}
function at(v: unknown, keys: readonly Key[]): unknown {
	for (const k of keys) {
		if (v === null || typeof v !== "object") return undefined
		v = (v as Record<Key, unknown>)[k]
	}
	return v
}
function has(v: unknown, k: Key): boolean {
	return v !== null && typeof v === "object" && Object.hasOwn(v, k)
}
function same(a: readonly Key[], b: readonly Key[]): boolean {
	return a.length === b.length && a.every((k, i) => k === b[i])
}
function under(p: readonly Key[], of: readonly Key[]): boolean {
	return p.length <= of.length && p.every((k, i) => k === of[i])
}
// the first position in a sorted list holding k or more
function lower(xs: number[], k: number): number {
	let lo = 0, hi = xs.length
	while (lo < hi) {
		const m = (lo + hi) >> 1
		if (xs[m] < k) lo = m + 1
		else hi = m
	}
	return lo
}

// the content before, as a move's second step sees it: what the first took out is not there
// built from before without copying it
function after(before: unknown, from: Place): Look {
	const seq = from.range ? from.path : from.path.slice(0, -1)
	const listy = from.range !== undefined || isList(at(before, seq))
	const f = from.range ? from.range[0] : from.path[from.path.length - 1] as number
	const r = from.range ? from.range[1] - from.range[0] : 1
	return (path) => {
		if (listy && path.length > seq.length && under(seq, path)) {
			const k = path[seq.length] as number
			if (k >= f) path = path.with(seq.length, k + r)
		}
		const v = at(before, path)
		if (!same(path, seq)) return { v, less: 0 }
		return listy ? { v, less: r } : { v, less: 0, lost: from.path[from.path.length - 1] }
	}
}

// a place's fact, as look sees the content
function fact(look: Look, p: Place, utf16: boolean): Fact {
	if (p.range) {
		const { v, less } = look(p.path)
		return { list: isList(v), length: len(v, utf16) - less, had: v !== undefined }
	}
	if (!p.path.length) return { list: false, length: 0, had: look([]).v !== undefined }
	const { v, less, lost } = look(p.path.slice(0, -1))
	const k = p.path[p.path.length - 1], length = len(v, utf16) - less
	// a list's: the index is in it
	if (isList(v)) return { list: true, length, had: typeof k === "number" && k < length }
	return { list: false, length, had: has(v, k) && k !== lost }
}

// string positions and lengths count code points; utf16: UTF-16 units, as JavaScript's own
// (an experiment, as mutate's utf16)
export type Count = { utf16?: boolean }

// the facts patched takes, from the whole content before the patch: for a caller that has it
export function facts(patch: Patch, before: unknown, count: Count = {}): Facts {
	const utf16 = count.utf16 ?? false
	const now: Look = (path) => ({ v: at(before, path), less: 0 })
	if (!patch.move) return { place: fact(now, patch, utf16) }
	const from = patch.move
	const place = fact(after(before, from), patch, utf16)
	if (!patch.range) return { place, from: fact(now, from, utf16) }
	const size = from.range
		? from.range[1] - from.range[0]
		: place.list
		? 1
		: len(at(before, from.path), utf16)
	return { place, from: fact(now, from, utf16), size }
}

// a point through [f, f + r) becoming n: ProseMirror's map with assoc
function map(p: number, f: number, r: number, n: number, side: -1 | 1): number {
	if (p < f) return p
	if (p > f + r) return p + n - r
	if (r > 0 && p === f) return f
	if (r > 0 && p === f + r) return f + n
	return side < 0 ? f : f + n
}
function inside(s: [number, number] | null, k: Key): boolean {
	return s !== null && typeof k === "number" && k >= s[0] && k < s[1]
}

export function createNotify(get: () => unknown, count: Count = {}) {
	const utf16 = count.utf16 ?? false
	const node = (up: T | null, key: Key | null): T => ({
		up,
		key,
		kids: new Map(),
		nums: [],
		reads: new Set(),
		spans: new Set(),
	})
	const root = node(null, null)

	function adopt(t: T, k: Key, kid: T) {
		t.kids.set(k, kid)
		kid.up = t
		kid.key = k
		if (typeof k === "number") t.nums.splice(lower(t.nums, k), 0, k)
	}
	function disown(t: T, k: Key) {
		t.kids.delete(k)
		if (typeof k !== "number") return
		const i = lower(t.nums, k)
		if (t.nums[i] === k) t.nums.splice(i, 1)
	}
	function place(keys: readonly Key[], from = root): T {
		let t = from
		for (const k of keys) {
			let kid = t.kids.get(k)
			if (!kid) adopt(t, k, kid = node(t, k))
			t = kid
		}
		return t
	}
	const empty = (t: T) => t.kids.size === 0 && t.reads.size === 0 && t.spans.size === 0
	function prune(t: T | null) {
		while (t && t.up && empty(t)) {
			disown(t.up, t.key!)
			t = t.up
		}
	}
	// the empty nodes under t, gone; true when t is empty too
	function clean(t: T): boolean {
		for (const [k, kid] of t.kids) if (clean(kid)) disown(t, k)
		return empty(t)
	}
	// all of src into dst
	function merge(src: T, dst: T) {
		for (const r of src.reads) (dst.reads.add(r), r.at = dst)
		for (const r of src.spans) (dst.spans.add(r), r.at = dst)
		for (const [k, kid] of src.kids) {
			const there = dst.kids.get(k)
			if (there) merge(kid, there)
			else adopt(dst, k, kid)
		}
	}
	function attach(r: R) {
		const t = place(r.keys)
		;(r.span ? t.spans : t.reads).add(r)
		r.at = t
	}
	// once only: a second prune could take a newer node at the same key
	function detach(r: R) {
		const t = r.at
		if (t === null) return
		;(r.span ? t.spans : t.reads).delete(r)
		r.at = null
		prune(t)
	}
	// root and each listened node along the path, as far as they go
	function line(path: readonly Key[]): T[] {
		const ts = [root]
		for (const k of path) {
			const next = ts[ts.length - 1].kids.get(k)
			if (!next) break
			ts.push(next)
		}
		return ts
	}
	function each(t: T, f: (r: R) => void) {
		for (const r of t.reads) f(r)
		for (const r of t.spans) f(r)
		for (const kid of t.kids.values()) each(kid, f)
	}

	// one patched(): what fires, and where chased reads go, kept until the walk is done
	let tick = 0
	// a move has two steps; a read carried in one is not heard again in it
	let step = 0
	let fired: R[] = []
	// chased spans whose ends moved: the node stays, the span changes
	let spans: [R, [number, number]][] = []
	// a sequence's kids from a position on, moved by delta; go: the keys with chased reads,
	// in order, and whether reads by position stay there too
	type Shift = { t: T; d: number; from: number; delta: number; go: [number, boolean][] }
	let shifts: Shift[] = []
	let carried: Carried[] = []
	// a move inside one sequence: its length stays
	let still = false
	// in a move: back where it was, it did not move
	let moving = false
	const held = (r: R) => r.held === step
	function shifted(r: R, d: number) {
		if (!moving) return
		if (r.marked !== tick) {
			r.marked = tick
			r.was = null
			r.wasD = d
			r.wasK = r.keys[d]
			r.wasSpan = r.span
		} else if (r.was === null && r.wasD !== d) r.was = r.keys.with(r.wasD, r.wasK)
	}
	function mark(r: R) {
		if (!moving) return
		if (r.marked !== tick) {
			r.marked = tick
			r.was = r.keys.slice()
			r.wasSpan = r.span
		} else if (r.was === null) r.was = r.keys.with(r.wasD, r.wasK)
	}
	function back(r: R): boolean {
		if (r.marked !== tick) return false
		const a = r.wasSpan, b = r.span
		if (a === null ? b !== null : b === null || a[0] !== b[0] || a[1] !== b[1]) return false
		return r.was === null ? r.keys[r.wasD] === r.wasK : same(r.was, r.keys)
	}
	function hit(r: R, kind: Kind) {
		if (held(r)) return
		if (r.tick !== tick) {
			r.tick = tick
			r.heard = [kind]
			fired.push(r)
		} else if (!r.heard.includes(kind)) r.heard.push(kind)
	}
	// what it hears is only this
	function only(r: R, kind: Kind) {
		if (r.tick !== tick) {
			r.tick = tick
			fired.push(r)
		}
		r.heard = [kind]
	}
	function gone(r: R) {
		hit(r, "gone")
		r.live = false
	}
	function carry(r: R, rel: (Key | Span)[], single: boolean) {
		if (held(r)) return
		carried.push({ r, rel, single })
		r.held = step
	}
	// deep reads above the path, and deep spans above holding the next key
	function above(ts: T[], path: readonly Key[]) {
		for (let i = 0; i < ts.length && i < path.length; i++) {
			for (const r of ts[i].reads) if (r.deep) hit(r, "value")
			for (const r of ts[i].spans) if (r.deep && inside(r.span, path[i])) hit(r, "value")
		}
	}

	// the content at the path is new; a key came or went when keyed
	function put(path: readonly Key[], keyed: boolean) {
		const ts = line(path)
		const d = path.length
		above(ts, path)
		if (d > 0 && ts.length >= d) {
			const parent = ts[d - 1]
			for (const r of parent.spans) if (inside(r.span, path[d - 1])) hit(r, "value")
			if (keyed) { for (const r of parent.reads) hit(r, "keys") }
		}
		if (ts.length > d) each(ts[d], (r) => hit(r, "value"))
	}

	// a map's key removed: chased reads under it are gone, or carried by a move
	function unkey(path: readonly Key[], moved: boolean) {
		const ts = line(path)
		const d = path.length
		above(ts, path)
		if (ts.length >= d) { for (const r of ts[d - 1].reads) hit(r, "keys") }
		if (ts.length > d) {
			each(ts[d], (r) => {
				if (!r.chase) hit(r, "value")
				else if (moved) carry(r, rest(r, d), true)
				else gone(r)
			})
		}
	}
	function rest(r: R, from: number): (Key | Span)[] {
		const out: (Key | Span)[] = r.keys.slice(from)
		if (r.span) out.push(r.span)
		return out
	}

	// the sequence at the path: [f, f + r) becomes n long; atomic: no path goes into it
	// more(k): it had more than k elements; moved: what left is carried; single: one element left
	function splice(
		path: readonly Key[],
		more: (k: number) => boolean,
		f: number,
		r: number,
		n: number,
		atomic: boolean,
		moved: boolean,
		single: boolean,
	) {
		const ts = line(path)
		const d = path.length
		above(ts, path)
		if (ts.length <= d) return
		const t = ts[d]
		const even = r === n
		// by position: what is touched; past the longer of the two lengths nothing was or is
		const reaches = (k: number) => even ? k < f + r : more(k) || more(k - n + r)
		for (const rd of t.reads) {
			if (atomic || rd.deep) hit(rd, "value")
			if (!even && !still) hit(rd, "length")
		}
		const nums = t.nums
		const to = even ? lower(nums, f + r) : nums.length
		const go: [number, boolean][] = []
		for (let i = lower(nums, f); i < to; i++) {
			const k = nums[i]
			const kid = t.kids.get(k)!
			const fires = reaches(k)
			const past = k >= f + r
			let chased = false, plain = false
			each(kid, (rd) => {
				if (!rd.chase || !rd.live) {
					plain = true
					if (!rd.chase && fires) hit(rd, "value")
				} else if (past) {
					chased = true
					hit(rd, "moved")
				} else if (moved) {
					carry(rd, single ? rest(rd, d + 1) : [k - f, ...rest(rd, d + 1)], single)
				} else if (k - f < n) hit(rd, "value")
				else gone(rd)
			})
			if (past && chased) go.push([k, plain])
		}
		if (go.length > 0) shifts.push({ t, d, from: f + r, delta: n - r, go })
		for (const sp of t.spans) {
			const [a, b] = sp.span!
			if (!sp.chase) {
				if (a === b ? a >= f && reaches(a) : f < b && reaches(a)) hit(sp, "value")
				continue
			}
			// all it holds moves: it goes along, as a span over what moved
			if (moved && a >= f && b <= f + r && b > a) {
				carry(sp, [[a - f, b - f]], false)
				continue
			}
			const a2 = map(a, f, r, n, sp.edges[0] === "in" ? -1 : 1)
			let b2 = map(b, f, r, n, sp.edges[1] === "in" ? 1 : -1)
			// a caret with both edges out: it stays with its start
			if (b2 < a2) b2 = a2
			const lost = r > 0 && b > a && a < f + r && f < b
			if (lost || (n > 0 && a2 < f + n && f < b2)) hit(sp, "value")
			if (b > a && a2 === b2 && sp.empty === "gone") {
				gone(sp)
				continue
			}
			if (a2 !== a || b2 !== b) {
				spans.push([sp, [a2, b2]])
				hit(sp, "moved")
			}
		}
	}

	// the kids of t holding chased reads move by delta; reads by position stay where they are
	function shift({ t, d, from, delta, go }: Shift) {
		const nums = t.nums
		const tail = nums.splice(lower(nums, Math.min(from, from + delta)))
		// what stays: the tail but for the kids that wholly go
		const stay: number[] = []
		let g = 0
		for (const k of tail) {
			while (g < go.length && go[g][0] < k) g++
			if (g < go.length && go[g][0] === k && !go[g][1]) continue
			stay.push(k)
		}
		const landed: number[] = []
		const out: [number, T][] = []
		for (const [k, mixed] of go) {
			const x = t.kids.get(k)!
			let mover = x
			if (mixed) {
				// some go, some stay: the chased ones into a node of their own
				mover = node(null, null)
				each(x, (r) => {
					if (!r.chase || !r.live) return
					;(r.span ? r.at!.spans : r.at!.reads).delete(r)
					const y = place(r.keys.slice(d + 1), mover)
					;(r.span ? y.spans : y.reads).add(r)
					r.at = y
				})
				clean(x)
			} else t.kids.delete(k)
			each(mover, (r) => {
				shifted(r, d)
				r.keys[d] = k + delta
			})
			out.push([k + delta, mover])
		}
		for (const [k, x] of out) {
			const there = t.kids.get(k)
			if (there) {
				merge(x, there)
				continue
			}
			t.kids.set(k, x)
			x.up = t
			x.key = k
			landed.push(k)
		}
		// both in order: one pass puts them together
		let a = 0, b = 0
		while (a < stay.length || b < landed.length) {
			if (b === landed.length || (a < stay.length && stay[a] < landed[b])) nums.push(stay[a++])
			else nums.push(landed[b++])
		}
	}

	// one place, removed (value absent) or put, against the content as it is then
	// moved: chased reads in what leaves are carried, not gone
	function act(f: Fact, p: Place, value: { n: number } | null, moved: boolean) {
		const { path, range } = p
		const more = (k: number) => f.length > k
		if (range) {
			splice(
				path,
				more,
				range[0],
				range[1] - range[0],
				value ? value.n : 0,
				!f.list,
				moved,
				false,
			)
			return
		}
		if (path.length === 0) {
			// the whole: put keeps chases; removed, they are gone
			if (value) put(path, false)
			else each(root, (r) => r.chase ? gone(r) : hit(r, "value"))
			return
		}
		const k = path[path.length - 1]
		if (f.list) {
			if (value) put(path, false)
			else splice(path.slice(0, -1), more, k as number, 1, 0, false, moved, true)
			return
		}
		if (value) put(path, !f.had)
		else if (f.had) unkey(path, moved)
	}

	// relink what moved, before the next step walks the trie
	function settle() {
		for (const s of shifts) shift(s)
		shifts = []
		for (const [r, span] of spans) {
			if (!r.live || held(r)) continue
			mark(r)
			r.span = span
		}
		spans = []
	}

	function patched(patch: Patch, facts: Facts) {
		tick++
		step++
		fired = []
		spans = []
		shifts = []
		carried = []
		still = false
		moving = patch.move !== undefined
		if (patch.move) {
			const from = patch.move
			const was = facts.from!
			const seq = (p: Place) => p.range ? p.path : p.path.slice(0, -1)
			still = (from.range !== undefined || was.list) &&
				patch.range !== undefined && same(seq(from), seq(patch))
			act(was, from, null, true)
			settle()
			for (const c of carried) detach(c.r)
			const dest = patch.range ? facts.place.list : false
			const n = patch.range ? facts.size! : 0
			step++
			act(facts.place, patch, { n }, false)
			settle()
			// carried reads land inside what arrived
			for (const c of carried) {
				let rel = c.rel
				// a span over one thing that moved with no range: the thing is a value there, not in a sequence
				if (!patch.range && !from.range && !c.single && rel.length === 1) {
					c.r.live = false
					only(c.r, "gone")
					continue
				}
				if (patch.range) {
					const g = patch.range[0]
					if (c.single) rel = dest ? [0, ...rel] : rel.length ? rel : [[0, n]]
					const head = rel[0]
					rel = [
						typeof head === "number"
							? head + g
							: [(head as Span)[0] + g, (head as Span)[1] + g],
						...rel.slice(1),
					]
				}
				const last = rel[rel.length - 1]
				const span = Array.isArray(last) ? [last[0], last[1]] as [number, number] : null
				mark(c.r)
				c.r.keys = [...patch.path, ...(span ? rel.slice(0, -1) : rel)] as Key[]
				c.r.span = span
				attach(c.r)
				only(c.r, "moved")
			}
		} else {
			const value = "value" in patch ? { n: patch.range ? len(patch.value, utf16) : 0 } : null
			act(facts.place, patch, value, false)
			settle()
		}
		const heard = fired
		fired = []
		for (const r of heard) {
			const kinds = r.heard
			const m = kinds.indexOf("moved")
			if (m !== -1 && back(r)) kinds.splice(m, 1)
			if (!r.live) detach(r)
			// a handler may add or stop others: each kind goes to the ones there when it began
			for (const kind of kinds) {
				for (
					const h of r.handlers.size === 1 ? r.handlers : [...r.handlers]
				) h(kind)
			}
		}
	}

	function read(path: Path, options: Options = {}): Read {
		const last = path[path.length - 1]
		const span = Array.isArray(last) ? [last[0], last[1]] as [number, number] : null
		const r: R = {
			keys: (span ? path.slice(0, -1) : path.slice()) as Key[],
			span,
			deep: options.deep ?? false,
			chase: options.chase ?? false,
			edges: options.edges ?? ["out", "out"],
			empty: options.empty ?? "keep",
			at: null,
			handlers: new Set(),
			live: true,
			tick: 0,
			heard: [],
			held: 0,
			was: null,
			wasD: 0,
			wasK: 0,
			wasSpan: null,
			marked: 0,
		}
		attach(r)
		return {
			get value() {
				const v = at(get(), r.keys)
				return r.span ? slice(v, r.span[0], r.span[1], utf16) : v
			},
			get path() {
				return r.span ? [...r.keys, r.span] : r.keys
			},
			on(f) {
				r.handlers.add(f)
				return () => r.handlers.delete(f)
			},
			stop() {
				if (!r.live) return
				r.live = false
				detach(r)
			},
		}
	}

	return { read, patched }
}
