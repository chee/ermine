/** @jsxImportSource @ermine */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	hasNode,
	list,
	patch,
	peep,
	PENDING,
	place,
	read,
	readAttributes,
	ref,
	rename,
	unplace,
} from "@ermine/system"
import { host, up } from "@ermine/slaygrounds/tools"
import type { Found } from "@ermine/compilers"
import type { Extra } from "./host.ts"
import { bind, handler, track } from "@ermine/render/h"

// fancy-notebook: a reactive notebook. every cell is a node, ./cells/<id>, named by its own id,
// its source a node under it (src). their order is a list of ids in ./order. a cell's value is a
// node too, at ./values/<name>: a memo for code, markdown and charts, the widget's own node for a
// slider or an input. cell("n") reads /values/n, so the scheduler tracks it: editing a cell reruns
// exactly the cells that read it. the arrows on the left are those reads: each run's end is
// written to ./flow, and an effect draws the rail from it. edit a cell, drag a slider, type a
// city: watch only the dependents light up.
// every computed cell is a step of @ermine/compilers' builds (the host hands them out): its name the
// cell's id, its code its kind, source and chart type. its run reads the cells it uses, and each
// run kept is an entry in ./cache, its reads and what it gave; the same code reading the same
// values again is a hit, given back without running (a city typed twice fetches once). a line
// "// nocache" in a cell's code keeps it out of the cache (the clock, a random number)
// the cells' memos are made by one effect (running) as it runs, for each cell in the order: made
// again at each of its runs, so one whose cell was removed or renamed is gone after it

// ---- the first notebook (seeded once: a reload keeps what you changed) ----
const SEED: [kind: string, name: string, src: string, extra?: Record<string, unknown>][] = [
	[
		"md",
		"intro",
		"# A notebook of nodes\nEvery cell is a node, and so is its value. Drag a slider: only the cells " +
		"that read it run again. The arrows are each run's own reads, as the scheduler told them.",
	],
	["slider", "n", "{ min: 3, max: 80, step: 1 }", { start: 50 }],
	["slider", "wobble", "{ min: 0, max: 8, step: 0.5 }", { start: 2.5 }],
	[
		"code",
		"wave",
		'Array.from({ length: cell("n") }, (_, i) =>\n  Math.sin(i / 4) * 10 + Math.sin(i * 1.7) * cell("wobble"))',
	],
	["chart", "picture", 'cell("wave")', { type: "area" }],
	[
		"code",
		"stats",
		'const w = cell("wave")\nreturn {\n  min: Math.min(...w),\n  max: Math.max(...w),\n  mean: w.reduce((a, b) => a + b, 0) / w.length,\n}',
	],
	[
		"md",
		"summary",
		'The wave has **${cell("n")}** points and peaks at **${cell("stats").max.toFixed(1)}**.',
	],
	["input", "city", "", { start: "Lisbon" }],
	[
		"code",
		"weather",
		'// fetch here is a fake: 2s, then made-up weather\nconst city = cell("city")\nconst res = await fetch("/weather?city=" + city)\nreturn (await res.json()).temps',
	],
	["chart", "temps", 'cell("weather")', { type: "bars" }],
	[
		"code",
		"stamp",
		'// nocache: the clock is not a value it read\n`ran at ${new Date().toLocaleTimeString()}, n is ${cell("n")}`',
	],
]

// what a new cell starts as
const FRESH: Record<string, [prefix: string, src: string, extra?: Record<string, unknown>]> = {
	code: ["cell", "42"],
	md: ["note", 'Some *words*, and a value: **${cell("n")}**'],
	slider: ["slider", "{ min: 0, max: 100, step: 1 }", { start: 50 }],
	input: ["text", "", { start: "hello" }],
	chart: ["chart", "[3, 1, 4, 1, 5, 9, 2, 6, 5, 3]", { type: "line" }],
}
const ICON: Record<string, string> = { code: "ƒ", md: "¶", slider: "⇆", input: "✎", chart: "◿" }
const COMPUTED = new Set(["code", "md", "chart"])
const TYPES = ["line", "area", "bars", "dots"]
const COLORS = ["#ff2284", "#2269ff", "#14a888", "#000000", "#a23cf0"]

// a node's value now, from an action or inside a run (nothing tracked)
const get = <T,>(x: Parameters<typeof read>[0], key?: readonly (string | number)[]) =>
	peep(() => read(x, key)) as T
const put = (x: Parameters<typeof read>[0], value: unknown) => patch(x, [{ path: [], value }])

