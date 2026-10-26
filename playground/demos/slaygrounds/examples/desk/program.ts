/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import type { Extra } from "./host.ts"
import { bind, handler, type Item, under } from "ermine-h"

// desk: nothing here knows how to draw itself. a renderer is a node holding source text,
// (v, w, h, near) => ops, in root/library; a folder carries its own under render/<type> (the library
// nodes placed again: mounts), and settings like accent. a thing is a node in a folder with a value
// and a type; each place it sits has a process, "look:<folder>", placed under it, whose program is
// the path ["render", type]: found by lookup, walking up from the thing's place, tracked (the
// host's way; the desk's supervisor effect starts one process per place, and starts it again when
// what it finds changes). so moving a tile re-finds its renderer from the new place, a mounted tile
// is drawn by two processes (one per place) and may look different in each, and editing a renderer
// runs every drawing that found it again. the effect of each process paints the ops on its canvas. an edit of this file reloads;
// the graph (and what it holds) is kept. the desk's view is jsx: each window lists its folder's
// members (under), each canvas says which renderer drew it (bound to its process's ops node), and
// "who drew this pixel?" is bound to the answer node; the canvases are painted by the processes

// the type of a renderer node: the host has a runner taking it (host.ts)
const RENDERER = "party.chee.ermine.renderer"
const FOLDERS = ["home", "work", "kids"]
const RESERVED = ["render", "accent"]
const TYPES = ["note", "number", "colour", "list", "image"]
const W = 96, H = 72
const ink = "#111", cherry = "#ff2284", lemon = "#fff27a", cream = "#fffbe6"
const dpr = Math.max(1, Math.ceil(globalThis.devicePixelRatio || 1))
const FACES: Record<string, string> = {
	sans: 'Jost, "Helvetica Neue", system-ui, sans-serif',
	mono: 'ui-monospace, "SF Mono", Menlo, monospace',
	hand: '"Marker Felt", "Comic Sans MS", cursive',
}
const font = (size: number, face = "sans") => `${size}px ${FACES[face] ?? FACES.sans}`
const root = { id: "root" }

// ---- the pictures: 12 rows of 12, . paper # ink o cherry + lemon; a thing's value is the string
const pic = (rows: string) =>
	rows.trim().split("\n").slice(0, 12).map((r) =>
		[...r.trim().padEnd(12, ".").slice(0, 12)].map((c) => ".#o+".indexOf(c) & 3).join("")
	).join("")
const pictures = {
	fox: pic(`
#..........#
##........##
#+#......#+#
#++#oooo#++#
#oooooooooo#
oooooooooooo
oo#oooooo#oo
oooooooooooo
.oo++++++oo.
..o++##++o..
...++++++...
....++++....`),
	heart: pic(`
............
..oo....oo..
.oooo..oooo.
oooooooooooo
oooo+ooooooo
ooo+oooooooo
.oooooooooo.
..oooooooo..
...oooooo...
....oooo....
.....oo.....
............`),
	cherry: pic(`
........##..
.......#+#..
......#..#..
.....#...#..
....#.....#.
...#......#.
..#.......#.
.ooo.....ooo
oo+oo...oo+o
ooooo...oooo
.ooo.....ooo
............`),
}

