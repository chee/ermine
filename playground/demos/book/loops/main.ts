/// <reference lib="dom" />
// loops: the pond's life cycle. fish lay eggs, eggs hatch into young, the young grow up. three
// computers the real scheduler runs, wired in a chain from an outside "stock the pond" write. the
// reader closes the circle by dragging grow's out onto fish; then grow's write comes back to lay,
// and the scheduler ends a run "looping", its more.through the circle, lit cherry and numbered.
import { type Computer, createScheduler, type Ended, type More } from "@ermine/core/scheduler"
import { pondPage } from "../kit/page.ts"
import type { Box, Port } from "../kit/board.ts"
import { chart, createPond, icon } from "../kit/sprites.ts"

const page = pondPage("loops", {
	say:
		`<p>Fish lay eggs, eggs hatch, the young grow up. Each step is a <b>computer</b>: it reads one thing and writes the next.</p>
		<p>Close the circle and grow's write comes back to lay, which already ran. The scheduler sees the loop, gives it <b>one more go</b>, and stops it there.</p>`,
	tries: [
		{ id: "stock", text: "Stock the pond with 3 fish. Watch it run down the chain." },
		{ id: "loop", text: "Close the circle: drag <b>grow</b>'s out dot onto <b>fish</b>." },
		{
			id: "small",
			text:
				"Give lay a <b>nest of 12</b> eggs at most, then stock 1 fish. Too few to fill it: a loop.",
		},
		{ id: "settle", text: "Now stock 3 fish. The nest fills, and the circle <b>settles</b>." },
		{ id: "flip", text: "Press <b>{ }</b> on a box to turn it over and read its code." },
	],
	rules:
		`<p><b>set:</b> a computer's result goes to its set. Here set writes one key and says so: <code>mark([key], run)</code>.</p>
		<p><b>naming the run:</b> makes the computer that key's writer, and the change carries the run's cause: the runs that led to it, this pulse.</p>
		<p><b>a loop:</b> a write makes due a computer that already ran this pulse, and the causes lead back to that run. The scheduler sees it at the mark and flags the next run.</p>
		<p><b>one more go:</b> the flagged run runs. The same result as before: it ends done, nothing is set, and the circle has settled. A new result: still nothing is set, and it ends <code>looping</code>.</p>
		<p><b>through:</b> <code>more.through</code> lists the computers on the circle, in the order they were made. The numbers on the boxes are that order.</p>
		<p><b>waits:</b> a computer that ended looping is due again only by a change from outside the loop.</p>
		<p><b>from outside:</b> a write that names no run has no cause and teaches no writer. It is never a loop.</p>
		<p><b>not shown here:</b> a flagged run that writes into its circle again is cut there: that mark makes nothing due, and it ends looping. A mark of a key held from an older run, not read in the latest, is a retry: it runs again, but it is no loop.</p>`,
	real:
		`Runs the real <code>@ermine/core/scheduler</code>: createScheduler, a root scope, createComputer, track, mark and pulse. The loop, its through list and each write's run come from its own listeners (onMark, onRunEnd); "waits" is the computer's own <code>looping</code>. The page keeps the keys in a Map, draws the pond and the chart after each pulse, and makes a computer again when you rewire it.`,
})
const { board } = page

// ---- the store: keys and values, the page's own ------------------------------------------------
const s = createScheduler()
const store = new Map<string, number>()
function read(key: string) {
	s.track(key)
	return store.get(key) ?? 0
}
// run: who wrote it. none: from outside
function write(key: string, value: number, run?: ReturnType<typeof s.getRun>) {
	store.set(key, value)
	s.mark([key], run)
}
const STORE_CODE = `const store = new Map()

// a read: tell the scheduler, then look
function read(key) {
  s.track(key)
  return store.get(key)
}

// a write: keep it, then say so.
// run: who wrote it; none means
// from outside
function write(key, value, run) {
  store.set(key, value)
  s.mark([key], run)
}`

