/// <reference lib="dom" />
// copies nobody sees: the pond's value is one real entry, written through the real unread. touch
// the pond to write; the value tree shows each container as a tile with a tag (a number the page
// gives an object the first time it sees it). same tag after a write: changed in place. a new
// tile, cherry: a copy. the camera reads the entry (unread.read) and the photo holds those very
// objects; the painter keeps one fish past its run (unread.kept). the page never looks inside
// unread: it sees only object identity
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import type { Patch } from "@ermine/op/apply"
import { createUnread } from "@ermine/unread"
import { pondPage } from "../kit/page.ts"
import type { Box, Wire } from "../kit/board.ts"
import { pixels, sprite, SPRITES } from "../kit/sprites.ts"

const page = pondPage("unread", {
	say:
		`<p>Every touch on the pond is a write to one entry. A write copies what it changes, unless it already owns it: a copy it made itself, that nobody has seen since. Those it changes in place.</p>
		<p>Take a photo and the entry is read. The photo holds those very objects, so the next write copies again. Each tile in the value tree has a tag: a new tag is a copy.</p>`,
	tries: [
		{ id: "feed", text: "Click a fish to feed it. Feed it again: nothing is copied." },
		{
			id: "photo",
			text: "Press the <b>camera</b>, then feed a fish. The photo stays; the write copies.",
		},
		{ id: "drag", text: "Drag a fish across the pond: many writes, hardly any copies." },
		{
			id: "new",
			text: "Add a fish, then feed it. It is copied: a patch's value is never owned.",
		},
		{
			id: "paint",
			text: "Have the <b>painter</b> paint one fish, then feed it. Only that fish is copied.",
		},
	],
	rules:
		`<p><b>copy:</b> a write copies what it changes that it doesn't own, only along its paths, and owns those copies.</p>
		<p><b>in place:</b> the next write changes owned copies where they are.</p>
		<p><b>read:</b> lets go of all of it. What the reader holds never changes under them. The next write copies again.</p>
		<p><b>cost:</b> a burst of writes with no read between costs one copy. A write between reads costs what copy-on-write does.</p>
		<p><b>never owned:</b> the value the entry started with, and a patch's value: those are the caller's. So the very first write copies. Nor what a write takes out: its undo holds it.</p>
		<p><b>kept:</b> for a computer's result held past its run. It lets go of the owned containers in just that value.</p>`,
	real:
		`Runs the real <code>@ermine/unread</code> (createUnread: update, read, kept) on an entry from <code>@ermine/node/entry</code>'s createEntry; <code>@ermine/op/apply</code> runs inside update. The tags (a WeakMap from object to number), the pictures, the patch each touch makes and the reasons in the caption are the page's own, worked out from its record of photos, paintings and patches; it never looks inside unread. Drawing the live pond is not a read: it looks and lets go.`,
})
const { board } = page

// ---- the value, the entry, unread -----------------------------------------------------------
type Fish = { name: string; size: number; x: number }
type PondValue = { sign: string; fish: Fish[]; lilies: { count: number } }
type Path = (string | number)[]
type Doc = Record<string, unknown>
const isMap = (v: unknown): v is Doc => v !== null && typeof v === "object" && !Array.isArray(v)
const isBox = (v: unknown): v is object => Array.isArray(v) || isMap(v)

const header = (): ChangeHeader => ({ time: Math.floor(Date.now() / 1000), actor: "you" })
const unread = createUnread()
const entry: Entry<unknown> = createEntry<unknown>(
	{
		sign: "pond",
		fish: [{ name: "ada", size: 2, x: 0.2 }, { name: "bo", size: 3, x: 0.55 }, {
			name: "cy",
			size: 1,
			x: 0.8,
		}],
		lilies: { count: 3 },
	} satisfies PondValue,
	header(),
)
const pond = () => entry.value as PondValue
const NAMES = ["dot", "eel", "fig", "gus", "hal", "ivy", "jo", "kit", "lu", "mo", "nan", "oz"]

// ---- the page's own record: tags, and where each container came from ------------------------
const tags = new WeakMap<object, number>()
let nextTag = 1
const tag = (o: object) => {
	let n = tags.get(o)
	if (n === undefined) tags.set(o, n = nextTag++)
	return n
}
// start: given to createEntry. copy: made by write `at`. put: came in write `at`'s patch.
// held: painted (kept) after write `held`
type Origin = { how: "start" | "copy" | "put"; at: number; held?: number }
const origin = new WeakMap<object, Origin>()
function boxes(v: unknown, path: Path = [], out: [Path, object][] = []): [Path, object][] {
	if (!isBox(v)) return out
	out.push([path, v])
	if (Array.isArray(v)) v.forEach((x, i) => boxes(x, [...path, i], out))
	else for (const k in v) boxes((v as Doc)[k], [...path, k], out)
	return out
}
for (const [, o] of boxes(entry.value)) tag(o), origin.set(o, { how: "start", at: 0 })

