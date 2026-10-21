/// <reference lib="dom" />
// many edits, one: painting the pond's sign. each keystroke on the sign (and each duck added,
// taken out or moved) is a real patch, a slip, dropped on the "as typed" pile. the real squish
// takes the pile and gives fewer, bigger slips; the real apply checks both piles end the same.
// the time slider goes back through the keystrokes, and the pond goes back with it
import apply, { type Patch } from "@ermine/op/apply"
import createSquish, { encode, type Squish } from "@ermine/op/squish"
import { pondPage } from "../kit/page.ts"
import type { Port, Wire } from "../kit/board.ts"
import { createPond, icon } from "../kit/sprites.ts"

const page = pondPage("squish", {
	say:
		`<p>Every keystroke on the sign drops a <b>slip</b>: a patch saying where, and what to put there. <b>Squish</b> takes the slips in and gives fewer, bigger ones out.</p>
		<p>Both piles paint the same sign. Squish never looks at the sign itself: only where each slip lands, and how long it is.</p>`,
	tries: [
		{ id: "word", text: "Type a word at the end of the sign. Many slips, one squished." },
		{ id: "back", text: "Backspace a letter you just typed. The squished slip gets shorter." },
		{ id: "move", text: "Add a duck, then move one. A move never joins." },
		{ id: "kill", text: "Press <b>wipe</b>. See which slips it kills, and where it stops." },
		{ id: "slide", text: "Drag <b>time</b> back. The pond goes back; the tick stays green." },
	],
	rules:
		`<p><b>Only the last:</b> a new slip can join only the last squished slip, at the same place (<code>sign</code> or <code>ducks</code>).</p>
		<p><b>Typing:</b> it joins if it lands inside what the last slip put, or runs on from its end. So typing makes one put; backspace shortens it.</p>
		<p><b>Removing:</b> a remove joins a remove that touches it. Remove, then type at that spot: one slip that puts over.</p>
		<p><b>Reaching back:</b> after a join, the joined slip tries the one before it, and so on back.</p>
		<p><b>Over all:</b> a slip with no range (<b>wipe</b>, <b>shoo all</b>) kills slips before it at or under its place. It starts at the newest and stops at the first it can't kill.</p>
		<p><b>Moves:</b> a move never joins, and nothing joins across it. Only a put over the whole pond, at the very top, would kill it.</p>
		<p><b>Ranges:</b> <code>2–5</code> means from place 2 up to place 5. <code>4–4</code> is a gap: nothing is covered.</p>
		<p><b>Columns:</b> turn the squish box over to see the squished slips stored sideways, one list per field, repeats written once.</p>`,
	real:
		`Runs the real <code>@ermine/op/squish</code> (createSquish, encode) and <code>@ermine/op/apply</code>. The page writes each slip itself, by comparing the sign before and after your keystroke. Squish doesn't say which slips went into which: the page works it out by watching what squish gives back after each push.`,
})
const { board } = page

// ---- the world: a sign and a row of ducks ---------------------------------------------------
type Pond = { sign: string; ducks: string[] }
const START: Pond = { sign: "hello", ducks: ["ada", "bo", "cy"] }
const NAMES = ["ada", "bo", "cy", "dot", "eve", "fay", "gus", "hal", "ivy", "jo", "kit", "lu"]

// what squish gave back after each push, and which typed slips each squished slip came from:
// an answer's slips that did not change are the same objects, so what changed is what joined
type Ev = { i: number; kind: "new" | "joined" | "killed"; n: number }
type Snap = { out: Patch[]; src: number[][]; killed: Map<number, number>; ev: Ev | null }

let typed: Patch[] = []
let snaps: Snap[] = [{ out: [], src: [], killed: new Map(), ev: null }]
let docs: Pond[] = [START]
let live: Squish = createSquish()
let t = 0

const esc = (s: string) =>
	s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const show = (v: unknown) => JSON.stringify(v)
const short = (s: string, n = 14) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

