/** @jsxImportSource @ermine */
// the party: one long page everyone is on at once. LLM generated: a prototype. every piece is
// nodes under /shared that every visitor's page binds, written by the visitors' actions (each a
// process of its own); the clocks are processes of their own, writing on a timer. ideas from the
// slaygrounds: piece-cursors (who's here), toy-paint and desk (the wall, who drew this pixel?),
// lab-life, toy-drums, toy-stickers, toy-pet, friends-card, lab-pig, toy-fortune
//   /shared/names/<id>   { animal, emoji, colour }: a visitor's, kept after they go
//   /shared/here/<id>    { animal, emoji, colour, away }: a visitor here now (the host's hooks)
//   /shared/wall/<i>     a colour, or null: 16 × 16
//   /shared/life/<i>     alive or not: 20 × 12, stepped by /clocks/life; life-gen, life-on
//   /shared/beat/<r>-<s> on or not: 4 sounds × 8 steps; beat-step, moved by /clocks/beat from
//                        the time, so every ermine that runs it is on the same step (LOCAL: each
//                        writes its own, synced with nobody)
//   /shared/stickers/*   { s, x, y, by }; /shared/card/* { name, flower, by }
//   /shared/pet/*        hunger (fed by the visitors, raised by /clocks/pet), fed, pats, patted
//   /shared/pens/a|b/*   { name, shame, shamedBy }: carried between pens by rename
//   /shared/fortune      { q, n, at, by }: the question the ball was asked last. its answer is
//                        each visitor's async compute (./answer), pending till the time it is due
import {
	addTeardown,
	createAction,
	createMemo,
	createNode,
	createWriter,
	ensureNode,
	explain,
	hasNode,
	list,
	patch,
	peep,
	read,
	remove,
	rename,
} from "@ermine/system"
import { bind, type Child, handler, track, under } from "@ermine/render/h"
import type { Page } from "./live.ts"

const ANIMALS = [
	["otter", "🦦"],
	["fox", "🦊"],
	["frog", "🐸"],
	["panda", "🐼"],
	["bunny", "🐰"],
	["owl", "🦉"],
	["mouse", "🐭"],
	["hedgehog", "🦔"],
	["bee", "🐝"],
	["duck", "🦆"],
	["koala", "🐨"],
	["cat", "🐱"],
] as const
// each visitor's colour, an index into the page's c0…c7
const COLOURS = 8
const STICKERS = ["🍒", "⭐", "🌸", "🦋", "🍓", "🌈", "🐾", "💖"]
const FLOWERS = ["🌷", "🌼", "🌻", "🌸", "🌹", "💐", "🪷", "🌺"]
const PIGS = ["pip", "wilbur", "truffle", "peaches", "bean", "mochi", "nugget", "clover"]
const SOUNDS = ["kick", "snare", "hat", "blip"]
const WALL = 16
// the life grid's width and height
const LIFE = { w: 20, h: 12 }
const STEPS = 8
// a kick on every fourth step, to start
const KICKS = 4
const STICKERS_KEPT = 48
const HUNGRY = 10
// a feed takes this much hunger away
const FED = 3
// the pet's mood, the first whose hunger it has reached
const MOODS = [[8, "is starving"], [5, "is peckish"], [2, "is happy"], [0, "is stuffed"]] as const
// hearts and a pig's shame shown at most this many times over
const HEARTS_SHOWN = 24
const SHAMES_SHOWN = 5
// how often each clock writes, in ms
const LIFE_MS = 600
const BEAT_MS = 250
const PET_MS = 6000
// life: how much of the grid a sprinkle fills, and the fewest alive before it sprinkles again
const SPRINKLE = 0.22
const FEWEST = 6
// life's rule: born with three neighbours, stays with two or three
const BORN = 3
const STAYS = 2
// the fortune ball's answers, and how long it thinks: at least THINK_MS, up to THINK_SPREAD more
const ANSWERS = [
	"yes, obviously",
	"ask me after snacks",
	"the stars say maybe",
	"no, but sweetly",
	"definitely, go go go",
	"not today, friend",
	"signs point to yes",
	"my sources are dogs: no",
]
const THINK_MS = 800
const THINK_SPREAD = 1600
const QUESTION_LONGEST = 80
// a string hash's multiplier (java's)
const HASH = 31

