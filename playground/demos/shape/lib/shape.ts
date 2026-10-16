/// <reference lib="dom" />
// the graph as the scheduler holds it: not the places tree, not what the host recorded, but the
// scheduler's own state, read when drawn. three ways, one switch:
//
// values: computer → computer, an arrow from w to c when c's last run read a key w writes
//   (c.values), in columns by rank (c.rank, the order it runs a round in)
// keys: computers and the keys they track (the tracker's links, c.node.reads) and write
//   (c.wrote: only a compute's mark counts as a write; an effect's or an outside write has none)
// owners: scopes and computers by who made whom (parent / children)
//
// keys are opaque to the scheduler; one shaped like a places spot ({source, id, path}) is shown
// by node and part, any other as itself.
import type { Computer, Scheduler, Scope } from "@ermine/scheduler"
import { gestures } from "./views.ts"

export type Mode = "values" | "keys" | "owners"

export type Box = {
	key: string
	kind: "compute" | "effect" | "scope" | "key"
	label: string
	sub: string
	flags: string[]
	// the node a box stands for or belongs to: a key's id, a process scope's (or its computers')
	place?: string
	scope?: Scope
	k?: unknown
	x: number
	y: number
}
export type Arrow = { from: Box; to: Box; kind: "value" | "read" | "wrote" | "owner" }
export type Shape = { boxes: Box[]; arrows: Arrow[]; mode: Mode; capped: boolean; counts: string }

const W = 170
const H = 40
const COL = 240
const ROW = 50
const CAP = 600

const isComputer = (o: Scope): o is Computer => "kind" in o
const given = (o: Scope) => o.info.filter(([k]) => k !== "owner" && k !== "run" && k !== "mark")
const short = (v: unknown, n = 24) => {
	let s: string
	try {
		s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v)
	} catch {
		s = String(v)
	}
	return s.length > n ? s.slice(0, n - 1) + "…" : s
}

// a spot's source: places keeps one {part} object a part
const partOf = (source: unknown) =>
	source !== null && typeof source === "object" && "part" in source
		? String((source as { part: unknown }).part)
		: String(source)

// a stable number per key object, so boxes keep their keys across draws
const ids = new WeakMap<object, number>()
let next = 0
const idOf = (k: unknown) => {
	if (k === null || (typeof k !== "object" && typeof k !== "function")) return `v:${String(k)}`
	let n = ids.get(k)
	if (n === undefined) ids.set(k, n = ++next)
	return `o:${n}`
}

// the roots to walk from: the ones given, and the top of every computer seen running since (a
// root scope made elsewhere, by as({actor}) say, is reachable from nothing else)
export function rootsOf(s: Scheduler, first: Scope[]): { roots: () => Scope[]; stop: () => void } {
	const roots = new Set(first)
	const stop = s.onRunStart((c) => {
		let o: Scope = c
		while (o.parent) o = o.parent
		roots.add(o)
	})
	return {
		roots: () => [...roots].filter((o) => o.state !== "gone"),
		stop,
	}
}

