/// <reference lib="dom" />
// change the rules: the farm runs on the real scheduler. hungry decides each pig's mood from its
// weight and the apples; its rule is on its box, and you edit it while everything runs. rules, the
// computer that made hungry, reads hungry's code: each change is a run of rules that claims hungry
// with the new function. same computer, its runs carrying on; wander and the picture never notice
import { type Computer, createScheduler } from "@ermine/scheduler"
import { pondPage } from "../kit/page.ts"
import { createFarm } from "../kit/farm.ts"

const page = pondPage("live", {
	say:
		`<p>The farm is running. <b>hungry</b> is a small program: it reads each pig's weight and the apples, and says who's hungry. Its rule is right there on its box.</p>
		<p>Change it and the scheduler hands <b>hungry</b> the new code while it runs: the same computer, its run count carrying on, the pigs where they were.</p>`,
	tries: [
		{ id: "edit", text: "Drag the <b>10</b> in hungry's rule up to 14. Watch its run count." },
		{ id: "word", text: "Change <b>full</b> to a word of your own." },
		{
			id: "typo",
			text: "Press <b>type</b> and break the rule: delete a quote, or misspell weight.",
		},
		{ id: "fix", text: "Fix it. The same hungry carries on." },
		{ id: "feed", text: "Click a pig to feed it an apple. Your rule decides how it feels." },
	],
	rules:
		`<p><b>owner:</b> <b>hungry</b> was made by <b>rules</b>, a computer that reads hungry's code.</p>
		<p><b>claim:</b> the code changes, so <b>rules</b> runs again and calls <code>s.claim(hungry, { kind: "compute", f, set })</code>. hungry keeps itself: its number, its runs, its last result. It takes the new <code>f</code> and is due.</p>
		<p><b>old:</b> as rules' run starts, what its earlier runs made is old, still alive. What it doesn't claim goes when the run is done.</p>
		<p><b>typo:</b> code that doesn't parse makes rules' run fail. A failed run keeps its old children as they are, so hungry runs on with the old rule.</p>
		<p><b>throw:</b> a rule that throws is hungry's own failed run: it sets nothing, so the moods it last gave stay.</p>
		<p><b>the rest:</b> <b>wander</b> and the picture weren't made by rules. Nothing here touches them.</p>`,
	real:
		`Runs the real <code>@ermine/scheduler</code>: createRootScope, createComputer, createEffect, claim, track, mark and pulse; run numbers and errors come from its onRunEnd. The page's own: turning your rule into a function (<code>new Function</code> on its text), the store, the clock, how wander steps, the chips and the farm picture.`,
})
const { board } = page

// ---- the store: keys and values, the page's own ---------------------------------------------
const s = createScheduler()
const PIGS = ["wilbur", "babe", "rosie", "hamlet"]
const START = `weight < 10 || apples < 3
  ? "hungry!" : "full"`
const store = new Map<string, unknown>([
	["apples", 5],
	["weights", { wilbur: 6, babe: 9, rosie: 13, hamlet: 17 }],
	["clock", 0],
	["code", START],
])
const read = <T>(key: string) => (s.track(key), store.get(key) as T)
// a write from a run's set or act is that run's; from the page, from outside
const write = (key: string, value: unknown) => {
	store.set(key, value)
	s.mark([key], s.getRun())
}

type Moods = Record<string, string>
type Spots = Record<string, { x: number; y: number; to: { x: number; y: number } }>

// the rule's text, made a function of weight and apples (the page's: it throws on a typo)
const compile = (code: string) =>
	new Function("weight", "apples", `return (\n${code}\n)`) as (w: number, a: number) => unknown
// hungry's run, with a rule
const hungryWith = (rule: (w: number, a: number) => unknown) => () => {
	const weights = read<Record<string, number>>("weights")
	const apples = read<number>("apples")
	const moods: Moods = {}
	for (const name of PIGS) moods[name] = String(rule(weights[name], apples))
	return moods
}
const setMoods = (m: unknown) => write("moods", m)

// ---- the programs, on the real scheduler ----------------------------------------------------
const root = s.createRootScope({ name: "farm" })
let hungry: Computer | undefined
let rules: Computer | undefined
let wander: Computer | undefined
let picture: Computer | undefined

