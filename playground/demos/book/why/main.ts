/// <reference lib="dom" />
// why is she so big? the farm's keys (apples, hour) are set from outside by buttons; programs the
// real scheduler runs work out who's hungry and what each pig weighs; an effect draws the farm.
// click a pig and the page walks back from her weight: the write that made it, the run that wrote
// it and what that run read, and on, to the writes from outside, each with its file and line.
// the records and the walk are store.ts's (the page's); who wrote what is the scheduler's word.
import { type Computer, createScheduler } from "@ermine/scheduler"
import { pondPage } from "../kit/page.ts"
import type { Box, Wire } from "../kit/board.ts"
import { createFarm } from "../kit/farm.ts"
import { icon } from "../kit/sprites.ts"
import { createStore, type Hop, trail, written } from "./store.ts"

const page = pondPage("why", {
	say:
		`<p>Every write in ermine says who made it: a program's run, or nobody, which means it came from outside. A write from outside also notes the line of code that made it.</p>
		<p>So any value can be asked <b>why?</b> and followed back, hop by hop, to the people and the code that set it off.</p>`,
	tries: [
		{ id: "apples", text: "Drop some apples. Only rosie eats them." },
		{ id: "noon", text: "Press <b>an hour later</b> until it's noon. Somebody gets very big." },
		{ id: "why", text: "Click rosie on the farm to ask <b>why?</b>" },
		{ id: "walk", text: "Press <b>on →</b> until you reach something you did." },
		{ id: "pip", text: "Ask pip too. Her trail never touches the apples." },
	],
	rules:
		`<p><b>who wrote it:</b> a write is <code>mark(keys, run)</code>. A program's write passes its own run (<code>getRun()</code>); no run means from outside.</p>
		<p><b>what it read:</b> the scheduler tells each run's reads when it ends (<code>onRunEnd</code>). As it reads, the page notes which write it got.</p>
		<p><b>where:</b> a write from outside captures the file and line that called it (<code>capture</code>). The page finds the line as written through vite's source map.</p>
		<p><b>the trail:</b> start at a value, find the write that made it, then the writes its run read, and on, until every branch ends outside.</p>
		<p><b>same answer:</b> a run that works out the same value writes nothing, so the trail names the run that last <i>changed</i> it.</p>`,
	real:
		`Runs the real <code>@ermine/scheduler</code> (createComputer, createEffect, track, mark, getRun, onRunEnd) and <code>capture</code> from <code>@ermine/util/stacktrace</code>. There's no <code>why()</code> in ermine: the page keeps each key's last write and each run's reads (store.ts, on the store box's back) and walks the trail itself. "You" means the click was a real one (<code>isTrusted</code>).`,
})
const { board } = page

// ---- the scheduler, the store ---------------------------------------------------------------
const s = createScheduler()
const names = new Map<Computer, string>()
const store = createStore(s, (c) => names.get(c) ?? "?")
const TITLE: Record<string, string> = {
	"grow-rosie": "grow rosie",
	"grow-pip": "grow pip",
	clock: "clock",
	farm: "the farm",
}
// which box a key's value comes out of
const SOURCE: Record<string, string> = {
	apples: "apples",
	hour: "hour",
	hungry: "clock",
	rosie: "grow-rosie",
	pip: "grow-pip",
}
const hourText = (h: number) => h === 12 ? "noon" : h < 12 ? `${h} am` : `${h - 12} pm`
const said = (key: string, v: unknown) => key === "hour" ? hourText(v as number) : String(v)
const time = (t: number) => new Date(t).toTimeString().slice(0, 8)
// the walk: on or not, its hops, the one shown; what the farm drew last, and by which effect
let walking = false
let hops: Hop[] = []
let at = 0
let now = { rosie: 0, pip: 0, apples: 0, hour: 9 }
let farmEffect: Computer
let told = ""
let ready = false

// ---- the keys: set from outside, by buttons -------------------------------------------------
const applesBox = board.box({
	id: "apples",
	x: 40,
	y: 60,
	title: "apples",
	kind: "key",
	outs: [["out", ""]],
	width: 190,
})
applesBox.body.innerHTML =
	`<div class="why-count"><span class="big"></span><span class="why-apples"></span></div>
	<button class="b go why-btn" data-via="drop apples">drop apples</button>`
