/** @jsxImportSource @ermine */
// the explorer, on @ermine/system: a graph as a finder (src/graph.ts says what a graph answers;
// graphs.ts is the host's side, answering for "page", this page's own graph, and handing "mac"
// asks to the relay). places down the side, a list, columns or a map in the middle, the one picked
// on the right: what it is, its value in full (edited with the patches it makes shown live), its
// attributes, who reads it, its last change (who, when, where in the code), why it is so, its
// status, and its trace back to the code that wrote it. a line along the bottom. live: on each tick
// of the host's clock (/host/graphs/tick), while it shows, it asks every 2 s for the versions of
// what's on screen, and again for what changed.
//
// an explorer's state is all in the graph, per explorer (name): what its graph said back at
// <den>/finder/<name>/… (lists/<place>, node, trace, map, found, lit, said; and the asks it waits
// on: latest, mores, known, polling, heard), what it shows at <this browser>/page/finder/<name>/…
// (at, past, view, folder, expanded, menu, renaming, editing, patch, confirm, drop, told, q, depth,
// folded, mapby). its actions are at on/finder-<name>-…, its memos and effects finder-<name>-…,
// under the program's node. what a graph says back lands in the host's inbox for it
// (/host/graphs/<graph>/inbox/<name>); an effect here reads it, writes what it says, and tells the
// host it took them. a place: a path from the root, or "#<id>" for a node by its id (one not
// reachable from the root, as a process's own node: the trace and the attributes lead there)
import { bind, type Child, handler } from "@ermine/render/h"
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	hasNode,
	list,
	patch,
	peep,
	read,
} from "@ermine/system"
import edit from "@ermine/core/changeable/edit"
import { enc, kid } from "../paths.ts"
import {
	changeable,
	CHANGEABLE_WORDS,
	graphAt,
	type GraphName,
	inboxOf,
	NOW,
	TICK,
} from "./graphs.ts"
import { BROWSER, finderAt, RELAY, SHOWING, shows } from "./places.ts"

type Row = { name: string; folder?: boolean; type?: string; brief?: string; when?: number }
type List = { version: unknown; rows: Row[] } | null
// deno-lint-ignore no-explicit-any
type Any = any

// ---- words for things ----
const short = (name: string) =>
	/^[0-9a-f-]{20,}$/.test(name) || /^proc:/.test(name) ? name.slice(0, 13) + "…" : name
const isId = (p: string) => p.startsWith("#")
const split = (p: string) => p.split("/").filter(Boolean)
const join = (parts: string[]) => "/" + parts.join("/")
const nameOf = (p: string) => isId(p) ? short(p.slice(1)) : split(p).at(-1) ?? "/"
function ago(t?: number) {
	if (!t) return ""
	const s = Date.now() / 1000 - t
	if (s < 5) return "just now"
	if (s < 60) return `${Math.floor(s)} s ago`
	if (s < 3600) return `${Math.floor(s / 60)} min ago`
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`
	return `${Math.floor(s / 86400)} days ago`
}
const clock = (t?: number) =>
	t
		? new Date(t * 1000).toLocaleString("en-GB", {
			day: "numeric",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
		: ""
const when = (t?: number) => t ? <span class="g-when" title={clock(t)}>{ago(t)}</span> : null
// a site: its file's name and line; the whole of it in its title
function site(s: Any) {
	if (!s) return null
	const file = String(s.file ?? "").replace(/^file:\/\//, "")
	const base = file.split("/").at(-1) || file
	return (
		<code
			class="g-site"
			title={`${file}:${s.line}${s.column ? ":" + s.column : ""}${
				s.function ? " in " + s.function : ""
			}`}
		>
			{`${base}:${s.line}`}
			{s.function ? <span class="g-fn">{` ${s.function}`}</span> : null}
		</code>
	)
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`
const TYPE: Record<string, string> = {
	text: "text",
	number: "a number",
	boolean: "true or false",
	null: "null",
	list: "a list",
	record: "a record",
	bytes: "bytes",
	function: "a function",
	pending: "pending",
	error: "an error",
	bigint: "a big number",
	"typed array": "a typed array",
}
const GLYPH: Record<string, string> = {
	"value write": "✎",
	"attributes write": "✎",
	"children write": "✎",
	run: "⚙",
	call: "ƒ",
	handler: "ƒ",
	outside: "✦",
	host: "⌂",
	process: "▣",
	scope: "○",
	scopes: "◌",
	computer: "◇",
	node: "◇",
	read: "↖",
	walk: "⋯",
	stop: "✕",
}
const parentOf = (p: string) => p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/"))
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

// ---- icons, as dens and catclock draw them: a folder tinted by where it is, a page with a band
// saying what's in it (dashed: nothing in it). each made once per place it's shown (a node is in
// one place at a time) ----
const TINT: Record<string, [string, string]> = {
	root: ["#ffd95e", "#fff0a6"],
	world: ["#8ddbb5", "#c3f0da"],
	apps: ["#94c6ff", "#c8e2ff"],
	lenses: ["#ffa9cf", "#ffd2e6"],
	other: ["#c3b2ff", "#e0d6ff"],
}
const tintOf = (p: string) => p === "/" ? TINT.root : TINT[split(p)[0]] ?? TINT.other
const BAND: Record<string, [string, string, string]> = {
	function: ["#40dcba", "#000", "LIVE"],
	record: ["#ffd84d", "#000", "{ }"],
	list: ["#ffd84d", "#000", "[ ]"],
	number: ["#2269ff", "#fff", "123"],
	bigint: ["#2269ff", "#fff", "123"],
	bytes: ["#b3a5b8", "#fff", "BIN"],
	"typed array": ["#b3a5b8", "#fff", "BIN"],
	text: ["#d9cfdd", "#000", "TXT"],
	boolean: ["#d9cfdd", "#000", "Y/N"],
	error: ["#ff2e93", "#fff", "ERR"],
	pending: ["#fff0a6", "#000", "…"],
}
const folderSvg = ([back, front]: [string, string]) =>
	`<svg viewBox="0 0 64 52" aria-hidden="true"><path d="M3,9 Q3,4 8,4 H23 Q26,4 28,7 L30,10 H56 Q61,10 61,15 V45 Q61,49 57,49 H7 Q3,49 3,45 Z" fill="${back}"/><path d="M3,19 Q3,15 7,15 H57 Q61,15 61,19 V45 Q61,49 57,49 H7 Q3,49 3,45 Z" fill="${front}"/><path d="M8,19.6 H56" stroke="#fff" stroke-opacity="0.75" stroke-width="1.3" stroke-linecap="round"/></svg>`
function pageSvg(type: string | undefined, small: boolean) {
	const empty = !type || type === "nothing"
	const b = empty ? undefined : BAND[type!] ?? ["#d9cfdd", "#000", "•"]
	return `<svg viewBox="0 0 48 60" aria-hidden="true"><path d="M8,2 H31 L44,15 V54 Q44,58 40,58 H8 Q4,58 4,54 V6 Q4,2 8,2 Z" fill="${
		empty ? "rgba(255,255,255,0.5)" : "#fff"
	}" stroke="rgba(0,0,0,0.3)"${
		empty ? ' stroke-dasharray="3 3"' : ""
	}/><path d="M31,2 V11 Q31,15 35,15 H44" fill="#f4eef7" stroke="rgba(0,0,0,0.3)" stroke-linejoin="round"/>${
		b
			? `<rect x="4.5" y="42" width="39" height="11" fill="${b[0]}"/>` +
				(small
					? ""
					: `<text x="24" y="50.4" text-anchor="middle" font-family="Monaco, Menlo, monospace" font-size="${
						b[2].length > 3 ? 7 : 8
					}" font-weight="700" fill="${b[1]}">${b[2]}</text>`)
			: ""
	}</svg>`
}
const icons = new Map<string, HTMLElement>()
function icon(
	where: string,
	p: string,
	r: { folder?: boolean; type?: string },
	size: "s" | "b" = "s",
) {
	const key = `${where}|${p}|${r.folder ? "f" : r.type ?? ""}|${size}`
	let el = icons.get(key)
	if (!el) {
		el = document.createElement("span")
		el.className = `g-ic g-ic-${size}${r.folder ? " g-ic-folder" : ""}`
		el.innerHTML = r.folder ? folderSvg(tintOf(p)) : pageSvg(r.type, size === "s")
		icons.set(key, el)
	}
	return el
}

// ---- the map, laid out and drawn ----
type Card = { id: string; at: string; name: string; kind: string; type: string }
type Line = { from: string; to: string; kind: string }
const CW = 168, CH = 26, GX = 56, GY = 10
const esc = (t: string) =>
	t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
// trees (place, owner): each card under its first parent, a column a level, leaves one under
// another, a parent level with the middle of its own. reads: a column for each step from what
// nothing feeds, so what's read sits left of what reads it
function layout(map: { by: string; cards: Card[]; edges: Line[] }) {
	const at = new Map<string, { x: number; y: number }>()
	const ids = new Set(map.cards.map((c) => c.id))
	const lines = map.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
	if (map.by === "reads") {
		const ins = new Map<string, string[]>()
		for (const e of lines) ins.set(e.to, [...(ins.get(e.to) ?? []), e.from])
		const rank = new Map<string, number>()
		const rankOf = (id: string, on: Set<string>): number => {
			if (rank.has(id)) return rank.get(id)!
			if (on.has(id)) return 0
			on.add(id)
			const r = Math.max(-1, ...(ins.get(id) ?? []).map((x) => rankOf(x, on))) + 1
			on.delete(id)
			rank.set(id, r)
			return r
		}
		const rows: number[] = []
		for (const c of map.cards) {
			const r = rankOf(c.id, new Set())
			const y = rows[r] ?? 0
			rows[r] = y + 1
			at.set(c.id, { x: r * (CW + GX), y: y * (CH + GY) })
		}
		return { at, lines }
	}
	const kids = new Map<string, string[]>()
	const parent = new Map<string, string>()
	for (const e of lines) {
		if (parent.has(e.to) || e.to === e.from) continue
		parent.set(e.to, e.from)
		kids.set(e.from, [...(kids.get(e.from) ?? []), e.to])
	}
	let leaf = 0
	const place = (id: string, depth: number, seen: Set<string>): number => {
		seen.add(id)
		const ks = (kids.get(id) ?? []).filter((k) => !seen.has(k))
		const ys = ks.map((k) => place(k, depth + 1, seen))
		const y = ys.length ? (ys[0] + ys.at(-1)!) / 2 : leaf++ * (CH + GY)
		at.set(id, { x: depth * (CW + GX), y })
		return y
	}
	const seen = new Set<string>()
	for (const c of map.cards) if (!parent.has(c.id) && !seen.has(c.id)) place(c.id, 0, seen)
	for (const c of map.cards) if (!seen.has(c.id)) place(c.id, 0, seen)
	return { at, lines }
}
const FILL: Record<string, string> = {
	process: "#000",
	computer: "#c9f7e6",
	handler: "#ffff99",
	folder: "#fff0a6",
	value: "#fff",
	empty: "#fffdf6",
}
const GLYPHS: Record<string, string> = {
	process: "▣",
	computer: "⚙",
	handler: "ƒ",
	folder: "▸",
	value: "",
	empty: "",
}
function drawMap(map: { by: string; cards: Card[]; edges: Line[] }, picked: string) {
	const { at, lines } = layout(map)
	const byId = new Map(map.cards.map((c) => [c.id, c]))
	const pickedId = map.cards.find((c) => c.at === picked)?.id
	let w = 0, h = 0
	for (const p of at.values()) (w = Math.max(w, p.x + CW)), (h = Math.max(h, p.y + CH))
	const P = 16
	const path = (a: { x: number; y: number }, b: { x: number; y: number }) => {
		const x1 = a.x + CW, y1 = a.y + CH / 2, x2 = b.x, y2 = b.y + CH / 2
		if (x2 <= x1) {
			// backwards or level: round the side
			return `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`
		}
		const mx = (x1 + x2) / 2
		return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
	}
	const edges = lines.map((e) => {
		const a = at.get(e.from), b = at.get(e.to)
		if (!a || !b) return ""
		const lit = pickedId && (e.from === pickedId ? " out" : e.to === pickedId ? " in" : "")
		return `<path class="m-line m-${e.kind}${lit || ""}" d="${path(a, b)}"/>`
	}).join("")
	const cards = map.cards.map((c) => {
		const p = at.get(c.id)
		if (!p) return ""
		const fill = c.kind === "folder"
			? tintOf(c.at.startsWith("#") ? "/x" : c.at)[1]
			: FILL[c.kind] ?? "#fff"
		const ink = c.kind === "process" ? "#fff" : "#000"
		const g = GLYPHS[c.kind] ?? ""
		const name = c.name.length > 20 ? c.name.slice(0, 19) + "…" : c.name
		return `<g class="m-card${c.id === pickedId ? " picked" : ""}${
			c.kind === "empty" ? " empty" : ""
		}" data-at="${esc(c.at)}" transform="translate(${p.x},${p.y})"><title>${esc(c.at)}${
			byId.get(c.id) ? " · " + esc(c.kind) : ""
		}</title><rect width="${CW}" height="${CH}" rx="4" fill="${fill}"/><text x="${
			g ? 22 : 9
		}" y="17" fill="${ink}">${esc(name)}</text>${
			g ? `<text class="m-glyph" x="8" y="17" fill="${ink}">${g}</text>` : ""
		}</g>`
	}).join("")
	const box = document.createElement("div")
	box.className = "g-mapdraw"
	box.innerHTML = `<svg width="${w + P * 2}" height="${h + P * 2}" viewBox="${-P} ${-P} ${
		w + P * 2
	} ${h + P * 2}" role="img" aria-label="the graph as a map, by ${
		esc(map.by)
	}">${edges}${cards}</svg>`
	return box
}
const KINDS: Record<string, string> = {
	text: "text",
	number: "number",
	boolean: "true/false",
	null: "null",
	list: "list",
	record: "record",
	bytes: "bytes",
	function: "function",
	pending: "pending",
	error: "error",
	bigint: "big number",
	"typed array": "typed array",
	nothing: "empty",
}
const EDITS_AS_JSON = new Set(["number", "boolean", "null", "list", "record"])
// what was typed, diffed against the value into patches (changeable's edit, as slaygrounds' editor
// does): a string's one splice between the ends it shares; a record's or list's keys set, deleted,
// lengths; anything else put whole. these patches are what the graph is sent
const holder = (v: unknown) => typeof v === "object" && v !== null
const alike = (a: unknown, b: unknown) =>
	holder(a) && holder(b) && Array.isArray(a) === Array.isArray(b)
