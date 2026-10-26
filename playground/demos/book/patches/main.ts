/// <reference lib="dom" />
// where a write lands: the pond's value as a little tree you aim at, a note (a patch) you fill
// and post, the real apply landing it and the real invert writing its undo note, and the pond
// drawn from the value. what the note touched flashes in the tree and in the picture
import apply, { ApplyError, type Code, type Key, type Patch, type Target } from "@ermine/core/op/apply"
import invert from "@ermine/core/op/invert"
import { pondPage } from "../kit/page.ts"
import type { Box } from "../kit/board.ts"
import { createPond, icon, type SpriteName } from "../kit/sprites.ts"

const page = pondPage("patches", {
	say:
		`<p>A change to the pond is a <b>patch</b>: a note saying where (a <b>path</b>, maybe a <b>range</b>) and what to put there. No value means remove.</p>
		<p><code>apply</code> lands it and gives a new value; what the note didn't touch is shared with the old one. A note that doesn't fit bounces, and nothing changes. Every note that lands leaves an <b>undo</b> note.</p>`,
	tries: [
		{ id: "letters", text: "Drag across letters on the sign, write something, post the note." },
		{ id: "rename", text: "Rename a fish. Watch its tag in the pond." },
		{ id: "move", text: "Drag a fish by its picture to another place in the list, and post." },
		{ id: "refuse", text: "Post a note that bounces." },
		{ id: "redo", text: "Post the top undo note, then post its undo." },
	],
	rules:
		`<p><b>path:</b> keys from the top of the value. Names go into maps, numbers into lists.</p>
		<p><b>put, remove, move:</b> a value is put at the spot. No value: what's there is removed. A move names another spot and takes what's there to here. Never a value and a move both.</p>
		<p><b>range:</b> <code>[3, 5]</code> covers positions 3 and 4, not 5. <code>[3, 3]</code> is the spot just before 3: a put there inserts. Strings and lists take ranges (typed arrays too; bytes never).</p>
		<p><b>code points:</b> a string's positions count code points, not JavaScript's units.</p>
		<p><b>maps and lists:</b> a put at a missing map key adds it; removing a missing key does nothing. A list index past the end is <code>no-key</code>; to add to a list, put a list into an empty range. Removing a list item closes the gap.</p>
		<p><b>sharing:</b> the old value never changes. What the patch touched is new; the rest is the very same objects.</p>
		<p><b>refused:</b> a bad patch throws an <code>ApplyError</code> with a code, and nothing changes.</p>
		<p><b>undo:</b> every apply can build its undo. Applying it takes the change back. The undo has its own undo.</p>
		<p><b>key order:</b> isn't part of a map. A key put back may land anywhere among the others.</p>`,
	real:
		`Runs the real <code>apply</code> (<code>@ermine/core/op/apply</code>) for every note posted, and <code>invert</code> (<code>@ermine/core/op/invert</code>) for every undo note. The page draws the tree, the note and the pond, reads what you write (JSON, else a string), pins a reason to each refusal code, and marks shared and new by checking each object against the value before.`,
})
const { board } = page

const esc = (s: string) =>
	s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const pk = (path: readonly Key[]) => JSON.stringify(path)
const same = (a: readonly Key[], b: readonly Key[]) =>
	a.length === b.length && a.every((k, i) => k === b[i])
const isList = Array.isArray
const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !isList(v)
const points = (s: string) => Array.from(s)
const MISSING = Symbol("missing")
function at(v: unknown, path: readonly Key[]): unknown {
	for (const k of path) {
		if (isList(v) && typeof k === "number" && k < v.length) v = v[k]
		else if (isMap(v) && typeof k === "string" && Object.hasOwn(v, k)) v = v[k]
		else return MISSING
	}
	return v
}
function objects(v: unknown, into = new WeakSet<object>()): WeakSet<object> {
	if (v !== null && typeof v === "object") {
		into.add(v)
		for (const x of Object.values(v)) objects(x, into)
	}
	return into
}

// ---- the state -------------------------------------------------------------------------------
const start = () => ({
	sign: "no fishing",
	fish: [{ name: "goldie", size: 2 }, { name: "pip", size: 1 }, { name: "big al", size: 4 }],
	weather: { rain: 0 },
})
type Card = { patches: Patch[] }
let value: unknown = start()
let before: WeakSet<object> | null = null
let litPaths = new Set<string>()
let litCells = new Map<string, [number, number]>()
let hotFish = new Set<number>()
let note: Record<string, unknown> = { path: ["sign"], range: [3, 10], value: "swimming" }
let valueText = "swimming"
let bounce: { code: Code; why: string } | null = null
let undos: Card[] = []
let redos: Card[] = []
let pushed: "undo" | "redo" | null = null
let preview: Target | null = null
let drop: Target | null = null

