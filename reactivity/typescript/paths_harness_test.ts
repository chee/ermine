// paths on whichever harness HARNESS names (default: paths_harness.ts), by the fuzzers; the
// scenarios are run by conformance/run.ts. Spots compare as sets with the rule; with HARNESS set,
// the reference is asked too and every answer is the same, spots in the same order.
//
// The oracle fuzz needs no second implementation: on copy-on-write values (op's apply), a read
// whose value is a new reference after the patches must be marked; and a single patch at a list
// of objects never reused marks an index read (inside the list, before or after) exactly when
// what is there changed.
import { assert, assertEquals } from "@std/assert"
import apply from "@ermine/changeable/apply"
import type { Key, Patch } from "@ermine/changeable/apply"
import { ask as send, command, reference } from "../../conformance/typescript/ask.ts"
import { rand as seeded } from "../../conformance/typescript/rand.ts"

type Request = Record<string, unknown> & { op: string }
type Shown = readonly Key[] | { keys: readonly Key[] } | "change"

async function ask(requests: Request[]): Promise<Record<string, unknown>[]> {
	const answers = await send(command("paths"), requests)
	assertEquals(answers.length, requests.length, "an answer per request")
	if (Deno.env.get("HARNESS")) {
		const want = await send(reference("paths"), requests)
		answers.forEach((a, i) =>
			assertEquals(JSON.stringify(a), JSON.stringify(want[i]), JSON.stringify(requests[i]))
		)
	}
	return answers
}

// a set of spots, in one order
const sorted = (spots: unknown) => (spots as Shown[]).map((s) => JSON.stringify(s)).sort()

// fuzzing: a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40

function rand(seed: number) {
	const pick = seeded(seed)
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	return { pick, one }
}
type Rand = ReturnType<typeof rand>

const NAMES = ["a", "b", "c", "d"]
const CHARS = ["x", "y", "é", "😀"]
const MISSING = Symbol("missing")
const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype
const typed = (v: unknown): v is Int16Array => v instanceof Int16Array
// positions: code points, as apply counts them
const size = (v: unknown) =>
	typeof v === "string" ? [...v].length : (v as ArrayLike<unknown>).length

// what a read of path got: only lists and maps are walked into (strings and typed arrays are
// leaves), as apply walks
function get(v: unknown, path: readonly Key[]): unknown {
	if (v === undefined) return MISSING
	for (const k of path) {
		if (Array.isArray(v) && typeof k === "number" && k < v.length) v = v[k]
		else if (isMap(v) && typeof k === "string" && Object.hasOwn(v, k)) v = v[k]
		else return MISSING
	}
	return v
}

// a value: maps, lists, strings, typed arrays, numbers; every list item a new one
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
// a run of new positions for a sequence like v
function run(r: Rand, v: unknown): unknown {
	const n = r.pick(3)
	if (typeof v === "string") return Array.from({ length: n }, () => r.one(CHARS)).join("")
	if (typed(v)) return Int16Array.from({ length: n }, () => r.pick(9))
	return Array.from({ length: n }, () => make(r, 1))
}

// every path in v, [] included
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

// one patch apply takes on v, or none found
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
			// a move: an unranged or ranged take, landing unranged or in a span
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

// read paths: every path in v, and some made up (missing, wrong kind, into leaves)
function reads(r: Rand, v: unknown): Key[][] {
	const out = every(v)
	for (let i = 0; i < 12; i++) {
		const n = r.pick(4)
		out.push(Array.from({ length: n }, () => r.pick(2) ? r.one(NAMES) : r.pick(6)))
	}
	const seen = new Set<string>()
	return out.filter((p) => !seen.has(JSON.stringify(p)) && seen.add(JSON.stringify(p)))
}

// typed arrays are leaves to the rule: sent as a map
const sent = (p: Patch): Patch =>
	JSON.parse(JSON.stringify(p, (_, x) => typed(x) ? { typed: [...x] } : x))