// rules: reads hungry's code; its first run makes hungry, each later one claims it with the new f
function rulesRun() {
	const f = hungryWith(compile(read<string>("code")))
	if (hungry && s.claim(hungry, { kind: "compute", f, set: setMoods })) return "claimed"
	hungry = s.createComputer(f, setMoods, undefined, undefined, { name: "hungry" })
	return "made"
}

const rand = () => ({ x: 0.08 + Math.random() * 0.84, y: 0.1 + Math.random() * 0.75 })
// where each pig starts
const HOME: Record<string, { x: number; y: number }> = {
	wilbur: { x: 0.15, y: 0.3 },
	babe: { x: 0.4, y: 0.7 },
	rosie: { x: 0.62, y: 0.2 },
	hamlet: { x: 0.85, y: 0.55 },
}
// wander: a step toward where each pig is going, each tick of the clock
function wanderRun(prev: Spots | undefined): Spots {
	read("clock")
	const next: Spots = {}
	for (const name of PIGS) {
		const p = prev?.[name] ?? { ...HOME[name], to: rand() }
		const dx = p.to.x - p.x, dy = p.to.y - p.y
		const d = Math.hypot(dx, dy)
		const step = 0.012
		next[name] = d < step
			? { x: p.to.x, y: p.to.y, to: Math.random() < 0.3 ? rand() : p.to }
			: { x: p.x + (dx / d) * step, y: p.y + (dy / d) * step, to: p.to }
	}
	return next
}

s.runWithScope(root, () => {
	rules = s.createComputer(rulesRun, () => {}, undefined, undefined, { name: "rules" })
	wander = s.createComputer(
		wanderRun as (p: unknown) => Spots,
		(v) => write("spots", v),
		undefined,
		undefined,
		{ name: "wander" },
	)
	picture = s.createEffect(
		() => ({
			spots: read<Spots>("spots"),
			moods: read<Moods>("moods"),
			weights: read<Record<string, number>>("weights"),
			apples: read<number>("apples"),
		}),
		(scene) => draw(scene),
		undefined,
		undefined,
		{ name: "picture" },
	)
})

// ---- the board ------------------------------------------------------------------------------
const applesBox = board.box({
	id: "apples",
	x: 0,
	y: 150,
	title: "apples",
	kind: "key",
	outs: [["out", ""]],
	width: 150,
})
applesBox.body.innerHTML =
	`<div class="stepper"><button data-d="-1" title="one fewer">−</button><output></output><button data-d="1" title="one more">+</button></div>`
const applesOut = applesBox.body.querySelector("output")!

const pigsBox = board.box({
	id: "pigs",
	x: 0,
	y: 260,
	title: "weights",
	kind: "key",
	outs: [["out", ""]],
	width: 150,
})
pigsBox.body.innerHTML = `<div class="small">click a pig to feed it</div>`

const clockBox = board.box({
	id: "clock",
	x: 0,
	y: 450,
	title: "clock",
	kind: "key",
	outs: [["out", ""]],
	width: 150,
})
clockBox.body.innerHTML = `<div class="small">the page ticks it</div>`

const rulesBox = board.box({
	id: "rules",
	x: 0,
	y: 0,
	title: "rules",
	kind: "compute",
	outs: [["owns", "owns"]],
	width: 190,
})
rulesBox.body.innerHTML =
	`<div class="small">reads hungry's code; hands it over</div><div class="err" hidden></div>`

const hungryBox = board.box({
	id: "hungry",
	x: 250,
	y: 90,
	title: "hungry",
	kind: "compute",
	ins: [["owner", ""], ["apples", ""], ["weights", ""]],
	outs: [["out", ""]],
	width: 310,
})
hungryBox.body.innerHTML = `<div class="rule" aria-label="hungry's rule"></div>
	<textarea class="rule-raw" rows="2" spellcheck="false" aria-label="hungry's rule, as text" hidden></textarea>
	<div class="rule-foot"><span class="small who"></span><button class="chip type" aria-pressed="false" title="edit the rule as text">type</button></div>
	<div class="err" hidden></div>`