const targetOf = (p: Record<string, unknown>): Target => {
	const t: Target = { path: (isList(p.path) ? p.path : []) as Key[] }
	if (isList(p.range)) t.range = p.range as [number, number]
	return t
}
const fromOf = (p: Record<string, unknown>): Target | null =>
	isMap(p.move) ? targetOf(p.move as Record<string, unknown>) : null
const kindOf = (p: Record<string, unknown>) =>
	"move" in p ? "move" : "value" in p ? "put" : "remove"
const pathText = (path: readonly Key[]) => path.length ? path.join("/") : "the whole value"
const rangeText = (r?: readonly number[]) => r ? ` [${r.join(", ")}]` : ""
function show(v: unknown, max = 28): string {
	const s = JSON.stringify(v) ?? "undefined"
	return s.length > max ? s.slice(0, max - 1) + "…" : s
}
function describe(p: Patch): string {
	const where = pathText(p.path) + rangeText(p.range)
	if (p.move) return `move ${pathText(p.move.path)}${rangeText(p.move.range)} to ${where}`
	if ("value" in p) return `put ${show(p.value)} at ${where}`
	return `remove ${where}`
}
function readValue(t: string): { v: unknown; json: boolean } {
	try {
		return { v: JSON.parse(t), json: true }
	} catch {
		return { v: t, json: false }
	}
}
const textOf = (v: unknown) =>
	typeof v === "string" && !readValue(v).json ? v : JSON.stringify(v) ?? ""
function kindName(v: unknown): string {
	if (typeof v === "string") return v === "" ? "an empty string" : "a string"
	if (typeof v === "number") return "a number"
	if (typeof v === "boolean") return "true or false"
	if (v === null) return "null"
	return isList(v) ? "a list" : "a map"
}

// ---- the boxes ---------------------------------------------------------------------------------
const tree = board.box({
	id: "value",
	x: 0,
	y: 0,
	title: "the value",
	kind: "key",
	outs: [["out", ""]],
	width: 350,
})
tree.code(`let value = {
  sign: "no fishing",
  fish: [
    { name: "goldie", size: 2 },
    { name: "pip", size: 1 },
    { name: "big al", size: 4 },
  ],
  weather: { rain: 0 },
}`)
const noteBox = board.box({
	id: "note",
	x: 30,
	y: 380,
	title: "a note",
	kind: "note",
	outs: [["out", ""]],
	width: 290,
})
noteBox.el.classList.add("pt-note")
const applyBox = board.box({
	id: "apply",
	x: 410,
	y: 300,
	title: "apply",
	kind: "compute",
	ins: ["value", "note"],
	outs: [["new", "new value"], ["undo", "undo"]],
})
applyBox.code(`import apply from "@ermine/core/op/apply"

// the note lands on the value:
// a new value. what the note touched
// is new; the rest is shared
const next = apply(value, [note])

// a bad note throws an ApplyError
// (e.code), and value is unchanged
value = next`)
const pondBox = board.box({
	id: "pond",
	x: 700,
	y: 0,
	title: "the pond",
	kind: "picture",
	ins: [["value", ""]],
})
pondBox.code(`// drawn from the value, every time
// it changes
pond.draw({
  sign: value.sign,
  named: value.fish.map((f) => ({
    name: f.name,
    kind: f.size >= 4 ? "pike"
      : f.size >= 2 ? "fish" : "minnow",
  })),
  rain: value.weather.rain / 3,
})`)
const pileBox = board.box({
	id: "undo",
	x: 730,
	y: 360,
	title: "undo notes",
	kind: "note",
	ins: [["in", ""]],
	width: 340,
})
pileBox.code(`import invert from "@ermine/core/op/invert"

// the note's undo, before it lands
const undo = invert(value, [note])

// posting the undo is apply(value, undo).
// that has an undo too: the redo pile`)
const oddBox = board.box({
	id: "odd",
	x: 380,
	y: 520,
	title: "odd notes",
	kind: "note",
	width: 230,
})

const wValue = board.wire(tree.port("out"), applyBox.port("value"))
const wNote = board.wire(noteBox.port("out"), applyBox.port("note"))
const wNew = board.wire(applyBox.port("new"), pondBox.port("value"))
const wUndo = board.wire(applyBox.port("undo"), pileBox.port("in"))
wValue.label("pond value")

// the pond picture, with its sign on top
const wrap = document.createElement("div")
wrap.className = "pt-pondwrap"
const canvas = document.createElement("canvas")
const sign = document.createElement("div")
sign.className = "pt-sign"
wrap.append(canvas, sign)
pondBox.body.append(wrap)
const pond = createPond(canvas, { width: 240, height: 140 })

applyBox.body.innerHTML = `<div class="pt-applied">waiting for a note</div>`

