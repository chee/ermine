/// <reference lib="dom" />
// the things' little pictures, 12 by 9 (the kit's letters: K ink, W white, P cherry, Y yellow,
// S grey; G green, B blue, p and q pinks)
import { COLOURS, pixels } from "./kit/sprites.ts"

export const PICTURES: Record<string, string[]> = {
	button: [
		"............",
		"....PPPP....",
		"..PPPPPPPP..",
		".PPWWPPPPPP.",
		".PPPPPPPPPP.",
		"..PPPPPPPP..",
		"KKKKKKKKKKKK",
		"KSSSSSSSSSSK",
		"KKKKKKKKKKKK",
	],
	counter: [
		"KKKKKKKKKKKK",
		"KWWWWWWWWWWK",
		"KWWWKWWKKWWK",
		"KWWKKWWWWKWK",
		"KWWWKWWWKWWK",
		"KWWWKWWKWWWK",
		"KWWKKKWKKKWK",
		"KWWWWWWWWWWK",
		"KKKKKKKKKKKK",
	],
	screen: [
		"KKKKKKKKKKKK",
		"KKKKKKKKKKKK",
		"KKYYYYKKKKKK",
		"KKKKKKKKKKKK",
		"KKYYYYYYYKKK",
		"KKKKKKKKKKKK",
		"KKKKKKKKKKKK",
		".....SS.....",
		"...SSSSSS...",
	],
	timer: [
		"...KKKKKK...",
		"..KWWWWWWK..",
		".KWWWWKWWWK.",
		".KWWWWKWWWK.",
		".KWWWWKPPWK.",
		".KWWWWWWWWK.",
		".KWWWWWWWWK.",
		"..KWWWWWWK..",
		"...KKKKKK...",
	],
	sound: [
		"......K.....",
		".....KK..P..",
		"KKKKKWK...P.",
		"KWWWWWK.P..P",
		"KWWWWWK..P.P",
		"KWWWWWK.P..P",
		"KKKKKWK...P.",
		".....KK..P..",
		"......K.....",
	],
	pad: [
		"KKKKKKKKKKKK",
		"KWWWWWWWWWWK",
		"KWKKWWWWWWWK",
		"KWWKKWWWKWWK",
		"KWWWKKWKKWWK",
		"KWWWWKKKWWPK",
		"KWWWWWWWWPPK",
		"KWWWWWWWWWWK",
		"KKKKKKKKKKKK",
	],
	chart: [
		"K...........",
		"K.........P.",
		"K........P..",
		"K....P..P...",
		"K...P.PP....",
		"K..P........",
		"K.P.........",
		"KP..........",
		"KKKKKKKKKKKK",
	],
	// the cardputer's parts
	keys: [
		"............",
		"KKKKKKKKKKKK",
		"KWSWSWSWSWSK",
		"KSSSSSSSSSSK",
		"KSWSWSWSWSWK",
		"KSSSSSSSSSSK",
		"KSSWWWWWWSSK",
		"KKKKKKKKKKKK",
		"............",
	],
	pigs: [
		".KK......KK.",
		"KpqK....KqpK",
		"KppKKKKKKppK",
		"KppppppppppK",
		"KpKppppppKpK",
		"KpppqqqqpppK",
		"KpppqKKqpppK",
		".KppqqqqppK.",
		"..KKKKKKKK..",
	],
	// a ball on a slope
	tilt: [
		"............",
		"............",
		"..........KK",
		"..KK....KKSK",
		".KPPK.KKSSSK",
		".KPPKKSSSSSK",
		"..KKSSSSSSSK",
		"KKSSSSSSSSSK",
		"KKKKKKKKKKKK",
	],
	// a level meter
	loudness: [
		"............",
		".........PP.",
		".........PP.",
		"......YY.PP.",
		"......YY.PP.",
		"...GG.YY.PP.",
		"...GG.YY.PP.",
		"GG.GG.YY.PP.",
		"GG.GG.YY.PP.",
	],
	led: [
		"....KKKK....",
		".Y.KPPPWK.Y.",
		"...KPPPPK...",
		"Y..KPPPPK..Y",
		"..KKKKKKKK..",
		"....S..S....",
		"....S..S....",
		"....S..S....",
		"....S.......",
	],
	// a remote, sending
	ir: [
		".KKK......P.",
		"KPPPK..P...P",
		"KSSSK...P..P",
		"KWSWK...P..P",
		"KSSSK...P..P",
		"KWSWK..P...P",
		"KSSSK.....P.",
		"KSSSK.......",
		".KKK........",
	],
	battery: [
		"............",
		"KKKKKKKKKKK.",
		"KGGGGGGWWWK.",
		"KGGGGGGWWWKK",
		"KGGGGGGWWWKK",
		"KGGGGGGWWWKK",
		"KGGGGGGWWWK.",
		"KKKKKKKKKKK.",
		"............",
	],
	// a microSD card
	sd: [
		"..KKKKKKK...",
		"..KYKYKYKK..",
		"..KYKYKYWWK.",
		"..KWWWWWWWK.",
		"..KSSSSSSSK.",
		"..KSWWWWWSK.",
		"..KSSSSSSSK.",
		"..KWWWWWWWK.",
		"..KKKKKKKKK.",
	],
	// a Grove plug, its four wires
	grove: [
		".KKKKKKKKKK.",
		".KWWWWWWWWK.",
		".KWSWSWSWSK.",
		".KWWWWWWWWK.",
		".KKKKKKKKKK.",
		"..K.P.S.Y...",
		"..K.P.S.Y...",
		"...K.P.S.Y..",
		"...K.P.S.Y..",
	],
}
// a den's speaker: a sound's
PICTURES.speaker = PICTURES.sound

