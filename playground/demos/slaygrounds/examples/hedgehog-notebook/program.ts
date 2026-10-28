/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	createWriter,
	ensureNode,
	explain,
	getStatus,
	hasNode,
	patch,
	peep,
	PENDING,
	read,
	remove,
	start,
} from "@ermine/system"
import { bind, handler } from "ermine-h"

// hedgehog-notebook: a reactive notebook on the process api alone.
// the notebook is nodes beside the process: /nb/order (the ids, in order), /nb/cell/<id> (one record
// each), /nb/epoch/<id> (bumped to empty a cache). each cell has a memo, c-<id>, inside the process,
// made by one effect, "cells", that reads the order (the rule: a memo is made inside its maker's
// node, by a bare name). a cell reads another by name: cell("n") reads the node /nb/names/n,
// then that cell's memo. the arrows come from explain(c-<id>): the nodes its latest run read

type Kind = "code" | "md" | "slider" | "input" | "chart"
type Cell = {
	name: string
	kind: Kind
	src?: string
	min?: number
	max?: number
	step?: number
	value?: unknown
	ctype?: string
	folded?: boolean
}
// what a cell's memo gives: its value or its error as data (a failed run is a value, so its reads
// are still there to be explained), how often it ran, and what it read by name
type Out = {
	id: string
	kind: Kind
	value?: unknown
	error?: string
	runs: number
	hits: number
	reads: string[]
	cached?: boolean
}

