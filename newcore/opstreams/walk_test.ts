import { assertEquals } from "@std/assert"
import { count, near, slice, unit, walk } from "./walk.ts"
import { paths } from "./walk/paths.ts"

// a fuzz's numbers: xorshift (an LCG's low bits repeat, so % k of one is patterned)
const xs = (x: number) => {
	x = x || 1
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return x >>> 0
}

const s = "a😀b" // units: a=0, 😀=1,2, b=3
const lone = "a\uD83Db\uDE00" // a lone high, a lone low: each one position

Deno.test("walk: a pair is one position, a lone surrogate one", () => {
	assertEquals([count(s), count(lone), count("")], [3, 4, 0])
	assertEquals([unit(s, 0), unit(s, 1), unit(s, 2), unit(s, 3), unit(s, 4)], [0, 1, 3, 4, -1])
	assertEquals([unit(lone, 2), unit(lone, 3)], [2, 3])
})

Deno.test("walk: one walk to a and b, counting all when asked", () => {
	assertEquals(walk(s, 1, 2), [1, 3, -1])
	assertEquals(walk(s, 1, 2, true), [1, 3, 3])
	assertEquals(walk(s, 3, 3, true), [4, 4, 3])
	assertEquals(walk(s, 2, 4), null)
})

Deno.test("walk: slice cuts at the end, never splits a pair", () => {
	assertEquals([slice(s, 1, 2), slice(s, 2, 9), slice(s, 5, 9), slice(s, 2, 1)], [
		"😀",
		"b",
		"",
		"",
	])
	assertEquals(slice(lone, 1, 2), "\uD83D")
})

Deno.test("walk: utf16 counts units, walking nothing", () => {
	assertEquals([count(s, true), unit(s, 2, true), unit(s, 5, true)], [4, 2, -1])
	assertEquals([walk(s, 1, 3, true, true), walk(s, 1, 5, false, true)], [[1, 3, 4], null])
	assertEquals(slice(s, 1, 2, true), "\uD83D")
})

// against the engine's own walk (for..of steps by code point, a lone surrogate one)
Deno.test("walk: as Array.from counts, over random strings", () => {
	const parts = ["a", "é", "😀", "\uD83D", "\uDE00", "✓"]
	let x = 7
	const rand = (n: number) => (x = xs(x)) % n
	for (let t = 0; t < 40; t++) {
		const str = Array.from({ length: rand(20) }, () => parts[rand(parts.length)]).join("")
		const cps = Array.from(str)
		assertEquals(count(str), cps.length, JSON.stringify(str))
		const a = rand(cps.length + 1), b = a + rand(cps.length - a + 1)
		assertEquals(slice(str, a, b), cps.slice(a, b).join(""), JSON.stringify([str, a, b]))
		const w = walk(str, a, b, true)!
		assertEquals([str.slice(w[0], w[1]), w[2]], [cps.slice(a, b).join(""), cps.length])
	}
})

// the fuzz: strings made of the awkward parts, every position pair, against the engine's own
// split by code point (Array.from: a pair is one, a lone surrogate one), and every fast path
// in walk/paths.ts against the same
const parts = [
	"a",
	"é",
	"✓",
	"中",
	"😀",
	"􏿿", // ASCII, Latin-1, BMP, CJK, a pair, the last pair
	"\uD83D",
	"\uDE00",
	"\uD800",
	"\uDFFF", // lone highs and lows
	"\uDC00\uD800", // a low then a high: two lone, not a pair
	"\uD83D😀", // a lone high, then a pair
]
function strings(seed: number, n: number): string[] {
	let x = seed
	const rand = (k: number) => (x = xs(x)) % k
	return Array.from({ length: n }, () => {
		// mostly short (every pair of positions walked), some long
		const size = rand(10) === 0 ? 200 + rand(400) : rand(24)
		// some strings plain, some all surrogates, some mixed
		const pool = [parts, parts.slice(0, 4), parts.slice(4)][rand(3)]
		return Array.from({ length: size }, () => pool[rand(pool.length)]).join("")
	})
}
// what each position's unit is, by the engine
function units(s: string): number[] {
	const at = [0]
	for (const cp of Array.from(s)) at.push(at[at.length - 1] + cp.length)
	return at
}

