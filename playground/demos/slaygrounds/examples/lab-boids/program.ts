/** @jsxImportSource @ermine */
import {
	addTeardown,
	createAction,
	createEffect,
	ensureNode,
	patch,
	peep,
	read,
	ref,
} from "@ermine/system"
import { bind, handler } from "@ermine/render/h"

// program.ts: boids on a canvas. the rules' numbers are nodes under ./params: edit one in the
// graph tab (or drag a slider, which writes the same node) and the flock changes at once. the
// pointer is a node too (written by the card's pointer events, through a handler: a plain listener
// has nothing open to write with). the flock itself (positions, 60 times a second) is not in the graph: it
// is a plain array held by ref at ./flock, which a reload finds again. edit the rules below and the same birds carry on. the
// canvas is drawn by hand and held with ref; the knobs are jsx, each bound to its node under params
const LOOK = `
body { background: #ffff88; margin: 8px; font-family: Jost, system-ui, sans-serif }
.lab { display: flex; flex-direction: column; gap: 8px }
.card { background: #fff; border: 1px solid #000; box-shadow: 0 0 10px 2px #66003322; border-radius: 6px; padding: 6px; width: fit-content }
canvas { display: block; cursor: crosshair; background: #fff }
.knobs { display: grid; grid-template-columns: auto 1fr 2.4em auto 1fr 2.4em; gap: 2px 8px; align-items: center; width: 584px }
.knobs input { accent-color: #ff2284 }
.knobs output { min-width: 2em; text-align: right; font-variant-numeric: tabular-nums }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg); font-weight: 600 }
select { font: inherit; border: 1px solid #000; border-radius: 2px; background: #fff }
`
const W = 560, H = 330
// name: [min, max, step, first value]
const KNOBS: Record<string, [number, number, number, number]> = {
	count: [1, 400, 1, 120],
	speed: [0.5, 6, 0.1, 2.5],
	vision: [10, 120, 1, 50],
	cohesion: [0, 1, 0.01, 0.35],
	alignment: [0, 1, 0.01, 0.5],
	separation: [0, 1, 0.01, 0.6],
	trail: [0, 0.95, 0.01, 0.8],
	hue: [0, 360, 1, 330],
}

type Boid = { x: number; y: number; vx: number; vy: number }

