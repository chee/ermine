// what apply's suite does besides its scenarios (conformance/run.ts), asked of the harness named by
// HARNESS (default: the TypeScript one, apply_harness.ts, which documents the protocol).
//
// The fuzzer makes values and patches, follows them with apply.ts, and asks the harness the same:
// its answers must be what calling apply.ts gives. And, for apply.ts and the harness alike: many
// patches in one call give what one call each gives (one call walks a string from where the last
// patch left off; one call each never does).
import { assert, assertEquals } from "@std/assert"
import apply, { ApplyError, type Patch } from "@ermine/op/apply"
import { ask, command } from "../../../conformance/typescript/ask.ts"
import { line, toJson } from "../../../conformance/typescript/form.ts"
import type { Request } from "../../../conformance/typescript/harness.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

const harness = command("apply")
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

Deno.test("an unknown op, or a line that is not JSON, is an error, and the harness goes on", async () => {
	const [a, b, c, d] = await ask(harness, [
		{ op: "nope" },
		"{nope",
		{ op: "apply" },
		{ op: "apply", value: 1, patches: [] },
	])
	assert(typeof a.error === "string", "unknown op")
	assert(typeof b.error === "string", "not JSON")
	assert(typeof c.error === "string", "no patches")
	assertEquals(d, { value: 1 })
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const PATCHES = 24

type Pick = ReturnType<typeof rand>

// string parts: ASCII, BMP, pairs, a pair and a modifier, lone halves, U+0000
const PARTS = ["a", "b", "xy", "é", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\u0000"]
const KEYS = ["a", "b", "c", "k"]
const KINDS = [
	Int8Array,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
]
type Typed = Exclude<ArrayBufferView, DataView | Uint8Array> & { length: number }
const typed = (v: unknown): v is Typed =>
	ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof Uint8Array)
const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)

function text(pick: Pick, most = 6) {
	return Array.from({ length: pick(most + 1) }, () => PARTS[pick(PARTS.length)]).join("")
}
function elements(pick: Pick, kind: (typeof KINDS)[number], n: number): Typed {
	const big = kind === BigInt64Array || kind === BigUint64Array
	const xs = Array.from({ length: n }, () => pick(200) - (kind.name.startsWith("Uint") ? 0 : 100))
	const make = kind as unknown as new (xs: unknown[]) => Typed
	return new make(big ? xs.map((x) => BigInt(Math.abs(x))) : xs)
}
function made(pick: Pick, depth: number): unknown {
	switch (pick(depth > 0 ? 9 : 6)) {
		case 0:
			return pick(100)
		case 1:
		case 2:
			return text(pick)
		case 3:
			return elements(pick, KINDS[pick(KINDS.length)], pick(4))
		case 4:
			return new Uint8Array(Array.from({ length: pick(3) }, () => pick(256)))
		case 5:
			return [null, true, false, 0.5][pick(4)]
		case 6:
		case 7:
			return Array.from({ length: pick(4) }, () => made(pick, depth - 1))
		default:
			return Object.fromEntries(
				Array.from({ length: pick(4) }, () => [KEYS[pick(KEYS.length)], made(pick, depth - 1)]),
			)
	}
}

const len = (v: unknown) =>
	typeof v === "string" ? Array.from(v).length : (v as unknown[] | Typed).length
const isSeq = (v: unknown) => typeof v === "string" || Array.isArray(v) || typed(v)

// every place in v: its path and what is there
function places(
	v: unknown,
	path: (string | number)[] = [],
	out: [(string | number)[], unknown][] = [],
) {
	out.push([path, v])
	if (path.length >= 4) return out
	if (Array.isArray(v)) v.forEach((x, i) => places(x, [...path, i], out))
	else if (isMap(v)) { for (const k of Object.keys(v)) places(v[k], [...path, k], out) }
	return out
}

// a span of a sequence of n: mostly in it, now and then past its end or reversed
function span(pick: Pick, n: number): [number, number] {
	const a = pick(n + 1), b = a + pick(n - a + 1)
	switch (pick(14)) {
		case 0:
			return [a, n + 1 + pick(2)]
		case 1:
			return b > a ? [b, a] : [a, b]
		default:
			return [a, b]
	}
}
// what fits a span of s, mostly
function filling(pick: Pick, s: unknown): unknown {
	if (pick(10) === 0) return made(pick, 1)
	if (typeof s === "string") return text(pick, 3)
	if (Array.isArray(s)) return Array.from({ length: pick(3) }, () => made(pick, 1))
	const kind = (s as Typed).constructor as (typeof KINDS)[number]
	return elements(pick, kind, pick(3))
}

// a patch against v (absent: undefined); many are valid, some are not
function patch(pick: Pick, v: unknown): Patch {
	const all = v === undefined ? [] : places(v)
	const any = () => all.length ? all[pick(all.length)] : [[], undefined] as const
	const seqs = all.filter(([, x]) => isSeq(x))
	const maps = all.filter(([, x]) => isMap(x))
	const seq = () => seqs.length ? seqs[pick(seqs.length)] : any()
	const k = pick(24)
	if (k < 3) {
		const [p] = any()
		return { path: p, value: made(pick, 2) }
	}
	if (k < 5 && maps.length) {
		const [p] = maps[pick(maps.length)]
		return { path: [...p, KEYS[pick(KEYS.length)]], value: made(pick, 1) }
	}
	if (k < 7) {
		const [p] = any()
		return pick(4) || !maps.length ? { path: p } : { path: [...maps[0][0], "nothing"] }
	}
	if (k < 12) {
		const [p, s] = seq()
		if (!isSeq(s)) return { path: p, range: [0, 0], value: "x" }
		return pick(3)
			? { path: p, range: span(pick, len(s)), value: filling(pick, s) }
			: { path: p, range: span(pick, len(s)) }
	}
	if (k < 15) {
		// unranged: to a new key, onto a place, into a span
		const [from] = any()
		const j = pick(3)
		if (j === 0 && maps.length) {
			return {
				path: [...maps[pick(maps.length)][0], KEYS[pick(KEYS.length)]],
				move: { path: from },
			}
		}
		if (j === 1) return { path: any()[0], move: { path: from } }
		const lists = seqs.filter(([, x]) => Array.isArray(x))
		const [p, s] = lists.length && pick(2) ? lists[pick(lists.length)] : seq()
		const g = pick((isSeq(s) ? len(s) : 0) + 1)
		return { path: p, range: [g, g + pick(2)], move: { path: from } }
	}
	if (k < 19) {
		// ranged: within one sequence, or across
		const [f, s] = seq()
		const n = isSeq(s) ? len(s) : 0
		const r = span(pick, n)
		if (pick(2)) {
			const left = Math.max(0, n - Math.max(0, r[1] - r[0]))
			const g = pick(left + 1)
			return { path: f, range: [g, g + pick(2)], move: { path: f, range: r } }
		}
		const [p, t] = seq()
		const g = pick((isSeq(t) ? len(t) : 0) + 1)
		if (pick(4) || !maps.length) return { path: p, range: [g, g], move: { path: f, range: r } }
		const [m] = maps[pick(maps.length)]
		return { path: [...m, KEYS[pick(KEYS.length)]], move: { path: f, range: r } }
	}
	if (k < 21) {
		// paths that may not be there, or are the wrong kind of key
		const [p] = any()
		const extra = [["x"], [0], [9], ["a", "b"], [1, "q"]][pick(5)]
		return pick(2) ? { path: [...p, ...extra], value: 1 } : { path: [...p, ...extra] }
	}
	if (k < 22) {
		const [p] = any()
		const bad = [
			{ path: [...p, -1] },
			{ path: [...p, 1.5], value: 1 },
			{ path: p, range: [0] },
			{ path: p, range: [-1, 0] },
			{ path: p, value: 1, move: { path: [] } },
			{ path: [true] },
			{ value: 1 },
			{ path: p, move: { path: "a" } },
		]
		return bad[pick(bad.length)] as unknown as Patch
	}
	if (k < 23) return { path: [], value: made(pick, 2) }
	const [p] = any()
	return { path: [...p, KEYS[pick(KEYS.length)]], move: { path: p } }
}

// apply.ts called directly, answered as the harness answers
function direct(value: unknown, patches: Patch[]): Answer {
	try {
		const v = apply(value, patches)
		const out: Answer = v === undefined ? {} : { value: toJson(v) }
		return JSON.parse(line(out))
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		return { error: { code: e.code, patch: e.patch } }
	}
}
const request = (value: unknown, patches: Patch[]): Request => ({
	op: "apply",
	...(value === undefined ? {} : { value: toJson(value) }),
	patches: patches.map((p) =>
		isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: toJson(p.value) } : p
	),
})

