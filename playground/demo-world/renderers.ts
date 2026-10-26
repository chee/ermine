/// <reference lib="dom" />
// renderers: a PROPOSAL, not decided api. pulled out of prog-render's host so other worlds can try
// it. one ui (data) drawn on several screens, each through its own host, each node in it getting
// the renderer that fits on that screen, and why.
//
//   import { charHost, domHost, mirror, renderers, runner } from "@ermine/slaygrounds/renderers"
//   const hosts = { dom: domHost(), chars: charHost() }
//   world.seed((h) => {
//   	runner(h, "/screens/dom/run", hosts.dom, ["dom", "canvas"])
//   	renderers(h, "/renderers", mod.renderers)
//   })
//   // in a process whose folder is /screens/dom:
//   export const dom = (api) => mirror(api, hosts.dom, "/app/ui")
//
// renderers are openers, found by programs' openwith:
//   a renderer is a node: attributes opens (the UTI of the nodes it draws) and needs (keys), type
//     javascript, its value the draw function. a folder saying loaders holds them (renderers())
//   a node to draw says what it is: its ermine.type (there is no guessing from the value)
//   a key (canvas, chars) is what a screen's runner provides (runner()). an opener needing a key
//     has a way only where a runner on its walk provides it: otherwise the whynot says "needs"
//   the mirror process's folder decides the walk: a screen's own renderers, nearer, win over farther
//   "the nearest that fits" is openwith's order (nearest level, then shortest chain); the other
//     ways fit but are farther; the misses are the ones a missing key stopped
// what it does not do: compose (a list drawn as text drawn as view): one step only, and no renderer
// is chosen for a node with no type
import type { API } from "@ermine/programs/api"
import { ATTRIBUTES as A } from "@ermine/programs"

const JS = "com.netscape.javascript-source"

// ---- a host: shift's Host (shift/render/render.ts), setProperty without a ctx. ops counts what was
// done; output is what the screen's process gives as its value ----
export interface Host<N = any> {
	element(tag: string): N
	text(value: string): N
	setText(node: N, value: string): void
	insert(parent: N, node: N, before: N | null): void
	remove(parent: N, node: N): void
	nextSibling(node: N): N | null
	parent(node: N): N | null
	firstChild(node: N): N | null
	setProperty(el: N, key: string, value: unknown): void
	root: N
	output(): Element
	// after a draw: nothing, or the screen drawn again
	paint?(): void
	ops: Record<string, number>
}
// a renderer: opens a UTI, may need keys; draw is given the host, the value, and what it made and
// showed last time for this node (both undefined the first time, or after another drew it)
export type Draw = (host: Host, value: any, was?: any, before?: any) => any
export type Renderer = { opens: string; needs?: string[]; draw: Draw }
// what the mirror says of a node drawn (its got node): its type, the renderer it got, the others
// that fit farther, the ones that would have but for a key
export type Got = {
	at: string
	type: string | null
	pick: { name: string; from: string } | null
	fits: { name: string; from: string }[]
	misses: { name: string; from: string; missing: string[] }[]
	why: string | null
}

const counter = () => ({ element: 0, text: 0, setText: 0, insert: 0, remove: 0, setProperty: 0 })

// ---- a DOM host: a div.screen. a property on:<event> is the handler; one in properties is set by
// its own function (a canvas's pixels, say); any other is an attribute (null or false: none) ----
export function domHost(
	properties: Record<string, (el: HTMLElement, value: any) => void> = {},
): Host<Node> {
	const ops = counter()
	const root = document.createElement("div")
	root.className = "screen"
	return {
		ops,
		root,
		element: (tag) => (ops.element++, document.createElement(tag)),
		text: (v) => (ops.text++, document.createTextNode(v)),
		setText: (n, v) => (ops.setText++, (n as Text).data = v),
		insert: (parent, n, before) => (ops.insert++, parent.insertBefore(n, before)),
		remove: (parent, n) => (ops.remove++, parent.removeChild(n)),
		nextSibling: (n) => n.nextSibling,
		parent: (n) => n.parentNode,
		firstChild: (n) => n.firstChild,
		setProperty(el, key, v) {
			ops.setProperty++
			const e = el as HTMLElement
			if (key.startsWith("on:")) (e as any)["on" + key.slice(3)] = v ?? null
			else if (key in properties) properties[key](e, v)
			else if (v == null || v === false) e.removeAttribute(key)
			else e.setAttribute(key, v === true ? "" : String(v))
		},
		output: () => root,
	}
}

