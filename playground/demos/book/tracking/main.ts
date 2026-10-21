/// <reference lib="dom" />
// who read what: the pond's keys on the left as things you set (day, fish, rain), computers in the
// middle that the real scheduler runs, and the pond, drawn by an effect, on the right. a computer
// grows an in-port for each key its last run read, and a wire from that key; what it stopped
// reading loses its port and its wire. a key nobody reads goes dim.
import { type Computer, createScheduler } from "@ermine/scheduler"
import { pondPage } from "../kit/page.ts"
import type { Box, Port, Wire } from "../kit/board.ts"
import { createPond, sprite } from "../kit/sprites.ts"

const page = pondPage("tracking", {
	say:
		`<p>A <b>computer</b> is a small job the scheduler runs. While it runs, every key it reads gets a wire.</p>
		<p>Change a key, and only the computers wired to it run again. The wires are what they read <i>last time</i>, so they can change.</p>`,
	tries: [
		{ id: "fish", text: "Add a fish. Watch which boxes run." },
		{ id: "night", text: "Make it night. The ermine stops watching the fish: its wire goes." },
		{ id: "quiet", text: "Now add fish at night. Nobody's watching, so the ermine sleeps on." },
		{
			id: "pulse",
			text:
				"Turn <b>at once</b> off, change something, see who's <b>due</b>, then press <b>pulse</b>.",
		},
		{ id: "flip", text: "Press <b>{ }</b> on a box to turn it over and read its code." },
	],
	rules:
		`<p><b>track:</b> a run says each key it reads with <code>track(key)</code>. That's the wire.</p>
		<p><b>mark:</b> a write says <code>mark([key])</code>. Every computer that tracked that key is now <b>due</b>.</p>
		<p><b>pulse:</b> runs what's due. Here it happens at once unless you switch that off.</p>
		<p><b>last run only:</b> a computer depends on what its last run read, nothing older. A key read only sometimes is wired only sometimes.</p>
		<p><b>nobody reads it:</b> when the last reader stops, the scheduler says so (<code>onTrackingEnd</code>). A key someone starts reading again: <code>onTrackingStart</code>.</p>
		<p><b>same result:</b> a result equal to the last one isn't passed on. The pond picture only redraws when what it read changed.</p>`,
	real:
		`Runs the real <code>@ermine/scheduler</code>: createScheduler, a root scope, createComputer, createEffect, track, mark and pulse. The wires come from its own listeners (onTrack, onRunEnd, onMark, onTrackingStart, onTrackingEnd); the page draws them, it doesn't guess. The keys live in a Map the page keeps; turn the "store" box over to see all of it.`,
})
const { board } = page

// ---- the store: keys and their values, the page's own --------------------------------------
const s = createScheduler()
const store = new Map<string, unknown>([["day", true], ["fish", 5], ["rain", 0]])
function read(key: string) {
	s.track(key)
	return store.get(key)
}
let atOnce = true
function write(key: string, value: unknown) {
	store.set(key, value)
	s.mark([key])
	if (atOnce) s.pulse()
}
const STORE_CODE = `const store = new Map()

// a read: tell the scheduler, then give the value
function read(key) {
  s.track(key)
  return store.get(key)
}

// a write: keep the value, then say the key changed
function write(key, value) {
  store.set(key, value)
  s.mark([key])
  if (atOnce) s.pulse()
}`