export default function program() {
	const { builds: makeBuilds } = host<Extra>()

	// the font link lives in the head: made once, kept (a reload would add a second)
	peep(() =>
		ref("./font", () =>
			document.head.appendChild(Object.assign(document.createElement("link"), {
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600;700&display=swap",
			})))
	)

	// ./cells/<id> is a cell (its record), ./cells/<id>/src its source; ./order the ids in order;
	// ./values/<name> a cell's value; ./flow what each cell's last run did; ./cache the builds'
	// steps. all under ./, so a reload finds them as they were
	const first = !hasNode("./order")
	const order = ensureNode("./order", [])
	ensureNode("./cells", {})
	ensureNode("./values", {})
	// the computed cells' memos, inside this process's own node (placed at ./values/<name> too)
	ensureNode("values", {})
	const flow = ensureNode("./flow", {})
	ensureNode("./cache", {})
	const builds = makeBuilds(["cache"])
	addTeardown(() => builds.stop())

	const ids = () => (read(order) ?? []) as string[]
	const at = (id: string) => `./cells/${id}`
	const nameOf = (id: string) => read(at(id), ["name"]) as string
	const names = () => ids().map(nameOf)

	// ---- cell(name): another cell's value, read by its path, so the run depends on it ----
	function cell(name: string) {
		touched?.add(String(name))
		const here = `/values/${name}`
		if (!hasNode(here)) throw new Error(`no cell is named ${name}`)
		// it waits (a fetch out): this one waits too, in place (read throws PENDING); it failed: so
		// does this one
		try {
			return read(here)
		} catch (e) {
			if (e === PENDING) throw e
			throw new Error(`${name} failed`)
		}
	}
	// the names the cell running now read, while it runs in the reader's own run (the // nocache
	// cells: a step's run is the builds', which keeps its trace)
	let touched: Set<string> | undefined

	// ---- a cell's source to a function: code is an expression or a body; await makes it async;
	// markdown is a template, ${…} its holes ----
	const compiled = new Map<string, Function>()
	function compile(kind: string, src: string): Function {
		const k = kind + "\u0000" + src
		const had = compiled.get(k)
		if (had) return had
		const names = ["cell", "fetch"]
		let f: Function
		if (kind === "md") {
			f = new Function(
				...names,
				"return `" + src.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`",
			)
		} else {
			const Make = /\bawait\b/.test(src) ? AsyncFunction : Function
			try {
				f = new Make(...names, `return (\n${src}\n)`)
			} catch {
				f = new Make(...names, src)
			}
		}
		compiled.set(k, f)
		return f
	}

	// ---- what a run found, and its end: a step says (onStep) what its lookup found, and the run
	// then ends; both are told here, and written to ./flow as the run ends (a run reads its own cell
	// and others', never the flow; the end writes it, in the run) ----
	const found = new Map<string, Found>()
	const off = builds.onStep((f) => found.set(f.name as string, f))
	addTeardown(off)
	// a miss: the step is out, the cell runs again as it lands and hits the entry kept. that run
	// is the miss, timed from the miss's start
	const missed = new Map<string, { key: string; t0: number }>()
	const lastOut = new Map<string, unknown>()
	type Note = {
		id: string
		ended: "done" | "pending" | "failed"
		error?: string
		ms?: number
		cutoff: boolean
		cache?: Found & { outcome: string }
		reads?: string[]
	}
	const notes: Note[] = []
	let alive = true
	addTeardown(() => (alive = false))

	function note(id: string, out: unknown, took: number, thrown: unknown, reads?: Set<string>) {
		const f = found.get(id)
		found.delete(id)
		const bad = thrown !== undefined && thrown !== PENDING
			? thrown
			: out instanceof Error
			? out
			: undefined
		const ended = out === PENDING || thrown === PENDING ? "pending" : bad ? "failed" : "done"
		const n: Note = { id, ended, cutoff: false }
		if (bad) n.error = String((bad as Error).message ?? bad)
		if (ended === "pending") {
			if (f?.found === "miss" && missed.get(id)?.key !== f.key) {
				missed.set(id, { key: f.key!, t0: performance.now() - took })
			}
		} else {
			const m = missed.get(id)
			missed.delete(id)
			n.ms = took
			if (ended === "done") {
				n.cutoff = lastOut.has(id) && sameBytes(lastOut.get(id), out)
				lastOut.set(id, out)
				if (f) {
					const ran = f.found === "miss" || (f.found === "hit" && m?.key === f.key)
					if (ran && m?.key === f.key) n.ms = performance.now() - m.t0
					n.cache = { ...f, outcome: ran ? "miss" : f.found }
				}
				if (reads) n.reads = [...reads]
			}
		}
		notes.push(n)
		flush()
	}

	// the notes written to the flow, one edit for all: the cell's run number, how it ended, what
	// its step found (counted), and who it read: for a hit, the places its entry's trace names
	function flush() {
		if (!alive || !notes.length) return
		const was = (get(flow) ?? {}) as Record<string, any>
		const next: Record<string, any> = {}
		const values = up(["values"], [])?.found
		for (const n of notes.splice(0)) {
			const name = hasNode(at(n.id)) ? get<string>(at(n.id), ["name"]) : undefined
			if (name === undefined) continue
			const before = next[name] ?? was[name]
			const counts = before?.cache ?? { hits: 0, misses: 0, cutoffs: 0, never: 0 }
			const c = n.cache
			const cache = c
				? {
					hits: counts.hits + (c.outcome === "hit" ? 1 : 0),
					misses: counts.misses + (c.outcome === "miss" ? 1 : 0),
					cutoffs: counts.cutoffs + (n.cutoff ? 1 : 0),
					never: counts.never + (c.outcome === "never" ? 1 : 0),
					last: c.outcome,
					cutoff: n.cutoff,
					key: c.key,
					entry: c.entry,
					entries: c.entries,
					checked: c.checked,
				}
				: counts
			let reads: string[] = before?.reads ?? []
			if (n.reads) reads = n.reads.filter((r) => r !== name)
			else if (c?.outcome === "hit" || c?.outcome === "miss") {
				const entry = `./cache/${c.key}/${c.entry}`
				const trace = (hasNode(entry) ? peep(() => readAttributes(entry, [TRACE])) : undefined) as
					| [string, unknown, (string | number)[], string | null][]
					| undefined
				reads = []
				for (const [part, id, path] of trace ?? []) {
					const r = String(path[0])
					if (part === "children" && id === values && path.length === 1 && r !== name) {
						if (!reads.includes(r)) reads.push(r)
					}
				}
			}
			next[name] = {
				reads,
				// a run that ends pending is the same run, as it lands
				run: (before?.run ?? 0) + (before?.ended === "pending" ? 0 : 1),
				ended: n.ended,
				error: n.error,
				ms: n.ms,
				cache,
			}
		}
		patch(flow, Object.entries(next).map(([name, value]) => ({ path: [name], value })))
	}

	// one run of a cell: its source and chart type read (so an edit reruns it), then its step: a
	// hit gives the kept value; a miss runs the code in a computer of its own, whose cell() calls
	// are its reads, and the cell runs again as it lands. failed: the cell fails with its Error
	function evaluate(id: string, kind: string) {
		const src = String(read(`${at(id)}/src`) ?? "")
		const type = kind === "chart" ? read(at(id), ["type"]) ?? "line" : undefined
		const never = NOCACHE.test(src)
		const t0 = performance.now()
		let out: unknown, thrown: unknown, reads: Set<string> | undefined
		try {
			out = builds.step(id, [kind, src, type ?? null], () => {
				if (never) touched = reads = new Set()
				let out
				try {
					out = compile(kind, src)(cell, fakeFetch)
				} finally {
					touched = undefined
				}
				if (kind === "md") return markdown(String(out))
				if (kind === "chart") {
					return isPromise(out)
						? out.then((data) => ({ chart: type, data }))
						: { chart: type, data: out }
				}
				return out
			}, { never })
		} catch (e) {
			thrown = e
		}
		note(id, out, performance.now() - t0, thrown, reads)
		if (thrown !== undefined) throw thrown
		if (out instanceof Error) throw out
		return out
	}

	// ---- the running cells: a memo for each computed cell, at its name in ./values, made by one
	// effect as it runs (a cell removed or renamed is not made again, and its memo goes); a node
	// for each widget, made with the cell. a memo made again by its owner's run is due again, so
	// the effect reads a memo of the cells that are (id, name, kind), equal while they are the same:
	// a move, a fold or a chart type does not make them again, a cell added, removed or renamed
	// does, and every cell's memo runs again with it ----
	const running = createMemo(
		"cells",
		() =>
			ids().map((id) =>
				[id, read(at(id), ["name"]), read(at(id), ["kind"])] as [string, string, string]
			).sort(),
		{
			equal: sameBytes,
		},
	)
	createEffect("running", () => {
		const made: string[] = []
		for (const [id, name, kind] of read(running) as [string, string, string][]) {
			if (COMPUTED.has(kind)) {
				// made inside the process's own node (a memo lives inside what made it), and placed at
				// /values/<name> too, where cell() reads every cell's value
				const m = createMemo(`values/${name}`, () => evaluate(id, kind), { equal: sameBytes })
				if (!peep(() => hasNode(`/values/${name}`))) place(`/values/${name}`, m)
			}
			made.push(name)
		}
		return made
	}, () => {})
	// a new cell: its record and source, its widget's node, and its place in the order
	function create(record: Record<string, unknown>, src: string, index?: number) {
		const id = crypto.randomUUID()
		ensureNode(at(id), record)
		ensureNode(`${at(id)}/src`, src)
		if (!COMPUTED.has(record.kind as string)) ensureNode(`/values/${record.name}`, record.start)
		const was = get<string[]>(order)
		const next = [...was]
		next.splice(index ?? next.length, 0, id)
		put(order, next)
	}

	if (first) { for (const [kind, name, src, extra] of SEED) create({ kind, name, ...extra }, src) }
	else {
		for (const id of ids()) {
			const c = get<{ kind: string; name: string; start?: unknown }>(at(id))
			if (!COMPUTED.has(c.kind)) ensureNode(`/values/${c.name}`, c.start)
		}
	}

	// ---- actions: every write is a call ----
	createAction("on/src", (id: string, text: string) => put(`${at(id)}/src`, text))
	createAction("on/set", (name: string, value: unknown) => put(`/values/${name}`, value))
	createAction(
		"on/type",
		(id: string, type: string) => patch(at(id), [{ path: ["type"], value: type }]),
	)
	createAction("on/fold", (id: string) => {
		patch(at(id), [{ path: ["open"], value: !get<{ open?: boolean }>(at(id)).open }])
	})
	createAction("on/add", (kind: string, after?: string) => {
		const [prefix, src, extra] = FRESH[kind]
		const taken = new Set(peep(names))
		let n = 1
		while (taken.has(prefix + n)) n++
		const index = after ? peep(ids).indexOf(after) + 1 : undefined
		create({ kind, name: prefix + n, open: true, ...extra }, src, index)
	})
	// the step of a cell's code now, out of the cache (its other codes' steps stay)
	const uncache = (name: string) => {
		const key = get<string | undefined>(flow, [name, "cache", "key"])
		if (!key) return
		for (const entry of peep(() => list(`./cache/${key}`))) unplace(`./cache/${key}/${entry}`)
		unplace(`./cache/${key}`)
	}
	createAction("on/remove", (id: string) => {
		const name = peep(() => nameOf(id))
		uncache(name)
		unplace(`/values/${name}`)
		lastOut.delete(id)
		missed.delete(id)
		put(order, get<string[]>(order).filter((x) => x !== id))
		unplace(`${at(id)}/src`)
		unplace(at(id))
		patch(flow, [{ path: [name] }])
	})
	// a cell's cache emptied: its next run is a miss
	createAction("on/uncache", (name: string) => {
		uncache(name)
		if (get(flow, [name, "cache"])) patch(flow, [{ path: [name, "cache", "entries"], value: 0 }])
	})
	createAction("on/move", (id: string, by: number) => {
		const all = [...get<string[]>(order)]
		const from = all.indexOf(id)
		const to = Math.max(0, Math.min(all.length - 1, from + by))
		if (to === from) return
		all.splice(to, 0, ...all.splice(from, 1))
		put(order, all)
	})
	// a new name: a widget's node moves with it, so a slider keeps its value; a computed cell runs
	// again at the new name (the running effect makes its memo there; its steps are named by its
	// id, so its cache stays its own). the cells reading the old name find nothing there now, and
	// say so
	createAction("on/rename", (id: string, typed: string) => {
		const old = peep(() => nameOf(id))
		let name = String(typed).trim().replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1")
		if (!name || name === old) return
		const taken = new Set(peep(names))
		if (taken.has(name)) {
			let n = 2
			while (taken.has(name + n)) n++
			name += n
		}
		const computed = COMPUTED.has(get<string>(at(id), ["kind"]))
		if (!computed && peep(() => list("/values")).includes(old)) {
			rename(`/values/${old}`, `/values/${name}`)
		}
		// a computed cell's memo is made again at its new name; its old name here goes
		if (computed) unplace(`/values/${old}`)
		patch(at(id), [{ path: ["name"], value: name }])
		patch(flow, [{ path: [old] }])
	})

	// ---- the arrows: an effect on the flow and the order, drawn in the rail beside the cells.
	// its value (a node too) is the edges; drawing is the DOM's, after layout ----
	let rail: HTMLElement | undefined
	let cellsEl: HTMLElement | undefined
	let last: {
		names: string[]
		edges: [string, string][]
		runs: Record<string, number>
		hits: string[]
	}
	let hot = new Set<string>()
	let hover: string | undefined
	let frame = 0
	const redraw = () => {
		cancelAnimationFrame(frame)
		frame = requestAnimationFrame(() => draw())
	}
	createEffect(
		"arrows",
		() => {
			const f = (read(flow) ?? {}) as Record<string, { reads?: string[]; run?: number }>
			const all = names()
			const edges: [string, string][] = []
			for (const to of all) {
				for (const from of f[to]?.reads ?? []) if (all.includes(from)) edges.push([from, to])
			}
			return {
				names: all,
				edges,
				runs: Object.fromEntries(all.map((n) => [n, f[n]?.run ?? 0])),
				hits: all.filter((n) => (f[n] as any)?.cache?.last === "hit"),
			}
		},
		(v, before) => {
			last = v
			// the cells that ran since: they flash, and so do the arrows into them
			hot = new Set(v.names.filter((n) => before && before.runs[n] !== v.runs[n]))
			redraw()
			const lit = hot
			setTimeout(() => {
				for (const n of lit) {
					const glow = v.hits.includes(n) ? HIT : GLOW
					cellsEl?.querySelector(`.cell[data-name="${n}"]`)?.animate(glow, 700)
				}
			})
			// the arrows into them stop flowing when the flash is over
			setTimeout(() => {
				if (hot !== lit) return
				hot = new Set()
				redraw()
			}, 950)
		},
	)
	function draw() {
		if (!rail || !cellsEl || !last) return
		const box = cellsEl.getBoundingClientRect()
		const at = new Map<string, number>()
		for (const el of cellsEl.querySelectorAll<HTMLElement>(".cell")) {
			at.set(el.dataset.name!, el.getBoundingClientRect().top - box.top + 19)
		}
		const index = new Map(last.names.map((n, i) => [n, i]))
		const X = 62
		let svg = ""
		const ports = new Set<string>()
		for (const [from, to] of last.edges) {
			const a = at.get(from), b = at.get(to)
			if (a === undefined || b === undefined) continue
			const k = Math.abs(index.get(from)! - index.get(to)!)
			const d = Math.min(54, 10 + 8 * k)
			const color = COLORS[index.get(from)! % COLORS.length]
			const lit = hover === undefined ? "" : hover === from || hover === to ? " lit" : " dim"
			svg += `<g class="edge${hot.has(to) ? " hot" : ""}${lit}" style="--c:${color}">` +
				`<path d="M${X} ${a} C${X - d} ${a}, ${X - d} ${b}, ${X - 5} ${b}"/>` +
				`<path class="head" d="M${X - 1} ${b} l-7 -4 v8 z"/>` +
				`<title>${from} → ${to}: ${to} read ${from} on its last run</title></g>`
			ports.add(from)
		}
		for (const name of ports) {
			const color = COLORS[index.get(name)! % COLORS.length]
			svg += `<circle cx="${X}" cy="${at.get(name)}" r="3.5" fill="${color}" stroke="#000"/>`
		}
		rail.innerHTML = `<svg width="${X + 2}" height="${box.height}">${svg}</svg>`
	}
	// a cell grows (a chart drawn, a source longer): the rail is drawn again
	const sizes = new ResizeObserver(() => redraw())
	addTeardown(() => sizes.disconnect())
	addEventListener("resize", redraw)
	addTeardown(() => removeEventListener("resize", redraw))
	const lit = (name?: string) => {
		hover = name
		redraw()
	}
	const jump = (name: string) => {
		const el = cellsEl?.querySelector<HTMLElement>(`.cell[data-name="${name}"]`)
		el?.scrollIntoView({ behavior: "smooth", block: "center" })
		el?.animate(GLOW, 900)
	}

	// ---- the views ----
	// the counts, from the arrows' node: the cells, the edges, every run so far
	const head = (a) => (
		<span class="counts">
			<span class="tag mint">{a.names.length} cells</span>
			<span class="tag">{a.edges.length} arrows</span>
			<span class="tag">
				{Object.values(a.runs).reduce((x: number, y: number) => x + y, 0)} runs
			</span>
		</span>
	)

	// how a cell's last run ended, by the flow
	const status = (name: string, kind: string) => (f) => {
		if (!COMPUTED.has(kind)) return <span class="state widget">a node you set</span>
		const r = f?.[name]
		if (!r) return <span class="state">not run</span>
		const c = r.cache
		const hit = c?.last === "hit" && r.ended === "done"
		const word = hit ? "kept" : r.ended === "done" ? "ran" : r.ended
		return [
			<span class={`state ${r.ended}`} title={`run ${r.run}, ${r.ended}`}>
				{word} #{r.run}
				{r.ms !== undefined && <span class="ms">{ms(r.ms)}</span>}
			</span>,
			c?.last && (
				<span
					class={`cache ${c.last}`}
					title={`${c.hits} hits · ${c.misses} misses · ${c.cutoffs} cut off · ${
						c.entries ?? 0
					} entries kept${c.entry ? ` · this run: entry ${c.entry}` : ""}${
						c.last === "never" ? " · its code says // nocache" : ""
					}`}
				>
					{c.last === "never" ? "never cached" : c.last}
					{c.last !== "never" && <b>{c.last === "hit" ? c.hits : c.misses}</b>}
				</span>
			),
			c?.cutoff && (
				<span class="cache cut" title="the same bytes as before: its readers did not run">
					cut off
				</span>
			),
		]
	}
	// who it reads, who reads it: chips that go to that cell
	const foot = (name: string) => (f) => {
		const c = f?.[name]?.cache
		const kept = c && c.last && c.last !== "never" && (
			<span class="side kept">
				{c.entries ?? 0} kept · {c.hits} hit{c.hits === 1 ? "" : "s"} · {c.misses} miss
				{c.misses === 1 ? "" : "es"}
				{c.cutoffs ? ` · ${c.cutoffs} cut off` : ""}
				<button
					class="chip clear"
					title="empty this cell's cache: its next run is a miss"
					onClick={handler("on/uncache", [name])}
				>
					clear cache
				</button>
			</span>
		)
		const reads = f?.[name]?.reads ?? []
		const by = Object.entries(f ?? {})
			.filter(([n, r]: [string, any]) => n !== name && r.reads?.includes(name))
			.map(([n]) => n)
		if (!reads.length && !by.length) return kept || undefined
		return [
			reads.length > 0 && (
				<span class="side">
					reads {reads.map((n) => (
						<button class="chip in" onClick={() => jump(n)}>
							{n}
						</button>
					))}
				</span>
			),
			by.length > 0 && (
				<span class="side">
					read by {by.map((n) => (
						<button class="chip by" onClick={() => jump(n)}>
							{n}
						</button>
					))}
				</span>
			),
			kept,
		]
	}

	// what a cell shows: by its kind
	function output(id: string, v) {
		const at = `./values/${v.name}`
		if (v.kind === "md") return <div class="out md">{bind(at, html)}</div>
		if (v.kind === "chart") return <div class="out chart">{bind(at, (spec) => chart(spec))}</div>
		if (v.kind === "code") {
			return (
				<div class="out code">
					<span class="lhs">{v.name} =</span> {bind(at, show)}
				</div>
			)
		}
		if (v.kind === "slider") {
			return bind(`./cells/${id}/src`, (src) => {
				const o = options(src)
				// the name read here, so a rename makes the slider again on its new value
				const name = (read(`./cells/${id}`) as { name: string }).name, at = `./values/${name}`
				return (
					<label class="out slider">
						<input
							type="range"
							min={String(o.min)}
							max={String(o.max)}
							step={String(o.step)}
							value={bind(at, String)}
							onInput={handler("on/set", (e) => [name, +e.target.value])}
						/>
						<output>{bind(at, num)}</output>
					</label>
				)
			})
		}
		return (
			<label class="out text">
				<input
					value={bind(at)}
					spellcheck={false}
					onInput={handler("on/set", (e) => [v.name, e.target.value])}
				/>
			</label>
		)
	}

	function body(id: string, v) {
		const editable = v.kind !== "input" && (v.kind === "code" || v.kind === "chart" || v.open)
		// what ./flow says of this cell, by its name as it is now: read here, since a binding made
		// again the same keeps what it closed over (a rename keeps the cell's place)
		const flow = (show: (name: string) => (f) => unknown) =>
			track(
				() => [read("./flow"), (read(`./cells/${id}`) as { name: string }).name] as const,
				([f, name]) => show(name)(f) as never,
			)
		return [
			<div class="head">
				<span class={`kind k-${v.kind}`} title={v.kind}>
					{ICON[v.kind]}
				</span>
				<input
					class="name"
					value={v.name}
					size={Math.max(2, v.name.length)}
					spellcheck={false}
					title="its name: cell(name) reads it. rename it and its readers lose it"
					onChange={handler("on/rename", (e) => {
						const typed = e.target.value
						e.target.value = v.name
						return [id, typed]
					})}
				/>
				{flow((name) => status(name, v.kind))}
				<span class="fill" />
				{v.kind === "chart" && (
					<span class="types">
						{TYPES.map((type) => (
							<button
								class={type === v.type ? "on" : ""}
								onClick={handler("on/type", [id, type])}
							>
								{type}
							</button>
						))}
					</span>
				)}
				<span class="tools">
					{(v.kind === "md" || v.kind === "slider") && (
						<button title="show the source" onClick={handler("on/fold", [id])}>✎</button>
					)}
					<button title="move up" onClick={handler("on/move", [id, -1])}>
						↑
					</button>
					<button title="move down" onClick={handler("on/move", [id, 1])}>
						↓
					</button>
					<button title="a code cell below" onClick={handler("on/add", ["code", id])}>
						+
					</button>
					<button class="x" title="delete" onClick={handler("on/remove", [id])}>✕</button>
				</span>
			</div>,
			output(id, v),
			<div class="err">{flow((name) => (f) => f?.[name]?.error)}</div>,
			editable && (
				<textarea
					class="src"
					spellcheck={false}
					rows={bind(`./cells/${id}/src`, (s) => String(s).split("\n").length)}
					value={bind(`./cells/${id}/src`)}
					onInput={handler("on/src", (e) => [id, e.target.value])}
					onKeyDown={tab}
				/>
			),
			<footer class="foot">{flow(foot)}</footer>,
		]
	}

	return (
		<div class="nb">
			<style>{LOOK}</style>
			<header class="top">
				<span class="tag title">notebook</span>
				<span class="lede">cells are nodes · a cell reads another with cell("name")</span>
				<span class="fill" />
				{bind("arrows", head)}
			</header>
			<div class="cells">
				<div class="rail" ref={(e) => (rail = e)} />
				<div
					class="list"
					ref={(e) => {
						cellsEl = e
						sizes.observe(e)
					}}
				>
					{bind("./order", (all: string[]) =>
						all.map((id) => (
							<section
								key={id}
								class="cell"
								data-name={bind(`./cells/${id}`, (v) => v.name)}
								data-kind={bind(`./cells/${id}`, (v) => v.kind)}
								onPointerEnter={(e) => lit(e.currentTarget.dataset.name)}
								onPointerLeave={() => lit(undefined)}
							>
								{bind(`./cells/${id}`, (v) => body(id, v))}
							</section>
						)))}
				</div>
			</div>
			<footer class="add">
				<span class="tag">add a cell</span>
				{Object.keys(FRESH).map((kind) => (
					<button onClick={handler("on/add", [kind])}>
						<b>{ICON[kind]}</b> {kind}
					</button>
				))}
			</footer>
		</div>
	)
}

// ---- small things ----
// the attribute a cache entry's reads are kept in
const TRACE = "ermine.programs.trace"
// a value's bytes: its JSON (a function or a symbol has none: a string saying what it is). two
// results with the same bytes are the same, so a run giving them again stops there (early cutoff)
const bytes = (v: unknown) => {
	if (v === undefined) return "undefined"
	try {
		return JSON.stringify(v) ?? String(v)
	} catch {
		return String(v)
	}
}
const sameBytes = (a: unknown, b: unknown) => a === b || bytes(a) === bytes(b)
const AsyncFunction = (async () => {}).constructor as FunctionConstructor
// a line "// nocache" (at the start of a line, after spaces): this cell is never cached
const NOCACHE = /^\s*\/\/\s*nocache\b/m
const HIT = [
	{ boxShadow: "0 0 0 3px #40dcba, 0 0 18px 6px #40dcba88" },
	{ boxShadow: "0 0 14px 2px #ff228426" },
]
const isPromise = (v) => typeof v?.then === "function"
const GLOW = [
	{ boxShadow: "0 0 0 3px #ff2284, 0 0 18px 6px #ff228466" },
	{ boxShadow: "0 0 14px 2px #ff228426" },
]
const ms = (
	n: number,
) => (n < 1 ? `${n.toFixed(2)}ms` : n < 100 ? `${n.toFixed(1)}ms` : `${(n / 1000).toFixed(2)}s`)
const num = (v) => (typeof v === "number" ? String(+v.toFixed(3)) : String(v))
function options(src) {
	try {
		const o = new Function(`return (${src || "{}"})`)()
		return { min: o.min ?? 0, max: o.max ?? 100, step: o.step ?? 1 }
	} catch {
		return { min: 0, max: 100, step: 1 }
	}
}
// two spaces for a tab, in the textarea itself (the input event that follows writes it)
function tab(e: KeyboardEvent) {
	if (e.key !== "Tab") return
	e.preventDefault()
	document.execCommand("insertText", false, "  ")
}

// the fake fetch: 2s, then a Response-like thing whose json is made-up weather for the city
function fakeFetch(url: string) {
	return new Promise((done) =>
		setTimeout(
			() => done({ ok: true, status: 200, json: async () => weather(String(url)) }),
			2000,
		)
	)
}
function weather(url: string) {
	const city = decodeURIComponent(/city=([^&]*)/.exec(url)?.[1] ?? "").trim() || "nowhere"
	let h = 7
	for (const ch of city.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0
	const base = 4 + (h % 22)
	const temps = Array.from(
		{ length: 24 },
		(_, i) =>
			Math.round(
				(base + 6 * Math.sin(((i - 9) / 24) * 2 * Math.PI) + ((h >> i % 13) & 3) - 1.5) * 10,
			) / 10,
	)
	return { city, temps }
}

// ---- markdown, small: headings, paragraphs, lists, quotes, **bold**, *em*, `code`, links ----
const esc = (s: string) =>
	s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const inline = (s: string) =>
	esc(s)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
function markdown(text: string) {
	const out: string[] = []
	for (const block of text.split(/\n\s*\n/)) {
		const lines = block.trim().split("\n")
		const h = /^(#{1,3})\s+(.*)$/.exec(lines[0])
		if (h && lines.length === 1) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
		else if (lines.every((l) => /^\s*[-*]\s/.test(l))) {
			out.push(
				`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s/, ""))}</li>`).join("")}</ul>`,
			)
		} else if (lines.every((l) => l.startsWith(">"))) {
			out.push(`<blockquote>${inline(lines.map((l) => l.slice(1)).join(" "))}</blockquote>`)
		} else if (h) {
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
			out.push(`<p>${inline(lines.slice(1).join(" "))}</p>`)
		} else out.push(`<p>${inline(lines.join(" "))}</p>`)
	}
	return out.join("")
}
function html(s: string) {
	const div = document.createElement("div")
	div.innerHTML = String(s)
	return div
}
function svg(s: string) {
	const t = document.createElement("template")
	t.innerHTML = s.trim()
	return t.content.firstChild as Element
}

