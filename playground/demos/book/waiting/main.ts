/// <reference lib="dom" />
// waiting: the weather comes by duck. weather's run gives back a promise (a duck flying in with a
// letter); the reader lands it with a forecast, or drops the letter in the water (it fails).
// summary and umbrella read weather and go pending with it; the pond, an effect, keeps its old
// picture, greyed, while pending. wires grow from what each run read, as onRunEnd tells it: a run
// that ends any way but done keeps what it held (dashed). below, on a second scheduler, before and
// after: one reads the town before its await, one after; only the first is ever wired to it
import {
	type Computer,
	createScheduler,
	type Ended,
	PENDING,
	type Scheduler,
} from "@ermine/scheduler"
import type { Box, Wire } from "../kit/board.ts"
import { pondPage } from "../kit/page.ts"
import { createPond, pixels, SPRITES } from "../kit/sprites.ts"

const page = pondPage("waiting", {
	say:
		`<p>Sometimes what a computer needs isn't here yet. <code>weather</code> sends a duck for the forecast: its run gives back a promise, and ends <b>pending</b>. Nothing is set; the last result stays.</p>
		<p>Whoever reads a pending key is pending too. The pond keeps its old picture until a letter lands and a pulse runs.</p>`,
	tries: [
		{ id: "land", text: "Click the duck, pick a forecast, then press <b>pulse</b>." },
		{ id: "old", text: "Pick another town. The pond keeps its old picture, greyed." },
		{
			id: "fail",
			text: "Click the new duck and <b>drop</b> the letter. What does the pond say?",
		},
		{
			id: "offline",
			text:
				"Shut the post, then pick another town. <code>weather</code> runs again, though it never read the town.",
		},
		{
			id: "await",
			text: "Pick a town and watch <b>before</b> and <b>after</b>. Only one has a wire.",
		},
	],
	rules:
		`<p><b>pending:</b> a run that returns a promise, or returns or throws <code>PENDING</code>, ends pending. Nothing is set, the last result is kept, an effect does not act.</p>
		<p><b>it spreads:</b> this page's <code>read</code> throws <code>PENDING</code> for a pending key, so every computer above <code>weather</code> is pending too, unasked.</p>
		<p><b>settle:</b> when a promise lands, the scheduler is told (<code>onSettle</code>). Its result waits for the next pulse.</p>
		<p><b>too late:</b> if <code>weather</code> ran again first, the old duck lands nowhere. Nobody is told.</p>
		<p><b>failed:</b> a rejected promise ends the run failed. Nothing is set. The page then clears the pending, so readers show the last forecast again, even for a new town.</p>
		<p><b>kept reads:</b> a run that ends any way but done keeps every key it read, and every key the run before read that it didn't reach (a dashed wire). A change to any of them runs it again.</p>
		<p><b>await:</b> a run lasts until its first await. Only what it read by then is tracked: after an await, JavaScript can't say which run the code is part of. It's why <code>preventDefault()</code> does nothing after an await: the event is gone.</p>`,
	real:
		`Runs the real <code>@ermine/scheduler</code>, twice (the pond's, and a second one for before and after): createScheduler, PENDING, a root scope, createComputer, createEffect, track, mark, pulse, and its listeners onRunStart, onRunEnd, onSettle, onTrack, onEffect. Wires and chips come from those. The ducks are plain promises the page resolves or rejects. The store, and the rule that a pending computer makes its key pending, are the page's: turn the store over.`,
})
const { board } = page

