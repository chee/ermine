// deno run playground/programs/typescript/programs_bench.ts [name…]   (deno bench runs it too)
// satisfy and openwith over a real table, paths, scheduler and places (root R, children alone, no
// box), the well-known types installed at R/ermine/types; every loader a host function in one
// folder W (R/work), the program or file there too, the search from ["work"]. each shape timed
// outside any run, and inside a computer: one tracking a tick and then searching, rerun by the tick
// marked and a pulse (what that costs alone: the "tick" row). medians of up to 21 rounds, CPU µs per
// call (the process's user and system time: other work on the machine counts little; ms, s where
// marked). reads: the places' reads one call tells the scheduler, then how many distinct keys.
// names given: only the shapes whose name holds one of them
//   depth n:   a chain of n compilers (t0 → t1 → … → tn, types unknown to ermine/types) then a
//              runner: the first way only
//   breadth k: k loaders each taking and giving JavaScript, and a runner: the first way, then all of
//              them, counted. nearest, then shortest: the first way is the runner alone, though its
//              name is last in key order (depth first, before 10-15, it was all k loaders, then the
//              runner). all ways stop once one call passes ~2 s
//   crowded m: depth 1, and m plain files on "/": the way's level answers, so "/" is never read
//   openwith m: m openers (each JavaScript, run by the one host runner) opening public.text, the
//              file public.c-source (c-source → source-code → plain-text → text): the first, all
//
// 2026-10-15, nearest, then shortest; one run (Apple A18 Pro, deno 2.9.7, load average ~60-200 from
// other work). first, all: CPU µs per call (ms, s where marked); out: outside any run, in: in a
// computer
//
//   shape         first out   first in      reads    all out     all in       ways  reads all
//   tick                  -        0.7
//   depth 1            17.8       18.2      30/24
//   depth 4            50.3       31.5      48/42
//   depth 16           83.2       94.7    120/114
//   depth 64          460.7      469.3    408/402
//   depth 256        4.81ms     4.68ms  1560/1554
//   crowded 100        14.3       16.1      30/24
//   breadth 2          12.9       14.1      27/24       15.0       19.2          5      32/29
//   breadth 4          14.4       18.0      37/34       72.6       43.6         65      42/39
//   breadth 6          18.2       23.5      47/44     1.78ms     1.66ms       1957      52/49
//   breadth 8          23.2       21.3      57/54   105.88ms   106.82ms     109601      62/59
//   breadth 10         27.3       26.3      67/64     11.2 s    stopped    9864101      72/69
//   openwith 1         15.4       18.6      36/33       17.8       21.2          1      45/42
//   openwith 10        24.3       31.2      54/51       44.5       63.7         10      99/87
//   openwith 100      131.5      143.6    234/231      417.7      437.3        100    639/537
//
// what they say, against the depth-first order before (the same day, CPU µs, out, first way, both in
// one process: old → new): depth 1 20.7 → 21.0, 4 38.1 → 33.8, 16 79.1 → 83.1, 64 556 → 387, 256
// 5.25ms → 3.36ms; reads one more (29 → 30: the program's own type's conformance, looked at in round
// 1). depth's first way still grows ~n² (each round walks the chain so far again), but steps through
// what was taken, where the old search scanned every candidate again at each step. breadth's first
// way is now the runner alone, at ~2 µs a loader looked at (k 10: 27.6 → 22.9), its reads the same;
// all ways are every order of every subset of the loaders, ~e·k! of them, ~1 µs each now (k 8: 239 →
// 93 ms), so all-ways still passes 2 s between k 8 and 10. crowded: "/" never read, its 100 files
// cost nothing (shortest first alone, reading every level to rule out a 1-step way up there: 123 µs,
// 235 reads). a level is read whole: openwith's first way reads every opener's loaders and takes in
// the file's folder. tracking adds little: in and out are within the noise
import createEntry from "@ermine/node/entry"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { ATTRIBUTES as A, openwith, satisfy } from "./programs.ts"
import { installTypes } from "@ermine/types"
import process from "node:process"

