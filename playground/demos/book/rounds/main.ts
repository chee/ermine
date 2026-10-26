/// <reference lib="dom" />
// a round: the pond's food chain on the real scheduler. rain (and sun) feed the algae and the water
// level; the minnows eat both (a diamond); the pike eat minnows. the fishing sign is an early
// effect, the pond picture a plain one. each change is a pulse, recorded through the scheduler's
// listeners, then replayed step by step on the board itself: who is due, who runs, who stops
// because its result is equal, and which queue the pulse is in
import { type Computer, createScheduler, type Ended } from "@ermine/core/scheduler"
import { pondPage } from "../kit/page.ts"
import type { Box, Tone, Wire } from "../kit/board.ts"
import { chart, createPond, pixels } from "../kit/sprites.ts"

const page = pondPage("rounds", {
	say:
		`<p>Change the weather and the scheduler runs a <b>pulse</b>, in <b>rounds</b>. Each round runs the due boxes from left to right, by <b>rank</b>, then lets the effects act.</p>
		<p>A box whose answer is the same as last time <b>stops there</b>: nothing after it runs. The <b>replay</b> box lets you step through every pulse.</p>`,
	tries: [
		{
			id: "level",
			text: "Nudge the rain. Step to <b>level</b>: same answer, so it stops there.",
		},
		{ id: "minnows", text: "Step to <b>minnows</b>. It runs once, after algae and level." },
		{ id: "sign", text: "Make the fishing <b>good</b>. The sign acts first, in the early lane." },
		{ id: "pond", text: "Then find the pond drawing a round later." },
		{ id: "stopped", text: "Open the <b>made</b> pulse and find a run that stopped." },
	],
	rules: `<p><b>Due:</b> a write marks a key. Every box that read it last time is due.</p>
		<p><b>Rank:</b> a box comes after the boxes that wrote what it read last time. Its rank is one past theirs. Rain and sun have no writer box, so their readers are rank 0.</p>
		<p><b>Order:</b> of what is due, the lowest rank runs first; then the one due first; then the one made first. So minnows runs once, with both inputs new.</p>
		<p><b>Equal stops:</b> a compute's answer goes to its set, which writes its key. An answer equal to the last one is not set, so its readers are not due.</p>
		<p><b>A round</b> is three queues: the runs, by rank; the early effects' acts; the other effects' acts. An effect acts only on an answer that is new.</p>
		<p><b>Another round:</b> an act can write. The sign writes <code>anglers</code>, which the pond reads. The pond is due again, so it does not act on its old answer: it runs and draws in the next round.</p>
		<p><b>Stopped:</b> a run that reads a key whose writer is due stops, stays due, and waits after that writer. You see it while things are being made, before any rank is known. An early effect runs the moment it is made.</p>`,
	real:
		`Runs the real <code>@ermine/core/scheduler</code>: createScheduler, a root scope, createComputer, createEffect, track, mark and pulse. The replay is recorded from its listeners (onMark, onRunStart, onRunReturn, onRunEnd, onEffect). The page keeps the store, draws the pictures, places the boxes in their rank columns, and names the lanes and rounds from the order things were told: a run after an act starts a new round; an act is early when its effect is.`,
})
const { board } = page

// ---- the store: the page's own Map, and its two helpers, made from this text --------------------
const s = createScheduler()
const store = new Map<string, unknown>([["rain", 6], ["sun", true], ["anglers", 0]])
const HELPERS = `const store = new Map()

// a read: tell the scheduler, then give the value
const read = (key) => {
  s.track(key)
  return store.get(key)
}

// a write: keep the value, then say the key changed
// (in a run or an act, who made the change)
const write = (key, value) => {
  store.set(key, value)
  s.mark([key], s.getRun())
}`
const { read, write } = new Function(
	"s",
	"store",
	HELPERS.replace("const store = new Map()", "") + "\nreturn { read, write }",
)(s, store) as { read: (key: string) => unknown; write: (key: string, value: unknown) => void }

