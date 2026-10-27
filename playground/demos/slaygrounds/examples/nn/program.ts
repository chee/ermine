/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	hasNode,
	list,
	patch,
	peep,
	PENDING,
	pipe,
	read,
	ref,
	unplace,
	type Watched,
} from "@ermine/system"
import { host, inspect } from "@ermine/slaygrounds/tools"
import type { Extra } from "./host.ts"
import { bind, handler } from "ermine-h"

// program.ts: a small neural network whose state is the graph. grain "weight": every weight and
// bias is a node (net/L1/n0/w0, net/L1/n0/b), and each neuron's activation is a compute part
// (…/n0/map) that reads its weights and the neurons before it, at every point of a grid over the
// plane and at every data point; …/n0/at is the same at the probe (the pointer). change one weight
// and its neuron reruns, then what comes after it, nothing before (the mint flash). a step is one
// send: it reads the activations the graph computed, backprops, writes every weight and bias; the
// pulse after it is the forward pass. the diagram's views are pipes on the nodes (a write marks
// what to paint), the frame paints. grain "layer": a layer's weights are one Float32Array node
// (layers/L1/W), its activations one compute. edit this file while it trains: the weights are
// nodes, so they stay (they are under ./, saved: a reload is a stop and a start, and finds them)
// the host (host.ts) keeps the clock, because it times what it runs (stats, the pulse after each
// step): each frame it runs on/step (and a pulse after each, the forward pass the next step
// reads) while playing, then on/frame, which paints. measure is the host's too: it is async, and sets
// the nodes through the actions
const LOOK = `
body { background: #ffff88; margin: 8px; font: 14px Jost, system-ui, sans-serif; color: #000 }
.nn { display: flex; flex-direction: column; gap: 8px; max-width: 660px }
.card { background: #fff; border: 1px solid #000; box-shadow: 0 0 10px 2px #66003322; border-radius: 6px; padding: 6px }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap }
.boards { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start }
button { font: inherit; padding: 2px 10px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
button:active { transform: none; box-shadow: none }
button[aria-pressed=true] { background: #ff2284; color: #fff }
button.pen[aria-pressed=true] { background: #ffff88; outline: 1px solid #000 }
button.small { padding: 0 6px; font-size: 12px; box-shadow: 1px 1px 0 #000 }
select { font: inherit; border: 1px solid #000; border-radius: 2px; background: #fff }
label { display: inline-flex; gap: 4px; align-items: center }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 7px; transform: skew(-8deg); font-size: 13px;
	font-weight: 600; font-variant-numeric: tabular-nums }
.tag b { color: #ff2284 }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 1px solid #000; vertical-align: -1px }
.c1 { background: #ff2284 } .c0 { background: #2269ff }
.plane canvas { display: block; cursor: crosshair; touch-action: none }
.hint { font-size: 12px; color: #000a; margin-top: 4px; width: 256px }
.net { position: relative }
.net > .layer { position: relative }
.net > .heads { position: absolute; left: 0; top: 0; right: 0; bottom: 0 }
.net > .heads { pointer-events: none }
.net > .heads > * { pointer-events: auto }
.netcard { width: 350px }
.net svg { position: absolute; left: 0; top: 0; overflow: visible }
.edge { fill: none; stroke-linecap: round }
.hit { fill: none; stroke: transparent; stroke-width: 9; cursor: pointer; pointer-events: stroke }
.hit:hover { stroke: #0003 }
.hit.picked { stroke: #000; stroke-opacity: 0.3; stroke-dasharray: 3 3 }
.neuron { position: absolute; width: 28px; height: 28px; border: 1px solid #000; background: #fff; cursor: pointer; box-sizing: border-box }
.neuron canvas { width: 100%; height: 100%; display: block }
.neuron .ring { position: absolute; inset: -5px; border: 3px solid transparent; border-radius: 3px; pointer-events: none }
.neuron.picked { outline: 1px dashed #000; outline-offset: 9px }
.head { position: absolute; top: 0; font-size: 12px; display: flex; gap: 3px; align-items: center; white-space: nowrap; transform: translateX(-50%) }
.side { position: absolute; font-size: 12px; font-weight: 600 }
.weight { border-top: 1px solid #000; margin-top: 6px; padding-top: 6px; font-size: 13px; min-height: 44px }
.weight .what { display: block; font-weight: 600 }
.weight input[type=range] { accent-color: #ff2284; width: 150px }
.weight output { font-variant-numeric: tabular-nums; min-width: 4em; display: inline-block }
.ran { font-size: 12px; color: #000a; margin-top: 2px }
.curve canvas { display: block; width: 100%; height: 72px }
table { border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums }
td, th { border: 1px solid #000; padding: 1px 6px; text-align: right }
th { background: #ffff88; font-weight: 600 }
td:first-child, td:nth-child(2) { text-align: left }
`
const G = 32 // the grid: the boundary is the output at G×G points of the plane
const SPAN = 2 // the plane is [-SPAN, SPAN]²
const OFF = G * G // in a map, the data points come after the grid
const SIZE = 256 // the plane's canvas, px
const MAX = { layers: 5, neurons: 8 }
// activation: [f(z), f'(z) told by f(z)]
const ACTS: Record<string, [(z: number) => number, (a: number) => number]> = {
	tanh: [Math.tanh, (a) => 1 - a * a],
	relu: [(z) => (z > 0 ? z : 0), (a) => (a > 0 ? 1 : 0)],
	sigmoid: [(z) => 1 / (1 + Math.exp(-z)), (a) => a * (1 - a)],
	linear: [(z) => z, () => 1],
}
const sigmoid = ACTS.sigmoid[0]
const CONFIGS: [string, string][] = [
	["weight", "each"],
	["weight", "bulk"],
	["layer", "each"],
	["layer", "whole"],
	["layer", "bulk"],
]

// ---- datasets: [x, y, label], label 1 (cherry) or 0 (blue) ----
const r2 = (v: number) => Math.round(v * 100) / 100
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const normal = () =>
	Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(6.2832 * Math.random())
const DATA: Record<string, () => number[][]> = {
	xor: () =>
		Array.from({ length: 200 }, () => {
			const x = (Math.random() < 0.5 ? -1 : 1) * rand(0.12, 1.95)
			const y = (Math.random() < 0.5 ? -1 : 1) * rand(0.12, 1.95)
			return [r2(x), r2(y), x * y > 0 ? 1 : 0]
		}),
	circle: () =>
		Array.from({ length: 200 }, (_, i) => {
			const r = i < 100 ? rand(0, 0.85) : rand(1.3, 1.9), a = rand(0, 6.2832)
			return [r2(r * Math.sin(a)), r2(r * Math.cos(a)), i < 100 ? 1 : 0]
		}),
	gauss: () =>
		Array.from({ length: 200 }, (_, i) => {
			const c = i < 100 ? 0.9 : -0.9
			return [r2(c + normal() * 0.45), r2(c + normal() * 0.45), i < 100 ? 1 : 0]
		}),
	spiral: () =>
		Array.from({ length: 200 }, (_, i) => {
			const k = i < 100 ? 0 : 1, u = (i % 100) / 100
			const r = u * 1.9, a = 1.75 * u * 6.2832 + k * Math.PI
			return [r2(r * Math.sin(a) + normal() * 0.04), r2(r * Math.cos(a) + normal() * 0.04), k]
		}),
}
// the grid's points: G×G cell centres, row 0 at the top (y up)
const GX = new Float32Array(OFF), GY = new Float32Array(OFF)
for (let g = 0; g < OFF; g++) {
	GX[g] = -SPAN + ((g % G) + 0.5) * (2 * SPAN) / G
	GY[g] = SPAN - (((g / G) | 0) + 0.5) * (2 * SPAN) / G
}