// the scheduler's state, as boxes and arrows laid out for one mode
export function readShape(roots: Scope[], mode: Mode, name: (id: string) => string): Shape {
	const scopes: Scope[] = []
	const computers: Computer[] = []
	let capped = false
	const walk = (o: Scope) => {
		if (o.state === "gone") return
		if (scopes.length >= CAP * 2) return void (capped = true)
		scopes.push(o)
		if (isComputer(o)) computers.push(o)
		for (const kid of o.children) walk(kid)
	}
	for (const r of roots) walk(r)

	// a scope's name: its own given pairs, the first of name / process / why / actor / role
	const nameOfScope = (o: Scope): string | undefined => {
		const g = Object.fromEntries(given(o))
		const v = g.name ?? g.process ?? g.why ?? g.actor ?? g.role
		return v === undefined ? undefined : short(v, 30)
	}
	// the process a scope is in: the nearest ["process", id] above
	const processOf = (o: Scope): string | undefined => {
		for (let x: Scope | undefined = o; x; x = x.parent) {
			const p = given(x).find(([k]) => k === "process")?.[1]
			if (typeof p === "string") return p
		}
	}
	const owner = (o: Scope) => {
		const out: string[] = []
		for (let x = o.parent; x && out.length < 2; x = x.parent) {
			const n = nameOfScope(x)
			if (n) out.unshift(n)
		}
		return out.join(" › ")
	}

	const boxes = new Map<unknown, Box>()
	const add = (k: unknown, b: Omit<Box, "x" | "y" | "key">) => {
		let box = boxes.get(k)
		if (!box) boxes.set(k, box = { ...b, key: idOf(k), x: 0, y: 0 })
		return box
	}
	const computerBox = (c: Computer) => {
		const flags: string[] = []
		if (c.due) flags.push("due")
		if (c.looping) flags.push("looping")
		if (c.early) flags.push("early")
		return add(c, {
			kind: c.kind,
			label: `${owner(c) || "·"}`,
			sub: `${c.kind} #${c.n}${
				processOf(c) ? ` · ${processOf(c)}` : ""
			} · rank ${c.rank} · ${c.runs} runs`,
			flags,
			place: processOf(c),
			scope: c,
		})
	}
	const scopeBox = (o: Scope) =>
		add(o, {
			kind: "scope",
			label: nameOfScope(o) ?? `scope #${o.n}`,
			sub: given(o).map(([k, v]) => `${k}=${short(v, 14)}`).join(" ") || `#${o.n}`,
			flags: o.parent ? [] : ["root"],
			place: processOf(o),
			scope: o,
		})
	const keyBox = (k: unknown) => {
		const spot = k as {
			source?: unknown
			id?: unknown
			path?: readonly unknown[] | null
			keys?: boolean
		}
		const isSpot = spot !== null && typeof spot === "object" && "id" in spot && "source" in spot
		if (!isSpot) return add(k, { kind: "key", label: short(k, 30), sub: typeof k, flags: [], k })
		const id = String(spot.id)
		const path = spot.path === null
			? "change"
			: spot.path?.length
			? "/" + spot.path.map((x) => String(x)).join("/")
			: ""
		return add(k, {
			kind: "key",
			label: name(id),
			sub: `${partOf(spot.source)}${path}${spot.keys ? " · keys" : ""}`,
			flags: [],
			place: id,
			k,
		})
	}

	const arrows: Arrow[] = []
	const live = new Set(computers)
	const shown = computers.slice(0, CAP)
	if (shown.length < computers.length) capped = true

	// columns: each distinct rank, in order
	const ranks = [...new Set(shown.map((c) => c.rank))].sort((a, b) => a - b)
	const col = new Map(ranks.map((r, i) => [r, i]))

	if (mode === "values") {
		for (const c of shown) computerBox(c)
		for (const c of shown) {
			for (const w of c.values) {
				if (!live.has(w) || !boxes.has(w)) continue
				arrows.push({ from: boxes.get(w)!, to: boxes.get(c)!, kind: "value" })
			}
		}
		columns(shown.map((c) => [boxes.get(c)!, col.get(c.rank)!]))
	} else if (mode === "keys") {
		const layer = new Map<Box, number>()
		for (const c of shown) layer.set(computerBox(c), 2 * col.get(c.rank)! + 1)
		const writer = new Map<unknown, Computer>()
		for (const c of shown) for (const k of c.wrote) writer.set(k, c)
		const keyLayer = (k: unknown) => {
			const w = writer.get(k)
			return w ? 2 * col.get(w.rank)! + 2 : 0
		}
		for (const c of shown) {
			const seen = new Set<unknown>()
			for (let l = c.node.reads; l !== null; l = l.next) {
				const k = l.to.owner
				if (seen.has(k)) continue
				seen.add(k)
				const b = keyBox(k)
				layer.set(b, keyLayer(k))
				arrows.push({ from: b, to: boxes.get(c)!, kind: "read" })
			}
			for (const k of c.wrote) {
				const b = keyBox(k)
				layer.set(b, keyLayer(k))
				arrows.push({ from: boxes.get(c)!, to: b, kind: "wrote" })
			}
		}
		columns([...layer])
	} else {
		// a tidy tree, left to right: leaves take rows, a parent sits between its first and last
		let row = 0
		const place = (o: Scope, depth: number): Box => {
			const b = isComputer(o) ? computerBox(o) : scopeBox(o)
			b.x = depth * COL
			const kids = o.children.filter((k) => k.state !== "gone" && scopes.includes(k))
			if (!kids.length) b.y = row++ * ROW
			else {
				const ys = kids.map((k) => {
					const kb = place(k, depth + 1)
					arrows.push({ from: b, to: kb, kind: "owner" })
					return kb.y
				})
				b.y = (ys[0] + ys[ys.length - 1]) / 2
			}
			return b
		}
		for (const r of roots) if (scopes.includes(r)) (place(r, 0), row++)
	}

	const n = (k: Box["kind"]) => [...boxes.values()].filter((b) => b.kind === k).length
	const counts = mode === "owners"
		? `${n("scope")} scopes · ${n("compute")} computes · ${n("effect")} effects`
		: mode === "keys"
		? `${shown.length} computers · ${n("key")} keys · ${arrows.length} links`
		: `${shown.length} computers · ${ranks.length} ranks · ${arrows.length} values`
	return { boxes: [...boxes.values()], arrows, mode, capped, counts }
}