// ---- a store over a scheduler: key → value, and the keys whose computer is pending -----------
function host(s: Scheduler) {
	const store = new Map<string, unknown>()
	const pending = new Set<string>()
	const keyOf = new Map<Computer, string>()
	function read(key: string) {
		s.track(key)
		if (pending.has(key)) throw PENDING
		return store.get(key)
	}
	function write(key: string, value: unknown, by?: Computer) {
		store.set(key, value)
		s.mark([key], by)
	}
	s.onRunEnd((c, _n, ended) => {
		const k = keyOf.get(c)
		if (!k || ended == "stopped") return
		const was = pending.has(k)
		if (ended == "pending") pending.add(k)
		else pending.delete(k)
		if (was != pending.has(k)) s.mark([k], c)
	})
	return { store, pending, keyOf, read, write }
}
const STORE_CODE = `const store = new Map()
const pending = new Set()

function read(key) {
  s.track(key)
  if (pending.has(key)) throw PENDING
  return store.get(key)
}

function write(key, value, by) {
  store.set(key, value)
  s.mark([key], by)
}

// a computer with a key: ending pending
// makes its key pending; any other end
// (not stopped) makes it not
s.onRunEnd((c, n, ended) => {
  const k = keyOf.get(c)
  if (!k || ended == "stopped") return
  const was = pending.has(k)
  if (ended == "pending") pending.add(k)
  else pending.delete(k)
  if (was != pending.has(k)) s.mark([k], c)
})`

// ---- little pictures of the page's own ---------------------------------------------------------
const GREY: Record<string, string> = { Y: "s", y: "S", O: "S", o: "S", W: "s" }
const greyed = (rows: readonly string[]) => rows.map((r) => r.replace(/[YyOoW]/g, (c) => GREY[c]))
const DUCK = SPRITES.duck
const GREY_DUCK = greyed(DUCK)
const LETTER = SPRITES.letter
const UMBRELLA: Record<string, string[]> = {
	umbrella: [
		"....K....",
		"..PPPPP..",
		".PPPPPPP.",
		"PPPPPPPPP",
		"....K....",
		"....K....",
		"..K.K....",
		"...K.....",
	],
	"no umbrella": [
		"....K....",
		"....P....",
		"...PPP...",
		"...PPP...",
		"...PPP...",
		"....K....",
		"..K.K....",
		"...K.....",
	],
	"stay in": [
		"....KK...",
		"...KPPK..",
		"..KPPPPK.",
		".KPPPPPPK",
		"KKKKKKKKK",
		".KWWWWNNK",
		".KWBWWNNK",
		".KKKKKKKK",
	],
}
function pic(rows: readonly string[], scale: number) {
	const c = document.createElement("canvas")
	c.width = rows[0].length * scale
	c.height = rows.length * scale
	c.className = "pix"
	pixels(c.getContext("2d")!, rows, 0, 0, scale)
	return c
}
const still = matchMedia("(prefers-reduced-motion: reduce)").matches

// ---- the pond's scheduler -----------------------------------------------------------------------
const A = createScheduler()
const a = host(A)
const { read, write } = a
a.store.set("town", "Lyon")
a.store.set("post", true)
const TOWNS = ["Lyon", "Oslo", "Lima"]
const FORECASTS = ["sun", "rain", "storm"]

// a duck: the promise one weather run gave back, flying in with its letter
type Duck = {
	run: number
	town: string
	born: number
	state: "flying" | "sent" | "landed" | "dropped" | "nowhere" | "gone"
	old?: number
	at?: number
	value?: string
	res: (v: string) => void
	rej: (e: Error) => void
}
let ducks: Duck[] = []
function send(town: string): Promise<string> {
	let res!: (v: string) => void, rej!: (e: Error) => void
	const p = new Promise<string>((y, n) => (res = y, rej = n))
	const now = performance.now()
	for (const d of ducks) if (d.state === "flying" && d.old === undefined) d.old = now
	// one old duck kept in the sky at most
	const olds = ducks.filter((d) => d.old !== undefined && d.state === "flying")
	for (const d of olds.slice(0, -1)) d.state = "gone"
	ducks = ducks.filter((d) => d.state !== "gone")
	ducks.push({ run: A.getRun()!.n, town, born: now, state: "flying", res, rej })
	return p
}

// what the pond last drew
let drawn: { weather: unknown; summary: unknown; umbrella: unknown } | undefined

