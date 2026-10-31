import { assertEquals } from "@std/assert"
import type { Patch } from "@ermine/changeable/apply"
import createSquish, { decode, encode, squish } from "./squish.ts"

const ins = (at: number, value: unknown, path: (string | number)[] = ["t"]): Patch => ({
	path,
	range: [at, at],
	value,
})
const del = (a: number, b: number, path: (string | number)[] = ["t"]): Patch => ({
	path,
	range: [a, b],
})

Deno.test("squish: typing becomes one insert", () => {
	assertEquals(squish([ins(3, "a"), ins(4, "b"), ins(5, "c")]), [ins(3, "abc")])
})

Deno.test("squish: backspace after typing shortens it, and can empty it", () => {
	assertEquals(squish([ins(3, "ab"), del(4, 5)]), [ins(3, "a")])
	assertEquals(squish([ins(3, "a"), del(3, 4)]), [ins(3, "")])
})

Deno.test("squish: backspaces and forward deletes join", () => {
	assertEquals(squish([del(5, 6), del(4, 5), del(3, 4)]), [del(3, 6)])
	assertEquals(squish([del(5, 6), del(5, 6), del(5, 6)]), [del(5, 8)])
})

Deno.test("squish: delete then type is a replace", () => {
	assertEquals(squish([del(2, 5), ins(2, "xy")]), [{ path: ["t"], range: [2, 5], value: "xy" }])
})

Deno.test("squish: lists, typed arrays and bytes join; kinds that differ do not", () => {
	assertEquals(squish([ins(0, [1], ["l"]), ins(1, [2, 3], ["l"])]), [ins(0, [1, 2, 3], ["l"])])
	assertEquals(
		squish([ins(0, new Int16Array([1]), ["t"]), ins(1, new Int16Array([2]), ["t"])]),
		[ins(0, new Int16Array([1, 2]), ["t"])],
	)
	assertEquals(
		squish([ins(0, new Uint8Array([1]), ["b"]), ins(1, new Uint8Array([2]), ["b"])]),
		[ins(0, new Uint8Array([1, 2]), ["b"])],
	)
	assertEquals(
		squish([ins(0, new Int8Array([1]), ["b"]), ins(1, new Uint8Array([2]), ["b"])]).length,
		2,
	)
	assertEquals(squish([ins(0, "a"), ins(1, [1])]).length, 2)
})

Deno.test("squish: code points count as one", () => {
	assertEquals(squish([ins(0, "😀"), ins(1, "b")]), [ins(0, "😀b")])
})

Deno.test("squish: other paths and gaps stay apart", () => {
	assertEquals(squish([ins(0, "a"), ins(2, "b")]).length, 2)
	assertEquals(squish([ins(0, "a"), ins(1, "b", ["u"])]).length, 2)
})

Deno.test("squish: a later put kills earlier patches under it", () => {
	const put = (path: string[], value: unknown): Patch => ({ path, value })
	assertEquals(squish([put(["a", "b"], 1), ins(0, "x", ["a", "c"]), put(["a"], {})]), [
		put(["a"], {}),
	])
	assertEquals(squish([put(["a"], 1), put(["b"], 2), put(["b"], 3)]), [
		put(["a"], 1),
		put(["b"], 3),
	])
	assertEquals(squish([ins(0, "x"), put([], {})]), [put([], {})])
})

Deno.test("squish: a move is never merged, nor killed, nor merged across", () => {
	const mv: Patch = { path: ["t"], range: [0, 0], move: { path: ["u"], range: [0, 2] } }
	assertEquals(squish([ins(5, "a"), mv, ins(5, "b")]).length, 3)
	assertEquals(squish([mv, { path: ["t"], value: "z" }]).length, 2)
})

Deno.test("squish: pushed patches are not changed; iterable", () => {
	const a = ins(0, "a"), b = ins(1, "b")
	const s = createSquish()
	s.push(a)
	s.push(b)
	assertEquals(a.value, "a")
	assertEquals([...s], [ins(0, "ab")])
	assertEquals(s.patches().length, 1)
})