const R = (id: string) => `/nb/cell/${id}`
const json = (v: unknown, space?: number) => {
	try {
		return JSON.stringify(v, null, space) ?? "undefined"
	} catch {
		return String(v)
	}
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---- the seed ----
const SEED: [string, Cell][] = [
	["intro", {
		name: "intro",
		kind: "md",
		src:
			"# A reactive notebook\nEdit a cell, drag a slider, type a city: only the cells that read it run again. The rail on the left draws who reads whom, from what each run really read.",
	}],
	["n", { name: "n", kind: "slider", min: 3, max: 80, step: 1, value: 50 }],
	["wobble", { name: "wobble", kind: "slider", min: 0, max: 8, step: 0.5, value: 2.5 }],
	["wave", {
		name: "wave",
		kind: "code",
		src:
			`const n = cell("n"), w = cell("wobble")\nreturn Array.from({ length: n }, (_, i) =>\n  Math.sin(i / 4) + w * Math.sin(i * 1.7) / 4)`,
	}],
	["wavechart", { name: "wave chart", kind: "chart", src: "wave", ctype: "area" }],
	["stats", {
		name: "stats",
		kind: "code",
		src:
			`const w = cell("wave")\nreturn {\n  min: Math.min(...w),\n  max: Math.max(...w),\n  mean: w.reduce((a, b) => a + b, 0) / w.length,\n}`,
	}],
	["summary", {
		name: "summary",
		kind: "md",
		src:
			'**${cell("n")}** points; the highest is **${cell("stats").max.toFixed(2)}**, the lowest ${cell("stats").min.toFixed(2)}.',
	}],
	["city", { name: "city", kind: "input", value: "Lisbon" }],
	["weather", {
		name: "weather",
		kind: "code",
		src:
			`const city = cell("city")\nconst days = await fakeFetch("weather", { city })\nreturn days`,
	}],
	["weatherchart", { name: "weather chart", kind: "chart", src: "weather", ctype: "bars" }],
	["stamp", {
		name: "stamp",
		kind: "code",
		src: `// nocache\nnew Date().toLocaleTimeString() + " (n is " + cell("n") + ")"`,
	}],
]
const STORE = "hedgehog-notebook"

// ---- code: an expression, or a body that returns; await makes it async ----
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor
function compile(kind: Kind, src: string): (cell: unknown, fakeFetch: unknown) => unknown {
	if (kind === "md") {
		return new Function("cell", "fakeFetch", "return `" + src.replace(/`/g, "\\`") + "`") as never
	}
	const F = /\bawait\b/.test(src) ? AsyncFunction : Function
	try {
		return new F("cell", "fakeFetch", `return (\n${src}\n)`) as never
	} catch {
		return new F("cell", "fakeFetch", src) as never
	}
}

// ---- made-up weather ----
function fakeDays(city: string) {
	let h = 0
	for (const c of city.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 997
	const out: Record<string, number> = {}
	;["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d, i) => {
		out[d] = Math.round(8 + (h % 14) + 6 * Math.sin(h + i * 0.9))
	})
	return out
}

export default function program() {
	// ---- seed once (or restore a saved page after a page reload) ----
	if (!hasNode("/nb/seeded")) {
		let saved: { order: string[]; cells: Record<string, Cell> } | undefined
		try {
			saved = JSON.parse(localStorage.getItem(STORE) ?? "null") ?? undefined
		} catch { /* no storage: seed */ }
		const cells = saved ? Object.entries(saved.cells) : SEED
		for (const [id, c] of cells) {
			ensureNode(R(id), c)
			ensureNode(`/nb/names/${c.name}`, id)
			ensureNode(`/nb/epoch/${id}`, 0)
		}
		ensureNode("/nb/order", saved ? saved.order : SEED.map(([id]) => id))
		ensureNode("/nb/fetches", 0)
		ensureNode("/nb/seeded", true)
	}
	const order = "/nb/order"
	const ids = () => peep(() => read(order)) as string[]

	// ---- what the cells' code is given ----
	const withWriter = createWriter()
	const fakeFetch = (_what: string, { city }: { city: string }) => {
		const bump = () =>
			patch("/nb/fetches", [{
				path: [],
				value: (peep(() => read("/nb/fetches")) as number) + 1,
			}])
		// in a run, a direct write; after an await, nothing is open: through the writer
		try {
			bump()
		} catch {
			withWriter(bump)
		}
		return new Promise((done) => setTimeout(() => done(fakeDays(city)), 2000))
	}

	// ---- names: one node for each, /nb/names/<name>, holding the id (kept by the actions) ----
	const nameAt = (name: string) => `/nb/names/${name}`
	const taken = (name: string) => !name || /\//.test(name) || peep(() => hasNode(nameAt(name)))

	// ---- caches and counts: plain memory ----
	type Entry = { key: string; deps: [string, string][]; value: unknown }
	const caches = new Map<string, Entry[]>()
	const counts = new Map<string, { runs: number; hits: number }>()

	// one cell's run: read its parts, read the cells it asks for, answer
	function runCell(id: string): Out | Promise<Out> | typeof PENDING {
		const kind = read(R(id), ["kind"]) as Kind
		read(`/nb/epoch/${id}`)
		const reads: string[] = []
		// each value as it was read (a read after an await is no longer possible)
		const vals: Record<string, string> = {}
		const count = counts.get(id) ?? { runs: 0, hits: 0 }
		counts.set(id, count)
		const out = (o: Partial<Out>): Out => ({
			id,
			kind,
			reads,
			runs: count.runs,
			hits: count.hits,
			...o,
		})
		let blocked = false, counted = false
		const tick = () => {
			count.runs++
			counted = true
		}
		const valueOf = (name: string) => {
			reads.push(name)
			// a node not there throws PENDING, and the read is tracked: its coming reruns this
			let from: string
			try {
				from = read(nameAt(name)) as string
			} catch (e) {
				if (e === PENDING && peep(() => !hasNode(nameAt(name)))) {
					throw new Error(`no cell named "${name}"`)
				}
				throw e
			}
			// a memo with an old value gives it while its new run is out: ask its status, so what
			// reads it waits too
			const target = (memos.get(from) ?? `./c-${from}/v`) as never
			if (getStatus(target)?.state === "pending") throw PENDING
			const o = read(target) as Out
			if (o.error !== undefined) throw new Error(`"${name}" failed: ${o.error}`)
			if (!(name in vals)) vals[name] = json(o.value)
			return o.value
		}
		const cell = (name: string) => {
			try {
				return valueOf(name)
			} catch (e) {
				if (e === PENDING) blocked = true
				throw e
			}
		}
		try {
			if (kind === "slider" || kind === "input") {
				tick()
				return out({ value: read(R(id), ["value"]) })
			}
			if (kind === "chart") {
				tick()
				return out({ value: cell(read(R(id), ["src"]) as string) })
			}
			const src = read(R(id), ["src"]) as string
			const nocache = /^\s*\/\/\s*nocache\b/m.test(src)
			const key = kind + "\0" + src
			// the same code, the same values read before: its earlier value, run nothing
			if (!nocache) {
				for (const e of caches.get(id) ?? []) {
					if (e.key !== key) continue
					let same = true
					const seen: string[] = []
					for (const [name, was] of e.deps) {
						seen.push(name)
						if (json(cell(name)) !== was) {
							same = false
							break
						}
					}
					if (same) {
						count.hits++
						reads.push(...seen)
						return out({ value: e.value, cached: true })
					}
				}
				reads.length = 0
				for (const k in vals) delete vals[k]
			}
			tick()
			const remember = (value: unknown) => {
				if (nocache) return
				const list = caches.get(id) ?? []
				// the deps as the code read them, with their values now
				const deps = Object.entries(vals)
				list.unshift({ key, deps, value })
				caches.set(id, list.slice(0, 12))
			}
			const result = compile(kind, src)(cell, fakeFetch)
			if (result && typeof (result as Promise<unknown>).then === "function") {
				if (blocked) {
					;(result as Promise<unknown>).catch(() => {})
					if (counted) count.runs--
					return PENDING
				}
				return (result as Promise<unknown>).then(
					(value) => {
						try {
							remember(value)
						} catch { /* a read after the await: not cached */ }
						return out({ value })
					},
					(e) => out({ error: message(e) }),
				)
			}
			remember(result)
			return out({ value: result })
		} catch (e) {
			if (e === PENDING) {
				if (counted) count.runs--
				throw e
			}
			return out({ error: message(e) })
		}
	}

	// ---- one process for each cell, started by this one; its memo, v, is inside it ----
	// each memo's handle: read by it, not by its path (a path read is tracked through every folder it walks,
	// and a cell added or removed would rerun every cell that reads any other)
	const memos = new Map<string, unknown>()
	const live = new Map<string, { stop: (why?: never) => void }>()
	const spawn = (id: string) => {
		const p = start(() => void memos.set(id, createMemo("v", () => runCell(id))), `c-${id}`)
		if ("stop" in p) live.set(id, p)
	}
	for (const id of ids()) spawn(id)

	// ---- who reads whom: from the nodes each cell's latest run read ----
	createMemo("edges", () => {
		const reads: Record<string, string[]> = {}
		for (const id of read(order) as string[]) {
			const run = explain(`c-${id}/v`)?.writer
			const list: string[] = []
			if (run?.kind === "computer") {
				for (const t of run.run?.reads ?? []) {
					const at = t.path?.at(-2)
					if (at?.startsWith("c-") && t.path?.at(-1) === "v" && at !== `c-${id}`) {
						list.push(at.slice(2))
					}
				}
			}
			reads[id] = [...new Set(list)]
		}
		return reads
	}, { equal: (a, b) => json(a) === json(b) })

	// ---- save (a page reload): the notebook as the browser's storage keeps it ----
	createEffect("save", () => {
		const o = read(order) as string[]
		const cells: Record<string, unknown> = {}
		for (const id of o) cells[id] = read(R(id))
		return { order: o, cells }
	}, (snapshot) => {
		try {
			localStorage.setItem(STORE, JSON.stringify(snapshot))
		} catch { /* no storage */ }
	})

	// ---- changes ----
	const set = (id: string, field: string, value: unknown) =>
		patch(R(id), [{ path: [field], value }])
	createAction("on/set", (id: string, field: string, value: unknown) => set(id, field, value))
	createAction("on/rename", (id: string, name: string) => {
		name = name.trim()
		const old = peep(() => read(R(id), ["name"])) as string
		if (name === old || taken(name)) return
		remove(nameAt(old))
		ensureNode(nameAt(name), id)
		set(id, "name", name)
	})
	createAction("on/move", (id: string, by: number) => {
		const d = [...ids()], i = d.indexOf(id), j = i + by
		if (i < 0 || j < 0 || j >= d.length) return
		;[d[i], d[j]] = [d[j], d[i]]
		patch(order, [{ path: [], value: d }])
	})
	createAction("on/add", (after: string | null, kind: Kind) => {
		const id = crypto.randomUUID().slice(0, 6)
		let k = ids().length + 1
		while (taken(`${kind}${k}`)) k++
		const c: Cell = { name: `${kind}${k}`, kind }
		if (kind === "code") c.src = "// an expression, or a body that returns\n1 + 1"
		if (kind === "md") c.src = 'write ${cell("n")} here'
		if (kind === "slider") Object.assign(c, { min: 0, max: 10, step: 1, value: 5 })
		if (kind === "input") c.value = ""
		if (kind === "chart") Object.assign(c, { src: "wave", ctype: "line" })
		ensureNode(R(id), c)
		ensureNode(nameAt(c.name), id)
		ensureNode(`/nb/epoch/${id}`, 0)
		spawn(id)
		const d = [...ids()]
		const at = after === null ? -1 : d.indexOf(after)
		d.splice(at + 1, 0, id)
		patch(order, [{ path: [], value: d }])
	})
	createAction("on/remove", (id: string) => {
		patch(order, [{ path: [], value: ids().filter((x) => x !== id) }])
		live.get(id)?.stop()
		live.delete(id)
		memos.delete(id)
		caches.delete(id)
		counts.delete(id)
		remove(nameAt(peep(() => read(R(id), ["name"])) as string))
		remove(R(id))
		remove(`/nb/epoch/${id}`)
	})
	createAction("on/clear", (id: string) => {
		caches.delete(id)
		patch(`/nb/epoch/${id}`, [{
			path: [],
			value: (peep(() => read(`/nb/epoch/${id}`)) as number) + 1,
		}])
	})

	// ---- the view ----
	let rail: HTMLElement
	let edges: Record<string, string[]> = {}
	let queued = false
	const layout = () => {
		queued = false
		if (!rail) return
		const page = rail.parentElement!
		const at = (id: string) => {
			const el = page.querySelector<HTMLElement>(`[data-cell="${id}"]`)
			return el ? el.offsetTop + 14 : undefined
		}
		const paths: string[] = []
		let lane = 0
		for (const [reader, from] of Object.entries(edges)) {
			for (const source of from) {
				const y1 = at(source), y2 = at(reader)
				if (y1 === undefined || y2 === undefined) continue
				const x = 50 - 6 * (1 + (lane++ % 7))
				paths.push(
					`<path d="M54 ${y1} C ${x} ${y1}, ${x} ${y2}, 52 ${
						y2 - 0
					}" fill="none" stroke="#111" stroke-width="1.5"/>` +
						`<path d="M58 ${y2 - 4} L52 ${y2} L58 ${
							y2 + 4
						}" fill="none" stroke="#111" stroke-width="1.5"/>` +
						`<circle cx="54" cy="${y1}" r="2.5" fill="#ff5fa2" stroke="#111"/>`,
				)
			}
		}
		rail.innerHTML = `<svg width="64" height="${page.scrollHeight}">${paths.join("")}</svg>`
	}
	const relayout = () => {
		if (!queued) {
			queued = true
			requestAnimationFrame(layout)
		}
	}
	const go = (id: string) => {
		const el = document.querySelector<HTMLElement>(`[data-cell="${id}"]`)
		el?.scrollIntoView({ behavior: "smooth", block: "center" })
		flash(el)
	}
	const flash = (el: Element | null | undefined) => {
		if (!el) return
		el.classList.remove("lit")
		void (el as HTMLElement).offsetWidth
		el.classList.add("lit")
	}

	return (
		<div
			class="nb"
			ref={(root) => {
				root.addEventListener("ermine:change", (e) => {
					const t = e.target as Element
					if (t.matches?.(".stat")) flash(t.closest("[data-cell]"))
					relayout()
				})
				new ResizeObserver(relayout).observe(root)
				new MutationObserver(relayout).observe(root, {
					childList: true,
					subtree: true,
					characterData: true,
				})
			}}
		>
			<style>{CSS}</style>
			<header>
				<b>notebook</b>
				<span>fetches: {bind("/nb/fetches")}</span>
				<span class="add">
					add first:
					{KINDS.map((k) => <button onClick={handler("on/add", [null, k])}>{k}</button>)}
				</span>
				<span hidden>
					{bind("edges", (e) => {
						edges = e
						relayout()
						return ""
					})}
				</span>
			</header>
			<div class="page">
				<div class="rail" ref={(el) => (rail = el)}></div>
				<div class="cells">
					{bind(order, (list: string[]) => list.map((id) => card(id, go)))}
				</div>
			</div>
		</div>
	)
}