// ---- colour: v in [-1, 1], cherry above 0, blue below, white at 0 ----
const TONES = Array.from({ length: 256 }, (_, k) => {
	const v = (k / 255) * 2 - 1, a = Math.min(1, Math.abs(v)) ** 0.9 * 0.85
	const c = v >= 0 ? [255, 34, 132] : [34, 105, 255]
	return c.map((x) => Math.round(255 + (x - 255) * a))
})
const tone = (v: number) => TONES[Math.max(0, Math.min(255, Math.round((v + 1) * 127.5))) | 0]
const css = (v: number) => `rgb(${tone(v).join(",")})`

// weights as plain arrays: W[l-1] is layer l's (rows: its neurons, columns: the ones before), B its biases
type Params = { W: Float64Array[]; B: Float64Array[] }
// what the rebuild made: the nodes of one grain, read and written the same way
type Entry = ReturnType<typeof ensureNode>
type Net = {
	grain: string
	sizes: number[]
	read: () => Params
	write: (P: Params, how: string) => void
	get: (l: number, j: number, i: number) => number // i < 0: the bias
	set: (l: number, j: number, i: number, v: number) => void
	act: (l: number, j: number) => Float32Array // neuron j of layer l over the grid, then the data
	address: (l: number, j: number, i: number) => string[]
	computes: number
	out: Entry // the output's map
	pipes: (thumbs: Thumb[][], edges: Edge[][][]) => void // the pipes that feed the diagram
}
type Thumb = {
	el: HTMLDivElement
	ring: HTMLDivElement
	g: CanvasRenderingContext2D
	img: ImageData
	map?: () => Float32Array | undefined
	dirty: boolean
	at?: () => number | undefined
	atDirty: boolean
	flashed: number
}
type Edge = { path: SVGPathElement; hit: SVGPathElement; w: () => number; dirty: boolean }

// the sizes a hidden list gives: 2 in, the hidden ones (kept to what fits), 1 out
const sizesOf = (hidden: number[]) => [
	2,
	...hidden.map((n) => Math.max(1, Math.min(MAX.neurons, n | 0))).slice(0, MAX.layers),
	1,
]
// the diagram's measures: its width, a neuron, the head's row, the columns' x and each one's ys
const DW = 350, S = 28, TOP = 30
function geometry(sizes: number[]) {
	const L = sizes.length - 1
	const DH = Math.max(276, TOP + 12 + 36 * Math.max(...sizes))
	const xs = sizes.map((_, c) => 18 + (c * (DW - 36 - S)) / L)
	const ys = sizes.map((n) => {
		const gap = Math.min(40, (DH - TOP - 8) / n)
		return Array.from(
			{ length: n },
			(_, j) => TOP + (DH - TOP) / 2 + (j - (n - 1) / 2) * gap - S / 2,
		)
	})
	return { L, DH, xs, ys }
}

