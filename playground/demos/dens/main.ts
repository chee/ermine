/// <reference lib="dom" />
// dens: two people, two screens, one graph. each page is one running ermine (a den), its id its
// tab's device key; the dens find each other over wss://galaxy.observer (host.ts' openChannel, the
// one seam; ?server=none: the tabs of one browser), and each shows the others' things as they are
// mirrored here. ?as=cardputer: chee's cardputer
import { type Box, createBoard, type Port, type Wire } from "./kit/board.ts"
import { createFarm, type Farm } from "./kit/farm.ts"
import { createHost, type Host, KINDS, newCode, OUT, roomCode } from "./host.ts"
import {
	controls,
	isPicture,
	PAD,
	parse,
	type Picture,
	PIGS,
	SAYS,
	type Source,
	speaker as playing,
	square,
	STATE,
	unparse,
} from "./things.ts"
import { picture } from "./pictures.ts"
import { createFiles } from "./files.ts"
import { createTerminal } from "./terminal.ts"
import { createCode } from "./code.ts"
import { get } from "@ermine/places/lib"
import { sound } from "./sound.ts"
import { DEVICE, NAME, RUNNER } from "@ermine/dens"
import type { Answered } from "@ermine/dens/away"

const $ = <T extends HTMLElement = HTMLElement>(q: string, root: ParentNode = document) =>
	root.querySelector(q) as T
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

const hex4 = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0"))
		.join("")

// ---- who this page is ----
const search = new URLSearchParams(location.search)
const isCard = search.get("as") === "cardputer"

// the room: ?room=CODE (a link someone sent), else the code typed at the welcome, else the last
// one this browser was in, else a new one. it goes in the url, so the url is the link to send
function welcome(): Promise<{ name: string; code?: string }> {
	const name = localStorage.getItem("dens.name")
	if (name) return Promise.resolve({ name })
	const card = $(".welcome")
	card.hidden = false
	const field = $<HTMLInputElement>("input[name=name]", card)
	const codeField = $<HTMLInputElement>("input[name=code]", card)
	if (roomCode(search.get("room") ?? "")) $(".joining", card).hidden = true
	field.focus()
	return new Promise((resolve) => {
		$<HTMLFormElement>("form", card).onsubmit = (e) => {
			e.preventDefault()
			const name = field.value.trim()
			if (!name) return field.focus()
			const typed = codeField.value.trim()
			const code = typed ? roomCode(typed) : undefined
			if (typed && !code) {
				codeField.setCustomValidity("four letters, like the ones on the screen")
				codeField.reportValidity()
				codeField.oninput = () => codeField.setCustomValidity("")
				return
			}
			localStorage.setItem("dens.name", name)
			card.hidden = true
			resolve({ name, code })
		}
	})
}
function roomOf(typed?: string): string {
	const code = roomCode(search.get("room") ?? "") ?? typed ??
		roomCode(localStorage.getItem("dens.room") ?? "") ?? newCode()
	localStorage.setItem("dens.room", code)
	const url = new URL(location.href)
	url.searchParams.set("room", code)
	history.replaceState(null, "", url)
	return code
}

// this tab's device key (its seed), kept for the tab: a den's id is its key, so each tab is its own
// den, and a reload is the same one
function seed(): Uint8Array {
	const kept = sessionStorage.getItem("dens.seed")
	if (kept?.length === 64) return Uint8Array.from(kept.match(/../g)!, (b) => parseInt(b, 16))
	const made = crypto.getRandomValues(new Uint8Array(32))
	sessionStorage.setItem(
		"dens.seed",
		Array.from(made, (b) => b.toString(16).padStart(2, "0")).join(""),
	)
	return made
}

// ?server=wss://… another server; ?server=none the tabs of this browser only
const server = search.get("server") === "none"
	? undefined
	: search.get("server") ?? "wss://galaxy.observer"
const me = isCard
	? { name: "chee's cardputer", device: "cardputer" }
	: { ...(await welcome()), device: "browser" }
const room = roomOf("code" in me ? me.code : undefined)
const host = await createHost({ ...me, room, seed: seed(), server })
const ANCHOR = host.anchor
const { den, link, hosted, table, places } = host
const id = host.id
if (isCard) {
	for (const k of ["keys", "screen", "pigs"]) {
		hosted(() => den.start(`/system/den/runners/${k}`, `/things/${k}`, ["work", k]))
	}
}

// ---- what the page sees: each den, its things ----
type Thing = {
	id: string
	at: string[]
	kind: string
	out: unknown
	state: unknown
	says: unknown
	args: string[]
	sources: Source[]
	settings: Record<string, string>
}
type View = {
	who: string
	name: string
	device: string
	alive: boolean
	mine: boolean
	things: Thing[]
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

function thingOf(id: string, at: string[], attrs: Record<string, unknown>): Thing | undefined {
	const runner = attrs[RUNNER]
	if (!isMap(runner) || !Array.isArray(runner.at)) return undefined
	const given = attrs["ermine.process.args"]
	const args = Array.isArray(given) ? given.map(String) : []
	return {
		id,
		at,
		kind: String(runner.at.at(-1)),
		out: attrs[OUT],
		state: attrs[STATE],
		says: attrs[SAYS],
		args,
		...parse(args),
	}
}

// dens seen once, kept so a den gone quiet stays drawn (grey)
const known = new Map<string, View>()

function views(): View[] {
	const now = Date.now()
	const rows = (table.get("presence", ANCHOR)?.value ?? {}) as Record<
		string,
		{ value: unknown; until: number }
	>
	const mine: View = {
		who: id,
		name: me.name,
		device: me.device,
		alive: (rows[id]?.until ?? 0) > now,
		mine: true,
		things: den.processes().flatMap((p) => {
			const t = thingOf(String(p.id), [...p.at], table.get("attributes", p.id)?.value ?? {})
			return t ? [t] : []
		}),
	}
	const out = [mine]
	for (const [who, row] of Object.entries(rows)) {
		if (who === id) continue
		const v = row.value as {
			den?: string
			nodes?: Record<string, { attributes?: Record<string, unknown> }>
			processes?: { id: string; at: string[] }[]
		}
		if (!isMap(v)) continue
		const attrs = v.nodes?.[String(v.den)]?.attributes ?? {}
		const things = (v.processes ?? []).flatMap((p) => {
			// the mirrored node, here; else the row's own words for it
			const a = table.get("attributes", p.id)?.value ?? v.nodes?.[p.id]?.attributes ?? {}
			const t = thingOf(p.id, p.at, a as Record<string, unknown>)
			return t ? [t] : []
		})
		known.set(who, {
			who,
			name: String(attrs[NAME] ?? who),
			device: String(attrs[DEVICE] ?? "browser"),
			alive: row.until > now,
			mine: false,
			things,
		})
	}
	for (const [who, v] of known) {
		if (!rows[who] || rows[who].until <= now) known.set(who, { ...v, alive: false })
	}
	out.push(...[...known.values()].sort((a, b) => a.who < b.who ? -1 : 1))
	return out
}

const label = (v: View) => v.device === "cardputer" ? v.name : `${v.name}'s browser`
// in a sentence: here, or the den's name
const where = (v: View) => v.mine ? "here" : `on ${label(v)}`
const whose = (v: View, t: Thing) => v.mine ? `your ${t.kind}` : `${label(v)}'s ${t.kind}`

function fmt(v: unknown): string {
	if (v === undefined || v === null) return "nothing"
	if (isPicture(v)) {
		let n = 0
		for (let y = 0; y < v.height; y++) {
			for (let x = 0; x < v.width; x++) {
				n += square(v, x, y) ? 1 : 0
			}
		}
		return `a picture, ${n} square${n === 1 ? "" : "s"}`
	}
	if (ArrayBuffer.isView(v)) return `${v.byteLength} bytes`
	if (typeof v === "number") return String(Math.round(v * 100) / 100)
	if (typeof v === "string") return v === "" ? '""' : `"${v.length > 14 ? v.slice(-14) : v}"`
	if (isMap(v)) {
		const vals = Object.values(v)
		if (vals.length && vals.every(Array.isArray)) {
			return `${vals.length} line${vals.length === 1 ? "" : "s"}`
		}
		return Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => `${k} ${fmt(x)}`)
			.join(" · ")
	}
	return String(v)
}