const KINDS: Kind[] = ["code", "md", "slider", "input", "chart"]

function card(id: string, go: (id: string) => void) {
	return (
		<section
			class="cell"
			key={id}
			data-cell={id}
			data-ctype={bind(R(id), (c: Cell) => c.ctype ?? "")}
		>
			{bind(R(id), (c: Cell) => (
				<div class="head">
					<span class="kind">{c.kind}</span>
					<input
						class="name"
						value={c.name}
						onChange={handler("on/rename", (e) => [id, e.target.value])}
					/>
					<span class="stat">{bind(`c-${id}/v`, (o: Out) => status(o))}</span>
					<span class="tools">
						<button title="up" onClick={handler("on/move", [id, -1])}>↑</button>
						<button title="down" onClick={handler("on/move", [id, 1])}>↓</button>
						<button title="fold" onClick={handler("on/set", [id, "folded", !c.folded])}>
							{c.folded ? "▸" : "▾"}
						</button>
						<button title="empty this cell's cache" onClick={handler("on/clear", [id])}>
							⌫
						</button>
						<button title="remove" onClick={handler("on/remove", [id])}>×</button>
					</span>
				</div>
			))}
			{bind(R(id), (c: Cell) => editor(id, c))}
			<div class="out">{bind(`c-${id}/v`, (o: Out) => output(o))}</div>
			<div class="chips">
				{bind("edges", (e: Record<string, string[]>) => chips(id, e, go))}
			</div>
			<div class="add">
				{KINDS.map((k) => <button onClick={handler("on/add", [id, k])}>+{k}</button>)}
			</div>
		</section>
	)
}