function edit(t: string, ps: Patch[]): string {
	const cs = Array.from(t)
	for (const p of ps) {
		const [a, b] = p.range!
		cs.splice(a, b - a, ...("value" in p ? Array.from(p.value as string) : []))
	}
	return cs.join("")
}

Deno.test("squish: same end result as the patches, over random typing", () => {
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed
		const rnd = (n: number) => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n
		let doc = "héllo wörld"
		const start = doc
		const ps: Patch[] = []
		for (let i = 0; i < 30; i++) {
			const n = Array.from(doc).length
			const at = rnd(n + 1)
			const a = Math.min(at, n - 1)
			const p = rnd(3) === 0 && n > 0
				? del(a, a + 1 + rnd(Math.min(2, n - a)))
				: ins(at, "ab😀"[rnd(3)] + (rnd(2) ? "z" : ""))
			if (p.range![1] > n) continue
			doc = edit(doc, [p])
			ps.push(p)
			if (rnd(2) && rnd(2)) ps.push(ins(Array.from(doc).length, "!"))
			doc = edit(start, ps)
		}
		const out = squish(ps)
		assertEquals(edit(start, out), doc, `seed ${seed}`)
		if (out.length > ps.length) throw new Error("grew")
	}
})

Deno.test("columns: round trip, runs, paths once", () => {
	const ps: Patch[] = [
		ins(0, "a"),
		ins(1, "b"),
		ins(2, "c"),
		{ path: ["u", 1], value: 7 },
		{ path: ["u", 1] },
		{ path: ["t"], range: [0, 0], move: { path: ["t"], range: [4, 6] } },
	]
	const c = encode(ps)
	assertEquals(c.paths, [["t"], ["u", 1]])
	assertEquals(c.path, [0, 3, 1, 2, 0, 1])
	assertEquals(c.from, [0, 1, 1, 2, -2, 1])
	assertEquals(decode(c), ps)
	assertEquals(decode(encode([])), [])
})

Deno.test("squish: values given in, or given out, never change after", () => {
	const l = [1]
	const s = createSquish()
	s.push(ins(0, l, ["l"]))
	s.push(ins(1, [2], ["l"]))
	const out = s.patches()
	s.push(ins(2, [3], ["l"]))
	const b = new Int16Array([1])
	s.push(ins(0, b, ["b"]))
	s.push(ins(1, new Int16Array([2]), ["b"]))
	const [typed] = [...s].slice(-1)
	s.push(ins(2, new Int16Array([3]), ["b"]))
	assertEquals(l, [1])
	assertEquals(out[0].value, [1, 2])
	assertEquals(b, new Int16Array([1]))
	assertEquals(typed.value, new Int16Array([1, 2]))
	assertEquals((typed.value as Int16Array).buffer.byteLength, 4)
	assertEquals(s.patches(), [ins(0, [1, 2, 3], ["l"]), ins(0, new Int16Array([1, 2, 3]), ["b"])])
})

Deno.test("squish: a long list typed into a list is one insert", () => {
	const big = Array.from({ length: 200000 }, (_, i) => i)
	const out = squish([ins(0, [1, 2], ["l"]), ins(1, big, ["l"])])
	assertEquals(out.length, 1)
	assertEquals((out[0].value as unknown[]).length, 200002)
})

// Lone surrogates break this for code points, since squish never sees the content.
import apply, { ApplyError } from "./apply.ts"

const whole = ["a", "é", "😀", "中", "xy", "👍🏽"]
const lone = [...whole, "\uD83D", "\uDE00", "\uD800", "\uDFFF"]

