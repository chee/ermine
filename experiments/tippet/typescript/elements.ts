// The elements of an entry's strings and arrays (WIRE.md, ids), held as runs: elements one after
// another of one device, numbered one on (or, back, one down), the lamports of the steps that made
// them going on evenly, all gone or none, each element after the one before it in the run (or, back,
// before the one after it). A sequence gets its elements at the first splice that touches it.
import apply, { type Patch, type Target } from "@ermine/changeable/apply"
import { type Anchor, type At, type Id, inserts, readIds, type Step } from "./step.ts"

// a step's place: lamport, device, n
export type Ref = [lamport: number, device: string, n: number]
// elements in order: made, numbered c on (back: c down), lamports l on (back: down) by d each; born
// (there since the list's step), places c on. left: what the first goes after (back: each), right:
// what each goes before (back: the last); null the start, the end
type Run = {
	device: string
	c: number
	len: number
	gone: boolean
	born: boolean
	back: boolean
	l: number
	d: number
	left: Id | null
	right: Id | null
}
// a place in a list: a run and a place in it
type Pos = [j: number, o: number]
// a sequence's runs, the step its born ones are since, how many are not gone, a cursor (live: how
// many before runs[j] are not gone)
type List = { runs: Run[]; by: Ref; count: number; j: number; live: number }
// an entry's value and its sequences' elements, by path; born: by path, the step that made what is
// there new (a sequence under it is that step's until a splice touches it)
export type State = { value: unknown; lists: Map<string, List>; born: Map<string, Ref> }

export const fresh = (): State => ({ value: undefined, lists: new Map(), born: new Map() })
// sort keys: lamport, device, number (a born one's -1)
type Key = [lamport: number, device: string, c: number]
const after = (a: Key, b: Key) =>
	a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))
const keyOf = (path: readonly unknown[]) => JSON.stringify(path)
// key's path is prefix's, or under it
const under = (key: string, prefix: string) =>
	prefix === "[]" || key === prefix || key.startsWith(prefix.slice(0, -1) + ",")
const isSeq = (v: unknown) => typeof v === "string" || Array.isArray(v)
// a sequence's length: counted once, when its elements are made, and for what a splice inserts
const units = (v: unknown) =>
	typeof v === "string" ? [...v].length : Array.isArray(v) ? v.length : -1
function at(value: unknown, path: readonly unknown[]): unknown {
	let v = value
	for (const k of path) {
		if (v === null || typeof v !== "object") return undefined
		v = (v as Record<string, unknown>)[k as string]
	}
	return v
}

const idAt = (l: List, r: Run, o: number): Id =>
	r.born
		? { device: r.device, c: l.by[2], k: r.c + o }
		: { device: r.device, c: r.back ? r.c - o : r.c + o }
// the lowest id of r's [o, o + n)
const low = (l: List, r: Run, o: number, n: number) => idAt(l, r, r.back ? o + n - 1 : o)
const leftOf = (l: List, r: Run, o: number) => !r.back && o > 0 ? idAt(l, r, o - 1) : r.left
const rightOf = (l: List, r: Run, o: number) =>
	r.back && o < r.len - 1 ? idAt(l, r, o + 1) : r.right
const plus = (i: Id, n: number): Id =>
	i.k === undefined ? { ...i, c: i.c + n } : { ...i, k: i.k + n }
const sortOf = (l: List, r: Run, o: number): Key =>
	r.born
		? [l.by[0], l.by[1], -1]
		: r.back
		? [r.l - r.d * o, r.device, r.c - o]
		: [r.l + r.d * o, r.device, r.c + o]
