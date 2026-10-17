// icons.ts: a node drawn as an icon, and where each sits in its folder (My Computer, the desk)
//
//   const I = icons.make(blit, {u, colours})   colours: paper line lemon cherry dim desk, read
//                                              at each call
//   I.entry(api, at, name, items)              {at, name, ids, e, kids, value, commit, kind}
//   I.kind(e)  I.describe(e)                   folder trash text picture app program data
//                                              pending refused; in words
//   I.icon(f, e, x, y, on, clear?)  I.size()   the theme's icons, else System 7's pixels
//   I.art  I.pattern  I.framed                 pictures
//   I.open(api, path, e)                       opened by kind; a word to say, or null
//   I.move(api, e, to, toname)                 a node to another name
//   I.rename(api, e, toname)                   a new name in its folder, where the old name was
//   I.link(api, e, to, toname)                 placed there too, by id (as ln)
//   I.free(api, at, n)                         a name not yet used
//   I.holds(api, at, id)                       the name a folder holds an id at, or null
//   I.into(api, e, at, link?)                  moved, or (option-cmd) linked, into a folder; its
//                                              name there. never the Trash, nor into itself
//   I.land(api, items, at, link?)              a drop's items ({at, name, id}); each {to,
//                                              already | error}
//   icons.dropped(api, x, y)                   the front window there, or the desk: {layer, drop},
//                                              drop its on/drop ([{items, x, y, linked}]) or null
//
// layout: /apps/computer/layout/<folder id> = {icons: {<id>: [x, y]}, window?: {x, y, w, h}},
// in points; keyed by ids, so renames and moves keep it
//
//   icons.folder(api, path)  icons.layout.at(id)   a folder's id; its layout's address
//   icons.keyed(entries)                       e.key: its id (a second at one id: id#name)
//   icons.spots(ids, saved, slot, cell)        saved, else the first free slot
//   icons.clean(spots, slot, cell)             each to the nearest free slot, top first
//   icons.nearest(spots, from, dx, dy)         the one an arrow goes to

// deno-lint-ignore-file no-explicit-any
import { drop, idAt, isStatus, make as makeAt, put, val } from "./kit.ts"
import type { Blitter, Rect } from "./blitter.ts"

// the part's api (any: an api's reads and writes as kit.ts types them, and move)
type Api = any
/** what a part was given that starting and calling need */
type Part = {
	api: Api
	start: (op: unknown) => string
	call: (address: string[], args?: unknown) => unknown
}
export type Entry = {
	at: string[]
	name: string
	ids: string[]
	e: boolean
	kids: number
	value: any
	commit?: any
	// what a program needs and a loader provides: its info ermine.program.provisions (loader.c)
	provisions?: { needs?: string[]; provides?: string[] } | null
	kind: string
}
export type Spot = [number, number]
/** an icon dropped on a window (dropped): the folder it is in, its name there, the node's id, and where the hand
 * held it, pixels from the icon's top left */
export type Item = { at: string[]; name: string; id: string; grip?: Spot }

const isPicture = (v: any) => v?.kind === "picture" && Array.isArray(v.rows)
/** an icon's side, in points: catclock's big icons' (an app's own picture three points a pixel) */
export const SIZE = 48

