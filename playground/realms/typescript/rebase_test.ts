import { assertEquals } from "jsr:@std/assert@1"
import apply, { type Patch } from "@ermine/core/changeable/apply"
import produce from "@ermine/core/changeable/produce"
import { rebase } from "./rebase.ts"

// the page's patches landed, then the realm's (made on the value before them), rebased
const both = <T>(v: T, theirs: Patch[], ours: Patch[]) =>
	apply(apply(v, theirs), rebase(theirs, ours))
const recipe = <T>(v: T, f: (d: any, h: any) => unknown) => produce(v, f as never)

Deno.test("text: an insert at the end stays at the end past an insert at the start", () => {
	const v = "hello world"
	const theirs = recipe(v, (t, { splice }) => void splice(t, 0, 0, "well, "))
	const ours = recipe(v, (t, { splice }) => void splice(t, t.length, 0, "!"))
	assertEquals(both(v, theirs, ours), "well, hello world!")
})

Deno.test("text: two inserts at one spot, theirs first", () => {
	assertEquals(
		both("x", [{ path: [], range: [0, 0], value: "A" }], [{
			path: [],
			range: [0, 0],
			value: "B",
		}]),
		"ABx",
	)
})

Deno.test("text: a removal over what theirs put in keeps it", () => {
	const theirs: Patch[] = [{ path: [], range: [3, 3], value: "X" }]
	const ours: Patch[] = [{ path: [], range: [1, 5] }]
	assertEquals(both("abcdef", theirs, ours), "aXf")
})

Deno.test("text: a replacement over what theirs removed", () => {
	const theirs: Patch[] = [{ path: [], range: [2, 4] }]
	const ours: Patch[] = [{ path: [], range: [1, 5], value: "Z" }]
	assertEquals(both("abcdef", theirs, ours), "aZf")
})

Deno.test("text: inside what theirs replaced, ours goes after what they put in", () => {
	const theirs: Patch[] = [{ path: [], range: [1, 5], value: "--" }]
	const ours: Patch[] = [{ path: [], range: [2, 3], value: "!" }]
	assertEquals(both("abcdef", theirs, ours), "a--!f")
})

Deno.test("list: crossing off the first is still milk past one put in front", () => {
	const v = ["milk", "eggs", "bread"]
	const theirs = recipe(v, (l) => void l.unshift("page's thing"))
	const ours = recipe(v, (l) => void l.shift())
	assertEquals(both(v, theirs, ours), ["page's thing", "eggs", "bread"])
})

Deno.test("list: an element's field follows it past an insert before it", () => {
	const v = { l: [{ n: "a" }, { n: "b" }] }
	const theirs = recipe(v, (d) => void d.l.unshift({ n: "new" }))
	const ours = recipe(v, (d) => void (d.l[1].n = "B"))
	assertEquals(both(v, theirs, ours), { l: [{ n: "new" }, { n: "a" }, { n: "B" }] })
})

Deno.test("list: an element theirs took out takes ours with it", () => {
	const v = { l: [{ n: "a" }, { n: "b" }] }
	const theirs = recipe(v, (d) => void d.l.splice(1, 1))
	const ours = recipe(v, (d) => void (d.l[1].n = "B"))
	assertEquals(both(v, theirs, ours), { l: [{ n: "a" }] })
})

Deno.test("list: an element's field follows it through theirs' sort", () => {
	const v = { l: [{ n: "c" }, { n: "a" }, { n: "b" }] }
	const theirs = recipe(v, (d) => void d.l.sort((x: any, y: any) => x.n < y.n ? -1 : 1))
	const ours = recipe(v, (d) => void (d.l[0].n = "c!"))
	const out = both(v, theirs, ours) as { l: { n: string }[] }
	assertEquals(out.l.map((x) => x.n), ["a", "b", "c!"])
})

Deno.test("map: different keys both land; one key, ours after", () => {
	const v = { title: "t", colour: "lemon" }
	assertEquals(
		both(
			v,
			recipe(v, (c) => void (c.title = "page")),
			recipe(v, (c) => void (c.colour = "cherry")),
		),
		{ title: "page", colour: "cherry" },
	)
	assertEquals(
		both(
			v,
			recipe(v, (c) => void (c.title = "page")),
			recipe(v, (c) => void (c.title = "realm")),
		),
		{ title: "realm", colour: "lemon" },
	)
})

Deno.test("a key theirs took out takes ours under it", () => {
	const v = { card: { tags: ["a"] } }
	const theirs: Patch[] = [{ path: ["card"] }]
	const ours = recipe(v, (d) => void d.card.tags.push("b"))
	assertEquals(both(v, theirs, ours), {})
})

Deno.test("several of each: ours in sequence, theirs in sequence", () => {
	const v = "abc"
	const theirs: Patch[] = [
		{ path: [], range: [0, 0], value: "1" },
		{ path: [], range: [4, 4], value: "2" },
	]
	// "abc" → "a-bc" → "a-bc+"
	const ours: Patch[] = [
		{ path: [], range: [1, 1], value: "-" },
		{ path: [], range: [4, 4], value: "+" },
	]
	assertEquals(both(v, theirs, ours), "1a-bc2+")
})

// a few dozen seeds: random inserts on both sides of a string, every inserted run survives, in
// each side's own order, and the original letters stay in theirs
Deno.test("fuzz: inserts on both sides all survive", () => {
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed
		const rnd = (n: number) => (x = (x * 1103515245 + 12345) % 2147483648) % n
		const v = "abcdefgh"
		const side = (mark: string) => {
			let s = v
			const ps: Patch[] = []
			for (let i = 0; i < 1 + rnd(4); i++) {
				const at = rnd(s.length + 1)
				const ins = mark + i
				ps.push({ path: [], range: [at, at], value: ins })
				s = s.slice(0, at) + ins + s.slice(at)
			}
			return ps
		}
		const theirs = side("T"), ours = side("O")
		const out = both(v, theirs, ours) as string
		for (const p of [...theirs, ...ours]) {
			if (!out.includes(p.value as string)) {
				throw new Error(`seed ${seed}: ${p.value} lost: ${out}`)
			}
		}
		assertEquals(out.replace(/[TO]\d/g, ""), v, `seed ${seed}`)
	}
})

// a few dozen seeds: random splices (removals too) on both sides of a list, the rebased always
// applies, and every item ours put in is there
Deno.test("fuzz: splices on both sides always land", () => {
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed * 7919
		const rnd = (n: number) => (x = (x * 1103515245 + 12345) % 2147483648) % n
		const v = [0, 1, 2, 3, 4, 5, 6, 7]
		const side = (mark: string) => {
			let l = [...v] as unknown[]
			const ps: Patch[] = []
			for (let i = 0; i < 1 + rnd(4); i++) {
				const a = rnd(l.length + 1), b = a + rnd(Math.min(3, l.length - a) + 1)
				const put = rnd(2) ? [mark + i] : []
				ps.push(
					put.length ? { path: [], range: [a, b], value: put } : { path: [], range: [a, b] },
				)
				l = [...l.slice(0, a), ...put, ...l.slice(b)]
			}
			return ps
		}
		const theirs = side("T"), ours = side("O")
		const out = both(v, theirs, ours) as unknown[]
		for (const p of ours) {
			const put = (p.value as unknown[] | undefined)?.[0]
			if (put !== undefined && !out.includes(put)) throw new Error(`seed ${seed}: ${put} lost`)
		}
	}
})
