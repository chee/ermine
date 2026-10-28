// what a write and a make cost in a process's setup (the site rule: system/index.ts), each case its
// median over trials, in µs a call:
//   deno run -A ermine/system/typescript/setup_bench.ts [trials]
//   patch        one patch at a node
//   ensureNode   one node made
//   createMemo   one memo made, reading a node
//   pipe         one @ermine/pipe pipe made between two nodes
// each trial: a fresh ermine, one process whose setup makes 1,000 of the thing, timed inside it
import { createErmine, createMemo, ensureNode, type Feature, patch, read } from "@ermine/system"
import pipes, { pipe } from "@ermine/pipe"

const TRIALS = Number(Deno.args[0] ?? 15)
const N = 1000
const manual: Feature = { name: "manual", setup: (f) => f.onSchedule(() => {}) }
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function time(f: (i: number) => void): number {
	const t0 = performance.now()
	for (let i = 0; i < N; i++) f(i)
	return (performance.now() - t0) * 1000 / N
}

const cases: [string, boolean, () => number][] = [
	["patch", false, () => {
		ensureNode("/k", 0)
		return time((i) => patch("/k", [{ path: [], value: i }]))
	}],
	["ensureNode", false, () => time((i) => ensureNode(`/n${i}`, i))],
	["createMemo", false, () => {
		ensureNode("/k", 0)
		return time((i) => void createMemo(`m${i}`, () => read("/k")))
	}],
	["pipe", true, () => {
		for (let i = 0; i <= N; i++) ensureNode(`/n${i}`, 0)
		return time((i) => void pipe(`/n${i}`, `/n${i + 1}`))
	}],
]

function trial(withPipes: boolean, body: () => number): number {
	const e = createErmine({ features: withPipes ? [pipes, manual] : [manual] })
	let us = NaN
	e.start(() => void (us = body()), "/code/p")
	e.close()
	return us
}

// warm: the engine's first runs
for (const [, withPipes, body] of cases) for (let i = 0; i < 3; i++) trial(withPipes, body)
for (const [name, withPipes, body] of cases) {
	const xs = Array.from({ length: TRIALS }, () => trial(withPipes, body))
	console.log(
		`${name.padEnd(12)} ${median(xs).toFixed(1).padStart(7)} µs   (min ${
			Math.min(...xs).toFixed(1)
		}, max ${Math.max(...xs).toFixed(1)})`,
	)
}