// columns: boxes in their column, sorted by label so a process's computers sit together
function columns(at: (readonly [Box, number])[]) {
	const by = new Map<number, Box[]>()
	for (const [b, c] of at) by.set(c, [...(by.get(c) ?? []), b])
	const cols = [...by.keys()].sort((a, b) => a - b)
	const tall = Math.max(0, ...[...by.values()].map((l) => l.length))
	cols.forEach((c, i) => {
		const list = by.get(c)!.sort((a, b) =>
			a.label.localeCompare(b.label) || a.sub.localeCompare(b.sub)
		)
		const top = (tall - list.length) * ROW / 2
		list.forEach((b, j) => ((b.x = i * COL), (b.y = top + j * ROW)))
	})
}

const css = `
.sv { flex: 1 1 55%; min-height: 80px; position: relative; overflow: hidden; background: var(--paper, #fffdf6); cursor: grab; touch-action: none; user-select: none; font: 10px/1.3 var(--mono, ui-monospace, monospace); color: var(--ink, #2c2231); }
.sv.drag { cursor: grabbing; }
.sv .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.sv svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.sv svg > path { fill: none; vector-effect: non-scaling-stroke; stroke-width: 1px; }
.sv svg > path.value { stroke: #555; }
.sv svg > path.owner { stroke: #999; }
.sv svg > path.read { stroke: var(--sky, #3d6fd8); opacity: .55; }
.sv svg > path.wrote { stroke: var(--leaf, #2f8a3a); opacity: .7; }
.sv svg > path.up { stroke: var(--sky, #3d6fd8); stroke-width: 2.5px; opacity: 1; }
.sv svg > path.down { stroke: var(--cherry, #ff2284); stroke-width: 2.5px; opacity: 1; }
.sv svg > path.faint { opacity: .08; }
.sv .sb { position: absolute; width: ${W}px; height: ${H}px; background: #fff; border: 1px solid var(--line, #2c2231); box-shadow: 2px 2px 0 var(--line, #2c2231); padding: 2px 4px; overflow: hidden; cursor: pointer; }
.sv .sb:hover { background: var(--lemon, #fff47a); }
.sv .sb .t, .sv .sb .u { display: flex; gap: 4px; white-space: nowrap; overflow: hidden; }
.sv .sb .n { font-weight: bold; font-size: 11px; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sv .sb .u { color: var(--soft, #7a6f7d); overflow: hidden; text-overflow: ellipsis; }
.sv .sb .f { font-size: 9px; border: 1px solid currentColor; padding: 0 3px; flex: none; }
.sv .sb .f.due { color: #b07800; } .sv .sb .f.looping { color: var(--cherry, #ff2284); } .sv .sb .f.root, .sv .sb .f.early { color: var(--soft, #7a6f7d); }
.sv .sb.compute { background: #f1ffe8; } .sv .sb.effect { background: #f6ecff; }
.sv .sb.key { border-style: dashed; box-shadow: none; background: #fffdf2; border-radius: 10px; }
.sv .sb.sel { background: var(--lemon, #fff47a); outline: 2px solid var(--ink, #2c2231); z-index: 3; }
.sv .sb.up { outline: 2px solid var(--sky, #3d6fd8); background: #e8f0ff; }
.sv .sb.down { outline: 2px solid var(--cherry, #ff2284); background: #ffe8ec; }
.sv .sb.faint { opacity: .35; }
.sv .modes { position: absolute; left: 4px; top: 4px; display: flex; z-index: 5; border: 1px solid var(--line, #2c2231); background: #fff; }
.sv .modes button { border: 0; border-right: 1px solid var(--line, #2c2231); background: transparent; padding: 0 8px; line-height: 18px; font: inherit; cursor: pointer; color: inherit; box-shadow: none; }
.sv .modes button:last-child { border-right: 0; }
.sv .modes button.on { background: var(--lemon, #fff47a); font-weight: bold; }
.sv .say { position: absolute; left: 4px; bottom: 2px; right: 4px; display: flex; gap: 10px; color: var(--soft, #7a6f7d); pointer-events: none; white-space: nowrap; overflow: hidden; }
.sv .say .sp { flex: 1; }
.sv .say b { font-weight: normal; padding-left: 4px; }
.sv .say .ku { border-left: 3px solid var(--sky, #3d6fd8); } .sv .say .kd { border-left: 3px solid var(--cherry, #ff2284); } .sv .say .kw { border-left: 3px solid var(--leaf, #2f8a3a); }
.sv .about { position: absolute; right: 4px; top: 4px; max-width: 46%; z-index: 5; background: #fff; border: 1px solid var(--line, #2c2231); box-shadow: 2px 2px 0 var(--line, #2c2231); padding: 4px 6px; white-space: pre-wrap; cursor: auto; user-select: text; }
.sv .about button { margin-top: 4px; font: inherit; cursor: pointer; }
`

