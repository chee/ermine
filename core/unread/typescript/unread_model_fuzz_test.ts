// unread against its model (model_harness.ts), on many shapes, a few dozen seeds each: random
// values, flat maps of 10, 1k and 10k names, deep nesting, lists of maps with spans moved, typed
// arrays, strings (spans edited and moved where lone halves meet), the root itself, values handed out and put back in (the same object twice, a read's,
// an undo's), and refusals of every kind after writes that landed. each step: writes, reads,
// keeps (alone, wrapped, in a map that holds itself; handed or not), unwrites, a put again where
// the last write put. nothing handed out changes; the value is copy-on-write apply's; copies
// stay few. a failure prints its shortest steps. what scenario 34 pins is let by (known)
//   deno run --allow-env --allow-read core/unread/typescript/unread_model_fuzz_test.ts [shape…]
//     [--all]   as a program: what fails, by property, shortest first; --all: nothing let by.
//     shapes: the ones here and "spans" (29's shape, often: fails until 29 passes). SEEDS=n
import type { Key } from "@ermine/op/apply"
import { assert } from "@std/assert"
import { rand } from "../../../conformance/typescript/rand.ts"
import {
	at,
	container,
	type Failure,
	fuzz,
	isMap,
	type Options,
	says,
	type Spec,
	type State,
	type Step,
} from "./model_harness.ts"
import { made, patch as randomPatch, text } from "./random_harness.ts"

type P = (n: number) => number
const SEEDS = Number(Deno.env.get("SEEDS") ?? 30)

// every path in v (maps and lists), the first max of them
function paths(v: unknown, max = 4000): Key[][] {
	const out: Key[][] = []
	const walk = (x: unknown, p: Key[]) => {
		if (out.length >= max) return
		out.push(p)
		if (Array.isArray(x)) x.forEach((y, i) => walk(y, [...p, i]))
		else if (isMap(x)) { for (const k of Object.keys(x)) walk(x[k], [...p, k]) }
	}
	walk(v, [])
	return out
}
const one = <T>(p: P, xs: readonly T[]): T => xs[p(xs.length)]

// a patch that is refused, of each kind, on v
function refusal(p: P, v: unknown): Spec {
	const ps = paths(v)
	const maps = ps.filter((x) => isMap(at(v, x)))
	const lists = ps.filter((x) => Array.isArray(at(v, x)))
	const boxes = ps.filter((x) => x.length && container(at(v, x)) && !ArrayBuffer.isView(at(v, x)))
	switch (p(9)) {
		case 0:
			return { raw: one(p, [null, 3, { path: "a" }, { path: [-1] }, { path: [1.5], value: 1 }]) }
		case 1:
			return { raw: { path: ["a"], value: undefined } }
		case 2:
			return { raw: { path: [], value: 1, move: { path: ["a"] } } }
		case 3:
			return { path: ["zz", "q"], value: { data: 1 } }
		case 4:
			return { path: [...(maps.length ? one(p, maps) : []), 0], value: { data: 1 } }
		case 5: {
			const l = lists.length ? one(p, lists) : []
			const n = Array.isArray(at(v, l)) ? (at(v, l) as unknown[]).length : 0
			return p(2) ? { path: l, range: [n + 1, n + 2], value: { data: [] } } : {
				path: l,
				range: [2, 1],
			}
		}
		case 6: {
			if (!boxes.length) return { path: ["zz"], move: { path: ["yy"] } }
			const b = one(p, boxes)
			return { path: [...b, "in"], move: { path: b } }
		}
		case 7:
			// the take lands, the landing is refused
			return boxes.length ? { path: [0], move: { path: one(p, boxes) } } : { raw: null }
		default:
			return { path: maps.length ? one(p, maps) : [], range: [0, 0], value: { data: [] } }
	}
}

// a value put: content, or something handed earlier, or the value an earlier patch put
function given(p: P, s: State, j: number, content: () => unknown): Spec["value"] {
	const k = p(10)
	if (k < 2 && s.handed.length) {
		const r = p(s.handed.length)
		const ps = paths(s.handed[r].thing, 200).filter((x) => container(at(s.handed[r].thing, x)))
		return { ref: r, at: ps.length ? one(p, ps) : [] }
	}
	if (k === 2 && j > 0) return { same: p(j) }
	return { data: content() }
}

// one generic patch from random_harness, as a spec, values sometimes aliased
function generic(p: P, s: State, j: number): Spec {
	const x = randomPatch(p, s.e.value) as Spec & { value?: unknown }
	if ("value" in x) return { ...x, value: given(p, s, j, () => x.value) }
	return x as Spec
}

type Shape = {
	name: string
	start: (p: P) => unknown
	patch: (p: P, s: State, j: number) => Spec
	steps: number
	o?: Options
	// at most this many seeds (big values)
	seeds?: number
}

