// letter: what a letter is handed, and how one is loaded. a letter is the body of a draw: source,
// run each frame with the pen's names in scope and the params { q, r, x, y, t, s }:
//
//   width(0.1)
//   move(-0.5, -0.5)
//   line(0.5, 0.5 * sine(t))      // a path, stroked at the end unless filled or stroked before
//
// the pen draws in the cell's clip space: -1 to 1 each way, y up, angles in turns. it gives the
// surface ops (Op) with every point already through its transform; what is left open at the end is
// stroked. the pen's names:
//   move(x, y) line(x, y) curve(cx, cy, x, y) arc(x, y, r, from?, to?) (to below from: clockwise)
//   circle(x, y, r) rect(x, y, w, h) close() stroke() fill() width(w) text(s, x, y, size?)
//   turn(n) grow(n) shift(x, y) push() pop()     the transform, kept until the draw ends
//   TAU sine(n) cosine(n) wrap(v, m?) mix(a, b, t) clamp(v, lo?, hi?)     n in turns
// params: q r x y the cell's knobs (none: 0), t 0 to 1 over the engine's period, s an object kept
// across frames for this letter. a param can be shadowed (`const x = ...`) and assigned
//
// load(code, budget?): code already through budget.ts; its TICK and EACH this load's, counting
// down from budget each draw: past it, a BudgetError thrown. a draw throws as the letter does; a
// syntax error is thrown by load. the code runs in the page's realm (new Function): a letter can
// reach anything the page can
import { EACH, TICK } from "./budget.ts"

export const BUDGET = 5000

// an op, as a surface is given it: points in the cell's clip space
export type Op =
	| readonly ["move", number, number]
	| readonly ["line", number, number]
	| readonly ["curve", number, number, number, number]
	| readonly ["arc", number, number, number, number, number]
	| readonly ["close"]
	| readonly ["stroke", number]
	| readonly ["fill"]
	| readonly ["text", string, number, number, number]
	// the engine's, over a letter: it threw (what), or it cost too much (how much)
	| readonly ["mark", "error" | "cost", string]

export type Params = {
	readonly q: number
	readonly r: number
	readonly x: number
	readonly y: number
	readonly t: number
	readonly s: Record<string, unknown>
}

type Fn = (...n: number[]) => void
export type Pen =
	& {
		readonly [
			name in
				| "move"
				| "line"
				| "curve"
				| "arc"
				| "circle"
				| "rect"
				| "close"
				| "stroke"
				| "fill"
				| "width"
				| "turn"
				| "grow"
				| "shift"
				| "push"
				| "pop"
		]: Fn
	}
	& {
		readonly text: (s: unknown, x: number, y: number, size?: number) => void
		readonly TAU: number
		readonly sine: (n: number) => number
		readonly cosine: (n: number) => number
		readonly wrap: (v: number, n?: number) => number
		readonly mix: (a: number, b: number, t: number) => number
		readonly clamp: (v: number, lo?: number, hi?: number) => number
	}

// a letter loaded: its draw, and its stop (nothing held yet)
export type Loaded = {
	readonly draw: (pen: Pen, params: Params) => void
	readonly stop: (reason?: unknown) => void
}

export class BudgetError extends Error {
	constructor(readonly budget: number) {
		super(`loop budget (${budget}) spent`)
		this.name = "BudgetError"
	}
}

const TAU = Math.PI * 2

// [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const times = (m: Matrix, n: Matrix): Matrix => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5],
]

// a pen giving ops to emit. begin: a draw starting (the transform back to none, the path empty);
// end: the path left open stroked
export function createPen(
	emit: (op: Op) => void,
): { pen: Pen; begin: () => void; end: () => void } {
	let m: Matrix = IDENTITY
	let saved: Matrix[] = []
	let w = 0.05
	let open = false
	const p = (x: number, y: number): [number, number] => [
		m[0] * x + m[2] * y + m[4],
		m[1] * x + m[3] * y + m[5],
	]
	const scale = () => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
	const angle = () => Math.atan2(m[1], m[0]) / TAU
	const path = (op: Op) => {
		open = true
		emit(op)
	}
	const pen: Pen = {
		move: (x: number, y: number) => path(["move", ...p(x, y)]),
		line: (x: number, y: number) => path(["line", ...p(x, y)]),
		curve: (cx: number, cy: number, x: number, y: number) =>
			path(["curve", ...p(cx, cy), ...p(x, y)]),
		arc: (x: number, y: number, r: number, from = 0, to = 1) =>
			path(["arc", ...p(x, y), r * scale(), from + angle(), to + angle()]),
		circle: (x: number, y: number, r: number) => {
			pen.move(x + r, y)
			pen.arc(x, y, r, 0, 1)
		},
		rect: (x: number, y: number, w: number, h: number) => {
			pen.move(x, y)
			pen.line(x + w, y)
			pen.line(x + w, y + h)
			pen.line(x, y + h)
			pen.close()
		},
		close: () => path(["close"]),
		stroke: () => {
			open = false
			emit(["stroke", w * scale()])
		},
		fill: () => {
			open = false
			emit(["fill"])
		},
		width: (n: number) => void (w = n),
		text: (s: unknown, x: number, y: number, size = 0.3) =>
			emit(["text", String(s), ...p(x, y), size * scale()]),
		turn: (n: number) => {
			const c = Math.cos(n * TAU), s = Math.sin(n * TAU)
			m = times(m, [c, s, -s, c, 0, 0])
		},
		grow: (n: number) => void (m = times(m, [n, 0, 0, n, 0, 0])),
		shift: (x: number, y: number) => void (m = times(m, [1, 0, 0, 1, x, y])),
		push: () => void saved.push(m),
		pop: () => void (m = saved.pop() ?? IDENTITY),
		TAU,
		sine: (n: number) => Math.sin(n * TAU),
		cosine: (n: number) => Math.cos(n * TAU),
		wrap: (v: number, n = 1) => ((v % n) + n) % n,
		mix: (a: number, b: number, t: number) => a + (b - a) * t,
		clamp: (v: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v)),
	}
	return {
		pen,
		begin: () => {
			m = IDENTITY
			saved = []
			w = 0.05
			open = false
		},
		end: () => {
			if (open) pen.stroke()
		},
	}
}

const NAMES = Object.keys(createPen(() => {}).pen)

export function load(code: string, budget = BUDGET): Loaded {
	let left = 0
	const tick = () => {
		if (--left < 0) throw new BudgetError(budget)
		return true
	}
	function* each<T>(xs: Iterable<T>): Generator<T> {
		for (const x of xs) {
			tick()
			yield x
		}
	}
	const f = new Function(
		TICK,
		EACH,
		"pen",
		"params",
		`"use strict"; const { ${NAMES.join(", ")} } = pen; let { q, r, x, y, t, s } = params; ` +
			`return (() => {\n${code}\n})()`,
	)
	return {
		draw: (pen, params) => {
			left = budget
			f(tick, each, pen, params)
		},
		stop: () => {},
	}
}