// ---- the keys, as things to touch ---------------------------------------------------------
const keyBoxes = new Map<string, Box>()
function keyBox(id: string, x: number, y: number, fill: (b: HTMLElement) => void) {
	const b = board.box({
		id: `key:${id}`,
		x,
		y,
		title: id,
		kind: "key",
		outs: [["out", ""]],
		width: 190,
	})
	fill(b.body)
	keyBoxes.set(id, b)
	return b
}
keyBox("day", 40, 40, (el) => {
	el.innerHTML =
		`<div class="chips"><button class="chip" data-v="1">day</button><button class="chip" data-v="0">night</button></div>`
	const sync = () =>
		el.querySelectorAll<HTMLElement>(".chip").forEach((c) =>
			c.setAttribute("aria-pressed", String((c.dataset.v === "1") === store.get("day")))
		)
	sync()
	el.onclick = (e) => {
		const c = (e.target as HTMLElement).closest<HTMLElement>(".chip")
		if (!c) return
		const v = c.dataset.v === "1"
		if (v === store.get("day")) return
		changed("day", v ? "day" : "night")
		write("day", v)
		sync()
		if (!v) page.tick("night")
	}
})
keyBox("fish", 40, 170, (el) => {
	el.innerHTML = `<div class="stepper"><button data-d="-1" title="one fewer">−</button><output>${
		store.get("fish")
	}</output><button data-d="1" title="one more">+</button></div>`
	el.onclick = (e) => {
		const d = Number((e.target as HTMLElement).closest<HTMLElement>("[data-d]")?.dataset.d)
		if (!d) return
		const n = Math.max(0, Math.min(30, (store.get("fish") as number) + d))
		el.querySelector("output")!.textContent = String(n)
		changed("fish", `${n} fish`)
		write("fish", n)
		page.tick("fish")
		if (store.get("day") === false && d > 0) page.tick("quiet")
	}
})
keyBox("rain", 40, 330, (el) => {
	el.innerHTML =
		`<input class="slider" type="range" min="0" max="10" value="0" aria-label="rain"><div class="small">dry</div>`
	const input = el.querySelector("input")!
	input.oninput = () => {
		const v = Number(input.value) / 10
		el.querySelector(".small")!.textContent = v === 0 ? "dry" : v < 0.5 ? "drizzle" : "pouring"
		changed("rain", el.querySelector(".small")!.textContent!)
		write("rain", v)
	}
})

// ---- the computers --------------------------------------------------------------------------
type Job = {
	id: string
	title: string
	x: number
	y: number
	kind: "compute" | "effect"
	code: string
	f: () => unknown
	show: (v: unknown, body: HTMLElement) => void
	width?: number
}
const JOBS: Job[] = [
	{
		id: "ermine",
		title: "ermine",
		x: 330,
		y: 20,
		kind: "compute",
		code: `() => read("day")
  ? "watching " + read("fish") + " fish"
  : "asleep"`,
		f: () => read("day") ? `watching ${read("fish")} fish` : "asleep",
		show(v, body) {
			body.querySelector(".mid")!.textContent = String(v)
			drawErmine(v !== "asleep")
		},
		width: 220,
	},
	{
		id: "algae",
		title: "algae",
		x: 330,
		y: 430,
		kind: "compute",
		code: `() => Math.round(read("rain") * 10) / 10`,
		f: () => Math.round((read("rain") as number) * 10) / 10,
		show(v, body) {
			body.querySelector(".mid")!.textContent = `${Math.round((v as number) * 100)}% green`
		},
		width: 220,
	},
]
const results = new Map<string, unknown>()
// the ermine on her bit of grass: awake and looking, or curled up asleep
const ermineTile = document.createElement("canvas")
ermineTile.className = "icon"
ermineTile.width = 64
ermineTile.height = 40
ermineTile.style.width = "128px"
ermineTile.style.height = "80px"
ermineTile.style.display = "block"
ermineTile.style.marginBottom = "6px"
ermineTile.style.border = "1.5px solid #000"
function drawErmine(awake: boolean) {
	const c = ermineTile.getContext("2d")!
	c.fillStyle = awake ? "#7fd36b" : "#203a5c"
	c.fillRect(0, 0, 64, 40)
	c.fillStyle = awake ? "#5bb44a" : "#2c4d78"
	for (let i = 0; i < 18; i++) c.fillRect((i * 37) % 62, 30 + ((i * 7) % 9), 1, 2)
	if (awake) {
		sprite(c, "ermine", 20, 12, 2)
		c.fillStyle = "#ffe23d"
		c.fillRect(54, 4, 5, 5)
	} else {
		sprite(c, "ermine", 20, 16, 2)
		c.fillStyle = "#fff"
		c.font = "8px Monaco, monospace"
		c.fillText("z z", 40, 14)
		c.fillStyle = "#fff8c8"
		c.fillRect(6, 5, 3, 3)
		c.fillRect(16, 9, 1, 1)
		c.fillRect(48, 3, 1, 1)
	}
}
drawErmine(true)
const boxes = new Map<string, Box>()
const byComputer = new Map<Computer, string>()
let making = ""

