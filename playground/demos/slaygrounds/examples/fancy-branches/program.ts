/** @jsxImportSource ermine-h */
import apply from "@ermine/core/changeable/apply"
import invert from "@ermine/core/changeable/invert"
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	patch,
	peep,
	read as readNode,
	ref,
	unplace,
} from "@ermine/system"
import { bind, handler } from "ermine-h"

// fancy-branches: time travel with branches. a small drawing (shapes on a sky) whose every change
// is kept as a step: its patches and their inverses, a node each under /branches/steps. a step
// has a parent, so the steps are a tree. going back and changing something starts a branch: the
// future you left is still there, with a name on its tip.
//   jump        undo along the inverses back to the fork, then the patches forward
//   merge       replay the steps one branch made, on the branch you are on. refused where both
//               changed the same shape (or the sky); nothing is applied then
//   compare     two branches' pictures side by side, what differs ringed

const W = 360, H = 240
const inks = ["#ff2284", "#40dcba", "#2269ff", "#ff9a3c", "#9b6bff", "#ffe94d", "#000000"]
const inkName: Record<string, string> = {
	"#ff2284": "cherry",
	"#40dcba": "mint",
	"#2269ff": "blue",
	"#ff9a3c": "orange",
	"#9b6bff": "purple",
	"#ffe94d": "lemon",
	"#000000": "black",
}
const skies = ["#fffbe0", "#ffd9ea", "#c8f6ea", "#d4e4ff", "#ffffc2"]
const skyName: Record<string, string> = {
	"#fffbe0": "cream",
	"#ffd9ea": "pink",
	"#c8f6ea": "mint",
	"#d4e4ff": "sky",
	"#ffffc2": "lemon",
}
const kinds = ["circle", "square", "star", "triangle"]
const lanes = ["#ff2284", "#2269ff", "#40dcba", "#ff9a3c", "#9b6bff", "#000000"]
const names = ["main", "plum", "mint", "sorbet", "fig", "clover", "pearl", "wren", "olive", "lark"]

type Shape = { k: string; x: number; y: number; c: string; s: number }
type Doc = { sky: string; shapes: Record<string, Shape> }
type Patch = { path: (string | number)[]; value?: unknown }
type Step = {
	id: string
	n: number
	parent: string | null
	label: string
	glyph: string
	patches: Patch[]
	undo: Patch[]
	doc?: Doc
	from?: string
}
type Branch = { name: string; tip: string }

const start = (): Doc => ({
	sky: "#fffbe0",
	shapes: {
		sun: { k: "circle", x: 300, y: 52, c: "#ff9a3c", s: 26 },
		home: { k: "square", x: 110, y: 168, c: "#ff2284", s: 38 },
		roof: { k: "triangle", x: 110, y: 100, c: "#2269ff", s: 44 },
	},
})

// ---- pictures ----
function shape(g: CanvasRenderingContext2D, s: Shape, alpha = 1, dashed = false) {
	g.save()
	g.translate(s.x, s.y)
	g.globalAlpha = alpha
	g.fillStyle = s.c
	g.strokeStyle = "#000"
	g.lineWidth = 2
	if (dashed) g.setLineDash([4, 3])
	g.beginPath()
	if (s.k === "circle") g.arc(0, 0, s.s, 0, 7)
	else if (s.k === "square") g.rect(-s.s * 0.85, -s.s * 0.85, s.s * 1.7, s.s * 1.7)
	else if (s.k === "triangle") {
		g.moveTo(0, -s.s), g.lineTo(s.s * 0.95, s.s * 0.75), g.lineTo(-s.s * 0.95, s.s * 0.75)
		g.closePath()
	} else {
		for (let i = 0; i < 10; i++) {
			const r = i % 2 ? s.s * 0.45 : s.s, a = (i * Math.PI) / 5 - Math.PI / 2
			g[i ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r)
		}
		g.closePath()
	}
	if (!dashed) g.fill()
	g.stroke()
	g.restore()
}
function ring(g: CanvasRenderingContext2D, s: Shape, color: string) {
	g.save()
	g.strokeStyle = color
	g.lineWidth = 3
	g.setLineDash([5, 4])
	g.beginPath()
	g.arc(s.x, s.y, s.s * 1.35 + 4, 0, 7)
	g.stroke()
	g.restore()
}
function scene(g: CanvasRenderingContext2D, d: Doc, k: number, draw: () => void) {
	g.save()
	g.scale(k, k)
	g.fillStyle = d.sky
	g.fillRect(0, 0, W, H)
	g.fillStyle = "#0000000d"
	for (let x = 12; x < W; x += 24) for (let y = 12; y < H; y += 24) g.fillRect(x, y, 2, 2)
	draw()
	g.restore()
}
const hit = (d: Doc, x: number, y: number) => {
	const ids = Object.keys(d.shapes).reverse()
	return ids.find((id) => {
		const s = d.shapes[id]
		return Math.hypot(s.x - x, s.y - y) <= s.s * 1.05
	})
}

