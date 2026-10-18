/// <reference lib="dom" />
// tenfold, on dens: the page's den offers its canvas as surfaces/screen; the engine (a process on
// the den's javascript runner) draws the knobs' letters on it each frame, each a run on the
// runner it offers. pick a cell on the canvas: its letter's source to edit (drawn again as you
// type), which letter it shows, and its q r x y. under them, what the cell's node says: its
// letter and cost, or what it threw
import { createTenfold, VIEW } from "@ermine/tenfold"
import { createCanvasSurface } from "@ermine/tenfold/canvas"
import { STATUS } from "@ermine/places/status"

const COLUMNS = 3, ROWS = 2
const canvas = document.querySelector<HTMLCanvasElement>("#screen")!
const source = document.querySelector<HTMLTextAreaElement>("#source")!
const letter = document.querySelector<HTMLSelectElement>("#letter")!
const said = document.querySelector<HTMLDivElement>("#said")!
const knobs = ["q", "r", "x", "y"] as const

function fit() {
	const r = canvas.getBoundingClientRect()
	canvas.width = r.width * devicePixelRatio
	canvas.height = r.height * devicePixelRatio
}
fit()
addEventListener("resize", fit)

const t = createTenfold({
	surface: createCanvasSurface(canvas, { columns: COLUMNS, rows: ROWS }),
	kind: "canvas",
	size: [canvas.width, canvas.height],
})
t.start()
// the den runs what it started at a pulse; after that, each frame's write asks for one
t.pulse()

const letters = () =>
	Object.keys(t.table.get("children", "tenfold/letters")?.value ?? {})
		.flatMap((l) =>
			Object.keys(t.table.get("children", `tenfold/letters/${l}`)?.value ?? {}).map((v) =>
				`${l}/${v}`
			)
		)
const sourceOf = (path: string) => t.table.get("value", `tenfold/letters/${path}`)?.value as string

let picked = 0
function pick(cell: number) {
	picked = cell
	const knob = t.knobs().cells[cell]
	letter.replaceChildren(...letters().map((l) => new Option(l, l, false, l === knob.letter)))
	source.value = sourceOf(knob.letter) ?? ""
	for (const k of knobs) {
		const input = document.querySelector<HTMLInputElement>(`#${k}`)!
		input.value = String(knob[k] ?? 0)
		input.nextElementSibling!.textContent = input.value
	}
}

canvas.addEventListener("click", (e) => {
	const r = canvas.getBoundingClientRect()
	const side = Math.min(r.width / COLUMNS, r.height / ROWS)
	const col = Math.floor((e.clientX - r.left - (r.width - side * COLUMNS) / 2) / side)
	const row = Math.floor((e.clientY - r.top - (r.height - side * ROWS) / 2) / side)
	if (col >= 0 && col < COLUMNS && row >= 0 && row < ROWS) pick(row * COLUMNS + col)
})
source.addEventListener("input", () => t.write(t.knobs().cells[picked].letter, source.value))
letter.addEventListener("change", () => {
	t.knob(picked, { letter: letter.value })
	pick(picked)
})
for (const k of knobs) {
	const input = document.querySelector<HTMLInputElement>(`#${k}`)!
	input.addEventListener("input", () => {
		input.nextElementSibling!.textContent = input.value
		t.knob(picked, { [k]: Number(input.value) })
	})
}

// what the picked cell's node says, as an inspector would read it
setInterval(() => {
	const id = t.idAt([...VIEW, "cells", String(picked)])
	if (id === undefined) return
	const st = t.table.get("attributes", id)?.value?.[STATUS]
	const v = t.table.get("value", id)?.value as { letter: string; cost: number } | undefined
	said.textContent = `cell ${picked}: ${v?.letter ?? "…"}, ${v?.cost.toFixed(2) ?? "?"} ms` +
		(st instanceof Error ? `\nthrew: ${st.message}` : "")
}, 250)

pick(0)