// ---- a value, shown: a number, a string, a list (a sparkline when it is numbers), a record ----
function show(v): any {
	if (v && typeof v === "object" && "chart" in v) return chart(v)
	if (typeof v === "number") return <span class="num">{num(v)}</span>
	if (typeof v === "string") return <span class="str">"{v}"</span>
	if (v === null || typeof v !== "object") return <span class="kw">{String(v)}</span>
	if (Array.isArray(v)) {
		const nums = v.every((x) => typeof x === "number")
		const shown = v.slice(0, 8).map((x) => (typeof x === "number" ? num(x) : brief(x)))
		return (
			<span class="arr">
				<span class="kw">Array({v.length})</span> [{shown.join(", ")}
				{v.length > 8 ? ", …" : ""}]{nums && v.length > 1 && spark(v)}
			</span>
		)
	}
	return (
		<span class="rec">
			{"{"}
			{Object.entries(v).map(([k, x], i) => (
				<span class="pair">
					{i > 0 && ", "}
					<span class="key">{k}</span>:{" "}
					{typeof x === "number" ? <span class="num">{num(x)}</span> : brief(x)}
				</span>
			))}
			{"}"}
		</span>
	)
}
const brief = (x) =>
	typeof x === "string"
		? `"${x}"`
		: Array.isArray(x)
		? `Array(${x.length})`
		: x && typeof x === "object"
		? "{…}"
		: String(x)