// ---- the page ----
const page = $("main")
page.hidden = false
const board = createBoard($("#board"))
const caption = $(".caption")
let hush: ReturnType<typeof setTimeout> | undefined
function say(text: string, tone?: "hot" | "ok") {
	caption.textContent = text
	caption.className = `caption shown${tone ? ` tone-${tone}` : ""}`
	clearTimeout(hush)
	hush = setTimeout(() => caption.classList.remove("shown"), 6000)
}
const you = isCard ? "you are chee's cardputer" : `you are ${me.name}`
host.onServer((state) => ($("#who").textContent = `${you} · ${state}`))
const speaker = $<HTMLButtonElement>("#sound")
const showSound = () => {
	speaker.textContent = sound.muted ? "sound off" : "sound on"
	speaker.setAttribute("aria-pressed", String(!sound.muted))
}
showSound()
speaker.onclick = () => (sound.toggle(), showSound())
if (!isCard) {
	$("#rename").hidden = false
	$("#rename").onclick = () => {
		localStorage.removeItem("dens.name")
		location.reload()
	}
}

// a hand-drawn boil on the frames' shells and the wires: six seeds, a slow round of them, the
// noise's grain gliding between (index.html's animate); still under reduced motion
{
	const turb = document.getElementById("boil-noise")!
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
		turb.querySelector("animate")?.remove()
	} else {
		let i = 0
		setInterval(() => turb.setAttribute("seed", String(1 + (i++ % 6))), 400)
	}
}

// a sound thing's notes, through the page's sound (its mute)
playing.play = (name, freq) => {
	console.log(`note ${name} ${Math.round(freq)} Hz`)
	sound.note(freq)
}

// ---- asks, answered ----
function refusal(a: Answered): string {
	if ("error" in a) return `it couldn't read the ask (${a.error})`
	if (!("refused" in a)) return ""
	switch (a.refused) {
		case "no-permission":
			return a.answer.answer === "no" ? `no, ${a.answer.reason}` : "it hasn't decided yet"
		case "not-a-runner":
			return "it has nothing that runs that"
		case "not-there":
			return "process" in a ? "that thing isn't running there any more" : "it doesn't have that"
		case "wrong-form":
			return "that isn't the kind of thing it runs"
		case "taken":
			return "something is already in that spot"
		case "stopped":
			return "it is switched off"
	}
}

// f told the answer to ask n when it lands
function answered(n: number, f: (a: Answered) => void) {
	hosted(() => {
		const c = host.s.createEffect(() => link.answer(n), (a) => {
			if (a === undefined) return
			host.s.teardown(c)
			f(a)
		})
	})
}

const refused = (v: View, a: Answered) => {
	const why = refusal(a)
	if (!why) return false
	sound.no()
	say(`${label(v)} said no: ${why}.`, "hot")
	return true
}

const runnerOf = (kind: string) => `/system/den/runners/${kind}`
const programOf = (kind: string) => `/things/${kind}`

function add(v: View, kind: string) {
	const at = ["work", `${kind}-${hex4()}`]
	const a = kind === "counter" ? "a counter" : `a ${kind}`
	if (v.mine) {
		const r = hosted(() => den.start(runnerOf(kind), programOf(kind), at))
		if ("refused" in r) return void refused(v, r)
		say(`You started ${a} ${isCard ? "here" : "in your browser"}.`, "ok")
		return
	}
	const n = hosted(() =>
		link.ask(v.who, {
			op: "start",
			runner: runnerOf(kind),
			program: link.carry(programOf(kind), { code: true }),
			at,
		})
	)
	say(`Asking ${label(v)} to start ${a}…`)
	answered(n, (r) => refused(v, r) || say(`You started ${a} on ${label(v)}.`, "ok"))
}

// a reader started again at its spot, reading args ([den, process]) or nothing
function restart(v: View, t: Thing, args: string[], done: string) {
	if (v.mine) {
		hosted(() => den.stop(t.id, "rewired"))
		const r = hosted(() => den.start(runnerOf(t.kind), programOf(t.kind), t.at, { args }))
		if ("refused" in r) return void refused(v, r)
		return say(done, "ok")
	}
	// the start asked only once the stop is answered: the two can arrive the other way round (seen
	// once in twelve to the cardputer through galaxy), and a start first is refused taken, then the
	// stop takes the old one away. not there: gone already, so the spot is free
	const s = hosted(() => link.ask(v.who, { op: "stop", process: t.id, reason: "rewired" }))
	say(`Rewiring ${whose(v, t)}…`)
	answered(s, (a) => {
		if (!("refused" in a && a.refused === "not-there") && refused(v, a)) return
		const n = hosted(() =>
			link.ask(v.who, {
				op: "start",
				runner: runnerOf(t.kind),
				program: link.carry(programOf(t.kind), { code: true }),
				at: t.at,
				args,
			})
		)
		answered(n, (r) => refused(v, r) || say(done, "ok"))
	})
}

function remove(v: View, t: Thing) {
	if (v.mine) {
		hosted(() => den.stop(t.id, "removed"))
		return say(`You took ${whose(v, t)} away.`)
	}
	const n = hosted(() => link.ask(v.who, { op: "stop", process: t.id }))
	answered(n, (r) => refused(v, r) || say(`You took ${whose(v, t)} away.`))
}

// someone else's asks to this den, in words
const rewiring = new Set<string>()
host.onAsked(({ from, op, runner }) => {
	const v = known.get(from)
	const who = v ? label(v) : from
	const kind = Array.isArray(runner) ? runner.at(-1) : String(runner ?? "").split("/").at(-1)
	if (op === "stop") {
		// the start comes a round trip after its stop (restart waits for the stop's answer)
		rewiring.add(from)
		setTimeout(() => rewiring.delete(from), 5000)
	} else if (op === "start") {
		say(
			rewiring.has(from)
				? `${who} rewired a ${kind} here.`
				: `${who} started a${kind === "" ? "" : ` ${kind}`} here.`,
		)
	}
})

