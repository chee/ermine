// deno bench changeable/typescript/mutate_bench.ts
// Compares mutate with a fork of cabbages (mutate/cabbages.ts), which changes in place.
import { assertEquals } from "@std/assert"
import { apply as cabbage } from "./mutate/cabbages.ts"
import apply, { type Patch } from "./apply.ts"
import { squish } from "./squish.ts"

const N = 10_000
const rnd = (() => {
	let x = 1
	return (n: number) => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n
})()

type Work = { start: () => unknown; patches: Patch[] }

const typing: Patch[] = Array.from(
	{ length: N },
	(_, i) => ({ path: ["t"], range: [i, i], value: "a" }),
)
const fixing: Patch[] = []
for (let i = 0, caret = 0; i < N; i++) {
	if (i % 5 === 4) fixing.push({ path: ["t"], range: [caret - 1, caret] }), caret--
	else fixing.push({ path: ["t"], range: [caret, caret], value: "a" }), caret++
}
const work: Record<string, Work> = {
	typing: { start: () => ({ t: "" }), patches: typing },
	"typing, squished": { start: () => ({ t: "" }), patches: squish(typing) },
	fixing: { start: () => ({ t: "" }), patches: fixing },
	appending: {
		start: () => ({ l: [] }),
		patches: Array.from({ length: N }, (_, i) => ({ path: ["l"], range: [i, i], value: [i] })),
	},
	typed: {
		start: () => ({ b: new Int8Array() }),
		patches: Array.from(
			{ length: N },
			(_, i) => ({ path: ["b"], range: [i, i], value: new Int8Array([i & 127]) }),
		),
	},
	scattered: {
		start: () => ({
			docs: Object.fromEntries(
				Array.from({ length: 100 }, (_, i) => [`d${i}`, "x".repeat(1000)]),
			),
		}),
		patches: Array.from({ length: N }, () => {
			const at = rnd(1000)
			return { path: ["docs", `d${rnd(100)}`], range: [at, at], value: "y" }
		}),
	},
	puts: {
		start: () => ({
			rows: Array.from(
				{ length: 10 },
				() => Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, 0])),
			),
		}),
		patches: Array.from(
			{ length: N },
			(_, i) => ({ path: ["rows", rnd(10), `f${rnd(100)}`], value: i }),
		),
	},
	moves: {
		start: () => ({ l: Array.from({ length: 1000 }, (_, i) => i) }),
		patches: Array.from({ length: N }, () => {
			const at = rnd(1000)
			return { path: ["l"], range: [at, at], move: { path: ["l", rnd(1000)] } }
		}),
	},
}

const viaApply = (w: Work) => apply(w.start(), w.patches)
const viaCabbages = (w: Work) => {
	let root = w.start()
	for (const p of w.patches) root = cabbage(root, p)
	return root
}

for (const [name, w] of Object.entries(work)) {
	assertEquals(viaApply(w), viaCabbages(w), name)
}

for (const [name, w] of Object.entries(work)) {
	Deno.bench(`${name}: apply`, { group: name, baseline: true }, (b) => {
		const v = w.start()
		b.start()
		apply(v, w.patches)
		b.end()
	})
	Deno.bench(`${name}: cabbages`, { group: name }, (b) => {
		let root = w.start()
		b.start()
		for (const p of w.patches) root = cabbage(root, p)
		b.end()
	})
	Deno.bench(`${name}: cabbages, cloned`, { group: name }, (b) => {
		const old = w.start()
		b.start()
		let root = structuredClone(old)
		for (const p of w.patches) root = cabbage(root, p)
		b.end()
	})
}

// Each patch is its own change, and mutate copies what it touches, so growing a list is quadratic.
const M = 1000
const each: Record<string, Work> = {
	"typing, a change each": { start: work.typing.start, patches: typing.slice(0, M) },
	"appending, a change each": {
		start: work.appending.start,
		patches: work.appending.patches.slice(0, M),
	},
	"puts, a change each": { start: work.puts.start, patches: work.puts.patches.slice(0, M) },
}
for (const [name, w] of Object.entries(each)) {
	Deno.bench(`${name}: apply`, { group: name, baseline: true }, (b) => {
		let v = w.start()
		b.start()
		for (const p of w.patches) v = apply(v, [p])
		b.end()
	})
	Deno.bench(`${name}: cabbages`, { group: name }, (b) => {
		let root = w.start()
		b.start()
		for (const p of w.patches) root = cabbage(root, p)
		b.end()
	})
}

const emoji: Patch[] = Array.from(
	{ length: N },
	(_, i) => ({ path: ["t"], range: [i, i], value: "😀" }),
)
const strings: Record<string, Work> = {
	typing: work.typing,
	fixing: work.fixing,
	scattered: work.scattered,
	"typing emoji": { start: () => ({ t: "" }), patches: emoji },
}
for (const [name, w] of Object.entries(strings)) {
	const group = `${name}: strings`
	Deno.bench(`${name}: apply`, { group, baseline: true }, (b) => {
		const v = w.start()
		b.start()
		apply(v, w.patches)
		b.end()
	})
	Deno.bench(`${name}: cabbages`, { group }, (b) => {
		let root = w.start()
		b.start()
		for (const p of w.patches) root = cabbage(root, p)
		b.end()
	})
}

const big = {
	list: Array.from({ length: 10_000 }, (_, i) => i),
	map: Object.fromEntries(
		Array.from({ length: 10_000 }, (_, i) => [`k${i}`, { a: { b: { c: i } } }]),
	),
}
const append: Patch[] = [
	{ path: ["list"], range: [10_000, 10_000], value: [1] },
	{ path: ["list"], range: [10_000, 10_001] },
]
const deep: Patch[] = [
	{ path: ["map", "k5000", "a", "b", "c"], value: -1 },
	{ path: ["map", "k5000", "a", "b", "c"], value: 5000 },
]
for (
	const [name, ps] of [["append to a list of 10k", append], [
		"edit deep in a map of 10k",
		deep,
	]] as const
) {
	Deno.bench(`${name}: copy-on-write`, { group: name, baseline: true }, () => {
		apply(big, ps)
	})
	Deno.bench(`${name}: cow: false`, { group: name }, () => {
		apply(big, ps, { cow: false })
	})
}