// a fraction as a css percentage, to a tenth
const percent = (f: number) => `${Math.round(f * 1000) / 10}%`
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]
const set = (path: string, value: unknown, at: string[] = []) => patch(path, [{ path: at, value }])
const now = <T,>(path: string) => peep(() => read(path)) as T

type Name = { animal: string; emoji: string; colour: number }
type Here = Name & { away: boolean }
type Asked = { q: string; n: number; at: number; by: string }
// a question's hash, the same on every ermine: which answer, and how long the ball thinks
const hash = ({ q, n }: Asked) =>
	[...q].reduce((h, c) => (h * HASH + c.codePointAt(0)!) >>> 0, n >>> 0)
// a visitor's name, by id; gone: undefined
const nameOf = (id: string | undefined): Name | undefined =>
	id && hasNode(`/shared/names/${id}`) ? read(`/shared/names/${id}`) as Name : undefined
const said = (n: Name | undefined) => n ? `${n.emoji} ${n.animal}` : "someone who has left"

// ---- the shared nodes, made by the host once ----
export function setupShared() {
	for (
		const f of ["", "/names", "/here", "/wall", "/life", "/beat", "/stickers", "/card", "/pet"]
	) {
		ensureNode(`/shared${f}`)
	}
	ensureNode("/shared/pens")
	ensureNode("/shared/pens/a")
	ensureNode("/shared/pens/b")
	for (const i of range(WALL * WALL)) ensureNode(`/shared/wall/${i}`, null)
	for (const i of range(LIFE.w * LIFE.h)) ensureNode(`/shared/life/${i}`, Math.random() < SPRINKLE)
	ensureNode("/shared/life-gen", 0)
	ensureNode("/shared/life-on", true)
	for (const r of range(SOUNDS.length)) {
		for (const s of range(STEPS)) ensureNode(`/shared/beat/${r}-${s}`, r === 0 && s % KICKS === 0)
	}
	ensureNode("/shared/beat-step", 0)
	ensureNode("/shared/pet/hunger", 4)
	ensureNode("/shared/pet/fed", null)
	ensureNode("/shared/pet/pats", 0)
	ensureNode("/shared/pet/patted", null)
	ensureNode("/shared/fortune", null)
	createNode("/shared/pens/a", { name: "pip", shame: 0, shamedBy: null })
}

// ---- the clocks: processes of their own, each a timer writing through a writer ----
function every(ms: number, f: () => void) {
	return function clock() {
		const write = createWriter()
		const t = setInterval(() => write(f), ms)
		addTeardown(() => clearInterval(t))
	}
}

// the next generation (a torus); fewer than six alive: sprinkled again
export function stepLife() {
	if (!now("/shared/life-on")) return
	const cells = peep(() => range(LIFE.w * LIFE.h).map((i) => read(`/shared/life/${i}`) as boolean))
	const around = (i: number) => {
		const x = i % LIFE.w, y = Math.floor(i / LIFE.w)
		let n = 0
		for (const dy of [-1, 0, 1]) {
			for (const dx of [-1, 0, 1]) {
				const j = ((y + dy + LIFE.h) % LIFE.h) * LIFE.w + (x + dx + LIFE.w) % LIFE.w
				if ((dx || dy) && cells[j]) n++
			}
		}
		return n
	}
	const next = cells.filter(Boolean).length < FEWEST
		? cells.map(() => Math.random() < SPRINKLE)
		: cells.map((a, i) => around(i) === BORN || a && around(i) === STAYS)
	next.forEach((a, i) => a !== cells[i] && set(`/shared/life/${i}`, a))
	set("/shared/life-gen", now<number>("/shared/life-gen") + 1)
}

