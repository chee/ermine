/// <reference lib="dom" />
// the explorer's other two ways of seeing the graph: a flat map and a 3d space. both are drawn from
// one small model the explorer builds from the host's reads (look / content / children / info,
// passed in by the inspector as a ctx; nothing here reads the scheduler itself).
//
// map: nodes as cards, the tree left to right, child edges thin, a node placed again (a mount) is
// one card with a second, dashed edge from its other parent, reads are curved arrows (process → what
// it read). 3d: the same tree in perspective; a name holding several ids stacks them one behind
// another in depth (reads are lists), read edges are glowing beams, an explode slider spreads the
// layers, drag to orbit.
type Address = string[]
// deno-lint-ignore no-explicit-any
type Node = any
type Item = { id: string; node?: Node; refused?: unknown }

// the names in a node: its children entry's value maps each name to one id
export function namesOf(n: Node): string[] {
	const v = n?.children?.value
	if (v === null || typeof v !== "object") return []
	return Object.keys(v).filter((k) => typeof v[k] === "string")
}

export type Card = {
	key: string
	id: string
	name: string
	address: Address
	k: number
	count: number
	depth: number
	kind: string
	node?: Node
	refused?: boolean
	parent?: Card
	kids: Card[]
	front?: Card
	more: number
	folded: boolean
	canOpen: boolean
	t: number
	fresh: boolean
	x: number
	y: number
}
export type Link = { from: Card; to: Card; kind: "child" | "mount" }
export type Model = {
	cards: Card[]
	home: Map<string, Card>
	links: Link[]
	procs: { id: string; a: Address; card: Card }[]
	where: Map<string, Address[]>
	times: Map<string, number>
	capped: boolean
}
export type Read = { id: string; from: Card; to: Card; fy: number; ty: number }

export type Ctx = {
	look: (a: Address) => Item[]
	kind: (id: string, n: Item["node"]) => string
	isFolded: (a: Address, k: number, depth: number, name: string) => boolean
	isOpened: (key: string) => boolean
	records: () => boolean
	newest: (n: Node) => number
	prevTimes: () => Map<string, number>
	key: (a: Address, k: number) => string
	readsOf: (id: string, a: Address) => { ids: Set<string> }
	picked: () => { address: Address; k: number; id: string } | undefined
	pick: (a: Address, k: number, id: string) => void
	fold: (c: Card) => void
	status: (c: Card) => string
	run: (c: Card) => number | undefined
	value: (c: Card) => HTMLElement | undefined
	hit: (c: Card) => boolean
	time: () => number
	h: (
		tag: "div" | "span" | "button" | "input",
		cls?: string,
		text?: string,
		attrs?: Record<string, string>,
	) => HTMLElement
}

export const W = 150
export const H = 40
const COL = 196
const ROW = 50
const CAP = 520
const PER = 40
const STACK = 8

