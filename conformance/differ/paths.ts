// paths' streams: for a few keys, a random value's paths (and some made up) spotted, plain or keys
// reads, the change spot, the key's event now and then, then a batch of patches apply takes
// marked; the rule asked of each patch (marks); events, releases and kept between
// (paths_harness_test.ts's values and patches, copied). sources and ids strings and symbols.
// wild: -0 and 1e15 as indices, a path not a list, keys of the wrong kind, malformed patches, a
// mark with no patches
// deno-lint-ignore-file no-explicit-any
// the properties, each implementation on its own: a change under a read marks it (marks: a place
// at or under a plain read's path, the read's path or one key more unranged for a keys read; mark:
// every spot at or above a place, the change spot first); event and kept are a model's of the
// spots kept (model, below): event the change spot, then each step's spot, its keys spot, then
// its kids, in the order the kid steps were made (a step let go and made again last)
import apply from "@ermine/op/apply"
import type { Key, Patch } from "@ermine/op/apply"
import {
	type Answer,
	differs,
	firsts,
	type Generator,
	picker,
	type Request,
	show,
	type Violation,
} from "./kit.ts"

type Rand = ReturnType<typeof picker>
const NAMES = ["a", "b", "c", "d"]
const CHARS = ["x", "y", "é", "😀"]
const MISSING = Symbol("missing")
const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype
const typed = (v: unknown): v is Int16Array => v instanceof Int16Array
const size = (v: unknown) =>
	typeof v === "string" ? [...v].length : (v as ArrayLike<unknown>).length

function get(v: unknown, path: readonly Key[]): unknown {
	if (v === undefined) return MISSING
	for (const k of path) {
		if (Array.isArray(v) && typeof k === "number" && k < v.length) v = v[k]
		else if (isMap(v) && typeof k === "string" && Object.hasOwn(v, k)) v = v[k]
		else return MISSING
	}
	return v
}
function make(r: Rand, depth: number): unknown {
	const k = r.pick(depth > 0 ? 9 : 4)
	if (k === 0) return r.pick(5)
	if (k === 1) return Array.from({ length: r.pick(4) }, () => r.one(CHARS)).join("")
	if (k === 2) return Int16Array.from({ length: r.pick(4) }, () => r.pick(9))
	if (k === 3) return null
	if (k < 6) return Array.from({ length: r.pick(5) }, () => make(r, depth - 1))
	const m: Record<string, unknown> = {}
	for (const n of NAMES) if (r.pick(2)) m[n] = make(r, depth - 1)
	return m
}
function run(r: Rand, v: unknown): unknown {
	const n = r.pick(3)
	if (typeof v === "string") return Array.from({ length: n }, () => r.one(CHARS)).join("")
	if (typed(v)) return Int16Array.from({ length: n }, () => r.pick(9))
	return Array.from({ length: n }, () => make(r, 1))
}
function every(v: unknown, at: Key[] = [], out: Key[][] = []): Key[][] {
	if (v === undefined) return out
	out.push(at)
	if (Array.isArray(v)) v.forEach((x, i) => every(x, [...at, i], out))
	else if (isMap(v)) { for (const k of Object.keys(v)) every(v[k], [...at, k], out) }
	return out
}
const sequence = (v: unknown) => typeof v === "string" || Array.isArray(v) || typed(v)
function span(r: Rand, v: unknown): [number, number] {
	const n = size(v), a = r.pick(n + 1)
	return [a, a + r.pick(n - a + 1)]
}
function patch(r: Rand, v: unknown): Patch | undefined {
	const all = every(v)
	for (let tries = 0; tries < 30; tries++) {
		const at = r.one(all.length ? all : [[]])
		const there = get(v, at)
		const k = r.pick(10)
		let p: Patch
		if (k < 2) p = { path: at, value: make(r, 2) }
		else if (k < 3 && isMap(there)) p = { path: [...at, r.one(NAMES)], value: make(r, 1) }
		else if (k < 5) p = { path: at.length || r.pick(4) === 0 ? at : [r.one(NAMES)] }
		else if (k < 7 && sequence(there)) {
			p = { path: at, range: span(r, there) }
			if (r.pick(3)) p.value = run(r, there)
		} else {
			const to = r.one(all.length ? all : [[]]), dest = get(v, to)
			const take = sequence(there) && r.pick(2)
				? { path: at, range: span(r, there) }
				: { path: at }
			if (sequence(dest) && r.pick(2)) p = { path: to, range: span(r, dest), move: take }
			else if (isMap(dest) && r.pick(2)) p = { path: [...to, r.one(NAMES)], move: take }
			else p = { path: to, move: take }
		}
		try {
			apply(v, [p])
			return p
		} catch {
			continue
		}
	}
}
function reads(r: Rand, v: unknown): Key[][] {
	const out = every(v)
	for (let i = 0; i < 6; i++) {
		const n = r.pick(4)
		out.push(Array.from({ length: n }, () => r.pick(2) ? r.one(NAMES) : r.pick(6)))
	}
	const seen = new Set<string>()
	return out.filter((p) => !seen.has(JSON.stringify(p)) && seen.add(JSON.stringify(p)))
}
// typed arrays are leaves to the rule: sent as a map
const sent = (p: Patch): Patch =>
	JSON.parse(JSON.stringify(p, (_, x) => typed(x) ? { typed: [...x] } : x))

