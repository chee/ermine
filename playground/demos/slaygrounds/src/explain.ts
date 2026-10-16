/// <reference lib="dom" />
// what just happened, in one line under the render: who changed what, read off the changes as
// they are written (the world's places.commit, wrapped like solid-ermine wraps moments.push) and the
// calls ermine-h tells ("ermine:call", "ermine:called"). a run of writes with no gap between them
// (until the next task) is one happening:
//   you pressed "+1" → /demo/on/press → wrote demo/add → adding acted → demo/counter = 3
// a write is said by its header's pairs: made in a part ("part"), it is that part acting (an
// effect) or running (a compute); else in a call ("caller"), the handler's; else the host's.
// its patches say what: a value's node gets "= value", a children node "placed" or "took out"
import { preview } from "./map.ts"

// deno-lint-ignore no-explicit-any
type Any = any
// a write as recorded; what to say is worked out when the happening is drawn (the nodes it
// placed are in the tree by then)
type Write = {
	by: string
	how: "acted" | "ran" | "wrote"
	part: string
	id: unknown
	patches: Any[]
	value: unknown
}
type Happening = {
	who?: { text: string; title?: string }
	call?: string
	writes: Write[]
	result?: unknown
}

const verbs: Record<string, string> = {
	click: "pressed",
	input: "typed in",
	keydown: "typed in",
	keyup: "typed in",
	focus: "went into",
	mouseup: "clicked",
	pointerup: "let go of",
	pointermove: "moved over",
	dblclick: "double-clicked",
	change: "changed",
	submit: "sent",
	pointerdown: "touched",
}

