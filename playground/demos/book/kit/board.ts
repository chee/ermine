/// <reference lib="dom" />
// the board: a roomy canvas of boxes and wires, the book's stage. drag the paper to pan, wheel or
// pinch to zoom, drag a box by its title. a box has ports: ins on its left, outs on its right. a
// wire joins an out to an in and can carry a little label (what flows along it). a box can carry
// its code on its back: the { } button turns it over.
//
//   const board = createBoard(document.getElementById("board")!)
//   const rain = board.box({ id: "rain", x: 40, y: 80, title: "rain", kind: "key", outs: ["out"] })
//   rain.body.append(someControl)
//   const algae = board.box({ id: "algae", x: 320, y: 60, title: "algae", ins: ["rain"], outs: ["out"] })
//   const w = board.wire(rain.port("out"), algae.port("rain"))
//   w.label("3 mm"); w.tone("hot"); rain.flash()
//
// tones: "hot" (cherry: what just happened), "pick" (blue: picked), "ok" (stem: fine, shared),
// "wait" (lemon dashed: due, waiting), "dim" (grey: nobody's using it), undefined (plain ink)

export type Tone = "hot" | "pick" | "ok" | "wait" | "dim" | undefined

export type Port = {
	readonly box: Box
	readonly name: string
	readonly side: "in" | "out"
	readonly el: HTMLElement
}

export type Box = {
	readonly id: string
	readonly el: HTMLElement
	// put the box's insides here
	readonly body: HTMLElement
	port(name: string): Port
	addPort(name: string, side: "in" | "out", label?: string): Port
	removePort(name: string): void
	move(x: number, y: number): void
	pos(): { x: number; y: number }
	title(text: string): void
	// a small chip at the title's right end; "" removes it
	badge(text: string, tone?: Tone): void
	tone(t: Tone): void
	flash(t?: Tone): void
	// put code on the box's back; the { } button turns it over
	code(text: string): void
	remove(): void
}

export type Wire = {
	readonly from: Port
	readonly to: Port
	label(text: string): void
	tone(t: Tone): void
	dashed(on: boolean): void
	flash(t?: Tone): void
	remove(): void
}

export type BoxOptions = {
	id: string
	x: number
	y: number
	title: string
	// key: something you set; compute: works a value out; effect: does something with a value;
	// picture: shows a world. only changes the look of the title strip
	kind?: "key" | "compute" | "effect" | "picture" | "note"
	width?: number
	ins?: (string | [string, string])[]
	outs?: (string | [string, string])[]
}

export type Board = {
	readonly el: HTMLElement
	// the layer that pans and zooms: put free things here (labels, ghosts)
	readonly world: HTMLElement
	box(o: BoxOptions): Box
	get(id: string): Box | undefined
	wire(from: Port, to: Port): Wire
	wires(): Wire[]
	// fit everything in view, with room around
	fit(pad?: number): void
	// redraw every wire (after a box changes size)
	redraw(): void
	// the user dragged from one port to another (out to in, or in to out); return false to refuse
	onConnect(f: (from: Port, to: Port) => boolean | void): void
	// the user dropped a wire end on empty paper, or grabbed a wire's in end off its port
	onDisconnect(f: (w: Wire) => void): void
	// a box was clicked (not dragged)
	onPick(f: (b: Box | undefined) => void): void
}

const SVG = "http://www.w3.org/2000/svg"
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