// someone is here, and not away
const anyoneHere = () =>
	peep(() => list("/shared/here")).some((id) => !now<Here>(`/shared/here/${id}`)?.away)

// the beat's step, from the time
export const beatClock = every(
	BEAT_MS,
	() => set("/shared/beat-step", Math.floor(Date.now() / BEAT_MS) % STEPS),
)
// the paths each ermine writes for itself (tippet's version: never synced)
export const LOCAL = ["/shared/beat-step"]
// the paths whose values tippet's version sends and never keeps: life, many writes a second
export const EPHEMERAL = ["/shared/life", "/shared/life-gen"]

export const clocks: readonly (readonly [string, () => void])[] = [
	// life steps only while someone watches it
	["/clocks/life", every(LIFE_MS, () => anyoneHere() && stepLife())],
	["/clocks/beat", beatClock],
	[
		"/clocks/pet",
		every(
			PET_MS,
			// only while it can rise: writing the same value is still a step (tippet's version)
			() => {
				const h = now<number>("/shared/pet/hunger")
				if (h < HUNGRY) set("/shared/pet/hunger", h + 1)
			},
		),
	],
]

// ---- a visitor ----
type Ev = {
	target: { value?: string; elements?: Record<string, { value: string }> }
	currentTarget: { clientWidth?: number; clientHeight?: number }
	offsetX?: number
	offsetY?: number
}
// the number a clicked cell says (its value), or nothing: a click between cells
const cell = (e: Ev) => e.target.value ? [Number(e.target.value)] : undefined

export const party = <E,>({ into, options, render }: Page<E>) =>
	function visitor() {
		const id = options.name.split("/").pop()!
		// a name and a colour, the first time: kept, so a visitor rebuilt per request (the edge) keeps them
		const [animal, emoji] = pick(ANIMALS)
		ensureNode(`/shared/names/${id}`, {
			animal,
			emoji,
			colour: Math.floor(Math.random() * COLOURS),
		})
		const me = now<Name>(`/shared/names/${id}`)
		ensureNode(`/shared/here/${id}`, { ...me, away: false })
		// this visitor's own: the wall's tool, the pixel asked about, the sticker in hand
		ensureNode("tool", "paint")
		ensureNode("asked", null)
		ensureNode("sticker", STICKERS[0])

		createAction("on/tool", (tool: string) => set("tool", tool))
		createAction(
			"on/paint",
			(i: number) =>
				now("tool") === "who" ? set("asked", i) : set(`/shared/wall/${i}`, me.colour),
		)
		createAction("on/life", (i: number) => set(`/shared/life/${i}`, !now(`/shared/life/${i}`)))
		createAction("on/life-on", () => set("/shared/life-on", !now("/shared/life-on")))
		createAction(
			"on/beat",
			(key: string) => set(`/shared/beat/${key}`, !now(`/shared/beat/${key}`)),
		)
		createAction("on/sticker", (s: string) => set("sticker", s))
		createAction("on/stick", (x: number, y: number) => {
			createNode("/shared/stickers", { s: now("sticker"), x, y, by: id })
			const all = peep(() => list("/shared/stickers"))
			for (const old of all.slice(0, Math.max(0, all.length - STICKERS_KEPT))) {
				remove(`/shared/stickers/${old}`)
			}
		})
		createAction("on/feed", () => {
			set("/shared/pet/hunger", Math.max(0, now<number>("/shared/pet/hunger") - FED))
			set("/shared/pet/fed", id)
		})
		createAction("on/pat", () => {
			set("/shared/pet/pats", now<number>("/shared/pet/pats") + 1)
			set("/shared/pet/patted", id)
		})
		createAction("on/sign", (name: string) =>
			createNode("/shared/card", {
				name: String(name ?? "").trim().slice(0, 24) || me.animal,
				flower: pick(FLOWERS),
				by: id,
			}))
		createAction(
			"on/pig",
			() => createNode("/shared/pens/a", { name: pick(PIGS), shame: 0, shamedBy: null }),
		)
		createAction(
			"on/carry",
			(pen: string, pig: string) =>
				rename(`/shared/pens/${pen}/${pig}`, `/shared/pens/${pen === "a" ? "b" : "a"}/${pig}`),
		)
		createAction("on/shame", (pen: string, pig: string) => {
			const at = `/shared/pens/${pen}/${pig}`
			set(at, (now<{ shame: number }>(at)).shame + 1, ["shame"])
			set(at, id, ["shamedBy"])
		})
		createAction("on/bin", (pen: string, pig: string) => remove(`/shared/pens/${pen}/${pig}`))
		createAction("on/ask", (q: string) => {
			const asked = String(q ?? "").trim().slice(0, QUESTION_LONGEST)
			if (!asked) return
			const last = now<Asked | null>("/shared/fortune")
			set("/shared/fortune", { q: asked, n: (last?.n ?? 0) + 1, at: Date.now(), by: id })
		})
		// the ball's answer: async, pending till it is due (when it was asked and how long its hash
		// says it thinks), so every ermine (a visitor's here, a page's own, the edge's for a request)
		// answers the same, at the same time
		createMemo("answer", () => {
			const asked = read("/shared/fortune") as Asked | null
			if (!asked) return null
			const h = hash(asked)
			const answer = ANSWERS[h % ANSWERS.length]
			const left = asked.at + THINK_MS + h % THINK_SPREAD - Date.now()
			if (left <= 0) return answer
			// its timer let go when it runs again, or its visitor goes
			let timer: ReturnType<typeof setTimeout> | undefined
			const thought = new Promise<string>((
				done,
			) => (timer = setTimeout(() => done(answer), left)))
			addTeardown(() => clearTimeout(timer))
			return thought
		})

		render(into, view(id), options)
	}

