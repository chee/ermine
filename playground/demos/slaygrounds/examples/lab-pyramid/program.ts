/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import type { Tools } from "./host.ts"
import { bind, handler } from "ermine-h"

// program.ts: the pyramid stress test. a sierpinski triangle of dots, each showing a number that
// lives in a graph node. an effect per dot reads its node and writes the text: only the dots whose
// number changed run. the whole triangle breathes (scale) while the numbers count.
//   spread: each frame the host writes a few random dots' nodes (fine-grained: only those update)
//   clock:  once a second one node changes and every dot reads it (a fan-out: all dots update)
// the readout is plain DOM, not the graph: measuring through the thing measured would change it.
// the controls are jsx (each select bound to its key of the config node); the triangle's dots are
// made by hand inside an element held with ref
const LOOK = `
body { background: #ffff88; margin: 8px; font-family: Jost, system-ui, sans-serif }
.lab { display: flex; flex-direction: column; gap: 8px }
.bar { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center }
.bar label { display: flex; gap: 4px; align-items: center }
select { font: inherit; border: 1px solid #000; border-radius: 2px; background: #fff; padding: 1px 4px }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg); font-weight: 600 }
.read { display: flex; flex-wrap: wrap; gap: 6px }
.read .tag { background: #fff; font-variant-numeric: tabular-nums; min-width: 92px; text-align: right }
.read .tag b { color: #ff2284 }
.stage { background: #fff; border: 1px solid #000; box-shadow: 0 0 10px 2px #66003322; border-radius: 6px; height: 520px; display: grid; place-items: center; overflow: hidden }
.tri { position: relative; width: 560px; height: 485px; transform-origin: 50% 70% }
.dot { position: absolute; border-radius: 50%; display: grid; place-items: center; color: #000; background: #c8f6ea; font-size: 8px; line-height: 1; overflow: hidden }
.dot.odd { background: #ffd9ea }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; background: #fff }
td, th { border: 1px solid #000; padding: 1px 6px; text-align: right }
th:first-child, td:first-child { text-align: left }
`

const W = 560
const wobble = (now: number) => 0.85 + 0.12 * Math.sin(now / 700)

// the leaves of a sierpinski triangle of this depth: 3 ** depth dots
function layout(depth: number) {
	const dot = W / 2 ** depth
	const out: { x: number; y: number; size: number }[] = []
	const rec = (level: number, x: number, y: number, side: number) => {
		if (level === 0) return void out.push({ x, y, size: side })
		const half = side / 2
		rec(level - 1, x + side / 4, y, half)
		rec(level - 1, x, y + half * 0.866, half)
		rec(level - 1, x + half, y + half * 0.866, half)
	}
	rec(depth, 0, 0, dot * 2 ** depth)
	return out
}

type Config = { depth: number; kind: string; mode: string; spread: number; scale: string }
const FIRST: Config = { depth: 5, kind: "parts", mode: "spread", spread: 8, scale: "graph" }