// a slip in words
function words(p: Patch): string {
	const r = p.range
	const span = r ? (r[0] === r[1] ? `at ${r[0]}` : `over ${r[0]}–${r[1]}`) : "over all"
	if (p.move) return `move duck ${p.move.path[1]} to ${r ? r[0] : "?"}`
	if (!("value" in p)) return `remove ${r ? `${r[0]}–${r[1]}` : "all"}`
	const v = p.value
	if (Array.isArray(v)) {
		if (!r) return `put ${show(v)} ${span}`
		return `${r[0] === r[1] ? "add" : "put"} ${v.length ? v.join(", ") : "nobody"} ${span}`
	}
	return `put ${show(v)} ${span}`
}
const kind = (p: Patch) =>
	`${p.move ? "mv" : "value" in p ? "" : "rm"} ${p.range ? "" : "whole"}`.trim()

// ---- pushing ----------------------------------------------------------------------------------
// a keystroke back in time: what came after is dropped, and squish is filled again up to there
function cut() {
	if (t === typed.length) return
	typed = typed.slice(0, t)
	snaps = snaps.slice(0, t + 1)
	docs = docs.slice(0, t + 1)
	live = createSquish()
	for (const p of typed) live.push(p)
	shown = new Set(live.patches())
}

function push(p: Patch) {
	let doc: Pond
	try {
		doc = apply(docs[t], [p]) as Pond
	} catch {
		return
	}
	cut()
	const was = snaps[t]
	const before = live.patches()
	live.push(p)
	const after = live.patches()
	let k = 0
	while (k < before.length && k < after.length && before[k] === after[k]) k++
	const i = typed.length
	typed.push(p)
	const src = was.src.slice(0, k)
	const killed = new Map(was.killed)
	const gone = was.src.slice(k).flat()
	let ev: Ev
	if (after.length - k === 1 && after[k] === p) {
		src.push([i])
		for (const s of gone) killed.set(s, i)
		ev = { i, kind: before.length > k ? "killed" : "new", n: before.length - k }
	} else {
		const all = [...gone, i].sort((a, b) => a - b)
		for (let j = k; j < after.length; j++) src.push(all)
		ev = { i, kind: "joined", n: before.length - k }
	}
	snaps.push({ out: after, src, killed, ev })
	docs.push(doc)
	t = typed.length
	draw(true)
	tell(p, ev, gone.length)
	tick(p, ev, src[src.length - 1])
}

// the sign's change as one patch: positions are code points, as apply counts. the caret says where
// the change ends, so typing "l" in "hel|lo" is put at 3
function signPatch(old: string, now: string, caretUnits: number): Patch | null {
	const o = Array.from(old), n = Array.from(now)
	const caret = Array.from(now.slice(0, caretUnits)).length
	let s = Math.max(0, Math.min(n.length - caret, o.length))
	const tailSame = (s: number) => {
		for (let j = 1; j <= s; j++) if (o[o.length - j] !== n[n.length - j]) return false
		return true
	}
	while (s > 0 && !tailSame(s)) s--
	let p = 0
	const most = Math.min(o.length - s, n.length - s)
	while (p < most && o[p] === n[p]) p++
	const put = n.slice(p, n.length - s).join("")
	const range: [number, number] = [p, o.length - s]
	if (range[0] === range[1] && put === "") return null
	return put === "" ? { path: ["sign"], range } : { path: ["sign"], range, value: put }
}

// ---- the boxes ----------------------------------------------------------------------------------
const sign = board.box({ id: "sign", x: 0, y: 0, title: "the sign", kind: "key", width: 210 })
sign.addPort("out", "out", "")
sign.body.innerHTML =
	`<input class="signin" spellcheck="false" autocomplete="off" aria-label="the sign's words">
	<div class="row"><span class="small grow">each keystroke: one slip</span><button class="chip" id="wipe" title="one slip with no range: put &quot;&quot; over all of the sign">wipe</button></div>`
const signIn = sign.body.querySelector("input")!

