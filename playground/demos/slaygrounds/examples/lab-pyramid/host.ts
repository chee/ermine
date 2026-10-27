// lab-pyramid's host: the world (@ermine/slaygrounds/world), one process, pyramid, running
// program.ts, and what the host does that a program cannot: it counts (stats, handed to the program
// by extend) and it runs the measure (/host/on/bench), which is async. the clocks (a frame, a
// second) are the program's own
import { createWorld } from "@ermine/slaygrounds/world"
import { createAction, executeAction, peep, read } from "@ermine/system"
import { render } from "ermine-h"

// what the page measures. writes: commits landed (each a write of a node's value); acts: effects
// that acted; runs: computations that ran; pulses: pulses ended, pulseMs the time in them, maxMs
// the longest one. counted by wrapping the scheduler's pulse and the places' commit, once
export type Stats = {
	writes: number
	acts: number
	runs: number
	pulses: number
	pulseMs: number
	maxMs: number
}
export type Tools = { stats: Stats }

// what the program and the host share: a live object at /pyramid/meter, made by the program
export type Meter = {
	// the config as built (the last one the program's effect saw)
	conf: { depth: number; kind: string; mode: string; spread: number; scale: string }
	last: { build: number; dots: number }
	// frames written (the program's on/frame), ms in their writes, animation frames seen
	frames: number
	body: number
	frameCount: number
	builds: Record<string, unknown>[]
	rows: Record<string, unknown>[]
	// the elements the program's view gave: the measure button, the results
	run?: HTMLButtonElement
	results?: HTMLElement
}

const stats: Stats = { writes: 0, acts: 0, runs: 0, pulses: 0, pulseMs: 0, maxMs: 0 }
const world = createWorld({
	render,
	processes: [{ name: "pyramid" }],
	extend: (): Tools => ({ stats }),
})
const { s, places } = world.world
const e = world.ermine

s.onEffect(() => void stats.acts++)
s.onRunStart(() => void stats.runs++)
const pulse = s.pulse
s.pulse = () => {
	const t0 = performance.now()
	pulse()
	const ms = performance.now() - t0
	stats.pulses++
	stats.pulseMs += ms
	stats.maxMs = Math.max(stats.maxMs, ms)
}
const commit = places.commit
places.commit = (changed) => (stats.writes++, commit(changed))

// the program's meter, if it is running
const meter = () => {
	try {
		return e.within(() => peep(() => read("/pyramid/meter"))) as Meter
	} catch {
		return undefined
	}
}

// the page the bench is reached from
const page = globalThis as Record<string, unknown>

// ---- measure: a table of settings, each run for 2.5 s after 0.7 s to settle ----
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// a config key set, a rebuild (depth, kind) pulsed now so its time is told
function change(m: Meter, k: string, v: unknown) {
	if ((m.conf as Record<string, unknown>)[k] === v) return
	const t0 = performance.now()
	e.within(() => executeAction("/pyramid/on/set", k, v))
	if (k === "depth" || k === "kind") {
		s.pulse()
		m.builds.push({
			depth: m.conf.depth,
			kind: m.conf.kind,
			ms: +m.last.build.toFixed(1),
			total: +(performance.now() - t0).toFixed(1),
			dots: m.last.dots,
		})
	}
}
function table(m: Meter) {
	const keys = Object.keys(m.rows[0])
	const html = `<table><tr>${keys.map((k) => `<th>${k}</th>`).join("")}</tr>${
		m.rows.map((r) => `<tr>${keys.map((k) => `<td>${r[k]}</td>`).join("")}</tr>`).join("")
	}</table>`
	if (m.results) m.results.innerHTML = html
}
async function bench() {
	const m = meter()
	if (!m) return
	if (m.run) m.run.disabled = true
	m.rows.length = 0
	const plan: Meter["conf"][] = [
		{ depth: 1, kind: "bare", mode: "spread", spread: 0, scale: "graph" },
		{ depth: 1, kind: "bare", mode: "spread", spread: 0, scale: "css" },
		{ depth: 5, kind: "parts", mode: "spread", spread: 8, scale: "graph" },
		{ depth: 5, kind: "bare", mode: "spread", spread: 8, scale: "graph" },
		{ depth: 5, kind: "bare", mode: "spread", spread: 64, scale: "graph" },
		{ depth: 5, kind: "parts", mode: "clock", spread: 0, scale: "graph" },
		{ depth: 5, kind: "bare", mode: "clock", spread: 0, scale: "graph" },
		{ depth: 6, kind: "bare", mode: "spread", spread: 8, scale: "graph" },
		{ depth: 6, kind: "bare", mode: "clock", spread: 0, scale: "graph" },
		{ depth: 7, kind: "bare", mode: "spread", spread: 8, scale: "graph" },
		{ depth: 7, kind: "bare", mode: "clock", spread: 0, scale: "graph" },
	]
	for (const p of plan) {
		for (const [k, v] of Object.entries(p)) change(m, k, v)
		await sleep(700)
		const a = { ...stats }
		const f0 = m.frameCount, b0 = m.body, n0 = m.frames
		stats.maxMs = 0
		const t0 = performance.now()
		await sleep(4500)
		const dt = (performance.now() - t0) / 1000
		const calls = m.frames - n0 || 1
		m.rows.push({
			...p,
			dots: m.last.dots,
			fps: +((m.frameCount - f0) / dt).toFixed(1),
			"updates/s": Math.round((stats.acts - a.acts) / dt),
			"writes/s": Math.round((stats.writes - a.writes) / dt),
			"runs/s": Math.round((stats.runs - a.runs) / dt),
			"body ms/frame": +((m.body - b0) / calls).toFixed(2),
			"pulse ms/frame": +((stats.pulseMs - a.pulseMs) / calls).toFixed(2),
			"max pulse ms": +stats.maxMs.toFixed(1),
		})
		table(m)
	}
	console.log("bench", JSON.stringify(m.rows))
	console.log("build", JSON.stringify(m.builds))
	if (m.run) m.run.disabled = false
}
world.seed(() => void createAction("/host/on/bench", bench))
page.__bench = bench
page.__rows = () => meter()?.rows

export const reload = world.reload