// ---- frames: one per den ----
const SLOT = { w: 300, h: 236 }
const COLS = 2
const TOP = 64
// in a browser's den: what shows (readers) in the top part, what you press or set below it
const SHOWS = new Set(["counter", "screen", "chart", "sound"])
type Group = "top" | "bottom" | "one"
type Frame = {
	el: HTMLElement
	two: boolean
	x: number
	y: number
	w: number
	h: number
	slots: Map<string, number>
	// where each group's first slot is, from the frame's corner
	origin: Record<Group, number>
	keyboard?: HTMLElement
}
const groupOf = (f: Frame, t: Thing): Group => !f.two ? "one" : SHOWS.has(t.kind) ? "top" : "bottom"
const frames = new Map<string, Frame>()
let menu: HTMLElement | undefined

function closeMenu() {
	menu?.remove()
	menu = undefined
}
addEventListener("keydown", (e) => e.key === "Escape" && closeMenu())
board.el.addEventListener("pointerdown", (e) => {
	if (menu && !(e.target as HTMLElement).closest(".menu, .add")) closeMenu()
})

function openMenu(f: Frame, v: View, button: HTMLElement) {
	closeMenu()
	menu = h("div", "menu")
	for (const k of KINDS) {
		const tile = h("button", `tile tile-${k}`)
		tile.append(picture(k, 5), h("span", "", k))
		tile.onclick = () => {
			closeMenu()
			add(v, k)
		}
		menu.append(tile)
	}
	f.el.append(menu)
	menu.style.left = `${button.offsetLeft + button.offsetWidth - 4}px`
	;(menu.firstElementChild as HTMLElement).focus()
}

function denCode(v: View): string {
	const id = JSON.stringify(v.who)
	const common = `// what the page asks of a den (none of it is on the page)
createDen({ scheduler, table, places, scopes,
  id: ${id}, name: ${JSON.stringify(v.name)}, device: "${v.device}",
  // a demo policy: yes to every ask, from anyone
  may: () => ({ answer: "yes" }) })
for (const kind of ["button", "pad", "timer", "counter", "screen", "chart", "sound"${
		v.device === "cardputer" ? `, "keys", "pigs"` : ""
	}])
  den.offer("runners", kind,
    { "ermine.runner.takes": "thing." + kind }, run[kind])
// programs at /things/<kind>, ermine.type "thing.<kind>"
// the room ${room}: its id is "ermine://" + hex(blake3("party.chee.ermine.dens.room:${room}"))
const link = connect(den, channel, { topic: roomId("${room}"), publish: true })
// its row at the presence anchor "${ANCHOR}": den.nodes(),
// each process's node and attributes, whole, as they change`
	return v.device === "cardputer"
		? `${common}
// at boot, its hardware as things:
den.start("/system/den/runners/keys", "/things/keys", "/work/keys")
den.start("/system/den/runners/screen", "/things/screen", "/work/screen")
den.start("/system/den/runners/pigs", "/things/pigs", "/work/pigs")`
		: common
}

const KEYS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]

function frameOf(v: View): Frame {
	let f = frames.get(v.who)
	if (f) return f
	const el = h("div", `frame ${v.device === "cardputer" ? "cardputer" : "browser"}`)
	if (v.mine) el.classList.add("mine")
	// one big panel for every den (a two-part one was tried; chee: one is nicer)
	const two = false
	el.innerHTML = two
		? `<div class="shell"></div>
		<div class="head avoid"><span class="live"></span><span class="label"></span><span class="denpath"></span>
			<button class="add" title="add a thing">+ add</button><button class="flip" title="turn it over">{ }</button></div>
		<div class="glass top"><p class="hint">counters, charts and sounds show up here</p></div>
		<div class="hinge"><i></i><i></i></div>
		<div class="glass bottom"><p class="hint">buttons and timers go here: <b>+ add</b></p></div>
		<pre class="back" hidden></pre>`
		: `<div class="shell"></div>
		<div class="head avoid"><span class="live"></span><span class="label"></span><span class="denpath"></span>
			<button class="add" title="add a thing">+ add</button><button class="flip" title="turn it over">{ }</button></div>
		<div class="glass"><p class="hint">nothing here yet: <b>+ add</b> puts a thing in</p></div>
		<pre class="back" hidden></pre>`
	$(".label", el).textContent = label(v)
	$(".denpath", el).textContent = `/system/dens/${v.who}`
	$(".back", el).textContent = denCode(v)
	board.world.prepend(el)
	f = { el, two, x: 0, y: 0, w: 0, h: 0, slots: new Map(), origin: { top: 0, bottom: 0, one: 0 } }
	const frame = f
	$(".add", el).onclick = (e) => {
		e.stopPropagation()
		const now = views().find((x) => x.who === v.who) ?? v
		if (menu) closeMenu()
		else openMenu(frame, now, e.currentTarget as HTMLElement)
	}
	$(".flip", el).onclick = () => {
		const back = $(".back", el)
		back.hidden = !back.hidden
		$(".flip", el).classList.toggle("on", !back.hidden)
	}
	if (v.device === "cardputer") {
		const kb = h("div", "keyboard")
		for (const row of [...KEYS, " "]) {
			const r = h("div", "keyrow")
			for (const k of row === " " ? ["space", "del"] : [...row]) {
				const key = h("button", `key${k.length > 1 ? " wide" : ""}`, k)
				key.onpointerdown = (e) => {
					e.stopPropagation()
					press(v, k === "space" ? " " : k)
				}
				r.append(key)
			}
			kb.append(r)
		}
		el.append(kb)
		f.keyboard = kb
	}
	frames.set(v.who, f)
	return f
}

// a key on a cardputer: to its keys thing, when it runs here
function press(v: View, k: string) {
	if (!v.mine) return say(`Type on ${label(v)} itself: its keys are there.`)
	const keys = den.processes().find((p) => p.at.at(-1) === "keys")
	const c = keys && controls.get(String(keys.id))
	if (!c?.type) return
	c.type(k)
}
if (isCard) {
	addEventListener("keydown", (e) => {
		if ((e.target as HTMLElement).closest("input") || e.metaKey || e.ctrlKey) return
		const k = e.key === "Backspace" ? "del" : e.key.length === 1 ? e.key.toLowerCase() : ""
		if (!k) return
		const v = views()[0]
		const kb = frames.get(v.who)?.keyboard
		const key = [...(kb?.querySelectorAll("button") ?? [])].find((b) =>
			b.textContent === (k === " " ? "space" : k)
		)
		sound.key()
		key?.classList.add("down")
		setTimeout(() => key?.classList.remove("down"), 120)
		press(v, k)
	})
}

// a slot in its den's frame (in its part), the same one for the same spot (a rewired thing keeps
// its place)
function slotOf(f: Frame, t: Thing, live: Set<string>): number {
	const g = groupOf(f, t)
	const key = `${g} ${t.at.join("/")}`
	let i = f.slots.get(key)
	if (i !== undefined) return i
	const used = new Set(
		[...f.slots].filter(([k]) => k.startsWith(`${g} `) && live.has(k)).map(([, n]) => n),
	)
	for (i = 0; used.has(i); i++);
	f.slots.set(key, i)
	return i
}

