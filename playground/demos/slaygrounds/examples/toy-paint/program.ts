/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// toy-paint: a 12x12 pixel pad. the picture is ONE node (a list of 144 colours). the big pad and
// the little thumbnail are two views of it; change the palette below and save to repaint the page.
// the pad (144 cells) and the thumbnail canvas are drawn by hand, kept across reloads; the
// palette, the buttons and the count are jsx, bound to the ink, mirror and painted nodes
const palette = [
	"#ffffff",
	"#000000",
	"#ff2284",
	"#40dcba",
	"#2269ff",
	"#fff7a8",
	"#ff9a3c",
	"#9b6bff",
]
const N = 12
const css = `
.paint{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:14px;max-width:360px;margin:0 auto;font-family:Jost,system-ui,sans-serif;touch-action:none}
.paint .pad{display:grid;grid-template-columns:repeat(${N},1fr);border:1px solid #000;width:336px;height:336px;user-select:none}
.paint .pad i{border:1px solid #0001;cursor:crosshair}
.paint .pal{display:flex;gap:6px;margin:10px 0}
.paint .pal b{width:28px;height:28px;border:1px solid #000;border-radius:2px;cursor:pointer;box-shadow:1px 1px 0 #000}
.paint .pal b.on{outline:3px solid #ff2284;outline-offset:1px}
.paint .row{display:flex;gap:8px;align-items:center}
.paint small{white-space:nowrap}
.paint canvas{width:48px;height:48px;image-rendering:pixelated;border:1px solid #000;margin-left:auto}
`

export default function program({ open, read, edit, memo, effect, method, send, ref }: API) {
	const blank = () => Array(N * N).fill(palette[0])
	const pixels = open("./pixels", blank())
	const ink = open("./ink", palette[2])
	const mirror = open("./mirror", false)
	const px = () => read(pixels) as string[]
	memo("painted", () => px().filter((c) => c !== palette[0]).length)

	// a paint changes only its cell (and its mirror): one or two items of the list, never the whole
	method("on/paint", (i: number) => {
		const c = read(ink) as string
		const m = read(mirror)
		edit(pixels, (d: string[]) => {
			d[i] = c
			if (m) d[Math.floor(i / N) * N + (N - 1 - (i % N))] = c
		})
	})
	method("on/ink", (c: string) => edit(ink, () => c))
	method("on/mirror", () => edit(mirror, (m: boolean) => !m))
	method("on/clear", () => edit(pixels, blank))
	method("on/surprise", () => {
		const out = blank()
		const c1 = palette[2 + Math.floor(Math.random() * 6)]
		for (let k = 0; k < 40; k++) {
			const i = Math.floor(Math.random() * N * N)
			out[i] = k % 3 ? c1 : palette[1 + (k % 7)]
			out[Math.floor(i / N) * N + (N - 1 - (i % N))] = out[i]
		}
		edit(pixels, () => out)
	})

	// the pad: 144 cells made once, drawn by the effect below (not by jsx: one write repaints them
	// all, and a drag paints cell by cell). a live thing, so a ref: it is there till the process stops
	const pad = read(ref("pad", () => {
		const el = document.createElement("div")
		el.className = "pad"
		return {
			el,
			cells: Array.from({ length: N * N }, () => el.appendChild(document.createElement("i"))),
		}
	})) as { el: HTMLElement; cells: HTMLElement[] }
	// a listener sends to the method, as a click's handler does
	pad.cells.forEach((c, i) => {
		c.onpointerdown = (e) => {
			if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId)
			send("on/paint", i)
		}
		c.onpointerenter = (e) => {
			if (e.buttons === 1) send("on/paint", i)
		}
	})
	const thumb = read(
		ref("thumb", () => Object.assign(document.createElement("canvas"), { width: N, height: N })),
	) as HTMLCanvasElement

	// the pad and the thumbnail are both drawn from the one node
	effect("draw", px, (all: string[]) => {
		pad.cells.forEach((cell, i) => (cell.style.background = all[i]))
		const g = thumb.getContext("2d")!
		all.forEach((col, i) => ((g.fillStyle = col), g.fillRect(i % N, Math.floor(i / N), 1, 1)))
	})

	return (
		<div class="paint">
			<style>{css}</style>
			{pad.el}
			<div class="pal">
				{palette.map((c) => (
					<b
						style={{ background: c }}
						class={bind("ink", (v) => (v === c ? "on" : ""))}
						onClick={handler("on/ink", [c])}
					/>
				))}
			</div>
			<div class="row">
				<button
					style={bind("mirror", (m) => ({ background: m ? "#40dcba" : "#fff" }))}
					onClick={handler("on/mirror")}
				>
					🪞 mirror
				</button>
				<button onClick={handler("on/clear")}>🧽 clear</button>
				<button onClick={handler("on/surprise")}>✨ surprise</button>
				<small>{bind("painted")} px</small>
				{thumb}
			</div>
		</div>
	)
}