Deno.test("walk: fuzz, against Array.from and in UTF-16", () => {
	for (let seed = 1; seed <= 50; seed++) {
		for (const s of strings(seed, 40)) {
			const at = units(s), n = at.length - 1, cps = Array.from(s)
			const say = (what: string) => `seed ${seed} ${what} ${JSON.stringify(s)}`
			assertEquals(count(s), n, say("count"))
			assertEquals(count(s, true), s.length, say("count utf16"))
			// past the end by two, so past-the-end answers are checked too
			const top = Math.min(n + 2, 40)
			for (let a = 0; a <= top; a++) {
				assertEquals(unit(s, a), a <= n ? at[a] : -1, say(`unit ${a}`))
				assertEquals(unit(s, a, true), a <= s.length ? a : -1, say(`unit utf16 ${a}`))
				for (let b = a; b <= top; b++) {
					const want = b <= n ? [at[a], at[b]] : null
					assertEquals(walk(s, a, b)?.slice(0, 2) ?? null, want, say(`walk ${a} ${b}`))
					assertEquals(
						walk(s, a, b, true),
						want ? [...want, n] : null,
						say(`walk all ${a} ${b}`),
					)
					assertEquals(slice(s, a, b), cps.slice(a, b).join(""), say(`slice ${a} ${b}`))
					assertEquals(
						walk(s, a, b, true, true),
						b <= s.length ? [a, b, s.length] : null,
						say(`walk utf16 ${a} ${b}`),
					)
					assertEquals(slice(s, a, b, true), s.slice(a, b), say(`slice utf16 ${a} ${b}`))
				}
			}
		}
	}
})

Deno.test("walk: fuzz, every fast path answers as walk", () => {
	for (let seed = 1; seed <= 50; seed++) {
		for (const s of strings(seed + 1000, 40)) {
			const n = count(s), top = Math.min(n + 2, 30)
			for (let a = 0; a <= top; a++) {
				for (let b = a; b <= top; b++) {
					for (const all of [false, true]) {
						const want = walk(s, a, b, all)
						for (const [name, f] of Object.entries(paths)) {
							assertEquals(
								f(s, a, b, all),
								want,
								`${name} seed ${seed} ${a} ${b} ${all} ${JSON.stringify(s)}`,
							)
						}
					}
				}
			}
			// and far positions on long strings: the middle and the end
			for (
				const [a, b] of [[n >> 1, n >> 1], [n, n], [n >> 2, Math.max(n >> 2, n - 1)], [0, n]]
			) {
				for (const all of [false, true]) {
					const want = walk(s, a, b, all)
					for (const [name, f] of Object.entries(paths)) {
						assertEquals(f(s, a, b, all), want, `${name} seed ${seed} far ${a} ${b} ${all}`)
					}
				}
			}
		}
	}
})

Deno.test("walk: fast paths on long strings that turn dense, or sparse", () => {
	const sparse = (n: number) =>
		Array.from({ length: n }, (_, i) => i % 97 === 5 ? "😀" : "x").join("")
	const dense = (n: number) =>
		Array.from({ length: n }, (_, i) => i % 3 ? "😀" : "\uD83D").join("")
	const texts = [
		sparse(3000) + dense(3000),
		dense(3000) + sparse(3000),
		sparse(2000) + dense(50) + sparse(2000),
	]
	for (const s of texts) {
		const n = count(s)
		for (let t = 0; t <= 40; t++) {
			const a = Math.floor(n * t / 40), b = Math.min(n, a + 7)
			for (const all of [false, true]) {
				const want = walk(s, a, b, all)
				for (const [name, f] of Object.entries(paths)) {
					assertEquals(f(s, a, b, all), want, `${name} ${a} ${b} ${all}`)
				}
			}
		}
	}
})

Deno.test("walk: fuzz, near answers as walk from any true hint", () => {
	let x = 11
	const rand = (k: number) => (x = xs(x)) % k
	for (let seed = 1; seed <= 50; seed++) {
		for (const s of strings(seed + 2000, 40)) {
			const n = count(s), top = Math.min(n + 2, 30)
			for (let t = 0; t < 4; t++) {
				// a true hint: some position and its unit; the count known or not
				const k = rand(n + 1)
				const h = { n: rand(2) ? n : -1, k, i: unit(s, k) }
				const far = [[n >> 1, n >> 1], [n, n], [0, n], [Math.max(0, n - 3), n]]
				const near_ = Array.from({ length: top + 1 }, (_, a) => [a, Math.min(top, a + rand(4))])
				for (const [a, b] of [...far, ...near_]) {
					for (const all of [false, true]) {
						const want = walk(s, a, b, all), got = near(s, a, b, all, h)
						const say = `seed ${seed} ${a} ${b} ${all} hint ${JSON.stringify(h)} ${
							JSON.stringify(s)
						}`
						if (want === null) {
							assertEquals(got, null, say)
							continue
						}
						assertEquals(got?.slice(0, 2), want.slice(0, 2), say)
						if (all) assertEquals(got?.[2], want[2], say)
						else if (h.n >= 0) assertEquals(got?.[2], n, say)
					}
				}
			}
		}
	}
})