export function createExplain(opts: {
	line: HTMLElement
	// a path clicked in the line: pick it
	go: (path: string) => void
}) {
	let now: Happening | undefined
	let world: Any
	let timer: ReturnType<typeof setTimeout> | undefined
	let undo: (() => void) | undefined
	let shown = false

	const open = () => (now ??= { writes: [] })
	// the happening closes when the task that made it is over
	// what a person set off stays up a while: a timer's or a frame's writes do not cover it then
	let held = 0
	const settle = () => {
		clearTimeout(timer)
		timer = setTimeout(() => {
			const mine = !!now?.call
			if (now && (mine || performance.now() > held)) draw(now)
			if (mine) held = performance.now() + 4000
			now = undefined
		}, 0)
	}

	function attach(w: Any, doc: Document | undefined) {
		undo?.()
		now = undefined
		world = w
		opts.line.replaceChildren(dim("nothing yet: press something in the render"))
		if (!w?.places) return
		const places = w.places
		const wrote = places.commit
		places.commit = function (changed: Any[]) {
			try {
				for (const c of changed) record(w, c)
			} catch { /* saying what happened never stops it happening */ }
			return wrote.call(this, changed)
		}
		const call = (e: Event) => {
			const d = (e as CustomEvent).detail
			const el = e.target as HTMLElement
			// a slider or a picker by its name or its kind, a field by what it holds for
			const kind = (el as HTMLInputElement).type
			const picks = el.localName === "select" ||
				["range", "checkbox", "radio", "color"].includes(kind)
			const label = (picks ? "" : (el.textContent ?? "").trim().slice(0, 18)) ||
				el.getAttribute("aria-label") || el.getAttribute("title") ||
				el.getAttribute("name") || el.getAttribute("placeholder") ||
				(kind === "range" ? "a slider" : `<${el.localName}>`)
			// the event as the browser made it: a person's, or one a script made (click(), dispatch)
			const verb = picks && (d.type === "input" || d.type === "change")
				? (kind === "range" ? "moved" : "picked in")
				: verbs[d.type] ?? d.type
			now = {
				who: {
					text: d.trusted === false
						? `🤖 a script ${verb} “${label}”`
						: `🫵 you ${verb} “${label}”`,
					title: `a ${d.type} on <${el.localName}>${
						d.trusted === false ? ", made by script" : ""
					}`,
				},
				call: d.path,
				writes: [],
			}
		}
		const called = (e: Event) => {
			if (now) now.result = (e as CustomEvent).detail.result
			settle()
		}
		doc?.addEventListener("ermine:call", call)
		doc?.addEventListener("ermine:called", called)
		undo = () => {
			places.commit = wrote
			doc?.removeEventListener("ermine:call", call)
			doc?.removeEventListener("ermine:called", called)
		}
	}

	// one changed node: who wrote it (its header's pairs) and what (its patches)
	function record(w: Any, node: Any) {
		const [[part, id] = []] = w.table.who(node) ?? []
		// a computation's status node (computer:<n>) is written by the computation itself: not a
		// write of anyone's to tell
		if (typeof id === "string" && id.startsWith("computer:")) return
		const c = node.change ?? {}
		const pairs: [string, unknown][] = c.metadata ?? []
		const get = (k: string) => pairs.findLast(([x]) => x === k)?.[1]
		const h = open()
		// who started it: a call's caller, an outside writer (via), the host; a part running on its
		// own (a promise landing) needs no one: the line starts with it
		if (!h.who && (get("caller") !== undefined || get("via") !== undefined || !get("part"))) {
			const caller = get("caller"), via = get("via")
			h.who = via || caller === "inspector"
				? { text: `🔍 the ${via ?? "inspector"}` }
				: caller !== undefined
				? {
					text: get("trusted") === true
						? `🫵 ${caller}, for a person`
						: `⏰ ${caller}'s own code`,
					title: "a call no event of yours made: a timer, or another process",
				}
				: { text: "🏠 the host" }
		}
		const name = get("part") as string | undefined
		const kind = name
			? [...(w.parts?.values() ?? [])].find((r: Any) => r.at?.[1] === name)?.c?.kind
			: undefined
		h.writes.push({
			by: name ?? String(get("caller") ?? get("via") ?? "host"),
			how: name ? (kind === "compute" ? "ran" : "acted") : "wrote",
			part,
			id,
			patches: c.op?.patches ?? [],
			value: node.value,
		})
		settle()
	}

	// every node's names from the root, by id: one walk, as the happening is drawn
	function names() {
		const out = new Map<string, string>()
		// the table read untouched: nothing here is tracked
		const walk = (id: unknown, path: string, depth: number) => {
			const k = String(id)
			if (out.has(k) || depth > 16) return
			out.set(k, path)
			const v = world.table.get("children", id)?.value ?? {}
			for (const [name, m] of Object.entries(v as Record<string, unknown>)) {
				if (typeof m !== "string" && typeof m !== "symbol") continue
				walk(m, `${path === "/" ? "" : path}/${name}`, depth + 1)
			}
		}
		try {
			walk("root", "/", 0)
		} catch { /* a world going: what was found is enough */ }
		return out
	}

	// a write in words: a value's node "path = value", a children node what was placed in it
	function say(x: Write, paths: Map<string, string>) {
		const at = paths.get(String(x.id)) ?? String(x.id).slice(0, 6)
		if (x.part === "children") {
			return x.patches.map((p) => {
				const there = `${at === "/" ? "" : at}/${p.path?.[0] ?? ""}`
				const verb = p.move ? "moved" : "value" in p ? "placed" : "took out"
				return { text: `${verb} ${there.slice(1)}`, path: there }
			})
		}
		const v = preview(x.value)
		const text = `${at.slice(1)}${v && v.length <= 16 ? ` = ${v}` : " changed"}`
		return [{ text: x.how === "wrote" ? `wrote ${text}` : text, path: at }]
	}

	const dim = (text: string) => chip("dim", text)
	function chip(cls: string, text: string, path?: string, title?: string) {
		const e = document.createElement(path ? "button" : "span")
		e.className = "hchip " + cls
		e.textContent = text
		if (title) e.title = title
		if (path) e.onclick = () => opts.go(path)
		return e
	}
	const arrow = () => {
		const e = document.createElement("span")
		e.className = "harrow"
		e.textContent = "→"
		return e
	}

	function draw(h: Happening) {
		const out: HTMLElement[] = []
		if (h.who) out.push(chip("who", h.who.text, undefined, h.who.title))
		if (h.call) out.push(chip("call", `🪝 ${h.call}`, h.call, "the handler called"))
		const paths = names()
		const all = h.writes.flatMap((x) => say(x, paths).map((s) => ({ ...s, x })))
		let by: string | undefined
		for (const [n, { text, path, x }] of all.entries()) {
			if (n >= 9) {
				out.push(dim(`+${all.length - 9} more`))
				break
			}
			// a part's writes: it acted (or ran), then what it wrote
			if (x.how !== "wrote" && x.by !== by) out.push(chip("part", `⚙️ ${x.by} ${x.how}`))
			by = x.by
			out.push(chip("wrote", text, path))
		}
		if (h.result !== undefined) out.push(chip("result", `↩ ${preview(h.result)}`))
		if (!h.writes.length && h.call) out.push(dim("nothing changed"))
		opts.line.replaceChildren()
		out.forEach((e, i) => {
			if (i) opts.line.append(arrow())
			opts.line.append(e)
		})
		if (shown) {
			opts.line.classList.remove("fresh")
			void opts.line.offsetWidth
			opts.line.classList.add("fresh")
		}
	}

	return {
		attach,
		show(on: boolean) {
			shown = on
			opts.line.hidden = !on
		},
	}
}