// ---- the page ----
function view(id: string): Child {
	return (
		<div class="party">
			<header class="top">
				<h1>
					ermine party<span class="dot">.</span>
				</h1>
				<p class="me">
					you're {bind(`/shared/names/${id}`, (n: Name) => said(n))}
				</p>
				<ul class="here">
					{under("/shared/here", (item) => (
						<li
							class={bind(item.at, (h: Here) => `chip c${h.colour}${h.away ? " away" : ""}`)}
						>
							{bind(item.at, (h: Here) =>
								`${h.emoji} ${h.animal}${item.name === id ? " (you)" : ""}${
									h.away ? " (away)" : ""
								}`)}
						</li>
					))}
				</ul>
			</header>
			{wall()}
			{life()}
			{beat()}
			{stickers()}
			{pet()}
			{fortune()}
			{card()}
			{pigs()}
		</div>
	)
}

// "who drew?": the pixel asked about, and its writer, by explain: the action that wrote it is at
// /visitors/<id>/on/paint, so its path's second name is the visitor. a write that came from
// another ermine (the tippet version: a step) has no writer here, its change's actor saying the
// process that wrote it ("/visitors/<id>")
function whoDrew(): string {
	const i = read("asked") as number | null
	if (i === null) return "pick “who drew?”, then a pixel"
	const at = `pixel ${i % WALL},${Math.floor(i / WALL)}`
	if (read(`/shared/wall/${i}`) === null) return `${at}: nobody yet`
	const seen = explain(`/shared/wall/${i}`) as {
		writer?: { path?: string[] | null }
		change?: { actor?: unknown }
	}
	const actor = seen?.change?.actor
	const by = seen?.writer?.path?.[1] ??
		(typeof actor === "string" ? actor.split("/")[2] : undefined)
	return `${at}: ${said(nameOf(by))}`
}

