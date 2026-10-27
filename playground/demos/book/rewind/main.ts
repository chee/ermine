/// <reference lib="dom" />
// rewind the farm: a day plays out (apples dropped, pigs fed, one renamed, a piglet born, the sun
// and the night), each change a real update to an entry in a real table, which keeps its undo.
// three programs the real scheduler runs (hungry, pen, sign) and the picture work out the rest. the
// wheel takes the whole farm back: the page applies the undos, newest first, as writes, and the
// scheduler runs again what read them, so the flags, the sign and where the pigs stand go back too.
// the strip is the page's own list of the day's changes, one card each.
import { type Computer, createScheduler } from "@ermine/core/scheduler"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import { createTable } from "@ermine/core/table"
import type { Patch } from "@ermine/core/changeable/apply"
import { pondPage } from "../kit/page.ts"
import type { Box, Wire } from "../kit/board.ts"
import { createFarm, type FarmPig, pigScale } from "../kit/farm.ts"
import { pixels, sprite, SPRITES } from "../kit/sprites.ts"

const page = pondPage("rewind", {
	say:
		`<p>A day on the farm: apples dropped, pigs fed, one renamed, a piglet born. Three programs watch it: <b>hungry</b>, <b>pen</b> (to the mud when it's hot) and the <b>sign</b>.</p>
		<p>Turn the wheel and the whole farm goes back to this morning, for real. The values go back, and the programs run again on them, so the hungry pigs, the sign and the mud go back too.</p>`,
	tries: [
		{ id: "morning", text: "Turn the wheel all the way back to this morning." },
		{ id: "again", text: "Turn it forwards again. Everything comes back." },
		{ id: "card", text: "Click a card in the day to jump there." },
		{
			id: "branch",
			text: "Go back to 11:20 and drop some apples. What happens to the afternoon?",
		},
		{ id: "flip", text: "Press <b>{ }</b> on <b>hungry</b> to read its code." },
	],
	rules:
		`<p><b>entries:</b> apples, pigs and weather are each an entry in a table. Every change is made with <code>update</code>, which keeps the change's patches and their <b>undo</b> (<code>change.op.undo</code>).</p>
		<p><b>the day:</b> the page keeps a list, one card per change you see, holding what update gave: the undo and the patches.</p>
		<p><b>going back:</b> applies the undos, newest first, each with <code>update</code> and a <code>mark</code>. Forwards applies the patches again, oldest first. Both are real writes.</p>
		<p><b>the programs:</b> nobody rewinds hungry, pen or the sign. The scheduler runs them again because what they read changed, and they work it all out from the old values.</p>
		<p><b>a change while back:</b> this page's list drops the cards after where you are, as undo does. Ermine's sync keeps each node's commits as a graph with several heads, so a branch could be kept; this page keeps one line.</p>`,
	real:
		`Runs the real <code>@ermine/core/table</code> (createTable), <code>@ermine/core/node</code> (createEntry, update and the undo it keeps) and <code>@ermine/core/scheduler</code> (hungry, pen and sign are computers, the picture an effect; track, mark, pulse). The page's own: the list of the day's cards, the wheel, the clock times, and where in the field each pig is drawn.`,
})
const { board } = page

// ---- the real table of entries, read and written through the scheduler ---------------------
type Pig = { name: string; weight: number }
type Pigs = Record<string, Pig>
type Weather = { heat: number; night: boolean }
const s = createScheduler()
const table = createTable()
const header = (actor: string, message: string): ChangeHeader => ({
	time: Math.floor(Date.now() / 1000),
	actor,
	metadata: { message },
})
const MORNING: Record<string, unknown> = {
	apples: 0,
	pigs: {
		wilbur: { name: "wilbur", weight: 6 },
		petunia: { name: "petunia", weight: 9 },
		dot: { name: "dot", weight: 7 },
	} satisfies Pigs,
	weather: { heat: 16, night: false } satisfies Weather,
}
for (const [id, v] of Object.entries(MORNING)) {
	table.add("value", id, createEntry(v, header("farm", "this morning")))
}
const entry = (id: string) => table.get("value", id) as Entry<unknown>
const peek = <T>(id: string) => entry(id).value as T
function read<T>(id: string): T {
	s.track(id)
	return peek<T>(id)
}

type Write = { id: string; undo: readonly Patch[]; redo: readonly Patch[] }
type Card = { kind: Icon; time: number; text: string; writes: Write[] }
// the day: card 0 is this morning; at is how many of the cards after it are applied
const day: Card[] = [{ kind: "morning", time: 7 * 60, text: "this morning", writes: [] }]
let at = 0
let recording: Write[] | undefined
function write(id: string, patches: Patch[], actor = "you", message = "") {
	const e = entry(id)
	update(e, patches, header(actor, message))
	recording?.push({ id, undo: e.change.op!.undo, redo: e.change.op!.patches })
	s.mark([id])
}

