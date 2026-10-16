/// <reference lib="dom" />
// files.ts: the whole graph as a file browser, Finder's or Dolphin's way. On the left the places
// (the root, what's at the top, what changed last); in the middle the nodes as icons, as a list
// (folders open in place) or as columns (one a level, walked by clicking); on the right the one
// picked: its value, its last change (when, who, where in the code). Drawn from what the graph
// holds (an effect reads every node), so a change shows here as it lands, the changed item lit up
// for a moment. A double click goes into a node with names under it, or opens it in the editor.
// Beside the graph, what the scheduler is doing: each computation's latest run, as its onRunStart
// and onRunEnd tell (the scheduler keeps no names: world.ts does). A run waiting on a promise is
// pending; the nodes it read wait with it, and show so. The map view draws the whole graph as a
// tree, and a pending run (or the one picked) beside it, a line to each node it read.
import type { ChangeHeader } from "@ermine/node/entry"
import type { Run, World } from "./world.ts"
import { BUILD, LOADERS, SRC } from "./map.ts"

type Item = {
	path: string[]
	key: string // the path joined by /, the root ""
	name: string
	id: string | symbol
	value: unknown
	change?: ChangeHeader
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

// ---- what each item is, in words ----
const ext = (name: string) => (name.includes(".") ? name.split(".").pop()! : "")
const TEXTS: Record<string, string> = {
	c: "C source",
	h: "C header",
	js: "JavaScript",
	ts: "TypeScript",
	json: "JSON text",
	md: "Markdown",
}
function valueKind(it: Item) {
	const v = it.value
	if (v instanceof Uint8Array) return ext(it.name) === "wasm" ? "WebAssembly" : "bytes"
	if (typeof v === "string") return TEXTS[ext(it.name)] ?? "text"
	if (Array.isArray(v)) return "list"
	if (v !== null && typeof v === "object") return "record"
	return v === undefined ? undefined : typeof v
}
function kind(it: Item) {
	if (it.key === "") return "the root"
	const v = valueKind(it)
	const n = it.names.length
	if (!n) return v ?? "empty"
	const under = `${n} ${n === 1 ? "name" : "names"}`
	return v ? `${v}, ${under}` : `folder, ${under}`
}
const bytes = (n: number) =>
	n < 1024
		? `${n} B`
		: n < 1024 * 1024
		? `${(n / 1024).toFixed(1)} KB`
		: `${(n / 1048576).toFixed(1)} MB`
function size(it: Item) {
	const v = it.value
	if (v instanceof Uint8Array) return bytes(v.length)
	if (typeof v === "string") return bytes(new TextEncoder().encode(v).length)
	if (Array.isArray(v)) return `${v.length} items`
	if (v !== null && typeof v === "object") return `${Object.keys(v).length} fields`
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
const who = (c?: ChangeHeader) => (c?.actor === undefined ? "—" : String(c.actor))
function site(c?: ChangeHeader) {
	const at = c?.external?.at(-1)
	if (!at) return undefined
	const file = at.file.split(/[/\\]/).pop()
	return `${at.function ? at.function + " · " : ""}${file}:${at.line}${
		at.column ? ":" + at.column : ""
	}`
}

// ---- icons: a folder, tinted by where it is; a page, with a band saying what's in it ----
const TINT: Record<string, [string, string]> = {
	root: ["#ffd95e", "#fff0a6"],
	src: ["#ffa9cf", "#ffd2e6"],
	build: ["#94c6ff", "#c8e2ff"],
	loaders: ["#8ddbb5", "#c3f0da"],
	other: ["#c3b2ff", "#e0d6ff"],
}
const under = (path: string[], at: string[]) =>
	path.length >= at.length && at.every((n, i) => path[i] === n)
function tint(path: string[]) {
	if (!path.length) return TINT.root
	if (under(path, SRC)) return TINT.src
	if (under(path, BUILD)) return TINT.build
	if (under(path, LOADERS)) return TINT.loaders
	return TINT.other
}
const BANDS: Record<string, [string, string, string]> = {
	// band, its ink, its word
	c: ["#ff2284", "#fff", "C"],
	h: ["#2269ff", "#fff", "H"],
	wasm: ["#40dcba", "#000", "WASM"],
	js: ["#ffff88", "#000", "JS"],
	record: ["#ffd84d", "#000", "{ }"],
	bytes: ["#b3a5b8", "#fff", "BIN"],
	text: ["#d9cfdd", "#000", "TXT"],
}
function band(it: Item) {
	const v = it.value
	if (v === undefined) return undefined
	const e = ext(it.name)
	if (BANDS[e]) return BANDS[e]
	if (v instanceof Uint8Array) return BANDS.bytes
	if (typeof v === "string") return BANDS.text
	return BANDS.record
}

function folderSvg([back, front]: [string, string]) {
	return `<svg viewBox="0 0 64 52" aria-hidden="true">
		<path d="M3,9 Q3,4 8,4 H23 Q26,4 28,7 L30,10 H56 Q61,10 61,15 V45 Q61,49 57,49 H7 Q3,49 3,45 Z" fill="${back}"/>
		<path d="M3,19 Q3,15 7,15 H57 Q61,15 61,19 V45 Q61,49 57,49 H7 Q3,49 3,45 Z" fill="${front}"/>
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
function icon(it: Item, size: "small" | "big" | "huge") {
	const folder = it.names.length > 0 || it.key === ""
	return `<span class="icon ${size}${folder ? " folder" : ""}">${
		folder ? folderSvg(tint(it.path)) : pageSvg(it, size === "small")
	}</span>`
}

// a computation's icon: a cog for a computer (it makes a value); an arrow out of a box for an
// effect (it acts on what it read)
function runIcon(kind: "compute" | "effect", size: "small" | "huge") {
	const svg = kind === "compute"
		? `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="#fff" stroke="#2269ff" stroke-width="2.6" stroke-dasharray="2.1 1.55"/><circle cx="8" cy="8" r="2" fill="#2269ff"/></svg>`
		: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3.5" width="9" height="9" rx="1" fill="#fff" stroke="#000" stroke-width="1"/><path d="M6,8 H14.5 M11.5,5 L14.5,8 L11.5,11" fill="none" stroke="#ff2284" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
	return `<span class="icon ${size} run-icon ${kind}">${svg}</span>`
}

// a soft curve from a to b, a little off true, the same each time for the same pair
function curve(key: string, ax: number, ay: number, bx: number, by: number) {
	let h = 2166136261
	for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
	const off = ((h >>> 0) / 4294967296 - 0.5) * 8
	const mx = (ax + bx) / 2
	return `M${ax},${ay} C${mx + off},${ay} ${mx - off},${by + off / 2} ${bx},${by}`
}

// ---- a value, a few lines of it ----
function preview(v: unknown) {
	if (v === undefined) return `<p class="none">no value: only names under it</p>`
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
		const lines = (JSON.stringify(v, null, 2) ?? String(v)).split("\n")
		text = lines.slice(0, 16).join("\n") + (lines.length > 16 ? "\n…" : "")
	}
	return `<pre class="peek">${esc(text)}</pre>`
}

// ---- the browser ----
export function createFiles(
	root: HTMLElement,
	world: World,
	onOpen: (path: string[]) => void,
) {
	const $ = <T extends Element = HTMLElement>(q: string) => root.querySelector(q) as T
	const side = $(".side"), main = $(".main"), info = $(".info"), crumbs = $(".crumbs")
	const status = $(".status"), back = $<HTMLButtonElement>(".back")
	const forward = $<HTMLButtonElement>(".forward")

	let view: View = "list"
	try {
		const kept = localStorage.getItem("catclock:files:view") as View | null
		if (kept && VIEWS.includes(kept)) view = kept
	} catch { /* no storage here: the list it is */ }
	let here: string[] = [] // the folder shown (icons, list); columns and the map walk from the root
	let picked: string | undefined // the item picked, by key
	let pickedRun: string | undefined // or a computation picked, by name
	const open = new Set<string>() // folders open in the list
	let opened = false // every folder starts open, once
	const past: string[][] = [], ahead: string[][] = []

	// ---- what the graph holds: every node, walked from the root (tracked) ----
	function model(): Items {
		const items: Items = new Map()
		const walk = (path: string[], ids: (string | symbol)[]) => {
			const id = world.id(path)
			if (id === undefined) return
			const again = ids.includes(id)
			const names = again ? [] : world.list(path)
			items.set(key(path), {
				path,
				key: key(path),
				name: path.at(-1) ?? "/",
				id,
				value: world.places.readValue("value", id),
				change: world.places.readChange("value", id),
				attributes: world.places.readValue("attributes", id) as
					| Record<string, unknown>
					| undefined,
				names,
				again,
			})
			for (const name of names) walk([...path, name], [...ids, id])
		}
		walk([], [])
		return items
	}
	let items: Items = new Map()
	// each id's items (a node placed twice is two)
	let byId = new Map<string | symbol, string[]>()

	// what changed since the last look: lit up for a moment; seen, in order, for "changed lately"
	const lit = new Map<string, number>()
	const seen = new Map<string, number>()
	let looks = 0
	function landed(next: Items) {
		const now = performance.now()
		if (looks++) {
			for (const [k, it] of next) {
				const was = items.get(k)
				if (!was || was.change !== it.change || key(was.names) !== key(it.names)) {
					lit.set(k, now)
					seen.set(k, looks)
				}
			}
		}
		if (!opened) {
			opened = true
			for (const [k, it] of next) if (it.names.length) open.add(k)
		}
		items = next
		byId = new Map()
		for (const [k, it] of items) byId.set(it.id, [...(byId.get(it.id) ?? []), k])
		if (!items.has(key(here))) here = []
		if (picked !== undefined && !items.has(picked)) picked = undefined
		draw()
	}

	// ---- what the scheduler is doing: each named computation's latest run (world.ts keeps them);
	// drawn soon after each is told ----
	type Doing = Run
	const doing = world.runs
	world.onRun((run) => run.name !== "the files" && later())
	const pendings = () => [...doing.values()].filter((d) => d.state === "pending")
	// the pending runs that read an item
	const waits = (it: Item) => pendings().filter((d) => d.reads.includes(it.id))
	const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
	const since = (d: Doing) =>
		`<span class="ticking" data-since="${d.since}">${secs(performance.now() - d.since)}</span>`
	const short = (d: Doing) => (d.state === "pending" ? since(d) : d.state)
	function stateOf(d: Doing) {
		if (d.state === "pending") return `pending, ${since(d)}`
		if (d.state === "running") return "running"
		if (d.took === undefined) return d.state
		return `${d.state}, ${d.took < 10 ? d.took.toFixed(1) : Math.round(d.took)} ms`
	}
	// a pending run's wait, counted up in place: no redraw for it
	setInterval(() => {
		for (const el of root.querySelectorAll<HTMLElement>(".ticking")) {
			el.textContent = secs(performance.now() - Number(el.dataset.since))
		}
	}, 100)

	// lit up for a moment, and read by a pending run: classes. blink: how far its blink has got,
	// for its style (drawn again mid-blink, it carries on rather than starting over)
	const fresh = (k: string) => {
		const it = items.get(k)
		const wait = it && waits(it).length ? " waits" : ""
		const at = lit.get(k)
		if (at === undefined) return wait
		if (performance.now() - at > 1800) return (lit.delete(k), wait)
		return `${wait} fresh`
	}
	const blink = (k: string) => {
		const at = lit.get(k)
		return at === undefined ? "" : `--age:-${Math.round(performance.now() - at)}ms;`
	}
	// read by a pending run: a small lemon mark beside it
	const hourglass = (it: Item) =>
		waits(it).length
			? `<span class="glass" title="read by a pending run" aria-label="read by a pending run"></span>`
			: ""

	// children of a node: folders first, then by name
	const kids = (it: Item) =>
		it.names
			.map((n) => items.get(key([...it.path, n])))
			.filter((c): c is Item => c !== undefined)
			.sort((a, b) =>
				Number(b.names.length > 0) - Number(a.names.length > 0) || a.name.localeCompare(b.name)
			)

	// ---- going places ----
	function go(path: string[], pick?: string) {
		if (key(path) !== key(here)) {
			past.push(here)
			ahead.length = 0
		}
		here = path
		picked = pick
		pickedRun = undefined
		draw()
	}
	function activate(it: Item) {
		if (it.names.length && !it.again && view !== "map") {
			if (view === "columns") pick(it.key)
			else go(it.path)
		} else if (it.key !== "") onOpen(it.path)
	}
	function pick(k: string) {
		picked = k
		pickedRun = undefined
		const it = items.get(k)
		if (view === "columns" && it) here = it.names.length ? it.path : parent(it.path)
		draw()
	}

	// ---- drawing: never while a button is held down in here (what it pressed would go, and its
	// click with it); owed, and drawn once it's let go ----
	let holding = false, owed = false, soon = 0
	const later = () => (soon ||= requestAnimationFrame(() => (soon = 0, draw())))
	root.addEventListener("pointerdown", () => (holding = true))
	addEventListener("pointerup", () => {
		holding = false
		if (owed) later()
	}, true)

	function draw() {
		if (!items.size) return
		if (holding) return void (owed = true)
		owed = false
		const focused = document.activeElement instanceof HTMLElement &&
				main.contains(document.activeElement)
			? document.activeElement.dataset.key ?? document.activeElement.dataset.run
			: undefined
		const scroll = { top: main.scrollTop, left: main.scrollLeft }
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
		if (cols) cols.scrollLeft = cols.scrollWidth
		if (focused !== undefined) {
			main.querySelector<HTMLElement>(
				`[data-key="${CSS.escape(focused)}"], [data-run="${CSS.escape(focused)}"]`,
			)?.focus({ preventScroll: true })
		}
	}

	function drawCrumbs() {
		const trail = (view === "columns" || view === "map") && picked !== undefined
			? items.get(picked)?.path ?? here
			: here
		let out = `<button class="crumb" data-go="">${
			icon(items.get("") ?? blank([]), "small")
		}<span>graph</span></button>`
		trail.forEach((name, i) => {
			out += `<span class="sep" aria-hidden="true">›</span><button class="crumb${
				i === trail.length - 1 ? " last" : ""
			}" data-go="${esc(key(trail.slice(0, i + 1)))}">${esc(name)}</button>`
		})
		crumbs.innerHTML = out
	}

	function drawSide() {
		const top = items.get("")
		let out = `<p class="group">graph</p>`
		const place = (it: Item, label = it.name) =>
			`<button class="spot${
				key(here) === it.key && !picked && !pickedRun ? " on" : ""
			}" data-go="${esc(it.key)}">${icon(it, "small")}<span>${esc(label)}</span></button>`
		if (top) {
			out += place(top, "the root")
			for (const it of kids(top)) out += place(it)
		}
		// running: what the scheduler is doing, the pending first
		const runs = [...doing.values()].sort((a, b) =>
			Number(b.state === "pending") - Number(a.state === "pending") ||
			a.name.localeCompare(b.name)
		)
		if (runs.length) {
			out += `<p class="group">running</p>`
			for (const d of runs) {
				out += `<button class="spot run ${d.state}${
					pickedRun === d.name ? " on" : ""
				}" data-run="${esc(d.name)}">${runIcon(d.kind, "small")}<span>${
					esc(d.name)
				}</span><em>${short(d)}</em></button>`
			}
		}
		// changed lately: what this window has seen change, newest first; then the rest by time.
		// a node placed twice (a box's) shown once, at its first place
		const recent = [...items.values()]
			.filter((it) => it.value !== undefined && it.key !== "")
			.sort((a, b) =>
				(seen.get(b.key) ?? 0) - (seen.get(a.key) ?? 0) ||
				(b.change?.time ?? 0) - (a.change?.time ?? 0) || a.key.localeCompare(b.key)
			)
			.filter((it, i, all) => all.findIndex((o) => o.id === it.id) === i)
			.slice(0, 4)
		if (recent.length) {
			out += `<p class="group">changed lately</p>`
			for (const it of recent) {
				out += `<button class="spot${picked === it.key ? " on" : ""}${fresh(it.key)}" style="${
					blink(it.key)
				}" data-reveal="${esc(it.key)}">${icon(it, "small")}<span>${esc(it.name)}</span><em>${
					esc(ago(it.change?.time))
				}</em></button>`
			}
		}
		side.innerHTML = out
	}

	const blank = (path: string[]): Item => ({
		path,
		key: key(path),
		name: path.at(-1) ?? "/",
		id: "",
		value: undefined,
		names: [],
	})
	const empty = (what: string) => `<p class="nothing">${esc(what)}</p>`

	function drawIcons() {
		const at = items.get(key(here))
		const list = at ? kids(at) : []
		main.innerHTML = list.length
			? `<div class="tiles" role="listbox" aria-label="${esc(at!.name)}">${
				list.map((it) =>
					`<button class="tile${picked === it.key ? " sel" : ""}${fresh(it.key)}" style="${
						blink(it.key)
					}" data-key="${esc(it.key)}" role="option" aria-selected="${picked === it.key}">${
						icon(it, "big")
					}${hourglass(it)}<span class="label">${esc(it.name)}</span><span class="sub">${
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
			const folder = it.names.length > 0 && !it.again
			const isOpen = folder && open.has(it.key)
			rows += `<div class="row${picked === it.key ? " sel" : ""}${fresh(it.key)}" style="${
				blink(it.key)
			}" data-key="${esc(it.key)}" role="row" tabindex="0" aria-selected="${picked === it.key}"${
				folder ? ` aria-expanded="${isOpen}"` : ""
			}>
				<span class="name" style="--depth:${depth}">${
				folder
					? `<button class="twisty" data-twist="${esc(it.key)}" tabindex="-1" aria-label="${
						isOpen ? "close" : "open"
					} ${esc(it.name)}">▸</button>`
					: `<span class="twisty"></span>`
			}${icon(it, "small")}<span>${esc(it.name)}</span>${hourglass(it)}</span>
				<span class="kind">${esc(kind(it))}</span>
				<span class="size">${esc(size(it))}</span>
				<span class="when" title="${it.change ? esc(clock(it.change.time)) : ""}">${
				esc(ago(it.change?.time))
			}</span>
				<span class="who">${esc(who(it.change))}</span>
			</div>`
			if (isOpen) { for (const c of kids(it)) row(c, depth + 1) }
		}
		if (at) { for (const it of kids(at)) row(it, 0) }
		main.innerHTML = rows
			? `<div class="table" role="treegrid" aria-label="${esc(at?.name ?? "/")}">
				<div class="row head" role="row"><span>name</span><span>kind</span><span>size</span><span>changed</span><span>by</span></div>
				${rows}
			</div>`
			: empty("nothing under here yet")
	}

	function drawColumns() {
		const trail = picked !== undefined ? items.get(picked)?.path ?? [] : here
		const folders: string[][] = [[]]
		for (let i = 1; i <= trail.length; i++) {
			const it = items.get(key(trail.slice(0, i)))
			if (it?.names.length && !it.again) folders.push(trail.slice(0, i))
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
						}" role="option" aria-selected="${last}">${icon(it, "small")}<span>${
							esc(it.name)
						}</span>${hourglass(it)}${
							it.names.length && !it.again
								? `<span class="more" aria-hidden="true">›</span>`
								: ""
						}</button>`
					}).join("") || empty("empty")
				}</div>`
			}).join("")
		}</div>`
	}

	// the whole graph as a tree, the root on the left; past it, a pending run (or the one picked)
	// with a line to each node it read
	function drawMap() {
		const top = items.get("")
		if (!top) return void (main.innerHTML = empty("nothing here yet"))
		const ROW = 40, COL = 200, PAD = 22, W = 160, H = 30, RUN = 54
		const at = new Map<string, { x: number; y: number }>()
		let rows = 0, deep = 0
		const lay = (it: Item, depth: number) => {
			deep = Math.max(deep, depth)
			const ks = it.again ? [] : kids(it)
			if (!ks.length) return void at.set(it.key, { x: PAD + depth * COL, y: PAD + rows++ * ROW })
			for (const c of ks) lay(c, depth + 1)
			const first = at.get(ks[0].key)!.y, last = at.get(ks.at(-1)!.key)!.y
			at.set(it.key, { x: PAD + depth * COL, y: (first + last) / 2 })
		}
		lay(top, 0)
		const shown = [...doing.values()].filter((d) => d.state === "pending" || d.name === pickedRun)
		const rx = PAD + (deep + 1) * COL + 60
		const width = (shown.length ? rx : PAD + deep * COL) + W + PAD
		const height = Math.max(PAD * 2 + rows * ROW - (ROW - H), PAD * 2 + shown.length * RUN)
		let lines = "", nodes = ""
		for (const [k, p] of at) {
			const it = items.get(k)!
			for (const c of it.again ? [] : kids(it)) {
				const q = at.get(c.key)!
				lines += `<path class="tie" d="${
					curve(c.key, p.x + W, p.y + H / 2, q.x, q.y + H / 2)
				}"/>`
			}
			nodes += `<button class="mnode${picked === k ? " sel" : ""}${fresh(k)}" data-key="${
				esc(k)
			}" style="${blink(k)}left:${p.x}px;top:${p.y}px">${icon(it, "small")}<span>${
				esc(k === "" ? "graph" : it.name)
			}</span>${hourglass(it)}</button>`
		}
		const top0 = (height - shown.length * RUN) / 2
		shown.forEach((d, i) => {
			const y = top0 + i * RUN + (RUN - H) / 2
			for (const id of d.reads) {
				for (const k of byId.get(id) ?? []) {
					const p = at.get(k)
					if (p) {
						lines += `<path class="reads ${d.state}" d="${
							curve(d.name + k, p.x + W, p.y + H / 2, rx, y + H / 2)
						}"/>`
					}
				}
			}
			nodes += `<button class="mrun ${d.state}${pickedRun === d.name ? " sel" : ""}" data-run="${
				esc(d.name)
			}" style="left:${rx}px;top:${y}px">${runIcon(d.kind, "small")}<span>${
				esc(d.name)
			}</span><em>${short(d)}</em></button>`
		})
		main.innerHTML = `<div class="mapview" style="width:${width}px;height:${height}px">
			<svg width="${width}" height="${height}" aria-hidden="true">${lines}</svg>${nodes}
		</div>`
	}

	function drawInfo() {
		const d = pickedRun === undefined
			? undefined
			: [...doing.values()].find((d) => d.name === pickedRun)
		if (d) return drawRun(d)
		const it = (picked !== undefined ? items.get(picked) : undefined) ?? items.get(key(here))
		if (!it) return void (info.innerHTML = "")
		const rows: [string, string][] = [["where", "/" + it.path.join("/")]]
		rows.push(["id", typeof it.id === "symbol" ? String(it.id.description) : it.id.slice(0, 8)])
		if (it.change) {
			rows.push(["changed", `${clock(it.change.time)} · ${ago(it.change.time)}`])
			rows.push(["by", who(it.change)])
			const s = site(it.change)
			if (s) rows.push(["in the code", s])
			const n = it.change.op?.patches.length
			if (n) rows.push(["last edit", `${n} ${n === 1 ? "patch" : "patches"}`])
		}
		for (const [k, v] of Object.entries(it.attributes ?? {})) {
			rows.push([k, typeof v === "string" ? v : JSON.stringify(v)])
		}
		const waiting = waits(it)
		const enter = it.names.length > 0 && !it.again && key(here) !== it.key && view !== "map"
		const edit = it.key !== "" && it.value !== undefined
		info.innerHTML = `<div class="hero${fresh(it.key)}" style="${blink(it.key)}">${
			icon(it, "huge")
		}${hourglass(it)}
				<p class="title">${esc(it.key === "" ? "the root" : it.name)}</p>
				<p class="what">${esc(kind(it))} · ${esc(size(it))}</p>
			</div>
			${
			waiting.map((d) =>
				`<button class="waiting" data-run="${
					esc(d.name)
				}"><span class="glass"></span><span>read by <b>${esc(d.name)}</b>, pending ${
					since(d)
				}</span></button>`
			).join("")
		}
			<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
			${it.key === "" ? "" : preview(it.value)}
			<div class="acts">${
			edit
				? `<button class="button accent" data-open="${esc(it.key)}">open in the editor</button>`
				: ""
		}${enter ? `<button class="button" data-enter="${esc(it.key)}">go in</button>` : ""}</div>`
	}

	// a computation: what it is, how its latest run ended, what that run read
	function drawRun(d: Doing) {
		const read = d.reads.flatMap((id) => byId.get(id) ?? []).map((k) => items.get(k)!)
		const said = d.state === "pending"
			? "Waiting on a promise. What it makes stays as it was until it settles."
			: d.state === "failed"
			? "Its latest run threw."
			: d.kind === "compute"
			? "Runs again when what it read changes, and sets what it makes."
			: "Runs again when what it read changes, then acts on it."
		info.innerHTML = `<div class="hero">${runIcon(d.kind, "huge")}
				<p class="title">${esc(d.name)}</p>
				<p class="what">${d.kind === "compute" ? "a computer" : "an effect"} · ${stateOf(d)}</p>
			</div>
			<p class="said">${esc(said)}</p>
			<dl><dt>runs</dt><dd>${d.n}</dd><dt>latest</dt><dd>${stateOf(d)}</dd>${
			d.error === undefined ? "" : `<dt>threw</dt><dd>${esc(String(d.error))}</dd>`
		}</dl>
			<p class="group">it read ${read.length} ${read.length === 1 ? "node" : "nodes"}</p>
			<div class="reads">${
			read.map((it) =>
				`<button class="spot" data-reveal="${esc(it.key)}">${icon(it, "small")}<span>/${
					esc(it.key)
				}</span></button>`
			).join("")
		}</div>`
	}

	function drawStatus() {
		const at = items.get(key(here))
		const last =
			[...items.values()].sort((a, b) =>
				(seen.get(b.key) ?? 0) - (seen.get(a.key) ?? 0) ||
				(b.change?.time ?? 0) - (a.change?.time ?? 0)
			)[0]
		const wait = pendings()
		status.innerHTML =
			`<span>${items.size} nodes in the graph</span><span class="dot">·</span><span>${
				at?.names.length ?? 0
			} here</span>${
				wait.map((d) =>
					`<span class="dot">·</span><span class="pending"><span class="glass"></span> <b>${
						esc(d.name)
					}</b> pending, ${since(d)}</span>`
				).join("")
			}${
				last?.change
					? `<span class="fill"></span><span>last change: <b>${esc(last.name)}</b>, ${
						esc(ago(last.change.time))
					}, by ${esc(who(last.change))}</span>`
					: ""
			}`
	}

	// ---- what's done to it. a second click on the same thing soon after is a double click,
	// counted here: the browser's own can miss when the drawing between the clicks is new ----
	let last = { what: "", at: 0 }
	const twice = (what: string) => {
		const now = performance.now()
		const again = last.what === what && now - last.at < 450
		last = again ? { what: "", at: 0 } : { what, at: now }
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
			const path = place.dataset.go ? place.dataset.go.split("/") : []
			if (view === "columns" || view === "map") {
				here = path
				picked = path.length ? key(path) : undefined
				pickedRun = undefined
				return draw()
			}
			return go(path)
		}
		const reveal = t.closest<HTMLElement>("[data-reveal]")
		if (reveal) {
			const it = items.get(reveal.dataset.reveal!)
			if (!it) return
			if (view === "icons" || view === "list") return go(parent(it.path), it.key)
			return pick(it.key)
		}
		const run = t.closest<HTMLElement>("[data-run]")
		if (run) {
			pickedRun = run.dataset.run
			picked = undefined
			return draw()
		}
		const v = t.closest<HTMLElement>(".views [data-view]")
		if (v) {
			view = v.dataset.view as View
			try {
				localStorage.setItem("catclock:files:view", view)
			} catch { /* kept for this visit only */ }
			return draw()
		}
		const o = t.closest<HTMLElement>("[data-open]")
		if (o) return onOpen(items.get(o.dataset.open!)!.path)
		const enter = t.closest<HTMLElement>("[data-enter]")
		if (enter) return activate(items.get(enter.dataset.enter!)!)
		const item = t.closest<HTMLElement>("[data-key]")
		if (item && main.contains(item)) {
			const it = items.get(item.dataset.key!)
			if (!it) return
			return twice(it.key) ? activate(it) : pick(it.key)
		}
		if (main.contains(t) && (view === "icons" || view === "list")) {
			picked = undefined
			pickedRun = undefined
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

	// drawn again whenever what it read changes; the times now and then
	world.effect("the files", model, landed)
	setInterval(later, 15_000)

	return {
		// a node opened elsewhere (the map, the editor): picked here too
		reveal(path: string[]) {
			const k = key(path)
			if (!items.has(k)) return
			for (let i = 1; i < path.length; i++) open.add(key(path.slice(0, i)))
			const shown = path.length > here.length && under(path, here)
			const folder = view === "icons" ? parent(path) : view === "list" && !shown ? [] : here
			if (key(folder) !== key(here)) {
				past.push(here)
				ahead.length = 0
			}
			here = folder
			pick(k)
		},
	}
}
