/// <reference lib="dom" />
// who made whom: the real scheduler runs program.ts (on the pond box's back, as it is). a step is
// the scope tree as it stood when the scheduler told a listener something (a run going, a child
// claimed or made, a run's end) or a cleanup ran, read off the real Scope objects. the board plays
// the last thing you did step by step: each child a box under pond, each child a fish
import { type Computer, createScheduler, type Scheduler, type Scope } from "@ermine/scheduler"
import { pondPage } from "../kit/page.ts"
import type { Box, Tone, Wire } from "../kit/board.ts"
import { createPond } from "../kit/sprites.ts"
import { program } from "./program.ts"
// @ts-ignore: vite gives the file's text
import source from "./program.ts?raw"

const page = pondPage("scopes", {
	say: `<p>A <b>scope</b> owns what is made in it. <b>pond</b> is a computer, and a computer is a
		scope: each run makes one child per name, and each child is a fish.</p>
		<p>When pond runs again, it doesn't throw its old fish away. It <b>claims</b> the ones it
		makes again; the rest go once the run is done.</p>`,
	tries: [
		{ id: "add", text: "Add a fish. One is made; the others are claimed: still goldie." },
		{ id: "move", text: "Drag a name to a new place. Every fish is claimed, none made." },
		{ id: "drop", text: "Rename or remove a fish. It isn't claimed, so it goes." },
		{
			id: "hungry",
			text: "Make them hungry. Only the fish rerun; their old cleanups (bubbles) come after.",
		},
		{ id: "tear", text: "Click <b>pond</b>, then tear it down. The fish leave, newest first." },
	],
	rules: `<p><b>owner:</b> what is made while a scope is open goes under it.</p>
		<p><b>teardown:</b> takes what is under a scope first, newest first, then its own cleanups,
		newest first.</p>
		<p><b>old:</b> as a computer's run starts, what its earlier runs made is old. Old children
		are still alive: they can run, and be read.</p>
		<p><b>claim:</b> <code>s.claim(child)</code> in the run puts an old child back under its
		computer and makes it due. How the run finds it is the program's own: here, a map by
		name.</p>
		<p><b>run done:</b> what is still old goes then, newest first.</p>
		<p><b>cleanups:</b> one made in a run (<code>s.registerTeardown</code>) is set aside as the
		next run starts, and runs once the round's runs are all done, newest first.</p>
		<p><b>not done:</b> a run that fails, waits or stops keeps its old children and cleanups for
		the next run.</p>
		<p><b>info:</b> a plain scope's is the object given. A computer's is made once from what was
		given; as each run starts, <code>run</code> and <code>mark</code> are set in it.</p>
		<p><b>effects:</b> the same, and one more: what an act made goes before the next act. No
		effect here.</p>`,
	real: `Runs the real <code>@ermine/scheduler</code>: createRootScope, createComputer, claim,
		registerTeardown, teardown, track, mark, pulse, and its onTrack, onMark and onRunEnd
		listeners. Each step is read off the real Scope objects (state, old, runs, info, the
		newest/older/before links) as a listener is told or a cleanup runs. The store, the map of
		fish by name, the claim switch and the pond picture are the page's: turn <b>pond</b> over
		for all of program.ts.`,
})
const { board } = page

const esc = (x: unknown) =>
	String(x).replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
	)

// ---- steps: the tree as it stood ------------------------------------------------------------

type Snap = {
	n: number
	name: string
	state: Scope["state"]
	old: boolean
	runs: number
	mood?: string
	info: string
	kids: Snap[]
	// out from under its owner: going, or gone
	loose?: boolean
}
type How = "you" | "made" | "claimed" | "run" | "done" | "cleanup" | "goes" | "end"
type Step = {
	text: string
	tone?: "hot" | "ok"
	tree: Snap
	hit: Map<number, How>
	hungry: boolean
}

let s: Scheduler
let p: ReturnType<typeof program>
let seen = new Set<Scope>()
let wasOld = new Set<Scope>()
const place = new Map<Scope, number>()
let ponding: Computer | undefined
let tearing = ""
let went = 0
let steps: Step[] = []
let at = -1
let timer: ReturnType<typeof setInterval> | undefined
let picked: Scope | undefined

const nameOf = (o: Scope) => String(o.info.name ?? `#${o.n}`)
const isComputer = (o: Scope): o is Computer => "kind" in o
const show = (v: Record<string, unknown>) =>
	`{ ${Object.entries(v).map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join(", ")} }`

