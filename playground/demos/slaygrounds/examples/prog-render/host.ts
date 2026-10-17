// prog-render's host: one app writes a ui, two screens draw it through two hosts, each node getting
// the renderer that fits on that screen, and why. the world (@ermine/slaygrounds/world) does the
// processes; this file holds only what is this demo's: the two hosts, the mirror, the renderers'
// nodes
//
// renderers are openers, found by programs' openwith. kept host-side: only the
// mirror (drawing: one host node per graph node, patching what differs).
//   a renderer is a node: attributes opens (the UTI of the nodes it draws) and needs (keys), type
//     javascript, its value the draw function. /renderers holds the general ones (a folder saying
//     loaders: its children are the candidates), /screens/<name>/renderers a screen's own
//   a node to draw says what it is: its ermine.type (the app sets it; there is no kindOf guessing)
//   a screen's mirror process runs with its cwd at /screens/<name>, so openwith looks there, then
//     up: the screen's own renderers are nearer than /renderers, as before
//   a key (canvas, chars) is what a screen's runner provides. /screens/<name>/run is a runner (a
//     live function, no type) taking javascript; an opener needing canvas has a way only where a
//     runner on its walk provides it: otherwise the whynot says "needs canvas"
//   "the nearest that fits" is openwith's order (nearest level, then shortest chain); the other
//     ways are the ones that fit but are farther; the whynots "needs" are the ones that nearly did
// why it carries them: a renderer is "a program that opens a file of a type, run by something that
// provides what it needs", which is what openwith is. what it does not do, that the old chain did:
// compose (a list drawn as text drawn as view): one step only here, and no renderer is chosen for
// a node with no type. the walk drawn as levels of chips is gone: the table says pick, fits, misses
import { ATTRIBUTES as A } from "@ermine/programs"
import type { API } from "@ermine/api"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const JS = "com.netscape.javascript-source"

// ---- the renderer's interface: shift's Host (shift/render/render.ts), setProperty without a ctx.
// ops counts what was done; output is what the screen's process gives as its value ----
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

// ---- the two hosts ----
const counter = () => ({ element: 0, text: 0, setText: 0, insert: 0, remove: 0, setProperty: 0 })

function domHost(): Host<Node> {
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
			else if (key === "pixels") pixels(e as HTMLCanvasElement, v as any)
			else if (v == null || v === false) e.removeAttribute(key)
			else e.setAttribute(key, v === true ? "" : String(v))
		},
		output: () => root,
	}
}
const shades = ["#fff", "#ffd9ea", "#ff2284"]
function pixels(
	canvas: HTMLCanvasElement,
	{ width, pixels }: { width: number; pixels: Uint8Array },
) {
	const height = Math.ceil(pixels.length / width)
	canvas.width = width
	canvas.height = height
	canvas.style.width = width * 10 + "px"
	canvas.style.height = height * 10 + "px"
	const g = canvas.getContext("2d")!
	pixels.forEach((p, i) => {
		g.fillStyle = shades[p] ?? "#000"
		g.fillRect(i % width, Math.floor(i / width), 1, 1)
	})
}

