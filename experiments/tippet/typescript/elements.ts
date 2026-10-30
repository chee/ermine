// The elements of an entry's strings and arrays (WIRE.md, ids): each element its id, the step that
// made it, and whether it is gone. A sequence gets its elements at the first splice that touches
// it: those there since the put that made it are that put's, k their place. A splice by ids goes
// after its element, past any made there by steps that sort after it (so two inserts at one place
// land the same in any order), and takes its gone elements away wherever they are now; a splice
// by range goes as written. A put makes the sequences under it new; a move does too.
import apply, { type Patch } from "@ermine/changeable/apply"
import type { Anchor, Id, Step } from "./step.ts"

// a step's place: lamport, device, n
export type Ref = [lamport: number, device: string, n: number]
type Elem = { id: string; at: Ref; gone: boolean }
// a sequence's elements in order, by id, how many are not gone, and a cursor: live, how many before
// items[j] are not gone (typing, and edits near the last, walk only from there)
type List = { items: Elem[]; byId: Map<string, Elem>; count: number; j: number; live: number }
// an entry's value and its sequences' elements, by path; born: by path, the put that made what is
// there (a sequence under it is that put's until a splice touches it)
export type State = { value: unknown; lists: Map<string, List>; born: Map<string, Ref> }

export const fresh = (): State => ({ value: undefined, lists: new Map(), born: new Map() })
const before = (a: Ref, b: Ref) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
const keyOf = (path: readonly unknown[]) => JSON.stringify(path)
const idOf = (i: Id) => `${i.device} ${i.n} ${i.k}`
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
// speed only, to the end of index: the cursor, so typing and edits near the last walk only from there

// how many before items[j] are not gone, the cursor moved there
function liveBefore(l: List, j: number) {
	while (l.j < j) l.live += l.items[l.j++].gone ? 0 : 1
	while (l.j > j) l.live -= l.items[--l.j].gone ? 0 : 1
	return l.live
}
// the index of the a-th element not gone (items.length: past the last), the cursor moved there
function liveAt(l: List, a: number) {
	while (l.live > a) if (!l.items[--l.j].gone) l.live--
	while (l.j < l.items.length && (l.live < a || l.items[l.j].gone)) {
		if (!l.items[l.j++].gone) l.live++
	}
	return l.j
}
// an element's index: looked for near the cursor first
function index(l: List, e: Elem) {
	for (let d = 0; d < 8; d++) {
		if (l.items[l.j - 1 - d] === e) return l.j - 1 - d
		if (l.items[l.j + d] === e) return l.j + d
	}
	return l.items.indexOf(e)
}