const wanderBox = board.box({
	id: "wander",
	x: 250,
	y: 450,
	title: "wander",
	kind: "compute",
	ins: [["clock", ""]],
	outs: [["out", ""]],
	width: 190,
})
wanderBox.body.innerHTML = `<div class="small">a step for each pig</div>`

const picBox = board.box({
	id: "picture",
	x: 680,
	y: 0,
	title: "the farm",
	kind: "picture",
	ins: [["moods", ""], ["spots", ""]],
})
const canvas = document.createElement("canvas")
picBox.body.append(canvas)
const farm = createFarm(canvas, { width: 240, height: 136 })
canvas.classList.add("big")
canvas.title = "click a pig to feed it"

const elsewhere = board.box({
	id: "elsewhere",
	x: 680,
	y: 400,
	title: "elsewhere",
	kind: "note",
	width: 400,
})
elsewhere.body.innerHTML =
	`<p class="small">In most apps you change the code, rebuild and restart, and the running thing starts over. Some dev tools hot-reload and keep part of the state. Spreadsheets do let you edit a formula live; here it's a whole program.</p>`

const owns = board.wire(rulesBox.port("owns"), hungryBox.port("owner"))
owns.dashed(true)
const wApples = board.wire(applesBox.port("out"), hungryBox.port("apples"))
const wWeights = board.wire(pigsBox.port("out"), hungryBox.port("weights"))
const wClock = board.wire(clockBox.port("out"), wanderBox.port("clock"))
const wMoods = board.wire(hungryBox.port("out"), picBox.port("moods"))
const wSpots = board.wire(wanderBox.port("out"), picBox.port("spots"))
// a wire from the apples and the weights to the picture too would say the same again: the
// picture reads them, but the moods carry the story

function draw(
	scene: { spots: Spots; moods: Moods; weights: Record<string, number>; apples: number },
) {
	farm.draw({
		pigs: PIGS.map((name) => {
			const at = scene.spots?.[name] ?? { x: 0.5, y: 0.5 }
			const says = scene.moods?.[name]
			return {
				name,
				weight: scene.weights[name],
				x: at.x,
				y: at.y,
				says,
				tone: says === "hungry!" ? "hot" as const : undefined,
			}
		}),
		apples: scene.apples,
	})
}

// ---- what the scheduler says ----------------------------------------------------------------
type End = { c: Computer; n: number; ended: string; error?: unknown }
let ends: End[] = []
const errors = new Map<Computer, unknown>()
s.onRunEnd((c, n, ended, _reads, more) => {
	ends.push({ c, n, ended, error: more.error })
	if (ended === "failed") errors.set(c, more.error)
	else if (ended === "done") errors.delete(c)
	if (c === rules || c === hungry || c === wander) {
		const b = c === rules ? rulesBox : c === hungry ? hungryBox : wanderBox
		b.badge(`run ${n}`, ended === "failed" ? "hot" : undefined)
	}
})
s.onAfterPulse(() => {
	labels()
	showErrors()
})

const msg = (e: unknown) => e instanceof Error ? e.message : String(e)
function showErrors() {
	for (const [c, b] of [[rules, rulesBox], [hungry, hungryBox]] as const) {
		const el = b.body.querySelector<HTMLElement>(".err")!
		const e = c && errors.get(c)
		el.hidden = !e
		el.textContent = e
			? c === rules ? `doesn't parse: ${msg(e)}` : `threw: ${msg(e)}. its last moods stay.`
			: ""
		b.tone(e ? "hot" : undefined)
	}
}

const tally = (m: Moods | undefined, quote = false) => {
	const n = new Map<string, number>()
	for (const name of PIGS) {
		const w = m?.[name] ?? ""
		n.set(w, (n.get(w) ?? 0) + 1)
	}
	return [...n].map(([w, k]) => quote ? `${k} “${w}”` : `${k} ${w}`).join(", ")
}
function labels() {
	applesOut.textContent = String(store.get("apples"))
	wApples.label(`${store.get("apples")} apples`)
	const w = store.get("weights") as Record<string, number>
	wWeights.label(PIGS.map((p) => w[p]).join(" · "))
	wClock.label(`tick ${store.get("clock")}`)
	wMoods.label(tally(store.get("moods") as Moods))
	wSpots.label("4 spots")
	who()
}
let was: number | undefined
function who() {
	if (!hungry) return
	const el = hungryBox.body.querySelector<HTMLElement>(".who")!
	el.textContent = was !== undefined && was !== hungry.runs
		? `run ${was} → ${hungry.runs}, same computer #${hungry.n}`
		: `computer #${hungry.n}, made once`
}