const BADS: [Code, Patch][] = [
	["no-key", { path: ["fish", 7, "name"], value: "nemo" }],
	["range", { path: ["sign"], range: [4, 40], value: "x" }],
	["wrong-kind", { path: ["weather", "rain", "drops"], value: 9 }],
	["into-itself", { path: ["fish", 0, "friend"], move: { path: ["fish", 0] } }],
	["not-a-patch", { path: ["sign"], value: "hi", move: { path: ["fish"] } } as unknown as Patch],
]
oddBox.body.innerHTML =
	`<div class="small" style="margin-bottom:6px">each puts a note that won't fit on the paper</div><div class="pt-odd">${
		BADS.map(([c], i) => `<button class="chip" data-bad="${i}">${c}</button>`).join("")
	}</div>`
oddBox.body.onclick = (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bad]")
	if (!b) return
	const p = BADS[+b.dataset.bad!][1] as unknown as Record<string, unknown>
	setNote({ ...p })
	noteBox.flash("pick")
	page.say(`An odd note is on the paper. Post it and see.`)
}

// a plain reason for each code, from what apply checks
const WHY: Record<Code, string> = {
	"not-a-patch":
		"This isn't shaped like a patch: a path, maybe a range, then a value or a move or neither, never both.",
	"no-key":
		"Nothing is there to go into: a key on the path is missing, or a list index is past the end.",
	"range": "The range doesn't fit: it runs past the end, or starts after it ends.",
	"wrong-kind":
		"Wrong kind of thing: a name into a list, a number into a map, a path into a string or number, or a range on (or of) the wrong kind.",
	"into-itself": "A thing can't move to a spot inside itself.",
}