// ---- the food chain ----------------------------------------------------------------------------
type Def = {
	id: string
	kind: "key" | "compute" | "effect"
	early?: boolean
	code?: string
	act?: string
	// the rank column it sits in (the page checks it against the ranks the scheduler tells)
	rank?: number
	x: number
	y: number
	width?: number
}
const DEFS: Def[] = [
	{ id: "rain", kind: "key", x: 0, y: 40, width: 190 },
	{ id: "sun", kind: "key", x: 0, y: 220, width: 190 },
	{
		id: "algae",
		kind: "compute",
		code: `read("sun") ? read("rain") * 2 : read("rain")`,
		rank: 0,
		x: 250,
		y: 20,
		width: 196,
	},
	{
		id: "level",
		kind: "compute",
		code: `Math.round(read("rain") / 5)`,
		rank: 0,
		x: 250,
		y: 220,
		width: 196,
	},
	{
		id: "minnows",
		kind: "compute",
		code: `read("algae") + read("level") * 5`,
		rank: 1,
		x: 510,
		y: 110,
		width: 196,
	},
	{
		id: "pike",
		kind: "compute",
		code: `Math.floor(read("minnows") / 10)`,
		rank: 2,
		x: 770,
		y: 110,
		width: 196,
	},
	{
		id: "sign",
		kind: "effect",
		early: true,
		code: `read("pike") >= 3 ? "good" : "poor"`,
		act: `sign(v)\nwrite("anglers", v === "good" ? 2 : 0)`,
		rank: 3,
		x: 1030,
		y: -90,
		width: 220,
	},
	{ id: "anglers", kind: "key", x: 1300, y: -70, width: 150 },
	{
		id: "pond",
		kind: "effect",
		code:
			`({ rain: read("rain"), algae: read("algae"), minnows: read("minnows"), pike: read("pike"), anglers: read("anglers") })`,
		act: `pond(v)`,
		rank: 3,
		x: 1030,
		y: 130,
	},
]
const def = new Map(DEFS.map((d) => [d.id, d]))
const nameOf = (c: Computer) => String(c.info.name)

// ---- the pictures ------------------------------------------------------------------------------
type Scene = { rain: number; algae: number; minnows: number; pike: number; anglers: number }
const pondCanvas = document.createElement("canvas")
const pond = createPond(pondCanvas, { width: 240, height: 140 })
const sceneOf = (v: Scene, stale: boolean) => ({
	minnows: v.minnows,
	pike: v.pike,
	algae: Math.min(1, v.algae / 40),
	rain: v.rain / 20,
	lilies: 4,
	sign: `${v.minnows} minnows · ${v.pike} pike`,
	named: Array.from({ length: v.anglers }, (_, i) => ({
		name: "angler",
		kind: "ermine" as const,
		x: 0.08 + i * 0.8,
		y: 0.95,
	})),
	stale,
})
const signCanvas = document.createElement("canvas")
signCanvas.className = "icon sign"
signCanvas.width = 120
signCanvas.height = 56
function drawSign(word: string | undefined, stale: boolean) {
	const c = signCanvas.getContext("2d")!
	c.clearRect(0, 0, 120, 56)
	c.fillStyle = "#e9d9a6"
	c.fillRect(0, 48, 120, 8)
	pixels(c, Array(20).fill("nN"), 59, 30, 1)
	c.fillStyle = "#7a5230"
	c.fillRect(6, 2, 108, 32)
	c.fillStyle = word === "good" ? "#40dcba" : word === "poor" ? "#fff" : "#dadada"
	c.fillRect(8, 4, 104, 28)
	c.fillStyle = "#000"
	c.textAlign = "center"
	c.font = "9px ui-monospace, Menlo, monospace"
	c.fillText("fishing", 60, 15)
	c.font = "bold 11px ui-monospace, Menlo, monospace"
	c.fillText(word ?? "?", 60, 28)
	if (word === "good") {
		pixels(c, ["g..ggg.", "gggGGKg", "g..ggg."], 12, 20, 1)
		pixels(c, ["g..ggg.", "gggGGKg", "g..ggg."], 101, 20, 1, true)
	}
	if (stale) {
		c.fillStyle = "rgba(240,240,240,.6)"
		c.fillRect(0, 0, 120, 56)
	}
}