// ---- patches: what a step touches, to know where two branches meet ----
// key -> { value, gone }: "shape:id" for a whole shape, "shape:id.x" for a field, "sky"
function touches(ps: Patch[]) {
	const out = new Map<string, { value: unknown; gone: boolean }>()
	for (const p of ps) {
		const [a, id, field] = p.path
		if (a === "sky") out.set("sky", { value: p.value, gone: false })
		else if (a === "shapes" && p.path.length === 2) {
			out.set(`shape:${id}`, { value: p.value, gone: !("value" in p) })
		} else if (a === "shapes") out.set(`shape:${id}.${field}`, { value: p.value, gone: false })
	}
	return out
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// the pictures differ: a line each
function diffDocs(a: Doc, b: Doc, an: string, bn: string) {
	const out: { mark: "a" | "b" | "both" | "sky"; text: string; id?: string }[] = []
	if (a.sky !== b.sky) {
		out.push({
			mark: "sky",
			text: `sky: ${skyName[a.sky] ?? a.sky} on ${an}, ${skyName[b.sky] ?? b.sky} on ${bn}`,
		})
	}
	for (const id of new Set([...Object.keys(a.shapes), ...Object.keys(b.shapes)])) {
		const x = a.shapes[id], y = b.shapes[id]
		if (x && !y) out.push({ mark: "a", id, text: `${x.k} ${id} only on ${an}` })
		else if (y && !x) out.push({ mark: "b", id, text: `${y.k} ${id} only on ${bn}` })
		else if (x && y) {
			const parts = (["x", "y", "c", "s", "k"] as const).filter((f) => x[f] !== y[f]).map((f) =>
				f === "c"
					? `colour ${inkName[x.c] ?? x.c} → ${inkName[y.c] ?? y.c}`
					: `${f} ${x[f]} → ${y[f]}`
			)
			if (parts.length) out.push({ mark: "both", id, text: `${x.k} ${id}: ${parts.join(", ")}` })
		}
	}
	return out
}

// ---- the tree: depth across, a lane per fork ----
function layout(S: Record<string, Step>) {
	const ids = Object.keys(S).sort((a, b) => S[a].n - S[b].n)
	const kids: Record<string, string[]> = {}
	for (const id of ids) if (S[id].parent) (kids[S[id].parent!] ??= []).push(id)
	const depth: Record<string, number> = {}, lane: Record<string, number> = {}
	for (const id of ids) depth[id] = S[id].parent ? depth[S[id].parent!] + 1 : 0
	// a first child goes on in its parent's lane; each later one takes a lane of its own, in order
	const later = ids.filter((id) => S[id].parent && kids[S[id].parent!][0] !== id)
	later.forEach((id, i) => (lane[id] = i + 1))
	for (const id of ids) {
		if (!S[id].parent) lane[id] = 0
		else if (!(id in lane)) lane[id] = lane[S[id].parent!]
	}
	return {
		nodes: ids.map((id) => ({
			id,
			n: S[id].n,
			depth: depth[id],
			lane: lane[id],
			parent: S[id].parent,
			glyph: S[id].glyph,
			label: S[id].label,
			from: S[id].from,
		})),
		depth: Math.max(0, ...Object.values(depth)),
		lanes: Math.max(0, ...Object.values(lane)) + 1,
	}
}
type Layout = ReturnType<typeof layout>

const css = `
.fb{font-family:Jost,system-ui,sans-serif;color:#000;max-width:1100px;margin:0 auto;padding:6px 4px 24px}
.fb *{box-sizing:border-box}
.fb h1{font-size:22px;margin:4px 0 2px;font-weight:600}
.fb h1 span,.fb h2 em{display:inline-block;background:#fff7a8;border:1px solid #000;padding:0 8px;transform:skew(-8deg);font-size:13px;font-weight:500;font-style:normal}
.fb h1 span{vertical-align:3px;margin-left:6px}
.fb .lede{margin:0 0 12px;font-size:14px;line-height:1.35;max-width:660px}
.fb code,.fb pre{font-family:ui-monospace,Menlo,monospace;font-size:11px}
.fb .card{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:12px;margin-bottom:14px}
.fb .top{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
.fb .top .doc{width:386px}
.fb .top .side{flex:1;min-width:300px}
.fb .doc canvas{display:block;width:360px;height:240px;border:1px solid #000;touch-action:none}
.fb .doc canvas.move{cursor:grab}.fb .doc canvas.add{cursor:crosshair}
.fb .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
.fb .row .lab{font-size:12px;font-weight:600;min-width:44px}
.fb button{font:inherit;font-size:13px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:2px 9px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s}
.fb button:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:3px 3px 0 #000}
.fb button:active:not(:disabled){transform:translate(1px,1px);box-shadow:0 0 0 #000}
.fb button:disabled{opacity:.35;cursor:default;box-shadow:none}
.fb button.on{background:#40dcba}
.fb button.go{background:#ff2284;color:#fff}
.fb button.sm{padding:0 7px;font-size:12px}
.fb .sw{width:22px;height:22px;border:1px solid #000;border-radius:2px;cursor:pointer;box-shadow:1px 1px 0 #000}
.fb .sw.on{outline:3px solid #ff2284;outline-offset:1px}
.fb .where{margin:10px 0 0;font-size:13px;line-height:1.35}
.fb .where b{background:#fff7a8;border:1px solid #000;padding:0 6px;display:inline-block;transform:skew(-8deg)}
.fb h2{font-size:13px;font-weight:600;margin:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fb .branches{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.fb .branches li{display:flex;gap:6px;align-items:center;flex-wrap:wrap;border:1px solid #000;padding:4px 6px;background:#fff;box-shadow:2px 2px 0 #000}
.fb .branches li.now{background:#fff7a8}
.fb .branches .dot{width:12px;height:12px;border-radius:50%;border:1px solid #000;flex:none}
.fb .branches .nm{font-weight:600;font-size:13px}
.fb .branches small{font-size:11.5px;opacity:.7;flex:1;min-width:90px}
.fb input[type=text]{font:inherit;font-size:13px;border:1px solid #000;border-radius:2px;padding:2px 6px;width:120px}
.fb .inspect{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.fb .inspect pre{margin:0;background:#fffbe0;border:1px solid #000;padding:6px;white-space:pre-wrap;word-break:break-all;max-height:110px;overflow:auto}
.fb .inspect h4{margin:0 0 3px;font-size:12px;font-weight:600}
.fb .tree{overflow:hidden}
.fb .treewrap{overflow:auto;border:1px solid #000;background:#fffdf0;position:relative}
.fb .treewrap canvas{display:block}
.fb .jumped{margin:8px 0 0;font-size:13px;min-height:18px}
.fb .notice{border:2px solid #ff2284;background:#fff0f7;padding:8px 10px;margin-bottom:8px;font-size:13px;box-shadow:3px 3px 0 #ff2284}
.fb .notice.ok{border-color:#40dcba;background:#effcf8;box-shadow:3px 3px 0 #40dcba}
.fb .notice b{display:block;margin-bottom:3px}
.fb .notice ul{margin:0;padding-left:18px}
.fb .cmp{display:flex;gap:14px;flex-wrap:wrap}
.fb .cmp figure{margin:0}
.fb .cmp canvas{display:block;width:360px;height:240px;border:1px solid #000}
.fb .cmp figcaption{font-size:13px;font-weight:600;margin-bottom:4px;display:flex;gap:6px;align-items:center}
.fb .cmp figcaption i{width:12px;height:12px;border-radius:50%;border:1px solid #000;display:inline-block}
.fb .diff{flex:1;min-width:230px;margin:0;padding:0;list-style:none;font-size:13px;display:flex;flex-direction:column;gap:4px}
.fb .diff li{border-left:4px solid #40dcba;padding:1px 0 1px 8px}
.fb .diff li.a{border-color:#ff2284}.fb .diff li.b{border-color:#2269ff}
.fb .hint{font-size:12.5px;opacity:.65;margin:6px 0 0}
`

export default function program() {
	// what a node holds, as the program takes it (any: its values are its own); the actions run
	// untracked (peep)
	// deno-lint-ignore no-explicit-any
	const read = (x: Parameters<typeof readNode>[0]): any => readNode(x)
	const method = (name: string, f: (...a: any[]) => unknown) =>
		createAction(name, (...a: unknown[]) => peep(() => f(...a)))
	// a live thing (a canvas), made once and kept at ./name: a reload finds it again
	const keep = <T,>(name: string, make: () => T) =>
		peep(() => readNode(ref(`./${name}`, make))) as T
	// a whole put: what a recipe would return
	const put = (x: ReturnType<typeof ensureNode>, v: unknown) => patch(x, [{ path: [], value: v }])
	const doc = ensureNode("./doc", start())
	const first: Step = {
		id: "s0",
		n: 0,
		parent: null,
		label: "start",
		glyph: "·",
		patches: [],
		undo: [],
		doc: start(),
	}
	ensureNode("./steps/s0", first)
	const order = ensureNode("./order", ["s0"])
	const tips = ensureNode("./tips", [{ name: "main", tip: "s0" }])
	const at = ensureNode("./at", "s0")
	const branch = ensureNode("./branch", "main") // the branch whose tip we are at; "" when we are in a past
	const lean = ensureNode("./lean", "main") // the branch last on: where forward goes
	const serial = ensureNode("./serial", 0)
	const hover = ensureNode("./hover", "")
	const jumped = ensureNode("./jumped", null)
	const notice = ensureNode("./notice", null)
	const cmp = ensureNode("./cmp", { a: "", b: "" })
	const mode = ensureNode("./mode", "add")
	const kind = ensureNode("./kind", "star")
	const ink = ensureNode("./ink", inks[1])

	// ---- reading ----
	const steps = () => {
		const S: Record<string, Step> = {}
		for (const id of read(order) as string[]) {
			const step = read(`./steps/${id}`) as Step | undefined
			if (step) S[id] = step
		}
		return S
	}
	const list = () => (read(tips) as Branch[]) ?? []
	const chain = (S: Record<string, Step>, id: string) => {
		const out: string[] = []
		for (let x: string | null = id; x && S[x]; x = S[x].parent) out.push(x)
		return out
	}
	const docAt = (S: Record<string, Step>, id: string): Doc => {
		let d = S.s0.doc!
		for (const x of chain(S, id).reverse().slice(1)) d = apply(d, S[x].patches) as Doc
		return d
	}

	// ---- derived ----
	const layoutE = createMemo("layout", () => layout(steps()))
	createMemo("rows", () => {
		const S = steps(), L = layout(S), now = read(branch) as string, c = read(cmp) as any
		const lane = Object.fromEntries(L.nodes.map((n) => [n.id, n.lane]))
		return list().map((b) => ({
			name: b.name,
			color: lanes[lane[b.tip] % lanes.length],
			steps: chain(S, b.tip).length - 1,
			label: S[b.tip]?.label ?? "",
			now: b.name === now,
			a: b.name === c.a,
			b: b.name === c.b,
		}))
	})
	createMemo("where", () => {
		const S = steps(), id = read(at) as string, now = read(branch) as string
		const n = S[id]?.n ?? 0
		return now
			? { text: `on branch`, name: now, n, label: S[id]?.label }
			: { text: `back at step ${n}, in the past of`, name: read(lean), n, label: S[id]?.label }
	})
	createMemo("focus", () => {
		const S = steps(), id = (read(hover) as string) || (read(at) as string)
		const s = S[id]
		return s
			? {
				title: `#${s.n} ${s.label}`,
				patches: JSON.stringify(s.patches),
				undo: JSON.stringify(s.undo),
				hovered: id === read(hover),
			}
			: null
	})
	const compareE = createMemo("compare", () => {
		const S = steps(),
			bs = list(),
			c = read(cmp) as { a: string; b: string },
			now = read(branch)
		const have = (n: string) => bs.find((b) => b.name === n)
		const a = have(c.a) ?? have(now as string) ?? bs[0]
		const b = have(c.b) ?? bs.find((x) => x !== a) ?? a
		if (!a || !b) return null
		const da = docAt(S, a.tip), db = docAt(S, b.tip)
		return {
			a: a.name,
			b: b.name,
			docA: da,
			docB: db,
			diff: diffDocs(da, db, a.name, b.name),
		}
	})

	// ---- changes ----
	const clear = () => notice && put(notice, null)
	const next = () => {
		const n = (read(serial) as number) + 1
		put(serial, n)
		return n
	}
	// one change: the patches go on the picture, and a step keeps them with their inverse
	const record = (patches: Patch[], label: string, glyph: string, from?: string) => {
		const here = read(at) as string
		const undo = invert(read(doc), patches) as Patch[]
		patch(doc, patches)
		const n = next(), id = `s${n}`
		const step: Step = {
			id,
			n,
			parent: here,
			label,
			glyph,
			patches,
			undo,
			...(from ? { from } : {}),
		}
		ensureNode(`./steps/${id}`, step)
		put(order, [...(read(order) as string[]), id])
		const bs = list(), now = read(branch) as string
		if (now && bs.find((b) => b.name === now)?.tip === here) {
			put(tips, bs.map((b) => (b.name === now ? { ...b, tip: id } : b)))
		} else {
			// a change in the past: the future stays where it is, and this is a branch of its own
			const used = new Set(bs.map((b) => b.name))
			const name = names.find((x) => !used.has(x)) ?? `b${n}`
			put(tips, [...bs, { name, tip: id }])
			put(branch, name)
			put(lean, name)
		}
		put(at, id)
		put(jumped, null)
		return id
	}
	// move along the tree: the inverses back to the fork, then the patches forward
	const go = (target: string, prefer?: string) => {
		const S = steps(), here = read(at) as string
		if (here === target) {
			const now = read(branch) as string
			const there = list().filter((b) => b.tip === target).map((b) => b.name)
			if (prefer && there.includes(prefer)) (put(branch, prefer), put(lean, prefer))
			else if (!there.includes(now)) put(branch, there[0] ?? "")
			return { down: [], up: [] }
		}
		const A = chain(S, here), B = chain(S, target)
		const inB = new Set(B)
		const fork = A.find((x) => inB.has(x))!
		const down = A.slice(0, A.indexOf(fork)), up = B.slice(0, B.indexOf(fork)).reverse()
		for (const id of down) patch(doc, S[id].undo)
		for (const id of up) patch(doc, S[id].patches)
		const bs = list(), now = read(branch) as string
		const there = bs.filter((b) => b.tip === target).map((b) => b.name)
		const pick = prefer && there.includes(prefer)
			? prefer
			: there.includes(now)
			? now
			: there[0] ?? ""
		put(at, target)
		put(branch, pick)
		if (pick) put(lean, pick)
		put(jumped, { stamp: Date.now(), down, up, fork, to: target, n: S[target].n })
		return { down, up }
	}
	// steps nobody can reach any more are let go
	const prune = () => {
		const S = steps(), keep = new Set<string>(chain(S, read(at) as string))
		for (const b of list()) for (const x of chain(S, b.tip)) keep.add(x)
		const ids = (read(order) as string[]).filter((id) => keep.has(id))
		for (const id of Object.keys(S)) if (!keep.has(id)) unplace(`./steps/${id}`)
		put(order, ids)
	}

	// ---- handlers ----
	const sh = (id: string, d: Doc) => d.shapes[id]
	const newId = () => Math.random().toString(36).slice(2, 5)
	method("on/mode", (m: string) => put(mode, m))
	method("on/kind", (k: string) => (put(kind, k), put(mode, "add")))
	method("on/ink", (c: string) => put(ink, c))
	method("on/add", (x: number, y: number) => {
		clear()
		const id = newId(), k = read(kind) as string
		const s: Shape = { k, x: Math.round(x), y: Math.round(y), c: read(ink) as string, s: 26 }
		record([{ path: ["shapes", id], value: s }], `add ${k} ${id}`, "+")
	})
	method("on/move", (id: string, x: number, y: number) => {
		const s = sh(id, read(doc) as Doc)
		if (!s) return
		clear()
		record(
			[
				{ path: ["shapes", id, "x"], value: Math.round(x) },
				{ path: ["shapes", id, "y"], value: Math.round(y) },
			],
			`move ${s.k} ${id}`,
			"→",
		)
	})
	method("on/paint", (id: string) => {
		const s = sh(id, read(doc) as Doc), c = read(ink) as string
		if (!s || s.c === c) return
		clear()
		record([{ path: ["shapes", id, "c"], value: c }], `${s.k} ${id} ${inkName[c]}`, "●")
	})
	method("on/erase", (id: string) => {
		const s = sh(id, read(doc) as Doc)
		if (!s) return
		clear()
		record([{ path: ["shapes", id] }], `erase ${s.k} ${id}`, "×")
	})
	method("on/sky", (c: string) => {
		if ((read(doc) as Doc).sky === c) return
		clear()
		record([{ path: ["sky"], value: c }], `sky ${skyName[c]}`, "◐")
	})
	method("on/jump", (id: string) => {
		clear()
		go(id)
	})
	method("on/back", () => {
		const S = steps(), p = S[read(at) as string]?.parent
		if (p) (clear(), go(p))
	})
	method("on/forward", () => {
		const S = steps(), here = read(at) as string
		const tip = list().find((b) => b.name === (read(lean) as string))?.tip
		const path = tip ? chain(S, tip) : []
		const i = path.indexOf(here)
		const to = i > 0
			? path[i - 1]
			: (read(order) as string[]).find((id) => S[id]?.parent === here)
		if (to) (clear(), go(to))
	})
	method("on/checkout", (name: string) => {
		const b = list().find((x) => x.name === name)
		if (b) (clear(), go(b.tip, name))
	})
	method("on/hover", (id: string) => {
		if (read(hover) !== id) put(hover, id)
	})
	method("on/rename", (to: string) => {
		const now = read(branch) as string
		to = to.trim().replace(/\s+/g, "-").slice(0, 16)
		if (!now || !to || list().some((b) => b.name === to)) return
		put(tips, list().map((b) => (b.name === now ? { ...b, name: to } : b)))
		for (const n of [branch, lean]) if (read(n) === now) put(n, to)
		const c = read(cmp) as { a: string; b: string }
		put(cmp, { a: c.a === now ? to : c.a, b: c.b === now ? to : c.b })
	})
	method("on/pick", (slot: "a" | "b", name: string) => {
		const c = read(cmp) as { a: string; b: string }
		put(cmp, { ...c, [slot]: name })
	})
	method("on/delete", (name: string) => {
		const bs = list(), gone = bs.find((b) => b.name === name)
		if (!gone) return
		if (bs.length < 2) {
			return put(notice, {
				kind: "refused",
				title: "that is the only branch",
				lines: ["a picture needs somewhere to be"],
				steps: [],
			})
		}
		clear()
		const S = steps(), rest = bs.filter((b) => b.name !== name), here = read(at) as string
		put(tips, rest)
		// on what goes, and on nothing else: step back to where it left the others
		const others = new Set(rest.flatMap((b) => chain(S, b.tip)))
		if (!others.has(here)) go(chain(S, here).find((x) => others.has(x))!)
		else if (read(branch) === name) put(branch, rest.find((b) => b.tip === here)?.name ?? "")
		if (read(lean) === name) put(lean, rest[0].name)
		const c = read(cmp) as { a: string; b: string }
		put(cmp, { a: c.a === name ? "" : c.a, b: c.b === name ? "" : c.b })
		prune()
	})
	// replay what a branch did since it left this one, here. refused, with nothing applied,
	// where both changed the same thing
	method("on/merge", (name: string) => {
		const S = steps(), bs = list()
		const into = bs.find((b) => b.name === (read(branch) as string))
		const from = bs.find((b) => b.name === name)
		const refuse = (title: string, lines: string[], ids: string[] = []) =>
			put(notice, { kind: "refused", title, lines, steps: ids })
		if (!from) return
		if (!into || into.tip !== read(at)) {
			return refuse("merge needs a branch to merge into", ["go to the tip of a branch first"])
		}
		if (from.name === into.name) return refuse("a branch is already itself", [])
		const mine = chain(S, into.tip), theirs = chain(S, from.tip)
		const fork = theirs.find((x) => mine.includes(x))!
		const replay = theirs.slice(0, theirs.indexOf(fork)).reverse()
		const here = mine.slice(0, mine.indexOf(fork))
		if (!replay.length) {
			return put(notice, {
				kind: "ok",
				title: `${into.name} already has everything on ${from.name}`,
				lines: [],
				steps: [],
			})
		}
		// what each side did since the fork, keyed
		const sideOf = (ids: string[]) => {
			const m = new Map<string, { value: unknown; gone: boolean; id: string }>()
			for (const id of [...ids].reverse()) {
				for (const [k, v] of touches(S[id].patches)) m.set(k, { ...v, id })
			}
			return m
		}
		const ours = sideOf(here), theirsMap = sideOf(replay)
		const found = new Map<string, { what: string; fields: string[]; a: string; b: string }>()
		const ids = new Set<string>()
		const shape_ = (k: string) => k.replace(/^shape:/, "").replace(/\..*/, "")
		for (const [k, b] of theirsMap) {
			for (const [k2, a] of ours) {
				const hits = k === k2 ||
					(k.startsWith("shape:") && k2.startsWith("shape:") && shape_(k) === shape_(k2) &&
						(!k.includes(".") || !k2.includes(".")))
				if (!hits) continue
				if (k === k2 && same(a.value, b.value) && a.gone === b.gone) continue
				const what = k === "sky" ? "the sky" : shape_(k)
				const key = `${what}|${a.id}|${b.id}`
				const f = found.get(key) ?? { what, fields: [], a: a.id, b: b.id }
				if (k.includes(".")) f.fields.push(k.split(".")[1])
				found.set(key, f)
				ids.add(a.id), ids.add(b.id)
			}
		}
		const lines = [...found.values()].map((f) =>
			`${f.what}${f.fields.length ? ` (${f.fields.join(", ")})` : ""}: ${S[f.a].label} (#${
				S[f.a].n
			}) on ${into.name}, ${S[f.b].label} (#${S[f.b].n}) on ${from.name}`
		)
		if (lines.length) {
			return refuse(
				`merge refused: ${from.name} and ${into.name} both changed ${
					lines.length === 1 ? "this" : "these"
				}`,
				[...new Set(lines)],
				[...ids],
			)
		}
		// no overlap: it must still apply, step by step, to what is here
		let d = read(doc) as Doc
		try {
			for (const id of replay) d = apply(d, S[id].patches) as Doc
		} catch (e) {
			return refuse(`merge refused: a step does not apply here`, [String((e as Error).message)])
		}
		for (const id of replay) record(S[id].patches, `merge ${S[id].label}`, "⎘", id)
		put(notice, {
			kind: "ok",
			title: `merged ${replay.length} step${
				replay.length === 1 ? "" : "s"
			} from ${from.name} into ${into.name}`,
			lines: [],
			steps: [],
		})
	})
	method("on/dismiss", () => clear())

	// ---- the picture ----
	const pad = keep("pad", () => {
		const k = window.devicePixelRatio || 1
		return Object.assign(document.createElement("canvas"), { width: W * k, height: H * k })
	})
	const K = pad.width / W
	let modeNow = "add"
	let lastDoc: Doc = start(),
		drag: { id: string; x: number; y: number; dx: number; dy: number; moved: boolean } | null =
			null
	const paintPad = () => {
		const g = pad.getContext("2d")!
		g.setTransform(1, 0, 0, 1, 0, 0)
		g.clearRect(0, 0, pad.width, pad.height)
		scene(g, lastDoc, K, () => {
			for (const [id, s] of Object.entries(lastDoc.shapes)) {
				shape(g, drag?.id === id ? { ...s, x: drag.x, y: drag.y } : s)
			}
		})
	}
	const point = (e: PointerEvent) => {
		const r = pad.getBoundingClientRect()
		return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]
	}
	// the pad and the tree are canvases with no handler of their own, and a plain
	// listener has nothing open (no writer is made here): their events are heard on a jsx element round each, and each
	// says the call it makes (on/do: name, ...args), or none. what the pointer is on is read from
	// what the draw effects last drew (lastDoc, modeNow)
	createAction("on/do", (name: string, ...args: unknown[]) => executeAction(`on/${name}`, ...args))
	const onDown = (e: PointerEvent) => {
		const [x, y] = point(e), d = lastDoc, m = modeNow
		const id = hit(d, x, y)
		if (m === "add") return ["add", x, y]
		else if (!id) return
		else if (m === "paint") return ["paint", id]
		else if (m === "erase") return ["erase", id]
		else if (m === "move") {
			pad.setPointerCapture(e.pointerId)
			drag = {
				id,
				x: d.shapes[id].x,
				y: d.shapes[id].y,
				dx: x - d.shapes[id].x,
				dy: y - d.shapes[id].y,
				moved: false,
			}
		}
	}
	const onDrag = (e: PointerEvent) => {
		if (!drag) return
		const [x, y] = point(e)
		drag.x = Math.max(0, Math.min(W, x - drag.dx)), drag.y = Math.max(0, Math.min(H, y - drag.dy))
		drag.moved = true
		paintPad()
	}
	const onUp = () => {
		const d = drag
		drag = null
		if (d?.moved) return ["move", d.id, d.x, d.y]
		else paintPad()
	}
	const onStage = (f: (e: any) => unknown[] | undefined | void) => handler("on/do", f as never)
	createEffect(
		"draw-doc",
		() => [read(doc), read(mode)] as [Doc, string],
		([d, m]: [Doc, string]) => {
			lastDoc = d
			modeNow = m
			pad.className = m === "move" ? "move" : m === "add" ? "add" : ""
			paintPad()
		},
	)

	// ---- the comparison ----
	const canvasFor = (name: string) =>
		keep(name, () => {
			const k = window.devicePixelRatio || 1
			return Object.assign(document.createElement("canvas"), { width: W * k, height: H * k })
		})
	const cvA = canvasFor("cmp-a"), cvB = canvasFor("cmp-b")
	createEffect("draw-compare", () => read(compareE), (c: any) => {
		if (!c) return
		for (
			const [cv, mine, other, theirs] of [[cvA, c.docA, c.docB, "a"], [
				cvB,
				c.docB,
				c.docA,
				"b",
			]] as const
		) {
			const g = cv.getContext("2d")!, k = cv.width / W
			g.setTransform(1, 0, 0, 1, 0, 0)
			g.clearRect(0, 0, cv.width, cv.height)
			scene(g, mine, k, () => {
				// what the other one moved or recoloured, ghosted where it is there
				for (const [id, s] of Object.entries(other.shapes) as [string, Shape][]) {
					const m = mine.shapes[id]
					if (m && (m.x !== s.x || m.y !== s.y)) shape(g, s, 0.35, true)
				}
				for (const [id, s] of Object.entries(mine.shapes) as [string, Shape][]) {
					shape(g, s)
					const o = other.shapes[id]
					if (!o) ring(g, s, theirs === "a" ? "#ff2284" : "#2269ff")
					else if (o.x !== s.x || o.y !== s.y || o.c !== s.c || o.s !== s.s) {
						ring(g, s, "#40dcba")
					}
				}
			})
		}
	})

	// ---- the tree ----
	const tree = keep("tree-canvas", () => document.createElement("canvas"))
	const wrap = keep("tree-wrap", () => {
		const d = document.createElement("div")
		d.className = "treewrap"
		return d
	})
	if (tree.parentNode !== wrap) wrap.appendChild(tree)
	const DX = 52, DY = 56, PAD = 50
	let view: any = null, anim = 0, shownJump = 0
	const px = (n: { depth: number; lane: number }) => [PAD + n.depth * DX, PAD + 18 + n.lane * DY]
	const paintTree = () => {
		if (!view) return
		const { L, atId, route, bs, now, hov, note, jump } = view
		const k = window.devicePixelRatio || 1
		const wCss = Math.max(560, PAD * 2 + L.depth * DX + 130),
			hCss = PAD * 2 + 20 + (L.lanes - 1) * DY + 20
		if (tree.width !== wCss * k || tree.height !== hCss * k) {
			tree.width = wCss * k, tree.height = hCss * k
			tree.style.width = wCss + "px", tree.style.height = hCss + "px"
		}
		const g = tree.getContext("2d")!
		g.setTransform(k, 0, 0, k, 0, 0)
		g.clearRect(0, 0, wCss, hCss)
		const byId: Record<string, any> = Object.fromEntries(L.nodes.map((n: any) => [n.id, n]))
		const col = (n: any) => lanes[n.lane % lanes.length]
		const age = jump ? (Date.now() - jump.stamp) / 1100 : 9
		const glow = new Map<string, string>()
		if (age < 1) {
			for (const id of jump.down) glow.set(id, "#ff2284")
			for (const id of jump.up) glow.set(id, "#40dcba")
		}
		// edges: a fork leaves its parent sideways and settles into its own lane
		for (const n of L.nodes) {
			if (!n.parent) continue
			const p = byId[n.parent], [x0, y0] = px(p), [x1, y1] = px(n)
			const onRoute = route.has(n.id) && route.has(p.id)
			g.beginPath()
			g.moveTo(x0, y0)
			if (y0 === y1) g.lineTo(x1, y1)
			else g.bezierCurveTo(x0 + DX * 0.55, y0, x1 - DX * 0.55, y1, x1, y1)
			g.lineWidth = onRoute ? 4 : 2.5
			g.strokeStyle = col(n)
			g.globalAlpha = onRoute ? 1 : 0.55
			g.stroke()
			g.globalAlpha = 1
		}
		// merged copies: a dashed line from what was replayed
		for (const n of L.nodes) {
			if (!n.from || !byId[n.from]) continue
			const [x0, y0] = px(byId[n.from]), [x1, y1] = px(n)
			g.beginPath()
			g.moveTo(x0, y0)
			g.bezierCurveTo(x0 + DX, y0 + 22, x1 - DX, y1 - 22, x1, y1)
			g.setLineDash([3, 4])
			g.lineWidth = 1.5
			g.strokeStyle = "#000"
			g.stroke()
			g.setLineDash([])
		}
		// nodes
		for (const n of L.nodes) {
			const [x, y] = px(n), c = col(n), here = n.id === atId, on = route.has(n.id)
			const gl = glow.get(n.id)
			if (gl) {
				g.beginPath()
				g.arc(x, y, 12 + 14 * age, 0, 7)
				g.strokeStyle = gl
				g.globalAlpha = 1 - age
				g.lineWidth = 4
				g.stroke()
				g.globalAlpha = 1
			}
			if (note?.steps?.includes(n.id)) {
				g.beginPath()
				g.arc(x, y, 17, 0, 7)
				g.setLineDash([4, 3])
				g.strokeStyle = "#ff2284"
				g.lineWidth = 2.5
				g.stroke()
				g.setLineDash([])
			}
			if (here) {
				g.beginPath()
				g.arc(x, y, 17, 0, 7)
				g.strokeStyle = "#ff2284"
				g.lineWidth = 3
				g.stroke()
			}
			g.beginPath()
			g.arc(x, y, 11, 0, 7)
			g.fillStyle = on ? c : "#fff"
			g.fill()
			g.lineWidth = n.id === hov ? 3.5 : 2
			g.strokeStyle = "#000"
			g.stroke()
			g.fillStyle = on && !["#40dcba", "#ff9a3c"].includes(c) ? "#fff" : "#000"
			g.font = "600 12px Jost, system-ui, sans-serif"
			g.textAlign = "center"
			g.textBaseline = "middle"
			g.fillText(n.glyph, x, y + 0.5)
		}
		// names on the tips: skewed lemon tags, the current one cherry
		const seen: Record<string, number> = {}
		for (const b of bs) {
			const n = byId[b.tip]
			if (!n) continue
			const [x, y] = px(n), slot = (seen[b.tip] = (seen[b.tip] ?? -1) + 1)
			const text = b.name
			g.font = "600 13px Jost, system-ui, sans-serif"
			const w = g.measureText(text).width + 16,
				bx = x + 20,
				by = y - 11 + slot * 24 - (slot ? 0 : 0)
			g.save()
			g.translate(bx, by + 11)
			g.transform(1, 0, -0.14, 1, 0, 0)
			g.fillStyle = b.name === now ? "#ff2284" : "#fff7a8"
			g.fillRect(0, -11, w, 22)
			g.strokeStyle = "#000"
			g.lineWidth = 1
			g.strokeRect(0, -11, w, 22)
			g.fillStyle = b.name === now ? "#fff" : "#000"
			g.textAlign = "left"
			g.fillText(text, 8, 1)
			g.restore()
		}
		// where we are
		const a = byId[atId]
		if (a) {
			const [x, y] = px(a)
			g.font = "600 11px Jost, system-ui, sans-serif"
			g.fillStyle = "#ff2284"
			g.textAlign = "center"
			g.fillText("you are here", x, y - 29)
		}
		const h = hov && byId[hov]
		if (h) {
			const [x, y] = px(h), text = `#${h.n} ${h.label}`
			g.font = "500 12px Jost, system-ui, sans-serif"
			const w = g.measureText(text).width + 14
			const bx = Math.min(wCss - w - 4, Math.max(4, x - w / 2)), by = y + 20
			g.fillStyle = "#fff"
			g.fillRect(bx, by, w, 22)
			g.strokeStyle = "#000"
			g.lineWidth = 1
			g.strokeRect(bx + 0.5, by + 0.5, w - 1, 21)
			g.fillStyle = "#000"
			g.textAlign = "left"
			g.fillText(text, bx + 7, by + 12)
		}
		if (age < 1) cancelAnimationFrame(anim), (anim = requestAnimationFrame(paintTree))
	}
	const nodeAt = (e: PointerEvent) => {
		if (!view) return
		const r = tree.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
		return view.L.nodes.find((n: any) => {
			const [nx, ny] = px(n)
			return Math.hypot(nx - x, ny - y) <= 15
		})?.id as string | undefined
	}
	let over = ""
	const hovering = (id: string) => {
		if (id === over) return
		over = id
		return ["hover", id]
	}
	const treeMove = (e: PointerEvent) => {
		const id = nodeAt(e) ?? ""
		tree.style.cursor = id ? "pointer" : "default"
		return hovering(id)
	}
	const treeLeave = () => hovering("")
	const treeClick = (e: MouseEvent) => {
		const id = nodeAt(e as PointerEvent)
		if (id) return ["jump", id]
	}
	createEffect(
		"draw-tree",
		() => ({
			L: read(layoutE),
			atId: read(at),
			bs: list(),
			now: read(branch),
			hov: read(hover),
			note: read(notice),
			jump: read(jumped),
			route: chain(steps(), read(at) as string),
		}),
		(v: any) => {
			view = { ...v, route: new Set(v.route) }
			if (v.jump && v.jump.stamp !== shownJump) shownJump = v.jump.stamp
			paintTree()
		},
	)
	// the animation stops with the run
	addTeardown(() => cancelAnimationFrame(anim))

	const tool = (m: string, text: string) => (
		<button class={bind("mode", (v) => (v === m ? "on" : ""))} onClick={handler("on/mode", [m])}>
			{text}
		</button>
	)
	let name: HTMLInputElement

	return (
		<div class="fb">
			<style>{css}</style>
			<h1>
				branches<span>nothing is lost</span>
			</h1>
			<p class="lede">
				every change is kept as patches and their inverses. go back and change something and the
				future you left is not thrown away: it becomes a branch. click a step in the tree to
				jump (the inverses back to the fork, the patches forward), merge one branch into
				another, or compare two.
			</p>
			<div class="top">
				<section class="card doc">
					<div
						class="stage"
						onPointerDown={onStage(onDown)}
						onPointerMove={onStage(onDrag)}
						onPointerUp={onStage(onUp)}
						onPointerCancel={onStage(onUp)}
					>
						{pad}
					</div>
					<div class="row">
						<span class="lab">tool</span>
						{tool("add", "add")}
						{tool("move", "move")}
						{tool("paint", "recolour")}
						{tool("erase", "erase")}
					</div>
					<div class="row">
						<span class="lab">shape</span>
						{kinds.map((k) => (
							<button
								key={k}
								class={bind("kind", (v) => (v === k ? "on" : ""))}
								onClick={handler("on/kind", [k])}
							>
								{k}
							</button>
						))}
					</div>
					<div class="row">
						<span class="lab">colour</span>
						{inks.map((c) => (
							<b
								key={c}
								class={bind("ink", (v) => (v === c ? "sw on" : "sw"))}
								style={{ background: c }}
								onClick={handler("on/ink", [c])}
							/>
						))}
					</div>
					<div class="row">
						<span class="lab">sky</span>
						{skies.map((c) => (
							<b
								key={c}
								class="sw"
								style={{ background: c }}
								onClick={handler("on/sky", [c])}
							/>
						))}
					</div>
					<div class="row">
						<button onClick={handler("on/back")}>◀ back</button>
						<button onClick={handler("on/forward")}>forward ▶</button>
					</div>
				</section>
				<section class="card side">
					<h2>
						branches<em>{bind("where", (w) => `${w.text} ${w.name}`)}</em>
					</h2>
					<ul class="branches">
						{bind("rows", (rows: any[]) =>
							rows.map((r) => (
								<li key={r.name} class={r.now ? "now" : ""}>
									<i class="dot" style={{ background: r.color }} />
									<span class="nm">{r.name}</span>
									<small>{r.steps} steps · {r.label}</small>
									<button class="sm" onClick={handler("on/checkout", [r.name])}>go</button>
									<button
										class={r.a ? "sm on" : "sm"}
										onClick={handler("on/pick", ["a", r.name])}
									>
										A
									</button>
									<button
										class={r.b ? "sm on" : "sm"}
										onClick={handler("on/pick", ["b", r.name])}
									>
										B
									</button>
									<button
										class="sm"
										disabled={r.now}
										onClick={handler("on/merge", [r.name])}
									>
										merge here
									</button>
									<button class="sm" onClick={handler("on/delete", [r.name])}>×</button>
								</li>
							)))}
					</ul>
					<div class="row">
						<input
							type="text"
							placeholder="name this branch"
							ref={(e) => (name = e)}
							onKeyDown={handler("on/rename", (e) => {
								if (e.key === "Enter") {
									const v = name.value
									name.value = ""
									return [v]
								}
							})}
						/>
						<button
							onClick={handler("on/rename", () => {
								const v = name.value
								name.value = ""
								return [v]
							})}
						>
							rename
						</button>
					</div>
					<div class="inspect">
						<div>
							<h4>
								patches{" "}
								<small>{bind("focus", (f) => (f?.hovered ? "(hovered)" : "(here)"))}</small>
							</h4>
							<pre>{bind("focus", (f) => f ? `${f.title}\n${f.patches}` : "")}</pre>
						</div>
						<div>
							<h4>inverse</h4>
							<pre>{bind("focus", (f) => f?.undo ?? "")}</pre>
						</div>
					</div>
				</section>
			</div>
			<section class="card tree">
				<h2>
					the tree<em>click a step to jump</em>
				</h2>
				{bind("notice", (n: any) =>
					n
						? (
							<div class={n.kind === "ok" ? "notice ok" : "notice"}>
								<b>{n.title}</b>
								<ul>{n.lines.map((l: string) => <li key={l}>{l}</li>)}</ul>
							</div>
						)
						: null)}
				<div
					onPointerMove={onStage(treeMove)}
					onPointerLeave={onStage(treeLeave)}
					onClick={onStage(treeClick)}
				>
					{wrap}
				</div>
				<p class="jumped">
					{bind("jumped", (j: any) =>
						!j
							? ""
							: `jumped to #${j.n}: ${j.down.length} inverse${
								j.down.length === 1 ? "" : "s"
							} back to the fork, then ${j.up.length} patch${
								j.up.length === 1 ? "" : "es"
							} forward`)}
				</p>
			</section>
			<section class="card">
				<h2>
					compare<em>
						{bind("compare", (c) =>
							`${c.a} and ${c.b}`)}
					</em>
				</h2>
				<div class="cmp">
					<figure>
						<figcaption>
							A · {bind("compare", (c) =>
								c.a)}
						</figcaption>
						{cvA}
					</figure>
					<figure>
						<figcaption>
							B · {bind("compare", (c) =>
								c.b)}
						</figcaption>
						{cvB}
					</figure>
					<ul class="diff">
						{bind("compare", (c: any) =>
							c.diff.length
								? c.diff.map((d: any) => <li key={d.text} class={d.mark}>{d.text}</li>)
								: <li>the same picture</li>)}
					</ul>
				</div>
				<p class="hint">
					pick A and B in the branch list. ringed: only on that side (cherry, blue) or
					different (mint); dashed: where the other side has it.
				</p>
			</section>
		</div>
	)
}