export default function program() {
	const nodes: Record<string, ReturnType<typeof ensureNode>> = {}
	for (const [k, [, , , v]] of Object.entries(KNOBS)) nodes[k] = ensureNode("./params/" + k, v)
	const aim = ensureNode("./params/pointer", "avoid") // avoid | follow
	const pointer = ensureNode("./pointer", null) // {x, y} or null: where the pointer is
	const put = (x: ReturnType<typeof ensureNode>, value: unknown) => patch(x, [{ path: [], value }])
	createAction("on/set", (k: string, v: unknown) => put(k === "pointer" ? aim : nodes[k], v))
	createAction("on/point", (p: { x: number; y: number } | null) => put(pointer, p))

	// the flock: ref at ./flock, so a reload finds the same birds (not in the graph's values: it
	// moves every frame)
	const flock = peep(() => read(ref("./flock", () => ({ birds: [] as Boid[] })))) as {
		birds: Boid[]
	}

	// ---- the rules as numbers, from the nodes: one effect reads them all into P ----
	let P: Record<string, any> = {}
	let pointed: { x: number; y: number } | null = null
	createEffect("settings", () => {
		const out: Record<string, any> = {}
		for (const k in nodes) out[k] = read(nodes[k])
		out.aim = read(aim)
		return JSON.stringify(out)
	}, (json) => {
		P = JSON.parse(json)
		const n = Math.round(P.count)
		const b = flock.birds
		while (b.length > n) b.pop()
		while (b.length < n) {
			const a = Math.random() * 6.28
			b.push({ x: Math.random() * W, y: Math.random() * H, vx: Math.cos(a), vy: Math.sin(a) })
		}
	})
	createEffect("pointed", () => read(pointer), (p) => {
		pointed = p as typeof pointed
	})

	// ---- the canvas: the pointer a node, written by the card's handlers (below) ----
	const canvas = peep(() =>
		read(ref(
			"canvas",
			() => Object.assign(document.createElement("canvas"), { width: W, height: H }),
		))
	) as HTMLCanvasElement
	const g = canvas.getContext("2d")!
	const at = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		return [{ x: e.clientX - r.left, y: e.clientY - r.top }]
	}

	// ---- the loop: step the flock with P, draw ----
	function step() {
		const b = flock.birds
		const v2 = P.vision * P.vision
		for (const a of b) {
			let cx = 0, cy = 0, ax = 0, ay = 0, sx = 0, sy = 0, n = 0
			for (const o of b) {
				if (o === a) continue
				const dx = o.x - a.x, dy = o.y - a.y
				const d2 = dx * dx + dy * dy
				if (d2 > v2) continue
				n++
				cx += o.x
				cy += o.y
				ax += o.vx
				ay += o.vy
				if (d2 < v2 / 6) (sx -= dx / (d2 + 1)), (sy -= dy / (d2 + 1))
			}
			if (n) {
				a.vx += P.cohesion * 0.005 * (cx / n - a.x) + P.alignment * 0.05 * (ax / n - a.vx) +
					P.separation * 6 * sx
				a.vy += P.cohesion * 0.005 * (cy / n - a.y) + P.alignment * 0.05 * (ay / n - a.vy) +
					P.separation * 6 * sy
			}
			if (pointed) {
				const dx = pointed.x - a.x, dy = pointed.y - a.y, d = Math.hypot(dx, dy) + 1
				const s = P.aim === "avoid" ? -1 : 1
				if (P.aim === "avoid" ? d < 110 : true) {
					;(a.vx += (s * dx) / d * 0.25), (a.vy += (s * dy) / d * 0.25)
				}
			}
			const sp = Math.hypot(a.vx, a.vy) || 1
			const k = Math.min(sp, P.speed) / sp
			a.vx *= k
			a.vy *= k
		}
		for (const a of b) {
			a.x = (a.x + a.vx + W) % W
			a.y = (a.y + a.vy + H) % H
		}
	}
	function draw() {
		g.fillStyle = `rgba(255,255,255,${1 - P.trail})`
		g.fillRect(0, 0, W, H)
		for (const a of flock.birds) {
			const r = Math.atan2(a.vy, a.vx)
			g.fillStyle = `hsl(${(P.hue + r * 20) % 360} 90% 55%)`
			g.beginPath()
			g.moveTo(a.x + Math.cos(r) * 7, a.y + Math.sin(r) * 7)
			g.lineTo(a.x + Math.cos(r + 2.5) * 5, a.y + Math.sin(r + 2.5) * 5)
			g.lineTo(a.x + Math.cos(r - 2.5) * 5, a.y + Math.sin(r - 2.5) * 5)
			g.fill()
		}
		if (pointed) {
			g.strokeStyle = "#000"
			g.beginPath()
			g.arc(pointed.x, pointed.y, 6, 0, 6.3)
			g.stroke()
		}
	}
	let raf = 0
	const loop = () => {
		raf = requestAnimationFrame(loop)
		if (P.count === undefined) return
		step()
		draw()
	}
	raf = requestAnimationFrame(loop)
	addTeardown(() => cancelAnimationFrame(raf))

	// ---- the knobs: each a slider and a readout bound to its node; a slide is a send to on/set ----
	const value = (e: Event) => (e.target as HTMLInputElement).value
	return (
		<div class="lab">
			<style>{LOOK}</style>
			<div
				class="card"
				onPointerMove={handler("on/point", at)}
				onPointerLeave={handler("on/point", () => [null])}
			>
				{canvas}
			</div>
			<div class="knobs card">
				{Object.entries(KNOBS).map(([k, [min, max, step]]) => [
					<span>{k}</span>,
					<input
						type="range"
						min={String(min)}
						max={String(max)}
						step={String(step)}
						value={bind("./params/" + k, String)}
						onInput={handler("on/set", (e) => [k, +value(e)])}
					/>,
					<output>{bind("./params/" + k)}</output>,
				])}
				<span>pointer</span>
				<select
					value={bind("./params/pointer")}
					onChange={handler("on/set", (e) => ["pointer", value(e)])}
				>
					<option value="avoid">pushes</option>
					<option value="follow">pulls</option>
				</select>
				<span />
			</div>
		</div>
	)
}