const SOURCES: unknown[] = ["v", { symbol: "v" }, "w"]

const generator: Generator = {
	streams(seed, o) {
		const r = picker(seed)
		const out: Request[] = []
		for (let c = 0; c < 4; c++) {
			const source = r.one(SOURCES), id = `n${c % 3}`
			const before = r.pick(8) === 0 ? make(r, 0) : make(r, 3)
			const batch: Patch[] = []
			let now = before
			for (let n = 1 + r.pick(3); n > 0; n--) {
				const p = patch(r, now)
				if (p === undefined) break
				batch.push(p)
				now = apply(now, [p])
			}
			const paths = reads(r, before)
			for (const path of paths) {
				if (r.pick(3) === 0) continue
				out.push({ op: "spot", source, id, path, ...(r.pick(3) === 0 ? { keys: true } : {}) })
			}
			if (r.pick(4)) out.push({ op: "change", source, id })
			if (r.pick(2)) out.push({ op: "event", source, id })
			if (r.pick(3) === 0) out.push({ op: "kept" })
			out.push({ op: "mark", source, id, patches: batch.map(sent) })
			for (const p of batch) {
				out.push({ op: "marks", patch: sent(p), paths, ...(r.pick(2) ? { keys: true } : {}) })
			}
			for (let i = r.pick(4); i > 0; i--) {
				const path = r.one(paths)
				out.push(
					r.pick(5) === 0
						? { op: "release", source, id }
						: { op: "release", source, id, path, ...(r.pick(3) === 0 ? { keys: true } : {}) },
				)
			}
			if (r.pick(2)) out.push({ op: "event", source: r.one(SOURCES), id: `n${r.pick(3)}` })
			out.push({ op: "kept" })
			if (o.wild) {
				out.push(
					r.one<Request>([
						{ op: "spot", source, id, path: ["a", -0] },
						{ op: "spot", source, id, path: [1e15] },
						{ op: "spot", source, id, path: [1.5] },
						{ op: "spot", source, id, path: "a" },
						{ op: "spot", source, id },
						{ op: "spot", source: 1, id, path: [] },
						{ op: "mark", source, id },
						{ op: "mark", source, id, patches: [{ path: "a" }] },
						{ op: "mark", source, id, patches: [{ path: ["a", -0], value: 1 }] },
						{ op: "marks", paths: [[]] },
						{ op: "marks", patch: { path: [0] }, paths: [[-0], ["a"]] },
					]),
					{ op: "kept" },
				)
			}
		}
		return [out]
	},
	invariant(stream, answers) {
		const out: Violation[] = []
		const no = (kind: string, at: number, why: string) => out.push({ kind, at, why })
		const m = model()
		let stopped = false
		stream.forEach((r, i) => {
			const a = answers[i]
			if (!a || a.error !== undefined) return
			if (r.op === "marks" && Array.isArray(r.paths) && Array.isArray(a.marks)) {
				const ps = places(r.patch)
				r.paths.forEach((p: unknown, j: number) => {
					if (!Array.isArray(p) || a.marks[j] === true) return
					const hit = ps.find((q) =>
						r.keys === true
							? same(q.path, p) || (q.path.length === p.length + 1 && !q.ranged &&
								under(p, q.path))
							: under(p, q.path)
					)
					if (hit) {
						no(
							"a change under a read does not mark it",
							i,
							`${show(r.patch)} at ${show(hit.path)}, ${
								r.keys === true ? "keys " : ""
							}read ${show(p)}: false`,
						)
					}
				})
			}
			if (stopped) return
			const want = m(r)
			if (want === undefined) return
			if (r.op === "mark") {
				const spots = a.spots as unknown[]
				const has = new Set(spots.map(show))
				const need = want.spots.filter((s: unknown) => !has.has(show(s)))
				const extra = spots.filter((s) => !want.kept.has(show(s)))
				if (spots.length !== has.size) no("mark gives a spot twice", i, show(spots))
				if (want.change && spots[0] !== "change") {
					no("mark gives the change spot not first", i, show(spots))
				}
				if (need.length || extra.length) {
					no(
						"a change under a spot does not mark it",
						i,
						`${show(spots)}: missing ${show(need)}, not kept ${show(extra)}`,
					)
				}
			} else if (differs(a, want)) {
				no(`${r.op} unlike the model`, i, `${show(a)}, model ${show(want)}`)
				stopped = true
			}
		})
		return Promise.resolve(firsts(out))
	},
}
export default generator