// ---- a character host: a tree of { tag | text, kids, props }, laid out as rows of characters in a
// pre.chars, width wide. a button's cells are clickable: they call its on:click. a run of cells is
// a span whose class is its kind: hot (a button), h1, number (class="number") ----
type Cell = { tag?: string; text?: string; kids: Cell[]; props: Record<string, any> }
export function charHost(width = 34): Host<Cell> {
	const ops = counter()
	const ups = new WeakMap<Cell, Cell>()
	const root: Cell = { tag: "screen", kids: [], props: {} }
	const pre = document.createElement("pre")
	pre.className = "chars"
	let dirty = true
	const op = (k: keyof typeof ops) => (ops[k]++, dirty = true)
	const unhook = (n: Cell) => {
		const up = ups.get(n)
		if (up) up.kids.splice(up.kids.indexOf(n), 1)
		ups.delete(n)
	}
	return {
		ops,
		root,
		element: (tag) => (op("element"), { tag, kids: [], props: {} }),
		text: (text) => (op("text"), { text, kids: [], props: {} }),
		setText: (n, text) => (op("setText"), n.text = text),
		insert(parent, n, before) {
			op("insert")
			unhook(n)
			const i = before ? parent.kids.indexOf(before) : -1
			parent.kids.splice(i < 0 ? parent.kids.length : i, 0, n)
			ups.set(n, parent)
		},
		remove: (_parent, n) => (op("remove"), unhook(n)),
		nextSibling(n) {
			const up = ups.get(n)
			return up?.kids[up.kids.indexOf(n) + 1] ?? null
		},
		parent: (n) => ups.get(n) ?? null,
		firstChild: (n) => n.kids[0] ?? null,
		setProperty: (
			el,
			key,
			v,
		) => (op("setProperty"), v === undefined ? delete el.props[key] : el.props[key] = v),
		output: () => pre,
		paint() {
			if (!dirty) return
			dirty = false
			const [rows, marks] = lay(root, width)
			const out: (string | HTMLElement)[] = []
			rows.forEach((row, r) => {
				const mark = marks.get(r) ?? []
				for (let i = 0; i < row.length;) {
					const m = mark[i]
					let j = i + 1
					while (j < row.length && mark[j] === m) j++
					const text = row.slice(i, j)
					if (!m) out.push(text)
					else {
						const span = document.createElement("span")
						span.className = m.kind
						span.textContent = text
						if (m.el) span.onclick = (e) => m.el.props["on:click"]?.(e)
						out.push(span)
					}
					i = j
				}
				out.push("\n")
			})
			pre.replaceChildren(...out)
		},
	}
}

// blocks start on a row of their own; a button is [ its text ], its cells clickable; an h1 is
// underlined
const blocks = new Set(["screen", "div", "p", "section", "figure", "ul", "li", "pre", "h1", "h2"])
function lay(top: Cell, width: number): [string[], Map<number, any[]>] {
	const rows: string[] = []
	const marks = new Map<number, any[]>()
	let line = ""
	const end = () => (rows.push(line.padEnd(width)), line = "")
	const block = () => line.length && end()
	const gap = () => (block(), rows.length && rows[rows.length - 1].trim() && end())
	const put = (text: string, mark?: unknown) => {
		for (const ch of text) {
			if (ch === "\n") {
				end()
				continue
			}
			if (line.length >= width) end()
			if (mark) {
				if (!marks.has(rows.length)) marks.set(rows.length, [])
				marks.get(rows.length)![line.length] = mark
			}
			line += ch
		}
	}
	const walk = (n: Cell, mark?: unknown) => {
		if (n.text !== undefined) return put(n.text, mark)
		const kids = (m = mark) => n.kids.forEach((k) => walk(k, m))
		if (n.tag === "h1") {
			gap()
			kids({ kind: "h1" })
			const length = line.length
			end()
			put("═".repeat(Math.max(1, length)))
			end()
		} else if (n.tag === "button") {
			const hot = { kind: "hot", el: n }
			put("[ ", hot)
			kids(hot)
			put(" ]", hot)
		} else if (n.tag === "li") (block(), put("• "), kids(), block())
		else if (n.tag === "p" || n.tag === "section" || n.tag === "figure") (gap(), kids(), block())
		else if (blocks.has(n.tag!)) (block(), kids(), block())
		else kids(n.props.class === "number" ? { kind: "number" } : mark)
	}
	walk(top)
	block()
	return [rows, marks]
}

