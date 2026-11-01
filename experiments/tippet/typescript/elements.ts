// The elements of an entry's strings and arrays (WIRE.md, ids), held as runs: elements one after
// another of one device, numbered one on (or, back, one down), all gone or none, each element after
// the one before it in the run (or, back, before the one after it). A sequence gets its elements at the first splice that touches it.
import type { Value } from "@ermine/encoding/cbor"
import apply, { type Key as Index, type Patch, type Target } from "@ermine/changeable/apply"
import { type Anchor, type At, type Id, inserts, type Named, readIds, type Step } from "./step.ts"

// a step's place: lamport, device, n
export type Ref = [lamport: number, device: string, n: number]
// elements in order: made, numbered c on (back: c down); born
// (there since the list's step), places c on. left: what the first goes after (back: each), right:
// what each goes before (back: the last); null the start, the end
type Run = {
	device: string
	c: number
	len: number
	gone: boolean
	born: boolean
	back: boolean
	left: Id | null
	right: Id | null
	// its place among the list's runs, as a number that grows along them (edit)
	lab: number
}
// a place in a list: a run and a place in it
type Pos = [j: number, o: number]
// a sequence's runs, the step its born ones are since, how many are not gone, a cursor (live: how
// many before runs[j] are not gone), the newest step that spliced it
type List = {
	runs: Run[]
	by: Ref
	count: number
	j: number
	live: number
	last?: Ref
	ix?: Ix[]
}
// the runs by their lowest id (device, born, number), sorted: made when a lookup walks far, kept up
// to date by edit; a run's place is found by its lab
type Ix = { d: string; b: boolean; lo: number; hi: number; run: Run }
// an entry's value and its sequences' elements, by where (a path, each array item as its element);
// born: by where, the step that made what is there new (a sequence under it is that step's until a
// splice touches it)
export type State = { value: unknown; lists: Map<string, List>; born: Map<string, Ref> }