function status(o: Out) {
	return `${o.runs} run${o.runs === 1 ? "" : "s"}${o.hits ? ` · ${o.hits} cached` : ""} · ${
		o.error !== undefined ? "failed: " + o.error : o.cached ? "cached" : "ran"
	}`
}

function chips(id: string, e: Record<string, string[]>, go: (id: string) => void) {
	const reads = e[id] ?? []
	const by = Object.keys(e).filter((x) => e[x].includes(id))
	const chip = (x: string) => (
		<button class="chip" onClick={() => go(x)}>
			{bind(R(x), (c: Cell) => c.name)}
		</button>
	)
	return (
		<span>
			{reads.length > 0 && <span class="lab">reads</span>}
			{reads.map(chip)}
			{by.length > 0 && <span class="lab">read by</span>}
			{by.map(chip)}
		</span>
	)
}

function editor(id: string, c: Cell) {
	if (c.kind === "slider") {
		return (
			<div class="ed">
				<input
					type="range"
					min={c.min}
					max={c.max}
					step={c.step}
					value={String(c.value)}
					onInput={handler("on/set", (e) => [id, "value", Number(e.target.value)])}
				/>
				<b>{String(c.value)}</b>
				<small>{c.min}–{c.max}</small>
			</div>
		)
	}
	if (c.kind === "input") {
		return (
			<div class="ed">
				<input
					value={String(c.value ?? "")}
					onChange={handler("on/set", (e) => [id, "value", e.target.value])}
				/>
			</div>
		)
	}
	if (c.kind === "chart") {
		return (
			<div class="ed">
				<span class="lab">draws</span>
				<input
					value={c.src ?? ""}
					onChange={handler("on/set", (e) => [id, "src", e.target.value])}
				/>
				{["line", "area", "bars", "dots"].map((t) => (
					<button
						class={c.ctype === t ? "on" : ""}
						onClick={handler("on/set", [id, "ctype", t])}
					>
						{t}
					</button>
				))}
			</div>
		)
	}
	if (c.folded) return <div class="ed folded" />
	return (
		<textarea
			class="src"
			spellcheck={false}
			rows={Math.min(12, (c.src ?? "").split("\n").length + 1)}
			value={c.src ?? ""}
			onChange={handler("on/set", (e) => [id, "src", e.target.value])}
			onKeyDown={(e: KeyboardEvent) => {
				if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
					e.preventDefault()
					;(e.target as HTMLElement).blur()
				}
			}}
		/>
	)
}

