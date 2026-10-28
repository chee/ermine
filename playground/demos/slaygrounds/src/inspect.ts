/// <reference lib="dom" />
// inspect element, over the render: what an element says it does (the data-ermine-* attributes
// @ermine/render writes) drawn on a layer above the iframe, never inside the program's document.
//   picking    the crosshair: hovering outlines the element under the pointer with a tag of what
//              it says; a click picks it (the program never hears that click), escape stops
//   marks      a node picked in the graph: every element bound to it, or whose node it is, ringed
//   explain    badges on every bound element (🪝 a handler, 🔗 a bound node), and a flash when a
//              bound element's node changes ("ermine:change", told by @ermine/render)
// the layer is drawn again on the next frame after the document, its scroll or its size changes

// what an element says: its own data-ermine-* attributes, and the process it is drawn by
export type Said = {
	el: Element
	tag: string
	process?: string
	source?: string
	key?: string
	waiting: boolean
	// [what, path]: data-ermine-bind:<what> (text, children, a prop)
	binds: [string, string][]
	// [event, path]: data-ermine-on:<event>
	ons: [string, string][]
}
// a path an element says, from the root: @ermine/render says one under the process's node from
// the nearest data-ermine-base ("items/a"), "./x" from the base's folder; one from the root, a word
// ("[track]") or one with no base, as it is
function resolved(at: string, base: string | undefined): string {
	if (at.startsWith("/") || at.startsWith("[") || base === undefined) return at
	const [path, id] = at.split("#")
	const out = base.split("/").filter(Boolean)
	const steps = path.split("/")
	if (steps[0] === "." || steps[0] === "..") out.pop()
	for (const step of steps) {
		if (step === "..") out.pop()
		else if (step !== "" && step !== ".") out.push(step)
	}
	return "/" + out.join("/") + (id === undefined ? "" : "#" + id)
}