let writes = 0, copies = 0, cow = 0, lastRead = -1
type Did = { path: Path; kind: "same" | "copy"; was?: number; why?: Why }
type Why = "start" | "put" | "read" | "held" | "?"
let did: Did[] = []
let putNames: string[] = []

// why a container wasn't owned: what the page saw happen to it
function why(old: object | undefined): Why {
	const o = old && origin.get(old)
	if (!o) return "?"
	if (o.how === "start") return "start"
	if (o.how === "put") return "put"
	if (lastRead >= o.at) return "read"
	if (o.held !== undefined && o.held >= o.at) return "held"
	return "?"
}

// the containers a write goes through: the root and each along a patch's path (a span: the one
// it splices too). copy-on-write copies every one of them
function through(ps: readonly Patch[]): Path[] {
	const out: Path[] = []
	for (const p of ps) {
		const end = p.range ? p.path.length : p.path.length - 1
		for (let i = 0; i <= end; i++) out.push(p.path.slice(0, i) as Path)
	}
	return out
}
const get = (v: unknown, p: Path) =>
	p.reduce<unknown>((v, k) => (isBox(v) ? (v as Doc)[k as string] : undefined), v)

function write(what: string, patches: Patch[]) {
	const before = new Map(boxes(entry.value).map(([p, o]) => [JSON.stringify(p), o]))
	const put = new Set<object>()
	for (const p of patches) if ("value" in p) { for (const [, o] of boxes(p.value)) put.add(o) }
	unread.update(entry, patches, header())
	const n = ++writes
	did = []
	const seen = new Set<object>()
	for (const p of through(patches)) {
		const o = get(entry.value, p), b = before.get(JSON.stringify(p))
		if (!isBox(o) || seen.has(o) || put.has(o)) continue
		seen.add(o)
		cow++
		if (o === b) did.push({ path: p, kind: "same" })
		else {
			const w = why(b)
			did.push({ path: p, kind: "copy", was: b && tags.get(b), why: w })
			origin.set(o, { how: "copy", at: n })
			copies++
		}
	}
	putNames = []
	for (const [, o] of boxes(entry.value)) {
		if (put.has(o) && !origin.has(o)) {
			tag(o), origin.set(o, { how: "put", at: n })
			if (isMap(o) && typeof o.name === "string") putNames.push(o.name)
		}
	}
	const copied = did.filter((d) => d.kind === "copy")
	if (lastRead === n - 1 && copied.length) page.tick("photo")
	if (did.length && !copied.length) page.tick("feed")
	if (copied.some((d) => d.why === "put")) page.tick("new")
	if (copied.some((d) => d.why === "held")) page.tick("paint")
	writeWire.flash(copied.length ? "hot" : "ok")
	livePond.code(
		`// ${what}\nunread.update(entry, [\n${
			patches.map((p) => `  ${JSON.stringify(p)},`).join("\n")
		}\n], header)`,
	)
	drawAll()
}