// where id is in r, or -1
function place(l: List, r: Run, id: Id) {
	if (r.device !== id.device || r.born !== (id.k !== undefined)) return -1
	const x = id.k === undefined ? id.c : id.c === l.by[2] ? id.k : -1
	const o = r.back ? r.c - x : x - r.c
	return o >= 0 && o < r.len ? o : -1
}
// an element's run and place in it: near the cursor first
function find(l: List, id: Id): [number, number] | undefined {
	for (let d = 0; d < 4; d++) {
		for (const j of [l.j - 1 - d, l.j + d]) {
			const o = j >= 0 && j < l.runs.length ? place(l, l.runs[j], id) : -1
			if (o >= 0) return [j, o]
		}
	}
	for (let j = 0; j < l.runs.length; j++) {
		const o = place(l, l.runs[j], id)
		if (o >= 0) return [j, o]
	}
}

// how many before runs[j] are not gone, the cursor moved there
function liveBefore(l: List, j: number) {
	while (l.j < j) l.live += l.runs[l.j].gone ? 0 : l.runs[l.j].len, l.j++
	while (l.j > j) l.j--, l.live -= l.runs[l.j].gone ? 0 : l.runs[l.j].len
	return l.live
}
// the a-th element not gone, its run and place (past the last: [runs.length, 0]), the cursor there
function liveAt(l: List, a: number): [number, number] {
	while (l.j > 0 && l.live > a) l.j--, l.live -= l.runs[l.j].gone ? 0 : l.runs[l.j].len
	for (; l.j < l.runs.length; l.j++) {
		const r = l.runs[l.j]
		if (!r.gone && l.live + r.len > a) return [l.j, a - l.live]
		if (!r.gone) l.live += r.len
	}
	return [l.j, 0]
}
// runs[j, j + del) for ins, the cursor at j
function edit(l: List, j: number, del: number, ...ins: Run[]) {
	liveBefore(l, j)
	l.runs.splice(j, del, ...ins)
}
const is = (a: Id | null, b: Id | null) => a === b || (!!a && !!b && same(a, b))
// runs[j - 1] and runs[j] as one, if they go on from each other: numbers one on (or one down), each
// after (or before) the one before, lamports evenly
function join(l: List, j: number) {
	const a = l.runs[j - 1], b = l.runs[j]
	if (!a || !b || a.device !== b.device || a.born !== b.born || a.gone !== b.gone) return
	const on = (a.len === 1 || !a.back) && (b.len === 1 || !b.back) && a.c + a.len === b.c &&
		is(b.left, idAt(l, a, a.len - 1)) && is(a.right, b.right)
	const down = !on && !a.born && (a.len === 1 || a.back) && (b.len === 1 || b.back) &&
		a.c - a.len === b.c && is(a.right, idAt(l, b, 0)) && is(a.left, b.left)
	if (!on && !down) return
	const step = on ? b.l - a.l : a.l - b.l
	const d = a.len > 1 ? a.d : b.len > 1 ? b.d : step
	if (d >= 0 && step === d * a.len && (b.len === 1 || b.d === d)) {
		edit(l, j - 1, 2, { ...a, len: a.len + b.len, d, back: down, right: on ? a.right : b.right })
	}
}
// run r's elements [o, o + n)
function part(l: List, r: Run, o: number, n: number): Run {
	if (r.back) {
		const right = o + n < r.len ? idAt(l, r, o + n) : r.right
		return { ...r, c: r.c - o, l: r.l - r.d * o, len: n, right }
	}
	return { ...r, c: r.c + o, l: r.l + r.d * o, len: n, left: o ? idAt(l, r, o - 1) : r.left }
}
// run j's elements [o, o + n) a run of their own: its index
function cut(l: List, j: number, o: number, n: number) {
	const r = l.runs[j], parts = [part(l, r, o, n)]
	if (o > 0) parts.unshift(part(l, r, 0, o))
	if (o + n < r.len) parts.push(part(l, r, o + n, r.len - o - n))
	edit(l, j, 1, ...parts)
	return j + (o > 0 ? 1 : 0)
}
function mark(l: List, j: number, o: number, n: number, gone: boolean) {
	const i = cut(l, j, o, n)
	edit(l, i, 1, { ...l.runs[i], gone })
	l.count += gone ? -n : n
	join(l, i + 1), join(l, i)
}
// how many of the ids from run j's place o on are there, one on, and the first place of them
function span(l: List, j: number, o: number, n: number): [o: number, m: number] {
	const r = l.runs[j], m = Math.min(r.back ? o + 1 : r.len - o, n)
	return [r.back ? o - m + 1 : o, m]
}
// each run of the n elements from id on, in turn: f(run, first place, how many there)
function each(l: List, id: Id, n: number, f: (j: number, o: number, m: number) => void) {
	for (let x = 0; x < n;) {
		const [j, o] = find(l, plus(id, x))!, [p, m] = span(l, j, o, n - x)
		f(j, p, m), x += m
	}
}
const same = (a: Id, b: Id) => a.device === b.device && a.c === b.c && a.k === b.k
const cleared = (p: Patch, from: number, to: number): Patch => ({ path: p.path, range: [from, to] })
const there = (l: List, id: Id, n: number) => {
	for (let x = 0; x < n;) {
		const f = find(l, plus(id, x))
		if (!f) return false
		x += span(l, f[0], f[1], n - x)[1]
	}
	return true
}

