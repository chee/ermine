import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Patch } from "./apply.ts"
import { squish } from "./squish.ts"

// a fuzz's numbers: xorshift (an LCG's low bits repeat, so % k of one is patterned)
const xs = (x: number) => {
	x = x || 1
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return x >>> 0
}

const error = (f: () => unknown) => assertThrows(f, ApplyError) as ApplyError
const code = (f: () => unknown) => error(f).code

Deno.test("apply: puts and removals; the value given unchanged", () => {
	const v = { t: "hi", l: [1, 2], m: { a: { b: 1 } } }
	const out = apply(v, [
		{ path: ["x"], value: 1 },
		{ path: ["l", 0] },
		{ path: ["gone"] },
		{ path: ["m", "a", "c"], value: null },
	])
	assertEquals(out, { t: "hi", l: [2], m: { a: { b: 1, c: null } }, x: 1 })
	assertEquals(v, { t: "hi", l: [1, 2], m: { a: { b: 1 } } })
})

Deno.test("apply: spans of strings in code points, lists, typed arrays", () => {
	const out = apply({ s: "a😀b", l: [1, 2, 3], t: new Int16Array([1, 2, 3]) }, [
		{ path: ["s"], range: [1, 2], value: "x" },
		{ path: ["l"], range: [0, 2], value: [9] },
		{ path: ["t"], range: [3, 3], value: new Int16Array([4]) },
	])
	assertEquals(out, { s: "axb", l: [9, 3], t: new Int16Array([1, 2, 3, 4]) })
})

Deno.test("apply: bytes are one whole value, never spliced", () => {
	const b = new Uint8Array([1, 2, 3])
	const into = (p: Patch) => code(() => apply({ b }, [p]))
	assertEquals(into({ path: ["b"], range: [3, 3], value: new Uint8Array([4]) }), "wrong-kind")
	assertEquals(into({ path: ["b"], range: [0, 1] }), "wrong-kind")
	assertEquals(into({ path: ["b", 0], value: 9 }), "wrong-kind")
	// a typed array takes no bytes into it
	const t = new Int8Array([1])
	assertEquals(
		code(() => apply(t, [{ path: [], range: [1, 1], value: new Uint8Array([2]) }])),
		"wrong-kind",
	)
	// a put replaces them whole, a view as given
	const view = new Uint8Array([0, 7, 8, 0]).subarray(1, 3)
	assertStrictEquals((apply({ b }, [{ path: ["b"], value: view }]) as { b: Uint8Array }).b, view)
	assertEquals(b, new Uint8Array([1, 2, 3]))
})

Deno.test("apply: what is not touched is shared, the value given unchanged", () => {
	const old = { a: { x: 1 }, b: { y: 2 } }
	const now = apply(old, [{ path: ["a", "x"], value: 3 }, {
		path: ["a", "z"],
		value: 4,
	}]) as typeof old
	assertEquals(old, { a: { x: 1 }, b: { y: 2 } })
	assertEquals(now.a, { x: 3, z: 4 } as unknown)
	assertStrictEquals(now.b, old.b)
	// no patch: the value itself
	assertStrictEquals(apply(old, []), old)
})

Deno.test("apply: a value put is not changed by a later patch", () => {
	const put = { x: [1] }
	const out = apply({}, [
		{ path: ["a"], value: put },
		{ path: ["a", "x", 0], value: 2 },
		{ path: ["a", "x"], range: [1, 1], value: [3] },
	])
	assertEquals(out, { a: { x: [2, 3] } })
	assertEquals(put, { x: [1] })
})

Deno.test("apply: squished typing gives what the typing gives", () => {
	const typing: Patch[] = [..."hello"].map((c, i) => ({ path: ["t"], range: [i, i], value: c }))
	const one = apply({ t: "" }, typing)
	assertEquals(one, { t: "hello" })
	assertEquals(apply({ t: "" }, squish(typing)), one)
})

Deno.test("apply: moves leave first, then land in what is left", () => {
	const v = { l: ["a", "b", "c"], m: {} }
	assertEquals(
		apply(v, [
			{ path: ["l"], range: [0, 0], move: { path: ["l", 2] } },
			{ path: ["m", "k"], move: { path: ["l", 1] } },
		]),
		{ l: ["c", "b"], m: { k: "a" } },
	)
	assertEquals(
		code(() => apply({ m: { k: 1 } }, [{ path: ["m", "k", "x"], move: { path: ["m"] } }])),
		"into-itself",
	)
	// a span, into a span of what is left
	assertEquals(
		apply("abcdef", [{ path: [], range: [0, 0], move: { path: [], range: [4, 6] } }]),
		"efabcd",
	)
})