function wall(): Child {
	const tool = (t: string, label: string) => (
		<button
			type="button"
			class={bind("tool", (now: string) => now === t ? "tool on" : "tool")}
			onClick={handler("on/tool", [t])}
		>
			{label}
		</button>
	)
	return (
		<section>
			<h2>pixel wall</h2>
			<p class="row">
				{tool("paint", "paint")} {tool("who", "who drew?")}{" "}
				<span class="who">{track(whoDrew)}</span>
			</p>
			<div class="wall" onClick={handler("on/paint", cell)}>
				{range(WALL * WALL).map((i) => (
					<button
						type="button"
						value={String(i)}
						class={bind(`/shared/wall/${i}`, (c: number | null) =>
							c === null ? "px" : `px c${c}`)}
					/>
				))}
			</div>
		</section>
	)
}

function life(): Child {
	return (
		<section>
			<h2>life, everyone pokes</h2>
			<p class="row">
				generation {bind("/shared/life-gen")}{" "}
				<button type="button" onClick={handler("on/life-on")}>
					{bind("/shared/life-on", (on: boolean) => on ? "pause" : "play")}
				</button>{" "}
				<span class="muted">click a cell to flip it, for everyone</span>
			</p>
			<div class="life" onClick={handler("on/life", cell)}>
				{range(LIFE.w * LIFE.h).map((i) => (
					<button
						type="button"
						value={String(i)}
						class={bind(`/shared/life/${i}`, (a: boolean) => a ? "cell on" : "cell")}
					/>
				))}
			</div>
		</section>
	)
}

function beat(): Child {
	return (
		<section>
			<h2>beat grid</h2>
			<p class="row">
				<button type="button" id="sound">sound: off</button>{" "}
				<span class="muted">
					the playhead is a clock on the server; sound plays on your page only
				</span>
			</p>
			<div
				class="beat"
				onClick={handler("on/beat", (e: Ev) => e.target.value ? [e.target.value] : undefined)}
			>
				{SOUNDS.map((sound, r) => (
					<div class="track">
						<span class="lbl">{sound}</span>
						{range(STEPS).map((s) => (
							<button
								type="button"
								value={`${r}-${s}`}
								data-sound={sound}
								data-step={String(s)}
								class={bind(`/shared/beat/${r}-${s}`, (on: boolean) =>
									on ? `step on r${r}` : "step")}
							/>
						))}
					</div>
				))}
				<div class="track">
					<span class="lbl" />
					{range(STEPS).map((s) => (
						<span
							data-step={String(s)}
							class={track(
								() => read("/shared/beat-step") === s ? "dot now" : "dot",
								undefined,
								"/shared/beat-step",
							)}
						/>
					))}
				</div>
			</div>
		</section>
	)
}

function stickers(): Child {
	return (
		<section>
			<h2>sticker page</h2>
			<p class="row">
				{STICKERS.map((s) => (
					<button
						type="button"
						class={bind("sticker", (held: string) => held === s ? "pick on" : "pick")}
						onClick={handler("on/sticker", [s])}
					>
						{s}
					</button>
				))}
			</p>
			<div
				class="board"
				// its size, for a page with no script (nothing measures it there)
				data-ermine-size="640x220"
				onClick={handler("on/stick", (e: Ev) => {
					const { offsetX: x, offsetY: y } = e
					const { clientWidth: w, clientHeight: h } = e.currentTarget
					return x !== undefined && y !== undefined && w && h ? [x / w, y / h] : undefined
				})}
			>
				{under("/shared/stickers", (item) => (
					<span
						class="sticker"
						style={bind(
							item.at,
							(v: { x: number; y: number }) => `left:${percent(v.x)};top:${percent(v.y)}`,
						)}
						title={bind(item.at, (v: { by: string }) => `stuck by ${said(nameOf(v.by))}`)}
					>
						{bind(item.at, (v: { s: string }) => v.s)}
					</span>
				))}
			</div>
		</section>
	)
}

