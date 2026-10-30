// The elements of an entry's strings and arrays (WIRE.md, ids), held as runs: elements one after
// another of one device, their counters one on, all gone or none. A sequence gets its elements at
// the first splice that touches it: those there since the step that made it new are that step's, k
// their place. A splice by ids goes after its element, past any whose ids sort after its own (so two
// inserts at one place land the same in any order), and takes its gone elements away wherever they
// are now; a splice by range goes as written. A put makes the sequences under it new; a move does
// too, and the sequences it moves out of and into. A removal at an index of an array is a splice of
// that one, by its place as written.
import apply, { type Patch, type Target } from "@ermine/changeable/apply"
import { type Anchor, type Id, inserts, type Step } from "./step.ts"

// a step's place: lamport, device
export type Ref = [lamport: number, device: string]
// elements in order: made, counters c on; born (there since the list's step), places c on
type Run = { device: string; c: number; len: number; gone: boolean; born: boolean }
// a sequence's runs, the step its born ones are since, how many are not gone, a cursor (live: how
// many before runs[j] are not gone); top: by device, past its newest counter here
type List = {
	runs: Run[]
	by: Ref
	count: number
	j: number
	live: number
	top: Map<string, number>
}
// an entry's value and its sequences' elements, by path; born: by path, the step that made what is
// there new (a sequence under it is that step's until a splice touches it)
export type State = { value: unknown; lists: Map<string, List>; born: Map<string, Ref> }

export const fresh = (): State => ({ value: undefined, lists: new Map(), born: new Map() })
const after = (a: Ref, b: Ref) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
const keyOf = (path: readonly unknown[]) => JSON.stringify(path)
// key's path is prefix's, or under it
const under = (key: string, prefix: string) =>
	prefix === "[]" || key === prefix || key.startsWith(prefix.slice(0, -1) + ",")
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
	r.born ? { device: r.device, c: l.by[0], k: r.c + o } : { device: r.device, c: r.c + o }
const plus = (i: Id, n: number): Id =>
	i.k === undefined ? { ...i, c: i.c + n } : { ...i, k: i.k + n }