// ---- drawing the tree ------------------------------------------------------------------------------
const fishImg = icon("fish", 2).toDataURL()
function mark(v: unknown) {
	if (!before || v === null || typeof v !== "object") return ""
	return before.has(v) ? "shared" : "new"
}
function seqSel(path: readonly Key[], t: Target | null) {
	return t && t.range && same(t.path, path) ? t.range : null
}
function key(label: string, path: Key[]) {
	const t = preview ?? targetOf(note), f = fromOf(note)
	const c = ["pt-k"]
	if (!t.range && same(t.path, path)) c.push("aim")
	else if (f && !f.range && same(f.path, path)) c.push("from")
	if (drop && !drop.range && same(drop.path, path)) c.push("drop")
	return `<span class="${c.join(" ")}" tabindex="0" data-key data-p='${
		esc(pk(path))
	}' title="click to aim the note here; drag to move it">${esc(label)}</span>`
}
function gapsAndCells(
	path: Key[],
	n: number,
	cell: (i: number, cls: string) => string,
	gapCls = "pt-gap",
) {
	const t = preview ?? targetOf(note), f = fromOf(note)
	const sel = seqSel(path, t), from = seqSel(path, f)
	const dr = drop && drop.range && same(drop.path, path) ? drop.range[0] : -1
	const gap = (g: number) => {
		const c = [gapCls]
		if (sel && sel[0] === sel[1] && sel[0] === g) c.push("aim")
		if (from && from[0] === from[1] && from[0] === g) c.push("from")
		if (dr === g) c.push("drop")
		return `<span class="${c.join(" ")}" data-g="${g}" title="position ${g}"></span>`
	}
	let h = ""
	for (let i = 0; i < n; i++) {
		const c: string[] = []
		if (sel && i >= sel[0] && i < sel[1]) c.push("aim")
		if (from && i >= from[0] && i < from[1]) c.push("from")
		h += gap(i) + cell(i, c.join(" "))
	}
	return h + gap(n)
}
// a leaf: letters for a string, a chip for the rest
function leaf(v: unknown, path: Key[]): string {
	const p = pk(path)
	if (typeof v === "string") {
		const cs = points(v), lit = litCells.get(p)
		return `<span class="pt-letters" data-seq='${
			esc(p)
		}' title="drag across letters for a range">${
			gapsAndCells(path, cs.length, (i, c) =>
				`<span class="pt-c ${c}${cs[i] === " " ? " space" : ""}${
					lit && i >= lit[0] && i < lit[1] ? " lit" : ""
				}" data-i="${i}">${cs[i] === " " ? "␣" : esc(cs[i])}</span>`)
		}</span>`
	}
	const t = preview ?? targetOf(note)
	const c = ["pt-leaf"]
	if (!t.range && same(t.path, path)) c.push("aim")
	if (drop && !drop.range && same(drop.path, path)) c.push("drop")
	return `<span class="${c.join(" ")}" data-key data-p='${esc(p)}'>${
		esc(JSON.stringify(v))
	}</span>`
}
const container = (v: unknown) => v !== null && typeof v === "object"
// what's inside a map or list, as rows
function inside(v: unknown, path: Key[]): string {
	if (isList(v)) {
		return `<div class="pt-items" data-seq='${esc(pk(path))}'>${
			gapsAndCells(path, v.length, (i, c) => {
				const x = v[i], ip = [...path, i]
				const fishy = isMap(x) && "name" in x
				const flat = isMap(x) && Object.values(x).every((y) => !container(y))
				const grip = `<span class="pt-grip" data-key data-p='${
					esc(pk(ip))
				}' title="drag to move this item">${
					fishy ? `<img src="${fishImg}" alt="" width="24" height="14">` : "⋮⋮"
				}</span>`
				const idx =
					`<span class="pt-i ${c}" data-i="${i}" title="index ${i}: click or drag across for a range">${i}</span>`
				const lit = litPaths.has(pk(ip)) ? " moved" : ""
				let body: string
				if (flat) {
					body = `<div class="pt-row pt-flat">${
						Object.entries(x as Record<string, unknown>).map(([k, y]) =>
							`<span class="pt-row${litPaths.has(pk([...ip, k])) ? " lit" : ""}">${
								key(k, [...ip, k])
							}${leaf(y, [...ip, k])}</span>`
						).join("")
					}${ghosts(x, ip)}</div>`
				} else if (container(x)) body = `<div class="pt-in ${mark(x)}">${inside(x, ip)}</div>`
				else body = leaf(x, ip)
				return `<div class="pt-item ${mark(x)}${lit}" data-p='${
					esc(pk(ip))
				}'>${grip}${idx}${body}</div>`
			})
		}</div>`
	}
	if (isMap(v)) {
		let h = ""
		for (const [k, x] of Object.entries(v)) {
			const kp = [...path, k]
			const lit = litPaths.has(pk(kp)) ? " lit" : ""
			if (container(x)) {
				h += `<div class="pt-row${lit}">${key(k, kp)}<span class="pt-kind">${
					isList(x) ? `list of ${x.length}` : "map"
				}</span></div><div class="pt-in ${mark(x)}">${inside(x, kp)}</div>`
			} else h += `<div class="pt-row${lit}">${key(k, kp)}${leaf(x, kp)}</div>`
		}
		return h + ghosts(v, path)
	}
	return leaf(v, path)
}
// a key the note aims at that isn't there yet
function ghosts(v: unknown, path: Key[]): string {
	if (!isMap(v)) return ""
	const t = targetOf(note)
	if (t.range || t.path.length !== path.length + 1 || !same(t.path.slice(0, -1), path)) return ""
	const k = t.path[path.length]
	if (typeof k !== "string" || Object.hasOwn(v, k)) return ""
	return `<span class="pt-ghost">${esc(k)}: nothing yet</span>`
}
function drawTree() {
	const a = document.activeElement as HTMLElement | null
	const keep = a && tree.body.contains(a) ? a.dataset.p : undefined
	tree.body.innerHTML = `<div class="pt-tree">
		<div class="pt-row">${key("value", [])}<span class="pt-kind">${
		isMap(value) ? "map" : kindName(value)
	}</span></div>
		<div class="pt-in ${mark(value)}">${
		container(value) ? inside(value, []) : leaf(value, [])
	}</div>
		<div class="pt-legend"><span><i style="background:var(--stem)"></i>shared with before</span><span><i style="background:var(--cherry)"></i>new from the last note</span></div>
	</div>`
	if (keep) {
		;[...tree.body.querySelectorAll<HTMLElement>(".pt-k")].find((e) => e.dataset.p === keep)
			?.focus()
	}
}

// ---- the pond picture ------------------------------------------------------------------------------
function kindFor(size: unknown): SpriteName {
	const n = typeof size === "number" ? size : 2
	return n >= 4 ? "pike" : n >= 2 ? "fish" : "minnow"
}
const SPOTS = [[0.12, 0.2], [0.55, 0.15], [0.35, 0.55], [0.8, 0.5], [0.6, 0.85], [0.15, 0.6]]
function drawPond() {
	const v = isMap(value) ? value : {}
	const fish = isList(v.fish) ? v.fish : []
	const named = fish.flatMap((f, i) => {
		if (!isMap(f)) return []
		const [x, y] = SPOTS[i % SPOTS.length]
		return [{
			name: String(f.name ?? "?"),
			kind: kindFor(f.size),
			x: Math.min(0.95, x + Math.floor(i / SPOTS.length) * 0.07),
			y,
			tone: hotFish.has(i) ? "hot" as const : undefined,
		}]
	})
	const w = isMap(v.weather) ? v.weather : {}
	const rain = typeof w.rain === "number" ? Math.max(0, Math.min(1, w.rain / 3)) : 0
	pond.draw({ named, rain, lilies: 3 })
	const s = v.sign
	if (s === undefined) sign.hidden = true
	else {
		sign.hidden = false
		const text = typeof s === "string" ? s : JSON.stringify(s)
		const lit = typeof s === "string" ? litCells.get(pk(["sign"])) : undefined
		const all = !lit && litPaths.has(pk(["sign"]))
		sign.innerHTML = `<div class="board-text">${
			points(text).map((c, i) =>
				`<span class="${all || (lit && i >= lit[0] && i < lit[1]) ? "lit" : ""}">${
					esc(c)
				}</span>`
			).join("") || " "
		}</div><div class="post"></div>`
	}
}

// ---- the note ------------------------------------------------------------------------------------
noteBox.body.innerHTML = `<div class="pt-paper">
	<div class="pt-line"><span class="w">at</span><span class="pt-aim"></span></div>
	<div class="pt-line pt-fromline"><span class="w">from</span><span class="pt-from"></span></div>
	<div class="chips pt-kinds"><button class="chip" data-kind="put">put</button><button class="chip" data-kind="remove">remove</button><button class="chip" data-kind="move" disabled title="drag something in the tree to make a move">move</button></div>
	<div class="pt-valrow"><input aria-label="what to put" placeholder="what to put"><div class="pt-reads"></div></div>
	<div class="pt-post"><span class="small">drag me onto the pond, or</span><button class="b go">post</button></div>
	<div class="pt-bounce" hidden></div>
