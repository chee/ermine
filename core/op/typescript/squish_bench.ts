// deno bench newcore/opstreams/ts/squish_bench.ts
// the same workloads as squish/c/bench.c: N patches each, made once
import { decode, encode, squish } from "./squish.ts"
import type { Patch } from "@ermine/core/op/apply"

const N = 10_000
const rnd = (() => {
	let x = 1
	return (n: number) => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n
})()

// one character at a time, at a caret
const typing: Patch[] = Array.from(
	{ length: N },
	(_, i) => ({ path: ["t"], range: [i, i], value: "a" }),
)
// typing, every fifth a backspace
const fixing: Patch[] = []
for (let i = 0, caret = 0; i < N; i++) {
	if (i % 5 === 4) fixing.push({ path: ["t"], range: [caret - 1, caret] }), caret--
	else fixing.push({ path: ["t"], range: [caret, caret], value: "a" }), caret++
}
// a list grown at the end
const appending: Patch[] = Array.from(
	{ length: N },
	(_, i) => ({ path: ["l"], range: [i, i], value: [i] }),
)
// inserts at random places in 100 strings: nothing joins
const scattered: Patch[] = Array.from({ length: N }, () => {
	const at = rnd(1000)
	return { path: ["docs", `d${rnd(100)}`], range: [at, at], value: "x" }
})
// 99 puts to a row's fields, then the row put whole: they die; 10 rows in turn
const puts: Patch[] = Array.from(
	{ length: N },
	(_, i) =>
		i % 100 === 99
			? { path: ["rows", Math.floor(i / 100) % 10], value: {} }
			: { path: ["rows", Math.floor(i / 100) % 10, `f${rnd(100)}`], value: i },
)

const work = { typing, fixing, appending, scattered, puts }
for (const [name, ps] of Object.entries(work)) {
	Deno.bench(name, { group: "squish" }, () => void squish(ps))
}
for (const [name, ps] of Object.entries(work)) {
	Deno.bench(name, { group: "encode" }, () => void encode(ps))
}
for (const [name, ps] of Object.entries(work)) {
	const c = encode(ps)
	Deno.bench(name, { group: "decode" }, () => void decode(c))
}
