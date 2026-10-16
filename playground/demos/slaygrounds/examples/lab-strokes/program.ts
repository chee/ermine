/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// program.ts: a drawing whose strokes are nodes. strokes/s<id> holds {color, width, points};
// strokes/order is the list of ids; pen is the colour and width of the next one. a point is added
// by a patch (produce), not by writing the stroke again. the big canvas and the small one are two
// views of the same nodes; edit this file (reload) and the drawing is still there, because it
// was never in the program. the strokes can be edited in the graph tab too (change a colour).
// the canvases are drawn by hand and held with ref; the pen's buttons and the tally are jsx, bound to nodes
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

export default function program({ open, read, edit, remove, method, effect, memo, ref }: API) {
	// saved under ./, so a reload finds the drawing as it was
	const order = open("./order", ["seed"])
	const pen = open("./pen", { color: "#ff2284", width: 4 })
	const ids = () => read(order) as string[]
	const slot = (id: string) => `./strokes/s${id}`

	// the first time only: a little flower, so there is something to see
	if (ids().includes("seed")) {
		open(slot("seed"), {
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

	// ---- methods: undo, clear, pen. a stroke begins and grows from the pointer's listeners, which
	// edit directly ----
	method("on/undo", () => {
		const last = ids().at(-1)
		if (last === undefined) return
		edit(order, (d: string[]) => void d.pop())
		remove(slot(last))
	})
	method("on/clear", () => {
		for (const id of ids()) remove(slot(id))
		edit(order, (d: string[]) => void d.splice(0))
	})
	method("on/pen", (key: string, value: unknown) => edit(pen, (d: any) => void (d[key] = value)))

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
	effect("paint", () => ids().map(stroke), (all) => {
		paint(canvas.getContext("2d")!, all, 1)
		paint(mini.getContext("2d")!, all, 140 / W)
	})
	// the tally: how many strokes and points, a node of its own (bound below)
	memo("tally", () => {
		const all = ids().map(stroke)
		const points = all.reduce((n: number, s: any) => n + (s?.points.length ?? 0), 0)
		return `${all.length} strokes, ${points} points`
	})

	// ---- the pointer ----
	let live: string | undefined
	const at = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]
	}
	canvas.onpointerdown = (e) => {
		canvas.setPointerCapture(e.pointerId)
		const [x, y] = at(e)
		const id = crypto.randomUUID().slice(0, 6)
		open(slot(id), { ...(read(pen) as object), points: [[x, y]] })
		edit(order, (d: string[]) => void d.push(id))
		live = id
	}
	canvas.onpointermove = (e) => {
		if (!live) return
		const [x, y] = at(e)
		edit(slot(live), (d: any) => void d.points.push([x, y]))
	}
	canvas.onpointerup = canvas.onpointercancel = () => (live = undefined)

	// ---- the tools: the pen is a node, so its buttons follow it (bound) ----
	const lit = (yes: boolean, cls = "") => (yes ? `${cls} on` : cls).trim()
	return (
		<div class="lab">
			<style>{LOOK}</style>
			<div class="card">{canvas}</div>
			<div class="row card">
				{COLORS.map((c) => (
					<button
						style={{ background: c }}
						class={bind("pen", (p) => lit(p.color === c, "sw"))}
						onClick={handler("on/pen", ["color", c])}
					/>
				))}
				<button
					class={bind("pen", (p) => lit(p.width === 2))}
					onClick={handler("on/pen", ["width", 2])}
				>
					thin
				</button>
				<button
					class={bind("pen", (p) => lit(p.width === 12))}
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