// ---- the computers: what each reads and writes, and its sum -------------------------------------
type Job = {
	id: "lay" | "hatch" | "grow"
	// the key it writes when it isn't wired to fish
	own: string
	from: string
	to: string
	sum: (x: number) => number
	says: (from: string, to: string) => string
	// the run's code, as written below
	js: (r: string) => string
	c?: Computer
	box?: Box
}
let cap = 0
const jobs: Job[] = [
	{
		id: "lay",
		own: "eggs",
		from: "fish",
		to: "eggs",
		sum: (x) => cap ? Math.min(x * 4, cap) : x * 4,
		says: (f, t) => cap ? `${t} = min(${f} × 4, ${cap})` : `${t} = ${f} × 4`,
		js: (r) => cap ? `Math.min(${r} * 4, ${cap})` : `${r} * 4`,
	},
	{
		id: "hatch",
		own: "young",
		from: "eggs",
		to: "young",
		sum: (x) => Math.floor(x / 2),
		says: (f, t) => `${t} = ${f} ÷ 2`,
		js: (r) => `Math.floor(${r} / 2)`,
	},
	{
		id: "grow",
		own: "grown",
		from: "young",
		to: "grown",
		sum: (x) => x,
		says: (f, t) => `${t} = ${f}`,
		js: (r) => r,
	},
]
const jobOf = (c: Computer) => jobs.find((j) => j.c === c)?.id ?? String(c.info.job)
const root = s.createRootScope({ page: "loops" })

function make(j: Job) {
	return s.runWithScope(root, () =>
		s.createComputer(
			() => j.sum(read(j.from)),
			(v) => write(j.to, v, s.getRun()),
			undefined,
			undefined,
			{ job: j.id },
		))
}
const codeOf = (j: Job) =>
	`// ${j.id}: reads ${j.from}, writes ${j.to}
s.createComputer(
  // the run: what it works out
  () => ${j.js(`read("${j.from}")`)},
  // its set: the result, written
  // by this run (it names itself)
  (v) => write("${j.to}", v,
    s.getRun()),
)`

// ---- the boxes ---------------------------------------------------------------------------------
const stock = board.box({
	id: "stock",
	x: -240,
	y: 520,
	title: "stock the pond",
	kind: "key",
	outs: [["out", ""]],
	width: 170,
})
stock.body.innerHTML = `<div class="chips">${
	[1, 3, 5].map((n) => `<button class="chip" data-n="${n}">${n} fish</button>`).join("")
}</div><div class="small" style="margin-top:4px">a write from outside</div>`
stock.code(`// a click: a write that names no run
write("fish", n)
s.pulse()`)

const fish = board.box({
	id: "fish",
	x: 0,
	y: 380,
	title: "fish",
	kind: "key",
	ins: [["stock", "outside"], ["in", "a run"]],
	outs: [["out", ""]],
	width: 200,
})
fish.body.innerHTML =
	`<div style="display:flex;align-items:center;gap:8px"><span class="big" data-v>0</span></div>`
fish.body.firstElementChild!.prepend(icon("fish", 3))

const AT: Record<Job["id"], [number, number]> = {
	lay: [230, 0],
	hatch: [530, 0],
	grow: [790, 0],
}
for (const j of jobs) {
	const b = board.box({
		id: j.id,
		x: AT[j.id][0],
		y: AT[j.id][1],
		title: j.id,
		kind: "compute",
		width: j.id === "lay" ? 240 : 190,
	})
	j.box = b
	b.body.innerHTML =
		`<div class="mid" data-sum style="font-size:14px"></div><div class="small" data-end>not run</div>${
			j.id === "lay"
				? `<div class="chips" style="margin-top:4px"><button class="chip" data-cap="0">no limit</button><button class="chip" data-cap="12">nest of 12</button></div>`
				: ""
		}`
}

const pic = board.box({ id: "pond", x: 400, y: 580, title: "the pond", kind: "picture" })
const canvas = document.createElement("canvas")
pic.body.append(canvas)
const pond = createPond(canvas, { width: 240, height: 140 })
canvas.style.width = "330px"
canvas.style.height = "192px"

const graph = board.box({
	id: "chart",
	x: 780,
	y: 580,
	title: "fish, pulse by pulse",
	kind: "picture",
})
const chartEl = document.createElement("canvas")
graph.body.append(chartEl)
const counts: number[] = []

const note = board.box({
	id: "store",
	x: 40,
	y: 700,
	title: "store",
	kind: "note",
	width: 170,
})
note.body.innerHTML =
	`<div class="small">the keys live in a Map. turn me over for read and write.</div>`
note.code(STORE_CODE)

// ---- what happened in a pulse: the scheduler's own reports -------------------------------------
type Ev =
	| { t: "mark"; key: string; by?: string; n?: number; due: string[] }
	| { t: "end"; id: string; n: number; ended: Ended; more: More }
let evs: Ev[] = []
const lastBy = new Map<string, { by?: string; n?: number }>()
const ends = new Map<string, Extract<Ev, { t: "end" }>>()