// ---- the clock: the farm keeps going ------------------------------------------------------
s.pulse()
labels()
const still = matchMedia("(prefers-reduced-motion: reduce)").matches
setInterval(() => {
	store.set("clock", (store.get("clock") as number) + 1)
	s.mark(["clock"])
	s.pulse()
}, still ? 2000 : 450)

// ---- you did something: the board says what the scheduler did ------------------------------
function act(f: () => void) {
	ends = []
	was = undefined
	const before = hungry!.runs
	const hadError = errors.size > 0
	f()
	s.pulse()
	return { before, hadError, mine: ends.filter((e) => e.c !== wander && e.c !== picture) }
}

// the rule, as chips: numbers you drag or type, words you type; the rest as it is
const ruleEl = hungryBox.body.querySelector<HTMLElement>(".rule")!
const raw = hungryBox.body.querySelector<HTMLTextAreaElement>(".rule-raw")!
const typeBtn = hungryBox.body.querySelector<HTMLButtonElement>(".type")!
const TOKEN = /("[^"\n]*"|'[^'\n]*')|((?<![\w.$])\d+(?:\.\d+)?(?![\w.]))/g

function chips(code: string) {
	ruleEl.textContent = ""
	let at = 0
	for (const m of code.matchAll(TOKEN)) {
		ruleEl.append(code.slice(at, m.index))
		at = m.index! + m[0].length
		const input = document.createElement("input")
		if (m[1]) {
			const q = m[1][0]
			input.className = "str"
			input.value = m[1].slice(1, -1)
			input.dataset.q = q
			input.setAttribute("aria-label", "a word")
			ruleEl.append(q, input, q)
		} else {
			input.className = "num"
			input.value = m[2]
			input.inputMode = "decimal"
			input.setAttribute("aria-label", "a number: drag or type")
			input.title = "drag sideways, or click and type"
			scrub(input)
			ruleEl.append(input)
		}
		size(input)
	}
	ruleEl.append(code.slice(at))
}
const size = (i: HTMLInputElement) => (i.style.width = `${Math.max(1, i.value.length) + 0.8}ch`)
// the code the chips say
const said = () => {
	let out = ""
	for (const n of ruleEl.childNodes) {
		out += n instanceof HTMLInputElement ? n.value : n.textContent
	}
	return out
}
// a drag is many edits: its sentence counts from where the drag began
let dragFrom: number | undefined
function scrub(i: HTMLInputElement) {
	i.addEventListener("pointerdown", (e) => {
		if (document.activeElement === i) return
		e.preventDefault()
		const x0 = e.clientX, v0 = Number(i.value) || 0
		let moved = false
		dragFrom = hungry!.runs
		i.setPointerCapture(e.pointerId)
		const move = (m: PointerEvent) => {
			const d = Math.round((m.clientX - x0) / 8)
			if (!moved && Math.abs(m.clientX - x0) < 4) return
			moved = true
			const v = String(Math.max(0, v0 + d))
			if (v === i.value) return
			i.value = v
			size(i)
			edit(said())
		}
		const up = () => {
			i.removeEventListener("pointermove", move)
			i.removeEventListener("pointerup", up)
			dragFrom = undefined
			if (!moved) (i.focus(), i.select())
		}
		i.addEventListener("pointermove", move)
		i.addEventListener("pointerup", up)
	})
}
ruleEl.addEventListener("input", (e) => {
	const i = e.target as HTMLInputElement
	size(i)
	edit(said())
})
let wait: ReturnType<typeof setTimeout> | undefined
raw.addEventListener("input", () => {
	clearTimeout(wait)
	wait = setTimeout(() => edit(raw.value), 300)
})
typeBtn.onclick = () => {
	const typing = typeBtn.getAttribute("aria-pressed") !== "true"
	typeBtn.setAttribute("aria-pressed", String(typing))
	typeBtn.textContent = typing ? "chips" : "type"
	typeBtn.title = typing ? "back to the chips" : "edit the rule as text"
	const code = store.get("code") as string
	if (typing) {
		raw.value = code
		raw.hidden = false
		ruleEl.hidden = true
		raw.focus()
	} else {
		chips(code)
		raw.hidden = true
		ruleEl.hidden = false
	}
	board.redraw()
}
chips(START)

