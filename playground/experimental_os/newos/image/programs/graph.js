// /programs/graph: the graph browser, as Smalltalk's system browser. columns down the tree, each
// name with its value in a line (kind, size, document dot or ephemeral ring, when set); below, the
// selected node drawn by the views library, with its change, who, why, the read's route and every
// id in its slot. read in parts (each column, the node), so live, redrawing only what changed.
// where it is: "at", {path, key}; write it to send it somewhere (key: a way into the value).
//
// keys: arrows move (into the value's keys past the last names); Enter edits a string, number or
// null, flips a boolean, follows an address, asks a handler's args (JSON, Enter again calls it), or
// opens; e editor (a picture: Paint); f follow; j JSON; x hex; h history. click a name, key or
// address to go there; the wheel scrolls the value.
// view state (scroll, JSON, hex, an edit, footer): <its node>/view, ephemeral. its own node and
// browsers' and inspectors' layers are not read (they change each draw).
//
// not yet from core: whether a node is ephemeral, a change's actor or site. history (h) is sync's
// (drv_sync.c): a document's; an ephemeral node has none.
import { data, effect, handler, idAt, isStatus, make, put, val, whole } from "ermine:kit"
import { after, here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as views from "ermine:views"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, onCleanup, self, name } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const owner = here(self)
	const cwd = owner.slice(0, -1)
	const blit = blitter(api)
	// names in /dev/font/text, heads in /dev/font/title, values in /dev/font/fixed; the font ROM until they come
	let F, FT, FX
	const fontAt = (api, role) => {
		const v = val(api, ["/", "dev", "font", role])
		return v ? font(v) : undefined
	}
	const fonts = (api) => {
		F = fontAt(api, "text")
		FT = fontAt(api, "title")
		FX = fontAt(api, "fixed")
		return `${F ? String(F) : "rom"} ${FT ? String(FT) : "rom"} ${FX ? String(FX) : "rom"}`
	}
	fonts(api)
	const RH = () => Math.max(blit.height(F), blit.height(FX)) + 4 * u
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(1100 * u, mode.w - 60 * u), H = Math.min(680 * u, mode.h - 80 * u)
	let COLS, COLW, LISTH, ROWS
	const size = (w, h) => {
		W = Math.max(320 * u, w)
		H = Math.max(240 * u, h)
		COLS = Math.max(1, Math.min(4, Math.floor(W / (300 * u))))
		COLW = Math.floor(W / COLS)
		LISTH = Math.floor(H * 0.42)
		ROWS = Math.max(1, Math.floor((LISTH - 4 * u) / RH()))
	}
	size(W, H)
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `graph-${self}`]
	const AT = [...owner, "at"]
	const VIEW = [...owner, "view"]
	const set = (key, value) => ({ path: [key], value })
	// a value written whole where a node is, else made there, ephemeral
	const keepAt = (api, address, value) => {
		if (idAt(api, address)) api.write(address, whole(value))
		else make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
	}
	// the look, from /etc/theme: paper, black lines, the selection in lemon highlighter, cherry for what is wrong
	const C = {}
	const colours = (T = {}) =>
		Object.assign(C, {
			paper: T.paper ?? 0xfdf8ea,
			chrome: T.chrome ?? 0xece5d4,
			hi: T.hi ?? 0xfffdf6,
			lo: T.lo ?? 0xb9ae98,
			line: T.line ?? 0x1c1a17,
			ink: T.ink ?? 0x2a2228,
			ink2: T.ink2 ?? 0x6b5a66,
			dim: T.ink3 ?? 0xa89aa2,
			lemon: T.select ?? T.lemon ?? 0xffff88,
			cherry: T.cherry ?? 0xd2244a,
			rose: T.rose ?? 0xe2457c,
			mint: T.mint ?? 0x18936b,
			lilac: T.lilac ?? 0x7b5ce6,
			blue: T.risoBlue ?? 0x0078bf,
			teal: T.teal ?? 0x0f7f8f,
			check: T.check ?? 0xe6dcc4,
			// a badge's pill (views' tag), as catclock's tags: the theme's soft blue; none, a box as before
			tag: T.blueSoft,
			// the theme's buttons ("bevel", "soft", "raised"), and its selection: {rows: "invert"} a chosen row's name in
			// pick and pickInk, as Windows 98's lists; else the row on the highlighter
			buttons: T.buttons === "soft" || T.buttons === "raised" ? T.buttons : "bevel",
			invert: T.selection?.rows === "invert",
			pick: T.pick ?? T.line ?? 0x1c1a17,
			pickInk: T.pickInk ?? T.paper ?? 0xfdf8ea,
			light: T.light ?? 0xdfdfdf,
			dark: T.dark ?? 0x000000,
		})
	colours(val(api, ["/", "etc", "theme"]))

	// what it was given, a path to start at: {path}, or a binding's words, {args: ["apps/workspace"]}
	const given_ = data(given) ?? {}
	if (!idAt(api, AT)) {
		const start = given_.path ?? (typeof given_.args?.[0] === "string"
			? given_.args[0].split("/").filter((n) =>
				n
			)
			: null) ??
			[]
		make(api, owner, "at", { path: start, key: [] }, { ephemeral: true })
	}
	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (50 + (n % 5) * 30) * u,
			y: (60 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "graph",
			owner,
			draw: [],
		}, { ephemeral: true })
	}

	// what is on screen besides the graph: the value's scroll, JSON, hex, a value edited, the footer's word
	const s = { scroll: 0, raw: false, hex: false, edit: null, note: null, hat: 0 }
	const view = val(api, VIEW)
	if (view) { for (const k of Object.keys(s)) if (k in view) s[k] = view[k] }
	let viewed = view ?? null
	const keep = (api) => {
		const text = JSON.stringify(s)
		if (viewed && JSON.stringify(viewed) === text) return
		keepAt(api, VIEW, JSON.parse(text))
		viewed = JSON.parse(text)
	}

	// values drawn as what they are: the views library's, as the inspector draws them
	const V = views.make(blit, {
		u,
		colours: C,
		get hex() {
			return s.hex
		},
	})
	const show = (v) => {
		try {
			return JSON.stringify(v, (_k, x) => {
				if (x instanceof Uint8Array) return `<bytes ${x.byteLength}>`
				if (ArrayBuffer.isView(x)) {
					return `<${x.constructor.name.replace("Array", "").toLowerCase()}[${x.length}]>`
				}
				if (typeof x === "function") return "<live function>"
				if (
					x && typeof x === "object" && !Array.isArray(x) &&
					Object.getPrototypeOf(x) !== Object.prototype
				) return `<live ${x.kind ?? ""}>`
				return x
			}, 2) ?? "undefined"
		} catch (e) {
			return `<${e.message}>`
		}
	}
	const why = (e) =>
		`${e?.code ?? "error"}: ${String(e?.message ?? e).replace(new RegExp(`^${e?.code}: `), "")}`
	const at = (v, key) =>
		key.reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), v)
	const keysOf = (
		v,
	) => (Array.isArray(v)
		? v.map((_x, i) => i)
		: v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype
		? Object.keys(v).sort(V.order)
		: [])
	// not read: its own node, whose parts' values change as it reads; a browser's, an inspector's or a Files window's layer
	// and text, which change each time one draws; what is inside a Files window's process (/apps/files/<it>/…): so it never
	// redraws itself, nor two each other (Files leaves a browser's unread in turn)
	const under = (a, b) => a.length > b.length && b.every((n, i) => a[i] === n)
	const unread = (a) =>
		under(a, owner) ||
		(a.length >= 5 && a[1] === "dev" && a[2] === "display" &&
			(a[3] === "layers" || a[3] === "text") && /^(graph|inspect|files)-/.test(a[4])) ||
		(a.length >= 5 && a[1] === "apps" && a[2] === "files")
	const topOf = (col, rows = ROWS) =>
		Math.max(0, col.entries.findIndex((e) => e.name === col.chosen) - rows + 2)

	// --- reading, in parts: the style, each column, the node chosen; each an effect of its own that reads only what
	// it shows, so a change reads again only the part it touched (a window moving, while /dev/display is shown: that
	// column's row for it, not every column, nor the node's slot), and only the rows that changed are drawn again
	// (Drawing, below). Every read through rd, so a part knows what it saw (its fingerprint)
	let sig = []
	// what a read gave, as these parts keep it: the item's id, whether its node is there, the value and the change that set it
	const got = (i) => {
		const v = i.versions?.find((x) => !isStatus(x))
		return {
			id: i.id,
			pending: !i.node,
			refused: !!i.refused,
			value: i.versions ? (v ? v.content : null) : undefined,
			version: v,
			change: v?.change,
			route: i.route,
			ephemeral: i.ephemeral,
		}
	}
	const rd = (api, address) => {
		const items = api.content(address).map(got)
		for (const i of items) sig.push(i.change?.time ?? (i.pending ? "p" : "-"))
		sig.push(items.length)
		return items
	}
	// how many columns and rows it shows, at <its node>/shows/size, written as the size changes, so a part that
	// reads values only for the rows shown reads them again when that changes
	const SHOWS = [...owner, "shows"], FIT = [...SHOWS, "size"]
	const fit = (api) => {
		const v = { cols: COLS, rows: ROWS }
		make(api, owner, "shows", null, { ephemeral: true })
		if (!idAt(api, FIT)) make(api, SHOWS, "size", v, { ephemeral: true })
		else if (JSON.stringify(val(api, FIT)) !== JSON.stringify(v)) api.write(FIT, whole(v))
	}
	fit(api)
	// a part: what it read, kept by name with the place and the size it was read for, so a page half read again is not drawn.
	// The compute's value is a fingerprint of what it saw (FNV-1a), a string: an effect runs when it is not the last
	const parts = {}
	const part = (n, fn) =>
		effect(given, n, ({ api }) => {
			sig = []
			const doc = rd(api, AT)[0]?.value ?? { path: [] }
			const size = val(api, FIT) ?? { cols: COLS, rows: ROWS }
			let value
			try {
				value = fn(
					api,
					{ path: doc.path ?? [], key: doc.key ?? [], history: !!doc.history },
					size,
				)
			} catch (e) {
				sig.push("!")
				value = null
			}
			parts[n] = { value, key: JSON.stringify([doc, size]) }
			let h = 2166136261
			for (const ch of sig.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
			return `${h}.${sig.length}`
		}, (g) => soon(g))
	// the look: /etc/theme, /etc/views, the fonts
	part("style", (api) => {
		V.kinds(rd(api, ["/", "etc", "views"])[0]?.value)
		sig.push(fonts(api))
		return rd(api, ["/", "etc", "theme"])[0]?.value ?? null
	})
	// a column: one directory down the path, each name with its value, for its line, when it is shown (the last
	// cols of them), and a few past them; the last's for the node's listing. DEPTH parts, the last all the deeper ones
	const DEPTH = 12
	const columnAt = (api, path, i, size) => {
		const dir = path.slice(0, i)
		const address = ["/", ...dir]
		let entries = []
		try {
			entries = api.children(address).map((n) => {
				const items = api.children(address, n)
				sig.push(n, ...items.map((x) => x.id))
				return {
					name: n,
					ids: items.map((x) => x.id),
					e: items.some((x) => x.ephemeral === true),
					doc: items.length > 0 && items.every((x) => x.ephemeral === false),
					pending: items.length > 0 && items.every((x) => !x.node),
				}
			})
		} catch (e) {
			sig.push("!")
			entries = [{ name: `(${e.code ?? "refused"})`, ids: [], refused: true }]
		}
		const col = { dir, entries, chosen: path[i] ?? null }
		if (i < path.length + 1 - size.cols) return col
		const top = topOf(col, size.rows), last = i === path.length
		for (const e of col.entries.slice(top, last ? top + 200 : top + size.rows + 12)) {
			const a = ["/", ...col.dir, e.name]
			if (e.refused || e.pending) continue
			if (unread(a)) {
				e.unread = true
				continue
			}
			try {
				e.item = rd(api, a).find((i) => !i.pending) ?? null
			} catch (err) {
				sig.push("!")
				e.bad = err?.code ?? "refused"
			}
		}
		return col
	}
	for (let k = 0; k < DEPTH; k++) {
		part(`col${k}`, (api, { path }, size) => {
			const out = []
			for (let i = k; i <= path.length && (i === k || k === DEPTH - 1); i++) {
				out.push(columnAt(api, path, i, size))
			}
			return out
		})
	}
	// the node chosen: its members, its slot, how many names below; what an address in it reaches
	part("node", (api, { path, key }) => {
		const A = ["/", ...path]
		if (unread(A)) return { address: A, unread: true }
		try {
			const items = rd(api, A)
			const item = items.find((i) => !i.pending) ?? items[0] ?? null
			const slot = path.length ? api.children(A.slice(0, -1), path.at(-1)) : []
			const v = at(item?.value, key)
			const there = V.kind(v, key.at(-1) ?? path.at(-1)) === "address"
				? rd(api, V.addressOf(v))[0]?.change?.time ?? null
				: null
			return { address: A, items, item, slot, there }
		} catch (e) {
			sig.push("!")
			return { address: A, refused: why(e) }
		}
	})
	// its history, while it is shown (at's history): /dev/sync/history/<id>, which the sync driver serves while
	// /dev/sync/want/graph-<pid> names the node's id; with no sync driver, nothing is served, and it says so
	const WANT = ["/", "dev", "sync", "want", `graph-${self}`]
	// what changed while it was away from a folder: /apps/graph/seen/<its name>, a document
	const away = V.away([...cwd, "seen", name])
	onCleanup(({ api }) => away.leave(api))
	const idOf = (
		api,
		path,
	) => (path.length
		? api.children(["/", ...path.slice(0, -1)], path.at(-1)).find((i) => i.node) ?? null
		: null)
	part("hist", (api, { path, history }) => {
		if (!history) return null
		if (!idAt(api, ["/", "dev", "sync", "history"])) {
			return { none: "no history here: sync keeps it, and its driver is not running" }
		}
		const i = idOf(api, path)
		if (!i || i.ephemeral === true) return { none: "ephemeral: no history kept" }
		const h = rd(api, ["/", "dev", "sync", "history", i.id.replace(/^ermine:/, "")])[0]?.value ??
			null
		return { id: i.id, h }
	})
	let wanted = null
	effect(given, "want", ({ api }) => {
		const doc = val(api, AT)
		const i = doc?.history ? idOf(api, doc.path ?? []) : null
		return i && i.ephemeral !== true ? i.id : null
	}, ({ value: id, api }) => {
		const want = id ? [id] : []
		if (JSON.stringify(want) === JSON.stringify(wanted)) return
		if (idAt(api, WANT)) api.write(WANT, whole(want))
		else make(api, WANT.slice(0, -1), WANT.at(-1), want, { ephemeral: true })
		wanted = want
	})
	const PARTS = ["style", ...Array.from({ length: DEPTH }, (_, k) => `col${k}`), "node", "hist"]
	// what it shows, as the parts last read it: once every part has read for where it is now, and the size it is
	let latest = {
		doc: { path: [], key: [] },
		path: [],
		key: [],
		columns: [],
		node: null,
		theme: null,
	}
	// the footer's word is about where it was: gone once it is somewhere else
	let where = null
	const present = (api) => {
		const doc = val(api, AT) ?? { path: [] }
		const size = val(api, FIT) ?? { cols: COLS, rows: ROWS }
		const key = JSON.stringify([doc, size])
		if (PARTS.some((n) => parts[n]?.key !== key)) return
		const path = doc.path ?? []
		const node = parts.node.value
		// the names below, as the last column has them
		const columns = PARTS.filter((n) => n.startsWith("col")).flatMap((n) => parts[n].value ?? [])
		if (node && !node.unread && !node.refused) {
			node.below = columns.at(-1)?.entries.filter((e) => !e.refused).length ?? 0
		}
		// what changed while it was away from the folder it moves in (views' away), by the time of each document's change
		const dir = path.slice(0, -1),
			col = columns.find((c) =>
				c.dir.length === dir.length && c.dir.every((n, i) => n === dir[i])
			)
		const marked = col
			? away.at(
				api,
				dir,
				col.entries.filter((e) => e.doc && e.item?.change).map((e) => ({
					id: e.ids[0],
					stamp: e.item.change.time,
				})),
			)
			: null
		const hist = parts.hist.value
		latest = {
			doc,
			path,
			key: doc.key ?? [],
			columns,
			node,
			theme: parts.style.value,
			marked,
			markDir: dir.join("/"),
			history: !!doc.history,
			hist: hist?.h ? { ...hist, list: V.changes(hist.h, doc.key ?? []) } : hist,
		}
		gone = false
		const now = JSON.stringify(doc)
		if (where !== null && where !== now) s.note = null
		where = now
		if (latest.theme) colours(latest.theme)
		ids(api)
		paint(api)
	}
	// the parts that changed in a turn shown once, after it, as the next display frame is: a timer, the part's own
	let due = null
	const soon = (g) => {
		if (!due) {
			due = after(g, 0, ({ api }) => {
				due = null
				present(api)
			})
		}
	}
	onCleanup(({ api }) => due?.(api))

	// the value it shows: the node's, at its key; and how the views library is to draw it
	const chosen = () => {
		const n = latest.node
		if (!n?.item || n.refused || n.unread || n.item.pending) return null
		const key = latest.key
		const value = at(n.item.value, key)
		const k = key.at(-1) ?? latest.path.at(-1)
		const kind = V.kind(value, k, undefined, { play: true })
		return {
			value,
			kind,
			address: n.address,
			key,
			item: n.item,
			o: {
				key: k,
				name: k,
				ctx: key.at(-2) === "colors" ? "colors" : undefined,
				parent: key.length ? at(n.item.value, key.slice(0, -1)) : undefined,
				write: ["string", "int", "float", "null", "bool"].includes(kind),
				address: n.address,
				into: true,
				play: true,
				why,
			},
		}
	}

	// --- drawing
	const BAR = () => blit.height(FT) + 10 * u
	const FOOT = () => blit.height(F) + 8 * u
	const LH = () => blit.height(FX) + u
	const AW = () => Math.min(320 * u, Math.floor(W * 0.32))
	let zones = []
	let caret = null
	// a button, as catclock's: white, its corners round, a hairline round it; one that cannot be pressed faint
	const rounded = (f, x, y, w, h, r, color) => {
		blit.fill(f, x + r, y, w - 2 * r, h, color)
		blit.fill(f, x, y + r, w, h - 2 * r, color)
		for (
			const [cx, cy] of [[x + r, y + r], [x + w - r - 1, y + r], [x + r, y + h - r - 1], [
				x + w - r - 1,
				y + h - r - 1,
			]]
		) blit.fillellipse(f, cx, cy, r, r, color)
	}
	const button = (f, x, y, label, act, on = true) => {
		const soft = C.buttons === "soft"
		const w = blit.measure(label, FT) + (soft ? 18 : 14) * u,
			h = blit.height(FT) + 4 * u,
			r = Math.min(6 * u, Math.floor((h - 1) / 2))
		if (soft) {
			rounded(f, x, y, w, h, r, C.lo)
			rounded(f, x + u, y + u, w - 2 * u, h - 2 * u, r - u, C.hi)
		} else if (C.buttons === "raised") {
			// Windows 98's: the chrome, lit above and left, dark below and right
			blit.fill(f, x, y, w, h, C.chrome)
			for (let k = 0; k < 2; k++) {
				const a = k ? C.light : C.hi, b = k ? C.lo : C.dark
				blit.fill(f, x + k * u, y + k * u, w - 2 * k * u, u, a)
				blit.fill(f, x + k * u, y + k * u, u, h - 2 * k * u, a)
				blit.fill(f, x + k * u, y + h - (k + 1) * u, w - 2 * k * u, u, b)
				blit.fill(f, x + w - (k + 1) * u, y + k * u, u, h - 2 * k * u, b)
			}
		} else {
			blit.fill(f, x, y, w, h, C.line)
			blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
			blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
			blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
		}
		blit.text(
			f,
			x + (soft ? 9 : 7) * u,
			y + 2 * u,
			label,
			on ? C.ink : C.dim,
			undefined,
			undefined,
			FT,
		)
		zones.push({ x, y, w, h, act: on ? act : null, role: "button", label })
		return w
	}

	// the draw list in segments, each {key, ops, zones, caret}: the paper, each column's line, each name shown, the
	// bar, the value, where it came from, the footer. A segment whose key, what it is drawn from, is as it was is
	// not drawn again, and only the ops from the first that changed to the last are written, a splice of the
	// layer's draw (paint, below). Fonts, colours, the size or hex changed: all of it
	let segs = [], style = null
	// a name in a column as it is drawn: its value by the change that set it
	// names for ids (V.ids), read again at most once a second as it draws: never tracked, so a window moving draws nothing
	let known = { pids: {}, t: 0 }
	const ids = (api) => {
		if (Date.now() - known.t > 1000) known = { ...V.ids(api), t: Date.now() }
	}
	// when it was set: the clock
	const when = (it, brief) => {
		const t = V.clock(it?.change?.time)
		return brief ? t.slice(0, 8) : t
	}
	const marks = (
		col,
		e,
	) => (latest.marked?.has(e.ids[0]) && col.dir.join("/") === latest.markDir ? "here" : "")
	const stampOf = (e) =>
		JSON.stringify([
			e.name,
			e.ids,
			!!e.e,
			!!e.doc,
			!!e.pending,
			!!e.unread,
			e.bad ?? null,
			!!e.refused,
			e.item?.change?.time ?? null,
			e.item ? null : "none",
		])
	const draw = (api) => {
		V.fonts({ text: F, title: FT, fixed: FX })
		const v = latest
		const look = JSON.stringify([
			F ? String(F) : null,
			FT ? String(FT) : null,
			FX ? String(FX) : null,
			W,
			H,
			s.hex,
			C,
		])
		const all = style !== look
		const had = all ? new Map() : new Map(segs.map((g) => [g.key, g]))
		style = look
		const out = []
		const seg = (key, fn) => {
			const g = had.get(key)
			if (g) return void out.push(g)
			zones = []
			caret = null
			const f = blit.list(W, H)
			fn(f)
			out.push({ key, ops: f.ops, zones, caret })
		}
		seg("paper", (f) => blit.fill(f, 0, 0, W, H, C.paper))
		const rh = RH()
		// the columns: the last few directories down the path, each name with its value in a line
		const first = Math.max(0, v.columns.length - COLS)
		const NW = Math.min(150 * u, Math.floor(COLW * 0.4))
		v.columns.slice(first).forEach((col, ci) => {
			const x = ci * COLW
			seg(`column ${ci} ${col.entries.length > 0}`, (f) => {
				blit.fill(f, x + COLW - u, 0, u, LISTH, C.line)
				if (!col.entries.length) {
					blit.text(f, x + 14 * u, 4 * u, "(empty)", C.dim, undefined, undefined, F)
				}
			})
			const top = topOf(col)
			col.entries.slice(top, top + ROWS).forEach((e, ri) =>
				seg(
					`name ${ci} ${ri} ${e.name === col.chosen} ${JSON.stringify(col.dir)} ${
						stampOf(e)
					} ${marks(col, e)}`,
					(f) => {
						const y = 2 * u + ri * rh
						const chosen = e.name === col.chosen
						if (chosen && !C.invert) blit.fill(f, x, y, COLW - u, rh, C.lemon)
						const ny = y + Math.floor((rh - blit.height(F)) / 2),
							vy = y + Math.floor((rh - blit.height(FX)) / 2)
						// a document: a dot of ink; ephemeral: a ring; changed while it was away, a label's square, rose
						const mark = marks(col, e)
						if (mark) {
							blit.fill(f, x + 6 * u, y + Math.floor(rh / 2) - 2 * u, 5 * u, 5 * u, C.rose)
						} else if (e.doc) {
							blit.fillellipse(f, x + 8 * u, y + Math.floor(rh / 2), 2 * u, 2 * u, C.ink2)
						} else if (e.e) {
							blit.ellipse(f, x + 8 * u, y + Math.floor(rh / 2), 2 * u, 2 * u, u, C.dim)
						}
						const nx = x + 14 * u
						const many = e.ids.length > 1 ? `×${e.ids.length}` : ""
						const nw = NW - 14 * u - (many ? blit.measure(many, F) + 2 * u : 0)
						// inverted, as Windows 98's lists: only the name, in pick
						if (chosen && C.invert) {
							blit.fill(
								f,
								nx - 2 * u,
								y + u,
								Math.min(nw, blit.measure(V.fitted(e.name, nw, F), F)) + 4 * u,
								rh - 2 * u,
								C.pick,
							)
						}
						const end = blit.text(
							f,
							nx,
							ny,
							V.fitted(e.name, nw, F),
							e.refused || e.bad ? C.cherry : chosen && C.invert ? C.pickInk : C.ink,
							undefined,
							{ x, y, w: NW, h: rh },
							F,
						)
						if (many) {
							blit.text(f, end + 2 * u, ny, many, C.dim, undefined, undefined, F)
						}
						// when it was set, at the right where there is room; then what it is, in a line
						let right = x + COLW - 6 * u
						const c = e.item?.change
						if (c && COLW >= 340 * u) {
							const t = when(e.item, true)
							const tw = blit.measure(t, FX)
							blit.text(f, right - tw, vy, t, C.dim, undefined, undefined, FX)
							right -= tw + 8 * u
						}
						const vx = x + NW + 4 * u, clip = { x: vx, y, w: Math.max(0, right - vx), h: rh }
						if (e.unread) {
							blit.text(
								f,
								vx,
								vy,
								"not read: it changes as one draws",
								C.dim,
								undefined,
								clip,
								FX,
							)
						} else if (e.pending) {
							blit.text(f, vx, vy, "… pending", C.dim, undefined, clip, FX)
						} else if (e.bad) {
							blit.text(f, vx, vy, e.bad, C.cherry, undefined, clip, FX)
						} else if (e.item) {
							V.summary(f, vx, vy, e.item.value, { key: e.name, play: true, clip })
						}
						if (!e.refused) {
							zones.push({
								x,
								y,
								w: COLW - u,
								h: rh,
								act: "go",
								path: [...col.dir, e.name],
								key: [],
								role: "button",
								label: e.name,
							})
						}
					},
				)
			)
		})
		// the bar: the path, each name a way there, then into the value; JSON, Edit or Paint
		const top = LISTH, bar = BAR()
		const cv = chosen()
		seg(
			`bar ${
				JSON.stringify([
					cv?.kind === "picture" && !v.key.length,
					v.path,
					v.key,
					s.raw,
					!!v.node?.unread,
				])
			}`,
			(f) => {
				blit.fill(f, 0, top, W, bar, C.chrome)
				blit.fill(f, 0, top, W, u, C.line)
				blit.fill(f, 0, top + bar - u, W, u, C.line)
				let bx = W - 6 * u
				const right = (label, act, on) => {
					bx -= blit.measure(label, FT) + 14 * u
					button(f, bx, top + 3 * u, label, act, on)
					bx -= 4 * u
				}
				right(
					cv?.kind === "picture" && !v.key.length ? "Paint" : "Edit",
					"open",
					v.path.length > 0 && !v.node?.unread,
				)
				right(s.raw ? "View" : "JSON", "raw", true)
				const crumbs = [
					{ text: "/", path: [], key: [] },
					...v.path.map((n, i) => ({
						text: (i ? "/" : "") + n,
						path: v.path.slice(0, i + 1),
						key: [],
					})),
					...v.key.map((k, i) => ({
						text: ` › ${k}`,
						path: v.path,
						key: v.key.slice(0, i + 1),
					})),
				]
				const ty = top + Math.floor((bar - blit.height(F)) / 2)
				const room = { x: 0, y: top, w: bx - 8 * u, h: bar }
				let x = 8 * u
				crumbs.forEach((c, i) => {
					if (x >= room.w) return
					const end = blit.text(
						f,
						x,
						ty,
						c.text,
						i === crumbs.length - 1 ? C.ink : C.rose,
						undefined,
						room,
						F,
					)
					zones.push({
						x,
						y: top,
						w: end - x,
						h: bar,
						act: "go",
						path: c.path,
						key: c.key,
						role: "link",
						label: c.text,
					})
					x = end
				})
			},
		)
		// the value, as what it is (or JSON); beside it, where it came from
		const foot = FOOT(), aw = AW()
		const R = { x: 0, y: top + bar, w: W - aw - u, h: H - foot - top - bar }
		const n = v.node
		const item = n?.item
			? [
				n.item.change?.time ?? null,
				n.item.id ?? null,
				n.item.ephemeral ?? null,
				!!n.item.pending,
				(n.item.route ?? []).map((st) => st.name),
			]
			: null
		// a folder's listing is the last column's names
		const listing = cv?.kind === "null" && !s.raw
			? v.columns.at(-1)?.entries.slice(0, 200).map(stampOf) ?? []
			: null
		const hk = v.history
			? [s.hat, v.hist?.none ?? null, v.hist?.h?.changes?.length ?? null]
			: null
		seg(
			`value ${
				JSON.stringify([
					s.scroll,
					s.raw,
					s.edit,
					v.path,
					v.key,
					item,
					n?.unread ?? false,
					n?.refused ?? null,
					n?.there ?? null,
					listing,
					hk,
				])
			}`,
			(f) => {
				blit.fill(f, W - aw - u, top + bar, u, R.h, C.line)
				pane(f, api, v, cv, R)
			},
		)
		seg(
			`about ${
				JSON.stringify([
					item,
					n?.item ? V.head(n.item.version, known) : null,
					cv?.kind ?? null,
					(n?.slot ?? []).map((x) => [x.id, !x.node]),
					n?.items?.length ?? 0,
					n?.below ?? 0,
				])
			}`,
			(f) => {
				about(f, v, cv, { x: W - aw, y: top + bar, w: aw, h: R.h })
			},
		)
		// the footer: a word, else what the keys do
		const said = s.note ??
			[
				s.edit?.kind === "call"
					? "args as JSON: Enter calls it, Escape lets it be"
					: s.edit
					? "Enter writes it, Escape lets it be"
					: v.history
					? "up down choose · p puts it back · h the value"
					: "arrows move · Enter edit · e editor · f follow · j JSON · x hex · h history · wheel scrolls",
				C.dim,
			]
		seg(`footer ${JSON.stringify(said)}`, (f) => {
			const fy = H - foot
			blit.fill(f, 0, fy, W, foot, C.chrome)
			blit.fill(f, 0, fy, W, u, C.line)
			blit.text(
				f,
				8 * u,
				fy + 4 * u,
				V.fitted(said[0], W - 16 * u, F),
				said[1],
				undefined,
				undefined,
				F,
			)
		})
		zones = out.flatMap((g) => g.zones)
		caret = out.find((g) => g.caret)?.caret ?? null
		return { out, all }
	}

	// the value: a field while it is edited, then its view, laid out from the scroll down
	const pane = (f, api, v, cv, R) => {
		const n = v.node
		const say = (t, c) => blit.text(f, R.x + 10 * u, R.y + 8 * u, t, c, undefined, R, F)
		if (!n) return say("the root", C.dim)
		if (n.unread) {
			return say(
				"not read: a browser's or an inspector's own, which changes each time it draws",
				C.dim,
			)
		}
		if (n.refused) return say(n.refused, C.cherry)
		if (!n.item) return say("nothing is here", C.dim)
		if (n.item.pending) return say("pending: not here yet", C.dim)
		let r = R
		if (s.edit) {
			const h = RH()
			caret = V.field(f, { x: R.x + 10 * u, y: R.y + 6 * u, w: R.w - 20 * u, h }, s.edit.field)
			r = { ...R, y: R.y + h + 10 * u, h: R.h - h - 10 * u }
		}
		if (v.history) return historyPane(f, v, r)
		if (cv.kind === "null" && !s.raw && v.columns.at(-1)?.entries.some((e) => !e.refused)) {
			return listing(f, v, r)
		}
		if (s.raw) {
			const B = V.blocks(f, r.w - 20 * u)
			for (const l of show(cv.value).split("\n")) B.text(l, C.ink)
			s.scroll = V.lay(B, r, s.scroll)
			return
		}
		const p = V.pane(f, r, cv.value, {
			...cv.o,
			kind: cv.kind,
			scroll: s.scroll,
			api: { content: (a) => api.content(a) },
		})
		s.scroll = p.scroll
		zones.push(...p.zones)
	}

	// its history: each change kept, newest first (at a key, those that changed it), when · who, what it
	// did, and the value after it; the one chosen in lemon
	const historyPane = (f, v, R) => {
		const H_ = v.hist, B = V.blocks(f, R.w - 20 * u)
		if (!H_ || H_.none || !H_.h) {
			B.text(H_?.none ?? "asking for its history…", C.dim, F)
			s.scroll = V.lay(B, R, s.scroll)
			return
		}
		const list = H_.list
		s.hat = Math.max(0, Math.min(list.length - 1, s.hat))
		B.text(
			`history · ${list.length} ${list.length === 1 ? "change" : "changes"}${
				v.key.length ? " to " + v.key.join(" › ") : ""
			}`,
			C.ink2,
			F,
		)
		B.rule()
		const rh = RH(), lh = LH()
		list.forEach((c, i) => {
			B.push(rh + lh, (x, y, clip) => {
				if (i === s.hat) blit.fill(f, x - 4 * u, y, B.w + 8 * u, rh + lh, C.lemon)
				const ty = y + Math.floor((rh - blit.height(FX)) / 2)
				const t = V.head(V.itemOf(c), known)
				const end = blit.text(f, x, ty, V.fitted(t, B.w * 0.7, FX), C.ink, undefined, clip, FX)
				blit.text(
					f,
					end + 8 * u,
					ty,
					V.fitted(V.did(c), Math.max(0, x + B.w - end - 8 * u), FX),
					C.ink2,
					undefined,
					clip,
					FX,
				)
				const after = v.key.length ? at(c.value, v.key) : c.value
				if ("value" in c) {
					V.summary(f, x + 8 * u, y + rh, after === undefined ? null : after, {
						key: v.key.at(-1),
						clip: { x, y: y + rh, w: B.w, h: lh },
					})
				} else if (c.kind === "write") {
					blit.text(
						f,
						x + 8 * u,
						y + rh,
						"over 4 KB: not kept here",
						C.dim,
						undefined,
						clip,
						FX,
					)
				}
				if (y >= R.y && y + rh <= R.y + R.h) {
					zones.push({
						x: R.x,
						y,
						w: R.w,
						h: rh + lh,
						act: "hat",
						i,
						role: "button",
						label: t,
					})
				}
			})
		})
		s.scroll = V.lay(B, R, s.scroll)
	}
	// h: its history shown, or the value again
	const history = (api, on) => {
		try {
			api.write(
				AT,
				whole({ path: latest.path, key: latest.key, ...(on ? { history: true } : {}) }),
			)
			gone = true
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
		s.hat = 0
		s.scroll = 0
	}
	// p: the change chosen put back, a write of the value after it (at a key, that key's)
	const putBack = (api) => {
		const c = latest.hist?.list?.[s.hat]
		if (!c) return
		if (!("value" in c)) {
			return void (s.note = [
				c.kind === "write" ? "over 4 KB: its value is not in the history" : "no value after it",
				C.cherry,
			])
		}
		const key = latest.key, after = key.length ? at(c.value, key) : c.value
		try {
			api.write(
				["/", ...latest.path],
				key.length
					? [{ path: key, ...(after === undefined ? {} : { value: after }) }]
					: whole(c.value),
			)
			s.note = [`put back ${V.when(c)}`, C.mint]
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
	}

	// a folder: its names, each with its value in a line, wider than a column has room for
	const listing = (f, v, R) => {
		const kids = v.columns.at(-1).entries.filter((e) => !e.refused)
		const B = V.blocks(f, R.w - 20 * u)
		B.text(
			`null: a folder, ${kids.length} ${kids.length === 1 ? "name" : "names"} below`,
			C.ink2,
			F,
		)
		B.rule()
		const rh = RH(), nw = Math.min(200 * u, Math.floor(B.w * 0.3))
		for (const e of kids.slice(0, 200)) {
			B.push(rh, (x, y, clip) => {
				const ny = y + Math.floor((rh - blit.height(F)) / 2),
					vy = y + Math.floor((rh - blit.height(FX)) / 2)
				if (e.doc) blit.fillellipse(f, x + 2 * u, y + Math.floor(rh / 2), 2 * u, 2 * u, C.ink2)
				else if (e.e) blit.ellipse(f, x + 2 * u, y + Math.floor(rh / 2), 2 * u, 2 * u, u, C.dim)
				blit.text(f, x + 8 * u, ny, V.fitted(e.name, nw - 12 * u, F), C.ink, undefined, clip, F)
				let right = x + B.w
				const c = e.item?.change
				if (c) {
					const t = when(e.item)
					right -= blit.measure(t, FX)
					blit.text(f, right, vy, t, C.dim, undefined, clip, FX)
					right -= 10 * u
				}
				const sub = {
					x: x + nw,
					y,
					w: Math.max(0, Math.min(right, clip.x + clip.w) - x - nw),
					h: rh,
				}
				if (e.unread) {
					blit.text(
						f,
						x + nw,
						vy,
						"not read: it changes as one draws",
						C.dim,
						undefined,
						sub,
						FX,
					)
				} else if (e.pending) blit.text(f, x + nw, vy, "… pending", C.dim, undefined, sub, FX)
				else if (e.item) {
					V.summary(f, x + nw, vy, e.item.value, { key: e.name, play: true, clip: sub })
				}
				if (y >= R.y && y + rh <= R.y + R.h) {
					zones.push({
						x: R.x,
						y,
						w: R.w,
						h: rh,
						act: "go",
						path: [...v.path, e.name],
						key: [],
						role: "button",
						label: e.name,
					})
				}
			})
		}
		if (kids.length > 200) B.text(`… ${kids.length - 200} more`, C.dim)
		s.scroll = V.lay(B, R, s.scroll)
	}

	// where it came from: the change that set it, the process that made it; ephemeral or a document, where
	// it says; its route, its slot
	const about = (f, v, cv, R) => {
		const n = v.node
		const lines = []
		const add = (label, text, c = C.ink) => lines.push([label, text, c])
		if (cv) add("kind", "", C.ink)
		if (n?.item && !n.item.pending) {
			const it = n.item, c = it.change
			if (it.ephemeral !== undefined) {
				add(
					"keeps",
					it.ephemeral
						? "ephemeral: goes with its holder"
						: "a document: kept, synced when shared",
					it.ephemeral ? C.dim : C.ink,
				)
			}
			if (c) {
				add("set", V.head(it.version, known), C.ink)
				if (typeof c.reader === "string") add("process", V.short(c.reader), C.ink2)
				if (c.site) add("site", V.site(c.site) ?? show(c.site).replace(/\n\s*/g, " "), C.ink2)
				if (c.cause !== undefined && c.cause !== null) {
					add("cause", show(c.cause).replace(/\n\s*/g, " "), C.ink2)
				}
			} else add("set", "no change kept: the root's first value", C.dim)
			add("id", it.id, C.ink2)
			const route = (it.route ?? []).map((st) => st.name)
			if (route.length) add("route", route.join(" › "), C.dim)
		}
		for (const x of n?.slot ?? []) {
			add(
				lines.some(([l]) => l === "slot") ? "" : "slot",
				`${x.id}${x.node ? "" : " …"}`,
				x.node ? C.ink2 : C.dim,
			)
		}
		if ((n?.items?.length ?? 0) > 1) {
			add("members", `${n.items.length}, the first reached shown`, C.ink2)
		}
		if (n?.below) add("below", `${n.below} ${n.below === 1 ? "name" : "names"}`, C.ink2)
		const lh = LH(),
			lw = blit.measure("members ", FX),
			clip = { x: R.x, y: R.y, w: R.w - 8 * u, h: R.h }
		let y = R.y + 6 * u
		for (const [label, text, c] of lines) {
			if (y + lh > R.y + R.h) break
			const x = R.x + 8 * u
			if (label) blit.text(f, x, y, label, C.dim, undefined, clip, FX)
			if (label === "kind") V.summary(f, x + lw, y, cv.value, { ...cv.o, kind: cv.kind, clip })
			else {
				// cut to the width, a line at a time
				let rest = text
				while (rest.length && y + lh <= R.y + R.h) {
					const k = Math.max(1, blit.fit(rest, R.w - lw - 16 * u, FX))
					blit.text(f, x + lw, y, rest.slice(0, k), c, undefined, clip, FX)
					rest = rest.slice(k)
					if (rest.length) y += lh
				}
			}
			y += lh
		}
	}

	// to VoiceOver: each column a list of the names in a directory; then the bar's names and buttons, what can be clicked in the value
	const meaning = () => {
		const v = latest
		const first = Math.max(0, v.columns.length - COLS)
		const cols = v.columns.slice(first).map((col, ci) => ({
			role: "list",
			label: "/" + col.dir.join("/"),
			x: ci * COLW,
			y: 0,
			w: COLW,
			h: LISTH,
			children: zones.filter((z) => z.act === "go" && z.y < LISTH && z.x === ci * COLW)
				.map(({ x, y, w, h, label, path }) => ({
					role: "button",
					label: [label, path.at(-1) === col.chosen ? "selected" : null].filter((x) => x).join(
						", ",
					),
					x,
					y,
					w,
					h,
				})),
		}))
		const rest = zones.filter((z) => z.y >= LISTH && z.role).map((
			{ x, y, w, h, role, label },
		) => ({ role, label, x, y, w, h }))
		return {
			access: [...cols, {
				role: "group",
				label: "/" + v.path.join("/"),
				x: 0,
				y: LISTH,
				w: W,
				h: H - LISTH,
				children: rest,
			}],
			input: caret
				? {
					text: caret.text,
					selection: [caret.pos, caret.pos],
					caret: { x: caret.x, y: caret.y, w: 2 * u, h: caret.h },
				}
				: null,
		}
	}

	// painted each time what it shows changed, the draw list's segments that did, as a splice; what else the layer
	// holds (its size, access, input, title) only when it changed.
	// gone: a new place written, which the parts have not read yet; drawn once they have
	let gone = false, held = null
	const paint = (api) => {
		if (!idAt(api, LAYER) || gone) return
		const was = segs
		const { out, all } = draw(api)
		segs = out
		const m = meaning()
		const now = {
			w: W,
			h: H,
			access: JSON.stringify(m.access),
			input: JSON.stringify(m.input),
			title: `graph  /${latest.path.join("/")}${
				latest.key.length ? " › " + latest.key.join(" › ") : ""
			}`,
		}
		const patches = []
		if (all || !held) patches.push(set("draw", out.flatMap((g) => g.ops)))
		else {
			// the segments the same at each end, then the ops between
			let p = 0, q = 0
			while (p < was.length && p < out.length && was[p] === out[p]) p++
			while (
				q < was.length - p && q < out.length - p &&
				was[was.length - 1 - q] === out[out.length - 1 - q]
			) q++
			if (p < was.length || p < out.length) {
				const count = (gs) => gs.reduce((n, g) => n + g.ops.length, 0)
				patches.push({
					path: ["draw"],
					range: [count(was.slice(0, p)), count(was.slice(0, was.length - q))],
					value: out.slice(p, out.length - q).flatMap((g) => g.ops),
				})
			}
		}
		for (const k of ["w", "h", "title"]) if (held?.[k] !== now[k]) patches.push(set(k, now[k]))
		if (held?.access !== now.access) patches.push(set("access", m.access))
		if (held?.input !== now.input) patches.push(set("input", m.input))
		held = now
		if (patches.length) api.write(LAYER, patches)
		keep(api)
		menus(api)
	}

	// its menus, in the menu bar while its window has the focus (/programs/wmii): its keys, as what they do here
	let menued = null
	const menus = (api) => {
		const cv = chosen(), n = latest.node
		const enter = !cv
			? "Open"
			: cv.kind === "bool"
			? "Turn Over"
			: cv.kind === "fn" && !cv.key.length
			? "Call…"
			: V.edit(cv.value, cv.kind, cv.o)
			? "Edit Value"
			: cv.kind === "address"
			? "Follow Address"
			: "Open"
		const value = [{
			title: "Graph",
			items: [
				{
					label: enter,
					key: "Enter",
					...(latest.path.length && !n?.unread ? {} : { off: true }),
				},
				{
					label: cv?.kind === "picture" && !latest.key.length
						? "Open in Paint"
						: "Open in Editor",
					key: "e",
					...(latest.path.length && !n?.unread ? {} : { off: true }),
				},
				{ label: "Follow Address", key: "f", ...(cv?.kind === "address" ? {} : { off: true }) },
				"-",
				{ label: s.raw ? "Show View" : "Show JSON", key: "j" },
				{ label: s.hex ? "Hide Hex" : "Show Hex", key: "x" },
				"-",
				{
					label: latest.history ? "Hide History" : "Show History",
					key: "h",
					...(latest.path.length && !n?.unread ? {} : { off: true }),
				},
				{
					label: "Put Back",
					key: "p",
					...(latest.history && "value" in (latest.hist?.list?.[s.hat] ?? {})
						? {}
						: { off: true }),
				},
				"-",
				{ label: "Close", key: "cmd-w" },
			],
		}]
		const text = JSON.stringify(value)
		if (text === menued) return
		menued = text
		keepAt(api, [...owner, "menus"], value)
	}

	// --- doing
	// moving: the path and the key, written to its own node
	const go = (api, path, key = []) => {
		try {
			api.write(AT, whole({ path, key }))
			gone = true
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
		s.scroll = 0
		s.edit = null
	}
	// a value written where it is: a set at its key, or the whole node; what the graph refuses said in cherry
	const write = (api, cv, value) => {
		const { address, key } = cv
		try {
			api.write(address, key.length ? [{ path: key, value }] : whole(value))
			s.note = [`wrote ${V.shown(address)}${key.length ? " › " + key.join(" › ") : ""}`, C.mint]
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
	}
	// a program started for the person: through the window manager's launch, else as this process's own child
	const launch = ({ api, call, start }, op) => {
		const l = val(api, ["/", "dev", "wm", "launch"])
		if (Array.isArray(l)) return call(l, [op])
		const pid = start({ address: op.address, program: op.program })
		if (op.data != null) put(api, pid, "data", op.data)
		return pid
	}
	// e: the node in the editor, a picture in Paint
	const open = (g) => {
		const path = latest.path
		if (!path.length || latest.node?.unread) return
		try {
			if (V.kind(latest.node?.item?.value) === "picture") {
				launch(g, {
					address: ["/", "apps", "paint"],
					program: ["programs", "paint"],
					data: { path },
				})
			} else {launch(g, {
					address: ["/", "apps", "edit"],
					program: ["programs", "edit"],
					data: { path },
				})}
			s.note = [`opened /${path.join("/")}`, C.mint]
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
	}
	const follow = (api, address) => go(api, V.addressOf(address).slice(1))
	// Enter: a simple value edited in place, a boolean turned over, an address followed, else the node opened
	const enter = (g) => {
		const cv = chosen()
		if (!cv) return open(g)
		if (cv.kind === "bool") return write(g.api, cv, !cv.value)
		if (cv.kind === "fn" && !cv.key.length) {
			return void (s.edit = { kind: "call", field: { text: "", pos: 0, mark: null } })
		}
		const field = V.edit(cv.value, cv.kind, cv.o)
		if (field) return void (s.edit = { kind: cv.kind, field })
		if (cv.kind === "address") return follow(g.api, cv.value)
		open(g)
	}
	// do it: a handler called with the args typed, as JSON (none, one, or several with commas); the answer in the footer
	const invoke = ({ call }, cv, text) => {
		let args
		try {
			args = JSON.parse(`[${text}]`)
		} catch (e) {
			return void (s.note = [`not JSON: ${e.message}`, C.cherry])
		}
		try {
			s.note = [`→ ${show(call(cv.address, args)).replace(/\n\s*/g, " ")}`, C.mint]
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
	}
	const done = (g, keepIt) => {
		const e = s.edit
		s.edit = null
		const cv = chosen()
		if (!keepIt || !e || !cv) return
		if (e.kind === "call") return invoke(g, cv, e.field.text)
		const p = V.parse(e.field.text, e.kind)
		if (p.none) return
		if (p.error) return void (s.note = [p.error, C.cherry])
		write(g.api, cv, p.value)
	}

	handler(given, "key", (g) => {
		const { api } = g
		const [recs] = g.args ?? []
		for (const r of recs ?? []) {
			if (s.edit) {
				if (r.down && r.key === "Escape") done(g, false)
				else if (r.down && r.key === "Enter") done(g, true)
				else {
					const next = readline.type(s.edit.field, r, { select: true, api })
					if (next) s.edit.field = next
				}
				continue
			}
			if (!r.down || r.mods?.includes("cmd")) continue
			const v = latest, p = v.path, key = v.key
			s.note = null
			if (v.history) {
				const n = v.hist?.list?.length ?? 0
				if (r.key === "ArrowDown") s.hat = Math.min(Math.max(0, n - 1), s.hat + 1)
				else if (r.key === "ArrowUp") s.hat = Math.max(0, s.hat - 1)
				else if (r.key === "p") putBack(api)
				else if (r.key === "h" || r.key === "Escape" || r.key === "ArrowLeft") {
					history(api, false)
				} else if (r.key === "PageDown") s.scroll += 10 * LH()
				else if (r.key === "PageUp") s.scroll = Math.max(0, s.scroll - 10 * LH())
				continue
			}
			if (key.length && (r.key === "ArrowDown" || r.key === "ArrowUp")) {
				// among the keys of the value it is in
				const ks = keysOf(at(v.node?.item?.value, key.slice(0, -1)))
				const i = ks.indexOf(key.at(-1))
				const to =
					ks[Math.max(0, Math.min(ks.length - 1, i + (r.key === "ArrowDown" ? 1 : -1)))]
				if (to !== undefined) go(api, p, [...key.slice(0, -1), to])
				continue
			}
			const col = v.columns[p.length > 0 ? p.length - 1 : 0]
			const names = col?.entries.filter((e) => !e.refused).map((e) => e.name) ?? []
			const i = names.indexOf(p.at(-1))
			if (r.key === "ArrowDown" && names.length) {
				go(api, [...p.slice(0, -1), names[Math.min(names.length - 1, i + 1)]])
			} else if (r.key === "ArrowUp" && names.length) {
				go(api, [...p.slice(0, -1), names[Math.max(0, i - 1)]])
			} else if (r.key === "ArrowLeft" && key.length) go(api, p, key.slice(0, -1))
			else if (r.key === "ArrowLeft" && p.length) go(api, p.slice(0, -1))
			else if (r.key === "ArrowRight") {
				// a name below, else the value's first key
				const next = key.length ? null : v.columns[p.length]?.entries.find((e) => !e.refused)
				const cv = chosen()
				const ks = ["list", "map", "picture", "view"].includes(cv?.kind) ? keysOf(cv.value) : []
				if (next) go(api, [...p, next.name])
				else if (ks.length) go(api, p, [...key, ks[0]])
			} else if (r.key === "PageDown") s.scroll += 10 * LH()
			else if (r.key === "PageUp") s.scroll = Math.max(0, s.scroll - 10 * LH())
			else if (r.key === "Enter") enter(g)
			else if (r.key === "e") open(g)
			else if (r.key === "f" && chosen()?.kind === "address") follow(api, chosen().value)
			else if (r.key === "j") {
				s.raw = !s.raw
				s.scroll = 0
			} else if (r.key === "x") s.hex = !s.hex
			else if (r.key === "h" && p.length) history(api, true)
		}
		paint(api)
	})

	// the pointer: a name goes there, a key or an address in the value into it; the wheel scrolls the value
	handler(given, "pointer", (g) => {
		const { api } = g
		const [recs] = g.args ?? []
		for (const r of recs ?? []) {
			if (r.event === "scroll") {
				if (r.y >= LISTH) s.scroll = Math.max(0, s.scroll + Math.round(r.dy))
				continue
			}
			if (r.event !== "down") continue
			const b = caret?.b
			if (s.edit && b && r.x >= b.x && r.x < b.x + b.w && r.y >= b.y && r.y < b.y + b.h) {
				s.edit.field = { ...s.edit.field, pos: V.click(caret, r.x), mark: null }
				continue
			}
			if (s.edit) done(g, true)
			const z = V.hit(zones, r.x, r.y)
			if (!z?.act) continue
			s.note = null
			const cv = chosen()
			if (z.act === "go") go(api, z.path, z.key)
			else if (z.act === "into") go(api, latest.path, [...latest.key, z.key])
			else if (z.act === "follow") follow(api, z.address)
			else if (z.act === "toggle" && cv) write(api, cv, !cv.value)
			else if (z.act === "hex") s.hex = !s.hex
			else if (z.act === "hat") s.hat = z.i
			else if (z.act === "raw") {
				s.raw = !s.raw
				s.scroll = 0
			} else if (z.act === "open") open(g)
		}
		paint(api)
	})

	// <its node>/view, read as it changes: a field another wrote (a shell's set) taken on, what it wrote itself let be
	const canon = (v) =>
		JSON.stringify(
			v,
			(_k, x) => (x && typeof x === "object" && !Array.isArray(x)
				? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
				: x),
		)
	effect(given, "theirs", ({ api }) => canon(val(api, VIEW) ?? null), ({ value, api }) => {
		const v = JSON.parse(value)
		const theirs = v && viewed
			? Object.keys(viewed).filter((k) => k in v && canon(v[k]) !== canon(viewed[k]))
			: []
		if (!theirs.length) return
		for (const k of theirs) [s[k], viewed[k]] = [v[k], JSON.parse(JSON.stringify(v[k]))]
		paint(api)
	})

	// --- the size the window manager gives: from /dev/display/windows, not its own layer, which changes each time it
	// draws or moves. The compute's value is "<w>x<h>", a string, so moving the window runs no effect
	effect(given, "size", ({ api }) => {
		const want = val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want
		return want ? `${want.w}x${want.h}` : null
	}, ({ value, api }) => {
		if (!value) return
		const [w, h] = value.split("x").map(Number)
		size(w, h)
		fit(api)
		paint(api)
	})
}