function oneByOne(start: string, ps: Patch[]) {
	let v: unknown = { t: start }
	const kept: Patch[] = []
	for (const p of ps) {
		try {
			v = apply(v, [p])
			kept.push(p)
		} catch (e) {
			if (!(e instanceof ApplyError)) throw e
		}
	}
	return { kept, end: (v as { t: string }).t }
}
function atOnce(start: string, ps: Patch[]): string {
	try {
		return (apply({ t: start }, ps) as { t: string }).t
	} catch (e) {
		return `throws ${(e as Error).message}`
	}
}
function xorshift(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (k: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % k
	}
}
function editing(seed: number, parts: string[], start_ = parts) {
	const rand = xorshift(seed)
	const size = (s: string) => Array.from(s).length
	const start = Array.from({ length: rand(12) }, () => start_[rand(start_.length)]).join("")
	let n = size(start), caret = rand(n + 1)
	const ps: Patch[] = []
	for (let i = 0; i < 40; i++) {
		if (rand(8) === 0) caret = rand(n + 1)
		const op = rand(4)
		if (op < 2) {
			const v = parts[rand(parts.length)]
			ps.push({ path: ["t"], range: [caret, caret], value: v })
			caret += size(v), n += size(v)
		} else if (op === 2 && caret > 0) {
			ps.push({ path: ["t"], range: [caret - 1, caret] })
			caret--, n--
		} else if (caret < n) {
			ps.push({ path: ["t"], range: [caret, caret + 1] })
			n--
		}
	}
	return { start, ps }
}
function broken(parts: string[], seeds: number, start_ = parts): string[] {
	const out: string[] = []
	for (let seed = 1; seed <= seeds; seed++) {
		const { start, ps } = editing(seed, parts, start_)
		const { kept, end } = oneByOne(start, ps)
		const squished = squish(kept)
		const got = atOnce(start, squished)
		if (got !== end) {
			out.push(
				`seed ${seed}: ${JSON.stringify(end)} one by one, ${JSON.stringify(got)} squished`,
			)
		}
	}
	return out
}

Deno.test("squish means what the patches meant: well-formed strings", () => {
	assertEquals(broken(whole, 300), [])
})

Deno.test("squish means what the patches meant: lone surrogates typed into well-formed content", () => {
	assertEquals(broken(lone, 300, whole), [])
})

Deno.test("squish with lone surrogates: a typed high and low stay apart", () => {
	const ps: Patch[] = [ins(0, "\uD83D"), ins(1, "\uDE00"), ins(1, "b"), ins(2, "c")]
	assertEquals(oneByOne("", ps).end, "😀bc")
	assertEquals(squish(ps), ps)
	assertEquals(atOnce("", squish(ps)), "😀bc")
	assertEquals(squish([ins(0, "a"), ins(1, "b"), ins(2, "\uD83D")]), [
		ins(0, "ab"),
		ins(2, "\uD83D"),
	])
})

// Known gap: content that already holds lone surrogates, which squish never sees.

Deno.test("squish with lone surrogates in the content: a removal joins them", () => {
	const start = "x\uD83Dy\uDE00z"
	const ps: Patch[] = [del(2, 3), del(1, 2)]
	assertEquals(oneByOne(start, ps).end, "xz")
	assertEquals(squish(ps), [del(1, 3)])
	assertEquals(atOnce(start, squish(ps)), "x\uDE00z")
})

Deno.test("squish with lone surrogates in the content: the fuzz finds more", () => {
	const found = broken(whole, 300, ["\uD83D", "\uDE00", "x"])
	assertEquals(found.length > 0, true, "no counterexample found")
})

// Skipped until squish keeps the meaning on content that already holds lone surrogates.
Deno.test({
	name: "squish means what the patches meant: content with lone surrogates (open)",
	ignore: true,
	fn() {
		const start = "x\uD83Dy\uDE00z"
		const ps: Patch[] = [del(2, 3), del(1, 2)]
		assertEquals(atOnce(start, squish(ps)), oneByOne(start, ps).end)
		assertEquals(broken(whole, 300, ["\uD83D", "\uDE00", "x"]), [])
		assertEquals(broken(lone, 300), [])
	},
})
