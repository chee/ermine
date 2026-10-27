/** @jsxImportSource ermine-h */
import type { Patch } from "@ermine/core/op/apply"
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	patch,
	peep,
	pipe,
	read as readNode,
	ref,
} from "@ermine/system"
import { change } from "@ermine/slaygrounds/tools"
import { bind, handler } from "ermine-h"

// the handle of a node: what ensureNode gives
type Node = ReturnType<typeof ensureNode>
// what a node holds, as the game takes it (any: its values are its own)
// deno-lint-ignore no-explicit-any
const read = (x: Node | string): any => readNode(x)

// big-rewind: snake on a nokia 3210, and a time machine beside it. every tick the game makes is
// kept on a tape, and the tape is a node (/snake/tape: { at, steps }), each step every write the
// tick made, as its patches and their inverses (op.undo). the machine shows the tape: the crank
// travels (a click a tick), the paper tape is punched from the real patches (above the line) and
// their inverses (below it), one hole a patch, on the track of the node it changed; going on reads
// the patches, going back the inverses. the lever plays, rewinds and fast-forwards (the clock, a
// second process, does the ticking and the winding at /snake/speed: edit it in the graph tab).
// crashed? crank back a little and play on: the steps after where you are go. the rules are below:
// change them while it plays. a travel replays the changes kept, never the rules
const W = 20, H = 10 // cells of 4 dots: the field is 80 by 40 of the screen's 84 by 48
const WRAP = false // true: the walls wrap round
const GROW = 2 // cells a cherry is worth
// covers: the 3210 snapped into Xpress-on covers: the colour runs to the edges, a silver panel round
// the screen. orange first (no photo of an orange 3210 cover was found: a warm orange of its years),
// four of its covers by their names (the colours near, not measured), the lime green of the green
// cover in the photo (sampled from it), and a lemon and cherry one
const SILVER = { panel: "#8e9492", keys: "#bfc3c4", ink: "#23262b", logo: "#c9cdcb" }
const COVERS = {
	orange: { name: "orange", body: "#f2761d", edge: "#c85a10", ...SILVER },
	astral: { name: "Astral Blue", body: "#24386f", edge: "#18264d", ...SILVER },
	copper: { name: "Copper Red", body: "#a8402a", edge: "#7e2f1e", ...SILVER },
	meteor: { name: "Meteor Yellow", body: "#f1c21a", edge: "#c99e0a", ...SILVER },
	rocket: {
		name: "Rocket Silver",
		body: "#aab1b8",
		edge: "#858c94",
		...SILVER,
		panel: "#c4c8cc",
		logo: "#7d838a",
	},
	lime: { name: "green (the photo's)", body: "#98ae49", edge: "#788b35", ...SILVER },
	lemon: {
		name: "lemon & cherry",
		body: "#ffff88",
		edge: "#dede55",
		panel: "#ff2284",
		keys: "#ffffff",
		ink: "#ff2284",
		logo: "#ffff88",
	},
}
// the phone is drawn in the photo's coordinates (814 by 2000), shown at this scale
const K = 0.36
// the paper tape's tracks, top to bottom: the node each patch changed
const TRACKS = ["body", "food", "score", "grow", "dir", "alive"]
type Write = { name: string; undo: readonly Patch[]; redo: readonly Patch[] }
type Step = { what: string; writes: Write[] }
type Tape = { at: number; steps: Step[] }
const STEP = 12 // px of tape a step