const dropBtn = applesBox.body.querySelector<HTMLButtonElement>("button")!
dropBtn.onclick = function dropApples(e) {
	told = "Four more apples"
	store.write("apples", (store.get("apples") as number) + 4, { via: "drop apples", event: e })
	page.tick("apples")
}
applesBox.code(`button.onclick = (e) =>
  store.write("apples", apples + 4,
    { via: "drop apples", event: e })`)

const hourBox = board.box({
	id: "hour",
	x: 40,
	y: 330,
	title: "hour",
	kind: "key",
	outs: [["out", ""]],
	width: 190,
})
hourBox.body.innerHTML = `<div class="big"></div>
	<button class="b go why-btn" data-via="an hour later">an hour later</button>`
const laterBtn = hourBox.body.querySelector<HTMLButtonElement>("button")!
laterBtn.onclick = function anHourLater(e) {
	const h = store.get("hour") as number
	told = `${hourText(h >= 21 ? 6 : h + 1)[0].toUpperCase()}${
		hourText(h >= 21 ? 6 : h + 1).slice(1)
	}`
	store.write("hour", h >= 21 ? 6 : h + 1, { via: "an hour later", event: e })
}
hourBox.code(`button.onclick = (e) =>
  store.write("hour", hour >= 21 ? 6 : hour + 1,
    { via: "an hour later", event: e })`)
const buttons: Record<string, HTMLElement> = { "drop apples": dropBtn, "an hour later": laterBtn }

function showKeys() {
	const n = store.get("apples") as number
	applesBox.body.querySelector(".big")!.textContent = String(n)
	const row = applesBox.body.querySelector(".why-apples")!
	row.replaceChildren(...Array.from({ length: Math.min(n, 12) }, () => icon("apple", 3)))
	hourBox.body.querySelector(".big")!.textContent = hourText(store.get("hour") as number)
}

// ---- the programs -----------------------------------------------------------------------------
type Job = { id: string; x: number; y: number; code: string; f: () => unknown }
const JOBS: Job[] = [
	{
		id: "clock",
		x: 290,
		y: 350,
		code: `() => read("hour") >= 12 ? "yes" : "no"`,
		f: () => (store.read("hour") as number) >= 12 ? "yes" : "no",
	},
	{
		id: "grow-rosie",
		x: 540,
		y: 60,
		code: `// rosie eats every apple,
// three times as fast when hungry
() => 5 + read("apples") *
  (read("hungry") === "yes" ? 3 : 1)`,
		f: () => 5 + (store.read("apples") as number) * (store.read("hungry") === "yes" ? 3 : 1),
	},
	{
		id: "grow-pip",
		x: 540,
		y: 360,
		code: `// pip won't touch apples
() => read("hungry") === "yes" ? 8 : 6`,
		f: () => store.read("hungry") === "yes" ? 8 : 6,
	},
]
const OUT: Record<string, string> = { clock: "hungry", "grow-rosie": "rosie", "grow-pip": "pip" }
const boxes = new Map<string, Box>([["apples", applesBox], ["hour", hourBox]])
for (const j of JOBS) {
	const b = board.box({
		id: j.id,
		x: j.x,
		y: j.y,
		title: TITLE[j.id],
		kind: "compute",
		outs: [["out", ""]],
		width: 170,
	})
	b.body.innerHTML = `<div class="mid"></div><div class="small runs"></div>`
	b.code(j.code)
	boxes.set(j.id, b)
}

// the farm: an effect reads what it draws, and draws in its act
const farmBox = board.box({ id: "farm", x: 800, y: 40, title: "the farm", kind: "effect" })
const canvas = document.createElement("canvas")
canvas.title = "click a pig to ask why"
farmBox.body.append(canvas)
farmBox.body.insertAdjacentHTML(
	"beforeend",
	`<div class="why-asks"><button class="b" data-pig="rosie"></button><button class="b" data-pig="pip"></button></div>`,
)
farmBox.code(`createEffect(
  () => ({
    rosie: read("rosie"),
    pip: read("pip"),
    apples: read("apples"),
    hour: read("hour"),
  }),
  (scene) => farm.draw(scene),
)`)
boxes.set("farm", farmBox)
const farm = createFarm(canvas)

// the store, with its code on its back
const storeBox = board.box({ id: "store", x: 40, y: 560, title: "store", kind: "note", width: 190 })
storeBox.body.innerHTML =
	`<div class="small">keys live in a Map. every write is noted: by which run, or from where outside.</div>`