export function buildModel(c: Ctx, root: Address, deep: boolean): Model {
	const m: Model = {
		cards: [],
		home: new Map(),
		links: [],
		procs: [],
		where: new Map(),
		times: new Map(),
		capped: false,
	}
	const prev = c.prevTimes()
	const walk = (
		a: Address,
		name: string,
		depth: number,
		parent: Card | undefined,
		parentProc: boolean,
		crowded = false,
	) => {
		const items = c.look(a)
		let front: Card | undefined
		for (let k = 0; k < items.length; k++) {
			const it = items[k]
			const n = it.node
			const id = it.id
			const list = m.where.get(id) ?? []
			const mount = list.length > 0
			list.push(a)
			m.where.set(id, list)
			if (mount) {
				const home = m.home.get(id)
				if (home && parent && home !== parent) {
					m.links.push({ from: parent, to: home, kind: "mount" })
				}
				continue
			}
			if (k >= STACK) break
			if (m.cards.length >= CAP) {
				m.capped = true
				if (parent) parent.more++
				continue
			}
			const kd = c.kind(id, n)
			const kidNames = n ? namesOf(n) : []
			const ckey = c.key(a, k)
			const folded = kidNames.length > 0 && k === 0 &&
				(c.isFolded(a, k, depth, name) || (crowded && !c.isOpened(ckey)))
			const t = n ? c.newest(n) : 0
			const was = prev.get(id)
			m.times.set(id, t)
			const card: Card = {
				key: c.key(a, k),
				id,
				name: name === "/" ? "root" : name,
				address: a,
				k,
				count: items.length,
				depth,
				kind: kd,
				node: n,
				refused: !!it.refused,
				parent,
				kids: [],
				more: 0,
				folded,
				canOpen: kidNames.length > 0 && k === 0,
				t,
				fresh: was !== undefined && t > was,
				x: 0,
				y: 0,
			}
			if (k === 0) front = card
			else card.front = front
			m.cards.push(card)
			m.home.set(id, card)
			if (parent) {
				parent.kids.push(card)
				m.links.push({ from: parent, to: card, kind: "child" })
			}
			if (kd === "proc" && k === 0) m.procs.push({ id, a, card })
			if (!n || k > 0 || folded) continue
			// a big list wraps into a grid, so what its members hold stays folded until opened
			const total = kidNames.length
			for (const kid of kidNames) {
				if (card.kids.length >= PER) {
					card.more++
					continue
				}
				walk([...a, kid], kid, depth + 1, card, kd === "proc", total > 8)
			}
		}
	}
	walk(root, root[root.length - 1], 0, undefined, false)
	// layout: across by depth, down by leaf row. in deep mode the later ids of a name sit behind
	let row = 0
	const place = (card: Card) => {
		card.x = card.depth * COL
		const real = card.kids.filter((x) => !(deep && x.k > 0))
		const leaves = real.filter((x) => !x.kids.length)
		if (real.length > 8 && leaves.length > 6) {
			// a big list wraps into a grid of columns, so the map is about as wide as tall; the
			// kids that hold things follow below as rows
			const cols = Math.ceil(Math.sqrt(leaves.length / 3))
			const per = Math.ceil(leaves.length / cols)
			leaves.forEach((kid, i) => {
				kid.x = kid.depth * COL + Math.floor(i / per) * (W + 12)
				kid.y = (row + (i % per)) * ROW
			})
			row += per
			for (const kid of real) if (kid.kids.length) place(kid)
			const ys = real.map((x) => x.y)
			card.y = (Math.min(...ys) + Math.max(...ys)) / 2
		} else {
			for (const kid of real) place(kid)
			if (!real.length) card.y = row++ * ROW
			else card.y = (real[0].y + real[real.length - 1].y) / 2
		}
		if (deep) { for (const kid of card.kids) if (kid.k > 0) kid.y = kid.front?.y ?? card.y }
	}
	if (m.cards[0]) place(m.cards[0])
	return m
}

// the read edges: for the picked process what it reads, for the picked node who reads it; with
// nothing picked every process's reads, faint
export function readEdges(c: Ctx, m: Model) {
	const p = c.picked()
	const mine = new Set<string>()
	const readers = new Set<string>()
	const edges: (Read & { cls: string })[] = []
	let n = 0
	for (const pr of m.procs) {
		if (n++ > 220) break
		const ids = c.readsOf(pr.id, pr.a).ids
		const isPicked = p && p.id === pr.id
		for (const id of ids) {
			const to = m.home.get(id)
			if (!to || to === pr.card) continue
			if (isPicked) mine.add(id)
			const readerOfPicked = p && id === p.id
			if (readerOfPicked) readers.add(pr.id)
			edges.push({
				id: pr.id,
				from: pr.card,
				to,
				fy: 0,
				ty: 0,
				cls: isPicked ? "rd" : readerOfPicked ? "rb" : p ? "faint" : "all",
			})
		}
	}
	// fan the ends out along each card's edge so every arrow stays visible
	const fan = (key: "from" | "to", off: "fy" | "ty") => {
		const by = new Map<Card, typeof edges>()
		for (const e of edges) by.set(e[key], [...(by.get(e[key]) ?? []), e])
		for (const list of by.values()) {
			list.sort((a, b) => (key === "from" ? a.to.y - b.to.y : a.from.y - b.from.y))
			list.forEach((e, i) => (e[off] = ((i + 0.5) / list.length - 0.5) * (H - 10)))
		}
	}
	fan("from", "fy")
	fan("to", "ty")
	return { mine, readers, edges }
}

