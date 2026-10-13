// deno bench core/util/typescript/walk-string_bench.ts
// walk-string.ts, the string positions notify, apply and squish share: code points against UTF-16
// units
import { count, slice, unit, walk } from "./walk-string.ts"

const N = 100_000
const ascii = "x".repeat(N)
// one emoji in ten
const mixed = Array.from({ length: N }, (_, i) => i % 10 === 9 ? "😀" : "x").join("")
const texts = { ascii, mixed }

for (const [name, s] of Object.entries(texts)) {
	const n = count(s), mid = n >> 1

	let group = `${name}: count`
	Deno.bench(`${name}: count, code points`, { group, baseline: true }, () => void count(s))
	Deno.bench(`${name}: count, utf16`, { group }, () => void count(s, true))

	group = `${name}: unit at the middle`
	Deno.bench(`${name}: unit, code points`, { group, baseline: true }, () => void unit(s, mid))
	Deno.bench(`${name}: unit, utf16`, { group }, () => void unit(s, mid, true))

	// what apply does per ranged patch: to a and b, and the whole count when patched
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
