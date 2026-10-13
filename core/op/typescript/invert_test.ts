import { assert, assertEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Key, type Patch } from "./apply.ts"
import invert, { type Options } from "./invert.ts"

// a fuzz's numbers: xorshift (an LCG's low bits repeat, so % k of one is patterned)
const xs = (x: number) => {
	x = x || 1
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return x >>> 0
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)
const view = (v: unknown): v is ArrayLike<unknown> & object =>
	ArrayBuffer.isView(v) && !(v instanceof DataView)

// where a and b differ ("": nowhere). lists, strings and typed arrays element for element; maps
// by content, and in key order when order
function differ(a: unknown, b: unknown, order = false, at = "$"): string {
	if (typeof a === "string" || typeof b === "string") return a === b ? "" : `${at}: string`
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${at}: list`
		for (let i = 0; i < a.length; i++) {
			const d = differ(a[i], b[i], order, `${at}[${i}]`)
			if (d) return d
		}
		return ""
	}
	if (view(a) || view(b)) {
		if (!view(a) || !view(b) || a.constructor !== b.constructor || a.length !== b.length) {
			return `${at}: typed`
		}
		for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `${at}[${i}]`
		return ""
	}
	if (isMap(a) || isMap(b)) {
		if (!isMap(a) || !isMap(b)) return `${at}: map`
		const ka = Object.keys(a), kb = Object.keys(b)
		if (ka.length !== kb.length) return `${at}: keys`
		if (order && ka.some((k, i) => k !== kb[i])) return `${at}: key order`
		for (const k of ka) {
			if (!Object.hasOwn(b, k)) return `${at}.${k}: missing`
			const d = differ(a[k], b[k], order, `${at}.${k}`)
			if (d) return d
		}
		return ""
	}
	return Object.is(a, b) ? "" : `${at}: ${String(a)} ≠ ${String(b)}`
}

// a copy that keeps lone surrogates, typed arrays, key order
const snap = (v: unknown) => v === undefined ? undefined : structuredClone(v)

// the patches, their undo, and the way back: the value as apply has it (the list option's empty
// list: nothing). the value given and the patches' values unchanged, key order too
function round(value: unknown, ps: Patch[], o: Options = {}, why = ""): Patch[] {
	const was = snap(value), values = ps.map((p) => snap(p?.value))
	const out = apply(value, ps, o)
	const undo = invert(value, ps, o)
	const back = apply(out, undo, o)
	const d = differ(back, apply(value, [], o))
	assert(d === "", `${why} round trip: ${d}\n${show(value)}\n${show(ps)}\nundo ${show(undo)}`)
	assert(differ(value, was, true) === "", `${why} the value given changed`)
	ps.forEach((p, i) =>
		assert(differ(p?.value, values[i], true) === "", `${why} patch ${i} changed`)
	)
	return undo
}
const show = (x: unknown) =>
	JSON.stringify(x, (_, v) => view(v) ? `${v.constructor.name}(${Array.from(v)})` : v)

const error = (f: () => unknown) => assertThrows(f, ApplyError) as ApplyError

Deno.test("invert: puts, each undone by a put of what was there or a removal", () => {
	const v = { m: { a: 1, b: 2 }, l: [1, 2, 3] }
	assertEquals(round(v, [{ path: ["m", "c"], value: 3 }]), [{ path: ["m", "c"] }])
	assertEquals(round(v, [{ path: ["m", "a"], value: 9 }]), [{ path: ["m", "a"], value: 1 }])
	assertEquals(round(v, [{ path: ["l", 1], value: [9] }]), [{ path: ["l", 1], value: 2 }])
	assertEquals(round(v, [{ path: [], value: null }]), [{ path: [], value: v }])
	// nested, in a value put by an earlier patch
	assertEquals(
		round(v, [{ path: ["n"], value: { x: [1] } }, { path: ["n", "x", 0], value: 2 }]),
		[{ path: ["n", "x", 0], value: 1 }, { path: ["n"] }],
	)
	// a key put over keeps its place in the key order
	const back = apply(apply(v, [{ path: ["m", "a"], value: 9 }]), [{ path: ["m", "a"], value: 1 }])
	assertEquals(differ(back, v, true), "")
})

Deno.test("invert: removals; a missing map key's is nothing", () => {
	const v = { m: { a: 1, b: 2 }, l: ["x", "y"] }
	assertEquals(round(v, [{ path: ["m", "a"] }]), [{ path: ["m", "a"], value: 1 }])
	assertEquals(round(v, [{ path: ["m", "q"] }]), [])
	assertEquals(round(v, [{ path: ["l", 0] }]), [{ path: ["l"], range: [0, 0], value: ["x"] }])
	assertEquals(round(v, [{ path: [] }]), [{ path: [], value: v }])
	// the key put back goes last: the same content
	const back = apply(apply(v, [{ path: ["m", "a"] }]), [{ path: ["m", "a"], value: 1 }])
	assertEquals(Object.keys((back as typeof v).m), ["b", "a"])
	assertEquals(differ(back, v), "")
})

Deno.test("invert: spans of strings in code points, lists, typed arrays", () => {
	const v = { s: "a😀b", l: [1, 2, 3], t: new Int16Array([1, 2, 3]) }
	assertEquals(round(v, [{ path: ["s"], range: [1, 2], value: "xy" }]), [
		{ path: ["s"], range: [1, 3], value: "😀" },
	])
	assertEquals(round(v, [{ path: ["s"], range: [3, 3], value: "!" }]), [
		{ path: ["s"], range: [3, 4] },
	])
	assertEquals(round(v, [{ path: ["s"], range: [0, 2] }]), [
		{ path: ["s"], range: [0, 0], value: "a😀" },
	])
	assertEquals(round(v, [{ path: ["l"], range: [0, 2], value: [9] }]), [
		{ path: ["l"], range: [0, 1], value: [1, 2] },
	])
	assertEquals(round(v, [{ path: ["t"], range: [3, 3], value: new Int16Array([4, 5]) }]), [
		{ path: ["t"], range: [3, 5] },
	])
	assertEquals(round(v, [{ path: ["t"], range: [0, 1] }]), [
		{ path: ["t"], range: [0, 0], value: new Int16Array([1]) },
	])
	// nothing put, nothing taken: nothing to undo
	assertEquals(round(v, [{ path: ["l"], range: [1, 1] }]), [])
	// bytes are one value
	const b = { b: new Uint8Array([1, 2]) }
	assertEquals(round(b, [{ path: ["b"], value: new Uint8Array([3]) }]), [
		{ path: ["b"], value: b.b },
	])
})

Deno.test("invert: many patches, undone last first", () => {
	const typing: Patch[] = [..."hello"].map((c, i) => ({ path: ["t"], range: [i, i], value: c }))
	const undo = round({ t: "" }, typing)
	assertEquals(undo.map((p) => p.range), [[4, 5], [3, 4], [2, 3], [1, 2], [0, 1]])
	round({ t: "x", l: [] }, [
		{ path: ["t"], range: [1, 1], value: "yz" },
		{ path: ["l"], range: [0, 0], value: ["a", "b"] },
		{ path: ["t"], range: [0, 2] },
		{ path: ["l", 1], value: "c" },
		{ path: ["m"], value: { k: [1] } },
		{ path: ["m", "k"], range: [1, 1], value: [2] },
		{ path: ["m", "k", 0] },
		{ path: ["l"], range: [0, 2] },
	])
	// any iterable
	function* gen(): Generator<Patch> {
		yield { path: ["a"], value: 1 }
		yield { path: ["a"] }
	}
	assertEquals(invert({ a: 0 }, gen()), [{ path: ["a"], value: 1 }, { path: ["a"], value: 0 }])
})

Deno.test("invert: nothing there; a put at [] made it, its undo leaves nothing", () => {
	assertEquals(round(undefined, []), [])
	assertEquals(round(undefined, [{ path: [], value: { a: 1 } }]), [{ path: [] }])
	assertEquals(round(undefined, [{ path: [], value: 1 }, { path: [], value: 2 }]), [
		{ path: [], value: 1 },
		{ path: [] },
	])
	assertEquals(round({ a: 1 }, [{ path: [] }, { path: [], value: 2 }]), [
		{ path: [] },
		{ path: [], value: { a: 1 } },
	])
})

Deno.test("invert: the list option, as apply's", () => {
	const list = { list: true }
	assertEquals(round(undefined, [{ path: [], range: [0, 0], value: ["a"] }], list), [
		{ path: [], range: [0, 1] },
	])
	// a list left empty is nothing; its undo starts from []
	assertEquals(round(["a"], [{ path: [0] }], list), [{ path: [], range: [0, 0], value: ["a"] }])
	assertEquals(round(["a"], [{ path: [] }, { path: [], value: ["b"] }], list), [
		{ path: [] },
		{ path: [], value: ["a"] },
	])
	round(["a", "b"], [{ path: [], range: [0, 0], move: { path: [], range: [1, 2] } }], list)
	round(["a", ["b"]], [{ path: [], move: { path: [1] } }], list)
	round([], [{ path: [], range: [0, 0], value: [1, 2] }, { path: [0] }], list)
	assertEquals(error(() => invert(["a"], [{ path: [], value: "x" }], list)).code, "wrong-kind")
	// a value given not a list: its undo puts it back, which the list option refuses
	const undo = invert("abc", [{ path: [], value: ["x"] }], list)
	assertEquals(undo, [{ path: [], value: "abc" }])
	assertEquals(error(() => apply(["x"], undo, list)).code, "wrong-kind")
})

Deno.test("invert: patches apply refuses, its error: the same code, the same index", () => {
	const v = { s: "ab", l: [1], m: {} }
	const cases: Patch[][] = [
		[{ path: ["s"], range: [1, 3] }],
		[{ path: ["s"], range: [0, 0], value: [1] }],
		[{ path: ["l", "x"], value: 1 }],
		[{ path: ["l", 1], value: 1 }],
		[{ path: ["m", "x", "y"], value: 1 }],
		[{ path: "s" } as unknown as Patch],
		[{ path: ["x"], value: undefined }],
		[{ path: ["l", 0], value: 2 }, { path: ["q", 0] }],
		[{ path: ["s"], range: [0, 0], value: "x" }, { path: ["l", -1] }],
		[{ path: ["x"], value: 1 }, { path: ["x", "y"], move: { path: ["x"] } }],
		[{ path: ["s"], range: [2, 1] }],
	]
	for (const ps of cases) {
		const a = error(() => apply(v, ps)), b = error(() => invert(v, ps))
		assertEquals([b.code, b.patch], [a.code, a.patch], JSON.stringify(ps))
	}
	assertEquals(
		[...new Set(cases.map((ps) => error(() => invert(v, ps)).code))].sort(),
		["into-itself", "no-key", "not-a-patch", "range", "wrong-kind"],
	)
	assertEquals(error(() => invert(undefined, [{ path: ["a"], value: 1 }])).code, "no-key")
	assertEquals(v, { s: "ab", l: [1], m: {} })
})

const moved = (undo: Patch[]) => undo.some((p) => p.move !== undefined)

Deno.test("invert: moves of one thing move it back", () => {
	const v = { l: ["a", "b", "c"], m: { x: 1, y: { z: 2 } }, s: "str" }
	// to a new key: back
	assertEquals(round(v, [{ path: ["m", "w"], move: { path: ["m", "x"] } }]), [
		{ path: ["m", "x"], move: { path: ["m", "w"] } },
	])
	// onto a key: back, then what it replaced put back
	assertEquals(round(v, [{ path: ["m", "x"], move: { path: ["s"] } }]), [
		{ path: ["s"], move: { path: ["m", "x"] } },
		{ path: ["m", "x"], value: 1 },
	])
	// onto an element: what it replaced goes in beside it, then back
	assertEquals(round(v, [{ path: ["l", 0], move: { path: ["m", "x"] } }]), [
		{ path: ["l"], range: [1, 1], value: ["a"] },
		{ path: ["m", "x"], move: { path: ["l", 0] } },
	])
	assertEquals(round(v, [{ path: ["l", 1], move: { path: ["l", 0] } }]), [
		{ path: ["l"], range: [2, 2], value: ["c"] },
		{ path: ["l"], range: [0, 0], move: { path: ["l", 1] } },
	])
	// out of a list: back into its gap
	assertEquals(round(v, [{ path: ["k"], move: { path: ["l", 1] } }]), [
		{ path: ["l"], range: [1, 1], move: { path: ["k"] } },
	])
	// into a list's span
	assertEquals(round(v, [{ path: ["l"], range: [0, 2], move: { path: ["m", "y"] } }]), [
		{ path: ["l"], range: [1, 1], value: ["a", "b"] },
		{ path: ["m", "y"], move: { path: ["l", 0] } },
	])
	assertEquals(round(v, [{ path: ["l"], range: [2, 2], move: { path: ["l", 0] } }]), [
		{ path: ["l"], range: [0, 0], move: { path: ["l", 2] } },
	])
	// into a list in the element after it
	assertEquals(
		round({ l: ["a", ["b"]] }, [{ path: ["l", 0], range: [0, 0], move: { path: ["l", 0] } }]),
		[
			{ path: ["l"], range: [0, 0], move: { path: ["l", 0, 0] } },
		],
	)
	// a key in a list after the gap it left: its path back as it was
	round({ l: [{ k: 1 }, "a"] }, [{ path: ["l", 0, "k"], move: { path: ["l", 1] } }])
	assertEquals(
		round({ l: ["a", "b", { k: 1 }] }, [{ path: ["l", 1, "k"], move: { path: ["l", 0] } }]),
		[
			{ path: ["l"], range: [0, 0], move: { path: ["l", 1, "k"] } },
			{ path: ["l", 2, "k"], value: 1 },
		],
	)
	// a string, out of a key, into a string
	assertEquals(round(v, [{ path: ["s"], range: [3, 3], move: { path: ["l", 0] } }]).length, 2)
	assertEquals(
		round({ e: "😀!", s: "ab" }, [{ path: ["s"], range: [1, 2], move: { path: ["e"] } }]),
		[
			{ path: ["s"], range: [3, 3], value: "b" },
			{ path: ["e"], move: { path: ["s"], range: [1, 3] } },
		],
	)
	const t = { t: new Int8Array([1, 2]), u: new Int8Array([7, 8, 9]) }
	assertEquals(round(t, [{ path: ["t"], range: [1, 1], move: { path: ["u"] } }]), [
		{ path: ["u"], move: { path: ["t"], range: [1, 4] } },
	])
	// onto itself: nothing
	assertEquals(round(v, [{ path: ["l", 2], move: { path: ["l", 2] } }]), [])
	assertEquals(round(v, [{ path: [], move: { path: [] } }]), [])
})

Deno.test("invert: moves of a span move it back", () => {
	assertEquals(round("abcdef", [{ path: [], range: [0, 0], move: { path: [], range: [4, 6] } }]), [
		{ path: [], range: [4, 4], move: { path: [], range: [0, 2] } },
	])
	assertEquals(
		round([1, 2, 3, 4], [{ path: [], range: [1, 3], move: { path: [], range: [3, 4] } }]),
		[
			{ path: [], range: [2, 2], value: [2, 3] },
			{ path: [], range: [3, 3], move: { path: [], range: [1, 2] } },
		],
	)
	const v = { l: [1, 2, 3, 4, 5], k: ["a"], s: "abcdef", t: "😀x😀", i: new Int16Array([1, 2, 3]) }
	for (
		const p of [
			{ path: ["l"], range: [3, 3], move: { path: ["l"], range: [0, 2] } },
			{ path: ["k"], range: [1, 1], move: { path: ["l"], range: [1, 3] } },
			{ path: ["s"], range: [6, 6], move: { path: ["t"], range: [1, 3] } },
			{ path: ["t"], range: [0, 0], move: { path: ["t"], range: [2, 3] } },
			{ path: ["i"], range: [0, 0], move: { path: ["i"], range: [2, 3] } },
			{ path: ["k"], range: [0, 1], move: { path: ["l"], range: [4, 5] } },
		] as Patch[]
	) assert(moved(round(v, [p])), JSON.stringify(p))
	// to a key: the span back, then what the key held put back
	assertEquals(round(v, [{ path: ["w"], move: { path: ["s"], range: [1, 3] } }]), [
		{ path: ["s"], range: [1, 1], move: { path: ["w"], range: [0, 2] } },
		{ path: ["w"] },
	])
	assertEquals(round(v, [{ path: ["k", 0], move: { path: ["l"], range: [0, 1] } }]), [
		{ path: ["l"], range: [0, 0], move: { path: ["k", 0], range: [0, 1] } },
		{ path: ["k", 0], value: "a" },
	])
	// an empty span: nothing moves
	assertEquals(
		round(v, [{ path: ["k"], range: [0, 0], move: { path: ["l"], range: [2, 2] } }]),
		[],
	)
})

Deno.test("invert: moves that cannot move back: what was put undone, what was taken put back", () => {
	const v = { l: ["a", "b"], m: { x: 1, y: { z: 2 } }, n: [["p", "q"]], s: "s" }
	// the whole replaced by a part of it
	assertEquals(round(v, [{ path: [], move: { path: ["m"] } }]), [
		{ path: [], value: { l: ["a", "b"], n: [["p", "q"]], s: "s" } },
		{ path: ["m"], value: { x: 1, y: { z: 2 } } },
	])
	// a key's value replaced by its own part
	assertEquals(round(v, [{ path: ["m"], move: { path: ["m", "x"] } }]), [
		{ path: ["m"], value: { y: { z: 2 } } },
		{ path: ["m", "x"], value: 1 },
	])
	// a span to a key it is under
	assert(!moved(round(v, [{ path: ["n"], move: { path: ["n", 0], range: [0, 1] } }])))
	// a string out of a list: no move puts a string in a list
	assert(!moved(round(v, [{ path: ["s"], range: [0, 0], move: { path: ["l", 0] } }])))
	// a list's element replaced by its own part: back would be into-itself
	round({ l: [["a", ["b"]]] }, [{ path: ["l", 0], move: { path: ["l", 0, 1, 0] } }])
	round({ l: [["a"], "x"] }, [{ path: ["l", 1], move: { path: ["l", 0, 0] } }])
	// the moved thing changed after: the undo's copy of it is not
	const w = { a: { k: [1] }, l: ["x"] }
	round(w, [
		{ path: ["a", "k"], range: [1, 1], value: [2] },
		{ path: [], move: { path: ["a"] } },
		{ path: ["k", 0], value: 9 },
		{ path: ["k"], range: [0, 0], value: [8] },
	])
})

// a lone high (H) met by a lone low (L) at an edge is one pair: one position fewer. the undo
// widens over the pair and gives back the exact units
const H = "\uD83D", L = "\uDE00", H2 = "\uD800", L2 = "\uDC00"
Deno.test("invert: lone surrogates joined at an edge, by a put", () => {
	// the left edge: a lone high before, a lone low first in what goes in
	assertEquals(round({ s: "x" + H }, [{ path: ["s"], range: [2, 2], value: L + "y" }]), [
		{ path: ["s"], range: [1, 3], value: H },
	])
	// the right edge: a lone high last in what goes in, a lone low after
	assertEquals(round({ s: L + "z" }, [{ path: ["s"], range: [0, 0], value: "a" + H }]), [
		{ path: ["s"], range: [0, 2], value: L },
	])
	// both, replacing
	assertEquals(round({ s: H + "Q" + L }, [{ path: ["s"], range: [1, 2], value: L2 + H2 }]), [
		{ path: ["s"], range: [0, 2], value: H + "Q" + L },
	])
	// one lone unit put between: joined on one side
	round({ s: H + L2 }, [{ path: ["s"], range: [1, 1], value: L }])
	round({ s: H2 + L }, [{ path: ["s"], range: [1, 1], value: H }])
	// joined, then typed after
	round({ s: "ab" + H }, [
		{ path: ["s"], range: [3, 3], value: L },
		{ path: ["s"], range: [3, 3], value: "c" },
		{ path: ["s"], range: [0, 1] },
	])
})

Deno.test("invert: lone surrogates joined by a removal", () => {
	assertEquals(round({ s: H + "Q" + L }, [{ path: ["s"], range: [1, 2] }]), [
		{ path: ["s"], range: [0, 1], value: H + "Q" + L },
	])
	assertEquals(round({ s: "a" + H + "xy" + L + "b" }, [{ path: ["s"], range: [2, 4] }]), [
		{ path: ["s"], range: [1, 2], value: H + "xy" + L },
	])
	// not joined: a pair is never split, a high after a low is two
	round({ s: L + "Q" + H }, [{ path: ["s"], range: [1, 2] }])
	round({ s: "😀Q😀" }, [{ path: ["s"], range: [1, 2] }])
})

Deno.test("invert: lone surrogates joined by a ranged move", () => {
	// the take joins what it leaves: no move back
	let undo = round({ s: H + "Q" + L + "ab" }, [
		{ path: ["s"], range: [3, 3], move: { path: ["s"], range: [1, 2] } },
	])
	assert(!moved(undo))
	assertEquals(
		apply(
			apply({ s: H + "Q" + L + "ab" }, [{
				path: ["s"],
				range: [3, 3],
				move: { path: ["s"], range: [1, 2] },
			}]),
			[undo[0]],
		),
		{ s: H + L + "ab" },
	)
	// the landing joins at its left edge, then its right
	undo = round({ s: H + "x", t: "y" + L }, [
		{ path: ["s"], range: [1, 1], move: { path: ["t"], range: [1, 2] } },
	])
	assert(!moved(undo))
	undo = round({ s: "x" + L, t: H + "y" }, [
		{ path: ["s"], range: [1, 1], move: { path: ["t"], range: [0, 1] } },
	])
	assert(!moved(undo))
	// what moved ends in a lone high, what it replaced begins with a lone low
	undo = round({ s: "a" + L + "b", t: H }, [
		{ path: ["s"], range: [1, 2], move: { path: ["t"], range: [0, 1] } },
	])
	assert(!moved(undo))
	// a string out of a key, joined where it lands
	round({ s: H + "b", e: L }, [{ path: ["s"], range: [1, 1], move: { path: ["e"] } }])
	round({ s: H + "b", e: L }, [{ path: ["s"], range: [1, 2], move: { path: ["e"] } }])
	// a span to a key, its take joined
	round({ s: H + "Q" + L }, [{ path: ["k"], move: { path: ["s"], range: [1, 2] } }])
	// lone surrogates not joined: moved back
	assert(moved(round({ s: H + "ab", t: L }, [
		{ path: ["s"], range: [3, 3], move: { path: ["t"], range: [0, 1] } },
	])))
})

// values, and patches of every kind on them: many valid, some not
const PARTS = ["a", "b", "xy", "é", "中", "😀", "\uD83D", "\uDE00", "\uD800", "\uDC00"]
const KEYS = ["a", "b", "c", "k"]
const KINDS = [Int8Array, Int16Array, Float64Array, BigInt64Array]
type Pick = (n: number) => number

function text(pick: Pick, most = 6) {
	return Array.from({ length: pick(most + 1) }, () => PARTS[pick(PARTS.length)]).join("")
}
function elements(pick: Pick, kind: (typeof KINDS)[number], n: number) {
	const xs = Array.from({ length: n }, () => pick(200) - 100)
	const make = kind as unknown as new (xs: unknown[]) => ArrayLike<unknown>
	return new make(kind === BigInt64Array ? xs.map(BigInt) : xs)
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
			return [null, true, false, -0][pick(4)]
		case 6:
		case 7:
			return Array.from({ length: pick(4) }, () => made(pick, depth - 1))
		default:
			return Object.fromEntries(
				Array.from({ length: pick(4) }, () => [KEYS[pick(KEYS.length)], made(pick, depth - 1)]),
			)
	}
}
const isSeq = (v: unknown) =>
	typeof v === "string" || Array.isArray(v) || view(v) && !(v instanceof Uint8Array)
const len = (v: unknown) => typeof v === "string" ? Array.from(v).length : (v as unknown[]).length

function places(v: unknown, path: Key[] = [], out: [Key[], unknown][] = []) {
	out.push([path, v])
	if (path.length >= 4) return out
	if (Array.isArray(v)) v.forEach((x, i) => places(x, [...path, i], out))
	else if (isMap(v)) { for (const k of Object.keys(v)) places(v[k], [...path, k], out) }
	return out
}
function span(pick: Pick, n: number): [number, number] {
	const a = pick(n + 1)
	return [a, a + pick(n - a + 1)]
}
function filling(pick: Pick, s: unknown): unknown {
	if (typeof s === "string") return text(pick, 3)
	if (Array.isArray(s)) return Array.from({ length: pick(3) }, () => made(pick, 1))
	return elements(pick, s!.constructor as (typeof KINDS)[number], pick(3))
}
function patch(pick: Pick, v: unknown, list: boolean): Patch {
	const all = v === undefined ? [] : places(v)
	const any = () => all.length ? all[pick(all.length)] : [[], undefined] as [Key[], unknown]
	const seqs = all.filter(([, x]) => isSeq(x)), maps = all.filter(([, x]) => isMap(x))
	const seq = () => seqs.length ? seqs[pick(seqs.length)] : any()
	const key = () =>
		maps.length ? [...maps[pick(maps.length)][0], KEYS[pick(KEYS.length)]] : any()[0]
	const gap = (): Patch => {
		const [p, s] = seq()
		const g = pick((isSeq(s) ? len(s) : 0) + 1)
		return { path: p, range: [g, g + (pick(3) ? 0 : 1)] }
	}
	if (list && pick(6) === 0) return { path: [], value: pick(4) ? [made(pick, 1)] : made(pick, 0) }
	switch (pick(16)) {
		case 0:
			return { path: any()[0], value: made(pick, 2) }
		case 1:
			return { path: key(), value: made(pick, 1) }
		case 2:
			return pick(5) ? { path: any()[0] } : { path: key() }
		case 3:
		case 4:
		case 5: {
			const [p, s] = seq()
			if (!isSeq(s)) return { path: p, range: [0, 0], value: "x" }
			const r = span(pick, len(s))
			return pick(3) ? { path: p, range: r, value: filling(pick, s) } : { path: p, range: r }
		}
		case 6:
			return { path: key(), move: { path: any()[0] } }
		case 7:
			return { path: any()[0], move: { path: any()[0] } }
		case 8:
			return { ...gap(), move: { path: any()[0] } }
		case 9:
		case 10: {
			// a span within its sequence
			const [f, s] = seq()
			const n = isSeq(s) ? len(s) : 0, r = span(pick, n)
			const g = pick(n - (r[1] - r[0]) + 1)
			return { path: f, range: [g, g + (pick(3) ? 0 : 1)], move: { path: f, range: r } }
		}
		case 11: {
			const [f, s] = seq()
			const r = span(pick, isSeq(s) ? len(s) : 0)
			return pick(2)
				? { ...gap(), move: { path: f, range: r } }
				: { path: key(), move: { path: f, range: r } }
		}
		case 12:
		case 13: {
			// a value into a sequence of its kind
			const [p, s] = seq()
			const fits = all.filter(([q, x]) =>
				q.length > 0 && (Array.isArray(s) ||
					(typeof s === "string"
						? typeof x === "string"
						: view(x) && x.constructor === s?.constructor))
			)
			if (!isSeq(s) || !fits.length) return { ...gap(), move: { path: any()[0] } }
			const g = pick(len(s) + 1)
			return {
				path: p,
				range: [g, g + (pick(3) ? 0 : 1)],
				move: { path: fits[pick(fits.length)][0] },
			}
		}
		case 14:
			return { path: [], value: made(pick, 2) }
		default: {
			// what is not there, or a key of the wrong kind
			const [p] = any()
			return { path: [...p, [["x"], [0], [9], ["a", "b"]][pick(4)]].flat(), value: 1 }
		}
	}
}

// a few dozen seeds (memory: fuzz runs small)
Deno.test("invert: fuzz, the round trip of random patches; refused ones as apply refuses them", () => {
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed
		const pick = (n: number) => (x = xs(x)) % n
		const list = seed % 5 === 0
		const start = list
			? (pick(3) ? Array.from({ length: pick(5) }, () => made(pick, 1)) : undefined)
			: pick(8)
			? {
				s: text(pick, 8),
				l: made(pick, 2),
				t: elements(pick, Int16Array, 3),
				m: made(pick, 2),
			}
			: made(pick, 3)
		const o = { list }
		let v: unknown = start
		const good: Patch[] = [], bad: [number, Patch][] = []
		for (let tries = 0; good.length < 24 && tries < 100; tries++) {
			const p = patch(pick, v, list)
			try {
				// all from the start: the list option's nothing is not [] mid-call
				const next = apply(start, [...good, p], o)
				good.push(p)
				v = next
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
				if (bad.length < 3) bad.push([good.length, p])
			}
		}
		round(start, good, o, `seed ${seed}`)
		// every patch alone, and every way back from part way
		for (let k = 1; k < good.length; k += 5) {
			round(start, good.slice(0, k), o, `seed ${seed} ${k}`)
		}
		for (const [k, p] of bad) {
			const ps = [...good.slice(0, k), p, ...good.slice(k)]
			const a = error(() => apply(start, ps, o)), b = error(() => invert(start, ps, o))
			assertEquals([b.code, b.patch], [a.code, a.patch], `seed ${seed}`)
		}
	}
})

Deno.test("invert: fuzz, typing and moving text with lone surrogates", () => {
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed
		const pick = (n: number) => (x = xs(x)) % n
		const start = { s: text(pick, 12), t: text(pick, 4) }
		let v: unknown = start
		const ps: Patch[] = []
		for (let step = 0; step < 40; step++) {
			const { s, t } = v as { s: string; t: string }
			const n = Array.from(s).length, a = pick(n + 1), b = a + pick(Math.min(3, n - a) + 1)
			const r = pick(6)
			const p: Patch = r < 3
				? { path: ["s"], range: [a, b], value: PARTS[pick(PARTS.length)] }
				: r === 3
				? { path: ["s"], range: [a, b] }
				: r === 4
				? {
					path: ["s"],
					range: [pick(n - (b - a) + 1), 0],
					move: { path: ["s"], range: [a, b] },
				}
				: {
					path: ["t"],
					range: [pick(Array.from(t).length + 1), 0],
					move: { path: ["s"], range: [a, b] },
				}
			if (p.move) p.range = [p.range![0], p.range![0]]
			try {
				v = apply(v, [p])
				ps.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		}
		round(start, ps, {}, `seed ${seed}`)
	}
})