// ---- what happens on the farm: each one card ------------------------------------------------
const clock = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`
let changedKeys = new Set<string>()
function act(kind: Icon, text: string, f: () => void, time?: number) {
	const cut = day.length - 1 - at
	if (cut > 0) dropFuture()
	recording = []
	changedKeys = new Set()
	try {
		f()
	} finally {
		const writes = recording
		recording = undefined
		if (writes.length) {
			const t = time ?? Math.min(23 * 60 + 59, day[at].time + 7)
			day.push({ kind, time: t, text, writes })
			at = day.length - 1
			ran.clear()
			s.pulse()
			drawStrip()
			wheel.set()
			page.say(`${clock(t)}: ${text}.${afterAct()}`)
			if (cut > 0) {
				page.tick("branch")
				page.say(
					`${clock(t)}: ${text}. The ${cut} card${cut === 1 ? "" : "s"} after it ${
						cut === 1 ? "was" : "were"
					} dropped: this is a new afternoon.`,
					"hot",
				)
			}
		}
	}
}
const pigs = () => peek<Pigs>("pigs")
const lightest = () => Object.entries(pigs()).sort((a, b) => a[1].weight - b[1].weight)[0]
function drop(n = 3, time?: number) {
	act("apple", `you dropped ${n} apples`, () => {
		write("apples", [{ path: [], value: peek<number>("apples") + n }])
	}, time)
}
function feed(id?: string, time?: number) {
	const apples = peek<number>("apples")
	if (apples <= 0) {
		stopDay()
		return page.say("The trough is empty: drop some apples first.", "hot")
	}
	const [pid, pig] = id ? [id, pigs()[id]] : lightest()
	const to = pig.weight + 2
	act("feed", `you fed ${pig.name}: ${pig.weight} → ${to}`, () => {
		write("apples", [{ path: [], value: apples - 1 }])
		write("pigs", [{ path: [pid, "weight"], value: to }])
	}, time)
}
const NAMES = ["pumpkin", "pearl", "hamlet", "truffle", "biscuit", "mabel"]
function rename(id?: string, to?: string, time?: number) {
	const all = Object.entries(pigs())
	const used = new Set(all.map(([, p]) => p.name))
	const name = to ?? NAMES.find((n) => !used.has(n)) ?? `pig ${all.length}`
	const [pid, pig] = id ? [id, pigs()[id]] : all[all.length - 1]
	act("letter", `you renamed ${pig.name} to ${name}`, () => {
		write("pigs", [{ path: [pid, "name"], value: name }])
	}, time)
}
const PIGLETS = ["pip", "nib", "sprout", "tuppence", "bean", "pickle"]
function piglet(time?: number) {
	const ids = new Set(Object.keys(pigs()))
	const names = new Set(Object.values(pigs()).map((p) => p.name))
	const name = PIGLETS.find((n) => !ids.has(n) && !names.has(n)) ?? `piglet${ids.size}`
	act("piglet", `${name} was born`, () => {
		write("pigs", [{ path: [name], value: { name, weight: 2 } }], "farm")
	}, time)
}
function warm(hot: boolean, time?: number) {
	const heat = hot ? 27 : 15
	act(
		hot ? "sun" : "cloud",
		hot ? `the sun came out: ${heat}°` : `it cooled down: ${heat}°`,
		() => {
			write("weather", [{ path: ["heat"], value: heat }], "weather")
		},
		time,
	)
}
function night(on: boolean, time?: number) {
	act(on ? "moon" : "morning", on ? "night fell" : "the sun came up", () => {
		write("weather", [{ path: ["night"], value: on }], "weather")
	}, time)
}

// ---- going back and forwards: undos newest first, patches oldest first -----------------------
const travelled = { morning: false }
function travel(to: number, how: "wheel" | "card" = "wheel") {
	to = Math.max(0, Math.min(day.length - 1, to))
	if (to === at) return
	const from = at
	ran.clear()
	changedKeys = new Set()
	while (at > to) {
		const { writes, time } = day[at--]
		for (let k = writes.length - 1; k >= 0; k--) {
			write(writes[k].id, [...writes[k].undo], "rewind", `back to ${clock(time)}`)
		}
	}
	while (at < to) {
		for (const w of day[++at].writes) {
			write(w.id, [...w.redo], "rewind", `on to ${clock(day[at].time)}`)
		}
	}
	s.pulse()
	drawStrip()
	wheel.set()
	const programs = ["hungry", "pen", "sign"].filter((p) => ran.has(p))
	const where = to === 0 ? "this morning" : clock(day[to].time)
	page.say(
		`${to < from ? "Back" : "On"} to ${where}. ${
			programs.length
				? `${list(programs.map((p) => `<b>${p}</b>`))} ran again on ${
					to < from ? "the old" : "these"
				} values.`
				: "No program read what changed, so none ran."
		}`,
		to < from ? "hot" : "ok",
	)
	if (to === 0) {
		travelled.morning = true
		page.tick("morning")
	}
	if (travelled.morning && to === day.length - 1) page.tick("again")
	if (how === "card") page.tick("card")
}
const list = (xs: string[]) =>
	xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`