// a step's patches applied to state in order, all or none: ids (when the step has them) made
// positions. o.undo gets what undoes the value, o.back what undoes the elements (run newest
// first). o.name: a write here, its splices named from the elements (their ids returned). o.keep:
// false for a patch left out (its elements still counted). the patches as applied, by position,
// returned for the graph
export function step(
	state: State,
	s: Pick<Step, "device" | "n" | "lamport" | "patches" | "ids"> & At,
	o: { undo?: Patch[]; back?: (() => void)[]; name?: boolean; keep?: readonly boolean[] } = {},
): { applied: Patch[]; ids: (Anchor | null)[] } {
	const { undo = [], back = [], name = false, keep } = o
	const ref: Ref = [s.lamport, s.device, s.n]
	const applied: Patch[] = [], ids: (Anchor | null)[] = []
	const mine: Patch[][] = [], marks = back.length
	const was = state.value
	const named = name || !s.ids ? undefined : readIds(s, s.ids)
	let made = 0
	try {
		for (let i = 0; i < s.patches.length; i++) {
			const p = s.patches[i], c = s.seq + made
			made += inserts(p)
			if (keep && !keep[i]) {
				ids.push(null)
				continue
			}
			const anchor = named?.[i] ?? null
			const listed = inArray(state.value, p)
			const out = p.move
				? (renew(state, ref, end(state.value, p), back),
					renew(state, ref, end(state.value, p.move), back),
					{ patches: [p], anchor: null })
				: p.range && isSeq(at(state.value, p.path))
				? splice(state, ref, c, p, anchor, back, name)
				: listed && p.value === undefined
				? { ...splice(state, ref, c, listed, null, back, false), anchor: null }
				: (renew(state, ref, p.path, back), { patches: [p], anchor: null })
			ids.push(out.anchor)
			for (const q of out.patches) {
				const u: Patch[] = []
				state.value = apply(state.value, [q], { undo: u })
				mine.push(u), applied.push(q)
			}
		}
	} catch (e) {
		state.value = was
		for (const f of back.splice(marks).reverse()) f()
		throw e
	}
	for (const u of mine.reverse()) undo.push(...u)
	return { applied, ids }
}

// a patch at an index of an array (no range): as a splice of that one, into the array
function inArray(value: unknown, p: Target): Patch | undefined {
	const k = p.path.at(-1)
	if (p.range || typeof k !== "number" || !Array.isArray(at(value, p.path.slice(0, -1)))) return
	return { path: p.path.slice(0, -1), range: [k, k + 1] }
}
// what a move makes new at one end: the sequence a range is in, or the array an index is in, or
// what is at the path
const end = (value: unknown, t: Target) => inArray(value, t)?.path ?? t.path