const ducks = board.box({ id: "ducks", x: 0, y: 150, title: "the ducks", kind: "key", width: 210 })
ducks.addPort("out", "out", "")
ducks.body.innerHTML = `<ul class="ducks"></ul>
	<div class="row"><button class="chip" id="addduck">+ duck</button><span class="grow"></span><button class="chip" id="shoo" title="one slip with no range: put [] over all the ducks">shoo all</button></div>`

const time = board.box({ id: "time", x: 0, y: 400, title: "time", kind: "key", width: 210 })
time.addPort("out", "out", "")
time.body.innerHTML =
	`<div class="time"><input class="slider" type="range" min="0" max="0" value="0" aria-label="how many keystrokes in">
	<div class="mid" id="when"></div><div class="small" id="ahead"></div></div>`
const scrub = time.body.querySelector("input")!

const pile = board.box({
	id: "typed",
	x: 290,
	y: 0,
	title: "as typed",
	kind: "compute",
	width: 230,
})
pile.addPort("sign", "in", "")
pile.addPort("ducks", "in", "")
pile.addPort("time", "in", "")
pile.addPort("out", "out", "")
pile.body.innerHTML = `<div class="pile" id="typedpile"></div>`

const press = board.box({
	id: "squish",
	x: 580,
	y: 250,
	title: "squish",
	kind: "compute",
	width: 160,
})
press.addPort("in", "in", "")
press.addPort("out", "out", "")
press.body.innerHTML =
	`<div class="press"><div class="count" id="count">0 → 0</div><div class="small">in → out</div><div class="what" id="what"></div></div>`

const out = board.box({
	id: "squished",
	x: 800,
	y: 230,
	title: "squished",
	kind: "compute",
	width: 210,
})
out.addPort("in", "in", "")
out.body.innerHTML = `<div class="pile big" id="outpile"></div>`

const same = board.box({
	id: "same",
	x: 800,
	y: 0,
	title: "same end?",
	kind: "compute",
	width: 150,
})
same.addPort("typed", "in", "as typed")
same.addPort("squished", "in", "squished")
same.body.innerHTML = `<div class="same" id="samebody"></div>`

const pic = board.box({ id: "pond", x: 290, y: 460, title: "the pond", kind: "effect" })
pic.addPort("time", "in", "")
const canvas = document.createElement("canvas")
const scene = document.createElement("div")
scene.className = "scene"
const board_ = document.createElement("div")
board_.className = "painted"
scene.append(canvas, board_)
pic.body.append(scene)
const pond = createPond(canvas, { width: 240, height: 140 })
canvas.classList.add("small")
pic.code(`// the pond at this time: every slip up to here
pond.draw({
  sign: doc.sign,   // drawn big, on the bank
  named: doc.ducks.map((name, i) => ({ name, kind: "duck", … })),
})`)

// the wires; a wire picked up off its port and dropped is put back
const wires = new Map<string, Wire>()
function wire(key: string, from: Port, to: Port) {
	const w = board.wire(from, to)
	wires.set(key, w)
	return w
}
wire("sign", sign.port("out"), pile.port("sign"))
wire("ducks", ducks.port("out"), pile.port("ducks"))
wire("time", time.port("out"), pile.port("time"))
wire("in", pile.port("out"), press.port("in"))
wire("out", press.port("out"), out.port("in"))
wire("typed", pile.port("out"), same.port("typed"))
wire("squished", press.port("out"), same.port("squished"))
wire("pond", time.port("out"), pic.port("time"))
board.onDisconnect((w) => {
	for (const [k, v] of wires) if (v === w) wire(k, w.from, w.to)
	labels()
})