// ---- output ----
const esc = (s: string) =>
	s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
function markdown(text: string) {
	const inline = (s: string) =>
		esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(
			/`(.+?)`/g,
			"<code>$1</code>",
		)
	const html: string[] = []
	let para: string[] = []
	const flush = () => {
		if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`)
		para = []
	}
	for (const line of text.split("\n")) {
		const h = /^(#{1,3}) (.*)$/.exec(line)
		if (h) {
			flush()
			html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
		} else if (!line.trim()) flush()
		else para.push(line)
	}
	flush()
	return html.join("")
}
function show(v: unknown): string {
	if (typeof v === "number") return String(Math.round(v * 1000) / 1000)
	if (typeof v === "string") return v
	if (v === undefined) return "undefined"
	const s = json(v)
	return s.length > 220 ? s.slice(0, 220) + "…" : s
}
function output(o: Out) {
	if (o.error !== undefined) return <div class="err">{o.error}</div>
	if (o.kind === "md") {
		return <div class="md" innerHTML={markdown(String(o.value ?? ""))} />
	}
	if (o.kind === "chart") {
		const data = points(o.value)
		return (
			<div class="charts">
				{["line", "area", "bars", "dots"].map((t) => (
					<div class={`chart ${t}`} innerHTML={chartSvg(data, t)} />
				))}
			</div>
		)
	}
	if (o.kind === "slider" || o.kind === "input") return ""
	return <pre class="val">{show(o.value)}</pre>
}

// ---- charts: a list of numbers, [x, y] pairs, or { label: number } ----
type Pt = { x: number; y: number; label?: string }
function points(v: unknown): Pt[] {
	if (Array.isArray(v)) {
		return v.map((p, i) =>
			Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]) } : { x: i, y: Number(p) }
		).filter((p) => isFinite(p.x) && isFinite(p.y))
	}
	if (v && typeof v === "object") {
		return Object.entries(v).map(([label, y], i) => ({ x: i, y: Number(y), label }))
	}
	return []
}
function chartSvg(d: Pt[], type: string) {
	const W = 560, H = 150, L = 34, B = 18, T = 8, Rr = 8
	if (!d.length) return `<svg viewBox="0 0 ${W} ${H}"><text x="10" y="20">no data</text></svg>`
	const xs = d.map((p) => p.x), ys = d.map((p) => p.y)
	const x0 = Math.min(...xs), x1 = Math.max(...xs)
	let y0 = Math.min(...ys, type === "bars" || type === "area" ? 0 : Infinity), y1 = Math.max(...ys)
	if (y0 === y1) y1 = y0 + 1
	const bars = type === "bars"
	const padX = bars ? (W - L - Rr) / d.length / 2 : 0
	const sx = (x: number) =>
		L + padX + (x1 === x0 ? 0 : (x - x0) / (x1 - x0)) * (W - L - Rr - 2 * padX)
	const sy = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B)
	const line = d.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(
		" ",
	)
	let body = ""
	if (type === "line") body = `<path d="${line}" fill="none" stroke="#111" stroke-width="1.6"/>`
	if (type === "area") {
		body = `<path d="${line} L${sx(x1)} ${sy(Math.max(0, y0))} L${sx(x0)} ${
			sy(Math.max(0, y0))
		} Z" fill="#ff9fca" stroke="#111" stroke-width="1.6"/>`
	}
	if (type === "dots") {
		body = d.map((p) =>
			`<circle cx="${sx(p.x).toFixed(1)}" cy="${
				sy(p.y).toFixed(1)
			}" r="3" fill="#ff5fa2" stroke="#111"/>`
		).join("")
	}
	if (bars) {
		const w = Math.max(3, (W - L - Rr) / d.length - 8)
		body = d.map((p) => {
			const top = sy(Math.max(p.y, 0)), base = sy(Math.max(0, y0))
			return `<rect x="${(sx(p.x) - w / 2).toFixed(1)}" y="${
				Math.min(top, base).toFixed(1)
			}" width="${w.toFixed(1)}" height="${
				Math.abs(base - top).toFixed(1)
			}" fill="#ff9fca" stroke="#111" stroke-width="1.4"/>`
		}).join("")
	}
	const labels = d.some((p) => p.label)
		? d.map((p) =>
			`<text x="${sx(p.x).toFixed(1)}" y="${H - 4}" text-anchor="middle">${
				esc(p.label ?? "")
			}</text>`
		).join("")
		: `<text x="${L}" y="${H - 4}">${x0}</text><text x="${W - Rr}" y="${
			H - 4
		}" text-anchor="end">${x1}</text>`
	return `<svg viewBox="0 0 ${W} ${H}" font-size="10" font-family="inherit">` +
		`<path d="M${L} ${T} V${H - B} H${W - Rr}" fill="none" stroke="#111"/>` +
		`<text x="${L - 4}" y="${T + 8}" text-anchor="end">${Math.round(y1 * 10) / 10}</text>` +
		`<text x="${L - 4}" y="${H - B}" text-anchor="end">${Math.round(y0 * 10) / 10}</text>` +
		body + labels + `</svg>`
}