// ---- the mirror: draws the ui at `at` through a host, in the process given. a ui is data:
// { tag, attrs, kids }, a string, or { node: path } for a node a renderer draws. an attribute
// on:<event> that is a string is a method's path: the event sends to it. what it says of each node
// drawn is written to its own got node ([Got]), and the host ops of the last draw to ops; its
// return is the host's output, the process's view. the process gone: its drawing taken off ----
type Desc =
	| { text: string }
	| { tag: string; attrs: Record<string, unknown>; kids: Desc[] }
	| { node: string; value: unknown; draw?: Draw }
type Rec = {
	out?: any
	text?: string
	tag?: string
	props?: Record<string, unknown>
	kids?: Rec[]
	shown?: any[]
	draw?: Draw
	value?: unknown
}

const last = (p: readonly string[]) => p[p.length - 1]
const upto = (p: readonly string[]) => "/" + p.slice(0, -1).join("/")

export function mirror(api: API, h: Host, at: string) {
	const { open, read, edit, effect, openwith, send, info, teardown } = api
	const got = open("got", [])
	const ops = open("ops", {})
	let top: Rec | undefined
	let shown: any[] = []
	let wrote = ["", ""]

	// tracked: the ui, and for each node in it the value and the ways to open it, nearest first
	function describe() {
		const ui = read(at) as any
		const rows: Got[] = []
		const walk = (x: any): Desc => {
			if (typeof x === "string") return { text: x }
			if (x.node === undefined) {
				return { tag: x.tag, attrs: x.attrs ?? {}, kids: (x.kids ?? []).map(walk) }
			}
			const value = read(x.node)
			const type = read(info(x.node), [A.type]) as string | undefined
			const ways = []
			// the whynots that matter: a renderer that fits but whose runner lacks a key it needs. the
			// runner says what is missing (needs, for the renderer), the renderer says it has no chain
			const lacks = new Map<unknown, string[]>()
			const stuck: { id: unknown; at: readonly string[] }[] = []
			let notype = false
			for (
				const way of openwith(x.node, {
					onwhynot: (w) => {
						if (!("for" in w)) {
							if (w.why === "no-type") notype = true
						} else if (w.why === "needs") {
							lacks.set(w.for, [...(lacks.get(w.for) ?? []), ...(w.missing ?? [])])
						} else if (w.why === "no-chain") stuck.push(w)
					},
				})
			) ways.push(way)
			const missed: Got["misses"] = stuck.map((w) => ({
				name: last(w.at),
				from: upto(w.at),
				missing: [...new Set(lacks.get(w.id) ?? [])],
			}))
			const pick = ways[0]?.program
			rows.push({
				at: x.node,
				type: type ?? null,
				pick: pick ? { name: last(pick.at), from: upto(pick.at) } : null,
				fits: ways.slice(1).map((w) => ({
					name: last(w.program.at),
					from: upto(w.program.at),
				})),
				misses: missed,
				why: pick
					? null
					: notype || type === undefined
					? "it has no type"
					: missed.length
					? `${
						missed.map((m) => `${m.name} needs ${m.missing.join(", ")}`).join("; ")
					}: not on this walk`
					: `nothing here opens ${type}`,
			})
			const draw = pick ? read({ id: pick.id, part: "value" }) as Draw : undefined
			return { node: x.node, value, draw }
		}
		return ui === undefined ? undefined : { tree: walk(ui), rows }
	}

	// the act: the desc drawn against what was drawn before, only what differs
	function make(d: Desc, prev: Rec | undefined): Rec {
		if ("text" in d) {
			if (prev?.text !== undefined) {
				if (prev.text !== d.text) h.setText(prev.out, d.text)
				return { ...prev, text: d.text }
			}
			return { out: h.text(d.text), text: d.text }
		}
		if ("node" in d) {
			if (!d.draw) return { value: d.value }
			const again = prev?.draw === d.draw
			const out = d.draw(
				h,
				d.value,
				again ? prev!.out : undefined,
				again ? prev!.value : undefined,
			)
			return { out, draw: d.draw, value: d.value }
		}
		const same = prev?.tag === d.tag
		const out = same ? prev!.out : h.element(d.tag)
		const was = same ? prev!.props! : {}
		for (const k of new Set([...Object.keys(was), ...Object.keys(d.attrs)])) {
			if (was[k] === d.attrs[k]) continue
			const v = d.attrs[k]
			// on:<event> is a method's path: a click sends to it, as the person (the native event)
			h.setProperty(out, k, k.startsWith("on:") && typeof v === "string" ? () => send(v) : v)
		}
		const kids = d.kids.map((k, i) => make(k, same ? prev!.kids![i] : undefined))
		const next = kids.map((k) => k.out).filter((o) => o != null)
		return {
			out,
			tag: d.tag,
			props: d.attrs,
			kids,
			shown: reconcile(h, out, same ? prev!.shown! : [], next),
		}
	}

	effect("mirror", describe, (d) => {
		const before = { ...h.ops }
		top = d && make(d.tree, top)
		shown = reconcile(h, h.root, shown, top?.out ? [top.out] : [])
		h.paint?.()
		const done: Record<string, number> = {}
		for (const k in h.ops) if (h.ops[k] !== before[k]) done[k] = h.ops[k] - before[k]
		// a write only for what changed: the table and the counts are nodes
		const rows = JSON.stringify(d?.rows ?? [])
		const counts = JSON.stringify(done)
		if (rows !== wrote[0]) edit(got, [{ path: [], value: d?.rows ?? [] }])
		if (counts !== wrote[1]) edit(ops, [{ path: [], value: done }])
		wrote = [rows, counts]
	})

	// the process gone or replaced: its drawing taken off the screen
	teardown(() => {
		reconcile(h, h.root, shown, [])
		h.paint?.()
	})
	return h.output()
}

