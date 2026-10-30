// deno run crow/typescript/crow_bench.ts [name…]
// µs per write, fastest of 31 rounds (the machine may be busy): update copying on write ("copy"),
// in place (op's apply with cow: false: "in place"), and crow.
// a burst: writes with no read between; read between: crow is told of a read before each write
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createCrow } from "./crow.ts"
import { createRoot, write } from "./root_harness.ts"
import { changeable, fastest, h, inPlace, only, row } from "./bench_harness.ts"

// three ways to write a value made by start; patch(i): the i-th write
function ways(start: () => unknown, patch: (i: number) => Patch[], read = false) {
	const out: Record<string, () => () => void> = {
		copy: () => {
			const e = changeable(start(), h)
			let i = 0
			return () => update(e, patch(i++), h)
		},
		"in place": () => {
			const e = changeable(start(), h)
			let i = 0
			return () => inPlace(e, patch(i++), h)
		},
		crow: () => {
			const u = createCrow()
			const e = createRoot(start())
			let i = 0
			return () => {
				if (read) u.letGo(e)
				write(u, e, patch(i++))
			}
		},
	}
	// in place changes what a reader holds: not a way when there are readers
	if (read) delete out["in place"]
	return out
}

const folder = (n: number) => () => ({
	...Object.fromEntries(Array.from({ length: n }, (_, i) => [`name${i}`, `id${i}`])),
})
const rename = (i: number): Patch[] => [{ path: [`name${i % 1000}`], value: `id${i}` }]
row("a name in a folder of 1000, a burst", ways(folder(1000), rename), 1000)
row("a name in a folder of 1000, read between", ways(folder(1000), rename, true), 1000)
row("a name in a folder of 30k, a burst", ways(folder(30000), rename), 20)

const doc = () => ({
	theme: { accent: "lemon", font: "chicago" },
	n: 0,
	...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `field ${i}`])),
})
const field = (i: number): Patch[] => [{ path: ["n"], value: i }]
row("a field of a 52-field doc, a burst", ways(doc, field), 10000)
row("a field of a 52-field doc, read between", ways(doc, field, true), 10000)

const items = () => ({
	items: Array.from({ length: 1000 }, (_, i) => ({ id: i, text: `item ${i}`, done: false })),
})
const done = (i: number): Patch[] => [{ path: ["items", i % 1000, "done"], value: i % 2 === 0 }]
row("an item's field in a list of 1000, a burst", ways(items, done), 10000)
row("an item's field in a list of 1000, read between", ways(items, done, true), 10000)

// a deep path: six maps down
const deep = () => ({ a: { b: { c: { d: { e: { f: { n: 0 } } } } } }, side: { x: 1 } })
const deepField = (i: number): Patch[] => [{ path: ["a", "b", "c", "d", "e", "f", "n"], value: i }]
row("a field six maps down, a burst", ways(deep, deepField), 10000)
row("a field six maps down, read between", ways(deep, deepField, true), 10000)

// five fields in one write
const five = (i: number): Patch[] =>
	[0, 1, 2, 3, 4].map((k) => ({ path: [`f${k * 10}`], value: `${i}` }))
row("five fields of a 52-field doc in one write, a burst", ways(doc, five), 10000)

// a list growing at its end
const list = () => ({ list: Array.from({ length: 10000 }, (_, i) => i) })
const append = (
	i: number,
): Patch[] => [{ path: ["list"], range: [10000 + i, 10000 + i], value: [i] }]
row("append to a list of 10k, a burst", ways(list, append), 2000)
row("append to a list of 10k, read between", ways(list, append, true), 2000)

// typing into a long string: a string never changes in place, so all three alike
const text = () => ({ body: "x".repeat(10000) })
const type = (i: number): Patch[] => [{ path: ["body"], range: [5000, 5000], value: "a" }]
row("typing into a 10k string, a burst", ways(text, type), 2000)

// one number of a typed array
const floats = () => ({ samples: new Float64Array(10000) })
const sample = (i: number): Patch[] => [
	{ path: ["samples"], range: [i % 10000, i % 10000 + 1], value: new Float64Array([i]) },
]
row("one sample of a 10k Float64Array, a burst", ways(floats, sample), 2000)
row("one sample of a 10k Float64Array, read between", ways(floats, sample, true), 2000)

// a first write to each of many entries: what an entry's first write costs
{
	const name = "a first write to each of 10k entries"
	if (!only.length || only.some((o) => name.includes(o))) {
		const docs = () => Array.from({ length: 10000 }, () => changeable(doc(), h))
		const cols = (["copy", "crow"] as const).map((way) => {
			let best = Infinity
			for (let r = 0; r < 11; r++) {
				const es = docs(), u = createCrow()
				const t0 = performance.now()
				for (const e of es) {
					if (way === "copy") update(e, field(1), h)
					else write(u, e, field(1))
				}
				best = Math.min(best, (performance.now() - t0) * 1000 / es.length)
			}
			return `${way} ${best.toFixed(2)}`
		})
		console.log(`${name}\t${cols.join("\t")} µs`)
	}
}

// kept: what a computation's result costs to let go, by its size: walked whole, or handed (what
// the run was given: the walk stops there)
{
	const u = createCrow()
	const sized: [string, () => unknown][] = [
		["a 52-field doc", doc],
		["a list of 1000 items", () => items().items],
		["a folder of 30k names", folder(30000)],
	]
	for (const [what, make] of sized) {
		const name = `kept: ${what}`
		if (only.length && !only.some((o) => name.includes(o))) continue
		const v = make(), handed = new Set([v]), calls = what.includes("30k") ? 20 : 1000
		const whole = fastest(() => u.letGoIn(v), calls),
			stops = fastest(() => u.letGoIn(v, handed), calls)
		console.log(`${name}\twhole ${whole.toFixed(2)}\thanded ${stops.toFixed(2)} µs`)
	}
}