</div>`
const nb = noteBox.body
const input = nb.querySelector("input")!
function chips(path: readonly Key[]) {
	if (!path.length) return `<span class="pt-chip none">the whole value</span>`
	return path.map((k) => `<span class="pt-chip">${esc(JSON.stringify(k))}</span>`).join("")
}
function drawNote() {
	const t = targetOf(note), f = fromOf(note), k = kindOf(note)
	nb.querySelector(".pt-aim")!.innerHTML = chips(t.path) +
		(t.range ? ` <span class="small">range [${t.range.join(", ")}]</span>` : "")
	nb.querySelector<HTMLElement>(".pt-fromline")!.hidden = !f
	if (f) {
		nb.querySelector(".pt-from")!.innerHTML = chips(f.path) +
			(f.range ? ` <span class="small">range [${f.range.join(", ")}]</span>` : "")
	}
	for (const b of nb.querySelectorAll<HTMLElement>("[data-kind]")) {
		b.setAttribute("aria-pressed", String(b.dataset.kind === k))
	}
	nb.querySelector<HTMLElement>(".pt-valrow")!.hidden = k !== "put"
	if (document.activeElement !== input) input.value = valueText
	const r = readValue(valueText)
	nb.querySelector(".pt-reads")!.textContent = r.json
		? `reads as ${kindName(r.v)}`
		: `not JSON, so ${kindName(r.v)}`
	const bx = nb.querySelector<HTMLElement>(".pt-bounce")!
	bx.hidden = !bounce
	if (bounce) bx.innerHTML = `<b>${bounce.code}</b> ${bounce.why}`
	noteBox.badge(bounce ? "bounced" : "", "hot")
	noteBox.tone(bounce ? "hot" : undefined)
	wNote.label(kindOf(note))
	wNote.tone(bounce ? "hot" : undefined)
}
function setNote(p: Record<string, unknown>) {
	note = p
	bounce = null
	if ("value" in p) valueText = textOf(p.value)
	drawAll()
}
function aim(t: Target) {
	const k = kindOf(note)
	const p: Record<string, unknown> = { path: t.path }
	if (t.range) p.range = t.range
	if (k === "put") {
		// into a list's empty range, a list: suggest one
		const there = at(value, t.path)
		if (t.range && isList(there) && !isList(readValue(valueText).v)) {
			valueText = `[{"name": "dot", "size": 1}]`
		}
		if (t.range && typeof there === "string" && typeof readValue(valueText).v !== "string") {
			valueText = "ducks"
		}
		p.value = readValue(valueText).v
	}
	if (k === "move") p.move = note.move
	setNote(p)
}
nb.addEventListener("click", (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]")
	if (b) {
		const t = targetOf(note)
		const p: Record<string, unknown> = { path: t.path }
		if (t.range) p.range = t.range
		if (b.dataset.kind === "put") p.value = readValue(valueText).v
		setNote(p)
	}
	if ((e.target as HTMLElement).closest(".b.go")) post()
})
input.oninput = () => {
	valueText = input.value
	const t = targetOf(note)
	const p: Record<string, unknown> = { path: t.path }
	if (t.range) p.range = t.range
	p.value = readValue(valueText).v
	note = p
	bounce = null
	drawNote()
	noteBox.code(noteCode())
}
input.onkeydown = (e) => {
	if (e.key === "Enter") post()
}
const noteCode = () =>
	`// a note is a patch: plain data\nconst note = ${JSON.stringify(note, null, 2)}`