function snap(o: Scope): Snap {
	seen.add(o)
	const c = o as Computer
	const under: Scope[] = []
	for (let x = o.newest; x; x = x.older) under.unshift(x)
	const old: Scope[] = []
	if (isComputer(o)) { for (let x = c.before; x; x = x.older) old.unshift(x) }
	const linked = new Set([...under, ...old])
	;[...under, ...old].forEach((x, i) => place.set(x, i))
	const loose = [...seen].filter((x) => x.parent === o && !linked.has(x))
		.sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0))
	return {
		n: o.n,
		name: nameOf(o),
		state: o.state,
		old: o.old,
		runs: isComputer(o) ? c.runs : 0,
		mood: isComputer(o) && c.last ? String(c.last.value) : undefined,
		info: show(o.info),
		kids: [
			...under.map(snap),
			...old.map(snap),
			...loose.map((x) => ({ ...snap(x), loose: true })),
		],
	}
}

function step(text: string, hit: [Scope, How][] = [], tone?: "hot" | "ok") {
	const tree = snap(p.root)
	wasOld = new Set([...seen].filter((x) => x.old))
	steps.push({
		text,
		tone,
		tree,
		hit: new Map(hit.map(([o, h]) => [o.n, h])),
		hungry: p.store.get("hungry") === true,
	})
}

function start() {
	s = createScheduler()
	// a new scheduler counts its scopes from 1 again: nothing kept by number
	for (const k of kids.values()) k.box.remove(), k.owns.remove(), k.reads.remove()
	kids.clear()
	spots.clear()
	seen = new Set()
	wasOld = new Set()
	ponding = undefined
	picked = undefined
	// a cleanup: the scope open is the one whose cleanup it is (a teardown opens its scope)
	p = program(s, (name, run) => {
		const o = s.getCurrentScope()!
		if (o.state === "disposing") {
			went++
			step(
				tearing
					? `${name} goes, torn down${
						tearing === name ? "" : ` with ${tearing}`
					}. Its cleanup from run ${run} blows a last bubble: bye, ${name}.`
					: `pond didn't claim ${name}, so ${name} goes now. Its cleanup from run ${run} blows a last bubble: bye, ${name}.`,
				[[o, "goes"]],
				"hot",
			)
		} else {
			step(
				`${name}'s cleanup from run ${run} runs now, after all of the round's runs: a bubble.`,
				[[o, "cleanup"]],
			)
		}
	})
	s.onTrack((_key, run) => {
		const c = run.computer
		if (c.info.name !== "pond" || ponding === c) return
		ponding = c
		went = 0
		step(
			run.n === 1
				? "pond runs for the first time."
				: `pond runs again (run ${run.n}). Its fish from earlier runs are old for now, still swimming.`,
			[[c, "run"]],
		)
	})
	s.onMark((keys) => {
		if (keys.length) return
		const known = new Set(seen)
		const before = wasOld
		snap(p.root)
		for (const x of seen) {
			if (!known.has(x)) {
				step(
					x.info.name === "pond"
						? "pond is made under page, and due."
						: `pond makes a new child: ${nameOf(x)}.`,
					[[x, "made"]],
					"hot",
				)
			} else if (before.has(x) && !x.old && x.state === "alive") {
				step(
					`pond claims ${nameOf(x)}: still ${nameOf(x)}, kept, and due.`,
					[[x, "claimed"]],
					"ok",
				)
			}
		}
	})
	s.onRunEnd((c, n, ended) => {
		if (c === ponding) {
			ponding = undefined
			step(
				went
					? `pond's run ${n} is ${ended}. What it didn't claim has gone.`
					: `pond's run ${n} is ${ended}.`,
				[[c, "done"]],
			)
		} else {
			step(`${nameOf(c)} runs (run ${n}): ${c.last?.value}.`, [[c, "done"]])
		}
	})
	act("The pond fills.", () => {
		p.makePond()
		s.pulse()
	}, "Three fish, one child each, all made by pond's first run.")
	startQuiet()
}

// something you did: the board plays what the scheduler did, step by step
function act(what: string, f: () => void, end = "Nothing is due. Every fish is settled.") {
	finish()
	for (const x of [...seen]) if (x.state !== "alive") seen.delete(x)
	steps = []
	step(what)
	f()
	step(end)
	play()
}
// the first fill: shown done, not played
function startQuiet() {
	finish()
}