// the latest each picture was given, by the effects' acts
const scenes: { pond?: Scene; sign?: string } = {}
const ACTS = {
	sign: (v: unknown) => (scenes.sign = v as string),
	pond: (v: unknown) => (scenes.pond = v as Scene),
}

// ---- recording: what the scheduler told, as steps -----------------------------------------------
// a step: something you wrote, a computer made, one run (its result, and what its set made due),
// one act (and what its write made due), the pulse over. lane: 0 outside a pulse, 1 the runs, 2
// the early acts, 3 the acts
type Lane = 0 | 1 | 2 | 3
type Step = {
	k: "write" | "made" | "run" | "act" | "over"
	who?: string
	lane: Lane
	round: number
	keys: string[]
	due: string[]
	n?: number
	rank?: number
	value?: unknown
	ended?: Ended
	equal?: boolean
	waits?: string
	store: Record<string, unknown>
	scenes: { pond?: Scene; sign?: string }
}
type Rec = { label: string; steps: Step[]; rounds: number; before: Record<string, unknown> }

const reads = new Map<string, string[]>()
let rec: Rec | undefined
let pulsing = false
let phase: Lane = 0
let round = 0
let open: Step | undefined
let acting: { who: string; keys: string[]; due: string[] } | undefined

const snap = () => ({ store: Object.fromEntries(store), scenes: { ...scenes } })
function push(e: Pick<Step, "k"> & Partial<Step>): Step {
	const st: Step = {
		keys: [],
		due: [],
		...e,
		lane: pulsing ? phase : 0,
		round: pulsing ? round : 0,
		...snap(),
	}
	rec?.steps.push(st)
	return st
}

s.onMark((keys, run, due) => {
	const names = due.map(nameOf)
	if (keys.length === 0) {
		for (const who of names) push({ k: "made", who, due: [who] })
		return
	}
	const by = run ? nameOf(run.computer) : undefined
	// a set's write, in its run
	if (open && by === open.who) {
		open.keys.push(...keys.map(String))
		open.due.push(...names)
		return
	}
	// an act's write: told with the act
	if (by && def.get(by)?.kind === "effect") {
		acting = { who: by, keys: keys.map(String), due: names }
		return
	}
	push({ k: "write", keys: keys.map(String), due: names })
})
s.onRunStart((c, n, rank) => {
	if (pulsing && phase !== 1) (round++, phase = 1)
	const who = nameOf(c)
	if (rec && rec.label !== "made" && def.get(who)?.rank !== rank) {
		console.warn(`${who} ran at rank ${rank}, not in its column`)
	}
	open = push({ k: "run", who, n, rank })
})
s.onRunReturn((_c, _n, value) => {
	if (open) open.value = value
})
s.onRunEnd((c, _n, ended, r, more) => {
	const who = nameOf(c)
	if (ended === "done") reads.set(who, r.map(String))
	if (open && open.who === who) {
		open.ended = ended
		open.equal = more.equal
		open.waits = more.waits ? nameOf(more.waits) : undefined
		Object.assign(open, snap())
	}
	open = undefined
})
s.onEffect((c) => {
	const who = nameOf(c)
	if (pulsing) phase = c.early ? 2 : 3
	const a = acting?.who === who ? acting : undefined
	acting = undefined
	push({ k: "act", who, keys: a?.keys ?? [], due: a?.due ?? [] })
})