function spark(v: number[]) {
	const lo = Math.min(...v), hi = Math.max(...v), W = 90, H = 20
	const pts = v.map((y, i) =>
		`${(i / (v.length - 1)) * W},${H - 2 - ((y - lo) / (hi - lo || 1)) * (H - 4)}`
	)
	return svg(
		`<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${
			pts.join(" ")
		}"/></svg>`,
	)
}

// ---- a chart, drawn as svg from a cell's value: numbers, [x, y] pairs, or { label: number } ----
function ticks(lo: number, hi: number, count = 4) {
	const raw = (hi - lo) / count
	const mag = 10 ** Math.floor(Math.log10(raw))
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!
	const out: number[] = []
	for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) {
		out.push(+v.toFixed(10))
	}
	if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step)
	return out
}
function chart(spec) {
	const type = spec?.chart ?? "line"
	const d = spec?.data
	let pts: { x: number; y: number; label: string }[] = []
	if (Array.isArray(d)) {
		pts = d.map((v, i) =>
			Array.isArray(v)
				? { x: +v[0], y: +v[1], label: String(v[0]) }
				: { x: i, y: +v, label: String(i) }
		)
	} else if (d && typeof d === "object") {
		pts = Object.entries(d).map(([k, v], i) => ({ x: i, y: +(v as number), label: k }))
	}
	pts = pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
	if (!pts.length) {
		return (
			<div class="nochart">
				a chart wants numbers: a list, [x, y] pairs, or {"{ label: number }"}
			</div>
		)
	}
	const W = 600, H = 210, L = 36, R = 12, T = 12, B = 24
	const ys = pts.map((p) => p.y)
	const yt = ticks(Math.min(0, ...ys), Math.max(0, ...ys) || 1)
	const lo = yt[0], hi = yt[yt.length - 1]
	const bars = type === "bars"
	const x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x))
	const n = pts.length
	const slot = (W - L - R) / n
	const sx = (x: number, i: number) =>
		bars ? L + slot * (i + 0.5) : L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R)
	const sy = (y: number) => T + ((hi - y) / (hi - lo || 1)) * (H - T - B)
	let g = ""
	for (const v of yt) {
		g +=
			`<line class="grid${v === 0 ? " zero" : ""}" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${
				sy(v)
			}"/>` +
			`<text class="yl" x="${L - 6}" y="${sy(v) + 4}">${+v.toFixed(2)}</text>`
	}
	const every = Math.ceil(n / 10)
	pts.forEach((p, i) => {
		if (i % every === 0) {
			g += `<text class="xl" x="${sx(p.x, i)}" y="${H - 6}">${esc(p.label)}</text>`
		}
	})
	const xy = pts.map((p, i) => `${sx(p.x, i).toFixed(1)},${sy(p.y).toFixed(1)}`)
	if (type === "area") {
		g += `<path class="area" d="M${sx(pts[0].x, 0)},${sy(0)} L${xy.join(" L")} L${
			sx(pts[n - 1].x, n - 1)
		},${sy(0)} Z"/>`
	}
	if (type === "line" || type === "area") g += `<polyline class="line" points="${xy.join(" ")}"/>`
	pts.forEach((p, i) => {
		const tip = `<title>${esc(p.label)}: ${+p.y.toFixed(3)}</title>`
		if (bars) {
			const top = sy(Math.max(0, p.y)), h = Math.abs(sy(p.y) - sy(0))
			g += `<rect class="bar" x="${sx(p.x, i) - slot * 0.36}" y="${top}" width="${
				slot * 0.72
			}" height="${Math.max(h, 0.5)}">${tip}</rect>`
		} else {
			g += `<circle class="${type === "dots" ? "dot big" : "dot"}" cx="${sx(p.x, i)}" cy="${
				sy(p.y)
			}" r="${type === "dots" ? 4.5 : 2.6}">${tip}</circle>`
		}
	})
	return svg(`<svg class="plot ${type}" viewBox="0 0 ${W} ${H}" width="100%">${g}</svg>`)
}