// pixel icons (the theme's icons {style: "pixel"}, the default): 16 × 16, two points a pixel: k line, p paper,
// y folder lemon, c cherry, d dim
const ICONS: Record<string, string[]> = {
	folder: [
		"................",
		"................",
		"..kkkkk.........",
		".kyyyyyk........",
		"kkkkkkkkkkkkkkk.",
		"kyyyyyyyyyyyyyk.",
		"kyyyyyyyyyyyyyk.",
		"kyyyyyyyyyyyyyk.",
		"kyyyyyyyyyyyyyk.",
		"kyyyyyyyyyyyyyk.",
		"kyyyyyyyyyyyyyk.",
		"kyyyyyyyyyyyyyk.",
		"kyyyyyyyyyyyyyk.",
		"kkkkkkkkkkkkkkk.",
		"................",
		"................",
	],
	text: [
		"..kkkkkkkkk.....",
		"..kpppppppkk....",
		"..kpppppppkpk...",
		"..kpppppppkkkk..",
		"..kpkkkkpppppk..",
		"..kppppppppppk..",
		"..kpkkkkkkkppk..",
		"..kppppppppppk..",
		"..kpkkkkkkpppk..",
		"..kppppppppppk..",
		"..kpkkkkkkkppk..",
		"..kppppppppppk..",
		"..kpkkkkkppppk..",
		"..kppppppppppk..",
		"..kkkkkkkkkkkk..",
		"................",
	],
	data: [
		"..kkkkkkkkk.....",
		"..kpppppppkk....",
		"..kpppppppkpk...",
		"..kpppppppkkkk..",
		"..kppppppppppk..",
		"..kppcpppcpppk..",
		"..kpcppppcpppk..",
		"..kpcpppppcppk..",
		"..kcppppppcppk..",
		"..kpcpppppcppk..",
		"..kpcppppcpppk..",
		"..kppcpppcpppk..",
		"..kppppppppppk..",
		"..kppppppppppk..",
		"..kkkkkkkkkkkk..",
		"................",
	],
	program: [
		".......kk.......",
		"......kcck......",
		".....kcccck.....",
		"....kccppcck....",
		"...kccpkkpcck...",
		"..kccpkppkpcck..",
		".kccpkppppkpcck.",
		"kccpkppppppkpcck",
		"kccpkppppppkpcck",
		".kccpkppppkpcck.",
		"..kccpkppkpcck..",
		"...kccpkkpcck...",
		"....kccppcck....",
		".....kcccck.....",
		"......kcck......",
		".......kk.......",
	],
	trash: [
		"................",
		"......kkkk......",
		"..kkkkkkkkkkkk..",
		"..kppppppppppk..",
		"..kkkkkkkkkkkk..",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"....kkkkkkkk....",
		"................",
	],
	full: [
		"...kkkk.kkk.....",
		"..kppppkpppk....",
		"..kpkpkkppkpk...",
		"..kkkkkkkkkkkk..",
		"..kppppppppppk..",
		"..kkkkkkkkkkkk..",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"...kpkpkpkpkk...",
		"....kkkkkkkk....",
		"................",
	],
	pending: [
		"..d.d.d.d.d.....",
		"................",
		"..d.......d.d...",
		"................",
		"..d.........d...",
		"................",
		"..d.........d...",
		"................",
		"..d.........d...",
		"................",
		"..d.........d...",
		"................",
		"..d.........d...",
		"................",
		"..d.d.d.d.d.d...",
		"................",
	],
	refused: [
		"..kkkkkkkkk.....",
		"..kpppppppkk....",
		"..kpppppppkpk...",
		"..kpppppppkkkk..",
		"..kppppppppppk..",
		"..kpcppppppcpk..",
		"..kppcppppcppk..",
		"..kpppcppcpppk..",
		"..kppppccppppk..",
		"..kpppcppcpppk..",
		"..kppcppppcppk..",
		"..kpcppppppcpk..",
		"..kppppppppppk..",
		"..kppppppppppk..",
		"..kkkkkkkkkkkk..",
		"................",
	],
}
// the selected one darker, as System 7 darkens an icon it has selected
const dark = (c: number) => ((c >> 1) & 0x7f7f7f) + ((c >> 2) & 0x3f3f3f)

// --- icons, as catclock's Files draws them: a folder, its back and its front tinted; a page, white, its corner
// turned, a band at its foot saying what is in it; the Trash a soft bin, as a folder's lilac. Each a few shapes in
// its own units (catclock's SVG's), drawn smooth (sixteen samples a pixel) once at a size and kept, then blended
// over what is under it; over clear pixels (the desk's layer), each pixel in or out, as only those can be there

/** a path's outline, as points in its units: M x y, L x y, H x, V y, Q cx cy x y (a curve, in 8 steps); Z closes */
const outline = (d: string): number[] => {
	const t = d.match(/[MLHVQZ]|-?[\d.]+/g) ?? []
	const out: number[] = []
	let x = 0, y = 0, i = 0
	const n = () => Number(t[i++])
	while (i < t.length) {
		const c = t[i++]
		if (c === "M" || c === "L") {
			x = n()
			y = n()
			out.push(x, y)
		} else if (c === "H") {
			x = n()
			out.push(x, y)
		} else if (c === "V") {
			y = n()
			out.push(x, y)
		} else if (c === "Q") {
			const cx = n(), cy = n(), ex = n(), ey = n()
			for (let k = 1; k <= 8; k++) {
				const s = k / 8, r = 1 - s
				out.push(
					r * r * x + 2 * r * s * cx + s * s * ex,
					r * r * y + 2 * r * s * cy + s * s * ey,
				)
			}
			x = ex
			y = ey
		}
	}
	return out
}
const box = (x: number, y: number, w: number, h: number, r: number) =>
	outline(
		`M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${
			y + h
		} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${
			x + r
		},${y} Z`,
	)
/** a shape: a fill (an outline, filled nonzero) or a stroke (a line along points, width across, its ends round), a colour, and how strong */
type Shape = {
	fill?: number[]
	stroke?: number[]
	width?: number
	closed?: boolean
	color: number
	alpha?: number
}
/**
 * how much of each pixel a fill covers, w × h pixels, k a unit: on four lines across each row of pixels, where its
 * edges cross them, nonzero; each span between added to the pixels it passes over, by how much of each it does
 */