function record(label: string, f: () => void): Rec {
	const r: Rec = { label, steps: [], rounds: 0, before: Object.fromEntries(store) }
	rec = r
	f()
	pulsing = true
	phase = 0
	round = 0
	try {
		s.pulse()
	} finally {
		pulsing = false
		r.rounds = round
		push({ k: "over" })
		rec = undefined
	}
	return r
}

// made: each computer, in a root scope, in the order listed
const root = s.createRootScope({ book: "rounds" })
const made = record("made", () =>
	s.runWithScope(root, () => {
		for (const d of DEFS) {
			if (d.kind === "key") continue
			const f = new Function("read", `return ${d.code}`) as (r: typeof read) => unknown
			if (d.kind === "compute") {
				s.createComputer(() => f(read), (v) => write(d.id, v), undefined, d.id, { name: d.id })
			} else {
				const act = new Function("v", "sign", "pond", "write", d.act!) as (
					v: unknown,
					...rest: unknown[]
				) => void
				s.createEffect(
					() => f(read),
					(v) => act(v, ACTS.sign, ACTS.pond, write),
					undefined,
					{ early: d.early },
					{ name: d.id },
				)
			}
		}
	}))

// ---- the board ---------------------------------------------------------------------------------
const boxes = new Map<string, Box>()
const backOf = (d: Def) =>
	d.kind === "compute"
		? `createComputer(
  () => ${d.code},
  (v) => write("${d.id}", v),
  undefined, // equal: Object.is
  "${d.id}", // the key it writes
)`
		: `createEffect(
  () => ${d.code},
  (v) => {
    ${d.act!.replace(/\n/g, "\n    ")}
  },
  undefined, // equal: Object.is
  { early: ${d.early === true} },
)`

for (const d of DEFS) {
	const b = board.box({
		id: d.id,
		x: d.x,
		y: d.y,
		title: d.id,
		kind: d.kind,
		outs: d.kind === "effect" ? (d.id === "sign" ? [["out", "writes"]] : []) : [["out", ""]],
		ins: d.id === "anglers" ? [["in", ""]] : [],
		width: d.width,
	})
	boxes.set(d.id, b)
	if (d.kind !== "key") b.code(backOf(d))
}

// rain: a slider; sun: two chips; anglers: written by the sign
const rainBox = boxes.get("rain")!
rainBox.body.innerHTML = `<input class="slider" type="range" min="0" max="20" value="${
	store.get("rain")
}" aria-label="rain"><div class="small"><span class="v"></span> mm of rain</div>`
const rainInput = rainBox.body.querySelector("input")!
const rainText = () => rainBox.body.querySelector(".v")!.textContent = String(store.get("rain"))
rainText()
rainInput.oninput = () => set("rain", Number(rainInput.value))
const sunBox = boxes.get("sun")!
sunBox.body.innerHTML =
	`<div class="chips"><button class="chip" data-v="1">sunny</button><button class="chip" data-v="0">cloudy</button></div>`
const sunChips = () =>
	sunBox.body.querySelectorAll<HTMLElement>(".chip").forEach((c) =>
		c.setAttribute("aria-pressed", String((c.dataset.v === "1") === store.get("sun")))
	)
sunChips()
sunBox.body.onclick = (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>(".chip")
	if (c) set("sun", c.dataset.v === "1")
}
boxes.get("anglers")!.body.innerHTML =
	`<div class="mid v"></div><div class="small">the sign's act writes it</div>`
for (const id of ["algae", "level", "minnows", "pike"]) {
	boxes.get(id)!.body.innerHTML = `<div class="big v"></div><div class="small">rank ${
		def.get(id)!.rank
	}</div>`
}
boxes.get("sign")!.body.append(signCanvas)
boxes.get("sign")!.body.insertAdjacentHTML(
	"beforeend",
	`<div class="small">early effect · rank 3</div>`,
)
boxes.get("pond")!.body.append(pondCanvas)
boxes.get("pond")!.body.insertAdjacentHTML(
	"beforeend",
	`<div class="small">effect · rank 3 · draws the pond in its act</div>`,
)