// the sequences at path and under it made new by this step (a put, a removal, a move there); self
// false: under it only (a splice into an array: a position under it now names another element)
function renew(
	state: State,
	ref: Ref,
	path: readonly unknown[],
	back: (() => void)[],
	self = true,
) {
	const prefix = keyOf(path)
	const lists = [...state.lists].filter(([k]) => under(k, prefix) && (self || k !== prefix))
	const born = [...state.born].filter(([k]) => under(k, prefix))
	for (const [k] of lists) state.lists.delete(k)
	for (const [k] of born) state.born.delete(k)
	state.born.set(prefix, ref)
	back.push(() => {
		state.born.delete(prefix)
		for (const [k, v] of born) state.born.set(k, v)
		for (const [k, v] of lists) state.lists.set(k, v)
	})
}

// the elements of the sequence at path, made at the first splice: there since the step that made
// it new
function elements(state: State, path: readonly unknown[], back: (() => void)[]): List {
	const key = keyOf(path)
	const had = state.lists.get(key)
	if (had) return had
	let by: Ref | undefined
	for (let n = path.length; n >= 0 && !by; n--) by = state.born.get(keyOf(path.slice(0, n)))
	by ??= [0, "", 0]
	const count = units(at(state.value, path))
	const runs = count
		? [{
			device: by[1],
			c: 0,
			len: count,
			gone: false,
			born: true,
			back: false,
			l: 0,
			d: 0,
			left: null,
			right: null,
		}]
		: []
	const l: List = { runs, by, count, j: 0, live: 0 }
	state.lists.set(key, l)
	back.push(() => state.lists.delete(key))
	return l
}

