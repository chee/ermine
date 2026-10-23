/// <reference lib="dom" />
// map.ts: the graph as lists, two ways.
// - graph: the C (catclock/src), the cache and the loaders, a list each, and a line down the left
//   for the chain the clock runs on: the C into the cache (clang's steps: each C file's object,
//   then the objects linked) and the build running into its runner. The cache lists each build and
//   each object by its key, the latest made or saved to first: a click runs a build and moves
//   nothing; on an object, opens it. The one running is marked, the
//   rest fade by how long since a save wanted them. While clang works its line marches and the
//   build being made comes first.
// - chain: what satisfy found for catclock.c in the box, each step and what runs it; why the other
//   loaders were passed over; the compiler switch; and what is in the box.
// Drawn from what the graph holds (an effect reads the folders, the nodes, satisfy and the box),
// so a node made or changed shows here. A click on a row opens it; on a build, runs it. A row
// written flashes, and a dot can travel any line (in a layer of its own, which a redraw leaves be).
import type { World } from "./world.ts"
import { short } from "./program.ts"
import { ATTRIBUTES as A, satisfy, type Way, type Why } from "@ermine/programs"
import { COMPILER } from "@ermine/compilers"
import { PIN } from "@ermine/processes/start"
import type { Box } from "@ermine/boxes"
import * as lib from "@ermine/places/lib"
import { STATUS } from "@ermine/places/status"
import { PENDING } from "@ermine/scheduler"

type Id = string | symbol
type Member = { readonly name: string; readonly id: Id; readonly from?: string }

export const SRC = ["catclock", "src"], LOADERS = ["loaders"], CACHE = ["cache"]
// the builds: the cache (files.ts tints them)
export const BUILD = CACHE

// one start of the clock, as the log keeps it: the key its build asked for (its link's), its
// objects' keys, what clang said making them, and how it went.
// asking: nothing yet; building: not in the cache, clang has it; hit: the cache had it; miss: clang
// made it; failed: clang said no; refused: satisfy or start said no (error says what); cancelled:
// stopped before its build came back
export type Build = {
	n: number
	key?: string
	objects?: string[]
	warnings?: string
	state: "asking" | "building" | "hit" | "miss" | "failed" | "refused" | "cancelled"
	by?: string // the compiler its chain goes through
	ms?: number
	error?: string
}

export type MapState = {
	compiler?: string // the compiler picked: a start goes through its chain (its name in /loaders)
	open?: string // the path of the node open, joined by /
	failed: Set<string> // files clang complained about
	builds: Build[] // every save's start, newest first
	current?: Build // the start the clock is on: a save's, or a build picked in the cache
	wearing?: string // the key of the build the clock runs
	proc?: Id // the clock's process
	box: Box // the clock's box
	program: string // what satisfy looks up in it, and where from
	from: string[]
	outside: Map<Id, string> // the box's folder, and nodes placed in it from elsewhere: where, by id
}

export type Card = { path: string[]; name: string; x: number; y: number; w: number; h: number }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

// a name cut to n characters, an ellipsis showing the cut
const cut = (
	s: string,
	n: number,
) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s)

const secs = (ms = 0) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
const plural = (n: number, one: string, more = one + "s") => `${n} ${n === 1 ? one : more}`

// what a node is, in a few letters: its extension, or fn for a live function
const ext = (name: string) => (name.includes(".") ? name.split(".").pop()! : "")
const mark = (name: string, live = false) => (live ? "fn" : ext(name) ? "." + ext(name) : "")

// why a loader was passed over, in words: the type it was asked to run, what it said
function because(w: Why, takes: string[] | undefined) {
	switch (w.why) {
		case "wrong-type":
			return `takes ${takes?.join(", ") || "nothing"}, not ${w.type}`
		case "unknown-type":
			return `${w.type} isn't in ermine/types: nothing conforms`
		case "needs":
			return `doesn't provide ${w.missing?.join(", ")}`
		case "no-chain":
			return `takes ${w.type}, but nothing runs it, or what comes after`
		case "no-type":
			return "no type and no function: nothing runs it"
		case "in-the-chain":
			return "already in this chain"
		default:
			return w.why
	}
}