// the store, with its code on the back
const storeBox = board.box({ id: "store", x: 0, y: 340, title: "store", kind: "note", width: 190 })
storeBox.body.innerHTML =
	`<div class="small">the keys live in a Map. turn me over for read and write.</div>`
storeBox.code(HELPERS)

// wires: from each key a box's last run read (as the scheduler told), and the sign's write
const wires = new Map<string, Wire>()
for (const d of DEFS) {
	for (const k of reads.get(d.id) ?? []) {
		const to = boxes.get(d.id)!.addPort(k, "in")
		wires.set(`${k}>${d.id}`, board.wire(boxes.get(k)!.port("out"), to))
	}
}
const writeWire = board.wire(boxes.get("sign")!.port("out"), boxes.get("anglers")!.port("in"))
writeWire.dashed(true)

// the chart: minnows after each pulse
const chartBox = board.box({
	id: "chart",
	x: 1140,
	y: 500,
	title: "minnows, pulse by pulse",
	kind: "picture",
})
const chartCanvas = document.createElement("canvas")
chartBox.body.append(chartCanvas)
const minnowsSeen: number[] = [store.get("minnows") as number]

// ---- the replay box ----------------------------------------------------------------------------
const replay = board.box({ id: "replay", x: 0, y: 470, title: "replay", kind: "note", width: 860 })
replay.body.innerHTML = `
<div class="pulses"></div>
<div class="lanes">
	<div class="names"><div>outside</div><div>runs, by rank</div><div>early acts</div><div>acts</div></div>
	<div class="track" tabindex="0" aria-label="the pulse, step by step: ← → to step"></div>
</div>
<div class="controls">
	<button class="b" data-go="first" title="to the start">|&lt;</button>
	<button class="b" data-go="back" title="one step back (←)">&lt;</button>
	<button class="b go" data-go="play" title="play">play</button>
	<button class="b" data-go="on" title="one step on (→)">&gt;</button>
	<button class="b" data-go="last" title="to the end">&gt;|</button>
	<span class="small count"></span>
	<span class="key"><i class="t run"></i>ran, new <i class="t equal"></i>equal: stops <i class="t stopped"></i>stopped <i class="t act"></i>acted <i class="t write"></i>write</span>
</div>`
const track = replay.body.querySelector<HTMLElement>(".track")!
// the replay's own: no dragging the box by its insides
replay.body.addEventListener("pointerdown", (e) => e.stopPropagation())

const recs: Rec[] = [made]
let at = 0
let step = made.steps.length - 1
let timer: ReturnType<typeof setInterval> | undefined

function set(key: string, value: unknown) {
	if (store.get(key) === value) return
	const label = key === "rain" ? `rain ${value}` : value ? "sunny" : "cloudy"
	recs.push(record(label, () => write(key, value)))
	while (recs.length > 7) recs.splice(1, 1)
	minnowsSeen.push(store.get("minnows") as number)
	if (minnowsSeen.length > 40) minnowsSeen.shift()
	at = recs.length - 1
	step = 0
	rainText()
	sunChips()
	play()
}

