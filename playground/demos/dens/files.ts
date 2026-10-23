/// <reference lib="dom" />
// files.ts: this den's tree as a file browser, catclock's Files (playground/demos/catclock/web),
// brought here. On the left the places (the root, what's at the top, what runs here, what changed
// last); in the middle the nodes as icons, as a list (folders open in place), as columns (one a
// level, walked by clicking) or as a map; on the right the one picked: its value, its attributes
// (what points somewhere a chip that goes there), its last change (when, who, where in the code).
//
// drawn by an effect of the host's that walks the tree from / as places reads it (lib's members:
// every contributor's names, each with the contributor that gave it: processes, away, children; a
// level of a trie a folder with no node). every read tracked, so anything arriving redraws it, the
// changed item lit up for a moment. a click picks a node (and shows its thing on the board); a
// double click goes into a folder. a thing's row is draggable onto an in-port
//
//   const files = createFiles(host, el, { pick: (path, id) => ..., isThing: (id) => ... })
//   files.select(["home", "counter-1a2b"])
import type { ChangeHeader } from "@ermine/node/entry"
import { level, type Path } from "@ermine/places"
import { members } from "@ermine/places/lib"
import { RUNNER, TAKES } from "@ermine/software"
import { codeLink, linesHtml, onMaps, origin, siteHtml } from "./code.ts"
import type { Host } from "./host.ts"
import { NAME, OUT } from "./host.ts"
import { isPicture } from "./things.ts"

type Item = {
	path: string[]
	key: string // the path joined by /, the root ""
	name: string
	id: string | symbol // a level: the symbol level
	from?: string // the contributor that gave it: processes, away, children
	value: unknown
	change?: ChangeHeader // the value's
	marked?: ChangeHeader // the attributes'
	live?: unknown // a thing's: its runner's live function, as read here
	attributes?: Record<string, unknown>
	names: string[] // what's under it
	again?: boolean // its id is already on the way here: not walked into twice
}
type Items = Map<string, Item>
type View = "icons" | "list" | "columns" | "map"

const key = (path: readonly string[]) => path.join("/")
const parent = (path: readonly string[]) => path.slice(0, -1)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const VIEWS: View[] = ["icons", "list", "columns", "map"]
const KEPT = "dens:files:view"
// how far the walk goes: the tree of a room of dens is small, a loop of mounts is not
const DEEPEST = 12, MOST = 3000

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)
const isPath = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string")
const split = (p: string): string[] => p.split("/").filter((x) => x !== "")
// a long key's hex cut to its start
const short = (name: string) => /^[0-9a-f]{20,}$/.test(name) ? name.slice(0, 6) + "…" : name

// ---- what each item is, in words ----
const isLevel = (it: Item) => it.id === level
const thingKind = (it: Item) => {
	const r = it.attributes?.[RUNNER]
	return isMap(r) && Array.isArray(r.at) ? String(r.at.at(-1)) : undefined
}
const time = (it: Item) => Math.max(it.change?.time ?? 0, it.marked?.time ?? 0)
const last = (it: Item) => (it.marked?.time ?? 0) > (it.change?.time ?? 0) ? it.marked : it.change
function valueKind(it: Item) {
	const v = it.value
	if (typeof v === "function") return "a live function"
	if (v instanceof Uint8Array) return "bytes"
	if (typeof v === "string") return "text"
	if (Array.isArray(v)) return "list"
	if (isMap(v)) return "record"
	return v === undefined ? undefined : typeof v
}
function kind(it: Item) {
	if (it.key === "") return "the root"
	const t = thingKind(it)
	if (t) return `${/^[aeiou]/.test(t) ? "an" : "a"} ${t}, running`
	const v = valueKind(it)
	const n = it.names.length
	if (!n) return v ?? (isLevel(it) ? "folder, empty" : "empty")
	const under = `${n} ${n === 1 ? "name" : "names"}`
	return v ? `${v}, ${under}` : `folder, ${under}`
}
const bytes = (n: number) =>
	n < 1024
		? `${n} B`
		: n < 1024 * 1024
		? `${(n / 1024).toFixed(1)} KB`
		: `${(n / 1048576).toFixed(1)} MB`

// a value, short
export function brief(v: unknown, room = 60): string {
	if (isPicture(v)) return `a picture, ${v.width}×${v.height}`
	if (typeof v === "function") return "a live function (this den's alone)"
	if (typeof v === "symbol") return String(v.description ?? "a symbol")
	if (v instanceof Error) return `failed: ${v.message}`
	let s: string
	try {
		s = JSON.stringify(
			v,
			(_, x) => typeof x === "function" ? "<function>" : typeof x === "symbol" ? "<pending>" : x,
		)
	} catch {
		s = String(v)
	}
	if (s === undefined) s = String(v)
	return s.length > room ? s.slice(0, room - 1) + "…" : s
}