const LOOK = `
[hidden] { display: none !important }
body { margin: 0; background: #ffff88; font: 14px/1.3 Jost, system-ui, sans-serif; color: #000;
	overflow: hidden }
.fit { margin: 0 auto; overflow: hidden }
.stage { position: relative; width: 960px; height: 760px; transform-origin: 0 0; display: flex;
	gap: 20px; padding: 10px; box-sizing: border-box }

/* the phone: drawn at K of the photo's 814 by 2000; the screen's glass is 137..691 by 472..860 */
.phone { position: relative; width: ${814 * K}px; flex: none; outline: none }
.phone svg.body { display: block; overflow: visible }
.phone .lcd { position: absolute; left: ${137 * K}px; top: ${472 * K}px; width: ${554 * K}px;
	height: ${388 * K}px; padding: ${12 * K}px ${13 * K}px; box-sizing: border-box; border-radius: ${
	10 * K
}px;
	image-rendering: auto; filter: blur(.25px) contrast(1.05);
	background: radial-gradient(ellipse at 50% 42%, #d6ec8e 0%, #b9d366 52%, #98b44c 100%);
	box-shadow: inset 0 0 6px #0006 }
.phone .glass { position: absolute; left: ${137 * K}px; top: ${472 * K}px; width: ${554 * K}px;
	height: ${388 * K}px; pointer-events: none; border-radius: ${10 * K}px;
	background: linear-gradient(160deg, #ffffff40 0%, #fff0 38%, #fff0 70%, #ffffff14 100%) }
.phone .edge { fill: var(--edge); transition: fill 300ms }
.phone .cover { fill: var(--body); transition: fill 300ms }
.phone .panel { fill: var(--panel); stroke: #000; stroke-opacity: .55; stroke-width: 4; transition: fill 300ms }
.phone .groove { fill: none; stroke: #2c2f33; stroke-width: 15; stroke-linecap: round }
.phone .groove.lit { stroke: #8f9599; stroke-width: 7 }
.phone .hole { fill: #0c0d0f }
.phone .logo { font: 700 56px Arial, "Helvetica Neue", sans-serif; fill: var(--logo); transition: fill 300ms }
.phone .recess { fill: #fff; fill-opacity: .1; stroke: #000; stroke-opacity: .28; stroke-width: 2.5 }
.phone .window { fill: #3a3e43; stroke: #000; stroke-width: 2.5 }
.phone .socket { fill: #000; fill-opacity: .55 }
.phone .key { cursor: pointer }
.phone .key .cap { transition: transform 60ms }
.phone .key.down .cap { transform: translateY(5px) }
.phone .key.down .keycap { filter: brightness(.8) }
.phone .keycap { fill: var(--keys); stroke: #000; stroke-width: 2.5; transition: fill 300ms }
.phone .face { fill: var(--keys); transition: fill 300ms }
.phone .key.down .face { filter: brightness(.8) }
.phone .shine { fill: url(#silver); pointer-events: none }
.phone .label { fill: var(--ink); text-anchor: middle; font-family: "Helvetica Neue", Arial, sans-serif;
	font-stretch: condensed; pointer-events: none }
.phone .label .digit { font-size: 60px; font-weight: 500 }
.phone .label .letters { font-size: 40px; font-weight: 400 }
.phone.buzz { animation: buzz 420ms linear }
@keyframes buzz { 0%,100% { transform: none } 10%,50%,90% { transform: translate(-4px, 1px) rotate(-1.2deg) }
	30%,70% { transform: translate(4px, -1px) rotate(1.2deg) } }
.phone .zz { opacity: 0; transition: opacity 120ms }
.phone.buzz .zz { opacity: 1 }
.phone.snap { animation: snap 380ms cubic-bezier(.3, 1.6, .5, 1) }
@keyframes snap { 0% { transform: scale(1) } 40% { transform: scale(.94) rotate(-2deg) } 100% { transform: none } }
.covers { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 6px;
	font-size: 12px }
.covers button { width: 22px; height: 22px; border-radius: 50%; border: 1px solid #000; padding: 0;
	cursor: pointer; box-shadow: 2px 2px 0 #000; transition: transform 100ms, box-shadow 100ms }
.covers button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
.covers button.on { outline: 2px solid #2269ff; outline-offset: 2px }
.covers .tag { background: #fff; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg);
	font-weight: 600 }

/* the time machine */
.machine { position: relative; flex: 1; background: #fff8e6; border: 1px solid #000;
	border-radius: 12px; box-shadow: 0 0 10px 2px #66003322; padding: 12px 16px; box-sizing: border-box }
.brass { background: linear-gradient(#f6dc93, #d3a24a 55%, #a87a2c); border: 1px solid #000 }
.plate { display: flex; align-items: center; gap: 12px; border-radius: 6px; padding: 6px 12px;
	box-shadow: inset 0 1px 0 #fff8 }
.plate .name { font-weight: 600; letter-spacing: 2px; font-size: 15px; text-transform: uppercase }
.plate .name small { display: block; font-size: 10px; letter-spacing: 1.5px; font-weight: 500; opacity: .75 }
.plate .fill { flex: 1 }
.rivet { width: 7px; height: 7px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fff6, #8a6420);
	border: 1px solid #000 }
.lamp { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10px;
	font-weight: 700; letter-spacing: 1.5px }
.lamp i { width: 20px; height: 20px; border-radius: 50%; border: 1px solid #000;
	background: radial-gradient(circle at 35% 35%, #fff8, #6d5c4a 70%); transition: background 160ms, box-shadow 160ms }
.lamp.now.on i { background: radial-gradient(circle at 35% 35%, #fff, #40dcba 55%, #1f9c80);
	box-shadow: 0 0 14px 5px #40dcbaaa }
.lamp.past.on i { background: radial-gradient(circle at 35% 35%, #fff, #ff2284 55%, #b3005a);
	box-shadow: 0 0 14px 5px #ff2284aa }
.dials { display: flex; align-items: center; justify-content: space-between; margin: 12px 4px 6px }
.odo { display: flex; flex-direction: column; align-items: center; gap: 3px }
.odo label { font-size: 10px; font-weight: 700; letter-spacing: 2px }
.wheels { display: flex; gap: 2px; padding: 4px 5px; border-radius: 5px }
.wheel { width: 24px; height: 34px; overflow: hidden; background: #1d1a17; border: 1px solid #000;
	border-radius: 2px; box-shadow: inset 0 9px 7px -5px #000, inset 0 -9px 7px -5px #000 }
.wheel b { display: block; font: 600 26px/34px Jost, system-ui, sans-serif; color: #fff1cc;
	text-align: center; transition: transform 180ms cubic-bezier(.3, .7, .4, 1) }
.gauge text { font: 700 9px Jost, system-ui, sans-serif; letter-spacing: 1px }
.deck { position: relative; height: 166px; margin-top: 4px }
.deck svg.reels { position: absolute; inset: 0; overflow: visible; z-index: 1; pointer-events: none }
.paper { position: absolute; left: 66px; right: 66px; top: 36px; height: 96px; overflow: hidden;
	border-top: 1px solid #000; border-bottom: 1px solid #000; background: #fdf1cc }
.strip { position: absolute; left: 0; top: 0; height: 96px; width: 120000px; will-change: transform;
	transition: transform 120ms linear;
	background: radial-gradient(circle, #3a2e22 0 1.6px, #0000 2.2px) 0 46px / ${STEP}px 6px repeat-x }
.strip .read { position: absolute; left: 0; top: 0; bottom: 0; background: #e9d7a3 }
.strip .col { position: absolute; top: 0; width: ${STEP}px; height: 96px }
.strip .col.new { background: #ff228422 }
.strip .h { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: #2b2118;
	box-shadow: inset 0 1px 1px #000 }
.strip .h.out { background: none; border: 1.4px solid #2b2118; width: 2.4px; height: 2.4px }
.strip .h.under { background: #5a1638 } .strip .h.under.out { background: none; border-color: #5a1638 }
.strip .no { position: absolute; bottom: 1px; font: 600 7px Jost, system-ui, sans-serif; color: #7a6440;
	transform: translateX(-50%) }
.paper .line { position: absolute; left: 0; right: 0; top: 47px; border-top: 1px dashed #7a644066 }
.head { position: absolute; z-index: 2; left: 50%; top: 24px; width: 30px; height: 120px; margin-left: -15px;
	border-radius: 5px; box-shadow: 0 3px 0 #0003; display: flex; flex-direction: column;
	align-items: center; justify-content: space-between; padding: 4px 0; box-sizing: border-box }
.head i { width: 12px; height: 12px; border-radius: 50%; border: 1px solid #000; background: #6d5c4a;
	transition: background 260ms, box-shadow 260ms }
.head .slot { width: 4px; flex: 1; margin: 5px 0; background: #0006; border-radius: 2px }
.head i.fwd.on { background: #40dcba; box-shadow: 0 0 10px 3px #40dcba; transition: none }
.head i.back.on { background: #ff2284; box-shadow: 0 0 10px 3px #ff2284; transition: none }
.ticket { margin: 2px 40px 0; background: #fff; border: 1px solid #000; padding: 5px 10px;
	font: 11px/1.45 Monaco, ui-monospace, monospace; min-height: 46px; box-shadow: 2px 2px 0 #000;
	transform: rotate(-.6deg); overflow-wrap: anywhere }
.ticket b { color: #2269ff } .ticket .back { color: #ff2284 } .ticket .fwd { color: #13a383 }
.ticket small { display: block; color: #0008; font-size: 10px; margin-top: 2px }
.works { position: absolute; left: 16px; right: 16px; bottom: 12px; height: 300px }
.works svg { position: absolute; overflow: visible }
.works .crank { cursor: grab; touch-action: none }
.works .crank:active { cursor: grabbing }
.works .spin { transition: transform 140ms linear }
.works .lever { cursor: pointer; touch-action: none }
.works .lever text { font: 700 11px Jost, system-ui, sans-serif; letter-spacing: 1px; text-anchor: middle }
.works .arm { transition: transform 220ms cubic-bezier(.3, 1.5, .5, 1) }
.works .how { position: absolute; right: 0; bottom: 0; width: 200px; font-size: 11px; line-height: 1.4;
	color: #000b; text-align: right }
.works .how b { color: #000 }
`

// a 3 by 5 font, as the 3210 had something like: each glyph five rows of three
const FONT = {
	"0": "###|#.#|#.#|#.#|###",
	"1": ".#.|##.|.#.|.#.|###",
	"2": "###|..#|###|#..|###",
	"3": "###|..#|.##|..#|###",
	"4": "#.#|#.#|###|..#|..#",
	"5": "###|#..|###|..#|###",
	"6": "###|#..|###|#.#|###",
	"7": "###|..#|..#|.#.|.#.",
	"8": "###|#.#|###|#.#|###",
	"9": "###|#.#|###|..#|###",
	A: ".#.|#.#|###|#.#|#.#",
	B: "##.|#.#|##.|#.#|##.",
	C: ".##|#..|#..|#..|.##",
	D: "##.|#.#|#.#|#.#|##.",
	E: "###|#..|##.|#..|###",
	F: "###|#..|##.|#..|#..",
	G: ".##|#..|#.#|#.#|.##",
	H: "#.#|#.#|###|#.#|#.#",
	I: "###|.#.|.#.|.#.|###",
	J: "..#|..#|..#|#.#|.#.",
	K: "#.#|#.#|##.|#.#|#.#",
	L: "#..|#..|#..|#..|###",
	M: "#.#|###|###|#.#|#.#",
	N: "##.|#.#|#.#|#.#|#.#",
	O: ".#.|#.#|#.#|#.#|.#.",
	P: "##.|#.#|##.|#..|#..",
	Q: ".#.|#.#|#.#|##.|.##",
	R: "##.|#.#|##.|#.#|#.#",
	S: ".##|#..|.#.|..#|##.",
	T: "###|.#.|.#.|.#.|.#.",
	U: "#.#|#.#|#.#|#.#|###",
	V: "#.#|#.#|#.#|#.#|.#.",
	W: "#.#|#.#|###|###|#.#",
	X: "#.#|#.#|.#.|#.#|#.#",
	Y: "#.#|#.#|.#.|.#.|.#.",
	Z: "###|..#|.#.|#..|###",
	" ": "...|...|...|...|...",
	":": "...|.#.|...|.#.|...",
	"<": "..#|.#.|#..|.#.|..#",
	">": "#..|.#.|..#|.#.|#..",
	"!": ".#.|.#.|.#.|...|.#.",
	"?": "##.|..#|.#.|...|.#.",
	"-": "...|...|###|...|...",
	".": "...|...|...|...|.#.",
	"/": "..#|..#|.#.|#..|#..",
}