function stop() {
	if (timer !== undefined) clearInterval(timer)
	timer = undefined
	replay.body.querySelector<HTMLElement>('[data-go="play"]')!.textContent = "play"
}
function play() {
	stop()
	if (step >= recs[at].steps.length - 1) step = 0
	replay.body.querySelector<HTMLElement>('[data-go="play"]')!.textContent = "pause"
	timer = setInterval(() => {
		if (step >= recs[at].steps.length - 1) return stop()
		step++
		draw()
	}, 650)
	draw()
}
function go(n: number) {
	stop()
	step = Math.max(0, Math.min(recs[at].steps.length - 1, n))
	draw()
}
replay.body.querySelector<HTMLElement>(".controls")!.onclick = (e) => {
	const g = (e.target as HTMLElement).closest<HTMLElement>("[data-go]")?.dataset.go
	if (g === "first") go(0)
	if (g === "back") go(step - 1)
	if (g === "on") go(step + 1)
	if (g === "last") go(Infinity)
	if (g === "play") timer === undefined ? play() : stop()
}
replay.body.querySelector<HTMLElement>(".pulses")!.onclick = (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rec]")
	if (!b) return
	stop()
	at = Number(b.dataset.rec)
	step = 0
	draw()
}
addEventListener("keydown", (e) => {
	const t = e.target as HTMLElement
	if (t.tagName === "INPUT") return
	if (e.key === "ArrowLeft") go(step - 1)
	else if (e.key === "ArrowRight") go(step + 1)
})
track.onpointerdown = (e) => {
	track.setPointerCapture(e.pointerId)
	const to = (x: number) => {
		const r = track.getBoundingClientRect()
		const w = r.width / recs[at].steps.length
		go(Math.floor((x - r.left) / w))
	}
	to(e.clientX)
	track.onpointermove = (m) => to(m.clientX)
	track.onpointerup = track.onpointercancel = () => (track.onpointermove = null)
}

// ---- the state of everything at step i, replayed from the record's start ------------------------
type State =
	| "idle"
	| "due"
	| "again"
	| "running"
	| "new"
	| "equal"
	| "stopped"
	| "toact"
	| "acting"
	| "acted"
	| "unmade"
function look(r: Rec, i: number): Map<string, State> {
	const m = new Map<string, State>()
	if (r === made) {
		for (const d of DEFS) {
			if (d.kind !== "key" && r.steps.findIndex((x) => x.k === "made" && x.who === d.id) > i) {
				m.set(d.id, "unmade")
			}
		}
	}
	for (let j = 0; j <= i; j++) {
		const e = r.steps[j]
		const now = j === i
		if (e.k === "made" || e.k === "write") { for (const d of e.due) m.set(d, "due") }
		if (e.k === "run") {
			const d = def.get(e.who!)!
			m.set(
				e.who!,
				now
					? "running"
					: e.ended === "stopped"
					? "stopped"
					: e.equal
					? "equal"
					: d.kind === "effect" && e.ended === "done"
					? "toact"
					: "new",
			)
			for (const x of e.due) m.set(x, "due")
		}
		if (e.k === "act") {
			m.set(e.who!, now ? "acting" : "acted")
			for (const x of e.due) m.set(x, m.get(x) === "toact" ? "again" : "due")
		}
	}
	return m
}

const BADGE: Record<State, [string, Tone]> = {
	idle: ["", undefined],
	unmade: ["not made yet", "dim"],
	due: ["due", "wait"],
	again: ["due again", "wait"],
	running: ["runs", "hot"],
	new: ["", undefined],
	equal: ["equal: stops here", "ok"],
	stopped: ["stopped: waits", "pick"],
	toact: ["to act", "pick"],
	acting: ["acts", "hot"],
	acted: ["acted", "ok"],
}

const fmt = (v: unknown) => typeof v === "string" ? v : String(v)
const said = (k: string, st: Record<string, unknown>) => {
	const v = st[k]
	if (v === undefined) return ""
	if (k === "rain") return `${v} mm`
	if (k === "sun") return v ? "sunny" : "cloudy"
	return fmt(v)
}
const b = (x: string) => `<b>${x}</b>`
const and = (xs: string[]) =>
	xs.length < 2 ? xs.map(b).join("") : `${xs.slice(0, -1).map(b).join(", ")} and ${b(xs.at(-1)!)}`