const CHIP = [
	"..S.S.S.S...",
	".KKKKKKKKK..",
	"SKWWWWWWWKS.",
	".KWYYWWWWK..",
	"SKWYYWWWWKS.",
	".KWWWWWWWK..",
	"SKWWWWWWWKS.",
	".KKKKKKKKK..",
	"..S.S.S.S...",
]

export function picture(name: string, scale = 4): HTMLCanvasElement {
	// a kind with no picture of its own: a chip
	const rows = PICTURES[name] ?? CHIP
	const c = document.createElement("canvas")
	c.width = rows[0].length * scale
	c.height = rows.length * scale
	c.className = "icon"
	pixels(c.getContext("2d")!, rows, 0, 0, scale)
	return c
}

// ---- faces: a board part's picture drawn from its out, live, and a line of words under it ----

// the parts that draw a face (the rest have boxes of their own, or none)
export const FACES = new Set(["led", "tilt", "loudness", "battery", "ir", "sd", "grove"])

// a face: its rows (the kit's letters, and C: the colour given), dimmed when its value isn't
// there, and the line under it
export type Face = { rows: string[]; colour?: string; dim: boolean; line: string }

const isList = (v: unknown): v is unknown[] => Array.isArray(v)
const isMapped = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// a picture of the kind, dimmed, and why: words the part gave (it didn't start: "not on the Mac"),
// else waiting
const waiting = (kind: string, v: unknown): Face => ({
	rows: PICTURES[kind] ?? CHIP,
	dim: true,
	line: typeof v === "string" && v ? v : "waiting for the board",
})

// the slope at x (-10 to 10, the board leaning): its edge's row in each column, and the ball on it,
// rolled toward the low side
function slope(x: number): string[] {
	const k = Math.max(-10, Math.min(10, x)) / 10
	const edge = Array.from(
		{ length: 12 },
		(_, i) => Math.max(3, Math.min(7, Math.round(5 + (i - 5.5) * k * 0.6))),
	)
	const rows = Array.from({ length: 9 }, () => Array(12).fill("."))
	for (let i = 0; i < 12; i++) {
		rows[edge[i]][i] = "K"
		for (let j = edge[i] + 1; j < 8; j++) rows[j][i] = "S"
		rows[8][i] = "K"
	}
	const c = Math.max(1, Math.min(9, Math.round(5 - k * 4)))
	const top = Math.min(edge[c], edge[c + 1]) - 2
	for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) rows[top + dy][c + dx] = "P"
	for (const [dx, dy] of [[0, -1], [1, -1], [-1, 0], [2, 0], [-1, 1], [2, 1]]) {
		const r = rows[top + dy], i = c + dx
		if (r && i >= 0 && i < 12 && r[i] === ".") r[i] = "K"
	}
	return rows.map((r) => r.join(""))
}

