/** @jsxImportSource ermine-h */
import {
	createAction,
	createMemo,
	ensureNode,
	getStatus,
	hasNode,
	patch,
	patchAttributes,
	peep,
	PENDING,
	read,
	readAttributes,
	remove,
	rename,
} from "@ermine/system"
import { bind, handler } from "ermine-h"

// program.ts: a reactive notebook, on the process api alone.
//   the cells live at /nb (seeded by host.ts): /nb/order is the list [{ name, kind }], /nb/cells/<name>
//   a cell's source; its look (fold, chart type) is on that node's attributes.
//   ":cells" is a memo that reads the order and makes, for each cell, two memos: <name> (the cell's
//   value) and <name>:view (what the page shows of it). a move or an add runs ":cells" again, which
//   makes them again with the same source: those do not run (rule 2), only the new ones do.
//   cell("x") is read("x"): the cell's memo. so a change reruns exactly the readers, the arrows are
//   the names the runs called, and a cell with a slow promise is a pending memo.
//   the cache is the program's own (a Map): the same code, reading the same values, is not run again.
//   the Maps are module state: a program.ts edit starts them empty (the cells stay, they are nodes)

type Kind = "code" | "markdown" | "slider" | "text" | "chart"
type Entry = { name: string; kind: Kind }
type Spec = {
	kind: Kind
	code?: string
	min?: number
	max?: number
	step?: number
	value?: unknown
	of?: string
	bust?: number
}
type Edge = [from: string, to: string, exists: boolean]