// ---- posting: the real apply, the real invert -----------------------------------------------------
function post() {
	run([note as unknown as Patch], "note")
}
function run(patches: Patch[], why: "note" | "undo" | "redo") {
	const old = value
	let undo: Patch[], next: unknown
	try {
		// invert is apply with its undo option: the same refusals
		undo = invert(old, patches)
		next = apply(old, patches)
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		before = objects(value)
		litPaths = new Set()
		litCells = new Map()
		if (why === "note") bounce = { code: e.code, why: WHY[e.code] + stopOf(e.code, patches[0]) }
		applyBox.body.innerHTML =
			`<div class="pt-applied"><span class="bad">${e.code}</span><br>nothing changed</div>`
		applyBox.flash("hot")
		noteBox.flash("hot")
		wNote.flash("hot")
		page.tick("refuse")
		page.say(
			`The note bounced: <code>${e.code}</code>. Nothing changed; the pond value is the very same object.`,
			"hot",
		)
		return drawAll()
	}
	bounce = null
	before = objects(old)
	value = next
	lights(old, next)
	pushed = null
	if (why === "undo") {
		undos.shift()
		if (undo.length) redos.unshift({ patches: undo }), pushed = "redo"
	} else {
		if (why === "redo") redos.shift()
		else redos = []
		if (undo.length) undos.unshift({ patches: undo }), pushed = "undo"
	}
	ticks(patches, old, next, why)
	// the words
	let made = 0, kept = 0
	const count = (v: unknown) => {
		if (v === null || typeof v !== "object") return
		before!.has(v) ? kept++ : made++
		for (const x of Object.values(v)) count(x)
	}
	count(next)
	applyBox.body.innerHTML = next === old
		? `<div class="pt-applied">nothing to do<br><span class="small">the very same value</span></div>`
		: `<div class="pt-applied">${made} new<br>${kept} shared</div>`
	applyBox.flash("hot")
	wNew.flash("hot")
	pondBox.flash("hot")
	wNew.label(next === old ? "the same value" : "new value")
	if (undo.length) {
		wUndo.flash("hot")
		wUndo.label("undo")
	}
	const what = why === "note"
		? "The note landed"
		: why === "undo"
		? "The undo landed"
		: "The redo landed"
	if (next === old) {
		page.say(`Nothing to do: apply gave back the very same value, so there's no undo note.`)
	} else {
		const top = isMap(next) && isMap(old)
			? Object.keys(old).filter((k) =>
				Object.hasOwn(next as object, k) && container(old[k]) &&
				(next as Record<string, unknown>)[k] === old[k]
			)
			: []
		page.say(
			`${what}: ${made} new ${made === 1 ? "object" : "objects"}${
				top.length
					? `, and ${top.map((k) => `<code>${k}</code>`).join(" and ")} ${
						top.length === 1 ? "is" : "are"
					} the very same as before`
					: ""
			}.${why === "undo" ? " Its own undo went on the redo pile." : ""}`,
			"ok",
		)
	}
	if (hotFish.size) setTimeout(() => (hotFish = new Set(), drawPond()), 1800)
	drawAll(true)
}
// for no-key: how far the path got, by the page's own walk
function stopOf(code: Code, p: Patch): string {
	if (code !== "no-key" || !p || !isList(p.path)) return ""
	const path = p.move && at(value, p.move.path) === MISSING ? p.move.path : p.path
	for (let n = path.length - 1; n >= 0; n--) {
		if (at(value, path.slice(0, n)) !== MISSING) {
			return ` Here: <code>${esc(pathText(path.slice(0, n)))}</code> has no <code>${
				esc(JSON.stringify(path[n]))
			}</code>.`
		}
	}
	return ""
}
// what to flash: leaves that changed, letters put in, containers new at a path
function lights(old: unknown, now: unknown) {
	litPaths = new Set()
	litCells = new Map()
	hotFish = new Set()
	const hit = (path: Key[]) => {
		if (path[0] === "fish" && typeof path[1] === "number") hotFish.add(path[1])
	}
	const walk = (v: unknown, path: Key[]) => {
		const was = at(old, path)
		if (typeof v === "string") {
			if (typeof was !== "string") litCells.set(pk(path), [0, points(v).length]), hit(path)
			else if (was !== v) {
				const a = points(was), b = points(v)
				let i = 0
				while (i < a.length && i < b.length && a[i] === b[i]) i++
				let j = 0
				while (
					j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]
				) j++
				if (b.length - j > i) litCells.set(pk(path), [i, b.length - j])
				else litPaths.add(pk(path))
				hit(path)
			}
			return
		}
		if (v === null || typeof v !== "object") {
			if (!Object.is(was, v)) litPaths.add(pk(path)), hit(path)
			return
		}
		if (was !== v && (was === MISSING || before!.has(v))) litPaths.add(pk(path)), hit(path)
		if (isList(v)) v.forEach((x, i) => walk(x, [...path, i]))
		else for (const [k, x] of Object.entries(v)) walk(x, [...path, k])
	}
	walk(now, [])
}
function ticks(patches: Patch[], old: unknown, now: unknown, why: string) {
	if (now === old) return
	for (const p of patches) {
		const there = at(old, p.path)
		if (
			why === "note" && typeof there === "string" && p.range && "value" in p &&
			p.path[0] === "sign"
		) {
			page.tick("letters")
		}
		if (
			why === "note" && p.path[0] === "fish" && p.path[2] === "name" && ("value" in p || p.move)
		) page.tick("rename")
		if (why === "note" && p.move && p.move.path[0] === "fish") page.tick("move")
	}
	if (why === "undo") undid = true
	if (why === "redo" && undid) page.tick("redo")
}
let undid = false