// one plain sentence for step i
function sentence(r: Rec, i: number): [string, "hot" | "ok" | undefined] {
	const e = r.steps[i]
	const d = e.who ? def.get(e.who) : undefined
	switch (e.k) {
		case "made":
			return [
				`${b(e.who!)} was made, so it is due.${
					d?.early ? " An early effect runs the moment it is made." : ""
				}`,
				undefined,
			]
		case "write": {
			const k = e.keys[0]
			return [
				`You set ${b(k)} to ${said(k, e.store)}: ${
					e.due.length ? `${and(e.due)} read it, so they are due.` : "nobody read it."
				}`,
				"hot",
			]
		}
		case "run": {
			const who = b(e.who!)
			if (e.ended === "stopped") {
				return [
					`${who} read ${b(e.waits!)}, but ${
						b(e.waits!)
					} is due to run first: ${who} stopped, and waits after it.`,
					undefined,
				]
			}
			const early = r === made && e.rank! < d!.rank!
				? ` at rank ${e.rank}, since it has not run before`
				: ""
			if (e.equal) {
				return [
					d!.kind === "effect"
						? `${who} got ${b(fmt(e.value))} again: nothing new to act on.`
						: `${who} ran${early} and got ${
							b(fmt(e.value))
						} again: equal, so it stops here and makes nothing due.`,
					"ok",
				]
			}
			if (d!.kind === "effect") {
				return [
					`${who} ran${early}: a new answer, to act on ${
						d!.early ? "in the early lane" : "in the last lane"
					} once the runs are done.`,
					undefined,
				]
			}
			const before = look(r, i - 1)
			const already = [...reads].filter(([to, ks]) =>
				ks.includes(e.who!) && !e.due.includes(to) &&
				["due", "again"].includes(before.get(to) ?? "")
			).map(([to]) => to)
			return [
				`${who} ran${early} and got ${b(fmt(e.value))}, which is new${
					e.due.length
						? `: ${and(e.due)} ${e.due.length > 1 ? "are" : "is"} due.`
						: already.length
						? `; ${and(already)} ${already.length > 1 ? "were" : "was"} due already.`
						: "."
				}`,
				undefined,
			]
		}
		case "act":
			if (e.who === "sign") {
				return [
					`The sign acted first, in the early lane: fishing is ${b(fmt(e.scenes.sign))}.${
						e.due.length
							? ` It wrote anglers, so ${and(e.due)} must run again: another round.`
							: ""
					}`,
					"hot",
				]
			}
			return [`The pond acted: the picture is drawn.`, "hot"]
		case "over":
			return [
				`Nothing is due: the pulse is over, after ${r.rounds} round${
					r.rounds === 1 ? "" : "s"
				}.`,
				"ok",
			]
	}
}

