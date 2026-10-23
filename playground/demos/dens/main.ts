/// <reference lib="dom" />
// dens: two people, two screens, one graph. each page is one running ermine (a den), its id its
// tab's device key; the dens share their nodes through tippet, a room's log on galaxy
// (wss://galaxy.observer, or ?server=ws://…; ?server=none: the tabs of one browser), and each shows
// the others' things as their steps land here. what a den runs runs on software (experiments/
// software). an ask to another den goes in its inbox, a program that den runs, and is done only if
// that den trusts this one (its authorized_keys). two dens pair first: until then each one's ins
// and outs are locked on the other's screen. ?as=cardputer: chee's cardputer
import { type Box, createBoard, type Port, type Wire } from "./kit/board.ts"
import { createFarm, type Farm } from "./kit/farm.ts"
import {
	type Answer,
	createHost,
	DEVICE,
	type Heard,
	KINDS,
	NAME,
	newCode,
	OUT,
	type Refusal,
	roomCode,
} from "./host.ts"
import {
	controls,
	isPicture,
	outlet,
	outletsOf,
	PAD,
	parse,
	type Picture,
	PIGS,
	SAYS,
	type Source,
	square,
	STATE,
	unparse,
	voice,
} from "./things.ts"
import { picture } from "./pictures.ts"
import { createFiles } from "./files.ts"
import { createTerminal } from "./terminal.ts"
import { createCode } from "./code.ts"
import { get } from "@ermine/places/lib"
import { isVoice, sound, type Voice, VOICES } from "./sound.ts"
import { RUNNER } from "@ermine/software"
import { answer } from "../devtools.ts"

const $ = <T extends HTMLElement = HTMLElement>(q: string, root: ParentNode = document) =>
	root.querySelector(q) as T
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

// where a den's speaker runs: the same spot in every den
const SPEAKER = ["system", "speaker"]
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
const { software, hosted, table, places } = host
const id = host.id
// the devtools extension: the den's graph, through a process api at its root (playground/devtools)
answer({ scheduler: host.s, table, places, scope: host.host }, {
	name: isCard ? me.name : `${me.name}'s den`,
	processes: software.running,
	stop: (p) => software.stop(p),
})
// every den's speaker, on its card: it plays what is wired into it, here
hosted(() => software.run("/system/den/runners/speaker", "/things/speaker", SPEAKER))
if (isCard) {
	for (const k of ["keys", "screen", "pigs"]) {
		hosted(() => software.run(`/system/den/runners/${k}`, `/things/${k}`, ["home", k]))
	}
}