// ---- the programs: the real scheduler runs them --------------------------------------------
const results = new Map<string, unknown>()
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const ran = new Set<string>()
const runs = new Map<string, number>()
const byComputer = new Map<Computer, string>()
let making = ""

type Program = {
	id: string
	code: string
	f: () => unknown
	show: (v: unknown, body: HTMLElement) => void
}
const PROGRAMS: Program[] = [
	{
		id: "hungry",
		code: `// every pig is hungry
// while the trough is empty
createComputer(() => {
  const apples = read("apples")
  const pigs = read("pigs")
  return apples > 0
    ? []
    : Object.keys(pigs)
}, (v) => write("hungry", v))`,
		f: () => {
			const apples = read<number>("apples")
			const all = read<Pigs>("pigs")
			return apples > 0 ? [] : Object.keys(all)
		},
		show(v, body) {
			const ids = v as string[]
			body.querySelector(".mid")!.textContent = ids.length
				? ids.map((id) => pigs()[id]?.name ?? id).join(", ")
				: "nobody"
		},
	},
	{
		id: "pen",
		code: `// hot: every pig to the mud
createComputer(() => {
  const { heat } = read("weather")
  const pigs = read("pigs")
  const spot = heat >= 25
    ? "mud"
    : "field"
  return Object.fromEntries(
    Object.keys(pigs)
      .map((id) => [id, spot]))
}, (v) => write("pen", v))`,
		f: () => {
			const { heat } = read<Weather>("weather")
			const all = read<Pigs>("pigs")
			const spot = heat >= 25 ? "mud" : "field"
			return Object.fromEntries(Object.keys(all).map((id) => [id, spot]))
		},
		show(v, body) {
			const spots = Object.values(v as Record<string, string>)
			const mud = spots.filter((x) => x === "mud").length
			body.querySelector(".mid")!.textContent = mud ? `${mud} in the mud` : "all in the field"
		},
	},
	{
		id: "sign",
		code: `createComputer(() => {
  const apples = read("apples")
  const hungry = read("hungry").length
  return hungry
    ? hungry + " hungry pigs"
    : apples + " apples left"
}, (v) => write("sign", v))`,
		f: () => {
			const apples = read<number>("apples")
			const hungry = read<string[]>("hungry").length
			return hungry ? `${hungry} hungry pigs` : `${apples} apple${apples === 1 ? "" : "s"} left`
		},
		show(v, body) {
			body.querySelector(".mid")!.textContent = String(v)
		},
	},
]

// ---- the board ------------------------------------------------------------------------------
// left: the entries, things you change. middle: the programs. right: the farm. below: the day,
// the wheel, and what other software does
const STORE_CODE = `const table = createTable()
table.add("value", "apples", createEntry(0))

function read(id) {
  s.track(id)
  return table.get("value", id).value
}

// update keeps the undo: change.op.undo
function write(id, patches) {
  const entry = table.get("value", id)
  update(entry, patches, header)
  card?.writes.push({
    id,
    undo: entry.change.op.undo,
    redo: patches,
  })
  s.mark([id])
}`
const boxes = new Map<string, Box>()
function entryBox(id: string, x: number, y: number, html: string, wire: (b: HTMLElement) => void) {
	const b = board.box({ id, x, y, title: id, kind: "key", outs: [["out", ""]], width: 196 })
	b.body.innerHTML = html
	wire(b.body)
	b.code(STORE_CODE)
	boxes.set(id, b)
	return b
}
const chipsOf = (el: HTMLElement, f: (d: string) => void) =>
	el.addEventListener("click", (e) => {
		const c = (e.target as HTMLElement).closest<HTMLElement>("[data-do]")
		if (!c) return
		stopDay()
		f(c.dataset.do!)
	})