const name = (i: number) => `n${i}`
function flat(n: number): Shape {
	return {
		name: `flat ${n}`,
		steps: n >= 10000 ? 40 : 80,
		seeds: n >= 10000 ? 6 : undefined,
		o: { every: n >= 1000 ? 8 : 1 },
		start: () => Object.fromEntries(Array.from({ length: n }, (_, i) => [name(i), `id${i}`])),
		patch: (p, s, j) => {
			const keys = Object.keys(s.e.value as object)
			const any = () => keys.length && p(4) ? one(p, keys) : name(p(n + 20))
			switch (p(7)) {
				case 0:
				case 1:
					return { path: [any()], value: { data: `id${p(1e6)}` } }
				case 2:
					return { path: [any()] }
				case 3:
				case 4:
					return { path: [any()], move: { path: [any()] } }
				case 5:
					// a folder in a folder, written into after
					return { path: [any()], value: given(p, s, j, () => ({ a: `id${p(9)}`, b: {} })) }
				default: {
					const deep = paths(s.e.value).filter((x) => x.length > 1 || isMap(at(s.e.value, x)))
					const to = deep.length ? one(p, deep) : [any()]
					return isMap(at(s.e.value, to))
						? { path: [...to, `k${p(4)}`], value: { data: p(9) } }
						: { path: to, value: { data: p(9) } }
				}
			}
		},
	}
}

function tree(p: P, depth: number): unknown {
	if (depth <= 0) return p(3) ? p(100) : p(2) ? `s${p(9)}` : text(p)
	const o: Record<string, unknown> = {}
	for (let i = 0, n = 1 + p(3); i < n; i++) o[`k${p(5)}`] = tree(p, depth - 1 - (p(4) ? 0 : 1))
	return o
}
const deep: Shape = {
	name: "deep",
	steps: 80,
	start: (p) => ({ a: tree(p, 6), b: tree(p, 5), c: tree(p, 4) }),
	patch: (p, s, j) => {
		const ps = paths(s.e.value)
		const boxes = ps.filter((x) => isMap(at(s.e.value, x)))
		const t = one(p, boxes)
		const k = p(6)
		if (k < 2) return { path: [...t, `k${p(6)}`], value: given(p, s, j, () => tree(p, p(3))) }
		if (k === 2) {
			const x = ps.filter((y) => y.length)
			return x.length ? { path: one(p, x) } : { path: [] }
		}
		// a subtree moved up, down or across
		const from = one(p, ps.filter((y) => y.length) as Key[][])
		return from ? { path: [...t, `k${p(6)}`], move: { path: from } } : generic(p, s, j)
	},
}

const lists: Shape = {
	name: "lists of maps",
	steps: 80,
	start: (p) => ({
		l: Array.from({ length: 2 + p(5) }, (_, i) => ({ i, x: { y: p(9) } })),
		m: Array.from({ length: p(4) }, (_, i) => ({ j: i, z: [p(9)] })),
		w: [],
	}),
	patch: (p, s, j) => {
		const v = s.e.value
		const ls = paths(v).filter((x) => Array.isArray(at(v, x)))
		const l = one(p, ls), list = at(v, l) as unknown[]
		const a = p(list.length + 1), b = a + p(list.length - a + 1)
		const k = p(8)
		if (k === 0) {
			return { path: l, range: [a, b], value: given(p, s, j, () => [{ n: p(9) }, { n: p(9) }]) }
		}
		if (k === 1) return { path: l, range: [a, b] }
		if (k === 2 || k === 3) {
			// a span into a list (ranged), or as a new list (29's shape), from another or the same
			const src = one(p, ls), sl = at(v, src) as unknown[]
			const c = p(sl.length + 1), d = c + p(sl.length - c + 1)
			const i = p(list.length + 1)
			if (k === 2) return { path: l, range: [i, i], move: { path: src, range: [c, d] } }
			return { path: [`s${p(3)}`], move: { path: src, range: [c, d] } }
		}
		if (k === 4 && list.length) {
			// an element out to a map key, or into another list
			return p(2)
				? { path: [`e${p(3)}`], move: { path: [...l, p(list.length)] } }
				: { path: one(p, ls), range: [0, 0], move: { path: [...l, p(list.length)] } }
		}
		const into = paths(v).filter((x) => x.length > 1)
		return into.length
			? { path: one(p, into), value: given(p, s, j, () => p(9)) }
			: generic(p, s, j)
	},
}