export function createBoard(el: HTMLElement): Board {
	el.classList.add("board")
	const world = h("div", "board-world")
	const svg = document.createElementNS(SVG, "svg")
	svg.classList.add("board-wires")
	const labels = h("div", "board-labels")
	world.append(svg, labels)
	el.append(world)
	const zoomer = h("div", "board-zoom")
	zoomer.innerHTML =
		`<button title="zoom out">−</button><button title="fit everything in view">fit</button><button title="zoom in">+</button>`
	el.append(zoomer)

	let view = { x: 0, y: 0, k: 1 }
	const boxes = new Map<string, Box>()
	const all = new Set<Wire>()
	const redrawers = new Map<Wire, () => void>()
	let connect: (from: Port, to: Port) => boolean | void = () => {}
	let disconnect: (w: Wire) => void = () => {}
	let pick: (b: Box | undefined) => void = () => {}

	function apply() {
		world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
		el.style.backgroundPosition = `${view.x}px ${view.y}px`
		el.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`
	}
	apply()

	function zoomAt(cx: number, cy: number, f: number) {
		const k = Math.min(2.5, Math.max(0.3, view.k * f))
		const r = el.getBoundingClientRect()
		const px = cx - r.left, py = cy - r.top
		view = { k, x: px - (px - view.x) * (k / view.k), y: py - (py - view.y) * (k / view.k) }
		apply()
	}
	const [zout, zfit, zin] = zoomer.querySelectorAll("button")
	const mid = () => {
		const r = el.getBoundingClientRect()
		return [r.left + r.width / 2, r.top + r.height / 2] as const
	}
	zout.onclick = () => zoomAt(...mid(), 1 / 1.2)
	zin.onclick = () => zoomAt(...mid(), 1.2)
	zfit.onclick = () => board.fit()

	el.addEventListener("wheel", (e) => {
		e.preventDefault()
		if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY / 100))
		else {
			view.x -= e.deltaX
			view.y -= e.deltaY
			apply()
		}
	}, { passive: false })

	// world coordinates of a screen point
	const toWorld = (cx: number, cy: number) => {
		const r = el.getBoundingClientRect()
		return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }
	}
	// a port's dot centre, in world coordinates
	const at = (p: Port) => {
		const r = p.el.querySelector(".dot")!.getBoundingClientRect()
		return toWorld(r.left + r.width / 2, r.top + r.height / 2)
	}
	const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
		// forwards: one s-curve. backwards (the in is left of the out): out to the right, a u-turn
		// underneath both ends, and in from the left, so it never crosses back over what it joins
		if (b.x > a.x + 30) {
			const d = Math.max(40, Math.abs(b.x - a.x) * 0.5)
			return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`
		}
		const low = Math.max(a.y, b.y) + 70
		const mx = (a.x + b.x) / 2
		return `M ${a.x} ${a.y} C ${a.x + 90} ${a.y}, ${a.x + 90} ${low}, ${mx} ${low} ` +
			`C ${b.x - 90} ${low}, ${b.x - 90} ${b.y}, ${b.x} ${b.y}`
	}

	// panning the paper
	el.addEventListener("pointerdown", (e) => {
		if (e.target !== el && e.target !== world && e.target !== svg) return
		if (e.button !== 0) return
		const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
		let moved = false
		el.setPointerCapture(e.pointerId)
		el.classList.add("panning")
		const move = (m: PointerEvent) => {
			if (Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) > 3) moved = true
			view.x = start.vx + m.clientX - start.x
			view.y = start.vy + m.clientY - start.y
			apply()
		}
		const up = () => {
			el.removeEventListener("pointermove", move)
			el.removeEventListener("pointerup", up)
			el.classList.remove("panning")
			if (!moved) pick(undefined)
		}
		el.addEventListener("pointermove", move)
		el.addEventListener("pointerup", up)
	})

	// dragging a wire out of a port
	function wireDrag(p: Port, e: PointerEvent, existing?: Wire) {
		e.stopPropagation()
		e.preventDefault()
		const ghost = document.createElementNS(SVG, "path")
		ghost.classList.add("ghost")
		svg.append(ghost)
		const fixed = existing ? existing.from : p
		const draw = (cx: number, cy: number) => {
			const m = toWorld(cx, cy), f = at(fixed)
			ghost.setAttribute("d", fixed.side === "out" ? curve(f, m) : curve(m, f))
		}
		draw(e.clientX, e.clientY)
		if (existing) existing.remove()
		const move = (m: PointerEvent) => {
			draw(m.clientX, m.clientY)
			for (const d of world.querySelectorAll(".port.near")) d.classList.remove("near")
			const t = (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement)?.closest(
				".port",
			)
			if (t) t.classList.add("near")
		}
		const up = (u: PointerEvent) => {
			removeEventListener("pointermove", move)
			removeEventListener("pointerup", up)
			ghost.remove()
			for (const d of world.querySelectorAll(".port.near")) d.classList.remove("near")
			const t = (document.elementFromPoint(u.clientX, u.clientY) as HTMLElement)?.closest(
				".port",
			) as HTMLElement | null
			const target = t ? ports.get(t) : undefined
			if (target && target.side !== fixed.side && target.box !== fixed.box) {
				const [from, to] = fixed.side === "out" ? [fixed, target] : [target, fixed]
				connect(from, to)
			} else if (existing) disconnect(existing)
		}
		addEventListener("pointermove", move)
		addEventListener("pointerup", up)
	}

	const ports = new Map<HTMLElement, Port>()

	function box(o: BoxOptions): Box {
		const el2 = h("div", `box kind-${o.kind ?? "compute"}`)
		el2.dataset.id = o.id
		if (o.width) el2.style.width = `${o.width}px`
		const head = h("div", "box-head")
		const name = h("span", "box-title", o.title)
		const chip = h("span", "box-badge")
		const flip = h("button", "box-flip", "{ }")
		flip.title = "turn it over: the code"
		flip.hidden = true
		head.append(name, chip, flip)
		const ins = h("div", "box-ins"), outs = h("div", "box-outs")
		const body = h("div", "box-body")
		const back = h("pre", "box-back")
		back.hidden = true
		const mid = h("div", "box-mid")
		mid.append(body, back)
		const row = h("div", "box-row")
		row.append(ins, mid, outs)
		el2.append(head, row)
		world.append(el2)
		let x = o.x, y = o.y
		const place = () => (el2.style.left = `${x}px`, el2.style.top = `${y}px`)
		place()
		const mine = new Map<string, Port>()
		const b: Box = {
			id: o.id,
			el: el2,
			body,
			port: (n) => {
				const p = mine.get(n)
				if (!p) throw new Error(`no port ${n} on ${o.id}`)
				return p
			},
			addPort(n, side, label) {
				const pe = h("div", `port port-${side}`)
				const dot = h("span", "dot")
				const lab = h("span", "port-label", label ?? n)
				if (side === "in") pe.append(dot, lab)
				else pe.append(lab, dot)
				;(side === "in" ? ins : outs).append(pe)
				const p: Port = { box: b, name: n, side, el: pe }
				mine.set(n, p)
				ports.set(pe, p)
				dot.addEventListener("pointerdown", (e) => {
					if (e.button !== 0) return
					// an in already wired: pick its wire up
					const w = side === "in" ? [...all].find((w) => w.to === p) : undefined
					wireDrag(p, e, w)
				})
				queueMicrotask(redraw)
				return p
			},
			removePort(n) {
				const p = mine.get(n)
				if (!p) return
				for (const w of [...all]) if (w.from === p || w.to === p) w.remove()
				p.el.remove()
				mine.delete(n)
				ports.delete(p.el)
				queueMicrotask(redraw)
			},
			move(nx, ny) {
				x = nx, y = ny
				place()
				redraw()
			},
			pos: () => ({ x, y }),
			title: (t) => void (name.textContent = t),
			badge(t, tone) {
				chip.textContent = t
				chip.className = `box-badge ${tone ? `tone-${tone}` : ""}`
				chip.hidden = t === ""
			},
			tone(t) {
				for (const c of [...el2.classList]) if (c.startsWith("tone-")) el2.classList.remove(c)
				if (t) el2.classList.add(`tone-${t}`)
			},
			flash(t = "hot") {
				el2.classList.remove("flash-hot", "flash-ok", "flash-pick")
				void el2.offsetWidth
				el2.classList.add(`flash-${t === "ok" ? "ok" : t === "pick" ? "pick" : "hot"}`)
			},
			code(text) {
				back.textContent = text
				flip.hidden = false
			},
			remove() {
				for (const n of [...mine.keys()]) b.removePort(n)
				el2.remove()
				boxes.delete(o.id)
			},
		}
		b.badge("")
		for (const p of o.ins ?? []) {
			typeof p === "string" ? b.addPort(p, "in") : b.addPort(p[0], "in", p[1])
		}
		for (const p of o.outs ?? []) {
			typeof p === "string" ? b.addPort(p, "out") : b.addPort(p[0], "out", p[1])
		}
		flip.onclick = (e) => {
			e.stopPropagation()
			const show = back.hidden === true
			back.hidden = !show
			body.hidden = show
			el2.classList.toggle("flipped", show)
			redraw()
		}
		// drag by the head
		head.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return
			e.stopPropagation()
			const s = { cx: e.clientX, cy: e.clientY, x, y }
			let moved = false
			head.setPointerCapture(e.pointerId)
			el2.classList.add("dragging")
			const move = (m: PointerEvent) => {
				if (Math.abs(m.clientX - s.cx) + Math.abs(m.clientY - s.cy) > 3) moved = true
				b.move(s.x + (m.clientX - s.cx) / view.k, s.y + (m.clientY - s.cy) / view.k)
			}
			const up = () => {
				head.removeEventListener("pointermove", move)
				head.removeEventListener("pointerup", up)
				el2.classList.remove("dragging")
				if (!moved) pick(b)
			}
			head.addEventListener("pointermove", move)
			head.addEventListener("pointerup", up)
		})
		new ResizeObserver(() => redraw()).observe(el2)
		boxes.set(o.id, b)
		return b
	}

	function wire(from: Port, to: Port): Wire {
		const path = document.createElementNS(SVG, "path")
		const hit = document.createElementNS(SVG, "path")
		hit.classList.add("hit")
		svg.append(hit, path)
		const lab = h("span", "wire-label")
		lab.hidden = true
		labels.append(lab)
		from.el.classList.add("wired")
		to.el.classList.add("wired")
		const draw = () => {
			if (!from.el.isConnected || !to.el.isConnected) return
			const a = at(from), b = at(to)
			const d = curve(a, b)
			path.setAttribute("d", d)
			hit.setAttribute("d", d)
			if (!lab.hidden) {
				const m = path.getPointAtLength(path.getTotalLength() / 2)
				lab.style.left = `${m.x}px`
				lab.style.top = `${m.y}px`
			}
		}
		const w: Wire = {
			from,
			to,
			label(t) {
				lab.textContent = t
				lab.hidden = t === ""
				draw()
			},
			tone(t) {
				path.setAttribute("class", t ? `tone-${t}` : "")
				lab.className = `wire-label ${t ? `tone-${t}` : ""}`
			},
			dashed: (on) => void path.classList.toggle("dashed", on),
			flash(t = "hot") {
				path.classList.remove("flash")
				void path.getBBox()
				path.classList.add("flash")
				lab.classList.remove("flash")
				void lab.offsetWidth
				lab.classList.add("flash")
				if (t) {
					path.style.setProperty(
						"--flash",
						`var(--${t === "ok" ? "stem" : t === "pick" ? "blue" : "cherry"})`,
					)
				}
			},
			remove() {
				path.remove()
				hit.remove()
				lab.remove()
				all.delete(w)
				redrawers.delete(w)
				if (![...all].some((o) => o.from === from || o.to === from)) {
					from.el.classList.remove("wired")
				}
				if (![...all].some((o) => o.from === to || o.to === to)) to.el.classList.remove("wired")
			},
		}
		all.add(w)
		redrawers.set(w, draw)
		requestAnimationFrame(draw)
		return w
	}

	function redraw() {
		for (const d of redrawers.values()) d()
	}

	const board: Board = {
		el,
		world,
		box,
		get: (id) => boxes.get(id),
		wire,
		wires: () => [...all],
		fit(pad = 48) {
			if (!boxes.size) return
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
			for (const b of boxes.values()) {
				const { x, y } = b.pos()
				x0 = Math.min(x0, x), y0 = Math.min(y0, y)
				x1 = Math.max(x1, x + b.el.offsetWidth), y1 = Math.max(y1, y + b.el.offsetHeight)
			}
			const r = el.getBoundingClientRect()
			// leave the notes card's side free when it is open
			const notes = document.querySelector<HTMLElement>(".notes-card:not(.folded)")
			const left = notes ? notes.offsetWidth + 16 : 0
			const k = Math.min(
				1.25,
				(r.width - left - pad * 2) / (x1 - x0),
				(r.height - pad * 2) / (y1 - y0),
			)
			view = {
				k,
				x: left + (r.width - left - (x1 - x0) * k) / 2 - x0 * k,
				y: (r.height - (y1 - y0) * k) / 2 - y0 * k,
			}
			apply()
		},
		redraw,
		onConnect: (f) => void (connect = f),
		onDisconnect: (f) => void (disconnect = f),
		onPick: (f) => void (pick = f),
	}
	addEventListener("resize", () => redraw())
	return board
}