// a path's keys compared: -0 is 0, 1 and "1" differ
const step = (k: unknown) => show(Object.is(k, -0) ? 0 : k)
const same = (a: unknown[], b: unknown[]) =>
	a.length === b.length && a.every((k, i) => step(k) === step(b[i]))
// a is b or above it
const under = (a: unknown[], b: unknown[]) =>
	a.length <= b.length && a.every((k, i) => step(k) === step(b[i]))
// a patch's places: a move's take and landing, else its own
function places(p: any): { path: unknown[]; ranged: boolean }[] {
	if (p === null || typeof p !== "object" || !Array.isArray(p.path)) return []
	const own = { path: p.path, ranged: Array.isArray(p.range) }
	const m = p.move
	if (m !== null && typeof m === "object" && Array.isArray(m.path)) {
		return [{ path: m.path, ranged: Array.isArray(m.range) }, own]
	}
	return [own]
}

// the spots kept, per key a trie of steps: a step kept while a spot is at or under it, its kids
// in the order made. given an answered request (no error), what the model says of it: the answer
// for event and kept; for mark, what it must give; undefined: not compared
function model(): (r: Request) => any {
	type Step = { path: unknown[]; spot: boolean; keys: boolean; kids: Map<string, Step> }
	type Root = { change: boolean; top: Step }
	const roots = new Map<string, Root>()
	const name = (r: Request) => show([r.source, r.id])
	const fresh = (path: unknown[]): Step => ({ path, spot: false, keys: false, kids: new Map() })
	const empty = (s: Step) => !s.spot && !s.keys && s.kids.size === 0
	function walk(root: Root, path: unknown[], make: boolean): Step[] | undefined {
		const line = [root.top]
		for (const [i, k] of path.entries()) {
			const up = line[line.length - 1]
			let s = up.kids.get(step(k))
			if (!s) {
				if (!make) return
				up.kids.set(
					step(k),
					s = fresh(path.slice(0, i + 1).map((k) => Object.is(k, -0) ? 0 : k)),
				)
			}
			line.push(s)
		}
		return line
	}
	function wholly(s: Step, out: unknown[]) {
		if (s.spot) out.push(s.path)
		if (s.keys) out.push({ keys: s.path })
		for (const k of s.kids.values()) wholly(k, out)
		return out
	}
	const spots = (root?: Root) =>
		root ? [...(root.change ? ["change"] : []), ...wholly(root.top, [])] : []
	const tidy = (r: Request) => {
		const root = roots.get(name(r))
		if (root && !root.change && empty(root.top)) roots.delete(name(r))
	}
	return (r) => {
		const root = () => {
			if (!roots.has(name(r))) roots.set(name(r), { change: false, top: fresh([]) })
			return roots.get(name(r))!
		}
		switch (r.op) {
			case "spot": {
				if (!Array.isArray(r.path)) return
				const s = walk(root(), r.path, true)!.at(-1)!
				if (r.keys === true) s.keys = true
				else s.spot = true
				return
			}
			case "change":
				root().change = true
				return
			case "release": {
				const at = roots.get(name(r))
				if (!at) return
				if (r.path === undefined) at.change = false
				else if (Array.isArray(r.path)) {
					const line = walk(at, r.path, false)
					if (line) {
						const s = line.at(-1)!
						if (r.keys === true) s.keys = false
						else s.spot = false
						for (let i = line.length - 1; i > 0 && empty(line[i]); i--) {
							line[i - 1].kids.delete(step(r.path[i - 1]))
						}
					}
				}
				tidy(r)
				return
			}
			case "event":
				return { spots: spots(roots.get(name(r))) }
			case "mark": {
				const at = roots.get(name(r))
				const kept = new Set(spots(at).map(show))
				const want: unknown[] = at?.change ? ["change"] : []
				for (const p of Array.isArray(r.patches) ? r.patches : []) {
					for (const q of places(p)) {
						// the place's step and those above it, as far as they are kept
						let s: Step | undefined = at?.top
						for (const k of [...q.path, null]) {
							if (!s) break
							if (s.spot && !want.some((w) => show(w) === show(s!.path))) want.push(s.path)
							s = k === null ? undefined : s.kids.get(step(k))
						}
					}
				}
				return { spots: want, kept, change: at?.change === true }
			}
			case "kept": {
				let spotsN = 0, steps = 0
				const count = (s: Step) => {
					steps++
					spotsN += (s.spot ? 1 : 0) + (s.keys ? 1 : 0)
					for (const k of s.kids.values()) count(k)
				}
				for (const at of roots.values()) {
					if (at.change) spotsN++
					count(at.top)
				}
				return { keys: roots.size, spots: spotsN, steps }
			}
		}
	}
}
