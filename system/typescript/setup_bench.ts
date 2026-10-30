// What a write and a make cost in a process's setup, median over trials in microseconds per call.
//   deno run -A system/typescript/setup_bench.ts [trials]
// Cases: patch, ensureNode, createMemo. Each trial makes 1,000 of the thing in a fresh ermine.
import { createErmine, createMemo, ensureNode, type Feature, patch, read } from "@ermine/system"

const TRIALS = Number(Deno.args[0] ?? 15)
const N = 1000
const manual: Feature = { name: "manual", setup: (f) => f.onSchedule(() => {}) }
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function time(f: (i: number) => void): number {
	const t0 = performance.now()
	for (let i = 0; i < N; i++) f(i)
	return (performance.now() - t0) * 1000 / N
}

const cases: [string, () => number][] = [
	["patch", () => {
		ensureNode("/k", 0)
		return time((i) => patch("/k", [{ path: [], value: i }]))
	}],
	["ensureNode", () => time((i) => ensureNode(`/n${i}`, i))],
	["createMemo", () => {
		ensureNode("/k", 0)
		return time((i) => void createMemo(`m${i}`, () => read("/k")))
	}],
]

function trial(body: () => number): number {
	const e = createErmine({ features: [manual] })
	let us = NaN
	e.start(() => void (us = body()), "/code/p")
	e.close()
	return us
}

for (const [, body] of cases) for (let i = 0; i < 3; i++) trial(body)
for (const [name, body] of cases) {
	const xs = Array.from({ length: TRIALS }, () => trial(body))
	console.log(
		`${name.padEnd(12)} ${median(xs).toFixed(1).padStart(7)} µs   (min ${
			Math.min(...xs).toFixed(1)
		}, max ${Math.max(...xs).toFixed(1)})`,
	)
}
