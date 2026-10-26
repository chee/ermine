// tracked paths against op, in process, where the paths suite's oracle fuzz (paths_harness_test.ts)
// does not reach: values of lists nested in maps and lists, batches of up to six patches mixing
// ranged and unranged moves (inside a list, between lists, to and from map keys) with splices,
// removals that shift, and replaces. on copy-on-write values (op's apply), a read whose value is
// a new reference after the batch must be marked; mark agrees with the rule (marks) patch by
// patch; a released spot is no longer given, the rest are; an event gives every spot of the key.
// a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import apply, { ApplyError, type Key, type Patch } from "@ermine/core/op/apply"
import { createPaths, marks, type Spot } from "./paths.ts"
import { isMap, rand, show } from "../../fuzz/gen_harness.ts"

const SEEDS = 40
const CASES = 25
const NAMES = ["a", "b", "c"]
const MISSING = Symbol("missing")

type R = ReturnType<typeof rand>

// a value: maps of lists, lists of lists and maps, every item a new object; a string and a typed
// array as leaves now and then
function make(r: R, depth: number): unknown {
	const k = r.pick(depth > 0 ? 10 : 3)
	if (k === 0) return { n: r.pick(100) }
	if (k === 1) return r.one(["", "x", "é😀"])
	if (k === 2) return Int16Array.from({ length: r.pick(3) }, () => r.pick(9))
	if (k < 7) return Array.from({ length: r.pick(5) }, () => make(r, depth - 1))
	const m: Record<string, unknown> = {}
	for (const n of NAMES) if (r.pick(3)) m[n] = make(r, depth - 1)
	return m
}
const items = (r: R) => Array.from({ length: r.pick(3) }, () => make(r, 1))

function get(v: unknown, path: readonly Key[]): unknown {
	if (v === undefined) return MISSING
	for (const k of path) {
		if (Array.isArray(v) && typeof k === "number" && k < v.length) v = v[k]
		else if (isMap(v) && typeof k === "string" && Object.hasOwn(v, k)) v = v[k]
		else return MISSING
	}
	return v
}
function every(v: unknown, at: Key[] = [], out: Key[][] = []): Key[][] {
	out.push(at)
	if (at.length >= 5) return out
	if (Array.isArray(v)) v.forEach((x, i) => every(x, [...at, i], out))
	else if (isMap(v)) { for (const k of Object.keys(v)) every(v[k], [...at, k], out) }
	return out
}

// a patch on v, aimed at its lists most of the time; none found: undefined
function patch(r: R, v: unknown): Patch | undefined {
	const all = every(v)
	const lists = all.filter((p) => Array.isArray(get(v, p)))
	const maps = all.filter((p) => isMap(get(v, p)))
	const elems = all.filter((p) => p.length > 0 && typeof p[p.length - 1] === "number")
	const keys = all.filter((p) => p.length > 0 && typeof p[p.length - 1] === "string")
	const strings = all.filter((p) => typeof get(v, p) === "string")
	const size = (p: Key[]) => (get(v, p) as unknown[]).length
	const gap = (p: Key[], less = 0) => r.pick(Math.max(size(p) - less, 0) + 1)
	const spanOf = (p: Key[]): [number, number] => {
		const n = size(p), a = r.pick(n + 1)
		return [a, a + r.pick(n - a + 1)]
	}
	for (let tries = 0; tries < 30; tries++) {
		let p: Patch | undefined
		const k = r.pick(14)
		if (k < 2 && lists.length) {
			// a splice: new items in, a span out
			const l = r.one(lists)
			p = r.pick(3)
				? { path: l, range: spanOf(l), value: items(r) }
				: { path: l, range: spanOf(l) }
		} else if (k < 3 && elems.length) p = { path: r.one(elems) } // a removal: the rest shift
		else if (k < 4 && elems.length) p = { path: r.one(elems), value: make(r, 1) }
		else if (k < 6 && lists.length) {
			// a span moved inside its list
			const l = r.one(lists), s = spanOf(l)
			const g = gap(l, s[1] - s[0])
			p = { path: l, range: [g, g], move: { path: l, range: s } }
		} else if (k < 8 && lists.length) {
			// a span to another list
			// a span to another list (or the same), landing in a gap or over a span of what is left
			const from = r.one(lists), to = r.one(lists), a = gap(to), b = r.pick(2) ? a : gap(to)
			p = {
				path: to,
				range: [Math.min(a, b), Math.max(a, b)],
				move: { path: from, range: spanOf(from) },
			}
		} else if (k < 10 && elems.length && lists.length) {
			// one element into a list's gap
			const to = r.one(lists), g = gap(to)
			p = { path: to, range: [g, g], move: { path: r.one(elems) } }
		} else if (k < 11 && elems.length && maps.length) {
			// one element, or a span as a list, to a map's key
			const l = r.one(lists.length ? lists : [[]])
			const take = r.pick(2) || !lists.length
				? { path: r.one(elems) }
				: { path: l, range: spanOf(l) }
			p = { path: [...r.one(maps), r.one(NAMES)], move: take }
		} else if (k < 12 && keys.length && lists.length) {
			const to = r.one(lists), g = gap(to)
			p = { path: to, range: [g, g], move: { path: r.one(keys) } }
		} else if (k < 13 && elems.length) {
			// an element onto another: a replace
			p = { path: r.one(elems), move: { path: r.one(elems) } }
		} else if (maps.length) {
			p = r.pick(2)
				? { path: [...r.one(maps), r.one(NAMES)], value: make(r, 2) }
				: { path: [...r.one(maps), r.one(NAMES)] }
		} else if (strings.length) {
			p = { path: r.one(strings), range: [0, 0], value: "q" }
		}
		if (p === undefined) continue
		try {
			apply(v, [p])
			return p
		} catch (e) {
			if (!(e instanceof ApplyError)) throw e
		}
	}
}