function pet(): Child {
	return (
		<section>
			<h2>the pet</h2>
			<p class="pet">
				<span class="hamster">🐹</span> pip{" "}
				<span class="bar">
					{bind("/shared/pet/hunger", (h: number) => "▮".repeat(h) + "▯".repeat(HUNGRY - h))}
				</span>{" "}
				{bind("/shared/pet/hunger", (h: number) => MOODS.find(([at]) => h >= at)![1])}
			</p>
			<p class="row">
				<button type="button" onClick={handler("on/feed")}>feed</button>{" "}
				<button type="button" onClick={handler("on/pat")}>pat</button>{" "}
				<span class="hearts">
					{bind("/shared/pet/pats", (n: number) => "♥".repeat(Math.min(n, HEARTS_SHOWN)))}
				</span>
			</p>
			<p class="muted">
				{track(() => {
					const fed = read("/shared/pet/fed") as string | null
					const patted = read("/shared/pet/patted") as string | null
					return [
						fed ? `last fed by ${said(nameOf(fed))}` : "nobody has fed pip yet",
						patted ? `last patted by ${said(nameOf(patted))}` : "",
					].filter(Boolean).join(" · ")
				})}
			</p>
		</section>
	)
}

// the fortune ball: its window binds the visitor's answer, an async compute; while it is pending
// the window's binding says data-ermine-waiting, and the ball shakes
function fortune(): Child {
	return (
		<section>
			<h2>the fortune ball</h2>
			<p class="ball">
				<span class="window">
					{bind("answer", (a: string | null) => a ?? "ask me something")}
				</span>
			</p>
			<p class="muted">
				{track(() => {
					const asked = read("/shared/fortune") as Asked | null
					return asked ? `${said(nameOf(asked.by))} asked: ${asked.q}` : "nobody has asked yet"
				})}
			</p>
			<form class="row" onSubmit={handler("on/ask", (e: Ev) => [e.target.elements?.q?.value])}>
				<input
					name="q"
					autocomplete="off"
					maxLength={QUESTION_LONGEST}
					placeholder="a yes or no question"
				/>{" "}
				<button type="submit">shake</button>
			</form>
		</section>
	)
}

function card(): Child {
	return (
		<section>
			<h2>birthday card</h2>
			<div class="card">
				<p class="to">happy birthday, little ermine 🎂</p>
				<ul class="sigs">
					{under(
						"/shared/card",
						(item) => (
							<li>
								{bind(
									item.at,
									(v: { name: string; flower: string }) => `${v.flower} ${v.name}`,
								)}
							</li>
						),
					)}
				</ul>
			</div>
			<form
				class="row"
				onSubmit={handler("on/sign", (e: Ev) => [e.target.elements?.name?.value])}
			>
				<input name="name" autocomplete="off" maxLength={24} placeholder="your name" />{" "}
				<button type="submit">sign</button>
			</form>
		</section>
	)
}

function pigs(): Child {
	const pen = (p: "a" | "b") => (
		<div class="pen">
			<h3>pen {p}</h3>
			<ul>
				{under(`/shared/pens/${p}`, (item) => (
					<li>
						{bind(item.at, (v: { name: string; shame: number; shamedBy: string | null }) =>
							`🐷 ${v.name}${
								v.shame ? " " + "😳".repeat(Math.min(v.shame, SHAMES_SHOWN)) : ""
							}` +
							(v.shamedBy ? `, shamed by ${said(nameOf(v.shamedBy))}` : ""))}{" "}
						<button type="button" onClick={handler("on/carry", [p, item.name])}>
							{p === "a" ? "carry →" : "← carry"}
						</button>{" "}
						<button type="button" onClick={handler("on/shame", [p, item.name])}>shame</button>
						{" "}
						<button type="button" onClick={handler("on/bin", [p, item.name])}>bin</button>
					</li>
				))}
			</ul>
		</div>
	)
	return (
		<section>
			<h2>pigs</h2>
			<p class="row">
				<button type="button" onClick={handler("on/pig")}>add a pig</button>{" "}
				<span class="muted">
					carrying a pig is a rename from one pen's folder to the other's
				</span>
			</p>
			<div class="pens">
				{pen("a")}
				{pen("b")}
			</div>
		</section>
	)
}