Deno.test("apply: nothing there; a put at [] makes a value, a removal there leaves none", () => {
	assertEquals(apply(undefined, []), undefined)
	assertEquals(apply(undefined, [{ path: [], value: { a: 1 } }]), { a: 1 })
	assertEquals(apply(undefined, [{ path: [], value: null }]), null)
	assertEquals(apply({ a: 1 }, [{ path: [] }]), undefined)
	for (
		const p of [{ path: [] }, { path: ["a"], value: 1 }, { path: [], range: [0, 0], value: "x" }]
	) {
		assertEquals(code(() => apply(undefined, [p as Patch])), "no-key", JSON.stringify(p))
	}
})

Deno.test("apply: invalid, its code and index; nothing changes", () => {
	const v = { s: "ab", l: [1], m: {} }
	const cases: [Patch[], string, number][] = [
		[[{ path: ["s"], range: [1, 3] }], "range", 0],
		[[{ path: ["s"], range: [0, 0], value: [1] }], "wrong-kind", 0],
		[[{ path: ["l", "x"], value: 1 }], "wrong-kind", 0],
		[[{ path: ["l", 1], value: 1 }], "no-key", 0],
		[[{ path: ["m", "x", "y"], value: 1 }], "no-key", 0],
		[[{ path: ["s", 0], value: "x" }], "wrong-kind", 0],
		[[{ path: "s" } as unknown as Patch], "not-a-patch", 0],
		[[{ path: ["l", 0], value: 2 }, { path: ["q", 0] }], "no-key", 1],
		[[{ path: ["s"], range: [0, 0], value: "x" }, { path: ["l", -1] }], "not-a-patch", 1],
		[[{ path: ["x"], value: 1 }, { path: ["x", "y"], move: { path: ["x"] } }], "into-itself", 1],
	]
	for (const [ps, c, i] of cases) {
		const e = error(() => apply(v, ps))
		assertEquals([e.code, e.patch], [c, i], JSON.stringify(ps))
	}
	assertEquals(v, { s: "ab", l: [1], m: {} })
})

Deno.test("apply: undo, asked for, is pushed once all have landed; a throw leaves it", () => {
	const undo: Patch[] = [{ path: ["mine"] }]
	const v = { t: "ab", l: [1, 2] }
	const ps: Patch[] = [{ path: ["t"], range: [2, 2], value: "c" }, { path: ["l", 0] }]
	const out = apply(v, ps, { undo })
	assertEquals(undo, [
		{ path: ["mine"] },
		{ path: ["l"], range: [0, 0], value: [1] },
		{ path: ["t"], range: [2, 3] },
	])
	assertEquals(apply(out, undo.slice(1)), v)
	code(() => apply(v, [...ps, { path: ["q", 0] }], { undo }))
	assertEquals(undo.length, 3)
})

// many string patches in one call walk from what the last left (walk-string's near): the same end
// as one call each, which never does
Deno.test("apply: fuzz, string edits in one call as one call each", () => {
	const parts = ["a", "é", "😀", "\uD83D", "\uDE00", "中", "xy"]
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed
		const rand = (k: number) => (x = xs(x)) % k
		const start = Array.from({ length: rand(30) }, () => parts[rand(parts.length)]).join("")
		let one: unknown = { s: start }
		const ps: Patch[] = []
		for (let step = 0; step < 60; step++) {
			const s = (one as { s: string }).s, n = Array.from(s).length
			// typing runs, backspaces, deletes, replaces, at random places and at the last caret
			const near = ps.length && rand(2) ? (ps[ps.length - 1].range![0] + 1) : rand(n + 2)
			const a = Math.min(near, n + 1), b = a + rand(3)
			const p: Patch = rand(3)
				? { path: ["s"], range: [a, b], value: parts[rand(parts.length)] }
				: { path: ["s"], range: [a, b] }
			try {
				one = apply(one, [p])
				ps.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		}
		assertEquals(apply({ s: start }, ps), one, `seed ${seed}`)
	}
})