const legends: Record<Mode, [string, string][]> = {
	values: [["ku", "waits on (its values)"], ["kd", "waited on by"]],
	keys: [["ku", "reads"], ["kw", "wrote"], ["kd", "read by / written by"]],
	owners: [["ku", "owners above"], ["kd", "made under it"]],
}

const SVGNS = "http://www.w3.org/2000/svg"
const svg = (tag: string, attrs: Record<string, string> = {}) => {
	const e = document.createElementNS(SVGNS, tag)
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
	return e
}
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))

function div(cls: string, text?: string) {
	const e = document.createElement("div")
	e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

// the view. read: the shape now, for a mode (the caller walks the scheduler); place: show a node
// in the places view
export function shapeView(o: {
	read: (mode: Mode) => Shape
	place?: (id: string) => void
	mode?: Mode
}) {
	if (!document.getElementById("sv-css")) {
		const st = document.createElement("style")
		st.id = "sv-css"
		st.textContent = css
		document.head.append(st)
	}
	const el = div("sv")
	const world = div("world")
	const lines = svg("svg", { width: "1", height: "1" })
	const defs = svg("defs")
	for (
		const [id, col] of [
			["value", "#555"],
			["owner", "#999"],
			["read", "#3d6fd8"],
			[
				"wrote",
				"#2f8a3a",
			],
			["up", "#3d6fd8"],
			["down", "#ff2284"],
		]
	) {
		const mk = svg("marker", {
			id: `sv-${id}`,
			viewBox: "0 0 10 10",
			refX: "9",
			refY: "5",
			markerWidth: "7",
			markerHeight: "7",
			orient: "auto-start-reverse",
		})
		mk.append(svg("path", { d: "M0 0L10 5L0 10z", fill: col, stroke: "none" }))
		defs.append(mk)
	}
	lines.append(defs)
	world.append(lines)
	const modes = div("modes")
	const say = div("say")
	const about = div("about")
	about.style.display = "none"
	el.append(world, modes, say, about)

	let mode: Mode = o.mode ?? "values"
	let shape: Shape | undefined
	let picked: string | undefined
	const btns = {} as Record<Mode, HTMLButtonElement>
	for (const m of ["values", "keys", "owners"] as Mode[]) {
		const b = document.createElement("button")
		b.textContent = m
		b.onclick = (e) => (e.stopPropagation(), setMode(m))
		btns[m] = b
		modes.append(b)
	}
	modes.addEventListener("pointerdown", (e) => e.stopPropagation())
	about.addEventListener("pointerdown", (e) => e.stopPropagation())

	let v = { x: 16, y: 32, k: 1 }
	let fitted = false
	let moved = false
	const apply = () => (world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`)
	const fit = () => {
		if (!shape?.boxes.length || !el.clientWidth) return
		let a = 1e9, b = 1e9, c = -1e9, d = -1e9
		for (const x of shape.boxes) {
			;(a = Math.min(a, x.x),
				b = Math.min(b, x.y),
				c = Math.max(c, x.x + W),
				d = Math.max(d, x.y + H))
		}
		const w = el.clientWidth - 32, hh = el.clientHeight - 64
		const k = clamp(Math.min(w / (c - a), hh / (d - b)), 0.15, 1.4)
		v = { k, x: (el.clientWidth - (c - a) * k) / 2 - a * k, y: 32 - b * k }
		fitted = true
		moved = false
		apply()
	}
	gestures(el, {
		drag: (dx, dy) => ((moved = true), (v.x += dx), (v.y += dy), apply()),
		wheel: (dy, e) => {
			moved = true
			const r = el.getBoundingClientRect()
			const mx = e.clientX - r.left, my = e.clientY - r.top
			const k2 = clamp(v.k * Math.exp(-dy * 0.0015), 0.05, 3)
			v = { k: k2, x: mx - (mx - v.x) * k2 / v.k, y: my - (my - v.y) * k2 / v.k }
			apply()
		},
		tap: (t) => {
			const b = t?.closest<HTMLElement>(".sb")
			picked = b?.dataset.key === picked ? undefined : b?.dataset.key
			draw()
		},
	})

	const edge = (a: Box, b: Box) => {
		const y1 = a.y + H / 2, y2 = b.y + H / 2
		if (b.x > a.x + W / 2) {
			const x1 = a.x + W, x2 = b.x, mx = (x1 + x2) / 2
			return `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
		}
		// backwards or in one column: out to the right and round
		const x1 = a.x + W, x2 = b.x + W, o = 40 + Math.abs(y2 - y1) * 0.15
		return `M${x1} ${y1}C${Math.max(x1, x2) + o} ${y1} ${Math.max(x1, x2) + o} ${y2} ${x2} ${y2}`
	}

	function aboutOf(b: Box) {
		about.replaceChildren()
		const lines: string[] = [`${b.kind}: ${b.label}`, b.sub]
		const sc = b.scope
		if (sc && isComputer(sc)) {
			lines.push(
				`due ${sc.due || "no"} · ranked ${sc.ranked} · stamp ${sc.stamp}`,
				`values ${sc.values.length} · wrote ${sc.wrote.size} · kept causes ${sc.kept.length}`,
			)
			if (sc.after) lines.push(`waits after #${sc.after.n}`)
			if (sc.loop?.length) lines.push(`loop: ${sc.loop.map((x) => `#${x.n}`).join(" → ")}`)
		}
		if (sc) {
			const pairs = given(sc)
			if (pairs.length) lines.push(pairs.map(([k, v]) => `${k}: ${short(v, 40)}`).join("\n"))
			const up: string[] = []
			for (let x = sc.parent; x; x = x.parent) {
				up.push(given(x).map(([k, v]) => `${k}=${short(v, 16)}`).join(" ") || `#${x.n}`)
			}
			if (up.length) lines.push(`owners: ${up.join(" ‹ ")}`)
		}
		about.append(lines.join("\n"))
		if (b.place && o.place) {
			const go = document.createElement("button")
			go.textContent = `show ${b.place} in places`
			go.onclick = () => o.place!(b.place!)
			about.append(document.createElement("br"), go)
		}
		about.style.display = ""
	}

	function draw() {
		shape = o.read(mode)
		for (const m of Object.keys(btns) as Mode[]) btns[m].classList.toggle("on", m === mode)
		world.querySelectorAll(".sb,path:not(marker path)").forEach((x) => x.remove())
		const sel = shape.boxes.find((b) => b.key === picked)
		if (!sel) picked = undefined
		const up = new Set<Box>(), down = new Set<Box>()
		if (sel && mode === "owners") {
			for (const a of shape.arrows) if (a.from === sel) down.add(a.to)
			for (let x = sel.scope?.parent; x; x = x.parent) {
				const b = shape.boxes.find((y) => y.scope === x)
				if (b) up.add(b)
			}
		} else if (sel) {
			for (const a of shape.arrows) {
				if (a.to === sel) up.add(a.from)
				if (a.from === sel) down.add(a.to)
			}
		}
		const paths: Element[] = []
		for (const a of shape.arrows) {
			const touch = sel && (a.from === sel || a.to === sel ||
				(mode === "owners" && (up.has(a.to) || a.to === sel)))
			const cls = !sel
				? a.kind
				: touch
				? (a.to === sel || up.has(a.to) ? "up" : "down")
				: "faint"
			const mk = cls === "faint" ? a.kind : cls
			paths.push(
				svg("path", {
					class: `${a.kind} ${cls}`,
					d: edge(a.from, a.to),
					"marker-end": `url(#sv-${mk})`,
				}),
			)
		}
		lines.append(...paths)
		const frag = document.createDocumentFragment()
		for (const b of shape.boxes) {
			const e = div(`sb ${b.kind}`)
			if (b === sel) e.classList.add("sel")
			else if (up.has(b)) e.classList.add("up")
			else if (down.has(b)) e.classList.add("down")
			else if (sel) e.classList.add("faint")
			e.dataset.key = b.key
			e.style.left = `${b.x}px`
			e.style.top = `${b.y}px`
			const t = div("t")
			t.append(div("n", b.label))
			for (const f of b.flags) t.append(div(`f ${f}`, f))
			e.append(t, div("u", b.sub))
			frag.append(e)
		}
		world.append(frag)
		say.replaceChildren(
			div("", shape.counts + (shape.capped ? " (capped)" : "")),
			div("sp"),
			...legends[mode].map(([c, t]) =>
				Object.assign(document.createElement("b"), { className: c, textContent: t })
			),
		)
		if (sel) aboutOf(sel)
		else about.style.display = "none"
		if (!fitted || !moved) fit()
	}
	function setMode(m: Mode) {
		mode = m
		picked = undefined
		fitted = false
		draw()
	}
	return { el, draw, fit, setMode, mode: () => mode }
}