function cardEl(c: Ctx, card: Card, marks: ReturnType<typeof readEdges>, cls: string) {
	const { h } = c
	const p = c.picked()
	const e = h("div", `mc ${cls} k-${card.kind || "data"}`)
	if (p && p.id === card.id && c.key(p.address, p.k) === card.key) e.classList.add("sel")
	else if (marks.mine.has(card.id)) e.classList.add("reads")
	else if (marks.readers.has(card.id)) e.classList.add("readby")
	if (c.hit(card)) e.classList.add("hit")
	if (card.fresh) e.classList.add("pulse")
	if (card.node && c.newest(card.node) === c.time() && c.time() > 0) e.classList.add("now")
	e.dataset.key = card.key
	const top = h("div", "mt")
	top.append(h("span", "mi", card.kind === "proc" ? "⚙" : card.kind === "fn" ? "ƒ" : ""))
	top.append(h("span", "mn" + (card.kind === "eph" ? " eph" : ""), card.name))
	if (card.count > 1) top.append(h("span", "mk", `${card.k + 1}/${card.count}`))
	if (card.kind === "proc") {
		const st = c.status(card)
		if (st) top.append(h("span", `mp ${st}`, st))
		const r = c.run(card)
		if (r !== undefined) top.append(h("span", "mk", `r${r}`))
	}
	e.append(top)
	const bot = h("div", "mb")
	if (card.refused) bot.append(h("span", "err", "refused"))
	else if (!card.node) bot.append(h("span", "dim", "not loaded"))
	else if (card.kind !== "fn") {
		const v = c.value(card)
		if (v) bot.append(v)
	}
	if (card.more) bot.append(h("span", "mk", ` +${card.more}`))
	e.append(bot)
	if (card.canOpen) {
		const f = h("span", "mf", card.folded ? "▸" : "▾")
		f.dataset.fold = card.key
		e.append(f)
	}
	return e
}

