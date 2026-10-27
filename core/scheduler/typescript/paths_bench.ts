// deno run core/scheduler/typescript/paths_bench.ts
// what a change costs to find its readers: medians of 31 rounds, µs per mark call
import { createPaths } from "./paths.ts"
import type { Patch } from "@ermine/core/changeable/apply"

function median(f: () => void, calls: number): number {
	for (let i = 0; i < calls; i++) f()
	const times: number[] = []
	for (let r = 0; r < 31; r++) {
		const t0 = performance.now()
		for (let i = 0; i < calls; i++) f()
		times.push((performance.now() - t0) * 1000 / calls)
	}
	return times.sort((a, b) => a - b)[15]
}
const show = (name: string, us: number) => console.log(`${name}\t${us.toFixed(3)} µs`)

// a keystroke into doc.body, with readers of other fields, one of the body and one of the whole
for (const readers of [10, 100, 1000]) {
	const p = createPaths()
	for (let i = 0; i < readers; i++) p.spot("v", "doc", [`field${i}`])
	p.spot("v", "doc", ["body"])
	p.spot("v", "doc", [])
	let k = 0
	show(
		`keystroke, ${readers} readers of other fields`,
		median(() => {
			p.mark("v", "doc", [{ path: ["body"], range: [k, k], value: "x" }])
			k = (k + 1) % 1000
		}, 10000),
	)
}

// a rename in a folder of 5000 names, a reader of each name and one of the names
{
	const p = createPaths()
	for (let i = 0; i < 5000; i++) p.spot("v", "folder", [`name${i}`])
	p.spot("v", "folder", [])
	let flip = false
	const there: Patch = { path: ["renamed"], move: { path: ["name2500"] } }
	const back: Patch = { path: ["name2500"], move: { path: ["renamed"] } }
	show(
		`rename in 5000 names, 5000 readers`,
		median(() => {
			flip = !flip
			p.mark("v", "folder", [flip ? there : back])
		}, 10000),
	)
}

// 10k appends to a list read at its first 100 indices
{
	const p = createPaths()
	for (let i = 0; i < 100; i++) p.spot("v", "stream", [i])
	p.spot("v", "stream", [])
	const one = ["x"]
	show(
		`append, 100 index readers (one of 10k)`,
		median(() => {
			for (let n = 100; n < 10100; n++) {
				p.mark("v", "stream", [{ path: [], range: [n, n], value: one }])
			}
		}, 1) / 10000,
	)
}