Deno.test(`fuzz: ${SEEDS} seeds, what changed is marked, and the index agrees with marks`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = rand(seed)
		const requests: Request[] = []
		const cases: { before: unknown; after: unknown; batch: Patch[]; paths: Key[][] }[] = []
		for (let c = 0; c < 25; c++) {
			const before = r.pick(8) === 0 ? make(r, 0) : make(r, 3)
			const batch: Patch[] = []
			let now = before
			for (let n = 1 + r.pick(3); n > 0; n--) {
				const p = patch(r, now)
				if (p === undefined) break
				batch.push(p)
				now = apply(now, [p])
			}
			const after = apply(before, batch)
			const paths = reads(r, before)
			const id = `case ${c}`
			cases.push({ before, after, batch, paths })
			for (const path of paths) requests.push({ op: "spot", source: "v", id, path })
			requests.push({ op: "change", source: "v", id })
			requests.push({ op: "mark", source: "v", id, patches: batch.map(sent) })
			for (const p of batch) requests.push({ op: "marks", patch: sent(p), paths })
		}
		const answers = await ask(requests)
		let i = 0
		for (const { before, after, batch, paths } of cases) {
			i += paths.length + 1
			const at = `seed ${seed}: ${JSON.stringify({ before, batch: batch.map(sent) })}`
			const marked = new Set(sorted(answers[i++].spots))
			assert(marked.has('"change"'), `${at}: the change spot`)
			const any = new Set<string>(['"change"'])
			for (const _ of batch) {
				const m = answers[i++].marks as boolean[]
				paths.forEach((p, j) => m[j] && any.add(JSON.stringify(p)))
			}
			assertEquals([...marked].sort(), [...any].sort(), `${at}: mark and marks agree`)
			for (const p of paths) {
				if (get(before, p) === get(after, p)) continue
				assert(marked.has(JSON.stringify(p)), `${at}: ${JSON.stringify(p)} changed, not marked`)
			}
		}
	}
})

// the keys at a value: a map's names, a list's length; a leaf or nothing has none
const shape = (v: unknown) =>
	isMap(v) ? JSON.stringify(Object.keys(v).sort()) : Array.isArray(v) ? `list ${v.length}` : "none"

Deno.test(`fuzz: ${SEEDS} seeds, a keys read is marked when its keys changed, and agrees with marks`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = rand(seed + 3000)
		const requests: Request[] = []
		const cases: { before: unknown; after: unknown; batch: Patch[]; paths: Key[][] }[] = []
		for (let c = 0; c < 25; c++) {
			const before = r.pick(8) === 0 ? make(r, 0) : make(r, 3)
			const batch: Patch[] = []
			let now = before
			for (let n = 1 + r.pick(3); n > 0; n--) {
				const p = patch(r, now)
				if (p === undefined) break
				batch.push(p)
				now = apply(now, [p])
			}
			const after = apply(before, batch)
			const paths = reads(r, before)
			const id = `case ${c}`
			cases.push({ before, after, batch, paths })
			for (const path of paths) requests.push({ op: "spot", source: "v", id, path, keys: true })
			requests.push({ op: "mark", source: "v", id, patches: batch.map(sent) })
			for (const p of batch) requests.push({ op: "marks", patch: sent(p), paths, keys: true })
		}
		const answers = await ask(requests)
		let i = 0
		for (const { before, after, batch, paths } of cases) {
			i += paths.length
			const at = `seed ${seed}: ${JSON.stringify({ before, batch: batch.map(sent) })}`
			const marked = new Set(sorted(answers[i++].spots))
			const any = new Set<string>()
			for (const _ of batch) {
				const m = answers[i++].marks as boolean[]
				paths.forEach((p, j) => m[j] && any.add(JSON.stringify({ keys: p })))
			}
			assertEquals([...marked].sort(), [...any].sort(), `${at}: mark and marks agree`)
			for (const p of paths) {
				if (shape(get(before, p)) === shape(get(after, p))) continue
				assert(
					marked.has(JSON.stringify({ keys: p })),
					`${at}: keys of ${JSON.stringify(p)} changed, not marked`,
				)
			}
		}
	}
})