// ---- what the page sees: each den, its things ----
type Thing = {
	// the node its attributes are on: here its process's, another den's its shared node
	id: string
	// its process, in its den
	process: string
	at: string[]
	kind: string
	out: unknown
	state: unknown
	says: unknown
	// all its attributes: what each outlet gives (outlet(name))
	attrs: Record<string, unknown>
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

function thingOf(
	id: string,
	at: string[],
	attrs: Record<string, unknown>,
	process = id,
): Thing | undefined {
	const runner = attrs[RUNNER]
	if (!isMap(runner) || !Array.isArray(runner.at)) return undefined
	const given = attrs["ermine.process.args"]
	const args = Array.isArray(given) ? given.map(String) : []
	return {
		id,
		process,
		at,
		kind: String(runner.at.at(-1)),
		out: attrs[OUT],
		state: attrs[STATE],
		says: attrs[SAYS],
		attrs,
		args,
		...parse(args),
	}
}

// this den, then the others heard on this page: grey once not heard for 6 s, its things still
// there (its steps last)
function views(): View[] {
	const mine: View = {
		who: id,
		name: me.name,
		device: me.device,
		alive: true,
		mine: true,
		things: host.things().flatMap((p) => {
			const t = thingOf(String(p.id), [...p.at], table.get("attributes", p.id)?.value ?? {})
			return t ? [t] : []
		}),
	}
	return [
		mine,
		...host.others().map((o): View => ({
			who: o.who,
			name: String(o.attributes[NAME] ?? o.who),
			device: String(o.attributes[DEVICE] ?? "browser"),
			alive: o.alive,
			mine: false,
			things: o.things.flatMap((t) => {
				const thing = thingOf(t.id, t.at, t.attributes, t.process)
				return thing ? [thing] : []
			}),
		})),
	]
}

const label = (v: View) => v.device === "cardputer" ? v.name : `${v.name}'s browser`
// in a sentence: here, or the den's name
const where = (v: View) => v.mine ? "here" : `on ${label(v)}`
const whose = (v: View, t: Thing) => v.mine ? `your ${t.kind}` : `${label(v)}'s ${t.kind}`

function fmt(v: unknown): string {
	if (v === undefined || v === null) return "nothing"
	if (isMap(v) && isVoice(v.sound)) return `♪ ${v.sound}`
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

// a hand-drawn wobble on the frames' shells and the wires (index.html's #boil), still: a seed
// changed every 400 ms filtered every frame and every wire again each time, and kept a GPU busy

// what a sound thing and this den's speaker play, through the page's sound (its mute, and its
// wait for a first click, said once). the cardputer's speaker isn't driven yet: silent
voice.silent = isCard
let toldWaiting = false
voice.play = (name: Voice) => {
	const heard = sound.play(name)
	if (heard === "waiting" && !toldWaiting) {
		toldWaiting = true
		say(
			"A sound is waiting: browsers keep a page quiet until it's been clicked. Click anywhere.",
			"hot",
		)
	}
	return heard
}

// ---- asks, answered ----
// why an ask to another den wasn't done, in words ("" : it was)
function refusal(a: Answer): string {
	if ("error" in a) return `it couldn't read the ask (${a.error})`
	if ("pair" in a) return a.pair === "yes" ? "" : "it said no"
	if (!("refused" in a)) return ""
	switch (a.refused) {
		case "not-trusted":
			return a.why === "not-in-keys"
				? "not trusted: you two aren't paired"
				: a.why === "bad-signature"
				? "not trusted: the ask's signature doesn't check out"
				: "the ask wasn't made out to it"
		case "not-a-runner":
			return "it has nothing that runs that"
		case "not-there":
			return "process" in a ? "that thing isn't running there any more" : "it doesn't have that"
		case "wrong-form":
			return "that isn't the kind of thing it runs"
		case "taken":
			return "something is already in that spot"
	}
}

// f told the answer to an ask of v's when it lands beside it in v's inbox; a word if it is slow
function answered(v: View, n: string, f: (a: Answer) => void) {
	const slow = setTimeout(
		() => say(`No answer from ${label(v)} yet. Is it still here?`),
		8000,
	)
	hosted(() => {
		const c = host.s.createEffect(() => host.answer(v.who, n), (a) => {
			if (a === undefined) return
			clearTimeout(slow)
			host.s.teardown(c)
			f(a)
		})
	})
}

// an ask into v's inbox, then f told its answer; one that can't be written, said
async function asking(v: View, ask: Parameters<typeof host.ask>[1], f: (a: Answer) => void) {
	let n
	try {
		n = await host.ask(v.who, ask)
	} catch (e) {
		n = { problem: e instanceof Error ? e.message : String(e) }
	}
	if (typeof n !== "string") {
		sound.no()
		return say(`Couldn't ask ${label(v)}: ${n.problem}.`, "hot")
	}
	answered(v, n, f)
}

const refused = (v: View, a: Answer) => {
	const why = refusal(a)
	if (!why) return false
	sound.no()
	say(
		"refused" in a && a.refused === "not-trusted" && a.why === "not-in-keys"
			? `${label(v)} said no: ${why}. Press pair on ${label(v)} first.`
			: `${label(v)} said no: ${why}.`,
		"hot",
	)
	return true
}

const runnerOf = (kind: string) => `/system/den/runners/${kind}`
const programOf = (kind: string) => `/things/${kind}`

function add(v: View, kind: string) {
	const at = ["home", `${kind}-${hex4()}`]
	const a = kind === "counter" ? "a counter" : `a ${kind}`
	if (v.mine) {
		const r = hosted(() => software.run(runnerOf(kind), programOf(kind), at))
		if ("refused" in r) return void refused(v, r)
		say(`You started ${a} ${isCard ? "here" : "in your browser"}.`, "ok")
		return
	}
	say(`Asking ${label(v)} to start ${a}…`)
	asking(
		v,
		{
			op: "start",
			runner: runnerOf(kind),
			program: host.carry(programOf(kind)),
			at: `/${at.join("/")}`,
		},
		(r) => refused(v, r) || say(`You started ${a} on ${label(v)}.`, "ok"),
	)
}

// a reader started again at its spot, reading args ([den, process]) or nothing; after told
// whether it was (a refusal said in words)
function restart(
	v: View,
	t: Thing,
	args: string[],
	done: string,
	after: (ok: boolean) => void = () => {},
) {
	if (v.mine) {
		hosted(() => software.stop(t.id, "rewired"))
		const r = hosted(() => software.run(runnerOf(t.kind), programOf(t.kind), t.at, { args }))
		if ("refused" in r) return void (refused(v, r), after(false))
		after(true)
		return say(done, "ok")
	}
	// the start asked only once the stop is answered, so it never finds the old one still there.
	// not there: gone already, so the spot is free
	say(`Rewiring ${whose(v, t)}…`)
	asking(v, { op: "stop", process: t.process, reason: "rewired" }, (a) => {
		if (!("refused" in a && a.refused === "not-there") && refused(v, a)) return after(false)
		asking(v, {
			op: "start",
			runner: runnerOf(t.kind),
			program: host.carry(programOf(t.kind)),
			at: `/${t.at.join("/")}`,
			args,
		}, (r) => {
			const no = refused(v, r)
			after(!no)
			if (!no) say(done, "ok")
		})
	})
}

function remove(v: View, t: Thing) {
	if (v.mine) {
		hosted(() => software.stop(t.id, "removed"))
		return say(`You took ${whose(v, t)} away.`)
	}
	asking(
		v,
		{ op: "stop", process: t.process },
		(r) => refused(v, r) || say(`You took ${whose(v, t)} away.`),
	)
}

// ---- pairing: a pair ask into another den's inbox; its yes opens each den's ins and outs to the
// other (render hears it: a happy sound on both screens); unpair locks them again ----
function pair(v: View) {
	say(`Asking ${label(v)} to pair…`)
	sound.blip()
	host.pair(v.who).then((n) => {
		if (typeof n !== "string") {
			sound.no()
			say(`Couldn't ask ${label(v)} to pair: ${n.problem}.`, "hot")
		}
		host.soon()
	})
}
function unpair(v: View) {
	host.unpair(v.who).then((n) => {
		if (typeof n !== "string") {
			sound.no()
			say(`Couldn't tell ${label(v)}: ${n.problem}.`, "hot")
		}
	})
	host.soon()
}
host.onPair((who, a) => {
	const v = views().find((x) => x.who === who)
	const name = v ? label(v) : `${who.slice(0, 6)}…`
	if ("pair" in a && a.pair === "no") {
		sound.no()
		say(`${name} said no.`, "hot")
	} else if (v && !("pair" in a)) refused(v, a)
	host.soon()
})

// a pair ask waiting in this den's inbox: "<name> wants to pair", yes or no (on the cardputer:
// tab or esc), a soft sound as it comes
const waiting = $(".asking")
type Want = { n: string; from: string; name: string; el: HTMLElement }
const wants: Want[] = []
function answerPair(w: Want, yes: boolean) {
	const i = wants.indexOf(w)
	if (i === -1) return
	wants.splice(i, 1)
	w.el.remove()
	host.answerPair(w.n, yes)
	if (yes) say(`You said yes to ${w.name}…`, "ok")
	else {
		sound.no()
		say(`You said no to ${w.name}.`)
	}
	host.soon()
}
function wanted(heard: Heard) {
	const n = heard.wants
	if (n === undefined || wants.some((w) => w.n === n)) return
	const name = heard.name ?? heard.from.slice(0, 6)
	const el = h("div", "want")
	const yes = h("button", "yes", isCard ? "yes · tab" : "yes")
	const no = h("button", "no", isCard ? "no · esc" : "no")
	el.append(h("p", "", `${name} wants to pair`), yes, no)
	const w: Want = { n, from: heard.from, name, el }
	yes.onclick = () => answerPair(w, true)
	no.onclick = () => answerPair(w, false)
	wants.push(w)
	waiting.append(el)
	sound.ask()
	say(`${name} wants to pair with your den.`)
}
if (isCard) {
	addEventListener("keydown", (e) => {
		const w = wants[0]
		if (!w || (e.key !== "Tab" && e.key !== "Escape")) return
		e.preventDefault()
		e.stopImmediatePropagation()
		answerPair(w, e.key === "Tab")
	}, { capture: true })
}

// someone else's asks to this den, in words: what they did, or why it wasn't done
const rewiring = new Set<string>()
const inWordsHere = (r: Refusal) =>
	r.why === "not-in-keys"
		? `not trusted: ${r.who} isn't paired with your den, so it asked for nothing.`
		: r.why === "bad-signature"
		? `not trusted: ${r.who}'s ask has a signature that doesn't check out.`
		: `not trusted: ${r.who}'s ask wasn't made out to this den.`
host.onAsked((heard) => {
	const { from, op, runner, refused } = heard
	const v = views().find((x) => x.who === from)
	const who = v ? label(v) : heard.name ?? from
	const kind = Array.isArray(runner) ? runner.at(-1) : String(runner ?? "").split("/").at(-1)
	if (refused) {
		sound.no()
		say(inWordsHere(refused), "hot")
	} else if (op === "pair") wanted(heard)
	else if (op === "unpair") {
		say(`${who} unpaired from your den: its ins and outs are locked again.`)
	} else if (op === "stop") {
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
// what went wrong in tippet: said, so it is seen
host.onTrouble((words) => say(words, "hot"))

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
// a den's things in slots: all but its speaker, which is stuck on in the card's bottom-left
// corner; that corner (CORNER px up from the bottom) is kept clear of things
const CORNER = 76
const slotted = (v: View) => v.things.filter((t) => t.kind !== "speaker")
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
	const common = `// what the page asks of a den (none of it is on the page)
// the den: the install's node, "ermine:ed01${v.who.slice(0, 8)}…",
// at /system/den and /system/dens/<id>; what it runs, on software
const software = createSoftware({ scheduler, table, places, scopes, scope })
const den = { id: node, at: ["system", "den"], scope, stored: true }
for (const kind of ["button", "pad", "timer", "counter", "screen", "chart", "sound"${
		v.device === "cardputer" ? `, "keys", "pigs"` : ""
	}])
  software.offer(den, "runners", kind,
    { "ermine.programs.takes": "thing." + kind }, run[kind])
// programs at /things/<kind>, ermine.type "thing.<kind>"
// its inbox: a program it runs, the one place that decides who may
software.offer(den, "runners", "inbox", { "ermine.programs.takes": "dens.inbox" }, inbox)
software.run("/system/den/runners/inbox", "/programs/inbox", "/system/inbox")
// the room ${room}: tippet's room "dens-${room}", its log on galaxy
const log = createLog({ store, seed })   // the den's key
createHistory({ log, table, places, kept })
sync.link(socket(new WebSocket(server + "/littlesync/tippet/dens-${room}")))
// kept, so in the room: the den's node, its things (each
// one's attributes, thing.out among them), its inbox and
// its authorized_keys. here: a live every 2 s
// an ask: into its inbox, signed; done if trusted().
// pair: an ask anyone may make; a person says yes or no
// its speaker, on its card: plays what is wired into it
software.run("/system/den/runners/speaker", "/things/speaker", "/system/speaker")`
	return v.device === "cardputer"
		? `${common}
// at boot, its hardware as things:
software.run("/system/den/runners/keys", "/things/keys", "/home/keys")
software.run("/system/den/runners/screen", "/things/screen", "/home/screen")
software.run("/system/den/runners/pigs", "/things/pigs", "/home/pigs")`
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
			<button class="pair" hidden></button><button class="add" title="add a thing">+ add</button><button class="flip" title="turn it over">{ }</button></div>
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
	$(".pair", el).onclick = (e) => {
		e.stopPropagation()
		const now = views().find((x) => x.who === v.who) ?? v
		if (host.paired(v.who)) unpair(now)
		else if (!host.pairing(v.who)) pair(now)
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
	const keys = host.things().find((p) => p.at.at(-1) === "keys")
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
	// the thing's node now: a rewire starts it again under a new id, at the same spot, in the same box
	me: { id: string }
	// where the page last put it (dragged elsewhere since: left there)
	placed: { x: number; y: number }
	kind: string
	who: string
	out: string
	update: (t: Thing, v: View) => void
}
// by spot: a thing's den and path, which a rewire keeps
const shown = new Map<string, Shown>()
const spotOf = (v: View, t: Thing) => `${v.who}:/${t.at.join("/")}`
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
		? `software.run(\n  "${runnerOf(t.kind)}",\n  "${programOf(t.kind)}",\n  "/${
			t.at.join("/")
		}"${list ? `,\n  { args: ${list} }` : ""})`
		: `// written into ${label(v)}'s inbox, signed:
host.ask(${JSON.stringify(v.who.slice(0, 8) + "…")}, { op: "start",\n  runner: "${
			runnerOf(t.kind)
		}",\n  program: host.carry("${programOf(t.kind)}"),\n  at: "/${t.at.join("/")}"${
			list ? `,\n  args: ${list}` : ""
		} })`
	const reads = t.sources.map((s) =>
		`\n//   ${s.input}: the node at ${s.at}, its attributes["${outlet(s.from)}"]`
	).join("")
	const gives = outletsOf(t.kind).map(([name], i) =>
		`\n//   attributes["${outlet(i ? name : undefined)}"] = ${
			fmt(t.attrs[outlet(i ? name : undefined)])
		}${outletsOf(t.kind).length > 1 ? ` (${name})` : ""}`
	).join("")
	return `// how this ${t.kind} came to be (as seen from here)
${start}
// a process: /${t.at.join("/")}, ${
		v.mine ? `node ${t.id.slice(0, 13)}…` : `its den's process ${t.process.slice(0, 13)}…`
	}${v.mine ? "" : `\n// shared here as the node …${t.id.slice(t.id.indexOf("/things"))}`}
// what it gives, on its own node:${gives}${
		reads ? `\n// what it reads, each its source's node, here or mirrored:${reads}` : ""
	}
// args: [input, den id, path] for each wire in, then
// "=<outlet>" when it reads a source's other outlet,
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
	speaker: ["in"],
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
	const me = { id: t.id }, spot = spotOf(v, t)
	const box = board.box({
		id: spot,
		x,
		y,
		bounds,
		width: t.kind === "pigs" ? SLOT.w - 16 : t.kind === "speaker" ? undefined : SLOT.w - 50,
		title: t.kind,
		kind: SHOWS.has(t.kind) || t.kind === "sound" ? "compute" : "key",
		ins: (INPUTS[t.kind] ?? []).map((i) => [i, i] as [string, string]),
		// its outlets: the first is its out (a speaker has none: it only takes in)
		outs: outletsOf(t.kind).map(([name], i) => [i ? name : "out", name] as [string, string]),
	})
	// more than one: each named while the pointer is on it, its words as its title
	if (outletsOf(t.kind).length > 1) {
		outletsOf(t.kind).forEach(([name, words], i) => {
			const p = box.port(i ? name : "out").el
			p.classList.add("named")
			p.title = `${name}: ${words}`
		})
	}
	box.el.tabIndex = 0
	box.el.classList.add("pop", `thing-${t.kind}`)
	if (!v.mine) box.el.classList.add("away")
	const x2 = h("button", "box-x", "×")
	x2.title = "take it away"
	x2.onclick = (e) => {
		e.stopPropagation()
		const now = views().find((q) => q.who === v.who)
		const tt = now?.things.find((q) => spotOf(now, q) === spot)
		if (now && tt) remove(now, tt)
	}
	// a den's speaker is part of its card: it stays
	if (t.kind !== "speaker") $(".box-head", box.el).append(x2)
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
			controls.get(me.id)?.press?.()
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
			b.onclick = () => controls.get(me.id)?.every?.(sec)
			pick.set(sec, b)
			row.append(b)
		}
		const play = h("button", "step play")
		play.disabled = !v.mine
		play.onclick = () => controls.get(me.id)?.pause?.()
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
			const live = v.mine ? controls.get(me.id)?.now?.() : undefined
			squares(
				c,
				"#fff",
				live
					? [[live.under, "#ff2284"], [live.mine, "#000"]]
					: [[isPicture(last.out) ? last.out : undefined, "#000"]],
			)
		}
		clear.onclick = () => {
			controls.get(me.id)?.clear?.()
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
				const now = controls.get(me.id)?.now?.()
				at = cell(e)
				on = !(now && square(now.mine, at[0], at[1]))
				controls.get(me.id)?.draw?.(at[0], at[1], on)
				paint()
			}
			c.onpointermove = (e) => {
				if (!at) return
				const to = cell(e)
				for (const [x, y] of between(at, to)) controls.get(me.id)?.draw?.(x, y, on)
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
			// long text wraps, its end in view
			sc.classList.toggle("long", typeof o === "string" && o.length > 10)
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
		// a sound: a big button, the voice it plays, and its voices as chips to pick from
		const play = h("button", "press playit", "play")
		const pic = picture("sound", 4)
		pic.classList.add("speaker")
		const name = h("span", "notename")
		const pickers = h("div", "voices")
		const chips = new Map<Voice, HTMLButtonElement>()
		for (const n of VOICES) {
			const c = h("button", "voice", n)
			c.disabled = !v.mine
			c.onclick = () => controls.get(me.id)?.choose?.(n)
			chips.set(n, c)
			pickers.append(c)
		}
		play.disabled = !v.mine
		if (!v.mine) play.title = `press it ${theirs}`
		play.onclick = () => controls.get(me.id)?.press?.()
		const row = h("div", "soundrow")
		row.append(pic, name)
		body.append(play, row, pickers, note)
		let last = ""
		update = (t) => {
			const o = isMap(t.out) ? t.out : {}
			const st = isMap(t.state) && isVoice(t.state.sound) ? t.state.sound : undefined
			for (const [n, c] of chips) c.setAttribute("aria-pressed", String(n === st))
			name.textContent = isVoice(o.sound) ? `♪ ${o.sound}${o.n ? ` · ${o.n}` : ""}` : "—"
			const now = JSON.stringify(t.out)
			if (now !== last && last !== "") {
				pic.classList.remove("ping")
				void pic.offsetWidth
				pic.classList.add("ping")
			}
			last = now
			const src = sourceWords(t)
			note.textContent = src
				? `plays each change of ${src}, and its button`
				: `press play ${v.mine ? "" : theirs}`
		}
	} else if (t.kind === "speaker") {
		// a den's speaker: an icon set into its card, its one inlet beside it. a tap: the voices,
		// one picked played once here. a sound played: one small pulse. what it has to say is in
		// its title, and in the caption when it matters. data-played, data-sound: what it played
		const icon = h("button", "speakicon")
		icon.append(picture("sound", 3))
		body.append(icon)
		icon.onclick = (e) => {
			e.stopPropagation()
			voicesFor(icon, v, me)
		}
		let last = -1
		update = (t) => {
			const o = isMap(t.out) ? t.out : {}
			const st = isMap(t.state) && isVoice(t.state.sound) ? t.state.sound : "blip"
			const n = typeof o.n === "number" ? o.n : 0
			const card = v.device === "cardputer"
			const src = sourceWords(t)
			const words = card
				? "the cardputer's speaker isn't on yet: what's wired in plays nothing on it"
				: o.heard === "muted" && v.mine
				? "sound is off here: the header's sound button turns it on"
				: o.heard === "waiting" && v.mine
				? "waiting for a click on the page before it can play"
				: src
				? `${v.mine ? "your" : `${label(v)}'s`} speaker: plays each change of ${src}`
				: `${v.mine ? "your" : `${label(v)}'s`} speaker: wire anything into its dot`
			icon.title = `${words}. it plays ${st}${v.mine ? ": tap to pick" : ""}`
			icon.dataset.sound = isVoice(o.sound) ? o.sound : ""
			icon.dataset.played = String(n)
			icon.dataset.heard = typeof o.heard === "string" ? o.heard : ""
			if (last >= 0 && n > last) {
				// one small pulse: in, and back by its own transition
				icon.classList.add("pulse")
				setTimeout(() => icon.classList.remove("pulse"), 130)
				// words when they matter: sound off here, or the cardputer's not on yet
				if (card) calmly(icon, () => say(`${label(v)}: ${words}.`))
				else if (o.heard === "muted" && v.mine) {
					calmly(icon, () => say(`A sound came in: ${words}.`))
				}
			}
			last = n
		}
	} else if (t.kind === "keys") {
		// its end in view: what it holds runs off to the left
		const typed = h("div", "typed"), held = h("span")
		typed.append(held)
		body.append(typed, note)
		update = (t) => {
			held.textContent = String(t.out ?? "")
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
					controls.get(me.id)?.feed?.(name)
				}
				return b
			}))
		}
	}
	return { box, me, placed: { x, y }, kind: t.kind, who: v.who, out: "", update }
}