// kind: "parts" makes each dot's effect named (placed in the process at p<i>), "bare" leaves it
// unnamed (a node with no place). both write their node at each act
export default function program(
	{ open, read, edit, remove, effect, method, pulse, teardown, ref, stats }: API & Tools,
) {
	const cfg = open("./config", FIRST)
	const seconds = open("./seconds", 0)
	const scale = open("./scale", 1)
	const put = (x: ReturnType<typeof open>, v: unknown) => edit(x, () => v)

	// a recipe: a key of the config
	const set = (k: string, v: unknown) => edit(cfg, (d: any) => void (d[k] = v))
	method("on/set", set)
	// one frame: the scale, and a few dots' own counters. conf and hits are the last built
	let conf: Config = FIRST
	let hits: ReturnType<typeof open>[] = []
	let body = 0 // ms in the frames' writes
	function frame(now: number) {
		const t0 = performance.now()
		if (conf.scale === "graph") put(scale, wobble(now))
		if (conf.mode === "spread" && hits.length) {
			for (let k = 0; k < conf.spread; k++) {
				const d = hits[(Math.random() * hits.length) | 0]
				edit(d, (n: number) => n + 1)
			}
		}
		body += performance.now() - t0
	}

	// ---- the view: the triangle is held with ref, its dots made by the build effect below ----
	const tri = read(ref("tri", () => document.createElement("div"))) as HTMLElement
	tri.className = "tri"
	let run: HTMLButtonElement | undefined
	let results: HTMLElement | undefined

	// the config the loop reads (the selects are bound to it below)
	effect("conf", () => read(cfg) as Config, (c) => (conf = c))

	// ---- the scale: one node, one effect ----
	effect("zoom", () => read(scale) as number, (v) => {
		tri.style.transform = `scale(${v})`
	})

	// ---- the dots: rebuilt when depth or kind change (read by path, so spread, mode and
	// scale edits do not wake it). what the act makes is under the effect, gone before its next act
	let last = { build: 0, dots: 0 }
	effect("dots", () => read(cfg, ["depth"]) + ":" + read(cfg, ["kind"]), (key: string) => {
		const t0 = performance.now()
		const [depth, kind] = key.split(":")
		const spots = layout(+depth)
		// the old ones out: their numbers. the effects, named or not, went with the act that made them
		const old = hits.length
		for (let i = 0; i < old; i++) {
			remove(`./dots/d${i}`)
		}
		hits = []
		const els: HTMLElement[] = []
		spots.forEach((p, i) => {
			const hit = open(`./dots/d${i}`, 0)
			hits.push(hit)
			const el = document.createElement("div")
			el.className = "dot"
			el.style.cssText =
				`left:${p.x}px;top:${p.y}px;width:${p.size}px;height:${p.size}px;font-size:${
					p.size * 0.55
				}px`
			els.push(el)
			const f = () =>
				read(cfg, ["mode"]) === "clock" ? read(seconds) as number : read(hit) as number
			const act = (v: number) => {
				el.textContent = String(v)
				el.classList.toggle("odd", v % 2 === 1)
			}
			effect(`p${i}`, f, act)
		})
		tri.replaceChildren(...els)
		last = { build: performance.now() - t0, dots: spots.length }
	})

	// ---- the loop: a frame writes, a second writes, straight from their timers. the readout
	// counts both ----
	const win = { t: performance.now(), frames: 0, worst: 0, prev: performance.now() }
	// the readout's tags: plain text written by hand, into the elements the jsx gives back
	const tags = new Map<string, HTMLElement>()
	const tag = (name: string) => tags.get(name) ?? document.createElement("span")
	const order = [
		"fps",
		"frame ms",
		"worst ms",
		"updates/s",
		"writes/s",
		"body ms",
		"pulse ms",
		"dots",
	]
	const was = { acts: 0, writes: 0, frames: 0, body: 0, pulse: 0 }
	let frames = 0
	const sample = () => {
		const st = stats
		const now = performance.now()
		const dt = (now - win.t) / 1000
		const calls = frames - was.frames || 1
		const show = (name: string, v: string) => (tag(name).innerHTML = `${name} <b>${v}</b>`)
		show("fps", (win.frames / dt).toFixed(0))
		show("frame ms", ((dt * 1000) / Math.max(win.frames, 1)).toFixed(1))
		show("worst ms", win.worst.toFixed(0))
		show("updates/s", ((st.acts - was.acts) / dt).toFixed(0))
		show("writes/s", ((st.writes - was.writes) / dt).toFixed(0))
		show("body ms", ((body - was.body) / calls).toFixed(2))
		show("pulse ms", ((st.pulseMs - was.pulse) / calls).toFixed(2))
		show("dots", String(last.dots))
		Object.assign(was, { acts: st.acts, writes: st.writes, frames, body, pulse: st.pulseMs })
		Object.assign(win, { t: now, frames: 0, worst: 0 })
	}
	let raf = 0
	const loop = (now: number) => {
		raf = requestAnimationFrame(loop)
		win.frames++
		win.worst = Math.max(win.worst, now - win.prev)
		win.prev = now
		if (conf.scale === "css") tri.style.transform = `scale(${wobble(now)})`
		if (conf.scale === "graph" || (conf.mode === "spread" && conf.spread > 0)) {
			frames++
			frame(now)
		}
	}
	raf = requestAnimationFrame(loop)
	const every = setInterval(() => edit(seconds, (n: number) => n + 1), 1000)
	const shown = setInterval(sample, 500)
	teardown(() => (cancelAnimationFrame(raf), clearInterval(every), clearInterval(shown)))

	// ---- measure: a table of settings, each run for 2.5 s after 0.7 s to settle ----
	const rows: Record<string, unknown>[] = []
	async function bench() {
		if (run) run.disabled = true
		rows.length = 0
		const plan: Config[] = [
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
			for (const [k, v] of Object.entries(p)) change(k, v)
			await sleep(700)
			const a = { ...stats }
			const f0 = frameCount, b0 = body, n0 = frames
			stats.maxMs = 0
			const t0 = performance.now()
			await sleep(4500)
			const dt = (performance.now() - t0) / 1000
			const calls = frames - n0 || 1
			rows.push({
				...p,
				dots: last.dots,
				fps: +((frameCount - f0) / dt).toFixed(1),
				"updates/s": Math.round((stats.acts - a.acts) / dt),
				"writes/s": Math.round((stats.writes - a.writes) / dt),
				"runs/s": Math.round((stats.runs - a.runs) / dt),
				"body ms/frame": +((body - b0) / calls).toFixed(2),
				"pulse ms/frame": +((stats.pulseMs - a.pulseMs) / calls).toFixed(2),
				"max pulse ms": +stats.maxMs.toFixed(1),
			})
			table()
		}
		console.log("bench", JSON.stringify(rows))
		console.log("build", JSON.stringify(builds))
		if (run) run.disabled = false
	}
	let frameCount = 0
	const count = () => (frameCount++, (counter = requestAnimationFrame(count)))
	let counter = requestAnimationFrame(count)
	teardown(() => cancelAnimationFrame(counter))
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
	// a config key set, a rebuild (depth, kind) pulsed now so its time is told
	const change = (k: string, v: unknown) => {
		if ((conf as Record<string, unknown>)[k] === v) return
		const t0 = performance.now()
		set(k, v)
		if (k === "depth" || k === "kind") {
			pulse()
			builds.push({
				depth: conf.depth,
				kind: conf.kind,
				ms: +last.build.toFixed(1),
				total: +(performance.now() - t0).toFixed(1),
				dots: last.dots,
			})
		}
	}
	const builds: Record<string, unknown>[] = []
	function table() {
		const keys = Object.keys(rows[0])
		const html = `<table><tr>${keys.map((k) => `<th>${k}</th>`).join("")}</tr>${
			rows.map((r) => `<tr>${keys.map((k) => `<td>${r[k]}</td>`).join("")}</tr>`).join("")
		}</table>`
		if (results) results.innerHTML = html
	}
	;(globalThis as any).__bench = bench
	;(globalThis as any).__rows = rows

	// ---- the controls: a select per key of the config, bound to it; a change sends to on/set ----
	const control = (key: string, label: string, options: (string | number)[]) => (
		<label>
			{label}{" "}
			<select
				value={bind("config", (c) => String(c[key]))}
				onChange={handler("on/set", (e) => {
					const v = (e.target as HTMLSelectElement).value
					return [key, typeof options[0] === "number" ? +v : v]
				})}
			>
				{options.map((o) => <option value={String(o)}>{String(o)}</option>)}
			</select>
		</label>
	)
	return (
		<div class="lab">
			<style>{LOOK}</style>
			<div class="bar">
				{control("depth", "depth", [1, 2, 3, 4, 5, 6, 7])}
				{control("kind", "dots as", ["parts", "bare"])}
				{control("mode", "numbers", ["spread", "clock"])}
				{control("spread", "per frame", [0, 1, 8, 64])}
				{control("scale", "scale by", ["graph", "css"])}
				<button ref={(e) => (run = e)} onClick={() => bench()}>measure</button>
			</div>
			<div class="read">
				{order.map((name) => <span class="tag" ref={(e) => tags.set(name, e)} />)}
			</div>
			<div class="stage">{tri}</div>
			<div ref={(e) => (results = e)} />
		</div>
	)
}
