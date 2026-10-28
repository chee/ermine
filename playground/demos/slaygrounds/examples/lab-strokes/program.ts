/** @jsxImportSource @ermine */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	patch,
	peep,
	read,
	ref,
	unplace,
} from "@ermine/system"
import { bind, handler } from "@ermine/render/h"

// program.ts: a drawing whose strokes are nodes. strokes/s<id> holds {color, width, points};
// strokes/order is the list of ids; pen is the colour and width of the next one. a point is added
// by a patch, not by writing the stroke again. the big canvas and the small one are two
// views of the same nodes; edit this file (reload) and the drawing is still there, because it
// was never in the program. the strokes can be edited in the graph tab too (change a colour).
// the canvases are drawn by hand and held with ref; the pen's buttons and the tally are jsx, bound to nodes
// the pointer is jsx too: a listener of the program's own would have nothing open to write in, so the
// canvas's events are handlers (on/begin, on/grow, on/end), whose actions write
const LOOK = `
body { background: #ffff88; margin: 8px; font-family: Jost, system-ui, sans-serif }
.lab { display: flex; flex-direction: column; gap: 8px; width: 584px }
.card { background: #fff; border: 1px solid #000; box-shadow: 0 0 10px 2px #66003322; border-radius: 6px; padding: 6px }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap }
canvas.big { display: block; cursor: crosshair; touch-action: none }
canvas.mini { border: 1px solid #000; background: #fff; margin-left: auto }
button { font: inherit; padding: 2px 12px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 1px 1px 0 #000; cursor: pointer; transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translateY(-1px); box-shadow: 2px 2px 0 #000 }
button:active { transform: none; box-shadow: none }
button.sw { width: 24px; height: 24px; padding: 0; border-radius: 50% }
button.on { outline: 2px solid #000; outline-offset: 2px }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg); font-weight: 600 }
`
const W = 560, H = 360
const COLORS = ["#000000", "#ff2284", "#40dcba", "#2269ff"]

export default function program() {
	// saved under ./, so a reload finds the drawing as it was
	const order = ensureNode("./order", ["seed"])
	const pen = ensureNode("./pen", { color: "#ff2284", width: 4 })
	// the ids, tracked (for a memo or an effect), and as they are now (an action)
	const ids = () => read(order) as string[]
	const now = () => peep(ids)
	const slot = (id: string) => `./strokes/s${id}`
	const put = (x: ReturnType<typeof ensureNode>, v: unknown) => patch(x, [{ path: [], value: v }])

	// the first time only: a little flower, so there is something to see
	if (now().includes("seed")) {
		ensureNode(slot("seed"), {
			color: "#40dcba",
			width: 6,
			points: Array.from({ length: 41 }, (_, i) => {
				const a = (i / 40) * 6.28
				return [
					280 + Math.cos(a) * (60 + 30 * Math.sin(a * 5)),
					180 + Math.sin(a) * (60 + 30 * Math.sin(a * 5)),
				]
			}),
		})
	}

	// ---- actions: undo, clear, pen, and the pointer's: a stroke begins, grows and ends ----
	createAction("on/undo", () => {
		const last = now().at(-1)
		if (last === undefined) return
		put(order, now().slice(0, -1))
		unplace(slot(last))
	})
	createAction("on/clear", () => {
		for (const id of now()) unplace(slot(id))
		put(order, [])
	})
	createAction("on/pen", (key: string, value: unknown) => patch(pen, [{ path: [key], value }]))
	let live: string | undefined
	createAction("on/begin", (x: number, y: number) => {
		const id = crypto.randomUUID().slice(0, 6)
		ensureNode(slot(id), { ...(peep(() => read(pen)) as object), points: [[x, y]] })
		put(order, [...now(), id])
		live = id
	})
	createAction("on/grow", (x: number, y: number) => {
		if (!live) return
		const points = peep(() => read(slot(live!), ["points"])) as number[][]
		patch(slot(live), [{
			path: ["points"],
			range: [points.length, points.length],
			value: [[x, y]],
		}])
	})
	createAction("on/end", () => void (live = undefined))

	// ---- the paint: one effect reads the order and each stroke; its act draws both canvases ----
	const canvas = read(ref(
		"canvas",
		() => Object.assign(document.createElement("canvas"), { width: W, height: H }),
	)) as HTMLCanvasElement
	canvas.className = "big"
	const mini = read(ref(
		"mini",
		() => Object.assign(document.createElement("canvas"), { width: 140, height: 90 }),
	)) as HTMLCanvasElement
	mini.className = "mini"
	function paint(g: CanvasRenderingContext2D, all: any[], k: number) {
		g.save()
		g.scale(k, k)
		g.clearRect(0, 0, W, H)
		g.lineCap = g.lineJoin = "round"
		for (const s of all) {
			if (!s) continue
			g.strokeStyle = s.color
			g.lineWidth = s.width
			g.beginPath()
			s.points.forEach(([x, y]: number[], i: number) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
			if (s.points.length === 1) g.lineTo(s.points[0][0] + 0.1, s.points[0][1])
			g.stroke()
		}
		g.restore()
	}
	// one stroke's value by its id (read, so whoever calls this reruns when it changes)
	const stroke = (id: string) => read(slot(id))
	createEffect("paint", () => ids().map(stroke), (all) => {
		paint(canvas.getContext("2d")!, all, 1)
		paint(mini.getContext("2d")!, all, 140 / W)
	})
	// the tally: how many strokes and points, a node of its own (bound below)
	createMemo("tally", () => {
		const all = ids().map(stroke)
		const points = all.reduce((n: number, s: any) => n + (s?.points.length ?? 0), 0)
		return `${all.length} strokes, ${points} points`
	})

	// ---- the pointer: the canvas's events bubble to the pad, whose handlers run the actions above.
	// a move not in a stroke sends nothing (no args) ----
	const at = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]
	}

	// ---- the tools: the pen is a node, so its buttons follow it (bound) ----
	const lit = (yes: boolean, cls = "") => (yes ? `${cls} on` : cls).trim()
	return (
		<div class="lab">
			<style>{LOOK}</style>
			<div
				class="card"
				onPointerDown={handler("on/begin", (e: PointerEvent) => {
					canvas.setPointerCapture(e.pointerId)
					return at(e)
				})}
				onPointerMove={handler("on/grow", (e: PointerEvent) => live ? at(e) : undefined)}
				onPointerUp={handler("on/end")}
				onPointerCancel={handler("on/end")}
			>
				{canvas}
			</div>
			<div class="row card">
				{COLORS.map((c) => (
					<button
						style={{ background: c }}
						class={bind("./pen", (p) => lit(p.color === c, "sw"))}
						onClick={handler("on/pen", ["color", c])}
					/>
				))}
				<button
					class={bind("./pen", (p) => lit(p.width === 2))}
					onClick={handler("on/pen", ["width", 2])}
				>
					thin
				</button>
				<button
					class={bind("./pen", (p) => lit(p.width === 12))}
					onClick={handler("on/pen", ["width", 12])}
				>
					thick
				</button>
				<button onClick={handler("on/undo")}>undo</button>
				<button onClick={handler("on/clear")}>clear</button>
				<span class="tag">{bind("tally")}</span>
				{mini}
			</div>
		</div>
	)
}