// a speaker's voices, in a tiny popover by its icon: one picked is chosen and played once here
let voicePop: HTMLElement | undefined
function voicesFor(icon: HTMLElement, v: View, me: { id: string }) {
	voicePop?.remove()
	voicePop = undefined
	if (!v.mine) {
		return say(`${label(v)}'s speaker plays ${label(v)}'s own pick: only they can change it.`)
	}
	const pop = h("div", "voicepop")
	pop.setAttribute("role", "menu")
	for (const n of VOICES) {
		const b = h("button", "voice", n)
		b.setAttribute("role", "menuitem")
		b.onclick = (e) => {
			e.stopPropagation()
			controls.get(me.id)?.choose?.(n)
			voice.play(n)
			pop.remove()
			voicePop = undefined
		}
		pop.append(b)
	}
	// it opens up and to the right, over the card, from the corner the speaker is in
	const r = icon.getBoundingClientRect(), p = page.getBoundingClientRect()
	page.append(pop)
	const x = r.right + 6, y = r.bottom - pop.offsetHeight
	pop.style.left = `${x - p.left}px`
	pop.style.top = `${y - p.top}px`
	voicePop = pop
	;(pop.firstElementChild as HTMLElement).focus()
}
addEventListener("pointerdown", (e) => {
	if (voicePop && !(e.target as Element).closest(".voicepop, .speakicon")) {
		voicePop.remove()
		voicePop = undefined
	}
})
addEventListener("keydown", (e) => e.key === "Escape" && (voicePop?.remove(), voicePop = undefined))