export default function program() {
	const { bulk } = host<Extra>()
	// a whole value put on a node
	const put = (x: Entry, value: unknown) => patch(x, [{ path: [], value }])
	// a read that is nothing while the node is pending (a memo not run yet) or not there; untracked
	const peek = <T,>(x: Entry | string): T | undefined => {
		try {
			return peep(() => read(x)) as T
		} catch (e) {
			if (e === PENDING) return undefined
			throw e
		}
	}

	// a pipe on x, told as the write lands, named (a name each: two in one run are already-there).
	// the rebuild's start the count again, so its pipes are the same ones each time
	let wired = 0
	const watch = (x: Entry, fn: (w: Watched) => unknown, name = `watch-${wired++}`) =>
		pipe(x, fn, { timing: "write", name })

	// ---- the nodes: ./ is the root, saved: a reload finds them as they were ----
	const data = ensureNode("./data", DATA.xor())
	const hidden = ensureNode("./hidden", [6, 6])
	const rate = ensureNode("./rate", 0.5)
	const activation = ensureNode("./activation", "tanh")
	const grain = ensureNode("./grain", "weight") // weight | layer
	const write = ensureNode("./write", "each") // each | bulk | whole
	const speed = ensureNode("./speed", 0) // steps a frame; 0: as many as fit in 10ms
	const playing = ensureNode("./playing", false)
	const steps = ensureNode("./steps", 0)
	const history = ensureNode("./history", { every: 1, losses: [] as number[] })
	const probe = ensureNode("./probe", [1, 1])
	const pen = ensureNode("./pen", 1)
	const busy = ensureNode("./measuring", false) // measure is running: its button says so
	const speeds = ensureNode("./speeds", [] as Record<string, unknown>[])
	const settings: Record<string, Entry> = { rate, activation, grain, write, speed, pen }

	// what the frame and the handlers' arguments need, kept up by a pipe on each: the controls are
	// bound to the nodes themselves
	const cur = {
		playing: false,
		rate: 0.5,
		activation: "tanh",
		grain: "weight",
		write: "each",
		speed: 0,
		pen: 1,
		hidden: [6, 6],
	}
	for (
		const [k, x] of Object.entries({
			playing,
			rate,
			activation,
			grain,
			write,
			speed,
			pen,
			hidden,
		})
	) {
		;(cur as Record<string, unknown>)[k] = peep(() => read(x))
		watch(
			x,
			(w) => ((cur as Record<string, unknown>)[k] = w.value),
			`cur-${k}`,
		)
	}

	let net: Net | undefined
	// what the forward computes ran since the frame last looked: the flash, and "reran" under the card
	let ranLog: string[] = []
	const ran = (label: string, kind = "") => ranLog.push(kind ? `${label} ${kind}` : label)

	// ---- actions: every write is an action ----
	createAction("on/step", () => step())
	createAction("on/play", (v: boolean) => put(playing, v))
	createAction("on/set", (name: string, v: unknown) => put(settings[name], v))
	createAction(
		"on/weight",
		(l: number, j: number, i: number, v: number) => net?.set(l, j, i, v),
	)
	createAction("on/add", (x: number, y: number, label: number) => {
		const n = (peep(() => read(data)) as number[][]).length
		patch(data, [{ path: [], range: [n, n], value: [[r2(x), r2(y), label]] }])
	})
	createAction("on/data", (name: string) => put(data, name ? DATA[name]() : []))
	createAction("on/reset", () => {
		if (!net) return
		net.write(reshape(undefined, undefined, net.sizes), cur.write)
		put(steps, 0)
		put(history, { every: 1, losses: [] })
	})
	createAction("on/hidden", (h: number[]) => put(hidden, h))
	createAction("on/probe", (p: number[]) => put(probe, p))
	createAction("on/speeds", (rows: Record<string, unknown>[]) => put(speeds, rows))
	createAction("on/measuring", (v: boolean) => put(busy, v))
	// the step with no graph (the host's measure runs it): its row
	createAction("on/plain", () => peep(() => plain()))

	// ---- a step: the activations the graph computed, backprop, every weight and bias written ----
	function step() {
		if (!net) return
		const pts = peek<number[][]>(data) ?? []
		const N = pts.length
		if (!N) return
		const { sizes } = net
		const L = sizes.length - 1
		const P = peep(net.read)
		const df = (ACTS[cur.activation] ?? ACTS.tanh)[1]
		const lr = cur.rate
		// A[l][i]: neuron i of layer l at the data points, read from its map node
		const A = peep(() =>
			sizes.map((n, l) =>
				Array.from({ length: n }, (_, j) => net!.act(l, j).subarray(OFF, OFF + N))
			)
		)
		let d = [new Float64Array(N)]
		let sum = 0
		for (let k = 0; k < N; k++) {
			const o = A[L][0][k], y = pts[k][2]
			d[0][k] = o - y // sigmoid out, cross-entropy loss
			sum -= Math.log(Math.max(1e-7, y ? o : 1 - o))
		}
		for (let l = L; l >= 1; l--) {
			const r = sizes[l], c = sizes[l - 1], W = P.W[l - 1], B = P.B[l - 1], a = A[l - 1]
			const nd = l > 1 ? Array.from({ length: c }, () => new Float64Array(N)) : []
			for (let j = 0; j < r; j++) {
				const dj = d[j]
				let gb = 0
				for (let k = 0; k < N; k++) gb += dj[k]
				for (let i = 0; i < c; i++) {
					const ai = a[i], w = W[j * c + i]
					let g = 0
					for (let k = 0; k < N; k++) g += dj[k] * ai[k]
					if (l > 1) {
						const ni = nd[i]
						for (let k = 0; k < N; k++) ni[k] += w * dj[k]
					}
					W[j * c + i] = w - (lr * g) / N
				}
				B[j] -= (lr * gb) / N
			}
			if (l > 1) {
				for (let i = 0; i < c; i++) {
					for (let k = 0; k < N; k++) nd[i][k] *= df(a[i][k])
				}
				d = nd
			}
		}
		net.write(P, cur.write)
		const n = (peep(() => read(steps)) as number) + 1
		put(steps, n)
		const h = peep(() => read(history)) as { every: number; losses: number[] }
		if (n % h.every === 0) {
			const v = Math.round((sum / N) * 1e4) / 1e4
			if (h.losses.length >= 300) {
				put(history, {
					every: h.every * 2,
					losses: [...h.losses.filter((_, i) => i % 2 === 0), v],
				})
			} else {
				patch(history, [{
					path: ["losses"],
					range: [h.losses.length, h.losses.length],
					value: [v],
				}])
			}
		}
	}

	// ---- weights carried over a rebuild: from either grain's nodes, reshaped to the sizes ----
	function reshape(P: Params | undefined, had: number[] | undefined, sizes: number[]): Params {
		const out: Params = { W: [], B: [] }
		for (let l = 1; l < sizes.length; l++) {
			const r = sizes[l], c = sizes[l - 1]
			const W = new Float64Array(r * c), B = new Float64Array(r)
			const old = had && l < had.length ? { r: had[l], c: had[l - 1] } : undefined
			for (let j = 0; j < r; j++) {
				for (let i = 0; i < c; i++) {
					W[j * c + i] = old && j < old.r && i < old.c
						? P!.W[l - 1][j * old.c + i]
						: r2(normal() * Math.sqrt(1 / c) * 100) / 100
				}
				B[j] = old && j < old.r ? P!.B[l - 1][j] : 0
			}
			out.W.push(W)
			out.B.push(B)
		}
		return out
	}
	function stored(name: string): [Params, number[]] | undefined {
		const had = peek<number[]>(`./${name}`)
		if (!Array.isArray(had)) return
		const P: Params = { W: [], B: [] }
		for (let l = 1; l < had.length; l++) {
			const r = had[l], c = had[l - 1]
			const W = new Float64Array(r * c), B = new Float64Array(r)
			if (name === "net") {
				for (let j = 0; j < r; j++) {
					B[j] = peek<number>(`./net/L${l}/n${j}/b`) ?? 0
					for (let i = 0; i < c; i++) {
						W[j * c + i] = peek<number>(`./net/L${l}/n${j}/w${i}`) ?? 0
					}
				}
			} else {
				const w = peek<Float32Array>(`./${name}/L${l}/W`)
				const b = peek<Float32Array>(`./${name}/L${l}/b`)
				if (w) W.set(w)
				if (b) B.set(b)
			}
			P.W.push(W)
			P.B.push(B)
		}
		return [P, had]
	}
	// a node and all under it taken out (a program unplaces one name at a time)
	function drop(path: string) {
		if (!peep(() => hasNode(path))) return
		for (const name of [...peep(() => list(path))]) drop(`${path}/${name}`)
		unplace(path)
	}
	// names under path past n (by their number), taken out
	function trim(path: string, letter: string, n: number) {
		const re = new RegExp(`^${letter}(\\d+)$`)
		for (const name of [...peep(() => list(path))]) {
			const m = re.exec(name)
			if (m && +m[1] >= n) drop(`${path}/${name}`)
		}
	}
	// the node at the path holding v (made with it, or written to it when it holds something else)
	function holding(path: string, v: number | Float32Array) {
		const e = ensureNode(path, v)
		const was = peek<number | Float32Array>(e)
		const same = typeof v === "number"
			? was === v
			: was instanceof Float32Array && was.length === v.length && was.every((x, k) => x === v[k])
		if (!same) put(e, v)
		return e
	}

	// ---- grain "weight": a node per weight and bias, a map and an at per neuron ----
	function byWeight(sizes: number[], P: Params): Net {
		const L = sizes.length - 1
		const folder = ensureNode("./net", sizes)
		if (JSON.stringify(peek(folder)) !== JSON.stringify(sizes)) put(folder, sizes)
		const w: Entry[][][] = [], b: Entry[][] = [], maps: Entry[][] = [], ats: Entry[][] = []
		for (let l = 0; l <= L; l++) {
			ensureNode(`./net/L${l}`, null)
			w.push([]), b.push([]), maps.push([]), ats.push([])
			for (let j = 0; j < sizes[l]; j++) {
				const at = `./net/L${l}/n${j}`
				ensureNode(at, null)
				const label = `L${l}·n${j}`
				if (l === 0) {
					maps[0].push(createMemo(`${at}/map`, () => {
						const pts = read(data) as number[][]
						const o = new Float32Array(OFF + pts.length)
						o.set(j ? GY : GX)
						for (let k = 0; k < pts.length; k++) o[OFF + k] = pts[k][j]
						ran(label, "map")
						return o
					}))
					ats[0].push(
						createMemo(`${at}/at`, () => (ran(label, "at"), (read(probe) as number[])[j])),
					)
					continue
				}
				const c = sizes[l - 1]
				const bias = holding(`${at}/b`, P.B[l - 1][j])
				const ws = Array.from(
					{ length: c },
					(_, i) => holding(`${at}/w${i}`, P.W[l - 1][j * c + i]),
				)
				b[l].push(bias)
				w[l].push(ws)
				const before = maps[l - 1], beforeAt = ats[l - 1]
				const fn = () => (l === L ? sigmoid : (ACTS[cur.activation] ?? ACTS.tanh)[0])
				maps[l].push(createMemo(`${at}/map`, () => {
					const f = fn(), z0 = read(bias) as number
					const k = ws.map((e) => read(e) as number)
					const ins = before.map((e) => read(e) as Float32Array)
					const len = ins[0].length, o = new Float32Array(len)
					for (let q = 0; q < len; q++) {
						let z = z0
						for (let i = 0; i < c; i++) z += k[i] * ins[i][q]
						o[q] = f(z)
					}
					ran(label, "map")
					return o
				}))
				ats[l].push(createMemo(`${at}/at`, () => {
					let z = read(bias) as number
					for (let i = 0; i < c; i++) {
						z += (read(ws[i]) as number) * (read(beforeAt[i]) as number)
					}
					ran(label, "at")
					return fn()(z)
				}))
			}
			trim(`./net/L${l}`, "n", sizes[l])
			for (let j = 0; l > 0 && j < sizes[l]; j++) {
				trim(`./net/L${l}/n${j}`, "w", sizes[l - 1])
			}
		}
		trim("./net", "L", L + 1)
		const it = (l: number, j: number, i: number) => (i < 0 ? b[l][j] : w[l][j][i])
		return {
			grain: "weight",
			sizes,
			computes: 2 * sizes.reduce((a, n) => a + n, 0),
			read() {
				const P: Params = { W: [], B: [] }
				for (let l = 1; l <= L; l++) {
					const c = sizes[l - 1]
					const W = new Float64Array(sizes[l] * c), B = new Float64Array(sizes[l])
					for (let j = 0; j < sizes[l]; j++) {
						B[j] = read(b[l][j]) as number
						for (let i = 0; i < c; i++) W[j * c + i] = read(w[l][j][i]) as number
					}
					P.W.push(W), P.B.push(B)
				}
				return P
			},
			write(P, how) {
				if (how === "bulk") {
					const puts: [Entry, unknown][] = []
					for (let l = 1; l <= L; l++) {
						const c = sizes[l - 1]
						for (let j = 0; j < sizes[l]; j++) {
							puts.push([b[l][j], P.B[l - 1][j]])
							for (let i = 0; i < c; i++) puts.push([w[l][j][i], P.W[l - 1][j * c + i]])
						}
					}
					bulk(puts)
					return
				}
				for (let l = 1; l <= L; l++) {
					const c = sizes[l - 1]
					for (let j = 0; j < sizes[l]; j++) {
						put(b[l][j], P.B[l - 1][j])
						for (let i = 0; i < c; i++) put(w[l][j][i], P.W[l - 1][j * c + i])
					}
				}
			},
			get: (l, j, i) => read(it(l, j, i)) as number,
			set: (l, j, i, v) => put(it(l, j, i), v),
			act: (l, j) => read(maps[l][j]) as Float32Array,
			address: (l, j, i) => ["net", `L${l}`, `n${j}`, i < 0 ? "b" : `w${i}`],
			out: maps[L][0],
			pipes(thumbs, edges) {
				for (let l = 0; l <= L; l++) {
					for (let j = 0; j < sizes[l]; j++) {
						const th = thumbs[l][j]
						th.map = () => peek<Float32Array>(maps[l][j])
						th.at = () => peek<number>(ats[l][j])
						watch(maps[l][j], () => (th.dirty = true))
						watch(ats[l][j], () => (th.atDirty = true))
						for (let i = 0; l > 0 && i < sizes[l - 1]; i++) {
							const ed = edges[l][j][i]
							ed.w = () => read(w[l][j][i]) as number
							watch(w[l][j][i], () => (ed.dirty = true))
						}
					}
				}
			},
		}
	}

	// a typed array node changed where it differs from what is given: a patch (a range of one) for each element
	function each(x: Entry, to: Float64Array) {
		const now = peep(() => read(x)) as Float32Array
		const patches = []
		for (let k = 0; k < now.length; k++) {
			const v = Math.fround(to[k])
			if (now[k] !== v) {
				patches.push({ path: [], range: [k, k + 1] as const, value: Float32Array.of(v) })
			}
		}
		if (patches.length) patch(x, patches)
	}

	// ---- grain "layer": a layer's weights one Float32Array node (rows: neurons), a map and an at per layer ----
	function byLayer(sizes: number[], P: Params): Net {
		const L = sizes.length - 1
		const folder = ensureNode("./layers", sizes)
		if (JSON.stringify(peek(folder)) !== JSON.stringify(sizes)) put(folder, sizes)
		const W: Entry[] = [], B: Entry[] = [], maps: Entry[] = [], ats: Entry[] = []
		for (let l = 0; l <= L; l++) {
			const at = `./layers/L${l}`
			ensureNode(at, null)
			const label = `L${l}`
			if (l === 0) {
				maps.push(createMemo(`${at}/map`, () => {
					const pts = read(data) as number[][]
					const n = OFF + pts.length, o = new Float32Array(2 * n)
					o.set(GX, 0)
					o.set(GY, n)
					for (let k = 0; k < pts.length; k++) {
						;(o[OFF + k] = pts[k][0]), (o[n + OFF + k] = pts[k][1])
					}
					ran(label, "map")
					return o
				}))
				ats.push(
					createMemo(
						`${at}/at`,
						() => (ran(label, "at"), Float32Array.from(read(probe) as number[])),
					),
				)
				W.push(undefined as unknown as Entry), B.push(undefined as unknown as Entry)
				continue
			}
			const r = sizes[l], c = sizes[l - 1]
			const We = holding(`${at}/W`, Float32Array.from(P.W[l - 1]))
			const Be = holding(`${at}/b`, Float32Array.from(P.B[l - 1]))
			W.push(We), B.push(Be)
			const before = maps[l - 1], beforeAt = ats[l - 1]
			const fn = () => (l === L ? sigmoid : (ACTS[cur.activation] ?? ACTS.tanh)[0])
			maps.push(createMemo(`${at}/map`, () => {
				const f = fn(), w = read(We) as Float32Array, b = read(Be) as Float32Array
				const ins = read(before) as Float32Array, n = ins.length / c
				const o = new Float32Array(r * n)
				for (let j = 0; j < r; j++) {
					for (let q = 0; q < n; q++) {
						let z = b[j]
						for (let i = 0; i < c; i++) z += w[j * c + i] * ins[i * n + q]
						o[j * n + q] = f(z)
					}
				}
				ran(label, "map")
				return o
			}))
			ats.push(createMemo(`${at}/at`, () => {
				const f = fn(), w = read(We) as Float32Array, b = read(Be) as Float32Array
				const ins = read(beforeAt) as Float32Array, o = new Float32Array(r)
				for (let j = 0; j < r; j++) {
					let z = b[j]
					for (let i = 0; i < c; i++) z += w[j * c + i] * ins[i]
					o[j] = f(z)
				}
				ran(label, "at")
				return o
			}))
		}
		trim("./layers", "L", L + 1)
		return {
			grain: "layer",
			sizes,
			computes: 2 * (L + 1),
			read: () => ({
				W: W.slice(1).map((e) => Float64Array.from(read(e) as Float32Array)),
				B: B.slice(1).map((e) => Float64Array.from(read(e) as Float32Array)),
			}),
			write(P, how) {
				if (how === "bulk") {
					const puts: [Entry, unknown][] = []
					for (let l = 1; l <= L; l++) {
						puts.push([W[l], Float32Array.from(P.W[l - 1])])
						puts.push([B[l], Float32Array.from(P.B[l - 1])])
					}
					bulk(puts)
					return
				}
				for (let l = 1; l <= L; l++) {
					if (how === "whole") {
						put(W[l], Float32Array.from(P.W[l - 1]))
						put(B[l], Float32Array.from(P.B[l - 1]))
						continue
					}
					// a patch per element that changed
					each(W[l], P.W[l - 1])
					each(B[l], P.B[l - 1])
				}
			},
			get: (l, j, i) =>
				i < 0
					? (read(B[l]) as Float32Array)[j]
					: (read(W[l]) as Float32Array)[j * sizes[l - 1] + i],
			set: (l, j, i, v) => {
				const k = i < 0 ? j : j * sizes[l - 1] + i
				patch(i < 0 ? B[l] : W[l], [{ path: [], range: [k, k + 1], value: Float32Array.of(v) }])
			},
			act(l, j) {
				const m = read(maps[l]) as Float32Array, n = m.length / sizes[l]
				return m.subarray(j * n, (j + 1) * n)
			},
			address: (l, _j, i) => ["layers", `L${l}`, i < 0 ? "b" : "W"],
			out: maps[L],
			pipes(thumbs, edges) {
				for (let l = 0; l <= L; l++) {
					const n = sizes[l]
					const slice = <T extends Float32Array>(m: T | undefined, j: number) =>
						m && m.subarray(j * (m.length / n), (j + 1) * (m.length / n))
					for (let j = 0; j < n; j++) {
						const th = thumbs[l][j]
						th.map = () => slice(peek<Float32Array>(maps[l]), j)
						th.at = () => peek<Float32Array>(ats[l])?.[j]
					}
					watch(maps[l], () => thumbs[l].forEach((th) => (th.dirty = true)))
					watch(ats[l], () => thumbs[l].forEach((th) => (th.atDirty = true)))
					if (l === 0) continue
					const c = sizes[l - 1]
					for (let j = 0; j < n; j++) {
						for (let i = 0; i < c; i++) {
							edges[l][j][i].w = () => (read(W[l]) as Float32Array)[j * c + i]
						}
					}
					watch(W[l], () => {
						for (const row of edges[l]) for (const ed of row) ed.dirty = true
					})
				}
			},
		}
	}

	// ---- the view: the controls and readouts are jsx, bound to the nodes they show and sending to
	// the methods they write through. the canvases, the network diagram and the picked weight's
	// card are elements the frame draws, placed in the jsx as they are ----
	const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "") => {
		const x = document.createElement(tag)
		if (cls) x.className = cls
		return x
	}
	// a select writing one setting, its value bound to the setting's node
	const choice = (
		name: string,
		options: [string, string][],
		parse: (v: string) => unknown = (v) => v,
	) => (
		<label>
			{name}
			<select
				value={bind(name, String)}
				onChange={handler("on/set", (e) => [name, parse(e.target.value)])}
			>
				{options.map(([v, k]) => <option value={v}>{k}</option>)}
			</select>
		</label>
	)
	// the readouts the frame measures (no node holds them): written straight into their <b>
	const live: Record<string, HTMLElement> = {}
	const setLive = (n: string, v: string) => {
		if (live[n] && live[n].textContent !== v) live[n].textContent = v
	}
	const measured = (n: string) => (
		<span class="tag">
			{n}{" "}
			<b
				ref={(b) => {
					live[n] = b
					if (!b.textContent) b.textContent = "–"
				}}
			/>
		</span>
	)
	// the plane: the output over the grid, the points, the probe. live things, the graph's refs
	const canvas = read(ref(
		"el/canvas",
		() => Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE }),
	)) as HTMLCanvasElement
	const g = canvas.getContext("2d")!
	const off = read(ref(
		"el/off",
		() => Object.assign(document.createElement("canvas"), { width: G, height: G }),
	)) as HTMLCanvasElement
	const og = off.getContext("2d")!
	const offImg = og.createImageData(G, G)
	const toPlane = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		return [
			r2(-SPAN + ((e.clientX - r.left) / r.width) * 2 * SPAN),
			r2(SPAN - ((e.clientY - r.top) / r.height) * 2 * SPAN),
		]
	}

	// the network: an svg of edges under a neuron box each (layer), built by the rebuild below and
	// drawn by the frame: elements. the heads, with the buttons that change the hidden layers, are jsx
	// over it (they run actions: an element's own listener has nothing open), and so is the picked
	// weight's slider
	const layer = el("div", "layer")
	const curve = read(ref("el/curve", () => document.createElement("canvas"))) as HTMLCanvasElement
	const cg = curve.getContext("2d")!

	// ---- what the frame paints: watches mark, the frame draws (a step writes many times a frame) ----
	let look: { thumbs: Thumb[][]; edges: Edge[][][] } | undefined
	const dirty = { plane: true, curve: true, card: true }
	let picked: { l: number; j: number; i: number } | undefined
	let lastRan = ""
	watch(probe, () => (dirty.plane = true), "probe")
	watch(history, () => (dirty.curve = true), "history")
	watch(data, () => (dirty.plane = true), "data")

	// ---- the rebuild: the grain and the sizes make the nodes, the computes and the diagram. what
	// it makes goes when it acts again (its memos, its watches), the weights stay ----
	createEffect("rebuild", () => {
		const h = sizesOf(read(hidden) as number[]).slice(1, -1)
		return `${read(grain)}|${h.join(",")}`
	}, (key: string) => {
		const [g0, h] = key.split("|")
		const sizes = [2, ...(h ? h.split(",").map(Number) : []), 1]
		const name = g0 === "layer" ? "layers" : "net"
		const other = g0 === "layer" ? "net" : "layers"
		wired = 0
		ranLog = [] // a rebuild runs everything: what reran is counted from here
		const [P, had] = stored(name) ?? stored(other) ?? [undefined, undefined]
		const weights = reshape(P, had, sizes)
		net = g0 === "layer" ? byLayer(sizes, weights) : byWeight(sizes, weights)
		drop(`./${other}`)
		const L = sizes.length - 1
		const outEntry = net.out
		createMemo("./loss", () => {
			const out = read(outEntry) as Float32Array, pts = read(data) as number[][]
			let sum = 0
			for (let k = 0; k < pts.length; k++) {
				const o = out[OFF + k]
				sum -= Math.log(Math.max(1e-7, pts[k][2] ? o : 1 - o))
			}
			ran("loss")
			return pts.length ? Math.round((sum / pts.length) * 1e4) / 1e4 : 0
		})
		createMemo("./accuracy", () => {
			const out = read(outEntry) as Float32Array, pts = read(data) as number[][]
			let right = 0
			for (let k = 0; k < pts.length; k++) {
				if ((out[OFF + k] > 0.5) === (pts[k][2] === 1)) right++
			}
			ran("accuracy")
			return pts.length ? right / pts.length : 0
		})
		look = diagram(sizes, net)
		watch(outEntry, () => (dirty.plane = true))
		dirty.plane = true
		picked =
			picked && picked.l <= L && picked.j < sizes[picked.l] && picked.i < sizes[picked.l - 1]
				? picked
				: undefined
		dirty.card = true
	})

	function diagram(sizes: number[], net: Net) {
		const { L, DH, xs, ys } = geometry(sizes)
		layer.style.width = DW + "px"
		layer.style.height = DH + "px"
		const NS = "http://www.w3.org/2000/svg"
		const svg = document.createElementNS(NS, "svg")
		svg.setAttribute("width", String(DW))
		svg.setAttribute("height", String(DH))
		const thumbs: Thumb[][] = [], edges: Edge[][][] = [[]]
		const parts: Node[] = [svg]
		for (let l = 1; l <= L; l++) {
			edges.push([])
			for (let j = 0; j < sizes[l]; j++) {
				edges[l].push([])
				for (let i = 0; i < sizes[l - 1]; i++) {
					const x0 = xs[l - 1] + S,
						y0 = ys[l - 1][i] + S / 2,
						x1 = xs[l],
						y1 = ys[l][j] + S / 2
					const m = (x0 + x1) / 2
					const d = `M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1}`
					const path = document.createElementNS(NS, "path"),
						hit = document.createElementNS(NS, "path")
					path.setAttribute("d", d)
					path.setAttribute("class", "edge")
					hit.setAttribute("d", d)
					hit.setAttribute("class", "hit")
					hit.onclick = () => {
						picked = { l, j, i }
						dirty.card = true
					}
					svg.append(path, hit)
					edges[l][j].push({ path, hit, w: () => 0, dirty: true })
				}
			}
		}
		for (let l = 0; l <= L; l++) {
			thumbs.push([])
			for (let j = 0; j < sizes[l]; j++) {
				const n = document.createElement("div")
				n.className = "neuron"
				n.style.left = xs[l] + "px"
				n.style.top = ys[l][j] + "px"
				const c = Object.assign(document.createElement("canvas"), { width: G, height: G })
				const ring = document.createElement("div")
				ring.className = "ring"
				n.append(c, ring)
				n.title = l === 0 ? (j ? "y" : "x") : `L${l}·n${j}: click for its bias`
				if (l > 0) {
					n.onclick = () => {
						picked = { l, j, i: -1 }
						dirty.card = true
					}
				}
				const g = c.getContext("2d")!
				thumbs[l].push({
					el: n,
					ring,
					g,
					img: g.createImageData(G, G),
					dirty: true,
					atDirty: true,
					flashed: 0,
				})
				parts.push(n)
			}
		}
		layer.replaceChildren(...parts)

		net.pipes(thumbs, edges) // a pipe per thing shown: a weight redraws its edge, a map its neuron
		return { thumbs, edges }
	}

	// ---- painting ----
	// a neuron's value as a tone: the output and sigmoids are 0..1, the plane's inputs -2..2
	const toned = (l: number, a: number) => {
		if (l === 0) return a / SPAN
		if (l === (net?.sizes.length ?? 1) - 1 || cur.activation === "sigmoid") return 2 * a - 1
		return a
	}
	function paintGrid(img: ImageData, m: Float32Array, l: number) {
		const px = img.data
		for (let q = 0; q < OFF; q++) {
			const [r, gg, b] = tone(toned(l, m[q]))
			px[4 * q] = r, px[4 * q + 1] = gg, px[4 * q + 2] = b, px[4 * q + 3] = 255
		}
	}
	function paint() {
		if (!look || !net) return
		const L = net.sizes.length - 1
		for (let l = 0; l <= L; l++) {
			for (const th of look.thumbs[l]) {
				if (th.dirty) {
					const m = th.map?.()
					if (m) {
						paintGrid(th.img, m, l)
						th.g.putImageData(th.img, 0, 0)
						th.dirty = false
					}
				}
				if (th.atDirty) {
					const a = th.at?.()
					if (a !== undefined) {
						th.ring.style.borderColor = css(toned(l, a))
						th.atDirty = false
					}
				}
			}
		}
		for (const layer of look.edges) {
			for (const row of layer) {
				for (const ed of row) {
					if (!ed.dirty) continue
					const w = ed.w()
					const a = Math.abs(w)
					ed.path.setAttribute("stroke", w >= 0 ? "#ff2284" : "#2269ff")
					ed.path.setAttribute("stroke-width", (0.6 + Math.min(5, a * 1.6)).toFixed(2))
					ed.path.setAttribute("stroke-opacity", (0.35 + Math.min(0.65, a / 2)).toFixed(2))
					ed.dirty = false
				}
			}
		}
		const out = dirty.plane ? peek<Float32Array>(net.out) : undefined
		if (out) {
			dirty.plane = false
			paintGrid(offImg, out, L)
			og.putImageData(offImg, 0, 0)
			g.imageSmoothingEnabled = true
			g.drawImage(off, 0, 0, SIZE, SIZE)
			const sx = (x: number) => ((x + SPAN) / (2 * SPAN)) * SIZE,
				sy = (y: number) => ((SPAN - y) / (2 * SPAN)) * SIZE
			g.lineWidth = 1
			g.strokeStyle = "#000"
			for (const [x, y, k] of read(data) as number[][]) {
				g.beginPath()
				g.arc(sx(x), sy(y), 3.5, 0, 6.2832)
				g.fillStyle = k ? "#ff2284" : "#2269ff"
				g.fill()
				g.stroke()
			}
			const [px, py] = read(probe) as number[]
			g.beginPath()
			g.arc(sx(px), sy(py), 7, 0, 6.2832)
			g.moveTo(sx(px) - 11, sy(py))
			g.lineTo(sx(px) + 11, sy(py))
			g.moveTo(sx(px), sy(py) - 11)
			g.lineTo(sx(px), sy(py) + 11)
			g.lineWidth = 1.5
			g.stroke()
		}
		if (dirty.curve) {
			dirty.curve = false
			const { losses, every } = read(history) as { every: number; losses: number[] }
			const w = curve.clientWidth || 600, h = 72
			if (curve.width !== w) (curve.width = w), (curve.height = h)
			cg.clearRect(0, 0, w, h)
			const top = Math.max(0.1, ...losses.slice(0, 20))
			const x = (k: number) => 4 + (k / Math.max(1, losses.length - 1)) * (w - 8)
			const y = (v: number) => h - 4 - (Math.min(v, top) / top) * (h - 22)
			cg.fillStyle = "#000"
			cg.font = "12px Jost, sans-serif"
			cg.fillText(`loss, a point every ${every} step${every > 1 ? "s" : ""}`, 6, 13)
			if (losses.length > 1) {
				cg.beginPath()
				cg.moveTo(x(0), h - 4)
				losses.forEach((v, k) => cg.lineTo(x(k), y(v)))
				cg.lineTo(x(losses.length - 1), h - 4)
				cg.fillStyle = "#40dcba55"
				cg.fill()
				cg.beginPath()
				losses.forEach((v, k) => (k ? cg.lineTo(x(k), y(v)) : cg.moveTo(x(k), y(v))))
				cg.strokeStyle = "#ff2284"
				cg.lineWidth = 1.5
				cg.stroke()
			}
			cg.fillStyle = "#000"
			cg.fillRect(0, h - 1, w, 1)
		}
		// what the last change reran: a flash on each neuron, and words under the card
		if (ranLog.length) {
			const now = performance.now()
			// label -> the kinds that ran: "L2·n3" -> ["map", "at"]; the maps flash
			const seen = new Map<string, string[]>()
			for (const x of ranLog) {
				const [label, kind] = x.split(" ")
				const kinds = seen.get(label) ?? []
				if (kind && !kinds.includes(kind)) kinds.push(kind)
				seen.set(label, kinds)
			}
			for (const [label, kinds] of seen) {
				const m = /^L(\d+)(?:·n(\d+))?$/.exec(label)
				if (!m || !kinds.includes("map") || cur.playing) continue
				const ths = m[2] === undefined
					? look.thumbs[+m[1]] ?? []
					: [look.thumbs[+m[1]]?.[+m[2]]]
				for (const th of ths) {
					if (!th || now - th.flashed < 500) continue
					th.flashed = now
					th.el.animate([{ boxShadow: "0 0 0 8px #40dcba" }, {
						boxShadow: "0 0 0 8px #40dcba00",
					}], { duration: 1400 })
				}
			}
			if (cur.playing) lastRan = ""
			else {
				const total = net.computes + 2
				const n = new Set(ranLog).size
				lastRan = n >= total
					? `the last change reran all ${total} forward computes`
					: `the last change reran ${n} of ${total} forward computes: ` +
						[...seen].slice(0, 6).map(([l, k]) => (k.length ? `${l} ${k.join("+")}` : l))
							.join(", ") +
						(seen.size > 6 ? `, and ${seen.size - 6} more` : "")
				dirty.card = true
			}
			ranLog = []
		}
		paintCard()
	}

	// the picked weight: its slider (jsx below, writing it through on/weight), its readout, a button
	// to its node in the graph tab. the rest of the card is elements, shown as the pick says
	let slider: HTMLInputElement | undefined
	const readout = el("output")
	const inGraph = el("button", "small")
	inGraph.textContent = "in the graph"
	inGraph.onclick = () => {
		if (picked && net) inspect(net.address(picked.l, picked.j, picked.i))
	}
	const what = el("span", "what")
	const ranLine = el("div", "ran")
	let cardKey = ""
	function paintCard() {
		if (!net) return
		const v = picked ? net.get(picked.l, picked.j, picked.i) : undefined
		const key = JSON.stringify([picked, v, lastRan, net.grain])
		if (!dirty.card && key === cardKey) return
		dirty.card = false
		cardKey = key
		for (const layer of look?.edges ?? []) {
			for (const row of layer) for (const ed of row) ed.hit.classList.remove("picked")
		}
		for (const col of look?.thumbs ?? []) for (const th of col) th.el.classList.remove("picked")
		ranLine.textContent = lastRan
		const some = picked !== undefined && v !== undefined
		if (slider) slider.hidden = !some
		readout.hidden = inGraph.hidden = !some
		if (!picked || v === undefined) {
			what.textContent = "click an edge for its weight, a neuron for its bias"
			return
		}
		const { l, j, i } = picked
		if (i < 0) look?.thumbs[l]?.[j]?.el.classList.add("picked")
		else look?.edges[l]?.[j]?.[i]?.hit.classList.add("picked")
		what.textContent = i < 0 ? `bias of L${l}·n${j}` : `weight L${l}·n${j} ← L${l - 1}·n${i}`
		if (slider && document.activeElement !== slider) slider.value = String(v)
		readout.textContent = v.toFixed(3)
	}

	// ---- the frame: the host runs on/frame each frame, after the steps it ran while playing. it
	// paints (reads untracked), and shows what the host measured (steps/s, writes/step, runs/step) ----
	createAction("on/frame", (readouts: Record<string, string> = {}) => {
		for (const [n, v] of Object.entries(readouts)) setLive(n, v)
		peep(paint)
	})

	// the same step with no graph: the forward pass over the grid and the data, backprop, in arrays
	function plain() {
		const pts = peek<number[][]>(data) ?? [], sizes = net!.sizes, L = sizes.length - 1
		const P = net!.read(), N = pts.length, n = OFF + N, lr = cur.rate
		const [f, df] = ACTS[cur.activation] ?? ACTS.tanh
		const x0 = new Float32Array(2 * n)
		x0.set(GX, 0), x0.set(GY, n)
		pts.forEach(([x, y], k) => ((x0[OFF + k] = x), (x0[n + OFF + k] = y)))
		let count = 0
		const t0 = performance.now()
		while (performance.now() - t0 < 500) {
			const A = [x0]
			for (let l = 1; l <= L; l++) {
				const r = sizes[l], c = sizes[l - 1], W = P.W[l - 1], B = P.B[l - 1], ins = A[l - 1]
				const o = new Float32Array(r * n), fn = l === L ? sigmoid : f
				for (let j = 0; j < r; j++) {
					for (let q = 0; q < n; q++) {
						let z = B[j]
						for (let i = 0; i < c; i++) z += W[j * c + i] * ins[i * n + q]
						o[j * n + q] = fn(z)
					}
				}
				A.push(o)
			}
			let d = new Float64Array(N)
			for (let k = 0; k < N; k++) d[k] = A[L][OFF + k] - pts[k][2]
			for (let l = L; l >= 1; l--) {
				const r = sizes[l], c = sizes[l - 1], W = P.W[l - 1], B = P.B[l - 1], a = A[l - 1]
				const nd = new Float64Array(c * N)
				for (let j = 0; j < r; j++) {
					let gb = 0
					for (let k = 0; k < N; k++) gb += d[j * N + k]
					for (let i = 0; i < c; i++) {
						let gw = 0
						const w = W[j * c + i]
						for (let k = 0; k < N; k++) {
							gw += d[j * N + k] * a[i * n + OFF + k]
							nd[i * N + k] += w * d[j * N + k]
						}
						W[j * c + i] = w - (lr * gw) / N // a copy: the nodes are left as they are
					}
					B[j] -= (lr * gb) / N
				}
				if (l === 1) break
				for (let i = 0; i < c * N; i++) nd[i] *= df(a[((i / N) | 0) * n + OFF + (i % N)])
				d = nd
			}
			count++
		}
		const ms = performance.now() - t0
		return {
			grain: "no graph",
			write: "arrays",
			"steps/s": Math.round((count * 1000) / ms),
			"ms/step": (ms / count).toFixed(2),
		}
	}

	// the speeds measured, as a table: hidden until there are some
	const table = (rows: Record<string, unknown>[]) => {
		const keys = Object.keys(rows[0] ?? {})
		return (
			<table>
				<tr>{keys.map((k) => <th>{k}</th>)}</tr>
				{rows.map((r) => <tr>{keys.map((k) => <td>{String(r[k] ?? "")}</td>)}</tr>)}
			</table>
		)
	}
	// a column's head: its size, and buttons for a hidden one; and a layer more (before the output),
	// at the left. jsx, since they run actions
	const heads = (sizes: number[]) => {
		const { L, xs } = geometry(sizes)
		const h = sizes.slice(1, -1)
		return (
			<div class="heads">
				{sizes.map((n, l) => {
					const left = { left: xs[l] + S / 2 + "px" }
					if (l === 0) return <div class="head" style={left}>x, y</div>
					if (l === L) return <div class="head" style={left}>out</div>
					const less = h.slice()
					less[l - 1] > 1 ? less[l - 1]-- : less.splice(l - 1, 1)
					const more = h.slice()
					more[l - 1] = Math.min(MAX.neurons, more[l - 1] + 1)
					return (
						<div class="head" style={left}>
							<button class="small" onClick={handler("on/hidden", [less])}>−</button>
							{String(n)}
							<button class="small" onClick={handler("on/hidden", [more])}>+</button>
						</div>
					)
				})}
				<div class="side" style={{ left: "0px", bottom: "0px" }}>
					<button
						class="small"
						onClick={handler(
							"on/hidden",
							[h.length < MAX.layers ? [...h, 4] : h],
						)}
					>
						+ layer
					</button>
				</div>
			</div>
		)
	}
	// the slider: writes the picked weight
	const picker = (
		<input
			type="range"
			min="-4"
			max="4"
			step="0.01"
			hidden
			ref={(e: HTMLInputElement) => (slider = e)}
			onInput={handler(
				"on/weight",
				(e) => picked ? [picked.l, picked.j, picked.i, +e.target.value] : undefined,
			)}
		/>
	)
	return (
		<div class="nn">
			<style>{LOOK}</style>
			<div class="card">
				<div class="row">
					<button
						aria-pressed={bind("playing", String)}
						onClick={handler("on/play", () => [!cur.playing])}
					>
						{bind("playing", (v) => (v ? "pause" : "play"))}
					</button>
					<button onClick={handler("on/step")}>step</button>
					<button onClick={handler("on/reset")}>reset</button>
					data
					{Object.keys(DATA).map((k) => (
						<button class="small" onClick={handler("on/data", [k])}>{k}</button>
					))}
					<button class="small" onClick={handler("on/data", [""])}>clear</button>
					pen
					{[1, 0].map((k) => (
						<button
							class="small pen"
							aria-pressed={bind("pen", (p) => String(p === k))}
							onClick={handler("on/set", ["pen", k])}
						>
							<span class={`dot c${k}`} />
						</button>
					))}
				</div>
				<div class="row">
					{choice("rate", [
						["0.03", "0.03"],
						["0.1", "0.1"],
						["0.3", "0.3"],
						["0.5", "0.5"],
						["1", "1"],
						["3", "3"],
					], Number)}
					{choice("activation", Object.keys(ACTS).map((k) => [k, k]))}
					{choice("grain", [["weight", "a node per weight"], ["layer", "a node per layer"]])}
					{choice("write", [["each", "each its own"], ["bulk", "one header"], [
						"whole",
						"whole values",
					]])}
					{choice("speed", [["0", "as fast as fits"], ["1", "1 a frame"], [
						"10",
						"10 a frame",
					]], Number)}
					<button onClick={handler("/host/on/measure")}>
						{bind("measuring", (m) => (m ? "measuring…" : "measure"))}
					</button>
				</div>
			</div>
			<div class="row">
				<span class="tag">
					steps <b>{bind("steps")}</b>
				</span>
				{measured("steps/s")}
				<span class="tag">
					loss <b>{bind("loss", (l) => (typeof l === "number" ? l.toFixed(3) : "–"))}</b>
				</span>
				<span class="tag">
					accuracy{" "}
					<b>
						{bind(
							"accuracy",
							(a) => (typeof a === "number" ? Math.round(a * 100) + "%" : "–"),
						)}
					</b>
				</span>
				{measured("writes/step")}
				{measured("runs/step")}
			</div>
			<div class="boards">
				<div
					class="card plane"
					onPointerDown={handler("on/add", (e) =>
						e.target === canvas
							? [...toPlane(e), e.shiftKey ? 1 - cur.pen : cur.pen]
							: undefined)}
					onPointerMove={handler("on/probe", (e) =>
						e.target === canvas ? [toPlane(e)] : undefined)}
				>
					{canvas}
					<div class="hint">
						click adds a <span class="dot c1" /> or <span class="dot c0" />{" "}
						point (the pen; shift: the other). the pointer is the probe the network's rings
						show
					</div>
				</div>
				<div class="card netcard">
					<div class="net">
						{layer}
						{bind("hidden", (h: number[]) =>
							heads(sizesOf(h)))}
					</div>
					<div class="weight">
						{what} {picker}
						{readout} {inGraph}
						{ranLine}
					</div>
				</div>
			</div>
			<div class="card curve">{curve}</div>
			<div
				class="card"
				hidden={bind("speeds", (rows) =>
					!rows?.length)}
			>
				{bind("speeds", (rows) => (rows?.length ? table(rows) : null))}
			</div>
		</div>
	)
}
