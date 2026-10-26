// deno run playground/programs/typescript/programs_bench.ts [name…]   (deno bench runs it too)
// satisfy and openwith over a real table, paths, scheduler and places (root R, children alone, no
// box), the well-known types at R/ermine/types; every loader a host function in W (R/work), the
// program or file there too, the search from ["work"]. each shape timed outside any run and inside
// a computer rerun by a tick and a pulse (the tick alone: "tick"). medians of up to 21 rounds, CPU
// µs per call. reads: places reads told the scheduler / distinct keys. names given: only the shapes
// whose name holds one
//   depth n:    n compilers (t0 → … → tn, types unknown) then a runner: the first way only
//   breadth k:  k loaders taking and giving JavaScript, and a runner: the first way, then all,
//               counted (stopped once one call passes ~2 s)
//   crowded m:  depth 1, and m plain files on "/" (never read)
//   openwith m: m openers of public.text, the file public.c-source: the first, all
//
// 2026-10-15 (A18 Pro, deno 2.9.7, busy machine), first way, µs: depth 1 18, 16 83, 256 4810;
// breadth 10 27 (all: 11.2 s, ~e·k! ways); crowded 100 14; openwith 100 132. in and out alike
import createEntry from "@ermine/core/node/entry"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createPlaces } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
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
	const host = s.createRootScope({ actor: "bench" })
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