export function face(kind: string, v: unknown, beam = false): Face | undefined {
	const n = typeof v === "number" ? v : undefined
	if (kind === "led") {
		// "#rrggbb" set; null: nothing set yet (off); other words: not a colour, or it didn't start
		const lit = typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) &&
			v.toLowerCase() !== "#000000"
		if (typeof v === "string" && !/^#[0-9a-f]{6}$/i.test(v)) return waiting(kind, v)
		if (v === undefined) return waiting(kind, v)
		const rows = PICTURES.led.map((r) => r.replace(/[PW]/g, "C").replace(/Y/g, lit ? "C" : "."))
		return {
			rows,
			colour: lit ? v as string : "#333",
			dim: false,
			line: lit ? v as string : "off",
		}
	}
	if (kind === "tilt") {
		if (!isMapped(v) || typeof v.x !== "number") return waiting(kind, v)
		return { rows: slope(v.x), dim: false, line: `x ${v.x} · y ${v.y ?? 0}` }
	}
	if (kind === "loudness") {
		if (n === undefined) return waiting(kind, v)
		const lit = Math.round(Math.max(0, Math.min(10, n)) * 4 / 10)
		const bars = ["GG", "GG", "YY", "PP"]
		const rows = PICTURES.loudness.map((r) => {
			let s = ""
			for (let b = 0; b < 4; b++) {
				const cell = r.slice(b * 3, b * 3 + 2)
				s += (cell === ".." ? ".." : b < lit ? bars[b] : "ss") + (b < 3 ? "." : "")
			}
			return s + "."
		})
		return { rows, dim: false, line: `${n} of 10` }
	}
	if (kind === "battery") {
		if (n === undefined) return waiting(kind, v)
		const full = Math.round(Math.max(0, Math.min(100, n)) * 9 / 100)
		const ink = n < 20 ? "P" : "G"
		const rows = PICTURES.battery.map((r, j) =>
			j >= 2 && j <= 6
				? "K" + Array.from({ length: 9 }, (_, i) => i < full ? ink : "W").join("") + r.slice(10)
				: r
		)
		return { rows, dim: false, line: `${n}%` }
	}
	if (kind === "ir") {
		// { code, n } sent; null: nothing yet; words: not a code, or it didn't start
		if (v === null) {
			return {
				rows: PICTURES.ir.map((r) => r.slice(0, 5) + "......."),
				dim: false,
				line: "nothing sent yet",
			}
		}
		if (!isMapped(v) || typeof v.code !== "string") return waiting(kind, v)
		const rows = PICTURES.ir.map((r) => beam ? r : r.slice(0, 5) + ".......")
		return { rows, dim: false, line: v.code }
	}
	if (kind === "sd") {
		if (!isList(v)) return waiting(kind, v)
		return {
			rows: PICTURES.sd,
			dim: false,
			line: v.length
				? `mounted · ${v.length} name${v.length === 1 ? "" : "s"}`
				: "mounted, empty",
		}
	}
	if (kind === "grove") {
		if (!isList(v)) return waiting(kind, v)
		// nothing on it: its wires grey
		const rows = v.length
			? PICTURES.grove
			: PICTURES.grove.map((r, j) => j > 4 ? r.replace(/[KPY]/g, "S") : r)
		return { rows, dim: false, line: v.length ? v.map(String).join(" ") : "nothing plugged in" }
	}
	return undefined
}

// a face onto its canvas, scale pixels a letter
export function drawFace(c: HTMLCanvasElement, f: Face, scale = 5) {
	c.width = 12 * scale
	c.height = 9 * scale
	const ctx = c.getContext("2d")!
	ctx.clearRect(0, 0, c.width, c.height)
	for (let j = 0; j < f.rows.length; j++) {
		for (let i = 0; i < f.rows[j].length; i++) {
			const ch = f.rows[j][i]
			if (ch === ".") continue
			ctx.fillStyle = ch === "C" ? f.colour ?? "#333" : COLOURS[ch]
			ctx.fillRect(i * scale, j * scale, scale, scale)
		}
	}
	c.classList.toggle("dim", f.dim)
}