const names = new Map<Computer, string>()
let weather!: Computer, summary!: Computer, umbrella!: Computer, pondFx!: Computer
A.runWithScope(A.createRootScope({ page: "waiting" }), () => {
	weather = A.createComputer<unknown>(
		() => {
			if (!read("post")) return PENDING
			return send(read("town") as string)
		},
		(v) => write("weather", v, weather),
		undefined,
		"weather",
	)
	summary = A.createComputer<unknown>(
		() => read("town") + ": " + (read("weather") ?? "no forecast"),
		(v) => write("summary", v, summary),
		undefined,
		"summary",
	)
	umbrella = A.createComputer<unknown>(
		() => {
			const w = read("weather")
			return w === "rain" ? "umbrella" : w === "storm" ? "stay in" : "no umbrella"
		},
		(v) => write("umbrella", v, umbrella),
		undefined,
		"umbrella",
	)
	pondFx = A.createEffect(
		() => ({ weather: read("weather"), summary: read("summary"), umbrella: read("umbrella") }),
		(scene) => {
			drawn = scene
			drawPond()
		},
	)
})
for (
	const [c, n] of [[weather, "weather"], [summary, "summary"], [umbrella, "umbrella"]] as const
) {
	names.set(c, n)
	a.keyOf.set(c, n)
}
names.set(pondFx, "pond")

// ---- the board ------------------------------------------------------------------------------------
const chips = (key: string, opts: [string, unknown][]) =>
	`<div class="chips">${
		opts.map(([t, v], i) => `<button class="chip" data-key="${key}" data-i="${i}">${t}</button>`)
			.join("")
	}</div>`
const syncChips = (b: Box, key: string, opts: [string, unknown][]) =>
	b.body.querySelectorAll<HTMLElement>(".chip").forEach((c) =>
		c.setAttribute("aria-pressed", String(opts[Number(c.dataset.i)][1] === a.store.get(key)))
	)

const TOWN_OPTS: [string, unknown][] = TOWNS.map((t) => [t, t])
const POST_OPTS: [string, unknown][] = [["open", true], ["shut", false]]
const townBox = board.box({
	id: "town",
	x: 40,
	y: 60,
	title: "town",
	kind: "key",
	outs: [["out", ""]],
	width: 190,
})
townBox.body.innerHTML = chips("town", TOWN_OPTS)
const postBox = board.box({
	id: "post",
	x: 40,
	y: 210,
	title: "post",
	kind: "key",
	outs: [["out", ""]],
	width: 190,
})
postBox.body.innerHTML = chips("post", POST_OPTS) +
	`<div class="small">shut: no duck can fly</div>`

const wBox = board.box({
	id: "weather",
	x: 290,
	y: 40,
	title: "weather",
	kind: "compute",
	outs: [["out", ""]],
	width: 390,
})
const sky = document.createElement("canvas")
sky.className = "sky"
sky.width = 120
sky.height = 42
sky.tabIndex = 0
sky.setAttribute("role", "button")
sky.setAttribute("aria-label", "the duck: open its letter")
wBox.body.append(sky)
wBox.body.insertAdjacentHTML(
	"beforeend",
	`<div class="letter" hidden></div><div class="mid"></div><div class="small runs"></div>`,
)
wBox.code(`createComputer(() => {
  if (!read("post")) return PENDING
  return send(read("town")) // a duck: a promise
}, (v) => write("weather", v, weather))`)

const sBox = board.box({
	id: "summary",
	x: 760,
	y: 20,
	title: "summary",
	kind: "compute",
	outs: [["out", ""]],
	width: 190,
})
sBox.body.innerHTML = `<div class="mid"></div><div class="small runs"></div>`
sBox.code(`createComputer(
  () => read("town") + ": " + (read("weather") ?? "no forecast"),
  (v) => write("summary", v, summary))`)

const uBox = board.box({
	id: "umbrella",
	x: 760,
	y: 180,
	title: "umbrella",
	kind: "compute",
	outs: [["out", ""]],
	width: 190,
})
uBox.body.innerHTML = `<div class="mid"></div><div class="small runs"></div>`
uBox.code(`createComputer(() => {
  const w = read("weather")
  return w === "rain" ? "umbrella"
    : w === "storm" ? "stay in" : "no umbrella"
}, (v) => write("umbrella", v, umbrella))`)