entryBox(
	"apples",
	0,
	0,
	`<div class="row"><span class="big">0</span><span class="small">in the trough</span></div>
	<div class="chips"><button class="chip" data-do="drop">drop 3</button></div>`,
	(el) => chipsOf(el, () => drop()),
)
entryBox(
	"pigs",
	0,
	128,
	`<div class="pigs"></div>
	<div class="chips"><button class="chip" data-do="feed">feed</button><button class="chip" data-do="rename">rename</button><button class="chip" data-do="piglet">piglet</button></div>`,
	(el) => chipsOf(el, (d) => d === "feed" ? feed() : d === "rename" ? rename() : piglet()),
)
entryBox(
	"weather",
	0,
	322,
	`<div class="row"><span class="big heat">16°</span><span class="small sky">day</span></div>
	<div class="chips"><button class="chip" data-do="warm">sun</button><button class="chip" data-do="night">night</button></div>`,
	(el) =>
		chipsOf(el, (d) => {
			const w = peek<Weather>("weather")
			if (d === "warm") warm(w.heat < 25)
			else night(!w.night)
		}),
)
function showEntries() {
	const a = boxes.get("apples")!.body
	a.querySelector(".big")!.textContent = String(peek<number>("apples"))
	const p = boxes.get("pigs")!.body.querySelector(".pigs")!
	p.innerHTML = Object.values(pigs()).map((g) =>
		`<div class="pigrow"><span>${g.name}</span><b>${g.weight}</b></div>`
	).join("")
	const w = peek<Weather>("weather")
	const wb = boxes.get("weather")!.body
	wb.querySelector(".heat")!.textContent = `${w.heat}°`
	wb.querySelector(".sky")!.textContent = w.night ? "night" : w.heat >= 25 ? "hot day" : "day"
	wb.querySelector<HTMLElement>("[data-do=warm]")!.textContent = w.heat >= 25 ? "cool" : "sun"
	wb.querySelector<HTMLElement>("[data-do=night]")!.textContent = w.night ? "morning" : "night"
}

PROGRAMS.forEach((p, i) => {
	const b = board.box({
		id: p.id,
		x: 262,
		y: [0, 160, 320][i],
		title: p.id,
		kind: "compute",
		outs: [["out", ""]],
		width: 176,
	})
	b.body.innerHTML = `<div class="mid">…</div><div class="small runs">ran 0 times</div>`
	b.code(p.code)
	boxes.set(p.id, b)
})

// the farm, drawn by an effect from everything above
const pic = board.box({ id: "farm", x: 540, y: 0, title: "the farm", kind: "picture" })
const canvas = document.createElement("canvas")
canvas.className = "farm-pic"
pic.body.append(canvas)
pic.body.insertAdjacentHTML("beforeend", `<div class="small runs">drew 0 times</div>`)
pic.code(`createEffect(
  () => ({
    pigs: read("pigs"),
    apples: read("apples"),
    weather: read("weather"),
    hungry: read("hungry"),
    pen: read("pen"),
    sign: read("sign"),
  }),
  (scene) => farm.draw(scene),
)`)
boxes.set("farm", pic)
const farm = createFarm(canvas, { width: 240, height: 140 })

// the day: the page's own list, one card per change
const strip = board.box({ id: "day", x: 0, y: 500, title: "the day", kind: "note", width: 456 })
strip.body.innerHTML = `<div class="cards"></div>`
strip.code(`// the page's list of the day. a change made
// while back drops the cards after it
function act(what, f) {
  day.splice(at + 1)
  card = { what, writes: [] }
  f() // its writes push onto card.writes
  day.push(card)
  at = day.length - 1
}`)
const cardsEl = strip.body.querySelector<HTMLElement>(".cards")!
cardsEl.addEventListener("click", (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")
	if (!c) return
	stopDay()
	travel(Number(c.dataset.i), "card")
})

// the wheel
const wheelBox = board.box({
	id: "rewind",
	x: 540,
	y: 500,
	title: "rewind",
	kind: "key",
	width: 262,
})
wheelBox.code(`// back: each card's undos, newest first.
// forwards: its patches, oldest first.
// real writes: the scheduler runs again
// whatever read them
function travel(to) {
  while (at > to) {
    const { writes } = day[at--]
    for (const w of writes.toReversed())
      write(w.id, w.undo)
  }
  while (at < to)
    for (const w of day[++at].writes)
      write(w.id, w.redo)
  s.pulse()
}`)

// elsewhere
const other = board.box({
	id: "elsewhere",
	x: 830,
	y: 500,
	title: "elsewhere",
	kind: "note",
	width: 222,
})
other.body.innerHTML =
	`<p class="else">Undo in most apps takes back your own edits, one step at a time. What programs did since stays done.</p>
	<p class="else">A spreadsheet comes close: its formulas work out again. A backup brings back files, not a running thing.</p>`