function play() {
	at = 0
	render()
	clearInterval(timer)
	timer = setInterval(() => {
		if (at >= steps.length - 1) return finish()
		at++
		render()
	}, 650)
	scrub()
}
function finish() {
	clearInterval(timer)
	timer = undefined
	if (at !== steps.length - 1 && steps.length) {
		at = steps.length - 1
		render()
	}
	scrub()
}
function goTo(i: number) {
	clearInterval(timer)
	timer = undefined
	at = Math.max(0, Math.min(steps.length - 1, i))
	render()
	scrub()
}
const live = () => at === steps.length - 1

// ---- the board -------------------------------------------------------------------------------

const COL = 880
const ROW = 112

// names: chips to add, rename, drag and remove
const namesBox = board.box({
	id: "names",
	x: 20,
	y: 20,
	title: "names",
	kind: "key",
	outs: [["out", ""]],
	width: 250,
})
namesBox.body.innerHTML = `<div class="chips" id="chips"></div>
	<div class="addrow"><input id="add" class="i" placeholder="a new fish" size="10" aria-label="a new fish"><button class="chip" id="add-b">add</button></div>
	<div class="small">drag to move · double-click to rename</div>`

const hungryBox = board.box({
	id: "hungry",
	x: 620,
	y: 340,
	title: "hungry",
	kind: "key",
	outs: [["out", ""]],
	width: 190,
})
hungryBox.body.innerHTML =
	`<div class="chips"><button class="chip" data-v="0">full</button><button class="chip" data-v="1">hungry</button></div>`

const pageBox = board.box({
	id: "page",
	x: 620,
	y: 20,
	title: "page",
	kind: "note",
	outs: [["owns", "owns"]],
	width: 190,
})
pageBox.code(`createRootScope({ name: "page" })`)

const pondBox = board.box({
	id: "pond",
	x: 620,
	y: 150,
	title: "pond",
	kind: "compute",
	ins: [["names", ""], ["owner", ""]],
	outs: [["owns", "owns"]],
	width: 190,
})
pondBox.code(source as string)
board.wire(namesBox.port("out"), pondBox.port("names"))
const pageOwnsPond = board.wire(pageBox.port("owns"), pondBox.port("owner"))
pageOwnsPond.dashed(true)

const picture = board.box({ id: "picture", x: 20, y: 180, title: "the pond", kind: "picture" })
picture.body.innerHTML = `<div class="pondwrap"><canvas></canvas><div class="over"></div></div>`
const pond = createPond(picture.body.querySelector("canvas")!, { width: 240, height: 140 })
const over = picture.body.querySelector<HTMLElement>(".over")!

const stepsBox = board.box({
	id: "steps",
	x: 20,
	y: 500,
	title: "steps",
	kind: "note",
	width: 486,
})
stepsBox.body.innerHTML = `<div class="scrub">
	<button class="chip" id="prev" aria-label="back a step">←</button>
	<span class="dots" id="dots"></span>
	<button class="chip" id="next" aria-label="on a step">→</button>
</div><div class="small" id="where"></div>
<button class="chip" id="again" data-again hidden>make pond again</button>
<button class="chip" id="over" data-over hidden>start over</button>`

// each child: a box under pond, wired from it by a dashed ownership line
type Kid = { box: Box; owns: Wire; reads: Wire }
const kids = new Map<number, Kid>()

function kidBox(x: Snap, i: number): Kid {
	let k = kids.get(x.n)
	if (!k) {
		const box = board.box({
			id: `kid:${x.n}`,
			x: COL,
			y: 20 + i * ROW,
			title: x.name,
			kind: "compute",
			ins: [["owner", ""], ["hungry", ""]],
			width: 210,
		})
		box.el.classList.add("kid")
		box.code(childCode)
		const owns = board.wire(pondBox.port("owns"), box.port("owner"))
		owns.dashed(true)
		const reads = board.wire(hungryBox.port("out"), box.port("hungry"))
		k = { box, owns, reads }
		kids.set(x.n, k)
	}
	return k
}
const childCode = (() => {
	const t = source as string
	const a = t.indexOf("\tfunction child")
	const b = t.indexOf("\n\t}\n", a)
	return a >= 0 && b > a ? t.slice(a, b + 3).replace(/^\t/gm, "") : t
})()