// ---- things: one box each ----
type Shown = {
	box: Box
	// where the page last put it (dragged elsewhere since: left there)
	placed: { x: number; y: number }
	kind: string
	who: string
	out: string
	update: (t: Thing, v: View) => void
}
const shown = new Map<string, Shown>()
const COLOURS = ["#ff2284", "#2269ff", "#13917a", "#000"]

function lines(canvas: HTMLCanvasElement, series: Record<string, number[]>) {
	const W = 220, H = 112, k = Math.max(2, Math.ceil(devicePixelRatio || 1))
	canvas.width = W * k
	canvas.height = H * k
	canvas.style.width = `${W}px`
	canvas.style.height = `${H}px`
	const ctx = canvas.getContext("2d")!
	ctx.scale(k, k)
	ctx.fillStyle = "#fff"
	ctx.fillRect(0, 0, W, H)
	const all = Object.values(series).flat()
	const lo = Math.min(0, ...all), hi = Math.max(1, ...all)
	const n = Math.max(2, ...Object.values(series).map((l) => l.length))
	const px = (i: number) => 26 + (i / (n - 1)) * (W - 34)
	const py = (x: number) => H - 14 - ((x - lo) / (hi - lo || 1)) * (H - 26)
	ctx.strokeStyle = "#eee"
	for (let g = 0; g <= 3; g++) {
		const y = Math.round(12 + g * (H - 26) / 3) + 0.5
		ctx.beginPath()
		ctx.moveTo(26, y)
		ctx.lineTo(W - 6, y)
		ctx.stroke()
	}
	ctx.fillStyle = "#666"
	ctx.font = "9px Monaco, ui-monospace, monospace"
	ctx.fillText(String(Math.round(hi)), 2, 15)
	ctx.fillText(String(Math.round(lo)), 2, H - 11)
	Object.entries(series).sort(([a], [b]) => a < b ? -1 : 1).forEach(([name, l], j) => {
		const c = COLOURS[j % COLOURS.length]
		ctx.strokeStyle = ctx.fillStyle = c
		ctx.lineWidth = 2
		ctx.beginPath()
		l.forEach((x, i) => (i ? ctx.lineTo(px(i), py(x)) : ctx.moveTo(px(i), py(x))))
		ctx.stroke()
		if (l.length) {
			ctx.beginPath()
			ctx.arc(px(l.length - 1), py(l.at(-1)!), 3, 0, 6.29)
			ctx.fill()
		}
		if (name !== "value") ctx.fillText(name, 30 + j * 56, H - 2)
	})
}

// pictures' squares drawn on a canvas, scale css pixels a square, over paper: each layer's in its
// colour, the later on top
function squares(
	canvas: HTMLCanvasElement,
	paper: string,
	layers: [Picture | undefined, string][],
	scale = 4,
) {
	const W = PAD.width * scale,
		H = PAD.height * scale,
		k = Math.max(2, Math.ceil(devicePixelRatio || 1))
	if (canvas.width !== W * k) {
		canvas.width = W * k
		canvas.height = H * k
		canvas.style.width = `${W}px`
		canvas.style.height = `${H}px`
	}
	const ctx = canvas.getContext("2d")!
	ctx.setTransform(k, 0, 0, k, 0, 0)
	ctx.fillStyle = paper
	ctx.fillRect(0, 0, W, H)
	for (const [p, ink] of layers) {
		if (!p) continue
		const s = Math.min(W / p.width, H / p.height)
		ctx.fillStyle = ink
		for (let y = 0; y < p.height; y++) {
			for (let x = 0; x < p.width; x++) if (square(p, x, y)) ctx.fillRect(x * s, y * s, s, s)
		}
	}
}

// the squares from a to b, both ends in, none skipped (a quick stroke is a line, not dots)
function between([x0, y0]: [number, number], [x1, y1]: [number, number]): [number, number][] {
	const dx = Math.abs(x1 - x0),
		dy = -Math.abs(y1 - y0),
		sx = x0 < x1 ? 1 : -1,
		sy = y0 < y1 ? 1 : -1
	const out: [number, number][] = []
	let err = dx + dy
	for (;;) {
		out.push([x0, y0])
		if (x0 === x1 && y0 === y1) return out
		const e2 = 2 * err
		if (e2 >= dy) err += dy, x0 += sx
		if (e2 <= dx) err += dx, y0 += sy
	}
}

// the pigs' out: { name: weight }
const isWeights = (o: unknown): o is Record<string, number> =>
	isMap(o) && PIGS.some((p) => typeof o[p] === "number")

// what is wired into a thing's input, in words
function sourceWords(t: Thing, input = "in"): string {
	const src = t.sources.find((s) => s.input === input)
	if (!src) return ""
	const it = sourceOf(src)
	return it ? whose(it.v, it.t) : "a thing that has gone"
}

// the thing a source names: in its den, at its path
function sourceOf(src: Source): { v: View; t: Thing } | undefined {
	const v = views().find((x) => x.who === src.den)
	const t = v?.things.find((x) => `/${x.at.join("/")}` === src.at)
	return v && t ? { v, t } : undefined
}

const short = (a: string) => JSON.stringify(a.length > 22 ? a.slice(0, 22) + "…" : a)

function thingCode(v: View, t: Thing): string {
	const list = t.args.length ? `[${t.args.map(short).join(", ")}]` : ""
	const start = v.mine
		? `den.start(\n  "${runnerOf(t.kind)}",\n  "${programOf(t.kind)}",\n  "/${t.at.join("/")}"${
			list ? `,\n  { args: ${list} }` : ""
		})`
		: `link.ask(${JSON.stringify(v.who)}, { op: "start",\n  runner: "${
			runnerOf(t.kind)
		}",\n  program: link.carry("${programOf(t.kind)}", { code: true }),\n  at: "/${
			t.at.join("/")
		}"${list ? `,\n  args: ${list}` : ""} })`
	const reads = t.sources.map((s) =>
		`\n//   ${s.input}: the node at ${s.at}, its attributes["thing.out"]`
	).join("")
	return `// how this ${t.kind} came to be (as seen from here)
${start}
// a process: /${t.at.join("/")}, node ${t.id.slice(0, 13)}…
// what it gives, on its own node:
//   attributes["thing.out"] = ${fmt(t.out)}${
		reads ? `\n// what it reads, each its source's node, here or mirrored:${reads}` : ""
	}
// args: [input, den id, process id] for each wire in,
// and settings as "name=value". a wire = this thing
// started again with new args; in another den, an ask
// to stop it and an ask to start it`
}

// what a thing reads, by kind
const INPUTS: Record<string, string[]> = {
	pad: ["in"],
	counter: ["in"],
	screen: ["in"],
	chart: ["in"],
	sound: ["in"],
	pigs: [...PIGS, "say"],
}

// a speech bubble shown a while after it changes
const SAYING = 4000
const said = new Map<string, { n: unknown; since: number }>()