// the code changed: rules runs, and hands hungry the new code (or can't)
function edit(code: string) {
	if (code === store.get("code")) return
	const words = (c: string) => [...c.matchAll(TOKEN)].filter((m) => m[1]).map((m) => m[1])
	const wordsBefore = words(store.get("code") as string)
	const r = act(() => {
		store.set("code", code)
		s.mark(["code"])
	})
	const before = dragFrom ?? r.before
	was = before
	const rEnd = r.mine.find((e) => e.c === rules)
	const hEnd = r.mine.filter((e) => e.c === hungry).at(-1)
	rulesBox.flash(rEnd?.ended === "failed" ? "hot" : "ok")
	if (rEnd?.ended === "failed") {
		page.say(
			`That doesn't parse yet, so <b>rules</b>' run failed and handed nothing over: <b>hungry</b> runs on with the old rule.`,
			"hot",
		)
		page.tick("typo")
	} else if (hEnd?.ended === "failed") {
		hungryBox.flash("hot")
		page.say(
			`<b>hungry</b> took the new code as run ${hEnd.n}, and it threw: it set nothing, so the pigs keep the moods they had.`,
			"hot",
		)
		page.tick("typo")
	} else if (hEnd) {
		hungryBox.flash("ok")
		wMoods.flash("hot")
		const moods = tally(store.get("moods") as Moods, true)
		page.say(
			r.hadError
				? `Fixed: <b>hungry</b> carries on at run ${hEnd.n}, the same computer #${
					hungry!.n
				}, now ${moods}.`
				: `<b>hungry</b> took your rule while running: run ${before} → ${hEnd.n}, the same computer #${
					hungry!.n
				}. Now ${moods}.`,
			"ok",
		)
		if (r.hadError) page.tick("fix")
		else if (words(code).join() !== wordsBefore.join()) page.tick("word")
		else page.tick("edit")
	}
	labels()
}

// apples, and feeding a pig
applesBox.body.onclick = (e) => {
	const d = Number((e.target as HTMLElement).closest<HTMLElement>("[data-d]")?.dataset.d)
	if (!d) return
	const n = Math.max(0, Math.min(8, (store.get("apples") as number) + d))
	if (n === store.get("apples")) return
	const r = act(() => write("apples", n))
	const h = r.mine.filter((x) => x.c === hungry).at(-1)
	wApples.flash("hot")
	page.say(
		h?.ended === "failed"
			? `${n} apples. <b>hungry</b> ran (run ${h.n}) and threw again: the moods stay.`
			: `${n} apples, so <b>hungry</b> ran again (run ${h?.n}) ${
				errors.has(rules!)
					? "on the old rule: the new text doesn't parse"
					: "with the rule as it is now"
			}.`,
	)
}
canvas.addEventListener("click", (e) => {
	const pig = farm.pigAt(e.clientX, e.clientY)
	if (!pig) return
	const apples = store.get("apples") as number
	if (apples === 0) {
		page.say(`The trough is empty: press <b>+</b> on apples first.`, "hot")
		return
	}
	const weights = { ...(store.get("weights") as Record<string, number>) }
	weights[pig.name] = Math.min(30, weights[pig.name] + 2)
	const r = act(() => {
		store.set("apples", apples - 1)
		store.set("weights", weights)
		s.mark(["apples", "weights"])
	})
	const h = r.mine.filter((x) => x.c === hungry).at(-1)
	wWeights.flash("hot")
	page.say(
		h?.ended === "failed"
			? `${pig.name} ate an apple: ${
				weights[pig.name]
			} now. <b>hungry</b>'s rule threw, so the moods stay.`
			: `${pig.name} ate an apple: ${weights[pig.name]} now, and ${
				errors.has(rules!) ? "the old rule" : "your rule"
			} says ${(store.get("moods") as Moods)[pig.name]}.`,
	)
	page.tick("feed")
})

requestAnimationFrame(() => board.fit())