const pBox = board.box({ id: "pond", x: 760, y: 360, title: "the pond", kind: "effect" })
const heaven = document.createElement("canvas")
heaven.className = "heaven"
heaven.width = 120
heaven.height = 20
const water = document.createElement("canvas")
pBox.body.append(heaven, water)
pBox.body.insertAdjacentHTML("beforeend", `<div class="small runs"></div>`)
pBox.code(`createEffect(
  () => ({
    weather: read("weather"),
    summary: read("summary"),
    umbrella: read("umbrella"),
  }),
  (scene) => pond.draw(scene),
)`)
const pond = createPond(water, { width: 240, height: 140 })

const schedBox = board.box({
	id: "scheduler",
	x: 1020,
	y: 40,
	title: "scheduler",
	kind: "note",
	width: 240,
})
schedBox.body.innerHTML =
	`<label class="small" style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input type="checkbox"> pulse as soon as a letter lands</label>
	<button class="b go" style="margin-top:6px;width:100%">pulse</button>`
const autoBox = schedBox.body.querySelector("input")!
const pulseBtn = schedBox.body.querySelector("button")!

const storeBox = board.box({ id: "store", x: 40, y: 360, title: "store", kind: "note", width: 190 })
storeBox.body.innerHTML =
	`<div class="small">the keys live in a Map; a pending computer's key is pending. turn me over.</div>`
storeBox.code(STORE_CODE)

// ---- wires, grown from what each run read -------------------------------------------------------
const boxOf: Record<string, Box> = {
	town: townBox,
	post: postBox,
	weather: wBox,
	summary: sBox,
	umbrella: uBox,
	pond: pBox,
}
// each computer's held keys: false read by its last run, true kept from a run before
const held = new Map<string, Map<string, boolean>>()
const wires = new Map<string, Wire>()
const ends = new Map<string, { n: number; ended: Ended }>()
function grow(id: string, reads: readonly unknown[], done: boolean) {
	const now = new Map<string, boolean>()
	for (const k of reads as string[]) now.set(k, false)
	if (!done) { for (const k of held.get(id)?.keys() ?? []) if (!now.has(k)) now.set(k, true) }
	const b = boxOf[id]
	for (const k of held.get(id)?.keys() ?? []) {
		if (now.has(k)) continue
		wires.get(`${k}→${id}`)?.remove()
		wires.delete(`${k}→${id}`)
		b.removePort(k)
	}
	for (const [k, kept] of now) {
		let w = wires.get(`${k}→${id}`)
		if (!w) {
			w = board.wire(boxOf[k].port("out"), b.addPort(k, "in"))
			wires.set(`${k}→${id}`, w)
			w.flash("ok")
		}
		w.dashed(kept)
	}
	held.set(id, now)
}
const said = (k: string): string => {
	if (a.pending.has(k)) return "pending"
	const v = a.store.get(k)
	if (k === "post") return v ? "open" : "shut"
	return v === undefined ? "nothing" : String(v)
}

A.onRunStart((c) => boxOf[names.get(c)!].flash("pick"))
A.onRunEnd((c, n, ended, reads) => {
	const id = names.get(c)!
	ends.set(id, { n, ended })
	grow(id, reads, ended === "done")
})