Deno.test("apply cow: false: the containers given change, the root returned is the one given", () => {
	const l = [1, 2],
		m: Record<string, Record<string, number>> = { a: { b: 1 } },
		v = { t: "hi", l, m, n: new Int16Array([1, 2, 3]) }
	const n = v.n
	const out = apply(v, [
		{ path: ["l"], range: [2, 2], value: [3] },
		{ path: ["m", "a", "c"], value: 2 },
		{ path: ["t"], range: [2, 2], value: "!" },
		{ path: ["n"], range: [0, 2], value: new Int16Array([9, 8]) },
	], { cow: false })
	assertStrictEquals(out, v)
	assertStrictEquals(v.l, l)
	assertStrictEquals(v.m, m)
	assertStrictEquals(v.m.a, m.a)
	assertEquals(v, {
		t: "hi!",
		l: [1, 2, 3],
		m: { a: { b: 1, c: 2 } },
		n: new Int16Array([9, 8, 3]),
	})
	// a typed array whose length stays is changed where it is, a string is put new
	assertStrictEquals(v.n, n)
	apply(v, [{ path: ["n"], range: [1, 2] }], { cow: false })
	assert(v.n !== n)
	assertEquals(v.n, new Int16Array([9, 3]))
	// the whole replaced: the root returned is the new one
	assertEquals(apply(v, [{ path: [], value: 5 }], { cow: false }), 5)
})

Deno.test("apply cow: false: the same value and undo as copy-on-write", () => {
	const make = () => ({ l: [1, [2, 3]], m: { a: { b: [4] }, c: "x" }, s: "héllo" })
	const ps: Patch[] = [
		{ path: ["l", 1], range: [0, 1] },
		{ path: ["m", "a", "b"], range: [1, 1], value: [5] },
		{ path: ["l", 0], move: { path: ["m", "a"] } },
		{ path: ["s"], range: [1, 2], value: "e" },
		{ path: ["m", "c"] },
		{ path: ["m", "z"], move: { path: ["l", 0] } },
	]
	const was: Patch[] = [], now: Patch[] = []
	const a = apply(make(), ps, { undo: was }), b = apply(make(), ps, { undo: now, cow: false })
	assertEquals(b, a)
	assertEquals(now, was)
	// and no undo asked for
	assertEquals(apply(make(), ps, { cow: false }), a)
})

Deno.test("apply cow: false: a refused patch undoes what was done, in place; the same error", () => {
	const l = [1, [2, 3]], m = { a: { b: 1 }, c: 2 }
	const v: Record<string, unknown> = { l, m, t: "abc", n: new Int8Array([1, 2]) }
	const was = structuredClone(v)
	const bad: Patch[][] = [
		[{ path: ["l"], range: [0, 0], value: [0] }, { path: ["m", "a", "x"], value: 1 }, {
			path: ["q", "r"],
			value: 1,
		}],
		// a take, then a landing that is refused
		[{ path: ["m", "c"] }, { path: ["t"], range: [9, 9], move: { path: ["l", 0] } }],
		[{ path: ["m", "x", "y"], move: { path: ["m", "c"] } }],
		[{ path: ["t"], range: [0, 1], value: "z" }, { path: [], value: 7 }, {
			path: ["a"],
			value: 1,
		}],
		[{ path: ["n"], range: [0, 1], value: new Int8Array([5]) }, { path: ["t", 0] }],
	]
	for (const ps of bad) {
		const e = error(() => apply(structuredClone(v), ps))
		const err = error(() => apply(v, ps, { cow: false }))
		assertEquals([err.code, err.patch], [e.code, e.patch], JSON.stringify(ps))
		assertEquals(v, was, JSON.stringify(ps))
		assertStrictEquals(v.l, l)
		assertStrictEquals(v.m, m)
		assertEquals(Object.keys(v), ["l", "m", "t", "n"])
	}
})

Deno.test("apply: a span of any length goes in and moves, past what a call's arguments hold", () => {
	const big = Array.from({ length: 300000 }, (_, i) => i)
	for (const cow of [true, false]) {
		const put = apply({ a: [0, 1] } as any, [{ path: ["a"], range: [1, 1], value: big }], {
			cow,
		}) as any
		assertEquals([put.a.length, put.a[1], put.a[300000], put.a[300001]], [300002, 0, 299999, 1])
		const moved = apply({ a: big, b: [] } as any, [
			{ path: ["b"], range: [0, 0], move: { path: ["a"], range: [0, 300000] } },
		], { cow }) as any
		assertEquals([moved.a.length, moved.b.length, moved.b[299999]], [0, 300000, 299999])
	}
})

Deno.test("apply: a value nested far deeper than the call stack moves in place and comes back by its undo", () => {
	let deep: unknown = null
	for (let i = 0; i < 200000; i++) deep = { a: deep }
	const depth = (v: any) => {
		let n = 0
		for (; v !== null; v = v.a) n++
		return n
	}
	const v: any = { x: deep, y: 1 }
	const undo: Patch[] = []
	const out = apply(v, [{ path: ["z"], move: { path: ["x"] } }], { cow: false, undo }) as any
	assertEquals([depth(out.z), "x" in out], [200000, false])
	const back = apply(out, undo, { cow: false }) as any
	assertEquals([depth(back.x), "z" in back], [200000, false])
})