function span(a: string, b: string) {
	const x = Array.from(a), y = Array.from(b)
	let start = 0
	while (start < x.length && start < y.length && x[start] === y[start]) start++
	let end = 0
	while (
		end < x.length - start && end < y.length - start &&
		x[x.length - 1 - end] === y[y.length - 1 - end]
	) end++
	return [
		start,
		x.length - start - end,
		y.slice(start, y.length - end).join("") || undefined,
	] as const
}
function into(a: Any, b: Any, splice: Any) {
	if (Array.isArray(b)) {
		for (let i = 0; i < Math.min(a.length, b.length); i++) onto(a, i, b[i], splice)
		if (b.length > a.length) a.push(...b.slice(a.length))
		else if (b.length < a.length) a.length = b.length
	} else {
		for (const k of Object.keys(b)) onto(a, k, b[k], splice)
		for (const k of Object.keys(a)) if (!(k in b)) delete a[k]
	}
}
function onto(parent: Any, key: string | number, b: Any, splice: Any) {
	const a = parent[key]
	if (Object.is(a, b)) return
	if (typeof a === "string" && typeof b === "string") splice(parent, key, ...span(a, b))
	else if (alike(a, b)) into(a, b, splice)
	else parent[key] = b
}
export function diff(current: unknown, next: unknown): Any[] {
	return edit(current as Any, (draft: Any, { splice }: Any) => {
		if (typeof current === "string" && typeof next === "string") {
			const [start, remove, insert] = span(current, next)
			if (start + remove > 0 || insert !== undefined) splice(current, start, remove, insert)
		} else if (alike(current, next)) into(draft, next, splice)
		else return next
	}) as Any[]
}
// a patch in words, as slaygrounds shows them
const patchWords = (p: Any) =>
	[
		`path ${JSON.stringify(p.path)}`,
		p.range ? `range ${JSON.stringify(p.range)}` : "",
		"value" in p ? `value ${JSON.stringify(p.value)}` : "remove",
	]
		.filter(Boolean).join("  ")
// a text that is a colour (#abc, #aabbcc, rgb(…), hsl(…)): shown as a swatch beside it
const colour = (v: { type: string; text: string }) =>
	v.type === "text" &&
	/^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|hsl)a?\([\d\s.,%/-]+\))$/i.test(v.text.trim())

// the columns: the root's, then each folder on the way to the one picked (a place by id: its own)
function columns(at: string, node: Any, list: (p: string) => List | undefined) {
	if (isId(at)) return node?.children?.length ? [at] : []
	const parts = split(at)
	const out = ["/"]
	for (let i = 1; i <= parts.length; i++) {
		const row = list(out.at(-1)!)?.rows.find((r) => r.name === parts[i - 1])
		if (row && !row.folder) break
		out.push(join(parts.slice(0, i)))
	}
	return out
}