function makeShown(
	v: View,
	t: Thing,
	x: number,
	y: number,
	bounds: () => { x0: number; y0: number; x1: number; y1: number },
): Shown {
	const box = board.box({
		id: t.id,
		x,
		y,
		bounds,
		width: t.kind === "pigs" ? SLOT.w - 16 : SLOT.w - 50,
		title: t.kind,
		kind: SHOWS.has(t.kind) || t.kind === "sound" ? "compute" : "key",
		ins: (INPUTS[t.kind] ?? []).map((i) => [i, i] as [string, string]),
		outs: [["out", "out"]],
	})
	box.el.tabIndex = 0
	box.el.classList.add("pop", `thing-${t.kind}`)
	if (!v.mine) box.el.classList.add("away")
	const x2 = h("button", "box-x", "×")
	x2.title = "take it away"
	x2.onclick = (e) => {
		e.stopPropagation()
		const now = views().find((q) => q.who === v.who)
		const tt = now?.things.find((q) => q.id === t.id)
		if (now && tt) remove(now, tt)
	}
	$(".box-head", box.el).append(x2)
	// its path, as this page's tree has it
	$(".box-head", box.el).after(h("div", "box-path avoid"))
	box.code(thingCode(v, t))
	const body = box.body
	const note = h("div", "note")
	const theirs = v.mine ? "" : `on ${label(v)}`
	let update: Shown["update"] = () => {}
	if (t.kind === "button") {
		const b = h("button", "press", "press")
		const tag = h("span", "tag")
		b.disabled = !v.mine
		if (!v.mine) b.title = `press it ${theirs}`
		b.onclick = () => {
			controls.get(t.id)?.press?.()
		}
		box.el.addEventListener("keydown", (e) => {
			if ((e.key === "Enter" || e.key === " ") && e.target === box.el) {
				e.preventDefault()
				b.click()
			}
		})
		body.append(b, tag, note)
		update = (t) => {
			tag.textContent = `${t.out ?? 0} press${t.out === 1 ? "" : "es"}`
			note.textContent = v.mine ? "" : `pressed ${theirs}`
		}
	} else if (t.kind === "timer") {
		const n = h("div", "number")
		const row = h("div", "steps")
		const pick = new Map<number, HTMLButtonElement>()
		for (const sec of [1, 2, 5]) {
			const b = h("button", "step", `${sec} s`)
			b.disabled = !v.mine
			b.onclick = () => controls.get(t.id)?.every?.(sec)
			pick.set(sec, b)
			row.append(b)
		}
		const play = h("button", "step play")
		play.disabled = !v.mine
		play.onclick = () => controls.get(t.id)?.pause?.()
		row.append(play)
		body.append(n, row, note)
		update = (t) => {
			n.textContent = String(t.out ?? 0)
			const st = isMap(t.state) ? t.state : {}
			for (const [sec, b] of pick) b.setAttribute("aria-pressed", String(st.every === sec))
			play.textContent = st.paused ? "play" : "pause"
			note.textContent = st.paused ? "paused" : `ticks every ${st.every ?? 1} s ${theirs}`
		}
	} else if (t.kind === "counter") {
		const n = h("div", "number")
		body.append(n, note)
		update = (t) => {
			n.textContent = String(t.out ?? 0)
			const src = sourceWords(t)
			note.textContent = src ? `changes of ${src}` : "wire something into its in"
		}
	} else if (t.kind === "pad") {
		const c = h("canvas", "pad")
		const clear = h("button", "step", "clear")
		clear.hidden = !v.mine
		body.append(c, clear, note)
		let last = t
		// here: your squares in ink over what is wired in, in cherry, as you draw; away: its out
		const paint = () => {
			const live = v.mine ? controls.get(t.id)?.now?.() : undefined
			squares(
				c,
				"#fff",
				live
					? [[live.under, "#ff2284"], [live.mine, "#000"]]
					: [[isPicture(last.out) ? last.out : undefined, "#000"]],
			)
		}
		clear.onclick = () => {
			controls.get(t.id)?.clear?.()
			paint()
		}
		if (v.mine) {
			// a stroke sets squares, or clears them when it starts on a set one
			let on = true, at: [number, number] | undefined
			const cell = (e: PointerEvent): [number, number] => {
				const r = c.getBoundingClientRect()
				return [
					Math.floor(((e.clientX - r.left) / r.width) * PAD.width),
					Math.floor(((e.clientY - r.top) / r.height) * PAD.height),
				]
			}
			c.onpointerdown = (e) => {
				if (e.button !== 0) return
				e.stopPropagation()
				e.preventDefault()
				c.setPointerCapture(e.pointerId)
				const now = controls.get(t.id)?.now?.()
				at = cell(e)
				on = !(now && square(now.mine, at[0], at[1]))
				controls.get(t.id)?.draw?.(at[0], at[1], on)
				paint()
			}
			c.onpointermove = (e) => {
				if (!at) return
				const to = cell(e)
				for (const [x, y] of between(at, to)) controls.get(t.id)?.draw?.(x, y, on)
				at = to
				paint()
			}
			c.onpointerup = c.onpointercancel = () => void (at = undefined)
		}
		update = (t) => {
			last = t
			paint()
			const src = sourceWords(t)
			note.textContent = v.mine
				? src ? `draw over ${src}` : "draw on it; wire another pad into its in to draw together"
				: src
				? `drawn ${theirs}, over ${src}`
				: `drawn ${theirs}`
		}
	} else if (t.kind === "screen") {
		const sc = h("div", "lcd")
		// a picture, in squares; the pigs' weights, as pigs
		const pic = h("canvas", "lcd-picture")
		const pond = h("canvas", "lcd-pigs")
		const farm: Farm = createFarm(pond, { width: 180, height: 104 })
		pond.style.width = "180px"
		pond.style.height = "104px"
		body.append(sc, pic, pond, note)
		update = (t) => {
			const o = t.out
			const drawn = isPicture(o), pigs = !drawn && isWeights(o)
			sc.hidden = drawn || pigs
			pic.hidden = !drawn
			pond.hidden = !pigs
			if (drawn) squares(pic, "#000", [[o, "#ff8"]])
			if (pigs) {
				const ns = Object.keys(o).filter((n) => typeof o[n] === "number").sort()
				farm.draw({
					pigs: ns.map((name, i) => ({
						name,
						weight: o[name],
						x: 0.08 + i * 0.36,
						y: 0.45 + (i % 2) * 0.3,
					})),
					apples: 0,
				})
			}
			sc.classList.toggle("empty", o === null || o === undefined)
			sc.classList.toggle("small", typeof o !== "number")
			sc.textContent = o === null || o === undefined
				? "—"
				: isMap(o)
				? Object.entries(o).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => `${k} ${fmt(x)}`)
					.join("\n")
				: typeof o === "string"
				? o
				: fmt(o)
			const src = sourceWords(t)
			note.textContent = src ? `shows ${src}` : "wire something into its in"
		}
	} else if (t.kind === "chart") {
		const c = h("canvas", "chart")
		body.append(c, note)
		update = (t) => {
			const series = isMap(t.out) ? t.out as Record<string, number[]> : {}
			lines(c, series)
			const src = sourceWords(t)
			note.textContent = src ? `${src}, over time` : "wire something into its in"
		}
	} else if (t.kind === "sound") {
		const pic = picture("sound", 6)
		pic.classList.add("speaker")
		const name = h("div", "notename")
		const row = h("div", "soundrow")
		row.append(pic, name)
		body.append(row, note)
		let last = ""
		update = (t) => {
			name.textContent = t.out ? String(t.out) : "—"
			const now = JSON.stringify(t.out)
			if (now !== last && last !== "") {
				pic.classList.remove("ping")
				void pic.offsetWidth
				pic.classList.add("ping")
			}
			last = now
			const src = sourceWords(t)
			note.textContent = src
				? `plays ${src} ${v.mine ? "here" : theirs}`
				: "wire something into its in"
		}
	} else if (t.kind === "keys") {
		const typed = h("div", "typed")
		body.append(typed, note)
		update = (t) => {
			typed.textContent = String(t.out ?? "")
			note.textContent = v.mine ? "type on the keys below" : `typed ${theirs}`
		}
	} else if (t.kind === "pigs") {
		const canvas = h("canvas")
		const farm: Farm = createFarm(canvas, { width: 180, height: 104 })
		canvas.style.width = "180px"
		canvas.style.height = "104px"
		const feeds = h("div", "feeds")
		const field = h("div", "field")
		const bubble = h("div", "bubble")
		bubble.hidden = true
		field.append(canvas, bubble)
		body.append(field, feeds, note)
		let names = ""
		said.set(t.id, { n: isMap(t.says) ? t.says.n : undefined, since: 0 })
		update = (t) => {
			const w = isMap(t.out) ? t.out as Record<string, number> : {}
			const ns = Object.keys(w).sort()
			const says = isMap(t.says) ? t.says : undefined
			const s = said.get(t.id)
			if (says && s?.n !== says.n) said.set(t.id, { n: says.n, since: Date.now() })
			const fresh = says && Date.now() - (said.get(t.id)?.since ?? 0) < SAYING
			farm.draw({
				pigs: ns.map((name, i) => ({
					name,
					weight: w[name],
					x: 0.08 + i * 0.36,
					y: 0.45 + (i % 2) * 0.3,
				})),
				apples: 3,
			})
			// what they were told, over the pig whose turn it was, a while
			const i = says ? ns.indexOf(String(says.pig)) : -1
			bubble.hidden = !fresh || i === -1
			if (fresh && i !== -1) {
				bubble.textContent = String(says.text)
				bubble.style.left = `${Math.round(10 + i * 0.36 * 140)}px`
				bubble.style.top = `${i % 2 ? 22 : 2}px`
			}
			const wired = PIGS.filter((p) => t.sources.some((s) => s.input === p))
			note.textContent = wired.length
				? `fed by ${wired.map((p) => `${p}: ${sourceWords(t, p)}`).join(", ")}`
				: v.mine
				? "feed them, or wire something into a pig"
				: `feed them ${theirs}, or wire something into a pig`
			if (names === ns.join()) return
			names = ns.join()
			feeds.replaceChildren(...(v.mine ? ns : []).map((name) => {
				const b = h("button", "feed", `feed ${name}`)
				b.onclick = () => {
					controls.get(t.id)?.feed?.(name)
				}
				return b
			}))
		}
	}
	return { box, placed: { x, y }, kind: t.kind, who: v.who, out: "", update }
}