// ---- the strip of cards ----------------------------------------------------------------------
type Icon = "morning" | "apple" | "feed" | "letter" | "piglet" | "sun" | "cloud" | "moon"
function drawIcon(kind: Icon) {
	const c = document.createElement("canvas")
	c.width = 24
	c.height = 14
	c.className = "icon"
	const x = c.getContext("2d")!
	const sun = (cx: number, cy: number, r: number) => {
		x.fillStyle = "#ffd23d"
		for (let j = -r; j <= r; j++) {
			for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) x.fillRect(cx + i, cy + j, 1, 1)
		}
	}
	if (kind === "morning") {
		sun(12, 11, 5)
		x.fillStyle = "#7fd36b"
		x.fillRect(0, 11, 24, 3)
	} else if (kind === "apple") {
		for (let i = 0; i < 3; i++) sprite(x, "apple", 3 + i * 6, 5)
	} else if (kind === "feed") {
		pixels(x, SPRITES.pig, 0, 2)
		sprite(x, "apple", 19, 8)
	} else if (kind === "letter") sprite(x, "letter", 7, 4)
	else if (kind === "piglet") {
		pixels(x, SPRITES.pig, 3, 3)
	} else if (kind === "sun") {
		sun(12, 7, 4)
		x.fillStyle = "#ffd23d"
		for (
			const [i, j] of [[12, 0], [12, 13], [5, 7], [19, 7], [7, 2], [17, 2], [7, 12], [17, 12]]
		) {
			x.fillRect(i, j, 1, 1)
		}
	} else if (kind === "cloud") {
		x.fillStyle = "#dce6ff"
		x.fillRect(0, 0, 24, 14)
		sprite(x, "cloud", 6, 5)
	} else if (kind === "moon") {
		x.fillStyle = "#2c3e66"
		x.fillRect(0, 0, 24, 14)
		sun(12, 7, 5)
		x.fillStyle = "#2c3e66"
		for (let j = -5; j <= 5; j++) {
			for (let i = -5; i <= 5; i++) if (i * i + j * j <= 22) x.fillRect(14 + i, 5 + j, 1, 1)
		}
		x.fillStyle = "#fff8c8"
		x.fillRect(3, 3, 1, 1)
		x.fillRect(20, 10, 1, 1)
	}
	return c
}
const cardEls: HTMLElement[] = []
function drawStrip() {
	while (cardEls.length > day.length) cardEls.pop()!.remove()
	for (let i = cardEls.length; i < day.length; i++) {
		const el = document.createElement("button")
		el.className = "card new"
		el.dataset.i = String(i)
		el.append(drawIcon(day[i].kind))
		el.insertAdjacentHTML(
			"beforeend",
			`<b>${i === 0 ? "7:00" : clock(day[i].time)}</b><span>${day[i].text}</span>`,
		)
		cardsEl.append(el)
		cardEls.push(el)
		requestAnimationFrame(() => el.classList.remove("new"))
	}
	cardEls.forEach((el, i) => {
		el.classList.toggle("here", i === at)
		el.classList.toggle("ahead", i > at)
	})
	strip.badge(at < day.length - 1 ? `${day.length - 1 - at} ahead` : "", "wait")
	board.redraw()
}
// a change while back: the cards after where you are fall away
function dropFuture() {
	const gone = day.splice(at + 1)
	const els = cardEls.splice(at + 1)
	for (const el of els) {
		el.classList.add("gone")
		el.removeAttribute("data-i")
		setTimeout(() => el.remove(), 700)
	}
	return gone
}