// ---- the undo piles ----------------------------------------------------------------------------------
pileBox.body.innerHTML = `<div class="pt-piles">
	<div><div class="lab small">undo</div><div class="pt-pile" data-pile="undo"></div></div>
	<div><div class="lab small">redo: the undo's undo</div><div class="pt-pile" data-pile="redo"></div></div>
</div>`
function drawPiles(flash: boolean) {
	for (const which of ["undo", "redo"] as const) {
		const list = which === "undo" ? undos : redos
		const el = pileBox.body.querySelector<HTMLElement>(`[data-pile="${which}"]`)!
		if (!list.length) {
			el.innerHTML = `<div class="pt-empty">${
				which === "undo"
					? "post a note: its undo lands here"
					: "post an undo: its undo lands here"
			}</div>`
			el.style.minHeight = ""
			continue
		}
		const shown = list.slice(0, 4).reverse()
		el.innerHTML = shown.map((c, j) => {
			const top = j === shown.length - 1, d = shown.length - 1 - j
			const text = c.patches.map(describe).map(esc).join("<br>then ")
			return top
				? `<button class="pt-card${
					flash && pushed === which ? " flash" : ""
				}" data-card="${which}" style="top:${
					d * 4
				}px" title="post this note">${text}<span class="go">click to post · ${list.length} in the pile</span></button>`
				: `<div class="pt-card" style="top:${(shown.length - 1 - j) * 4}px;left:${
					d * 3
				}px;right:${-d * 3}px;transform:rotate(${d % 2 ? 1.5 : -1.2}deg)"></div>`
		}).join("")
		el.style.minHeight = `${74 + Math.min(3, list.length - 1) * 4}px`
	}
}
pileBox.body.addEventListener("click", (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>("[data-card]")
	if (!c) return
	const which = c.dataset.card as "undo" | "redo"
	const list = which === "undo" ? undos : redos
	if (list[0]) run(list[0].patches, which)
})

function drawAll(flash = false) {
	drawTree()
	drawNote()
	noteBox.code(noteCode())
	drawPond()
	drawPiles(flash)
	if (flash) {
		litPaths = new Set()
		litCells = new Map()
	}
	board.redraw()
}