export const fresh = (): State => ({ value: undefined, lists: new Map(), born: new Map() })
// a step applied after newer ones (late) whose effect needs what those did: it is worked out from them
export const LATE = "late, and the steps after it let go"
export class Late extends Error {
	constructor() {
		super(LATE)
	}
}
const newer = (a: Ref | undefined, b: Ref) => !!a && (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]))
// late: a step after ref made where or above it new
function covered(state: State, where: readonly unknown[], ref: Ref) {
	for (let n = 0; n <= where.length; n++) {
		if (newer(state.born.get(keyOf(where.slice(0, n))), ref)) return true
	}
	return false
}
// late: a step after ref made new or spliced what is at or under where
function touched(state: State, where: readonly unknown[], ref: Ref) {
	const prefix = keyOf(where)
	for (const [k, b] of state.born) if (under(k, prefix) && newer(b, ref)) return true
	for (const [k, l] of state.lists) if (under(k, prefix) && newer(l.last, ref)) return true
	return false
}
// sort keys: device, number (a born one's -1)
type Key = [device: string, c: number]
const after = (a: Key, b: Key) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
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
	r.born ? [l.by[1], -1] : [r.device, r.back ? r.c - o : r.c + o]
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
	if (l.runs.length <= FAR) {
		for (let j = 0; j < l.runs.length; j++) {
			const o = place(l, l.runs[j], id)
			if (o >= 0) return [j, o]
		}
		return
	}
	l.ix ??= l.runs.map(entry).sort(order)
	const born = id.k !== undefined, x = born ? id.k! : id.c
	if (born && id.c !== l.by[2]) return
	const e = l.ix[below(l.ix, id.device, born, x) - 1]
	if (e && e.d === id.device && e.b === born && x <= e.hi) {
		const r = e.run
		return [indexOf(l, r), r.back ? r.c - x : x - r.c]
	}
}
// runs it takes to walk before the index is made
const FAR = 32
// where run r is, by its lab
function indexOf(l: List, r: Run) {
	let a = 0, b = l.runs.length
	while (a < b) {
		const m = (a + b) >> 1
		if (l.runs[m].lab < r.lab) a = m + 1
		else b = m
	}
	return a
}
const entry = (r: Run): Ix => ({
	d: r.device,
	b: r.born,
	lo: r.back ? r.c - r.len + 1 : r.c,
	hi: r.back ? r.c : r.c + r.len - 1,
	run: r,
})
const order = (a: Ix, b: Ix) => a.d < b.d ? -1 : a.d > b.d ? 1 : +a.b - +b.b || a.lo - b.lo
// how many entries sort at or before (d, b, x)
function below(ix: Ix[], d: string, b: boolean, x: number) {
	let lo = 0, hi = ix.length
	while (lo < hi) {
		const m = (lo + hi) >> 1, e = ix[m]
		if (e.d < d || (e.d === d && (+e.b < +b || (e.b === b && e.lo <= x)))) lo = m + 1
		else hi = m
	}
	return lo
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
	const ix = l.ix
	if (ix) {
		// an entry of a run taken out stays for one put in with the same lowest id
		const out: Ix[] = []
		for (const r of l.runs.slice(j, j + del)) {
			const e = ix[below(ix, r.device, r.born, entry(r).lo) - 1]
			out.push(e)
		}
		const used = new Set<Ix>()
		for (const r of ins) {
			const n = entry(r), e = ix[below(ix, n.d, n.b, n.lo) - 1]
			if (e && out.includes(e) && !used.has(e) && e.d === n.d && e.b === n.b && e.lo === n.lo) {
				e.hi = n.hi, e.run = r, used.add(e)
			} else ix.splice(below(ix, n.d, n.b, n.lo), 0, n)
		}
		for (const e of out) if (!used.has(e)) ix.splice(below(ix, e.d, e.b, e.lo) - 1, 1)
	}
	const lo = j > 0 ? l.runs[j - 1].lab : 0
	const hi = j + del < l.runs.length ? l.runs[j + del].lab : lo + (ins.length + 1) * GAP
	const gap = Math.floor((hi - lo) / (ins.length + 1))
	ins.forEach((r, i) => r.lab = lo + gap * (i + 1))
	if (del === ins.length) ins.forEach((r, i) => l.runs[j + i] = r)
	else l.runs.splice(j, del, ...ins)
	if (gap < 8) relabel(l, j, j + ins.length)
}
// labs of the runs around [a, b) made even again, over as few as leave room between them
function relabel(l: List, a: number, b: number) {
	const n = l.runs.length
	for (let k = 4;; k *= 2) {
		const x = Math.max(0, a - k), y = Math.min(n, b + k)
		const lo = x > 0 ? l.runs[x - 1].lab : 0
		const hi = y < n ? l.runs[y].lab : lo + (y - x + 1) * GAP
		const gap = Math.floor((hi - lo) / (y - x + 1))
		if (gap >= 16 || (x === 0 && y === n)) {
			const g = x === 0 && y === n ? GAP : gap
			for (let i = x; i < y; i++) l.runs[i].lab = lo + g * (i - x + 1)
			return
		}
	}
}
// the labs of runs are this far apart at first
const GAP = 2 ** 20
const is = (a: Id | null, b: Id | null) => a === b || (!!a && !!b && same(a, b))
// runs[j - 1] and runs[j] as one, if they go on from each other: numbers one on (or one down), each
// after (or before) the one before
function join(l: List, j: number) {
	const a = l.runs[j - 1], b = l.runs[j]
	if (!a || !b || a.device !== b.device || a.born !== b.born || a.gone !== b.gone) return
	const on = (a.len === 1 || !a.back) && (b.len === 1 || !b.back) && a.c + a.len === b.c &&
		is(b.left, idAt(l, a, a.len - 1)) && is(a.right, b.right)
	const down = !on && !a.born && (a.len === 1 || a.back) && (b.len === 1 || b.back) &&
		a.c - a.len === b.c && is(a.right, idAt(l, b, 0)) && is(a.left, b.left)
	if (!on && !down) return
	edit(l, j - 1, 2, { ...a, len: a.len + b.len, back: down, right: on ? a.right : b.right })
}
// run r's elements [o, o + n)
function part(l: List, r: Run, o: number, n: number): Run {
	if (r.back) {
		const right = o + n < r.len ? idAt(l, r, o + n) : r.right
		return { ...r, c: r.c - o, len: n, right }
	}
	return { ...r, c: r.c + o, len: n, left: o ? idAt(l, r, o - 1) : r.left }
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

// a step's patches applied to state in order, all or none, by its ids; a step with none is a write
// here: its splices and the array items its paths go through are named from the elements
// (returned). o.undo gets what undoes the value, o.back what undoes the elements (run newest
// first). o.keep: false for a patch left out (its elements still counted). o.late: steps after it
// may be applied already; one whose effect needs them throws Late. the patches as applied, by
// position, returned for the graph
export function step(
	state: State,
	s: Pick<Step, "device" | "n" | "lamport" | "patches"> & { ids?: readonly Value[] } & At,
	o: {
		undo?: Patch[]
		back?: (() => void)[]
		keep?: readonly boolean[]
		late?: boolean
	} = {},
): { applied: Patch[]; ids: (Named | null)[] } {
	const { undo = [], back = [], keep } = o
	const ref: Ref = [s.lamport, s.device, s.n]
	const applied: Patch[] = [], ids: (Named | null)[] = []
	const mine: Patch[][] = [], marks = back.length
	const was = state.value
	const name = !s.ids, named = s.ids ? readIds(s, s.ids) : undefined
	let made = 0
	try {
		for (let i = 0; i < s.patches.length; i++) {
			const p = s.patches[i], c = s.seq + made
			made += inserts(p)
			if (keep && !keep[i]) {
				ids.push(null)
				continue
			}
			if (p.move && o.late) throw new Late()
			const out = p.move
				? (renew(state, ref, end(state, p, back), back),
					renew(state, ref, end(state, p.move, back), back),
					{ patches: [p], named: null })
				: patch(state, ref, c, p, named?.[i] ?? null, back, name, o.late)
			ids.push(out.named)
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

// a patch but a move, its path's array items found by ids (a write here: by place, and named): a
// splice, a removal at an index of an array (a splice of that one) or a put
function patch(
	state: State,
	ref: Ref,
	c: number,
	p: Patch,
	given: Named | null,
	back: (() => void)[],
	name: boolean,
	late = false,
): { patches: Patch[]; named: Named | null } {
	const k = p.path.at(-1), by = given?.through ?? (name ? undefined : [])
	const one = !p.range && p.value === undefined && typeof k === "number"
	let up = locate(state, p.path, by, back, one ? p.path.length - 1 : p.path.length)
	if (late && covered(state, up.where, ref)) throw new Late()
	// empty: an empty through too (a splice into an array whose path has no whole)
	const through = (more: Id[], empty = false) => {
		const t = name && up.ids ? [...up.ids, ...more] : undefined
		return t && (t.length || empty) ? t : undefined
	}
	if (one && Array.isArray(at(state.value, up.path))) {
		// by its id: taken away wherever it is now, once
		const q: Patch = { path: up.path, range: [k, k + 1] }
		const gone = by ? { after: null, gone: [[by.at(-1)!, 1]] as [Id, number][] } : null
		const out = splice(state, ref, c, q, up.where, gone, back)
		const t = out.anchor && through([out.anchor.gone[0][0]])
		return { patches: out.patches, named: t ? { through: t } : null }
	}
	if (one) up = locate(state, p.path, by, back, p.path.length)
	if (one && late && covered(state, up.where, ref)) throw new Late()
	const q: Patch = up.path === p.path ? p : { ...p, path: up.path }
	if (p.range && isSeq(at(state.value, up.path))) {
		if (!name && !given?.splice) throw new RangeError("a splice with no ids")
		const out = splice(state, ref, c, q, up.where, given?.splice ?? null, back)
		const t = through([], true)
		return {
			patches: out.patches,
			named: { splice: out.anchor!, ...(t && { through: t }) },
		}
	}
	if (late && touched(state, up.where, ref)) throw new Late()
	renew(state, ref, up.where, back)
	const t = through([])
	return { patches: [q], named: t ? { through: t } : null }
}

// a path's first upto items, its arrays' items found by the ids by names, wherever they are now
// (one gone or not there: it doesn't apply), or by place (a write here, a move). path: to apply;
// where: its key, each array item as its element; ids: those elements (none: one not there)
function locate(
	state: State,
	path: readonly Index[],
	by: readonly Id[] | undefined,
	back: (() => void)[],
	upto = path.length,
) {
	const out: Index[] = [], where: unknown[] = []
	let ids: Id[] | undefined = [], v = state.value, x = 0, moved = upto < path.length
	for (let i = 0; i < upto; i++) {
		let k = path[i]
		if (typeof k === "number") {
			const id = by?.[x++]
			let e: Id | undefined
			if (Array.isArray(v)) {
				const l = elements(state, out, where, back)
				if (by && !id) throw new RangeError("an element named is not there")
				if (id) {
					const f = find(l, id)
					if (!f || l.runs[f[0]].gone) throw new RangeError("an element named is not there")
					e = id, k = liveBefore(l, f[0]) + f[1], moved ||= k !== path[i]
				} else if (k < l.count) {
					const [j, o] = liveAt(l, k)
					e = idAt(l, l.runs[j], o)
				}
			} else if (id) throw new RangeError("an element named is not there")
			where.push(!e ? k : e.k === undefined ? [e.device, e.c] : [e.device, e.c, e.k])
			if (e) ids?.push(e)
			else ids = undefined
		} else where.push(k)
		out.push(k)
		v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined
	}
	return { path: moved ? out : path, where, ids }
}

// what a move makes new at one end, by place: the sequence a range is in, or the array an index is
// in, or what is at the path
function end(state: State, t: Target, back: (() => void)[]) {
	const k = t.path.at(-1), up = locate(state, t.path, undefined, back, t.path.length - 1)
	return !t.range && typeof k === "number" && Array.isArray(at(state.value, up.path))
		? up.where
		: locate(state, t.path, undefined, back).where
}

// the sequences at where and under it made new by this step (a put, a removal, a move there)
function renew(state: State, ref: Ref, where: readonly unknown[], back: (() => void)[]) {
	const prefix = keyOf(where)
	const lists = [...state.lists].filter(([k]) => under(k, prefix))
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

// the elements of the sequence at path (where, its key), made at the first splice: there since the
// step that made it new
function elements(
	state: State,
	path: readonly unknown[],
	where: readonly unknown[],
	back: (() => void)[],
): List {
	const key = keyOf(where)
	const had = state.lists.get(key)
	if (had) return had
	let by: Ref | undefined
	for (let n = where.length; n >= 0 && !by; n--) by = state.born.get(keyOf(where.slice(0, n)))
	if (!by) throw new RangeError("no put made it")
	const count = units(at(state.value, path))
	const runs = count
		? [{
			device: by[1],
			c: 0,
			len: count,
			gone: false,
			born: true,
			back: false,
			left: null,
			right: null,
			lab: GAP,
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
	where: readonly unknown[],
	anchor: Anchor | null,
	back: (() => void)[],
): { patches: Patch[]; anchor: Anchor } {
	// an insert of another kind than the sequence (a list into a text): doesn't apply, as apply refuses
	const kind = (v: unknown) => typeof v === "string" ? "text" : Array.isArray(v) ? "list" : "other"
	if (p.value !== undefined && kind(p.value) !== kind(at(state.value, p.path))) {
		throw new RangeError("wrong-kind")
	}
	const l = elements(state, p.path, where, back)
	const was = l.last
	if (!newer(was, ref)) l.last = ref
	back.push(() => void (l.last = was))
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
		spot = scan(l, spot, first, right, rp, [ref[1], c])
	} else if (m > 0 && spot[0] < l.runs.length) {
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
			left: first,
			right,
			lab: 0,
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
	return { patches, anchor: anchor ?? anchorOf(first, gone, before) }
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

// a splice's ids
function anchorOf(
	first: Id | null,
	gone: readonly (readonly [Id, number])[],
	before: Anchor["before"],
): Anchor {
	const a: Anchor = { after: first, gone: gone.map(([i, n]) => [i, n] as [Id, number]) }
	if (before !== undefined) a.before = before
	return a
}

// a state's elements as a value, for a snapshot; the value itself is the graph's
const idOut = (i: Id | null): Value =>
	i === null ? null : i.k === undefined ? [i.device, i.c] : [i.device, i.c, i.k]
const idIn = (v: unknown): Id | null => {
	if (v === null) return null
	const [device, c, k] = v as [string, number, number?]
	return k === undefined ? { device, c } : { device, c, k }
}
export function save(state: State): Value {
	const lists = [...state.lists].map(([key, l]) => [
		key,
		l.by,
		l.last ?? null,
		l.runs.map((r) => [
			r.device,
			r.c,
			r.len,
			(r.gone ? 1 : 0) | (r.born ? 2 : 0) | (r.back ? 4 : 0),
			idOut(r.left),
			idOut(r.right),
		]),
	])
	return [lists, [...state.born]] as unknown as Value
}
export function load(v: unknown): State {
	const [lists, born] = v as [unknown[][], [string, Ref][]]
	const state = fresh()
	for (const [key, by, last, runs] of lists as [string, Ref, Ref | null, unknown[][]][]) {
		const rs = runs.map((r, i): Run => ({
			device: r[0] as string,
			c: r[1] as number,
			len: r[2] as number,
			gone: !!((r[3] as number) & 1),
			born: !!((r[3] as number) & 2),
			back: !!((r[3] as number) & 4),
			left: idIn(r[4]),
			right: idIn(r[5]),
			lab: GAP * (i + 1),
		}))
		const count = rs.reduce((n, r) => n + (r.gone ? 0 : r.len), 0)
		state.lists.set(key, { runs: rs, by, count, j: 0, live: 0, ...(last && { last }) })
	}
	for (const [key, ref] of born) state.born.set(key, ref)
	return state
}
