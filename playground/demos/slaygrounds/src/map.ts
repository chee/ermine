/// <reference lib="dom" />
// the map: the tree from the root as cards left to right, drawn from the tree signal
// (solid-ermine.ts) with Solid 2.0's reactive core. no JSX and no template: plain SVG built
// inside effects, the cards and edges kept by key so only what changed is touched.
//   cards      sized to their text: name, an id tag, a value preview
//   edges      curved, child edges black; a mount is one card with a dashed second edge
//   pulses     a card whose change is new outlines in cherry, and a bright line travels up its
//              edges to the root
//   reads      arrows from a part to what its latest run read (blue, dotted); picked, what it
//              reads is lit blue and what reads it cherry
//   fold       a card with children has a toggle; folded, it hides its subtree and says how many.
//              reads and pulses of hidden cards attach to the folded card that hides them
//   move       dragging a card moves it and its subtree; each card keeps its own offset
// fold and offsets are the map's own view state, in memory here (never the program's, never in
// the graph), kept by card key, so they hold through reloads and are cleared with the world
import { createEffect, createMemo, createRoot, createSignal } from "@solidjs/signals"
import type { Card, Tree } from "./solid-ermine.ts"

// deno-lint-ignore no-explicit-any
type Any = any
export type Read = { from: string; to: string } // card keys: the reader, what it read
export type MapOptions = {
	tree: () => Tree | undefined
	picked: () => string | undefined
	pick: (key: string) => void
	// read arrows: reader card key -> card key of what it read
	reads?: () => Read[]
}

const NS = "http://www.w3.org/2000/svg"
const el = (tag: string, attrs: Record<string, string | number> = {}, text?: string) => {
	const e = document.createElementNS(NS, tag)
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
	if (text !== undefined) e.textContent = text
	return e
}

const ctx = document.createElement("canvas").getContext("2d")!
const width = (font: string, text: string) => ((ctx.font = font), ctx.measureText(text).width)
const NAME = "600 11px Jost, system-ui, sans-serif"
const TAG = "9px Monaco, ui-monospace, monospace"
const SUB = "10px Monaco, ui-monospace, monospace"
const H = 34, GAP_X = 44, GAP_Y = 6, PAD = 8

const short = (id: unknown) => String(id).slice(0, 6)
export function preview(v: unknown): string {
	if (v === undefined) return ""
	if (typeof v === "function") return "ƒ"
	if (typeof v === "object" && v !== null && "nodeType" in v) {
		const n = v as Node
		return n.nodeType === 3
			? JSON.stringify((n as Text).data)
			: `<${(n as Element).localName ?? "node"}>`
	}
	try {
		const s = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v))
		return s.length > 28 ? s.slice(0, 27) + "…" : s
	} catch {
		return String(v)
	}
}

type Placed = {
	card: Card
	x: number
	y: number
	w: number
	name: string
	tag: string
	sub: string
}

// which cards show: all but those under a folded card. rep: what stands for a card (itself if
// shown, else the folded card that hides it); hidden: how many a folded card hides
function visibility(t: Tree, folded: Set<string>) {
	const shown = new Set<Card>()
	const rep = new Map<Card, Card>()
	const hidden = new Map<Card, number>()
	for (const c of t.cards) {
		const vis = !c.up || (shown.has(c.up) && !folded.has(c.up.key))
		if (vis) (shown.add(c), rep.set(c, c))
		else {
			const r = shown.has(c.up!) ? c.up! : rep.get(c.up!)!
			rep.set(c, r)
			hidden.set(r, (hidden.get(r) ?? 0) + 1)
		}
	}
	return { shown, rep, hidden }
}