// a character host: a tree of { tag | text, kids, props }, laid out as rows of characters in a pre.
// a button's cells are clickable: they call its on:click
type Cell = { tag?: string; text?: string; kids: Cell[]; props: Record<string, any> }
function charHost(width = 34): Host<Cell> {
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

const hosts = { dom: domHost(), chars: charHost() }

// ---- the mirror: draws a ui (data: { tag, attrs, kids }, a string, or { node: path } for a node a
// renderer draws) through a host. the app writes the ui as a value; this is the one thing a screen
// process is given beyond the api ----
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
// what the table shows for a node drawn: its type, the renderer it got, the others that fit
// farther, the ones that would have but for a key
export type Got = {
	at: string
	type: string | null
	pick: { name: string; from: string } | null
	fits: { name: string; from: string }[]
	misses: { name: string; from: string; missing: string[] }[]
	why: string | null
}

const last = (p: readonly string[]) => p[p.length - 1]
const upto = (p: readonly string[]) => "/" + p.slice(0, -1).join("/")

function mirror(api: API, h: Host, at: string) {
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
// only what is out of place, so a node kept is never touched
function reconcile(host: Host, parent: any, current: any[], next: any[]) {
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

// what a program is given beyond the api: the hosts, and the mirror
export type Extra = { hosts: typeof hosts; mirror: (h: Host, at: string) => Element }
export type Tools = API & Extra

// ---- the page: the screens side by side, the table under them ----
if (!document.getElementById("prog-render-style")) {
	const style = document.head.appendChild(document.createElement("style"))
	style.id = "prog-render-style"
	style.textContent = `
body { background: #ffff88; margin: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
	align-items: start }
[data-ermine-box] { position: relative; background: #fff; border: 1px solid #000; border-radius: 8px;
	box-shadow: 0 0 10px 2px #66003322; padding: 16px 12px 8px; min-width: 0 }
[data-ermine-box]::before { position: absolute; top: -10px; left: 10px; background: #ffff88;
	border: 1px solid #000; padding: 0 8px; font-size: 12px; font-weight: 600; white-space: nowrap }
[data-ermine-box="screens/dom/mirror"]::before { content: "screens/dom · a DOM host · key: canvas" }
[data-ermine-box="screens/chars/mirror"]::before { content: "screens/chars · a character host · key: chars" }
[data-ermine-box="why"] { grid-column: 1 / -1 }
[data-ermine-box="why"]::before { content: "node → what opens it: the nearest renderer that fits on each screen" }
pre.chars { background: #ffffea; border: 1px solid #000; margin: 0; padding: 6px 8px;
	font: 12px/1.25 Monaco, Menlo, monospace; color: #000; overflow: hidden }
pre.chars .hot { background: #eaffff; cursor: pointer }
pre.chars .hot:hover { background: #ff2284; color: #fff }
pre.chars .number { color: #2269ff; font-weight: bold }
pre.chars .h1 { font-weight: bold }
.screen h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600 }
.screen p { margin: 4px 0 }
.screen .number { color: #2269ff; font: bold 13px Monaco, Menlo, monospace }
.screen figure { margin: 6px 0 }
.screen canvas { display: block; image-rendering: pixelated; border: 1px solid #000 }
.screen section { font-size: 13px }
.screen ul { margin: 2px 0 4px; padding-left: 18px }
.screen .buttons button { margin-right: 4px }
.why { font-size: 12px }
.why p { margin: 0 0 6px }
.why code, .why td, .why th { font: 11px/1.45 Monaco, Menlo, monospace }
.why table { border-collapse: collapse; width: 100% }
.why th { text-align: left; font: 600 12px Jost, sans-serif; border-bottom: 1px solid #000 }
.why td, .why th { padding: 1px 8px 1px 0; vertical-align: top }
.why tr + tr td { border-top: 1px solid #0001 }
.why b { color: #ff2284 }
.why .no { color: #ff2284 }
.why .near { background: #ff2284; color: #fff; padding: 0 3px; border-radius: 2px }
.why .dim { color: #0007 }
.why .kind { background: #c8f6ea; padding: 0 3px; border-radius: 2px }
`
}

// ---- the world ----
const spec = (name: string) => ({
	name,
	export: name,
	at: ["screens", name, "mirror"],
	cwd: ["screens", name],
})
const world = createWorld({
	render,
	processes: [{ name: "app" }, spec("dom"), spec("chars"), { name: "why", export: "why" }],
	extend: (api) => ({ hosts, mirror: (h: Host, at: string) => mirror(api, h, at) }),
})

// a node at a path: made if not there, its value then written, its attributes written whole
function put(h: API, at: string, value: unknown, attributes: Record<string, unknown>) {
	const node = h.open(at)
	if (h.read(node) === undefined) h.open(at, value)
	else h.edit(node, [{ path: [], value }])
	h.edit(h.info(node), [{ path: [], value: attributes }])
}
// a folder of candidates: its children are the openers, in its place
function folder(h: API, at: string) {
	const node = h.open(at, null)
	h.edit(h.info(node), [{ path: [], value: { [A.loaders]: true } }])
	return node
}
// the folder's children are the renderers given, no others
function renderers(h: API, at: string, given: Record<string, Renderer> = {}) {
	folder(h, at)
	for (const [name, r] of Object.entries(given)) {
		put(h, `${at}/${name}`, r.draw, {
			[A.type]: JS,
			[A.opens]: [r.opens],
			...(r.needs ? { [A.needs]: r.needs } : {}),
		})
	}
	for (const name of h.list(at)) if (!(name in given)) h.remove(`${at}/${name}`)
}

// a screen's runner: a live function from the host, no type, taking javascript. what it provides
// is the screen's keys: a renderer needing one has a way only on a walk with a runner giving it
world.seed((h) => {
	for (const [name, provides] of [["dom", ["dom", "canvas"]], ["chars", ["chars"]]] as const) {
		put(h, `/screens/${name}/run`, () => hosts[name], {
			[A.takes]: [JS],
			[A.provides]: provides,
		})
	}
})

// a reload: the program's exports written as nodes by the world, and the renderers beside them
export function reload(mod: Record<string, any>) {
	world.seed((h) => {
		renderers(h, "/renderers", mod.renderers)
		for (const name of ["dom", "chars"]) {
			renderers(h, `/screens/${name}/renderers`, mod.screens?.[name])
		}
	})
	world.reload(mod)
}