function listen() {
	s.onMark((keys, run, due) => {
		const d = due.map(jobOf)
		for (const k of keys as string[]) {
			const by = run ? jobOf(run.computer) : undefined
			evs.push({ t: "mark", key: k, by, n: run?.n, due: d })
			lastBy.set(k, { by, n: run?.n })
		}
	})
	s.onRunEnd((c, n, ended, _reads, more) => {
		const e = { t: "end" as const, id: jobOf(c), n, ended, more }
		evs.push(e)
		ends.set(e.id, e)
	})
}
listen()

// ---- the wires, from the jobs: what reads what, who writes fish --------------------------------
let lit: string[] = []
const writerOf = (key: string) => jobs.find((j) => j.to === key)
const says = (key: string) => `${store.get(key) ?? 0} ${key}`

function wires() {
	for (const w of board.wires()) w.remove()
	const on = new Set(lit)
	const sw = board.wire(stock.port("out"), fish.port("stock"))
	sw.label("from outside")
	sw.tone("dim")
	for (const j of jobs) {
		const src: Port | undefined = j.from === "fish"
			? fish.port("out")
			: writerOf(j.from)?.box!.port("out")
		if (!src) continue
		const w = board.wire(src, j.box!.port("in"))
		w.label(says(j.from))
		const back = j.from === "fish" ? writerOf("fish") : writerOf(j.from)
		if (on.has(j.id) && back && on.has(back.id)) w.tone("hot")
	}
	for (const j of jobs) {
		if (j.to !== "fish") continue
		const w = board.wire(j.box!.port("out"), fish.port("in"))
		w.label(says("fish"))
		if (on.has(j.id) && jobs.some((r) => r.from === "fish" && on.has(r.id))) w.tone("hot")
	}
	// the move to make, till it's made
	const grow = jobs[2]
	if (!writerOf("fish") && !done.has("loop")) {
		const w = board.wire(grow.box!.port("out"), fish.port("in"))
		w.dashed(true)
		w.tone("dim")
		w.label("drag grow's out here")
	}
}

// the ports carry the key's name: re-made when the wiring changes
function ports(j: Job) {
	const b = j.box!
	b.removePort("in")
	b.removePort("out")
	b.addPort("in", "in", j.from)
	b.addPort("out", "out", j.to)
	b.code(codeOf(j))
}

// ---- drawing: boxes, pond, chart ---------------------------------------------------------------
function draw() {
	const by = lastBy.get("fish")
	fish.body.querySelector("[data-v]")!.textContent = String(store.get("fish") ?? 0)
	if (by) by.by ? fish.badge(`by ${by.by}, run ${by.n}`, "hot") : fish.badge("from outside", "dim")
	for (const j of jobs) {
		const b = j.box!
		b.body.querySelector("[data-sum]")!.textContent = j.says(j.from, j.to)
		const e = ends.get(j.id)
		b.body.querySelector("[data-end]")!.innerHTML = !e
			? "not run"
			: e.ended === "looping"
			? `<b style="color:var(--cherry)">ended looping</b>${j.c!.looping ? " · waits" : ""}`
			: `${e.ended}${e.more.equal ? ", same result" : ""} · run ${e.n}`
		const at = lit.indexOf(j.id)
		b.tone(undefined)
		b.badge("")
		if (at >= 0) {
			// lit one after another, in through's order
			setTimeout(() => {
				b.tone("hot")
				b.badge(String(at + 1), "hot")
			}, at * 260)
		} else if (j.c!.looping) b.badge("waits", "wait")
		for (const c of b.body.querySelectorAll<HTMLElement>("[data-cap]")) {
			c.setAttribute("aria-pressed", String(Number(c.dataset.cap) === cap))
		}
	}
	for (const c of stock.body.querySelectorAll<HTMLElement>("[data-n]")) {
		c.setAttribute("aria-pressed", "false")
	}
	pond.draw({
		fish: store.get("fish") ?? 0,
		eggs: store.get("eggs") ?? 0,
		minnows: store.get("young") ?? 0,
		lilies: 3,
		sign: `${store.get("fish") ?? 0} fish · ${store.get("eggs") ?? 0} eggs · ${
			store.get("young") ?? 0
		} young`,
	})
	chart(chartEl, counts.slice(-24), { width: 240, height: 110, min: 0 })
	wires()
}