// a container's name, as the tree shows it
const label = (p: Path): string => {
	if (p.length === 0) return "pond"
	const last = p[p.length - 1]
	if (typeof last === "number") {
		const f = get(entry.value, p) as Fish | undefined
		return f?.name ?? `[${last}]`
	}
	return String(last)
}
const list = (xs: string[]) =>
	xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`

const REASON: Record<Why, string> = {
	start:
		"what the pond started with is the caller's, never owned, so the first write through it copies",
	put: "that fish came in a patch: the caller's, never owned",
	read: "a photo holds the old ones, and they must never change",
	held: "the painter holds that one",
	"?": "they weren't owned",
}
function sentence(what: string): [string, "hot" | "ok"] {
	const c = did.filter((d) => d.kind === "copy"), s = did.filter((d) => d.kind === "same")
	const names = (ds: Did[]) => list(ds.map((d) => `<b>${label(d.path)}</b>`))
	const inPlace = s.length ? ` Changed in place: ${names(s)}.` : ""
	const added = putNames.length
		? ` <b>${list(putNames)}</b> came in the patch: the caller's, not owned.`
		: ""
	if (!c.length) {
		return [
			`${
				cap(what)
			}: no copies. Nobody has looked since an earlier write copied them, so they changed in place: ${
				names(s)
			}.${added}`,
			"ok",
		]
	}
	const whys = [...new Set(c.map((d) => d.why!))]
	return [
		`${cap(what)}: copied ${names(c)}. ${
			cap(whys.map((w) => REASON[w]).join("; "))
		}.${inPlace}${added}`,
		"hot",
	]
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ---- drawing a pond ---------------------------------------------------------------------------
const W = 240, H = 140
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
function seeded(seed: number) {
	let s = seed * 9301 + 49297
	return () => (s = (s * 9301 + 49297) % 233280) / 233280
}
const scaleOf = (size: number) => Math.min(4, 1 + Math.floor((size - 1) / 2))
// a fish's spot on the canvas: its x from the value, its y from its name
function fishAt(f: Fish) {
	const sc = scaleOf(f.size)
	const w = SPRITES.fish[0].length * sc, h = SPRITES.fish.length * sc
	const x = 14 + f.x * (W - 28 - w)
	const y = 24 + (hash(f.name) % 1000) / 1000 * (H - 52 - h)
	return { x, y, w, h, sc }
}
function drawPond(c: HTMLCanvasElement, v: PondValue, hot?: string) {
	const ctx = c.getContext("2d")!
	ctx.imageSmoothingEnabled = false
	ctx.fillStyle = "#e9d9a6"
	ctx.fillRect(0, 0, W, H)
	ctx.fillStyle = "#cdb877"
	const r0 = seeded(7)
	for (let i = 0; i < 40; i++) ctx.fillRect(Math.floor(r0() * W), Math.floor(r0() * H), 1, 1)
	ctx.fillStyle = "#2269ff"
	ctx.beginPath()
	ctx.roundRect(8, 8, W - 16, H - 16, 18)
	ctx.fill()
	ctx.strokeStyle = "#7a5230"
	ctx.lineWidth = 2
	ctx.stroke()
	ctx.fillStyle = "rgba(255,255,255,.35)"
	const r1 = seeded(100)
	for (let i = 0; i < 10; i++) {
		ctx.fillRect(Math.round(20 + r1() * (W - 50)), Math.round(16 + r1() * (H - 34)), 4 + i % 5, 1)
	}
	const r2 = seeded(500)
	for (let i = 0; i < Math.min(30, v.lilies.count); i++) {
		sprite(ctx, i % 3 === 2 ? "flower" : "lily", 16 + r2() * (W - 40), 16 + r2() * (H - 36))
	}
	for (const f of v.fish) {
		const p = fishAt(f)
		sprite(ctx, "fish", p.x, p.y, p.sc, f.x > 0.5)
		ctx.font = "7px Monaco, ui-monospace, monospace"
		const t = `${f.name} ${f.size}`
		const tw = Math.ceil(ctx.measureText(t).width)
		ctx.fillStyle = f.name === hot ? "#ff2284" : "#000"
		ctx.fillRect(Math.round(p.x + p.w / 2 - tw / 2 - 2), Math.round(p.y - 9), tw + 4, 8)
		ctx.fillStyle = "#fff"
		ctx.fillText(t, Math.round(p.x + p.w / 2 - tw / 2), Math.round(p.y - 3))
	}
	ctx.font = "8px Monaco, ui-monospace, monospace"
	const tw = ctx.measureText(v.sign).width
	ctx.fillStyle = "#fff"
	ctx.fillRect(4, H - 15, tw + 8, 11)
	ctx.strokeStyle = "#000"
	ctx.lineWidth = 1
	ctx.strokeRect(4.5, H - 14.5, tw + 7, 10)
	ctx.fillStyle = "#000"
	ctx.fillText(v.sign, 8, H - 6)
}
const canvasOf = (w = W, h = H) => {
	const c = document.createElement("canvas")
	c.width = w
	c.height = h
	return c
}

// ---- the boxes ----------------------------------------------------------------------------------
const livePond = board.box({
	id: "pond",
	x: 380,
	y: 40,
	title: "the pond: touch it",
	kind: "picture",
	outs: [["write", ""]],
})
const live = canvasOf()
live.className = "pond live"
live.setAttribute("aria-label", "the pond: click a fish to feed it, drag it to move it")
livePond.body.append(live)
const handles = document.createElement("div")
handles.className = "handles"
handles.innerHTML = `<button class="chip" data-do="fish">+ fish</button>
	<button class="chip" data-do="lily">+ lily</button>
	<input aria-label="the sign" value="pond" maxlength="24">`