const sortOf = (l: List, r: Run, o: number): Ref => r.born ? l.by : [r.c + o, r.device]
// where id is in r, or -1
function place(l: List, r: Run, id: Id) {
	if (r.device !== id.device || r.born !== (id.k !== undefined)) return -1
	const x = id.k === undefined ? id.c : id.c === l.by[0] ? id.k : -1
	return x >= r.c && x < r.c + r.len ? x - r.c : -1
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
// runs[j - 1] and runs[j] as one, if they go on from each other
function join(l: List, j: number) {
	const a = l.runs[j - 1], b = l.runs[j]
	if (
		a && b && a.device === b.device && a.born === b.born && a.gone === b.gone &&
		a.c + a.len === b.c
	) edit(l, j - 1, 2, { ...a, len: a.len + b.len })
}
// run j's elements [o, o + n) a run of their own: its index
function cut(l: List, j: number, o: number, n: number) {
	const r = l.runs[j], parts = [{ ...r, c: r.c + o, len: n }]
	if (o > 0) parts.unshift({ ...r, len: o })
	if (o + n < r.len) parts.push({ ...r, c: r.c + o + n, len: r.len - o - n })
	edit(l, j, 1, ...parts)
	return j + (o > 0 ? 1 : 0)
}
function mark(l: List, j: number, o: number, n: number, gone: boolean) {
	const i = cut(l, j, o, n)
	edit(l, i, 1, { ...l.runs[i], gone })
	l.count += gone ? -n : n
	join(l, i + 1), join(l, i)
}
// each run of the n elements from id on, in turn: f(run, place, how many there)
function each(l: List, id: Id, n: number, f: (j: number, o: number, m: number) => void) {
	for (let x = 0; x < n;) {
		const [j, o] = find(l, plus(id, x))!, m = Math.min(l.runs[j].len - o, n - x)
		f(j, o, m), x += m
	}
}
const same = (a: Id, b: Id) => a.device === b.device && a.c === b.c && a.k === b.k
const cleared = (p: Patch, from: number, to: number): Patch => ({ path: p.path, range: [from, to] })
const there = (l: List, id: Id, n: number) => {
	for (let x = 0; x < n;) {
		const f = find(l, plus(id, x))
		if (!f) return false
		x += l.runs[f[0]].len - f[1]
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
	s: Pick<Step, "device" | "lamport" | "patches" | "ids">,
	o: { undo?: Patch[]; back?: (() => void)[]; name?: boolean; keep?: readonly boolean[] } = {},
): { applied: Patch[]; ids: (Anchor | null)[] } {
	const { undo = [], back = [], name = false, keep } = o
	const ref: Ref = [s.lamport, s.device]
	const applied: Patch[] = [], ids: (Anchor | null)[] = []
	const mine: Patch[][] = [], marks = back.length
	const was = state.value
	let made = 0
	try {
		for (let i = 0; i < s.patches.length; i++) {
			const p = s.patches[i], c = s.lamport + made
			made += inserts(p)
			if (keep && !keep[i]) {
				ids.push(null)
				continue
			}
			const anchor = name ? null : s.ids?.[i] ?? null
			const listed = inArray(state.value, p)
			const out = p.move
				? (renew(state, ref, end(state.value, p), back),
					renew(state, ref, end(state.value, p.move), back),
					{ patches: [p], anchor: null })
				: p.range && units(at(state.value, p.path)) >= 0
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
	by ??= [0, ""]
	const count = units(at(state.value, path))
	const runs = count ? [{ device: by[1], c: 0, len: count, gone: false, born: true }] : []
	const l: List = { runs, by, count, j: 0, live: 0, top: new Map() }
	state.lists.set(key, l)
	back.push(() => state.lists.delete(key))
	return l
}

// a splice, its inserted ones counted from c: by ids (anchor) or by its range; name: its ids found
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
	// its counters past those its device made here: an element is never named twice
	const top = l.top.get(ref[1])
	if (m > 0 && top !== undefined && c < top) throw new RangeError("a counter its device used")
	// what it names: the element it goes after, and those it takes away, as runs
	let first: Id | null
	let gone: readonly (readonly [Id, number])[]
	if (anchor) {
		first = anchor.after, gone = anchor.gone
		if ((first && !find(l, first)) || !gone.every(([i, n]) => there(l, i, n))) {
			throw new RangeError("an element named is not there")
		}
	} else {
		if (a > b || b > l.count) throw new RangeError("range")
		const [j, o] = a ? liveAt(l, a - 1) : [0, 0]
		first = a ? idAt(l, l.runs[j], o) : null
		const runs: [Id, number][] = []
		for (let x = a; x < b;) {
			const [j, o] = liveAt(l, x), r = l.runs[j], n = Math.min(r.len - o, b - x)
			const i = idAt(l, r, o), last = runs.at(-1)
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
			taken.push([idAt(l, r, o), m])
			mark(l, j, o, m, true)
			if (last && last[0] === from) patches[patches.length - 1] = cleared(p, from, last[1] + m)
			else if (last && from + m === last[0]) {
				patches[patches.length - 1] = cleared(p, from, last[1])
			} else patches.push(cleared(p, from, from + m))
		})
	}
	// where the inserted go: after its element, past those that sort after it (by ids)
	let [j, o] = first ? find(l, first)! : [0, -1]
	if (++o === l.runs[j]?.len) j++, o = 0
	if (anchor) {
		while (j < l.runs.length && after(sortOf(l, l.runs[j], o), [c, ref[1]])) j++, o = 0
	}
	const to = liveBefore(l, j) + (l.runs[j] && !l.runs[j].gone ? o : 0)
	if (m > 0) {
		if (o > 0) j = cut(l, j, o, l.runs[j].len - o)
		edit(l, j, 0, { device: ref[1], c, len: m, gone: false, born: false })
		l.count += m
		join(l, j + 1), join(l, j)
		l.top.set(ref[1], c + m)
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
			if (top === undefined) l.top.delete(ref[1])
			else l.top.set(ref[1], top)
		}
		for (const [id, n] of taken.reverse()) each(l, id, n, (j, o, m) => mark(l, j, o, m, false))
	})
	if (Array.isArray(at(state.value, p.path))) renew(state, ref, p.path, back, false)
	return { patches, anchor: name ? anchorOf(first, gone) : anchor }
}

// a splice's ids; null: one of them made by no step (no put made its sequence), so it goes by its
// range
function anchorOf(first: Id | null, gone: readonly (readonly [Id, number])[]): Anchor | null {
	if ([first, ...gone.map((g) => g[0])].some((i) => i?.device === "")) return null
	return { after: first, gone: gone.map(([i, n]) => [i, n] as [Id, number]) }
}