// ---- the ducks in the sky -----------------------------------------------------------------------
const FLY = 4000
type Spot = { x: number; y: number; k: number }
function where(d: Duck, t: number): Spot {
	const bob = still ? 0 : Math.round(Math.sin(t / 260 + d.run) * 1)
	if (d.state === "landed") return { x: 96, y: 22, k: 1 }
	const p = still ? 1 : Math.min(1, (Math.min(t, d.old ?? t) - d.born) / FLY)
	let x = 4 + 76 * p, y = 4 + 10 * p + bob
	const k = p < 0.5 ? 1 : 2
	if (d.old !== undefined) {
		// gone old: it drifts back and up, grey
		const q = still ? 1 : Math.min(1, (t - d.old) / 1500)
		x -= 40 * q
		y = Math.max(1, y - 8 * q)
		return { x, y, k: 1 }
	}
	if (d.state === "dropped") {
		const q = Math.min(1, (t - d.at!) / 900)
		return { x: x + 60 * q, y: y - 14 * q, k }
	}
	return { x, y, k }
}
function drawSky(t: number) {
	const c = sky.getContext("2d")!
	c.fillStyle = "#dce6ff"
	c.fillRect(0, 0, 120, 42)
	// the water, and the door the letters go to
	c.fillStyle = "#2269ff"
	c.fillRect(0, 37, 120, 5)
	c.fillStyle = "#7a5230"
	c.fillRect(110, 14, 10, 23)
	c.fillStyle = "#ffe23d"
	c.fillRect(112, 25, 2, 2)
	if (!a.store.get("post")) {
		c.fillStyle = "#000"
		c.font = "7px Monaco, monospace"
		c.fillText("post shut", 30, 22)
	}
	for (const d of ducks) {
		if (d.state === "gone" || d.state === "nowhere") continue
		if (d.state === "dropped" && t - d.at! > 2200) continue
		const s = where(d, t)
		const old = d.old !== undefined
		pixels(c, old ? GREY_DUCK : DUCK, s.x, s.y, s.k)
		if (d.state === "dropped") {
			// the letter falls into the water, and rings spread
			const q = Math.min(1, (t - d.at!) / 700)
			const lx = 50
			if (q < 1) pixels(c, LETTER, lx, 14 + 20 * q, 1)
			else {
				const r = Math.min(10, (t - d.at! - 700) / 60)
				c.fillStyle = "rgba(255,255,255,.8)"
				c.fillRect(lx + 4 - r, 38, 2 * r + 2, 1)
			}
			continue
		}
		pixels(c, old ? greyed(LETTER) : LETTER, s.x + 6 * s.k, s.y + 6 * s.k, 1)
		if (d.state === "landed") {
			c.fillStyle = "#000"
			c.font = "6px Monaco, monospace"
			c.fillText(String(d.value), 88, 11)
		}
		if (old) {
			c.fillStyle = "#666"
			c.font = "6px Monaco, monospace"
			c.fillText("old", s.x, s.y + 13)
		}
	}
}
function duckAt(px: number, py: number): Duck | undefined {
	const t = performance.now()
	for (const d of [...ducks].reverse()) {
		if (d.state !== "flying") continue
		const s = where(d, t)
		if (px >= s.x - 4 && px <= s.x + 16 * s.k && py >= s.y - 4 && py <= s.y + 13 * s.k) return d
	}
}

// the letter, opened: what it says, or drop it
const letterRow = wBox.body.querySelector<HTMLElement>(".letter")!
let opened: Duck | undefined
function open(d: Duck | undefined) {
	opened = d
	if (!d) {
		letterRow.hidden = true
		return
	}
	letterRow.hidden = false
	letterRow.innerHTML = `<span>${
		d.old !== undefined ? "the old duck's letter:" : "it says:"
	}</span>${
		FORECASTS.map((f) => `<button class="chip" data-say="${f}">${f}</button>`).join("")
	}<button class="chip drop" data-say="">drop it</button>`
	letterRow.querySelector<HTMLElement>("button")!.focus()
	page.say(
		d.old !== undefined
			? "That's an old duck: <code>weather</code> has run again since. Land it and see who is told."
			: `The duck hands you the letter for ${d.town}. What does it say?`,
	)
}
sky.addEventListener("click", (e) => {
	const r = sky.getBoundingClientRect()
	const d = duckAt((e.clientX - r.left) / r.width * 120, (e.clientY - r.top) / r.height * 42)
	if (d) open(d)
})
sky.addEventListener("keydown", (e) => {
	if (e.key !== "Enter" && e.key !== " ") return
	e.preventDefault()
	open([...ducks].reverse().find((d) => d.state === "flying"))
})
letterRow.addEventListener("click", (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-say]")
	if (!b || !opened) return
	land(opened, b.dataset.say || undefined)
})