function size(it: Item) {
	if (thingKind(it) && it.attributes?.[OUT] !== undefined) return brief(it.attributes[OUT], 24)
	const v = it.value
	if (v instanceof Uint8Array) return bytes(v.length)
	if (typeof v === "string") return bytes(new TextEncoder().encode(v).length)
	if (typeof v === "function") return "live"
	if (Array.isArray(v)) return `${v.length} items`
	if (isMap(v)) return `${Object.keys(v).length} fields`
	if (v === undefined && it.names.length) {
		return `${it.names.length} ${it.names.length === 1 ? "item" : "items"}`
	}
	return v === undefined ? "—" : String(v)
}
const clock = (t: number) =>
	new Date(t * 1000).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	})
function ago(t: number | undefined) {
	if (!t) return "—"
	const s = Date.now() / 1000 - t
	if (s < 10) return "just now"
	if (s < 60) return `${Math.floor(s)} s ago`
	if (s < 3600) return `${Math.floor(s / 60)} min ago`
	return clock(t)
}
// the site a change came from: the last of its external sites
const siteAt = (c?: ChangeHeader) => c?.external?.at(-1)
const FROM: Record<string, string> = {
	process: "running here (processes)",
	away: "another den's, its steps come through tippet (away places it)",
	children: "saved here (children)",
}

// ---- icons: a folder, tinted by where it is; a page, with a band saying what's in it; a cog for
// a thing that runs ----
const TINT: Record<string, [string, string]> = {
	root: ["#ffd95e", "#fff0a6"],
	things: ["#ffa9cf", "#ffd2e6"],
	system: ["#94c6ff", "#c8e2ff"],
	home: ["#8ddbb5", "#c3f0da"],
	other: ["#c3b2ff", "#e0d6ff"],
}
const tint = (path: string[]) => !path.length ? TINT.root : TINT[path[0]] ?? TINT.other
const BANDS: Record<string, [string, string, string]> = {
	// band, its ink, its word
	fn: ["#40dcba", "#000", "LIVE"],
	record: ["#ffd84d", "#000", "{ }"],
	list: ["#ffd84d", "#000", "[ ]"],
	number: ["#2269ff", "#fff", "123"],
	bytes: ["#b3a5b8", "#fff", "BIN"],
	text: ["#d9cfdd", "#000", "TXT"],
	other: ["#d9cfdd", "#000", "•"],
}
function band(it: Item) {
	const v = it.value
	if (v === undefined) return undefined
	if (typeof v === "function") return BANDS.fn
	if (v instanceof Uint8Array) return BANDS.bytes
	if (typeof v === "string") return BANDS.text
	if (typeof v === "number") return BANDS.number
	if (Array.isArray(v)) return BANDS.list
	if (isMap(v)) return BANDS.record
	return BANDS.other
}

function folderSvg([back, front]: [string, string], dashed: boolean) {
	const line = dashed ? ` stroke="rgba(58,42,67,0.35)" stroke-dasharray="3 2.5"` : ""
	return `<svg viewBox="0 0 64 52" aria-hidden="true">
		<path d="M3,9 Q3,4 8,4 H23 Q26,4 28,7 L30,10 H56 Q61,10 61,15 V45 Q61,49 57,49 H7 Q3,49 3,45 Z" fill="${back}"${line}/>
		<path d="M3,19 Q3,15 7,15 H57 Q61,15 61,19 V45 Q61,49 57,49 H7 Q3,49 3,45 Z" fill="${front}"${line}/>
		<path d="M8,19.6 H56" stroke="#fff" stroke-opacity="0.75" stroke-width="1.3" stroke-linecap="round"/>
	</svg>`
}
function pageSvg(it: Item, small: boolean) {
	const b = band(it)
	const empty = it.value === undefined
	return `<svg viewBox="0 0 48 60" aria-hidden="true">
		<path d="M8,2 H31 L44,15 V54 Q44,58 40,58 H8 Q4,58 4,54 V6 Q4,2 8,2 Z" fill="${
		empty ? "rgba(255,255,255,0.4)" : "#fff"
	}" stroke="rgba(58,42,67,0.24)"${empty ? ' stroke-dasharray="3 3"' : ""}/>
		<path d="M31,2 V11 Q31,15 35,15 H44" fill="#f4eef7" stroke="rgba(58,42,67,0.24)" stroke-linejoin="round"/>
		${
		b
			? `<rect x="4.5" y="42" width="39" height="11" fill="${b[0]}"/>` +
				(small
					? ""
					: `<text x="24" y="50.4" text-anchor="middle" font-family="Monaco, Menlo, monospace" font-size="${
						b[2].length > 3 ? 7 : 8
					}" font-weight="700" fill="${b[1]}">${esc(b[2])}</text>`)
			: ""
	}
	</svg>`
}
// a thing: a cog (it makes a value, as a computer does), cherry when it is another den's
const cogSvg = (away: boolean) =>
	`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="#fff" stroke="${
		away ? "#ff2284" : "#2269ff"
	}" stroke-width="2.6" stroke-dasharray="2.1 1.55"/><circle cx="8" cy="8" r="2" fill="${
		away ? "#ff2284" : "#2269ff"
	}"/></svg>`