// ---- a pulse, and one sentence about it --------------------------------------------------------
function pulse(why: string) {
	s.pulse()
	counts.push(store.get("fish") ?? 0)
	const runs = evs.filter((e) => e.t === "end") as Extract<Ev, { t: "end" }>[]
	const loop = runs.find((e) => e.ended === "looping")
	const twice = (id: string) => runs.filter((e) => e.id === id).length > 1
	const settled = runs.find((e) => e.ended === "done" && e.more.equal && twice(e.id))
	lit = []
	if (loop) {
		lit = (loop.more.through ?? []).map(jobOf)
		// the write that made it due again
		const i = evs.indexOf(loop)
		const m = evs.slice(0, i).reverse().find((e) => e.t === "mark" && e.due.includes(loop.id)) as
			| Extract<Ev, { t: "mark" }>
			| undefined
		page.say(
			`${why} <b>${
				m?.by ?? "a run"
			}</b> wrote <code>${m?.key}</code>, and <b>${loop.id}</b> had read it earlier this pulse: a loop. The scheduler gave ${loop.id} one more go; its result was new, so nothing was set. ${loop.id} ended <b>looping</b>, through ${
				lit.join(" → ")
			}.`,
			"hot",
		)
		page.tick("loop")
		if (cap) page.tick("small")
		done.add("loop")
	} else if (settled) {
		page.say(
			`${why} The circle came back round to <b>${settled.id}</b>, and it gave the same result as before. Nothing more was set: the circle settled.`,
			"ok",
		)
		if (cap) page.tick("settle")
	} else if (runs.length) {
		const ran = runs.map((e) => e.id)
		const last = runs[runs.length - 1]
		page.say(
			`${why} ${ran.map((r) => `<b>${r}</b>`).join(", then ")} ran. ${
				last.more.equal
					? `${last.id} gave the same result as last time, so nothing was set and the pulse ended.`
					: "Nothing came back round, so the pulse ended."
			}`,
		)
	} else page.say(`${why} Nobody was due, so nothing ran.`)
	evs = []
	draw()
}
const done = new Set<string>()

// ---- hands -------------------------------------------------------------------------------------
stock.body.addEventListener("click", (e) => {
	const n = Number((e.target as HTMLElement).closest<HTMLElement>("[data-n]")?.dataset.n)
	if (!n) return
	write("fish", n)
	page.tick("stock")
	pulse(`You stocked ${n} fish, from outside.`)
})

for (const j of jobs) {
	j.box!.body.addEventListener("click", (e) => {
		const c = (e.target as HTMLElement).closest<HTMLElement>("[data-cap]")
		if (!c || Number(c.dataset.cap) === cap) return
		cap = Number(c.dataset.cap)
		remake(j)
		pulse(
			cap ? "lay now keeps at most 12 eggs (made again)." : "lay has no limit now (made again).",
		)
	})
}

// a job rewired, or its sum changed: torn down and made again (new, so due)
function remake(j: Job) {
	if (j.c) s.teardown(j.c)
	j.c = make(j)
	ports(j)
}

board.onConnect((from, to) => {
	const writer = jobs.find((j) => j.box === from.box)
	const reader = jobs.find((j) => j.box === to.box)
	if (writer && to.box === fish) {
		if (writer.to === "fish") return false
		writer.to = "fish"
		remake(writer)
		pulse(`<b>${writer.id}</b> now writes fish (made again).`)
		return
	}
	if (reader) {
		const key = from.box === fish ? "fish" : writer?.to
		if (!key || key === reader.from) return false
		reader.from = key
		remake(reader)
		pulse(`<b>${reader.id}</b> now reads ${key} (made again).`)
		return
	}
	return false
})
board.onDisconnect((w) => {
	const writer = jobs.find((j) => j.box === w.from.box)
	if (writer && w.to.box === fish && writer.to === "fish") {
		writer.to = writer.own
		remake(writer)
		pulse(`<b>${writer.id}</b> writes ${writer.own} again (made again); the circle is open.`)
		return
	}
	wires()
})
board.el.addEventListener("click", (e) => {
	if ((e.target as HTMLElement).closest(".box-flip")) page.tick("flip")
}, true)

// ---- the start: fish 2 from outside, then the computers ----------------------------------------
store.set("fish", 2)
for (const j of jobs) remake(j)
pulse("")
page.say(
	"An open chain: <b>lay</b>, <b>hatch</b> and <b>grow</b> each ran once. Stock the pond to run it again.",
)
// narrow: the notes start folded, so the board has the room (the notes button opens them)
if (innerWidth < 1000) page.notes.querySelector<HTMLElement>(".fold")!.click()
requestAnimationFrame(() => board.fit(90))