// ---- the look: lemon paper, black lines, white cards with a pink glow ----
const CSS = `
.nb{--paper:#fff7a6;--ink:#111;--pink:#ff5fa2;font:13px/1.35 ui-monospace,Menlo,monospace;color:var(--ink);background:var(--paper);padding:8px 10px 40px;min-height:100vh;box-sizing:border-box}
.nb header{display:flex;gap:10px;align-items:center;border-bottom:1.5px solid var(--ink);padding-bottom:4px;margin-bottom:8px;flex-wrap:wrap}
.nb button{font:inherit;background:#fff;border:1.5px solid var(--ink);border-radius:4px;padding:0 5px;cursor:pointer;line-height:1.4}
.nb button:hover,.nb button.on{background:var(--pink);color:#fff}
.nb input,.nb textarea{font:inherit;border:1.5px solid var(--ink);border-radius:4px;background:#fff;color:var(--ink)}
.nb .page{position:relative;display:grid;grid-template-columns:64px minmax(0,720px);gap:0}
.nb .rail{position:relative}
.nb .rail svg{position:absolute;left:0;top:0;pointer-events:none}
.nb .cells{display:flex;flex-direction:column;gap:6px}
.nb .cell{background:#fff;border:1.5px solid var(--ink);border-radius:6px;padding:4px 6px;box-shadow:0 0 12px 1px rgba(255,95,162,.45);display:grid;gap:3px}
.nb .cell.lit{animation:lit 1s ease-out}
@keyframes lit{0%{background:var(--pink);box-shadow:0 0 24px 6px var(--pink)}100%{background:#fff}}
.nb .cell:has([data-ermine-waiting]){border-style:dashed;opacity:.8}
.nb .head{display:flex;gap:6px;align-items:center}
.nb .kind{font-size:10px;border:1.5px solid var(--ink);border-radius:8px;padding:0 5px;background:var(--paper)}
.nb .name{width:11ch;font-weight:bold;padding:0 3px}
.nb .stat{flex:1;font-size:11px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nb .stat[data-ermine-waiting]::after{content:" · waiting";font-weight:bold;color:#c0206a}
.nb .tools{display:flex;gap:2px}
.nb .src{width:100%;box-sizing:border-box;padding:3px;resize:vertical;background:#fffef0}
.nb .ed{display:flex;gap:6px;align-items:center}
.nb .ed input[type=range]{flex:1;accent-color:var(--pink);border:0}
.nb .ed input:not([type=range]){flex:1;padding:1px 4px}
.nb .out [data-ermine-waiting]{opacity:.45}
.nb .val{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}
.nb .err{color:#b0003a;background:#ffe3ee;border-radius:4px;padding:1px 4px}
.nb .md,.nb .md *{font-weight:normal}
.nb .md b{font-weight:bold}
.nb .md h1,.nb .md h2,.nb .md h3{font-weight:bold}
.nb .md h1,.nb .md h2,.nb .md h3{margin:2px 0;font-size:15px}
.nb .md p{margin:2px 0}
.nb .md code{background:var(--paper);padding:0 3px}
.nb .cell[data-ctype=line] .chart:not(.line),.nb .cell[data-ctype=area] .chart:not(.area),.nb .cell[data-ctype=bars] .chart:not(.bars),.nb .cell[data-ctype=dots] .chart:not(.dots){display:none}
.nb .chips{display:flex;font-size:11px;gap:4px;flex-wrap:wrap}
.nb .chips span{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap}
.nb .chips:empty{display:none}
.nb .chip{background:var(--paper);border-radius:9px}
.nb .lab{opacity:.6}
.nb .add{display:flex;gap:2px;font-size:11px;opacity:.5}
.nb .cell:hover .add{opacity:1}
.nb .add button{font-size:10px}
`