// a tidy tree: a column per depth (as wide as its widest card), leaves one row each, a parent
// centred on its children; nothing overlaps because every leaf has a row of its own. only the
// cards shown are laid out
function layout(t: Tree, shown: Set<Card>): Map<string, Placed> {
	const out = new Map<string, Placed>()
	const kids = new Map<Card, Card[]>()
	for (const e of t.edges) {
		if (!e.mount && shown.has(e.from) && shown.has(e.to)) {
			;(kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(e.to)
		}
	}
	const colw: number[] = []
	for (const c of shown) {
		const name = c.name.length > 22 ? c.name.slice(0, 21) + "…" : c.name
		const tag = c.refused ? "REFUSED" : c.pending ? "pending" : short(c.item.id)
		const sub = c.refused ? "" : preview(c.value)
		const w = Math.max(
			width(NAME, name) + width(TAG, tag) + 22,
			width(SUB, sub) + 4,
			54,
		) + PAD * 2 + 10
		out.set(c.key, { card: c, x: 0, y: 0, w, name, tag, sub })
		colw[c.depth] = Math.max(colw[c.depth] ?? 0, w)
	}
	const xs: number[] = []
	colw.reduce((x, w, d) => ((xs[d] = x), x + (w ?? 0) + GAP_X), 0)
	let row = 0
	const place = (c: Card): number => {
		const p = out.get(c.key)!
		p.x = xs[c.depth]
		const ks = kids.get(c) ?? []
		if (!ks.length) p.y = row++ * (H + GAP_Y)
		else {
			const ys = ks.map(place)
			p.y = (ys[0] + ys[ys.length - 1]) / 2
		}
		return p.y
	}
	if (t.cards[0]) place(t.cards[0])
	// every card is as wide as its column, so a column reads as a column
	for (const p of out.values()) p.w = colw[p.card.depth]
	return out
}

export function createMap(box: HTMLElement, o: MapOptions) {
	const svg = el("svg") as SVGSVGElement
	const sheet = el("g", { class: "sheet" }) as SVGGElement
	const edgeLayer = el("g"),
		readLayer = el("g", { class: "reads" }),
		pulseLayer = el("g"),
		cardLayer = el("g")
	const defs = el("defs")
	defs.innerHTML =
		`<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="#2269ff"/></marker>`
	sheet.append(edgeLayer, readLayer, pulseLayer, cardLayer)
	svg.append(defs, sheet)
	box.append(svg)

	const [view, setView] = createSignal({ x: 20, y: 20, k: 1 })
	const [bounds, setBounds] = createSignal({ w: 1, h: 1 })
	let smooth = true
	let fitted = false

	// the view state: what is folded (card keys), and each card's own offset from the tidy place
	const [folded, setFolded] = createSignal(new Set<string>(), { equals: false })
	const [offsets, setOffsets] = createSignal(new Map<string, { x: number; y: number }>(), {
		equals: false,
	})

	const dispose = createRoot((dispose) => {
		const vis = createMemo(() => {
			const t = o.tree()
			return t ? { t, ...visibility(t, folded()) } : undefined
		})
		// the tidy layout of what shows, then each card moved by its own offset and its ancestors'
		const placed = createMemo(() => {
			const v = vis()
			if (!v) return undefined
			const at = layout(v.t, v.shown)
			const off = offsets()
			const total = new Map<Card, { x: number; y: number }>()
			for (const c of v.t.cards) {
				if (!v.shown.has(c)) continue
				const mine = off.get(c.key), above = c.up ? total.get(c.up) : undefined
				const x = (mine?.x ?? 0) + (above?.x ?? 0), y = (mine?.y ?? 0) + (above?.y ?? 0)
				total.set(c, { x, y })
				const p = at.get(c.key)!
				p.x += x
				p.y += y
			}
			return { ...v, at }
		})

		// the cards and edges, kept by key
		const cardEls = new Map<string, SVGGElement>()
		const edgeEls = new Map<string, SVGPathElement>()
		// the change each card had when last drawn: a different one is fresh
		let seen = new Map<string, unknown>()
		let drawn = false

		const curve = (a: Placed, b: Placed) => {
			const x1 = a.x + a.w, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2
			const m = (x1 + x2) / 2
			return b.x > a.x + a.w
				? `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`
				// a mount to a card to the left or the same column: out of the right side, round
				: `M${x1} ${y1}C${x1 + 36} ${y1} ${x2 - 36} ${y2} ${x2} ${y2}`
		}

		createEffect(() => placed(), (p) => {
			if (!p) return
			const { t, at } = p
			// cards
			const live = new Set<string>()
			for (const [key, pl] of at) {
				live.add(key)
				let g = cardEls.get(key)
				if (!g) {
					g = el("g", { class: "card" }) as SVGGElement
					g.dataset.key = key
					g.append(
						el("rect", { height: H, rx: 6 }),
						el("text", { class: "cname", x: PAD, y: 15 }),
						el("rect", { class: "ctagbg", height: 13, y: 5 }),
						el("text", { class: "ctag", y: 14.5 }),
						el("text", { class: "csub", x: PAD, y: 31 }),
					)
					const fold = el("g", { class: "fold" })
					fold.append(
						el("rect", { height: 14, rx: 7, y: H / 2 - 7 }),
						el("text", { y: H / 2 + 3.5 }),
					)
					g.append(fold)
					cardEls.set(key, g)
					cardLayer.append(g)
				}
				const [rect, name, tagbg, tag, sub, fold] = g.children as unknown as SVGElement[]
				g.style.transform = `translate(${pl.x}px, ${pl.y}px)`
				// a card with children has a toggle on its right edge: a count when folded
				const count = p.hidden.get(pl.card) ?? 0
				const parent = p.t.edges.some((e) => !e.mount && e.from === pl.card)
				fold.style.display = parent ? "" : "none"
				const label = count ? `+${count}` : "−"
				const fw = count ? label.length * 6 + 8 : 14
				const [fr, ft] = fold.children as unknown as SVGElement[]
				fr.setAttribute("width", String(fw))
				fr.setAttribute("x", String(pl.w - fw / 2))
				ft.setAttribute("x", String(pl.w))
				ft.textContent = label
				g.classList.toggle("folded", count > 0)
				rect.setAttribute("width", String(pl.w))
				name.textContent = pl.name
				const tw = width(TAG, pl.tag) + 8
				tagbg.setAttribute("x", String(pl.w - PAD - tw))
				tagbg.setAttribute("width", String(tw))
				tag.setAttribute("x", String(pl.w - PAD - tw + 4))
				tag.textContent = pl.tag
				sub.textContent = pl.sub
				g.classList.toggle("pending", pl.card.pending)
				g.classList.toggle("refused", pl.card.refused)
			}
			for (const [key, g] of cardEls) if (!live.has(key)) (g.remove(), cardEls.delete(key))

			// edges: between cards shown. a mount to or from a hidden card goes to what hides it, faint
			const liveE = new Set<string>()
			for (const e of t.edges) {
				const f = p.rep.get(e.from)!, to = p.rep.get(e.to)!
				if (f === to) continue
				if (!e.mount && (f !== e.from || to !== e.to)) continue
				const a = at.get(f.key)!, b = at.get(to.key)!
				const k = `${f.key}>${to.key}`
				liveE.add(k)
				let path = edgeEls.get(k)
				if (!path) {
					path = el("path", { class: "edge" }) as SVGPathElement
					edgeEls.set(k, path)
					edgeLayer.append(path)
				}
				path.classList.toggle("mount", e.mount)
				path.classList.toggle("faint", f !== e.from || to !== e.to)
				path.style.d = `path("${curve(a, b)}")`
			}
			for (const [k, path] of edgeEls) if (!liveE.has(k)) (path.remove(), edgeEls.delete(k))

			// pulses: the cards whose change is new, and a line up their edges to the root
			const now = new Map<string, unknown>()
			const fresh: Card[] = []
			for (const c of t.cards) {
				now.set(c.id, c.change)
				// a card new to the map is not a change: only one seen before, with another change now
				if (drawn && seen.has(c.id) && seen.get(c.id) !== c.change) fresh.push(c)
			}
			seen = now
			drawn = true
			// a change in a hidden card lights the folded card that hides it
			const lit = new Set(fresh.map((c) => p.rep.get(c)!))
			for (const c of lit) {
				const g = cardEls.get(c.key)
				if (g) {
					g.classList.remove("fresh")
					void g.getBoundingClientRect() // restart the animation
					g.classList.add("fresh")
					g.addEventListener("animationend", () => g.classList.remove("fresh"), { once: true })
				}
				let delay = 0
				for (let u = c; u.up; u = u.up) {
					const a = at.get(u.up.key)!, b = at.get(u.key)!
					if (!a || !b) break
					// drawn child -> parent: the bright dash travels toward the root
					const x1 = b.x, y1 = b.y + H / 2, x2 = a.x + a.w, y2 = a.y + H / 2, m = (x1 + x2) / 2
					const line = el("path", {
						class: "pulse",
						d: `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`,
						pathLength: 1,
					}) as SVGPathElement
					line.style.animationDelay = `${delay}ms`
					line.addEventListener("animationend", () => line.remove())
					pulseLayer.append(line)
					delay += 220
				}
			}
			const b = [...at.values()].reduce(
				(m, p) => ({ w: Math.max(m.w, p.x + p.w), h: Math.max(m.h, p.y + H) }),
				{ w: 1, h: 1 },
			)
			setBounds(b)
		})

		// the pick, shared with the tree and the detail
		createEffect(() => o.picked(), (key) => {
			for (const [k, g] of cardEls) g.classList.toggle("picked", k === key)
		})

		// read arrows: a part's card to what its latest run read (blue); with a card picked, what
		// it reads is lit blue and the parts that read it cherry. an end in a folded subtree
		// attaches to the folded card, faint, with how many it stands for
		createEffect(() => [placed(), o.reads?.() ?? [], o.picked()] as const, ([p, reads, pick]) => {
			readLayer.replaceChildren()
			for (const g of cardEls.values()) g.classList.remove("reads", "readby")
			if (!p) return
			const byKey = new Map<string, Card>()
			for (const c of p.t.cards) byKey.set(c.key, c)
			const arrows = new Map<
				string,
				{ from: Card; to: Card; n: number; hidden: boolean; lit?: string }
			>()
			for (const r of reads) {
				const fc = byKey.get(r.from), tc = byKey.get(r.to)
				if (!fc || !tc) continue
				const f = p.rep.get(fc)!, to = p.rep.get(tc)!
				if (f === to) continue
				const k = `${f.key}>${to.key}`
				const a = arrows.get(k) ?? { from: f, to, n: 0, hidden: false }
				a.n++
				if (f !== fc || to !== tc) a.hidden = true
				if (pick === r.from || pick === f.key) a.lit = "out"
				else if (pick === r.to || pick === to.key) a.lit = "in"
				arrows.set(k, a)
			}
			for (const a of arrows.values()) {
				const x = p.at.get(a.from.key)!, y = p.at.get(a.to.key)!
				// out of the reader's bottom, round, into the bottom of what it read
				const x1 = x.x + x.w / 2, y1 = x.y + H, x2 = y.x + y.w / 2, y2 = y.y + H
				const drop = Math.max(y1, y2) + 28 + Math.abs(x1 - x2) / 8
				const d = `M${x1} ${y1}C${x1} ${drop} ${x2} ${drop} ${x2} ${y2}`
				readLayer.append(
					el("path", {
						class: "read" + (a.lit ? " " + a.lit : "") + (a.hidden ? " faint" : ""),
						d,
						"marker-end": "url(#arrow)",
					}),
				)
				if (a.hidden || a.n > 1) {
					readLayer.append(
						el("text", {
							class: "readn",
							x: (x1 + x2) / 2,
							y: drop * 0.75 + Math.max(y1, y2) * 0.25 + 4,
						}, `×${a.n}`),
					)
				}
				if (a.lit === "out") cardEls.get(a.to.key)?.classList.add("reads")
				if (a.lit === "in") cardEls.get(a.from.key)?.classList.add("readby")
			}
		})

		createEffect(() => bounds(), () => {
			if (!fitted && fit()) fitted = true
		})

		// pan and zoom
		createEffect(() => view(), (v) => {
			sheet.classList.toggle("smooth", smooth)
			sheet.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`
		})
		return dispose
	})

	// fit the whole tree in the box
	function fit() {
		const b = bounds(), r = box.getBoundingClientRect()
		if (!r.width || !r.height) return false
		const kw = (r.width - 40) / b.w, kh = (r.height - 40) / b.h
		let k = Math.min(1, kw, kh)
		smooth = true
		// a very tall tree would fit only as specks: it fits the width instead, from the top, to pan down
		if (k < 0.45) {
			k = Math.max(k, Math.min(kw, 0.7))
			setView({ k, x: Math.max(20, (r.width - b.w * k) / 2), y: 20 })
			return true
		}
		setView({ k, x: (r.width - b.w * k) / 2, y: (r.height - b.h * k) / 2 })
		return true
	}
	// the first time there is something to show and a box with a size
	const first = new ResizeObserver(() => {
		if (!fitted && bounds().w > 1 && fit()) fitted = true
	})
	first.observe(box)

	// a press on the background pans, on a card's fold toggle folds, on a card picks it, or drags
	// it (and its subtree) when it moves; a press that did not move picks
	type Press = {
		x: number
		y: number
		v: ReturnType<typeof view>
		moved: boolean
		card?: string
		fold?: string
		from?: { x: number; y: number }
	}
	let at: Press | undefined
	const under = (e: PointerEvent) => {
		const t = document.elementFromPoint(e.clientX, e.clientY) as Element | null
		const g = t?.closest<SVGElement>(".card")
		return { card: g?.dataset.key, fold: t?.closest(".fold") ? g?.dataset.key : undefined }
	}
	svg.onpointerdown = (e) => {
		svg.setPointerCapture(e.pointerId)
		const u = under(e)
		at = { x: e.clientX, y: e.clientY, v: view(), moved: false, ...u }
		if (u.card && !u.fold) at.from = { ...(offsets().get(u.card) ?? { x: 0, y: 0 }) }
	}
	svg.onpointermove = (e) => {
		if (!at) return
		const dx = e.clientX - at.x, dy = e.clientY - at.y
		if (Math.abs(dx) + Math.abs(dy) > 3) at.moved = true
		if (!at.moved || at.fold) return
		smooth = false
		if (at.card && at.from) {
			sheet.classList.add("dragging")
			const k = view().k
			setOffsets((
				m,
			) => (m.set(at!.card!, { x: at!.from!.x + dx / k, y: at!.from!.y + dy / k }), m))
		} else setView({ ...at.v, x: at.v.x + dx, y: at.v.y + dy })
	}
	svg.onpointerup = () => {
		const p = at
		at = undefined
		sheet.classList.remove("dragging")
		if (!p || p.moved) return
		if (p.fold) {
			setFolded((f) => (f.has(p.fold!) ? f.delete(p.fold!) : f.add(p.fold!), f))
		} else if (p.card) o.pick(p.card)
	}
	svg.onwheel = (e) => {
		e.preventDefault()
		const r = svg.getBoundingClientRect(), v = view()
		const px = e.clientX - r.left, py = e.clientY - r.top
		const k = Math.min(3, Math.max(0.15, v.k * Math.exp(-e.deltaY / 300)))
		smooth = true
		setView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k })
	}
	svg.ondblclick = () => fit()

	// the map's own controls: fold every card at a depth that has children, unfold, tidy up
	function foldAt(depth: number) {
		const t = o.tree()
		if (!t) return
		const parents = new Set(t.edges.filter((e) => !e.mount).map((e) => e.from))
		setFolded(() =>
			new Set(t.cards.filter((c) => c.depth === depth && parents.has(c)).map((c) => c.key))
		)
		setTimeout(fit, 260)
	}
	const unfoldAll = () => (setFolded(() => new Set()), setTimeout(fit, 260))
	const tidy = () => setOffsets(() => new Map())
	// a new world: nothing folded, nothing moved
	const reset = () => (unfoldAll(), tidy())
	return { fit, foldAt, unfoldAll, tidy, reset, dispose: () => (dispose(), first.disconnect()) }
}