// ---- the wheel: drag it round; one notch per card -------------------------------------------
const SWEEP = 140
const wheel = (() => {
	const NS = "http://www.w3.org/2000/svg"
	const el = document.createElement("div")
	el.className = "wheel"
	el.innerHTML = `<svg viewBox="0 0 240 240" tabindex="0" role="slider" aria-label="time of day">
		<circle class="ring" cx="120" cy="120" r="114"/>
		<path class="arc" d=""/>
		<g class="notches"></g>
		<circle class="shadow" cx="124" cy="124" r="80"/>
		<g class="knob">
			<circle class="face" cx="120" cy="120" r="80"/>
			<g class="knurl"></g>
			<rect class="pointer" x="116" y="44" width="8" height="30" rx="3"/>
			<circle class="dimple" cx="120" cy="62" r="0"/>
		</g>
		<text class="time" x="120" y="126" text-anchor="middle">7:00</text>
		<text class="where" x="120" y="146" text-anchor="middle">now</text>
	</svg>
	<div class="ends"><button class="chip" data-to="0">this morning</button><span class="hint small">drag the wheel</span><button class="chip" data-to="now">now</button></div>`
	const svg = el.querySelector("svg")!
	const knob = svg.querySelector<SVGGElement>(".knob")!
	const shadow = svg.querySelector<SVGCircleElement>(".shadow")!
	const notches = svg.querySelector<SVGGElement>(".notches")!
	const arc = svg.querySelector<SVGPathElement>(".arc")!
	const knurl = svg.querySelector<SVGGElement>(".knurl")!
	for (let i = 0; i < 48; i++) {
		const l = document.createElementNS(NS, "line")
		const a = (i / 48) * Math.PI * 2
		l.setAttribute("x1", String(120 + Math.sin(a) * 72))
		l.setAttribute("y1", String(120 - Math.cos(a) * 72))
		l.setAttribute("x2", String(120 + Math.sin(a) * 79))
		l.setAttribute("y2", String(120 - Math.cos(a) * 79))
		knurl.append(l)
	}
	const pt = (deg: number, r: number) => {
		const a = (deg * Math.PI) / 180
		return [120 + Math.sin(a) * r, 120 - Math.cos(a) * r] as const
	}
	const angleOf = (i: number) =>
		day.length < 2 ? -SWEEP : -SWEEP + (2 * SWEEP * i) / (day.length - 1)
	let angle = -SWEEP
	let dragging = false
	function turn(deg: number, smooth: boolean) {
		angle = deg
		knob.style.transition = smooth ? "transform .25s cubic-bezier(.3,1.6,.5,1)" : "none"
		knob.style.transform = `rotate(${deg}deg)`
		// the arc from this morning to here: how far back you are
		const [x0, y0] = pt(-SWEEP, 100), [x1, y1] = pt(deg, 100)
		arc.setAttribute(
			"d",
			deg <= -SWEEP + 0.5
				? ""
				: `M ${x0} ${y0} A 100 100 0 ${deg + SWEEP > 180 ? 1 : 0} 1 ${x1} ${y1}`,
		)
	}
	function set() {
		notches.innerHTML = ""
		for (let i = 0; i < day.length; i++) {
			const [x0, y0] = pt(angleOf(i), 104), [x1, y1] = pt(angleOf(i), 113)
			const l = document.createElementNS(NS, "line")
			l.setAttribute("x1", String(x0))
			l.setAttribute("y1", String(y0))
			l.setAttribute("x2", String(x1))
			l.setAttribute("y2", String(y1))
			l.setAttribute("class", i === at ? "here" : i > at ? "ahead" : "")
			notches.append(l)
		}
		svg.querySelector(".time")!.textContent = clock(day[at].time)
		svg.querySelector(".where")!.textContent = at === day.length - 1
			? "now"
			: at === 0
			? "this morning"
			: `${day.length - 1 - at} back`
		svg.setAttribute("aria-valuenow", String(at))
		svg.setAttribute("aria-valuetext", `${clock(day[at].time)}: ${day[at].text}`)
		wheelBox.badge(at < day.length - 1 ? `back at ${clock(day[at].time)}` : "", "hot")
		el.classList.toggle("back", at < day.length - 1)
		pic.tone(at < day.length - 1 ? "hot" : undefined)
		pic.badge(at < day.length - 1 ? `as at ${clock(day[at].time)}` : "", "hot")
		if (!dragging) turn(angleOf(at), true)
	}
	const pointerAngle = (e: PointerEvent) => {
		const r = svg.getBoundingClientRect()
		const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2)
		return (Math.atan2(dx, -dy) * 180) / Math.PI
	}
	svg.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return
		e.stopPropagation()
		e.preventDefault()
		stopDay()
		svg.setPointerCapture(e.pointerId)
		svg.focus()
		el.classList.remove("keys")
		dragging = true
		el.classList.add("held")
		let last = pointerAngle(e)
		const move = (m: PointerEvent) => {
			const now = pointerAngle(m)
			let d = now - last
			if (d > 180) d -= 360
			if (d < -180) d += 360
			last = now
			turn(Math.max(-SWEEP, Math.min(SWEEP, angle + d)), false)
			const i = day.length < 2
				? 0
				: Math.round(((angle + SWEEP) / (2 * SWEEP)) * (day.length - 1))
			if (i !== at) travel(i)
		}
		const up = () => {
			svg.removeEventListener("pointermove", move)
			svg.removeEventListener("pointerup", up)
			svg.removeEventListener("pointercancel", up)
			dragging = false
			el.classList.remove("held")
			turn(angleOf(at), true)
		}
		svg.addEventListener("pointermove", move)
		svg.addEventListener("pointerup", up)
		svg.addEventListener("pointercancel", up)
	})
	// a wheel or trackpad over it turns it a notch at a time
	let spin = 0
	svg.addEventListener("wheel", (e) => {
		e.preventDefault()
		e.stopPropagation()
		stopDay()
		spin += e.deltaY + e.deltaX
		if (Math.abs(spin) < 40) return
		travel(at + Math.sign(spin))
		spin = 0
	}, { passive: false })
	svg.addEventListener("keydown", (e) => {
		el.classList.add("keys")
		const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]
		const to = e.key === "Home" ? 0 : e.key === "End" ? day.length - 1 : d ? at + d : undefined
		if (to === undefined) return
		e.preventDefault()
		stopDay()
		travel(to)
	})
	el.querySelector(".ends")!.addEventListener("click", (e) => {
		const b = (e.target as HTMLElement).closest<HTMLElement>("[data-to]")
		if (!b) return
		stopDay()
		travel(b.dataset.to === "now" ? day.length - 1 : 0)
	})
	return { el, set }
})()
wheelBox.body.append(wheel.el)