// ---- wires ----
// by key: "<source's spot> <reader's spot> <input> <outlet>" (its port: "out", the first)
const wires = new Map<string, Wire & { text?: string }>()
const wireKey = (from: string, to: string, input: string, out = "out") =>
	`${from} ${to} ${input} ${out}`
// the port an outlet is drawn at, and back
const portOf = (from?: string) => from ?? "out"
const fromOf = (port: string) => port === "out" ? undefined : port
// a wire made or taken off, until the reader started again says so: made, drawn from the drop,
// dashed (pending); taken off, not drawn meanwhile. the reader's box held while it starts again.
// a refusal: as it was, with words. no answer in WAIT: let go
const pending = new Map<
	string,
	{ from: string; to: string; input: string; out: string; since: number }
>()
const dropped = new Map<string, number>()
const holding = new Map<string, number>()
const WAIT = 20000

// another den not paired with this one: its ins and outs locked, greyed, a padlock over each dot
// (inside it, so the board's face() keeps it and a wire still ends there), its note shown while
// the pointer is on it. a wire can't start or end on one
const LOCKED = "not trusted! pair first"
const locked = (v: View) => !v.mine && !host.paired(v.who)
const PADLOCK =
	`<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M3.2,6.2 V4.4 a2.8,2.8 0 0 1 5.6,0 V6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="1.2" y="6" width="9.6" height="7" rx="1.6" fill="currentColor"/><circle cx="6" cy="9.4" r="1.1" fill="#fff"/></svg>`