// ---- the look: lemon paper, black lines, white cards glowing pink ----
const LOOK = `
[hidden] { display: none !important }
body { margin: 0; background: #ffff88; font: 15px/1.4 Jost, system-ui, sans-serif; color: #000 }
.nb { max-width: 900px; margin: 0 auto; padding: 12px 14px 40px }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 14px 62px }
.fill { flex: 1 }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 9px;
	transform: skew(-8deg); font-weight: 600; font-size: 13px; white-space: nowrap }
.tag.title { background: #ff2284; color: #fff; font-size: 17px; padding: 1px 12px }
.tag.mint { background: #40dcba }
.lede { font-size: 13px; color: #000b }
.counts { display: flex; gap: 6px }
button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 0 9px; box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform 90ms, box-shadow 90ms }
button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
button:active { transform: translate(1px, 1px); box-shadow: 0 0 0 #000 }
.cells { position: relative }
.rail { position: absolute; left: 0; top: 0; bottom: 0; width: 64px; pointer-events: none }
.rail svg { overflow: visible; pointer-events: auto }
.edge path { fill: none; stroke: var(--c); stroke-width: 1.7; transition: opacity 120ms }
.edge path.head { fill: var(--c); stroke: none }
.edge.dim { opacity: .15 }
.edge.lit path { stroke-width: 2.6 }
.edge.hot path:not(.head) { stroke-dasharray: 5 4; animation: flow 900ms linear }
@keyframes flow { from { stroke-dashoffset: 36 } to { stroke-dashoffset: 0 } }
.list { margin-left: 64px }
.cell { position: relative; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 0 0 14px 2px #ff228426; margin: 0 0 14px; padding: 7px 10px 6px }
.cell[data-kind=md] { background: #fffef6 }
.head { display: flex; align-items: center; gap: 7px; min-height: 24px }
.kind { width: 20px; height: 20px; display: grid; place-items: center; border: 1px solid #000;
	border-radius: 50%; font-size: 12px; font-weight: 700; background: #fff; flex: none }
.k-code { background: #ff2284; color: #fff } .k-chart { background: #2269ff; color: #fff }
.k-slider, .k-input { background: #40dcba } .k-md { background: #ffff88 }
input.name { font: 600 13px Jost, system-ui, sans-serif; background: #ffff88; border: 1px solid #000;
	border-radius: 0; transform: skew(-8deg); padding: 0 7px; outline: none; min-width: 2ch }
input.name:focus { background: #fff; box-shadow: 0 0 0 2px #2269ff66 }
.state { font-size: 12px; color: #0009; display: inline-flex; gap: 5px; align-items: center }
.state::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1px solid #000;
	background: #40dcba }
.state.pending::before { background: #ffff88; animation: blink 600ms infinite alternate }
.state.failed::before { background: #ff2284 } .state.looping::before { background: #a23cf0 }
.state.widget::before { background: #fff }
.state .ms { font-variant-numeric: tabular-nums; color: #0007 }
@keyframes blink { to { background: #ff2284 } }
.tools, .types { display: flex; gap: 4px; opacity: 0; transition: opacity 120ms }
.cell:hover .tools, .cell:hover .types, .types { opacity: 1 }
.tools button, .types button { font-size: 12px; padding: 0 6px; box-shadow: 1px 1px 0 #000 }
.types button.on { background: #2269ff; color: #fff }
.tools .x:hover { background: #ff2284; color: #fff }
.out { padding: 6px 2px 4px; min-height: 20px; overflow-x: auto; transition: opacity 200ms }
.out:has([data-ermine-waiting]), .out[data-ermine-waiting] { opacity: .5; background:
	repeating-linear-gradient(-45deg, #ffff8844 0 8px, #fff0 8px 16px); animation: wait 1s linear infinite }
@keyframes wait { to { background-position: 22px 0 } }
.out.code { font: 13px/1.5 ui-monospace, Menlo, monospace }
.lhs { color: #0008 }
.num { color: #2269ff } .str { color: #c4006a } .kw { color: #0009 } .key { color: #14a888 }
.spark { vertical-align: middle; margin-left: 8px; overflow: visible }
.spark polyline { fill: none; stroke: #ff2284; stroke-width: 1.5 }
.out.md h1 { font-size: 26px; margin: 2px 0 4px; line-height: 1.15 }
.out.md h2 { font-size: 20px; margin: 2px 0 } .out.md p { margin: 4px 0 }
.out.md code { background: #ffff88; padding: 0 3px; border: 1px solid #0003 }
.out.md strong { background: linear-gradient(transparent 60%, #40dcba88 60%) }
.out.slider { display: flex; align-items: center; gap: 12px }
.out.slider input { flex: 1; accent-color: #ff2284 }
.out.slider output { font: 600 18px Jost, sans-serif; min-width: 3ch; text-align: right;
	font-variant-numeric: tabular-nums }
.out.text input { font: inherit; font-size: 16px; width: 100%; box-sizing: border-box; border: 1px solid #000;
	border-radius: 2px; padding: 3px 8px; outline: none; background: #fffdf0 }
.out.text input:focus { box-shadow: 0 0 0 2px #2269ff55 }
.plot { display: block; max-height: 230px; overflow: visible }
.plot .grid { stroke: #0002; stroke-dasharray: 3 3 } .plot .grid.zero { stroke: #000; stroke-dasharray: none }
.plot text { font: 11px Jost, sans-serif; fill: #0009 } .plot .yl { text-anchor: end } .plot .xl { text-anchor: middle }
.plot .line { fill: none; stroke: #ff2284; stroke-width: 2.2; stroke-linejoin: round }
.plot .area { fill: #ff228424 }
.plot .dot { fill: #ff2284; stroke: #000; stroke-width: .8 } .plot .dot.big { fill: #2269ff }
.plot .bar { fill: #40dcba; stroke: #000; stroke-width: 1 } .plot .bar:hover, .plot .dot:hover { fill: #ff2284 }
.nochart { font-size: 13px; color: #0008 }
.err { font: 12px ui-monospace, Menlo, monospace; color: #d1006a }
.err:not(:empty) { border-left: 3px solid #ff2284; padding: 2px 8px; margin: 2px 0 4px; background: #ff228410 }
.err:not(:empty) + .src, .cell:has(.err:not(:empty)) .out { opacity: .55 }
textarea.src { display: block; width: 100%; box-sizing: border-box; font: 13px/1.5 ui-monospace, Menlo, monospace;
	background: #fffdf0; border: 1px solid #0004; border-radius: 2px; padding: 5px 8px; resize: none;
	outline: none; margin: 4px 0 2px; tab-size: 2; white-space: pre; overflow-x: auto }
textarea.src:focus { border-color: #000; box-shadow: 0 0 0 2px #2269ff44 }
.cache { font-size: 11px; font-weight: 600; border: 1px solid #000; padding: 0 6px; transform: skew(-8deg);
	display: inline-flex; gap: 4px; align-items: center; line-height: 16px }
.cache b { font-weight: 700; background: #000; color: #fff; border-radius: 6px; padding: 0 4px; font-size: 10px; line-height: 13px }
.cache.hit { background: #40dcba } .cache.miss { background: #ff2284; color: #fff }
.cache.miss b { background: #fff; color: #ff2284 } .cache.cut { background: #d4e4ff }
.cache.never { background: #fff; border-style: dashed; color: #0009 }
.kept { color: #0008 } .chip.clear { background: #fff; margin-left: 4px }
.chip.clear:hover { background: #ffff88 }
.foot { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: #0008; min-height: 18px; padding-top: 2px }
.side { display: inline-flex; gap: 4px; align-items: center }
.chip { font-size: 11.5px; padding: 0 7px; border-radius: 9px; box-shadow: 1px 1px 0 #000; line-height: 16px }
.chip.in { background: #c8f6ea } .chip.by { background: #d4e4ff }
.add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: 64px }
.add b { color: #ff2284 }
`