storeBox.code(`function read(key) {
  s.track(key)
  // in a run: note which write it got
  const run = s.getRun()
  if (run) runOf(run).reads.push(last.get(key))
  return values.get(key)
}

function write(key, value, from) {
  const run = s.getRun()
  const w = { key, value, at: Date.now() }
  if (run) w.run = runOf(run)
  // from outside: the line that called
  else w.site = capture(ours, write), w.via = from?.via
  values.set(key, value)
  last.set(key, w)
  s.mark([key], run)
}`)

// the trail, and the walk along it
const whyBox = board.box({ id: "why", x: 800, y: 470, title: "why?", kind: "picture", width: 390 })
whyBox.body.innerHTML = `<div class="why-idle small">click a pig on the farm</div>
	<div class="why-trail" hidden>
		<div class="why-hops"></div>
		<div class="why-where small"></div>
		<div class="why-steps"><button class="b" data-d="-1">← back</button><span class="why-n small"></span><button class="b go" data-d="1">on →</button></div>
	</div>`
whyBox.code(`// start at what the farm read
let hops = [{ w: farmRun.reads[rosie], by: farmRun }]
// then the writes each run read
for (const { w } of hops)
  for (const r of w.run?.reads ?? [])
    if (!seen(r)) hops.push({ w: r, by: w.run })
// a hop with no run came from outside:
// it has a site, a time, and a button`)

// beside it: what other software does instead
const elsewhere = board.box({
	id: "elsewhere",
	x: 540,
	y: 540,
	title: "elsewhere",
	kind: "note",
	width: 220,
})
elsewhere.body.innerHTML =
	`<p class="why-else">A spreadsheet shows a cell's formula, but not who typed the numbers it uses, when, or from where.</p>
	<p class="why-else">In most apps a value just is what it is. To find out why, you add logging and try again.</p>`

// ---- wires: from what each run read (the scheduler's onRunEnd) ------------------------------
const wires = new Map<string, Wire>() // "key→reader"
const runs = new Map<string, number>()
s.onRunEnd((c, n, ended, reads) => {
	const id = names.get(c)
	if (!id || ended !== "done") return
	runs.set(id, n)
	const b = boxes.get(id)!
	for (const k of reads as string[]) {
		if (wires.has(`${k}→${id}`)) continue
		const w = board.wire(boxes.get(SOURCE[k])!.port("out"), b.addPort(k, "in"))
		wires.set(`${k}→${id}`, w)
	}
	const r = b.body.querySelector(".runs")
	if (r) r.textContent = `run ${n}`
	if (!walking) b.flash("ok")
})
const label = () => {
	for (const [k, w] of wires) {
		const key = k.split("→")[0]
		w.label(said(key, store.get(key)))
	}
}
// what ran in a pulse, said after it, for a write from outside
const ran: string[] = []
s.onRunStart((c) => void ran.push(names.get(c) ?? ""))
s.onAfterPulse(() => {
	showKeys()
	if (!walking) label()
	if (ready && told) {
		const jobs = [...new Set(ran)].filter((id) => id !== "farm").map((id) =>
			`<b>${TITLE[id]}</b>`
		)
		const rosie = store.get("rosie") as number
		page.say(
			`${told}. ${
				jobs.length
					? `${jobs.slice(0, -1).join(", ")}${jobs.length > 1 ? " and " : ""}${
						jobs.at(-1)
					} ran again`
					: "No program read it"
			}${
				jobs.length === 1 && ran.includes("clock")
					? `, but hungry is still ${store.get("hungry")}, so neither grow program ran`
					: ""
			}${rosie >= 25 ? `, and rosie is ${rosie} now` : ""}.`,
			rosie >= 25 ? "hot" : undefined,
		)
	}
	ran.length = 0
	told = ""
})