// ---- wires ----
const wires = new Map<string, Wire & { text?: string }>()

function find(id: string): { v: View; t: Thing } | undefined {
	for (const v of views()) {
		const t = v.things.find((t) => t.id === id)
		if (t) return { v, t }
	}
}

// whether reading src from reader would come back round to reader
function loops(src: string, reader: string): boolean {
	const todo = [src], seen = new Set<string>()
	while (todo.length) {
		const id = todo.pop()!
		if (id === reader) return true
		if (seen.has(id)) continue
		seen.add(id)
		for (const s of find(id)?.t.sources ?? []) {
			const it = sourceOf(s)
			if (it) todo.push(it.t.id)
		}
	}
	return false
}

// a reader's args with one input wired to src (none: unwired); the pigs keep their weights
function argsWith(t: Thing, input: string, src?: Source): string[] {
	const sources = t.sources.filter((s) => s.input !== input)
	if (src) sources.push(src)
	const kept = isMap(t.state) ? t.state.squares : undefined
	const settings = t.kind === "pigs" && isMap(t.out)
		? Object.fromEntries(Object.entries(t.out).map(([k, w]) => [k, String(w)]))
		: t.kind === "pad" && kept instanceof Uint8Array
		? { squares: Array.from(kept, (b) => b.toString(16).padStart(2, "0")).join("") }
		: {}
	return unparse(sources, settings)
}

const inWords = (v: View, t: Thing, input: string) =>
	t.kind !== "pigs"
		? whose(v, t)
		: input === "say"
		? (v.mine ? "what your pigs say" : `what the pigs on ${label(v)} say`)
		: (v.mine ? `your pig ${input}` : `${input}, a pig on ${label(v)}`)

// a wire: the reader started again, reading the source by its path
function connect(source: string, reader: string, input: string, port?: HTMLElement): boolean {
	const s = find(source), r = find(reader)
	if (!s || !r) return false
	if (!(INPUTS[r.t.kind] ?? []).includes(input)) return false
	if (loops(s.t.id, r.t.id)) {
		sound.no()
		say("That wire would make a loop: each would count the other forever.", "hot")
		return false
	}
	sound.snap()
	if (port) {
		port.classList.remove("snap")
		void port.offsetWidth
		port.classList.add("snap")
	}
	restart(
		r.v,
		r.t,
		argsWith(r.t, input, { input, den: s.v.who, at: `/${s.t.at.join("/")}` }),
		`You wired ${whose(s.v, s.t)} (/${s.t.at.join("/")}) to ${inWords(r.v, r.t, input)}.`,
	)
	return true
}
board.onConnect((from: Port, to: Port) => connect(from.box.id, to.box.id, to.name, to.el))

// a thing dragged from the files, dropped on an in-port: the same wire
board.world.addEventListener("dragover", (e) => {
	const p = (e.target as HTMLElement).closest(".port")
	if (!p || !e.dataTransfer?.types.includes("text/x-ermine-id")) return
	e.preventDefault()
	for (const d of board.world.querySelectorAll(".port.near")) d.classList.remove("near")
	p.classList.add("near")
})
board.world.addEventListener("drop", (e) => {
	const p = (e.target as HTMLElement).closest<HTMLElement>(".port")
	const id = e.dataTransfer?.getData("text/x-ermine-id")
	for (const d of board.world.querySelectorAll(".port.near")) d.classList.remove("near")
	if (!p || !id) return
	e.preventDefault()
	const reader = p.closest<HTMLElement>(".box")?.dataset.id
	const input = p.querySelector(".port-label")?.textContent ?? ""
	if (!reader || !connect(id, reader, input, p)) {
		sound.no()
		say("Only an in can read: drop it on a dot marked in, or on a pig.", "hot")
	}
})

board.onDisconnect((w: Wire) => {
	const r = find(w.to.box.id)
	for (const [k, x] of wires) if (x === w) wires.delete(k)
	if (r) restart(r.v, r.t, argsWith(r.t, w.to.name), `You unwired ${whose(r.v, r.t)}.`)
})