// a step's patches applied to state in order, all or none: ids (when the step has them) made
// positions. o.undo gets what undoes the value, o.back what undoes the elements (run newest
// first). o.name: a write here, its splices named from the elements (their ids returned). the
// patches as applied, by position, returned for the graph
export function step(
	state: State,
	s: Pick<Step, "device" | "n" | "lamport" | "patches" | "ids">,
	o: { undo?: Patch[]; back?: (() => void)[]; name?: boolean } = {},
): { applied: Patch[]; ids: (Anchor | null)[] } {
	const { undo = [], back = [], name = false } = o
	const ref: Ref = [s.lamport, s.device, s.n]
	// what this step made at each path, counted
	const made = new Map<string, number>()
	const applied: Patch[] = [], ids: (Anchor | null)[] = []
	const mine: Patch[][] = [], marks = back.length
	const was = state.value
	try {
		for (let i = 0; i < s.patches.length; i++) {
			const p = s.patches[i], anchor = name ? null : s.ids?.[i] ?? null
			const out = p.range && units(at(state.value, p.path)) >= 0
				? splice(state, ref, made, p, anchor, back, name)
				: (renew(state, ref, p.path, back),
					p.move && renew(state, ref, p.move.path, back),
					{ patches: [p], anchor: null })
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

// the elements of the sequence at path, made at the first splice: there since the put that made it
function elements(
	state: State,
	ref: Ref,
	made: Map<string, number>,
	path: readonly unknown[],
	back: (() => void)[],
): List {
	const key = keyOf(path)
	const had = state.lists.get(key)
	if (had) return had
	let b: Ref | undefined
	for (let n = path.length; n >= 0 && !b; n--) b = state.born.get(keyOf(path.slice(0, n)))
	const by = b ?? [0, "", 0] as Ref, count = units(at(state.value, path))
	const items = Array.from(
		{ length: count },
		(_, k) => ({ id: `${by[1]} ${by[2]} ${k}`, at: by, gone: false }),
	)
	const l: List = { items, byId: new Map(items.map((e) => [e.id, e])), count, j: 0, live: 0 }
	state.lists.set(key, l)
	if (by[1] === ref[1] && by[2] === ref[2]) made.set(key, count)
	back.push(() => state.lists.delete(key))
	return l
}

// a splice: by ids (anchor) or by its range; name: its ids found from its range
function splice(
	state: State,
	ref: Ref,
	made: Map<string, number>,
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
	const key = keyOf(p.path), l = elements(state, ref, made, p.path, back)
	const [a, b] = p.range!
	let after: number
	const gone: Elem[] = []
	if (anchor) {
		const e = anchor.after && l.byId.get(idOf(anchor.after))
		if (anchor.after && !e) throw new RangeError("an element named is not there")
		after = e ? index(l, e) : -1
		for (const [i, c] of anchor.gone) {
			for (let k = 0; k < c; k++) {
				const g = l.byId.get(idOf({ ...i, k: i.k + k }))
				if (!g) throw new RangeError("an element named is not there")
				gone.push(g)
			}
		}
	} else {
		if (a > b || b > l.count) throw new RangeError("range")
		after = a ? liveAt(l, a - 1) : -1
		for (let i = b > a ? liveAt(l, a) : 0; gone.length < b - a; i++) {
			if (!l.items[i].gone) gone.push(l.items[i])
		}
	}
	// where the inserted go: after its element, past those made by steps after this one
	let j = after + 1
	if (anchor) { while (j < l.items.length && before(ref, l.items[j].at)) j++ }
	const value = p.value, m = value === undefined ? 0 : units(value)
	// by position: the gone ones that are still there, newest place first, then the insert
	// each still there taken away once, however often named
	const taken = [...new Set(gone)].filter((e) => !e.gone), where = taken.map((e) => index(l, e))
	const places = where.map((i) => liveBefore(l, i)).sort((x, y) => y - x)
	const to = liveBefore(l, j) - where.filter((i) => i < j).length
	// neighbours as one range
	const patches: Patch[] = []
	for (let i = 0; i < places.length;) {
		let n = 1
		while (i + n < places.length && places[i + n] + n === places[i]) n++
		patches.push({ path: p.path, range: [places[i] + 1 - n, places[i] + 1] }), i += n
	}
	if (m > 0) patches.push({ path: p.path, range: [to, to], value })
	if (!patches.length) patches.push({ path: p.path, range: [to, to] })
	// the elements: gone ones marked, the inserted made, k counted per path for the step
	for (const i of where) {
		l.items[i].gone = true
		if (i < l.j) l.live--
	}
	const k0 = made.get(key) ?? 0
	const fresh = Array.from(
		{ length: m },
		(_, k) => ({ id: `${ref[1]} ${ref[2]} ${k0 + k}`, at: ref, gone: false }),
	)
	l.items.splice(j, 0, ...fresh)
	for (const f of fresh) l.byId.set(f.id, f)
	if (l.j > j) l.j += m, l.live += m
	l.count += m - taken.length
	made.set(key, k0 + m)
	back.push(() => {
		l.items.splice(j, m)
		for (const f of fresh) l.byId.delete(f.id)
		for (const e of taken) e.gone = false
		l.count += taken.length - m, l.j = 0, l.live = 0
		made.set(key, k0)
	})
	if (Array.isArray(at(state.value, p.path))) renew(state, ref, p.path, back, false)
	const named = name ? anchorOf(l.items, after, gone) : anchor
	return { patches, anchor: named }
}

// a splice's ids: the element before it, and its gone ones as runs of one step's, k on. null: one
// of them made by no step (no put made its sequence), so it goes by its range
function anchorOf(list: Elem[], after: number, gone: Elem[]): Anchor | null {
	if ([...gone, ...after < 0 ? [] : [list[after]]].some((e) => e.at[1] === "")) return null
	const id = (e: Elem): Id => {
		const [device, n, k] = e.id.split(" ")
		return { device, n: Number(n), k: Number(k) }
	}
	const runs: [Id, number][] = []
	for (const e of gone) {
		const i = id(e), last = runs[runs.length - 1]
		if (last && last[0].device === i.device && last[0].n === i.n && last[0].k + last[1] === i.k) {
			last[1]++
		} else runs.push([i, 1])
	}
	return { after: after < 0 ? null : id(list[after]), gone: runs }
}