const JS = "com.netscape.javascript-source"

function world() {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	// the places' reads, counted only while counting
	const count = { on: false, reads: 0, keys: new Set<unknown>() }
	const scheduler = {
		track: (key: unknown) => {
			if (count.on) count.reads++, count.keys.add(key)
			s.track(key)
		},
		mark: s.mark,
		getRun: s.getRun,
	}
	const places = createPlaces({ root: "R", table, paths, scheduler })
	s.onTrackingEnd((key) => places.release(key))
	const host = s.createRootScope([["actor", "bench"]])
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header())))
	hosted(() => installTypes(table, "R", header(), undefined, (p) => p.join("/")))
	put("children", "R", { ermine: "ermine", work: "W" })
	// a node's attributes, by ATTRIBUTES' names; a host function too, with fn
	const says = (id: Id, l: Partial<Record<keyof typeof A, unknown>>, fn = false) => {
		if (fn) put("value", id, () => {})
		put(
			"attributes",
			id,
			Object.fromEntries(Object.entries(l).map(([k, v]) => [A[k as keyof typeof A], v])),
		)
	}
	// reads and distinct keys one call of f tells
	const reads = (f: () => unknown): string => {
		count.on = true
		count.reads = 0
		count.keys.clear()
		f()
		count.on = false
		return `${count.reads}/${count.keys.size}`
	}
	// f in a computer tracking a tick first; the timed call: the tick marked, a pulse
	const computer = (f: () => unknown): () => void => {
		const tick = {}
		s.runWithScope(
			host,
			() => s.createComputer(() => (s.track(tick), f()), () => {}, () => false),
		)
		s.pulse()
		return () => {
			s.mark([tick])
			s.pulse()
		}
	}
	return { places, put, says, reads, computer }
}

// the process's CPU time, ms
const cpu = () => {
	const u = process.cpuUsage()
	return (u.user + u.system) / 1000
}

// CPU µs per call: one call over ~0.5 s is timed once; else calls for ~100 ms to warm, then the
// median of up to 21 rounds (at least 3), each as many calls as fill ~5 ms, within ~2 s
function measure(f: () => unknown): number {
	let t = cpu()
	f()
	if (cpu() - t > 500) return (cpu() - t) * 1000
	let n = 0
	t = cpu()
	while (cpu() - t < 100) f(), n++
	const calls = Math.max(1, Math.round(5 * n / 100))
	const times: number[] = []
	const start = cpu()
	for (let r = 0; r < 21; r++) {
		const t0 = cpu()
		for (let i = 0; i < calls; i++) f()
		times.push((cpu() - t0) * 1000 / calls)
		if (r >= 2 && cpu() - start > 2000) break
	}
	return times.sort((a, b) => a - b)[times.length >> 1]
}

const us = (x: number) =>
	x >= 1e6 ? `${(x / 1e6).toFixed(1)} s` : x >= 1000 ? `${(x / 1000).toFixed(2)}ms` : x.toFixed(1)

const only = Deno.args
const picked = (name: string) => !only.length || only.some((o) => name.includes(o))
const heads = ["first out", "first in", "reads", "all out", "all in", "ways", "reads all"]
function row(name: string, cells: string[]) {
	const out = cells.map((c, i) => c.padStart(Math.max(heads[i].length, 9) + 2))
	console.log(`//   ${name.padEnd(12)}${out.join("")}`.trimEnd())
}

row("shape", heads)

if (picked("tick")) {
	const w = world()
	row("tick", ["-", us(measure(w.computer(() => 0)))])
}

// depth n: P (t0) run by C0 … Cn-1, then RUN (tn)
for (const n of [1, 4, 16, 64, 256]) {
	const name = `depth ${n}`
	if (!picked(name)) continue
	const w = world()
	const t = (i: number) => `party.chee.ermine.t${i}`
	const kids: Record<string, Id> = { p: "P", run: "RUN" }
	for (let i = 0; i < n; i++) {
		w.says(`C${i}`, { takes: [t(i)], gives: t(i + 1) }, true)
		kids[`c${i}`] = `C${i}`
	}
	w.says("RUN", { takes: [t(n)] }, true)
	w.says("P", { type: t(0) })
	w.put("children", "W", kids)
	const first = () => satisfy(w.places, "p", ["work"]).next().value
	if (first()?.chain.length !== n + 1) throw new Error(`${name}: no chain of ${n + 1}`)
	row(name, [us(measure(first)), us(measure(w.computer(first))), w.reads(first)])
}