// where a fish swims: its own spot, by its name
const SPOTS = [
	{ x: 0.12, y: 0.2 },
	{ x: 0.55, y: 0.12 },
	{ x: 0.85, y: 0.45 },
	{ x: 0.3, y: 0.62 },
	{ x: 0.68, y: 0.85 },
	{ x: 0.1, y: 0.9 },
	{ x: 0.45, y: 0.38 },
	{ x: 0.9, y: 0.1 },
	{ x: 0.75, y: 0.6 },
	{ x: 0.25, y: 0.35 },
]
// each fish keeps its spot for as long as its child lives: a new child takes a free one
const spots = new Map<number, number>()
function home(n: number) {
	let i = spots.get(n)
	if (i === undefined) {
		const used = new Set(spots.values())
		i = SPOTS.findIndex((_, k) => !used.has(k))
		if (i < 0) i = spots.size % SPOTS.length
		spots.set(n, i)
	}
	return SPOTS[i]
}

const STATE: Record<string, [string, Tone]> = {
	alive: ["", undefined],
	old: ["old", "wait"],
	disposing: ["going", "hot"],
	gone: ["gone", "dim"],
}

function render(fresh = true) {
	const st = steps[at]
	if (!st) return
	if (fresh) page.say(esc(st.text), st.tone)
	scrub()
	const root = st.tree
	// page
	pageBox.badge(
		root.state === "alive" ? "" : root.state,
		root.state === "alive" ? undefined : "dim",
	)
	pageBox.tone(root.state === "gone" ? "dim" : root.state === "disposing" ? "hot" : undefined)
	pageBox.body.innerHTML = `<div class="small">a plain scope</div><div class="info">info ${
		esc(root.info)
	}</div>${tearButton(root)}`
	// pond: the newest one there is
	const ponds = root.kids
	const pd = ponds.find((x) => !x.loose) ?? ponds.at(-1)
	if (pd) {
		const [b, t] = STATE[pd.state === "alive" && pd.old ? "old" : pd.state]
		pondBox.badge(b, t)
		pondBox.tone(t)
		const claim = p.claiming.on
		pondBox.body.innerHTML = `<div class="mid">${pd.runs} run${
			pd.runs === 1 ? "" : "s"
		}</div><div class="info">info ${esc(pd.info)}</div>
			<label class="small sw"><input type="checkbox" id="claim" ${
			claim ? "checked" : ""
		}> claim old fish</label>${tearButton(pd)}`
		const h = st.hit.get(pd.n)
		if (h && fresh) pondBox.flash("hot")
		pageOwnsPond.tone(pd.loose ? "dim" : undefined)
	} else {
		pondBox.badge("")
		pondBox.body.innerHTML = ""
	}
	// once something is gone for good: a way back, on the steps box
	const again = live() && pd?.state === "gone" && root.state === "alive"
	const over = live() && root.state === "gone"
	document.getElementById("again")!.hidden = !again
	document.getElementById("over")!.hidden = !over
	// the fish
	const list = pd?.kids ?? []
	const here = new Set(list.map((x) => x.n))
	for (const [n, k] of kids) {
		if (!here.has(n)) {
			k.box.remove()
			k.owns.remove()
			k.reads.remove()
			kids.delete(n)
		}
	}
	const named: {
		name: string
		kind: "fish"
		x: number
		y: number
		tone?: "hot" | "ok" | "dim"
	}[] = []
	list.forEach((x, i) => {
		const k = kidBox(x, i)
		k.box.move(COL, 20 + i * ROW)
		const state = x.state === "alive" && x.old ? "old" : x.state
		const h = st.hit.get(x.n)
		let [b, t] = STATE[state]
		if (state === "alive" && h === "claimed") b = "claimed", t = "ok"
		if (state === "alive" && h === "made") b = "new", t = "hot"
		k.box.badge(b, t)
		k.box.tone(t === "ok" ? undefined : t)
		if (fresh && h === "claimed") k.box.flash("ok")
		else if (fresh && h && h !== "goes") k.box.flash("hot")
		k.reads.tone(x.loose || state === "gone" ? "dim" : undefined)
		if (fresh && h === "done") k.reads.flash("hot")
		k.owns.tone(x.loose ? "dim" : state === "old" ? "wait" : h === "claimed" ? "ok" : undefined)
		k.box.body.innerHTML = `<div class="mid">${
			x.mood ?? "…"
		}</div><div class="small">${x.runs} run${
			x.runs === 1 ? "" : "s"
		}</div><div class="info">info ${esc(x.info)}</div>${tearButton(x)}`
		if (x.state !== "gone") {
			named.push({
				name: x.name,
				kind: "fish",
				...home(x.n),
				tone: state === "disposing" || h === "made"
					? "hot"
					: h === "claimed"
					? "ok"
					: state === "old"
					? "dim"
					: undefined,
			})
		}
		if (fresh && (h === "cleanup" || h === "goes")) puff(x.n, x.name, h === "goes")
	})
	for (const n of [...spots.keys()]) if (!here.has(n)) spots.delete(n)
	pond.draw({ named, lilies: 3, sign: st.hungry ? "hungry!" : undefined })
	// what's picked
	for (const b of [pageBox, pondBox, ...[...kids.values()].map((k) => k.box)]) {
		b.el.classList.toggle("picked", picked !== undefined && boxOf(picked) === b && live())
	}
	hungryButtons()
	chips()
	board.redraw()
}

