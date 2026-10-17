// /programs/paint: a picture editor, MacPaint's FatBits with Aseprite's keys. given {path} as data,
// as the editor is. a picture: {kind: "picture", colors: {letter: 0xRRGGBB}, rows: [...], tile?,
// hot?, layers?} (computer.js). top: tool options, grid, mirror, zoom; left: tools, the colours
// in front and behind; right: the picture at size, colours, layers, history; bottom: status.
//
// tools: p pencil (pixel-perfect), b brush, e eraser ([ ] size, square or round), g fill (4-way or
// every pixel of a colour), l line, u rectangle, o ellipse (shift square, option from the middle),
// i dropper, m marquee, q lasso, h hand (or space), t hot spot (a cursor's). shift-click: a line
// from the last point; option-click picks a colour; the right button paints the back colour; x
// swaps, d black and clear. a selection drags (option copies), arrows nudge it, painting stays
// inside it.
//
// layers: saved flattened into rows (what other readers read), layers kept beside it (open); one
// layer saves as before. cmd-s writes as you through protect, saying if refused; a saved cursor is
// live at once (/apps/cursor follows /etc/cursors/*). the node changed while painting: it says so;
// untouched, it follows.
// drafts: /apps/paint/drafts/<the path's names joined by ":">: layers, base change, undo and redo,
// written each stroke; saved, the draft goes. view state: <its node>/view.
// the fat picture is drawn into a /dev/vram plane under the layer's ops; a stroke, a pan or the
// pointer draws only the changed rectangle. the rest are ops, written when they change.
import {
	data,
	drop,
	effect,
	handler,
	idAt,
	isStatus,
	key,
	make,
	snap,
	val,
	whole,
} from "ermine:kit"
import { after, here, plane } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, self, onCleanup } = given
	// the part running now: what the plane and the timers are reached through, as a setup's api stops when it returns
	// and each handler and effect has its own; each of them says which it is as it starts (using)
	let part = given
	const using = (g, f) => {
		const was = part
		part = g
		try {
			return f()
		} finally {
			part = was
		}
	}
	// this process's own node: a window's owner, whose on/key, on/pointer and on/hover the window manager calls; its
	// place, where its drafts are kept
	const me = here(self), place = me.slice(0, -1)
	const blit = blitter(api)
	// labels in /dev/font/text, buttons in /dev/font/title, as System 7's are in Chicago; the font ROM until they come
	let F, FT
	const fonts = (api) => {
		const at = (role) => {
			const v = val(api, ["/", "dev", "font", role])
			return v ? font(v) : undefined
		}
		F = at("text")
		FT = at("title")
		return `${F ? String(F) : "rom"} ${FT ? String(FT) : "rom"}`
	}
	fonts(api)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(1040 * u, mode.w - 60 * u), H = Math.min(720 * u, mode.h - 80 * u)
	// data {path}, or a binding's words, {args: ["etc/cursors/arrow"]}
	const boot = data(given)
	const path = boot?.path ??
		(typeof boot?.args?.[0] === "string" ? boot.args[0].split("/").filter((n) => n) : null) ??
		["home", "Pictures", "untitled picture"]
	const NODE = ["/", ...path]
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `paint-${self}`]
	// the look, from /etc/theme: paper, a platinum bar, black lines, lemon for what is in hand, cherry for what is wrong
	const C = {}
	const colours = (T = {}) =>
		Object.assign(C, {
			paper: T.paper ?? 0xfdf8ea,
			chrome: T.chrome ?? 0xece5d4,
			hi: T.hi ?? 0xfffdf6,
			lo: T.lo ?? 0xb9ae98,
			line: T.line ?? 0x1c1a17,
			ink: T.ink ?? 0x2a2228,
			dim: T.ink3 ?? 0xa89aa2,
			lemon: T.select ?? T.lemon ?? 0xffff88,
			cherry: T.cherry ?? 0xd2244a,
			rose: T.rose ?? 0xe2457c,
			ok: T.mint ?? 0x18936b,
			desk: T.desk ?? 0xf3ead2,
			check: T.check ?? 0xe6dcc4,
		})
	colours(val(api, ["/", "etc", "theme"]))

	// --- the picture, as it is being painted

	const isRows = (r) => Array.isArray(r) && r.every((x) => typeof x === "string")
	const isPicture = (v) => v?.kind === "picture" && isRows(v.rows)
	const BLANK = {
		kind: "picture",
		colors: { k: 0x1c1a17 },
		rows: Array.from({ length: 16 }, () => ".".repeat(16)),
	}
	const MAX = 512
	const load = (api) => {
		const item = api.content(NODE).find((i) => i.versions)?.versions.find((v) => !isStatus(v))
		const v = isPicture(item?.content) ? item.content : BLANK
		return {
			value: v,
			time: item?.change?.time ?? null,
			missing: !item,
			wrong: !!item && !isPicture(item.content),
		}
	}
	// the letters a colour may have, in the palette's order: a colour's place is its letter's
	const LETTERS = [
		..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
		...Array.from({ length: 0x180 - 0xc0 }, (_, i) => String.fromCharCode(0xc0 + i)).filter((
			ch,
		) => ch !== "×" && ch !== "÷"),
		...Array.from({ length: 0x100 }, (_, i) => String.fromCharCode(0x400 + i)),
	]
	const RANK = new Map(LETTERS.map((ch, i) => [ch, i]))
	const rank = (ch) => RANK.get(ch) ?? 1e6 + ch.charCodeAt(0)
	const order = (colors = s.colors) => Object.keys(colors).sort((a, b) => rank(a) - rank(b))
	// a letter for clear: the one the picture uses most, else the first free of these
	const clearOf = (colors, rows) => {
		const n = {}
		for (const row of rows) {
			for (const ch of row) if (typeof colors[ch] !== "number") n[ch] = (n[ch] ?? 0) + 1
		}
		return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ??
			[..."._ -~"].find((ch) => !(ch in colors))
	}
	// the picture: its layers, bottom first, each {id, name, hidden, rows}; rows, them flattened, as the plane
	// shows them; the layer painted on; and the floating selection (fl, below), stamped into its layer
	const s = {
		base: null,
		colors: {},
		layers: [],
		cur: 0,
		rows: [],
		hot: null,
		clear: ".",
		modified: false,
		undo: [],
		redo: [],
		tool: "pencil",
		prev: "pencil",
		fore: null,
		back: null,
		size: 1,
		shape: "square",
		filled: false,
		contiguous: true,
		perfect: true,
		mx: false,
		my: false,
		grid: true,
		zoom: null,
		center: null,
		sel: null,
		recent: [],
		dialog: null,
		note: null,
		click: { key: null, t: 0 },
		drop: null,
		from: null,
	}
	// the floating selection (below); the rectangle of the picture changed since it was drawn; whether the plane
	// is to be drawn whole; what the pointer is doing; rectangles of the room to draw again as they are now
	let fl = null, changed = null, everything = true, gesture = null, marks = []
	const full = () => (everything = true)
	// the rectangle of the picture changed, [x0, y0, x1, y1], grown
	const touch = (x0, y0, x1, y1) => {
		changed = changed
			? [
				Math.min(changed[0], x0),
				Math.min(changed[1], y0),
				Math.max(changed[2], x1),
				Math.max(changed[3], y1),
			]
			: [x0, y0, x1, y1]
	}
	const pw = () => s.layers[0]?.rows[0]?.length ?? 0
	const ph = () => s.layers[0]?.rows.length ?? 0
	const layer = () => s.layers[s.cur]
	const paints = (ch) => (typeof s.colors[ch] === "number" ? ch : s.clear)
	// a pixel of the picture as shown: the top layer shown that has a colour there
	const mixAt = (x, y) => {
		for (let l = s.layers.length - 1; l >= 0; l--) {
			const L = s.layers[l]
			if (L.hidden) continue
			const ch = L.rows[y][x]
			if (typeof s.colors[ch] === "number") return ch
		}
		return s.clear
	}
	const flatten = () => {
		const shown = s.layers.filter((l) => !l.hidden), w = pw()
		if (shown.length === 1) s.rows = shown[0].rows.slice()
		else if (!shown.length) s.rows = s.layers[0].rows.map(() => s.clear.repeat(w))
		else {s.rows = s.layers[0].rows.map((_, y) =>
				Array.from({ length: w }, (_, x) => mixAt(x, y)).join("")
			)}
	}
	// row y, x0 to x1, shown again after its layer changed
	const remix = (y, x0, x1) => {
		if (s.layers.length === 1) {
			return void (s.rows[y] = s.layers[0].hidden ? s.clear.repeat(pw()) : s.layers[0].rows[y])
		}
		let t = ""
		for (let x = x0; x < x1; x++) t += mixAt(x, y)
		s.rows[y] = s.rows[y].slice(0, x0) + t + s.rows[y].slice(x1)
	}
	// two lists of rows that show the same: every clear letter one
	const alike = (a, b) =>
		a.length === b.length &&
		a.every((r, j) =>
			r.length === b[j].length && [...r].every((ch, i) => paints(ch) === paints(b[j][i]))
		)
	// the colours in hand still the picture's
	const hands = () => {
		if (s.fore !== s.clear && !(s.fore in s.colors)) s.fore = order()[0] ?? s.clear
		if (s.back !== s.clear && !(s.back in s.colors)) s.back = s.clear
		s.recent = s.recent.filter((ch) => ch in s.colors)
	}
	// a picture taken up: drawn again whole, or (the same size, colours and hot spot) only its rows that changed
	const adopt = (colors, hot, layers, cur) => {
		const was = { rows: s.rows, w: pw(), h: ph(), key: JSON.stringify([s.colors, s.hot]) }
		s.colors = colors
		s.hot = hot
		s.layers = layers
		s.cur = Math.max(0, Math.min(cur, layers.length - 1))
		flatten()
		hands()
		if (s.tool === "hot" && !s.hot) s.tool = "pencil"
		if (was.w !== pw() || was.h !== ph() || was.key !== JSON.stringify([s.colors, s.hot])) {
			return full()
		}
		s.rows.forEach((r, y) => r !== was.rows[y] && touch(0, y, pw(), y + 1))
	}
	const take = (b) => {
		const v = b.value
		s.base = b
		const colors = Object.fromEntries(
			Object.entries(v.colors ?? {}).filter(([, c]) => typeof c === "number"),
		)
		s.clear = clearOf(colors, v.rows)
		const w = Math.max(1, ...v.rows.map((r) => r.length)), h = Math.max(1, v.rows.length)
		const pad = (rows) =>
			Array.from({ length: h }, (_, j) => String(rows[j] ?? "").slice(0, w).padEnd(w, s.clear))
		s.colors = colors
		let layers = [{ id: 1, name: "Layer 1", hidden: false, rows: pad(v.rows) }]
		if (
			Array.isArray(v.layers) && v.layers.length > 1 && v.layers.every((l) => isRows(l?.rows))
		) {
			const ls = v.layers.map((l, i) => ({
				id: i + 1,
				name: String(l.name ?? `Layer ${i + 1}`),
				hidden: !!l.hidden,
				rows: pad(l.rows),
			}))
			s.layers = ls
			flatten()
			if (alike(s.rows, layers[0].rows)) layers = ls
			else s.note = ["its rows were changed without its layers: shown as one layer", C.cherry]
		}
		adopt(colors, Array.isArray(v.hot) ? [...v.hot] : null, layers, layers.length - 1)
	}
	take(load(api))
	if (!s.note) {
		s.note = s.base.wrong
			? ["this node is not a picture: cmd-s puts a blank one over it", C.cherry]
			: s.base.missing
			? ["nothing is here yet: cmd-s makes it", C.dim]
			: null
	}
	s.fore = order()[0] ?? s.clear
	s.back = s.clear

	// --- undo: each change, newest last, as what takes it back: {label, w, h, colors, hot, cur, layers}, each
	// layer {id, name, hidden} and either its rows whole or a patch, [[j, row]], to the layer of that id now

	const snapshot = () => ({
		w: pw(),
		h: ph(),
		colors: { ...s.colors },
		hot: s.hot && [...s.hot],
		cur: s.cur,
		layers: s.layers.map((l) => ({
			id: l.id,
			name: l.name,
			hidden: l.hidden,
			rows: l.rows.slice(),
		})),
	})
	// what makes a out of b, and whether they differ
	const diff = (a, b) => {
		let changed = a.w !== b.w || a.h !== b.h || a.cur !== b.cur ||
			a.layers.length !== b.layers.length ||
			JSON.stringify([a.colors, a.hot]) !== JSON.stringify([b.colors, b.hot])
		const layers = a.layers.map((L, i) => {
			const B = b.layers.find((x) => x.id === L.id)
			if (!B || B.rows.length !== L.rows.length || B.rows[0]?.length !== L.rows[0]?.length) {
				changed = true
				return { id: L.id, name: L.name, hidden: L.hidden, rows: L.rows }
			}
			if (b.layers[i] !== B || B.name !== L.name || B.hidden !== L.hidden) changed = true
			const patch = []
			for (let j = 0; j < L.rows.length; j++) {
				if (L.rows[j] !== B.rows[j]) patch.push([j, L.rows[j]])
			}
			if (patch.length) changed = true
			return { id: L.id, name: L.name, hidden: L.hidden, patch }
		})
		return {
			changed,
			entry: { w: a.w, h: a.h, colors: a.colors, hot: a.hot, cur: a.cur, layers },
		}
	}
	const apply = (e, b) => ({
		w: e.w,
		h: e.h,
		colors: { ...e.colors },
		hot: e.hot ? [...e.hot] : null,
		cur: e.cur,
		layers: e.layers.map((L) => {
			if (L.rows) return { id: L.id, name: L.name, hidden: !!L.hidden, rows: L.rows.slice() }
			const rows = b.layers.find((x) => x.id === L.id).rows.slice()
			for (const [j, r] of L.patch) rows[j] = r
			return { id: L.id, name: L.name, hidden: !!L.hidden, rows }
		}),
	})
	// the picture before the change being made, until it is made: then it is an undo; and where undo was when it was saved
	let pending = null, saved = { n: 0, top: undefined }
	const remember = (label) => {
		done()
		pending = { label, was: snapshot() }
	}
	const done = () => {
		if (!pending || fl) return
		const { label, was } = pending
		pending = null
		const d = diff(was, snapshot())
		if (!d.changed) return
		s.undo.push({ label, ...d.entry })
		s.redo = []
		s.modified = true
	}
	const back = (from, to) => {
		putdown()
		done()
		const e = from.pop()
		if (!e) return null
		const now = snapshot(), was = apply(e, now)
		to.push({ label: e.label, ...diff(now, was).entry })
		adopt(was.colors, was.hot, was.layers, was.cur)
		if (s.sel && (s.sel.x >= pw() || s.sel.y >= ph())) s.sel = null
		// back to what was saved: nothing to save
		s.modified = !(saved && s.undo.length === saved.n && s.undo.at(-1) === saved.top)
		return e.label
	}

	// --- the draft, a document beside this process, by the path it paints; and the view, inside this process

	const DRAFT = [...place, "drafts", path.join(":")]
	const VIEW = [...me, "view"]
	const draft = val(api, DRAFT)
	if (Array.isArray(draft?.layers) || isRows(draft?.rows)) {
		const colors = draft.colors ?? {}
		const raw = Array.isArray(draft.layers)
			? draft.layers
			: [{ id: 1, name: "Layer 1", rows: draft.rows }]
		const layers = raw.filter((l) => isRows(l?.rows)).map((l, i) => ({
			id: l.id ?? i + 1,
			name: String(l.name ?? `Layer ${i + 1}`),
			hidden: !!l.hidden,
			rows: l.rows.slice(),
		}))
		if (layers.length) {
			s.clear = clearOf(colors, layers[0].rows)
			adopt(
				colors,
				Array.isArray(draft.hot) ? draft.hot : null,
				layers,
				draft.cur ?? layers.length - 1,
			)
			s.base = { ...load(api), time: draft.base ?? null }
			s.modified = true
			// an older draft's undo was another shape
			s.undo = Array.isArray(draft.layers) && Array.isArray(draft.undo) ? draft.undo : []
			s.redo = Array.isArray(draft.redo) ? draft.redo : []
			saved = null
			s.note = [`not saved since t=${draft.base}: kept as it was`, C.cherry]
		}
	}
	const view = val(api, VIEW)
	if (view) {
		for (
			const k of [
				"tool",
				"prev",
				"fore",
				"back",
				"size",
				"shape",
				"filled",
				"contiguous",
				"perfect",
				"mx",
				"my",
				"grid",
				"zoom",
				"center",
				"sel",
				"recent",
				"dialog",
				"note",
				"click",
			]
		) if (k in view) s[k] = view[k]
	}
	if (!draft && Array.isArray(view?.undo)) [s.undo, s.redo] = [view.undo, view.redo ?? []]
	hands()
	// the patches from one draft to the next: rows spliced where they changed, the undo and redo lists where
	// their entries (never changed once made) differ, anything else set
	const patched = (was, now) => {
		const out = []
		for (const k of ["path", "base", "colors", "hot", "cur"]) {
			if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) {
				out.push({ path: [k], value: now[k] ?? null })
			}
		}
		const splice = (at, a, b) => {
			let p = 0, q = 0
			while (p < a.length && p < b.length && a[p] === b[p]) p++
			while (
				q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]
			) q++
			if (p < a.length - q || p < b.length - q) {
				out.push({ path: at, range: [p, a.length - q], value: b.slice(p, b.length - q) })
			}
		}
		const same = was.layers.length === now.layers.length &&
			was.layers.every((l, i) =>
				l.id === now.layers[i].id && l.name === now.layers[i].name &&
				l.hidden === now.layers[i].hidden && l.rows.length === now.layers[i].rows.length
			)
		if (!same) out.push({ path: ["layers"], value: now.layers })
		else now.layers.forEach((l, i) => splice(["layers", i, "rows"], was.layers[i].rows, l.rows))
		splice(["undo"], was.undo, now.undo)
		splice(["redo"], was.redo, now.redo)
		return out
	}
	const copy = (d) => ({
		...d,
		colors: { ...d.colors },
		layers: d.layers.map((l) => ({ ...l, rows: l.rows.slice() })),
		undo: d.undo.slice(),
		redo: d.redo.slice(),
	})
	let drafted = Array.isArray(draft?.layers) ? copy({ undo: [], redo: [], ...draft }) : null,
		viewed = view ?? null
	// what changed, written, once a stroke has ended: the draft while anything is not saved, and gone once it
	// is saved; the view as it changes
	const keep = (api) => {
		if (gesture) return
		done()
		const now = {
			path,
			base: s.base.time ?? null,
			colors: s.colors,
			hot: s.hot,
			cur: s.cur,
			layers: s.layers.map((l) => ({ id: l.id, name: l.name, hidden: l.hidden, rows: l.rows })),
			undo: s.undo,
			redo: s.redo,
		}
		try {
			if (s.modified) {
				if (drafted && idAt(api, DRAFT)) {
					const patches = patched(drafted, now)
					if (patches.length) api.write(DRAFT, patches)
				} else {
					make(api, place, "drafts", null)
					snap(api, DRAFT, now)
				}
				drafted = copy(now)
			} else if (drafted || idAt(api, DRAFT)) {
				const folder = DRAFT.slice(0, -1)
				for (let n = api.children(folder, DRAFT.at(-1)).length; n > 0; n--) {
					drop(api, folder, DRAFT.at(-1))
				}
				drafted = null
			}
		} catch (e) {
			s.note = [`the draft is not kept: ${e.code ?? e.message}`, C.cherry]
		}
		const shown = {
			tool: s.tool,
			prev: s.prev,
			fore: s.fore,
			back: s.back,
			size: s.size,
			shape: s.shape,
			filled: s.filled,
			contiguous: s.contiguous,
			perfect: s.perfect,
			mx: s.mx,
			my: s.my,
			grid: s.grid,
			zoom: s.zoom,
			center: s.center,
			sel: s.sel,
			recent: s.recent,
			dialog: s.dialog,
			note: s.note,
			click: s.click,
			...(s.modified ? {} : { undo: s.undo, redo: s.redo }),
		}
		const patches = []
		for (const k of new Set([...Object.keys(viewed ?? {}), ...Object.keys(shown)])) {
			if (JSON.stringify(viewed?.[k]) === JSON.stringify(shown[k])) continue
			patches.push(k in shown ? { path: [k], value: shown[k] ?? null } : { path: [k] })
		}
		if (!viewed) make(api, me, "view", shown, { ephemeral: true })
		else if (patches.length) api.write(VIEW, patches)
		viewed = JSON.parse(JSON.stringify(shown))
	}

	// --- painting: everything goes through put, into the layer painted on, inside the selection

	const within = (x, y) => {
		const z = s.sel
		if (!z) return true
		if (x < z.x || y < z.y || x >= z.x + z.w || y >= z.y + z.h) return false
		return !z.mask || z.mask[y - z.y][x - z.x] === "#"
	}
	const put = (x, y, ch) => {
		if (x < 0 || y < 0 || x >= pw() || y >= ph() || !within(x, y)) return
		const L = layer(), row = L.rows[y]
		if (row[x] === ch) return
		L.rows[y] = row.slice(0, x) + ch + row.slice(x + 1)
		remix(y, x, x + 1)
		s.modified = true
		touch(x, y, x + 1, y + 1)
	}
	// a whole row of a layer written at once: shown again from its first change to its last
	const row = (L, y, text) => {
		const was = L.rows[y]
		if (was === text) return
		let a = 0, b = text.length
		while (a < b && was[a] === text[a]) a++
		while (b > a && was[b - 1] === text[b - 1]) b--
		L.rows[y] = text
		s.modified = true
		if (s.layers.includes(L)) {
			remix(y, a, b)
			touch(a, y, b, y + 1)
		}
	}
	// a pixel and its mirrors
	const mirrors = (x, y) => {
		const out = [[x, y]]
		if (s.mx) out.push([pw() - 1 - x, y])
		if (s.my) out.push([x, ph() - 1 - y])
		if (s.mx && s.my) out.push([pw() - 1 - x, ph() - 1 - y])
		return out
	}
	const plot = (x, y, ch) => {
		for (const [i, j] of mirrors(x, y)) put(i, j, ch)
	}
	// the brush: its pixels about a point, square or round
	const tip = (size, shape) => {
		const lo = -Math.floor((size - 1) / 2),
			c = (size - 1) / 2,
			r2 = (size / 2) ** 2 - 0.25,
			out = []
		for (let j = 0; j < size; j++) {
			for (let i = 0; i < size; i++) {
				if (shape === "square" || size < 3 || (i - c) ** 2 + (j - c) ** 2 < r2) {
					out.push([lo + i, lo + j])
				}
			}
		}
		return out
	}
	const reach =
		() => (["brush", "eraser", "line", "rect", "ellipse"].includes(s.tool) ? s.size : 1)
	const stamp = (x, y, ch, size = 1) => {
		if (size === 1) return plot(x, y, ch)
		for (const [dx, dy] of tip(size, s.shape)) plot(x + dx, y + dy, ch)
	}
	// the pixels of a line from one to the other, so a fast stroke leaves no gaps
	const bresenham = (x0, y0, x1, y1, f) => {
		const dx = Math.abs(x1 - x0),
			dy = -Math.abs(y1 - y0),
			sx = x0 < x1 ? 1 : -1,
			sy = y0 < y1 ? 1 : -1
		let e = dx + dy
		for (;;) {
			f(x0, y0)
			if (x0 === x1 && y0 === y1) return
			const e2 = 2 * e
			if (e2 >= dy) (e += dy), (x0 += sx)
			if (e2 <= dx) (e += dx), (y0 += sy)
		}
	}
	// an ellipse in a rectangle, Alois Zingl's, its pixels given to f
	const oval = (x0, y0, x1, y1, f) => {
		let a = Math.abs(x1 - x0), b = Math.abs(y1 - y0), b1 = b & 1
		let dx = 4 * (1 - a) * b * b, dy = 4 * (b1 + 1) * a * a, err = dx + dy + b1 * a * a
		if (x0 > x1) (x0 = x1), (x1 += a)
		if (y0 > y1) y0 = y1
		y0 += (b + 1) >> 1
		y1 = y0 - b1
		a = 8 * a * a
		b1 = 8 * b * b
		do {
			f(x1, y0), f(x0, y0), f(x0, y1), f(x1, y1)
			const e2 = 2 * err
			if (e2 <= dy) (y0++, y1--, (err += dy += a))
			if (e2 >= dx || 2 * err > dy) (x0++, x1--, (err += dx += b1))
		} while (x0 <= x1)
		while (y0 - y1 < b) f(x0 - 1, y0), f(x1 + 1, y0++), f(x0 - 1, y1), f(x1 + 1, y1--)
	}
	// a shape from one corner to the other: shift makes it square (a line, straight or diagonal), option draws it from the middle
	const corners = (g, mods) => {
		let [x0, y0] = g.from, [x1, y1] = g.to
		let dx = x1 - x0, dy = y1 - y0
		if (mods.includes("shift")) {
			if (g.tool === "line") {
				if (Math.abs(dx) > 2 * Math.abs(dy)) dy = 0
				else if (Math.abs(dy) > 2 * Math.abs(dx)) dx = 0
				else {dx = Math.sign(dx) * Math.max(Math.abs(dx), Math.abs(dy)),
						dy = Math.sign(dy) * Math.abs(dx)}
			} else {
				const n = Math.max(Math.abs(dx), Math.abs(dy))
				dx = (Math.sign(dx) || 1) * n
				dy = (Math.sign(dy) || 1) * n
			}
		}
		if (mods.includes("alt") && g.tool !== "line") return [x0 - dx, y0 - dy, x0 + dx, y0 + dy]
		return [x0, y0, x0 + dx, y0 + dy]
	}
	const shape = (g, mods) => {
		const [x0, y0, x1, y1] = corners(g, mods), ch = g.ch, n = s.size
		g.shown = [x0, y0, x1, y1]
		if (g.tool === "line") return bresenham(x0, y0, x1, y1, (x, y) => stamp(x, y, ch, n))
		const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1)
		if (g.tool === "rect") {
			for (let y = t; y <= b; y++) {
				for (
					let x = l;
					x <= r;
					x++
				) if (s.filled || x < l + n || x > r - n || y < t + n || y > b - n) plot(x, y, ch)
			}
			return
		}
		if (s.filled) {
			const span = new Map()
			oval(l, t, r, b, (x, y) => {
				const v = span.get(y)
				span.set(y, v ? [Math.min(v[0], x), Math.max(v[1], x)] : [x, x])
			})
			for (const [y, [a, z]] of span) for (let x = a; x <= z; x++) plot(x, y, ch)
		} else oval(l, t, r, b, (x, y) => stamp(x, y, ch, n))
	}
	// a shape drawn again as the pointer moves: its layer as it was, then the shape where it is now
	const reshape = (g, mods) => {
		const L = layer()
		if (g.span) {
			for (let y = Math.max(0, g.span[1]); y < Math.min(ph(), g.span[3]); y++) {
				row(L, y, g.base[y])
			}
		}
		const was = changed
		changed = null
		shape(g, mods)
		g.span = changed ?? null
		if (was) touch(...was)
	}
	// the region of one colour (every clear letter one colour) painted another: four-way, or every pixel of it
	const fill = (x, y, ch) => {
		const L = layer(), w = pw(), h = ph()
		if (x < 0 || y < 0 || x >= w || y >= h || !within(x, y)) return
		const from = paints(L.rows[y][x])
		if (from === paints(ch)) return
		const hit = new Uint8Array(w * h)
		const is = (i, j) => paints(L.rows[j][i]) === from && within(i, j)
		if (s.contiguous) {
			const todo = [x, y]
			while (todo.length) {
				const j = todo.pop(), i = todo.pop()
				if (i < 0 || j < 0 || i >= w || j >= h || hit[j * w + i] || !is(i, j)) continue
				hit[j * w + i] = 1
				todo.push(i + 1, j, i - 1, j, i, j + 1, i, j - 1)
			}
		} else {for (let j = 0; j < h; j++) {
				for (let i = 0; i < w; i++) if (is(i, j)) hit[j * w + i] = 1
			}}
		for (let j = 0; j < h; j++) {
			let t = null
			for (let i = 0; i < w; i++) {
				if (!hit[j * w + i]) continue
				t ??= L.rows[j].split("")
				t[i] = ch
			}
			if (t) row(L, j, t.join(""))
		}
	}
	// pixel-perfect: a stroke's corner, a pixel beside both its neighbours, taken back as it was
	const pencil = (g, x, y) => {
		const n = g.pts.length, last = g.pts[n - 1]
		if (last && last[0] === x && last[1] === y) return
		if (s.perfect && n >= 2) {
			const a = g.pts[n - 2], b = last
			if (
				Math.abs(a[0] - x) === 1 && Math.abs(a[1] - y) === 1 &&
				(b[0] === a[0] || b[1] === a[1]) && (b[0] === x || b[1] === y)
			) {
				for (const [i, j] of mirrors(b[0], b[1])) {
					if (g.base[j]?.[i] !== undefined) put(i, j, g.base[j][i])
				}
				g.pts.pop()
			}
		}
		g.pts.push([x, y])
		plot(x, y, g.ch)
	}
	// a letter for a new colour: one neither in colors nor in any row, so no clear pixel takes it; after the last, so it is last
	const fresh = () => {
		const used = new Set(Object.keys(s.colors))
		for (const l of s.layers) for (const r of l.rows) for (const ch of r) used.add(ch)
		const top = Math.max(-1, ...order().map((ch) => RANK.get(ch) ?? -1))
		return LETTERS.slice(top + 1).find((ch) => !used.has(ch)) ??
			LETTERS.find((ch) => !used.has(ch)) ?? null
	}
	const hex = (c) => c.toString(16).padStart(6, "0")
	const parse = (text) => {
		const t = text.trim().replace(/^(#|0x)/i, "")
		if (/^[0-9a-f]{3}$/i.test(t)) return parseInt([...t].map((d) => d + d).join(""), 16)
		return /^[0-9a-f]{6}$/i.test(t) ? parseInt(t, 16) : null
	}
	// every layer's letters changed by a map, as a colour moves or goes
	const relabel = (map) => {
		for (const L of s.layers) {
			for (let y = 0; y < L.rows.length; y++) {
				const r = L.rows[y]
				let t = ""
				for (const ch of r) t += map[ch] ?? ch
				if (t !== r) L.rows[y] = t
			}
		}
		for (const k of ["fore", "back"]) s[k] = map[s[k]] ?? s[k]
		s.recent = s.recent.map((ch) => map[ch] ?? ch)
		flatten()
		s.modified = true
		full()
	}
	// the canvas made w × h, the old one at anchor (0 to 8, left to right, top to bottom)
	const resize = (w, h, anchor = 0) => {
		const dx = Math.floor(((w - pw()) * (anchor % 3)) / 2),
			dy = Math.floor(((h - ph()) * Math.floor(anchor / 3)) / 2)
		for (const L of s.layers) {
			L.rows = Array.from({ length: h }, (_, j) => {
				const r = L.rows[j - dy]
				if (r === undefined) return s.clear.repeat(w)
				let t = ""
				for (let i = 0; i < w; i++) t += r[i - dx] ?? s.clear
				return t
			})
		}
		if (s.hot) {
			s.hot = [
				Math.max(0, Math.min(s.hot[0] + dx, w - 1)),
				Math.max(0, Math.min(s.hot[1] + dy, h - 1)),
			]
		}
		s.sel = null
		if (s.center) s.center = [s.center[0] + dx, s.center[1] + dy]
		flatten()
		s.modified = true
		full()
	}
	// rows turned: a flip across, a flip down, a quarter turn right or left
	const turn = (rows, how) => {
		const h = rows.length, w = rows[0]?.length ?? 0
		if (how === "fliph") return rows.map((r) => r.split("").reverse().join(""))
		if (how === "flipv") return rows.slice().reverse()
		if (how === "right") {
			return Array.from(
				{ length: w },
				(_, y) => Array.from({ length: h }, (_, x) => rows[h - 1 - x][y]).join(""),
			)
		}
		return Array.from(
			{ length: w },
			(_, y) => Array.from({ length: h }, (_, x) => rows[x][w - 1 - y]).join(""),
		)
	}

	// --- the floating selection: lifted out of its layer, stamped back over what was under it wherever it is

	// fl: {id, base, rows}, its layer without it, its pixels; where it is, s.sel's x and y
	const floatLayer = () => s.layers.find((l) => l.id === fl.id)
	const unstamp = () => {
		const L = floatLayer()
		for (let j = 0; j < fl.rows.length; j++) {
			const y = s.sel.y + j
			if (y >= 0 && y < ph()) row(L, y, fl.base[y])
		}
	}
	const restamp = () => {
		const L = floatLayer(), w = pw()
		for (let j = 0; j < fl.rows.length; j++) {
			const y = s.sel.y + j
			if (y < 0 || y >= ph()) continue
			const t = fl.base[y].split(""), r = fl.rows[j]
			for (let i = 0; i < r.length; i++) {
				const x = s.sel.x + i
				if (x >= 0 && x < w && typeof s.colors[r[i]] === "number") t[x] = r[i]
			}
			row(L, y, t.join(""))
		}
	}
	// what the selection holds of the layer painted on, as rows, clear outside it
	const held = () => {
		const z = s.sel, L = layer()
		if (fl) return fl.rows.slice()
		return Array.from({ length: z.h }, (_, j) => {
			let t = ""
			for (let i = 0; i < z.w; i++) {
				const x = z.x + i, y = z.y + j
				t += y < ph() && x < pw() && within(x, y) ? paints(L.rows[y][x]) : s.clear
			}
			return t
		})
	}
	const lift = (keep, label = "Move") => {
		if (fl || !s.sel) return
		remember(label)
		const L = layer(), rows = held()
		if (!keep) {
			for (let j = 0; j < s.sel.h; j++) {
				const y = s.sel.y + j
				if (y >= ph()) continue
				const t = L.rows[y].split("")
				for (let i = 0; i < s.sel.w; i++) {
					if (within(s.sel.x + i, y) && s.sel.x + i < pw()) t[s.sel.x + i] = s.clear
				}
				row(L, y, t.join(""))
			}
		}
		fl = { id: L.id, base: L.rows.slice(), rows }
		restamp()
	}
	const slide = (x, y) => {
		if (!fl) return
		ants()
		unstamp()
		s.sel = { ...s.sel, x, y }
		restamp()
		ants()
	}
	// put down where it is: its move is one undo
	const putdown = () => {
		if (!fl) return
		fl = null
		done()
	}

	// --- where things are, from the window's size: the room the picture is in, the picture at its size, the readout

	const TOP = () => blit.height(FT) + 16 * u
	const FOOT = () => blit.height(F) + 10 * u
	const CELL = 28 * u
	const LEFT = 2 * CELL + 16 * u
	const RIGHT = 208 * u
	const LEVELS = [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]
	let G = null
	const lay = () => {
		const top = TOP(), foot = FOOT(), lh = blit.height(F), th = blit.height(FT)
		const room = {
			x: LEFT,
			y: top,
			w: Math.max(u, W - LEFT - RIGHT),
			h: Math.max(u, H - top - foot),
		}
		const fit = Math.max(
			1,
			Math.min(64 * u, Math.floor(Math.min((room.w - 48 * u) / pw(), (room.h - 48 * u) / ph()))),
		)
		const sc = s.zoom ? Math.max(1, Math.round(s.zoom * u)) : fit
		const c = s.zoom && s.center ? s.center : [pw() / 2, ph() / 2]
		const ox = room.x + Math.floor(room.w / 2 - c[0] * sc),
			oy = room.y + Math.floor(room.h / 2 - c[1] * sc)
		// the right panel: the picture at its size, a point a pixel (less, if it is bigger than there is room for)
		// and beside it, if there is room, as big again as fits (up to four points a pixel), where the part shown is ringed
		const px = W - RIGHT + 10 * u, pwide = RIGHT - 20 * u, most = 112 * u
		const ps = Math.min(u, (pwide - 12 * u) / pw(), (most - 12 * u) / ph())
		let big = 0
		for (let k = 4; k >= 2 && !big; k--) {
			if (pw() * (k + 1) * u + 24 * u <= pwide && ph() * k * u + 12 * u <= most) big = k * u
		}
		const pvh = Math.max(36 * u, Math.ceil(ph() * Math.max(ps, big)) + 16 * u)
		const pv = { x: px, y: top + 8 * u + th + 6 * u, w: pwide, h: pvh, s: big || ps }
		// the large one is where clicks go, and where the part shown is ringed; the small one is at its left
		const gap = big ? 12 * u : 0, both = Math.round(pw() * ps) + gap + pw() * big
		pv.small = big
			? {
				s: ps,
				ox: pv.x + Math.floor((pv.w - both) / 2),
				oy: pv.y + Math.floor((pv.h - ph() * ps) / 2),
			}
			: null
		pv.ox = big
			? pv.small.ox + Math.round(pw() * ps) + gap
			: pv.x + Math.floor((pv.w - pw() * ps) / 2)
		pv.oy = pv.y + Math.floor((pv.h - ph() * pv.s) / 2)
		// the colours: a well each, clear first, and one to add
		const sw = 18 * u, pitch = 21 * u, cols = Math.floor((pwide + pitch - sw) / pitch)
		const n = order().length + 2
		const wells = { y: pv.y + pv.h + 12 * u + th + 6 * u, sw, pitch, cols }
		const hexy = wells.y + Math.ceil(n / cols) * pitch + 2 * u
		const recenty = hexy + lh + 10 * u
		const rl = lh + 8 * u, bh = 20 * u
		const layersy = recenty + 16 * u + 12 * u + th + 6 * u
		const seen = Math.max(1, Math.min(s.layers.length, 5))
		const histy = layersy + seen * rl + 4 * u + bh + 12 * u + th + 6 * u
		const hl = lh + 4 * u
		const histn = Math.max(0, Math.floor((H - foot - 8 * u - histy) / hl))
		G = {
			room,
			sc,
			ox,
			oy,
			fit,
			pv,
			wells,
			hexy,
			recenty,
			layersy,
			rl,
			bh,
			seen,
			histy,
			hl,
			histn,
			ro: { x: 0, y: H - foot + u, w: Math.min(220 * u, LEFT + 150 * u), h: foot - u },
		}
	}
	const pixel = (x, y) => [Math.floor((x - G.ox) / G.sc), Math.floor((y - G.oy) / G.sc)]
	const clampCenter = () => {
		if (s.center) {
			s.center = [
				Math.max(0, Math.min(pw(), s.center[0])),
				Math.max(0, Math.min(ph(), s.center[1])),
			]
		}
	}
	// a zoom, keeping the pixel under x, y (the room's middle, if none) where it is
	const zoomTo = (pts, x, y) => {
		const R = G.room
		x ??= R.x + R.w / 2
		y ??= R.y + R.h / 2
		const sc = Math.max(1, Math.round(pts * u))
		const at = [(x - G.ox) / G.sc, (y - G.oy) / G.sc]
		s.zoom = pts
		s.center = [at[0] + (R.x + R.w / 2 - x) / sc, at[1] + (R.y + R.h / 2 - y) / sc]
		clampCenter()
		lay()
		full()
	}
	const zoomBy = (dir, x, y) => {
		const now = G.sc / u
		const next = dir > 0
			? LEVELS.find((z) => z > now + 1e-6)
			: [...LEVELS].reverse().find((z) => z < now - 1e-6)
		if (next) zoomTo(next, x, y)
	}

	// --- the plane: the window's size, made again bigger when the window grows past it

	let p = null, made = 0
	// the plane's pixels and their row length, through the part running; none until the driver has made it
	const pbits = () => (p ? p.bits(part.api) : null)
	const pstride = () => p.stride(part.api)
	const PLANES = ["/", "dev", "vram", "planes"]
	const sized = (api) => {
		if (p && p.w >= W && p.h >= H) return
		if (p) drop(api, PLANES, p.name)
		const n = `paint-${self}-${++made}`
		p = Object.assign(plane(api, n, W, H), { name: n })
		full()
	}
	// what is drawn into the plane and not yet said drawn: rectangles in the window; all of it, after a change of layout
	let dirt = []
	const dirty = (r) => {
		if (r && r.w > 0 && r.h > 0) dirt.push(r)
	}
	const meet = (a, b) => {
		const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
		return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y }
	}
	const join = (a, b) => {
		const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
		return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
	}
	// the pointer over the picture, the pixel it is on, or null; and what the readout last said
	let hover = null, said = ""
	// the screen rectangle of a rectangle of the picture's pixels, and some around it
	const cellsBox = (x0, y0, x1, y1, m = 0) => ({
		x: G.ox + x0 * G.sc - m,
		y: G.oy + y0 * G.sc - m,
		w: (x1 - x0) * G.sc + 2 * m,
		h: (y1 - y0) * G.sc + 2 * m,
	})
	const footprint = () => {
		if (!hover || s.dialog || s.tool === "hand" || gesture || space) return null
		const n = reach(), lo = -Math.floor((n - 1) / 2)
		return [hover[0] + lo, hover[1] + lo, hover[0] + lo + n, hover[1] + lo + n]
	}
	const footBox = () => {
		const f = footprint()
		return f && cellsBox(...f, u)
	}
	const antsBox = () =>
		s.sel && cellsBox(s.sel.x, s.sel.y, s.sel.x + s.sel.w, s.sel.y + s.sel.h, 2 * u)
	// a rectangle of the room drawn again once what changes has changed: what was there, and what will be
	const mark = (r) => r && marks.push(r)
	const ants = () => mark(antsBox())
	const ringBox = () => s.hot && cellsBox(s.hot[0], s.hot[1], s.hot[0] + 1, s.hot[1] + 1, 4 * u)

	// clear, as a checkerboard from the picture's corner
	const checker = (bits, st, y, xa, xb, n, ox, oy) => {
		const base = y * st, rowp = Math.floor((y - oy) / n)
		for (let x = xa; x < xb;) {
			const b = Math.floor((x - ox) / n), end = Math.min(xb, ox + (b + 1) * n)
			bits.fill((b + rowp) & 1 ? C.check : C.hi, base + x, base + end)
			x = end
		}
	}
	// the grid between pixels: what is under it darkened a little, so it shows on any colour
	const shade = (c) => c - ((c >> 2) & 0x3f3f3f) + 0x202020
	/** the room's rectangle R, drawn: the desk, the picture's frame and shadow, its pixels, the grid, then what lies over it */
	const room = (R) => {
		R = meet(R, G.room)
		if (R.w <= 0 || R.h <= 0) return
		const bits = pbits(), st = pstride(), form = { w: st, h: p.h, bits }
		const { sc, ox, oy } = G, w = pw(), h = ph(), cw = w * sc, ch = h * sc
		blit.fill(form, R.x, R.y, R.w, R.h, C.desk)
		blit.fill(form, ox + u, oy + u, cw + 2 * u, ch + 2 * u, C.line, R)
		blit.fill(form, ox - u, oy - u, cw + 2 * u, ch + 2 * u, C.line, R)
		const A = meet(R, { x: ox, y: oy, w: cw, h: ch })
		if (A.w > 0 && A.h > 0) {
			// a row of pixels drawn once for each phase of the checkerboard, then copied down the rest of the row
			// of the picture's pixels (the copy is the runner's, not a loop here)
			const n = Math.max(2 * u, Math.min(8 * u, Math.floor(sc / 2))),
				grid = s.grid && sc >= 4 * u
			const i0 = Math.floor((A.x - ox) / sc), i1 = Math.ceil((A.x + A.w - ox) / sc)
			const j0 = Math.floor((A.y - oy) / sc), j1 = Math.ceil((A.y + A.h - oy) / sc)
			const line = (r, y) => {
				const base = y * st
				for (let i = i0; i < i1;) {
					let k = i
					const letter = r[i]
					while (k < i1 && r[k] === letter) k++
					const xa = Math.max(A.x, ox + i * sc),
						xb = Math.min(A.x + A.w, ox + k * sc),
						c = s.colors[letter]
					if (typeof c === "number") bits.fill(c, base + xa, base + xb)
					else checker(bits, st, y, xa, xb, n, ox, oy)
					i = k
				}
				if (grid) {
					for (let i = Math.max(1, i0); i < Math.min(w, i1 + 1); i++) {
						const x = ox + i * sc
						if (x >= A.x && x < A.x + A.w) bits[base + x] = shade(bits[base + x])
					}
				}
			}
			for (let j = j0; j < j1; j++) {
				const r = s.rows[j],
					ya = Math.max(A.y, oy + j * sc),
					yb = Math.min(A.y + A.h, oy + (j + 1) * sc)
				const made = [-1, -1]
				for (let y = ya; y < yb; y++) {
					const phase = Math.floor((y - oy) / n) & 1, edge = grid && j > 0 && y === oy + j * sc
					if (!edge && made[phase] >= 0) {
						bits.copyWithin(
							y * st + A.x,
							made[phase] * st + A.x,
							made[phase] * st + A.x + A.w,
						)
						continue
					}
					line(r, y)
					if (edge) {
						for (let x = A.x; x < A.x + A.w; x++) bits[y * st + x] = shade(bits[y * st + x])
					} else made[phase] = y
				}
			}
		}
		over(form, R)
	}
	// what lies over the picture: the mirrors' lines, the selection's dashes, the hot spot, the pointer's footprint
	const over = (form, R) => {
		const { sc, ox, oy } = G, w = pw(), h = ph(), bits = form.bits, st = form.w
		if (s.mx) {
			blit.fill(
				form,
				ox + Math.round((w * sc) / 2) - Math.floor(u / 2),
				oy - 6 * u,
				u,
				h * sc + 12 * u,
				C.cherry,
				R,
			)
		}
		if (s.my) {
			blit.fill(
				form,
				ox - 6 * u,
				oy + Math.round((h * sc) / 2) - Math.floor(u / 2),
				w * sc + 12 * u,
				u,
				C.cherry,
				R,
			)
		}
		// dashes: black and paper by where they are, still
		const dash = (x, y, dw, dh) => {
			const A = meet(R, { x, y, w: dw, h: dh })
			for (let yy = A.y; yy < A.y + A.h; yy++) {
				for (let xx = A.x; xx < A.x + A.w; xx++) {
					bits[yy * st + xx] = Math.floor((xx + yy) / (4 * u)) & 1 ? C.hi : C.line
				}
			}
		}
		const z = s.sel
		if (z && !z.mask) {
			const x = ox + z.x * sc, y = oy + z.y * sc, zw = z.w * sc, zh = z.h * sc
			dash(x - u, y - u, zw + 2 * u, u)
			dash(x - u, y + zh, zw + 2 * u, u)
			dash(x - u, y, u, zh)
			dash(x + zw, y, u, zh)
		} else if (z) {
			const inside = (i, j) => i >= 0 && j >= 0 && i < z.w && j < z.h && z.mask[j][i] === "#"
			const i0 = Math.max(0, Math.floor((R.x - ox) / sc) - z.x - 1),
				i1 = Math.min(z.w, Math.ceil((R.x + R.w - ox) / sc) - z.x + 1)
			const j0 = Math.max(0, Math.floor((R.y - oy) / sc) - z.y - 1),
				j1 = Math.min(z.h, Math.ceil((R.y + R.h - oy) / sc) - z.y + 1)
			for (let j = j0; j < j1; j++) {
				for (let i = i0; i < i1; i++) {
					if (!inside(i, j)) continue
					const x = ox + (z.x + i) * sc, y = oy + (z.y + j) * sc
					if (!inside(i, j - 1)) dash(x - u, y - u, sc + 2 * u, u)
					if (!inside(i, j + 1)) dash(x - u, y + sc, sc + 2 * u, u)
					if (!inside(i - 1, j)) dash(x - u, y, u, sc)
					if (!inside(i + 1, j)) dash(x + sc, y, u, sc)
				}
			}
		}
		// a lasso being drawn: its line so far
		if (gesture?.kind === "lasso") {
			const q = gesture.pts
			for (let k = 1; k < q.length; k++) {
				blit.line(
					form,
					ox + q[k - 1][0] * sc,
					oy + q[k - 1][1] * sc,
					ox + q[k][0] * sc,
					oy + q[k][1] * sc,
					u,
					C.line,
					R,
				)
			}
		}
		// the hot spot: the pixel that points, ringed in lemon between black lines, seen on any colour
		if (s.hot) {
			const hx = ox + s.hot[0] * sc, hy = oy + s.hot[1] * sc
			const band = (d, k, c) => {
				for (let i = 0; i < k; i++) {
					blit.frame(form, hx - d + i, hy - d + i, sc + 2 * (d - i), sc + 2 * (d - i), c, R)
				}
			}
			band(3 * u, u, C.line)
			band(2 * u, 3 * u, C.lemon)
			band(-u, u, C.line)
		}
		// where the brush would land: a black line round it, paper inside that
		const f = footprint()
		if (f) {
			const b = cellsBox(...f)
			blit.frame(form, b.x - 1, b.y - 1, b.w + 2, b.h + 2, C.line, R)
			blit.frame(form, b.x, b.y, b.w, b.h, C.hi, R)
		}
	}
	/** the picture at its size, a point a pixel, and the part of it the room shows ringed in cherry */
	const preview = () => {
		const P = G.pv, bits = pbits(), st = pstride(), form = { w: st, h: p.h, bits }
		blit.fill(form, P.x, P.y, P.w, P.h, C.desk)
		blit.frame(form, P.x, P.y, P.w, P.h, C.line)
		for (let i = 1; i < u; i++) {
			blit.frame(form, P.x + i, P.y + i, P.w - 2 * i, P.h - 2 * i, C.line)
		}
		const w = pw(), h = ph(), ps = P.s
		// a row drawn, the rows after it that show the same picture's row and checks copied
		const at = (ps, ox, oy) => {
			const dw = Math.max(1, Math.round(w * ps)), dh = Math.max(1, Math.round(h * ps))
			let last = -1, lastKey = ""
			for (let y = 0; y < dh; y++) {
				const j = Math.min(h - 1, Math.floor(y / ps)),
					r = s.rows[j],
					base = (oy + y) * st + ox,
					key = `${j} ${Math.floor(y / (2 * u)) & 1}`
				if (key === lastKey) {
					bits.copyWithin(base, (oy + last) * st + ox, (oy + last) * st + ox + dw)
					continue
				}
				for (let x = 0; x < dw; x++) {
					const c = s.colors[r[Math.min(w - 1, Math.floor(x / ps))]]
					bits[base + x] = typeof c === "number"
						? c
						: (Math.floor(x / (2 * u)) + Math.floor(y / (2 * u))) & 1
						? C.check
						: C.hi
				}
				last = y
				lastKey = key
			}
		}
		if (P.small) at(P.small.s, P.small.ox, P.small.oy)
		at(ps, P.ox, P.oy)
		// the part shown, when it is not all of it
		const R = G.room,
			a = [(R.x - G.ox) / G.sc, (R.y - G.oy) / G.sc],
			b = [(R.x + R.w - G.ox) / G.sc, (R.y + R.h - G.oy) / G.sc]
		if (a[0] > 0 || a[1] > 0 || b[0] < w || b[1] < h) {
			const x0 = P.ox + Math.round(Math.max(0, a[0]) * ps),
				y0 = P.oy + Math.round(Math.max(0, a[1]) * ps)
			const x1 = P.ox + Math.round(Math.min(w, b[0]) * ps),
				y1 = P.oy + Math.round(Math.min(h, b[1]) * ps)
			const clip = { x: P.x + u, y: P.y + u, w: P.w - 2 * u, h: P.h - 2 * u }
			for (let i = 0; i < u; i++) {
				blit.frame(
					form,
					x0 - i - 1,
					y0 - i - 1,
					x1 - x0 + 2 * i + 2,
					y1 - y0 + 2 * i + 2,
					C.cherry,
					clip,
				)
			}
		}
		dirty({ x: P.x, y: P.y, w: P.w, h: P.h })
	}
	// where the pointer is, the colour under it; and a shape's or a selection's size as it is drawn
	const reading = () => {
		let t = ""
		if (hover && hover[0] >= 0 && hover[1] >= 0 && hover[0] < pw() && hover[1] < ph()) {
			const c = s.colors[s.rows[hover[1]][hover[0]]]
			t = `${hover[0]}, ${hover[1]}   ${typeof c === "number" ? `#${hex(c)}` : "clear"}`
		} else if (hover) t = `${hover[0]}, ${hover[1]}`
		const g = gesture
		if (g?.shown) {
			t += `   ${Math.abs(g.shown[2] - g.shown[0]) + 1} × ${
				Math.abs(g.shown[3] - g.shown[1]) + 1
			}`
		} else if (g?.kind === "select" || g?.kind === "move") {
			t += s.sel ? `   ${s.sel.w} × ${s.sel.h}` : ""
		}
		return t
	}
	const readout = (force) => {
		const t = reading()
		if (t === said && !force) return
		said = t
		const O = G.ro, form = { w: pstride(), h: p.h, bits: pbits() }
		blit.fill(form, O.x, O.y, O.w, O.h, C.chrome)
		blit.text(
			form,
			O.x + 10 * u,
			O.y + Math.floor((O.h - blit.height(F)) / 2),
			t,
			C.ink,
			undefined,
			O,
			F,
		)
		blit.fill(form, O.x + O.w - u, O.y + 3 * u, u, O.h - 6 * u, C.lo)
		dirty(O)
	}
	// where the room's picture was last drawn, [ox, oy, sc], so a move of it alone is the plane's pixels moved; the
	// pointer's footprint as drawn
	let drawn = null, foot = null
	/** the room's pixels moved by dx, dy, as a pan moves them, and only the strips it uncovers drawn */
	const scroll = (dx, dy) => {
		const R = G.room, bits = pbits(), st = pstride()
		const x0 = Math.max(R.x, R.x + dx), x1 = Math.min(R.x + R.w, R.x + R.w + dx)
		if (x1 > x0) {
			const rows = []
			for (let y = Math.max(R.y, R.y + dy); y < Math.min(R.y + R.h, R.y + R.h + dy); y++) {
				rows.push(y)
			}
			if (dy > 0) rows.reverse()
			for (const y of rows) {
				bits.copyWithin(y * st + x0, (y - dy) * st + x0 - dx, (y - dy) * st + x1 - dx)
			}
		}
		if (dx > 0) room({ x: R.x, y: R.y, w: dx, h: R.h })
		if (dx < 0) room({ x: R.x + R.w + dx, y: R.y, w: -dx, h: R.h })
		if (dy > 0) room({ x: R.x, y: R.y, w: R.w, h: dy })
		if (dy < 0) room({ x: R.x, y: R.y + R.h + dy, w: R.w, h: -dy })
		dirty(R)
	}
	/** what changed, into the plane: all of it after a change of layout, else the pixels changed, what lies over them, the readout */
	const render = () => {
		if (!pbits() || !G) return
		if (everything) {
			foot = footBox()
			room(G.room)
			dirty(G.room)
			preview()
			readout(true)
			everything = false
			changed = null
			marks = []
			drawn = [G.ox, G.oy, G.sc]
			return
		}
		if (drawn && (drawn[0] !== G.ox || drawn[1] !== G.oy) && drawn[2] === G.sc) {
			const dx = G.ox - drawn[0], dy = G.oy - drawn[1]
			// the footprint moved with what it was drawn on
			if (foot) foot = { ...foot, x: foot.x + dx, y: foot.y + dy }
			if (Math.abs(dx) < G.room.w && Math.abs(dy) < G.room.h) scroll(dx, dy)
			else {
				room(G.room)
				dirty(G.room)
			}
			drawn = [G.ox, G.oy, G.sc]
			preview()
		}
		// the pointer's footprint where it is now, and gone from where it was drawn (a tool, a size or the pointer changed)
		const now = footBox()
		if (JSON.stringify(now) !== JSON.stringify(foot)) {
			mark(foot)
			mark(now)
			foot = now
		}
		for (const r of marks) {
			room(r)
			dirty(meet(r, G.room))
		}
		marks = []
		if (changed) {
			const r = cellsBox(...changed, 4 * u)
			room(r)
			dirty(meet(r, G.room))
			// the picture at its size: as a stroke ends, not during one
			if (gesture?.kind !== "paint") preview()
			else gesture.preview = true
			changed = null
		}
		// where the pointer is: once it rests
		if (reading() !== said) rest()
	}
	// said drawn: what changed in each of the plane's places (the room, the picture at its size, the readout) as one
	// rectangle, never across the ops between them, which the compositor does not play again over a rectangle. One
	// place a serial: the room's now, another's a turn later, as the compositor copies only the rectangle of a serial
	// one more than the last it drew (two in one turn, and it copies the plane whole, which is right, only slower)
	let later = []
	const tell = () => {
		const all = [...dirt, ...later]
		dirt = []
		later = []
		if (!all.length || !p || !G) return
		const places = [G.room, G.pv, G.ro], groups = []
		for (const r of all) {
			const k = places.findIndex((P) =>
				r.x >= P.x && r.y >= P.y && r.x + r.w <= P.x + P.w && r.y + r.h <= P.y + P.h
			)
			if (k < 0) continue
			groups[k] = groups[k] ? join(groups[k], r) : { ...r }
		}
		const [first, ...rest] = groups.filter(Boolean)
		if (!first) return
		p.drawn(part.api, part.call, LAYER, first.x, first.y, first.w, first.h)
		later = rest
		if (later.length && !waiting) waiting = after(part, 16, ready)
	}
	// the readout, once the pointer rests: drawn while it moves, it would be a serial of its own each move
	let resting = null, movedAt = 0
	const rest = () => {
		movedAt = Date.now()
		if (!resting) resting = after(part, 40, settle)
	}

	// --- drawing the window: ops, written only when what they show changes

	const TOOLS = [
		["pencil", "Pencil", "p", [
			"..........kk",
			".........kck",
			"........kcck",
			".......kpkk.",
			"......kppk..",
			".....kppk...",
			"....kppk....",
			"...kppk.....",
			"..kkpk......",
			"..kkk.......",
			".kk.........",
			"k...........",
		]],
		["brush", "Brush", "b", [
			"..........kk",
			".........kpk",
			"........kpk.",
			".......kpk..",
			"......kpk...",
			".....kkk....",
			"....kcck....",
			"...kccck....",
			"..kccck.....",
			".kccck......",
			".kcck.......",
			"..kk........",
		]],
		["eraser", "Eraser", "e", [
			"............",
			"......kkkkk.",
			".....kpppkk.",
			"....kpppkpk.",
			"...kpppkppk.",
			"..kpppkppk..",
			".kkkkkppk...",
			".kpppkpk....",
			".kpppkk.....",
			".kkkkk......",
			"............",
			"............",
		]],
		["fill", "Fill", "g", [
			"....kk......",
			"...kppk.....",
			"..kpppkk....",
			".kpppkpkk...",
			"kpppkppkck..",
			".kpkppkpcck.",
			"..kppkpkccck",
			"...kppk.ccck",
			"....kk...cck",
			".........cc.",
			"............",
			"............",
		]],
		["line", "Line", "l", [
			"............",
			"..........k.",
			".........k..",
			"........k...",
			".......k....",
			"......k.....",
			".....k......",
			"....k.......",
			"...k........",
			"..k.........",
			".k..........",
			"............",
		]],
		["rect", "Rectangle", "u", [
			"............",
			"............",
			".kkkkkkkkkk.",
			".k........k.",
			".k........k.",
			".k........k.",
			".k........k.",
			".k........k.",
			".k........k.",
			".kkkkkkkkkk.",
			"............",
			"............",
		]],
		["ellipse", "Ellipse", "o", [
			"............",
			"....kkkk....",
			"..kk....kk..",
			".k........k.",
			".k........k.",
			"k..........k",
			"k..........k",
			".k........k.",
			".k........k.",
			"..kk....kk..",
			"....kkkk....",
			"............",
		]],
		["dropper", "Dropper", "i", [
			"........kkk.",
			".......kkkkk",
			"......kkkkkk",
			".......kkkk.",
			"......kpkk..",
			".....kpk.k..",
			"....kpk.....",
			"...kpk......",
			"..kpk.......",
			".kck........",
			".kk.........",
			"............",
		]],
		["marquee", "Marquee", "m", [
			"............",
			".kk.kk.kk.k.",
			"............",
			".k........k.",
			".k..........",
			"..........k.",
			".k..........",
			".k........k.",
			"............",
			".k.kk.kk.kk.",
			"............",
			"............",
		]],
		["lasso", "Lasso", "q", [
			"............",
			"...kkkkk....",
			".kk.....kk..",
			"k.........k.",
			"k.........k.",
			".kk.....kk..",
			"...kkkkkk...",
			"....k.......",
			"...k........",
			"...k........",
			"....kk......",
			"......k.....",
		]],
		["hand", "Hand", "h", [
			".....kk.....",
			"..kk.kpkkk..",
			".kpkkkpkpk..",
			".kpkpkpkpkk.",
			".kpkpkpkpkpk",
			".kpppppppkpk",
			"kkpppppppppk",
			"kppppppppppk",
			".kppppppppk.",
			"..kpppppppk.",
			"...kppppppk.",
			"...kkkkkkkk.",
		]],
		["hot", "Hot Spot", "t", [
			".....k......",
			".....k......",
			".....k......",
			"............",
			"............",
			"kkk..c..kkk.",
			"............",
			"............",
			".....k......",
			".....k......",
			".....k......",
			"............",
		]],
	]
	const tools = () => TOOLS.filter(([t]) => t !== "hot" || s.hot)
	const named = (t) => TOOLS.find((x) => x[0] === t)?.[1] ?? t
	// small pictures for the bar's and the panel's buttons, 9 × 9
	const ICONS = {
		square: [
			".........",
			".kkkkkkk.",
			".kkkkkkk.",
			".kkkkkkk.",
			".kkkkkkk.",
			".kkkkkkk.",
			".kkkkkkk.",
			".kkkkkkk.",
			".........",
		],
		round: [
			".........",
			"...kkk...",
			".kkkkkkk.",
			".kkkkkkk.",
			"kkkkkkkkk",
			".kkkkkkk.",
			".kkkkkkk.",
			"...kkk...",
			".........",
		],
		plus: [
			".........",
			"....k....",
			"....k....",
			"....k....",
			".kkkkkkk.",
			"....k....",
			"....k....",
			"....k....",
			".........",
		],
		minus: [
			".........",
			".........",
			".........",
			".........",
			".kkkkkkk.",
			".........",
			".........",
			".........",
			".........",
		],
		up: [
			".........",
			".........",
			"....k....",
			"...kkk...",
			"..kkkkk..",
			".kkkkkkk.",
			".........",
			".........",
			".........",
		],
		down: [
			".........",
			".........",
			".........",
			".kkkkkkk.",
			"..kkkkk..",
			"...kkk...",
			"....k....",
			".........",
			".........",
		],
		dup: [
			"kkkkkk...",
			"k....k...",
			"k..kkkkkk",
			"k..k....k",
			"kkkk....k",
			"...k....k",
			"...k....k",
			"...kkkkkk",
			".........",
		],
		grid: [
			"kkkkkkkkk",
			"k...k...k",
			"k...k...k",
			"k...k...k",
			"kkkkkkkkk",
			"k...k...k",
			"k...k...k",
			"k...k...k",
			"kkkkkkkkk",
		],
		mx: [
			"....k....",
			"k...k...k",
			"kk..k..kk",
			"kkk.k.kkk",
			"kkkkkkkkk",
			"kkk.k.kkk",
			"kk..k..kk",
			"k...k...k",
			"....k....",
		],
		my: [
			"kkkkkkkkk",
			".kkkkkkk.",
			"..kkkkk..",
			"...kkk...",
			"kkkkkkkkk",
			"...kkk...",
			"..kkkkk..",
			".kkkkkkk.",
			"kkkkkkkkk",
		],
		eye: [
			".........",
			".........",
			"..kkkkk..",
			".k..k..k.",
			"k..kkk..k",
			".k..k..k.",
			"..kkkkk..",
			".........",
			".........",
		],
		swap: [
			"..k......",
			".kk......",
			"kkkkkkk..",
			".kk...k..",
			"..k...k..",
			"......k..",
			"....kkkkk",
			".....kkk.",
			"......k..",
		],
	}
	const fitted = (text, w, font) => {
		const n = blit.fit(text, w, font)
		return n >= text.length ? text : text.slice(0, Math.max(0, n - 1)) + "…"
	}
	// pixel art, drawn once into a form (a letter not in colors transparent) and kept, then one op wherever it goes
	const sprites = new Map()
	const art = (f, rows, colors, x, y, scale, clip) => {
		const key = JSON.stringify([rows, colors, scale])
		let form = sprites.get(key)
		if (!form) {
			const w = Math.max(...rows.map((r) => r.length))
			form = blit.form(w * scale, rows.length * scale, 0xff000000)
			rows.forEach((row, j) =>
				[...row].forEach((ch, i) => {
					if (typeof colors[ch] === "number") {
						blit.fill(form, i * scale, j * scale, scale, scale, colors[ch])
					}
				})
			)
			if (sprites.size > 200) sprites.clear()
			sprites.set(key, form)
		}
		blit.blit(f, x, y, form, 0, 0, form.w, form.h, "over", clip)
	}
	// clear, as a checkerboard: a form of four cells, tiled
	const checks = (n) => {
		const form = blit.form(2 * n, 2 * n, C.hi)
		blit.fill(form, n, 0, n, n, C.check)
		blit.fill(form, 0, n, n, n, C.check)
		return form
	}
	const box = (f, x, y, w, h, n = u, c = C.line) => {
		for (let i = 0; i < n; i++) blit.frame(f, x + i, y + i, w - 2 * i, h - 2 * i, c)
	}
	// where each thing drawn is, from the last draw: what a click does there, and what VoiceOver says
	let zones = []
	const zone = (z) => zones.push(z)

	// a square button with a hard 90s bevel; a default one ringed, as System 7's OK is
	const button = (f, x, y, label, act, on = true, ring = false, extra = {}) => {
		const w = blit.measure(label, FT) + 20 * u, h = blit.height(FT) + 8 * u
		if (ring) {
			blit.fill(f, x - 3 * u, y - 3 * u, w + 6 * u, h + 6 * u, C.line)
			blit.fill(f, x - u, y - u, w + 2 * u, h + 2 * u, C.chrome)
		}
		blit.fill(f, x, y, w, h, C.line)
		blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
		blit.text(f, x + 10 * u, y + 4 * u, label, on ? C.ink : C.dim, undefined, undefined, FT)
		zone({ x, y, w, h, act: on ? act : null, role: "button", label, ...extra })
		return x + w
	}
	// a small square button with an icon: lemon and a heavier line when it is on, as a tool in hand is
	const SB = () => blit.height(FT) + 6 * u
	const toggle = (f, x, y, icon, lit, z, on = true) => {
		const n = SB()
		blit.fill(f, x, y, n, n, lit ? C.lemon : C.hi)
		box(f, x, y, n, n, lit ? 2 * u : u)
		const k = ICONS[icon], sc = Math.max(u, Math.floor((n - 8 * u) / 9))
		art(
			f,
			k,
			{ k: on ? C.line : C.dim },
			x + Math.floor((n - 9 * sc) / 2),
			y + Math.floor((n - 9 * sc) / 2),
			sc,
		)
		zone({ x, y, w: n, h: n, role: "button", ...z, act: on ? z.act : null })
		return x + n
	}
	// a System 7 checkbox: a box, a cross in it when on, its label
	const checkbox = (f, x, y, label, on, z) => {
		const n = 12 * u, lh = blit.height(F), cy = y + Math.floor((SB() - n) / 2)
		blit.fill(f, x, cy, n, n, C.hi)
		box(f, x, cy, n, n)
		if (on) {
			for (let i = 2 * u; i < n - 2 * u; i += u) {
				blit.fill(f, x + i, cy + i, u, u, C.line)
				blit.fill(f, x + n - u - i, cy + i, u, u, C.line)
			}
		}
		const end = blit.text(
			f,
			x + n + 6 * u,
			y + Math.floor((SB() - lh) / 2),
			label,
			C.ink,
			undefined,
			undefined,
			F,
		)
		zone({
			x,
			y,
			w: end - x,
			h: SB(),
			role: "checkbox",
			label: `${label}, ${on ? "on" : "off"}`,
			...z,
		})
		return end
	}
	// a colour well: its colour, or clear's checks
	const well = (f, x, y, w, h, ch) => {
		const c = s.colors[ch]
		if (typeof c === "number") blit.fill(f, x, y, w, h, c)
		else blit.tile(f, x, y, w, h, checks(3 * u), "copy", { x, y, w, h })
		box(f, x, y, w, h)
	}
	const label = (ch) => (ch === s.clear || !(ch in s.colors) ? "clear" : `#${hex(s.colors[ch])}`)
	// a section of the right panel: its name, and a line under it
	const head = (f, x, y, w, text) => {
		const th = blit.height(FT)
		blit.text(f, x, y, text, C.ink, undefined, undefined, FT)
		blit.fill(
			f,
			x + blit.measure(text, FT) + 8 * u,
			y + Math.floor(th / 2),
			w - blit.measure(text, FT) - 8 * u,
			u,
			C.lo,
		)
	}

	// what the ops show, all of it: written again only when this changes
	const ui = () => ({
		W,
		H,
		ready: !!pbits(),
		fonts: [String(F), String(FT)],
		C,
		tool: s.tool,
		fore: s.fore,
		back: s.back,
		size: s.size,
		shape: s.shape,
		filled: s.filled,
		contiguous: s.contiguous,
		perfect: s.perfect,
		mx: s.mx,
		my: s.my,
		grid: s.grid,
		zoom: G.sc,
		pw: pw(),
		ph: ph(),
		colors: s.colors,
		clear: s.clear,
		recent: s.recent,
		drop: s.drop,
		from: s.from,
		layers: s.layers.map((l) => [l.name, l.hidden]),
		cur: s.cur,
		history: history(),
		modified: s.modified,
		missing: s.base.missing || s.base.wrong,
		hot: s.hot ? 1 : 0,
		sel: s.sel ? [s.sel.w, s.sel.h] : null,
		floating: !!fl,
		note: s.note,
		dialog: s.dialog,
	})
	// what was done, oldest first: what undo takes back, then (dimmed) what redo does again; the ones shown
	const history = () => {
		const all = [
			{ label: "Opened", k: 0 },
			...s.undo.map((e, i) => ({ label: e.label, k: i + 1 })),
			...s.redo.slice().reverse().map((e, i) => ({
				label: e.label,
				k: s.undo.length + i + 1,
				later: true,
			})),
		]
		const n = G?.histn ?? 0, now = s.undo.length
		const from = Math.max(0, Math.min(now - Math.floor(n / 2), all.length - n))
		return all.slice(from, from + n).map((x) => [x.label, x.k, !!x.later])
	}

	const draw = (v) => {
		zones = []
		// no ground: the room the picture is in is the plane's, under these ops
		const f = blit.list(W, H)
		const top = TOP(), foot = FOOT(), lh = blit.height(F), th = blit.height(FT), R = G.room
		if (!v.ready) blit.fill(f, R.x, R.y, R.w, R.h, C.desk)
		zone({
			...R,
			act: "room",
			role: "image",
			label: `${path.at(-1)}, ${pw()} by ${ph()}${
				s.hot ? `, hot spot ${s.hot[0]} ${s.hot[1]}` : ""
			}`,
		})

		// the bar: what the tool in hand does; at the right, the grid, the mirrors and the zoom
		blit.fill(f, 0, 0, W, top, C.chrome)
		blit.fill(f, 0, top - u, W, u, C.line)
		const by = Math.floor((top - SB()) / 2),
			ty = Math.floor((top - th) / 2),
			ly = Math.floor((top - lh) / 2)
		blit.text(f, 10 * u, ty, named(s.tool), C.ink, undefined, undefined, FT)
		let x = LEFT + 10 * u
		blit.fill(f, LEFT, 6 * u, u, top - 12 * u, C.lo)
		const stepper = () => {
			blit.text(f, x, ly, "Size", C.ink, undefined, undefined, F)
			x += blit.measure("Size", F) + 8 * u
			x = toggle(f, x, by, "minus", false, { act: "smaller", label: "smaller, [" }, s.size > 1)
			const t = `${s.size}`, tw = 26 * u
			blit.text(
				f,
				x + Math.floor((tw - blit.measure(t, F)) / 2),
				ly,
				t,
				C.ink,
				undefined,
				undefined,
				F,
			)
			x = toggle(
				f,
				x + tw,
				by,
				"plus",
				false,
				{ act: "bigger", label: "bigger, ]" },
				s.size < 32,
			) + 16 * u
		}
		const hint = (text) => {
			const room = W - x - 260 * u
			if (room > 40 * u) {
				blit.text(f, x, ly, fitted(text, room, F), C.dim, undefined, undefined, F)
			}
		}
		if (s.tool === "pencil") {
			x = checkbox(f, x, by, "Pixel-perfect", s.perfect, { act: "perfect" }) + 20 * u
			hint("Shift-click draws a line from the last point")
		} else if (s.tool === "brush" || s.tool === "eraser") {
			stepper()
			x = toggle(f, x, by, "square", s.shape === "square", {
				act: "shape",
				arg: "square",
				label: "square brush",
			})
			x = toggle(f, x - u, by, "round", s.shape === "round", {
				act: "shape",
				arg: "round",
				label: "round brush",
			}) + 20 * u
			hint("Shift-click draws a line from the last point")
		} else if (s.tool === "line") {
			stepper()
			hint("Shift keeps it straight or diagonal")
		} else if (s.tool === "rect" || s.tool === "ellipse") {
			stepper()
			x = checkbox(f, x, by, "Filled", s.filled, { act: "filled" }) + 20 * u
			hint("Shift makes it square, Option draws it from the middle")
		} else if (s.tool === "fill") {
			x = checkbox(f, x, by, "Contiguous", s.contiguous, { act: "contiguous" }) + 20 * u
			hint(
				s.contiguous
					? "Fills the touching pixels of one colour"
					: "Fills every pixel of that colour",
			)
		} else if (s.tool === "dropper") {
			hint("Click takes the colour in front, the right button the one behind")
		} else if (s.tool === "marquee" || s.tool === "lasso") {
			hint("Drag inside to move it, Option to copy; the arrows nudge")
		} else if (s.tool === "hand") hint("Or hold Space; scroll to move, Cmd-scroll to zoom")
		else if (s.tool === "hot") hint("Click the pixel that points")
		// from the right: the zoom, the mirrors, the grid
		let rx = W - 10 * u
		const zt = `${Math.round((v.zoom / u) * 100)}%`
		rx -= SB()
		toggle(f, rx, by, "plus", false, { act: "in", label: "zoom in, cmd-+" }, v.zoom < 64 * u)
		rx -= 50 * u
		blit.text(
			f,
			rx + Math.floor((50 * u - blit.measure(zt, F)) / 2),
			ly,
			zt,
			C.ink,
			undefined,
			undefined,
			F,
		)
		zone({
			x: rx,
			y: by,
			w: 50 * u,
			h: SB(),
			act: "fit",
			role: "button",
			label: `${zt}, fit in the window, cmd-0`,
		})
		rx -= SB()
		toggle(f, rx, by, "minus", false, { act: "out", label: "zoom out, cmd--" }, v.zoom > 1)
		rx -= 14 * u + SB()
		toggle(f, rx, by, "my", s.my, {
			act: "my",
			label: `mirror top and bottom, ${s.my ? "on" : "off"}`,
		})
		rx -= SB() - u
		toggle(f, rx, by, "mx", s.mx, {
			act: "mx",
			label: `mirror left and right, ${s.mx ? "on" : "off"}`,
		})
		rx -= 8 * u + SB()
		toggle(f, rx, by, "grid", s.grid, {
			act: "grid",
			label: `the grid, ${s.grid ? "on" : "off"}, cmd-'`,
		})

		// the left column: tools, two by two, the one in hand on lemon; under them the colours in front and behind
		blit.fill(f, 0, top, LEFT, H - top - foot, C.paper)
		blit.fill(f, LEFT - u, top, u, H - top - foot, C.line)
		const tint = { k: C.line, p: C.paper, c: C.cherry }
		let ty2 = top + 8 * u
		tools().forEach(([t, title, key, rows], i) => {
			const cx = 8 * u + (i % 2) * CELL, cy = ty2 + Math.floor(i / 2) * CELL
			blit.fill(f, cx, cy, CELL, CELL, t === s.tool ? C.lemon : C.paper)
			box(f, cx, cy, CELL + u, CELL + u, t === s.tool ? 2 * u : u)
			art(f, rows, tint, cx + 2 * u, cy + 2 * u, 2 * u)
			zone({
				x: cx,
				y: cy,
				w: CELL,
				h: CELL,
				act: "tool",
				arg: t,
				role: "button",
				label: `${title}, ${key}${t === s.tool ? ", in hand" : ""}`,
			})
		})
		ty2 += Math.ceil(tools().length / 2) * CELL + 14 * u
		const ww = 32 * u
		well(f, 8 * u + 2 * CELL - ww, ty2 + 14 * u, ww, ww, s.back)
		zone({
			x: 8 * u + 2 * CELL - ww,
			y: ty2 + 14 * u,
			w: ww,
			h: ww,
			act: "swap",
			role: "button",
			label: `behind: ${label(s.back)}; swaps, x`,
		})
		blit.fill(f, 8 * u - u, ty2 - u, ww + 2 * u, ww + 2 * u, C.paper)
		well(f, 8 * u, ty2, ww, ww, s.fore)
		zone({
			x: 8 * u,
			y: ty2,
			w: ww,
			h: ww,
			act: "edit",
			role: "button",
			label: `in front: ${label(s.fore)}; edit it`,
		})
		art(f, ICONS.swap, { k: C.line }, 8 * u + 2 * CELL - 9 * u, ty2 - u, u)
		zone({
			x: 8 * u + 2 * CELL - 12 * u,
			y: ty2 - 2 * u,
			w: 12 * u,
			h: 12 * u,
			act: "swap",
			role: "button",
			label: "swap them, x",
		})
		// the colours as they began, black in front and clear behind: d
		const dy = ty2 + ww + 4 * u
		blit.tile(f, 8 * u + 5 * u, dy + 5 * u, 9 * u, 9 * u, checks(2 * u), "copy", {
			x: 8 * u + 5 * u,
			y: dy + 5 * u,
			w: 9 * u,
			h: 9 * u,
		})
		box(f, 8 * u + 5 * u, dy + 5 * u, 9 * u, 9 * u)
		blit.fill(f, 8 * u, dy, 9 * u, 9 * u, C.line)
		zone({
			x: 8 * u,
			y: dy,
			w: 14 * u,
			h: 14 * u,
			act: "default",
			role: "button",
			label: "black and clear, d",
		})

		// the right panel
		const px = W - RIGHT, X = px + 10 * u, PW = RIGHT - 20 * u, P = G.pv
		// around the picture at its size, which is the plane's
		blit.fill(f, px, top, RIGHT, P.y - top, C.paper)
		blit.fill(f, px, P.y, P.x - px, P.h, C.paper)
		blit.fill(f, P.x + P.w, P.y, px + RIGHT - P.x - P.w, P.h, C.paper)
		blit.fill(f, px, P.y + P.h, RIGHT, H - foot - P.y - P.h, C.paper)
		blit.fill(f, px, top, u, H - top - foot, C.line)
		head(f, X, top + 8 * u, PW, "Preview")
		if (!v.ready) blit.fill(f, P.x, P.y, P.w, P.h, C.desk)
		zone({
			x: P.x,
			y: P.y,
			w: P.w,
			h: P.h,
			act: "look",
			role: "image",
			label: "the picture at its size; click to go there",
		})
		head(f, X, P.y + P.h + 12 * u, PW, "Colours")
		const Wl = G.wells, wells = [s.clear, ...order()]
		wells.forEach((ch, i) => {
			const cx = X + (i % Wl.cols) * Wl.pitch, cy = Wl.y + Math.floor(i / Wl.cols) * Wl.pitch
			well(f, cx, cy, Wl.sw, Wl.sw, ch)
			if (ch === s.back) {
				blit.fill(f, cx + Wl.sw - 6 * u, cy + Wl.sw - 6 * u, 5 * u, 5 * u, C.line),
					blit.fill(f, cx + Wl.sw - 5 * u, cy + Wl.sw - 5 * u, 3 * u, 3 * u, C.hi)
			}
			if (ch === s.fore) {
				box(f, cx - 2 * u, cy - 2 * u, Wl.sw + 4 * u, Wl.sw + 4 * u, u)
				box(f, cx - u, cy - u, Wl.sw + 2 * u, Wl.sw + 2 * u, u, C.lemon)
			}
			// where a colour dragged would go: a cherry bar on the side it comes in from
			if (s.drop === i) {
				blit.fill(
					f,
					s.from < i ? cx + Wl.sw + u : cx - 3 * u,
					cy - u,
					2 * u,
					Wl.sw + 2 * u,
					C.cherry,
				)
			}
			zone({
				x: cx - 1 * u,
				y: cy - 1 * u,
				w: Wl.pitch,
				h: Wl.pitch,
				act: "well",
				arg: ch,
				i,
				role: "button",
				label: `${label(ch)}${ch === s.fore ? ", in front" : ""}${
					ch === s.back ? ", behind" : ""
				}`,
			})
		})
		{
			const i = wells.length,
				cx = X + (i % Wl.cols) * Wl.pitch,
				cy = Wl.y + Math.floor(i / Wl.cols) * Wl.pitch
			blit.fill(f, cx, cy, Wl.sw, Wl.sw, C.hi)
			box(f, cx, cy, Wl.sw, Wl.sw, u, C.lo)
			art(
				f,
				ICONS.plus,
				{ k: fresh() ? C.line : C.dim },
				cx + Math.floor((Wl.sw - 9 * u) / 2),
				cy + Math.floor((Wl.sw - 9 * u) / 2),
				u,
			)
			zone({
				x: cx,
				y: cy,
				w: Wl.sw,
				h: Wl.sw,
				act: fresh() ? "add" : null,
				role: "button",
				label: "a new colour, cmd-k",
			})
		}
		// the colour in front, in hex: a click edits it
		const ht = s.fore === s.clear ? "clear" : `${s.fore}  #${hex(s.colors[s.fore])}`
		blit.text(f, X, G.hexy, ht, C.ink, undefined, undefined, F)
		zone({
			x: X,
			y: G.hexy - 2 * u,
			w: blit.measure(ht, F) + 4 * u,
			h: lh + 4 * u,
			act: "edit",
			role: "button",
			label: `in front, ${ht}; edit it`,
		})
		// what can be done to it: words, underlined, as links are
		if (s.fore !== s.clear) {
			let lx = X + PW
			for (
				const [t, what, about] of [[
					"Remove",
					"remove",
					"remove the colour in front: its pixels go clear",
				], ["Edit…", "edit", "edit the colour in front"]]
			) {
				const tw = blit.measure(t, F)
				lx -= tw
				blit.text(f, lx, G.hexy, t, C.ink, undefined, undefined, F)
				blit.fill(f, lx, G.hexy + lh, tw, u, C.lo)
				zone({
					x: lx - 4 * u,
					y: G.hexy - 2 * u,
					w: tw + 8 * u,
					h: lh + 4 * u,
					act: what,
					role: "button",
					label: about,
				})
				lx -= 12 * u
			}
		}
		// the colours painted with last
		const rt = "Recent", rw = blit.measure(rt, F) + 8 * u
		blit.text(f, X, G.recenty + Math.floor((16 * u - lh) / 2), rt, C.dim, undefined, undefined, F)
		s.recent.slice(0, Math.floor((PW - rw) / (17 * u))).forEach((ch, i) => {
			const cx = X + rw + i * 17 * u
			well(f, cx, G.recenty, 14 * u, 14 * u, ch)
			zone({
				x: cx,
				y: G.recenty,
				w: 14 * u,
				h: 14 * u,
				act: "well",
				arg: ch,
				i: -1,
				role: "button",
				label: `recent: ${label(ch)}`,
			})
		})
		// the layers, top first: an eye if shown, the one painted on lit
		head(f, X, G.layersy - th - 6 * u, PW, "Layers")
		const first = Math.max(
			0,
			Math.min(s.layers.length - G.seen, s.layers.length - 1 - s.cur - Math.floor(G.seen / 2)),
		)
		for (let k = 0; k < G.seen; k++) {
			const li = s.layers.length - 1 - (first + k), L = s.layers[li]
			if (!L) break
			const y = G.layersy + k * G.rl
			if (li === s.cur) blit.fill(f, X, y, PW, G.rl, C.lemon)
			box(f, X, y, PW, G.rl + u, li === s.cur ? 2 * u : u, li === s.cur ? C.line : C.lo)
			if (!L.hidden) {
				art(f, ICONS.eye, { k: C.line }, X + 6 * u, y + Math.floor((G.rl - 9 * u) / 2), u)
			}
			zone({
				x: X,
				y,
				w: 22 * u,
				h: G.rl,
				act: "eye",
				arg: li,
				role: "checkbox",
				label: `${L.name} shown, ${L.hidden ? "off" : "on"}`,
			})
			blit.text(
				f,
				X + 22 * u,
				y + 4 * u,
				fitted(L.name, PW - 30 * u, F),
				L.hidden ? C.dim : C.ink,
				undefined,
				undefined,
				F,
			)
			zone({
				x: X + 22 * u,
				y,
				w: PW - 22 * u,
				h: G.rl,
				act: "layer",
				arg: li,
				role: "button",
				label: `${L.name}${li === s.cur ? ", painted on" : ""}`,
			})
		}
		{
			let bx = X, y = G.layersy + G.seen * G.rl + 4 * u
			const one = s.layers.length < 2
			bx = toggle(f, bx, y, "plus", false, { act: "newlayer", label: "new layer, shift-n" }) - u
			bx = toggle(f, bx, y, "dup", false, { act: "dup", label: "duplicate layer, cmd-j" }) - u
			bx = toggle(f, bx, y, "minus", false, { act: "unlayer", label: "delete layer" }, !one) +
				8 * u
			bx = toggle(
				f,
				bx,
				y,
				"up",
				false,
				{ act: "raise", label: "move layer up, cmd-]" },
				s.cur < s.layers.length - 1,
			) - u
			toggle(
				f,
				bx,
				y,
				"down",
				false,
				{ act: "lower", label: "move layer down, cmd-[" },
				s.cur > 0,
			)
		}
		// what was done: a click goes back (or on) to there
		head(f, X, G.histy - th - 6 * u, PW, "History")
		v.history.forEach(([text, k, later], i) => {
			const y = G.histy + i * G.hl, now = k === s.undo.length
			if (now) blit.fill(f, X, y, PW, G.hl, C.lemon)
			blit.text(
				f,
				X + 6 * u,
				y + 2 * u,
				fitted(text, PW - 12 * u, F),
				later ? C.dim : C.ink,
				undefined,
				undefined,
				F,
			)
			zone({
				x: X,
				y,
				w: PW,
				h: G.hl,
				act: "history",
				arg: k,
				role: "button",
				label: `${text}${now ? ", now" : later ? ", undone" : ""}`,
			})
		})

		// the footer: the readout (the plane's), how big, the layer, the selection; what happened at the right
		const fy = H - foot
		blit.fill(f, G.ro.x + G.ro.w, fy, W - G.ro.w, foot, C.chrome)
		blit.fill(f, 0, fy, W, u, C.line)
		if (!v.ready) blit.fill(f, G.ro.x, G.ro.y, G.ro.w, G.ro.h, C.chrome)
		const facts = [
			`${pw()} × ${ph()}`,
			s.layers.length > 1 ? layer().name : null,
			s.sel ? `selected ${s.sel.w} × ${s.sel.h}${fl ? ", floating" : ""}` : null,
		].filter(Boolean).join("   ")
		const end = blit.text(
			f,
			G.ro.w + 10 * u,
			fy + 5 * u,
			fitted(facts, W / 2 - G.ro.w, F),
			C.ink,
			undefined,
			undefined,
			F,
		)
		if (s.note) {
			const text = fitted(s.note[0], Math.max(0, W - end - 24 * u), F)
			blit.text(
				f,
				W - 10 * u - blit.measure(text, F),
				fy + 5 * u,
				text,
				s.note[1],
				undefined,
				undefined,
				F,
			)
		}
		if (s.dialog) sheet(f)
		return f.ops
	}

	// a dialog, as System 7's: a box on top, its fields, presets or an anchor, Cancel and the default button
	const sheet = (f) => {
		const d = s.dialog, lh = blit.height(F), fh = lh + 8 * u, bh = blit.height(FT) + 8 * u
		const extra = d.presets
			? lh + 4 * u + bh + 14 * u
			: d.anchor !== undefined
			? lh + 4 * u + 3 * 16 * u + 14 * u
			: 0
		const w = Math.min(W - 40 * u, 380 * u),
			h = 20 * u + lh + 12 * u + d.fields.length * (lh + fh + 14 * u) + extra + bh + 24 * u
		const x = Math.floor((W - w) / 2), y = Math.max(TOP() + 10 * u, Math.floor((H - h) / 3))
		// everything under it takes no clicks
		zones = [{ x: 0, y: 0, w: W, h: H, act: null }]
		blit.fill(f, x + 3 * u, y + 3 * u, w, h, C.line)
		blit.fill(f, x, y, w, h, C.paper)
		box(f, x, y, w, h, 2 * u)
		blit.frame(f, x + 4 * u, y + 4 * u, w - 8 * u, h - 8 * u, C.line)
		let fy = y + 16 * u
		// a colour's dialog shows the colour as typed so far
		const c = d.swatch ? parse(d.fields[0].text) : null
		const tw = d.swatch ? w - 32 * u - 30 * u : w - 16 * u
		blit.text(f, x + 16 * u, fy, d.title, C.ink, undefined, { x, y, w: tw, h }, FT)
		if (d.swatch) {
			const sx = x + w - 16 * u - 22 * u, sy = fy - 2 * u
			if (c !== null) blit.fill(f, sx, sy, 22 * u, 22 * u, c)
			else {blit.tile(f, sx, sy, 22 * u, 22 * u, checks(4 * u), "copy", {
					x: sx,
					y: sy,
					w: 22 * u,
					h: 22 * u,
				})}
			box(f, sx, sy, 22 * u, 22 * u)
		}
		fy += lh + 12 * u
		s.caret = null
		d.fields.forEach((field, i) => {
			blit.text(f, x + 16 * u, fy, field.label, C.dim, undefined, undefined, F)
			fy += lh + 4 * u
			const b = { x: x + 16 * u, y: fy, w: w - 32 * u, h: fh }
			blit.fill(f, b.x, b.y, b.w, b.h, C.line)
			blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi)
			const clip = { x: b.x + u, y: b.y, w: b.w - 2 * u, h: b.h }
			// the text from where the caret shows, the selection on lemon, the caret at pos (a readline field)
			const on = i === d.at, t = field.text, room = b.w - 12 * u
			let from = 0
			while (on && from < field.pos && blit.measure(t.slice(from, field.pos), F) > room) from++
			const xAt = (k) => b.x + 6 * u + blit.measure(t.slice(from, Math.max(from, k)), F)
			const sel = on ? readline.selection(field) : null
			if (sel) {
				blit.fill(
					f,
					xAt(sel[0]),
					b.y + 3 * u,
					Math.max(u, xAt(sel[1]) - xAt(sel[0])),
					lh + 2 * u,
					C.lemon,
					clip,
				)
			}
			blit.text(f, b.x + 6 * u, b.y + 4 * u, t.slice(from), C.ink, undefined, clip, F)
			if (on) {
				const cx = Math.min(b.x + b.w - 4 * u, xAt(field.pos))
				blit.fill(f, cx, b.y + 4 * u, 2 * u, lh, C.rose)
				s.caret = { text: t, pos: field.pos, x: cx, y: b.y + 4 * u, h: lh }
			}
			zone({
				...b,
				act: "field",
				arg: i,
				from,
				role: "textfield",
				label: field.label,
				value: field.text,
			})
			fy += fh + 10 * u
		})
		if (d.presets) {
			blit.text(f, x + 16 * u, fy, "Square, in pixels", C.dim, undefined, undefined, F)
			fy += lh + 4 * u
			let bx = x + 16 * u
			for (const n of d.presets) {
				bx = button(f, bx, fy, String(n), "preset", true, false, { arg: n }) + 6 * u
			}
		}
		if (d.anchor !== undefined) {
			blit.text(f, x + 16 * u, fy, "Where the picture stays", C.dim, undefined, undefined, F)
			fy += lh + 4 * u
			for (let k = 0; k < 9; k++) {
				const ax = x + 16 * u + (k % 3) * 16 * u, ay = fy + Math.floor(k / 3) * 16 * u
				blit.fill(f, ax, ay, 15 * u, 15 * u, k === d.anchor ? C.line : C.hi)
				box(f, ax, ay, 15 * u, 15 * u)
				zone({
					x: ax,
					y: ay,
					w: 15 * u,
					h: 15 * u,
					act: "anchor",
					arg: k,
					role: "radio",
					label: `anchor ${k}${k === d.anchor ? ", chosen" : ""}`,
				})
			}
		}
		const by = y + h - bh - 14 * u
		const okw = blit.measure(d.ok, FT) + 20 * u, cw = blit.measure("Cancel", FT) + 20 * u
		button(f, x + w - 20 * u - okw, by, d.ok, "ok", true, true)
		button(f, x + w - 20 * u - okw - 16 * u - cw, by, "Cancel", "cancel")
		if (d.error) {
			blit.text(
				f,
				x + 16 * u,
				by + 4 * u,
				fitted(d.error, w - okw - cw - 70 * u, F),
				C.cherry,
				undefined,
				undefined,
				F,
			)
		}
	}

	// to VoiceOver: what each zone is; and while a field is typed in, where its caret is, for input methods
	const meaning = () => ({
		access: [{
			role: "group",
			label: `paint ${path.at(-1)}`,
			x: 0,
			y: 0,
			w: W,
			h: H,
			children: [
				...zones.filter((z) => z.role).map(({ x, y, w, h, role, label, value }) => ({
					role,
					label,
					value,
					x,
					y,
					w,
					h,
				})),
				{
					role: "image",
					label: `the picture, ${Math.round((G.sc / u) * 100)}%`,
					x: G.ox,
					y: G.oy,
					w: pw() * G.sc,
					h: ph() * G.sc,
				},
			],
		}],
		input: s.dialog && s.caret
			? {
				text: s.caret.text,
				selection: [s.caret.pos, s.caret.pos],
				caret: { x: s.caret.x, y: s.caret.y, w: 2 * u, h: s.caret.h },
			}
			: null,
	})

	// --- the menus: each item what it does, the chord shown, and the chords that do it (/programs/wmii draws them,
	// and the Mac's menu bar shows them; a choice calls on/menu with what)
	const MENUS = () => [
		["File", [
			["New Picture…", "cmd-n", "new", ["s-n"]],
			["Save", "cmd-s", "save", ["s-s"], s.modified || s.base.missing || s.base.wrong],
			["Revert to Saved", null, "revert", [], s.modified && !s.base.missing],
			"-",
			["Close", "cmd-w", null],
		]],
		["Edit", [
			[
				s.undo.length ? `Undo ${s.undo.at(-1).label}` : "Undo",
				"cmd-z",
				"undo",
				["s-z"],
				s.undo.length > 0 || !!fl,
			],
			[s.redo.length ? `Redo ${s.redo.at(-1).label}` : "Redo", "cmd-shift-z", "redo", [
				"S-s-z",
				"s-y",
			], s.redo.length > 0],
			"-",
			["Cut", "cmd-x", "cut", ["s-x"], !!s.sel],
			["Copy", "cmd-c", "copy", ["s-c"]],
			["Paste", "cmd-v", "paste", ["s-v"]],
			["Clear", "delete", "clear", ["backspace", "delete"], !!s.sel],
			"-",
			["Select All", "cmd-a", "all", ["s-a"]],
			["Deselect", "cmd-d", "none", ["s-d", "escape"], !!s.sel],
			["Crop to Selection", null, "crop", [], !!s.sel],
		]],
		["Image", [
			[s.sel ? "Flip Selection Across" : "Flip Across", "shift-h", "fliph", ["S-h"]],
			[s.sel ? "Flip Selection Down" : "Flip Down", "shift-v", "flipv", ["S-v"]],
			[s.sel ? "Turn Selection Right" : "Turn Right", "shift-r", "right", ["S-r"]],
			[s.sel ? "Turn Selection Left" : "Turn Left", "shift-l", "left", ["S-l"]],
			"-",
			["Canvas Size…", "cmd-alt-c", "canvas", ["A-s-c"]],
			[s.hot ? "Remove Hot Spot" : "Add Hot Spot", null, "hotspot"],
		]],
		["Layer", [
			["New Layer", "shift-n", "newlayer", ["S-n"]],
			["Duplicate Layer", "cmd-j", "dup", ["s-j"]],
			["Delete Layer", null, "unlayer", [], s.layers.length > 1],
			["Merge Down", "cmd-e", "merge", ["s-e"], s.cur > 0],
			"-",
			["Move Up", "cmd-]", "raise", ["s-bracketright"], s.cur < s.layers.length - 1],
			["Move Down", "cmd-[", "lower", ["s-bracketleft"], s.cur > 0],
			[layer()?.hidden ? "Show Layer" : "Hide Layer", null, "eye"],
			["Rename Layer…", null, "rename"],
		]],
		["Colour", [
			["Swap", "x", "swap", ["x"]],
			["Black and Clear", "d", "default", ["d"]],
			"-",
			["Edit Colour…", null, "edit", [], s.fore !== s.clear],
			["New Colour…", "cmd-k", "add", ["s-k"], !!fresh()],
			["Remove Colour", null, "remove", [], s.fore !== s.clear],
		]],
		["Tools", [
			...tools().map((
				[t, title, key],
			) => [title, key, "tool", [key, ...(t === "fill" ? ["f"] : [])], true, t]),
			"-",
			["Bigger Brush", "]", "bigger", ["bracketright"]],
			["Smaller Brush", "[", "smaller", ["bracketleft"]],
		]],
		["View", [
			["Zoom In", "cmd-+", "in", ["s-equal", "S-s-equal", "s-+", "S-s-+"]],
			["Zoom Out", "cmd--", "out", ["s-minus"]],
			["Fit in Window", "cmd-0", "fit", ["s-0"]],
			["Actual Size", "cmd-1", "actual", ["s-1"]],
			"-",
			[s.grid ? "Hide Grid" : "Show Grid", "cmd-'", "grid", ["s-quote"]],
			[s.mx ? "Stop Mirroring Across" : "Mirror Across", null, "mx"],
			[s.my ? "Stop Mirroring Down" : "Mirror Down", null, "my"],
		]],
	]
	// the chords: each to what it does
	const chords = () => {
		const out = {}
		for (const [, items] of MENUS()) {
			for (const it of items) {
				if (it !== "-" && it[2]) { for (const c of it[3] ?? []) out[c] = [it[2], it[5]] }
			}
		}
		return out
	}
	let menued = null
	const menus = (api) => {
		const value = MENUS().map(([title, items]) => ({
			title,
			items: items.map((it) =>
				it === "-" ? "-" : {
					label: it[0],
					...(it[1] ? { key: it[1] } : {}),
					...(it[2] ? { call: "menu", args: [it[2], ...(it[5] ? [it[5]] : [])] } : {}),
					...(it[4] === false ? { off: true } : {}),
				}
			),
		}))
		const text = JSON.stringify(value)
		if (text === menued) return
		menued = text
		if (idAt(api, [...me, "menus"])) api.write([...me, "menus"], whole(value))
		else make(api, me, "menus", value, { ephemeral: true })
	}

	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (60 + (n % 5) * 30) * u,
			y: (60 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: path.at(-1),
			owner: me,
			draw: [],
			drags: true,
		}, { ephemeral: true })
	}
	// until the driver has made the plane, and for what is said drawn a turn later, a handler a timer calls
	// (after), as its own part
	let waiting = null, stopped = false
	const ready = (g) =>
		using(g, () => {
			waiting = null
			if (stopped) return
			if (!shows) return refresh(g.api)
			tell()
		})
	// the readout, once the pointer has been still for 40 ms: a move since then is waited for again
	const settle = (g) =>
		using(g, () => {
			resting = null
			if (stopped || !pbits() || !G) return
			const more = 40 - (Date.now() - movedAt)
			if (more > 4) return void (resting = after(part, more, settle))
			readout()
			tell()
		})
	onCleanup(({ api }) => {
		stopped = true
		waiting?.(api)
		resting?.(api)
	})

	// the window as it is now: the plane drawn where it changed; the ops, menus and the plane whole if what they show changed
	let shows = false, shown = null
	const refresh = (api) => {
		if (!idAt(api, LAYER)) return
		// a change made, its undo kept, so the history says so
		if (!gesture) done()
		sized(api)
		lay()
		render()
		const v = ui(), sig = JSON.stringify(v)
		if (sig === shown && shows) return tell()
		menus(api)
		const ops = draw(v)
		const m = meaning()
		const pv = p.value(api)
		shows = !!pv
		shown = sig
		dirt = []
		later = []
		if (!pv && !waiting) waiting = after(part, 30, ready)
		// the plane as a whole, no dirty: its ops changed with it
		api.write(LAYER, [
			...key("w", W),
			...key("h", H),
			...key("draw", ops),
			...key("access", m.access),
			...key("input", m.input),
			...key("title", `${path.at(-1)}${s.modified ? " •" : ""}`),
			...key("plane", pv),
		])
	}

	// --- doing

	const why = (
		e,
	) => (e.code === "refused"
		? "refused by a rule: go stack> to see /etc/rules"
		: `${e.code ?? "error"}: ${e.message}`)
	const say = (text, c = C.dim) => (s.note = [text, c])
	const save = (api) => {
		putdown()
		done()
		// what the node held, every field kept, with what was painted over it
		const value = {
			...(isPicture(s.base.value) ? s.base.value : {}),
			kind: "picture",
			colors: { ...s.colors },
			rows: [...s.rows],
		}
		if (s.hot) value.hot = [...s.hot]
		else delete value.hot
		if (s.layers.length > 1) {
			value.layers = s.layers.map((l) => ({
				name: l.name,
				rows: [...l.rows],
				...(l.hidden ? { hidden: true } : {}),
			}))
		} else delete value.layers
		try {
			if (idAt(api, NODE)) api.write(NODE, whole(value))
			else if (!make(api, NODE.slice(0, -1), NODE.at(-1), value)) {
				throw new Error("nothing is there to put it in")
			}
			s.modified = false
			saved = { n: s.undo.length, top: s.undo.at(-1) }
			s.base = load(api)
			say(`saved, t=${s.base.time}`, C.ok)
		} catch (e) {
			say(why(e), C.cherry)
		}
	}
	// a dialog is data, so the view holds it: act names its answer (answers), ch the colour it is about
	const ask = (act, title, ok, fields, more = {}) => {
		s.dialog = {
			act,
			title,
			ok,
			fields: fields.map(([label, text]) => ({
				label,
				text,
				pos: text.length,
				mark: text ? 0 : null,
			})),
			at: 0,
			error: null,
			swatch: false,
			...more,
		}
	}
	const count = (t, lo, hi) => {
		const n = Number(t)
		return Number.isInteger(n) && n >= lo && n <= hi ? n : null
	}
	// the colours of another picture, as letters of this one: the same colour's letter, or a new one
	const welcome = (v) => {
		const map = {}
		for (const [ch, c] of Object.entries(v.colors ?? {})) {
			if (typeof c !== "number") continue
			const mine = order().find((k) => s.colors[k] === c)
			if (mine) map[ch] = mine
			else {
				const k = fresh()
				if (!k) continue
				s.colors[k] = c
				map[ch] = k
			}
		}
		const w = Math.max(1, ...v.rows.map((r) => r.length))
		return v.rows.map((r) => Array.from({ length: w }, (_, i) => map[r[i]] ?? s.clear).join(""))
	}
	// a picture in the selection, as copied: the layer painted on, clear outside it
	const copied = (api) => {
		if (!s.sel) return null
		const rows = held(), used = new Set(rows.join(""))
		const colors = Object.fromEntries(Object.entries(s.colors).filter(([ch]) => used.has(ch)))
		const v = { kind: "picture", colors, rows }
		try {
			api.write(
				["/", "dev", "clip", "text"],
				whole({ text: JSON.stringify(v), count: 0, from: "paint" }),
			)
			if (idAt(api, ["/", "dev", "clip", "picture"])) {
				api.write(["/", "dev", "clip", "picture"], whole(v))
			} else make(api, ["/", "dev", "clip"], "picture", v, { ephemeral: true })
		} catch {
			// the clipboard's text, at least, was written; /dev/clip/picture is a courtesy
		}
		return v
	}
	const clipped = (api) => {
		try {
			const v = JSON.parse(val(api, ["/", "dev", "clip", "text"])?.text ?? "null")
			if (isPicture(v)) return v
		} catch {
			// not a picture as text
		}
		const v = val(api, ["/", "dev", "clip", "picture"])
		return isPicture(v) ? v : null
	}
	const clear = (label = "Clear") => {
		if (!s.sel) return
		if (fl) {
			// a floating selection let go of: what was under it, as it was
			unstamp()
			fl = null
			if (pending) pending.label = label
		} else {
			remember(label)
			const L = layer()
			for (let j = 0; j < s.sel.h; j++) {
				const y = s.sel.y + j
				if (y < 0 || y >= ph()) continue
				const t = L.rows[y].split("")
				for (let i = 0; i < s.sel.w; i++) {
					if (within(s.sel.x + i, y) && s.sel.x + i < pw()) t[s.sel.x + i] = s.clear
				}
				row(L, y, t.join(""))
			}
		}
		done()
	}
	const recent = (ch) => {
		if (ch === s.clear || !(ch in s.colors)) return
		s.recent = [ch, ...s.recent.filter((x) => x !== ch)].slice(0, 12)
	}
	// a layer's rows, all clear
	const blank = () => Array.from({ length: ph() }, () => s.clear.repeat(pw()))
	const restack = (label, f) => {
		putdown()
		remember(label)
		f()
		flatten()
		full()
		done()
	}
	const turned = (how) => {
		if (s.sel) {
			lift(false, how.startsWith("flip") ? "Flip" : "Turn")
			ants()
			unstamp()
			fl.rows = turn(fl.rows, how)
			const z = s.sel, w = fl.rows[0].length, h = fl.rows.length
			const mask = z.mask && turn(z.mask, how)
			s.sel = {
				x: z.x + Math.floor((z.w - w) / 2),
				y: z.y + Math.floor((z.h - h) / 2),
				w,
				h,
				mask,
			}
			restamp()
			ants()
			return
		}
		restack(how.startsWith("flip") ? "Flip" : "Turn", () => {
			const w = pw(), h = ph()
			for (const L of s.layers) L.rows = turn(L.rows, how)
			if (s.hot) {
				const [x, y] = s.hot
				s.hot = how === "fliph"
					? [w - 1 - x, y]
					: how === "flipv"
					? [x, h - 1 - y]
					: how === "right"
					? [h - 1 - y, x]
					: [y, w - 1 - x]
			}
		})
	}
	const choose = (t) => {
		if (t === s.tool || !tools().some(([x]) => x === t)) return
		if (t !== "marquee" && t !== "lasso") putdown()
		if (t === "dropper") s.prev = s.tool
		s.tool = t
	}
	const acts = {
		save,
		revert: (api) => {
			if (!s.modified) return
			putdown()
			remember("Revert")
			take(load(api))
			done()
			s.modified = false
			say("as it was saved")
		},
		new: () =>
			ask("new", "A new picture, beside this one:", "Make", [["Name", "untitled picture"], [
				"Width",
				String(pw()),
			], ["Height", String(ph())]], { presets: [8, 16, 32, 64, 128, 256] }),
		undo: () => {
			const t = back(s.undo, s.redo)
			say(t ? `undid ${t}` : "nothing to undo")
		},
		redo: () => {
			const t = back(s.redo, s.undo)
			say(t ? `did ${t} again` : "nothing to redo")
		},
		copy: (api) => {
			if (!s.sel) {
				s.sel = { x: 0, y: 0, w: pw(), h: ph(), mask: null }
				copied(api)
				s.sel = null
			} else copied(api)
			say("copied")
		},
		cut: (api) => {
			if (!s.sel) return
			copied(api)
			clear("Cut")
			say("cut")
		},
		paste: (api) => {
			const v = clipped(api)
			if (!v) return say("nothing to paste: copy a selection first")
			putdown()
			remember("Paste")
			const rows = welcome(v), w = rows[0].length, h = rows.length
			// in the middle of what the room shows of the picture
			const R = G.room, cx = (R.x + R.w / 2 - G.ox) / G.sc, cy = (R.y + R.h / 2 - G.oy) / G.sc
			const x = Math.max(0, Math.min(Math.round(cx - w / 2), pw() - w)),
				y = Math.max(0, Math.min(Math.round(cy - h / 2), ph() - h))
			ants()
			s.sel = { x, y, w, h, mask: null }
			fl = { id: layer().id, base: layer().rows.slice(), rows }
			restamp()
			ants()
			full()
			if (s.tool !== "marquee" && s.tool !== "lasso") s.tool = "marquee"
			say(`pasted ${w} × ${h}: drag it where it goes`)
		},
		clear: () => clear(),
		all: () => {
			putdown()
			ants()
			s.sel = { x: 0, y: 0, w: pw(), h: ph(), mask: null }
			ants()
		},
		none: () => {
			putdown()
			ants()
			s.sel = null
		},
		crop: () => {
			if (!s.sel) return
			const z = s.sel
			restack("Crop", () => {
				for (const L of s.layers) {
					L.rows = Array.from(
						{ length: z.h },
						(_, j) =>
							(L.rows[z.y + j] ?? "").slice(Math.max(0, z.x), z.x + z.w).padEnd(
								z.w,
								s.clear,
							),
					)
				}
				if (s.hot) {
					s.hot = [
						Math.max(0, Math.min(s.hot[0] - z.x, z.w - 1)),
						Math.max(0, Math.min(s.hot[1] - z.y, z.h - 1)),
					]
				}
				s.sel = null
				s.center = null
			})
		},
		fliph: () => turned("fliph"),
		flipv: () => turned("flipv"),
		right: () => turned("right"),
		left: () => turned("left"),
		canvas: () =>
			ask("canvas", "The canvas, in pixels:", "Change", [["Width", String(pw())], [
				"Height",
				String(ph()),
			]], { anchor: 0 }),
		hotspot: () => {
			restack(s.hot ? "Remove Hot Spot" : "Add Hot Spot", () => (s.hot = s.hot ? null : [0, 0]))
			if (s.hot) s.tool = "hot"
			else if (s.tool === "hot") s.tool = "pencil"
		},
		newlayer: () =>
			restack("New Layer", () => {
				const id = Math.max(0, ...s.layers.map((l) => l.id)) + 1
				s.layers.splice(s.cur + 1, 0, { id, name: `Layer ${id}`, hidden: false, rows: blank() })
				s.cur += 1
			}),
		dup: () =>
			restack("Duplicate Layer", () => {
				const id = Math.max(0, ...s.layers.map((l) => l.id)) + 1, L = layer()
				s.layers.splice(s.cur + 1, 0, {
					id,
					name: `${L.name} copy`,
					hidden: L.hidden,
					rows: L.rows.slice(),
				})
				s.cur += 1
			}),
		unlayer: () => {
			if (s.layers.length < 2) return
			restack("Delete Layer", () => {
				s.layers.splice(s.cur, 1)
				s.cur = Math.max(0, s.cur - 1)
			})
		},
		merge: () => {
			if (s.cur < 1) return
			restack("Merge Down", () => {
				const top = layer(), under = s.layers[s.cur - 1]
				under.rows = under.rows.map((r, y) =>
					Array.from(
						r,
						(ch, x) => (typeof s.colors[top.rows[y][x]] === "number" && !top.hidden
							? top.rows[y][x]
							: ch),
					).join("")
				)
				s.layers.splice(s.cur, 1)
				s.cur -= 1
			})
		},
		raise: () => {
			if (s.cur >= s.layers.length - 1) return
			restack("Move Layer Up", () => {
				const L = s.layers.splice(s.cur, 1)[0]
				s.layers.splice(++s.cur, 0, L)
			})
		},
		lower: () => {
			if (s.cur < 1) return
			restack("Move Layer Down", () => {
				const L = s.layers.splice(s.cur, 1)[0]
				s.layers.splice(--s.cur, 0, L)
			})
		},
		eye: (api, i = s.cur) => {
			const L = s.layers[i]
			if (L) restack(L.hidden ? "Show Layer" : "Hide Layer", () => (L.hidden = !L.hidden))
		},
		rename: () => ask("rename", "The layer's name:", "Rename", [["Name", layer().name]]),
		swap: () => ([s.fore, s.back] = [s.back, s.fore]),
		default: () => {
			s.fore = order().find((ch) => s.colors[ch] === 0x000000 || s.colors[ch] === C.line) ??
				order()[0] ?? s.clear
			s.back = s.clear
		},
		edit: () => {
			if (s.fore === s.clear) return say("clear has no colour to edit: take another")
			ask("colour", `The colour ${s.fore}, as RRGGBB:`, "Change", [[
				"Hex",
				hex(s.colors[s.fore]),
			]], { swatch: true, ch: s.fore })
		},
		add: () => {
			const ch = fresh()
			if (!ch) return say("no letter is left for another colour", C.cherry)
			ask(
				"add",
				"A new colour, as RRGGBB:",
				"Add",
				[["Hex", hex(s.colors[s.fore] ?? 0x1c1a17)]],
				{ swatch: true, ch },
			)
		},
		remove: () => {
			const ch = s.fore
			if (ch === s.clear) return
			restack("Remove Colour", () => {
				delete s.colors[ch]
				for (const L of s.layers) L.rows = L.rows.map((r) => r.split(ch).join(s.clear))
				hands()
			})
			say(`${ch} removed: its pixels are clear`)
		},
		tool: (api, t) => choose(t),
		bigger: () => (s.size = Math.min(32, s.size + 1)),
		smaller: () => (s.size = Math.max(1, s.size - 1)),
		shape: (api, t) => (s.shape = t),
		perfect: () => (s.perfect = !s.perfect),
		filled: () => (s.filled = !s.filled),
		contiguous: () => (s.contiguous = !s.contiguous),
		in: () => zoomBy(1),
		out: () => zoomBy(-1),
		fit: () => {
			s.zoom = null
			s.center = null
			full()
		},
		actual: () => zoomTo(1),
		grid: () => {
			s.grid = !s.grid
			full()
		},
		mx: () => {
			s.mx = !s.mx
			full()
		},
		my: () => {
			s.my = !s.my
			full()
		},
		history: (api, k) => {
			while (s.undo.length > k && s.undo.length) back(s.undo, s.redo)
			while (s.undo.length < k && s.redo.length) back(s.redo, s.undo)
			s.note = null
		},
	}
	const act = (api, what, arg) => {
		try {
			acts[what]?.(api, arg)
		} catch (e) {
			say(why(e), C.cherry)
		}
	}
	// each dialog's OK: null closes it, a string is what is wrong
	const answers = {
		canvas: (api, [w, h], d) => {
			const nw = count(w, 1, MAX), nh = count(h, 1, MAX)
			if (!nw || !nh) return `whole numbers from 1 to ${MAX}, please`
			if (nw === pw() && nh === ph()) return null
			restack("Canvas Size", () => resize(nw, nh, d.anchor))
			say(`${nw} × ${nh}`)
			return null
		},
		new: (api, [n, w, h]) => {
			const nw = count(w, 1, MAX), nh = count(h, 1, MAX)
			if (!n || n.includes("/")) return "a name, with no /"
			if (!nw || !nh) return `whole numbers from 1 to ${MAX}, please`
			const at = ["/", ...path.slice(0, -1)]
			if (idAt(api, [...at, n])) return `${n} is already there`
			const clear = clearOf(s.colors, [])
			if (
				!make(api, at, n, {
					kind: "picture",
					colors: { ...s.colors },
					rows: Array.from({ length: nh }, () => clear.repeat(nw)),
				})
			) return `nothing is at ${at.join("/")} to make it in`
			const op = {
				address: ["/", "apps", "paint"],
				program: ["programs", "paint"],
				data: { path: [...path.slice(0, -1), n] },
			}
			const launch = val(api, ["/", "dev", "wm", "launch"])
			if (Array.isArray(launch)) part.call(launch, [op])
			else {
				const { data: what, ...rest } = op
				api.insert(part.start(rest), "data", api.create(what))
			}
			say(`made ${n}`)
			return null
		},
		rename: (api, [n]) => {
			if (!n) return "a name, please"
			if (n !== layer().name) restack("Rename Layer", () => (layer().name = n))
			return null
		},
		colour: (api, [t], { ch }) => {
			const c = parse(t)
			if (c === null) return "six hex digits, as d2244a"
			if (c !== s.colors[ch]) restack("Edit Colour", () => (s.colors[ch] = c))
			return null
		},
		add: (api, [t], { ch }) => {
			const c = parse(t)
			if (c === null) return "six hex digits, as d2244a"
			restack("New Colour", () => (s.colors[ch] = c))
			s.fore = ch
			if (s.tool === "eraser" || s.tool === "dropper") s.tool = "pencil"
			say(`${ch} is #${hex(c)}`)
			return null
		},
	}
	const answer = (api, ok) => {
		const d = s.dialog
		if (!ok) return void (s.dialog = null)
		try {
			d.error = answers[d.act]?.(api, d.fields.map((x) => x.text.trim()), d) ?? null
		} catch (e) {
			d.error = why(e)
		}
		if (!d.error) s.dialog = null
	}
	// a colour moved in the palette, from place i to place j: its letter and those between change places in every row
	const reorder = (i, j) => {
		const L = order(), moved = L.slice()
		moved.splice(j, 0, moved.splice(i, 1)[0])
		const map = {}, colors = {}
		L.forEach((ch, k) => {
			map[moved[k]] = ch
			colors[ch] = s.colors[moved[k]]
		})
		restack("Reorder Colours", () => {
			s.colors = colors
			relabel(map)
		})
	}

	// --- the pointer: a click on a zone does what it says; in the room, the tool in hand

	let space = false, last = null
	const painting = (t) =>
		["pencil", "brush", "eraser", "line", "rect", "ellipse", "fill"].includes(t)
	const begin = (r) => {
		const mods = r.mods ?? [],
			right = r.button === 1 || mods.includes("ctrl"),
			pt = pixel(r.x, r.y)
		if (space || s.tool === "hand" || r.button === 2) {
			return void (gesture = {
				kind: "pan",
				from: [r.x, r.y],
				center: [
					(G.room.x + G.room.w / 2 - G.ox) / G.sc,
					(G.room.y + G.room.h / 2 - G.oy) / G.sc,
				],
			})
		}
		const tool =
			mods.includes("alt") && painting(s.tool) && !["line", "rect", "ellipse"].includes(s.tool)
				? "dropper"
				: s.tool
		if (painting(tool)) {
			if (layer().hidden) return say("this layer is hidden: show it to paint on it", C.cherry)
			putdown()
			const ch = tool === "eraser" ? s.clear : right ? s.back : s.fore
			recent(ch)
			remember(named(tool))
			if (tool === "fill") {
				for (const [x, y] of mirrors(...pt)) fill(x, y, ch)
				return
			}
			const g = {
				kind: tool === "pencil" || tool === "brush" || tool === "eraser" ? "paint" : "shape",
				tool,
				ch,
				from: pt,
				to: pt,
				base: layer().rows.slice(),
				pts: [],
				span: null,
			}
			gesture = g
			if (g.kind === "shape") return reshape(g, mods)
			const n = tool === "pencil" ? 1 : s.size
			const go = (x, y) => (tool === "pencil" ? pencil(g, x, y) : stamp(x, y, ch, n))
			if (mods.includes("shift") && last) bresenham(last[0], last[1], pt[0], pt[1], go)
			else go(...pt)
			g.last = pt
			return
		}
		if (tool === "dropper") {
			if (pt[0] < 0 || pt[1] < 0 || pt[0] >= pw() || pt[1] >= ph()) return
			const ch = paints(s.rows[pt[1]][pt[0]])
			if (right) s.back = ch
			else s.fore = ch
			say(`${right ? "behind" : "in front"}: ${label(ch)}`)
			// the dropper chosen as a tool goes back to the one before, as MacPaint's does
			if (s.tool === "dropper") s.tool = s.prev && s.prev !== "dropper" ? s.prev : "pencil"
			return
		}
		if (tool === "marquee" || tool === "lasso") {
			const z = s.sel
			const onit = z && pt[0] >= z.x && pt[1] >= z.y && pt[0] < z.x + z.w && pt[1] < z.y + z.h &&
				(!z.mask || z.mask[pt[1] - z.y][pt[0] - z.x] === "#")
			if (onit) {
				if (layer().hidden) return say("this layer is hidden: show it to move on it", C.cherry)
				// option: a copy, the selection put down first
				if (mods.includes("alt")) {
					putdown()
					lift(true, "Copy")
				} else lift(false)
				gesture = { kind: "move", from: pt, at: [z.x, z.y], moved: false }
				return
			}
			putdown()
			ants()
			s.sel = null
			if (tool === "marquee") gesture = { kind: "select", from: pt, moved: false }
			else gesture = { kind: "lasso", pts: [[(r.x - G.ox) / G.sc, (r.y - G.oy) / G.sc]] }
			return
		}
		if (tool === "hot" && s.hot) {
			remember("Hot Spot")
			gesture = { kind: "hot" }
			move({ ...r })
		}
	}
	const move = (r) => {
		const g = gesture, mods = r.mods ?? [], pt = pixel(r.x, r.y)
		hover = pt
		if (g.kind === "pan") {
			s.zoom ??= G.sc / u
			s.center = [g.center[0] - (r.x - g.from[0]) / G.sc, g.center[1] - (r.y - g.from[1]) / G.sc]
			clampCenter()
			return lay()
		}
		if (g.kind === "paint") {
			if (pt[0] === g.last[0] && pt[1] === g.last[1]) return
			const n = g.tool === "pencil" ? 1 : s.size
			bresenham(
				g.last[0],
				g.last[1],
				pt[0],
				pt[1],
				(
					x,
					y,
				) => (g.tool === "pencil"
					? pencil(g, x, y)
					: (x !== g.last[0] || y !== g.last[1]) && stamp(x, y, g.ch, n)),
			)
			g.last = pt
			return
		}
		if (g.kind === "shape") {
			if (
				pt[0] === g.to[0] && pt[1] === g.to[1] &&
				JSON.stringify(mods) === JSON.stringify(g.mods ?? [])
			) return
			g.to = pt
			g.mods = mods
			return reshape(g, mods)
		}
		if (g.kind === "select") {
			let [x1, y1] = pt
			if (mods.includes("shift")) {
				const n = Math.max(Math.abs(x1 - g.from[0]), Math.abs(y1 - g.from[1]))
				x1 = g.from[0] + Math.sign(x1 - g.from[0] || 1) * n
				y1 = g.from[1] + Math.sign(y1 - g.from[1] || 1) * n
			}
			const x0 = Math.max(0, Math.min(g.from[0], x1)), y0 = Math.max(0, Math.min(g.from[1], y1))
			const xe = Math.min(pw(), Math.max(g.from[0], x1) + 1),
				ye = Math.min(ph(), Math.max(g.from[1], y1) + 1)
			ants()
			g.moved ||= pt[0] !== g.from[0] || pt[1] !== g.from[1]
			s.sel = xe > x0 && ye > y0 ? { x: x0, y: y0, w: xe - x0, h: ye - y0, mask: null } : null
			ants()
			return
		}
		if (g.kind === "lasso") {
			const q = [(r.x - G.ox) / G.sc, (r.y - G.oy) / G.sc], l = g.pts.at(-1)
			if (Math.hypot(q[0] - l[0], q[1] - l[1]) < 0.5) return
			g.pts.push(q)
			mark(
				cellsBox(
					Math.floor(Math.min(q[0], l[0])) - 1,
					Math.floor(Math.min(q[1], l[1])) - 1,
					Math.ceil(Math.max(q[0], l[0])) + 1,
					Math.ceil(Math.max(q[1], l[1])) + 1,
				),
			)
			return
		}
		if (g.kind === "move") {
			const x = g.at[0] + pt[0] - g.from[0], y = g.at[1] + pt[1] - g.from[1]
			if (x !== s.sel.x || y !== s.sel.y) {
				g.moved = true
				slide(x, y)
			}
			return
		}
		if (
			g.kind === "hot" && pt[0] >= 0 && pt[1] >= 0 && pt[0] < pw() && pt[1] < ph() &&
			(s.hot[0] !== pt[0] || s.hot[1] !== pt[1])
		) {
			mark(ringBox())
			s.hot = pt
			s.modified = true
			mark(ringBox())
		}
	}
	const end = () => {
		const g = gesture
		gesture = null
		if (!g) return
		if (g.kind === "paint" || g.kind === "shape") {
			last = g.kind === "paint" ? g.last : g.to
			if (g.preview) preview()
		}
		if (g.kind === "select" && !g.moved) {
			ants()
			s.sel = null
		}
		if (g.kind === "lasso") {
			// the pixels whose middles are inside the line drawn, odd crossings in
			const q = g.pts
			const x0 = Math.max(0, Math.floor(Math.min(...q.map((a) => a[0])))),
				x1 = Math.min(pw(), Math.ceil(Math.max(...q.map((a) => a[0]))))
			const y0 = Math.max(0, Math.floor(Math.min(...q.map((a) => a[1])))),
				y1 = Math.min(ph(), Math.ceil(Math.max(...q.map((a) => a[1]))))
			const mask = []
			let any = false
			for (let y = y0; y < y1; y++) {
				let t = ""
				for (let x = x0; x < x1; x++) {
					const cx = x + 0.5, cy = y + 0.5
					let inside = false
					for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
						const [ax, ay] = q[i], [bx, by] = q[j]
						if (ay > cy !== by > cy && cx < ((bx - ax) * (cy - ay)) / (by - ay) + ax) {
							inside = !inside
						}
					}
					t += inside ? "#" : "."
					any ||= inside
				}
				mask.push(t)
			}
			full()
			s.sel = any
				? {
					x: x0,
					y: y0,
					w: x1 - x0,
					h: y1 - y0,
					mask: mask.every((r) => !r.includes(".")) ? null : mask,
				}
				: null
		}
		if (g.kind === "move" && !g.moved && !fl) s.sel = null
	}

	handler(given, "pointer", (g) =>
		using(g, () => {
			const { api } = g, [recs] = g.args
			for (const r of recs) {
				if (r.event === "scroll") {
					if (
						s.dialog || r.x < G.room.x || r.y < G.room.y || r.x >= G.room.x + G.room.w ||
						r.y >= G.room.y + G.room.h
					) continue
					const mods = r.mods ?? []
					// cmd or option and the wheel zooms about the pointer; the wheel alone moves the picture
					if (mods.includes("cmd") || mods.includes("alt") || mods.includes("ctrl")) {
						if (Math.abs(r.dy) >= 1) zoomBy(-Math.sign(r.dy), r.x, r.y)
					} else {
						s.zoom ??= G.sc / u
						s.center = [
							(G.room.x + G.room.w / 2 - G.ox) / G.sc + (r.dx ?? 0) / G.sc,
							(G.room.y + G.room.h / 2 - G.oy) / G.sc + (r.dy ?? 0) / G.sc,
						]
						clampCenter()
						lay()
					}
					hover = pixel(r.x, r.y)
					continue
				}
				if (r.event === "up") {
					if (gesture?.kind === "swatch") {
						const g = gesture
						gesture = null
						if (s.drop !== null && s.drop !== g.i) reorder(g.i - 1, s.drop - 1)
						s.drop = null
						s.from = null
					} else end()
					continue
				}
				if (r.event === "move" && gesture) {
					if (gesture.kind === "swatch") {
						const z = [...zones].reverse().find((z) =>
							z.act === "well" && z.i > 0 && r.x >= z.x && r.x < z.x + z.w && r.y >= z.y &&
							r.y < z.y + z.h
						)
						s.drop = z && z.i !== gesture.i ? z.i : null
						s.from = gesture.i
					} else if (gesture.kind === "look") {
						const P = G.pv
						s.zoom ??= G.sc / u
						s.center = [(r.x - P.ox) / P.s, (r.y - P.oy) / P.s]
						clampCenter()
						lay()
					} else move(r)
					continue
				}
				if (r.event !== "down") continue
				const z = [...zones].reverse().find((z) =>
					r.x >= z.x && r.x < z.x + z.w && r.y >= z.y && r.y < z.y + z.h
				)
				if (!z) continue
				if (!s.dialog && z.act !== "room") s.note = null
				const now = Date.now(),
					twice = s.click.key === `${z.act} ${z.arg}` && now - s.click.t < 500
				s.click = { key: `${z.act} ${z.arg}`, t: twice ? 0 : now }
				if (z.act === "room") {
					s.note = null
					begin(r)
				} else if (z.act === "well") {
					// a click takes it in front (the right button, behind); two edit it; a drag moves it in the palette
					const right = r.button === 1 || r.mods?.includes("ctrl")
					if (right) s.back = z.arg
					else s.fore = z.arg
					if (
						s.tool === "dropper" || (s.tool === "eraser" && z.arg !== s.clear) ||
						s.tool === "hand" || s.tool === "marquee" || s.tool === "lasso"
					) {
						s.tool = s.tool === "dropper"
							? s.prev ?? "pencil"
							: s.tool === "eraser"
							? "pencil"
							: s.tool
					}
					if (twice && !right) act(api, "edit")
					else if (z.i > 0) gesture = { kind: "swatch", i: z.i }
				} else if (z.act === "layer") {
					putdown()
					s.cur = z.arg
					if (twice) act(api, "rename")
				} else if (z.act === "look") {
					gesture = { kind: "look" }
					const P = G.pv
					s.zoom ??= G.sc / u
					s.center = [(r.x - P.ox) / P.s, (r.y - P.oy) / P.s]
					clampCenter()
					lay()
				} else if (z.act === "field") {
					// the caret where the click is
					const x = s.dialog.fields[z.arg]
					s.dialog.at = z.arg
					Object.assign(x, {
						pos: z.from + blit.at(x.text.slice(z.from), r.x - z.x - 6 * u, F),
						mark: null,
					})
				} else if (z.act === "preset") {
					s.dialog.fields[1].text = s.dialog.fields[2].text = String(z.arg)
					for (const x of s.dialog.fields.slice(1)) {
						Object.assign(x, { pos: x.text.length, mark: null })
					}
				} else if (z.act === "anchor") {
					s.dialog.anchor = z.arg
				} else if (z.act === "ok" || z.act === "cancel") answer(api, z.act === "ok")
				else if (z.act) act(api, z.act, z.arg)
			}
			refresh(api)
			keep(api)
		}))

	// the pointer passing over the window: the pixel under it ringed, and said in the readout; nothing written but the plane
	handler(given, "hover", (g) =>
		using(g, () => {
			const [recs] = g.args
			const r = recs.at(-1)
			if (!r || !G || !pbits()) return
			const inroom = r.event === "move" && r.x >= G.room.x && r.y >= G.room.y &&
				r.x < G.room.x + G.room.w && r.y < G.room.y + G.room.h
			const pt = inroom ? pixel(r.x, r.y) : null
			if (JSON.stringify(pt) === JSON.stringify(hover)) return
			hover = pt
			render()
			tell()
		}))

	// --- the keyboard

	const dialogKey = (api, r) => {
		const d = s.dialog, x = d.fields[d.at]
		if (r.key === "Escape") s.dialog = null
		else if (r.key === "Enter") answer(api, true)
		else if (r.key === "Tab" && d.fields.length) {
			d.at = (d.at + (r.mods?.includes("shift") ? d.fields.length - 1 : 1)) % d.fields.length
			const y = d.fields[d.at]
			Object.assign(y, { pos: y.text.length, mark: 0 })
		} else if (x) {
			// readline's keys, the tool's: C-a, A-f, C-k, C-y, the arrows, shift and a move selects, cmd-c, cmd-v
			const next = readline.type(x, r, { select: true, api })
			if (next) {
				Object.assign(x, next)
				d.error = null
			}
		}
	}
	const NUDGE = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }

	handler(given, "key", (g) =>
		using(g, () => {
			const { api } = g, [recs] = g.args
			for (const r of recs) {
				if (r.event === "commit" && s.dialog) {
					const x = s.dialog.fields[s.dialog.at]
					if (x) Object.assign(x, readline.type(x, r))
					continue
				}
				// space held: the hand, while it is
				if (r.key === " " || r.key === "Space") {
					space = !!r.down && !s.dialog
					if (!s.dialog) continue
				}
				if (!r.down) continue
				if (s.dialog) {
					dialogKey(api, r)
					continue
				}
				if (gesture) continue
				const c = readline.chord(r)
				const k = c.replace(/^S-/, "")
				// the arrows nudge a selection, shift ten at a time
				if (NUDGE[k] && s.sel && !r.mods?.some((m) => m !== "shift")) {
					if (layer().hidden) {
						say("this layer is hidden: show it to move on it", C.cherry)
						continue
					}
					lift(false)
					const n = c.startsWith("S-") ? 10 : 1
					slide(s.sel.x + NUDGE[k][0] * n, s.sel.y + NUDGE[k][1] * n)
					continue
				}
				if (c === "return" && fl) {
					putdown()
					continue
				}
				const hit = chords()[c]
				if (hit) act(api, hit[0], hit[1])
			}
			refresh(api)
			keep(api)
		}))

	// a menu's item chosen: what it does
	handler(given, "menu", (g) =>
		using(g, () => {
			const { api } = g, [what, arg] = g.args
			if (s.dialog && !["save"].includes(what)) return
			act(api, what, arg)
			refresh(api)
			keep(api)
		}))

	// a new look, or new fonts: drawn again in them
	effect(
		given,
		"theme",
		({ api }) => ({ T: val(api, ["/", "etc", "theme"]) ?? null, fonts: fonts(api) }),
		(g) =>
			using(g, () => {
				colours(g.value.T ?? {})
				full()
				refresh(g.api)
			}),
	)

	// the size the window manager gives
	// from /dev/display/windows, not the layer, which changes at each stroke; deep, as the window's node changes
	// each move and the same want, made again, is no new value
	effect(
		given,
		"size",
		({ api }) => val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want ?? null,
		(g) =>
			using(g, () => {
				const want = g.value
				if (!want) return
				W = Math.max(560 * u, want.w)
				H = Math.max(420 * u, want.h)
				full()
				refresh(g.api)
			}),
		{ deep: true },
	)

	// <its node>/view, read as it changes: a field another wrote (a shell's set) taken on, what it wrote itself let
	// be; not in a stroke, whose end writes the view over it
	const canon = (v) =>
		JSON.stringify(
			v,
			(_k, x) => (x && typeof x === "object" && !Array.isArray(x)
				? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
				: x),
		)
	effect(given, "theirs", ({ api }) => val(api, VIEW) ?? null, (g) =>
		using(g, () => {
			const { api, value: v } = g
			const theirs = v && viewed && !gesture
				? Object.keys(viewed).filter((k) => k in v && canon(v[k]) !== canon(viewed[k]))
				: []
			if (!theirs.length) return
			for (const k of theirs) [s[k], viewed[k]] = [v[k], JSON.parse(JSON.stringify(v[k]))]
			hands()
			full()
			refresh(api)
			keep(api)
		}))

	// the node, as it is now: followed while untouched, flagged while painted
	effect(given, "node", ({ api }) => {
		const item = api.content(NODE).find((i) => i.versions)?.versions.find((v) => !isStatus(v))
		return item ? { time: item.change?.time ?? null } : null
	}, (g) =>
		using(g, () => {
			const { api, value: now } = g
			if (now && now.time !== s.base.time) {
				const theirs = load(api)
				if (!s.modified) {
					// followed, as a change of its own: undone, it is as it was
					putdown()
					remember("Changed Elsewhere")
					take(theirs)
					done()
					s.modified = false
					say(`changed elsewhere, t=${theirs.time}: shown`)
				} else say(`changed elsewhere at t=${theirs.time}; cmd-s puts yours over it`, C.cherry)
			}
			refresh(api)
			keep(api)
		}))
}