function lock(b: Box, on: boolean) {
	b.el.classList.toggle("locked", on)
	for (const p of b.el.querySelectorAll<HTMLElement>(".port")) {
		p.classList.toggle("locked", on)
		const there = p.querySelector(".lock")
		if (on && !there) {
			const l = h("span", "lock")
			l.innerHTML = PADLOCK
			l.append(h("span", "lock-note", LOCKED))
			p.querySelector(".dot")!.append(l)
		} else if (!on && there) there.remove()
	}
}
// a wire tried on a locked port (or from one): said, and its padlock shaken
function refuseLocked(v: View, port?: HTMLElement) {
	sound.no()
	say(`${LOCKED}: press pair on ${label(v)}, and its ins and outs open once it says yes.`, "hot")
	const n = port?.querySelector<HTMLElement>(".lock")
	if (!n) return
	n.classList.remove("shake")
	void n.offsetWidth
	n.classList.add("shake")
}
// a drag from a locked port never starts (before the board's own pointerdown on its dot)
board.world.addEventListener("pointerdown", (e) => {
	const p = (e.target as HTMLElement).closest<HTMLElement>(".port.locked")
	if (!p) return
	e.stopPropagation()
	e.preventDefault()
	const who = shown.get(p.closest<HTMLElement>(".box")?.dataset.id ?? "")?.who
	const v = views().find((x) => x.who === who)
	if (v) refuseLocked(v, p)
}, { capture: true })