// ---- the renderers' source, seeded once into root/library: after that the graph holds them, and
// an edit in the graph tab (or the panel below) is what changes a drawing
// ops: ["rect", x, y, w, h, fill, stroke?] ["circle", x, y, r, fill, stroke?]
//      ["text", x, y, text, colour, size, face?, align?] ["line", x1, y1, x2, y2, colour, width?]
//      ["pixels", x, y, data, cols, scale, palette]
const sources: Record<string, [string, string]> = {
	card: [
		"note",
		`(v, w, h, near) => {
	const ops = [["rect", 0, 0, w, h, "#fffbe6", "#111"], ["rect", 0, 0, w, 10, near("accent") ?? "#ff2284"]]
	let line = "", y = 24
	for (const word of String(v).split(/\\s+/)) {
		if (line && (line + " " + word).length > 14) { ops.push(["text", 6, y, line, "#111", 11]); y += 12; line = word }
		else line = line ? line + " " + word : word
	}
	if (line) ops.push(["text", 6, y, line, "#111", 11])
	return ops
}`,
	],
	digits: [
		"number",
		`(v, w, h, near) => [
	["rect", 0, 0, w, h, "#fff", "#111"],
	["text", w / 2, h / 2 + 9, String(v), "#111", 26, "sans", "center"],
	["rect", w / 2 - 18, h - 12, 36, 3, near("accent") ?? "#ff2284"],
]`,
	],
	swatch: [
		"colour",
		`(v, w, h) => [
	["rect", 0, 0, w, h, v, "#111"],
	["rect", 0, h - 16, w, 16, "#fff", "#111"],
	["text", 5, h - 4, String(v), "#111", 10, "mono"],
]`,
	],
	bullets: [
		"list",
		`(v, w, h, near) => {
	const ops = [["rect", 0, 0, w, h, "#fff", "#111"]]
	v.slice(0, 4).forEach((item, i) => {
		ops.push(["rect", 7, 11 + i * 15, 5, 5, near("accent") ?? "#ff2284"], ["text", 17, 17 + i * 15, String(item), "#111", 11])
	})
	return ops
}`,
	],
	pixels: [
		"image",
		`(v, w, h, near) => [
	["rect", 0, 0, w, h, "#fffbe6", "#111"],
	["pixels", (w - 72) / 2, 0, v, 12, 6, ["#fffbe6", "#111", near("accent") ?? "#ff2284", "#fff27a"]],
]`,
	],
	// home's
	sticky: [
		"note",
		`(v, w, h) => {
	const ops = [["rect", 0, 0, w, h, "#fff27a"], ["rect", w - 14, h - 14, 14, 14, "#e6d84f"], ["line", 0, h - 1, w, h - 1, "#c9b800", 1]]
	let line = "", y = 16
	for (const word of String(v).split(/\\s+/)) {
		if (line && (line + " " + word).length > 12) { ops.push(["text", 6, y, line, "#111", 13, "hand"]); y += 15; line = word }
		else line = line ? line + " " + word : word
	}
	if (line) ops.push(["text", 6, y, line, "#111", 13, "hand"])
	return ops
}`,
	],
	ruled: [
		"list",
		`(v, w, h, near) => {
	const ops = [["rect", 0, 0, w, h, "#fff", "#111"], ["line", 14, 0, 14, h, near("accent") ?? "#ff2284", 1]]
	for (let y = 14; y < h; y += 15) ops.push(["line", 0, y, w, y, "#bcd4ff", 1])
	v.slice(0, 4).forEach((item, i) => ops.push(["text", 19, 12 + i * 15, String(item), "#111", 11, "hand"]))
	return ops
}`,
	],
	// work's
	ledger: [
		"number",
		`(v, w, h) => {
	const ops = [["rect", 0, 0, w, h, "#f4fbef", "#111"]]
	for (let y = 14; y < h; y += 12) ops.push(["line", 0, y, w, y, "#9fd0a8", 1])
	ops.push(["line", 14, 0, 14, h, "#ff2284", 1])
	const n = Number(v).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
	ops.push(["text", w - 5, 38, "$" + n, "#111", 13, "mono", "right"], ["text", w - 5, 62, "balance", "#2f8f46", 9, "mono", "right"])
	return ops
}`,
	],
	checklist: [
		"list",
		`(v, w, h) => {
	const ops = [["rect", 0, 0, w, h, "#fff", "#111"]]
	v.slice(0, 4).forEach((item, i) => {
		const done = String(item).startsWith("x "), y = 8 + i * 15
		ops.push(["rect", 6, y, 10, 10, "#fff", "#111"])
		if (done) ops.push(["line", 8, y + 5, 11, y + 9, "#111", 2], ["line", 11, y + 9, 16, y - 1, "#111", 2])
		ops.push(["text", 22, y + 9, done ? String(item).slice(2) : String(item), done ? "#888" : "#111", 11])
	})
	return ops
}`,
	],
	// kids'
	tally: [
		"number",
		`(v, w, h, near) => {
	const ink = near("accent") ?? "#ff2284"
	const ops = [["rect", 0, 0, w, h, "#fffbe6", "#111"]]
	const n = Math.min(15, Math.max(0, Math.round(Number(v))))
	for (let i = 0; i < n; i++) {
		const g = Math.floor(i / 5), k = i % 5, x = 10 + g * 28, y = 14
		if (k < 4) ops.push(["line", x + k * 5, y, x + k * 5 + 1, y + 30, ink, 2])
		else ops.push(["line", x - 3, y + 22, x + 20, y + 8, ink, 2])
	}
	ops.push(["text", w - 6, h - 6, String(v), ink, 12, "hand", "right"])
	return ops
}`,
	],
	crayon: [
		"note",
		`(v, w, h, near) => {
	const ink = near("accent") ?? "#ff2284"
	const ops = [["rect", 0, 0, w, h, "#fff", "#111"]]
	let line = "", y = 22
	for (const word of String(v).split(/\\s+/)) {
		if (line && (line + " " + word).length > 9) { ops.push(["text", 6, y, line, ink, 16, "hand"]); y += 17; line = word }
		else line = line ? line + " " + word : word
	}
	if (line) ops.push(["text", 6, y, line, ink, 16, "hand"])
	for (let x = 4; x < w - 8; x += 6) ops.push(["line", x, h - 6 + (x % 12 ? 1 : -1), x + 6, h - 6 + (x % 12 ? -1 : 1), ink, 2])
	return ops
}`,
	],
	balloon: [
		"colour",
		`(v, w, h) => [
	["rect", 0, 0, w, h, "#d4e4ff", "#111"],
	["line", w / 2, 44, w / 2 - 4, h, "#111", 1],
	["circle", w / 2, 26, 20, v, "#111"],
	["circle", w / 2 - 7, 18, 4, "#ffffff88"],
]`,
	],
	stars: [
		"list",
		`(v, w, h, near) => {
	const ink = near("accent") ?? "#ff2284"
	const ops = [["rect", 0, 0, w, h, "#fffbe6", "#111"]]
	v.slice(0, 4).forEach((item, i) => ops.push(["circle", 12, 14 + i * 15, 5, ink, "#111"], ["text", 24, 18 + i * 15, String(item), "#111", 12, "hand"]))
	return ops
}`,
	],
}
// a renderer's source, compiled once per text
const compiled = new Map<string, (...a: any[]) => Op[]>()
function compile(src: string) {
	let f = compiled.get(src)
	if (!f) {
		f = new Function(`"use strict"; return (${src})`)()
		if (typeof f !== "function") throw new Error("a renderer is (v, w, h, near) => ops")
		compiled.set(src, f!)
	}
	return f!
}
type Op = unknown[]
const missing = (type: string): Op[] => {
	const ops: Op[] = [["rect", 0, 0, W, H, "#fff", cherry]]
	for (let x = -H; x < W; x += 8) ops.push(["line", x, H, x + H, 0, "#ffd6de", 2])
	ops.push(["text", W / 2, H / 2 - 2, "no renderer", cherry, 11, "sans", "center"])
	ops.push(["text", W / 2, H / 2 + 12, "for " + type, cherry, 11, "sans", "center"])
	return ops
}