// ---- make them ------------------------------------------------------------------------------
s.runWithScope(s.createRootScope({ name: "farm" }), () => {
	for (const j of JOBS) {
		const c: Computer = s.createComputer(j.f, (v) => {
			// a program's own write: the store passes its run (getRun) to mark
			store.write(OUT[j.id], v)
			boxes.get(j.id)!.body.querySelector(".mid")!.textContent = `${OUT[j.id]}: ${v}`
			if (ready && j.id === "clock" && v === "yes") page.tick("noon")
		})
		names.set(c, j.id)
	}
	const e = s.createEffect(
		() => ({
			rosie: store.read("rosie") as number,
			pip: store.read("pip") as number,
			apples: store.read("apples") as number,
			hour: store.read("hour") as number,
		}),
		(scene) => {
			now = scene
			draw()
			for (const b of farmBox.body.querySelectorAll<HTMLElement>("[data-pig]")) {
				const p = b.dataset.pig as "rosie" | "pip"
				b.textContent = `why is ${p} ${scene[p]}?`
			}
		},
	)
	names.set(e, "farm")
	farmEffect = e
})
function draw() {
	const asked = walking ? hops[0].w.key : ""
	farm.draw({
		pigs: [
			{
				name: "rosie",
				weight: now.rosie,
				x: 0.3,
				y: 0.42,
				tone: asked === "rosie" ? "hot" : undefined,
				says: asked === "rosie" ? "why?" : undefined,
			},
			{
				name: "pip",
				weight: now.pip,
				x: 0.68,
				y: 0.5,
				tone: asked === "pip" ? "hot" : undefined,
				says: asked === "pip" ? "why?" : undefined,
			},
		],
		apples: now.apples,
		night: now.hour >= 20,
		sign: walking ? undefined : "click a pig: why?",
	})
}

// the morning, as the page loads: two writes from outside, by this page's own code
store.write("hour", 9)
store.write("apples", 2)
ready = true

// ---- asking why -------------------------------------------------------------------------------
const where = new Map<Hop, string>()

function ask(pig: "rosie" | "pip") {
	const run = store.run(farmEffect)!
	const w = run.reads.find((r) => r.key === pig)!
	hops = trail(w, run)
	walking = true
	at = 0
	whyBox.title(`why is ${pig} ${w.value}?`)
	whyBox.body.querySelector<HTMLElement>(".why-idle")!.hidden = true
	whyBox.body.querySelector<HTMLElement>(".why-trail")!.hidden = false
	const row = whyBox.body.querySelector(".why-hops")!
	row.innerHTML = hops.map((h, i) =>
		`<button class="chip" data-hop="${i}">${h.w.key} ${said(h.w.key, h.w.value)}</button>`
	).join("")
	for (const h of hops) {
		if (h.w.site) {
			written(h.w.site).then((p) => {
				where.set(h, `${p.path.replace(/^playground\/demos\//, "")}:${p.line}`)
				if (walking && hops[at] === h) show()
			})
		}
	}
	farmBox.tone("pick")
	page.tick(pig === "rosie" ? "why" : "pip")
	show()
}

function stop() {
	if (!walking) return
	walking = false
	hops = []
	for (const b of boxes.values()) b.tone(undefined)
	for (const b of Object.values(buttons)) b.classList.remove("why-lit")
	for (const w of wires.values()) w.tone(undefined)
	whyBox.title("why?")
	whyBox.body.querySelector<HTMLElement>(".why-idle")!.hidden = false
	whyBox.body.querySelector<HTMLElement>(".why-trail")!.hidden = true
	label()
	draw()
}

function show() {
	const h = hops[at]
	for (const b of boxes.values()) b.tone(undefined)
	farmBox.tone("pick")
	for (const b of Object.values(buttons)) b.classList.remove("why-lit")
	for (const w of wires.values()) w.tone(undefined), w.dashed(false)
	label()
	// the hops so far: their wires lit, carrying the value as it was read then
	for (let i = 0; i <= at; i++) {
		const { w, by } = hops[i]
		const wire = wires.get(`${w.key}→${by.name}`)
		wire?.tone("hot")
		wire?.label(said(w.key, w.value))
	}
	// this hop's run: what it read, as it read it
	if (h.w.run) {
		for (const r of h.w.run.reads) {
			const wire = wires.get(`${r.key}→${h.w.run.name}`)
			wire?.label(said(r.key, r.value))
			if (wire && !hops.slice(0, at + 1).some((x) => x.w === r)) wire.dashed(true)
		}
	}
	const box = boxes.get(SOURCE[h.w.key])!
	box.tone("hot")
	box.flash("hot")
	if (h.w.via) buttons[h.w.via]?.classList.add("why-lit")
	wires.get(`${h.w.key}→${h.by.name}`)?.flash("hot")
	draw()

	// the chips, the line under them, the steps
	whyBox.body.querySelectorAll<HTMLElement>("[data-hop]").forEach((c) =>
		c.setAttribute("aria-pressed", String(Number(c.dataset.hop) === at))
	)
	const site = where.get(h) ?? "…"
	whyBox.body.querySelector(".why-where")!.innerHTML = h.w.run
		? `written by <b>${TITLE[h.w.run.name]}</b> · run ${h.w.run.n} · ${time(h.w.at)}`
		: `from outside · ${
			h.w.via ? `${h.w.you ? "you pressed" : "pressed"} <b>${h.w.via}</b>` : "the page's setup"
		} · <code>${site}</code> · ${time(h.w.at)}`
	whyBox.body.querySelector(".why-n")!.textContent = `${at + 1} of ${hops.length}`
	const [back, on] = whyBox.body.querySelectorAll<HTMLButtonElement>("[data-d]")
	back.disabled = at === 0
	on.disabled = at === hops.length - 1
	page.say(sentence(h, at === hops.length - 1), "hot")
	if (!h.w.run && h.w.you) page.tick("walk")
}