// a splice, its inserted ones numbered from c: by ids (anchor) or by its range; name: its ids found
// from its range
function splice(
	state: State,
	ref: Ref,
	c: number,
	p: Patch,
	anchor: Anchor | null,
	back: (() => void)[],
	name: boolean,
): { patches: Patch[]; anchor: Anchor | null } {
	// an insert of another kind than the sequence (a list into a text): doesn't apply, as apply refuses
	const kind = (v: unknown) => typeof v === "string" ? "text" : Array.isArray(v) ? "list" : "other"
	if (p.value !== undefined && kind(p.value) !== kind(at(state.value, p.path))) {
		throw new RangeError("wrong-kind")
	}
	const l = elements(state, p.path, back)
	const [a, b] = p.range!
	const value = p.value, m = value === undefined ? 0 : units(value)
	// what it names: the element it goes after, and those it takes away, as runs
	let first: Id | null, right: Id | null = null
	let gone: readonly (readonly [Id, number])[]
	if (anchor) {
		first = anchor.after, gone = anchor.gone
		const b = anchor.before, f = first ? find(l, first) : undefined
		right = b === undefined ? null : b !== true ? b : f ? rightOf(l, l.runs[f[0]], f[1]) : null
		const rp = right ? find(l, right) : undefined
		if (
			(first && !f) || !gone.every(([i, n]) => there(l, i, n)) || (b === true && !f) ||
			(right && !rp) || (f && rp && !ahead(f, rp))
		) throw new RangeError("an element named is not there")
	} else {
		if (a > b || b > l.count) throw new RangeError("range")
		const [j, o] = a ? liveAt(l, a - 1) : [0, 0]
		first = a ? idAt(l, l.runs[j], o) : null
		const runs: [Id, number][] = []
		for (let x = a; x < b;) {
			const [j, o] = liveAt(l, x), r = l.runs[j], n = Math.min(r.len - o, b - x)
			const i = low(l, r, o, n), last = runs.at(-1)
			if (last && same(plus(last[0], last[1]), i)) last[1] += n
			else runs.push([i, n])
			x += n
		}
		gone = runs
	}
	// the gone ones still there taken away, each once however often named, by position
	const patches: Patch[] = [], taken: [Id, number][] = []
	for (const [id, n] of gone) {
		each(l, id, n, (j, o, m) => {
			const r = l.runs[j]
			if (r.gone) return
			const from = liveBefore(l, j) + o, last = patches.at(-1)?.range
			taken.push([low(l, r, o, m), m])
			mark(l, j, o, m, true)
			if (last && last[0] === from) patches[patches.length - 1] = cleared(p, from, last[1] + m)
			else if (last && from + m === last[0]) {
				patches[patches.length - 1] = cleared(p, from, last[1])
			} else patches.push(cleared(p, from, from + m))
		})
	}
	// where the inserted go: right after its element; by ids, past those put there meanwhile
	const lp = first ? find(l, first)! : null
	let spot: Pos = lp ? next(l, lp) : [0, 0], before: Anchor["before"]
	if (anchor) {
		const rp = right ? find(l, right)! : null
		spot = scan(l, spot, first, right, rp, [ref[0], ref[1], c])
	} else if (name && m > 0 && spot[0] < l.runs.length) {
		right = idAt(l, l.runs[spot[0]], spot[1])
		before = lp && is(rightOf(l, l.runs[lp[0]], lp[1]), right) ? true : right
	}
	let [j, o] = spot
	const to = liveBefore(l, j) + (l.runs[j] && !l.runs[j].gone ? o : 0)
	if (m > 0) {
		if (o > 0) j = cut(l, j, o, l.runs[j].len - o)
		edit(l, j, 0, {
			device: ref[1],
			c,
			len: m,
			gone: false,
			born: false,
			back: false,
			l: ref[0],
			d: 0,
			left: first,
			right,
		})
		l.count += m
		join(l, j + 1), join(l, j)
		patches.push({ path: p.path, range: [to, to], value })
	}
	if (!patches.length) patches.push(cleared(p, to, to))
	back.push(() => {
		if (m > 0) {
			each(l, { device: ref[1], c }, m, (j, o, n) => {
				const i = cut(l, j, o, n)
				edit(l, i, 1)
				l.count -= n
				join(l, i)
			})
		}
		for (const [id, n] of taken.reverse()) each(l, id, n, (j, o, m) => mark(l, j, o, m, false))
	})
	if (Array.isArray(at(state.value, p.path))) renew(state, ref, p.path, back, false)
	return { patches, anchor: name ? anchorOf(first, gone, before) : anchor }
}