type Run = {
	start: unknown
	good: Patch[]
	befores: unknown[]
	bad: [number, Patch][]
}

// patches followed one by one: the valid kept, the invalid kept aside with where they fell
function run(seed: number): Run {
	const pick = rand(seed)
	let v: unknown = pick(8)
		? { s: text(pick, 8), l: made(pick, 2), t: elements(pick, Int16Array, 3), m: made(pick, 2) }
		: made(pick, 3)
	const start = v
	const good: Patch[] = [], befores: unknown[] = [], bad: [number, Patch][] = []
	for (let tries = 0; good.length < PATCHES && tries < PATCHES * 4; tries++) {
		const p = patch(pick, v)
		try {
			const next = apply(v, [p])
			befores.push(v)
			good.push(p)
			v = next
		} catch (e) {
			if (!(e instanceof ApplyError)) throw e
			if (bad.length < 4) bad.push([good.length, p])
		}
	}
	return { start, good, befores, bad }
}

Deno.test(`fuzz: ${SEEDS} seeds × ${PATCHES} patches, as apply.ts; one call as one call each`, async () => {
	const runs = Array.from({ length: SEEDS }, (_, i) => run(i + 1))
	const requests: Request[] = [], expected: Answer[] = [], where: string[] = []
	const add = (seed: number, what: string, value: unknown, ps: Patch[]) => {
		requests.push(request(value, ps))
		expected.push(direct(value, ps))
		where.push(`seed ${seed}: ${what}`)
	}
	runs.forEach((r, i) => {
		const seed = i + 1
		add(seed, "all", r.start, r.good)
		r.good.forEach((p, k) => add(seed, `patch ${k} alone`, r.befores[k], [p]))
		// an invalid patch where it fell: that index, whatever came before
		for (const [k, p] of r.bad) {
			add(
				seed,
				`invalid at ${k}`,
				r.start,
				[...r.good.slice(0, k), p, ...r.good.slice(k)],
			)
		}
	})
	const answers = (await ask(harness, requests)) as Answer[]
	assertEquals(answers.length, requests.length, "one answer per request")
	answers.forEach((a, i) =>
		assertEquals(line(a), line(expected[i]), `${where[i]}: ${line(requests[i])}`)
	)
	// the same in place
	const inPlace = await ask(harness, requests.map((r) => ({ ...r, cow: false })))
	inPlace.forEach((a, i) =>
		assertEquals(line(a), line(expected[i]), `${where[i]} (cow: false): ${line(requests[i])}`)
	)
	// one call, as one call each: the end, an invalid patch's index
	let at = 0
	runs.forEach((r, i) => {
		const all = answers[at], alone = answers.slice(at + 1, at + 1 + r.good.length)
		const invalid = answers.slice(at + 1 + r.good.length, at + 1 + r.good.length + r.bad.length)
		at += 1 + r.good.length + r.bad.length
		assertEquals(all.error, undefined, `seed ${i + 1}: all valid`)
		const end = alone.length
			? alone[alone.length - 1].value
			: r.start === undefined
			? undefined
			: JSON.parse(line(toJson(r.start)))
		assertEquals(all.value, end, `seed ${i + 1}: the end`)
		r.bad.forEach(([k], j) => assertEquals(invalid[j].error?.patch, k, `seed ${i + 1}: invalid`))
	})
})