livePond.body.append(handles)
livePond.code(`// touch the pond: each touch is one write\nunread.update(entry, patches, header)`)

const tree = board.box({
	id: "entry",
	x: 930,
	y: 40,
	title: "the entry's value",
	kind: "compute",
	width: 300,
	ins: [["write", "write"]],
	outs: [["kept", "kept"]],
})
tree.code(`const unread = createUnread()
const entry = createEntry(pond, header)

// in place of node's update
unread.update(entry, patches, header)

// each tile: a container (a map or a list)
// its tag: which object it is`)

const count = board.box({
	id: "count",
	x: 1270,
	y: 250,
	title: "copies made",
	kind: "note",
	width: 200,
})

const camera = board.box({
	id: "camera",
	x: 380,
	y: 420,
	title: "camera",
	kind: "effect",
	width: 150,
	outs: [["out", ""]],
})
const lens = canvasOf(SPRITES.camera[0].length * 4, SPRITES.camera.length * 4)
lens.className = "icon"
sprite(lens.getContext("2d")!, "camera", 0, 0, 4)
const shoot = document.createElement("button")
shoot.className = "shoot"
shoot.title = "take a photo: unread.read(entry)"
shoot.append(lens, "take a photo")
const reads = document.createElement("div")
reads.className = "small"
reads.style.marginTop = "4px"
reads.textContent = "a photo reads the entry"
camera.body.append(shoot, reads)
camera.code(`// a photo: the entry is read
unread.read(entry)
const photo = entry.value
// these very objects: never changed
// under the photo`)

const painter = board.box({
	id: "painter",
	x: 1270,
	y: 40,
	title: "painter",
	kind: "compute",
	width: 160,
	ins: [["in", ""]],
})
painter.code(`// a computer whose result is one fish,
// held past its run
const fish = entry.value.fish[i]
unread.kept(fish)`)

const writeWire = board.wire(livePond.port("write"), tree.port("write"))

board.wire(tree.port("kept"), painter.port("in")).label("kept")

// ---- photos and the painting ---------------------------------------------------------------------
type Held = { box: Box; value: unknown; wire?: Wire; at: number }
const photos: Held[] = []
let photoN = 0
function takePhoto() {
	unread.read(entry)
	lastRead = writes
	const value = entry.value as PondValue
	photoN++
	hint?.remove()
	hint = undefined
	// newest by the camera; the oldest of three goes
	if (photos.length === 3) photos.pop()!.box.remove()
	for (const p of photos) p.wire?.remove(), p.wire = undefined
	photos.forEach((p, i) => p.box.move(560 + (i + 1) * 290, 420))
	const b = board.box({
		id: `photo${photoN}`,
		x: 560,
		y: 420,
		title: `photo ${photoN} · after write ${writes}`,
		kind: "picture",
		width: 270,
		ins: [["in", ""]],
	})
	b.code(`// photo ${photoN}: what a reader holds\n// never changes, however you edit`)
	const pol = document.createElement("div")
	pol.className = "polaroid"
	const c = canvasOf()
	drawPond(c, value)
	pol.append(c)
	const chips = document.createElement("div")
	chips.className = "chipsrow"
	pol.append(chips)
	b.body.append(pol)
	const w = board.wire(camera.port("out"), b.port("in"))
	w.flash("ok")
	b.flash("ok")
	photos.unshift({ box: b, value, wire: w, at: writes })
	drawAll()
	page.say(
		`Photo ${photoN} taken: the entry is read. Nothing of it is owned now, so the next write copies.`,
		"ok",
	)
}
shoot.onclick = takePhoto
// where photos land, before there are any
let hint: Box | undefined = board.box({
	id: "hint",
	x: 560,
	y: 420,
	title: "photos",
	kind: "note",
	width: 270,
})
hint.body.innerHTML =
	`<div class="small">press the camera: a photo lands here, holding the pond as it is. up to three.</div>`