const KINDS = [Int8Array, Uint16Array, Int32Array, Float32Array, Float64Array, Uint32Array] as const
const typedShape: Shape = {
	name: "typed arrays",
	steps: 80,
	start: () => ({
		t: new Int16Array([1, 2, 3]),
		u: [new Float64Array([0.5, -0]), new Int32Array([7])],
		m: { f: new Uint16Array([9, 8]), b: new Uint8Array([1, 2]) },
	}),
	patch: (p, s, j) => {
		const v = s.e.value
		const ts = paths(v).filter((x) => {
			const y = at(v, x)
			return ArrayBuffer.isView(y) && !(y instanceof Uint8Array)
		})
		const k = p(6)
		if (k < 3 && ts.length) {
			const t = one(p, ts), arr = at(v, t) as Int16Array
			const a = p(arr.length + 1), b = a + p(arr.length - a + 1)
			const C = arr.constructor as Int16ArrayConstructor
			// same length (in place), or not (a new one)
			const n = k === 0 ? b - a : p(3)
			return {
				path: t,
				range: [a, b],
				value: { data: new C(Array.from({ length: n }, () => p(50))) },
			}
		}
		if (k === 3) {
			const C = one(p, KINDS)
			return {
				path: [`t${p(4)}`],
				value: given(p, s, j, () => new C(Array.from({ length: 1 + p(3) }, () => p(50)))),
			}
		}
		if (k === 4 && ts.length) return { path: [`t${p(4)}`], move: { path: one(p, ts) } }
		return generic(p, s, j)
	},
}

// strings: spans written over, taken out, moved within one and across, where pairs, modifiers and
// lone halves sit (a lone high and a lone low that meet are one code point)
const strings: Shape = {
	name: "strings",
	steps: 80,
	start: (p) => ({ s: text(p, 6), t: [text(p, 6), text(p, 6)], m: { u: text(p, 6) } }),
	patch: (p, s, j) => {
		const v = s.e.value
		const ss = paths(v).filter((x) => typeof at(v, x) === "string")
		if (!ss.length) return { path: [`s${p(3)}`], value: given(p, s, j, () => text(p, 6)) }
		const l = one(p, ss), n = [...(at(v, l) as string)].length
		const a = p(n + 1), b = a + p(n - a + 1)
		const k = p(6)
		if (k < 2) return { path: l, range: [a, b], value: { data: text(p, 3) } }
		if (k === 2) return { path: l, range: [a, b] }
		if (k === 3) {
			const f = p(2) ? l : one(p, ss), m = [...(at(v, f) as string)].length
			const c = p(m + 1), d = c + p(m - c + 1)
			const i = p(n + 1)
			return { path: l, range: [i, i + p(2)], move: { path: f, range: [c, d] } }
		}
		if (k === 4) return { path: [`s${p(3)}`], move: { path: l, range: [a, b] } }
		return generic(p, s, j)
	},
}

const root: Shape = {
	name: "the root",
	steps: 60,
	start: (p) => one(p, [[1, [2], { a: 3 }], { a: { b: [] } }, "text", 5, new Int16Array([1])]),
	patch: (p, s, j) => {
		const k = p(6)
		if (k === 0) return { path: [], value: given(p, s, j, () => made(p, 3)) }
		if (k === 1) return { path: [] }
		const ps = paths(s.e.value).filter((x) => x.length)
		if (k === 2 && ps.length) return { path: [], move: { path: one(p, ps) } }
		return generic(p, s, j)
	},
}

// 29's shape, often: spans moved out of lists landing as new lists (unranged), kept handed, written
// under, their parents taken out and put back
export const spans: Shape = {
	name: "spans",
	steps: 60,
	start: () => ({ l: [{ x: 0 }, { x: 0 }, { x: 0 }], p: {} }),
	patch: (p, s, j) => {
		const v = s.e.value
		const all = paths(v)
		const lists = all.filter((x) => Array.isArray(at(v, x)) && (at(v, x) as unknown[]).length)
		const k = p(6)
		if (k === 0 && lists.length) {
			const l = one(p, lists), n = (at(v, l) as unknown[]).length
			const a = p(n), b = a + 1 + p(n - a)
			return {
				path: [one(p, ["p", "q"]), `w${p(2)}`].slice(p(2)),
				move: { path: l, range: [a, b] },
			}
		}
		if (k === 1) {
			const maps = all.filter((x) => isMap(at(v, x)) && x.length)
			return maps.length ? { path: one(p, maps) } : { path: ["p"], value: { data: {} } }
		}
		if (k === 2 && !isMap(at(v, ["p"]))) return { path: ["p"], value: { data: {} } }
		const xs = all.filter((x) => x[x.length - 1] === "x")
		return xs.length ? { path: one(p, xs), value: { data: p(99) } } : generic(p, s, j)
	},
}

const random: Shape = {
	name: "random",
	steps: 80,
	start: (p) => {
		const v = made(p, 3)
		return isMap(v) ? v : { a: v, b: made(p, 2), c: made(p, 2) }
	},
	patch: generic,
}