// ---- wires: what each program read, from the scheduler's reports -----------------------------
const reading = new Map<string, Set<string>>()
const wires = new Map<string, Wire>()
const said = (key: string): string => {
	if (key === "apples") return `${peek<number>("apples")} apples`
	if (key === "pigs") return `${Object.keys(pigs()).length} pigs`
	if (key === "weather") {
		const w = peek<Weather>("weather")
		return `${w.heat}°${w.night ? ", night" : ""}`
	}
	const v = results.get(key)
	if (key === "hungry") return `${(v as string[]).length} hungry`
	if (key === "pen") {
		return Object.values(v as Record<string, string>).includes("mud") ? "mud" : "field"
	}
	return String(v)
}
s.onRunStart((c) => {
	ran.add(byComputer.get(c) ?? making)
})
s.onRunEnd((c, _n, ended, reads) => {
	const id = byComputer.get(c) ?? making
	if (ended !== "done") return
	const b = boxes.get(id)!
	const now = new Set(reads as string[])
	const before = reading.get(id) ?? new Set()
	for (const k of now) {
		if (before.has(k)) continue
		const from = boxes.get(k)?.port("out")
		if (!from) continue
		const w = board.wire(from, b.addPort(k, "in"))
		wires.set(`${k}→${id}`, w)
	}
	for (const k of before) {
		if (now.has(k)) continue
		wires.get(`${k}→${id}`)?.remove()
		wires.delete(`${k}→${id}`)
		b.removePort(k)
	}
	reading.set(id, now)
	runs.set(id, (runs.get(id) ?? 0) + 1)
	const n = runs.get(id)!
	b.body.querySelector(".runs")!.textContent = `${id === "farm" ? "drew" : "ran"} ${n} time${
		n === 1 ? "" : "s"
	}`
	b.flash(at < day.length - 1 ? "hot" : "ok")
})
s.onMark((keys) => {
	for (const k of keys as string[]) {
		changedKeys.add(k)
		if (boxes.has(k) && !PROGRAMS.some((p) => p.id === k)) boxes.get(k)!.flash("pick")
	}
})
s.onAfterPulse(() => {
	showEntries()
	for (const [k, w] of wires) {
		const key = k.split("→")[0]
		w.label(said(key))
		if (changedKeys.has(key)) {
			w.tone(at < day.length - 1 ? "hot" : "ok")
			w.flash(at < day.length - 1 ? "hot" : "ok")
		} else w.tone(undefined)
	}
})
// a sentence on what the programs made of a change
function afterAct() {
	const did = ["hungry", "pen", "sign"].filter((p) => ran.has(p))
	return did.length ? ` ${list(did.map((p) => `<b>${p}</b>`))} ran again.` : ""
}

// ---- the picture: pigs walk to where the pen says --------------------------------------------
type Scene = {
	pigs: Pigs
	apples: number
	weather: Weather
	hungry: string[]
	pen: Record<string, string>
	sign: string
}
const shown = new Map<string, { x: number; y: number }>()
let scene: Scene | undefined
// a spot for pig number i of n: the field's spread out, the mud's huddled
function spot(where: string, i: number, n: number, weight: number) {
	const k = pigScale(weight)
	const w = SPRITES.pig[0].length * k, h = SPRITES.pig.length * k
	let cx: number, bottom: number
	if (where === "mud") {
		// round the puddle, staggered so the names don't sit on each other
		cx = 187 + (i - (n - 1) / 2) * 24
		bottom = i % 2 ? 126 : 106
	} else {
		cx = [70, 140, 105, 40, 170, 120][i % 6]
		bottom = [56, 64, 98, 84, 92, 40][i % 6]
	}
	return {
		x: Math.max(0, Math.min(1, (cx - w / 2 - 6) / (240 - 12 - w))),
		y: Math.max(0, Math.min(1, (bottom - h - 14) / (140 - 24 - h))),
	}
}
let walking = false
function paint() {
	if (!scene) return
	const ids = Object.keys(scene.pigs)
	let moving = false
	const out: FarmPig[] = ids.map((id, i) => {
		const pig = scene!.pigs[id]
		const to = spot(scene!.pen[id] ?? "field", i, ids.length, pig.weight)
		const now = shown.get(id) ?? to
		const nx = now.x + (to.x - now.x) * 0.12, ny = now.y + (to.y - now.y) * 0.12
		const close = Math.abs(to.x - nx) + Math.abs(to.y - ny) < 0.004
		if (!close) moving = true
		shown.set(id, close ? to : { x: nx, y: ny })
		const hungry = scene!.hungry.includes(id)
		return {
			name: pig.name,
			weight: pig.weight,
			...shown.get(id)!,
			says: hungry && !scene!.weather.night ? "hungry!" : undefined,
			tone: hungry ? "hot" : undefined,
		}
	})
	for (const id of [...shown.keys()]) if (!(id in scene.pigs)) shown.delete(id)
	farm.draw({ pigs: out, apples: scene.apples, night: scene.weather.night, sign: scene.sign })
	if (moving) requestAnimationFrame(paint)
	else walking = false
}