const MOVES = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" }
// keyboard keys, as the phone's
const KEYS = {
	ArrowUp: "2",
	ArrowLeft: "4",
	ArrowRight: "6",
	ArrowDown: "8",
	w: "2",
	a: "4",
	d: "6",
	s: "8",
	" ": "navi",
	Enter: "navi",
	Backspace: "c",
	c: "c",
	"[": "down",
	"]": "up",
	PageUp: "up",
	PageDown: "down",
}
const TURN = { "2": "up", "4": "left", "6": "right", "8": "down" }
const LEVER = { rew: -56, stop: -19, play: 19, ff: 56 }
const fresh = () => [[6, 5], [5, 5], [4, 5]]
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

export default function game() {
	// what a node holds now, untracked: the actions and the code they call read so
	const got = (x: Node | string) => peep(() => read(x))
	// a live thing kept across reloads: saved under ./snake/ui, made the first time only
	const keep = <T,>(name: string, make: () => T): T => got(ref(`./snake/ui/${name}`, make)) as T
	const style = keep("style", () => document.head.appendChild(document.createElement("style")))
	style.textContent = LOOK
	keep("font", () =>
		document.head.appendChild(Object.assign(document.createElement("link"), {
			rel: "stylesheet",
			href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600;700&display=swap",
		})))
	// a whole put
	const put = (x: Node, v: unknown) => patch(x, [{ path: [], value: v }])

	// the game is these nodes (./snake: saved, there across a reload); the tape keeps how each tick
	// changed them
	const body = ensureNode("./snake/body", fresh())
	const dir = ensureNode("./snake/dir", "right")
	const want = ensureNode("./snake/want", "right")
	const food = ensureNode("./snake/food", [14, 5])
	const score = ensureNode("./snake/score", 0)
	const grow = ensureNode("./snake/grow", 0)
	const alive = ensureNode("./snake/alive", true)
	// not on the tape: the lever (stop, play, rew, ff), the beat, the best, the cover
	const lever = ensureNode("./snake/lever", "stop")
	const speed = ensureNode("./snake/speed", 140)
	const best = ensureNode("./snake/best", 0)
	const cover = ensureNode("./snake/cover", "orange")
	const tape = ensureNode("./snake/tape", { at: 0, steps: [] as Step[] })

	// the tape. record(what, f): every write f makes to a tracked node is one step (its patches and
	// their inverse, as the change says them: op.undo), appended at `at`, the steps after it cut.
	// the tape's own writes are never on it. travel(to) goes back through the inverses, newest
	// first, or on through the patches, oldest first
	const MOST = 2000
	let recording: Write[] | undefined
	for (const [name, node] of Object.entries({ body, food, score, grow, dir, alive })) {
		// told as each write lands ({ timing: "write" }), so a tick's writes are in `recording` as it
		// ends; the inverse is in the node's own change (the world's change(x): its op.undo), the
		// patches are what the pipe is told
		pipe(node, (w) => {
			const op = (change(node) as { op?: { undo: readonly Patch[] } } | undefined)?.op
			if (recording && op) recording.push({ name, undo: op.undo, redo: w.patches })
		}, { timing: "write", name: `tape-${name}` })
	}
	const nodes: Record<string, Node> = { body, food, score, grow, dir, alive }
	function record(what: string, f: () => void) {
		if (recording) return f()
		recording = []
		try {
			f()
		} finally {
			const writes = recording
			recording = undefined
			if (writes.length) {
				const { at, steps } = got(tape) as Tape
				// the steps after where it is go; the oldest go past MOST
				const ps: Patch[] = [{
					path: ["steps"],
					range: [at, steps.length],
					value: [{ what, writes }],
				}]
				let next = at + 1
				if (next > MOST) (ps.push({ path: ["steps"], range: [0, next - MOST] }), next = MOST)
				ps.push({ path: ["at"], value: next })
				patch(tape, ps)
			}
		}
	}
	function travel(to: number) {
		const { at, steps } = got(tape) as Tape
		to = Math.max(0, Math.min(steps.length, Math.round(to)))
		let i = at
		while (i > to) {
			const { writes } = steps[--i]
			for (let k = writes.length - 1; k >= 0; k--) patch(nodes[writes[k].name], writes[k].undo)
		}
		while (i < to) for (const w of steps[i++].writes) patch(nodes[w.name], w.redo)
		if (to !== at) patch(tape, [{ path: ["at"], value: to }])
	}

	// one tick: everything it writes is one step of the tape
	function step() {
		const b = got(body)
		const was = got(dir)
		let d = got(want)
		if (d === OPPOSITE[was]) d = was
		if (d !== was) put(dir, d)
		let [x, y] = b[0]
		x += MOVES[d][0]
		y += MOVES[d][1]
		if (WRAP) (x = (x + W) % W, y = (y + H) % H)
		const growing = got(grow) > 0
		const hit = x < 0 || y < 0 || x >= W || y >= H ||
			b.some(([bx, by], i) => bx === x && by === y && (growing || i < b.length - 1))
		if (hit) return put(alive, false)
		const [fx, fy] = got(food)
		const ate = fx === x && fy === y
		// the head in front, the tail off the back unless it grows: two patches, not a new body
		patch(body, [
			{ path: [], range: [0, 0], value: [[x, y]] },
			...(!growing && !ate ? [{ path: [], range: [b.length, b.length + 1] } as Patch] : []),
		])
		if (growing) put(grow, got(grow) - 1)
		if (ate) {
			put(score, got(score) + 1)
			put(grow, got(grow) + GROW - 1)
			put(food, place(got(body)))
		}
	}
	function begin() {
		record("new game", () => {
			put(body, fresh())
			put(dir, "right")
			put(food, place(fresh()))
			put(score, 0)
			put(grow, 0)
			put(alive, true)
		})
		put(want, "right")
		put(lever, "play")
	}

	createAction("on/tick", () => {
		if (!got(alive) || got(lever) !== "play") return
		record("tick", step)
		// not on the tape: going back over a crash keeps the best, and does not play
		if (!got(alive)) {
			put(lever, "stop")
			if (got(score) > got(best)) put(best, got(score))
		}
	})
	createAction("on/turn", (d) => put(want, d))
	// the navi key: play and pause; after a crash, a new game
	createAction("on/navi", () => {
		if (!got(alive)) return begin()
		put(lever, got(lever) === "play" ? "stop" : "play")
	})
	// the lever: a crashed game does not play (crank back first, or navi for a new one)
	createAction("on/lever", (to) => {
		if (to === "play" && !got(alive)) return
		put(lever, to)
		put(want, got(dir))
	})
	// a step of winding (the clock, while the lever is at rew or ff): the end of the tape stops it
	createAction("on/wind", (by) => {
		const { at, steps } = got(tape)
		const to = at + by
		if (to < 0 || to > steps.length) return put(lever, "stop")
		travel(to)
		put(want, got(dir))
		if (to === 0 || to === steps.length) put(lever, "stop")
	})
	createAction("on/travel", (to) => {
		if (got(lever) !== "stop") put(lever, "stop")
		travel(to)
		put(want, got(dir))
	})
	createAction("on/new", () => begin())
	createAction("on/cover", (name) => put(cover, name))
	// the phone and the machine are hand-drawn elements with no handler of their own, and nothing
	// is open in a plain listener to call an action from: one jsx event on the stage, the same
	// action for all of them (name, ...args: the action it runs), whatever the event hit
	createAction("on/do", (name: string, ...args: unknown[]) => executeAction(`on/${name}`, ...args))
	// the crank, a click a tick or a wheel notch: the move is bounded by the tape as it is now
	createAction("on/nudge", (by: number) => {
		const { at, steps } = got(tape) as Tape
		const to = Math.max(0, Math.min(steps.length, at + by))
		if (to !== at) (executeAction("on/travel", to), click(audio, 1))
	})

	// ---- sound: made on the first press (a page may only make sound after one)
	const audio = keep("audio", () => ({ ctx: undefined as AudioContext | undefined }))
	const hear = () => {
		audio.ctx ??= new AudioContext()
		if (audio.ctx.state === "suspended") audio.ctx.resume()
	}

	// ---- the view: a stage scaled to fit, the phone and the machine on it. the phone and the
	// machine are drawn by hand (svg, a canvas): kept elements the jsx places. the covers are jsx
	const fitted: { view?: HTMLElement; stage?: HTMLElement } = {}
	const fit = () => {
		const { view, stage } = fitted
		if (!view || !stage) return
		const k = Math.min(innerWidth / 960, innerHeight / 760)
		stage.style.transform = `scale(${k})`
		view.style.width = `${960 * k}px`
		view.style.height = `${760 * k}px`
	}
	onresize = fit

	// ---- the phone
	const phone = keep("phone", () => {
		const p = el("div", "phone")
		p.innerHTML = phoneSvg() +
			`<canvas class="lcd" width="${84 * 6}" height="${
				48 * 6
			}"></canvas><div class="glass"></div>`
		return p
	})
	// a cover a button: ringed while it is the one on (bound to /game/cover), pressed: a call
	const covers = (
		<div class="covers">
			<span class="tag">covers</span>
			{Object.entries(COVERS).map(([k, c]) => (
				<button
					data-cover={k}
					title={c.name}
					aria-label={c.name}
					style={`background:${
						k === "lemon" ? `linear-gradient(135deg, #ffff88 50%, #ff2284 50%)` : c.body
					}`}
					class={bind("cover", (name) => (name === k ? "on" : ""))}
					onClick={handler("on/cover", () => (hear(), [k]))}
				/>
			))}
		</div>
	)

	// the keys: the drawn ones and the keyboard's, each shown pressed
	const flash = (k) => {
		const key = phone.querySelector(`[data-key="${k}"]`)
		if (!key) return
		key.classList.add("down")
		setTimeout(() => key.classList.remove("down"), 140)
	}
	// a press: the call it makes (name, ...args for on/do), none for a key with no use
	const press = (k: string): [string, ...unknown[]] | undefined => {
		hear()
		flash(k)
		if (TURN[k]) return ["turn", TURN[k]]
		if (k === "navi") return ["navi"]
		if (k === "c" || k === "down") return ["nudge", -1]
		if (k === "up") return ["nudge", 1]
	}
	// a press keeps the focus off the svg (no outline), but in this page: the keyboard goes on working
	phone.tabIndex = -1

	// the screen: 84 by 48 dots. an effect makes the picture; a frame loop fades each dot toward
	// it, the way that screen was slow to change
	const lcd = keep(
		"lcd",
		() => ({ target: new Uint8Array(84 * 48), level: new Float32Array(84 * 48), fresh: true }),
	)
	const canvas = phone.querySelector("canvas") as HTMLCanvasElement
	const g = canvas.getContext("2d")
	const ghost = ghosts()
	lcd.fresh = true
	let raf = requestAnimationFrame(function loop() {
		paint(lcd, g, ghost)
		raf = requestAnimationFrame(loop)
	})
	addTeardown(() => cancelAnimationFrame(raf))
	createEffect("screen", () => {
		const { at, steps } = read(tape) as Tape
		return [
			[...(read(body) as number[][])],
			[...(read(food) as number[])],
			read(dir),
			read(alive),
			read(score),
			read(lever),
			at,
			steps.length,
		]
	}, (now, was) => {
		lcd.target.set(picture(now as Parameters<typeof picture>[0]))
		// a crash buzzes: playing into it, or cranking over it
		if (was && was[3] && !now[3]) buzz(phone, audio)
		if (was && now[4] > was[4] && now[5] === "play") beep(audio)
	}, { equal: same })
	createEffect("look", () => read(cover), (name, was) => {
		const c = COVERS[name] ?? COVERS.orange
		for (const k of ["body", "edge", "panel", "keys", "ink", "logo"]) {
			phone.style.setProperty(`--${k}`, c[k])
		}
		if (was !== undefined && was !== name) {
			phone.classList.remove("snap")
			void phone.offsetWidth
			phone.classList.add("snap")
		}
	})

	// ---- the time machine
	const machine = keep("machine", () => {
		const m = el("div", "machine")
		m.innerHTML = machineHtml()
		return m
	})
	const $ = (q) => machine.querySelector(q)
	const strip = $(".strip") as HTMLElement
	const reader = $(".strip .read") as HTMLElement
	const ticket = $(".ticket") as HTMLElement
	const columns = new WeakMap()

	const crank = $(".crank") as SVGElement
	const leverEl = $(".lever") as SVGElement
	const arm = $(".lever .arm") as SVGElement
	const nearest = (e: PointerEvent) => {
		const r = leverEl.getBoundingClientRect()
		const px = r.left + r.width / 2, py = r.top + r.height * (152 / 170)
		const a = (Math.atan2(e.clientX - px, py - e.clientY) * 180) / Math.PI
		return Object.entries(LEVER).sort((x, y) => Math.abs(x[1] - a) - Math.abs(y[1] - a))[0][0]
	}
	// where the lever is drawn once the game says so (the machine effect sets it)
	let shown = "stop"

	// the events of the phone and the machine, all heard on the stage (nothing is open in a plain
	// listener to call an action from): each gives the call it makes, or none. the crank: a turn of
	// 15 degrees is a tick of the tape, and it will not wind past either end (the action bounds it).
	// the lever: click or drag it to a position
	let turning: { cx: number; cy: number; last: number; turned: number } | undefined
	let leaning = false
	const angle = (e: PointerEvent) => {
		if (!turning) return 0
		return (Math.atan2(e.clientY - turning.cy, e.clientX - turning.cx) * 180) / Math.PI
	}
	const onDown = (e: PointerEvent) => {
		const t = e.target as Element
		phone.focus({ preventScroll: true })
		const key = t.closest(".key") as HTMLElement | null
		if (key && phone.contains(key)) {
			e.preventDefault()
			return press(key.dataset.key!)
		}
		if (t.closest(".crank")) {
			hear()
			const r = crank.getBoundingClientRect()
			turning = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, last: 0, turned: 0 }
			turning.last = angle(e)
			crank.setPointerCapture(e.pointerId)
		} else if (t.closest(".lever")) {
			hear()
			leaning = true
			leverEl.setPointerCapture(e.pointerId)
		}
	}
	const onMove = (e: PointerEvent) => {
		if (turning) {
			let d = angle(e) - turning.last
			if (d > 180) d -= 360
			if (d < -180) d += 360
			turning.last = angle(e)
			turning.turned += d
			const n = Math.trunc(turning.turned / 15)
			if (!n) return
			turning.turned -= n * 15
			return ["nudge", n]
		}
		if (leaning) arm.style.transform = `rotate(${LEVER[nearest(e)]}deg)`
	}
	const onUp = (e: PointerEvent) => {
		turning = undefined
		if (!leaning) return
		leaning = false
		// a lever the game would not move goes back where it was drawn
		setTimeout(() => (arm.style.transform = `rotate(${LEVER[shown] ?? LEVER.stop}deg)`), 60)
		return ["lever", nearest(e)]
	}
	const onKey = (e: KeyboardEvent) => {
		const k = KEYS[e.key] ?? (/^[0-9*#]$/.test(e.key) ? e.key : undefined)
		if (!k || e.metaKey || e.ctrlKey) return
		e.preventDefault()
		return press(k)
	}
	const onWheel = (e: WheelEvent) => {
		if (!(e.target as Element).closest(".crank")) return
		e.preventDefault()
		hear()
		return ["nudge", e.deltaY > 0 ? 1 : -1]
	}
	// the stage's events call the action with (name, ...args), or nothing
	const onStage = (f: (e: any) => unknown[] | undefined | void) => handler("on/do", f as never)

	// everything on the machine is the tape node, the lever and the beat
	// (the tape is changed in place: what it was is read out here, at, its steps and the last one)
	createEffect(
		"machine",
		() => {
			const tp = read(tape) as Tape
			return [
				tp.at,
				tp.steps,
				tp.steps[tp.steps.length - 1],
				read(lever),
				Number(read(speed)) || 140,
			]
		},
		([at, steps, _last, lv, ms], was) => {
			const live = at === steps.length
			$(".lamp.now").classList.toggle("on", live)
			$(".lamp.past").classList.toggle("on", !live)
			odometer($(".odo.now .wheels"), at)
			odometer($(".odo.far .wheels"), steps.length)
			// the beat: a needle from slow (left) to quick (right)
			const needle = Math.max(-70, Math.min(70, 70 - ((ms - 40) / 360) * 140))
			;($(".gauge .needle") as SVGElement).style.transform = `rotate(${needle}deg)`
			$(".gauge .ms").textContent = `${ms} MS`
			shown = lv
			arm.style.transform = `rotate(${LEVER[lv] ?? LEVER.stop}deg)`
			// the gears and the crank turn a tooth a tick; the reels with the paper on them
			const turn = at * 15
			spin($(".crank .dial"), turn)
			spin($(".gear.big"), turn)
			spin($(".gear.small"), -turn * 2.4 + 18)
			spin($(".gear.tiny"), -turn * 3 + 22.5)
			const wound = (n) => Math.min(48, 14 + Math.sqrt(n) * 1.5)
			$(".reel.left .wound").setAttribute("r", String(wound(at)))
			$(".reel.right .wound").setAttribute("r", String(wound(Math.max(0, 900 - at))))
			spin($(".reel.left .hub"), -at * 24)
			spin($(".reel.right .hub"), -at * 24)
			// the paper: the steps near the reader, punched from their patches
			drawTape(at, steps)
			// the reader: which way it went, and what it read
			const back = was && at < was[0]
			const forth = was && at > was[0]
			if (back || forth) {
				const lamp = $(back ? ".head .back" : ".head .fwd")
				lamp.classList.add("on")
				setTimeout(() => lamp.classList.remove("on"), 90)
				const n = back ? at : at - 1
				ticket.innerHTML = readout(steps[n], n, back)
			} else if (!was) ticket.innerHTML = at ? readout(steps[at - 1], at - 1, false) : idle()
		},
		{ equal: same },
	)

	function drawTape(at, steps) {
		strip.style.transform = `translateX(${
			(machine.querySelector(".paper") as HTMLElement).clientWidth / 2 - at * STEP
		}px)`
		reader.style.width = `${at * STEP}px`
		const lo = Math.max(0, at - 24), hi = Math.min(steps.length, at + 24)
		const keep = new Set<Element>()
		for (let i = lo; i < hi; i++) {
			let col = columns.get(steps[i])
			if (!col) columns.set(steps[i], col = punch(steps[i]))
			col.style.left = `${i * STEP}px`
			keep.add(col)
		}
		for (let i = Math.ceil(lo / 10) * 10; i < at + 24; i += 10) {
			const no = el("span", "no", String(i))
			no.style.left = `${i * STEP}px`
			keep.add(no)
		}
		for (const c of [...strip.children]) if (c !== reader && !keep.has(c)) c.remove()
		for (const c of keep) if (c.parentNode !== strip) strip.append(c)
	}

	// a step's column: a hole a patch, on its node's track; the patches above, the inverses below
	function punch(step) {
		const col = el("div", "col" + (step.what === "tick" ? "" : " new"))
		col.title = step.what
		for (const w of step.writes) {
			const k = TRACKS.indexOf(w.name)
			if (k < 0) continue
			w.redo.forEach((p, j) => col.append(hole(k, false, p, j)))
			w.undo.forEach((p, j) => col.append(hole(k, true, p, j)))
		}
		return col
	}
	function hole(k, under, p, j) {
		const h = el("i", "h" + ("value" in p ? "" : " out") + (under ? " under" : ""))
		h.style.top = `${(under ? 55 : 5) + k * 7}px`
		h.style.left = `${1 + j * 5}px`
		h.title = (under ? "inverse: " : "patch: ") + say(p)
		return h
	}
	function readout(step, n, back) {
		if (!step) return idle()
		const lines = step.writes.map((w) =>
			`<b>${w.name}</b> ${(back ? w.undo : w.redo).map(say).join(", ")}`
		)
		return `<span class="${back ? "back" : "fwd"}">${
			back ? "▼ read back" : "▲ read"
		}</span> step ${n + 1} (${step.what}${back ? ", its inverses" : ""}): ${lines.join(" · ")}`
	}
	function idle() {
		return `the reader reads each step as the tape goes by: the patches going on, their inverses going back<small>tracks, top to bottom: ${
			TRACKS.join(" · ")
		} · above the line the patches, below it the inverses · a ring is a removal</small>`
	}

	return (
		<div
			class="fit"
			tabIndex={-1}
			ref={(e) => {
				fitted.view = e
				fit()
				e.focus({ preventScroll: true })
			}}
			onPointerDown={onStage(onDown)}
			onPointerMove={onStage(onMove)}
			onPointerUp={onStage(onUp)}
			onPointerCancel={onStage(onUp)}
			onKeyDown={onStage(onKey)}
			onWheel={onStage(onWheel)}
		>
			<div class="stage" ref={(e) => (fitted.stage = e)}>
				<div>
					{phone}
					{covers}
				</div>
				{machine}
			</div>
		</div>
	)
}

// the clock: ticks the game while the lever is at play; winds the tape while it is at rew or ff,
// three times as quick. a second process, reading the game's nodes: a new lever or a new beat, and
// the interval it says is written at its own every (/clock/every). a timer cannot call into the graph, so the host's
// timer (host.ts) is the metronome: it runs /clock/on/beat at that interval, and the beat does the
// ticking or the winding
export function clock() {
	const every = ensureNode("every", 0)
	createEffect("beat", () => {
		const lv = read("/snake/lever")
		const ms = read("/snake/speed")
		return [lv ?? "stop", ms ? Math.max(40, Number(ms) || 140) : 140] as [string, number]
	}, ([lv, ms]) => {
		patch(every, [{
			path: [],
			value: lv === "play" ? ms : lv === "rew" || lv === "ff" ? Math.max(35, ms / 3) : 0,
		}])
	}, { equal: same })
	createAction("on/beat", () => {
		const lv = peep(() => read("/snake/lever"))
		if (lv === "play") executeAction("/game/on/tick")
		if (lv === "rew" || lv === "ff") executeAction("/game/on/wind", lv === "rew" ? -1 : 1)
	})
}

// ---- the screen ----

// the picture, from the game: the score and a sign along the top, the field in a box below
function picture([b, f, d, live, score, lv, at, length]) {
	const px = new Uint8Array(84 * 48)
	const dot = (x, y, on = 1) => {
		if (x >= 0 && x < 84 && y >= 0 && y < 48) px[y * 84 + x] = on
	}
	const text = (s, x, y) => {
		for (const ch of s) {
			const glyph = FONT[ch] ?? FONT["?"]
			glyph.split("|").forEach((row, r) =>
				[...row].forEach((c, k) => c === "#" && dot(x + k, y + r))
			)
			x += 4
		}
	}
	text(String(score).padStart(4, "0"), 0, 0)
	const sign = lv === "rew" ? "<<" : lv === "ff" ? ">>" : lv === "stop" && live ? "II" : ""
	if (sign === "II") {
		for (let y = 0; y < 5; y++) {
			;(dot(78, y), dot(79, y), dot(82, y), dot(83, y))
		}
	} else text(sign, 77, 0)
	for (let x = 0; x < 84; x++) (dot(x, 5), dot(x, 47))
	for (let y = 5; y < 48; y++) (dot(0, y), dot(83, y))
	// a cell is 4 dots: 3 lit and a gap, the gap filled toward the next piece of snake
	const X = (cx) => 2 + cx * 4, Y = (cy) => 7 + cy * 4
	const block = (cx, cy) => {
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) dot(X(cx) + i, Y(cy) + j)
	}
	b.forEach(([cx, cy], i) => {
		block(cx, cy)
		const next = b[i + 1]
		if (!next) return
		const [nx, ny] = next
		if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) return
		for (let k = 0; k < 3; k++) {
			if (nx !== cx) dot(Math.max(X(cx), X(nx)) - 1, Y(cy) + k)
			else dot(X(cx) + k, Math.max(Y(cy), Y(ny)) - 1)
		}
	})
	// the head: an eye, looking the way it goes; crashed, a cross
	const [hx, hy] = b[0]
	const [mx, my] = MOVES[d]
	if (live) dot(X(hx) + 1 + (my ? 0 : mx), Y(hy) + 1 + (mx ? 0 : my), 0)
	else {
		;(dot(X(hx), Y(hy), 0),
			dot(X(hx) + 2, Y(hy), 0),
			dot(X(hx), Y(hy) + 2, 0),
			dot(X(hx) + 2, Y(hy) + 2, 0))
	}
	// the cherry: a little diamond
	const [fx, fy] = f
	for (const [i, j] of [[1, 0], [0, 1], [2, 1], [1, 2]]) dot(X(fx) + i, Y(fy) + j)
	// a word in a box, when it is not playing
	const say = !live
		? ["GAME OVER", "CRANK BACK"]
		: lv !== "stop"
		? []
		: !length
		? ["SNAKE II", "PRESS NAVI"]
		: at < length
		? ["TIME TRAVEL", `STEP ${at}`]
		: ["PAUSED"]
	if (say.length) {
		const w = Math.max(...say.map((s) => s.length * 4 - 1)) + 6, h = say.length * 7 + 4
		const x0 = Math.floor((84 - w) / 2), y0 = 7 + Math.floor((40 - h) / 2)
		for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) dot(x, y, 0)
		for (let x = x0; x < x0 + w; x++) (dot(x, y0), dot(x, y0 + h - 1))
		for (let y = y0; y < y0 + h; y++) (dot(x0, y), dot(x0 + w - 1, y))
		say.forEach((s, i) => text(s, x0 + Math.floor((w - (s.length * 4 - 1)) / 2), y0 + 3 + i * 7))
	}
	return px
}

// the unlit dots: the faint grid a screen like that always shows
function ghosts() {
	const c = document.createElement("canvas")
	c.width = 84 * 6
	c.height = 48 * 6
	const g = c.getContext("2d")!
	g.fillStyle = "rgba(28, 44, 20, 0.085)"
	for (let y = 0; y < 48; y++) for (let x = 0; x < 84; x++) g.fillRect(x * 6, y * 6, 5, 5)
	return c
}

// a frame: each dot a little nearer its picture (on quick, off slow), drawn when anything moved
function paint(lcd, g, ghost) {
	let moved = lcd.fresh
	for (let i = 0; i < lcd.level.length; i++) {
		const want = lcd.target[i], was = lcd.level[i]
		if (want === was) continue
		const next = was + (want - was) * (want > was ? 0.6 : 0.3)
		lcd.level[i] = Math.abs(want - next) < 0.03 ? want : next
		moved = true
	}
	if (!moved) return
	lcd.fresh = false
	g.clearRect(0, 0, 84 * 6, 48 * 6)
	g.drawImage(ghost, 0, 0)
	g.fillStyle = "#17203a"
	for (let i = 0; i < lcd.level.length; i++) {
		const v = lcd.level[i]
		if (v < 0.03) continue
		g.globalAlpha = Math.min(1, v) * 0.92
		g.fillRect((i % 84) * 6, Math.floor(i / 84) * 6, 5, 5)
	}
	g.globalAlpha = 1
}

// ---- the phone, drawn from photographs of real 3210s (Wikimedia Commons), in the coordinates of
// the straight-on one, 814 by 2000 (Nokia_3210_3.jpg at that size): every part measured there.
//   https://commons.wikimedia.org/wiki/File:Nokia_3210_3.jpg (the one measured)
//   https://commons.wikimedia.org/wiki/File:Nokia_3210.jpg
//   https://commons.wikimedia.org/wiki/File:Nokia_3210_with_display_content.jpg
//   https://commons.wikimedia.org/wiki/File:Nokia_3210_(9136307576).jpg (a green cover: colour
//   to the edges, the silver panel round the screen and the keys under it)
// the outline: the body's half width at each height, from the photo, smoothed through
const HALF = [
	[6, 0],
	[10, 131],
	[20, 192],
	[30, 236],
	[50, 295],
	[80, 328],
	[120, 349],
	[220, 367],
	[320, 380],
	[420, 390],
	[520, 400],
	[670, 404],
	[820, 400],
	[920, 393],
	[1020, 383],
	[1120, 372],
	[1220, 369],
	[1420, 368],
	[1570, 365],
	[1870, 361],
	[1920, 349],
	[1950, 325],
	[1970, 302],
	[1990, 274],
	[1997, 250],
	[2000, 0],
]
// the silver panel: round the earpiece, the wordmark, the screen, down under the keys below it
const PANEL = [
	[404, 30],
	[560, 35],
	[652, 52],
	[712, 92],
	[742, 150],
	[753, 260],
	[758, 420],
	[759, 600],
	[754, 780],
	[740, 880],
	[722, 952],
	[690, 1010],
	[640, 1080],
	[565, 1156],
	[500, 1192],
	[404, 1208],
	[300, 1190],
	[222, 1150],
	[160, 1092],
	[108, 1018],
	[86, 955],
	[62, 880],
	[50, 780],
	[46, 600],
	[48, 420],
	[55, 260],
	[66, 150],
	[96, 92],
	[156, 52],
	[248, 35],
]
// a closed curve through points (catmull-rom, as cubic béziers)
function smooth(pts) {
	const n = pts.length, p = (i) => pts[(i + n) % n]
	let d = `M${p(0)[0]} ${p(0)[1]}`
	for (let i = 0; i < n; i++) {
		const [a, b, c, e] = [p(i - 1), p(i), p(i + 1), p(i + 2)]
		const c1 = [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6]
		const c2 = [c[0] - (e[0] - b[0]) / 6, c[1] - (e[1] - b[1]) / 6]
		d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${
			c[0]
		} ${c[1]}`
	}
	return d + " Z"
}
const outline = (inset = 0) =>
	smooth([
		...HALF.slice(0, -1).map((
			[y, h],
		) => [404 + Math.max(0, h - inset), y + (y < 400 ? inset : y > 1900 ? -inset : 0)]),
		...HALF.slice(1).reverse().map((
			[y, h],
		) => [404 - Math.max(0, h - inset), y + (y < 400 ? inset : y > 1900 ? -inset : 0)]),
	])
// a key in its socket: a rounded slab, a little curved top and bottom, the digit and its letters
function keySvg(k, x, y, w, rot, digit, letters) {
	const h = 90, r = 36
	const slab = (g) =>
		`M${-w / 2 + r - g} ${-h / 2 - g} Q0 ${-h / 2 - 7 - g} ${w / 2 - r + g} ${-h / 2 - g} A${
			r + g
		} ${r + g} 0 0 1 ${w / 2 - r + g} ${h / 2 + g} Q0 ${h / 2 + 5 + g} ${-w / 2 + r - g} ${
			h / 2 + g
		} A${r + g} ${r + g} 0 0 1 ${-w / 2 + r - g} ${-h / 2 - g} Z`
	const label = digit === "1"
		? `<tspan class="digit">1</tspan><tspan class="letters" dx="6"> </tspan>`
		: `<tspan class="digit">${digit}</tspan><tspan class="letters" dx="3">${letters}</tspan>`
	const voicemail = digit === "1"
		? `<g fill="none" stroke="var(--ink)" stroke-width="3.5"><circle cx="4" cy="11" r="9"/><circle cx="32" cy="11" r="9"/><path d="M4 20 H32"/></g>`
		: ""
	return `<g transform="translate(${x} ${y}) rotate(${rot})"><path class="socket" d="${
		slab(6)
	}"/><g class="key" data-key="${k}"><g class="cap"><path class="keycap" d="${
		slab(0)
	}"/><path class="shine" d="${slab(-10)}"/><text class="label" x="${
		digit === "1" ? -24 : 0
	}" y="21">${label}</text>${voicemail}</g></g></g>`
}
function phoneSvg() {
	const rows = [["1", "", "2", "abc", "3", "def"], ["4", "ghi", "5", "jkl", "6", "mno"], [
		"7",
		"pqrs",
		"8",
		"tuv",
		"9",
		"wxyz",
	], ["*", "+", "0", "␣", "#", "⇧"]]
	let keys = ""
	rows.forEach((row, r) => {
		const y = 1290 + r * 150
		keys += keySvg(row[0], 192, y, 172, 2, row[0], row[1])
		keys += keySvg(row[2], 407, y + 10, 184, 0, row[2], row[3])
		keys += keySvg(row[4], 616, y - 2, 168, -2, row[4], row[5])
	})
	// the earpiece: two wavy grooves, each with four holes
	const groove = (dy) =>
		[" groove", " groove lit"].map((c) =>
			`<path d="M305 ${196 + dy} C330 ${190 + dy} 345 ${214 + dy} 372 ${214 + dy} C395 ${
				214 + dy
			} 400 ${204 + dy} 418 ${204 + dy} C438 ${204 + dy} 445 ${215 + dy} 466 ${215 + dy} C490 ${
				215 + dy
			} 500 ${195 + dy} 515 ${197 + dy}" class="${c}"/>`
		).join("") +
		[[323, 206], [372, 213], [447, 213], [494, 206]].map(([x, y]) =>
			`<ellipse cx="${x}" cy="${y + dy}" rx="10" ry="5" class="hole"/>`
		).join("")
	return `<svg class="body" width="${814 * K}" height="${2000 * K}" viewBox="0 0 814 2000">
	<defs>
		<linearGradient id="sheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset=".12" stop-color="#fff" stop-opacity=".08"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset=".9" stop-color="#000" stop-opacity=".05"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient>
		<linearGradient id="panelshade" x1="0" y1="0" x2="1" y2=".4"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></linearGradient>
		<linearGradient id="silver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".45" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
		<filter id="fleck" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="7"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  6 0 0 0 -4.3"/></filter>
		<clipPath id="bodyclip"><path d="${outline(14)}"/></clipPath>
	</defs>
	<path class="edge" d="${outline()}"/>
	<path class="cover" d="${outline(14)}"/>
	<rect width="814" height="2000" filter="url(#fleck)" clip-path="url(#bodyclip)" opacity=".28" pointer-events="none"/>
	<path d="${outline(14)}" fill="url(#sheen)" pointer-events="none"/>
	<path class="panel" d="${smooth(PANEL)}"/>
	<path d="${smooth(PANEL)}" fill="url(#panelshade)" pointer-events="none"/>
	${groove(0)}${groove(80)}
	<text class="logo" x="411" y="418" text-anchor="middle" textLength="238" lengthAdjust="spacingAndGlyphs">NOKIA</text>
	<path class="recess" d="M97 492 Q97 440 150 440 L672 440 Q725 440 725 492 L725 838 Q725 895 668 895 L154 895 Q97 895 97 838 Z"/>
	<path class="window" d="M125 502 Q125 461 166 461 L658 461 Q699 461 699 502 L699 846 Q699 870 675 870 L149 870 Q125 870 125 846 Z"/>
	<rect x="137" y="472" width="554" height="388" rx="10" fill="#0b0c0e"/>
	<path d="M300 893 Q412 903 560 893" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="5" stroke-linecap="round"/>
	<g transform="translate(172 1036) rotate(24)"><ellipse class="socket" rx="86" ry="60"/><g class="key" data-key="c"><g class="cap"><ellipse class="keycap" rx="76" ry="50"/><ellipse class="shine" rx="62" ry="36"/><text class="label" x="2" y="16" transform="rotate(-24)"><tspan class="digit">C</tspan></text></g></g></g>
	<g transform="translate(412 1017)"><ellipse class="socket" rx="133" ry="59"/><g class="key" data-key="navi"><g class="cap"><ellipse class="keycap" rx="122" ry="48"/><ellipse class="shine" rx="106" ry="34"/><path d="M-50 0 H54" stroke="#5cadc1" stroke-width="8" stroke-linecap="round"/></g></g></g>
	<g transform="translate(614 1083) rotate(-42)"><ellipse class="socket" rx="140" ry="74"/><ellipse class="face" rx="132" ry="66"/>
		<g class="key" data-key="up"><g class="cap"><path class="face" d="M0 -66 A132 66 0 0 1 0 66 Z"/><path d="M84 0 L56 -12 L56 12 Z" fill="var(--ink)"/></g></g>
		<g class="key" data-key="down"><g class="cap"><path class="face" d="M0 66 A132 66 0 0 1 0 -66 Z"/><path d="M-84 0 L-56 -12 L-56 12 Z" fill="var(--ink)"/></g></g>
		<ellipse class="shine" rx="114" ry="52" pointer-events="none"/>
		<ellipse rx="132" ry="66" fill="none" stroke="#000" stroke-width="2.5" pointer-events="none"/>
	</g>
	${keys}
	<g class="zz" fill="none" stroke="#000" stroke-width="7" stroke-linecap="round">
		<path d="M-6 940 q-20 40 0 80 M-24 915 q-28 65 0 130"/><path d="M820 940 q20 40 0 80 M838 915 q28 65 0 130"/>
	</g>
</svg>`
}

// ---- the machine, drawn ----
function machineHtml() {
	const wheels = () =>
		Array.from({ length: 5 }, () => `<span class="wheel"><b>0</b></span>`).join("")
	const reel = (side, cx) =>
		`<g class="reel ${side}"><circle cx="${cx}" cy="84" r="56" fill="#c9963a" stroke="#000" stroke-width="1.2"/><circle cx="${cx}" cy="84" r="52" fill="#3a2e22" stroke="#000" opacity=".25"/><circle class="wound" cx="${cx}" cy="84" r="30" fill="#fdf1cc" stroke="#7a6440"/><g class="hub spin" style="transform-origin:${cx}px 84px"><circle cx="${cx}" cy="84" r="12" fill="#e7c66f" stroke="#000"/>${
			[0, 120, 240].map((a) =>
				`<circle cx="${cx + Math.cos((a * Math.PI) / 180) * 6.5}" cy="${
					84 + Math.sin((a * Math.PI) / 180) * 6.5
				}" r="2.4" fill="#3a2e22"/>`
			).join("")
		}<rect x="${cx - 1}" y="${
			84 - 30
		}" width="2" height="18" fill="#7a6440" opacity=".5"/></g></g>`
	return `
	<div class="plate brass"><span class="rivet"></span><span class="name">the time machine<small>reads the tape · model 3210-t</small></span><span class="fill"></span>
		<span class="lamp now"><i></i>NOW</span><span class="lamp past"><i></i>PAST</span><span class="rivet"></span></div>
	<div class="dials">
		<div class="odo now"><label>NOW</label><div class="wheels brass">${wheels()}</div></div>
		<svg class="gauge" width="130" height="88" viewBox="0 0 130 88">
			<path d="M8 68 A57 57 0 0 1 122 68 Z" fill="#fff" stroke="#000"/>
			${
		Array.from({ length: 9 }, (_, i) => {
			const a = ((-70 + i * 17.5 - 90) * Math.PI) / 180
			return `<line x1="${65 + Math.cos(a) * 46}" y1="${68 + Math.sin(a) * 46}" x2="${
				65 + Math.cos(a) * 54
			}" y2="${68 + Math.sin(a) * 54}" stroke="#000" stroke-width="${i % 4 ? 1 : 2}"/>`
		}).join("")
	}
			<text x="16" y="62">SLOW</text><text x="92" y="62">QUICK</text><text class="ms" x="65" y="86" text-anchor="middle">140 MS</text>
			<g class="needle spin" style="transform-origin:65px 68px"><line x1="65" y1="68" x2="65" y2="20" stroke="#ff2284" stroke-width="2.4" stroke-linecap="round"/></g>
			<circle cx="65" cy="68" r="5" fill="#d3a24a" stroke="#000"/><text x="65" y="10" text-anchor="middle">BEAT</text>
		</svg>
		<div class="odo far"><label>FURTHEST</label><div class="wheels brass">${wheels()}</div></div>
	</div>
	<div class="deck">
		<svg class="reels" width="546" height="166" viewBox="0 0 546 166">${reel("left", 56)}${
		reel("right", 490)
	}</svg>
		<div class="paper"><div class="strip"><div class="read"></div></div><div class="line"></div></div>
		<div class="head brass"><i class="fwd" title="reading the patches"></i><span class="slot"></span><i class="back" title="reading the inverses"></i></div>
	</div>
	<div class="ticket"></div>
	<div class="works">
		<svg width="330" height="300" viewBox="0 0 330 300" style="left:0;top:0">
			${gearSvg("gear big spin", 140, 160, 24, 118, "#d3a24a")}
			${gearSvg("gear small spin", 284, 93, 10, 50, "#e7c66f")}
			${gearSvg("gear tiny spin", 254, 256, 8, 40, "#c9963a")}
			<g class="crank">
				<circle cx="140" cy="160" r="92" fill="#0000"/>
				<g class="dial spin" style="transform-origin:140px 160px">
					<circle cx="140" cy="160" r="92" fill="#fff8e6" stroke="#000" stroke-width="1.4"/>
					${
		Array.from({ length: 24 }, (_, i) => {
			const a = (i * 15 * Math.PI) / 180
			return `<line x1="${140 + Math.cos(a) * 80}" y1="${160 + Math.sin(a) * 80}" x2="${
				140 + Math.cos(a) * 89
			}" y2="${160 + Math.sin(a) * 89}" stroke="#000" stroke-width="${i % 6 ? 1 : 2.4}"/>`
		}).join("")
	}
					<circle cx="140" cy="160" r="30" fill="#d3a24a" stroke="#000"/>
					<path d="M140 160 L140 88" stroke="#000" stroke-width="13" stroke-linecap="round"/>
					<path d="M140 160 L140 88" stroke="#e7c66f" stroke-width="10" stroke-linecap="round"/>
					<circle cx="140" cy="84" r="16" fill="#ff2284" stroke="#000" stroke-width="1.4"/>
					<circle cx="135" cy="79" r="5" fill="#fff" opacity=".55"/>
					<circle cx="140" cy="160" r="8" fill="#a87a2c" stroke="#000"/>
				</g>
			</g>
		</svg>
		<svg class="lever" width="210" height="170" viewBox="0 0 210 170" style="right:0;top:24px">
			<path d="M27 152 A78 78 0 0 1 183 152 L157 152 A52 52 0 0 0 53 152 Z" fill="#fff8e6" stroke="#000"/>
			${
		Object.entries(LEVER).map(([k, a]) => {
			const r = ((a - 90) * Math.PI) / 180
			const anchor = a < -30 ? "start" : a > 30 ? "end" : "middle"
			return `<text x="${105 + Math.cos(r) * 118}" y="${
				152 + Math.sin(r) * 118 + 4
			}" style="text-anchor:${anchor}">${
				{ rew: "◀◀ REW", stop: "■ STOP", play: "▶ PLAY", ff: "FF ▶▶" }[k]
			}</text><circle cx="${105 + Math.cos(r) * 65}" cy="${
				152 + Math.sin(r) * 65
			}" r="3" fill="#000"/>`
		}).join("")
	}
			<g class="arm" style="transform-origin:105px 152px">
				<line x1="105" y1="152" x2="105" y2="72" stroke="#000" stroke-width="9" stroke-linecap="round"/>
				<line x1="105" y1="152" x2="105" y2="72" stroke="#e7c66f" stroke-width="6" stroke-linecap="round"/>
				<circle cx="105" cy="68" r="13" fill="#40dcba" stroke="#000" stroke-width="1.4"/>
				<circle cx="101" cy="64" r="4" fill="#fff" opacity=".6"/>
			</g>
			<circle cx="105" cy="152" r="10" fill="#d3a24a" stroke="#000"/>
		</svg>
		<div class="how"><b>crank</b>: travel, a click a tick · <b>lever</b>: play, rewind, fast-forward · <b>2 4 6 8</b> or arrows steer · <b>navi</b> (space) plays · <b>C</b> a tick back</div>
	</div>`
}

// a gear: teeth round a wheel, a hole and spokes, turning about its centre
function gearSvg(cls, cx, cy, teeth, r, fill) {
	const depth = 9, step = (Math.PI * 2) / teeth
	const pt = (rad, a) =>
		`${(cx + Math.cos(a) * rad).toFixed(1)} ${(cy + Math.sin(a) * rad).toFixed(1)}`
	let d = ""
	for (let i = 0; i < teeth; i++) {
		const a = i * step
		d += `${i ? "L" : "M"}${pt(r - depth, a - step * 0.5)} L${pt(r - depth, a - step * 0.28)} L${
			pt(r, a - step * 0.16)
		} L${pt(r, a + step * 0.16)} L${pt(r - depth, a + step * 0.28)} `
	}
	const spokes = [0, 1, 2, 3, 4].map((i) => {
		const a = (i * 2 * Math.PI) / 5
		return `<circle cx="${cx + Math.cos(a) * r * 0.5}" cy="${cy + Math.sin(a) * r * 0.5}" r="${
			r * 0.15
		}" fill="#fff8e6" stroke="#000"/>`
	}).join("")
	return `<g class="${cls}" style="transform-origin:${cx}px ${cy}px"><path d="${d}Z" fill="${fill}" stroke="#000" stroke-width="1.2"/>${spokes}<circle cx="${cx}" cy="${cy}" r="${
		r * 0.14
	}" fill="#8a6420" stroke="#000"/></g>`
}