function tearButton(x: Snap) {
	return live() && picked?.n === x.n && x.state === "alive"
		? `<button class="b go tear" data-tear="${x.n}">tear down</button>`
		: ""
}
function boxOf(o: Scope): Box | undefined {
	if (o === p.root) return pageBox
	if (o.info.name === "pond") return pondBox
	return kids.get(o.n)?.box
}

// a bubble from a fish: its cleanup ran. a bigger one, with a goodbye, as it goes
function puff(n: number, name: string, bye: boolean) {
	const { x, y } = home(n)
	const left = (14 + x * 200 + 10) * 2, top = (21 + y * 98) * 2
	const b = document.createElement("div")
	b.className = bye ? "bubble bye" : "bubble"
	b.textContent = bye ? `bye, ${name}` : ""
	b.style.left = `${left}px`
	b.style.top = `${bye ? top + 16 : top - 6}px`
	over.append(b)
	setTimeout(() => b.remove(), 1600)
}

function scrub() {
	const dots = document.getElementById("dots")!
	dots.innerHTML = steps.map((x, i) =>
		`<button class="dot-step ${i === at ? "now" : ""} ${
			x.tone ? `tone-${x.tone}` : ""
		}" data-i="${i}" aria-label="step ${i + 1}" title="${esc(x.text)}"></button>`
	).join("")
	document.getElementById("where")!.textContent = `step ${at + 1} of ${steps.length}${
		timer ? " · playing" : ""
	}`
}

// ---- what you do --------------------------------------------------------------------------

const names = () => [...(p.store.get("names") as string[])]
function setNames(next: string[], what: string, tick: string) {
	act(what, () => {
		p.write("names", next)
		s.pulse()
	})
	page.tick(tick)
}