// ---- make them -------------------------------------------------------------------------------
const root = s.createRootScope({ name: "farm" })
s.runWithScope(root, () => {
	for (const p of PROGRAMS) {
		making = p.id
		const c: Computer = s.createComputer(p.f, (v) => {
			results.set(p.id, v)
			// a program's result is an entry too, written by it
			const e = table.get("value", p.id)
			if (e) update(e, [{ path: [], value: v }], header(p.id, `${p.id} ran`))
			else table.add("value", p.id, createEntry(v, header(p.id, `${p.id} ran`)))
			p.show(v, boxes.get(p.id)!.body)
			s.mark([p.id], c)
		}, sameJSON)
		byComputer.set(c, p.id)
	}
	making = "farm"
	const e = s.createEffect(
		(): Scene => ({
			pigs: read<Pigs>("pigs"),
			apples: read<number>("apples"),
			weather: read<Weather>("weather"),
			hungry: read<string[]>("hungry"),
			pen: read<Record<string, string>>("pen"),
			sign: read<string>("sign"),
		}),
		(next) => {
			scene = structuredClone(next)
			if (!walking) {
				walking = true
				requestAnimationFrame(paint)
			}
		},
	)
	byComputer.set(e, "farm")
	making = ""
})
s.pulse()
showEntries()
drawStrip()
wheel.set()
for (const [k, w] of wires) w.label(said(k.split("→")[0]))

// a box turned over grows to fit its code, and back
for (const b of board.world.querySelectorAll<HTMLElement>(".box")) {
	const w = b.style.width
	new MutationObserver(() => {
		b.style.width = b.classList.contains("flipped") ? "" : w
	}).observe(b, { attributes: true, attributeFilter: ["class"] })
}

// turning hungry over ticks the last try
board.el.addEventListener("click", (e) => {
	const f = (e.target as HTMLElement).closest(".box-flip")
	if (f && f.closest<HTMLElement>(".box")?.dataset.id === "hungry") page.tick("flip")
}, true)

// ---- the day plays out ------------------------------------------------------------------------
const SCRIPT: [number, () => void][] = [
	[7 * 60 + 30, () => drop(3, 7 * 60 + 30)],
	[8 * 60 + 15, () => feed("wilbur", 8 * 60 + 15)],
	[9 * 60 + 40, () => warm(true, 9 * 60 + 40)],
	[11 * 60 + 20, () => rename("dot", "pumpkin", 11 * 60 + 20)],
	[13 * 60 + 5, () => piglet(13 * 60 + 5)],
	[14 * 60 + 30, () => feed("pip", 14 * 60 + 30)],
	[16 * 60, () => feed("petunia", 16 * 60)],
	[18 * 60 + 10, () => warm(false, 18 * 60 + 10)],
	[20 * 60 + 30, () => night(true, 20 * 60 + 30)],
]
let playing: ReturnType<typeof setTimeout> | undefined
const fast = new URLSearchParams(location.search).has("now")
function stopDay() {
	if (playing === undefined) return
	clearTimeout(playing)
	playing = undefined
}
function playDay(i = 0) {
	if (i >= SCRIPT.length) {
		playing = undefined
		return page.say("That was the day. Now turn the wheel back.", "ok")
	}
	SCRIPT[i][1]()
	if (fast) return playDay(i + 1)
	playing = setTimeout(() => playDay(i + 1), 1300)
}
page.say("7:00, this morning. Three pigs, an empty trough.")
requestAnimationFrame(() => board.fit())
playing = setTimeout(() => playDay(), fast ? 0 : 1400)