export const viewsCss = `
.ex .vtabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); background: var(--cream); }
.ex .vtabs button { flex: none; padding: 0 10px; font-size: 11px; border: 0; border-right: 1px solid var(--line); color: var(--ink); box-shadow: none; background: transparent; line-height: 18px; cursor: pointer; }
.ex .vtabs button.on { background: var(--lemon); font-weight: bold; }
.ex .vtabs .sp { flex: 1; }
.ex .vtabs .sl { display: flex; align-items: center; gap: 4px; padding: 0 6px; color: var(--soft); }
.ex .vtabs input[type=range] { width: 90px; padding: 0; }
.ex .vw { flex: 1 1 55%; min-height: 80px; position: relative; overflow: hidden; background: var(--paper); cursor: grab; touch-action: none; user-select: none; }
.ex .vw.drag { cursor: grabbing; }
.ex .vw .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.ex .vw svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.ex .vw .help { position: absolute; right: 4px; bottom: 2px; color: var(--soft); font-size: 10px; pointer-events: none; background: var(--paper); padding: 0 3px; }
.ex .mc { position: absolute; width: ${W}px; height: ${H}px; background: #fff; border: 1px solid var(--line); box-shadow: 2px 2px 0 var(--line); padding: 2px 4px; overflow: hidden; cursor: pointer; font: 10px/1.3 var(--mono); }
.ex .mc:hover { background: var(--lemon); }
.ex .mc .mt, .ex .mc .mb { display: flex; gap: 4px; align-items: baseline; white-space: nowrap; overflow: hidden; }
.ex .mc .mb { color: var(--soft); }
.ex .mc .mb > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ex .mc .mn { font-weight: bold; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
.ex .mc .mi { color: var(--leaf); }
.ex .mc .mk { color: var(--soft); font-size: 9px; flex: none; }
.ex .mc .mp { font-size: 9px; border: 1px solid currentColor; padding: 0 3px; flex: none; }
.ex .mc .mp.pending { color: #b07800; } .ex .mc .mp.error, .ex .mc .mp.loop { color: var(--cherry); }
.ex .mc .mf { position: absolute; right: 0; top: 0; padding: 0 4px; color: var(--ink); background: var(--cream); border-left: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.ex .mc.k-proc { background: #f1ffe8; } .ex .mc.k-fn { background: #f6ecff; } .ex .mc.k-eph { border-style: dashed; background: #fffdf2; }
.ex .mc.sel { background: var(--lemon); outline: 2px solid var(--ink); z-index: 3; }
.ex .mc.reads { outline: 2px solid var(--sky); background: #e8f0ff; }
.ex .mc.readby { outline: 2px solid var(--cherry); background: #ffe8ec; }
.ex .mc.hit { outline: 2px solid var(--cherry); outline-offset: 1px; }
.ex .mc.pulse { animation: exflash 1.4s ease-out; }
.ex .mc.s3 { backface-visibility: visible; }
.ex .mp3 { stroke: var(--line); }
.ex .vw path { fill: none; vector-effect: non-scaling-stroke; }
.ex .vw path.ch { stroke: #777; stroke-width: 1px; }
.ex .vw path.mo { stroke: #777; stroke-width: 1px; stroke-dasharray: 4 3; }
.ex .vw path.ch.pulse, .ex .vw path.mo.pulse { stroke: var(--cherry); stroke-width: 2px; stroke-dasharray: 6 4; animation: exdash 1.2s linear 2; }
@keyframes exdash { to { stroke-dashoffset: -20; } }
.ex .vw path.rd { stroke: var(--sky); stroke-width: 2.5px; }
.ex .vw path.rb { stroke: var(--cherry); stroke-width: 2.5px; }
.ex .vw path.all { stroke: var(--sky); stroke-width: 1px; opacity: .3; }
.ex .vw path.faint { stroke: var(--sky); stroke-width: 1px; opacity: .1; }
.ex .scene3 { position: absolute; left: 50%; top: 50%; transform-style: preserve-3d; width: 0; height: 0; }
.ex .scene3, .ex .scene3 * { transform-style: preserve-3d; }
.ex .bm { position: absolute; height: 2px; transform-origin: 0 50%; pointer-events: none; }
.ex .bm.ch { background: #555; height: 1px; }
.ex .bm.mo { background: repeating-linear-gradient(90deg, #555 0 4px, transparent 4px 7px); height: 1px; }
.ex .bm.pulse { background: var(--cherry); height: 2px; }
.ex .bm.rd, .ex .bm.rb, .ex .bm.all, .ex .bm.faint { height: 3px; }
.ex .bm.rd { background: var(--sky); box-shadow: 0 0 6px 2px var(--sky); }
.ex .bm.rb { background: var(--cherry); box-shadow: 0 0 6px 2px var(--cherry); }
.ex .bm.all { background: var(--sky); box-shadow: 0 0 4px 1px var(--sky); opacity: .5; }
.ex .bm.faint { background: var(--sky); opacity: .1; }
`

const SVGNS = "http://www.w3.org/2000/svg"
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) => {
	const e = document.createElementNS(SVGNS, tag)
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
	return e
}
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))

// pulsing edges: from each freshly changed card up to the root
function pulsing(m: Model) {
	const out = new Set<Card>()
	for (const card of m.cards) {
		if (!card.fresh) continue
		for (let x: Card | undefined = card; x && !out.has(x); x = x.parent) out.add(x)
	}
	return out
}