let painting: { value: Fish; at: number } | undefined
const pick = document.createElement("div")
pick.className = "pick"
const portrait = document.createElement("div")
portrait.className = "portrait"
painter.body.append(pick, portrait)
function drawPainter() {
	pick.innerHTML = pond().fish.map((f, i) =>
		`<button class="chip" data-paint="${i}" title="paint ${f.name}: unread.kept(fish)">${f.name}</button>`
	).join("")
	if (!painting) {
		portrait.innerHTML = `<div class="small">pick a fish to paint</div>`
		return
	}
	const f = painting.value
	const c = canvasOf(66, 36)
	const ctx = c.getContext("2d")!
	ctx.fillStyle = "#2269ff"
	ctx.fillRect(0, 0, 66, 36)
	const sc = scaleOf(f.size)
	pixels(
		ctx,
		SPRITES.fish,
		33 - SPRITES.fish[0].length * sc / 2,
		18 - SPRITES.fish.length * sc / 2,
		sc,
	)
	portrait.innerHTML = ""
	portrait.append(c)
	const chips = document.createElement("div")
	chips.className = "chipsrow"
	chips.innerHTML = `${f.name} ${f.size} ${chip(f)}`
	portrait.append(chips)
}
pick.onclick = (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-paint]")
	if (!b) return
	const f = pond().fish[Number(b.dataset.paint)]
	unread.kept(f)
	origin.get(f)!.held = writes
	painting = { value: f, at: writes }
	painter.flash("ok")
	drawAll()
	page.say(
		`The painter holds <b>${f.name}</b>: kept lets go of just that fish. The rest of the pond stays owned.`,
		"ok",
	)
}

// ---- the tree: a tile per container, kept on the page by tag --------------------------------------
const tiles = new Map<number, HTMLElement>()
const held = () => {
	const s = new Set<object>()
	for (const p of photos) for (const [, o] of boxes(p.value)) s.add(o)
	if (painting) s.add(painting.value)
	return s
}
function chip(o: object): string {
	const liveSet = new Set(boxes(entry.value).map(([, o]) => o))
	return `<span class="tg ${liveSet.has(o) ? "shared" : "gone"}" title="${
		liveSet.has(o) ? "the live pond still shares this one" : "the live pond has moved on"
	}">#${tag(o)}</span>`
}
function drawTree() {
	const shared = held()
	const marks = new Map<object, Did>()
	for (const d of did) {
		const o = get(entry.value, d.path)
		if (isBox(o)) marks.set(o, d)
	}
	const used = new Set<number>()
	const make = (o: object, p: Path): HTMLElement => {
		const t = tag(o)
		used.add(t)
		let el = tiles.get(t)
		const fresh = !el
		if (!el) {
			el = document.createElement("div")
			el.className = "tile"
			tiles.set(t, el)
		}
		const d = marks.get(o)
		el.classList.toggle("copied", d?.kind === "copy")
		el.classList.toggle("same", d?.kind === "same")
		el.classList.toggle("shared", shared.has(o) && !d)
		el.classList.remove("pulse", "arrive")
		if (d) {
			void el.offsetWidth
			el.classList.add(d.kind === "copy" || fresh ? "arrive" : "pulse")
		}
		let leaves = ""
		if (Array.isArray(o)) leaves = `${o.length}`
		else if (p.length === 0) leaves = JSON.stringify((o as PondValue).sign)
		else {
			leaves = Object.entries(o).filter(([, v]) => !isBox(v)).filter(([k]) =>
				k !== "name" && k !== "x"
			).map((
				[k, v],
			) => `${k} ${typeof v === "number" ? Math.round(v * 100) / 100 : JSON.stringify(v)}`).join(
				" · ",
			)
		}
		el.innerHTML = `<span class="nm">${label(p)}</span><span class="lf">${leaves}</span>${
			d?.kind === "copy"
				? `<span class="what">copied</span>`
				: d?.kind === "same"
				? `<span class="what">in place</span>`
				: ""
		}<span class="tg">${d?.kind === "copy" && d.was ? `#${d.was}→` : ""}#${t}</span>`
		return el
	}
	const node = (o: object, p: Path): HTMLElement => {
		const wrap = document.createElement("div")
		wrap.className = "tree"
		wrap.append(make(o, p))
		const kids = (Array.isArray(o) ? o.map((x, i) => [i, x] as const) : Object.entries(o))
			.filter(([, x]) => isBox(x))
		if (kids.length) {
			const k = document.createElement("div")
			k.className = "kids"
			for (const [key, x] of kids) k.append(node(x as object, [...p, key]))
			wrap.append(k)
		}
		return wrap
	}
	const t = node(entry.value as object, [])
	tree.body.replaceChildren(t)
	for (const k of [...tiles.keys()]) if (!used.has(k)) tiles.delete(k)
}