// reads: every path before and after, and some made up (past the end, missing, into leaves)
function reads(r: R, before: unknown, after: unknown): Key[][] {
	const out = [...every(before), ...every(after)]
	for (let i = 0; i < 10; i++) {
		const base = r.one(out)
		out.push([...base, r.pick(2) ? r.one(NAMES) : r.pick(7)])
	}
	const seen = new Set<string>()
	return out.filter((p) => !seen.has(JSON.stringify(p)) && seen.add(JSON.stringify(p)))
}

Deno.test(`paths fuzz: ${SEEDS} seeds × ${CASES} batches of nested lists: what changed is marked`, () => {
	let marked = 0, changed = 0
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = rand(seed)
		const paths = createPaths<never>()
		for (let c = 0; c < CASES; c++) {
			const before: Record<string, unknown> = {}
			for (const n of NAMES) before[n] = r.pick(4) ? make(r, 3) : { n: 0 }
			const batch: Patch[] = []
			let now: unknown = before
			for (let n = 2 + r.pick(5); n > 0; n--) {
				const p = patch(r, now)
				if (p === undefined) break
				batch.push(p)
				now = apply(now, [p])
			}
			const after = apply(before, batch)
			const ps = reads(r, before, after)
			const id = `case ${c}`
			const spots = new Map<Spot<never>, Key[]>()
			for (const p of ps) spots.set(paths.spot("v", id, p.slice()), p)
			const change = paths.change("v", id)
			const at = `seed ${seed}, ${id}: ${show({ before, batch })}`
			const got = paths.mark("v", id, batch)
			const once = new Set(got)
			assertEquals(once.size, got.length, `${at}: a spot given twice`)
			assert(once.has(change), `${at}: the change spot`)
			for (const s of got) assert(s === change || spots.has(s), `${at}: a spot not made here`)
			// mark is the rule, patch by patch
			for (const [s, p] of spots) {
				assertEquals(once.has(s), batch.some((x) => marks(x, p)), `${at}: ${show(p)}`)
				if (get(before, p) !== get(after, p)) {
					changed++
					assert(once.has(s), `${at}: ${show(p)} changed, not marked`)
				}
				if (once.has(s)) marked++
			}
			// released spots are no longer given; the rest are, as before
			const gone = new Set([...spots.keys()].filter(() => r.pick(2) === 0))
			for (const s of gone) paths.release(s)
			const again = paths.mark("v", id, batch)
			assertEquals(
				new Set(again),
				new Set(got.filter((s) => !gone.has(s))),
				`${at}: after release`,
			)
			// an event: every spot still kept
			const kept = [...spots.keys()].filter((s) => !gone.has(s))
			assertEquals(new Set(paths.event("v", id)), new Set([change, ...kept]), `${at}: event`)
			for (const s of kept) paths.release(s)
			paths.release(change)
		}
		assertEquals(paths.kept(), { keys: 0, spots: 0, steps: 0 }, `seed ${seed}: all released`)
	}
	assert(
		changed > 1000 && marked > changed,
		`the fuzz reaches: ${changed} changed, ${marked} marked`,
	)
})