// shift's reconcile (shift/render/render.ts), on a host: take out what is no longer wanted, move
// only what is out of place, so a node kept is never touched. gives back next
export function reconcile(host: Host, parent: any, current: any[], next: any[]) {
	if (!current.length && !next.length) return current
	const keep = new Set(next)
	for (const n of current) if (!keep.has(n) && host.parent(n) === parent) host.remove(parent, n)
	let before = null
	for (let i = next.length - 1; i >= 0; i--) {
		const n = next[i]
		if (host.parent(n) !== parent || host.nextSibling(n) !== before) {
			host.insert(parent, n, before)
		}
		before = n
	}
	return next
}

// ---- the nodes, written with the api given (a host's, in a seed) ----

// a node at a path: made if not there, its value then written, its attributes written whole
function put(h: API, at: string, value: unknown, attributes: Record<string, unknown>) {
	const node = h.open(at)
	if (h.read(node) === undefined) h.open(at, value)
	else h.edit(node, [{ path: [], value }])
	h.edit(h.info(node), [{ path: [], value: attributes }])
}

// the folder at `at` says loaders (its children are the candidates, in its place) and holds the
// renderers given, no others: each a node, its draw the value, typed javascript, opening its UTI
export function renderers(h: API, at: string, given: Record<string, Renderer> = {}) {
	const node = h.open(at, null)
	h.edit(h.info(node), [{ path: [], value: { [A.loaders]: true } }])
	for (const [name, r] of Object.entries(given)) {
		put(h, `${at}/${name}`, r.draw, {
			[A.type]: JS,
			[A.opens]: [r.opens],
			...(r.needs ? { [A.needs]: r.needs } : {}),
		})
	}
	for (const name of h.list(at)) if (!(name in given)) h.remove(`${at}/${name}`)
}

// a screen's runner at `at`: a live function from the host (no type) taking javascript, giving the
// host (to @ermine/software, a runner: the function its start). what it provides is the screen's
// keys: a renderer needing one has a way only on a walk with a runner giving it
export function runner(h: API, at: string, host: Host, provides: readonly string[]) {
	put(h, at, () => host, { [A.takes]: [JS], [A.provides]: provides })
}