function drawAll(hot?: string) {
	drawPond(live, pond(), hot)
	drawTree()
	drawPainter()
	for (const p of photos) {
		const chips = p.box.body.querySelector(".chipsrow")!
		chips.innerHTML = `holds ${boxes(p.value).map(([, o]) => chip(o)).join("")}`
	}
	count.body.innerHTML =
		`<div class="count"><span class="big">${copies}</span><span class="vs">copy-on-write<br>would have made <b>${cow}</b></span></div><div class="small">in ${writes} write${
			writes === 1 ? "" : "s"
		}</div>`
	board.redraw()
}

// ---- touching the pond ----------------------------------------------------------------------------
function fishUnder(e: PointerEvent): number {
	const r = live.getBoundingClientRect()
	const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height
	const fish = pond().fish
	for (let i = fish.length - 1; i >= 0; i--) {
		const p = fishAt(fish[i])
		if (x >= p.x - 2 && x <= p.x + p.w + 2 && y >= p.y - 10 && y <= p.y + p.h + 2) return i
	}
	return -1
}
let drag: { i: number; moved: boolean; n: number; c: number; sx: number } | undefined
live.addEventListener("pointerdown", (e) => {
	if (e.button !== 0) return
	const i = fishUnder(e)
	if (i < 0) return
	e.stopPropagation()
	live.setPointerCapture(e.pointerId)
	drag = { i, moved: false, n: 0, c: 0, sx: e.clientX }
})
live.addEventListener("pointermove", (e) => {
	if (!drag) {
		live.style.cursor = fishUnder(e) >= 0 ? "grab" : "default"
		return
	}
	if (!drag.moved && Math.abs(e.clientX - drag.sx) < 4) return
	drag.moved = true
	live.classList.add("dragging")
	const r = live.getBoundingClientRect()
	const f = pond().fish[drag.i]
	const p = fishAt(f)
	const px = (e.clientX - r.left) * W / r.width - p.w / 2
	const x = Math.round(Math.min(1, Math.max(0, (px - 14) / (W - 28 - p.w))) * 100) / 100
	if (x === f.x) return
	const before = copies
	write(`move ${f.name}`, [{ path: ["fish", drag.i, "x"], value: x }])
	drag.n++
	drag.c += copies - before
	drawPond(live, pond(), f.name)
	page.say(
		`Moving <b>${f.name}</b>: ${drag.n} write${drag.n === 1 ? "" : "s"}, ${drag.c} cop${
			drag.c === 1 ? "y" : "ies"
		}. Nobody looks between them, so after the first they all change in place.`,
		drag.c ? "hot" : "ok",
	)
})
live.addEventListener("pointerup", () => {
	if (!drag) return
	const d = drag
	drag = undefined
	live.classList.remove("dragging")
	if (d.moved) {
		if (d.n >= 5) page.tick("drag")
		return
	}
	const f = pond().fish[d.i]
	const what = `fed ${f.name}`
	write(what, [{ path: ["fish", d.i, "size"], value: f.size + 1 }])
	drawPond(live, pond(), f.name)
	const [s, tone] = sentence(what)
	page.say(s, tone)
})
handles.addEventListener("click", (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-do]")
	if (!b) return
	let what: string
	if (b.dataset.do === "fish") {
		const n = pond().fish.length
		if (n >= 6) return page.say("The pond is full.")
		const used = new Set(pond().fish.map((f) => f.name))
		const name = NAMES.find((x) => !used.has(x)) ?? `f${n}`
		const x = Math.round(seeded(n + writes)() * 100) / 100
		what = `added ${name}`
		write(what, [{ path: ["fish"], range: [n, n], value: [{ name, size: 1, x }] }])
		drawPond(live, pond(), name)
	} else {
		what = "added a lily"
		write(what, [{ path: ["lilies", "count"], value: pond().lilies.count + 1 }])
	}
	const [s, tone] = sentence(what)
	page.say(s, tone)
})
const signInput = handles.querySelector("input")!
signInput.addEventListener("input", () => {
	// the smallest splice from the old sign to the new, in code points (op's string spans)
	const a = [...pond().sign], b = [...signInput.value]
	let s = 0
	while (s < a.length && s < b.length && a[s] === b[s]) s++
	let e = 0
	while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
	const what = "changed the sign"
	write(what, [{
		path: ["sign"],
		range: [s, a.length - e],
		value: b.slice(s, b.length - e).join(""),
	}])
	const [t, tone] = sentence(what)
	page.say(t, tone)
})

drawAll()
page.say("Click a fish to feed it. Watch the tiles in the value tree.")
requestAnimationFrame(() => board.fit())
