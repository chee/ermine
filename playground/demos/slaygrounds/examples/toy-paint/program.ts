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
} from "@ermine/system"
import { bind, handler } from "@ermine/render/h"

// toy-paint: a 12x12 pixel pad. the picture is ONE node (a list of 144 colours). the big pad and
// the little thumbnail are two views of it; change the palette below and save to repaint the page.
// the pad (144 cells, jsx whose pointer handlers call on/paint) and the thumbnail canvas are drawn
// by an effect; the
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

export default function program() {
	const blank = () => Array(N * N).fill(palette[0])
	const pixels = ensureNode("./pixels", blank())
	const ink = ensureNode("./ink", palette[2])
	const mirror = ensureNode("./mirror", false)
	const px = () => read(pixels) as string[]
	const now = <T,>(x: unknown) => peep(() => read(x as never)) as T
	const put = (x: unknown, value: unknown) => patch(x as never, [{ path: [], value }])
	createMemo("painted", () => px().filter((c) => c !== palette[0]).length)

	// a paint changes only its cell (and its mirror): one or two patches, never the whole list
	createAction("on/paint", (i: number) => {
		const c = now<string>(ink)
		const patches = [{ path: [i], value: c }]
		if (now(mirror)) patches.push({ path: [Math.floor(i / N) * N + (N - 1 - (i % N))], value: c })
		patch(pixels, patches)
	})
	createAction("on/ink", (c: string) => put(ink, c))
	createAction("on/mirror", () => put(mirror, !now<boolean>(mirror)))
	createAction("on/clear", () => put(pixels, blank()))
	createAction("on/surprise", () => {
		const out = blank()
		const c1 = palette[2 + Math.floor(Math.random() * 6)]
		for (let k = 0; k < 40; k++) {
			const i = Math.floor(Math.random() * N * N)
			out[i] = k % 3 ? c1 : palette[1 + (k % 7)]
			out[Math.floor(i / N) * N + (N - 1 - (i % N))] = out[i]
		}
		put(pixels, out)
	})

	// the pad: 144 cells, drawn by the effect below (not bound one by one: one write repaints them
	// all, and a drag paints cell by cell). a press, or the pointer entering with the button down,
	// is the cell's handler: a listener of the program's own would have no call open to paint with
	const cells: HTMLElement[] = []
	const pad = (
		<div class="pad">
			{Array.from({ length: N * N }, (_, i) => (
				<i
					key={String(i)}
					ref={(e) => (cells[i] = e as HTMLElement)}
					onPointerDown={handler("on/paint", (e: PointerEvent) => {
						const c = e.currentTarget as HTMLElement
						if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId)
						return [i]
					})}
					onPointerEnter={handler("on/paint", (e: PointerEvent) =>
						e.buttons === 1 ? [i] : undefined)}
				/>
			))}
		</div>
	)
	// a live thing, so a ref: it is there till the process stops
	const thumb = read(
		ref("thumb", () => Object.assign(document.createElement("canvas"), { width: N, height: N })),
	) as HTMLCanvasElement

	// the pad and the thumbnail are both drawn from the one node
	createEffect("draw", px, (all: string[]) => {
		cells.forEach((cell, i) => (cell.style.background = all[i]))
		const g = thumb.getContext("2d")!
		all.forEach((col, i) => ((g.fillStyle = col), g.fillRect(i % N, Math.floor(i / N), 1, 1)))
	})

	return (
		<div class="paint">
			<style>{css}</style>
			{pad}
			<div class="pal">
				{palette.map((c) => (
					<b
						style={{ background: c }}
						class={bind("./ink", (v) => (v === c ? "on" : ""))}
						onClick={handler("on/ink", [c])}
					/>
				))}
			</div>
			<div class="row">
				<button
					style={bind("./mirror", (m) => ({ background: m ? "#40dcba" : "#fff" }))}
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