// five wheels rolling to a number
function odometer(box, n) {
	const digits = String(Math.min(99999, n)).padStart(5, "0")
	box.querySelectorAll(".wheel").forEach((w, i) => {
		let b = w.firstElementChild
		if (b.childElementCount !== 10) {
			b.innerHTML = Array.from(
				{ length: 10 },
				(_, d) => `<span style="display:block">${d}</span>`,
			).join("")
		}
		b.style.transform = `translateY(${-Number(digits[i]) * 34}px)`
	})
}

const spin = (e, deg) => e && (e.style.transform = `rotate(${deg}deg)`)

// ---- sound: a click for a tick of the crank, a beep for a cherry, a buzz for a crash ----
function click(audio, n) {
	const ctx = audio.ctx
	if (!ctx) return
	for (let i = 0; i < Math.min(n, 5); i++) {
		const t0 = ctx.currentTime + i * 0.03
		const o = ctx.createOscillator(), g = ctx.createGain()
		o.type = "square"
		o.frequency.setValueAtTime(2200, t0)
		o.frequency.exponentialRampToValueAtTime(500, t0 + 0.018)
		g.gain.setValueAtTime(0.05, t0)
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.025)
		o.connect(g).connect(ctx.destination)
		o.start(t0)
		o.stop(t0 + 0.03)
	}
}
function beep(audio) {
	const ctx = audio.ctx
	if (!ctx) return
	const o = ctx.createOscillator(), g = ctx.createGain()
	o.type = "square"
	o.frequency.value = 1320
	g.gain.setValueAtTime(0.035, ctx.currentTime)
	g.gain.setValueAtTime(0, ctx.currentTime + 0.06)
	o.connect(g).connect(ctx.destination)
	o.start()
	o.stop(ctx.currentTime + 0.07)
}
function buzz(phone, audio) {
	phone.classList.remove("buzz")
	void phone.offsetWidth
	phone.classList.add("buzz")
	setTimeout(() => phone.classList.remove("buzz"), 440)
	const ctx = audio.ctx
	if (!ctx) return
	const o = ctx.createOscillator(), g = ctx.createGain()
	o.type = "sawtooth"
	o.frequency.value = 85
	for (let i = 0; i < 6; i++) {
		g.gain.setValueAtTime(i % 2 ? 0 : 0.07, ctx.currentTime + i * 0.065)
	}
	g.gain.setValueAtTime(0, ctx.currentTime + 0.4)
	o.connect(g).connect(ctx.destination)
	o.start()
	o.stop(ctx.currentTime + 0.42)
}

// a cherry somewhere the snake is not
function place(b) {
	for (;;) {
		const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H)
		if (!b.some(([bx, by]) => bx === x && by === y)) return [x, y]
	}
}

// a patch in a few characters: where, and what was put there
function say(p) {
	const at = p.path.join("/") + (p.range ? `[${p.range}]` : "")
	if ("value" in p) return `${at || "="}${at ? " = " : " "}${JSON.stringify(p.value)}`
	return `${at} removed`
}

function el(tag, className = "", text?) {
	const e = document.createElement(tag)
	if (className) e.className = className
	if (text !== undefined) e.textContent = text
	return e
}
