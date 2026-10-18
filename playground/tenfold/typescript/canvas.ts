/// <reference lib="dom" />
// canvas: a surface (surfaces.ts) on a 2d canvas. cells in a grid of columns by rows, the first at
// the top left, square and centred; frames from requestAnimationFrame while anyone listens. marks
// drawn red: an error tints the cell and says what, a cost is said at its foot
import type { Op } from "./letter.ts"
import type { Surface } from "./surfaces.ts"

type Context2D = CanvasRenderingContext2D

export function createCanvasSurface(
	canvas: HTMLCanvasElement,
	o: { columns: number; rows: number; ink?: string; paper?: string; red?: string },
): Surface {
	const ctx = canvas.getContext("2d") as Context2D
	const { columns, rows, ink = "#111", paper = "#fff", red = "#e0203a" } = o
	const TAU = Math.PI * 2
	// a cell's centre and half its side, in pixels
	function place(cell: number) {
		const side = Math.min(canvas.width / columns, canvas.height / rows)
		const left = (canvas.width - side * columns) / 2
		const top = (canvas.height - side * rows) / 2
		const half = side / 2
		return {
			x: left + (cell % columns) * side + half,
			y: top + Math.floor(cell / columns) * side + half,
			half,
		}
	}
	// the cell's clip space as the transform, a little inside its square
	function into(cell: number) {
		const { x, y, half } = place(cell)
		const h = half * 0.82
		ctx.setTransform(h, 0, 0, -h, x, y)
	}
	function clear(cell: number) {
		const { x, y, half } = place(cell)
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.fillStyle = paper
		ctx.fillRect(x - half, y - half, half * 2, half * 2)
		ctx.beginPath()
	}
	function words(cell: number, s: string, at: number, size: number) {
		const { x, y, half } = place(cell)
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.fillStyle = red
		ctx.font = `${Math.round(half * size)}px ui-monospace, monospace`
		ctx.textAlign = "center"
		ctx.fillText(s.slice(0, 40), x, y + half * at)
	}
	function draw(cell: number, op: Op) {
		into(cell)
		ctx.strokeStyle = ctx.fillStyle = ink
		switch (op[0]) {
			case "move":
				return ctx.moveTo(op[1], op[2])
			case "line":
				return ctx.lineTo(op[1], op[2])
			case "curve":
				return ctx.quadraticCurveTo(op[1], op[2], op[3], op[4])
			case "arc":
				return ctx.arc(op[1], op[2], op[3], op[4] * TAU, op[5] * TAU, op[5] < op[4])
			case "close":
				return ctx.closePath()
			case "stroke":
				ctx.lineWidth = op[1]
				ctx.lineCap = ctx.lineJoin = "round"
				ctx.stroke()
				return ctx.beginPath()
			case "fill":
				ctx.fill()
				return ctx.beginPath()
			case "text":
				ctx.translate(op[2], op[3])
				ctx.scale(1, -1)
				ctx.font = `${op[4]}px ui-sans-serif, sans-serif`
				return ctx.fillText(op[1], 0, 0)
			case "mark": {
				ctx.beginPath()
				if (op[1] === "error") {
					const { x, y, half } = place(cell)
					ctx.setTransform(1, 0, 0, 1, 0, 0)
					ctx.fillStyle = red + "33"
					ctx.fillRect(x - half, y - half, half * 2, half * 2)
					return words(cell, op[2], 0.8, 0.09)
				}
				return words(cell, `cost ${op[2]}`, 0.92, 0.09)
			}
		}
	}
	const told = new Set<(ms: number) => void>()
	let asked = 0
	const tick = (ms: number) => {
		asked = told.size ? requestAnimationFrame(tick) : 0
		for (const f of [...told]) f(ms)
	}
	return {
		clear,
		draw,
		frames: (f) => {
			const g = (ms: number) => f(ms)
			told.add(g)
			if (!asked) asked = requestAnimationFrame(tick)
			return () => void told.delete(g)
		},
	}
}
