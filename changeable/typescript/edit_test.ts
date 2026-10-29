// edit: each mutation as the patches it should be, and the oracle: apply(base, edit(base,
// recipe)) is what the recipe makes of a clone of base, base is untouched, and the undo restores it.
// a few dozen seeds (fuzz runs small)
import { assertEquals, assertNotStrictEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { type Patch } from "./apply.ts"
import edit, { type Helpers, nothing } from "./edit.ts"

const run = (base: unknown, recipe: (d: any, h: Helpers) => unknown) => edit(base, recipe as never)
const after = (base: unknown, recipe: (d: any, h: Helpers) => unknown) =>
	apply(base, run(base, recipe))

Deno.test("a deep field set is one patch at its path", () => {
	const base = { a: { b: { c: 1, d: 2 } }, big: [1, 2, 3] }
	assertEquals(run(base, (d) => void (d.a.b.c = 5)), [{ path: ["a", "b", "c"], value: 5 }])
	assertEquals(base, { a: { b: { c: 1, d: 2 } }, big: [1, 2, 3] })
})

Deno.test("a key set to what it is makes nothing", () => {
	assertEquals(run({ a: 1, l: [1] }, (d) => void (d.a = 1, d.l[0] = 1, d.l = d.l)), [])
})

Deno.test("a key deleted is a removal, a missing one nothing", () => {
	assertEquals(run({ a: 1, b: 2 }, (d) => void delete d.a), [{ path: ["a"] }])
	assertEquals(run({ a: 1 }, (d) => void delete d.z), [])
})

Deno.test("a new key is a put", () => {
	assertEquals(run({}, (d) => void (d.x = { y: [1] })), [{ path: ["x"], value: { y: [1] } }])
})

Deno.test("list: index set, push, pop, shift, unshift", () => {
	const base = { l: [1, 2, 3] }
	assertEquals(run(base, (d) => void (d.l[1] = 9)), [{ path: ["l", 1], value: 9 }])
	assertEquals(run(base, (d) => void assertEquals(d.l.push(4, 5), 5)), [
		{ path: ["l"], range: [3, 3], value: [4, 5] },
	])
	assertEquals(run(base, (d) => void (d.l[3] = 4)), [{ path: ["l"], range: [3, 3], value: [4] }])
	assertEquals(run(base, (d) => void assertEquals(d.l.pop(), 3)), [{ path: ["l"], range: [2, 3] }])
	assertEquals(run(base, (d) => void assertEquals(d.l.shift(), 1)), [{
		path: ["l"],
		range: [0, 1],
	}])
	assertEquals(run(base, (d) => void assertEquals(d.l.unshift(7), 4)), [
		{ path: ["l"], range: [0, 0], value: [7] },
	])
	assertEquals(run(base, (d) => void d.l.push()), [])
	assertEquals(run({ l: [] }, (d) => void [d.l.pop(), d.l.shift()]), [])
})

Deno.test("list: splice, length", () => {
	const base = { l: [1, 2, 3, 4, 5] }
	assertEquals(
		run(base, (d) => void assertEquals(d.l.splice(1, 2, "a"), [2, 3])),
		[{ path: ["l"], range: [1, 3], value: ["a"] }],
	)
	assertEquals(run(base, (d) => void assertEquals(d.l.splice(-2), [4, 5])), [
		{ path: ["l"], range: [3, 5] },
	])
	assertEquals(run(base, (d) => void d.l.splice(1, 0)), [])
	assertEquals(run(base, (d) => void (d.l.length = 2)), [{ path: ["l"], range: [2, 5] }])
	assertEquals(run(base, (d) => void (d.l.length = 5)), [])
	assertThrows(() => run(base, (d) => void (d.l.length = 9)), RangeError)
	assertThrows(() => run(base, (d) => void (d.l[9] = 1)), RangeError)
	assertThrows(() => run(base, (d) => void delete d.l[0]), TypeError)
})

Deno.test("list: sort and reverse are moves, few", () => {
	const base = { l: [3, 1, 2, 9] }
	// the run 1 2 9 stays: the 3 is taken out of 0 and put at the gap 2
	assertEquals(run(base, (d) => void d.l.sort()), [
		{ path: ["l"], range: [2, 2], move: { path: ["l"], range: [0, 1] } },
	])
	assertEquals(run({ l: [1, 2] }, (d) => void d.l.sort()), [])
	assertEquals(run({ l: [] }, (d) => void d.l.reverse()), [])
	assertEquals(run({ l: [1, 2, 3, 4] }, (d) => void d.l.reverse()).length, 3)
	assertEquals(after(base, (d) => void d.l.reverse()), { l: [9, 2, 1, 3] })
	assertEquals(after(base, (d) => void d.l.sort((a: number, b: number) => b - a)), {
		l: [9, 3, 2, 1],
	})
	// a sorted list with one out of place: one move
	assertEquals(run({ l: [1, 2, 5, 3, 4, 6] }, (d) => void d.l.sort()).length, 1)
	// equal elements are not moved among themselves
	assertEquals(run({ l: ["a", "b", "a", "b"] }, (d) => void d.l.sort()).length, 1)
	assertEquals(after({ l: ["b", "a", "b", "a"] }, (d) => void d.l.sort()), {
		l: ["a", "a", "b", "b"],
	})
	const t = { t: new Int16Array([5, 4, 3, 2]) }
	assertEquals(after(t, (d) => void d.t.sort()), { t: new Int16Array([2, 3, 4, 5]) })
})

Deno.test("list: fill and copyWithin are one span", () => {
	const base = { l: [3, 1, 2, 9] }
	assertEquals(run(base, (d) => void d.l.fill(0, 1, 3)), [
		{ path: ["l"], range: [1, 3], value: [0, 0] },
	])
	assertEquals(run(base, (d) => void d.l.fill(9, 3)), [])
	assertEquals(run(base, (d) => void d.l.copyWithin(0, 2)), [
		{ path: ["l"], range: [0, 2], value: [2, 9] },
	])
})

Deno.test("a draft held across a change of its list is still where it is", () => {
	const base = { l: [{ n: 1 }, { n: 2 }] }
	const patches = run(base, (d) => {
		const second = d.l[1]
		d.l.unshift({ n: 0 })
		second.n = 22
		d.l.reverse()
		second.n = 222
		d.l.pop()
		second.n = 2222
	})
	const at = (n: number) => patches.find((p) => p.value === n)!.path
	assertEquals(at(22), ["l", 2, "n"])
	assertEquals(at(222), ["l", 0, "n"])
	assertEquals(at(2222), ["l", 0, "n"])
	assertEquals(apply(base, patches), { l: [{ n: 2222 }, { n: 1 }] })
})

Deno.test("a draft taken out of its list makes no more patches", () => {
	const base = { l: [{ n: 1 }, { n: 2 }] }
	const patches = run(base, (d) => {
		const gone = d.l.pop()
		gone.n = 5
		d.l.push(gone)
		gone.n = 6
	})
	assertEquals(patches, [
		{ path: ["l"], range: [1, 2] },
		{ path: ["l"], range: [1, 1], value: [{ n: 5 }] },
	])
})

Deno.test("a part of the draft assigned elsewhere is put as the value it has then", () => {
	const base = { a: { x: [1, 2] }, big: { deep: { deeper: [1] } } }
	const patches = run(base, (d) => {
		d.a.x.push(3)
		d.b = d.a
		d.a.x.push(4)
		d.c = d.big
	})
	assertEquals(patches[1], { path: ["b"], value: { x: [1, 2, 3] } })
	assertEquals(patches[2], { path: ["a", "x"], range: [3, 3], value: [4] })
	// what was never touched is shared
	assertStrictEquals(patches[3].value as any, base.big)
	assertEquals((apply(base, patches) as any).b, { x: [1, 2, 3] })
})

Deno.test("a draft inside a value assigned is the value it has", () => {
	const base = { a: { x: 1 }, l: [] as unknown[] }
	const [, put] = run(base, (d) => {
		d.a.x = 2
		d.l.push({ held: d.a }, [d.a])
	})
	assertEquals(put.value, [{ held: { x: 2 } }, [{ x: 2 }]])
})

Deno.test("a value assigned is read as a draft of it, and the value is not changed", () => {
	const mine = { y: 1 }
	const patches = run({}, (d) => {
		d.x = mine
		d.x.y = 2
	})
	assertEquals(patches, [{ path: ["x"], value: { y: 1 } }, { path: ["x", "y"], value: 2 }])
	assertEquals(mine, { y: 1 })
})

Deno.test("undefined on a key is a removal; in a list it is refused", () => {
	assertEquals(run({ a: 1, b: 2 }, (d) => void (d.a = undefined)), [{ path: ["a"] }])
	assertEquals(run({ a: 1 }, (d) => void (d.z = undefined)), [])
	assertEquals(after({ a: 1, b: 2 }, (d) => void (d.a = undefined)), { b: 2 })
	assertThrows(() => run({ l: [1] }, (d) => void (d.l[0] = undefined)), TypeError)
	assertThrows(() => run({ l: [1] }, (d) => void d.l.push(undefined)), TypeError)
	assertThrows(() => run({ l: [1] }, (d) => void d.l.fill(undefined)), TypeError)
})

Deno.test("splice: a string counts code points, and is read as it is after", () => {
	const base = { s: "a🙂bc", l: ["xyz", "q"] }
	assertEquals(
		run(base, (d, { splice }) => {
			assertEquals(splice(d, "s", 1, 2, "--"), "a--c")
			assertEquals(d.s, "a--c")
		}),
		[{ path: ["s"], range: [1, 3], value: "--" }],
	)
	assertEquals(run(base, (d, { splice }) => void splice(d, "s", 4, 0)), [])
	assertEquals(run(base, (d, { splice }) => void splice(d.l, 0, 1, 2)), [
		{ path: ["l", 0], range: [1, 3] },
	])
	assertEquals(after(base, (d, { splice }) => void splice(d.l, 1, 0, 0, ">")), {
		s: "a🙂bc",
		l: ["xyz", ">q"],
	})
	assertThrows(() => run(base, (d, { splice }) => void splice(d, "s", 9, 0, "x")), RangeError)
	assertThrows(() => run(base, (d, { splice }) => void splice(d, "nope", 0, 0, "x")), RangeError)
	assertThrows(() => run(base, (d, { splice }) => void splice(d, "s", 0, 0, 1)), TypeError)
	assertEquals(base, { s: "a🙂bc", l: ["xyz", "q"] })
})

Deno.test("splice: the root string, and a deep string after a change above it", () => {
	assertEquals(
		run("hello", (s, { splice }) => {
			s = splice(s, 0, 1, "J")
			assertEquals(splice(s, 4, 1), "Jell")
		}),
		[{ path: [], range: [0, 1], value: "J" }, { path: [], range: [4, 5] }],
	)
	assertThrows(() => run(1, (n, { splice }) => void splice("x", 0, 0)), TypeError)
	const base = { l: [{ s: "ab" }, { s: "cd" }] }
	const patches = run(base, (d, { splice }) => {
		const second = d.l[1]
		d.l.unshift({ s: "" })
		splice(second, "s", 2, 0, "!")
	})
	assertEquals(patches[1], { path: ["l", 2, "s"], range: [2, 2], value: "!" })
})

Deno.test("splice: a typed array may change its length", () => {
	const base = { t: new Int16Array([1, 2, 3]) }
	assertEquals(
		run(base, (d, { splice }) => void splice(d, "t", 1, 1, new Int16Array([7, 8]))),
		[{ path: ["t"], range: [1, 2], value: new Int16Array([7, 8]) }],
	)
	assertEquals(
		after(base, (d, { splice }) => void splice(d, "t", 0, 3)),
		{ t: new Int16Array([]) },
	)
	assertThrows(
		() => run(base, (d, { splice }) => void splice(d, "t", 0, 0, new Int32Array([1]))),
		TypeError,
	)
	run(base, (d, { splice }) => {
		const t = d.t
		splice(d, "t", 0, 1)
		assertEquals([...d.t], [2, 3])
		assertEquals(t.length, 3)
	})
})

Deno.test("nothing is on the helpers too", () => {
	assertEquals(run({ a: 1 }, (_, h) => h.nothing), [{ path: [] }])
})

Deno.test("a recipe may return a value: a put at the whole", () => {
	assertEquals(run({ a: 1 }, () => ({ b: 2 })), [{ path: [], value: { b: 2 } }])
	assertEquals(run({ a: 1 }, (d) => ({ c: d })), [{ path: [], value: { c: { a: 1 } } }])
	assertEquals(run({ a: 1 }, (d) => d), [])
	assertEquals(run({ a: 1 }, () => nothing), [{ path: [] }])
	assertThrows(() => run({ a: 1 }, (d) => (d.a = 2, { b: 1 })), TypeError)
})

Deno.test("a base that is no container: the recipe can only return", () => {
	assertEquals(run(1, (n) => n + 1), [{ path: [], value: 2 }])
	assertEquals(run("abc", (s) => s + "d"), [{ path: [], value: "abcd" }])
	assertEquals(run("abc", () => {}), [])
	assertEquals(run(1, (n) => n), [])
	const bytes = new Uint8Array([1, 2])
	assertEquals(run(bytes, (b) => assertStrictEquals(b, bytes)), [])
})

Deno.test("bytes, maps, sets, class instances, symbols are leaves", () => {
	class Live {}
	const bytes = new Uint8Array([1]), map = new Map(), live = new Live(), sym = Symbol("s")
	const base = { bytes, map, live, sym }
	run(base, (d) => {
		assertStrictEquals(d.bytes, bytes)
		assertStrictEquals(d.map, map)
		assertStrictEquals(d.live, live)
		assertStrictEquals(d.sym, sym)
	})
	const next = new Uint8Array([2])
	assertEquals(run(base, (d) => void (d.bytes = next)), [{ path: ["bytes"], value: next }])
})

Deno.test("typed arrays: elements and the in place methods are ranges", () => {
	const base = { t: new Int16Array([5, 4, 3, 2]) }
	assertEquals(run(base, (d) => void (d.t[1] = 9)), [
		{ path: ["t"], range: [1, 2], value: new Int16Array([9]) },
	])
	assertEquals(run(base, (d) => void (d.t[1] = 4)), [])
	assertEquals(run(base, (d) => void (d.t[7] = 4)), [])
	assertEquals(run(base, (d) => void d.t.sort()).length, 3)
	assertEquals(run(base, (d) => void d.t.sort())[0].move, { path: ["t"], range: [3, 4] })
	assertEquals(after(base, (d) => void d.t.set([7, 8], 1)), { t: new Int16Array([5, 7, 8, 2]) })
	assertEquals(after(base, (d) => void d.t.fill(1, 2)), { t: new Int16Array([5, 4, 1, 1]) })
	assertEquals(after(base, (d) => void d.t.reverse()), { t: new Int16Array([2, 3, 4, 5]) })
	assertEquals(after(base, (d) => void d.t.copyWithin(0, 2)), { t: new Int16Array([3, 2, 3, 2]) })
	run(base, (d) => {
		assertEquals(d.t.length, 4)
		assertEquals([...d.t], [5, 4, 3, 2])
		assertEquals(d.t.slice(1, 3), new Int16Array([4, 3]))
	})
	assertEquals(base.t, new Int16Array([5, 4, 3, 2]))
})

Deno.test("reads see the draft as it is", () => {
	run({ a: 1, l: [3, 1, 2] }, (d) => {
		d.a = 2
		d.b = 3
		d.l.sort()
		d.l.push(4)
		assertEquals(d.a + d.b, 5)
		assertEquals(Object.keys(d), ["a", "l", "b"])
		assertEquals(d.l.length, 4)
		assertEquals([...d.l], [1, 2, 3, 4])
		assertEquals(d.l.map((x: number) => x * 2), [2, 4, 6, 8])
		assertEquals(d.l.indexOf(3), 2)
		assertEquals(JSON.stringify(d), '{"a":2,"l":[1,2,3,4],"b":3}')
		assertEquals("a" in d, true)
		assertEquals(Array.isArray(d.l), true)
	})
})

Deno.test("what is never touched is shared; the base is never changed", () => {
	const base = { a: { x: 1 }, b: { y: [1, 2] }, c: [{ z: 1 }] }
	const frozen = structuredClone(base)
	const patches = run(base, (d) => {
		d.a.x = 2
		d.c[0]
	})
	assertEquals(patches.length, 1)
	assertEquals(base, frozen)
	const next = apply(base, patches) as typeof base
	assertStrictEquals(next.b, base.b)
	assertStrictEquals(next.c, base.c)
	assertNotStrictEquals(next.a, base.a)
})

Deno.test("a draft used after edit returned throws", () => {
	let kept: any
	run({ a: { x: 1 } }, (d) => void (kept = d.a))
	assertThrows(() => kept.x, TypeError)
	assertThrows(() => void (kept.x = 2), TypeError)
})

// the oracle -------------------------------------------------------------------------------

function rng(seed: number) {
	let s = seed >>> 0
	const next = () => {
		s = (s + 0x6D2B79F5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const int = (n: number) => Math.floor(next() * n)
	return { int, pick: <T>(a: readonly T[]): T => a[int(a.length)] }
}
type Rng = ReturnType<typeof rng>

const keys = ["a", "b", "c", "d", "e"]
function leaf(r: Rng): unknown {
	return r.pick<() => unknown>([
		() => r.int(100),
		() => "s" + r.int(10),
		() => r.int(2) === 0,
		() => null,
		() => "🙂" + r.int(5),
	])()
}
function make(r: Rng, depth: number): unknown {
	const k = r.int(depth > 2 ? 4 : 8)
	if (k < 3) return leaf(r)
	if (k === 3) {
		return r.pick<() => unknown>([
			() => new Int16Array(Array.from({ length: r.int(5) }, () => r.int(50))),
			() => new Uint8Array(Array.from({ length: r.int(4) }, () => r.int(256))),
			() => new Float64Array(Array.from({ length: r.int(4) }, () => r.int(9) / 2)),
		])()
	}
	if (k < 6) {
		const o: Record<string, unknown> = {}
		for (let i = r.int(5); i > 0; i--) o[r.pick(keys)] = make(r, depth + 1)
		return o
	}
	return Array.from({ length: r.int(6) }, () => make(r, depth + 1))
}

const list = Array.isArray
// a draft of a typed array is no view: it is seen by what it can do
const isTyped = (v: any) =>
	typeof v === "object" && v !== null && !list(v) && !(v instanceof Uint8Array) &&
	typeof v.copyWithin === "function"
const container = (v: unknown): v is any =>
	typeof v === "object" && v !== null && !(v instanceof Uint8Array) &&
	(list(v) || isTyped(v) || Object.getPrototypeOf(v) === Object.prototype)
const keysof = (v: any): (string | number)[] => list(v) ? [...v.keys()] : Object.keys(v)

// descend from the root by random steps; the containers met. the draft and a clone read the same,
// so both runs choose the same
function descend(root: any, r: Rng): any[] {
	const at = [root]
	for (let v = root; r.int(3) > 0;) {
		const next = isTyped(v) ? [] : keysof(v).filter((k) => container(v[k]))
		if (!next.length) break
		v = v[r.pick(next)]
		at.push(v)
	}
	return at
}

// one random change; same choices on a draft and on a clone. a copy is of a draft's part itself,
// of a clone's a structuredClone of it
function change(root: any, r: Rng, drafted: boolean, h?: Helpers) {
	const at = descend(root, r), t = at[at.length - 1]
	// not what holds t (that would be a cycle)
	const share = (v: unknown) =>
		at.includes(v) ? leaf(r) : drafted || !container(v) ? v : structuredClone(v)
	if (isTyped(t)) {
		const hi = t.length || 1
		switch (r.int(6)) {
			case 0:
				return void (t[r.int(hi)] = r.int(40))
			case 1:
				return void t.fill(r.int(40), r.int(hi))
			case 2:
				return void t.reverse()
			case 3:
				return void t.sort()
			case 4:
				return void t.copyWithin(r.int(hi), r.int(hi))
			default: {
				const at = r.int(t.length + 1)
				return void t.set(
					Array.from({ length: r.int(Math.min(3, t.length - at) + 1) }, () => r.int(40)),
					at,
				)
			}
		}
	}
	if (list(t)) {
		const len = t.length
		switch (r.int(13)) {
			case 0:
				return void (len && (t[r.int(len)] = make(r, 2)))
			case 1:
				return void t.push(...Array.from({ length: r.int(3) }, () => make(r, 2)))
			case 2:
				return void t.pop()
			case 3:
				return void t.shift()
			case 4:
				return void t.unshift(make(r, 2))
			case 5:
				return void t.splice(
					r.int(len + 1),
					r.int(3),
					...Array.from({ length: r.int(3) }, () => make(r, 2)),
				)
			case 6:
				return void (t.length = r.int(len + 1))
			case 7:
				return void t.sort()
			case 11: {
				// a string in the list, spanned
				const ss = keysof(t).filter((k) => typeof (t as any)[k] === "string")
				return ss.length ? respan(t, r.pick(ss), r, h) : void t.pop()
			}
			case 8:
				return void t.reverse()
			case 9:
				return void t.fill(leaf(r), r.int(len + 1))
			case 10:
				// copying parts of a list of parts would alias them in a clone, and not in patches
				if (t.some(container)) return
				return void t.copyWithin(r.int(len + 1), r.int(len + 1))
			default: {
				// a copy of a part somewhere else in
				const from = descend(root, r), src = from[from.length - 1]
				return void t.push(share(src))
			}
		}
	}
	const ks = Object.keys(t)
	switch (r.int(6)) {
		case 0:
			return void (t[r.pick(keys)] = make(r, 2))
		case 1: {
			if (!ks.length) return
			const k = r.pick(ks), undef = r.int(2)
			// undefined is a removal
			return void (drafted && undef ? t[k] = undefined : delete t[k])
		}
		case 5: {
			const ss = ks.filter((k) => typeof t[k] === "string" || isTyped(t[k]))
			if (!ss.length) return void (t[r.pick(keys)] = leaf(r))
			return respan(t, r.pick(ss), r, h)
		}
		case 2: {
			const from = descend(root, r)
			return void (t[r.pick(keys)] = share(from[from.length - 1]))
		}
		case 3: {
			// a change held across a change of the list it is in
			const lists = at.filter((x) => list(x) && x.some(container))
			if (!lists.length) return void (t[r.pick(keys)] = leaf(r))
			const l = r.pick(lists), held = l[r.pick(keysof(l).filter((k) => container(l[k])))]
			l.unshift(make(r, 3))
			return change(held, r, drafted, h)
		}
		default:
			return void (t[r.pick(keys)] = leaf(r))
	}
}

// a span of the string or typed array at t[k] replaced: by the helper, or in a clone by hand
function respan(t: any, k: string | number, r: Rng, h?: Helpers) {
	const v = t[k], typed = typeof v !== "string"
	const items: any[] = typed ? [...v] : [...v as string]
	const start = r.int(items.length + 1), remove = r.int(items.length - start + 1)
	const put = typed
		? Array.from({ length: r.int(3) }, () => r.int(40))
		: [...r.pick(["", "x", "🙂y"])]
	if (h) {
		const ins = typed ? new v.constructor(put) : put.join("")
		return void h.splice(t, k, start, remove, put.length ? ins : undefined)
	}
	items.splice(start, remove, ...put)
	t[k] = typed ? new v.constructor(items) : items.join("")
}

const SEEDS = 40
Deno.test(`edit oracle: ${SEEDS} seeds, apply(edit) is the recipe on a clone`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		let base = make(rng(seed), 0)
		for (let tries = 0; !container(base); tries++) base = make(rng(seed * 1000 + tries), 0)
		const was = structuredClone(base)
		const recipe = (root: any, drafted: boolean, helpers?: Helpers) => {
			// the same choices both times
			const r = rng(seed + 7777)
			for (let i = 1 + r.int(7); i > 0; i--) change(root, r, drafted, helpers)
		}
		const direct = structuredClone(base)
		recipe(direct, false)
		const patches: Patch[] = edit(
			base as never,
			(d: any, h: Helpers) => void recipe(d, true, h),
		)
		const undo: Patch[] = []
		const at = `seed ${seed}: ${Deno.inspect(base, { depth: 9 })}\n${
			Deno.inspect(patches, { depth: 9 })
		}`
		let got: unknown
		try {
			got = apply(base, patches, { undo })
		} catch (e) {
			throw new Error(`${at}\n${e}`)
		}
		assertEquals(got, direct, at)
		assertEquals(base, was, `${at}: base changed`)
		assertEquals(apply(got, undo), was, `${at}: undo`)
	}
})
