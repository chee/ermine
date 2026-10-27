/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	ensureNode,
	patch,
	peep,
	read,
	ref,
	unplace,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import type { Meter, Tools } from "./host.ts"
import { bind, handler } from "ermine-h"

// program.ts: the pyramid stress test. a sierpinski triangle of dots, each showing a number that
// lives in a graph node. an effect per dot reads its node and writes the text: only the dots whose
// number changed run. the whole triangle breathes (scale) while the numbers count.
//   spread: each frame a few random dots' nodes are written (fine-grained: only those update)
//   clock:  once a second one node changes and every dot reads it (a fan-out: all dots update)
// the readout is plain DOM, not the graph: measuring through the thing measured would change it.
// the controls are jsx (each select bound to its key of the config node); the triangle's dots are
// made by hand inside an element held with ref
// the clocks are the host's (host.ts): nothing is open in a requestAnimationFrame or a timer, so a
// program cannot write from one. the host calls on/frame each frame and on/second each second, and
// runs the measure (/host/on/bench). what they share with the program is the meter, a live object at
// ./meter inside this process (config as built, last build, counts), read by the host
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

type Config = Meter["conf"]
const FIRST: Config = { depth: 5, kind: "parts", mode: "spread", spread: 8, scale: "graph" }

// kind: "parts" makes each dot's effect named (placed in the process at p<i>), "bare" leaves it
// unnamed (a node with no place). both write their node at each act
export default function program() {
	const { stats } = host<Tools>()
	const cfg = ensureNode("./config", FIRST)
	const seconds = ensureNode("./seconds", 0)
	const scale = ensureNode("./scale", 1)
	const put = (x: ReturnType<typeof ensureNode>, v: unknown) => patch(x, [{ path: [], value: v }])
	const bump = (x: ReturnType<typeof ensureNode>) => put(x, (peep(() => read(x)) as number) + 1)

	// a key of the config
	const set = (k: string, v: unknown) => patch(cfg, [{ path: [k], value: v }])
	createAction("on/set", set)

	// the meter: conf and hits are the last built, body the ms in the frames' writes, frameCount the
	// animation frames seen. a live object, shared with the host's clock and measure
	const meter = read(
		ref("meter", (): Meter => ({
			conf: FIRST,
			last: { build: 0, dots: 0 },
			frames: 0,
			body: 0,
			frameCount: 0,
			builds: [],
			rows: [],
		})),
	) as Meter
	let hits: ReturnType<typeof ensureNode>[] = []

	// one frame, called by the host each frame: the scale, and a few dots' own counters
	createAction("on/frame", (now: number) => {
		const t0 = performance.now()
		const conf = meter.conf
		if (conf.scale === "graph" || (conf.mode === "spread" && conf.spread > 0)) meter.frames++
		else return
		if (conf.scale === "graph") put(scale, wobble(now))
		if (conf.mode === "spread" && hits.length) {
			for (let k = 0; k < conf.spread; k++) bump(hits[(Math.random() * hits.length) | 0])
		}
		meter.body += performance.now() - t0
	})
	// one second, called by the host each second
	createAction("on/second", () => bump(seconds))

	// ---- the view: the triangle is held with ref, its dots made by the build effect below ----
	const tri = read(ref("tri", () => document.createElement("div"))) as HTMLElement
	tri.className = "tri"

	// the config the loop reads (the selects are bound to it below)
	createEffect("conf", () => read(cfg) as Config, (c) => {
		meter.conf = c
	})

	// ---- the scale: one node, one effect ----
	createEffect("zoom", () => read(scale) as number, (v) => {
		tri.style.transform = `scale(${v})`
	})

	// ---- the dots: rebuilt when depth or kind change (read by path, so spread, mode and
	// scale edits do not wake it). what the act makes is under the effect, gone before its next act
	createEffect(
		"dots",
		() => read(cfg, ["depth"]) + ":" + read(cfg, ["kind"]),
		(key: string) => {
			const t0 = performance.now()
			const [depth, kind] = key.split(":")
			const spots = layout(+depth)
			// the old ones out: their numbers. the effects, named or not, went with the act that made them
			const old = hits.length
			for (let i = 0; i < old; i++) {
				unplace(`./dots/d${i}`)
			}
			hits = []
			const els: HTMLElement[] = []
			spots.forEach((p, i) => {
				const hit = ensureNode(`./dots/d${i}`, 0)
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
				createEffect(`p${i}`, f, act)
			})
			tri.replaceChildren(...els)
			meter.last = { build: performance.now() - t0, dots: spots.length }
		},
	)

	// ---- the readout: the frames counted by the page's own loop (no writes in it), the graph's
	// counts from the host's stats ----
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
	const sample = () => {
		const st = stats
		const now = performance.now()
		const dt = (now - win.t) / 1000
		const calls = meter.frames - was.frames || 1
		const show = (name: string, v: string) => (tag(name).innerHTML = `${name} <b>${v}</b>`)
		show("fps", (win.frames / dt).toFixed(0))
		show("frame ms", ((dt * 1000) / Math.max(win.frames, 1)).toFixed(1))
		show("worst ms", win.worst.toFixed(0))
		show("updates/s", ((st.acts - was.acts) / dt).toFixed(0))
		show("writes/s", ((st.writes - was.writes) / dt).toFixed(0))
		show("body ms", ((meter.body - was.body) / calls).toFixed(2))
		show("pulse ms", ((st.pulseMs - was.pulse) / calls).toFixed(2))
		show("dots", String(meter.last.dots))
		Object.assign(was, {
			acts: st.acts,
			writes: st.writes,
			frames: meter.frames,
			body: meter.body,
			pulse: st.pulseMs,
		})
		Object.assign(win, { t: now, frames: 0, worst: 0 })
	}
	// the page's own frame loop: the readout's frames, and the css scale (no graph, so no write)
	let raf = 0
	const loop = (now: number) => {
		raf = requestAnimationFrame(loop)
		win.frames++
		meter.frameCount++
		win.worst = Math.max(win.worst, now - win.prev)
		win.prev = now
		if (meter.conf.scale === "css") tri.style.transform = `scale(${wobble(now)})`
	}
	raf = requestAnimationFrame(loop)
	const shown = setInterval(sample, 500)
	addTeardown(() => (cancelAnimationFrame(raf), clearInterval(shown)))

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
				<button ref={(e) => (meter.run = e)} onClick={handler("/host/on/bench")}>
					measure
				</button>
			</div>
			<div class="read">
				{order.map((name) => <span class="tag" ref={(e) => tags.set(name, e)} />)}
			</div>
			<div class="stage">{tri}</div>
			<div ref={(e) => (meter.results = e)} />
		</div>
	)
}