const root = s.createRootScope({ name: "pond" })
for (const j of JOBS) {
	const b = board.box({
		id: j.id,
		x: j.x,
		y: j.y,
		title: j.title,
		kind: j.kind,
		outs: [["out", ""]],
		width: j.width,
	})
	b.body.innerHTML = `<div class="mid">…</div><div class="small runs">ran 0 times</div>`
	if (j.id === "ermine") b.body.prepend(ermineTile)
	b.code(j.code)
	boxes.set(j.id, b)
}

// the pond picture: an effect reads what it draws, and draws it in its act
const pic = board.box({ id: "pond", x: 700, y: 120, title: "the pond", kind: "effect" })
const canvas = document.createElement("canvas")
pic.body.append(canvas)
const runsLine = document.createElement("div")
runsLine.className = "small runs"
runsLine.textContent = "drew 0 times"
pic.body.append(runsLine)
pic.code(`createEffect(
  () => ({
    fish: read("fish"),
    rain: read("rain"),
    algae: read("algae"),
    ermine: read("ermine"),
  }),
  (scene) => pond.draw(scene),
)`)
boxes.set("pond", pic)
const pond = createPond(canvas, { width: 240, height: 140 })

// the scheduler box: at once, or pulse by hand
const sched = board.box({
	id: "scheduler",
	x: 930,
	y: 560,
	title: "scheduler",
	kind: "note",
	width: 220,
})
sched.body.innerHTML =
	`<label class="small" style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input type="checkbox" checked> run at once</label>
	<button class="b go" style="margin-top:6px;width:100%" disabled>pulse</button>`
const once = sched.body.querySelector("input")!
const pulseBtn = sched.body.querySelector("button")!
once.onchange = () => {
	atOnce = once.checked
	if (atOnce) s.pulse()
	refreshDue()
}
pulseBtn.onclick = () => {
	const due = [...dueSet]
	s.pulse()
	if (due.length) page.tick("pulse")
	refreshDue()
}

// the store, with all its code on its back
const storeBox = board.box({ id: "store", x: 40, y: 600, title: "store", kind: "note", width: 190 })
storeBox.body.innerHTML =
	`<div class="small">the keys live in a Map. turn me over for read and write.</div>`
storeBox.code(STORE_CODE)

// ---- reading the scheduler's own reports into wires ------------------------------------------
const reading = new Map<string, Set<string>>() // job → keys its last done run read
const wires = new Map<string, Wire>() // "key→job"
const dueSet = new Set<string>()
const runs = new Map<string, number>()
const ranNow: string[] = []
const looked = new Set<string>()

// what flows along a wire: the key's value, in words
const said = (key: string) => {
	const v = store.has(key) ? store.get(key) : results.get(key)
	if (key === "day") return v ? "day" : "night"
	if (key === "fish") return `${v} fish`
	if (key === "rain") return v === 0 ? "dry" : `rain ${v}`
	if (key === "algae") return `${Math.round((v as number) * 100)}% green`
	return String(v)
}
const source = (key: string): Port | undefined =>
	keyBoxes.get(key)?.port("out") ?? boxes.get(key)?.port("out")

s.onMark((keys, _run, due) => {
	for (const c of due) {
		const id = byComputer.get(c) ?? making
		if (id) dueSet.add(id)
	}
	for (const k of keys as string[]) {
		for (const [j, ks] of reading) if (ks.has(k)) wires.get(`${k}→${j}`)?.tone("hot")
	}
	refreshDue()
})
s.onRunStart((c) => {
	const id = byComputer.get(c) ?? making
	dueSet.delete(id)
	ranNow.push(id)
})
s.onRunEnd((c, _n, ended, reads) => {
	const id = byComputer.get(c) ?? making
	if (ended !== "done") return
	const now = new Set(reads as string[])
	const before = reading.get(id) ?? new Set()
	const b = boxes.get(id)!
	for (const k of before) {
		if (now.has(k)) continue
		wires.get(`${k}→${id}`)?.remove()
		wires.delete(`${k}→${id}`)
		b.removePort(k)
	}
	for (const k of now) {
		if (before.has(k)) continue
		const from = source(k)
		if (!from) continue
		const to = b.addPort(k, "in")
		const w = board.wire(from, to)
		wires.set(`${k}→${id}`, w)
		w.flash("ok")
	}
	reading.set(id, now)
	runs.set(id, (runs.get(id) ?? 0) + 1)
	b.body.querySelector(".runs")!.textContent = `${id === "pond" ? "drew" : "ran"} ${
		runs.get(id)
	} time${runs.get(id) === 1 ? "" : "s"}`
	b.flash("hot")
	b.tone(undefined)
	b.badge("")
})
s.onTrackingEnd((k) => {
	keyBoxes.get(k as string)?.tone("dim")
	keyBoxes.get(k as string)?.badge("nobody's looking", "dim")
})
s.onTrackingStart((k) => {
	keyBoxes.get(k as string)?.tone(undefined)
	keyBoxes.get(k as string)?.badge("")
})
s.onAfterPulse(() => {
	refreshDue()
	for (const [k, w] of wires) {
		w.tone(undefined)
		w.label(said(k.split("→")[0]))
	}
	tell()
})