// crowded m: depth 1 (P, C0, RUN in W), and m plain files on "/"
for (const m of [100]) {
	const name = `crowded ${m}`
	if (!picked(name)) continue
	const w = world()
	const t = (i: number) => `party.chee.ermine.t${i}`
	w.says("C0", { takes: [t(0)], gives: t(1) }, true)
	w.says("RUN", { takes: [t(1)] }, true)
	w.says("P", { type: t(0) })
	w.put("children", "W", { p: "P", c0: "C0", run: "RUN" })
	const top: Record<string, Id> = { ermine: "ermine", work: "W" }
	for (let i = 0; i < m; i++) {
		top[`file${i}`] = `F${i}`
		w.says(`F${i}`, { type: "public.plain-text" })
	}
	w.put("children", "R", top)
	const first = () => satisfy(w.places, "p", ["work"]).next().value
	if (first()?.chain.length !== 2) throw new Error(`${name}: no chain of 2`)
	row(name, [us(measure(first)), us(measure(w.computer(first))), w.reads(first)])
}

// breadth k: P (JavaScript), L0 … Lk-1 each JavaScript to JavaScript, RUN taking JavaScript
let stopped = false
for (const k of [2, 4, 6, 8, 10]) {
	const name = `breadth ${k}`
	if (!picked(name)) continue
	const w = world()
	const kids: Record<string, Id> = { p: "P", run: "RUN" }
	for (let i = 0; i < k; i++) {
		w.says(`L${i}`, { takes: [JS], gives: JS }, true)
		kids[`l${i}`] = `L${i}`
	}
	w.says("RUN", { takes: [JS] }, true)
	w.says("P", { type: JS })
	w.put("children", "W", kids)
	const first = () => satisfy(w.places, "p", ["work"]).next().value
	const all = () => {
		let n = 0
		for (const _ of satisfy(w.places, "p", ["work"])) n++
		return n
	}
	const cells = [us(measure(first)), us(measure(w.computer(first))), w.reads(first)]
	if (stopped) cells.push("stopped")
	else {
		// counted and timed at once: a call past ~0.5 s is not made again
		const t = cpu()
		const ways = all()
		const once = (cpu() - t) * 1000
		const out = once > 5e5 ? once : measure(all)
		stopped = out > 2e6
		cells.push(
			us(out),
			stopped ? "stopped" : us(measure(w.computer(all))),
			String(ways),
			w.reads(all),
		)
	}
	row(name, cells)
}

// openwith m: F (public.c-source), O0 … Om-1 (JavaScript, opening public.text), PAGE running them
for (const m of [1, 10, 100]) {
	const name = `openwith ${m}`
	if (!picked(name)) continue
	const w = world()
	const kids: Record<string, Id> = { "f.c": "F", page: "PAGE" }
	for (let i = 0; i < m; i++) {
		w.says(`O${i}`, { type: JS, opens: ["public.text"] })
		kids[`o${i}`] = `O${i}`
	}
	w.says("PAGE", { takes: [JS] }, true)
	w.says("F", { type: "public.c-source" })
	w.put("children", "W", kids)
	const first = () => openwith(w.places, "F", ["work"]).next().value
	const all = () => {
		let n = 0
		for (const _ of openwith(w.places, "F", ["work"])) n++
		return n
	}
	if (all() !== m) throw new Error(`${name}: not ${m} ways`)
	row(name, [
		us(measure(first)),
		us(measure(w.computer(first))),
		w.reads(first),
		us(measure(all)),
		us(measure(w.computer(all))),
		String(m),
		w.reads(all),
	])
}
