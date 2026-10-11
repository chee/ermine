// deno bench newcore/opstreams/ts/walk_bench.ts
// walk.ts, the string positions notify, mutate and squish share: code points against UTF-16
// units, and other ways of walking to try against it
import { assertEquals } from "@std/assert"
import { count, slice, unit, walk } from "./walk.ts"

const N = 100_000
const ascii = "x".repeat(N)
// one emoji in ten
const mixed = Array.from({ length: N }, (_, i) => i % 10 === 9 ? "😀" : "x").join("")
const texts = { ascii, mixed }

// other ways, each as walk.ts would answer
const others = {
	"count: for..of": (s: string) => {
		let n = 0
		for (const _ of s) n++
		return n
	},
	"count: units less pairs (regex)": (s: string) =>
		s.length - (s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0),
	"unit: regex ^[\\s\\S]{n}": (s: string, n: number) => {
		const m = new RegExp(`^[\\s\\S]{${n}}`, "u").exec(s)
		return m ? m[0].length : -1
	},
	"unit: codePointAt": (s: string, n: number) => {
		let i = 0
		for (let k = 0; k < n; k++) {
			if (i >= s.length) return -1
			i += s.codePointAt(i)! > 0xffff ? 2 : 1
		}
		return i
	},
}

for (const [name, s] of Object.entries(texts)) {
	const n = count(s), mid = n >> 1
	assertEquals(others["count: for..of"](s), n)
	assertEquals(others["count: units less pairs (regex)"](s), n)
	assertEquals(others["unit: regex ^[\\s\\S]{n}"](s, mid), unit(s, mid))
	assertEquals(others["unit: codePointAt"](s, mid), unit(s, mid))

	let group = `${name}: count`
	Deno.bench(`${name}: count, code points`, { group, baseline: true }, () => void count(s))
	Deno.bench(`${name}: count, utf16`, { group }, () => void count(s, true))
	Deno.bench(`${name}: count, for..of`, { group }, () => void others["count: for..of"](s))
	Deno.bench(
		`${name}: count, units less pairs (regex)`,
		{ group },
		() => void others["count: units less pairs (regex)"](s),
	)

	group = `${name}: unit at the middle`
	Deno.bench(`${name}: unit, code points`, { group, baseline: true }, () => void unit(s, mid))
	Deno.bench(`${name}: unit, utf16`, { group }, () => void unit(s, mid, true))
	Deno.bench(
		`${name}: unit, regex`,
		{ group },
		() => void others["unit: regex ^[\\s\\S]{n}"](s, mid),
	)
	Deno.bench(
		`${name}: unit, codePointAt`,
		{ group },
		() => void others["unit: codePointAt"](s, mid),
	)

	// what mutate does per ranged patch: to a and b, and the whole count when patched
	group = `${name}: walk to the end`
	Deno.bench(`${name}: walk, code points`, { group, baseline: true }, () => void walk(s, n, n))
	Deno.bench(`${name}: walk, all, code points`, { group }, () => void walk(s, mid, mid, true))
	Deno.bench(`${name}: walk, utf16`, { group }, () => void walk(s, n, n, true, true))

	// what a span read's value does
	group = `${name}: slice 100 at the middle`
	Deno.bench(
		`${name}: slice, code points`,
		{ group, baseline: true },
		() => void slice(s, mid, mid + 100),
	)
	Deno.bench(`${name}: slice, utf16`, { group }, () => void slice(s, mid, mid + 100, true))
}

// can a string be walked by numbers? units are positions when it has no surrogates at all
// isWellFormed is not enough (a pair is well formed, and two units): it is here as a check's cost
const noSurrogate = /[\uD800-\uDFFF]/
const plain = (s: string) => !noSurrogate.test(s)
// checked first, walked only when the string has a surrogate
const quick = (s: string, a: number, b: number) =>
	plain(s) ? (b <= s.length ? [a, b, s.length] : null) : walk(s, a, b, true)

const checks = {
	ascii,
	// two-byte (✓ is past Latin-1), no surrogates
	bmp: "✓".repeat(N),
	// one emoji in ten: the regex stops at the first
	mixed,
	// the worst: one emoji, at the very end
	"emoji last": "x".repeat(N - 1) + "😀",
}
for (const [name, s] of Object.entries(checks)) {
	const n = count(s), group = `${name}: safe to walk by numbers?`
	assertEquals(quick(s, n - 1, n), walk(s, n - 1, n, true))
	Deno.bench(`${name}: regex /[\\uD800-\\uDFFF]/`, { group }, () => void plain(s))
	Deno.bench(`${name}: isWellFormed`, { group }, () => void s.isWellFormed())
	Deno.bench(
		`${name}: walk to the end, as now`,
		{ group, baseline: true },
		() => void walk(s, n - 1, n, true),
	)
	Deno.bench(`${name}: regex, then walk only if needed`, { group }, () => void quick(s, n - 1, n))
}

import { paths } from "./walk/paths.ts"

const fast = {
	ascii,
	bmp: "✓".repeat(N),
	mixed,
	"emoji last": "x".repeat(N - 1) + "😀",
	"emoji first": "😀" + "x".repeat(N - 1),
	// lone surrogates scattered: each one position
	lone: Array.from({ length: N }, (_, i) => i % 100 === 50 ? "\uD83D" : "x").join(""),
}
// each path against walk.ts, at random places, before any is timed
{
	let x = 3
	const rand = (n: number) => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n
	for (const [text, s] of Object.entries(fast)) {
		const n = count(s)
		for (let t = 0; t < 30; t++) {
			const a = rand(n + 2), b = a + rand(n + 2 - a)
			for (const all of [false, true]) {
				const want = walk(s, a, b, all)
				for (const [name, f] of Object.entries(paths)) {
					assertEquals(f(s, a, b, all), want, `${name} on ${text}: ${a} ${b} ${all}`)
				}
			}
		}
	}
}
for (const [text, s] of Object.entries(fast)) {
	const n = count(s)
	for (
		const [where, a, all] of [["typing at the end", n, false], ["at the middle", n >> 1, false], [
			"at the middle, counting all",
			n >> 1,
			true,
		]] as const
	) {
		const group = `${text}: ${where}`
		for (const [name, f] of Object.entries(paths)) {
			Deno.bench(
				`${text}, ${where}: ${name}`,
				{ group, baseline: name === "as now" },
				() => void f(s, a, a, all),
			)
		}
	}
}