// ---- the files and the terminal, docked under the board; one selection shared with the board ----
let picked: Box | undefined
const dock = $(".dock")
const docked = () => page.style.setProperty("--dock", `${dock.offsetHeight}px`)
docked()
new ResizeObserver(docked).observe(dock)
function pick(b: Box | undefined) {
	picked?.tone(undefined)
	picked = b
	b?.tone("pick")
}
const files = createFiles(host, $(".files"), {
	pick: (_, id) => {
		const s = id === undefined ? undefined : shown.get(id)
		pick(s?.box)
		if (s) board.show(s.box)
	},
	isThing: (id) => shown.has(id),
	live: (name, fn) => code.live(name, fn),
})
createTerminal(host, $(".term"))
// the code window: the page's own files, and a live function's code. a site anywhere on the page
// (data-code, data-line) opens its file there
let showCode = (_: boolean) => {}
const code = createCode($(".code.window"), () => showCode(true))
addEventListener("click", (e) => {
	const a = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-code]") : null
	if (!a) return
	code.open(a.dataset.code!, Number(a.dataset.line))
})
board.onPick((b) => {
	pick(b)
	const f = b && find(b.id)
	if (f) files.select(f.t.at)
})
{
	// the terminal shown or not, and the dock folded down to its toolbar: remembered
	const term = $<HTMLButtonElement>(".show-term"), fold = $<HTMLButtonElement>(".fold")
	const codes = $<HTMLButtonElement>(".show-code")
	const kept = (k: string) => {
		try {
			return localStorage.getItem(k)
		} catch {
			return null
		}
	}
	const keep = (k: string, v: string) => {
		try {
			localStorage.setItem(k, v)
		} catch { /* this visit only */ }
	}
	const showTerm = (on: boolean) => {
		dock.classList.toggle("no-term", !on)
		term.setAttribute("aria-pressed", String(on))
	}
	const showFold = (on: boolean) => {
		dock.classList.toggle("folded", on)
		fold.setAttribute("aria-pressed", String(on))
		fold.textContent = on ? "open" : "fold"
		docked()
		requestAnimationFrame(() => board.redraw())
	}
	showCode = (on: boolean) => {
		dock.classList.toggle("no-code", !on)
		codes.setAttribute("aria-pressed", String(on))
		if (on && dock.classList.contains("folded")) showFold(false)
	}
	showCode(false)
	codes.onclick = () => showCode(codes.getAttribute("aria-pressed") !== "true")
	showTerm(kept("dens:dock:term") !== "0")
	showFold(kept("dens:dock:folded") === "1")
	term.onclick = () => {
		const on = term.getAttribute("aria-pressed") !== "true"
		showTerm(on)
		keep("dens:dock:term", on ? "1" : "0")
		if (on) $<HTMLInputElement>(".term input").focus()
	}
	fold.onclick = () => {
		const on = !dock.classList.contains("folded")
		showFold(on)
		keep("dens:dock:folded", on ? "1" : "0")
	}
	const grab = $(".dock-grab")
	grab.onpointerdown = (e) => {
		grab.setPointerCapture(e.pointerId)
		const y0 = e.clientY, h0 = dock.offsetHeight
		if (dock.classList.contains("folded")) showFold(false)
		grab.onpointermove = (m) => {
			dock.style.height = `${
				Math.max(120, Math.min(innerHeight * 0.75, h0 - (m.clientY - y0)))
			}px`
			docked()
		}
		grab.onpointerup = () => (grab.onpointermove = null, board.redraw())
	}
}

// ---- drawing it all ----
let shape = ""
let seen = new Set<string>()
let first = true
const centre = (b: Box) => b.pos().x + b.el.offsetWidth / 2