const filled = (p: number[], w: number, h: number, k: number) => {
	const cover = new Float32Array(w * h), N = 4, cross: [number, number][] = []
	for (let py = 0; py < h; py++) {
		for (let j = 0; j < N; j++) {
			const y = (py + (j + 0.5) / N) / k
			cross.length = 0
			for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) {
				const x0 = p[m], y0 = p[m + 1], x1 = p[i], y1 = p[i + 1]
				if ((y0 <= y) === (y1 <= y)) continue
				cross.push([(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0)) * k, y1 > y0 ? 1 : -1])
			}
			cross.sort((a, b) => a[0] - b[0])
			let wind = 0
			for (let c = 0; c < cross.length - 1; c++) {
				wind += cross[c][1]
				if (!wind) continue
				const xa = Math.max(0, cross[c][0]), xb = Math.min(w, cross[c + 1][0])
				for (let px = Math.floor(xa); px < xb && px < w; px++) {
					cover[py * w + px] += (Math.min(px + 1, xb) - Math.max(px, xa)) / N
				}
			}
		}
	}
	return cover
}
/** how much of each pixel a stroke covers: along each segment, as far from it as half its width, the edge smooth */
const stroked = (p: number[], closed: boolean, width: number, w: number, h: number, k: number) => {
	const cover = new Float32Array(w * h), n = p.length / 2, hw = (width / 2) * k
	for (let i = 0; i < (closed ? n : n - 1); i++) {
		const x0 = p[2 * i] * k,
			y0 = p[2 * i + 1] * k,
			x1 = p[(2 * i + 2) % p.length] * k,
			y1 = p[(2 * i + 3) % p.length] * k
		const dx = x1 - x0, dy = y1 - y0, l = dx * dx + dy * dy
		for (
			let py = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1));
			py < Math.min(h, Math.ceil(Math.max(y0, y1) + hw + 1));
			py++
		) {
			for (
				let px = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1));
				px < Math.min(w, Math.ceil(Math.max(x0, x1) + hw + 1));
				px++
			) {
				const x = px + 0.5,
					y = py + 0.5,
					t = l ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l)) : 0
				const c = Math.max(
					0,
					Math.min(1, hw + 0.5 - Math.hypot(x - x0 - t * dx, y - y0 - t * dy)),
				)
				if (c > cover[py * w + px]) cover[py * w + px] = c
			}
		}
	}
	return cover
}
const ink = (a: number, b: number, t: number) =>
	[16, 8, 0].reduce(
		(c, k) => c | (Math.round(((a >> k) & 255) * (1 - t) + ((b >> k) & 255) * t) << k),
		0,
	)
/**
 * shapes drawn w × h pixels, k pixels a unit: each pixel the shapes over one another by how much of it each
 * covers, its alpha in the top byte (0 opaque, as the blitter's blend has it); clear, each pixel in (half covered)
 * or out
 */
const raster = (w: number, h: number, k: number, shapes: Shape[], clear: boolean) => {
	const covers = shapes.map((
		s,
	) => (s.fill ? filled(s.fill, w, h, k) : stroked(s.stroke!, !!s.closed, s.width ?? 1, w, h, k)))
	const bits = new Uint32Array(w * h)
	for (let i = 0; i < w * h; i++) {
		let a = 0, r = 0, g = 0, b = 0
		shapes.forEach((s, n) => {
			const c = Math.min(1, covers[n][i]) * (s.alpha ?? 1)
			if (!c) return
			r = r * (1 - c) + ((s.color >> 16) & 255) * c
			g = g * (1 - c) + ((s.color >> 8) & 255) * c
			b = b * (1 - c) + (s.color & 255) * c
			a = a * (1 - c) + c
		})
		const colour = a
			? (Math.round(r / a) << 16) | (Math.round(g / a) << 8) | Math.round(b / a)
			: 0
		bits[i] = clear
			? (a >= 0.5 ? colour : 0xff000000)
			: (((255 - Math.round(a * 255)) << 24) | colour) >>> 0
	}
	return bits
}
// catclock's: a folder's two tints, by the area it is in (its path's first name), as catclock tints its src, build
// and loaders; a page's band for what it holds
const TINT = {
	root: [0xffd95e, 0xfff0a6],
	pink: [0xffa9cf, 0xffd2e6],
	blue: [0x94c6ff, 0xc8e2ff],
	mint: [0x8ddbb5, 0xc3f0da],
	trash: [0xc3b2ff, 0xe0d6ff],
	lilac: [0xc3b2ff, 0xe0d6ff],
}
const AREA: Record<string, number[]> = {
	home: TINT.pink,
	programs: TINT.blue,
	lib: TINT.blue,
	Applications: TINT.blue,
	drivers: TINT.mint,
	dev: TINT.mint,
	hw: TINT.mint,
}
const tinted = (path: string[], own?: unknown) =>
	Array.isArray(own) && own.length === 2 && own.every((c) => typeof c === "number")
		? own as number[]
		: AREA[path[0]] ?? (path.length <= 1 ? TINT.root : TINT.lilac)
