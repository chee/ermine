// surfaces: what the engine draws on, as a den offers it (surfaces/<name>, its value this). a
// surface is cells, each its own clip space (letter.ts' Op), and a frame clock:
//
//   clear(cell)        what the cell showed gone; its next ops start a new picture
//   draw(cell, op)     one op on it
//   frames(f)          f(ms) each frame from now; gives back its stop
//
// a recording (tests, no canvas): each cell's ops since its last clear, frames by hand. a canvas:
// canvas.ts
import type { Op } from "./letter.ts"

export type Surface = {
	readonly clear: (cell: number) => void
	readonly draw: (cell: number, op: Op) => void
	readonly frames: (f: (ms: number) => void) => () => void
}

export type Recording = {
	readonly surface: Surface
	// by cell: its ops since its last clear
	readonly cells: Op[][]
	// a frame at ms, to each listening
	readonly frame: (ms: number) => void
	readonly listening: () => number
}

export function createRecording(): Recording {
	const cells: Op[][] = []
	const told = new Set<(ms: number) => void>()
	return {
		surface: {
			clear: (cell) => void (cells[cell] = []),
			draw: (cell, op) => void (cells[cell] ??= []).push(op),
			frames: (f) => {
				const g = (ms: number) => f(ms)
				told.add(g)
				return () => void told.delete(g)
			},
		},
		cells,
		frame: (ms) => {
			for (const f of [...told]) f(ms)
		},
		listening: () => told.size,
	}
}