function chips() {
	const el = document.getElementById("chips")!
	if (el.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return
	const focused = (document.activeElement as HTMLElement | null)?.dataset?.i
	el.innerHTML = names().map((n, i) =>
		`<span class="chip name" draggable="true" tabindex="0" data-i="${i}" title="drag to move · enter or double-click to rename · delete to remove"><span class="nm">${
			esc(n)
		}</span><button class="x" data-rm="${i}" aria-label="remove ${esc(n)}">×</button></span>`
	).join("")
	if (focused !== undefined) el.querySelector<HTMLElement>(`[data-i="${focused}"]`)?.focus()
}
function hungryButtons() {
	for (const c of hungryBox.body.querySelectorAll<HTMLElement>(".chip")) {
		c.setAttribute(
			"aria-pressed",
			String((c.dataset.v === "1") === (p.store.get("hungry") === true)),
		)
	}
}

function add() {
	const input = document.getElementById("add") as HTMLInputElement
	const name = input.value.trim().toLowerCase().slice(0, 10)
	if (!name || names().includes(name)) {
		input.classList.add("bad")
		page.say(
			name ? `There is a ${name} already: one fish per name.` : "Type a name first.",
			"hot",
		)
		return
	}
	input.classList.remove("bad")
	input.value = ""
	setNames([...names(), name], `You added ${name}.`, "add")
}
function remove(i: number) {
	const n = names()
	const [x] = n.splice(i, 1)
	setNames(n, `You took ${x} off the names.`, "drop")
}
function move(i: number, j: number) {
	const n = names()
	if (j < 0 || j >= n.length || i === j) return
	const [x] = n.splice(i, 1)
	n.splice(j, 0, x)
	setNames(n, `You moved ${x}.`, "move")
}
function rename(i: number) {
	const el = document.getElementById("chips")!.children[i] as HTMLElement
	const nm = el.querySelector(".nm") as HTMLElement
	const was = names()[i]
	const input = document.createElement("input")
	input.className = "i ren"
	input.value = was
	input.size = Math.max(4, was.length)
	nm.replaceWith(input)
	input.focus()
	input.select()
	let ended = false
	const end = (keep: boolean) => {
		if (ended) return
		ended = true
		const name = input.value.trim().toLowerCase().slice(0, 10)
		if (!keep || !name || name === was || names().includes(name)) return chips()
		const n = names()
		n[i] = name
		setNames(n, `You renamed ${was} to ${name}.`, "drop")
	}
	input.onkeydown = (e) => {
		e.stopPropagation()
		if (e.key === "Enter") end(true)
		if (e.key === "Escape") end(false)
	}
	input.onblur = () => end(true)
	input.onpointerdown = (e) => e.stopPropagation()
}
function tear(n: number) {
	const o = [...seen].find((x) => x.n === n)
	if (!o || o.state !== "alive") return
	picked = undefined
	const name = nameOf(o)
	act(`You tore ${name} down.`, () => {
		tearing = name
		try {
			s.teardown(o)
		} finally {
			tearing = ""
		}
	}, `${name} is gone, and everything under it.`)
	if (o === p.root || name === "pond") page.tick("tear")
}

// ---- wiring the controls --------------------------------------------------------------------

// keep the board from panning or dragging when a control inside a box is used
for (const b of [namesBox, hungryBox, pondBox, pageBox, stepsBox]) {
	b.body.addEventListener("pointerdown", (e) => {
		if ((e.target as HTMLElement).closest("button, input, .chip, label")) e.stopPropagation()
	})
}
board.el.addEventListener("pointerdown", (e) => {
	if ((e.target as HTMLElement).closest(".kid button")) e.stopPropagation()
}, true)

document.getElementById("add-b")!.onclick = add
document.getElementById("add")!.onkeydown = (e) => {
	e.stopPropagation()
	if (e.key === "Enter") add()
}
hungryBox.body.onclick = (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>(".chip")
	if (!c) return
	const v = c.dataset.v === "1"
	if (v === p.store.get("hungry")) return
	act(v ? "You made the fish hungry." : "You fed the fish.", () => {
		p.write("hungry", v)
		s.pulse()
	})
	if (v) page.tick("hungry")
}
document.getElementById("prev")!.onclick = () => goTo(at - 1)
document.getElementById("next")!.onclick = () => goTo(at + 1)
document.getElementById("dots")!.onclick = (e) => {
	const d = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")
	if (d) goTo(+d.dataset.i!)
}
// buttons inside boxes: tear down, make again, start over, the claim switch
board.el.addEventListener("click", (e) => {
	const t = e.target as HTMLElement
	const tb = t.closest<HTMLElement>("[data-tear]")
	if (tb) return tear(+tb.dataset.tear!)
	if (t.closest("[data-again]")) {
		return act("You made pond again.", () => {
			p.makePond()
			s.pulse()
		})
	}
	if (t.closest("[data-over]")) return start()
})
board.el.addEventListener("change", (e) => {
	const t = e.target as HTMLInputElement
	if (t.id !== "claim") return
	p.claiming.on = t.checked
	page.say(
		t.checked
			? "pond claims its old fish again."
			: "pond won't claim now: each run makes every fish anew, and the old ones go.",
		"hot",
	)
})
board.onPick((b) => {
	if (!live()) finish()
	const kid = [...kids].find(([, k]) => k.box === b)?.[0]
	const o = b === pageBox
		? p.root
		: b === pondBox
		? [...seen].find((x) => x.info.name === "pond" && x.state === "alive")
		: kid !== undefined
		? [...seen].find((x) => x.n === kid)
		: undefined
	picked = o && o.state === "alive" && picked !== o ? o : undefined
	render(false)
	if (picked) page.say(`${nameOf(picked)} is picked. Tear it down, and what is under it goes too.`)
})

const chipsEl = document.getElementById("chips")!
let dragging = -1
chipsEl.addEventListener("pointerdown", (e) => e.stopPropagation())
chipsEl.onclick = (e) => {
	const x = (e.target as HTMLElement).closest<HTMLElement>("[data-rm]")
	if (x) remove(+x.dataset.rm!)
}
chipsEl.ondblclick = (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>(".name")
	if (c) rename(+c.dataset.i!)
}
chipsEl.onkeydown = (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>(".name")
	if (!c || e.target !== c) return
	const i = +c.dataset.i!
	if (e.key === "Enter") rename(i), e.preventDefault()
	else if (e.key === "Delete" || e.key === "Backspace") remove(i), e.preventDefault()
	else if (e.altKey && e.key === "ArrowLeft") move(i, i - 1), e.preventDefault()
	else if (e.altKey && e.key === "ArrowRight") move(i, i + 1), e.preventDefault()
}
chipsEl.ondragstart = (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>(".name")
	if (!c) return
	dragging = +c.dataset.i!
	e.dataTransfer!.effectAllowed = "move"
	e.dataTransfer!.setData("text/plain", String(dragging))
	c.classList.add("dragging")
}
chipsEl.ondragover = (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>(".name")
	if (dragging < 0 || !c) return
	e.preventDefault()
	for (const x of chipsEl.children) x.classList.remove("over-l", "over-r")
	const r = c.getBoundingClientRect()
	c.classList.add(e.clientX < r.left + r.width / 2 ? "over-l" : "over-r")
}
chipsEl.ondrop = (e) => {
	e.preventDefault()
	const c = (e.target as HTMLElement).closest<HTMLElement>(".name")
	const from = dragging
	dragging = -1
	if (!c || from < 0) return chips()
	let to = +c.dataset.i! + (c.classList.contains("over-r") ? 1 : 0)
	if (to > from) to--
	if (to === from) return chips()
	move(from, to)
}
chipsEl.ondragend = () => {
	dragging = -1
	for (const x of chipsEl.children) x.classList.remove("over-l", "over-r", "dragging")
}

// ---- this page's own look -------------------------------------------------------------------

const style = document.createElement("style")
style.textContent = `
.box.kid { transition: left .35s ease, top .35s ease; }
.box.flipped { width: auto !important; z-index: 6; }
.box-back { tab-size: 2; max-height: 440px; max-width: 460px; }
.box .info { font: 10px var(--mono); color: #555; margin-top: 2px; overflow-wrap: anywhere; white-space: normal; }
.box.picked { outline: 3px solid var(--blue); outline-offset: 2px; }
.box .tear { margin-top: 6px; width: 100%; }
.box [data-again], .box [data-over] { margin-top: 6px; width: 100%; }
.sw { display: flex; gap: 6px; align-items: center; margin-top: 6px; color: var(--ink); cursor: pointer; }
.addrow { display: flex; gap: 4px; margin: 6px 0 4px; }
.chip.name { display: inline-flex; align-items: center; padding: 1px 0 1px 8px; cursor: grab; background: var(--sky); }
.chip.name .x { font: 12px var(--mono); border: 0; background: none; cursor: pointer; padding: 0 6px; }
.chip.name .x:hover { color: var(--cherry); }
.chip.name.dragging { opacity: .4; }
.chip.name.over-l { box-shadow: -4px 0 0 var(--cherry); }
.chip.name.over-r { box-shadow: 4px 0 0 var(--cherry); }
.chip .ren { padding: 0 3px; font: 12px var(--mono); }
input.bad { outline: 2px solid var(--cherry); }
.pondwrap { position: relative; }
.pondwrap .over { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.bubble { position: absolute; width: 10px; height: 10px; border: 2px solid #fff; border-radius: 50%;
	animation: rise 1.5s ease-out forwards; }
.bubble.bye { width: auto; height: auto; border-radius: 10px; padding: 1px 7px; background: var(--cherry);
	color: #fff; border: 0; font: 700 11px var(--mono); white-space: nowrap; }
@keyframes rise { from { transform: translateY(0); opacity: 1 } to { transform: translateY(-36px); opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .bubble { animation: none; } .box.kid { transition: none; } }
.scrub { display: flex; align-items: center; gap: 6px; }
.dots { flex: 1; display: flex; flex-wrap: wrap; gap: 3px; }
.dot-step { width: 12px; height: 12px; border: 1.5px solid var(--ink); background: var(--paper); padding: 0; cursor: pointer; }
.dot-step.tone-hot { background: var(--pink); }
.dot-step.tone-ok { background: var(--mint); }
.dot-step.now { background: var(--ink); }
`
document.head.append(style)

start()
requestAnimationFrame(() => board.fit())