const BAND: Record<string, number> = {
	text: 0xd9cfdd,
	data: 0xffd84d,
	c: 0xff8fc0,
	javascript: 0x5fcf9f,
	wasm: 0x6eb4ff,
	builtin: 0xb7a2ff,
	exec: 0xb7a2ff,
	refused: 0xe2457c,
}
const LINE = 0x3a2a43
// a folder, 64 × 52 units: its back with its tab, its front, a highlight along the front's top
const FOLDER = (back: number, front: number): Shape[] => [
	{
		fill: outline(
			"M3,9 Q3,4 8,4 H23 Q26,4 28,7 L30,10 H56 Q61,10 61,15 V45 Q61,49 57,49 H7 Q3,49 3,45 Z",
		),
		color: back,
	},
	{
		fill: outline("M3,19 Q3,15 7,15 H57 Q61,15 61,19 V45 Q61,49 57,49 H7 Q3,49 3,45 Z"),
		color: front,
	},
	{ stroke: [8, 19.6, 56, 19.6], width: 1.3, color: 0xffffff, alpha: 0.75 },
]
// a page, 48 × 60 units: white, its corner turned, a band at its foot; arriving, faint
const PAGE = (band: number | null, faint = false): Shape[] => {
	const body = outline("M8,2 H31 L44,15 V54 Q44,58 40,58 H8 Q4,58 4,54 V6 Q4,2 8,2 Z")
	const corner = outline("M31,2 V11 Q31,15 35,15 H44 Z")
	return [
		{ fill: body, color: 0xffffff, alpha: faint ? 0.4 : 1 },
		...(band === null ? [] : [{ fill: box(4.5, 42, 39, 11, 0), color: band }]),
		{ stroke: body, closed: true, width: 1, color: LINE, alpha: faint ? 0.18 : 0.24 },
		{ fill: corner, color: 0xf4eef7, alpha: faint ? 0.4 : 1 },
		{ stroke: corner, width: 1, color: LINE, alpha: faint ? 0.18 : 0.24 },
	]
}
// the Trash, 48 × 60 units: a soft bin, its lid and handle, white ribs; full, a page crumpled on it
const TRASH = (full: boolean, own?: unknown): Shape[] => {
	const [lid, body] = Array.isArray(own) && own.length === 2 ? own as number[] : TINT.trash
	return [
		...(full
			? [{ fill: outline("M13,15 L17,3 L31,5 L34,15 Z"), color: 0xffffff }, {
				stroke: outline("M13,15 L17,3 L31,5 L34,15"),
				width: 1,
				color: LINE,
				alpha: 0.24,
			}]
			: []),
		{ fill: outline("M9,19 H39 L37,53 Q36.7,57 33,57 H15 Q11.3,57 11,53 Z"), color: body },
		{ stroke: [19, 24, 19.6, 51], width: 2.2, color: 0xffffff, alpha: 0.8 },
		{ stroke: [24, 24, 24, 51], width: 2.2, color: 0xffffff, alpha: 0.8 },
		{ stroke: [29, 24, 28.4, 51], width: 2.2, color: 0xffffff, alpha: 0.8 },
		{ stroke: outline("M19,12 V9 Q19,7 21,7 H27 Q29,7 29,9 V12"), width: 2.4, color: lid },
		{ fill: box(6, 12, 36, 6, 3), color: lid },
	]
}