// ---- the reader's hands -------------------------------------------------------------------------
signIn.addEventListener("input", () => {
	const p = signPatch(docs[t].sign, signIn.value, signIn.selectionEnd ?? signIn.value.length)
	if (p) push(p)
})
sign.body.querySelector<HTMLElement>("#wipe")!.onclick = () => push({ path: ["sign"], value: "" })
ducks.body.querySelector<HTMLElement>("#shoo")!.onclick = () => push({ path: ["ducks"], value: [] })
ducks.body.querySelector<HTMLElement>("#addduck")!.onclick = () => {
	const have = docs[t].ducks
	const name = NAMES.find((n) => !have.includes(n)) ?? `duck${have.length}`
	push({ path: ["ducks"], range: [have.length, have.length], value: [name] })
}
ducks.body.querySelector("ul")!.addEventListener("click", (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-do]")
	if (!b) return
	const i = +b.dataset.i!, what = b.dataset.do!
	// a move: the duck at i is taken out, then lands in the gap given, in what is left
	if (what === "up") push({ path: ["ducks"], range: [i - 1, i - 1], move: { path: ["ducks", i] } })
	if (what === "down") {
		push({ path: ["ducks"], range: [i + 1, i + 1], move: { path: ["ducks", i] } })
	}
	if (what === "x") push({ path: ["ducks"], range: [i, i + 1] })
	const j = what === "up" ? i - 1 : what === "down" ? i + 1 : i
	ducks.body.querySelector<HTMLElement>(`button[data-do="${what}"][data-i="${j}"]`)?.focus()
})
scrub.addEventListener("input", () => {
	t = +scrub.value
	draw(false)
	if (t < typed.length) {
		page.tick("slide")
		page.say(
			`Back at keystroke ${t} of ${typed.length}: the pond shows the sign as it was then, and both piles still end the same.`,
			"ok",
		)
	} else page.say(`Now: all ${typed.length} slips.`)
})

// hovering a squished slip lights the typed slips it came from; a typed slip, where it went
function pick(e: Event, on: boolean) {
	for (const s of board.el.querySelectorAll(".slip.pick")) s.classList.remove("pick")
	if (!on) return
	const el = (e.target as HTMLElement).closest<HTMLElement>(".slip")
	if (!el) return
	const snap = snaps[t]
	if (el.dataset.j !== undefined) {
		el.classList.add("pick")
		for (const i of snap.src[+el.dataset.j] ?? []) {
			board.el.querySelector(`#typedpile .slip[data-i="${i}"]`)?.classList.add("pick")
		}
	} else if (el.dataset.i !== undefined && +el.dataset.i < t) {
		el.classList.add("pick")
		const j = snap.src.findIndex((s) => s.includes(+el.dataset.i!))
		if (j >= 0) board.el.querySelector(`#outpile .slip[data-j="${j}"]`)?.classList.add("pick")
	}
}
for (const b of [pile, out]) {
	b.body.addEventListener("mouseover", (e) => pick(e, true))
	b.body.addEventListener("mouseleave", (e) => pick(e, false))
	b.body.addEventListener("focusin", (e) => pick(e, true))
	b.body.addEventListener("focusout", (e) => pick(e, false))
}

// ---- drawing ------------------------------------------------------------------------------------
let shown = new Set<Patch>()

function labels() {
	const snap = snaps[t]
	const last = t ? typed[t - 1] : undefined
	wires.get("sign")!.label(last && last.path[0] === "sign" ? short(words(last), 11) : "")
	wires.get("ducks")!.label(last && last.path[0] === "ducks" ? short(words(last), 11) : "")
	wires.get("time")!.label(`${t}`)
	wires.get("pond")!.label(`at ${t}`)
	wires.get("in")!.label(`${t} slip${t === 1 ? "" : "s"}`)
	wires.get("out")!.label(`${snap.out.length} slip${snap.out.length === 1 ? "" : "s"}`)
	const a = apply(START, typed.slice(0, t)) as Pond, b = apply(START, snap.out) as Pond
	wires.get("typed")!.label(`"${short(a.sign, 12)}"`)
	wires.get("squished")!.label(`"${short(b.sign, 12)}"`)
}

function slip(p: Patch, attrs: string, cls: string, fate: string) {
	return `<div class="slip ${kind(p)} ${cls}" ${attrs} tabindex="0" title="${
		esc(show(p))
	}">${fate}<span class="on">${esc(String(p.path[0]))}</span>${esc(words(p))}</div>`
}

