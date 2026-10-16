/// <reference lib="dom" />
// flow.ts: what moves between the windows, drawn over the page. The runner's line to the clock:
// out of the runner's row, down out of the graph's window and around to the clock (beside it or
// below it, as the page is laid out). And dots that travel: along that line, or from anywhere to
// anywhere (what was saved, into its row). Drawn again when the page's layout moves.
type Box = { x: number; y: number; w: number; h: number }

const NS = "http://www.w3.org/2000/svg"
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const page = (el: Element): Box => {
	const r = el.getBoundingClientRect()
	return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
}

export function createFlow(
	svg: SVGSVGElement,
	ends: { card: () => Box | undefined; pane?: Element; window: Element; cat: Element },
) {
	let arrow = ""
	// the arrow, drawn again as the page moves; what travels, in a layer of its own
	svg.innerHTML = `<g class="art"></g><g class="packets"></g>`
	const art = svg.querySelector(".art")!, packets = svg.querySelector(".packets")!

	// the route: down from the row to under the window, along, then up (or down) to the clock
	function draw() {
		const card = ends.card()
		if (!card) return void (art.innerHTML = "")
		const win = page(ends.window), cat = page(ends.cat)
		// the editor under the map (a narrow page): out of the window's bottom, not through the code
		const pane = ends.pane ? page(ends.pane) : undefined
		const stacked = pane
			? pane.y + pane.h < win.y + win.h - 8
			: card.y + card.h < win.y + win.h - 160
		const sx = card.x + card.w * 0.72, sy = stacked ? win.y + win.h + 4 : card.y + card.h + 4
		const run = win.y + win.h + 26
		const beside = cat.x > win.x + win.w - 40
		// beside: up into the clock's window at its left
		const ex = beside ? cat.x + 46 : cat.x + cat.w / 2
		const ey = beside ? cat.y + cat.h + 8 : cat.y - 10
		const r = 18
		const up = ey < run
		// beside, and under the window is level with the clock's: straight along into its side
		const level = beside && run > cat.y + 40 && run < cat.y + cat.h - 12
		const down = `M${sx},${sy} V${run - r} Q${sx},${run} ${sx + r},${run}`
		arrow = level
			? `${down} H${cat.x - 4}`
			: `${down} H${ex - r} Q${ex},${run} ${ex},${up ? run - r : run + r} V${ey}`
		const head = level
			? `M${cat.x - 13},${run - 6} L${cat.x - 4},${run} L${cat.x - 13},${run + 6}`
			: up
			? `M${ex - 6},${ey + 9} L${ex},${ey} L${ex + 6},${ey + 9}`
			: `M${ex - 6},${ey - 9} L${ex},${ey} L${ex + 6},${ey - 9}`
		art.innerHTML = `<path class="arrow" d="${arrow}"/><path class="tip" d="${head}"/>`
	}

	// a dot along d; done when it gets there
	function along(d: string, ms: number, kind = ""): Promise<void> {
		if (!d || reduced()) return Promise.resolve()
		const path = document.createElementNS(NS, "path")
		path.setAttribute("d", d)
		path.setAttribute("class", "track")
		const dot = document.createElementNS(NS, "g")
		dot.setAttribute("class", `packet ${kind}`)
		dot.innerHTML = `<circle class="dot" r="4"/>`
		packets.append(path, dot)
		const length = path.getTotalLength(), start = performance.now()
		svg.classList.add("moving")
		return new Promise((done) => {
			const step = (now: number) => {
				const t = Math.min(1, (now - start) / ms)
				const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
				const p = path.getPointAtLength(length * e)
				dot.setAttribute("transform", `translate(${p.x} ${p.y})`)
				if (t < 1) return void requestAnimationFrame(step)
				path.remove()
				dot.remove()
				if (!svg.querySelector(".packet")) svg.classList.remove("moving")
				done()
			}
			requestAnimationFrame(step)
		})
	}

	// layout moves: a window grows, the page narrows, fonts arrive
	const later = () => requestAnimationFrame(draw)
	new ResizeObserver(later).observe(document.body)
	new ResizeObserver(later).observe(ends.window)
	addEventListener("resize", later)
	document.fonts?.ready.then(later)
	draw()

	return {
		draw,
		// along the line, the runner to the clock
		toCat: () => along(arrow, 900),
		// from one place on the page to another, in a little arc
		toss(from: Element | Box, to: Box | undefined, ms = 520) {
			if (!to) return Promise.resolve()
			const a = from instanceof Element ? page(from) : from
			const ax = a.x + a.w / 2, ay = a.y + a.h / 2
			const bx = to.x + to.w * 0.85, by = to.y + to.h / 2
			const lift = Math.min(120, Math.hypot(bx - ax, by - ay) / 3)
			return along(
				`M${ax},${ay} Q${(ax + bx) / 2},${Math.min(ay, by) - lift} ${bx},${by}`,
				ms,
				"toss",
			)
		},
	}
}