// a thing by its node's id, or by its spot (its box's id)
function find(id: string): { v: View; t: Thing } | undefined {
	for (const v of views()) {
		const t = v.things.find((t) => t.id === id || spotOf(v, t) === id)
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
		: (t.kind === "sound" || t.kind === "speaker") && isMap(t.state) && isVoice(t.state.sound)
		? { sound: t.state.sound }
		: {}
	return unparse(sources, settings)
}

const inWords = (v: View, t: Thing, input: string) =>
	t.kind !== "pigs"
		? whose(v, t)
		: input === "say"
		? (v.mine ? "what your pigs say" : `what the pigs on ${label(v)} say`)
		: (v.mine ? `your pig ${input}` : `${input}, a pig on ${label(v)}`)

// a wire: the reader started again, reading the source's outlet out (its port) by its path
function connect(
	source: string,
	reader: string,
	input: string,
	port?: HTMLElement,
	out = "out",
): boolean {
	const s = find(source), r = find(reader)
	if (!s || !r) return false
	if (!(INPUTS[r.t.kind] ?? []).includes(input)) return false
	if (locked(s.v) || locked(r.v)) {
		refuseLocked(locked(s.v) ? s.v : r.v, port)
		return false
	}
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
	const from = spotOf(s.v, s.t), to = spotOf(r.v, r.t), k = wireKey(from, to, input, out)
	pending.set(k, { from, to, input, out, since: Date.now() })
	holding.set(to, Date.now())
	render()
	restart(
		r.v,
		r.t,
		argsWith(r.t, input, {
			input,
			den: s.v.who,
			at: `/${s.t.at.join("/")}`,
			...(fromOf(out) ? { from: fromOf(out) } : {}),
		}),
		`You wired ${whose(s.v, s.t)}${out === "out" ? "" : `'s ${out}`} (/${s.t.at.join("/")}) to ${
			inWords(r.v, r.t, input)
		}.`,
		(ok) => {
			holding.delete(to)
			if (!ok) pending.delete(k)
			render()
		},
	)
	return true
}
board.onConnect((from: Port, to: Port) =>
	connect(from.box.id, to.box.id, to.name, to.el, from.name)
)

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
	const input = p.dataset.port ?? ""
	if (!reader || !p.classList.contains("port-in") || !connect(id, reader, input, p)) {
		sound.no()
		say("Only an in can read: drop it on a dot marked in, or on a pig.", "hot")
	}
})

board.onDisconnect((w: Wire) => {
	const r = find(w.to.box.id)
	for (const [k, x] of wires) {
		if (x !== w) continue
		wires.delete(k)
		pending.delete(k)
		dropped.set(k, Date.now())
	}
	if (!r) return
	const to = spotOf(r.v, r.t)
	holding.set(to, Date.now())
	restart(r.v, r.t, argsWith(r.t, w.to.name), `You unwired ${whose(r.v, r.t)}.`, (ok) => {
		holding.delete(to)
		if (!ok) {
			for (const k of [...dropped.keys()]) if (k.split(" ")[1] === to) dropped.delete(k)
		}
		render()
	})
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
		const s = id === undefined ? undefined : [...shown.values()].find((x) => x.me.id === id)
		pick(s?.box)
		if (s) board.show(s.box)
	},
	isThing: (id) => [...shown.values()].some((x) => x.me.id === id),
	// a thing taken out in the files: as its box's ×
	remove: (id) => {
		const f = find(id)
		if (f) remove(f.v, f.t)
	},
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
// a flash at most once in CALM for each box and wire: a timer's every tick flashing kept the page
// painting all the time
const CALM = 4000
const flashed = new WeakMap<object, number>()
function calmly(o: object, f: () => void) {
	const now = Date.now(), was = flashed.get(o)
	if (was !== undefined && now - was < CALM) return
	flashed.set(o, now)
	f()
}
const pairedWas = new Map<string, boolean>()
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
		const keys = new Set(slotted(v).map((t) => `${groupOf(f, t)} ${t.at.join("/")}`))
		for (const t of slotted(v)) slotOf(f, t, keys)
		const rows = (g: Group) =>
			Math.max(
				1,
				Math.ceil(
					Math.max(
						0,
						...slotted(v).filter((t) => groupOf(f, t) === g).map((t) =>
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
		f.el.classList.toggle("empty", slotted(v).length === 0)
		$(".live", f.el).title = v.alive ? "here now" : "gone quiet"
		$<HTMLButtonElement>(".add", f.el).disabled = !v.alive
		// another den: paired or not (a pair button until it is, then unpair), and asked
		if (!v.mine) {
			const b = $<HTMLButtonElement>(".pair", f.el)
			const yes = host.paired(v.who), asked = host.pairing(v.who)
			b.hidden = false
			b.classList.toggle("on", yes)
			b.classList.toggle("asked", asked && !yes)
			b.textContent = yes ? "unpair" : asked ? "asked…" : "pair"
			b.title = yes
				? `you and ${
					label(v)
				} are paired: each can reach the other's ins and outs. unpair locks them again`
				: asked
				? `waiting for ${label(v)} to say yes or no`
				: `ask ${label(v)} to pair: until it says yes, its ins and outs are locked`
			$(".denpath", f.el).textContent = `${yes ? "paired · " : ""}/system/dens/${v.who}`
			f.el.classList.toggle("locked", !yes)
		}
		for (const t of v.things) {
			const spot = spotOf(v, t)
			live.add(spot)
			const g = groupOf(f, t)
			const slot = f.slots.get(`${g} ${t.at.join("/")}`)
			// the speaker: stuck on in the card's bottom-left corner, its dot on the card's left edge
			// (that corner kept clear: CORNER); the rest in their slots
			let s = shown.get(spot)
			const px = slot === undefined ? f.x - 6 : f.x + 20 + (slot % COLS) * SLOT.w
			const py = slot === undefined
				? f.y + f.h - CORNER + 6
				: f.y + f.origin[g] + Math.floor(slot / COLS) * SLOT.h
			if (s) {
				const p = s.box.pos()
				if (p.x === s.placed.x && p.y === s.placed.y && (p.x !== px || p.y !== py)) {
					s.box.move(px, py)
					s.placed = { x: px, y: py }
				}
			}
			if (!s) {
				s = makeShown(v, t, px, py, () => ({
					x0: t.kind === "speaker" ? f.x - 40 : f.x + 14,
					y0: f.y + 58,
					x1: f.x + f.w - 14,
					// above the keyboard and the speaker's corner: nothing is dragged under them
					y1: f.y + f.h - (f.keyboard ? 168 : CORNER),
				}))
				shown.set(spot, s)
			}
			s.me.id = t.id
			const out = JSON.stringify(t.out ?? null)
			if (out !== s.out) {
				if (s.out !== "" && t.kind !== "speaker") calmly(s.box, () => s!.box.flash("hot"))
				s.out = out
			}
			s.update(t, v)
			const here = places.peep(() => get(places, t.at)) === t.id
			const pathEl = $(".box-path", s.box.el)
			pathEl.textContent = `/${t.at.join("/")}${here ? "" : " (not in this tree)"}`
			s.box.code(thingCode(v, t))
			s.box.tone(!v.alive ? "dim" : s.box === picked ? "pick" : undefined)
			lock(s.box, locked(v))
		}
	}
	// a reader starting again keeps its box meanwhile (a stop answered before its start)
	const now = Date.now()
	for (const [spot, since] of holding) if (now - since > WAIT) holding.delete(spot)
	for (const [spot, s] of shown) {
		if (live.has(spot) || holding.has(spot)) continue
		s.box.remove()
		shown.delete(spot)
	}
	// wires: each reader's sources, from the source's out to the reader's input; then those asked
	// for and not yet answered, dashed
	const want = new Set<string>()
	const partners = new Map<Port, number[]>()
	const draw = (
		k: string,
		a: Shown,
		b: Shown,
		input: string,
		out: string,
		text: string,
		wait: boolean,
	) => {
		want.add(k)
		let w = wires.get(k)
		if (!w) {
			w = board.wire(a.box.port(out), b.box.port(input))
			wires.set(k, w)
			w.text = text
			w.label(text)
		} else if (w.text !== text) {
			w.text = text
			w.label(text)
			calmly(w, () => w!.flash("hot"))
		}
		w.dashed(wait)
		// each end faces the other
		const from = a.box.port(out), inp = b.box.port(input)
		partners.set(from, [...(partners.get(from) ?? []), centre(b.box) - centre(a.box)])
		partners.set(inp, [centre(a.box) - centre(b.box)])
		return w
	}
	const there = new Set<string>()
	for (const v of vs) {
		for (const t of v.things) {
			const b = shown.get(spotOf(v, t))
			if (!b) continue
			for (const src of t.sources) {
				const s = sourceOf(src)
				const a = s && shown.get(spotOf(s.v, s.t))
				if (!s || !a || !(INPUTS[t.kind] ?? []).includes(src.input)) continue
				// an outlet its source doesn't draw (one it doesn't give): no wire to show
				if (!a.box.el.querySelector(`.port-out[data-port="${CSS.escape(portOf(src.from))}"]`)) {
					continue
				}
				const k = wireKey(spotOf(s.v, s.t), spotOf(v, t), src.input, portOf(src.from))
				there.add(k)
				// taken off, not yet answered: not drawn again
				if (dropped.has(k)) continue
				pending.delete(k)
				const w = draw(
					k,
					a,
					b,
					src.input,
					portOf(src.from),
					fmt(s.t.attrs[outlet(src.from)]),
					false,
				)
				w.tone(s.v.alive && v.alive && !locked(s.v) && !locked(v) ? undefined : "dim")
				w.hint(
					`reads ${src.at}${src.from ? `, its ${src.from}` : ""}${
						s.v.who !== v.who
							? ` (${label(s.v)}'s: its steps come through tippet, and it is placed in ${
								v.mine ? "this" : `${label(v)}'s`
							} tree)`
							: ""
					}`,
				)
			}
		}
	}
	for (const [k, since] of dropped) if (!there.has(k) || now - since > WAIT) dropped.delete(k)
	for (const [k, p] of pending) {
		const a = shown.get(p.from), b = shown.get(p.to)
		if (!a || !b || now - p.since > WAIT) {
			pending.delete(k)
			if (a && b) say("No answer to that wire yet, so it's gone: try it again.", "hot")
			continue
		}
		const w = draw(
			k,
			a,
			b,
			p.input,
			p.out,
			find(p.from) ? fmt(find(p.from)!.t.attrs[outlet(fromOf(p.out))]) : "",
			true,
		)
		w.tone(undefined)
		w.hint("asked for: waiting for the answer")
	}
	// a reader starting again keeps the other wires into it meanwhile
	for (const [k, w] of wires) {
		if (want.has(k)) continue
		const [, to, input] = k.split(" ")
		const replaced = [...pending.values()].some((p) => p.to === to && p.input === input)
		if (holding.has(to) && !replaced && !dropped.has(k)) {
			want.add(k)
			continue
		}
		w.remove()
		wires.delete(k)
	}
	for (const s of shown.values()) {
		// a speaker's dot stays on the card's edge
		if (s.kind === "speaker") continue
		for (const p of [...s.box.el.querySelectorAll<HTMLElement>(".port")]) {
			const port = s.box.port(p.dataset.port!)
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
	const here = new Set(vs.filter((v) => v.alive && !v.mine).map((v) => v.who))
	for (const who of here) {
		if (seen.has(who)) continue
		const v = vs.find((x) => x.who === who)!
		if (!first) {
			sound.chime()
			say(`${label(v)} is here.`, "ok")
		}
	}
	for (const who of seen) {
		if (here.has(who)) continue
		const v = vs.find((x) => x.who === who)
		if (v) say(`${label(v)} went quiet.`)
	}
	seen = here
	// paired, or not any more: the padlocks open with a happy sound, or come back
	for (const v of vs) {
		if (v.mine) continue
		const yes = host.paired(v.who), was = pairedWas.get(v.who)
		pairedWas.set(v.who, yes)
		if (was === undefined || was === yes) continue
		if (yes) {
			sound.yay()
			say(`You and ${label(v)} are paired: wire your things to each other's.`, "ok")
		} else say(`You and ${label(v)} aren't paired now: its ins and outs are locked.`)
	}
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
		: "Add things with + add. Drag from an out dot to an in dot to wire them; another den's, once you pair.",
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