function sentence(h: Hop, end: boolean): string {
	const { w } = h
	const v = `<code>${w.key}</code> = ${said(w.key, w.value)}`
	let say: string
	if (w.run) {
		const read = w.run.reads.map((r) => `${r.key} = ${said(r.key, r.value)}`)
		const by = `<b>${TITLE[w.run.name]}</b>'s run ${w.run.n}`
		const after = `after reading ${read.join(" and ")}`
		say = h.by.name === "farm"
			? `The farm drew ${v}. ${by} wrote it at ${time(w.at)}, ${after}.`
			: `${v} was written by ${by} at ${time(w.at)}, ${after}.`
	} else {
		const site = `<code>${where.get(h) ?? "…"}</code>`
		say = w.via
			? `No program wrote ${v}: ${w.you ? "you" : "something"} pressed <b>${w.via}</b> at ${
				time(w.at)
			}, and the write came from ${site}.`
			: `No program wrote ${v}: this page's setup code did, from ${site}, as it loaded at ${
				time(w.at)
			}.`
	}
	if (end) {
		const outside = hops.filter((x) => !x.w.run).length
		say += ` That's the end of the trail: ${
			outside === 1 ? "one write" : `${outside} writes`
		} from outside.`
	}
	return say
}

function step(d: number) {
	if (!walking) return
	const n = Math.max(0, Math.min(hops.length - 1, at + d))
	if (n === at) return
	at = n
	show()
}

// clicks: a pig, a why button, a hop, back and on
canvas.onclick = (e) => {
	const p = farm.pigAt(e.clientX, e.clientY)
	if (p) ask(p.name as "rosie" | "pip")
}
farmBox.body.querySelector(".why-asks")!.addEventListener("click", (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pig]")
	if (b) ask(b.dataset.pig as "rosie" | "pip")
})
whyBox.body.addEventListener("click", (e) => {
	const t = e.target as HTMLElement
	const hop = t.closest<HTMLElement>("[data-hop]")
	if (hop) (at = Number(hop.dataset.hop), show())
	const d = t.closest<HTMLElement>("[data-d]")
	if (d) step(Number(d.dataset.d))
})
addEventListener("keydown", (e) => {
	if (e.key === "ArrowRight") step(1)
	if (e.key === "ArrowLeft") step(-1)
	if (e.key === "Escape") stop()
})
// a new write from outside: the trail was about the farm before it, so it's put away (what
// the pulse did is said instead)
s.onMark((_keys, run) => {
	if (!run) stop()
})

// a little style of the page's own
const style = document.createElement("style")
style.textContent = `
.why-count { display: flex; align-items: center; gap: 8px; min-height: 34px; }
.why-apples { display: flex; flex-wrap: wrap; gap: 2px; max-width: 120px; }
.why-btn { margin-top: 8px; width: 100%; }
.why-btn.why-lit { outline: 3px solid var(--cherry); outline-offset: 2px; }
.why-asks { display: flex; gap: 6px; margin-top: 6px; }
.why-asks .b { flex: 1; }
.why-hops { display: flex; flex-wrap: wrap; gap: 4px; }
.why-where { margin: 8px 0; color: var(--ink); line-height: 1.4; }
.why-where code { font: 11px var(--mono); background: var(--lemon); padding: 0 3px; }
.why-steps { display: flex; align-items: center; gap: 8px; }
.why-steps .why-n { flex: 1; text-align: center; }
.why-else { margin: 0 0 6px; font-size: 0.9rem; line-height: 1.35; }
.why-else:last-child { margin: 0; }
`
document.head.append(style)
requestAnimationFrame(() => board.fit())
