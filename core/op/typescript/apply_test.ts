import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Facts, type Patch } from "./apply.ts"
import { squish } from "./squish.ts"
import { facts } from "@ermine/scheduler/notify"

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

Deno.test("apply: the list option starts as [], is a list, and is nothing when empty", () => {
	assertEquals(apply(undefined, [], { list: true }), undefined)
	assertEquals(apply(undefined, [{ path: [], range: [0, 0], value: ["m2"] }], { list: true }), [
		"m2",
	])
	assertEquals(apply(["a"], [{ path: [0] }], { list: true }), undefined)
	assertEquals(apply(["a"], [{ path: [0] }]), [], "without it, an empty list is there")
	for (const value of ["", "abc", 5, null, { a: 1 }]) {
		assertEquals(
			code(() => apply(["m"], [{ path: [], value }], { list: true })),
			"wrong-kind",
			JSON.stringify(value),
		)
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

Deno.test("apply: each is told every patch given, in order, with its facts", () => {
	const ps: Patch[] = [
		{ path: ["t"], range: [2, 2], value: "c" },
		{ path: ["l", 0], value: 2 },
		{ path: ["t"], range: [0, 1] },
	]
	const told: [Patch, Facts][] = []
	const out = apply({ t: "ab", l: [1] }, ps, { each: (p, f) => told.push([p, f]) })
	assertEquals(out, { t: "bc", l: [2] })
	assertEquals(told.map(([p]) => ps.indexOf(p)), [0, 1, 2])
	assertEquals(told.map(([, f]) => f), [
		{ place: { list: false, length: 2, had: true } },
		{ place: { list: true, length: 1, had: true } },
		{ place: { list: false, length: 3, had: true } },
	])
})

Deno.test("apply: invalid, each never hears", () => {
	let told = 0
	code(() =>
		apply({ t: "ab" }, [{ path: ["t"], range: [0, 0], value: "x" }, { path: ["q", 0] }], {
			each: () => told++,
		})
	)
	assertEquals(told, 0)
})

Deno.test("apply: facts at [] say whether a value was there", () => {
	const told: boolean[] = []
	const each = (_p: Patch, f: Facts) => told.push(f.place.had)
	apply(undefined, [{ path: [], value: 1 }, { path: [], value: 2 }], { each })
	// the list option: an empty list is nothing there
	const l = apply(undefined, [{ path: [], value: ["m"] }], { list: true, each })
	apply(l, [{ path: [] }], { list: true, each })
	apply([], [{ path: [], value: ["m"] }], { list: true, each })
	assertEquals(told, [false, true, false, true, false])
})

// apply's facts, against notify's facts() from the whole value before each patch
Deno.test("apply: facts as notify makes them from the value", () => {
	let x = 0
	const rand = (n: number) => (x = xs(x)) % n
	const keys = ["a", "b", "c"]
	function patch(v: Record<string, unknown>): Patch {
		const l = v.l as unknown[], s = v.s as string
		const i = rand(l.length + 1), j = i + rand(l.length - i + 1)
		const c = rand(s.length + 1)
		switch (rand(10)) {
			case 0:
				return { path: ["l"], range: [i, j], value: [rand(9)] }
			case 1:
				return { path: ["l"], range: [i, j] }
			case 2:
				return { path: ["s"], range: [c, c], value: rand(2) ? "x" : "😀" }
			case 3:
				return { path: ["m", keys[rand(3)]], value: rand(9) }
			case 4:
				return { path: ["m", keys[rand(3)]] }
			case 5:
				return l.length
					? {
						path: ["l"],
						range: [i % l.length, i % l.length],
						move: { path: ["l", rand(l.length)] },
					}
					: { path: ["l"], range: [0, 0], value: [1, 2, 3] }
			case 6:
				return l.length > 1
					? {
						path: ["l"],
						range: [0, 0],
						move: { path: ["l"], range: [1, 1 + rand(l.length - 1)] },
					}
					: { path: ["l", 0], value: 0 } as Patch
			case 7:
				return l.length
					? { path: ["m", keys[rand(3)]], move: { path: ["l", rand(l.length)] } }
					: { path: ["s"], range: [0, 0], value: "y" }
			case 8:
				return l.length > 1
					? { path: ["l", rand(l.length - 1)], move: { path: ["l", rand(l.length)] } }
					: { path: ["l", rand(l.length + 1)], value: 7 }
			default:
				return { path: ["l", rand(l.length + 1)], value: 7 }
		}
	}
	for (let seed = 1; seed <= 40; seed++) {
		x = seed
		const start = { l: [1, 2, 3], s: "ab", m: { a: 1 } }
		let v: unknown = start
		const ps: Patch[] = [], befores: unknown[] = []
		// one call each, to have each value before; patches that fail are left out
		for (let step = 0; step < 30; step++) {
			const p = patch(v as Record<string, unknown>)
			try {
				const next = apply(v, [p])
				ps.push(p), befores.push(v)
				v = next
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		}
		const told: Facts[] = []
		assertEquals(apply(start, ps, { each: (_p, f) => told.push(f) }), v, `seed ${seed}`)
		ps.forEach((p, i) =>
			assertEquals(told[i], facts(p, befores[i]), `seed ${seed} ${JSON.stringify(p)}`)
		)
	}
})

Deno.test("apply: the facts of moving the whole onto itself are notify's", () => {
	const told: Facts[] = []
	const p: Patch = { path: [], move: { path: [] } }
	assertEquals(apply({ x: 1 }, [p], { each: (_p, f) => told.push(f) }), { x: 1 })
	assertEquals(told, [facts(p, { x: 1 })])
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
		const told: Facts[] = []
		assertEquals(apply({ s: start }, ps, { each: (_p, f) => told.push(f) }), one, `seed ${seed}`)
		// each patch's length fact: the string's positions before it
		let s = start
		ps.forEach((p, i) => {
			assertEquals(told[i].place.length, Array.from(s).length, `seed ${seed} patch ${i}`)
			const cps = Array.from(s), [a, b] = p.range!
			s = cps.slice(0, a).join("") + ((p.value as string) ?? "") + cps.slice(b).join("")
		})
	}
})