// ---- the painter: ops onto a canvas, and from a point back to the op that painted it
function paint(c: HTMLCanvasElement, ops: Op[]) {
	const g = c.getContext("2d")!
	g.setTransform(dpr, 0, 0, dpr, 0, 0)
	g.clearRect(0, 0, W, H)
	for (const op of ops) {
		const [k, a, b, p, q, r, f, al] = op as any[]
		g.lineWidth = 1
		if (k === "rect") {
			if (r) (g.fillStyle = r, g.fillRect(a, b, p, q))
			if (f) (g.strokeStyle = f, g.strokeRect(a + .5, b + .5, p - 1, q - 1))
		} else if (k === "circle") {
			g.beginPath()
			g.arc(a, b, p, 0, Math.PI * 2)
			if (q) (g.fillStyle = q, g.fill())
			if (r) (g.strokeStyle = r, g.stroke())
		} else if (k === "text") {
			g.fillStyle = q
			g.font = font(r ?? 11, f)
			g.textAlign = (al ?? "left") as CanvasTextAlign
			g.fillText(p, a, b)
		} else if (k === "line") {
			g.strokeStyle = r
			g.lineWidth = f ?? 1
			g.beginPath()
			g.moveTo(a, b)
			g.lineTo(p, q)
			g.stroke()
		} else if (k === "pixels") {
			const [data, cols, s, pal] = [p, q, r, f] as [string, number, number, string[]]
			for (let i = 0; i < data.length; i++) {
				g.fillStyle = pal[+data[i]] ?? ink
				g.fillRect(a + (i % cols) * s, b + Math.floor(i / cols) * s, s, s)
			}
		}
	}
}
// the topmost op that painted x, y: each op alone on a spare canvas, top down
const spare = Object.assign(document.createElement("canvas"), { width: W * dpr, height: H * dpr })
function hit(ops: Op[], x: number, y: number) {
	const g = spare.getContext("2d", { willReadFrequently: true })!
	for (let i = ops.length - 1; i >= 0; i--) {
		paint(spare, [ops[i]])
		if (g.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data[3] > 0) return i
	}
	return -1
}

const css = `
body{background:#ffffc2;margin:0;padding:12px;font-family:Jost,system-ui,sans-serif;font-size:13px;color:#000}
.desk{display:flex;flex-direction:column;gap:12px;user-select:none}
.hint{margin:0}.hint b{background:#40dcba;padding:0 4px;border-radius:2px;font-weight:500}
.hint .said{color:#ff2284;margin-left:8px}
.wins{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
.win{background:#fff;border:1px solid #000;box-shadow:3px 3px 0 #000,0 0 10px 2px #ff228522;width:244px;display:flex;flex-direction:column}
[data-drop].drop{outline:3px solid #2269ff;outline-offset:2px}
[data-drop].drop.mount{outline-color:#40dcba}
.title{display:flex;align-items:center;gap:6px;height:20px;padding:0 6px;border-bottom:1px solid #000;
 background:repeating-linear-gradient(#fff 0 2px,#000 2px 3px);font-weight:600}
.title span{background:#fff;padding:0 6px}
.title .n{margin-left:auto;font-weight:400;background:#fff;padding:0 4px}
.title button{font:inherit;line-height:1;padding:0 6px;border:1px solid #000;border-radius:2px;background:#fff;cursor:pointer;
 box-shadow:1px 1px 0 #000;transition:transform 100ms,box-shadow 100ms}
.title button:hover{transform:translateY(-1px);box-shadow:2px 2px 0 #000}
.title button:active{transform:none;box-shadow:none}
.tiles{display:flex;flex-wrap:wrap;gap:8px;padding:8px;min-height:90px;align-content:flex-start}
.tile{position:relative;width:${W}px;cursor:grab;touch-action:none}
.tile canvas{display:block;width:${W}px;height:${H}px;background:#fff;box-shadow:0 0 6px 1px #ff228533}
.tile .lbl{display:flex;justify-content:space-between;gap:4px;padding-top:2px;font-size:12px;white-space:nowrap;overflow:hidden}
.tile .lbl i{font-style:normal;color:#ff2284;cursor:pointer}
.tile.mounted canvas{outline:1px dashed #ff2284;outline-offset:2px}
.tile[data-picked] canvas{outline:2px solid #ff2284;outline-offset:1px}
.tile .x{position:absolute;width:11px;height:11px;margin:-6px 0 0 -6px;pointer-events:none;
 border:2px solid #ff2284;border-radius:50%;background:#fff8}
img.drag{position:fixed;z-index:9;pointer-events:none;opacity:.85;box-shadow:3px 3px 0 #000;width:${W}px}
.chip.drag{position:fixed;z-index:9;pointer-events:none;box-shadow:3px 3px 0 #000}
.strip{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:5px 8px;border-top:1px solid #000;background:#ffffc2;font-size:12px;min-height:30px}
.strip .k{color:#666}
.strip .grow{flex:1}
.chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.chips:empty::after{content:"none here: found further up";color:#666}
.chip{display:inline-block;border:1px solid #000;border-radius:2px;padding:0 5px;font-size:12px;background:#c8f6ea;cursor:grab;touch-action:none;white-space:nowrap}
.chip b{font-weight:600;margin-right:3px;color:#2269ff}
.chip.at{background:#d4e4ff;cursor:default}
.acc{width:16px;height:16px;border:1px solid #000;border-radius:2px;cursor:pointer;box-shadow:1px 1px 0 #000;padding:0}
.acc.inherited{border-style:dashed;box-shadow:none}
.win.lib{width:300px}
.win.lib .strip{border-top:0}
.win.why{width:520px;max-width:100%}
.win.why:not([data-open]){display:none}
.why .body{padding:8px 10px;line-height:1.45;user-select:text}
.why h4{margin:8px 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#ff2284}
.why code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:#ffffc2;padding:0 3px}
.why .sw{display:inline-block;width:11px;height:11px;border:1px solid #000;vertical-align:-1px}
.why .dim{color:#666}.why .err{color:#ff2284}
.why .walk{display:flex;flex-wrap:wrap;gap:3px;align-items:center}
.why .walk .hit{background:#40dcba;font-weight:600}
.why .walk .miss{background:#fff;color:#888}
.why textarea{width:100%;height:120px;font:11px ui-monospace,Menlo,monospace;border:1px solid #000;border-radius:2px;box-sizing:border-box}
.why button{font:inherit;padding:1px 10px;border:1px solid #000;border-radius:2px;background:#fff;cursor:pointer;
 box-shadow:1px 1px 0 #000;transition:transform 100ms,box-shadow 100ms}
.why button:hover{transform:translateY(-1px);box-shadow:2px 2px 0 #000}
`