// ---------------------------------------------------------------- small helpers
const json = (v: unknown) => {
	try {
		return String(JSON.stringify(v))
	} catch {
		return String(v)
	}
}
const same = (a: unknown, b: unknown) => json(a) === json(b)
const num = (v: number) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(3)))
function fmt(v: unknown, max = 700): string {
	if (v === undefined) return "undefined"
	if (typeof v === "number") return num(v)
	if (typeof v === "string") return v
	let s: string
	try {
		s = JSON.stringify(v, (_, x) => (typeof x === "number" ? +x.toFixed(3) : x))
	} catch {
		s = String(v)
	}
	return s.length > max ? s.slice(0, max) + `… (${s.length} chars)` : s
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const specAt = (name: string) => "/nb/cells/" + name
const NAME = /^[A-Za-z_]\w*$/
const NOCACHE = /^\s*\/\/\s*nocache\b/m
const MISSING = Symbol("missing")

// ---------------------------------------------------------------- the fake fetch
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
// two seconds, then made-up temperatures: a base for the city, a slow wave, and a little noise
const fakeFetch = (what: string, arg: unknown) =>
	new Promise<Record<string, number>>((done, fail) =>
		setTimeout(() => {
			if (what !== "weather") return fail(new Error(`fetch: nothing at "${what}"`))
			const base = 4 + (hash(String(arg)) % 20)
			done(
				Object.fromEntries(
					DAYS.map((
						d,
						i,
					) => [d, +(base + 4 * Math.sin(i * 0.9) + Math.random() * 2).toFixed(1)]),
				),
			)
		}, 2000)
	)

// ---------------------------------------------------------------- compiling a cell's code
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
type Cell = (name: string) => unknown
type Compiled = (cell: Cell, fetch: typeof fakeFetch) => unknown
const compiled = new Map<string, Compiled>()
// an expression, or else a body that returns; async when it says await
function compile(code: string): Compiled {
	let f = compiled.get(code)
	if (f) return f
	const Fn = /\bawait\b/.test(code) ? AsyncFunction : Function
	try {
		f = new Fn("cell", "fetch", `return (\n${code}\n)`)
	} catch {
		f = new Fn("cell", "fetch", code)
	}
	compiled.set(code, f!)
	return f!
}

// ---------------------------------------------------------------- reading cells, caching
// a cell's value, tracked. a name with no cell: read throws PENDING and the read is tracked, so the
// cell's coming reruns this (the view says "no cell named"). catching that PENDING and ending any
// other way hangs the scheduler when the node then goes: see the report
function readCell(n: string): unknown {
	return stale(n)
}
// a memo that has a value and is running again gives that value (read does not throw): a reader
// would not wait for it. getStatus says so, tracked, and the reader waits
function stale(n: string): unknown {
	if (!hasNode(n)) return read(n)
	const st = getStatus(n)
	if (st?.state === "pending") throw PENDING
	// a failed memo still gives its last value, and a reader would use it
	if (st?.state === "failed" || st?.state === "looping") throw st.error
	return read(n)
}
const peekCell = (n: string) => (hasNode(n) ? stale(n) : MISSING)

type Cached = { deps: [string, string][]; value: unknown }
const caches = new Map<string, Map<string, Cached[]>>()
// what a cell last did: how many times its code ran, whether the last run was a cache hit
const stats = new Map<string, { evals: number; hit: boolean }>()
const stat = (name: string) => {
	let s = stats.get(name)
	if (!s) stats.set(name, s = { evals: 0, hit: false })
	return s
}
// the names a cell's last run called: the arrows
const called = new Map<string, string[]>()
const forget = (name: string) => {
	caches.delete(name)
	stats.delete(name)
	called.delete(name)
}
const cacheSize = (name: string) => {
	let n = 0
	for (const es of caches.get(name)?.values() ?? []) n += es.length
	return n
}

// run evaluate(cell) unless the same key, reading the same values, was run before. every call to
// cell() is recorded (name and the value it gave): that is the cache key, and the arrows.
// a read after an await cannot be tracked (the process api throws nothing-open there), so for async
// code the names it mentions are read first, here, and cell() after an await answers from those
function cached(
	name: string,
	key: string,
	src: string,
	nocache: boolean,
	evaluate: (cell: Cell) => unknown,
): unknown {
	const s = stat(name)
	let byKey = caches.get(name)
	if (!byKey) caches.set(name, byKey = new Map())
	const entries = byKey.get(key) ?? []
	if (!nocache) {
		for (const e of entries) {
			const ok = e.deps.every(([dep, was]) => {
				const v = peekCell(dep)
				return v !== MISSING && json(v) === was
			})
			if (ok) {
				s.hit = true
				called.set(name, e.deps.map((d) => d[0]))
				return e.value
			}
		}
	}
	s.hit = false
	s.evals++
	const mine = new Map<string, string>()
	const snap = new Map<string, unknown>()
	let live = true, waiting = false, waitingDone = false, bad = false
	try {
		if (/\bawait\b/.test(src)) {
			const names = new Set(called.get(name) ?? [])
			for (const m of src.matchAll(/cell\(\s*(["'`])([A-Za-z_]\w*)\1\s*\)/g)) names.add(m[2])
			for (const n of names) {
				const v = peekCell(n)
				if (v !== MISSING) snap.set(n, v)
			}
		}
		const cell: Cell = (n) => {
			let v: unknown
			if (live) {
				try {
					v = readCell(n)
				} catch (e) {
					mine.set(n, "")
					bad = true
					if (e === PENDING) waiting = true
					throw e
				}
			} else {
				if (!snap.has(n)) {
					throw new Error(
						`cell("${n}") was read after an await, and not before it: it cannot be tracked there`,
					)
				}
				v = snap.get(n)
			}
			mine.set(n, json(v))
			return v
		}
		let out: unknown
		try {
			out = evaluate(cell)
		} finally {
			live = false
			called.set(name, [...mine.keys()])
		}
		if (out && typeof (out as Promise<unknown>).then === "function") {
			// an async function turns a PENDING thrown before its first await into a rejection: the
			// memo needs it thrown, here
			if (waiting) {
				;(out as Promise<unknown>).then(undefined, () => {})
				s.evals--
				waitingDone = true
				throw PENDING
			}
			return (out as Promise<unknown>).then((value) => {
				called.set(name, [...mine.keys()])
				if (bad) return value
				const list = byKey!.get(key) ?? []
				list.unshift({ deps: [...mine], value })
				byKey!.set(key, list.slice(0, 20))
				return value
			})
		}
		if (!nocache && !bad) {
			const list = byKey.get(key) ?? []
			list.unshift({ deps: [...mine], value: out })
			byKey.set(key, list.slice(0, 20))
		}
		return out
	} catch (e) {
		// waiting on a cell is not a run of this code
		if (e === PENDING && !waitingDone) s.evals--
		throw e
	}
}

// ---------------------------------------------------------------- the kinds
// markdown: the text with each ${expression} run as a cell expression
function markdown(src: string, cell: Cell): string {
	let out = "", i = 0
	while (i < src.length) {
		const at = src.indexOf("${", i)
		if (at < 0) break
		out += src.slice(i, at)
		let depth = 1, j = at + 2
		for (; j < src.length && depth > 0; j++) {
			if (src[j] === "{") depth++
			else if (src[j] === "}") depth--
		}
		const expr = src.slice(at + 2, j - 1)
		try {
			const v = compile(expr)(cell, fakeFetch)
			if (v && typeof (v as Promise<unknown>).then === "function") {
				throw new Error("a hole cannot await")
			}
			out += fmt(v, 120)
		} catch (e) {
			if (e === PENDING) throw e
			out += `⟦${message(e)}⟧`
		}
		i = j
	}
	return out + src.slice(i)
}

// a chart's data: a list of numbers, [x, y] pairs, or { label: number }
type Series = { xs: number[]; ys: number[]; labels?: string[] }
function series(v: unknown): Series {
	if (Array.isArray(v) && v.every((y) => typeof y === "number")) {
		return { xs: v.map((_, i) => i), ys: v as number[] }
	}
	if (
		Array.isArray(v) &&
		v.every((p) => Array.isArray(p) && p.length === 2 && p.every((q) => typeof q === "number"))
	) {
		return { xs: v.map((p) => p[0]), ys: v.map((p) => p[1]) }
	}
	if (
		v && typeof v === "object" && !Array.isArray(v) &&
		Object.values(v).every((y) => typeof y === "number")
	) {
		const labels = Object.keys(v)
		return { xs: labels.map((_, i) => i), ys: Object.values(v) as number[], labels }
	}
	throw new Error("a chart takes a list of numbers, [x, y] pairs, or { label: number }")
}

const W = 560, H = 150, L = 34, R = 10, T = 10, B = 22
function svgOf(d: Series, type: string): string {
	const n = d.ys.length
	if (n === 0) {
		return `<svg viewBox="0 0 ${W} ${H}"><text x="${L}" y="40">nothing to draw</text></svg>`
	}
	const bars = type === "bars" || type === "area"
	let lo = Math.min(...d.ys), hi = Math.max(...d.ys)
	if (bars) {
		lo = Math.min(lo, 0)
		hi = Math.max(hi, 0)
	}
	if (hi === lo) hi = lo + 1
	let x0 = Math.min(...d.xs), x1 = Math.max(...d.xs)
	if (x1 === x0) x1 = x0 + 1
	const pad = type === "bars" ? ((x1 - x0) / Math.max(n - 1, 1)) / 2 + 0 : 0
	x0 -= pad
	x1 += pad
	const X = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - R)
	const Y = (y: number) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B)
	const pts = d.xs.map((x, i) => [X(x), Y(d.ys[i])] as const)
	const base = Y(Math.max(lo, Math.min(0, hi)))
	let body = ""
	if (type === "bars") {
		const w = Math.max(2, ((W - L - R) / n) * 0.7)
		body = pts.map(([x, y]) =>
			`<rect x="${(x - w / 2).toFixed(1)}" y="${Math.min(y, base).toFixed(1)}" width="${
				w.toFixed(1)
			}" height="${Math.abs(base - y).toFixed(1)}" fill="#ff7ab8" stroke="#000"/>`
		).join("")
	} else if (type === "dots") {
		body = pts.map(([x, y]) =>
			`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#ff7ab8" stroke="#000"/>`
		).join("")
	} else {
		const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(
			"",
		)
		if (type === "area") {
			body = `<path d="${line}L${pts[n - 1][0].toFixed(1)} ${base.toFixed(1)}L${
				pts[0][0].toFixed(1)
			} ${base.toFixed(1)}Z" fill="#ff7ab888"/>`
		}
		body += `<path d="${line}" fill="none" stroke="#000" stroke-width="1.4"/>`
	}
	const t = (x: number, y: number, s: string, a = "end") =>
		`<text x="${x}" y="${y}" text-anchor="${a}" font-size="10">${esc(s)}</text>`
	let axes = `<path d="M${L} ${T}V${H - B}H${W - R}" fill="none" stroke="#000"/>` +
		t(L - 4, T + 8, num(hi)) + t(L - 4, H - B, num(lo))
	if (d.labels) {
		axes += d.labels.map((s, i) => t(pts[i][0], H - 8, s, "middle")).join("")
	} else axes += t(L, H - 8, num(x0), "start") + t(W - R, H - 8, num(x1), "end")
	return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${axes}${body}</svg>`
}

// a tiny markdown: # headings, - lists, paragraphs, **bold**, *italic*, `code`
function html(md: string): string {
	const inline = (s: string) =>
		esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
			.replace(/\*([^*]+)\*/g, "<i>$1</i>")
	const out: string[] = []
	let para: string[] = [], list: string[] = []
	const flush = () => {
		if (para.length) out.push(`<p>${para.map(inline).join(" ")}</p>`)
		if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`)
		para = []
		list = []
	}
	for (const line of md.split("\n")) {
		const h = /^(#{1,3})\s+(.*)$/.exec(line)
		if (h) {
			flush()
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
		} else if (/^\s*[-*]\s+/.test(line)) {
			if (para.length) flush()
			list.push(line.replace(/^\s*[-*]\s+/, ""))
		} else if (line.trim() === "") flush()
		else {
			if (list.length) flush()
			para.push(line.trim())
		}
	}
	flush()
	return out.join("")
}

// ---------------------------------------------------------------- one cell's run, one cell's view
function runCell(name: string): unknown {
	const spec = read(specAt(name)) as Spec | undefined
	if (!spec) throw new Error(`no source for "${name}"`)
	const s = stat(name)
	switch (spec.kind) {
		case "slider":
		case "text":
			s.evals++
			s.hit = false
			called.set(name, [])
			return spec.value
		case "code": {
			const code = spec.code ?? ""
			return cached(
				name,
				code,
				code,
				NOCACHE.test(code),
				(cell) => compile(code)(cell, fakeFetch),
			)
		}
		case "markdown": {
			const code = spec.code ?? ""
			return cached(name, code, code, false, (cell) => markdown(code, cell))
		}
		case "chart": {
			const of = spec.of ?? ""
			return cached(name, of, `cell("${of}")`, false, (cell) => series(cell(of)))
		}
	}
	throw new Error(`a cell of kind ${spec.kind}`)
}

type View = {
	kind: Kind
	state: "ran" | "failed" | "waiting"
	n: number
	evals: number
	hit: boolean
	cache: number
	error?: string
	waiting: string[]
	reads: [string, boolean][]
	readers: string[]
	fold: boolean
	chart: string
	text: string
	html: string
	svg: string
}
const lastOf = (p: readonly string[] | null) => (p && p.length ? p[p.length - 1] : "?")

function viewOf(name: string): View {
	const g = read(":graph") as { edges: Edge[] }
	const spec = read(specAt(name)) as Spec | undefined
	const attrs = (readAttributes(specAt(name)) ?? {}) as { fold?: boolean; chart?: string }
	const st = getStatus(name)
	const v: View = {
		kind: spec?.kind ?? "code",
		state: "ran",
		n: st?.n ?? 0,
		evals: 0,
		hit: false,
		cache: 0,
		waiting: [],
		reads: g.edges.filter((e) => e[1] === name).map((e) => [e[0], e[2]]),
		readers: g.edges.filter((e) => e[0] === name).map((e) => e[1]),
		fold: !!attrs.fold,
		chart: attrs.chart ?? "line",
		text: "",
		html: "",
		svg: "",
	}
	// (the counts are the program's Maps: read after the status, which changes as a run ends)
	const s = stat(name)
	v.evals = s.evals
	v.hit = s.hit
	v.cache = cacheSize(name)
	if (!st || st.state === "pending") {
		v.state = "waiting"
		const gone = v.reads.filter((r) => !r[1]).map((r) => r[0])
		if (gone.length) v.error = gone.map((m) => `no cell named "${m}"`).join("; ")
		v.waiting = (st?.waiting ?? []).map((w) =>
			typeof w === "string" ? w : "node" in w ? lastOf(w.node) : "?"
		)
		return v
	}
	if (st.state !== "done") {
		v.state = "failed"
		v.error = message(st.error)
		return v
	}
	let value: unknown
	try {
		value = read(name)
	} catch (e) {
		if (e === PENDING) v.state = "waiting"
		else {
			v.state = "failed"
			v.error = message(e)
		}
		return v
	}
	if (v.kind === "markdown") v.html = html(String(value ?? ""))
	else if (v.kind === "chart") {
		try {
			v.svg = svgOf(value as Series, v.chart)
		} catch (e) {
			v.state = "failed"
			v.error = message(e)
		}
	} else if (v.kind === "code") v.text = fmt(value)
	return v
}

// ---------------------------------------------------------------- the page
const LOOK = `
body { background: #ffff88; margin: 8px; font-family: Jost, system-ui, sans-serif; font-size: 13px; color: #000 }
.nb { max-width: 900px; margin: 0 auto }
.top { display: flex; gap: 8px; align-items: baseline; margin: 0 0 6px 76px }
.top b { font-size: 15px }
.top .note { color: #ff2284 }
.page { display: grid; grid-template-columns: 76px 1fr; align-items: start }
.rail { position: relative; align-self: stretch }
.rail svg { position: absolute; left: 0; top: 0; overflow: visible }
.cells { position: relative; display: flex; flex-direction: column; gap: 6px }
.cell { background: #fff; border: 1px solid #000; border-radius: 6px; box-shadow: 0 0 10px 2px #66003322;
	padding: 4px 6px; position: relative }
.cell.flash { animation: flash 900ms ease-out }
.cell.hot { outline: 2px solid #ff2284 }
@keyframes flash { from { box-shadow: 0 0 14px 6px #ff2284cc; background: #ffe3f1 } to { box-shadow: 0 0 10px 2px #66003322; background: #fff } }
.head { display: flex; gap: 4px; align-items: center; flex-wrap: wrap }
.head input.name { width: 92px; font: 600 13px ui-monospace, Menlo, monospace; border: 1px solid transparent; padding: 0 3px; background: transparent }
.head input.name:hover, .head input.name:focus { border-color: #000; background: #fff }
.kind { font-size: 11px; background: #ffff88; border: 1px solid #000; border-radius: 8px; padding: 0 5px }
.state { font-size: 11px; border-radius: 8px; padding: 0 6px; border: 1px solid #000 }
.state[data-state=ran] { background: #c8f6ea }
.state[data-state=failed] { background: #ffd9ea; color: #c00060 }
.state[data-state=waiting] { background: repeating-linear-gradient(45deg, #fff, #fff 5px, #ffe3f1 5px, #ffe3f1 10px) }
.count { font-size: 11px; color: #444 }
.spacer { flex: 1 }
button, select { font: inherit; font-size: 12px; border: 1px solid #000; background: #fff; border-radius: 4px; padding: 0 5px; cursor: pointer; height: 20px }
button:hover { background: #ffe3f1 }
.chips { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; min-height: 0 }
.chips:empty { display: none }
.chips .lbl { font-size: 10px; color: #666; margin-left: 4px }
.chip { height: 17px; font: 11px ui-monospace, Menlo, monospace; border-radius: 9px; padding: 0 6px }
.chip.none { border-style: dashed; color: #c00060 }
.chip.out { background: #ffe3f1 }
.body { margin-top: 3px }
textarea { width: 100%; box-sizing: border-box; font: 12px/1.35 ui-monospace, Menlo, monospace; border: 1px solid #000; border-radius: 4px; padding: 3px 5px; resize: vertical; background: #fffffa }
.cell[data-fold="1"] textarea, .cell[data-fold="1"] .setup { display: none }
.out { margin: 3px 0 0; padding: 2px 6px; background: #ffff8844; border-left: 3px solid #000; font: 12px ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; max-height: 7em; overflow: auto }
.out:empty { display: none }
.err { color: #c00060; font: 12px ui-monospace, Menlo, monospace; margin-top: 3px }
.err:empty { display: none }
.body[data-state=waiting] .out, .body[data-state=waiting] .chart, .body[data-state=waiting] .md { opacity: .35 }
.md h1 { font-size: 17px; margin: 2px 0 } .md h2 { font-size: 15px; margin: 2px 0 } .md p { margin: 3px 0 } .md ul { margin: 2px 0; padding-left: 18px } .md code { background: #ffff88; padding: 0 3px }
.chart svg { width: 100%; height: auto; display: block; max-height: 190px }
.chart text { font-family: ui-monospace, Menlo, monospace }
.slider { display: flex; gap: 6px; align-items: center }
.slider input[type=range] { flex: 1; accent-color: #ff2284 }
.slider output { font: 600 13px ui-monospace, Menlo, monospace; min-width: 3em; text-align: right }
.setup { display: flex; gap: 6px; align-items: center; font-size: 11px; color: #555 }
.setup input { width: 5em; font: 11px ui-monospace, Menlo, monospace; border: 1px solid #000; border-radius: 3px }
input.text { width: 100%; box-sizing: border-box; font: 13px ui-monospace, Menlo, monospace; border: 1px solid #000; border-radius: 4px; padding: 2px 5px }
.cell h1 { margin: 0 }
`

const KINDS: Kind[] = ["code", "markdown", "slider", "text", "chart"]
const DEFAULTS: Record<Kind, () => Spec> = {
	code: () => ({ kind: "code", code: "// an expression, or a body that returns\n1 + 1" }),
	markdown: () => ({ kind: "markdown", code: 'text, with a hole: ${cell("n")}' }),
	slider: () => ({ kind: "slider", min: 0, max: 10, step: 1, value: 5 }),
	text: () => ({ kind: "text", value: "" }),
	chart: () => ({ kind: "chart", of: "wave" }),
}

const goto = (name: string) => {
	const el = document.querySelector(`[data-cell="${name}"]`)
	if (!el) return
	el.scrollIntoView({ block: "center", behavior: "smooth" })
	el.classList.remove("hot")
	void (el as HTMLElement).offsetWidth
	el.classList.add("hot")
	setTimeout(() => el.classList.remove("hot"), 1400)
}

const statText = (v: View) =>
	v.state === "ran"
		? v.hit ? "ran (cached)" : "ran"
		: v.state === "failed"
		? "failed"
		: v.waiting.length
		? "waiting for " + v.waiting.join(", ")
		: "waiting"
const countText = (v: View) =>
	`run ${v.n}×` + (v.kind === "slider" || v.kind === "text" ? "" : ` · code ${v.evals}×`) +
	(v.cache ? ` · cache ${v.cache}` : "")

function chips(v: View) {
	const out: unknown[] = []
	if (v.reads.length) {
		out.push(<span class="lbl" key="l1">reads</span>)
		for (const [n, exists] of v.reads) {
			out.push(
				<button
					key={"r" + n}
					class={exists ? "chip" : "chip none"}
					title={exists ? "go to " + n : "no cell named " + n}
					onClick={() => goto(n)}
				>
					{exists ? n : n + " (none)"}
				</button>,
			)
		}
	}
	if (v.readers.length) {
		out.push(<span class="lbl" key="l2">read by</span>)
		for (const n of v.readers) {
			out.push(
				<button key={"o" + n} class="chip out" title={"go to " + n} onClick={() => goto(n)}>
					{n}
				</button>,
			)
		}
	}
	return out
}

function cellView(name: string, kind: Kind) {
	const spec = specAt(name)
	const view = name + ":view"
	const commit = (field: string) => handler("on/field", (e: any) => [name, field, e.target.value])
	const source = (
		<textarea
			spellcheck={false}
			rows={bind(spec, (s: Spec) => Math.max(2, (s.code ?? "").split("\n").length))}
			value={bind(spec, (s: Spec) => s.code ?? "")}
			onChange={commit("code")}
			onKeyDown={(e: KeyboardEvent) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLElement).blur()
			}}
		/>
	)
	const err = <div class="err">{bind(view, (v: View) => v.error ?? "")}</div>
	let body: unknown
	if (kind === "code") {
		body = [source, <pre class="out">{bind(view, (v: View) => v.text)}</pre>, err]
	} else if (kind === "markdown") {
		body = [source, <div class="md" innerHTML={bind(view, (v: View) => v.html)} />, err]
	} else if (kind === "slider") {
		body = (
			<div>
				<div class="slider">
					<input
						type="range"
						min={bind(spec, (s: Spec) => s.min)}
						max={bind(spec, (s: Spec) => s.max)}
						step={bind(spec, (s: Spec) => s.step)}
						value={bind(spec, (s: Spec) => s.value)}
						onInput={handler("on/set", (e: any) => [name, +e.target.value])}
					/>
					<output>{bind(spec, (s: Spec) => num(Number(s.value)))}</output>
				</div>
				<div class="setup">
					min
					<input
						type="number"
						value={bind(spec, (s: Spec) => s.min)}
						onChange={handler("on/field", (e: any) => [name, "min", +e.target.value])}
					/>
					max
					<input
						type="number"
						value={bind(spec, (s: Spec) => s.max)}
						onChange={handler("on/field", (e: any) => [name, "max", +e.target.value])}
					/>
					step
					<input
						type="number"
						value={bind(spec, (s: Spec) => s.step)}
						onChange={handler("on/field", (e: any) => [name, "step", +e.target.value])}
					/>
				</div>
				{err}
			</div>
		)
	} else if (kind === "text") {
		body = [
			<input
				class="text"
				spellcheck={false}
				value={bind(spec, (s: Spec) => String(s.value ?? ""))}
				onChange={handler("on/set", (e: any) => [name, e.target.value])}
			/>,
			err,
		]
	} else {
		body = [
			<div class="setup">
				draws
				<input
					style={{ width: "9em" }}
					value={bind(spec, (s: Spec) => s.of ?? "")}
					onChange={commit("of")}
				/>
				as
				{["line", "area", "bars", "dots"].map((t) => (
					<button
						key={t}
						style={{ opacity: "1" }}
						class={bind(view, (v: View) => (v.chart === t ? "on" : ""))}
						onClick={handler("on/chart", [name, t])}
					>
						{bind(view, (v: View) => (v.chart === t ? "● " + t : t))}
					</button>
				))}
			</div>,
			<div class="chart" innerHTML={bind(view, (v: View) => v.svg)} />,
			err,
		]
	}
	return (
		<section
			class="cell"
			key={name}
			data-cell={name}
			data-kind={kind}
			data-fold={bind(view, (v: View) => (v.fold ? "1" : "0"))}
		>
			<div class="head">
				<input
					class="name"
					value={name}
					spellcheck={false}
					title="rename"
					onChange={handler("on/rename", (e: any) => [name, e.target.value.trim()])}
				/>
				<span class="kind">{kind}</span>
				<span class="state" data-state={bind(view, (v: View) => v.state)}>
					{bind(view, statText)}
				</span>
				<span class="count">{bind(view, countText)}</span>
				<span class="spacer" />
				<button title="move up" onClick={handler("on/up", [name])}>↑</button>
				<button title="move down" onClick={handler("on/down", [name])}>↓</button>
				<button title="fold the source" onClick={handler("on/fold", [name])}>
					{bind(view, (v: View) => (v.fold ? "▸" : "▾"))}
				</button>
				<button
					title="empty its cache and run it again"
					onClick={handler("on/refresh", [name])}
				>
					↻
				</button>
				<select
					title="add a cell after this one"
					onChange={handler("on/add", (e: any) => {
						const kind = e.target.value
						e.target.value = ""
						return kind ? [name, kind] : undefined
					})}
				>
					<option value="" selected>+ after</option>
					{KINDS.map((k) => <option value={k}>{k}</option>)}
				</select>
				<button title="remove" onClick={handler("on/remove", [name])}>×</button>
			</div>
			<div class="chips">{bind(view, chips)}</div>
			<div class="body" data-state={bind(view, (v: View) => v.state)}>{body}</div>
		</section>
	)
}

// the page's own script, on its root: the cells that ran light up (ermine-h tells a change on the
// bound count), and the rail draws an arrow from each cell to the cells that read it
function page(root: HTMLElement) {
	;(root as any).__off?.()
	const rail = root.querySelector(".rail") as HTMLElement
	const cells = root.querySelector(".cells") as HTMLElement
	let hot = ""
	let frame = 0
	const draw = () => {
		frame = 0
		const edges: Edge[] = JSON.parse(rail.getAttribute("data-edges") || "[]")
		const y = (n: string) => {
			const el = cells.querySelector(`[data-cell="${n}"]`) as HTMLElement | null
			return el ? el.offsetTop + 15 : undefined
		}
		const lanes = [...edges].sort((a, b) =>
			Math.abs((y(b[0]) ?? 0) - (y(b[1]) ?? 0)) - Math.abs((y(a[0]) ?? 0) - (y(a[1]) ?? 0))
		)
		let out =
			`<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="context-stroke"/></marker></defs>`
		lanes.forEach(([from, to, exists], i) => {
			const y2 = y(to)
			if (y2 === undefined) return
			const lit = hot && (hot === from || hot === to)
			const stroke = lit ? "#ff2284" : "#000"
			const w = lit ? 2 : 1.1
			const op = hot && !lit ? 0.25 : 0.85
			const xl = 66 - 7 * (i % 8)
			const y1 = y(from)
			if (y1 === undefined || !exists) {
				out += `<path d="M${
					xl + 10
				} ${y2}H72" fill="none" stroke="#c00060" stroke-dasharray="2 2" marker-end="url(#ar)"/>`
				return
			}
			out +=
				`<path d="M72 ${y1}H${xl}V${y2}H70" fill="none" stroke="${stroke}" stroke-width="${w}" opacity="${op}" marker-end="url(#ar)"/>`
		})
		rail.querySelector("svg")!.innerHTML = out
		const h = cells.offsetHeight
		rail.querySelector("svg")!.setAttribute("height", String(h))
		rail.querySelector("svg")!.setAttribute("width", "76")
	}
	const later = () => {
		if (!frame) frame = requestAnimationFrame(draw)
	}
	if (!rail.querySelector("svg")) {
		rail.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"))
	}
	const mo = new MutationObserver(later)
	// (not the rail's svg: drawing into it would draw again)
	mo.observe(rail, { attributes: true, attributeFilter: ["data-edges"] })
	mo.observe(cells, {
		subtree: true,
		childList: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["data-fold", "rows"],
	})
	const ro = new ResizeObserver(later)
	ro.observe(cells)
	const flash = (e: Event) => {
		const t = e.target as HTMLElement
		if (!t.classList?.contains("count")) return
		const c = t.closest(".cell")!
		c.classList.remove("flash")
		void (c as HTMLElement).offsetWidth
		c.classList.add("flash")
	}
	const over = (e: Event) => {
		const n = (e.target as HTMLElement).closest?.(".cell")?.getAttribute("data-cell") ?? ""
		if (n !== hot) {
			hot = n
			later()
		}
	}
	root.addEventListener("ermine:change", flash)
	root.addEventListener("mouseover", over)
	window.addEventListener("resize", later)
	;(root as any).__off = () => {
		mo.disconnect()
		ro.disconnect()
		root.removeEventListener("ermine:change", flash)
		root.removeEventListener("mouseover", over)
		window.removeEventListener("resize", later)
	}
	later()
}

// ---------------------------------------------------------------- the process
export default function program() {
	// the cells' memos. made inside ":cells" (its run), by bare names: a bare name is inside the process
	createMemo(":cells", () => {
		const order = read("/nb/order") as Entry[]
		for (const { name } of order) {
			createMemo(name, () => runCell(name), { equal: same })
			createMemo(name + ":view", () => viewOf(name), { equal: same })
		}
		return order.map((o) => o.name)
	})
	// who read whom: the names each cell's last run called. it reads every cell's status, which
	// changes as a run ends, and then the program's record of the calls
	createMemo(":graph", () => {
		const order = read("/nb/order") as Entry[]
		const names = new Set(order.map((o) => o.name))
		const edges: Edge[] = []
		for (const { name } of order) {
			getStatus(name)
			try {
				read(name)
			} catch { /* a cell that waits or failed: its status was the read */ }
			for (const from of called.get(name) ?? []) edges.push([from, name, names.has(from)])
		}
		return { edges }
	}, { equal: same })

	// ---- edits: all of them are patches to /nb
	const order = () => peep(() => read("/nb/order")) as Entry[]
	const setOrder = (o: Entry[]) => patch("/nb/order", [{ path: [], value: o }])
	const note = (text: string) => patch("/nb/note", [{ path: [], value: text }])
	const taken = (name: string) => order().some((o) => o.name === name)

	createAction("on/set", (name: string, value: unknown) => {
		patch(specAt(name), [{ path: ["value"], value }])
	})
	createAction("on/field", (name: string, field: string, value: unknown) => {
		patch(specAt(name), [{ path: [field], value }])
	})
	createAction("on/chart", (name: string, type: string) => {
		patchAttributes(specAt(name), [{ path: ["chart"], value: type }])
	})
	createAction("on/fold", (name: string) => {
		const now = peep(() => readAttributes(specAt(name))) as { fold?: boolean } | undefined
		patchAttributes(specAt(name), [{ path: ["fold"], value: !now?.fold }])
	})
	createAction("on/refresh", (name: string) => {
		caches.delete(name)
		const s = peep(() => read(specAt(name))) as Spec
		patch(specAt(name), [{ path: ["bust"], value: (s.bust ?? 0) + 1 }])
	})
	const swap = (name: string, by: number) => {
		const o = order(), i = o.findIndex((e) => e.name === name), j = i + by
		if (i < 0 || j < 0 || j >= o.length) return
		;[o[i], o[j]] = [o[j], o[i]]
		setOrder([...o])
	}
	createAction("on/up", (name: string) => swap(name, -1))
	createAction("on/down", (name: string) => swap(name, 1))
	createAction("on/add", (after: string, kind: Kind) => {
		const o = order()
		let i = 1
		while (taken(kind + i)) i++
		const name = kind + i
		const spec = DEFAULTS[kind]()
		if (kind === "chart") spec.of = after
		ensureNode(specAt(name), spec)
		const at = o.findIndex((e) => e.name === after)
		setOrder([...o.slice(0, at + 1), { name, kind }, ...o.slice(at + 1)])
	})
	createAction("on/remove", (name: string) => {
		setOrder(order().filter((o) => o.name !== name))
		remove(specAt(name))
		forget(name)
	})
	createAction("on/rename", (from: string, to: string) => {
		if (to === from) return note("")
		if (!NAME.test(to) || to === "on") return note(`"${to}" is not a name a cell can have`)
		if (taken(to)) return note(`there is already a cell named ${to}`)
		rename(specAt(from), specAt(to))
		setOrder(order().map((o) => (o.name === from ? { ...o, name: to } : o)))
		forget(from)
		note("")
	})

	return (
		<div class="nb" ref={page}>
			<style>{LOOK}</style>
			<div class="top">
				<b>notebook</b>
				<span>cells run when what they read changes. hover a cell: its arrows go pink</span>
				<span class="note">{bind("/nb/note")}</span>
			</div>
			<div class="page">
				<div
					class="rail"
					data-edges={bind(":graph", (g: { edges: Edge[] }) => JSON.stringify(g.edges))}
				/>
				<div class="cells">
					{bind("/nb/order", (o: Entry[]) => o.map(({ name, kind }) => cellView(name, kind)))}
				</div>
			</div>
		</div>
	)
}