function refreshDue() {
	for (const [id, b] of boxes) {
		if (dueSet.has(id)) {
			b.tone("wait")
			b.badge("due", "wait")
		} else if (b.el.classList.contains("tone-wait")) {
			b.tone(undefined)
			b.badge("")
		}
	}
	pulseBtn.disabled = atOnce || dueSet.size === 0
	pulseBtn.textContent = dueSet.size ? `pulse: ${dueSet.size} due` : "pulse"
	if (!atOnce && dueSet.size) {
		page.say(
			`<b>${[...dueSet].join(" and ")}</b> ${
				dueSet.size === 1 ? "is" : "are"
			} due. Nothing has run yet: press <b>pulse</b>.`,
		)
	}
}

// what just happened, in words
let lastKey = ""
function changed(key: string, _text: string) {
	lastKey = key
	ranNow.length = 0
	for (const w of wires.values()) w.tone(undefined)
}
function tell() {
	if (!lastKey) return
	const ran = [...new Set(ranNow)].filter((x) => x)
	const readers = [...reading].filter(([, ks]) => ks.has(lastKey)).map(([j]) => j)
	const still = JOBS.map((j) => j.id).filter((j) => !ran.includes(j))
	if (!ran.length) {
		page.say(
			readers.length || !atOnce
				? `<code>${lastKey}</code> changed.`
				: `<code>${lastKey}</code> changed, and nobody read it last time. Nothing ran.`,
			"hot",
		)
	} else {
		page.say(
			`<code>${lastKey}</code> changed. ${ran.map((r) => `<b>${r}</b>`).join(", ")} ran again${
				still.length
					? `; ${
						still.map((r) => `<b>${r}</b>`).join(" and ")
					} didn't read it, so stayed still`
					: ""
			}.`,
		)
	}
	ranNow.length = 0
}

// make them: each inside the root scope
s.runWithScope(root, () => {
	for (const j of JOBS) {
		making = j.id
		const c: Computer = s.createComputer(j.f, (v) => {
			results.set(j.id, v)
			store.set(j.id, v)
			j.show(v, boxes.get(j.id)!.body)
			// a computer's result is a key too: written by it, so what reads it is marked
			s.mark([j.id], c)
		})
		byComputer.set(c, j.id)
	}
	making = "pond"
	const e = s.createEffect(
		() => ({
			fish: read("fish") as number,
			rain: read("rain") as number,
			algae: read("algae") as number,
			ermine: read("ermine") as string,
		}),
		(scene) => {
			pond.draw({
				fish: scene.fish,
				rain: scene.rain,
				algae: scene.algae ?? 0,
				lilies: 4,
				sign: scene.ermine === "asleep" ? "ermine: zzz" : `ermine: ${scene.fish} fish`,
				stale: false,
			})
		},
	)
	byComputer.set(e, "pond")
	making = ""
})
s.pulse()
for (const k of ["day", "fish", "rain"]) {
	if (![...reading.values()].some((ks) => ks.has(k))) {
		keyBoxes.get(k)?.tone("dim")
		keyBoxes.get(k)?.badge("nobody's looking", "dim")
	}
}
for (const [k, w] of wires) w.label(said(k.split("→")[0]))

// turning a box over ticks the last try
board.el.addEventListener("click", (e) => {
	if ((e.target as HTMLElement).closest(".box-flip")) {
		looked.add("x")
		page.tick("flip")
	}
})
requestAnimationFrame(() => board.fit())
