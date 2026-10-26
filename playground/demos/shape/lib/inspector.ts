/// <reference lib="dom" />
// the explorer: the graph as the host's api gives it, never the table underneath. every read
// is the scheduler's (look, content, info, children), so protect is asked and what is refused
// shows as refused.
//
// a tree you fold and search; pick a node and the tree lights up what it reads (blue) and the
// processes that read it (cherry), from each process's latest run as its `ends` moment told it
// (the stand-in, host.ts, keeps no run nodes). a detail pane: where the node is placed, its value
// (a process's status in front) and the change that made it, infos, children; a process's status,
// latest run, kill and replace; a handler's call. below, what the scheduler did, in words.
//
// one id under a name (today's places): a path reaches it, and a node placed under two names shows
// as the same node placed again
import { STATUS } from "@ermine/core/places/status"
import {
	type ChangeHeader,
	first,
	type Host,
	type Moment,
	type Read,
	statusOf,
	tickOf,
	whole,
	whoOf,
} from "./host.ts"
import {
	buildModel,
	type Card,
	type Ctx,
	mapView,
	type Model,
	namesOf,
	spaceView,
	viewsCss,
} from "./views.ts"
import { readShape, rootsOf, shapeView } from "./shape.ts"

type Item = ReturnType<Host["content"]>[number]
type N = NonNullable<Item["node"]>
type V = { content: unknown; change?: ChangeHeader; because?: unknown }
type Address = string[]
// a process's latest run, from its ends moment; by: the process whose change made it due
type Run = { run: number; ended: string; reads: Read[]; wrote: number[]; by?: string }

export type InspectorOptions = {
	// the address drawn from; default the root
	from?: Address
	// lists folded at first (big ones)
	skip?: (name: string) => boolean
	// folded below this depth at first; default 4
	depth?: number
	// the activity strip's height in px; 0: none
	moments?: number
	// picked at first
	pick?: Address
	// going back in time, when the host has a history to do it with (a demo syncing over
	// subduction has). given: a one-row control to pick a past moment and really go back to it.
	// not given: nothing shows
	travel?: Travel
}

// a host's history: the moments it can go back to, and a way to go. going back is itself a new
// moment (a change like any other), so nothing is lost and a later pick can go forward again
export type Travel = {
	// the moments, oldest first. time: the host's own (a graph clock time, a chain's index…);
	// label: a few words for it
	times: () => { time: number; label: string }[]
	// set the graph back to how it was at time; one call per pick
	go: (time: number) => unknown
	// what going back does not set back, said in the control's tooltip
	note?: string
}