// ---- a drawing process, one per place a thing sits, placed under the thing as "look:<folder>"
// (/desk/<folder>/<thing>/look:<folder>), its folder the thing. its program is the
// renderer the desk found by walking up from the thing (see the supervisor in desk): the host's
// runner for typed renderers hands it the renderer's source text, and the process's args say what
// was found: type, the renderer's name and id, how many places up, whose folder holds it. the
// process reads its thing as ".", paints what the renderer says, and nothing else knows how
export function drawing(api: API & Extra, src: string) {
	const { read, memo, effect, entries, up, args } = api
	const [type, name, steps, holder, renderer, folder] = args
	const render = compile(src)
	const id = entries(".")[0]?.id
	// the nearest node named name, walking up from this process's place, tracked
	const near = (n: string) => {
		const i = up([n])
		return i ? read(i) : undefined
	}
	const ops = memo("ops", () => ({
		ops: render(read("."), W, H, near) as Op[],
		type,
		renderer: renderer || null,
		name,
		up: Number(steps),
		holder: holder || null,
	}))
	effect("paint", () => read(ops), (pic: { ops: Op[] }) => {
		for (
			const c of document.querySelectorAll<HTMLCanvasElement>(
				`canvas[data-thing="${id}"][data-folder="${folder}"]`,
			)
		) paint(c, pic.ops)
	})
	return { draws: type, for: folder }
}

// no renderer found by the walk up: this one, at the root, says so (it draws what the old desk's
// missing() drew)
export const MISSING = `(v, w, h, near) => {
	const ops = [["rect", 0, 0, w, h, "#fff", "#ff2284"]]
	for (let x = -h; x < w; x += 8) ops.push(["line", x, h, x + h, 0, "#ffd6de", 2])
	ops.push(["text", w / 2, h / 2 - 2, "no renderer", "#ff2284", 11, "sans", "center"])
	ops.push(["text", w / 2, h / 2 + 12, "for " + near("type"), "#ff2284", 11, "sans", "center"])
	return ops
}`

const spares: [string, string, unknown][] = [
	["note", "idea", "a thing to remember"],
	["number", "tally", 3],
	["colour", "paint", "#40dcba"],
	["list", "errands", ["post", "milk", "stamps"]],
	["image", "cherry", pictures.cherry],
]
const palette = ["#ff2284", "#2269ff", "#2f8f46", "#e8a400", "#9b3dd8", "#111"]
const SAVE = "one write: every drawing that found it runs again"

