import { assertEquals } from "@std/assert"
import type { Patch } from "./notify.ts"
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

Deno.test("squish: lists and bytes join; kinds that differ do not", () => {
	assertEquals(squish([ins(0, [1], ["l"]), ins(1, [2, 3], ["l"])]), [ins(0, [1, 2, 3], ["l"])])
	assertEquals(
		squish([ins(0, new Uint8Array([1]), ["b"]), ins(1, new Uint8Array([2]), ["b"])]),
		[ins(0, new Uint8Array([1, 2]), ["b"])],
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

// apply, for strings under "t" only
function apply(t: string, ps: Patch[]): string {
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
			doc = apply(doc, [p])
			ps.push(p)
			if (rnd(2) && rnd(2)) ps.push(ins(Array.from(doc).length, "!"))
			doc = apply(start, ps)
		}
		const out = squish(ps)
		assertEquals(apply(start, out), doc, `seed ${seed}`)
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
	const b = new Uint8Array([1])
	s.push(ins(0, b, ["b"]))
	s.push(ins(1, new Uint8Array([2]), ["b"]))
	const [bytes] = [...s].slice(-1)
	s.push(ins(2, new Uint8Array([3]), ["b"]))
	assertEquals(l, [1])
	assertEquals(out[0].value, [1, 2])
	assertEquals(b, new Uint8Array([1]))
	assertEquals(bytes.value, new Uint8Array([1, 2]))
	assertEquals((bytes.value as Uint8Array).buffer.byteLength, 2)
	assertEquals(s.patches(), [ins(0, [1, 2, 3], ["l"]), ins(0, new Uint8Array([1, 2, 3]), ["b"])])
})

// found by the audit of 10-11

Deno.test("squish: a long list typed into a list is one insert", () => {
	const big = Array.from({ length: 200000 }, (_, i) => i)
	const out = squish([ins(0, [1, 2], ["l"]), ins(1, big, ["l"])])
	assertEquals(out.length, 1)
	assertEquals((out[0].value as unknown[]).length, 200002)
})
