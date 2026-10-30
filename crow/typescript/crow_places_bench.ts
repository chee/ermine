// deno run --allow-run crow/typescript/crow_places_bench.ts [names…]
// places' folders, written one patch at a time, three ways: node's update copying ("copy"), in
// place (op's apply with cow: false: a reader's map changes under it), crow.
// writes: a place over a name there, an unplace then a place back, a rename there and back. reads
// (crow's read): none (a burst), before every write, every 10 writes. µs per write after the
// first (fastest of 15 rounds); the first write (the caller's map: copied, fastest round); the
// slowest write after the first in any round (a copy after a read, and the collector's pauses)
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createCrow } from "./crow.ts"
import { createRoot, write as writeRoot } from "./root_harness.ts"
import { changeable, h, inPlace, only } from "./bench_harness.ts"

const folder = (n: number) =>
	Object.fromEntries(Array.from({ length: n }, (_, i) => [`name${i}`, `id${i}`]))
const WRITES: [string, (n: number) => (i: number) => Patch[]][] = [
	["place", (n) => (i) => [{ path: [`name${i % n}`], value: `id${i}` }]],
	[
		"unplace, place",
		(n) => (i) =>
			i % 2
				? [{ path: [`name${(i >> 1) % n}`], value: "back" }]
				: [{ path: [`name${(i >> 1) % n}`] }],
	],
	[
		"rename",
		(n) => (i) => {
			const k = (i >> 1) % n
			return i % 2
				? [{ path: [`name${k}`], move: { path: [`moved${k}`] } }]
				: [{ path: [`moved${k}`], move: { path: [`name${k}`] } }]
		},
	],
]

type Way = "copy" | "in place" | "crow"
function measure(way: Way, n: number, write: (i: number) => Patch[], every: number, calls: number) {
	let best = Infinity, first = Infinity, worst = 0
	for (let r = 0; r < 15; r++) {
		const u = createCrow()
		const e = changeable(folder(n), h), root = createRoot(folder(n))
		const one = (i: number) => {
			if (way === "copy") return update(e, write(i), h)
			if (way === "in place") return inPlace(e, write(i), h)
			if (every && i % every === 0) u.letGo(root)
			writeRoot(u, root, write(i))
		}
		const t = performance.now()
		one(0)
		first = Math.min(first, (performance.now() - t) * 1000)
		const t0 = performance.now()
		for (let i = 1; i <= calls; i++) {
			const t = performance.now()
			one(i)
			worst = Math.max(worst, performance.now() - t)
		}
		best = Math.min(best, (performance.now() - t0) * 1000 / calls)
	}
	return { best, first, worst: worst * 1000 }
}

const uptime = () => new TextDecoder().decode(new Deno.Command("uptime").outputSync().stdout).trim()
console.log(`uptime: ${uptime()}`)
console.log(
	"names\twrite\treads\tcopy\tin place\tunread\t| first: copy\tunread\t| slowest: copy\tunread",
)
const f = (x: number) => x.toFixed(x < 10 ? 2 : 0)
for (const n of [1, 10, 100, 1000, 10000]) {
	if (only.length && !only.includes(String(n))) continue
	for (const [name, make] of WRITES) {
		const write = make(n)
		const calls = n >= 10000 ? 40 : n >= 1000 ? 200 : 2000
		for (const [reads, every] of [["none", 0], ["every write", 1], ["every 10", 10]] as const) {
			const c = measure("copy", n, write, every, calls)
			const p = measure("in place", n, write, every, calls)
			const u = measure("crow", n, write, every, calls)
			console.log(
				[n, name, reads, f(c.best), f(p.best), f(u.best), "| " + f(c.first), f(u.first)]
					.concat(["| " + f(c.worst), f(u.worst)]).join("\t"),
			)
		}
	}
}
console.log(`uptime: ${uptime()}`)