// handed values put back, written into, put twice
const alias: Shape = {
	name: "aliasing",
	steps: 80,
	start: () => ({ a: { x: [1, { y: 2 }] }, b: [{ z: 3 }], c: { d: { e: {} } } }),
	patch: (p, s, j) => {
		const ps = paths(s.e.value)
		const maps = ps.filter((x) => isMap(at(s.e.value, x)))
		if (p(2)) {
			const g = given(p, s, j, () => ({ q: [p(9)], r: { t: p(9) } }))
			if (maps.length) return { path: [...one(p, maps), `k${p(4)}`], value: g }
		}
		return generic(p, s, j)
	},
}

export const SHAPES: Shape[] = [
	random,
	flat(10),
	flat(1000),
	flat(10000),
	deep,
	lists,
	typedShape,
	strings,
	root,
	alias,
]

// the next step: mostly writes; reads, keeps, unwrites, refusals and puts again between
function next(sh: Shape, p: P) {
	return (s: State, i: number): Step => {
		const k = p(100)
		const v = s.e.value
		if (v === undefined && k >= 8) {
			return { k: "write", ps: [{ path: [], value: { data: { a: 1 } } }] }
		}
		if (k < 8) return { k: "read" }
		if (k < 20) {
			const ps = paths(v, 2000)
			const path = one(p, ps)
			const handed = p(2) ? [] : Array.from({ length: 1 + p(3) }, () => {
				// what is at path, above it, or under it
				const q = one(p, ps)
				return p(2) ? path.slice(0, p(path.length + 1)) : q
			})
			return { k: "kept", path, wrap: p(3), handed }
		}
		if (k < 27) return { k: "unwrite" }
		if (k < 35) return { k: "again", value: p(1000) }
		const n = 1 + p(3)
		const ps: Spec[] = []
		for (let j = 0; j < n; j++) ps.push(sh.patch(p, s, j))
		// a refusal after what landed
		if (k < 45) ps.splice(p(ps.length + 1), 0, refusal(p, v))
		void i
		return { k: "write", ps }
	}
}

export type Found = { shape: string; seed: number; failure: Failure; shrunk: Step[] }

export function sweep(
	shapes: Shape[],
	seeds: number,
	known?: Options["known"],
	seen?: Map<string, number>,
): Found[] {
	const found: Found[] = []
	for (const sh of shapes) {
		for (let seed = 1; seed <= Math.min(seeds, sh.seeds ?? seeds); seed++) {
			const p = rand(seed * 7919 + sh.name.length)
			const value = sh.start(p)
			const r = fuzz(value, sh.steps, next(sh, p), { ...sh.o, known, seen })
			if (r) found.push({ shape: sh.name, seed, failure: r.failure, shrunk: r.shrunk })
		}
	}
	return found
}

export function report(found: Found[], value: (f: Found) => unknown): string {
	return found.map((f) =>
		`${f.shape}, seed ${f.seed}: ${f.failure.property} at step ${f.failure.at}: ${f.failure.why}\n  start ${
			says({ k: "write", ps: [{ path: [], value: { data: value(f) } }] })
		}\n${f.shrunk.map((s) => "  " + says(s)).join("\n")}`
	).join("\n\n")
}

// what the failing scenarios pin, told apart so the rest is seen: a refused write that leaves a
// typed array at the root changed (34). --all: none
export const known: Options["known"] = (f, s) =>
	f.property === "refused-changes" && ArrayBuffer.isView(s.e.value)

if (import.meta.main) {
	const only = Deno.args.filter((a) => !a.startsWith("--"))
	const shapes = only.length ? [...SHAPES, spans].filter((s) => only.includes(s.name)) : SHAPES
	const seen = new Map<string, number>()
	const found = sweep(shapes, SEEDS, Deno.args.includes("--all") ? undefined : known, seen)
	console.log(`known met: ${[...seen].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`)
	const firsts = new Map<string, Found>()
	for (const f of found) {
		const key = `${f.failure.property}`
		const was = firsts.get(key)
		if (!was || f.shrunk.length < was.shrunk.length) firsts.set(key, f)
	}
	console.log(`${found.length} failing runs; by property: ${[...firsts.keys()]}`)
	for (const f of firsts.values()) {
		const sh = [...SHAPES, spans].find((s) => s.name === f.shape)!
		console.log(report([f], () => sh.start(rand(f.seed * 7919 + sh.name.length))))
	}
}

Deno.test("unread: against copy-on-write apply on many shapes; nothing handed out changes", () => {
	const found = sweep(SHAPES, SEEDS, known)
	assert(
		found.length === 0,
		report(found, (f) => {
			const sh = [...SHAPES, spans].find((s) => s.name === f.shape)!
			return sh.start(rand(f.seed * 7919 + sh.name.length))
		}),
	)
})