let waiting = 0
let auto = false
function land(d: Duck, value: string | undefined) {
	open(undefined)
	d.value = value
	d.at = performance.now()
	const old = d.old !== undefined
	d.state = value === undefined ? "dropped" : "sent"
	if (value === undefined) d.rej(new Error("the letter fell in the pond"))
	else d.res(value)
	setTimeout(() => {
		// no settle came: the run it belonged to has been followed by another
		if (d.state === "sent" || (d.state === "dropped" && !told.has(d))) {
			if (d.state === "sent") d.state = "nowhere"
			if (old) {
				page.say(
					"The old duck landed, but <code>weather</code> ran again since. Nobody was told: it lands nowhere.",
					"hot",
				)
			}
		}
		refresh()
	}, 0)
}
// ducks whose settling the scheduler heard
const told = new Set<Duck>()
A.onSettle(() => {
	const d = ducks.find((d) =>
		(d.state === "sent" || d.state === "dropped") && !told.has(d) && d.run === weather.runs
	)
	if (!d) return
	told.add(d)
	waiting++
	if (d.state === "sent") d.state = "landed"
	page.say(
		d.state === "dropped"
			? "The letter fell in the pond: the promise is rejected. The scheduler was told; it waits for a pulse."
			: `The letter says <b>${d.value}</b>. The scheduler was told (<code>onSettle</code>); nothing runs till the next pulse.`,
		d.state === "dropped" ? "hot" : undefined,
	)
	if (auto) setTimeout(pulse, 0)
	else refresh()
})

// ---- pulses, and what they show -----------------------------------------------------------------
let landing = false
function pulse() {
	landing = waiting > 0
	waiting = 0
	A.pulse()
	refresh()
	landing = false
}
pulseBtn.onclick = () => pulse()
autoBox.onchange = () => {
	auto = autoBox.checked
	if (auto && waiting) pulse()
	refresh()
}

let offline = 0
A.onRunStart((c) => {
	if (c !== weather) return
	offline = a.store.get("post") ? 0 : offline + 1
	if (offline >= 2) page.tick("offline")
})
A.onRunEnd((c, n, ended) => {
	if (c === weather) {
		if (ended === "done") {
			for (const d of ducks) if (d.run === n && d.state === "landed") d.state = "gone"
			if (landing) {
				page.say(
					`<code>weather</code> is done: <b>${
						a.store.get("weather")
					}</b>. Everything above it ran again, and the pond drew.`,
					"ok",
				)
				page.tick("land")
			}
		}
		if (ended === "failed") {
			page.say(
				"<code>weather</code> failed: nothing set. Its readers are not pending now, so they show the last forecast again.",
				"hot",
			)
			page.tick("fail")
		}
	}
	if (c === pondFx && ended === "pending" && drawn) page.tick("old")
})

function drawPond() {
	const l = ends.get("pond")
	const stale = !!drawn && l?.ended !== "done"
	const w = drawn?.weather
	pond.draw({
		fish: w === "sun" ? 6 : w === "rain" ? 4 : w === "storm" ? 1 : 3,
		lilies: 4,
		rain: w === "rain" ? 0.45 : w === "storm" ? 1 : 0,
		algae: w === "storm" ? 0.35 : 0,
		named: w === "sun" ? [{ name: "duck", kind: "duck", x: 0.7, y: 0.2 }] : [],
		sign: drawn ? `${drawn.summary} · ${drawn.umbrella}` : "no forecast yet",
		stale,
	})
	const c = heaven.getContext("2d")!
	c.fillStyle = w === "storm"
		? "#555"
		: w === "rain"
		? "#9a9a9a"
		: w === "sun"
		? "#9fc0ff"
		: "#eee"
	c.fillRect(0, 0, 120, 20)
	if (w === "sun") {
		c.fillStyle = "#ffe23d"
		c.beginPath()
		c.arc(100, 10, 6, 0, 6.3)
		c.fill()
	}
	if (w === "rain" || w === "storm") {
		pixels(c, SPRITES.cloud, 10, 4, 1)
		pixels(c, SPRITES.cloud, 60, 7, 1)
		pixels(c, SPRITES.cloud, 88, 2, 1)
	}
	if (w === "storm") {
		c.fillStyle = "#ffe23d"
		for (const [x, y] of [[50, 6], [48, 9], [51, 10], [49, 13], [52, 14]]) c.fillRect(x, y, 2, 2)
	}
	pBox.el.classList.toggle("stale", stale)
}