function draw(pushed: boolean) {
	const snap = snaps[t], doc = docs[t]

	// the sign and the ducks, as they are at t
	if (signIn.value !== doc.sign) signIn.value = doc.sign
	const ul = ducks.body.querySelector("ul")!
	ul.innerHTML = doc.ducks.length
		? doc.ducks.map((n, i) =>
			`<li><span class="duckicon"></span><span class="name">${i} ${esc(n)}</span>
			<button class="tiny" data-do="up" data-i="${i}" ${i === 0 ? "disabled" : ""} title="move ${
				esc(n)
			} up" aria-label="move ${
				esc(n)
			} up">↑</button><button class="tiny" data-do="down" data-i="${i}" ${
				i === doc.ducks.length - 1 ? "disabled" : ""
			} title="move ${esc(n)} down" aria-label="move ${
				esc(n)
			} down">↓</button><button class="tiny" data-do="x" data-i="${i}" title="take ${
				esc(n)
			} out" aria-label="take ${esc(n)} out">×</button></li>`
		).join("")
		: `<li class="none">no ducks</li>`
	for (const s of ul.querySelectorAll(".duckicon")) s.replaceWith(icon("duck", 2))

	// time
	scrub.max = String(typed.length)
	scrub.value = String(t)
	time.body.querySelector("#when")!.textContent = `${t} of ${typed.length}`
	time.body.querySelector("#ahead")!.textContent = t < typed.length
		? `${typed.length - t} later slips greyed. a keystroke now drops them.`
		: "keystrokes so far"
	time.badge(t < typed.length ? "back in time" : "", "pick")

	// the typed pile: newest on top
	const tp = pile.body.querySelector("#typedpile")!
	tp.innerHTML = typed.length
		? typed.map((p, i) => {
			if (i >= t) return slip(p, `data-i="${i}"`, "later", "")
			const k = snap.killed.get(i)
			if (k !== undefined) {
				return slip(p, `data-i="${i}"`, "dead", `<span class="fate">killed</span>`)
			}
			const j = snap.src.findIndex((s) => s.includes(i))
			return slip(p, `data-i="${i}"`, "", `<span class="fate">→ ${j}</span>`)
		}).reverse().join("")
		: `<div class="empty">type on the sign:<br>each keystroke lands here</div>`
	pile.badge(String(t), t ? undefined : "dim")

	// squish
	const counted = press.body.querySelector("#count")!
	counted.innerHTML = `${t} → <b>${snap.out.length}</b>`
	const ev = snap.ev
	press.body.querySelector("#what")!.textContent = !ev || t === 0
		? "waiting for slips"
		: ev.kind === "new"
		? "the last slip stood alone"
		: ev.kind === "killed"
		? `the last slip killed ${ev.n}`
		: ev.n > 1
		? `joined, and reached back: ${ev.n + 1} became 1`
		: "the last slip joined in"
	press.code(`const s = createSquish()
for (const slip of typed) s.push(slip)
const squished = s.patches()

// squished, stored as columns: encode(squished)
// one list per field. [3, 5] means 3, five times in a row
${columns(snap.out)}`)

	// the squished pile, in order
	const op = out.body.querySelector("#outpile")!
	op.innerHTML = snap.out.length
		? snap.out.map((p, j) =>
			slip(p, `data-j="${j}"`, "", `<span class="fate">${snap.src[j].length} typed</span>`)
		).join("")
		: `<div class="empty">squish's slips land here</div>`
	out.badge(String(snap.out.length), snap.out.length ? "ok" : "dim")
	out.code(JSON.stringify(snap.out, null, 1).replace(/\n\s*/g, " ").replace(/ \{/g, "\n{"))
	pile.code(
		JSON.stringify(typed.slice(0, t), null, 1).replace(/\n\s*/g, " ").replace(/ \{/g, "\n{"),
	)

	// same end? the real apply, both ways, every time
	const a = apply(START, typed.slice(0, t)), b = apply(START, snap.out)
	const ok = show(a) === show(b)
	const sb = same.body.querySelector("#samebody")!
	sb.className = `same ${ok ? "" : "no"}`
	sb.innerHTML = `<div class="mark">${ok ? "✓" : "✗"}</div><div class="small">${
		ok ? "same sign, same ducks" : "not the same"
	}</div>`
	same.tone(ok ? "ok" : "hot")
	same.code(`apply(start, asTyped)
// ${show(a)}

apply(start, squished)
// ${show(b)}`)

	// the pond
	const n = doc.ducks.length
	board_.textContent = doc.sign
	board_.classList.toggle("blank", doc.sign === "")
	pond.draw({
		lilies: 3,
		fish: 2,
		named: doc.ducks.map((name, i) => ({
			name,
			kind: "duck" as const,
			x: n === 1 ? 0.5 : 0.08 + (i / Math.max(1, n - 1)) * 0.84,
			y: 0.3 + (i % 2) * 0.18,
		})),
	})

	labels()

	// what changed lights up: the new typed slip, the squished slips not shown before
	const top = tp.querySelector<HTMLElement>(`.slip[data-i="${t - 1}"]`)
	if (pushed && top) {
		top.classList.add("flash")
		top.scrollIntoView({ block: "nearest" })
	}
	snap.out.forEach((p, j) => {
		if (!shown.has(p)) {
			const el = op.querySelector<HTMLElement>(`.slip[data-j="${j}"]`)
			el?.classList.add("flash")
			el?.scrollIntoView({ block: "nearest" })
		}
	})
	if (pushed) {
		const w = typed[t - 1].path[0] === "sign" ? "sign" : "ducks"
		wires.get(w)!.flash("hot")
		pile.flash("hot")
		press.flash(ev?.kind === "joined" ? "ok" : "hot")
		wires.get("out")!.flash(ev?.kind === "joined" ? "ok" : "hot")
	}
	shown = new Set(snap.out)
}

function columns(ps: Patch[]): string {
	const c = encode(ps)
	return [
		`paths: ${show(c.paths)}`,
		`path:  ${show(c.path)}   // which of paths`,
		`shape: ${show(c.shape)}   // 1 range + 2 value + 4 move`,
		`from:  ${show(c.from)}   // each start, minus the last start`,
		`size:  ${show(c.size)}   // range length`,
		`value: ${show(c.value)}`,
		`move:  ${show(c.move)}`,
	].join("\n")
}

// ---- what just happened, in one sentence --------------------------------------------------------
function tell(p: Patch, ev: Ev, typedKilled: number) {
	const s = `<code>${esc(words(p))}</code>`
	const now = snaps[t].out.length
	if (ev.kind === "joined") {
		page.say(
			ev.n > 1
				? `${s} joined the last slip, and that joined the one before: ${
					ev.n + 1
				} slips became 1.`
				: `${s} joined the last slip: still ${now} squished.`,
			"ok",
		)
	} else if (ev.kind === "killed") {
		page.say(
			`${s} covers all of <code>${p.path[0]}</code>: it killed ${typedKilled} typed slip${
				typedKilled === 1 ? "" : "s"
			}${now > 1 ? ", then stopped at one it can't kill" : ""}.`,
			"hot",
		)
	} else if (p.move) page.say(`${s}: a move never joins, so it stands alone.`)
	else page.say(`${s} couldn't join the last slip, so it stands alone.`)
}

function tick(p: Patch, ev: Ev, src: number[]) {
	const onSign = p.path[0] === "sign" && p.range
	if (onSign && "value" in p && ev.kind === "joined" && src.length >= 3) page.tick("word")
	const last = snaps[t].out.at(-1)!
	if (onSign && !("value" in p) && ev.kind === "joined" && "value" in last) page.tick("back")
	if (p.move) page.tick("move")
	if (ev.kind === "killed") page.tick("kill")
}

// a box turned over grows to fit its code, and shrinks back when turned again
for (const b of [pile, press, out, same, pic]) {
	const w = b.el.style.width
	b.el.querySelector(".box-flip")!.addEventListener("click", () => {
		b.el.style.width = b.el.classList.contains("flipped") ? "auto" : w
		b.el.style.zIndex = b.el.classList.contains("flipped") ? "4" : ""
	})
}

draw(false)
requestAnimationFrame(() => board.fit())