Deno.test(`fuzz: ${SEEDS} seeds, a list of new objects: an index read is marked when it changed`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = rand(seed + 1000)
		const requests: Request[] = []
		const cases: { before: unknown[]; after: unknown[]; p: Patch; at: Key[] }[] = []
		const item = () => ({ n: r.pick(100) })
		for (let c = 0; c < 30; c++) {
			const before = Array.from({ length: r.pick(7) }, item)
			const at: Key[] = r.pick(2) ? ["l"] : ["a", 0, "l"]
			const value = at.length === 1 ? { l: before } : { a: [{ l: before }] }
			const n = before.length, k = r.pick(Math.max(n, 1))
			const s = span(r, before)
			const pick = r.pick(4)
			const p: Patch = pick === 0 && n
				? { path: [...at, k] }
				: pick === 1 && n
				? { path: [...at, k], value: item() }
				: r.pick(2)
				? { path: at, range: s, value: Array.from({ length: r.pick(3) }, item) }
				: { path: at, range: s }
			const after = get(apply(value, [p]), at) as unknown[]
			const id = `case ${c}`
			cases.push({ before, after, p, at })
			for (let j = 0; j < n + 3; j++) {
				requests.push({ op: "spot", source: "v", id, path: [...at, j] })
			}
			requests.push({ op: "mark", source: "v", id, patches: [p] })
		}
		const answers = await ask(requests)
		let i = 0
		for (const { before, after, p, at } of cases) {
			i += before.length + 3
			const marked = new Set(sorted(answers[i++].spots))
			const end = Math.max(before.length, after.length)
			for (let j = 0; j < end; j++) {
				const changed = before[j] !== after[j]
				const path = JSON.stringify([...at, j])
				assertEquals(
					marked.has(path),
					changed,
					`seed ${seed}: ${JSON.stringify({ n: before.length, p })} at ${j}`,
				)
			}
		}
	}
})

// pruning against a model: the spots held, and what an event at a key gives
Deno.test(`fuzz: ${SEEDS} seeds, spot and release against a model`, async () => {
	const SOURCES: unknown[] = ["v", { symbol: "v" }]
	const IDS = ["n", "m"]
	const PATHS: Key[][] = [[], ["a"], ["a", "b"], ["a", 0], ["a", 2, "c"], [1], ["b", "a"]]
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = rand(seed + 2000)
		const requests: Request[] = []
		const expected: unknown[] = []
		const model = new Map<string, Set<string>>()
		const at = (source: unknown, id: string) => {
			const k = JSON.stringify([source, id])
			if (!model.has(k)) model.set(k, new Set())
			return model.get(k)!
		}
		for (let s = 0; s < 120; s++) {
			const source = r.one(SOURCES), id = r.one(IDS), k = r.pick(10)
			const path = r.one(PATHS)
			const spot = k < 2 ? '"change"' : JSON.stringify(path)
			const was = at(source, id)
			if (k < 2) {
				requests.push(r.pick(2) ? { op: "change", source, id } : { op: "release", source, id })
			} else if (k < 6) requests.push({ op: "spot", source, id, path })
			else requests.push({ op: "release", source, id, path })
			if (requests[requests.length - 1].op === "release") was.delete(spot)
			else was.add(spot)
			expected.push(null)
			requests.push({ op: "event", source, id })
			expected.push([...was].sort())
			requests.push({ op: "held" })
			let keys = 0, spots = 0, steps = 0
			for (const set of model.values()) {
				if (set.size === 0) continue
				keys++
				spots += set.size
				const prefixes = new Set<string>(["[]"])
				for (const p of set) {
					if (p === '"change"') continue
					const keys = JSON.parse(p) as Key[]
					for (let n = 1; n <= keys.length; n++) prefixes.add(JSON.stringify(keys.slice(0, n)))
				}
				steps += prefixes.size
			}
			expected.push({ keys, spots, steps })
		}
		const answers = await ask(requests)
		answers.forEach((a, i) => {
			const e = expected[i], step = `seed ${seed}, request ${i}: ${JSON.stringify(requests[i])}`
			assertEquals(a.error, undefined, step)
			if (e === null) return
			if (Array.isArray(e)) assertEquals(sorted(a.spots), e, step)
			else assertEquals(a, e, step)
		})
	}
})