const CHIP: Record<Ended, "ok" | "wait" | "hot" | "dim"> = {
	done: "ok",
	pending: "wait",
	failed: "hot",
	stopped: "dim",
	looping: "hot",
}
function refresh() {
	syncChips(townBox, "town", TOWN_OPTS)
	syncChips(postBox, "post", POST_OPTS)
	for (const [c, id] of names) {
		const b = boxOf[id]
		const l = ends.get(id)
		const stale = l !== undefined && l.ended !== "done" && c.last !== undefined
		if (id === "pond") {
			b.badge(
				stale ? "still the old one" : l ? l.ended : "due",
				stale ? "wait" : l ? CHIP[l.ended] : "wait",
			)
			b.body.querySelector(".runs")!.textContent = `ran ${c.runs}${
				drawn ? "" : " · drew nothing yet"
			}`
			continue
		}
		b.badge(l ? l.ended : "due", l ? CHIP[l.ended] : "wait")
		b.el.classList.toggle("stale", stale)
		const mid = b.body.querySelector<HTMLElement>(".mid")!
		mid.textContent = c.last === undefined ? "nothing yet" : String(c.last.value)
		if (id === "umbrella" && c.last !== undefined) {
			mid.prepend(pic(UMBRELLA[String(c.last.value)] ?? UMBRELLA["no umbrella"], 3))
		}
		const why = !l
			? ""
			: l.ended === "pending" && id === "weather"
			? a.store.get("post") ? " · a duck is out" : " · returned PENDING"
			: l.ended === "pending"
			? " · a read threw PENDING"
			: ""
		b.body.querySelector(".runs")!.textContent = `ran ${c.runs}${why}${
			stale ? " · still the old one" : ""
		}`
	}
	for (const [k, w] of wires) {
		const [key, id] = k.split("→")
		w.label(said(key) + (held.get(id)?.get(key) ? " · kept" : ""))
		w.tone(a.pending.has(key) ? "wait" : undefined)
	}
	pulseBtn.textContent = waiting
		? `pulse: ${waiting} letter${waiting > 1 ? "s" : ""} waiting`
		: "pulse"
	schedBox.tone(waiting ? "hot" : undefined)
	drawPond()
}

// the keys, touched
board.el.addEventListener("click", (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>(".chip[data-key]")
	if (!c) return
	const key = c.dataset.key!
	const v = (key === "town" ? TOWN_OPTS : POST_OPTS)[Number(c.dataset.i)][1]
	if (v === a.store.get(key)) return
	const out = ducks.some((d) => d.state === "flying" && d.old === undefined)
	write(key, v)
	A.pulse()
	if (key === "town") writeB(v as string)
	refresh()
	boxOf[key].flash("hot")
	const pending = ends.get("weather")?.ended === "pending"
	if (key === "post" && !v) {
		page.say(
			"The post is shut: <code>weather</code> returned <code>PENDING</code>. No duck flies.",
		)
	} else if (key === "town" && !a.store.get("post")) {
		page.say(
			"The post is shut, yet <code>weather</code> ran again: the town was read by the run before, so a change to it still counts (dashed wire).",
		)
	} else if (pending) {
		page.say(
			`<code>weather</code> ran again for ${a.store.get("town")}: a new duck.${
				out ? " The old one lands nowhere now." : ""
			} Everything above is pending${drawn ? "; the pond keeps its old picture" : ""}.`,
		)
	}
})

// ---- read before you await: a second scheduler ----------------------------------------------------
const B = createScheduler()
const b = host(B)
b.store.set("town", "Lyon")
const FLY_B = 1400
const flights = new Map<Computer, number>()
const wait = () => new Promise((r) => setTimeout(r, FLY_B))
let before!: Computer, after!: Computer
B.runWithScope(B.createRootScope({ page: "waiting", part: "await" }), () => {
	before = B.createComputer(async () => {
		const town = b.read("town")
		await wait()
		return "news for " + town
	}, (v) => b.write("before", v, before))
	after = B.createComputer(async () => {
		await wait()
		const town = b.read("town")
		return "news for " + town
	}, (v) => b.write("after", v, after))
})
const namesB = new Map<Computer, string>([[before, "before"], [after, "after"]])
const noteB = board.box({
	id: "second",
	x: 40,
	y: 560,
	title: "a second scheduler",
	kind: "note",
	width: 240,
})
noteB.body.innerHTML =
	`<div class="small">before and after run on their own scheduler, each waiting on a duck that flies by itself. Picking a town writes it here too, and this one pulses as soon as a duck lands.</div>`