export function make(blit: Blitter, style: { u: number; colours: Record<string, any> }) {
	const C = style.colours
	const kind = (e: Omit<Entry, "kind">) => {
		const v = e.value
		if (e.name === "Trash" && e.at.join("/") === "home") return "trash"
		if (e.kids) return "folder"
		if (isPicture(v)) return "picture"
		if (v?.kind === "app" && typeof v.run === "string") return "app"
		// a program says what it needs, a loader what it provides (loader.c)
		if (e.provisions?.needs?.length || e.provisions?.provides?.length) return "program"
		if (v === null || v === undefined) return "folder"
		if (typeof v === "string") return "text"
		return "data"
	}
	const entry = (api: Api, at: string[], n: string, items: any[]): Entry => {
		// items: the list's, as children gives them; one with no node is still arriving. core's items do not say
		// whether a node is ephemeral (AFFORDANCES.md): e is false
		const e: any = { at, name: n, ids: items.map((x) => x.id), e: false, kids: 0, value: null }
		if (items.length && items.every((x) => !x.node)) return { ...e, kind: "pending" }
		try {
			// the first loaded member's first version that is not a status: its value, and when it changed (the change header's
			// time, for views.away: JS is given a change's time and node, no actor, so there is no signer)
			const v = (api.content(["/", ...at, n]) as any[]).find((i) => i.versions)?.versions?.find((
				x: any,
			) => !isStatus(x))
			e.value = v?.content ?? null
			e.commit = v?.change?.time !== undefined ? { lamport: v.change.time } : null
			e.kids = (api.children(["/", ...at, n]) as string[]).length
			const p = ((api as any).info(["/", ...at, n], "ermine.program.provisions") as any[]).find((
				i,
			) => i.versions)?.versions?.[0]?.content
			e.provisions = p && typeof p === "object" ? p : null
		} catch {
			return { ...e, kind: "refused" }
		}
		return { ...e, kind: kind(e) }
	}
	// a program by what it needs ("C program, 12 lines"), a loader by what it provides
	const program = (e: Entry) => {
		const needs = e.provisions?.needs ?? [], provides = e.provisions?.provides ?? []
		const lines = typeof e.value === "string" ? `, ${e.value.split("\n").length} lines` : ""
		if (provides.length) {
			return `loader of ${provides.join(", ")}${
				needs.length ? `, needs ${needs.join(", ")}` : ""
			}`
		}
		const what = ({
			c: "C program",
			javascript: "JavaScript program",
			wasm: "wasm program",
			builtin: "driver built in",
			exec: "Mac program",
		} as Record<string, string>)[needs[0]]
		return `${what ?? `program, needs ${needs.join(", ")}`}${lines}`
	}
	const describe = (e: Entry) => {
		const more = [e.ids.length > 1 ? `${e.ids.length} members` : null, e.e ? "ephemeral" : null]
			.filter((x) => x)
		const what = ({
			folder: `folder, ${e.kids} ${e.kids === 1 ? "item" : "items"}${
				e.kids && e.value !== null ? ", with a value" : ""
			}`,
			trash: e.kids ? `the Trash, ${e.kids} thrown away` : "the Trash, empty",
			text: `note, ${e.value?.length ?? 0} characters`,
			picture: `${e.value?.tile ? "pattern" : "picture"}, ${e.value?.rows?.[0]?.length ?? 0} × ${
				e.value?.rows?.length ?? 0
			}`,
			program: program(e),
			app: `application, runs ${e.value?.run}`,
			data: "data",
			pending: "arriving: it shows when it comes",
			refused: "refused",
		} as Record<string, string>)[e.kind]
		return [what, ...more].join(", ")
	}

	// --- pictures: each row's runs of one letter, a fill each
	const art = (f: any, v: any, x: number, y: number, scale: number, clip?: Rect) => {
		v.rows.forEach((row: string, j: number) => {
			let i = 0
			while (i < row.length) {
				let k = i
				while (k < row.length && row[k] === row[i]) k++
				const color = v.colors?.[row[i]]
				if (typeof color === "number") {
					blit.fill(f, x + i * scale, y + j * scale, (k - i) * scale, scale, color, clip)
				}
				i = k
			}
		})
	}
	// a pattern as a form, to tile: a letter not in its colors is the desk
	const pattern = (v: any, scale: number) => {
		const w = Math.max(...v.rows.map((r: string) => r.length)), h = v.rows.length
		const form = blit.form(w * scale, h * scale, C.desk)
		v.rows.forEach((row: string, j: number) =>
			[...row].forEach((ch, i) => {
				const color = v.colors?.[ch]
				if (typeof color === "number") {
					blit.fill(form, i * scale, j * scale, scale, scale, color)
				}
			})
		)
		return form
	}
	// a picture inside a box: a pattern fills it, a picture sits in its middle as big as fits
	const framed = (f: any, v: any, x: number, y: number, w: number, h: number) => {
		const clip = { x, y, w, h }
		if (v.tile) {
			return blit.tile(f, x, y, w, h, pattern(v, Math.max(1, Math.floor(w / 32))), "copy", clip)
		}
		const pw = Math.max(...v.rows.map((r: string) => r.length)), ph = v.rows.length
		const scale = Math.max(1, Math.floor(Math.min(w / pw, h / ph)))
		art(
			f,
			v,
			x + Math.floor((w - pw * scale) / 2),
			y + Math.floor((h - ph * scale) / 2),
			scale,
			clip,
		)
	}
	// the pixel icons, System 7's: 32 points square, two a pixel; on, darkened
	const pixel = (f: any, e: Entry, x: number, y: number, on: boolean) => {
		const u = style.u, S = 2 * u
		if (e.kind === "picture") {
			blit.fill(f, x + S, y + S, 14 * S, 14 * S, on ? dark(C.paper) : C.paper)
			framed(f, e.value, x + 2 * S, y + 2 * S, 12 * S, 12 * S)
			blit.frame(f, x + S, y + S, 14 * S, 14 * S, C.line)
			for (let i = 1; i < u; i++) {
				blit.frame(f, x + S + i, y + S + i, 14 * S - 2 * i, 14 * S - 2 * i, C.line)
			}
			if (on) blit.fill(f, x + S, y + 15 * S, 14 * S, S, C.line)
			return
		}
		// an application: its own icon, as a picture's, two points a pixel; none, a program's
		if (e.kind === "app" && isPicture(e.value.icon)) {
			const v = e.value.icon
			art(
				f,
				on
					? {
						...v,
						colors: Object.fromEntries(
							Object.entries(v.colors ?? {}).map(([k, c]) => [k, dark(c as number)]),
						),
					}
					: v,
				x,
				y,
				S,
			)
			return
		}
		const rows =
			ICONS[e.kind === "trash" && e.kids ? "full" : e.kind === "app" ? "program" : e.kind] ??
				ICONS.data
		const tint: Record<string, number> = {
			k: C.line,
			p: C.paper,
			y: C.lemon,
			c: C.cherry,
			d: C.dim,
		}
		art(
			f,
			{
				rows,
				colors: Object.fromEntries(
					Object.entries(tint).map(([k, c]) => [k, on && k !== "k" ? dark(c) : c]),
				),
			},
			x,
			y,
			S,
		)
		// a folder that holds a value too: a page in it
		if (e.kind === "folder" && e.value !== null && e.kids) {
			blit.fill(f, x + 9 * S, y + 6 * S, 5 * S, 6 * S, C.paper)
			blit.frame(f, x + 9 * S, y + 6 * S, 5 * S, 6 * S, C.line)
		}
	}

	// each icon's pixels, kept by what it is and its size
	const drawn = new Map<string, { w: number; h: number; bits: Uint32Array }>()
	const shapes = (e: Entry): [Shape[], number, number] => {
		if (e.kind === "folder") {
			const [back, front] = tinted([...e.at, e.name], C.icons?.folder)
			return [FOLDER(back, front), 64, 52]
		}
		if (e.kind === "trash") return [TRASH(!!e.kids, C.icons?.trash), 48, 60]
		if (e.kind === "pending") return [PAGE(null, true), 48, 60]
		if (e.kind === "program" || e.kind === "app") {
			const needs = e.provisions?.needs?.[0] ?? (e.kind === "app" ? "builtin" : "c")
			return [PAGE(BAND[needs] ?? BAND.builtin), 48, 60]
		}
		return [PAGE(BAND[e.kind] ?? BAND.data), 48, 60]
	}
	/** whether the theme's icons are catclock's vector ones ({style: "vector"}), else pixels */
	const vector = () => C.icons?.style === "vector"
	/** an icon's side, in points: catclock's big ones' (SIZE), or the pixel ones' 32 */
	const size = () => (vector() ? SIZE : 32)
	/** size() points square; on: vector, on a square of the soft highlight, as catclock's chosen tiles are; pixel,
	 *  darkened, as System 7's; clear, over clear pixels (the desk) */
	const icon = (f: any, e: Entry, x: number, y: number, on: boolean, clear = false) => {
		if (!vector()) return pixel(f, e, x, y, on)
		const u = style.u, N = SIZE * u, S = (SIZE / 16) * u
		if (on) {
			const pad = 4 * u, r = 8 * u, c = C.select ?? 0xffe8f2
			blit.fill(f, x - pad + r, y - pad, N + 2 * pad - 2 * r, N + 2 * pad, c)
			blit.fill(f, x - pad, y - pad + r, N + 2 * pad, N + 2 * pad - 2 * r, c)
			for (
				const [cx, cy] of [[x - pad + r, y - pad + r], [x + N + pad - r - 1, y - pad + r], [
					x - pad + r,
					y + N + pad - r - 1,
				], [x + N + pad - r - 1, y + N + pad - r - 1]]
			) {
				blit.fillellipse(f, cx, cy, r, r, c)
			}
		}
		if (e.kind === "picture") {
			blit.fill(f, x + S, y + S, 14 * S, 14 * S, C.paper)
			framed(f, e.value, x + 2 * S, y + 2 * S, 12 * S, 12 * S)
			for (let i = 0; i < u; i++) {
				blit.frame(f, x + S + i, y + S + i, 14 * S - 2 * i, 14 * S - 2 * i, C.line)
			}
			return
		}
		// an application: its own icon, as a picture's, two points a pixel; none, a program's page
		if (e.kind === "app" && isPicture(e.value.icon)) return art(f, e.value.icon, x, y, S)
		const [list, uw, uh] = shapes(e)
		// as big as fits the square, a point in from its edge, sitting on its foot
		const k = Math.min((N - 2 * u) / uw, (N - 2 * u) / uh),
			w = Math.ceil(uw * k),
			h = Math.ceil(uh * k)
		const key = `${e.kind} ${e.kids ? 1 : 0} ${e.provisions?.needs?.[0] ?? ""} ${
			e.kind === "folder" ? tinted([...e.at, e.name]).join() : ""
		} ${N} ${clear}`
		let made = drawn.get(key)
		if (!made) {
			made = { w, h, bits: raster(w, h, k, list, clear) }
			if (drawn.size > 64) drawn.clear()
			drawn.set(key, made)
		}
		blit.blit(
			f,
			x + Math.floor((N - w) / 2),
			y + N - u - h,
			{ w: made.w, h: made.h, bits: made.bits },
			0,
			0,
			made.w,
			made.h,
			clear ? "over" : "blend",
		)
		// a folder that holds a value too: a page in it
		if (e.kind === "folder" && e.value !== null && e.kids) {
			const px = x + 18 * u, py = y + 10 * u
			blit.fill(f, px, py, 10 * u, 12 * u, 0xffffff)
			blit.frame(f, px, py, 10 * u, 12 * u, ink(0xffffff, LINE, 0.24))
		}
	}

	// --- doing: started by the window manager's policy (/dev/wm/launch), so a window outlives what opened it
	// part: what the part running was given ({api, start, call}): start and call are the part's, not api's
	const start = (part: Part, folder: string, program: string, d?: any) => {
		const op = {
			address: ["/", "apps", folder],
			program: program.split("/").filter((x) => x),
			...(d ? { data: d } : {}),
		}
		const launch = val(part.api, ["/", "dev", "wm", "launch"])
		if (Array.isArray(launch)) return part.call(launch, [op])
		const { data, ...rest } = op as any
		const pid = part.start(rest)
		if (data !== undefined) put(part.api, pid, "data", data)
		return pid
	}
	const open = (part: Part, path: string[], e: Entry): string | null => {
		const api = part.api
		if (e.kind === "pending") return `${e.name} is still arriving`
		if (e.kind === "refused") return `${e.name}: refused`
		if (e.kind === "folder" || e.kind === "trash" || e.kind === "picture") {
			start(part, "computer", "programs/computer", { path })
		} // an application runs: its run, a command as /etc/keys has them, a Run the wm's policy runs
		else if (e.kind === "app") {
			const ctl = val(api, ["/", "dev", "wm", "ctl"])
			if (!Array.isArray(ctl)) return `${e.name}: no window manager to run it`
			part.call(ctl, [`run ${e.value.run}`])
		} // the key bindings open in Keys, their settings
		else if (path.join("/") === "etc/keys") start(part, "keys", "programs/keys")
		else start(part, "edit", "programs/edit", { path })
		return null
	}
	// a node from one name to another, the same node: its entry goes from one list to the other's end (core moves
	// any node, document or not). The names' order is no object of the graph: a node goes last in its new folder
	const move = (api: Api, e: Entry, to: string[], toname: string) => {
		const from = ["/", ...e.at]
		const at = idAt(api, from), into = idAt(api, to)
		if (!at || !into) return null
		const i = (api.children(from, e.name) as any[]).findIndex((x) => x.id === e.ids[0])
		return api.move(at, e.name, Math.max(0, i), into, toname)
	}
	// a node to a new name in the same folder, in the place its old name had (the list renamed: a name of one member;
	// a name of several, the first one moved)
	const rename = (api: Api, e: Entry, toname: string) => {
		const at = idAt(api, ["/", ...e.at])
		if (at && e.ids.length === 1) return api.rename(at, e.name, toname)
		return move(api, e, ["/", ...e.at], toname)
	}
	// a name not yet used in a folder: n, n 2, n 3 …
	const free = (api: Api, at: string[], n: string) => {
		const names = api.children(["/", ...at]) as string[]
		let k = n, i = 2
		while (names.includes(k)) k = `${n} ${i++}`
		return k
	}
	const link = (api: Api, e: Entry, to: string[], toname: string) =>
		api.insert(idAt(api, to)!, toname, e.ids[0])
	// the name a folder holds a node at, the first; none, null
	const holds = (api: Api, at: string[], id: string): string | null => {
		const names = api.children(["/", ...at]) as string[]
		return names.find((n) => (api.children(["/", ...at], n) as any[]).some((x) => x.id === id)) ??
			null
	}
	// not the Trash, and not into itself or a folder inside it; moved into the folder it is in, it stays as it is.
	// One the folder holds already (a link of it there): linked, nothing; moved, the name it came from goes, so it is
	// there once, at the name it has there
	const into = (api: Api, e: Entry, at: string[], linked = false) => {
		if (e.kind === "trash") throw new Error("the Trash stays where it is")
		if ([...e.at, e.name].every((n, i) => at[i] === n)) {
			throw new Error(`${e.name} can't go inside itself`)
		}
		if (!linked && e.at.join("/") === at.join("/")) return e.name
		const had = holds(api, at, e.ids[0])
		if (had !== null) {
			if (!linked) drop(api, ["/", ...e.at], e.name, e.ids[0])
			return had
		}
		const n = free(api, at, e.name)
		;(linked ? link : move)(api, e, ["/", ...at], n)
		return n
	}
	// a drop's items, each the folder it is in, its name there and the node's id, into the folder at: moved, or
	// linked; each item as it came with to, its name there, and already, the folder held it before; or error, why it
	// did not go
	const land = (api: Api, items: Item[], at: string[], linked = false) =>
		items.map((it) => {
			try {
				const there = api.children(["/", ...it.at], it.name) as any[]
				if (!there.some((x) => x.id === it.id)) throw new Error(`${it.name} is gone`)
				const e = { ...entry(api, it.at, it.name, there), ids: [it.id] }
				const already = holds(api, at, it.id) !== null
				return { ...it, to: into(api, e, at, linked), already }
			} catch (x) {
				return { ...it, error: (x as Error).message }
			}
		})
	return {
		kind,
		entry,
		describe,
		art,
		pattern,
		framed,
		icon,
		size,
		isPicture,
		open,
		start,
		move,
		rename,
		free,
		link,
		holds,
		into,
		land,
	}
}

