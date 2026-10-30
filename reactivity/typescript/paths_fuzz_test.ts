// Fuzzes tracked paths against op in process: nested lists and maps, batches of patches, splices,
// shifting removals. On copy-on-write values, a read whose value is a new reference must be marked.
import { assert, assertEquals } from "@std/assert"
import apply, { ApplyError, type Key, type Patch } from "@ermine/changeable/apply"
import { createPaths, marks, type Spot } from "./paths.ts"
import { isMap, rand, show } from "../../conformance/typescript/gen.ts"

const SEEDS = 40
const CASES = 25
const NAMES = ["a", "b", "c"]
const MISSING = Symbol("missing")

type R = ReturnType<typeof rand>

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
			const l = r.one(lists)
			p = r.pick(3)
				? { path: l, range: spanOf(l), value: items(r) }
				: { path: l, range: spanOf(l) }
		} else if (k < 3 && elems.length) p = { path: r.one(elems) } // a removal: the rest shift
		else if (k < 4 && elems.length) p = { path: r.one(elems), value: make(r, 1) }
		else if (k < 6 && lists.length) {
			const l = r.one(lists), s = spanOf(l)
			const g = gap(l, s[1] - s[0])
			p = { path: l, range: [g, g], move: { path: l, range: s } }
		} else if (k < 8 && lists.length) {
			const from = r.one(lists), to = r.one(lists), a = gap(to), b = r.pick(2) ? a : gap(to)
			p = {
				path: to,
				range: [Math.min(a, b), Math.max(a, b)],
				move: { path: from, range: spanOf(from) },
			}
		} else if (k < 10 && elems.length && lists.length) {
			const to = r.one(lists), g = gap(to)
			p = { path: to, range: [g, g], move: { path: r.one(elems) } }
		} else if (k < 11 && elems.length && maps.length) {
			const l = r.one(lists.length ? lists : [[]])
			const take = r.pick(2) || !lists.length
				? { path: r.one(elems) }
				: { path: l, range: spanOf(l) }
			p = { path: [...r.one(maps), r.one(NAMES)], move: take }
		} else if (k < 12 && keys.length && lists.length) {
			const to = r.one(lists), g = gap(to)
			p = { path: to, range: [g, g], move: { path: r.one(keys) } }
		} else if (k < 13 && elems.length) {
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
			const heres = new Map<Spot<never>, Key[]>()
			for (const p of ps) heres.set(paths.spot("v", id, p.slice(), false, true), p)
			const change = paths.change("v", id)
			const at = `seed ${seed}, ${id}: ${show({ before, batch })}`
			const got = paths.mark("v", id, batch)
			const once = new Set(got)
			assertEquals(once.size, got.length, `${at}: a spot given twice`)
			assert(once.has(change), `${at}: the change spot`)
			for (const s of got) {
				assert(s === change || spots.has(s) || heres.has(s), `${at}: a spot not made here`)
			}
			const itself = (v: unknown) => isMap(v) ? "a map" : JSON.stringify(v)
			for (const [s, p] of heres) {
				assertEquals(
					once.has(s),
					batch.some((x) => marks(x, p, false, true)),
					`${at}: here ${show(p)}`,
				)
				if (itself(get(before, p)) !== itself(get(after, p))) {
					assert(once.has(s), `${at}: here ${show(p)} changed, not marked`)
				}
			}
			for (const [s, p] of spots) {
				assertEquals(once.has(s), batch.some((x) => marks(x, p)), `${at}: ${show(p)}`)
				if (get(before, p) !== get(after, p)) {
					changed++
					assert(once.has(s), `${at}: ${show(p)} changed, not marked`)
				}
				if (once.has(s)) marked++
			}
			for (const s of heres.keys()) paths.release(s)
			const gone = new Set([...spots.keys()].filter(() => r.pick(2) === 0))
			for (const s of gone) paths.release(s)
			const again = paths.mark("v", id, batch)
			assertEquals(
				new Set(again),
				new Set(got.filter((s) => !gone.has(s) && !heres.has(s))),
				`${at}: after release`,
			)
			const still = [...spots.keys()].filter((s) => !gone.has(s))
			assertEquals(new Set(paths.event("v", id)), new Set([change, ...still]), `${at}: event`)
			for (const s of still) paths.release(s)
			paths.release(change)
		}
		assertEquals(paths.held(), { keys: 0, spots: 0, steps: 0 }, `seed ${seed}: all released`)
	}
	assert(
		changed > 1000 && marked > changed,
		`the fuzz reaches: ${changed} changed, ${marked} marked`,
	)
})
