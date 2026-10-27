// nn's host: the world (@ermine/slaygrounds/world), one process, nn, running program.ts. a
// program.ts edit reloads: nn stopped ("replaced"), then started again on the new code. the host
// adds what the demo measures and the api does not give (extend, below), and it keeps the clock,
// because it times what it runs (the pulse after each step is the scheduler's): each frame the
// host runs nn's on/step while it is playing (a pulse after each: the forward pass the next step
// reads), then on/frame, which paints. measure (/host/on/measure) is the host's too: it is async
import { createWorld } from "@ermine/slaygrounds/world"
import { createAction, executeAction, peep, read } from "@ermine/system"
import type { Ermine } from "@ermine/system"
import update from "@ermine/core/changeable/update"
import { get } from "@ermine/core/places/lib"
import { createChangeHeader } from "@ermine/core/places/header"
import { trace } from "@ermine/core/scheduler/trace"
import { render } from "ermine-h"

type Node = ReturnType<Ermine["ensureNode"]>

// what the page measures: the writes made, the headers they cost, the runs and acts of the
// scheduler, and (timing on) the ms of each run, the program's own memos and effects apart from
// everyone else's (h's bindings, the inspector's)
export type Stats = {
	writes: number
	headers: number
	acts: number
	starts: number
	calls: number
	bodyMs: number
	pulseMs: number
	timing: boolean
	oursMs: number
	othersMs: number
	othersRuns: number
}
export type Extra = {
	// the values put on these nodes with one header and one commit: what the api cannot say (each
	// patch is its own header). for the "one header" row of the measure
	bulk: (puts: [Node, unknown][]) => void
}

const stats: Stats = {
	writes: 0,
	headers: 0,
	acts: 0,
	starts: 0,
	calls: 0,
	bodyMs: 0,
	pulseMs: 0,
	timing: false,
	oursMs: 0,
	othersMs: 0,
	othersRuns: 0,
}

const world = createWorld({
	render,
	processes: [{ name: "nn" }],
	actor: "me@laptop",
	extend: (): Extra => ({
		bulk(puts) {
			const header = createChangeHeader(s)
			const changed = []
			for (const [n, value] of puts) {
				const at = e.dataOf(n)!.node
				const id = at.id ?? get(places, at.path!)!
				const entry = table.get("value", id)!
				update(entry, [{ path: [], value }], header)
				changed.push(entry)
			}
			places.commit(changed)
		},
	}),
})

// every write the api makes is one commit of one entry and its own header; counted where it lands
const { places, s, parts, table } = world.world
const e = world.ermine
const commit = places.commit
places.commit = (changed) => {
	stats.writes += changed.length
	stats.headers++
	return commit(changed)
}
const began = new Map<unknown, number>()
trace(s, (m) => {
	if ("acts" in m) stats.acts++
	if ("starts" in m) {
		stats.starts++
		if (stats.timing) began.set(m.starts, performance.now())
	} else if ("ends" in m && stats.timing && began.has(m.ends)) {
		const ms = performance.now() - began.get(m.ends)!
		began.delete(m.ends)
		if (parts.has(m.ends)) stats.oursMs += ms
		else (stats.othersMs += ms, stats.othersRuns++)
	}
})

// ---- nn's actions, run as the host; none there (not started, or stopped): nothing ----
function act(name: string, ...args: unknown[]): unknown {
	if (!world.world.processes.has("nn")) return
	return e.within(() => executeAction(`/nn/on/${name}`, ...args))
}
// a node's value as the host reads it, none: undefined
const peek = (path: string) => {
	try {
		return e.within(() => peep(() => read(path)))
	} catch {
		return undefined
	}
}

// ---- the clock: steps while playing, then a paint, every frame ----
let measuring = false
let done = 0
const window_: [number, number][] = []
// one step, its body and its pulse timed apart
const one = () => {
	const t0 = performance.now()
	act("step")
	const t1 = performance.now()
	s.pulse()
	const t2 = performance.now()
	stats.calls++
	stats.bodyMs += t1 - t0
	stats.pulseMs += t2 - t1
}
const frame = () => {
	requestAnimationFrame(frame)
	const w0 = stats.writes, s0 = stats.starts, d0 = done
	if (peek("/playing") === true && !measuring) {
		const end = performance.now() + 10
		const speed = peek("/speed") as number
		let k = 0
		try {
			do {
				one()
				k++
				done++
			} while (peek("/playing") === true && (speed ? k < speed : performance.now() < end))
		} catch (e) {
			console.error("a step failed, paused", e)
			act("play", false)
		}
	}
	const now = performance.now()
	window_.push([now, done])
	while (window_.length > 2 && now - window_[0][0] > 1000) window_.shift()
	const [t0, n0] = window_[0]
	const readouts: Record<string, string> = {
		"steps/s": now - t0 > 200 ? String(Math.round(((done - n0) * 1000) / (now - t0))) : "0",
	}
	if (done > d0) {
		readouts["writes/step"] = String(Math.round((stats.writes - w0) / (done - d0)))
		readouts["runs/step"] = String(Math.round((stats.starts - s0) / (done - d0)))
	}
	try {
		act("frame", readouts)
	} catch (e) {
		console.error("a paint failed", e)
	}
}
requestAnimationFrame(frame)

// ---- measure: each grain and write, steps timed in the calls alone; then the arithmetic alone ----
const CONFIGS: [string, string][] = [
	["weight", "each"],
	["weight", "bulk"],
	["layer", "each"],
	["layer", "whole"],
	["layer", "bulk"],
]
const nextFrame = () => new Promise((r) => requestAnimationFrame(r))
async function measure() {
	if (measuring) return
	measuring = true
	act("measuring", true)
	const was = { grain: peek("/grain"), write: peek("/write"), playing: peek("/playing") }
	act("play", false)
	stats.timing = true
	const rows: Record<string, unknown>[] = []
	try {
		for (const [g0, w0] of CONFIGS) {
			act("set", "grain", g0)
			act("set", "write", w0)
			await nextFrame()
			for (let k = 0; k < 10; k++) one()
			const a = { ...stats }
			let n = 0, ms = 0
			const t0 = performance.now()
			while (performance.now() - t0 < 1500) {
				const t1 = performance.now()
				for (let k = 0; k < 10; k++) one()
				ms += performance.now() - t1
				n += 10
				await nextFrame()
			}
			const per = (k: keyof typeof stats) => ((stats[k] as number) - (a[k] as number)) / n
			rows.push({
				grain: g0,
				write: w0,
				"steps/s": Math.round((n * 1000) / ms),
				"ms/step": (ms / n).toFixed(2),
				"in step": per("bodyMs").toFixed(2),
				"in pulse": per("pulseMs").toFixed(2),
				"its runs": per("oursMs").toFixed(2),
				"inspector": per("othersMs").toFixed(2),
				writes: Math.round(per("writes")),
				headers: Math.round(per("headers")),
				runs: Math.round(per("starts")),
			})
		}
		rows.push(act("plain") as Record<string, unknown>)
	} finally {
		stats.timing = false
		act("set", "grain", was.grain)
		act("set", "write", was.write)
		act("speeds", rows)
		act("play", was.playing)
		measuring = false
		act("measuring", false)
		console.log("nn speeds", JSON.stringify(rows))
	}
}
world.seed(() => void createAction("/host/on/measure", measure))

export const reload = world.reload