export function createMap(
	svg: SVGSVGElement,
	world: World,
	state: MapState,
	onOpen: (path: string[]) => void,
	onPick: (compiler: string) => void,
) {
	let cards: (Card & { kind: string })[] = []
	// the cache's list: how far it's scrolled, and where it is
	let scrolled = 0
	let strip = { x: 0, y: 0, w: 0, h: 0, max: 0 }
	// the width; a row's and a list head's height; the gutter's line; where rows start
	const W = 360, ROW = 24, HEAD = 24, GUT = 5, X0 = 14
	// the cache shows this many builds at most, the rest scrolled to
	const SHOWN = 6
	const NS = "http://www.w3.org/2000/svg"
	svg.innerHTML = `<g class="drawn"></g><g class="packets"></g>`
	const drawn = svg.querySelector(".drawn")!, packets = svg.querySelector(".packets")!
	// each line's path, by its key, for what travels it
	const lines = new Map<string, string>()
	// a row's moment: pressed (written), popped (new bytes), when, by its path
	const moments = new Map<string, { kind: "press" | "pop"; at: number }>()
	const moment = (key: string) => {
		const m = moments.get(key)
		if (!m) return ""
		const age = performance.now() - m.at
		if (age > 900) return (moments.delete(key), "")
		return ` ${m.kind}" style="--age:-${Math.round(age)}ms`
	}

	// which way it's drawn: the graph, or the chain; the bar's buttons pick (remembered here)
	type View = "graph" | "chain"
	let view: View = "graph"
	try {
		if (localStorage.getItem("catclock:map") === "chain") view = "chain"
	} catch { /* the graph it is */ }
	const pane = svg.closest("#map")
	const buttons = [...(pane?.querySelectorAll<HTMLButtonElement>("[data-map]") ?? [])]
	const show = (v: View) => {
		view = v
		for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.map === v))
	}
	show(view)
	for (const b of buttons) {
		b.addEventListener("click", () => {
			show(b.dataset.map as View)
			try {
				localStorage.setItem("catclock:map", view)
			} catch { /* this visit only */ }
			draw(last ?? world.peek(model))
		})
	}

	// what the map shows, read from the graph (tracked): the folders' names, each node's size, type
	// and part in the chain; the cache; what satisfy finds in the box; the box; the process
	// a build (its wasm) or an object (its bytes, what clang said)
	type Item = { name: string; object?: boolean; bytes?: number; time?: number }
	type Model = {
		src: string[]
		loaders: string[]
		size: Map<string, string>
		type: Map<string, string>
		role: Map<string, string> // a live function's part: compiler or runner
		io: Map<string, { takes?: string[]; gives?: string }> // a loader's types
		cache: Item[]
		ways: Way[] // every way satisfy finds
		why: Why[] // each loader passed over
		refused?: string // the search's own whynot: nothing found
		takes: Map<Id, string[]>
		paths: Map<Id, string[]> // the rows' nodes, by id: where each is, outside the box
		compilers: Map<string, { name?: string; version?: string; target?: string }> // by loader name
		members: Member[] // what is in the box: its folder's names, and its processes
		status: unknown
		pin?: { program?: { hash?: string }; chain?: { at: string[] }[] }
	}
	function model(): Model {
		const size = new Map<string, string>(), type = new Map<string, string>()
		const role = new Map<string, string>(), paths = new Map<Id, string[]>()
		const io = new Map<string, { takes?: string[]; gives?: string }>()
		const src = world.list(SRC), loaders = world.list(LOADERS)
		const compilers: Model["compilers"] = new Map()
		for (const [path, names] of [[SRC, src], [LOADERS, loaders]] as const) {
			for (const name of names) {
				const at = [...path, name], key = at.join("/")
				const id = world.id(at)
				if (id !== undefined) paths.set(id, at)
				const v = world.read(at)
				const a = world.attributes(at)
				if (typeof v === "string") {
					size.set(
						key,
						v.length > 20000
							? `${Math.round(v.length / 1024)} KB`
							: plural(v.split("\n").length, "line"),
					)
				}
				if (typeof v === "function") role.set(key, a?.[A.gives] ? "compiler" : "runner")
				if (typeof a?.[A.type] === "string") type.set(key, a[A.type] as string)
				if (Array.isArray(a?.[A.takes])) {
					io.set(key, {
						takes: a[A.takes] as string[],
						gives: typeof a[A.gives] === "string" ? a[A.gives] as string : undefined,
					})
				}
				if (path === LOADERS && a?.[COMPILER]) {
					compilers.set(
						name,
						a[COMPILER] as { name?: string; version?: string; target?: string },
					)
				}
			}
		}
		const cache = world.list(CACHE).map((name): Item => {
			const id = world.id([...CACHE, name])
			const v = world.read([...CACHE, name])
			const o = (v as { object?: unknown } | undefined)?.object
			return {
				name,
				object: o instanceof Uint8Array || undefined,
				bytes: v instanceof Uint8Array
					? v.length
					: o instanceof Uint8Array
					? o.length
					: undefined,
				time: id === undefined ? undefined : world.places.readChange("value", id)?.time,
			}
		})
		// every way, so every whynot: iterated here, in the run, so tracked
		const why: Why[] = []
		let refused: string | undefined
		const ways = [
			...satisfy(state.box.places, state.program, state.from, {
				onwhynot: (w) => void ("for" in w ? why.push(w) : (refused = w.why)),
			}),
		]
		const takes = new Map<Id, string[]>()
		for (const w of why) {
			const t = state.box.places.readValue("attributes", w.id, [A.takes])
			if (Array.isArray(t)) takes.set(w.id, t)
		}
		const proc = state.proc
		return {
			src,
			loaders,
			size,
			type,
			role,
			io,
			cache,
			ways,
			why,
			refused,
			takes,
			paths,
			compilers,
			members: lib.members(state.box.places, []),
			status: proc === undefined
				? undefined
				: world.places.readValue("attributes", proc, [STATUS]),
			pin: proc === undefined
				? undefined
				: world.places.readValue("attributes", proc, [PIN]) as Model["pin"],
		}
	}
	let last: Model | undefined

	// ---- the parts: a list's head, a row, a tag, a line down the gutter ----

	// a list's head: what it is on the left, a count on the right, a rule under them
	function head(label: string, count: string, y: number) {
		return `<g class="head"><text class="label" x="${X0}" y="${y + 13}">${esc(label)}</text>${
			count
				? `<text class="count" x="${W - 2}" y="${y + 13}" text-anchor="end">${
					esc(count)
				}</text>`
				: ""
		}<path class="rule" d="M${X0},${y + HEAD - 4.5} H${W}"/></g>`
	}

	// a row: a node, what it is, its name, a note on the right; with sub, a second line under it.
	// data: a click opens it (or for a build, runs it)
	type Row = {
		path: string[]
		name: string
		kind: string
		mark: string
		note?: string
		sub?: string
		cls?: string
		label?: string
		right?: string // drawn at the right instead of the note (a tag)
	}
	function row(r: Row, y: number, h = ROW, click = true) {
		const key = r.path.join("/")
		const x = X0, w = W - X0
		cards.push({ kind: r.kind, path: r.path, name: r.name, x, y, w, h })
		const open = state.open === key ? " open" : ""
		return `<g class="item ${r.kind}${open}${r.cls ?? ""}${moment(key)}"${
			click ? ` data-path="${esc(key)}" tabindex="0" role="button"` : ""
		} aria-label="${esc(r.label ?? `open /${key}`)}">
			<rect class="bg" x="${x}" y="${y + 1}" width="${w}" height="${h - 2}" rx="2"/>
			<text class="mark m-${r.mark.replace(".", "")}" x="${x + 6}" y="${y + 16}">${
			esc(r.mark)
		}</text>
			<text class="name" x="${x + 40}" y="${y + 16}">${esc(cut(r.name, 24))}</text>
			${
			r.right ??
				(r.note
					? `<text class="note" x="${x + w - 6}" y="${y + 16}" text-anchor="end">${
						esc(r.note)
					}</text>`
					: "")
		}
			${
			r.sub ? `<text class="sub" x="${x + 40}" y="${y + 30}">${esc(cut(r.sub, 52))}</text>` : ""
		}
		</g>`
	}

	// a tag: a small skewed label, its right edge at right, its middle at y
	function tag(text: string, right: number, y: number, tone = "") {
		const w = [...text].length * 5.75 + 10, x = right - w
		const cx = x + w / 2
		return `<g class="tag ${tone}"><rect x="${x}" y="${
			y - 7.5
		}" width="${w}" height="15" transform="translate(${cx} ${y}) skewX(-10) translate(${-cx} ${-y})"/><text x="${
			x + 5
		}" y="${y + 3.5}">${esc(text)}</text></g>`
	}

	// a line down the gutter: out of the row at y0, down, into the row at y1 (an arrowhead there)
	function edge(key: string, y0: number, y1: number, tone = "") {
		const d = `M${X0 - 2},${y0} H${GUT} V${y1} H${X0 - 2}`
		lines.set(key, d)
		const t = X0 - 2
		return `<g class="edge ${tone}"><path class="ink" d="${d}"/><path class="tip" d="M${
			t - 4.5
		},${y1 - 3.5} L${t},${y1} L${t - 4.5},${y1 + 3.5}"/></g>`
	}

	const said = (text: string, y: number) =>
		`<text class="said" x="${X0 + 6}" y="${y + 16}">${esc(text)}</text>`

	// how many starts a key answered from the cache, and how many it was built for
	const counts = (key: string) => {
		let hits = 0, misses = 0
		for (const b of state.builds) {
			if (b.key !== key) continue
			if (b.state === "hit") hits++
			if (b.state === "miss") misses++
		}
		return { hits, misses }
	}

	// a build in the cache, by its key: its size, its hits, and the clock's state if it's on it.
	// the rest faded by how long since a save wanted them. the build being made (not in the cache
	// yet): first, compiling, or its error
	type Kind = "building" | "failed" | number
	function stateOf(key: string, m: Model, kind: Kind) {
		if (kind === "building") return "compiling"
		if (kind === "failed") return "error"
		const c = state.current
		if (c?.key === key && (c.state === "hit" || c.state === "miss")) {
			return m.status === PENDING
				? "starting"
				: m.status instanceof Error
				? "error"
				: state.proc === undefined
				? "stopped"
				: "running"
		}
		// the canvas still shows it: stopped, its next building, failed or cancelled
		return key === state.wearing ? "stopped" : ""
	}
	function buildRow(it: Item, y: number, kind: Kind, m: Model) {
		const fade = typeof kind !== "number" ? 1 : Math.max(0.45, 1 - kind * 0.12)
		const path = [...CACHE, it.name], key = path.join("/")
		const { hits } = counts(it.name)
		const st = stateOf(it.name, m, kind)
		// the build being made isn't in the cache: nothing to run yet. an object: opened, not run
		const real = typeof kind === "number"
		const what = it.object ? "object" : "build"
		const x = X0, w = W - X0
		cards.push({ kind: "build", path, name: it.name, x, y, w, h: ROW })
		const cls = [
			"item build",
			typeof kind === "number" ? "" : kind,
			it.name === state.wearing ? "worn" : "",
		].filter(Boolean).join(" ")
		return `<g class="${cls}${moment(key)}"${
			real ? ` data-path="${esc(key)}" tabindex="0" role="button"` : ""
		}${it.name === state.wearing ? ' aria-current="true"' : ""} aria-label="${
			real ? (it.object ? "open " : "run ") : ""
		}${what} ${esc(short(it.name))}${st ? `, ${st}` : ""}" style="opacity:${fade.toFixed(2)}">
			<rect class="bg" x="${x}" y="${y + 1}" width="${w}" height="${ROW - 2}" rx="2"/>
			<text class="mark ${it.object ? "m-o" : "m-wasm"}" x="${x + 6}" y="${y + 16}">${
			it.object ? ".o" : ".wasm"
		}</text>
			<text class="name" x="${x + 40}" y="${y + 16}">${esc(short(it.name) || "…")}</text>
			<text class="note" x="${x + 192}" y="${y + 16}" text-anchor="end">${
			it.bytes === undefined ? "" : kb(it.bytes)
		}</text>
			<text class="note" x="${x + 252}" y="${y + 16}" text-anchor="end">${
			hits ? plural(hits, "hit") : ""
		}</text>
			<text class="state ${st}" x="${x + w - 6}" y="${y + 16}" text-anchor="end">${st}</text>
			<title>key ${esc(it.name)}${
			it.bytes ? `: ${kb(it.bytes)} of ${it.object ? "object" : "wasm"}` : ""
		}${it.time ? `, made ${esc(ago(it.time))}` : ""}${
			real ? `; ${plural(hits, "hit")}` : ""
		}</title>
		</g>`
	}

	const ago = (t?: number) => {
		if (!t) return ""
		const s = Date.now() / 1000 - t
		return s < 60
			? "just now"
			: s < 3600
			? `${Math.floor(s / 60)} min ago`
			: `${Math.floor(s / 3600)} h ago`
	}

	// ---- the graph: src, the cache, the loaders, and the chain's lines down the gutter ----
	function drawGraph(m: Model): [string, number] {
		let out = "", y = 0
		const now = state.builds[0]
		// the C
		const srcHead = y
		out += head(SRC.join("/"), plural(m.src.length, "file"), y)
		y += HEAD
		for (const name of m.src) {
			const key = [...SRC, name].join("/")
			const failed = state.failed.has(name)
			out += row({
				path: [...SRC, name],
				name,
				kind: "src",
				mark: mark(name),
				note: failed ? "error" : m.size.get(key) ?? "",
				cls: failed ? " failed" : "",
			}, y)
			y += ROW
		}
		const gap = y
		y += 26
		// the cache: the build being made first, then by the last save that wanted each
		const cacheHead = y
		const hits = state.builds.filter((b) => b.state === "hit").length
		const misses = state.builds.filter((b) => b.state === "miss").length
		const objects = m.cache.filter((c) => c.object).length
		out += head(
			CACHE.join("/"),
			`${plural(m.cache.length - objects, "build")} · ${plural(objects, "object")} · ${
				plural(hits, "hit")
			} · ${plural(misses, "miss", "misses")}`,
			y,
		)
		y += HEAD
		const wanted = new Map<string, number>()
		// a build, then its objects
		state.builds.forEach((b, i) => {
			for (const k of [b.key, ...(b.objects ?? [])]) if (k && !wanted.has(k)) wanted.set(k, i)
		})
		const items = [...m.cache].sort((a, b) =>
			(wanted.get(a.name) ?? Infinity) - (wanted.get(b.name) ?? Infinity) ||
			(b.time ?? 0) - (a.time ?? 0)
		)
		// the one being made: its build, or before it's linked, its first object not kept yet
		const kept = (k: string) => m.cache.some((c) => c.name === k)
		const making = now &&
				(now.state === "asking" || now.state === "building" || now.state === "failed")
			? now
			: undefined
		const ghost: Item | undefined = !making
			? undefined
			: making.key
			? (kept(making.key) ? undefined : { name: making.key })
			: (() => {
				const k = making.objects?.find((o) => !kept(o))
				return k ? { name: k, object: true } : undefined
			})()
		const shown = (ghost ? 1 : 0) + items.length
		const visible = Math.max(1, Math.min(SHOWN, shown))
		strip = { x: X0, y, w: W - X0, h: visible * ROW, max: Math.max(0, (shown - visible) * ROW) }
		scrolled = Math.min(scrolled, strip.max)
		const at = (n: number) => y + n * ROW - scrolled
		const inside = (v: number) => Math.max(strip.y + 6, Math.min(strip.y + strip.h - 6, v))
		let html = "", i = 0, worn: number | undefined
		if (ghost) {
			html += buildRow(ghost, at(i++), making!.state === "failed" ? "failed" : "building", m)
		}
		items.forEach((it, k) => {
			if (it.name === state.wearing) worn = at(i) + ROW / 2
			html += buildRow(it, at(i++), k, m)
		})
		if (!shown) html += said("nothing built yet", y)
		out += `<defs>
			<clipPath id="strip"><rect x="${strip.x}" y="${strip.y}" width="${strip.w}" height="${strip.h}"/></clipPath>
			<linearGradient id="fade-past" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="#fff" stop-opacity="${scrolled > 0 ? 0.15 : 1}"/>
				<stop offset="0.14" stop-color="#fff"/><stop offset="0.86" stop-color="#fff"/>
				<stop offset="1" stop-color="#fff" stop-opacity="${strip.max > scrolled ? 0.15 : 1}"/>
			</linearGradient>
			<mask id="past" maskUnits="userSpaceOnUse"><rect x="${strip.x}" y="${strip.y}" width="${strip.w}" height="${strip.h}" fill="url(#fade-past)"/></mask>
		</defs><g class="strip" clip-path="url(#strip)" mask="url(#past)">${html}</g>`
		y += strip.h
		y += 26
		// the loaders: compilers, then the rest, the runners last (the line to the clock leaves
		// from there)
		out += head(LOADERS.join("/"), String(m.loaders.length), y)
		y += HEAD
		const rank = (n: string) => {
			const r = m.role.get([...LOADERS, n].join("/"))
			return r === "compiler" ? 0 : r === "runner" ? 2 : 1
		}
		const runner = (picked(m) ?? m.ways[0])?.chain.at(-1)?.at.at(-1)
		let runs: number | undefined
		for (const name of [...m.loaders].sort((a, b) => rank(a) - rank(b))) {
			const key = [...LOADERS, name].join("/")
			const role = m.role.get(key)
			if (name === runner) runs = y + ROW / 2
			out += row({
				path: [...LOADERS, name],
				name,
				kind: "loaders",
				mark: mark(name, role !== undefined),
				note: role ?? m.size.get(key) ?? "",
			}, y)
			y += ROW
		}
		// the chain's lines: the C into the cache, clang's step (into the build it makes, or made);
		// the build running into its runner
		const b = now
		const tone = b?.state === "asking" || b?.state === "building"
			? "busy"
			: b?.state === "failed"
			? "failed"
			: ""
		out += edge("src-cache", srcHead + 12, shown ? inside(at(0) + ROW / 2) : cacheHead + 12, tone)
		out += `<text class="step ${tone}" x="${X0 + 6}" y="${gap + 16}">${
			esc(b?.by ?? state.compiler ?? "")
		}</text>`
		if (worn !== undefined && runs !== undefined) {
			const st = m.status === PENDING ? "busy" : m.status instanceof Error ? "failed" : ""
			out += edge("cache-runner", inside(worn), runs, st)
		}
		return [out, y + 4]
	}

	// ---- the chain: satisfy's answer, why the others weren't taken, the compiler, the box ----
	function drawChain(m: Model): [string, number] {
		let out = "", y = 0
		const name = (at: readonly string[]) => at.at(-1) ?? "/"
		const host = (id: Id, at: readonly string[]) => m.paths.get(id) ?? [...at]
		const TWO = 38

		// satisfy: each way a step a row, a line down the gutter from each into the next
		const ways = m.ways.length
		out += head(
			`satisfy ${state.program} from /${state.from.join("/")}`,
			ways === 0
				? "none"
				: ways === 1
				? "1 way, started"
				: `${ways} ways, ${picked(m) ? `${state.compiler}'s` : "the first"} started`,
			y,
		)
		y += HEAD
		if (m.refused) {
			out += said(`nothing found: ${m.refused}`, y)
			y += ROW
		}
		m.ways.forEach((way, i) => {
			if (i) y += 8
			const steps = [
				{ id: way.program.id, at: way.program.at, by: [] as Way["chain"] },
				...way.chain,
			]
			let before: number | undefined
			steps.forEach((s, j) => {
				const path = host(s.id, s.at), key = path.join("/"), n = name(s.at)
				const io = m.io.get(key)
				const types = io?.gives
					? `${io.takes?.join(", ") ?? ""} → ${io.gives}`
					: io?.takes
					? `runs ${io.takes.join(", ")}`
					: ""
				const by = s.by.length ? `by ${s.by.map((b) => name(b.at)).join(" → ")}` : ""
				out += row(
					{
						path,
						name: n,
						kind: "step",
						mark: mark(n, m.role.has(key)),
						note: j === 0 ? "program" : j === steps.length - 1 ? "runner" : "compiler",
						sub: j === 0 ? m.type.get(key) ?? "" : [types, by].filter(Boolean).join(" · "),
					},
					y,
					TWO,
				)
				const mid = y + 12
				if (before !== undefined) out += edge(`chain-${i}-${j}`, before, mid)
				before = mid
				y += TWO
			})
		})
		y += 16

		// the compilers: each in /loaders, the one picked on; clang without serve.ts, shown off
		out += head("compile with", "", y)
		y += HEAD
		const option = (top: number, name: string, on: boolean, sub: string, off?: string) =>
			`<g class="option${off ? " off" : ""}" role="radio" aria-checked="${on}"${
				off ? ` aria-disabled="true"` : ` data-compiler="${esc(name)}" tabindex="0"`
			}>${off ? `<title>${esc(off)}</title>` : ""}
				<rect class="area" x="${X0}" y="${top}" width="${
				W - X0
			}" height="${TWO}" fill="transparent"/>
				<rect class="dot" x="${X0 + 3}" y="${top + 6}" width="11" height="11" rx="2"/>${
				on ? `<rect class="pip" x="${X0 + 6}" y="${top + 9}" width="5" height="5" rx="1"/>` : ""
			}
				<text class="what" x="${X0 + 24}" y="${top + 16}">${esc(name)}</text>
				<text class="sub" x="${X0 + 24}" y="${top + 30}">${esc(sub)}</text>
			</g>`
		const where: Record<string, string> = {
			"clang": "this machine's, by serve.ts",
			"netlify-clang": "wasm, in a Netlify function",
			"wasm-clang": "in this page, as wasm",
		}
		for (const [name, c] of m.compilers) {
			const said = [where[name], c.version].filter(Boolean)
			out += option(y, name, name === state.compiler, cut(said.join(": "), 60))
			y += TWO
		}
		if (!m.compilers.has("clang")) {
			out += option(
				y,
				"clang",
				false,
				"on this machine: only with serve.ts",
				"deno run -A playground/demos/catclock/serve.ts, then http://localhost:8077",
			)
			y += TWO
		}
		y += 16

		// why: each loader looked at and not taken
		out += head("why not", String(m.why.length), y)
		y += HEAD
		if (!m.why.length) {
			out += said("nothing passed over", y)
			y += ROW
		}
		for (const w of m.why) {
			const path = host(w.id, w.at), n = name(w.at)
			out += row(
				{
					path,
					name: n,
					kind: "why",
					mark: mark(n, m.role.has(path.join("/"))),
					right: tag(w.why, W - 6, y + 12),
					sub: because(w, m.takes.get(w.id)),
				},
				y,
				TWO,
			)
			y += TWO
		}
		y += 16

		// the box: a plain folder; its names, each where it is outside (a node placed there too:
		// its own place), and the process started in it
		const rows: [string, string, string, string?][] = []
		const outside = (id: Id) => state.outside.get(id)
		const folder = outside(state.box.root) ?? String(state.box.root)
		rows.push(["/", folder, "folder"])
		for (const it of m.members) {
			if (it.from !== "children") continue
			const there = outside(it.id)
			rows.push([it.name, there ?? `${folder}/${it.name}`, there ? "placed" : "child"])
		}
		for (const it of m.members) {
			if (it.from !== "process") continue
			const s = m.status
			rows.push([
				it.name,
				`proc:${String(it.id).replace(/^proc:/, "").slice(0, 8)}`,
				"process",
				s === PENDING ? "starting" : s instanceof Error ? "error" : "running",
			])
		}
		out += head("box", plural(rows.length, "name"), y)
		y += HEAD
		const R = 22
		rows.forEach(([path, to, kind, status]) => {
			out += `<g class="line">
				<text class="name" x="${X0 + 6}" y="${y + 15}">${esc(cut(path, 13))}</text>
				<text class="sub" x="${X0 + 112}" y="${y + 15}">${esc(cut(to, 26))}</text>
				${
				status
					? tag(status, W - 6, y + 11, status === "error" ? "failed" : "")
					: `<text class="note" x="${W - 6}" y="${y + 15}" text-anchor="end">${
						esc(kind)
					}</text>`
			}
			</g>`
			y += R
		})
		const pin = m.pin
		if (pin) {
			const said = [
				`${state.program} ${short(pin.program?.hash)}`,
				...(pin.chain ?? []).map((s) => name(s.at)),
			].join(" → ")
			out += `<text class="sub" x="${X0 + 6}" y="${y + 17}">pinned: ${esc(cut(said, 56))}</text>`
			y += R
		}
		return [out, y + 6]
	}

	function draw(m: Model) {
		last = m
		cards = []
		strip = { x: 0, y: 0, w: 0, h: 0, max: 0 }
		const [out, height] = view === "graph" ? drawGraph(m) : drawChain(m)
		svg.setAttribute("viewBox", `0 -2 ${W} ${height + 2}`)
		svg.dataset.view = view
		drawn.innerHTML = out
	}

	// the way through the compiler picked
	const picked = (m: Model) =>
		m.ways.find((w) => w.chain[0] && m.paths.get(w.chain[0].id)?.at(-1) === state.compiler)

	function press(t: Element) {
		const c = t.closest?.("[data-compiler]") as SVGGElement | null
		if (c?.dataset.compiler) return (onPick(c.dataset.compiler), true)
		const g = t.closest?.("[data-path]") as SVGGElement | null
		if (g?.dataset.path) return (onOpen(g.dataset.path.split("/")), true)
		return false
	}
	svg.addEventListener("click", (e) => press(e.target as Element))
	svg.addEventListener("keydown", (e) => {
		if ((e.key === "Enter" || e.key === " ") && press(e.target as Element)) e.preventDefault()
	})
	// the cache's list scrolled by a wheel or a trackpad over it
	svg.addEventListener("wheel", (e) => {
		if (!strip.max) return
		const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, k = vb.width / r.width
		const x = vb.x + (e.clientX - r.left) * k, y = vb.y + (e.clientY - r.top) * k
		if (x < strip.x || x > strip.x + strip.w || y < strip.y || y > strip.y + strip.h) return
		const by = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * k
		const next = Math.max(0, Math.min(strip.max, scrolled + by))
		if (next === scrolled) return
		e.preventDefault()
		scrolled = next
		draw(last ?? world.peek(model))
	}, { passive: false })

	// drawn again whenever what it read changes
	world.effect("the map", model, draw)

	// a dot along a line, start to end; done when it gets there (at once, for someone who asked
	// for less motion, or when the line isn't drawn: the chain shown)
	function travel(key: string, ms = 650): Promise<void> {
		const d = lines.get(key)
		if (!d || view !== "graph" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
			return Promise.resolve()
		}
		const path = document.createElementNS(NS, "path")
		path.setAttribute("d", d)
		path.setAttribute("class", "track")
		const dot = document.createElementNS(NS, "g")
		dot.setAttribute("class", "packet")
		dot.innerHTML = `<circle class="dot" r="3.6"/>`
		packets.append(path, dot)
		const length = path.getTotalLength(), start = performance.now()
		return new Promise((done) => {
			const step = (now: number) => {
				const t = Math.min(1, (now - start) / ms)
				const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
				const p = path.getPointAtLength(length * e)
				dot.setAttribute("transform", `translate(${p.x} ${p.y})`)
				if (t < 1) return void requestAnimationFrame(step)
				path.remove()
				dot.remove()
				done()
			}
			requestAnimationFrame(step)
		})
	}

	// a row, on the page, in the page's own coordinates (scrolled with it)
	const onPage = (name: string, at: (c: Card) => { x: number; w: number }) => {
		const c = cards.find((c) => c.name === name)
		if (!c) return undefined
		const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal
		const k = r.width / vb.width, { x, w } = at(c)
		return {
			x: r.left + scrollX + (x - vb.x) * k,
			y: r.top + scrollY + (c.y - vb.y) * k,
			w: w * k,
			h: c.h * k,
		}
	}

	return {
		redraw: () => draw(last ?? world.peek(model)),
		travel,
		// a row flashed: written, or new bytes
		press: (
			path: string[],
		) => (moments.set(path.join("/"), { kind: "press", at: performance.now() }),
			draw(last ?? world.peek(model))),
		pop: (
			path: string[],
		) => (moments.set(path.join("/"), { kind: "pop", at: performance.now() }),
			draw(last ?? world.peek(model))),
		// a row's box
		box: (name: string) => onPage(name, (c) => c),
		// where a line leaves a row: the gutter beside it, no wider than a line
		exit: (name: string) => onPage(name, () => ({ x: GUT, w: 0 })),
	}
}