// an explorer. name: its own (its state's place, its actions' and memos' names); label: its words;
// graph: "page" (this page's own) or "mac" (astrobleme's). made inside a program's setup, while it
// renders (not inside a binding that runs again: its actions and memos are made once)
export function Explorer(
	{ name, label, graph: which }: { name: string; label: string; graph: string },
): Child {
	const graph: GraphName = which === "mac" ? "mac" : "page"
	const G = graphAt(graph)
	// its two folders (places.ts): what its graph said back, in the den it looks at (the mac's: the
	// den the relay reaches, known by the time a den's explorer is made: den.tsx), and what it shows,
	// in this page's state
	const at = finderAt(graph === "mac" ? (peep(() => read(RELAY)) as string) : BROWSER, name)
	const F = (k: string) => `${at.answers}/${k}`
	const PF = (k: string) => `${at.shows}/${k}`
	const M = `finder-${name}-`
	const A = (k: string) => `on/${M}${k}`
	const listAt = (p: string) => F(`lists/${enc(p)}`)
	// what can be changed from here: the mac's graph, all of it (signed); the page's, its state
	const may = (p: string) => graph === "mac" || changeable(p)
	const mayInside = (folder: string) => may(kid(folder, "x"))

	// ---- reading and writing, in an action or an effect's act ----
	const now = <T = Any>(path: string): T => peep(() => read(path)) as T
	// a value written; the same again is no write (nothing reads it again)
	const put = (path: string, value: unknown) => {
		const was = now(path)
		if (was !== undefined && same(was, value)) return
		if (!peep(() => hasNode(path))) return void ensureNode(path, value)
		patch(path, [{ path: [], value }])
	}
	const ask = (m: Any) => executeAction(`${G}/ask`, name, m) as string
	const change = (m: Any) => executeAction(`${G}/change`, name, m) as string
	const latest = (asks: Record<string, string>) =>
		put(F("latest"), { ...now<Record<string, string>>(F("latest")), ...asks })

	// what it starts from, put in once
	for (
		const [k, v] of Object.entries({
			lists: null,
			node: null,
			trace: null,
			lit: {},
			said: "",
			found: null,
			map: null,
			// the latest ask of each kind whose answer is still wanted (an older one is let go), the
			// "more…" asks (where their steps go), the versions last seen, the versions asked, the last
			// answer read
			latest: {},
			mores: {},
			known: {},
			polling: { on: false, since: 0 },
			heard: 0,
		})
	) ensureNode(F(k), v)
	for (
		const [k, v] of Object.entries({
			at: "/",
			past: [],
			depth: 6,
			folded: [],
			q: "",
			menu: null,
			renaming: "",
			editing: "",
			confirm: "",
			drop: "",
			told: "",
			patch: null,
			view: "list",
			mapby: "place",
			folder: "/",
			expanded: [],
		})
	) ensureNode(PF(k), v)
	const node = () => (read(F("node")) as Any)?.node

	// the columns, and what's on screen, as words: the same columns again is no change
	createMemo(
		`${M}columns`,
		() =>
			JSON.stringify(
				columns(
					read(PF("at")) as string,
					isId(read(PF("at")) as string) ? node() : undefined,
					(p) => read(listAt(p)) as List | undefined,
				),
			),
	)
	// the list view: its folder, and the folders opened in it (their twisties)
	createMemo(`${M}view`, () => ({
		view: read(PF("view")),
		folder: read(PF("folder")),
		expanded: read(PF("expanded")),
	}), { equal: same })
	// every folder whose rows are on screen: the columns', the list view's, the root (the side)
	createMemo(`${M}wanted`, () => {
		const v = read(`${M}view`) as Any
		const cols: string[] = JSON.parse(read(`${M}columns`) as string)
		const shown = v.view === "list" ? [v.folder, ...(v.expanded as string[])] : cols
		return JSON.stringify([...new Set(["/", ...shown])].filter((c) => !isId(c)))
	})
	createMemo(`${M}shown`, () => {
		const at = read(PF("at")) as string
		return JSON.stringify([...new Set([...JSON.parse(read(`${M}wanted`) as string), at])])
	})
	// the side: the root's places, and what changed lately (of the rows seen)
	createMemo(`${M}side`, () => {
		const root = read(listAt("/")) as List | undefined
		const all: { p: string; when: number; r: Row }[] = []
		for (const n of list(F("lists"))) {
			const l = read(F(`lists/${n}`)) as List | undefined
			const at = decodeURIComponent(n)
			for (const r of l?.rows ?? []) {
				if (r.when && !r.folder) all.push({ p: kid(at, r.name), when: r.when, r })
			}
		}
		all.sort((a, b) => b.when - a.when)
		const seen = new Set<string>()
		const lately = all.filter((x) => !seen.has(x.p) && seen.add(x.p)).slice(0, 5)
		return JSON.stringify({
			places: (root?.rows ?? []).filter((r) => r.folder || r.type !== "nothing").map((r) =>
				r.name
			),
			lately: lately.map((x) => ({ p: x.p, when: x.when, type: x.r.type })),
		})
	})
	// what each row's look depends on: the place picked, the rows seen to change, a drop
	createMemo(`${M}marks`, () => ({
		at: read(PF("at")),
		lit: Object.keys((read(F("lit")) as object) ?? {}),
		drop: read(PF("drop")),
	}), { equal: same })
	// a search: its words, and what came back for them
	createMemo(`${M}finding`, () => ({ q: read(PF("q")), found: read(F("found")) }), { equal: same })
	createMemo(`${M}trace`, () => ({ trace: read(F("trace")), folded: read(PF("folded")) }), {
		equal: same,
	})
	// the line at the bottom
	createMemo(`${M}foot`, () => {
		const said = read(F("said")) as string, at = read(PF("at")) as string
		read(NOW)
		const cols: string[] = JSON.parse(read(`${M}columns`) as string)
		const here = isId(at) ? undefined : read(listAt(cols.at(-1) ?? "/")) as List | undefined
		const n = (read(F("node")) as Any)?.node
		const told = read(PF("told")) as "" | { text: string; bad: boolean }
		return {
			bad: !!said || (!!told && told.bad),
			left: said
				? said
				: told
				? told.text
				: here
				? plural(here.rows.length, "name") + " in " + nameOf(cols.at(-1) ?? "/") + " · " +
					plural(list(F("lists")).length, "folder") + " looked at"
				: "",
			right: [
				n?.change?.value?.when ? `changed ${ago(n.change.value.when)}` : "",
				graph === "page" ? "everything but /code and /host changes from here" : "",
			].filter(Boolean).join(" · "),
		}
	}, { equal: same })
	createMemo(`${M}mapshown`, () => ({ map: read(F("map")), at: read(PF("at")) }), { equal: same })

	// a column's rows asked for once it is on screen and not known (null while asked)
	createEffect(
		`${M}lists`,
		() =>
			(JSON.parse(read(`${M}wanted`) as string) as string[]).filter((c) =>
				!isId(c) && read(listAt(c)) === undefined
			),
		(missing: string[]) => {
			for (const c of missing) {
				if (now(listAt(c)) !== undefined) continue
				put(listAt(c), null)
				ask({ do: "list", path: c })
			}
		},
		{ equal: same },
	)
	// the map: asked when shown, and again for each way it's laid out
	createEffect(
		`${M}map`,
		() => ({
			view: read(PF("view")) as string,
			by: read(PF("mapby")) as "place" | "owner" | "reads",
		}),
		(m: { view: string; by: "place" | "owner" | "reads" }) => {
			if (m.view !== "map") return
			put(F("map"), null)
			latest({ map: ask({ do: "map", by: m.by }) })
		},
		{ equal: same },
	)
	// live: on the host's tick, the rows seen to change stop being lit after a moment, and every 2 s
	// the versions of what's on screen are asked for (an answer that never came: asked again after
	// 6 s)
	// only while it shows: hidden, it reads nothing of the clock, so the tick doesn't run it
	createEffect(`${M}tick`, () => {
		if (!shows(name, SHOWING.map((p) => read(p)))) return null
		return read(TICK) as number
	}, (t: number | null) => {
		if (typeof t !== "number") return
		const lit = (now(F("lit")) ?? {}) as Record<string, number>
		const still = Object.entries(lit).filter(([, at]) => t - at < 1500)
		if (still.length !== Object.keys(lit).length) put(F("lit"), Object.fromEntries(still))
		const polling = now(F("polling")) as { on: boolean; since: number }
		if (t - polling.since < (polling.on ? 6000 : 2000)) return
		put(F("polling"), { on: true, since: t })
		ask({ do: "versions", paths: JSON.parse(now(`${M}shown`) ?? "[]") })
	})
	// what the graph says back: each answer not read yet, in order; then the host is told they were
	createEffect(
		`${M}heard`,
		() => (read(inboxOf(graph, name)) ?? []) as { n: number; m: Any }[],
		(all: { n: number; m: Any }[]) => {
			const last = now(F("heard")) as number
			let upTo = last
			for (const { n, m } of all) {
				if (n <= last) continue
				upTo = n
				try {
					heard(m)
				} catch (err) {
					say(`that answer broke something here: ${(err as Error)?.message ?? err}`)
				}
			}
			if (upTo === last) return
			put(F("heard"), upTo)
			executeAction(`${G}/took`, name, upTo)
		},
	)

	// ---- what a person does ----
	const go = (p: string, remember = true) => {
		const at = now(PF("at")) as string
		if (remember && p !== at) put(PF("past"), [...(now(PF("past")) as string[]), at].slice(-50))
		put(PF("at"), p)
		// the list view's folder: kept while what's picked is in it; else the folder it's in
		const folder = now(PF("folder")) as string
		if (!isId(p) && p !== folder && !p.startsWith(folder === "/" ? "/" : folder + "/")) {
			put(PF("folder"), parentOf(p))
		}
		put(PF("told"), "")
		put(PF("editing"), "")
		put(F("node"), null)
		put(F("trace"), null)
		put(PF("folded"), [])
		put(PF("depth"), 6)
		latest({
			node: ask({ do: "node", path: p }),
			trace: ask({ do: "trace", path: p, depth: 6 }),
		})
	}
	createAction(A("go"), (p: string) => go(p))
	// into a folder: the list shows what's in it
	createAction(A("enter"), (p: string) => {
		if (isId(p)) return go(p)
		put(PF("folder"), p)
		put(PF("expanded"), [])
		go(p)
	})
	createAction(
		A("view"),
		(v: string) => put(PF("view"), v === "columns" || v === "map" ? v : "list"),
	)
	createAction(
		A("mapby"),
		(by: string) => put(PF("mapby"), by === "owner" || by === "reads" ? by : "place"),
	)
	const toggle = (path: string, x: string) => {
		const was = (now(path) ?? []) as string[]
		put(path, was.includes(x) ? was.filter((y) => y !== x) : [...was, x])
	}
	// a folder's twisty, in the list
	createAction(A("twist"), (p: string) => toggle(PF("expanded"), p))
	createAction(A("back"), () => {
		const past = now(PF("past")) as string[]
		if (!past.length) return
		put(PF("past"), past.slice(0, -1))
		go(past.at(-1)!, false)
	})
	createAction(A("deeper"), () => {
		const depth = Math.min(12, (now(PF("depth")) as number) + 3)
		put(PF("depth"), depth)
		latest({ trace: ask({ do: "trace", path: now(PF("at")), depth }) })
	})
	createAction(A("fold"), (key: string) => toggle(PF("folded"), key))
	createAction(A("more"), (key: string, more: { id: string; part: string; change: number }) => {
		const at = now(PF("at")) as string
		const id = ask({
			do: "trace",
			path: at,
			id: more.id,
			part: more.part,
			change: more.change,
			depth: 6,
		})
		put(F("mores"), { ...now<Record<string, unknown>>(F("mores")), [id]: [at, key] })
	})

	// ---- changing things: each one asked of the graph (the mac's signed, the page's made by the
	// host), answered in changed. a place by id can't be changed here: only places with a path ----
	const listed = (p: string) => now(listAt(p)) as List | undefined
	// the foot's words from here: told (quiet), or said (something went wrong). the graph's own
	// answers clear its said as they come, so these stay until the next move
	const say = (words: string) => put(PF("told"), words ? { text: words, bad: true } : "")
	const tell = (words: string) => put(PF("told"), words ? { text: words, bad: false } : "")
	const closeMenu = () => now(PF("menu")) && put(PF("menu"), null)
	const copy = (text: string) => {
		closeMenu()
		executeAction(`${G}/copy`, name, text)
	}
	const showInfo = () =>
		document.querySelector(`[data-win="${name}"] .g-info`)?.scrollIntoView({ block: "nearest" })
	// a name not taken in a folder: "untitled", then "untitled 2", …
	const free = (folder: string, base: string) => {
		const taken = new Set((listed(folder)?.rows ?? []).map((r) => r.name))
		if (!taken.has(base)) return base
		for (let i = 2;; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`
	}
	const openMenu = (path: string, x: number, y: number, here: boolean) => {
		if (!here && path !== now(PF("at"))) go(path)
		put(PF("menu"), { path, x, y, here })
	}
	createAction(A("menu"), openMenu)
	// "+ new": the menu for the folder in front
	createAction(A("new-menu"), (x: number, y: number) => {
		const into = now(PF("view")) === "list" ? now(PF("folder")) : now(PF("at"))
		openMenu(into, x, y, true)
	})
	createAction(A("menu-close"), () => closeMenu())
	createAction(A("info"), () => {
		closeMenu()
		showInfo()
	})
	createAction(A("copy"), (text: string) => copy(text))
	createAction(A("copy-id"), (p: string) => {
		const n = now(F("node"))
		const id = n?.path === p ? n.node?.id : isId(p) ? p.slice(1) : undefined
		if (!id) {
			closeMenu()
			return say("its id isn't here yet: try again in a moment")
		}
		copy(id)
	})
	createAction(A("rename-start"), (p: string) => {
		closeMenu()
		if (isId(p) || p === "/") return say("only a place with a path can be renamed")
		if (!may(p)) return say(CHANGEABLE_WORDS)
		put(PF("renaming"), p)
	})
	// a name typed: renamed (null: let go, as escape does)
	createAction(A("rename"), (p: string, name: string | null) => {
		if (now(PF("renaming")) !== p) return
		put(PF("renaming"), "")
		if (name === null) return
		name = String(name ?? "").trim()
		if (!name || name === nameOf(p)) return
		if (name.includes("/")) return say("a name can't have a / in it")
		if (name === "." || name === "..") return say(`a name can't be "${name}"`)
		if (!may(kid(parentOf(p), name))) return say(CHANGEABLE_WORDS)
		change({ do: "move", path: p, to: kid(parentOf(p), name) })
	})
	// kind: "node" (nothing in it yet) or "text" (an empty text)
	createAction(A("new"), (folder: string, kind: string) => {
		closeMenu()
		if (isId(folder)) return say("new things go in a place with a path")
		const named = free(folder, kind === "text" ? "untitled text" : "untitled")
		if (!may(kid(folder, named))) return say(CHANGEABLE_WORDS)
		change({ do: "make", path: kid(folder, named), ...(kind === "text" ? { value: "" } : {}) })
	})
	createAction(A("ask-remove"), (p: string) => {
		closeMenu()
		if (isId(p) || p === "/") return say("only a place with a path can be removed")
		if (!may(p)) return say(CHANGEABLE_WORDS)
		put(PF("confirm"), p)
	})
	createAction(A("remove"), (p: string) => {
		if (now(PF("confirm")) !== p) return
		put(PF("confirm"), "")
		change({ do: "remove", path: p })
	})
	createAction(A("cancel"), () => put(PF("confirm"), ""))
	createAction(A("edit"), (p: string) => {
		if (!may(p)) return say(CHANGEABLE_WORDS)
		put(PF("patch"), { at: p, patches: [] })
		put(PF("editing"), p)
	})
	createAction(A("edit-cancel"), () => put(PF("editing"), ""))
	// each keystroke: what's typed, diffed against the value as it came. as: "text" (the words as
	// they are) or "json"
	createAction(A("typed"), (p: string, text: string, as: string) => {
		const n = now(F("node"))
		if (n?.path !== p || !n.node?.value) return
		try {
			const current = as === "json" ? JSON.parse(n.node.value.text) : n.node.value.text
			const next = as === "json" ? JSON.parse(text) : text
			put(PF("patch"), { at: p, patches: diff(current, next) })
		} catch (err) {
			put(PF("patch"), { at: p, error: `that isn't json yet: ${(err as Error).message}` })
		}
	})
	// the patches go (the mac's signed, as one change)
	const save = (p: string) => {
		const pt = now(PF("patch"))
		if (pt?.at !== p) return
		if (pt.error) return say(pt.error)
		if (!pt.patches?.length) return tell("no change to save")
		put(PF("editing"), "")
		change({ do: "edit", path: p, patches: pt.patches })
	}
	createAction(A("save"), save)
	// the editor's keys: escape lets it go, ⌘↩ saves
	createAction(A("edit-key"), (p: string, key: string) => {
		if (key === "Escape") return put(PF("editing"), "")
		if (key === "Save") return save(p)
	})
	// dragging a row onto a folder (or a column's empty space): moved into it, its name kept
	createAction(A("drag-over"), (p: string) => put(PF("drop"), p))
	createAction(A("drop"), (from: string, into: string) => {
		put(PF("drop"), "")
		if (!from || isId(from) || isId(into)) return
		const to = kid(into, nameOf(from))
		if (to === from) return
		if (into === from || into.startsWith(from + "/")) return say("a thing can't go inside itself")
		if (!may(from) || !may(to)) return say(CHANGEABLE_WORDS)
		change({ do: "move", path: from, to })
	})
	// what's typed in the find box, as it's typed: a node, like everything else the page shows
	createAction(A("typing"), (q: string) => put(PF("q"), String(q ?? "").slice(0, 200)))
	createAction(A("find"), (q: string) => {
		q = String(q ?? "").slice(0, 200)
		put(PF("q"), q)
		put(F("found"), null)
		if (q.trim()) latest({ find: ask({ do: "find", q }) })
	})
	createAction(A("found-go"), (p: string) => {
		put(PF("q"), "")
		put(F("found"), null)
		go(p)
	})
	// the keys, on the middle: arrows walk, return renames, ⌘⌫ removes (asked first), ⌘I shows what
	// it is, ⌘C copies its path (in the key's own moment: the host's copy is called from here)
	createAction(A("key"), (key: string) => {
		const at = now(PF("at")) as string
		if (key === "Escape") return closeMenu()
		if (key === "Copy") return copy(at)
		if (key === "Info") return showInfo()
		if (isId(at)) return
		const siblings = (listed(parentOf(at))?.rows ?? []).map((r) => r.name)
		const i = siblings.indexOf(nameOf(at))
		if (key === "ArrowDown" || key === "ArrowUp") {
			if (at === "/") {
				const first = listed("/")?.rows[0]
				return first && go(kid("/", first.name))
			}
			const next = siblings[i + (key === "ArrowDown" ? 1 : -1)]
			return next !== undefined && go(kid(parentOf(at), next))
		}
		if (key === "ArrowRight") {
			const first = listed(at)?.rows[0]
			return first && go(kid(at, first.name))
		}
		if (key === "ArrowLeft") return at !== "/" && go(parentOf(at))
		if (key === "Enter") {
			return at !== "/" && (may(at) ? put(PF("renaming"), at) : say(CHANGEABLE_WORDS))
		}
		if (key === "Remove") {
			return at !== "/" && (may(at) ? put(PF("confirm"), at) : say(CHANGEABLE_WORDS))
		}
	})

	// a change's answer: look again where it happened, and follow what moved
	function changed(m: Any) {
		if (m.error) return say(m.error)
		say("")
		const look = new Set([parentOf(m.path)])
		if (m.at) look.add(parentOf(m.at))
		if (m.do === "make" && m.at) look.add(m.at)
		for (const p of look) if (listed(p) !== undefined) ask({ do: "list", path: p })
		const at = now(PF("at")) as string
		const inside = (p: string) => at === p || at.startsWith(p + "/")
		if (m.do === "move" && m.at && inside(m.path)) {
			go(m.at + at.slice(m.path.length))
			tell(`moved to ${m.at}`)
		} else if (m.do === "remove" && inside(m.path)) {
			go(parentOf(m.path))
			tell(`removed ${m.path}`)
		} else if (m.do === "make" && m.at) {
			// the folder it was made in, shown, so the field for its name is seen
			if (now(PF("view")) === "list" && parentOf(m.at) !== now(PF("folder"))) {
				put(PF("folder"), parentOf(m.at))
				put(PF("expanded"), [])
			}
			go(m.at)
			put(PF("renaming"), m.at)
		} else if ((m.do === "write" || m.do === "edit") && at === m.path) {
			latest({
				node: ask({ do: "node", path: at }),
				trace: ask({ do: "trace", path: at, depth: now(PF("depth")) }),
			})
			tell("saved")
		}
	}

	// ---- what the graph says back: written into the page's graph, where the bindings read it ----
	function heard(m: Any) {
		if (["write", "edit", "make", "move", "remove"].includes(m.do)) return changed(m)
		if (m.do === "copy") return m.error ? say(m.error) : tell(`copied ${m.text}`)
		if (m.do === "said") return put(F("said"), m.error ?? "")
		if (m.do === "versions") {
			put(F("polling"), { on: false, since: (now(F("polling")) as Any).since })
		}
		const asked = now(F("latest")) as Record<string, string>
		const mores = now(F("mores")) as Record<string, [string, string]>
		// an answer no longer wanted: a newer ask of its kind went
		if (
			["node", "trace", "find", "map"].includes(m.do) && m.ask !== asked[m.do] &&
			!(m.ask in mores)
		) return
		if (m.error) return put(F("said"), m.error)
		put(F("said"), "")
		if (m.do === "find") {
			if (m.q === now(PF("q"))) put(F("found"), { q: m.q, found: m.found ?? [], more: !!m.more })
			return
		}
		const at = now(PF("at")) as string
		const known = now(F("known")) as Record<string, unknown>
		if (m.do === "list" && m.list) {
			const where = listAt(m.path)
			const was = now(where) as List | undefined
			if (was) {
				// the rows seen to change light up a moment
				const t = Date.now()
				const lit: Record<string, number> = {}
				for (const r of m.list.rows as Row[]) {
					const o = was.rows.find((x) => x.name === r.name)
					if (!o || o.brief !== r.brief || o.when !== r.when) lit[kid(m.path, r.name)] = t
				}
				if (Object.keys(lit).length) {
					put(F("lit"), { ...now<Record<string, number>>(F("lit")), ...lit })
				}
			}
			put(where, m.list)
			put(F("known"), { ...known, [m.path]: m.list.version })
			return
		}
		if (m.do === "node" && m.path === at) {
			put(F("node"), { path: m.path, node: m.node })
			put(F("known"), { ...known, [at]: m.node?.version })
			return
		}
		// "more…": the steps under one step, put in where it was
		const more = mores[m.ask]
		if (m.do === "trace" && more) {
			const { [m.ask]: _, ...rest } = mores
			put(F("mores"), rest)
			const [path, key] = more
			const t = now(F("trace"))
			if (t?.path !== path) return
			const copy = JSON.parse(JSON.stringify(t))
			let step: Any = { steps: copy.trace.steps }
			for (const i of key.split(".")) step = step?.steps?.[Number(i)]
			if (!step?.more) return
			step.steps = m.trace.steps?.[0]?.steps ?? m.trace.steps
			delete step.more
			if (m.trace.note) step.note = m.trace.note
			return put(F("trace"), copy)
		}
		if (m.do === "trace" && m.path === at) {
			return put(F("trace"), { path: m.path, trace: m.trace })
		}
		if (m.do === "map") {
			if (m.ask === asked.map) {
				put(F("map"), { by: m.by, cards: m.cards ?? [], edges: m.edges ?? [], more: !!m.more })
			}
			return
		}
		if (m.do === "versions" && m.versions) {
			const moved = Object.entries(m.versions).some(([p, v]) => known[p] !== v)
			if (moved && now(PF("view")) === "map") {
				latest({ map: ask({ do: "map", by: now(PF("mapby")) }) })
			}
			const next = { ...known }
			for (const [p, v] of Object.entries(m.versions)) {
				if (known[p] === v) continue
				next[p] = v
				if (now(listAt(p))) ask({ do: "list", path: p })
				if (p === at) {
					latest({ node: ask({ do: "node", path: p }) })
					if (now(F("trace"))) {
						latest({ trace: ask({ do: "trace", path: p, depth: now(PF("depth")) }) })
					}
				}
			}
			put(F("known"), next)
		}
	}

	// opened: what's picked asked for, once (none asked yet: a new explorer, or a new page)
	createEffect(`${M}open`, () => true, () => {
		if (!(now(F("latest")) as Record<string, string>).node) go(now(PF("at")) as string)
	})

	// ---- the window ----
	const goes = (p: string) => handler(A("go"), [p])
	const chip = (p: string, words?: Child) => (
		<button class="g-chip" title={`go to ${p}`} onClick={goes(p)}>
			{words ?? (isId(p) ? `#${short(p.slice(1))}` : p)}
		</button>
	)
	const scrolled = (e: Event) => {
		const cols = e.currentTarget as HTMLElement
		cols.scrollLeft = cols.scrollWidth
	}
	const crumbs = (at: string) => {
		const parts = isId(at) ? [] : split(at)
		return [
			<button class="g-crumb" onClick={goes("/")}>/</button>,
			parts.map((x, i) => [
				i ? <span class="g-sep" aria-hidden="true">▸</span> : null,
				<button
					class={"g-crumb" + (i === parts.length - 1 ? " last" : "")}
					title={join(parts.slice(0, i + 1))}
					onClick={goes(join(parts.slice(0, i + 1)))}
				>
					{short(x)}
				</button>,
			]),
			isId(at)
				? [
					<span class="g-sep" aria-hidden="true">▸</span>,
					<span
						class="g-crumb last"
						title={`${at.slice(1)}: a node by its id, not reachable from the root`}
					>
						{`#${short(at.slice(1))}`}
					</span>,
				]
				: null,
		]
	}
	// a row: its look bound to what's picked
	const look = (p: string, depthAt: number, n: string) => (m: { at: string; lit: string[] }) => {
		const on = !isId(m.at) && split(m.at)[depthAt] === n
		return "g-row" + (on ? (p === m.at ? " sel" : " trail") : "") +
			(m.lit.includes(p) ? " fresh" : "")
	}
	// a drag carries the place it started from, under a type of its own (so a drop of anything else
	// is no move)
	const DRAG = "application/x-ermine-place"
	const dragging = (e: DragEvent) => !!e.dataTransfer?.types.includes(DRAG)
	const dropsInto = (into: string) => ({
		onDragOver: handler(A("drag-over"), (e: DragEvent) => {
			if (!dragging(e)) return
			e.preventDefault()
			e.stopPropagation()
			e.dataTransfer!.dropEffect = "move"
			return [into]
		}),
		onDrop: handler(A("drop"), (e: DragEvent) => {
			if (!dragging(e)) return
			e.preventDefault()
			e.stopPropagation()
			return [e.dataTransfer!.getData(DRAG), into]
		}),
	})
	const menuAt = (p: string, here: boolean) =>
		handler(A("menu"), (e: MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			return [p, e.clientX, e.clientY, here]
		})
	// a name being renamed: a field in the row, its name picked; return or leaving it renames,
	// escape doesn't
	const renaming = (p: string, n: string) => (
		<input
			class="g-rename"
			value={n}
			aria-label={`new name for ${n}`}
			spellcheck={false}
			ref={(el: HTMLInputElement) =>
				queueMicrotask(() => {
					if (document.activeElement === el) return
					el.focus()
					el.select()
				})}
			onClick={(e: Event) => e.stopPropagation()}
			onKeyDown={handler(A("rename"), (e: KeyboardEvent) => {
				e.stopPropagation()
				if (e.key === "Escape") return [p, null]
				if (e.key !== "Enter") return
				e.preventDefault()
				return [p, (e.currentTarget as HTMLInputElement).value]
			})}
			onBlur={handler(A("rename"), (e: FocusEvent) => [
				p,
				(e.currentTarget as HTMLInputElement).value,
			])}
		/>
	)
	// what a row does: picked by a click, a folder gone into by a double click, dragged, dropped on,
	// right-clicked; its name a field while renamed
	const rowDoes = (p: string, r: Row) => ({
		title: `${p}${r.brief !== undefined ? "\n" + r.brief : ""}`,
		draggable: true,
		onClick: goes(p),
		onDblClick: r.folder ? handler(A("enter"), [p]) : undefined,
		onContextMenu: menuAt(p, false),
		onDragStart: (e: DragEvent) => {
			e.dataTransfer?.setData(DRAG, p)
			e.dataTransfer?.setData("text/plain", p)
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
		},
		onDragEnd: handler(A("drag-over"), [""]),
		...(r.folder ? dropsInto(p) : {}),
	})
	const nameOrField = (p: string, r: Row) => (
		<span class="g-namebox">
			{bind(
				PF("renaming"),
				(on: string) =>
					on === p ? renaming(p, r.name) : <span class="g-name">{short(r.name)}</span>,
			)}
		</span>
	)
	// ---- columns: a level each ----
	const row = (c: string, depthAt: number, r: Row) => {
		const p = kid(c, r.name)
		return (
			<div
				key={r.name}
				class={bind(`${M}marks`, (m) =>
					look(p, depthAt, r.name)(m) + (m.drop === p ? " drop" : ""))}
				role="option"
				aria-selected={bind(`${M}marks`, (m) =>
					String(p === m.at))}
				{...rowDoes(p, r)}
			>
				{icon(`${name}:col`, p, r)}
				{nameOrField(p, r)}
				{r.folder
					? <span class="g-more" aria-hidden="true">›</span>
					: r.brief !== undefined
					? <span class="g-brief">{r.brief}</span>
					: null}
			</div>
		)
	}
	const column = (c: string, depthAt: number) => (
		<div
			class={bind(`${M}marks`, (m) => "g-col" + (m.drop === c ? " drop" : ""))}
			key={c}
			role="listbox"
			aria-label={c}
			{...(isId(c) ? {} : { onContextMenu: menuAt(c, true), ...dropsInto(c) })}
		>
			{isId(c)
				// a place by id: its names, each one by the child's id (from the node's own)
				? bind(F("node"), (n) =>
					(n?.node?.children ?? []).map((k: string) => {
						const p = n.node.inside?.[k]
						return (
							<button
								class="g-row"
								key={k}
								role="option"
								title={k}
								onClick={handler(A("go"), () => (p ? [p] : undefined))}
							>
								{icon(`${name}:col`, `${c}/${k}`, {})}
								<span class="g-name">{short(k)}</span>
							</button>
						)
					}))
				: bind(listAt(c), (l: List) =>
					l === null ? <div class="g-empty">…</div> : [
						!l.rows.length ? <div class="g-empty">empty</div> : null,
						l.rows.map((r) => row(c, depthAt, r)),
					])}
		</div>
	)
	const columnsView = () => (
		<div class="g-cols" onErmineChange={scrolled}>
			{bind(`${M}columns`, (cols: string) => (JSON.parse(cols) as string[]).map(column))}
		</div>
	)
	// ---- the list: the folder's rows, name · kind · value · changed; a folder's twisty opens it in
	// place ----
	const lrow = (c: string, r: Row, depth: number): Child => {
		const p = kid(c, r.name)
		return [
			<div
				key={r.name}
				class={bind(
					`${M}marks`,
					(m) =>
						"g-lrow" + (p === m.at ? " sel" : "") + (m.lit.includes(p) ? " fresh" : "") +
						(m.drop === p ? " drop" : ""),
				)}
				role="row"
				aria-selected={bind(`${M}marks`, (m) => String(p === m.at))}
				style={`--depth:${depth}`}
				{...rowDoes(p, r)}
			>
				<span class="g-lname">
					{r.folder
						? (
							<button
								class="g-twisty"
								aria-label={`open ${r.name} here`}
								aria-expanded={bind(
									PF("expanded"),
									(ex: string[]) => String(ex.includes(p)),
								)}
								onClick={handler(A("twist"), (e: Event) => {
									e.stopPropagation()
									return [p]
								})}
							>
								{bind(PF("expanded"), (ex: string[]) => (ex.includes(p) ? "▾" : "▸"))}
							</button>
						)
						: <span class="g-twisty" />}
					{icon(`${name}:list`, p, r)}
					{nameOrField(p, r)}
				</span>
				<span class="g-lkind">{r.folder ? "folder" : KINDS[r.type ?? ""] ?? r.type}</span>
				<span class="g-lval">{r.folder ? "" : r.brief ?? ""}</span>
				<span class="g-lwhen" title={clock(r.when)}>
					{r.when ? bind(NOW, () => ago(r.when)) : "—"}
				</span>
			</div>,
			r.folder
				? bind(PF("expanded"), (ex: string[]) => (ex.includes(p) ? lrows(p, depth + 1) : null))
				: null,
		]
	}
	const lrows = (c: string, depth: number): Child =>
		bind(
			listAt(c),
			(l: List) =>
				l === undefined || l === null
					? <div class="g-lrow g-quiet" style={`--depth:${depth}`}>…</div>
					: !l.rows.length
					? (
						<div class="g-lrow g-quiet" style={`--depth:${depth}`}>
							{depth ? "nothing in it" : "empty"}
						</div>
					)
					: l.rows.map((r) => lrow(c, r, depth)),
		)
	const listView = (folder: string) => (
		<div
			class={bind(`${M}marks`, (m) => "g-list" + (m.drop === folder ? " drop" : ""))}
			role="treegrid"
			aria-label={`what's in ${folder}`}
			onContextMenu={menuAt(folder, true)}
			{...dropsInto(folder)}
		>
			<div class="g-lrow g-lhead" role="row">
				<span>name</span>
				<span>kind</span>
				<span>value</span>
				<span>changed</span>
			</div>
			{lrows(folder, 0)}
		</div>
	)
	// ---- the map: cards and lines, laid out by place, by who made what, or by what reads what.
	// drawn as one svg (@ermine/render/dom makes html only): a click on a card goes there ----
	const BY: [string, string][] = [["place", "place"], ["owner", "ownership"], ["reads", "reads"]]
	const mapView = () => (
		<div class="g-map">
			<div class="g-mapbar">
				<span class="g-views" role="group" aria-label="lay the map out by">
					{BY.map(([by, words]) => (
						<button
							aria-pressed={bind(PF("mapby"), (b: string) => String(b === by))}
							onClick={handler(A("mapby"), [by])}
						>
							{words}
						</button>
					))}
				</span>
				<span class="g-quiet">
					{bind(
						`${M}mapshown`,
						({ map }) =>
							!map
								? "drawing…"
								: `${plural(map.cards.length, "card")}${
									map.more ? ", and more not drawn" : ""
								}${
									map.by === "reads"
										? " · blue: read by · pink: wrote"
										: map.by === "owner"
										? " · dashed: made inside"
										: ""
								}`,
					)}
				</span>
			</div>
			<div
				class="g-mapbox"
				onClick={handler(A("go"), (e: Event) => {
					const card = (e.target as Element).closest<SVGElement>("[data-at]")
					return card ? [card.dataset.at!] : undefined
				})}
				onContextMenu={handler(A("menu"), (e: MouseEvent) => {
					const card = (e.target as Element).closest<SVGElement>("[data-at]")
					if (!card) return
					e.preventDefault()
					return [card.dataset.at!, e.clientX, e.clientY, false]
				})}
			>
				{bind(`${M}mapshown`, ({ map, at }) => (map ? drawMap(map, at) : null))}
			</div>
		</div>
	)
	// ---- the side: places from the root, and what changed lately ----
	const side = (j: string) => {
		const { places, lately } = JSON.parse(j) as {
			places: string[]
			lately: { p: string; when: number; type?: string }[]
		}
		const spot = (
			p: string,
			words: string,
			r: { folder?: boolean; type?: string },
			em?: Child,
		) => (
			<button
				class={bind(`${M}view`, (v) => "g-spot" + (v.folder === p ? " on" : ""))}
				onClick={handler(r.folder ? A("enter") : A("go"), [p])}
				title={p}
			>
				{icon(`${name}:side`, p, r)}
				<span>{words}</span>
				{em ? <em>{em}</em> : null}
			</button>
		)
		return [
			<div class="g-group">the graph</div>,
			spot("/", "the root", { folder: true }),
			places.map((n) => spot(kid("/", n), n, { folder: true })),
			lately.length ? <div class="g-group">changed lately</div> : null,
			lately.map((x) => spot(x.p, nameOf(x.p), { type: x.type }, bind(NOW, () => ago(x.when)))),
		]
	}

	// ---- the keys: in the listener, only which key; the action does the rest ----
	function keyed(e: KeyboardEvent) {
		const t = e.target as HTMLElement
		if (t.closest("input, textarea")) return
		const command = e.metaKey || e.ctrlKey
		if (command && (e.key === "Backspace" || e.key === "Delete")) {
			e.preventDefault()
			return ["Remove"]
		}
		if (command && e.key.toLowerCase() === "c") {
			e.preventDefault()
			return ["Copy"]
		}
		if (command && e.key.toLowerCase() === "i") {
			e.preventDefault()
			return ["Info"]
		}
		if (command || e.altKey) return
		if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"].includes(e.key)) {
			e.preventDefault()
			return [e.key]
		}
	}

	// ---- the menu: what can be done to one thing (or, on a column's empty space, in it) ----
	function menu(m: { path: string; x: number; y: number; here: boolean } | null) {
		if (!m) return null
		const p = m.path
		const byPath = !isId(p)
		const item = (words: string, act: unknown, key?: string, off = false) => (
			<button class="g-mi" role="menuitem" disabled={off} onClick={act as never}>
				<span>{words}</span>
				{key ? <span class="g-key" aria-hidden="true">{key}</span> : null}
			</button>
		)
		const line = () => <div class="g-ml" role="separator" />
		// up and down move between the items (focus only); escape closes
		const walk = handler(A("menu-close"), (e: KeyboardEvent) => {
			const items = [
				...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(
					".g-mi:not(:disabled)",
				),
			]
			const i = items.indexOf(document.activeElement as HTMLButtonElement)
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault()
				items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus()
				return
			}
			if (e.key !== "Escape") return
			e.preventDefault()
			;(document.querySelector(`[data-win="${name}"] .g-main`) as HTMLElement | null)?.focus()
			return []
		})
		const left = Math.max(4, Math.min(m.x, innerWidth - 224))
		const top = Math.max(4, Math.min(m.y, innerHeight - (m.here ? 120 : 250)))
		const inside = byPath && mayInside(p)
		return [
			<div
				class="g-veil"
				onClick={handler(A("menu-close"))}
				onContextMenu={handler(A("menu-close"), (e: Event) => {
					e.preventDefault()
					return []
				})}
			/>,
			<div
				class="g-menu"
				role="menu"
				aria-label={m.here ? `in ${p}` : nameOf(p)}
				style={`left:${left}px;top:${top}px`}
				onKeyDown={walk}
				ref={(el: HTMLElement) =>
					queueMicrotask(() => el.querySelector<HTMLElement>(".g-mi:not(:disabled)")?.focus())}
			>
				{m.here
					? [
						item("new node", handler(A("new"), [p, "node"]), undefined, !inside),
						item("new text", handler(A("new"), [p, "text"]), undefined, !inside),
						line(),
						item("copy path", handler(A("copy"), [p])),
					]
					: [
						item("get info", handler(A("info")), "⌘I"),
						item(
							"rename",
							handler(A("rename-start"), [p]),
							"↩",
							!byPath || p === "/" || !may(p),
						),
						line(),
						item("new node inside", handler(A("new"), [p, "node"]), undefined, !inside),
						item("new text inside", handler(A("new"), [p, "text"]), undefined, !inside),
						line(),
						item("copy path", handler(A("copy"), [p]), "⌘C"),
						item("copy id", handler(A("copy-id"), [p])),
						line(),
						item(
							"remove…",
							handler(A("ask-remove"), [p]),
							"⌘⌫",
							!byPath || p === "/" || !may(p),
						),
					]}
				{graph === "page" && !(m.here ? inside : may(p))
					? <div class="g-mnote">{CHANGEABLE_WORDS}</div>
					: null}
			</div>,
		]
	}

	// ---- removing: asked first, in words. cancel is the default ----
	function confirm(p: string) {
		if (!p) return null
		return [
			<div class="g-veil dim" onClick={handler(A("cancel"))} />,
			<div
				class="g-alert"
				role="alertdialog"
				aria-label={`remove ${nameOf(p)}?`}
				onKeyDown={handler(A("cancel"), (e: KeyboardEvent) => {
					if (e.key !== "Escape") return
					e.preventDefault()
					return []
				})}
			>
				<p>
					<b>{`remove “${nameOf(p)}”?`}</b>
				</p>
				<p>
					{`it goes from ${parentOf(p)}, with everything inside it. this can't be put back.`}
				</p>
				<div class="g-alert-btns">
					<button class="btn" onClick={handler(A("remove"), [p])}>remove</button>
					<button
						class="btn g-default"
						onClick={handler(A("cancel"))}
						ref={(el: HTMLElement) => queueMicrotask(() => el.focus())}
					>
						cancel
					</button>
				</div>
			</div>,
		]
	}

	// ---- a search's answers, over the middle: each place, its path in full ----
	function found(f: { q: string; found: Any }) {
		if (!f.q) return null
		const rows = f.found?.found as
			| { path: string; name: string; type: string; brief?: string; folder: boolean }[]
			| undefined
		return (
			<div class="g-found" role="listbox" aria-label={`found for ${f.q}`}>
				<div class="g-found-head">
					<span>
						{!f.found
							? `looking for “${f.q}”…`
							: `${plural(rows!.length, "place")}${
								f.found.more ? " (and more not shown)" : ""
							} with “${f.q}”`}
					</span>
					<button class="g-btn g-small" onClick={handler(A("find"), [""])}>done</button>
				</div>
				{(rows ?? []).map((r) => (
					<button
						class="g-row"
						role="option"
						key={r.path}
						title={r.brief ?? r.path}
						onClick={handler(A("found-go"), [r.path])}
					>
						{icon(`${name}:found`, r.path, r)}
						<span class="g-name">{r.path}</span>
						{r.brief !== undefined ? <span class="g-brief">{r.brief}</span> : null}
					</button>
				))}
			</div>
		)
	}

	// ---- the one picked ----
	function section(title: string, ...kids: Child[]) {
		return (
			<section class="g-sec">
				<h3>{title}</h3>
				{kids}
			</section>
		)
	}
	function rows(pairs: [string, Child][]) {
		return (
			<dl class="g-dl">
				{pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map((
					[k, v],
				) => [<dt>{k}</dt>, <dd>{v}</dd>])}
			</dl>
		)
	}
	function kindOf(n: Any) {
		const v = n.value
		const what = v ? TYPE[v.type] ?? v.type : n.children.length ? "a folder" : "nothing in it"
		const size = v
			? (v.type === "text"
				? plural(v.size, "character")
				: v.type === "function"
				? `source, ${plural(v.size, "character")}`
				: "")
			: ""
		return [what, size, n.children.length ? plural(n.children.length, "name") + " inside" : ""]
			.filter(Boolean).join(" · ")
	}
	function lastChange(c: Any) {
		if (!c) return null
		const meta = Object.entries(c.metadata ?? {}).map(([k, v]) => (
			<span class="g-meta">
				{`${k}: `}
				{(k === "node" || k === "handler") && typeof v === "string"
					? chip("#" + v, short(v))
					: String(v)}
			</span>
		))
		return rows([
			["when", c.when ? <span>{clock(c.when)} · {ago(c.when)}</span> : undefined],
			["who", c.who ?? <span class="g-quiet">no actor named</span>],
			[
				"where",
				c.where?.length
					? <span>{c.where.map(site)}</span>
					: <span class="g-quiet">no site caught</span>,
			],
			["scope", meta.length ? <span class="g-metas">{meta}</span> : undefined],
		])
	}
	function why(w: Any) {
		if (!w) return undefined
		if (w.error) return <span class="g-bad">{w.error}</span>
		const held = w.held
			? <span class="g-quiet">{` · a later write held back by ${w.held.feature}`}</span>
			: null
		const place = (id: string, p?: string) => chip(p ?? "#" + id, p ?? `#${short(id)}`)
		if (w.kind === "run") {
			return (
				<span>
					{w.n ? `run ${w.n} of ` : "a run of "}
					{place(w.computer, w.at)}
					{` (it read ${w.reads}, wrote ${w.writes})`}
					{held}
				</span>
			)
		}
		if (w.kind === "call") {
			return <span>{w.n ? `call ${w.n} to ` : "a call to "}{place(w.handler, w.at)}{held}</span>
		}
		if (w.kind === "replaced") {
			return <span>{"written by "}{place(w.by, w.at)}{", whose record is newer now"}{held}</span>
		}
		if (w.kind === "outside") {
			return (
				<span>
					{"written from outside any run or call"}
					{w.fallback ? ` (${w.fallback})` : ""}
					{w.where ? <span>{" at "}{site(w.where)}</span> : ""}
					{held}
				</span>
			)
		}
		return held ?? undefined
	}
	function status(s: Any) {
		if (!s) return null
		if (s.error && !s.state) return <span class="g-bad">{s.error}</span>
		// made only while read (pully): awake, waking or asleep
		if (!s.state && s.provider) {
			return (
				<span class={"g-state g-" + s.provider} title="made only while something reads it">
					{s.provider}
				</span>
			)
		}
		const more = []
		if (s.n !== undefined) more.push(`run ${s.n}`)
		if (s.phase) more.push(`in its ${s.phase}`)
		if (s.held) more.push(`held by ${s.held.feature}`)
		return (
			<span>
				<span class={"g-state g-" + s.state}>{s.state}</span>
				{more.length ? ` ${more.join(" · ")}` : ""}
				{s.waiting
					? (
						<div class="g-quiet">
							{"waiting on " +
								s.waiting.map((w: unknown) => typeof w === "string" ? w : JSON.stringify(w))
									.join(", ")}
						</div>
					)
					: null}
				{s.error ? <pre class="g-pre g-bad">{s.error}</pre> : null}
			</span>
		)
	}
	// who reads it now: each by its latest run or call, a chip that goes there
	function readBy(
		rs: { at: string; label?: string; kind: string; n: number; part: string }[] | undefined,
	) {
		if (!rs?.length) return <p class="g-quiet">nothing reads it now</p>
		return (
			<div class="g-metas">
				{rs.map((r) => (
					<span class="g-meta">
						{chip(r.at, r.label ?? nameOf(r.at))}
						<span class="g-quiet">
							{` its ${r.kind} ${r.n}${r.part === "attributes" ? ", its attributes" : ""}`}
						</span>
					</span>
				))}
			</div>
		)
	}
	function attributes(attrs: Record<string, Any>) {
		const ks = Object.keys(attrs ?? {})
		if (!ks.length) return <p class="g-quiet">none</p>
		return rows(ks.map((k): [string, Child] => {
			const a = attrs[k]
			// the scope a computer was made in: a node, by id
			if (k === "ermine.computer.scope" && a.type === "text") {
				return [k, chip("#" + a.text, `#${short(a.text)}`)]
			}
			return [
				k,
				a.text.length > 120 || a.text.includes("\n")
					? <pre class="g-pre g-small">{a.text}</pre>
					: <code>{a.text}</code>,
			]
		}))
	}
	function info(picked: { path: string; node: Any } | null) {
		if (!picked) return <p class="g-quiet">looking…</p>
		const { path: at, node: n } = picked
		if (!n?.there) return <p class="g-quiet">{`nothing at ${at}`}</p>
		const head = (
			<div class="g-head">
				{icon(
					`${name}:head`,
					at,
					{ folder: !n.value && n.children.length > 0, type: n.value?.type ?? "nothing" },
					"b",
				)}
				<div>
					<div class="g-title">{at === "/" ? "the root" : nameOf(at)}</div>
					<div class="g-kind">{kindOf(n)}</div>
				</div>
				{status(n.status)}
			</div>
		)
		const place = rows([
			[
				"where",
				isId(at)
					? (
						<span>
							<code>{at.slice(1)}</code>
							<span class="g-quiet">{" by its id: not reachable from the root"}</span>
						</span>
					)
					: <code>{at}</code>,
			],
			["id", n.id ? <code>{n.id}</code> : undefined],
			[
				"placed",
				n.ids?.length > 1
					? `${n.ids.length} nodes have this name; the first is shown`
					: undefined,
			],
			["from", n.from && n.from !== "children" ? n.from : undefined],
			["why", why(n.why?.value)],
			[
				"processes",
				n.processes
					? (
						<span>
							{Object.entries(n.processes).map(([k, p]: [string, Any]) => (
								<span class="g-meta">{`${k} `}{chip(p, `#${short(p.slice(1))}`)}</span>
							))}
						</span>
					)
					: undefined,
			],
		])
		const v = n.value
		// what can be edited here: words as words; numbers, lists, records, true/false and null as
		// json. anything else (a function, bytes, an error, pending) is said, not offered
		const as = v?.type === "text" ? "text" : EDITS_AS_JSON.has(v?.type) ? "json" : undefined
		const cant = !v
			? undefined
			: v.cut
			? "too long to edit here: only part of it came"
			: isId(at)
			? "a place by id can't be edited here: only places with a path"
			: !may(at)
			? CHANGEABLE_WORDS
			: as
			? undefined
			: `${TYPE[v.type] ?? v.type} can't be edited here`
		const shownValue = v
			? (
				<div>
					{n.picture
						? <img class="g-picture" src={n.picture} alt={`the picture in ${nameOf(at)}`} />
						: null}
					<div class="g-swatchrow">
						{colour(v) ? <span class="g-swatch" style={`background:${v.text}`} /> : null}
						<pre class={"g-pre" + (v.type === "function" ? " code" : "")}>{v.text}</pre>
					</div>
					{v.cut
						? <p class="g-quiet">{`the first ${v.text.length} of ${v.size} characters`}</p>
						: null}
					<p class="g-quiet g-edit-row">
						{cant ? cant : (
							<button class="g-btn g-small" onClick={handler(A("edit"), [at])}>
								{"edit…"}
							</button>
						)}
					</p>
				</div>
			)
			: <p class="g-quiet">no value</p>
		const editor = () => (
			<div class="g-edit">
				<textarea
					class={"g-pre" + (as === "json" ? " code" : "")}
					aria-label={`the value of ${at}${as === "json" ? ", as json" : ""}`}
					spellcheck={false}
					rows={Math.min(16, Math.max(3, String(v.text).split("\n").length + 1))}
					ref={(el: HTMLTextAreaElement) =>
						queueMicrotask(() => document.activeElement === el || el.focus())}
					onInput={handler(A("typed"), (e: Event) => [
						at,
						(e.currentTarget as HTMLTextAreaElement).value,
						as,
					])}
					onKeyDown={handler(A("edit-key"), (e: KeyboardEvent) => {
						if (e.key === "Escape") return [at, "Escape"]
						if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return
						e.preventDefault()
						return [at, "Save"]
					})}
				>
					{v.text}
				</textarea>
				<div class="g-patches" aria-live="polite">
					{bind(PF("patch"), (pt: Any) =>
						pt?.at !== at ? null : pt.error ? <div class="g-patch bad">{pt.error}</div> : [
							<div class="g-quiet">
								{pt.patches.length
									? plural(pt.patches.length, "patch", "patches")
									: "no change yet"}
							</div>,
							pt.patches.map((p: Any) => <div class="g-patch">{patchWords(p)}</div>),
						])}
				</div>
				<div class="g-edit-row">
					<span class="g-quiet">
						{as === "json" ? "as json. ⌘↩ saves, esc doesn't" : "⌘↩ saves, esc doesn't"}
					</span>
					<button class="g-btn" onClick={handler(A("edit-cancel"))}>cancel</button>
					<button
						class="g-btn g-go"
						disabled={bind(PF("patch"), (pt: Any) =>
							pt?.at !== at || !!pt.error || !pt.patches?.length)}
						onClick={handler(A("save"), [at])}
					>
						save
					</button>
				</div>
			</div>
		)
		const value = v && as && !cant
			? bind(PF("editing"), (e: string) => (e === at ? editor() : shownValue))
			: shownValue
		const c = n.change ?? {}
		return [
			head,
			place,
			section(v ? `value · ${TYPE[v.type] ?? v.type}` : "value", value),
			section("attributes", attributes(n.attributes)),
			section("read by", readBy(n.readBy)),
			c.value ? section("its value's last change", lastChange(c.value)) : null,
			c.attributes
				? section(
					"its attributes' last change",
					lastChange(c.attributes),
					n.why?.attributes ? rows([["why", why(n.why.attributes)]]) : null,
				)
				: null,
			c.children ? section("its names' last change", lastChange(c.children)) : null,
			section(
				"trace",
				<p class="g-quiet">
					{"what led to it: who wrote it, inside what, what that read, back to the code. "}
					<button
						class="g-btn g-small"
						disabled={bind(PF("depth"), (d: number) => d >= 12)}
						onClick={handler(A("deeper"))}
					>
						deeper
					</button>
				</p>,
				<div class="g-traced">
					{bind(`${M}trace`, ({ trace, folded }) => traced(trace, folded))}
				</div>,
			),
		]
	}

	// ---- the trace: each step a row, what it led from under it ----
	function traced(t: { path: string; trace: Any } | null, folded: string[]) {
		if (!t?.trace?.steps) return <p class="g-quiet">tracing…</p>
		return (
			<div class="g-trace" role="tree">
				{t.trace.steps.flatMap((s: Any, i: number) => step(t.path, folded, s, String(i), 0))}
			</div>
		)
	}
	function step(at: string, folded: string[], s: Any, key: string, level: number): Child[] {
		const kids = s.steps ?? []
		// a walk is folded unless opened; anything else open unless folded
		const open = !folded.includes(key) && !(s.what === "walk" && !folded.includes("open:" + key))
		const twist = kids.length
			? (
				<button
					class="g-twist"
					aria-expanded={String(open)}
					aria-label={open ? "fold" : "unfold"}
					onClick={handler(A("fold"), [s.what === "walk" ? "open:" + key : key])}
				>
					{open ? "▾" : "▸"}
				</button>
			)
			: <span class="g-twist" />
		const words = s.at && s.at !== at
			? (
				<a
					class="g-step-go"
					role="link"
					tabIndex={0}
					title={`go to ${s.at}`}
					onClick={goes(s.at)}
					onKeyDown={handler(
						A("go"),
						(e: KeyboardEvent) => (e.key === "Enter" ? [s.at] : undefined),
					)}
				>
					{s.label}
				</a>
			)
			: <span>{s.label}</span>
		const out: Child[] = [
			<div
				key={key}
				class={`g-step g-${s.what.replace(/\s+/g, "-")}`}
				style={`--level:${level}`}
				{...(s.when ? { title: clock(s.when) } : {})}
			>
				{twist}
				<span class="g-glyph" aria-hidden="true">{GLYPH[s.what] ?? "·"}</span>
				<span class="g-step-what">
					{words}
					{s.note ? <span class="g-quiet">{` ${s.note}`}</span> : null}
					{s.where?.length ? <span>{" "}{s.where.map(site)}</span> : null}
				</span>
				{when(s.when)}
			</div>,
		]
		if (s.more) {
			out.push(
				<div key={key + "+"} class="g-step" style={`--level:${level + 1}`}>
					<span class="g-twist" />
					<button class="g-btn g-small" onClick={handler(A("more"), [key, s.more])}>
						more…
					</button>
				</div>,
			)
		}
		if (open) {
			kids.forEach((k: Any, i: number) =>
				out.push(...step(at, folded, k, `${key}.${i}`, level + 1))
			)
		}
		return out
	}

	return (
		<section class="win app-graph" data-win={name} data-label={label} aria-label={label}>
			<div class="body">
				<div class="g-bar">
					<button
						class="g-round"
						aria-label="back"
						title="back"
						disabled={bind(PF("past"), (p: string[]) => p.length === 0)}
						onClick={handler(A("back"))}
					>
						‹
					</button>
					<nav class="g-crumbs" aria-label="where you are">
						{bind(PF("at"), crumbs)}
					</nav>
					<input
						class="g-find"
						type="search"
						placeholder="find"
						aria-label="find a name or a value, from the root"
						value={bind(PF("q"), (q: string) => q)}
						onInput={handler(
							A("typing"),
							(e: Event) => [(e.currentTarget as HTMLInputElement).value],
						)}
						onKeyDown={handler(A("find"), (e: KeyboardEvent) => {
							if (e.key === "Escape") return [""]
							if (e.key === "Enter") return [(e.currentTarget as HTMLInputElement).value]
						})}
						onSearch={handler(A("find"), (e: Event) =>
							(e.currentTarget as HTMLInputElement).value === "" ? [""] : undefined)}
					/>
					<button
						class="g-new"
						onClick={handler(A("new-menu"), (e: MouseEvent) => {
							const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
							return [b.left, b.bottom + 4]
						})}
					>
						+ new
					</button>
					<span class="g-views" role="group" aria-label="show as">
						<button
							aria-pressed={bind(`${M}view`, (v) =>
								String(v.view === "list"))}
							onClick={handler(A("view"), ["list"])}
							title="as a list"
						>
							list
						</button>
						<button
							aria-pressed={bind(`${M}view`, (v) =>
								String(v.view === "columns"))}
							onClick={handler(A("view"), ["columns"])}
							title="as columns"
						>
							columns
						</button>
						<button
							aria-pressed={bind(`${M}view`, (v) => String(v.view === "map"))}
							onClick={handler(A("view"), ["map"])}
							title="as a map: by place, by who made what, by what reads what"
						>
							map
						</button>
					</span>
					<span class="g-live" title="asks for what changed every 2 s while the page is seen">
						live
					</span>
				</div>
				{bind(`${M}finding`, found)}
				<div class="g-panes">
					<nav class="g-side" aria-label="places">{bind(`${M}side`, side)}</nav>
					<div
						class="g-main"
						tabIndex={0}
						aria-label="the graph. arrows walk, return renames, command-delete removes, command-c copies the path, command-i shows what it is"
						onKeyDown={handler(A("key"), keyed)}
					>
						{bind(`${M}view`, (v) =>
							v.view === "columns"
								? columnsView()
								: v.view === "map"
								? mapView()
								: listView(v.folder))}
					</div>
					<div class="g-info" aria-live="polite">
						{bind(F("node"), (n) =>
							info(n))}
					</div>
				</div>
				<div class={bind(`${M}foot`, (f) => (f.bad ? "g-foot bad" : "g-foot"))} role="status">
					<span>
						{bind(`${M}foot`, (f) =>
							f.left)}
					</span>
					<span class="g-quiet">
						{bind(`${M}foot`, (f) =>
							f.right)}
					</span>
				</div>
				{bind(PF("menu"), menu)}
				{bind(PF("confirm"), confirm)}
			</div>
		</section>
	)
}