// ---- drawing step i on the board ---------------------------------------------------------------
let lastDrawn = ""
function draw() {
	const r = recs[at]
	const e = r.steps[step]
	const st = look(r, step)

	// boxes
	for (const d of DEFS) {
		if (d.kind === "key") continue
		const box = boxes.get(d.id)!
		const s1 = st.get(d.id) ?? "idle"
		const [text, tone] = BADGE[s1]
		let badge = text
		if (s1 === "running") {
			badge = e.ended === "stopped" ? "stopped" : e.equal ? "equal: stops here" : "runs: new"
		}
		box.badge(badge, s1 === "running" && e.equal ? "ok" : tone)
		box.tone(
			s1 === "running" || s1 === "acting"
				? "hot"
				: s1 === "due" || s1 === "again" || s1 === "stopped"
				? "wait"
				: s1 === "unmade"
				? "dim"
				: undefined,
		)
		const v = box.body.querySelector(".v")
		if (v) v.textContent = d.id in e.store ? fmt(e.store[d.id]) : "…"
	}
	boxes.get("anglers")!.body.querySelector(".v")!.textContent = said("anglers", e.store)
	const pondOld = ["due", "again", "running", "toact"].includes(st.get("pond") ?? "")
	if (e.scenes.pond) pond.draw(sceneOf(e.scenes.pond, pondOld))
	else pond.draw({ stale: true })
	drawSign(
		e.scenes.sign,
		["due", "again", "running", "toact", "stopped"].includes(st.get("sign") ?? ""),
	)

	// wires: values ride on them; cherry where a change made the reader due; grey after an equal
	for (const [id, w] of wires) {
		const [k, to] = id.split(">")
		w.label(said(k, e.store))
		const hot = e.keys.includes(k) && e.due.includes(to)
		const reading = e.k === "run" && e.who === to
		const stopped = st.get(k) === "equal" || (e.k === "run" && e.who === k && e.equal === true)
		w.tone(hot ? "hot" : stopped ? "dim" : reading ? "pick" : undefined)
	}
	writeWire.tone(e.k === "act" && e.who === "sign" ? "hot" : undefined)
	writeWire.label(e.k === "act" && e.who === "sign" ? said("anglers", e.store) : "")

	// a run steps in: its box flashes, once
	const here = `${at}:${step}`
	if (here !== lastDrawn && (e.k === "run" || e.k === "act")) boxes.get(e.who!)!.flash("hot")
	lastDrawn = here

	// the replay box
	replay.body.querySelector(".pulses")!.innerHTML = `<span class="small">pulses</span>` +
		recs.map((x, i) =>
			`<button class="chip" data-rec="${i}" aria-pressed="${i === at}">${x.label}</button>`
		).join("")
	let html = [1, 2, 3].map((i) => `<div class="rule" style="top:${i * 22}px"></div>`).join("")
	const w = 100 / r.steps.length
	let was = 0
	r.steps.forEach((x, i) => {
		if (x.round > 0 && x.round !== was) {
			html += `<div class="round" style="left:${i * w}%">round ${x.round}</div>`
			was = x.round
		}
		const cls = x.k === "run"
			? x.ended === "stopped" ? "stopped" : x.equal ? "equal" : "run"
			: x.k === "act"
			? "act"
			: x.k === "over"
			? "over"
			: "write"
		html += `<div class="t ${cls}${i < step ? " past" : i === step ? " here" : ""}" style="left:${
			i * w
		}%;width:calc(${w}% - 3px);top:${x.lane * 22 + 3}px">${x.who ?? ""}</div>`
	})
	html += `<div class="head" style="left:calc(${(step + 0.5) * w}% - 1px)"></div>`
	track.innerHTML = html
	replay.body.querySelectorAll(".names div").forEach((x, i) =>
		x.classList.toggle("on", i === e.lane)
	)
	replay.body.querySelector(".count")!.textContent = `step ${step + 1} of ${r.steps.length}${
		e.lane === 0 ? "" : ` · round ${e.round}`
	}`

	chart(chartCanvas, minnowsSeen, { width: 240, height: 90, min: 0, max: 60 })

	const [say, tone] = sentence(r, step)
	page.say(say, tone)
	tick(r, e)
}

// the tries
function tick(r: Rec, e: Step) {
	if (e.k === "run" && e.ended === "stopped") page.tick("stopped")
	if (r === made) return
	if (e.k === "run" && e.who === "level" && e.equal) page.tick("level")
	if (e.k === "run" && e.who === "minnows") page.tick("minnows")
	if (e.k === "act" && e.who === "sign") page.tick("sign")
	if (e.k === "act" && e.who === "pond" && e.round > 1) page.tick("pond")
}

// a narrow window: the same boxes, stacked taller, so they stay big enough to read
if (board.el.clientWidth < 1100) {
	const TALL: Record<string, [number, number]> = {
		rain: [0, 0],
		sun: [0, 180],
		algae: [230, -20],
		level: [230, 180],
		minnows: [460, 80],
		pike: [690, 80],
		store: [690, 240],
		sign: [0, 340],
		anglers: [250, 370],
		pond: [430, 330],
		replay: [0, 640],
		chart: [0, 900],
	}
	for (const [id, [x, y]] of Object.entries(TALL)) board.get(id)!.move(x, y)
	replay.el.style.width = "820px"
}

draw()
requestAnimationFrame(() => board.fit())