// ---- pointing at the tree: click to aim, drag across letters or index numbers for a range, drag a
// key or a fish to move it -------------------------------------------------------------------------
type Drag = {
	mode: "select" | "move"
	x: number
	y: number
	moved: boolean
	seq?: Key[]
	lo?: number
	hi?: number
	from?: Target
	cell?: number
}
let drag: Drag | null = null
const ghost = document.createElement("div")
ghost.className = "wire-label"
ghost.style.cssText = "position:fixed;z-index:20;pointer-events:none"
ghost.hidden = true
document.body.append(ghost)
const pathOf = (el: Element) => JSON.parse((el as HTMLElement).dataset.p!) as Key[]
const seqOf = (el: Element) => {
	const s = el.closest<HTMLElement>("[data-seq]")
	return s ? JSON.parse(s.dataset.seq!) as Key[] : null
}
tree.body.addEventListener("pointerdown", (e) => {
	if (e.button !== 0) return
	const el = e.target as HTMLElement
	const base = { x: e.clientX, y: e.clientY, moved: false }
	const cell = el.closest<HTMLElement>("[data-i]"), gap = el.closest<HTMLElement>("[data-g]")
	const handle = el.closest<HTMLElement>("[data-key]")
	if (cell || gap) {
		const seq = seqOf((cell ?? gap)!)!
		const t = targetOf(note)
		if (cell) {
			const i = +cell.dataset.i!
			const r = t.range && same(t.path, seq) ? t.range : null
			if (r && i >= r[0] && i < r[1]) {
				drag = { ...base, mode: "move", from: { path: seq, range: r }, seq, cell: i }
			} else drag = { ...base, mode: "select", seq, lo: i, hi: i + 1 }
		} else drag = { ...base, mode: "select", seq, lo: +gap!.dataset.g!, hi: +gap!.dataset.g! }
		if (drag.mode === "select") {
			preview = { path: seq, range: [drag.lo!, drag.hi!] }
			drawTree()
		}
	} else if (handle) drag = { ...base, mode: "move", from: { path: pathOf(handle) } }
	else return
	e.preventDefault()
	e.stopPropagation()
})
function dropAt(x: number, y: number): Target | null {
	const el = document.elementFromPoint(x, y) as HTMLElement | null
	if (!el || !tree.body.contains(el)) return null
	const gap = el.closest<HTMLElement>("[data-g]")
	if (gap) return { path: seqOf(gap)!, range: [+gap.dataset.g!, +gap.dataset.g!] }
	const cell = el.closest<HTMLElement>("[data-i]")
	if (cell) {
		const r = cell.getBoundingClientRect(), i = +cell.dataset.i!
		const vertical = cell.classList.contains("pt-i")
		const g = (vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2) ? i : i + 1
		return { path: seqOf(cell)!, range: [g, g] }
	}
	const h = el.closest<HTMLElement>("[data-key]")
	return h ? { path: pathOf(h) } : null
}
addEventListener("pointermove", (e) => {
	if (!drag) return
	if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true
	if (!drag.moved) return
	if (drag.mode === "select") {
		const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
		const c = el?.closest<HTMLElement>("[data-i]"), g = el?.closest<HTMLElement>("[data-g]")
		const hit = c ?? g
		if (!hit || !same(seqOf(hit) ?? [], drag.seq!)) return
		const lo = c ? +c.dataset.i! : +g!.dataset.g!, hi = c ? lo + 1 : lo
		preview = { path: drag.seq!, range: [Math.min(drag.lo!, lo), Math.max(drag.hi!, hi)] }
		drawTree()
	} else {
		const f = drag.from!
		ghost.textContent = `move ${pathText(f.path)}${rangeText(f.range)}`
		ghost.hidden = false
		ghost.style.left = `${e.clientX + 12}px`
		ghost.style.top = `${e.clientY + 12}px`
		const d = dropAt(e.clientX, e.clientY)
		if (JSON.stringify(d) !== JSON.stringify(drop)) {
			drop = d
			drawTree()
		}
	}
})
addEventListener("pointerup", (e) => {
	const d = drag
	if (!d) return
	drag = null
	ghost.hidden = true
	if (d.mode === "select") {
		const t = preview!
		preview = null
		page.say(`The note now aims at <code>${pathText(t.path)}${rangeText(t.range)}</code>.`)
		return aim(t)
	}
	const to = d.moved ? dropAt(e.clientX, e.clientY) : null
	drop = null
	if (!d.moved) {
		const t = d.cell !== undefined
			? { path: d.seq!, range: [d.cell, d.cell + 1] as [number, number] }
			: { path: d.from!.path }
		page.say(`The note now aims at <code>${pathText(t.path)}${rangeText(t.range)}</code>.`)
		return aim(t)
	}
	if (!to) return drawTree()
	const p: Record<string, unknown> = { path: to.path }
	if (to.range) p.range = to.range
	p.move = d.from
	setNote(p)
	noteBox.flash("pick")
	page.say(
		`A move note: take <code>${pathText(d.from!.path)}${
			rangeText(d.from!.range)
		}</code> to <code>${pathText(to.path)}${rangeText(to.range)}</code>. Post it.`,
	)
})
tree.body.addEventListener("keydown", (e) => {
	const el = e.target as HTMLElement
	if ((e.key === "Enter" || e.key === " ") && el.dataset.key !== undefined) {
		e.preventDefault()
		aim({ path: pathOf(el) })
	}
})

// ---- dragging the note onto the pond posts it --------------------------------------------------------
const head = noteBox.el.querySelector<HTMLElement>(".box-head")!
let carrying: { x: number; y: number } | null = null
const over = () => {
	const a = noteBox.el.getBoundingClientRect()
	return [pondBox, applyBox].some((b) => {
		const r = b.el.getBoundingClientRect()
		const cx = a.left + a.width / 2, cy = a.top + 20
		return cx > r.left && cx < r.right && cy > r.top && cy < r.bottom
	})
}
head.addEventListener("pointerdown", (e) => {
	if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return
	carrying = noteBox.pos()
})
addEventListener("pointermove", () => {
	if (!carrying) return
	pondBox.tone(over() ? "pick" : undefined)
})
addEventListener("pointerup", () => {
	const home = carrying
	carrying = null
	if (!home) return
	pondBox.tone(undefined)
	if (!over()) return
	post()
	// back to where it was picked up: a bounce if it was refused
	noteBox.el.classList.add("sliding")
	noteBox.move(home.x, home.y)
	const until = performance.now() + 350
	const follow = () => {
		board.redraw()
		if (performance.now() < until) requestAnimationFrame(follow)
		else noteBox.el.classList.remove("sliding")
	}
	requestAnimationFrame(follow)
})

drawAll()
// on a narrow window the board gets the room: the notes start folded (the notes button opens them)
if (innerWidth < 1100) page.notes.querySelector<HTMLElement>(".fold")!.click()
requestAnimationFrame(() => board.fit())
page.say(`The note on the paper would change the sign. Drag it onto the pond, or press post.`)