const h = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls = "",
	text?: string,
	attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] => {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
	return e
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
function json(v: unknown): string {
	try {
		return JSON.stringify(v, (_, x) => (typeof x === "function" ? "ƒ" : x)) ?? String(v)
	} catch {
		return String(v)
	}
}
// a value, drawn by its kind: strings as text, numbers, truth, lists by length, maps by keys
function shown(v: unknown, n = 40): HTMLElement {
	if (v === undefined) return h("span", "vk", "")
	if (v === null) return h("span", "vk", "∅")
	if (typeof v === "string") return h("span", "vs", `“${cut(v.replace(/\n/g, "⏎"), n)}”`)
	if (typeof v === "number") return h("span", "vn", String(Math.round(v * 1000) / 1000))
	if (typeof v === "boolean") return h("span", v ? "vt" : "vf", String(v))
	if (typeof v === "function") return h("span", "vfn", `ƒ ${v.name || "handler"}`)
	if (v instanceof Uint8Array) return h("span", "vb", `bytes ${v.length}`)
	if (ArrayBuffer.isView(v)) {
		return h("span", "vb", `${v.constructor.name} ${(v as unknown as ArrayLike<unknown>).length}`)
	}
	if (Array.isArray(v)) {
		return h(
			"span",
			"vl",
			`[${v.length}] ${
				cut(v.slice(0, 4).map((x) => typeof x === "object" ? "…" : json(x)).join(" "), n)
			}`,
		)
	}
	if (typeof v === "object") {
		const keys = Object.keys(v as object)
		return h("span", "vm", `{${cut(keys.join(" "), n)}}`)
	}
	return h("span", "", String(v))
}
function pretty(v: unknown): string {
	if (typeof v === "function") return v.toString()
	if (v instanceof Uint8Array) {
		return `bytes ${v.length}: ${
			[...v.slice(0, 48)].map((b) => b.toString(16).padStart(2, "0")).join(" ")
		}${v.length > 48 ? " …" : ""}`
	}
	try {
		return JSON.stringify(v, (_, x) => (typeof x === "function" ? `ƒ ${x.name}` : x), 1) ??
			String(v)
	} catch {
		return String(v)
	}
}
// who a change is by, in a few words: a person, the actor, then the process and its run or
// handler (the header's pairs)
function who(change: ChangeHeader | undefined, name: (id: string) => string): string {
	if (!change) return ""
	const w = whoOf(change)
	const p = w.process === undefined ? "" : name(String(w.process))
	const by = w.handler !== undefined
		? `${p}${p ? " " : ""}on/${w.handler}`
		: p
		? `${p}${w.run !== undefined ? ` run ${w.run}` : ""}`
		: ""
	return [w.person !== undefined ? `${w.person} via` : "", by ? "" : String(w.actor ?? ""), by]
		.filter(Boolean).join(" ")
}
const key = (a: Address, k: number) => a.join("/") + "#" + k
const timeOf = (v: { change?: ChangeHeader }) => tickOf(v.change) ?? 0
// a name as shown: a slot that stands for a key a name can never be ("/", "." or "..", written
// %2F, %2E, %2E%2E, as outside/automerge does) shows that key; every other name as it is
const ENCODED = /^((?:%25)*)(%2F|%2E|%2E%2E)$/
const unescaped = (name: string) => {
	const m = ENCODED.exec(name)
	if (!m) return name
	if (m[1]) return name.slice(3)
	return ({ "%2F": "/", "%2E": ".", "%2E%2E": ".." } as Record<string, string>)[m[2]]
}
const pathOf = (a: Address) => "/" + a.slice(1).map(unescaped).join("/")

const css = `
.ex { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; background: var(--acme); border-left: 1px solid var(--line); font: 11px/1.45 var(--mono); }
.ex .tools { display: flex; gap: 4px; padding: 4px; border-bottom: 1px solid var(--line); background: var(--cream); align-items: center; }
.ex .tools input { flex: 1; min-width: 0; font: 11px var(--mono); padding: 1px 4px; }
.ex .tools button { padding: 0 5px; font-size: 11px; box-shadow: none; }
.ex.big { position: fixed; inset: 44px 16px 16px; z-index: 1000; border: 1.5px solid var(--line); box-shadow: 0 0 0 100vmax #2c223144, 4px 4px 0 var(--line); }
.ex.big { display: grid; grid-template-columns: 1fr 380px; grid-template-rows: auto auto auto 1fr auto; }
.ex.big > .vtabs, .ex.big > .tools, .ex.big > .key { grid-column: 1; }
.ex.big > .tree, .ex.big > .vw { grid-column: 1; grid-row: 4 / 6; flex: none; }
.ex.big > .detail { grid-column: 2; grid-row: 1 / 5; border-top: 0; border-left: 1px solid var(--line); min-height: 0; }
.ex.big > .mo { grid-column: 2; grid-row: 5; height: 160px !important; border-left: 1px solid var(--line); }
.ex .key { display: flex; gap: 10px; padding: 2px 6px; border-bottom: 1px solid var(--shade); color: var(--soft); background: #fff; white-space: nowrap; overflow: hidden; }
.ex .key b { font-weight: normal; padding: 0 3px; }
.ex .key .kr { border-left: 3px solid var(--sky); } .ex .key .kb { border-left: 3px solid var(--cherry); }
.ex .tree { flex: 1 1 55%; overflow: auto; min-height: 60px; padding: 2px 0 8px; }
.ex .r { display: flex; gap: 6px; white-space: nowrap; align-items: baseline; padding: 0 6px 0 0; cursor: pointer; border-left: 3px solid transparent; }
.ex .r:hover { background: #fff; }
.ex .r.sel { background: var(--lemon); }
.ex .r.reads { border-left-color: var(--sky); background: #e8f0ff; }
.ex .r.readby { border-left-color: var(--cherry); background: #ffe8ec; }
.ex .r.hit .nm { background: var(--lemon); outline: 1px solid var(--line); }
.ex .r.flash { animation: exflash 1.2s ease-out; }
@keyframes exflash { from { background: #fff27a; } to { background: transparent; } }
.ex .g { display: inline-block; width: 12px; align-self: stretch; border-left: 1px dotted #c9c0a0; margin-left: 5px; flex: none; }
.ex .tw { width: 10px; color: var(--ink); flex: none; text-align: center; }
.ex .nm { font-weight: bold; }
.ex .nm.eph { font-style: italic; }
.ex .k { color: var(--soft); }
.ex .id { color: #b5ab88; margin-left: auto; padding-left: 8px; font-size: 10px; }
.ex .vs { color: #6b3d00; } .ex .vn { color: var(--sky); } .ex .vt { color: var(--leaf); } .ex .vf { color: var(--cherry); }
.ex .vk { color: var(--soft); } .ex .vl, .ex .vm { color: #5a5a5a; } .ex .vb { color: #9b3dd8; } .ex .vfn { color: #9b3dd8; }
.ex .r > .vs, .ex .r > .vn, .ex .r > .vl, .ex .r > .vm, .ex .r > .vk { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ex .pill { padding: 0 4px; font-size: 9px; line-height: 13px; border: 1px solid currentColor; flex: none; }
.ex .ok { color: var(--leaf); } .ex .pend { color: #b07800; } .ex .err { color: var(--cherry); }
.ex .tag { font-size: 9px; padding: 0 3px; flex: none; }
.ex .tag.rd { background: var(--sky); color: #fff; } .ex .tag.rb { background: var(--cherry); color: #fff; }
.ex .ph { color: var(--cherry); }
.ex .dim { color: var(--soft); font-style: italic; }
.ex .detail { flex: 1 1 45%; overflow: auto; border-top: 1px solid var(--line); background: #fff; padding: 6px 8px; min-height: 80px; }
.ex .detail h4 { margin: 10px 0 3px; font: bold 10px var(--sans); text-transform: uppercase; letter-spacing: .05em; color: var(--soft); border-bottom: 1px solid var(--shade); }
.ex .detail h3 { margin: 0; font: bold 13px var(--mono); display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.ex .detail pre { margin: 2px 0; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; background: var(--acme); padding: 3px 5px; border: 1px solid var(--shade); }
.ex .ver { border-left: 3px solid var(--shade); padding-left: 6px; margin: 4px 0; }
.ex .ver.status { border-color: #b07800; }
.ex .ver .meta { color: var(--soft); }
.ex .chip { display: inline-block; border: 1px solid var(--line); background: var(--acme); padding: 0 4px; margin: 1px 3px 1px 0; cursor: pointer; }
.ex .chip:hover { background: var(--lemon); }
.ex .chip.rd { border-left: 3px solid var(--sky); } .ex .chip.rb { border-left: 3px solid var(--cherry); }
.ex .chip.un { color: var(--soft); border-style: dashed; }
.ex .row2 { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
.ex .row2 button { padding: 0 6px; font-size: 11px; }
.ex textarea { width: 100%; min-height: 48px; font: 11px var(--mono); }
.ex .msg { color: var(--cherry); }
.ex .tip { color: var(--soft); line-height: 1.6; }
.ex .tip b { color: var(--ink); }
.ex .tt { display: flex; gap: 4px; padding: 2px 4px; border-bottom: 1px solid var(--line); background: var(--cream); align-items: center; white-space: nowrap; }
.ex .tt input { flex: 1 1 40%; min-width: 40px; margin: 0; height: 14px; accent-color: var(--cherry); }
.ex .tt .tl { flex: 1 1 60%; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--soft); }
.ex .tt .tl.back { color: var(--cherry); }
.ex .tt .tl.bad { color: var(--cherry); font-weight: bold; }
.ex.big.tr { grid-template-rows: auto auto auto auto 1fr auto; }
.ex.big > .tt { grid-column: 1; }
.ex.big.tr > .tree, .ex.big.tr > .vw { grid-row: 5 / 7; }
.ex.big.tr > .detail { grid-row: 1 / 6; }
.ex.big.tr > .mo { grid-row: 6; }
.ex .mo { flex: none; overflow: auto; border-top: 1px solid var(--line); background: var(--acme-tag); padding: 2px 6px; }
.ex .mo div { cursor: pointer; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.ex .mo div:hover { background: #fff; }
.ex .mo .round { border-top: 1px dashed var(--soft); margin-top: 3px; padding-top: 1px; color: var(--soft); }
` + viewsCss + `.ex .mc.s3 { left: 0; top: 0; }\n`

// mounts the explorer into an element
export function inspector(s: Host, into: HTMLElement, o: InspectorOptions = {}) {
	if (!document.getElementById("ex-css")) {
		document.head.append(Object.assign(h("style", "", css), { id: "ex-css" }))
	}
	into.classList.add("inspector-wrap")
	const box = h("div", "ex")
	const tools = h("div", "tools")
	const search = h("input", "", undefined, {
		placeholder: "find a name or id…",
		spellcheck: "false",
	})
	const procsOnly = h("button", "", "⚙ only", { title: "only processes and what holds them" })
	const foldAll = h("button", "", "fold", { title: "back to the first folding" })
	tools.append(search, procsOnly, foldAll)
	const legend = h("div", "key")
	const stat = h("span")
	legend.append(stat, h("b", "kr", "reads"), h("b", "kb", "read by"))
	const tree = h("div", "tree")
	const detail = h("div", "detail")
	// view tabs: the tree, a flat map, a 3d space, and the scheduler's own shape (shape.ts)
	type View = "tree" | "map" | "3d" | "scheduler"
	let view: View = "tree"
	const vtabs = h("div", "vtabs")
	const tabs = {} as Record<View, HTMLElement>
	for (const t of ["tree", "map", "3d", "scheduler"] as View[]) {
		tabs[t] = h("button", t === view ? "on" : "", t)
		tabs[t].onclick = () => setView(t)
		vtabs.append(tabs[t])
	}
	const fitBtn = h("button", "", "fit", { title: "fit the whole map in view" })
	const exSl = h("span", "sl")
	const exRange = h("input", "", undefined, {
		type: "range",
		min: "0",
		max: "300",
		value: "90",
		title: "explode: spread the layers",
	}) as HTMLInputElement
	exSl.append("explode", exRange)
	// big: the explorer over the whole page, so the map and 3d have room
	const bigBtn = h("button", "", "⤢", { title: "make the explorer big (esc to shrink)" })
	bigBtn.onclick = () => {
		const on = box.classList.toggle("big")
		bigBtn.classList.toggle("on", on)
		bigBtn.textContent = on ? "⤡" : "⤢"
		requestAnimationFrame(() => fitBtn.click())
	}
	addEventListener("keydown", (e) => {
		if (e.key === "Escape" && box.classList.contains("big")) bigBtn.click()
	})
	vtabs.append(h("span", "sp"), fitBtn, exSl, bigBtn)
	box.append(vtabs, tools, legend)
	const travel = o.travel ? travelRow(o.travel) : undefined
	if (travel) (box.classList.add("tr"), box.append(travel.el))
	box.append(tree, detail)
	const height = o.moments ?? 110
	const mo = h("div", "mo")
	if (height) {
		mo.style.height = `${height}px`
		box.append(mo)
	}
	into.append(box)

	const root: Address = o.from ?? ["/"]
	const folded = new Set<string>()
	const opened = new Set<string>()
	let onlyProcs = false
	let picked: { address: Address; k: number; id: string } | undefined
	// what the last draw saw: each id's addresses and name, its newest change tick
	let where = new Map<string, Address[]>()
	let times = new Map<string, number>()
	// each process's latest run (its ends moment), what last made it due, its reads as ids
	const runs = new Map<string, Run>()
	const woken = new Map<string, string | undefined>()
	const edges = new Map<string, { run: Run | undefined; ids: Set<string>; reads: Read[] }>()

	// a node's name, with its parent's when it has one, so ten "panel"s say whose they are
	const nameOf = (id: string) => {
		const a = where.get(id)?.[0]
		if (!a) return id
		return a.length > 2
			? `${unescaped(a[a.length - 2])}/${unescaped(a[a.length - 1])}`
			: unescaped(a[a.length - 1])
	}
	const isFolded = (a: Address, k: number, depth: number, name: string) => {
		const id = key(a, k)
		if (folded.has(id)) return true
		if (opened.has(id)) return false
		return depth >= (o.depth ?? 4) || name === "on" || (o.skip?.(name) ?? false)
	}

	// every read below is the host's: content gives the items with their versions
	const look = (a: Address) => s.content(a) as Item[]
	const newest = (n: N) => {
		let t = 0
		for (const e of Object.values(n)) t = Math.max(t, tickOf(e.change) ?? 0)
		return t
	}
	function kind(id: string, n: Item["node"]) {
		if (s.process(id)) return "proc"
		if (n && typeof n.value?.value === "function") return "fn"
		return s.ephemeral(id) ? "eph" : ""
	}
	const kidOf = (n: N, name: string) => (n.children?.value as Record<string, string>)[name]
	const holdsProc = (n: N) => namesOf(n).some((name) => s.process(kidOf(n, name)))
	// a node's infos, but the status the stand-in keeps among them
	const infosOf = (n: N) =>
		Object.entries((n.attributes?.value ?? {}) as Record<string, unknown>).filter(([k]) =>
			k !== STATUS
		)

	// what a process's latest run read, as ids: each node whose value or info it read, or whose
	// names it listed (a step of a walk, one name, is left out: it only passes through)
	function readsOf(id: string, _a?: Address): { ids: Set<string>; reads: Read[] } {
		const run = runs.get(id)
		const had = edges.get(id)
		if (had && had.run === run) return had
		const ids = new Set<string>()
		const reads: Read[] = []
		for (const r of run?.reads ?? []) {
			if (r.part === "children" && r.path?.length) continue
			if (r.part === "attributes" && r.path?.[0] === STATUS) continue
			ids.add(r.id)
			reads.push(r)
		}
		const e = { run, ids, reads }
		edges.set(id, e)
		return e
	}
	// the map and the 3d space draw from one model built with the same reads
	const ctx: Ctx = {
		look,
		kind,
		isFolded,
		isOpened: (k) => opened.has(k),
		records: () => true,
		newest,
		prevTimes: () => times,
		key,
		readsOf,
		picked: () => picked,
		pick: (a, k, id) => pick(a, k, id),
		fold: (c: Card) => {
			if (c.folded) (folded.delete(c.key), opened.add(c.key))
			else (opened.delete(c.key), folded.add(c.key))
			draw()
		},
		status: (c) => {
			if (!c.node) return ""
			const st = statusOf(look(c.address)[c.k]?.versions)
			return st.error ? "error" : st.loop ? "loop" : st.pending !== undefined ? "pending" : ""
		},
		run: (c) => (c.k === 0 ? runs.get(c.id)?.run : undefined),
		value: (c) => {
			const v = first(look(c.address)[c.k]?.versions)
			return v === undefined ? undefined : shown(v, 22)
		},
		hit: (c) => {
			const q = search.value.trim().toLowerCase()
			return !!q && (c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
		},
		time: () => s.clock.time,
		h: h as Ctx["h"],
	}
	const mapv = mapView(ctx)
	const spacev = spaceView(ctx)
	const w = s.world()
	const roots = rootsOf(w.scheduler, [w.scope])
	const shapev = shapeView({
		read: (m) => readShape(roots.roots(), m, nameOf),
		place(id) {
			setView("map")
			show(id)
		},
	})
	mapv.el.style.display = spacev.el.style.display = shapev.el.style.display = "none"
	box.insertBefore(mapv.el, detail)
	box.insertBefore(spacev.el, detail)
	box.insertBefore(shapev.el, detail)
	function setView(v: View) {
		view = v
		for (const t of Object.keys(tabs) as View[]) tabs[t].classList.toggle("on", t === v)
		tree.style.display = v === "tree" ? "" : "none"
		mapv.el.style.display = v === "map" ? "" : "none"
		spacev.el.style.display = v === "3d" ? "" : "none"
		shapev.el.style.display = v === "scheduler" ? "" : "none"
		fitBtn.style.display = v === "tree" ? "none" : ""
		exSl.style.display = v === "3d" ? "" : "none"
		procsOnly.style.display = v === "tree" ? "" : "none"
		tools.style.display = legend.style.display = v === "scheduler" ? "none" : ""
		draw()
		if (v === "map") mapv.fit()
	}
	fitBtn.onclick = () =>
		view === "map" ? mapv.fit() : view === "scheduler" ? shapev.fit() : spacev.reframe()
	exRange.oninput = () => spacev.setExplode(+exRange.value)
	function drawView() {
		if (view === "scheduler") {
			// the places' names still come from a places walk: build it, draw the scheduler
			where = buildModel(ctx, root, false).where
			return shapev.draw()
		}
		const m: Model = buildModel(ctx, root, view === "3d")
		where = m.where
		times = m.times
		if (view === "map") mapv.render(m)
		else spacev.render(m)
		stat.textContent = `${m.cards.length} cards${
			m.capped ? " (capped)" : ""
		} · ${m.procs.length} processes · t${s.clock.time}`
		const seen = m.procs.map((x) => ({ id: x.id, a: x.a }))
		if (picked) detailOf(picked, seen)
		else if (!detail.childElementCount) detail.append(h("div", "tip", "pick a card."))
	}

	function draw() {
		if (view !== "tree") return drawView()
		const q = search.value.trim().toLowerCase()
		const frag = document.createDocumentFragment()
		const seenWhere = new Map<string, Address[]>()
		const seenTimes = new Map<string, number>()
		const seenProcs: { id: string; a: Address }[] = []
		const rowsById = new Map<string, HTMLElement[]>()
		let rows = 0
		const walk = (a: Address, name: string, depth: number) => {
			if (rows > 4000) return
			const items = look(a)
			items.forEach((it, k) => {
				const id = it.id
				const n = it.node
				const list = seenWhere.get(id) ?? []
				const mount = list.length > 0
				list.push(a)
				seenWhere.set(id, list)
				const kd = kind(id, n)
				if (kd === "proc" && !mount && k === 0) seenProcs.push({ id, a })
				const kids = n ? namesOf(n) : []
				const fold = isFolded(a, k, depth, name)
				const hidden = onlyProcs && kd !== "proc" && !(n && holdsProc(n)) && depth > 0 &&
					!(kids.length && !fold)
				if (!hidden) {
					const r = h("div", "r")
					for (let d = 0; d < depth; d++) r.append(h("span", "g"))
					const canOpen = kids.length > 0 && !mount && k === 0
					const tw = h("span", "tw", canOpen ? (fold ? "▸" : "▾") : "")
					tw.onclick = (e) => {
						e.stopPropagation()
						const kk = key(a, k)
						if (fold) (folded.delete(kk), opened.add(kk))
						else (opened.delete(kk), folded.add(kk))
						draw()
					}
					r.append(tw)
					if (kd === "proc") r.append(h("span", "ok", "⚙"))
					if (kd === "fn") r.append(h("span", "vfn", "ƒ"))
					r.append(
						h(
							"span",
							"nm" + (kd === "eph" ? " eph" : ""),
							name === "/" ? "root" : unescaped(name),
						),
					)
					if (items.length > 1) r.append(h("span", "k", `${k + 1}/${items.length}`))
					if (it.refused) r.append(h("span", "pill err", "refused"))
					else if (!n) r.append(h("span", "dim", "not loaded"))
					else {
						if (kd === "proc") {
							const st = statusOf(it.versions)
							if (st.error) r.append(h("span", "pill err", "error"))
							else if (st.loop) r.append(h("span", "pill err", "loop"))
							else if (st.pending !== undefined) r.append(h("span", "pill pend", "pending"))
							const run = k === 0 && !mount ? runs.get(id) : undefined
							if (run?.run !== undefined) r.append(h("span", "k", `run ${run.run}`))
						}
						const v = first(it.versions)
						if (kd !== "fn" && v !== undefined) r.append(shown(v))
						for (const [ik, iv] of infosOf(n)) {
							const span = h("span", "k", `${ik}=`)
							span.append(shown(iv, 14))
							r.append(span)
						}
						if (mount) r.append(h("span", "ph", `↺ same node as ${pathOf(list[0])}`))
						if (k > 0 && kids.length) r.append(h("span", "dim", "off-path"))
						if (fold && canOpen) r.append(h("span", "k", `${kids.length} inside`))
						const t = newest(n)
						seenTimes.set(id, t)
						const was = times.get(id)
						if (was !== undefined && t > was) r.classList.add("flash")
					}
					r.append(h("span", "id", id))
					if (q && (name.toLowerCase().includes(q) || id.toLowerCase().includes(q))) {
						r.classList.add("hit")
					}
					if (picked && picked.id === id && key(picked.address, picked.k) === key(a, k)) {
						r.classList.add("sel")
					}
					r.onclick = () => pick(a, k, id)
					frag.append(r)
					const rs = rowsById.get(id) ?? []
					rs.push(r)
					rowsById.set(id, rs)
					rows++
				}
				if (!n || mount || k > 0 || (fold && !q)) return
				for (const child of kids) walk([...a, child], child, depth + 1)
			})
		}
		walk(root, root[root.length - 1], 0)
		where = seenWhere
		times = seenTimes

		// the picked node's edges: what it reads, and the processes that read it
		if (picked) {
			const mark = (id: string, cls: string, tag: string) => {
				for (const r of rowsById.get(id) ?? []) {
					if (r.classList.contains("sel")) continue
					r.classList.add(cls)
					r.insertBefore(
						h("span", `tag ${cls === "reads" ? "rd" : "rb"}`, tag),
						r.querySelector(".id"),
					)
				}
			}
			const mine = kind(picked.id, look(picked.address)[picked.k]?.node) === "proc"
				? readsOf(picked.id).ids
				: new Set<string>()
			for (const id of mine) mark(id, "reads", "read")
			for (const p of seenProcs) {
				if (p.id !== picked.id && readsOf(p.id).ids.has(picked.id)) {
					mark(p.id, "readby", "reads it")
				}
			}
		}

		const top = tree.scrollTop
		tree.replaceChildren(frag)
		tree.scrollTop = top
		stat.textContent = `${rows} nodes · ${seenProcs.length} processes · t${s.clock.time}`
		if (picked) detailOf(picked, seenProcs)
		else if (!detail.childElementCount) {
			detail.append(h("div", "tip", ""))
			;(detail.firstChild as HTMLElement).innerHTML =
				`<b>pick a node.</b> you'll see where it sits, every
				version and who made it, and — lit in the tree — what it reads and who reads it.<br>
				<span class="ok">⚙</span> process · <span class="vfn">ƒ</span> handler · <i>italic</i> ephemeral, never kept ·
				<span class="ph">↺</span> the same node placed again`
		}
	}

	// the detail pane

	let detailKey = ""
	// pick a node by id, where the last draw saw it
	function show(id: string) {
		const a = where.get(id)?.[0]
		if (a) pick(a, Math.max(0, look(a).findIndex((x) => x.id === id)), id)
	}
	function pick(a: Address, k: number, id: string) {
		picked = { address: a, k, id }
		detailKey = ""
		draw()
	}

	function detailOf(
		p: { address: Address; k: number; id: string },
		seenProcs: { id: string; a: Address }[],
	) {
		const it = look(p.address)[p.k]
		const t = it?.node ? newest(it.node) : -1
		const dk = `${key(p.address, p.k)}@${t}@${s.clock.time}`
		if (dk === detailKey) return
		if (detail.contains(document.activeElement) && document.activeElement?.tagName !== "BUTTON") {
			return
		}
		detailKey = dk
		const top = detail.scrollTop
		detail.replaceChildren(...detailParts(p, it, seenProcs))
		detail.scrollTop = top
	}

	function chipTo(id: string, cls = "") {
		const c = h("span", "chip " + cls, nameOf(id))
		c.title = id
		c.onclick = () => {
			const a = where.get(id)?.[0]
			if (a) pick(a, Math.max(0, look(a).findIndex((x) => x.id === id)), id)
		}
		return c
	}

	function detailParts(
		p: { address: Address; k: number; id: string },
		it: Item | undefined,
		seenProcs: { id: string; a: Address }[],
	): HTMLElement[] {
		const out: HTMLElement[] = []
		const head = h("h3")
		head.append(
			h("span", "", pathOf(p.address) + (p.k ? ` (${p.k + 1})` : "")),
			h("span", "k", p.id),
		)
		out.push(head)
		if (!it || it.id !== p.id) {
			out.push(h("div", "dim", "no longer here"))
			return out
		}
		if (it.refused) {
			out.push(h("div", "err", `refused: ${json(it.refused)}`))
			return out
		}
		const n = it.node
		if (!n) {
			out.push(h("div", "dim", "not loaded"))
			return out
		}
		const kd = kind(p.id, n)
		const tags = h("div", "row2")
		if (kd === "proc") tags.append(h("span", "pill ok", "process"))
		if (kd === "fn") tags.append(h("span", "pill vfn", "handler: a function held as a value"))
		if (s.ephemeral(p.id)) tags.append(h("span", "pill pend", "ephemeral: never kept"))
		const placed = where.get(p.id) ?? [p.address]
		if (placed.length > 1) tags.append(h("span", "pill err", `one node, ${placed.length} places`))
		if (p.k > 0) tags.append(h("span", "pill pend", `${p.k + 1}th id under this name: off-path`))
		out.push(tags)

		// actions
		const msg = h("div", "msg")
		const act = (f: () => unknown) => {
			try {
				msg.textContent = ""
				const r = f()
				msg.className = "ok"
				if (r !== undefined) msg.textContent = `→ ${cut(json(r), 200)}`
			} catch (e) {
				msg.className = "msg"
				msg.textContent = String((e as Error).message ?? e)
			}
			detailKey = ""
			draw()
		}

		// a process: status, what it reads and who reads it, its latest run, kill and replace
		if (kd === "proc") {
			const st = statusOf(it.versions)
			if (Object.keys(st).length) {
				out.push(h("div", st.error || st.loop ? "err" : "pend", cut(json(st), 300)))
			}
			const row = h("div", "row2")
			const kill = h("button", "", "kill (outro)")
			kill.onclick = () => act(() => void s.outro(p.id))
			const rep = h("button", "", "replace")
			rep.onclick = () => act(() => void s.replace({ address: p.address }))
			row.append(kill, rep)
			out.push(row, msg)
			if (p.k === 0) {
				const e = readsOf(p.id)
				const run = runs.get(p.id)
				out.push(
					h("h4", "", `reads · from its latest run (${run?.run ?? "?"}, ${run?.ended ?? ""})`),
				)
				const d = h("div")
				for (const id of e.ids) {
					const parts = e.reads.filter((r) => r.id === id).map((r) =>
						r.part === "children" ? "names" : r.part === "attributes" ? "info" : "value"
					)
					const c = chipTo(id, "rd")
					c.title = `${id}: ${[...new Set(parts)].join(", ")}`
					d.append(c)
				}
				if (!e.reads.length) {
					d.append(h("span", "dim", "nothing tracked: it never reruns by itself"))
				}
				out.push(d)
				const by = run?.by
				out.push(
					h(
						"div",
						"k",
						by
							? `woken by a change ${nameOf(by)} made`
							: "a first run, or woken from outside",
					),
				)
			}
		}
		// anything: the processes that read it
		const readers = seenProcs.filter((q) => q.id !== p.id && readsOf(q.id).ids.has(p.id))
		if (readers.length) {
			out.push(
				h(
					"h4",
					"",
					`read by · ${readers.length} process${
						readers.length === 1 ? "" : "es"
					} rerun when it changes`,
				),
			)
			const d = h("div")
			for (const q of readers) d.append(chipTo(q.id, "rb"))
			out.push(d)
		}
		if (placed.length > 1) {
			out.push(h("h4", "", "placed at"))
			const d = h("div")
			for (const a of placed) {
				const c = h("span", "chip", pathOf(a))
				c.onclick = () => pick(a, Math.max(0, look(a).findIndex((x) => x.id === p.id)), p.id)
				d.append(c)
			}
			out.push(d)
		}
		if (kd === "fn" && p.k === 0) {
			const row = h("div", "row2")
			const args = h("input", "", undefined, { placeholder: "args as JSON (optional)" })
			args.style.flex = "1"
			const call = h("button", "", "call as host")
			call.onclick = () =>
				act(() =>
					s.call({
						address: p.address,
						args: args.value.trim() ? JSON.parse(args.value) : undefined,
					})
				)
			row.append(args, call)
			out.push(row, msg)
		}

		// the value (a process's status in front), the change that made it
		const vs = (it.versions ?? []) as V[]
		out.push(h("h4", "", "value"))
		if (!vs.length) out.push(h("div", "dim", "no value: a node holds children either way"))
		vs.forEach((v) => {
			const st = (v.because as { place?: string } | undefined)?.place === "status"
			const d = h("div", "ver" + (st ? " status" : ""))
			d.append(h("pre", "", pretty(v.content)))
			const c = v.change
			const site = c?.external?.[0]
			const cause = whoOf(c).cause
			const meta = [
				st ? "status, in front of the value" : "",
				tickOf(c) !== undefined ? `t${tickOf(c)}` : "",
				who(c, nameOf),
				cause !== undefined ? `because ${cut(json(cause), 40)}` : "",
				site ? `at ${site.file?.split("/").pop()}:${site.line}` : "",
			].filter(Boolean).join(" · ")
			d.append(h("div", "meta", meta))
			out.push(d)
		})
		if (kd !== "proc" && kd !== "fn") {
			const ta = h("textarea")
			ta.value = vs.length ? pretty(first(vs)) : ""
			const row = h("div", "row2")
			const write = h("button", "", "write as host")
			write.onclick = () => act(() => void s.write(p.address, whole(JSON.parse(ta.value))))
			row.append(write, h("span", "k", "one change; its readers wake"))
			out.push(ta, row, msg)
		}

		// infos
		const infos = infosOf(n)
		if (infos.length) {
			out.push(h("h4", "", "info"))
			for (const [name] of infos) {
				const iv = (s.info(p.address, name)[p.k]?.versions ?? []) as V[]
				const d = h("div", "ver")
				d.append(h("b", "", name), h("pre", "", pretty(first(iv))))
				const c = iv[0]?.change
				if (c) d.append(h("div", "meta", [`t${tickOf(c)}`, who(c, nameOf)].join(" · ")))
				out.push(d)
			}
		}

		// children: the id under each name
		const kids = namesOf(n)
		if (kids.length) {
			out.push(h("h4", "", "children"))
			const d = h("div")
			for (const name of kids) {
				const id = kidOf(n, name)
				const c = h("span", "chip", `${unescaped(name)} ${id}`)
				c.title = id
				c.onclick = () => pick([...p.address, name], 0, id)
				d.append(c)
			}
			out.push(d)
		}
		return out
	}

	// activity: the scheduler's moments, in words, a dashed line between requests

	const lines: Moment[] = []
	s.hear((m: Moment) => {
		if ("due" in m) woken.set(m.due, m.by)
		if ("ends" in m && m.part !== "load" && m.ended !== "stopped") {
			const run: Run = { run: m.run, ended: m.ended, reads: m.reads, wrote: m.wrote }
			const by = woken.get(m.ends)
			runs.set(m.ends, by === undefined ? run : { ...run, by })
		}
		if ("gone" in m) (runs.delete(m.gone), woken.delete(m.gone), edges.delete(m.gone))
		if (height) lines.push(m)
	})
	let lastRound = -1
	function flushMoments() {
		if (!lines.length) return
		const t = s.clock.time
		if (t !== lastRound) {
			mo.append(h("div", "round", `— t${t}`))
			lastRound = t
		}
		for (const m of lines.splice(0)) {
			let id = ""
			let d: HTMLElement
			if ("due" in m) {
				id = m.due
				d = h(
					"div",
					"k",
					`  ${nameOf(m.due)} is due (a change it read${m.by ? `, by ${nameOf(m.by)}` : ""})`,
				)
			} else if ("starts" in m) {
				id = m.starts
				d = h(
					"div",
					"",
					`⚙ ${nameOf(m.starts)} runs (run ${m.run}${
						m.part === "load" ? ", finding its program" : ""
					})`,
				)
			} else if ("call" in m) {
				id = m.call
				d = h("div", "", `ƒ ${nameOf(m.call)} on/${m.handler} called`)
			} else if ("called" in m) {
				if (m.ended !== "failed") continue
				id = m.called
				d = h("div", "err", `  ${nameOf(m.called)} on/${m.handler} → failed`)
			} else if ("ends" in m) {
				id = m.ends
				const c = m.ended === "failed" || m.ended === "looping"
					? "err"
					: m.ended === "pending" || m.ended === "stopped"
					? "pend"
					: "ok"
				const how = m.ended === "done"
					? (m.equal ? "done, same value: readers sleep" : "done")
					: m.ended
				d = h(
					"div",
					c,
					`  ${nameOf(m.ends)} → ${how}${m.waits ? `, waits for ${nameOf(m.waits)}` : ""}`,
				)
			} else continue
			d.onclick = () => {
				const a = where.get(id)?.[0]
				if (a) pick(a, Math.max(0, look(a).findIndex((x) => x.id === id)), id)
			}
			mo.append(d)
		}
		while (mo.childElementCount > 400) mo.firstElementChild!.remove()
		mo.scrollTop = mo.scrollHeight
	}

	search.oninput = () => draw()
	foldAll.onclick = () => {
		opened.clear()
		folded.clear()
		draw()
	}
	procsOnly.onclick = () => {
		onlyProcs = !onlyProcs
		procsOnly.classList.toggle("on", onlyProcs)
		draw()
	}

	let drawn = -1
	let at = 0
	let stopped = false
	const tick = (now: number) => {
		if (stopped) return
		if (box.offsetParent !== null && s.clock.time !== drawn && now - at > 120) {
			drawn = s.clock.time
			at = now
			if (o.pick && !picked) {
				const it = look(o.pick)[0]
				if (it) picked = { address: o.pick, k: 0, id: it.id }
			}
			draw()
		}
		flushMoments()
		travel?.update()
		requestAnimationFrame(tick)
	}
	requestAnimationFrame(tick)
	// stop: no more drawing, the panel taken out (a demo that swaps schedulers mounts a new one)
	const stop = () => {
		stopped = true
		roots.stop()
		box.remove()
	}
	return { draw, pick, show, nameOf, stop }
}

// the travel row: ⟲, a slider over the host's moments (resting on now), the picked one's label.
// dragging only shows where you would land; letting go (or a key) goes there, once
function travelRow(t: Travel) {
	const el = h("div", "tt")
	const icon = h("span", "k", "⟲")
	const range = h("input", "", undefined, { type: "range", min: "0", max: "0", value: "0" })
	const label = h("span", "tl", "")
	el.title = "go back in time: pick a moment, the graph is set back to how it was then" +
		(t.note ? `. ${t.note}` : "")
	el.append(icon, range, label)
	let times: { time: number; label: string }[] = []
	let held = false
	let busy = false
	const say = (i: number) => {
		const m = times[i]
		const now = i === times.length - 1
		label.className = "tl" + (now ? "" : " back")
		label.textContent = m
			? (now ? `now · ${m.label}` : `back to t${m.time} · ${m.label}`)
			: "no history yet"
		label.title = m?.label ?? ""
	}
	const update = () => {
		if (held || busy) return
		const next = t.times()
		if (next.length === times.length && next.at(-1)?.time === times.at(-1)?.time) return
		times = next
		range.max = String(Math.max(0, times.length - 1))
		range.value = range.max
		range.disabled = times.length < 2
		say(times.length - 1)
	}
	range.addEventListener("pointerdown", () => (held = true))
	range.oninput = () => say(+range.value)
	range.onchange = async () => {
		held = false
		const m = times[+range.value]
		if (!m || +range.value === times.length - 1) return say(times.length - 1)
		busy = true
		label.textContent = `going back to t${m.time}…`
		try {
			await t.go(m.time)
			busy = false
			times = []
			update()
		} catch (e) {
			busy = false
			label.className = "tl bad"
			label.textContent = String((e as Error).message ?? e)
			label.title = label.textContent
		}
	}
	return { el, update }
}

// a header button that shows and hides a panel
export function toggle(button: HTMLElement, panel: HTMLElement, shown = true) {
	button.classList.add("view")
	if (button.textContent === "graph") button.textContent = "graph ▸"
	const set = (on: boolean) => {
		panel.style.display = on ? "" : "none"
		button.classList.toggle("on", on)
		if (button.textContent?.startsWith("graph")) button.textContent = on ? "graph ◂" : "graph ▸"
	}
	set(shown)
	button.addEventListener("click", () => set(panel.style.display === "none"))
}