// --- the layout

/** the folder's id: the first member at its path, "/" the root's */
export function folder(api: Api, path: string[]): string | null {
	if (!path.length) return "/"
	try {
		return (api.children(["/", ...path.slice(0, -1)], path[path.length - 1]) as any[])[0]?.id ??
			null
	} catch {
		return null
	}
}
export const layout = {
	/** a layout's address: an id is a name less its ermine:// (and any / in it) */
	at: (
		id: string,
	) => [
		"/",
		"apps",
		"computer",
		"layout",
		id === "/" ? "root" : id.replace(/^ermine:\/\//, "").replaceAll("/", "∕"),
	],
	/** made the first time: /apps/computer/layout, a folder */
	ready(api: Api) {
		makeAt(api, ["/", "apps", "computer"], "layout", null)
	},
	/** one icon's spot (points) in a folder's layout, its desk's or its icons: a drop from elsewhere, written once */
	put(api: Api, folder: string, part: "desk" | "icons", id: string, at: Spot) {
		layout.ready(api)
		const address = layout.at(folder), was = val(api, address) as any
		if (was?.[part] && typeof was[part] === "object") {
			api.write(address, [{ path: [part, id], value: at }])
		} else if (was) api.write(address, [{ path: [part], value: { [id]: at } }])
		else makeAt(api, address.slice(0, -1), address[address.length - 1], { [part]: { [id]: at } })
	},
}

/** what a drag let go at x, y on the screen is over: the front window there, or the desk: its layer's name, and its
 * owner's on/drop if it takes drops (a My Computer's window, the desk), else null. Nothing there: null */
export function dropped(
	api: Api,
	x: number,
	y: number,
): { layer: string; drop: string[] | null } | null {
	const WINDOWS = ["/", "dev", "display", "windows"]
	let best: any = null
	for (const n of api.children(WINDOWS) as string[]) {
		const l = val(api, [...WINDOWS, n]) as any
		if (!l || l.hidden || !l.w || (l.title == null && n !== "desk")) continue
		const f = l.parts?.frame ?? { x: 0, y: 0, w: l.w, h: l.h }
		if (x < l.x + f.x || x >= l.x + f.x + f.w || y < l.y + f.y || y >= l.y + f.y + f.h) continue
		if (!best || (l.z ?? 0) > (best.z ?? 0)) best = { ...l, name: n }
	}
	if (!best) return null
	const o = best.owner, drop = Array.isArray(o) ? [...o, "on", "drop"] : null
	return { layer: best.name, drop: drop && idAt(api, drop) ? drop : null }
}

const overlaps = (a: Spot, b: Spot, cell: { w: number; h: number }) =>
	Math.abs(a[0] - b[0]) < cell.w && Math.abs(a[1] - b[1]) < cell.h

/** each entry's key in a layout, as e.key: its id, and a node there twice (a link beside it) its id#name after the first */
export function keyed<E extends { ids: string[]; name: string; key?: string }>(entries: E[]) {
	const seen = new Set<string>()
	for (const e of entries) {
		const id = e.ids[0]
		e.key = seen.has(id) ? `${id}#${e.name}` : id
		seen.add(id)
	}
	return entries
}

/** each id's spot: saved, else slot(i)'s first that no other is on (slot may give null: none further) */
export function spots(
	ids: string[],
	saved: Record<string, Spot>,
	slot: (i: number) => Spot | null,
	cell: { w: number; h: number },
) {
	const out = new Map<string, Spot>(), taken: Spot[] = []
	for (const id of ids) if (saved[id]) taken.push(saved[id]), out.set(id, saved[id])
	let i = 0
	for (const id of ids) {
		if (out.has(id)) continue
		let at: Spot | null = null
		for (;; i++) {
			const s = slot(i)
			// no slot left: on the last, over another
			if (!s) {
				at = slot(Math.max(0, i - 1)) ?? [0, 0]
				break
			}
			if (!taken.some((t) => overlaps(t, s, cell))) {
				at = s
				break
			}
		}
		taken.push(at)
		out.set(id, at)
	}
	return out
}

/** cleaned up: each, top first, to the nearest slot no other has taken */
export function clean(
	spots: Map<string, Spot>,
	slot: (i: number) => Spot | null,
	cell: { w: number; h: number },
) {
	const slots: Spot[] = []
	for (let i = 0; slots.length < spots.size * 4 + 16; i++) {
		const s = slot(i)
		if (!s) break
		slots.push(s)
	}
	const used = new Set<number>(), out = new Map<string, Spot>()
	const order = [...spots].sort(([, a], [, b]) => a[1] - b[1] || a[0] - b[0])
	for (const [id, [x, y]] of order) {
		let best = -1, d = Infinity
		slots.forEach(([sx, sy], k) => {
			const dk = Math.hypot((sx - x) / cell.w, (sy - y) / cell.h)
			if (!used.has(k) && dk < d) [best, d] = [k, dk]
		})
		if (best < 0) out.set(id, [x, y])
		else {
			used.add(best)
			out.set(id, slots[best])
		}
	}
	return out
}

/** the spot an arrow goes to from one: ahead of it that way, the nearest, across counting twice */
export function nearest(
	spots: Map<string, Spot>,
	from: string | null,
	dx: number,
	dy: number,
): string | null {
	const all = [...spots]
	if (!all.length) return null
	const at = from !== null ? spots.get(from) : undefined
	if (!at) return [...all].sort(([, a], [, b]) => a[1] - b[1] || a[0] - b[0])[0][0]
	let best: string | null = null, d = Infinity
	for (const [id, [x, y]] of all) {
		if (id === from) continue
		const along = (x - at[0]) * dx + (y - at[1]) * dy,
			across = Math.abs((x - at[0]) * dy) + Math.abs((y - at[1]) * dx)
		if (along <= 0) continue
		const dk = along + 2 * across
		if (dk < d) [best, d] = [id, dk]
	}
	return best ?? from
}