const lanes = new Map<Computer, HTMLCanvasElement>()
const bBoxes = new Map<Computer, Box>()
for (
	const [c, id, y, code] of [
		[
			before,
			"before",
			380,
			`async () => {
  const town = read("town")
  await wait() // a duck flies
  return "news for " + town
}`,
		],
		[
			after,
			"after",
			560,
			`async () => {
  await wait() // a duck flies
  const town = read("town")
  return "news for " + town
}`,
		],
	] as const
) {
	const bx = board.box({ id, x: 290, y, title: id, kind: "compute", width: 390 })
	const lane = document.createElement("canvas")
	lane.className = "lane"
	lane.width = 90
	lane.height = 18
	bx.body.append(lane)
	bx.body.insertAdjacentHTML(
		"beforeend",
		`<div class="small">${
			id === "before" ? "reads the town, then awaits" : "awaits, then reads the town"
		}</div><div class="mid"></div><div class="oldnote"></div>`,
	)
	bx.code(code)
	lanes.set(c, lane)
	bBoxes.set(c, bx)
}
const wiresB = new Map<Computer, Wire>()
B.onRunStart((c) => {
	flights.set(c, performance.now())
	bBoxes.get(c)!.flash("pick")
})
B.onTrack((key, run) => {
	const c = run.computer
	if (key !== "town" || wiresB.has(c)) return
	const w = board.wire(townBox.port("out"), bBoxes.get(c)!.addPort("town", "in"))
	w.flash("ok")
	wiresB.set(c, w)
})
B.onRunEnd((c, n, ended, reads) => {
	const bx = bBoxes.get(c)!
	bx.badge(ended, CHIP[ended])
	if (ended === "done" && !(reads as string[]).includes("town") && wiresB.has(c)) {
		wiresB.get(c)!.remove()
		wiresB.delete(c)
		bx.removePort("town")
	}
	if (ended === "pending") flights.set(c, performance.now())
	else flights.delete(c)
	if (
		c === before && ended === "done" && n > 1 &&
		b.store.get("after") !== "news for " + b.store.get("town")
	) {
		page.tick("await")
	}
	refreshB()
})
B.onSettle(() => setTimeout(() => (B.pulse(), refreshB()), 0))
function writeB(town: string) {
	b.write("town", town)
	B.pulse()
	refreshB()
}
function refreshB() {
	for (const [c, id] of namesB) {
		const bx = bBoxes.get(c)!
		const v = b.store.get(id)
		bx.body.querySelector(".mid")!.textContent = v === undefined ? "nothing yet" : String(v)
		const behind = v !== undefined && v !== "news for " + b.store.get("town")
		bx.body.querySelector(".oldnote")!.textContent = behind
			? "out of date: it never tracked the town, so nothing runs it again"
			: `ran ${c.runs}`
		bx.tone(behind ? "hot" : undefined)
	}
	for (const w of wiresB.values()) w.label(String(b.store.get("town")))
}
function drawLanes(t: number) {
	for (const [c, lane] of lanes) {
		const g = lane.getContext("2d")!
		g.fillStyle = "#dce6ff"
		g.fillRect(0, 0, 90, 18)
		g.fillStyle = "#7a5230"
		g.fillRect(84, 4, 6, 14)
		const from = flights.get(c)
		const p = from === undefined ? 1 : still ? 0.5 : Math.min(1, (t - from) / FLY_B)
		const x = 2 + 70 * p
		pixels(g, DUCK, x, 5 + (still ? 0 : Math.round(Math.sin(t / 200) * 1)), 1)
		if (from !== undefined) pixels(g, LETTER, x + 6, 11, 1)
	}
}

// ---- the sky moves ------------------------------------------------------------------------------
function frame(t: number) {
	drawSky(t)
	drawLanes(t)
	requestAnimationFrame(frame)
}

A.pulse()
B.pulse()
refresh()
refreshB()
requestAnimationFrame(frame)
requestAnimationFrame(() => board.fit())
page.say(
	"<code>weather</code> sent a duck for Lyon's forecast. Its run ended pending, and so did everyone above it.",
)