const ahead = (a: Pos, b: Pos) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
const next = (l: List, [j, o]: Pos): Pos => o + 1 < l.runs[j].len ? [j, o + 1] : [j + 1, 0]
// the elements from a scan's start on, by id: their places. ends: a piece's first and last (where
// an element's left and right mostly are); ranges, per device (and step, for born ones), the rest:
// numbers [lo, hi] from run j's place o, sorted when looked in
type Range = [lo: number, hi: number, j: number, o: number, back: boolean]
type Seen = { ends: Map<string, Pos>; ranges: Map<string, Range[] & { sorted?: boolean }> }
const seenKey = (i: Id) => i.k === undefined ? i.device : `${i.device} ${i.c}`
const idKey = (i: Id) => `${seenKey(i)} ${i.k ?? i.c}`
function see(l: List, seen: Seen, j: number, o: number, n: number) {
	const r = l.runs[j], i = low(l, r, o, n), lo = i.k ?? i.c, key = seenKey(i)
	seen.ends.set(idKey(idAt(l, r, o)), [j, o])
	seen.ends.set(idKey(idAt(l, r, o + n - 1)), [j, o + n - 1])
	if (n < 3) return
	let xs = seen.ranges.get(key)
	if (!xs) seen.ranges.set(key, xs = [])
	if (xs.length && xs[xs.length - 1][0] > lo) xs.sorted = false
	xs.push([lo, lo + n - 1, j, o, r.back])
}
function seenAt(seen: Seen, i: Id): Pos | undefined {
	const end = seen.ends.get(idKey(i))
	if (end) return end
	const xs = seen.ranges.get(seenKey(i)), x = i.k ?? i.c
	if (!xs) return
	if (xs.sorted === false) xs.sort((a, b) => a[0] - b[0]), xs.sorted = true
	let a = 0, b = xs.length
	while (a < b) {
		const m = (a + b) >> 1
		if (xs[m][1] < x) a = m + 1
		else b = m
	}
	const e = xs[a]
	if (e && e[0] <= x) return [e[2], e[3] + (e[4] ? e[1] - x : x - e[0])]
}
// where an insert by ids goes, from i (right after its left, at lp) to its right (at rp): past those
// inserted there meanwhile, as FugueMax (Gentle's YjsMod): by each one's own left and right, then
// by sort key, greater first. those between are looked up by id as far as the scan has looked, so it
// costs what lies between, at most
function scan(
	l: List,
	i: Pos,
	left: Id | null,
	right: Id | null,
	rp: Pos | null,
	mine: Key,
): Pos {
	const seen: Seen = { ends: new Map(), ranges: new Map() }
	const at = (p: Pos, q: Pos | null) => !!q && p[0] === q[0] && p[1] === q[1]
	// a run's elements from p on, to the right at most: how many
	const upto = (p: Pos) => (rp && rp[0] === p[0] ? rp[1] : l.runs[p[0]].len) - p[1]
	// looked up so far: from i to far
	let far = i
	const more = () => {
		if (far[0] >= l.runs.length || at(far, rp)) return false
		const n = upto(far)
		see(l, seen, far[0], far[1], n)
		far = far[1] + n < l.runs[far[0]].len ? [far[0], far[1] + n] : [far[0] + 1, 0]
		return true
	}
	// where id is from i to the right, or undefined
	const look = (id: Id) => {
		let p = seenAt(seen, id)
		while (!p && more()) p = seenAt(seen, id)
		return p
	}
	let spot = i, scanning = false
	for (;;) {
		if (!scanning) spot = i
		if (i[0] >= l.runs.length || at(i, rp)) return spot
		while (ahead(far, i) || at(far, i)) more()
		const r = l.runs[i[0]], o = i[1], ol = leftOf(l, r, o)
		// its left against ours: before (-1), the same (0), passed (1)
		const p = ol && left && !same(ol, left) ? seenAt(seen, ol) : undefined
		const x = !ol ? left ? -1 : 0 : !left ? 1 : same(ol, left) ? 0 : p && ahead(p, i) ? 1 : -1
		if (x < 0) return spot
		let y = 1
		if (x === 0) {
			// its right against ours: before (-1), the same (0), after (1)
			const or = rightOf(l, r, o)
			y = !or ? right ? 1 : 0 : !right ? -1 : same(or, right) ? 0 : look(or) ? -1 : 1
			if (y === 0 && !after(sortOf(l, r, o), mine)) return spot
			scanning = y < 0
		}
		// what is passed at once: a run's later elements, each after the one before (forward), or
		// all after ours (back, once one is) and each before the next, nearer than ours
		const n = !r.back || x > 0 ? upto(i) : y < 0 ? Math.max(1, upto(i) - 1) : 1
		i = o + n < r.len ? [i[0], o + n] : [i[0] + 1, 0]
	}
}

// a splice's ids; null: one of them made by no step (no put made its sequence), so it goes by its
// range
function anchorOf(
	first: Id | null,
	gone: readonly (readonly [Id, number])[],
	before: Anchor["before"],
): Anchor | null {
	const named = [first, ...gone.map((g) => g[0]), before === true ? null : before]
	if (named.some((i) => i?.device === "")) return null
	const a: Anchor = { after: first, gone: gone.map(([i, n]) => [i, n] as [Id, number]) }
	if (before !== undefined) a.before = before
	return a
}