const isFolder = (it: Item) => (it.names.length > 0 && !it.again) || it.key === "" || isLevel(it)
function icon(it: Item, size: "small" | "big" | "huge") {
	if (thingKind(it)) {
		return `<span class="icon i-${size} cog">${cogSvg(it.from === "away")}</span>`
	}
	const folder = isFolder(it)
	return `<span class="icon i-${size}${folder ? " folder" : ""}">${
		folder ? folderSvg(tint(it.path), isLevel(it)) : pageSvg(it, size === "small")
	}</span>`
}
// mirrored from another den: a small tag
const tag = (it: Item) =>
	it.from === "away" && !isLevel(it)
		? `<span class="badge" title="mirrored from another den">away</span>`
		: ""

// a soft curve from a to b, a little off true, the same each time for the same pair
function curve(key: string, ax: number, ay: number, bx: number, by: number) {
	let h = 2166136261
	for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
	const off = ((h >>> 0) / 4294967296 - 0.5) * 8
	const mx = (ax + bx) / 2
	return `M${ax},${ay} C${mx + off},${ay} ${mx - off},${by + off / 2} ${bx},${by}`
}

// ---- a value, a few lines of it ----
function preview(it: Item) {
	const v = it.value
	if (typeof v === "function") {
		return `<p class="none">a live function: it runs here, in this den, and never travels</p>`
	}
	if (v === undefined) {
		return `<p class="none">${
			isLevel(it) ? "a folder with no node of its own: only names under it" : "no value"
		}</p>`
	}
	let text: string
	if (v instanceof Uint8Array) {
		const rows = []
		for (let i = 0; i < Math.min(v.length, 96); i += 8) {
			rows.push(
				i.toString(16).padStart(4, "0") + "  " +
					[...v.subarray(i, i + 8)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
			)
		}
		text = rows.join("\n") + (v.length > 96 ? "\n…" : "")
	} else if (typeof v === "string") {
		const lines = v.split("\n")
		text = lines.slice(0, 16).join("\n") + (lines.length > 16 ? "\n…" : "")
	} else {
		let s: string
		try {
			s = JSON.stringify(v, null, 2) ?? String(v)
		} catch {
			s = String(v)
		}
		const lines = s.split("\n")
		text = lines.slice(0, 16).join("\n") + (lines.length > 16 ? "\n…" : "")
	}
	return `<pre class="peek">${esc(text)}</pre>`
}

// ---- the browser ----
export function createFiles(
	host: Host,
	root: HTMLElement,
	on: {
		// a node picked: its path, and its id (a level: none)
		pick: (path: Path, id: string | undefined) => void
		// what this page calls a thing's id (one is draggable onto an in-port)
		isThing: (id: string) => boolean
		// "open it wide": a live function, in the code window
		live: (name: string, fn: unknown) => void
	},
) {
	const { s, places, hosted } = host
	const $ = <T extends Element = HTMLElement>(q: string) => root.querySelector(q) as T
	const side = $(".side"), main = $(".main"), info = $(".info"), crumbs = $(".crumbs")
	const status = $(".status"), back = $<HTMLButtonElement>(".back")
	const forward = $<HTMLButtonElement>(".forward")

	let view: View = "list"
	try {
		const kept = localStorage.getItem(KEPT) as View | null
		if (kept && VIEWS.includes(kept)) view = kept
	} catch { /* no storage here: the list it is */ }
	let here: string[] = [] // the folder shown (icons, list); columns and the map walk from the root
	let picked: string | undefined // the item picked, by key
	let wanted: string[] | undefined // a path asked for before it was in the tree
	const open = new Set<string>(["", "home"]) // folders open in the list
	const past: string[][] = [], ahead: string[][] = []

	// ---- what the tree holds: every node, walked from the root (tracked) ----
	function model(): Items {
		const items: Items = new Map()
		const node = (
			path: string[],
			id: string | symbol,
			from: string | undefined,
			seen: unknown[],
		) => {
			const again = id !== level && seen.includes(id)
			const ms = again || path.length >= DEEPEST || items.size >= MOST
				? []
				: members(places, path)
			const it: Item = {
				path,
				key: key(path),
				name: path.at(-1) ?? "/",
				id,
				from,
				value: undefined,
				names: ms.map((m) => m.name),
				again,
			}
			if (id !== level) {
				it.value = places.readValue("value", id)
				it.change = places.readChange("value", id)
				it.marked = places.readChange("attributes", id)
				const a = places.readValue("attributes", id)
				if (isMap(a)) it.attributes = a
				// a thing: the function that runs it, if its runner is here
				const r = isMap(a) ? a[RUNNER] : undefined
				if (isMap(r) && typeof r.id === "string") it.live = places.readValue("value", r.id)
			}
			items.set(it.key, it)
			const deeper = id === level ? seen : [...seen, id]
			for (const m of ms) node([...path, m.name], m.id, m.from, deeper)
		}
		node([], places.root, "root", [])
		return items
	}
	let items: Items = new Map()
	// each id's items (a node placed twice is two)
	let byId = new Map<string | symbol, string[]>()

	// what changed since the last look: lit up for a moment; seen, in order, for "changed lately"
	const lit = new Map<string, number>(), litAt = new Map<string, number>()
	const seen = new Map<string, number>()
	let looks = 0
	function landed(next: Items) {
		const now = performance.now()
		if (looks++) {
			for (const [k, it] of next) {
				const was = items.get(k)
				if (
					!was || was.change !== it.change || was.marked !== it.marked ||
					key(was.names) !== key(it.names)
				) {
					// lit at most once in 4 s, and still (a fade was painted every frame, and a node
					// changing every second kept one going): drawn again without it once it's over
					if (now - (litAt.get(k) ?? -Infinity) > 4000) {
						lit.set(k, now), litAt.set(k, now)
						setTimeout(later, 1900)
					}
					seen.set(k, looks)
				}
			}
		}
		items = next
		byId = new Map()
		for (const [k, it] of items) byId.set(it.id, [...(byId.get(it.id) ?? []), k])
		if (!items.has(key(here))) here = []
		if (picked !== undefined && !items.has(picked)) picked = undefined
		if (wanted && items.has(key(wanted))) {
			const w = wanted
			wanted = undefined
			return reveal(w)
		}
		later()
	}

	// a den's name, from its node at /system/dens/<id>; else the id, short
	const denName = (den: unknown) => {
		if (typeof den !== "string") return den === undefined ? "—" : String(den)
		const n = items.get(key(["system", "dens", den]))?.attributes?.[NAME]
		return typeof n === "string" ? n : den === host.id ? "this den" : short(den)
	}
	const who = (c?: ChangeHeader) => (c?.actor === undefined ? "—" : denName(c.actor))
	// who changed it: another den's node is written here as its steps land, by that den
	const by = (it: Item) =>
		it.from === "away" && last(it)?.actor === host.id ? "mirrored" : who(last(it))
	// a name as shown: a den's key cut short, with the den's own name beside it
	const named = (it: Item) => {
		const n = it.attributes?.[NAME]
		return `${esc(short(it.name))}${
			typeof n === "string" && n !== it.name ? ` <span class="also">${esc(n)}</span>` : ""
		}`
	}

	// lit up for a moment: a class. blink: how far its blink has got, for its style (drawn again
	// mid-blink, it carries on rather than starting over)
	const fresh = (k: string) => {
		const at = lit.get(k)
		if (at === undefined) return ""
		if (performance.now() - at > 1800) return (lit.delete(k), "")
		return " fresh"
	}
	const blink = (k: string) => {
		const at = lit.get(k)
		return at === undefined ? "" : `--age:-${Math.round(performance.now() - at)}ms;`
	}
	// a thing's row: draggable onto an in-port
	const drag = (it: Item) =>
		typeof it.id === "string" && thingKind(it) && on.isThing(it.id) ? ` draggable="true"` : ""

	// children of a node: folders first, then by name
	const kids = (it: Item) =>
		it.again ? [] : it.names
			.map((n) => items.get(key([...it.path, n])))
			.filter((c): c is Item => c !== undefined)
			.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name))

	// ---- going places ----
	function go(path: string[], pick?: string) {
		if (key(path) !== key(here)) {
			past.push(here)
			ahead.length = 0
		}
		here = path
		picked = pick
		draw()
	}
	function told(it: Item) {
		on.pick(it.path, typeof it.id === "string" ? it.id : undefined)
	}
	function activate(it: Item) {
		if (isFolder(it) && it.names.length && view !== "map") {
			if (view === "columns") pick(it.key)
			else go(it.path)
		} else told(it)
	}
	function pick(k: string) {
		picked = k
		const it = items.get(k)
		if (view === "columns" && it) {
			here = isFolder(it) && it.names.length ? it.path : parent(it.path)
		}
		draw()
	}

	// ---- drawing: never while a button is held down in here (what it pressed would go, and its
	// click with it), nor mid-drag; owed, and drawn once it's let go ----
	let holding = false, owed = false, soon = 0, bring = false
	const later = () => (soon ||= requestAnimationFrame(() => (soon = 0, draw())))
	const letGo = () => {
		holding = false
		if (owed) later()
	}
	root.addEventListener("pointerdown", () => (holding = true))
	addEventListener("pointerup", letGo, true)
	addEventListener("dragend", letGo, true)
	addEventListener("drop", letGo, true)

	function draw() {
		if (!items.size) return
		if (holding) return void (owed = true)
		owed = false
		const focused = document.activeElement instanceof HTMLElement &&
				main.contains(document.activeElement)
			? document.activeElement.dataset.key
			: undefined
		const scroll = { top: main.scrollTop, left: main.scrollLeft }
		const cols0 = main.querySelector(".cols")?.scrollLeft
		root.dataset.shows = view
		for (const b of root.querySelectorAll<HTMLButtonElement>("[data-view]")) {
			b.setAttribute("aria-pressed", String(b.dataset.view === view))
		}
		back.disabled = !past.length
		forward.disabled = !ahead.length
		drawCrumbs()
		drawSide()
		if (view === "icons") drawIcons()
		else if (view === "list") drawList()
		else if (view === "columns") drawColumns()
		else drawMap()
		drawInfo()
		drawStatus()
		main.scrollTop = scroll.top
		main.scrollLeft = scroll.left
		const cols = main.querySelector(".cols")
		if (cols) cols.scrollLeft = Math.max(cols0 ?? 0, cols.scrollWidth)
		if (focused !== undefined) {
			main.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({
				preventScroll: true,
			})
		}
		// after a view change or a reveal: the one picked, in view
		if (bring) {
			bring = false
			main.querySelector(".sel")?.scrollIntoView({ block: "nearest", inline: "nearest" })
		}
	}

	function drawCrumbs() {
		const trail = (view === "columns" || view === "map") && picked !== undefined
			? items.get(picked)?.path ?? here
			: here
		let out = `<button class="crumb" data-go="">${
			icon(items.get("")!, "small")
		}<span>/</span></button>`
		trail.forEach((name, i) => {
			out += `<span class="sep" aria-hidden="true">›</span><button class="crumb${
				i === trail.length - 1 ? " last" : ""
			}" data-go="${esc(key(trail.slice(0, i + 1)))}" title="${esc(name)}">${
				esc(short(name))
			}</button>`
		})
		crumbs.innerHTML = out
	}

	function drawSide() {
		const top = items.get("")
		let out = `<p class="group">this den</p>`
		const place = (it: Item, label = it.name) =>
			`<button class="spot${key(here) === it.key && !picked ? " on" : ""}" data-go="${
				esc(it.key)
			}">${icon(it, "small")}<span>${esc(label)}</span></button>`
		if (top) {
			out += place(top, "the root")
			for (const it of kids(top)) out += place(it)
		}
		// running: the things in the tree, each once, the newest change first
		const running = [...items.values()]
			.filter((it) => thingKind(it))
			.filter((it, i, all) => all.findIndex((o) => o.id === it.id) === i)
			.sort((a, b) => a.key.localeCompare(b.key))
		if (running.length) {
			out += `<p class="group">running</p>`
			for (const it of running) {
				const out_ = it.attributes?.[OUT]
				out += `<button class="spot run${picked === it.key ? " on" : ""}${
					fresh(it.key)
				}" style="${blink(it.key)}" data-reveal="${esc(it.key)}" title="/${esc(it.key)}"${
					drag(it)
				} data-key-drag="${esc(it.key)}">${icon(it, "small")}<span>${esc(it.name)}</span><em>${
					esc(out_ === undefined ? "" : brief(out_, 10))
				}</em></button>`
			}
		}
		// changed lately: what this page has seen change, newest first; then the rest by time.
		// a node placed twice shown once, at its first place
		const recent = [...items.values()]
			.filter((it) => !isLevel(it) && it.key !== "" && time(it) > 0)
			.sort((a, b) =>
				(seen.get(b.key) ?? 0) - (seen.get(a.key) ?? 0) || time(b) - time(a) ||
				a.key.localeCompare(b.key)
			)
			.filter((it, i, all) => all.findIndex((o) => o.id === it.id) === i)
			.slice(0, 4)
		if (recent.length) {
			out += `<p class="group">changed lately</p>`
			for (const it of recent) {
				out += `<button class="spot${picked === it.key ? " on" : ""}${fresh(it.key)}" style="${
					blink(it.key)
				}" data-reveal="${esc(it.key)}" title="/${esc(it.key)}">${icon(it, "small")}<span>${
					named(it)
				}</span><em>${esc(ago(time(it)))}</em></button>`
			}
		}
		side.innerHTML = out
	}

	const empty = (what: string) => `<p class="nothing">${esc(what)}</p>`

	function drawIcons() {
		const at = items.get(key(here))
		const list = at ? kids(at) : []
		main.innerHTML = list.length
			? `<div class="tiles" role="listbox" aria-label="${esc(at!.name)}">${
				list.map((it) =>
					`<button class="ftile${picked === it.key ? " sel" : ""}${fresh(it.key)}" style="${
						blink(it.key)
					}" data-key="${esc(it.key)}" role="option" aria-selected="${
						picked === it.key
					}" title="/${esc(it.key)}"${drag(it)}>${icon(it, "big")}<span class="label">${
						named(it)
					}</span>${tag(it)}<span class="sub${thingKind(it) ? " out" : ""}">${
						esc(size(it))
					}</span></button>`
				).join("")
			}</div>`
			: empty("nothing under here yet")
	}

	function drawList() {
		const at = items.get(key(here))
		let rows = ""
		const row = (it: Item, depth: number) => {
			const folder = isFolder(it) && it.names.length > 0
			const isOpen = folder && open.has(it.key)
			const t = thingKind(it)
			rows += `<div class="row${picked === it.key ? " sel" : ""}${fresh(it.key)}" style="${
				blink(it.key)
			}" data-key="${esc(it.key)}" role="row" tabindex="0" aria-selected="${
				picked === it.key
			}" title="/${esc(it.key)}"${folder ? ` aria-expanded="${isOpen}"` : ""}${drag(it)}>
				<span class="name" style="--depth:${depth}">${
				folder
					? `<button class="twisty" data-twist="${esc(it.key)}" tabindex="-1" aria-label="${
						isOpen ? "close" : "open"
					} ${esc(it.name)}">▸</button>`
					: `<span class="twisty"></span>`
			}${icon(it, "small")}<span>${named(it)}</span>${tag(it)}</span>
				<span class="kind">${esc(kind(it))}</span>
				<span class="size${t ? " out" : ""}">${esc(size(it))}</span>
				<span class="when" title="${time(it) ? esc(clock(time(it))) : ""}">${
				siteHtml(siteAt(last(it)), ago(time(it)))
			}</span>
				<span class="who">${esc(by(it))}</span>
			</div>`
			if (isOpen) { for (const c of kids(it)) row(c, depth + 1) }
		}
		if (at) { for (const it of kids(at)) row(it, 0) }
		main.innerHTML = rows
			? `<div class="table" role="treegrid" aria-label="${esc(at?.name ?? "/")}">
				<div class="row head" role="row"><span>name</span><span>kind</span><span>value</span><span>changed</span><span>by</span></div>
				${rows}
			</div>`
			: empty("nothing under here yet")
	}

	function drawColumns() {
		const trail = picked !== undefined ? items.get(picked)?.path ?? [] : here
		const folders: string[][] = [[]]
		for (let i = 1; i <= trail.length; i++) {
			const it = items.get(key(trail.slice(0, i)))
			if (it && isFolder(it) && it.names.length) folders.push(trail.slice(0, i))
		}
		main.innerHTML = `<div class="cols">${
			folders.map((path, depth) => {
				const at = items.get(key(path))
				const list = at ? kids(at) : []
				return `<div class="col" role="listbox" aria-label="${esc(at?.name ?? "/")}">${
					list.map((it) => {
						const onTrail = trail[depth] === it.name &&
							key(trail.slice(0, depth)) === key(path)
						const last = onTrail && it.key === picked
						return `<button class="cell${last ? " sel" : onTrail ? " trail" : ""}${
							fresh(it.key)
						}" style="${blink(it.key)}" data-key="${
							esc(it.key)
						}" role="option" aria-selected="${last}" title="/${esc(it.key)}"${drag(it)}>${
							icon(it, "small")
						}<span>${named(it)}</span>${tag(it)}${
							thingKind(it) ? `<em class="out">${esc(size(it))}</em>` : ""
						}${
							isFolder(it) && it.names.length
								? `<span class="more" aria-hidden="true">›</span>`
								: ""
						}</button>`
					}).join("") || empty("empty")
				}</div>`
			}).join("")
		}</div>`
	}

	// the whole tree, the root on the left
	function drawMap() {
		const top = items.get("")
		if (!top) return void (main.innerHTML = empty("nothing here yet"))
		const ROW = 36, COL = 190, PAD = 18, W = 160, H = 28
		const at = new Map<string, { x: number; y: number }>()
		let rows = 0, deep = 0
		const lay = (it: Item, depth: number) => {
			deep = Math.max(deep, depth)
			const ks = kids(it)
			if (!ks.length) return void at.set(it.key, { x: PAD + depth * COL, y: PAD + rows++ * ROW })
			for (const c of ks) lay(c, depth + 1)
			const first = at.get(ks[0].key)!.y, last = at.get(ks.at(-1)!.key)!.y
			at.set(it.key, { x: PAD + depth * COL, y: (first + last) / 2 })
		}
		lay(top, 0)
		const width = PAD + deep * COL + W + PAD
		const height = PAD * 2 + rows * ROW - (ROW - H)
		let lines = "", nodes = ""
		for (const [k, p] of at) {
			const it = items.get(k)!
			for (const c of kids(it)) {
				const q = at.get(c.key)!
				lines += `<path class="tie" d="${
					curve(c.key, p.x + W, p.y + H / 2, q.x, q.y + H / 2)
				}"/>`
			}
			nodes += `<button class="mnode${picked === k ? " sel" : ""}${fresh(k)}" data-key="${
				esc(k)
			}" style="${blink(k)}left:${p.x}px;top:${p.y}px" title="/${esc(k)}"${drag(it)}>${
				icon(it, "small")
			}<span>${k === "" ? "/" : named(it)}</span>${tag(it)}</button>`
		}
		main.innerHTML = `<div class="mapview" style="width:${width}px;height:${height}px">
			<svg width="${width}" height="${height}" aria-hidden="true">${lines}</svg>${nodes}
		</div>`
	}

	// a path, as a chip: click it and the files go there (not in this tree: plain text)
	const chip = (at: string[], note?: string) => {
		const c = items.has(key(at))
			? `<button class="fchip" data-reveal="${esc(key(at))}" title="go to /${esc(key(at))}">/${
				esc(at.map(short).join("/"))
			}</button>`
			: `<code title="not in this tree">/${esc(at.map(short).join("/"))}</code>`
		return note === undefined ? c : `${c} <span class="fnote">${esc(note)}</span>`
	}
	// an attribute's value: what points somewhere is a chip there; the rest, short
	function shown(k: string, v: unknown): string {
		// a pointer to a node: { id, at, hash? }
		if (isMap(v) && isPath(v.at)) return chip(v.at)
		// a folder, as a path
		if (k === "ermine.process.cwd" && isPath(v)) return chip(v)
		// a wire: [input, den, path] triples, each "input ← path"
		if (
			k === "ermine.process.args" && isPath(v) && v.length > 0 && v.length % 3 === 0 &&
			v.every((x, i) => i % 3 !== 2 || x.startsWith("/"))
		) {
			let out = ""
			for (let i = 0; i < v.length; i += 3) {
				out += `<span class="wire"><span class="fnote">${esc(v[i])} ←</span> ${
					chip(split(v[i + 2]), `on ${denName(v[i + 1])}`)
				}</span>`
			}
			return out
		}
		return esc(typeof v === "string" ? v : brief(v, 200))
	}

	// what runs it: a thing's runner's function; a runner's own; a program's, the runner here that
	// takes its type. none: undefined
	function liveOf(it: Item): { fn: unknown; name: string } | undefined {
		const t = thingKind(it)
		if (t && typeof it.live === "function") return { fn: it.live, name: `the ${t} runner` }
		if (typeof it.value === "function") return { fn: it.value, name: `${it.name}, a runner` }
		const type = it.attributes?.["ermine.type"]
		if (typeof type !== "string") return undefined
		for (const o of items.values()) {
			if (o.attributes?.[TAKES] === type && typeof o.value === "function") {
				return { fn: o.value, name: `the ${o.name} runner, which runs ${it.name}` }
			}
		}
		return undefined
	}
	let lived: { fn: unknown; name: string } | undefined
	function liveHtml(it: Item): string | undefined {
		const l = liveOf(it)
		lived = l
		if (!l) {
			if (thingKind(it) && it.from === "away") {
				return `<p class="none">its code runs on the other den, and stays there</p>`
			}
			return undefined
		}
		const home = origin(l.fn)
		return `<p class="group">what runs it: ${esc(l.name)}</p>
			<div class="code-peek">${linesHtml(String(l.fn))}</div>
			<p class="code-acts"><button class="button" data-live>open it wide</button>${
			home ? ` written at ${codeLink(home.name, home.line, `${home.name}:${home.line}`)}` : ""
		}</p>`
	}

	function drawInfo() {
		const it = (picked !== undefined ? items.get(picked) : undefined) ?? items.get(key(here))
		if (!it) return void (info.innerHTML = "")
		const rows: [string, string, string?][] = [["where", esc("/" + it.path.join("/"))]]
		if (!isLevel(it)) {
			rows.push(["id", esc(typeof it.id === "symbol" ? String(it.id.description) : it.id)])
		}
		if (it.from && FROM[it.from]) rows.push(["from", esc(FROM[it.from])])
		const c = last(it)
		if (c) {
			const at = siteAt(c)
			rows.push(["changed", siteHtml(at, `${clock(c.time)} · ${ago(c.time)}`)])
			rows.push(["by", siteHtml(at, by(it))])
			if (at) rows.push(["in the code", siteHtml(at)])
		}
		const attrs = Object.entries(it.attributes ?? {}).sort(([a], [b]) =>
			a === OUT ? -1 : b === OUT ? 1 : a < b ? -1 : 1
		)
		for (const [k, v] of attrs) {
			rows.push([k === OUT ? "out" : k, shown(k, v), k === OUT ? "out" : undefined])
		}
		const enter = isFolder(it) && it.names.length > 0 && key(here) !== it.key && view !== "map"
		const board = typeof it.id === "string" && on.isThing(it.id)
		info.innerHTML = `<div class="hero${fresh(it.key)}" style="${blink(it.key)}">${
			icon(it, "huge")
		}
				<p class="title">${it.key === "" ? "the root" : named(it)}</p>
				<p class="what">${esc(kind(it))}${thingKind(it) ? "" : ` · ${esc(size(it))}`}</p>
			</div>
			<dl>${
			rows.map(([k, v, cls]) =>
				`<dt${cls ? ` class="${cls}"` : ""}>${esc(k)}</dt><dd${
					cls ? ` class="${cls}"` : ""
				}>${v}</dd>`
			).join("")
		}</dl>
			${it.key === "" ? "" : liveHtml(it) ?? preview(it)}
			<div class="acts">${
			board
				? `<button class="button accent" data-board="${esc(it.key)}">show on the board</button>`
				: ""
		}${enter ? `<button class="button" data-enter="${esc(it.key)}">go in</button>` : ""}</div>`
	}

	function drawStatus() {
		const at = items.get(key(here))
		const newest =
			[...items.values()].filter((it) => !isLevel(it)).sort((a, b) =>
				(seen.get(b.key) ?? 0) - (seen.get(a.key) ?? 0) || time(b) - time(a)
			)[0]
		const things = new Set([...items.values()].filter((it) => thingKind(it)).map((it) => it.id))
		status.innerHTML =
			`<span>${items.size} nodes in this den's tree</span><span class="dot">·</span><span>${
				at?.names.length ?? 0
			} here</span><span class="dot">·</span><span>${things.size} running</span>${
				newest && time(newest)
					? `<span class="fill"></span><span>last change: <b>${esc(short(newest.name))}</b>, ${
						esc(ago(time(newest)))
					}, by ${siteHtml(siteAt(last(newest)), by(newest))}</span>`
					: ""
			}`
	}

	// ---- what's done to it. a second click on the same thing soon after is a double click,
	// counted here: the browser's own can miss when the drawing between the clicks is new ----
	let was = { what: "", at: 0 }
	const twice = (what: string) => {
		const now = performance.now()
		const again = was.what === what && now - was.at < 450
		was = again ? { what: "", at: 0 } : { what, at: now }
		return again
	}
	root.addEventListener("click", (e) => {
		const t = e.target as Element
		const twist = t.closest<HTMLElement>("[data-twist]")
		if (twist) {
			const k = twist.dataset.twist!
			open.has(k) ? open.delete(k) : open.add(k)
			return draw()
		}
		const place = t.closest<HTMLElement>("[data-go]")
		if (place) {
			const path = split(place.dataset.go ?? "")
			if (view === "columns" || view === "map") {
				here = path
				picked = path.length ? key(path) : undefined
				return draw()
			}
			return go(path)
		}
		const reveal_ = t.closest<HTMLElement>("[data-reveal]")
		if (reveal_) {
			const it = items.get(reveal_.dataset.reveal!)
			if (!it) return
			told(it)
			if (view === "icons" || view === "list") {
				for (let i = 1; i < it.path.length; i++) open.add(key(it.path.slice(0, i)))
				return go(view === "icons" ? parent(it.path) : here, it.key)
			}
			return pick(it.key)
		}
		const v = t.closest<HTMLElement>(".views [data-view]")
		if (v) {
			view = v.dataset.view as View
			bring = true
			try {
				localStorage.setItem(KEPT, view)
			} catch { /* kept for this visit only */ }
			return draw()
		}
		if (t.closest("[data-live]") && lived) return on.live(lived.name, lived.fn)
		const b = t.closest<HTMLElement>("[data-board]")
		if (b) {
			const it = items.get(b.dataset.board!)
			return it && told(it)
		}
		const enter = t.closest<HTMLElement>("[data-enter]")
		if (enter) return activate(items.get(enter.dataset.enter!)!)
		const item = t.closest<HTMLElement>("[data-key]")
		if (item && main.contains(item)) {
			const it = items.get(item.dataset.key!)
			if (!it) return
			if (twice(it.key)) return activate(it)
			told(it)
			return pick(it.key)
		}
		if (main.contains(t) && (view === "icons" || view === "list")) {
			picked = undefined
			draw()
		}
	})
	root.addEventListener("keydown", (e) => {
		const item = (e.target as Element).closest<HTMLElement>("[data-key]")
		if (item && main.contains(item) && e.key === "Enter") {
			e.preventDefault()
			const it = items.get(item.dataset.key!)
			if (it) activate(it)
		} else if (item && main.contains(item) && e.key === " ") {
			e.preventDefault()
			pick(item.dataset.key!)
		} else if (e.key === "Backspace" && here.length && (view === "icons" || view === "list")) {
			e.preventDefault()
			go(parent(here), key(here))
		}
	})
	// a thing dragged out: its path and id, for an in-port to take (main.ts' drop)
	root.addEventListener("dragstart", (e) => {
		const el = (e.target as Element).closest<HTMLElement>("[data-key], [data-key-drag]")
		const it = el && items.get(el.dataset.key ?? el.dataset.keyDrag ?? "")
		if (!it || typeof it.id !== "string" || !e.dataTransfer) return
		e.dataTransfer.setData("text/x-ermine-path", `/${it.key}`)
		e.dataTransfer.setData("text/x-ermine-id", it.id)
		e.dataTransfer.setData("text/plain", `/${it.key}`)
		e.dataTransfer.effectAllowed = "link"
	})
	back.addEventListener("click", () => {
		if (!past.length) return
		ahead.push(here)
		here = past.pop()!
		picked = undefined
		draw()
	})
	forward.addEventListener("click", () => {
		if (!ahead.length) return
		past.push(here)
		here = ahead.pop()!
		picked = undefined
		draw()
	})

	// a node picked elsewhere (the board): picked here too, its folders opened
	function reveal(path: string[]) {
		const k = key(path)
		if (!items.has(k)) return void (wanted = [...path])
		for (let i = 1; i < path.length; i++) open.add(key(path.slice(0, i)))
		const shown = path.length > here.length && path.slice(0, here.length).join("/") === key(here)
		const folder = view === "icons" ? parent(path) : view === "list" && !shown ? [] : here
		if (key(folder) !== key(here)) {
			past.push(here)
			ahead.length = 0
		}
		here = folder
		bring = true
		pick(k)
	}

	// drawn again whenever what it read changes; the times now and then
	hosted(() => s.createEffect(model, landed, () => false))
	setInterval(later, 15_000)
	onMaps(later)

	return {
		select: (path: Path) => reveal([...path]),
		selected: (): Path => picked !== undefined ? items.get(picked)?.path ?? here : here,
	}
}