function render() {
	const vs = views()
	// frames, side by side
	let x = 0
	const live = new Set<string>()
	const natural = new Map<string, { top: number }>()
	for (const v of vs) {
		const f = frameOf(v)
		const keys = new Set(v.things.map((t) => `${groupOf(f, t)} ${t.at.join("/")}`))
		for (const t of v.things) slotOf(f, t, keys)
		const rows = (g: Group) =>
			Math.max(
				1,
				Math.ceil(
					Math.max(
						0,
						...v.things.filter((t) => groupOf(f, t) === g).map((t) =>
							f.slots.get(`${g} ${t.at.join("/")}`)! + 1
						),
					) / COLS,
				),
			)
		f.w = COLS * SLOT.w + 40
		const top = rows(f.two ? "top" : "one") * SLOT.h
		f.h = f.two ? TOP + top + 30 + rows("bottom") * SLOT.h + 8 : TOP + top + 6 + 160
		natural.set(v.who, { top })
	}
	// side by side as equals: one height, the tallest's
	const H = Math.max(...vs.map((v) => frames.get(v.who)!.h))
	for (const v of vs) {
		const f = frames.get(v.who)!
		const { top } = natural.get(v.who)!
		f.h = H
		if (f.two) {
			const hinge = TOP + top + 2
			f.origin = { top: TOP, bottom: hinge + 30, one: TOP }
			Object.assign($(".glass.top", f.el).style, { top: "58px", height: `${top + 2}px` })
			$(".hinge", f.el).style.top = `${hinge + 4}px`
			Object.assign($(".glass.bottom", f.el).style, {
				top: `${hinge + 24}px`,
				height: `${H - hinge - 36}px`,
			})
			const has = (g: Group) => v.things.some((t) => groupOf(f, t) === g)
			$(".glass.top .hint", f.el).hidden = has("top") || !has("bottom")
			$(".glass.bottom .hint", f.el).hidden = has("bottom")
			if (!has("top") && !has("bottom")) {
				$(".glass.bottom .hint", f.el).textContent = "nothing here yet: + add puts a thing in"
			} else $(".glass.bottom .hint", f.el).textContent = "buttons and timers go here: + add"
		} else f.origin = { top: TOP, bottom: TOP, one: TOP }
		f.x = x
		f.y = 0
		x += f.w + 140
		Object.assign(f.el.style, {
			left: `${f.x}px`,
			top: `${f.y}px`,
			width: `${f.w}px`,
			height: `${f.h}px`,
		})
		f.el.classList.toggle("quiet", !v.alive)
		f.el.classList.toggle("empty", v.things.length === 0)
		$(".live", f.el).title = v.alive ? "here now" : "gone quiet"
		$<HTMLButtonElement>(".add", f.el).disabled = !v.alive
		for (const t of v.things) {
			live.add(t.id)
			const g = groupOf(f, t)
			const slot = f.slots.get(`${g} ${t.at.join("/")}`)!
			const px = f.x + 20 + (slot % COLS) * SLOT.w
			const py = f.y + f.origin[g] + Math.floor(slot / COLS) * SLOT.h
			let s = shown.get(t.id)
			if (s) {
				const p = s.box.pos()
				if (p.x === s.placed.x && p.y === s.placed.y && (p.x !== px || p.y !== py)) {
					s.box.move(px, py)
					s.placed = { x: px, y: py }
				}
			}
			if (!s) {
				s = makeShown(v, t, px, py, () => ({
					x0: f.x + 14,
					y0: f.y + 58,
					x1: f.x + f.w - 14,
					y1: f.y + f.h - (f.keyboard ? 168 : 12),
				}))
				shown.set(t.id, s)
			}
			const out = JSON.stringify(t.out ?? null)
			if (out !== s.out) {
				if (s.out !== "") s.box.flash("hot")
				s.out = out
			}
			s.update(t, v)
			const here = places.peep(() => get(places, t.at)) === t.id
			const pathEl = $(".box-path", s.box.el)
			pathEl.textContent = `/${t.at.join("/")}${here ? "" : " (not in this tree)"}`
			s.box.code(thingCode(v, t))
			s.box.tone(!v.alive ? "dim" : s.box === picked ? "pick" : undefined)
		}
	}
	for (const [id, s] of shown) {
		if (live.has(id)) continue
		s.box.remove()
		shown.delete(id)
	}
	// wires: each reader's sources, from the source's out to the reader's input
	const want = new Set<string>()
	const partners = new Map<Port, number[]>()
	for (const v of vs) {
		for (const t of v.things) {
			const b = shown.get(t.id)
			if (!b) continue
			for (const src of t.sources) {
				const s = sourceOf(src)
				const a = s && shown.get(s.t.id)
				if (!a || !(INPUTS[t.kind] ?? []).includes(src.input)) continue
				const k = `${s.t.id} ${t.id} ${src.input}`
				want.add(k)
				const text = fmt(s?.t.out)
				let w = wires.get(k)
				if (!w) {
					w = board.wire(a.box.port("out"), b.box.port(src.input))
					wires.set(k, w)
					w.text = text
					w.label(text)
				} else if (w.text !== text) {
					w.text = text
					w.label(text)
					w.flash("hot")
				}
				w.tone(s?.v.alive && v.alive ? undefined : "dim")
				w.hint(
					`reads ${src.at}${
						s && s.v.who !== v.who
							? ` (${label(s.v)}'s, placed in ${
								v.mine ? "this" : `${label(v)}'s`
							} tree by away)`
							: ""
					}`,
				)
				// each end faces the other
				const out = a.box.port("out"), inp = b.box.port(src.input)
				partners.set(out, [...(partners.get(out) ?? []), centre(b.box) - centre(a.box)])
				partners.set(inp, [centre(a.box) - centre(b.box)])
			}
		}
	}
	for (const [k, w] of wires) {
		if (want.has(k)) continue
		w.remove()
		wires.delete(k)
	}
	for (const s of shown.values()) {
		for (const p of [...s.box.el.querySelectorAll<HTMLElement>(".port")]) {
			const port = s.box.port(p.querySelector(".port-label")!.textContent!)
			const ds = partners.get(port)
			// an in faces its source when that is well to the left; else it faces right, the way
			// outs face (so a source above or below joins it in a bracket)
			const left = port.side === "in"
				? !ds || ds.every((d) => d < -160)
				: !!(ds && ds.every((d) => d < -160))
			board.face(port, left ? "left" : "right")
		}
	}
	// someone new, or gone quiet
	const now = new Set(vs.filter((v) => v.alive && !v.mine).map((v) => v.who))
	for (const who of now) {
		if (seen.has(who)) continue
		const v = vs.find((x) => x.who === who)!
		if (!first) {
			sound.chime()
			say(`${label(v)} is here.`, "ok")
		}
		hosted(() => link.announce())
	}
	for (const who of seen) {
		if (now.has(who)) continue
		const v = vs.find((x) => x.who === who)
		if (v) say(`${label(v)} went quiet.`)
	}
	seen = now
	first = false
	// the view fitted when the frames change shape
	const sh = vs.map((v) => `${v.who}:${frames.get(v.who)!.h}`).join()
	if (sh !== shape) {
		shape = sh
		requestAnimationFrame(() => board.fit(40))
	}
	$("#room").textContent = vs.filter((v) => v.alive).length === 1
		? "nobody else here yet"
		: `${vs.filter((v) => v.alive).length} dens here`
}
// the room's code in the header: click it to copy the link; "join" to type another room's code
{
	const chip = $<HTMLButtonElement>("#code")
	chip.textContent = room
	chip.hidden = false
	chip.title = "copy the link to this room"
	chip.onclick = async () => {
		try {
			await navigator.clipboard.writeText(location.href)
			say(`Copied the link to room ${room}. Whoever opens it lands here.`, "ok")
		} catch {
			say(`The link to room ${room} is this page's address.`)
		}
	}
	const given = search.get("room")
	if (given !== null && roomCode(given) === undefined) {
		say(
			`"${given}" isn't a room code (four letters, no I, L, O, B, G, Q, S, U, V or Z), so you're in room ${room}.`,
			"hot",
		)
	}
	const join = $<HTMLFormElement>("#join")
	join.hidden = isCard
	join.onsubmit = (e) => {
		e.preventDefault()
		const field = $<HTMLInputElement>("input", join)
		const code = roomCode(field.value)
		if (!code) {
			field.setCustomValidity("four letters, like the ones on the screen")
			field.reportValidity()
			field.oninput = () => field.setCustomValidity("")
			return
		}
		const url = new URL(location.href)
		url.searchParams.set("room", code)
		location.href = url.href
	}
}

// a bubble's time up: drawn again without it
setInterval(() => {
	for (const s of said.values()) {
		if (s.since && Date.now() - s.since > SAYING && Date.now() - s.since < SAYING + 1200) {
			render()
			break
		}
	}
}, 500)

let drawing = false
host.onPulse(() => {
	if (drawing) return
	drawing = true
	requestAnimationFrame(() => {
		drawing = false
		render()
	})
})
render()
host.soon()
say(
	isCard
		? "This is chee's cardputer. Type on its keys, feed its pigs; other dens show up beside it."
		: "Add things with + add, here or on another den. Drag from an out dot to an in dot to wire them.",
)

// arrows move the focus between things, nearest that way
addEventListener("keydown", (e) => {
	const dirs: Record<string, [number, number]> = {
		ArrowLeft: [-1, 0],
		ArrowRight: [1, 0],
		ArrowUp: [0, -1],
		ArrowDown: [0, 1],
	}
	const d = dirs[e.key]
	if (!d || (e.target as HTMLElement).closest("input, .dock")) return
	const all = [...board.world.querySelectorAll<HTMLElement>(".box, .frame .add, .menu .tile")]
	if (!all.length) return
	e.preventDefault()
	const cur = document.activeElement as HTMLElement
	const mid = (el: Element) => {
		const r = el.getBoundingClientRect()
		return [r.left + r.width / 2, r.top + r.height / 2]
	}
	if (!all.includes(cur)) return all[0].focus()
	const [cx, cy] = mid(cur)
	let best: HTMLElement | undefined, bd = Infinity
	for (const el of all) {
		if (el === cur) continue
		const [x, y] = mid(el)
		const along = (x - cx) * d[0] + (y - cy) * d[1]
		if (along <= 4) continue
		const across = Math.abs((x - cx) * d[1]) + Math.abs((y - cy) * d[0])
		const score = along + across * 2
		if (score < bd) (bd = score, best = el)
	}
	if (best) {
		sound.blip()
		best.focus()
	}
})