export function desk(api: API & Extra) {
	const {
		open,
		read,
		edit,
		info,
		entries,
		list,
		place,
		unplace,
		move,
		remove,
		memo,
		effect,
		method,
		send,
		start,
		stop,
		way,
		up,
		about,
		pulse,
	} = api
	const put = (x: unknown, value: unknown) => edit(x as string, [{ path: [], value }])
	const asId = (id: unknown) => ({ id: id as string, part: "value" as const })

	// the desk is saved under ./ (the root): a reload finds it as it was. the ui process is at /ui,
	// never at a name it uses under ./
	const said = open("./said", "")
	const picked = open("./picked", null)
	const compiled = open("./compiled", SAVE)

	// first time only: the library, what each folder carries, and the things
	if (!entries("./library").length) {
		const lib: Record<string, string> = {}
		for (const [name, [type, src]] of Object.entries(sources)) {
			lib[name] = `/library/${name}`
			const node = open(lib[name], src)
			put(info(node), { "ermine.type": RENDERER })
			open(`${lib[name]}/type`, type)
		}
		open("/missing", MISSING)
		put(info("/missing"), { "ermine.type": RENDERER })
		open("/missing/type", "none")
		for (const f of FOLDERS) open(`./desk/${f}`, null)
		open("./desk/render", null)
		const use = (holder: string, names: string[]) => {
			open(`${holder}/render`, null)
			for (const n of names) place(`${holder}/render/${sources[n][0]}`, lib[n])
		}
		use("./desk", ["card", "digits", "swatch", "bullets", "pixels"])
		use("./desk/home", ["sticky", "ruled"])
		use("./desk/work", ["ledger", "checklist"])
		use("./desk/kids", ["tally", "crayon", "balloon", "stars"])
		open("./desk/accent", palette[0])
		open("./desk/kids/accent", palette[1])
		const seed: Record<string, [string, string, unknown][]> = {
			home: [
				["fern", "note", "water the fern on sunday"],
				["groceries", "list", ["eggs", "lemons", "cherries", "bread"]],
				["cherry", "colour", "#ff2284"],
				["fox", "image", pictures.fox],
			],
			work: [
				["invoice", "number", 4200],
				["todo", "list", ["x write spec", "ship demo", "show it"]],
				["memo", "note", "the printer is haunted again"],
				["lemon", "colour", "#fff27a"],
			],
			kids: [
				["story", "note", "a fox with a candle"],
				["apples", "number", 7],
				["sky", "colour", "#2269ff"],
				["drawing", "image", pictures.heart],
			],
		}
		for (const [f, list] of Object.entries(seed)) {
			for (const [name, type, value] of list) {
				open(`./desk/${f}/${name}`, value)
				open(`./desk/${f}/${name}/type`, type)
			}
		}
	}

	// folders and their things (a thing in two folders is one id at two places)
	// (a name with only a process under it, a drawing not yet stopped, is a level: no id, no thing)
	const things = (f: string) =>
		list(`./desk/${f}`).filter((n) => !RESERVED.includes(n)).map((name) => ({
			name,
			id: entries(`./desk/${f}/${name}`)[0]?.id as string,
		})).filter((i) => typeof i.id === "string")
	const whereis = (id: unknown) =>
		FOLDERS.flatMap((f) => things(f).filter((i) => i.id === id).map((i) => ({ f, i })))
	const holder = (f: string) => (f === "desk" ? "./desk" : `./desk/${f}`)
	const typeOf = (f: string, name: string) => read(`./desk/${f}/${name}/type`) as string
	const libName = (id: unknown) =>
		list("/library").find((n) => entries(`/library/${n}`)[0]?.id === id) ?? "?"

	// ---- the supervisor: a drawing process for every place a thing sits. the walk up is the
	// host's (way: the first way to run "render/<type>" found from the thing's place, tracked); a
	// nearer render/<type> placed, the one found edited, the thing moved or mounted, changes what
	// this finds, and the process there is stopped and started again with the new way. a place
	// gone: its process stopped ----
	const running = new Map<string, { sig: string; p: ReturnType<typeof start> }>()
	effect("procs", () => {
		const want: Record<
			string,
			{ sig: string; at: string[]; folder: string[]; w: any; args: string[] }
		> = {}
		for (const f of FOLDERS) {
			for (const { name } of things(f)) {
				const folder = ["/", "desk", f, name]
				const type = typeOf(f, name)
				const found = way(`render/${type}`, ["desk", f, name])
				const w = found ?? way("/missing", [])
				if (!w) continue
				const program = w.program
				const holderAt = program.at.slice(0, -2)
				// how many places up from the process's place the renderer's holder is
				const args = [
					String(type),
					found ? libName(program.id) : "none",
					String(found ? folder.length - holderAt.length : -1),
					holderAt.at(-1) ?? "/",
					found ? String(program.id) : "",
					f,
				]
				want[`${f}/${name}`] = {
					sig: JSON.stringify([program.id, program.at, read(asId(program.id))]),
					at: [...folder, "look:" + f],
					folder,
					w,
					args,
				}
			}
		}
		return want
	}, (want) => {
		for (const [key, r] of running) {
			if (want[key]?.sig === r.sig) continue
			if (!("refused" in r.p)) stop(r.p)
			running.delete(key)
		}
		for (const [key, x] of Object.entries(want)) {
			if (running.has(key)) continue
			const p = start(x.w, x.at, { folder: x.folder, args: x.args })
			if ("refused" in p) console.error(`look ${key}: refused ${p.refused}`)
			else running.set(key, { sig: x.sig, p })
		}
	})

	// ---- methods: what a person does. a DOM event has no scope, so each is a send ----
	// a drag ends here: the same id lands in the other folder (move) or in both (mount)
	method("on/take", (id, from, to, mount) => {
		const src = things(from).find((i) => i.id === id)
		if (!src || from === to) return
		let msg = ""
		if (things(to).some((i) => i.id === id)) msg = `${src.name} is in ${to} already`
		else if (things(to).some((i) => i.name === src.name)) {
			// a name holds one id: the other folder already has something under this name
			msg = `${to} already has a ${src.name}`
		} else if (mount) {
			place(`./desk/${to}/${src.name}`, asId(src.id))
			msg = `${src.name} mounted in ${to}: one node, two places, two processes`
		} else {
			move(`./desk/${from}/${src.name}`, `./desk/${to}/${src.name}`)
			msg = `${src.name} moved to ${to}: the same node, found its renderer again from there`
		}
		put(said, msg)
	})
	method("on/leave", (id, folder) => {
		const src = things(folder).find((i) => i.id === id)
		if (!src || whereis(id).length < 2) return
		unplace(`./desk/${folder}/${src.name}`)
		put(said, `${src.name} left ${folder}; it is still in ${whereis(id)[0].f}`)
	})
	// a renderer chip dropped in a folder: placed under its render/<type> (replacing what was there),
	// the same library node again. from: the folder it came out of, taken out unless keep
	method("on/render", (id, type, from, to, keep) => {
		const name = libName(id)
		const stands = (f: string) => entries(`${holder(f)}/render/${type}`).some((i) => i.id === id)
		const has = (f: string) => entries(`${holder(f)}/render/${type}`).length > 0
		if (to && !stands(to)) {
			if (!entries(`${holder(to)}/render`).length) open(`${holder(to)}/render`, null)
			for (const _old of entries(`${holder(to)}/render/${type}`)) {
				unplace(`${holder(to)}/render/${type}`)
			}
			place(`${holder(to)}/render/${type}`, asId(id))
			put(said, `${name} placed in ${to}/render/${type}`)
		}
		if (from && from !== to && !keep && stands(from) && has(from)) {
			unplace(`${holder(from)}/render/${type}`)
			if (!to) put(said, `${name} taken out of ${from}/render/${type}`)
		}
	})
	// a renderer's source written: one write, every drawing that found it runs again. what came of
	// it is a node too (compiled), shown by the save button
	method("on/source", (id, text) => {
		try {
			compile(text)
		} catch (e) {
			const why = String((e as Error).message)
			put(compiled, "not saved: " + why)
			return why
		}
		put(asId(id), text)
		put(compiled, "saved")
		put(said, "a renderer's source written: its drawings run again")
	})
	// a folder's own accent: placed, or the next colour; alt: taken away (its things look up again)
	method("on/accent", (folder, take) => {
		const at = `${holder(folder)}/accent`
		const own = entries(at).length > 0
		if (take && own) return remove(at)
		const near = up(["accent"], folder === "desk" ? ["desk"] : ["desk", folder])
		const next = palette[(palette.indexOf(read(near!) as string) + 1) % palette.length]
		if (own) put(at, next)
		else open(at, next)
	})
	method("on/add", (folder) => {
		const [type, base, value] = spares[Math.floor(Math.random() * spares.length)]
		const name = base + Math.random().toString(36).slice(2, 5)
		open(`./desk/${folder}/${name}`, value)
		open(`./desk/${folder}/${name}/type`, type)
		put(said, `${name} made in ${folder}`)
	})
	// a double-click: change the value, so the processes that draw it run again
	method("on/poke", (id) => {
		const [{ f, i }] = whereis(id)
		const at = `./desk/${f}/${i.name}`
		const v = read(at) as any
		const k = typeOf(f, i.name)
		const colours = ["#ff2284", "#40dcba", "#2269ff", "#fff27a", "#111"]
		put(
			at,
			k === "number"
				? v + 1
				: k === "note"
				? v + " !"
				: k === "colour"
				? colours[(colours.indexOf(v) + 1) % colours.length]
				: k === "list"
				? [...v, "more"]
				: v.slice(12) + v.slice(0, 12),
		)
	})
	method("on/pick", (id, folder, x, y) => {
		put(picked, { id, folder, x, y })
		put(compiled, SAVE)
	})

	// ---- what the windows say: memos, each a node the view is bound to ----
	// how many folders each thing sits in (more than one: a mount), and how many things a folder has
	memo("mounts", () => {
		const n: Record<string, number> = {}
		for (const f of FOLDERS) {
			for (const i of things(f)) n[i.id] = (n[i.id] ?? 0) + 1
		}
		return n
	})
	memo("counts", () => Object.fromEntries(FOLDERS.map((f) => [f, things(f).length])))
	// each folder's accent and the desk's: the nearest one walking up (a lookup), and whose it is
	memo("accents", () => {
		const of = (at: string[]) => {
			const a = up(["accent"], at)
			return a && {
				value: read(a),
				from: a.path!.at(-2) ?? "/",
				own: a.path!.length - 1 === at.length,
			}
		}
		const out: Record<string, unknown> = { desk: of(["desk"]) }
		for (const f of FOLDERS) out[f] = of(["desk", f])
		return out
	})

	// ---- who drew this pixel? read from the graph alone ----
	memo("answer", () => {
		const p = read(picked) as any
		if (!p) return null
		const at = whereis(p.id)
		const here = at.find((a) => a.f === p.folder)
		if (!here) return { gone: true, ...p }
		const thing = here.i
		const look = `/desk/${p.folder}/${thing.name}/look:${p.folder}`
		const opsAt = `${look}/ops`
		const pic = read(opsAt) as any
		const ops: Op[] = pic?.ops ?? []
		const op = hit(ops, p.x, p.y)
		const chain: string[] = []
		const proc = entries(look)[0]
		if (proc) chain.push("look:" + p.folder, thing.name, p.folder, "desk", "/")
		return {
			...p,
			name: thing.name,
			type: typeOf(p.folder, thing.name),
			value: read(`./desk/${p.folder}/${thing.name}`),
			places: at.map((a) => ({ folder: a.f, name: a.i.name })),
			process: proc && { id: proc.id, value: read(look), chain },
			pic: pic &&
				{
					type: pic.type,
					renderer: pic.renderer,
					name: pic.name,
					up: pic.up,
					holder: pic.holder,
				},
			source: pic?.renderer ? read(asId(pic.renderer)) : undefined,
			ops: ops.length,
			op,
			opText: op >= 0 ? JSON.stringify(ops[op]) : null,
			run: entries(opsAt).length ? about(open(opsAt)) : undefined,
		}
	})

	// ---- dragging: a tile to a window moves it, alt mounts it; a click is a pixel; a chip to a
	// window places that renderer there ----
	type What = { thing: { id: string; folder: string } } | {
		chip: { id: string; type: string; from?: string }
	}
	let ghost: HTMLElement | undefined
	let why: HTMLElement | undefined
	function grab(e: PointerEvent, what: What, src: HTMLElement) {
		if (e.button !== 0) return
		e.preventDefault()
		e.stopPropagation()
		const x0 = e.clientX, y0 = e.clientY
		const box = src.getBoundingClientRect()
		let over: HTMLElement | null = null
		const move = (m: PointerEvent) => {
			if (!ghost && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return
			if (!ghost) {
				ghost = "thing" in what
					? Object.assign(document.createElement("img"), {
						src: (src as HTMLCanvasElement).toDataURL(),
					})
					: (src.cloneNode(true) as HTMLElement)
				ghost.classList.add("drag")
				document.body.append(ghost)
			}
			ghost.style.left = `${m.clientX - (x0 - box.left)}px`
			ghost.style.top = `${m.clientY - (y0 - box.top)}px`
			over?.classList.remove("drop", "mount")
			over = (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest(
				"[data-drop]",
			) ?? null
			const ok = over &&
				("thing" in what
					? over.dataset.drop !== what.thing.folder && FOLDERS.includes(over.dataset.drop!)
					: over.dataset.drop !== what.chip.from)
			if (over && ok) {
				over.classList.add("drop")
				over.classList.toggle("mount", m.altKey)
			}
		}
		const release = (u: PointerEvent) => {
			removeEventListener("pointermove", move)
			removeEventListener("pointerup", release)
			over?.classList.remove("drop", "mount")
			if (!ghost) {
				if ("thing" in what) {
					const r = src.getBoundingClientRect()
					send(
						"on/pick",
						what.thing.id,
						what.thing.folder,
						u.clientX - r.left,
						u.clientY - r.top,
					)
					pulse() // the answer is drawn now: bring it into view
					why?.scrollIntoView({ block: "nearest" })
				}
				return
			}
			ghost.remove()
			ghost = undefined
			const to = (over as HTMLElement | null)?.dataset.drop
			if ("thing" in what) {
				if (to && to !== what.thing.folder && FOLDERS.includes(to)) {
					send("on/take", what.thing.id, what.thing.folder, to, u.altKey)
				}
			} else {
				const c = what.chip
				send("on/render", c.id, c.type, c.from, to === "library" ? undefined : to, u.altKey)
			}
		}
		addEventListener("pointermove", move)
		addEventListener("pointerup", release)
	}

	// ---- the page ----
	type Chip = { id: string; type: string; name: string }

	// a chip is a renderer placed (or in the library); drag it into a window
	const Chip = ({ c, from }: { c: Chip; from?: string }) => (
		<span
			class="chip"
			title={from
				? `placed here under render/${c.type}: drag to move, alt-drag to keep`
				: "drag into a window"}
			onPointerDown={(ev: PointerEvent) => {
				grab(ev, { chip: { ...c, from } }, ev.currentTarget as HTMLElement)
			}}
		>
			<b>{c.type + " "}</b>
			{c.name}
		</span>
	)
	// a folder's render/ chips: the members under its render node
	const Strip = ({ f, at }: { f: string; at: string }) => (
		<span class="chips">
			{under(
				`${at}/render`,
				(c) => <Chip c={{ id: c.id as string, type: c.name!, name: libName(c.id) }} from={f} />,
			)}
		</span>
	)
	// an accent: the nearest one up; click gives this folder its own (or the next colour), alt-click
	// takes its own away
	const Accent = ({ f }: { f: string }) => [
		<span class="grow" />,
		<span class="k">
			{bind("accents", (all) => all[f]?.own ? "accent" : `accent ↑ ${all[f]?.from}`)}
		</span>,
		<button
			class={bind("accents", (all) => all[f]?.own ? "acc" : "acc inherited")}
			style={bind("accents", (all) => `background: ${all[f]?.value ?? "#fff"}`)}
			title="click: this folder's own accent, or its next colour; alt-click: take its own away"
			onClick={handler("on/accent", (e: MouseEvent) => [f, e.altKey])}
		/>,
	]
	// a tile: the canvas its process paints (the first time from what it already drew), its name,
	// a mount's count; picked, a ring at the pixel
	const Tile = ({ f, thing }: { f: string; thing: Item }) => {
		const id = thing.id as string
		const mine = (p: any) => p.id === id && p.folder === f
		return (
			<div
				class={bind("mounts", (n) => n[id] > 1 ? "tile mounted" : "tile")}
				data-picked={bind("picked", mine)}
				title="drag to move; alt-drag to mount; double-click to change it"
				onDblClick={handler("on/poke", [id])}
			>
				<canvas
					width={W * dpr}
					height={H * dpr}
					data-thing={id}
					data-folder={f}
					data-drawn-by={bind(
						`/desk/${f}/${thing.name}/look:${f}/ops`,
						(pic) => (pic ? `${pic.name} for ${pic.type}` : ""),
					)}
					ref={(c) => {
						const pic = read(`/desk/${f}/${thing.name}/look:${f}/ops`) as
							| { ops: Op[] }
							| undefined
						if (pic) paint(c, pic.ops)
					}}
					onPointerDown={(e: PointerEvent) => {
						grab(e, { thing: { id, folder: f } }, e.currentTarget as HTMLElement)
					}}
				/>
				<div class="lbl">
					{thing.name}
					{bind("mounts", (n) =>
						n[id] > 1 && (
							<i
								title="click: take this mount away"
								onPointerDown={(e: Event) => {
									e.stopPropagation()
								}}
								onClick={handler("on/leave", [id, f])}
							>
								↺{n[id]}
							</i>
						))}
				</div>
				{bind("picked", (p) =>
					mine(p) && <div class="x" style={`left: ${p.x}px; top: ${p.y}px`} />)}
			</div>
		)
	}
	const Win = ({ f }: { f: string }) => (
		<div class="win" data-drop={f}>
			<div class="title">
				<span>{f}</span>
				<small class="n">
					{bind("counts", (c) => `${c[f]} item${c[f] === 1 ? "" : "s"}`)}
				</small>
				<button title="make a new thing here" onClick={handler("on/add", [f])}>+</button>
			</div>
			<div class="tiles">
				{under(
					`/desk/${f}`,
					(thing) => RESERVED.includes(thing.name!) ? null : <Tile f={f} thing={thing} />,
				)}
			</div>
			<div class="strip">
				<span class="k">render/</span>
				<Strip f={f} at={`/desk/${f}`} />
				{Accent({ f })}
			</div>
		</div>
	)

	// the answer, line by line
	const chipOf = (s: string, cls = "") => <span class={"chip at " + cls}>{s}</span>
	const dim = (s: string) => <span class="dim">{s}</span>
	const short = (v: unknown, n = 60) => {
		const s = JSON.stringify(v)
		return s.length > n ? s.slice(0, n - 1) + "…" : s
	}
	let ta: HTMLTextAreaElement | undefined
	const Answer = ({ a }: { a: any }) => {
		if (a.gone) return <div>that thing is not in {a.folder} any more</div>
		const canvas = document.querySelector<HTMLCanvasElement>(
			`canvas[data-thing="${a.id}"][data-folder="${a.folder}"]`,
		)
		const [r, g, b, al] = canvas?.getContext("2d")!.getImageData(
			Math.floor(a.x * dpr),
			Math.floor(a.y * dpr),
			1,
			1,
		).data ?? []
		const pic = a.pic
		const run = a.run
		const c = run?.change
		const site = (c?.external ?? [])[0]
		const pa = ["desk", a.folder, a.name, "look:" + a.folder]
		const pickIn = (address: string[]) => () => (globalThis as any).parent.__pick?.(address)
		return [
			canvas && (
				<div>
					{`pixel ${Math.floor(a.x)}, ${Math.floor(a.y)} of ${a.name} in ${a.folder} `}
					<span class="sw" style={`background: rgba(${r},${g},${b},${al / 255})`} />
					{` rgb(${r}, ${g}, ${b})`}
				</div>
			),
			<div>
				{a.op < 0
					? dim("no op painted here: the canvas shows through")
					: `painted by op ${a.op + 1} of ${a.ops}: `}
			</div>,
			a.opText && (
				<div>
					<code>{a.opText}</code>
				</div>
			),
			<h4>the thing</h4>,
			<div>
				{`${a.name} · ${a.type} · `}
				{dim(String(a.id).slice(0, 8))}
			</div>,
			<div>
				value <code>{short(a.value)}</code>
			</div>,
			<div>
				{a.places.length > 1
					? `one node, ${a.places.length} places, so ${a.places.length} processes: `
					: "placed at "}
				{a.places.map((p: any) => chipOf(`/desk/${p.folder}/${p.name}`))}
			</div>,
			<h4>the renderer its process found</h4>,
			!pic?.renderer
				? (
					<div>
						<code>none</code>
						{` for ${pic?.type}: lookup walked to the root`}
					</div>
				)
				: [
					<div>
						{chipOf(pic.name)} {dim(String(pic.renderer).slice(0, 8))}
						{` for ${pic.type}`}
					</div>,
					<div>
						found at{" "}
						<code>
							{`/desk${
								FOLDERS.includes(pic.holder) ? "/" + pic.holder : ""
							}/render/${pic.type}`}
						</code>, <b>{`${pic.up} level${pic.up === 1 ? "" : "s"} up`}</b> from its place
					</div>,
				],
			<div class="walk">
				{(a.process?.chain ?? []).map((n: string, i: number) => [
					i ? dim("↑") : null,
					chipOf(n, i === pic?.up ? "hit" : i < (pic?.up ?? -1) ? "miss" : ""),
				])}
			</div>,
			<h4>the process that drew it</h4>,
			<div>
				{chipOf(`/desk/${a.folder}/${a.name}/look:${a.folder}`)}
				{dim(" " + String(a.process?.id).slice(0, 8))}
			</div>,
			<div>
				its value <code>{short(a.process?.value)}</code>
			</div>,
			<h4>its latest run</h4>,
			run?.part && (
				<div>
					{`ops ${run.part.kind}: run #${run.last?.run ?? "?"}, ${run.last?.ended ?? "?"}`}
					{run.last?.equal ? " (same value)" : ""}
					{dim(` · ${run.part.runs} run${run.part.runs === 1 ? "" : "s"} so far`)}
				</div>
			),
			run?.last?.error && (
				<div>
					<code class="err">{String(run.last.error)}</code>
				</div>
			),
			c && [
				<div>
					written by {chipOf(String(c.actor))}
					{c.reader !== undefined ? ` for ${c.reader}` : ""}
				</div>,
				Object.keys(c.metadata ?? {}).length > 0 && (
					<div>
						{dim("scope: ")}
						{Object.entries(c.metadata).map(([k, v]: [string, unknown]) =>
							chipOf(`${k} ${typeof v === "string" ? v.slice(0, 8) : short(v, 16)}`)
						)}
					</div>
				),
				<div>{`at ${new Date(c.time * 1000).toLocaleTimeString()}`}</div>,
				<div>
					{dim("site: ")}
					<code>
						{site
							? `${site.function ?? ""} ${
								String(site.file).split("/").pop()?.slice(0, 12)
							}…:${site.line}`.trim()
							: "none"}
					</code>
				</div>,
			],
			<div>
				<button onClick={pickIn([...pa, "ops"])}>pick the process in the graph</button>{" "}
				{pic?.renderer && (
					<button onClick={pickIn(["library", pic.name])}>pick the renderer</button>
				)}
			</div>,
			// the source: keyed by its renderer, so an edit under way stays while the rest redraws
			// (defaultValue: what a textarea starts with, never what it has been typed into)
			a.source !== undefined && [
				<h4>{`${pic.name}'s source`}</h4>,
				<textarea
					key={pic.renderer}
					spellcheck={false}
					defaultValue={a.source}
					ref={(e) => (ta = e)}
				/>,
				<div>
					<button onClick={handler("on/source", () => [pic.renderer, ta!.value])}>save</button>
					{" "}
					<span class={bind("compiled", (m: string) => m.startsWith("not") ? "err" : "dim")}>
						{bind("compiled")}
					</span>
				</div>,
			],
		]
	}

	return (
		<div class="desk">
			<style>{css}</style>
			<p class="hint">
				drag a tile to another window to <b>move</b> it; hold alt to <b>mount</b>{" "}
				it in both. drag a renderer chip into a window: that folder draws with it. click a
				pixel: who drew it?
				<span class="said">{bind("said")}</span>
			</p>
			<div class="wins">
				{FOLDERS.map((f) => <Win f={f} />)}
				<div class="win lib" title="drag a chip into a window: that folder carries it">
					<div class="title">
						<span>renderers</span>
					</div>
					<div class="strip">
						<span class="k">library</span>
						<span class="chips">
							{under("/library", (m) => (
								<Chip
									c={{
										id: m.id as string,
										name: m.name!,
										type: read(`/library/${m.name}/type`) as string,
									}}
								/>
							))}
						</span>
					</div>
					<div class="strip" data-drop="desk">
						<span class="k">desk/render/</span>
						<Strip f="desk" at="/desk" />
						{Accent({ f: "desk" })}
					</div>
				</div>
			</div>
			<div class="win why" data-open={bind("answer", () => true)} ref={(e) => (why = e)}>
				<div class="title">
					<span>who drew this pixel?</span>
				</div>
				<div class="body">{bind("answer", (a) => Answer({ a }))}</div>
			</div>
		</div>
	)
}
