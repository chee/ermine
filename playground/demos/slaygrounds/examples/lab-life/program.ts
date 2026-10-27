/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	createWriter,
	ensureNode,
	executeAction,
	hasNode,
	patch,
	peep,
	read,
	ref,
} from "@ermine/system"
import { bind, handler } from "ermine-h"

// program.ts: the game of life as a graph. every cell is a node under ./cells (alive or not). each
// cell has two effects made here:
//   paint: its own square, when its cell changes
//   flip:  reads its eight neighbours, its cell and the rule node, answers "will I change?";
//          its act keeps the plan list
// a step writes only the cells in the plan: one pulse. what reruns is what read a
// changed cell: the neighbours' counts, then their flips. nothing else. edit the rule node (or pick
// one) and every flip reads it, so every flip reruns. edit this file: the board is still there.
// the board is a canvas, painted by hand and held with ref; the controls and the generation are jsx, bound
// to their nodes. alive, flips and runs/step are measured, not nodes: plain text, every half second.
// the clock is a timer an effect keeps (an interval per step, from the speed node, none when it is
// 0), calling on/step through a writer made in setup; the pointer paints through the card's handlers
const LOOK = `
body { background: #ffff88; margin: 8px; font-family: Jost, system-ui, sans-serif }
.lab { display: flex; flex-direction: column; gap: 8px; width: 584px }
.card { background: #fff; border: 1px solid #000; box-shadow: 0 0 10px 2px #66003322; border-radius: 6px; padding: 6px }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap }
canvas { display: block; cursor: crosshair; touch-action: none }
button { font: inherit; padding: 2px 12px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 1px 1px 0 #000; cursor: pointer; transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translateY(-1px); box-shadow: 2px 2px 0 #000 }
button:active { transform: none; box-shadow: none }
select { font: inherit; border: 1px solid #000; border-radius: 2px; background: #fff }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg); font-weight: 600; font-variant-numeric: tabular-nums }
.tag b { color: #ff2284 }
`
const W = 40, H = 28, S = 14
const RULES: Record<string, { birth: number[]; survive: number[] }> = {
	"life B3/S23": { birth: [3], survive: [2, 3] },
	"highlife B36/S23": { birth: [3, 6], survive: [2, 3] },
	"day & night": { birth: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8] },
	"seeds B2/S": { birth: [2], survive: [] },
	"replicator": { birth: [1, 3, 5, 7], survive: [1, 3, 5, 7] },
}

// a node's value now, from an action (nothing tracked)
const get = <T,>(x: Parameters<typeof read>[0]) => peep(() => read(x)) as T
const put = (x: Parameters<typeof read>[0], v: unknown) => patch(x, [{ path: [], value: v }])