export function says(el: Element): Said {
	const out: Said = {
		el,
		tag: el.localName,
		binds: [],
		ons: [],
		waiting: el.hasAttribute("data-ermine-waiting"),
	}
	const base = el.closest("[data-ermine-base]")?.getAttribute("data-ermine-base") ?? undefined
	for (const a of el.attributes) {
		const path = resolved(a.value, base)
		if (a.name.startsWith("data-ermine-bind:")) out.binds.push([a.name.slice(17), path])
		else if (a.name.startsWith("data-ermine-on:")) out.ons.push([a.name.slice(15), path])
		else if (a.name === "data-ermine-source") out.source = a.value
		else if (a.name === "data-ermine-key") out.key = a.value
	}
	out.process = el.closest("[data-ermine-process]")?.getAttribute("data-ermine-process") ??
		undefined
	return out
}
const speaks = (el: Element) => [...el.attributes].some((a) => a.name.startsWith("data-ermine-"))
// the element itself if it says anything, else the nearest one up that does
const sayer = (el: Element | null) => {
	for (let e = el; e; e = e.parentElement) if (speaks(e)) return e
	return el ?? undefined
}
// the last name of a path: what a badge has room for
const last = (path: string) => path.split("#")[0].split("/").filter(Boolean).pop() ?? "/"
// a path as a tag says it: an id after it cut short
const short = (path: string) => path.replace(/#(.{6}).+$/, "#$1")
// a path an element says is the node picked: the same id, or (no id said) the same path
const same = (said: string, m: { path?: string; id?: unknown }) => {
	const [path, id] = said.split("#")
	return id !== undefined ? id === String(m.id) : path === m.path
}

const div = (cls: string, text?: string) => {
	const e = document.createElement("div")
	e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

export function createLook(opts: {
	iframe: () => HTMLIFrameElement | undefined
	// a click while picking: what it was
	picked: (s: Said) => void
	// picking turned on or off (the crosshair shows it)
	picking: (on: boolean) => void
}) {
	// the layers: fixed over the iframe, clipped to it, never in the way of the pointer. flashes
	// have their own, under the rest, multiplied onto the render (the text stays black through it)
	const flashes = document.body.appendChild(div("look look-flashes"))
	const layer = document.body.appendChild(div("look"))
	const badges = layer.appendChild(div("look-badges"))
	const marks = layer.appendChild(div("look-marks"))
	const hover = layer.appendChild(div("look-hover"))

	let doc: Document | undefined
	let mo: MutationObserver | undefined
	let explaining = false
	let pickingOn = false
	let marked: { path?: string; value?: unknown; id?: unknown } = {}
	let hovered: Element | undefined
	let queued = false

	const frameBox = () => opts.iframe()?.getBoundingClientRect()
	// an element's box on the page: its box in the frame, moved by the frame's place
	function boxOf(el: Element) {
		const f = frameBox()
		const r = el.getBoundingClientRect()
		if (!f || (!r.width && !r.height)) return undefined
		return { left: r.left, top: r.top, width: r.width, height: r.height }
	}
	const at = (e: HTMLElement, b: { left: number; top: number; width: number; height: number }) =>
		Object.assign(e.style, {
			left: b.left + "px",
			top: b.top + "px",
			width: b.width + "px",
			height: b.height + "px",
		})

	function draw() {
		queued = false
		const f = frameBox()
		layer.hidden = flashes.hidden = !f || !doc
		if (!f || !doc) return
		for (const l of [layer, flashes]) {
			Object.assign(l.style, {
				left: f.left + "px",
				top: f.top + "px",
				width: f.width + "px",
				height: f.height + "px",
			})
		}
		badges.replaceChildren()
		marks.replaceChildren()
		hover.replaceChildren()
		// every element that says something; not looked for when nothing is to be drawn
		const all = explaining || marked.path || marked.value
			? [...doc.querySelectorAll("*")].filter(speaks)
			: []
		if (explaining) {
			// a row of badges above each bound element's corner; a row that would cover another
			// says only its icons, then moves right until it is clear
			type Box = { l: number; t: number; r: number; b: number }
			const taken: Box[] = []
			// a badge never covers another bound element (one that is not its own, inside or out)
			const bound = all.filter((el) =>
				[...el.attributes].some((a) => /^data-ermine-(bind|on):/.test(a.name))
			)
			const covers = (a: Box, el: Element) =>
				bound.find((o) => {
					if (o === el || o.contains(el) || el.contains(o)) return false
					const r = o.getBoundingClientRect()
					return a.l < r.right - 2 && r.left + 2 < a.r && a.t < r.bottom - 2 && r.top + 2 < a.b
				})
			let current: Element
			const hit = (a: Box): Box | undefined => {
				const other = taken.find((b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b)
				if (other) return other
				const o = covers(a, current)?.getBoundingClientRect()
				return o && { l: o.left, t: o.top, r: o.right, b: o.bottom }
			}
			for (const el of all) {
				const s = says(el)
				const b = boxOf(el)
				if (!b || (!s.binds.length && !s.ons.length)) continue
				current = el
				const row = badges.appendChild(div("look-badgerow"))
				for (const [what, path] of s.binds) {
					const tag = row.appendChild(div("look-badge bind", `🔗 ${last(path)}`))
					tag.title = `${what} ← ${path}`
				}
				// one badge a handler, however many events call it
				const calls = new Map<string, string[]>()
				for (const [event, path] of s.ons) calls.set(path, [...calls.get(path) ?? [], event])
				for (const [path, events] of calls) {
					const tag = row.appendChild(div("look-badge on", `🪝 ${last(path)}`))
					tag.title = `${events.join(", ")} → ${path}`
				}
				if (s.waiting) row.appendChild(div("look-badge waiting", "⏳"))
				const put = (x: number) => {
					const y = b.top - row.offsetHeight + 1
					row.style.left = x + "px"
					row.style.top = y + "px"
					return { l: x, t: y, r: x + row.offsetWidth, b: y + row.offsetHeight }
				}
				let at = put(b.left)
				if (hit(at)) {
					for (const t of row.children) t.textContent = t.textContent!.slice(0, 2)
					at = put(b.left)
				}
				// moved right while it stays over its own element; no room at all: a pip in its
				// corner says only that it is bound (or calls)
				for (let i = 0, h = hit(at); h && i < 8; i++, h = hit(at)) {
					if (h.r + 2 + row.offsetWidth > b.left + Math.max(b.width, 40)) {
						row.className = "look-badgerow pips"
						for (const t of row.children) t.textContent = ""
						row.style.left = b.left + "px"
						row.style.top = b.top + "px"
						at = { l: b.left, t: b.top, r: b.left + row.offsetWidth, b: b.top + 1 }
						break
					}
					at = put(h.r + 2)
				}
				taken.push(at)
			}
		}
		// a node picked in the graph: what is bound to it, and the element that is its value
		if (marked.path || marked.value) {
			for (const el of all) {
				const s = says(el)
				const hit = el === marked.value ||
					s.binds.some(([, p]) => same(p, marked)) ||
					s.ons.some(([, p]) => same(p, marked))
				const b = hit && boxOf(el)
				if (!b) continue
				at(marks.appendChild(div("look-mark")), b)
			}
		}
		if (pickingOn && hovered?.isConnected) {
			const b = boxOf(hovered)
			if (b) {
				at(hover.appendChild(div("look-outline")), b)
				const tag = hover.appendChild(tagOf(says(hovered)))
				// above the element when there is room, else below it
				tag.style.left = Math.max(0, Math.min(b.left, f.width - 280)) + "px"
				tag.style.top = (b.top > 46 ? b.top - 4 : b.top + b.height + 4) + "px"
				tag.classList.toggle("below", b.top <= 46)
			}
		}
	}
	const later = () => {
		if (!queued) (queued = true, requestAnimationFrame(draw))
	}

	// the tag over a hovered element: its tag, its process, what it is bound to and calls
	function tagOf(s: Said) {
		const t = div("look-tag")
		t.append(div("look-name", `<${s.tag}>`))
		if (s.process) t.append(div("look-chip proc", s.process))
		for (const [what, path] of s.binds) {
			t.append(div("look-chip bind", `🔗 ${what} ← ${short(path)}`))
		}
		for (const [event, path] of s.ons) {
			t.append(div("look-chip on", `🪝 ${event} → ${short(path)}`))
		}
		if (s.key !== undefined) t.append(div("look-chip key", `🔑 ${s.key}`))
		if (s.source) t.append(div("look-chip src", s.source))
		if (!s.binds.length && !s.ons.length && !s.source && !s.process) {
			t.append(div("look-chip none", "not drawn by @ermine/render"))
		}
		return t
	}

	// ---- the frame's document: listened to while it is there ----
	const listeners: [EventTarget, string, EventListener, boolean][] = []
	function on(t: EventTarget, type: string, f: EventListener, capture = true) {
		t.addEventListener(type, f, capture)
		listeners.push([t, type, f, capture])
	}
	function attach() {
		detach()
		const frame = opts.iframe()
		doc = frame?.contentDocument ?? undefined
		if (!doc || !frame?.contentWindow) return later()
		mo = new MutationObserver(later)
		mo.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true })
		on(frame.contentWindow, "scroll", later)
		on(frame.contentWindow, "resize", later)
		// a box moved by css (a transition, an animation) is drawn again where it ends
		on(doc, "transitionend", later)
		on(doc, "animationend", later)
		on(doc, "ermine:change", (e) => explaining && flash(e.target as Element), false)
		// while picking, the program hears none of the pointer: it is the picker's
		for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick"]) {
			on(doc, type, (e) => pickingOn && (e.preventDefault(), e.stopImmediatePropagation()))
		}
		on(doc, "pointermove", (e) => {
			if (!pickingOn) return
			const next = sayer(e.target as Element)
			if (next !== hovered) (hovered = next, later())
		})
		on(doc, "click", (e) => {
			if (!pickingOn) return
			e.preventDefault()
			e.stopImmediatePropagation()
			const el = sayer(e.target as Element)
			pick(false)
			if (el) opts.picked(says(el))
		})
		on(doc, "keydown", (e) => {
			if (pickingOn && (e as KeyboardEvent).key === "Escape") pick(false)
		})
		later()
	}
	function detach() {
		mo?.disconnect()
		for (const [t, type, f, capture] of listeners.splice(0)) {
			t.removeEventListener(type, f, capture)
		}
		hovered = undefined
		doc = undefined
	}

	// a flash over an element whose node changed: it goes by itself
	function flash(el: Element) {
		const b = el.isConnected && boxOf(el)
		if (!b) return
		const f = flashes.appendChild(div("look-flash"))
		at(f, b)
		f.onanimationend = () => f.remove()
	}

	function pick(on: boolean) {
		pickingOn = on
		hovered = undefined
		if (doc) doc.documentElement.style.cursor = on ? "crosshair" : ""
		opts.picking(on)
		later()
	}
	addEventListener("resize", later)
	addEventListener("keydown", (e) => pickingOn && e.key === "Escape" && pick(false))
	new ResizeObserver(later).observe(document.body)

	return {
		attach,
		// picking: on, off, or the other way
		pick: (on = !pickingOn) => pick(on),
		explain(on: boolean) {
			explaining = on
			flashes.replaceChildren()
			later()
		},
		// a node picked: its path from the root, and its value (an element is ringed too)
		mark(path?: string, value?: unknown, id?: unknown) {
			marked = { path, value, id }
			later()
		},
		redraw: later,
	}
}