// shared pointer handling: drag moves (dx, dy), wheel zooms, a press without a drag picks the card
export function gestures(
	el: HTMLElement,
	on: {
		drag: (dx: number, dy: number, e: PointerEvent) => void
		wheel: (dy: number, e: WheelEvent) => void
		tap: (t: HTMLElement | null) => void
	},
) {
	let down: { x: number; y: number; t: HTMLElement | null; moved: boolean } | undefined
	el.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 && e.button !== 1) return
		down = { x: e.clientX, y: e.clientY, t: e.target as HTMLElement, moved: false }
	})
	addEventListener("pointermove", (e) => {
		if (!down) return
		const dx = e.clientX - down.x
		const dy = e.clientY - down.y
		if (!down.moved && Math.hypot(dx, dy) < 4) return
		if (!down.moved) el.classList.add("drag")
		down.moved = true
		down.x = e.clientX
		down.y = e.clientY
		on.drag(dx, dy, e)
	})
	addEventListener("pointerup", () => {
		if (!down) return
		el.classList.remove("drag")
		if (!down.moved) on.tap(down.t)
		down = undefined
	})
	el.addEventListener("wheel", (e) => {
		e.preventDefault()
		on.wheel(e.deltaY, e)
	}, { passive: false })
}

export function mapView(c: Ctx) {
	const { h } = c
	const el = h("div", "vw")
	const world = h("div", "world")
	const lines = svg("svg", { width: "1", height: "1" })
	const defs = svg("defs")
	for (const [id, col] of [["rd", "#3d6fd8"], ["rb", "#ff2284"], ["all", "#3d6fd8"]]) {
		const mk = svg("marker", {
			id: `ar-${id}`,
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
	const help = h("div", "help", "drag: pan · wheel: zoom · click: pick · ▸ folds")
	el.append(world, help)
	let v = { x: 16, y: 16, k: 1 }
	let model: Model | undefined
	let fitted = false
	let moved = false
	const apply = () => (world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`)
	// fit: everything if it reads at >= 0.9 (text >= 10px), scaled up to 1.6; else the picked
	// node's neighbourhood (itself, its parent, kids, what it reads and who reads it)
	const MINK = 0.9
	const fit = () => {
		if (!model?.cards.length || !el.clientWidth) return
		const w = el.clientWidth - 32, hh = el.clientHeight - 32
		const bounds = (cs: Card[]) => {
			let a = 1e9, b = 1e9, c = -1e9, d = -1e9
			for (const k of cs) {
				;(a = Math.min(a, k.x),
					b = Math.min(b, k.y),
					c = Math.max(c, k.x + W),
					d = Math.max(d, k.y + H))
			}
			return { a, b, c, d }
		}
		const place = (cs: Card[], lo: number, hi: number) => {
			const r = bounds(cs)
			const bw = r.c - r.a, bh = r.d - r.b
			const k = clamp(Math.min(w / bw, hh / bh), lo, hi)
			v = {
				k,
				x: (el.clientWidth - bw * k) / 2 - r.a * k,
				y: Math.max(16, (el.clientHeight - bh * k) / 2) - r.b * k,
			}
		}
		fitted = true
		moved = false
		const all = bounds(model.cards)
		if (Math.min(w / (all.c - all.a), hh / (all.d - all.b)) >= MINK) place(model.cards, MINK, 1.6)
		else {
			const p = c.picked()
			const me = (p && model.cards.find((x) => x.key === c.key(p.address, p.k))) ||
				model.cards[0]
			const near = new Set<Card>([me, ...me.kids])
			if (me.parent) near.add(me.parent)
			for (const e of readEdges(c, model).edges) {
				if (e.from === me || e.to === me) (near.add(e.from), near.add(e.to))
			}
			const r = bounds([...near])
			if (Math.min(w / (r.c - r.a), hh / (r.d - r.b)) >= MINK) place([...near], MINK, 1.1)
			else {
				// too much even for that: readable size, centred on the node
				v = {
					k: MINK,
					x: el.clientWidth / 2 - (me.x + W / 2) * MINK,
					y: el.clientHeight / 2 - (me.y + H / 2) * MINK,
				}
			}
		}
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
			const f = t?.closest<HTMLElement>("[data-fold]")
			const cardEl = t?.closest<HTMLElement>(".mc")
			const card = model?.cards.find((x) => x.key === cardEl?.dataset.key)
			if (!card) return
			if (f) c.fold(card)
			else c.pick(card.address, card.k, card.id)
		},
	})
	const edge = (a: Card, b: Card, bow = 0, fy = 0, ty = 0) => {
		const x1 = a.x + W, y1 = a.y + H / 2 + fy, x2 = b.x, y2 = b.y + H / 2 + ty
		if (!bow) {
			const mx = (x1 + x2) / 2
			return `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
		}
		// a read: from the reader's side to the read card's near side, bowed away from the tree
		const left = b.x + W < a.x
		const sx = left ? a.x : a.x + W, tx = left ? b.x + W : b.x
		const same = Math.abs(a.x - b.x) < 1
		if (same) {
			const o = 40
			return `M${a.x + W} ${y1}C${a.x + W + o} ${y1} ${a.x + W + o} ${y2} ${b.x + W} ${y2}`
		}
		const dx = tx - sx, dy = y2 - y1
		const len = Math.hypot(dx, dy) || 1
		const cx = (sx + tx) / 2 - dy / len * len * 0.25,
			cy = (y1 + y2) / 2 + dx / len * len * 0.25 * (dy > 0 ? -1 : 1)
		return `M${sx} ${y1}Q${cx} ${cy} ${tx} ${y2}`
	}
	return {
		el,
		fit,
		render(m: Model) {
			model = m
			const marks = readEdges(c, m)
			const pulse = pulsing(m)
			world.querySelectorAll(".mc,path").forEach((x) => x.remove())
			const paths: SVGElement[] = []
			for (const l of m.links) {
				const cls = `${l.kind === "mount" ? "mo" : "ch"}${
					pulse.has(l.to) && l.kind === "child" && l.to.fresh ||
						(pulse.has(l.to) && pulse.has(l.from) && l.kind === "child")
						? " pulse"
						: ""
				}`
				paths.push(svg("path", { class: cls, d: edge(l.from, l.to) }))
			}
			for (const r of marks.edges) {
				paths.push(svg("path", {
					class: r.cls,
					d: edge(r.from, r.to, 1, r.fy, r.ty),
					"marker-end": `url(#ar-${r.cls === "rb" ? "rb" : r.cls === "rd" ? "rd" : "all"})`,
				}))
			}
			lines.append(...paths)
			const frag = document.createDocumentFragment()
			for (const k of m.cards) {
				const e = cardEl(c, k, marks, "")
				e.style.left = `${k.x}px`
				e.style.top = `${k.y}px`
				frag.append(e)
			}
			world.append(frag)
			if (!fitted || !moved) fit()
		},
	}
}

export function spaceView(c: Ctx) {
	const { h } = c
	const el = h("div", "vw")
	const scene = h("div", "scene3")
	const world = h("div", "world3")
	world.style.cssText = "position:absolute;left:0;top:0;width:0;height:0"
	scene.append(world)
	el.append(scene, h("div", "help", "drag: orbit · shift-drag: pan · wheel: zoom · click: pick"))
	el.style.perspective = "1400px"
	let v = { rx: -16, ry: 22, k: 0.6, px: 0, py: 0 }
	let explode = 90
	let model: Model | undefined
	let center = { x: 0, y: 0, z: 0 }
	let first = true
	let moved3 = false
	let bx = 0, by = 0, bz = 0
	// frame the whole tree if it reads at k >= 0.8, scaled up to 1.6; else readable size, centred
	// on the picked node (or the root)
	const reframe = () => {
		moved3 = false
		if (!model?.cards.length || !el.clientWidth) return
		const fitk = Math.min(el.clientWidth / (bx + 60), el.clientHeight / (by + 60)) * 1.2
		if (fitk >= 0.8) {
			center = { x: bx / 2, y: by / 2, z: bz }
			v = { ...v, k: Math.min(fitk, 1.6), px: 0, py: 0 }
		} else {
			const p = c.picked()
			const me = (p && model.cards.find((x) => x.key === c.key(p.address, p.k))) ||
				model.cards[0]
			center = { x: me.x + W / 2, y: me.y + H / 2, z: zOf(me) }
			v = { ...v, k: 0.8, px: 0, py: 0 }
		}
		apply()
	}
	const apply = () => {
		scene.style.transform =
			`translate(${v.px}px,${v.py}px) scale(${v.k}) rotateX(${v.rx}deg) rotateY(${v.ry}deg) translate3d(${-center
				.x}px,${-center.y}px,${-center.z}px)`
	}
	gestures(el, {
		drag: (dx, dy, e) => {
			moved3 = true
			if (e.shiftKey) (v.px += dx, v.py += dy)
			else (v.ry += dx * 0.4, v.rx = clamp(v.rx - dy * 0.4, -90, 90))
			apply()
		},
		wheel: (
			dy,
		) => ((moved3 = true), (v.k = clamp(v.k * Math.exp(-dy * 0.0015), 0.1, 3)), apply()),
		tap: (t) => {
			const cardEl = t?.closest<HTMLElement>(".mc")
			const card = model?.cards.find((x) => x.key === cardEl?.dataset.key)
			if (!card) return
			if (t?.closest("[data-fold]")) c.fold(card)
			else c.pick(card.address, card.k, card.id)
		},
	})
	const zOf = (k: Card) => -(k.k * explode + k.depth * explode * 0.3)
	const beam = (a: [number, number, number], b: [number, number, number], cls: string) => {
		const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
		const len = Math.hypot(dx, dy, dz)
		const yaw = Math.atan2(dy, dx) * 180 / Math.PI
		const pitch = -Math.asin(dz / (len || 1)) * 180 / Math.PI
		const out: HTMLElement[] = []
		for (const roll of [0, 90]) {
			const e = h("div", `bm ${cls}`)
			e.style.width = `${len}px`
			e.style.transform = `translate3d(${a[0]}px,${a[1]}px,${
				a[2]
			}px) rotateZ(${yaw}deg) rotateY(${pitch}deg) rotateX(${roll}deg)`
			out.push(e)
			if (cls === "ch" || cls === "mo" || cls === "faint") break
		}
		return out
	}
	const pt = (
		k: Card,
		right: boolean,
		dy = 0,
	): [number, number, number] => [k.x + (right ? W : 0), k.y + H / 2 + dy, zOf(k)]
	return {
		el,
		reframe,
		setExplode(x: number) {
			explode = x
			if (model) this.render(model)
		},
		get explode() {
			return explode
		},
		render(m: Model) {
			model = m
			const marks = readEdges(c, m)
			const pulse = pulsing(m)
			let x1 = 0, y1 = 0, z1 = 0
			for (const k of m.cards) {
				;(x1 = Math.max(x1, k.x + W), y1 = Math.max(y1, k.y + H), z1 = Math.min(z1, zOf(k)))
			}
			bz = z1 / 2
			bx = x1
			by = y1
			if ((first || !moved3) && el.clientWidth) (first = false, reframe())
			apply()
			const frag = document.createDocumentFragment()
			for (const l of m.links) {
				const hot = l.kind === "child" && pulse.has(l.to) && (l.to.fresh || pulse.has(l.from))
				frag.append(
					...beam(
						pt(l.from, true),
						[l.to.x, l.to.y + H / 2, zOf(l.to)],
						hot ? "pulse" : l.kind === "mount" ? "mo" : "ch",
					),
				)
			}
			for (const r of marks.edges) {
				frag.append(...beam(pt(r.from, false, r.fy), pt(r.to, false, r.ty), r.cls))
			}
			for (const k of m.cards) {
				const e = cardEl(c, k, marks, "s3")
				e.style.transform = `translate3d(${k.x}px,${k.y}px,${zOf(k)}px)`
				frag.append(e)
			}
			world.replaceChildren(frag)
		},
	}
}