export default function program() {
	const rule = ensureNode("./rule", { name: "life B3/S23", ...RULES["life B3/S23"] })
	const speed = ensureNode("./speed", 0) // steps a second; 0 is paused
	const generation = ensureNode("./generation", 0)
	const N = W * H

	// the cells: made the first time (a glider and a blinker and some noise), found after
	const entry: ReturnType<typeof ensureNode>[] = []
	const seeded = hasNode("./cells/c0")
	for (let i = 0; i < N; i++) {
		const x = i % W, y = (i / W) | 0
		const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]].some(([a, b]) =>
			x === a + 3 && y === b + 3
		)
		const blinker = y === 10 && x >= 20 && x <= 22
		entry.push(
			ensureNode("./cells/c" + i, seeded ? false : glider || blinker || Math.random() < 0.18),
		)
	}

	// ---- the plan, and what the readout counts ----
	const plan = new Set<number>()
	let alive = 0
	const shown = { flips: 0, runs: 0 }
	let runs = 0 // runs of a flip or a paint since a step began (its pulse follows the step)

	// ---- per cell: paint, count, flip ----
	const canvas = peep(() =>
		read(ref(
			"canvas",
			() => Object.assign(document.createElement("canvas"), { width: W * S, height: H * S }),
		))
	) as HTMLCanvasElement
	const g = canvas.getContext("2d")!
	let paints = 0
	for (let i = 0; i < N; i++) {
		const x = i % W, y = (i / W) | 0
		const around: number[] = []
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx || dy) around.push(((y + dy + H) % H) * W + ((x + dx + W) % W))
			}
		}
		let was = false
		// paint: its own square, only when its cell changed
		createEffect(`paint${i}`, () => (runs++, read(entry[i]) as boolean), (v: boolean) => {
			g.fillStyle = v ? "#ff2284" : "#fff"
			g.fillRect(x * S, y * S, S, S)
			g.strokeStyle = "#0001"
			g.strokeRect(x * S + 0.5, y * S + 0.5, S - 1, S - 1)
			alive += (v ? 1 : 0) - (was ? 1 : 0)
			was = v
			paints++
		})
		// flip: will this cell change? counts its eight and reads the rule: when a neighbour or
		// the rule changes it runs again, and its set puts it in the plan or takes it out
		createEffect(`flip${i}`, () => {
			runs++
			let n = 0
			for (const j of around) if (read(entry[j])) n++
			const me = read(entry[i])
			const r = read(rule) as { birth: number[]; survive: number[] }
			return me ? !r.survive.includes(n) : r.birth.includes(n)
		}, (will: boolean) => void (will ? plan.add(i) : plan.delete(i)))
	}

	// ---- a step, and the actions the buttons call ----
	// the step is an action: the clock's beat calls it, and the button. its writes ask for one pulse,
	// after it: the readout is told then (runs/step counts what that pulse ran)
	const out: Record<string, HTMLElement> = {}
	const show = () => {
		const v: Record<string, number> = { alive, flips: shown.flips, runs }
		for (const k in out) out[k].textContent = String(v[k])
	}
	createAction("on/step", () => {
		const flips = [...plan]
		runs = 0
		for (const i of flips) put(entry[i], !get(entry[i]))
		put(generation, get<number>(generation) + 1)
		shown.flips = flips.length
		setTimeout(show, 0)
	})
	// the clock: one interval a step while the speed is not 0
	const withWriter = createWriter()
	createEffect("clock", () => read(speed) as number, (v) => {
		if (!v) return
		const t = setInterval(() => withWriter(() => executeAction("on/step")), 1000 / v)
		return () => clearInterval(t)
	})
	createAction("on/rule", (name: string) => put(rule, { name, ...RULES[name] }))
	createAction("on/speed", (v: number) => put(speed, v))
	createAction("on/play", () => put(speed, get(speed) ? 0 : 8))
	createAction("on/random", () => {
		for (let i = 0; i < N; i++) put(entry[i], Math.random() < 0.25)
	})
	createAction("on/clear", () => {
		for (let i = 0; i < N; i++) if (get(entry[i])) put(entry[i], false)
	})

	// ---- painting by hand: the card's pointer handlers call on/paint; the drag's mode is held here ----
	let paint: boolean | undefined
	const cellAt = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		const x = Math.floor((e.clientX - r.left) / S), y = Math.floor((e.clientY - r.top) / S)
		return x >= 0 && x < W && y >= 0 && y < H ? y * W + x : -1
	}
	createAction("on/paint", (how: "down" | "move" | "up", i: number) => {
		if (how === "up") return void (paint = undefined)
		if (i < 0) return
		if (how === "down") {
			paint = !get(entry[i])
			put(entry[i], paint)
		} else if (paint !== undefined && !!get(entry[i]) !== paint) put(entry[i], paint)
	})

	// ---- the readout every half second ----
	const readout = setInterval(show, 500)
	addTeardown(() => clearInterval(readout))

	// ---- the view: the controls call handlers; step sends to on/step ----
	const tag = (name: string, k: string) => (
		<span class="tag">
			{name} <b ref={(e) => (out[k] = e)} />
		</span>
	)
	return (
		<div class="lab">
			<style>{LOOK}</style>
			<div class="row card">
				<button onClick={handler("on/play")}>
					{bind("speed", (v) => (v ? "pause" : "play"))}
				</button>
				<button onClick={handler("on/step")}>step</button>
				<button onClick={handler("on/random")}>random</button>
				<button onClick={handler("on/clear")}>clear</button>
				<select
					value={bind("rule", (r) => r.name)}
					onChange={handler("on/rule", (e) => [e.target.value])}
				>
					{Object.keys(RULES).map((k) => <option value={k}>{k}</option>)}
				</select>
				<span class="tag">
					generation <b>{bind("generation")}</b>
				</span>
				{tag("alive", "alive")}
				{tag("flips", "flips")}
				{tag("runs/step", "runs")}
			</div>
			<div
				class="card"
				onPointerDown={handler("on/paint", (e) => {
					canvas.setPointerCapture(e.pointerId)
					return ["down", cellAt(e)]
				})}
				onPointerMove={handler("on/paint", (e) => ["move", cellAt(e)])}
				onPointerUp={handler("on/paint", () => ["up", -1])}
			>
				{canvas}
			</div>
		</div>
	)
}
