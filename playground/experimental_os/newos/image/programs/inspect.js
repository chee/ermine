// /programs/inspect: the inspector, as Smalltalk's is for an object, for a
// window: its layer, the process that owns it (its node, its parts, handlers
// and state; the processes above it up to where it was started; the ones
// beside it), its place, its program, what it keeps beside itself, and what
// its last run read and wrote. Every node it shows can be gone into, and
// every value inside one: the left a list, the right the one chosen, drawn
// as what it is. All of it is read in parts that track what they read, so it is live.
//
// Opened for a window: the box left of a title bar's minimize box, cmd-i
// (/etc/keys: inspect), "Inspect the window" in the world menu and the Mac's
// menu bar. Its words are a layer's name; none, the window with the focus.
// /programs/inspect windows lists every window.
//
// Keys: up and down choose, right or cmd-down goes in, left, Backspace or
// cmd-[ goes back, cmd-up to the enclosing node, w the window, a every
// window, g (or /) types an address into the path bar; Enter edits a string, a number or a boolean in place (space
// toggles one), asks an on/<name> handler's args (JSON, a second Enter calls it, the answer in the footer), or goes in; f follows an address, e (cmd-e) opens the node
// in the editor, or in Paint for a picture; x shows whole numbers in hex.
// Click to choose, twice to go in; the path bar goes to any node above.
//
// Where it is, the window it inspects and the way back: at/<its name>
// beside it (/apps/inspect/at/<name>), a document, so a window the session
// brings back is where it was. The row chosen, the scroll, a value being
// edited, hex, the footer's word: <its node>/view, ephemeral, read as it
// changes: a field another writes is taken on.
//
// What core does not tell a read yet: whether a node is ephemeral (a dot or a ring is drawn
// only when an item says), and a change's actor or site (a change says its time, its node and
// the process that made it). A document's history is sync's (newos/drv_sync.c).
import { data, effect, handler, idAt, isStatus, make, put, val, whole } from "ermine:kit"
import { after, here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as views from "ermine:views"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, onCleanup, self, name } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const owner = here(self)
	// where it was started: the node it is in
	const home = owner.slice(0, -1)
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
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(820 * u, mode.w - 40 * u), H = Math.min(540 * u, mode.h - 70 * u)
	const DISPLAY = ["/", "dev", "display"]
	const LAYERS = [...DISPLAY, "layers"]
	const WINDOWS = [...DISPLAY, "windows"]
	const LAYER = [...LAYERS, `inspect-${self}`]
	const AT = [...home, "at", name]
	const set = (key, value) => ({ path: [key], value })
	// a value written whole where a node is, else made there, ephemeral
	const keepAt = (api, address, value) => {
		if (idAt(api, address)) api.write(address, whole(value))
		else make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
	}
	// the look, from /etc/theme: paper, black lines, the chosen row in lemon highlighter, cherry for what is wrong
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
		})
	colours(val(api, ["/", "etc", "theme"]))

	// --- where it is: the window, the page, the way back; a document beside it
	const given_ = data(given) ?? {}
	const asked = given_.args?.[0] ?? given_.window ?? null
	const focus = val(api, [...DISPLAY, "focus"]) ?? null
	// given at (a page) and a note, as pointing at something gives them (wmii's ctl point)
	const first = asked === "windows"
		? { window: focus, at: { page: "windows" }, back: [] }
		: { window: asked ?? focus, at: given_.at ?? { page: "window" }, back: [] }
	if (!idAt(api, AT)) {
		make(api, home, "at", null)
		make(api, AT.slice(0, -1), name, first)
	} else if ((asked && asked !== val(api, AT)?.window) || given_.at) api.write(AT, whole(first))
	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (40 + (n % 5) * 30) * u,
			y: (50 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "Inspector",
			owner,
			draw: [],
		}, { ephemeral: true })
	}

	// every window, [name, value]: a node each, /dev/display/windows/<name>
	const every = (api, read = (a) => val(api, a)) =>
		api.children(WINDOWS).map((n) => [n, read([...WINDOWS, n])])

	// what is on screen besides the graph: the row chosen (its id), the scroll of each side, a value edited, hex
	const s = {
		chosen: null,
		scroll: 0,
		dscroll: 0,
		edit: null,
		hex: false,
		note: null,
		click: { id: null, t: 0 },
	}
	// a key since the last draw: the row chosen scrolled into view
	let reveal = true
	const VIEW = [...owner, "view"]
	const view = val(api, VIEW)
	if (view) { for (const k of Object.keys(s)) if (k in view) s[k] = view[k] }
	if (typeof given_.note === "string") s.note = [given_.note, C.ink2]
	let viewed = view ?? null
	const keep = (api) => {
		const text = JSON.stringify(s)
		if (viewed && JSON.stringify(viewed) === text) return
		keepAt(api, VIEW, JSON.parse(text))
		viewed = JSON.parse(text)
	}

	// --- what a value is: the views library's, hex as this inspector says
	const V = views.make(blit, {
		u,
		colours: C,
		get hex() {
			return s.hex
		},
	})
	const enc = new TextEncoder()
	const names = (v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "string")
	const { addressOf, shown, short, clock, size, order } = V
	const kindOf = (v, key) => V.kind(v, key)

	// --- reading: every read through these, so the compute knows what it saw (its fingerprint)
	let sig = []
	// what each address read last gave, so the right side says what an address reaches without reading it again
	const lastRead = new Map()
	// what a read gave, as these parts keep it: the item's id, whether its node is there, the value and the change that set it
	const got = (i) => {
		const v = i.versions?.find((x) => !isStatus(x))
		return {
			id: i.id,
			pending: !i.node,
			refused: i.refused ? { message: "refused" } : undefined,
			value: i.versions ? (v ? v.content : null) : undefined,
			version: v,
			change: v?.change,
			route: i.route,
			ephemeral: i.ephemeral,
		}
	}
	const rd = (api, address) => {
		try {
			const raw = api.content(address)
			const items = raw.map(got)
			for (const i of items) sig.push(i.change?.time ?? (i.pending ? "p" : "-"))
			sig.push(items.length)
			lastRead.set(shown(address), raw)
			return items
		} catch (e) {
			sig.push("!")
			return [{ refused: e }]
		}
	}
	// a directory: [name, items] for each name
	const ls = (api, address) => {
		try {
			const d = api.children(address).map((n) => [n, api.children(address, n)])
			for (const [n, items] of d) {
				sig.push(n)
				for (const i of items) sig.push(i.id, i.node ? 1 : 0)
			}
			return d
		} catch {
			sig.push("!")
			return []
		}
	}
	const why = (e) =>
		`${e?.code ?? "error"}: ${String(e?.message ?? e).replace(new RegExp(`^${e?.code}: `), "")}`
	// a node under this inspector's own whose value it makes as it reads (its parts' and their runs): not read, so reading is
	// not a loop; nor under another inspector's, in its . (/apps/inspect), so two inspecting each other never redraw each other;
	// nor inside a Files window's process (/apps/files/<it>/…), which Files leaves unread of an inspector's in turn
	const FILES = ["/", "apps", "files"]
	const under = (a, at) => a.length > at.length && at.every((n, i) => a[i] === n)
	const mine = (a) =>
		under(a, owner) || (a.length > owner.length && under(a, home)) ||
		(a.length > FILES.length + 1 && under(a, FILES))

	// a node: its items, the one reached, its names, and whether it is a process (it holds a run)
	const nodeAt = (api, address) => {
		const items = rd(api, address)
		const item = items.find((i) => !i.pending && !i.refused) ?? items[0] ?? null
		const kids = item && !item.refused ? ls(api, address) : []
		const proc = kids.some(([n]) => n === "run")
		return { address, items, item, kids, proc }
	}
	const runOf = (
		api,
		address,
	) => (mine(address) ? null : rd(api, [...address, "run"])[0]?.value ?? null)
	// the address of the program at a node: the one in /programs or /drivers with its id
	const programAt = (api, id) => {
		for (const dir of ["programs", "drivers"]) {
			for (const n of ls(api, ["/", dir])) {
				if (n[1].some((i) => i.id === id)) return ["/", dir, n[0]]
			}
		}
		return null
	}
	// the program a process runs: what launch was given, else the node its run says it came from
	const programOf = (api, run, start) => {
		if (start?.program) return addressOf(start.program)
		return run?.program?.node ? programAt(api, run.program.node) : null
	}

	// --- rows: what the left side lists. A row: {id, name, value, kind, item?, address?, key?, go?, write?, flags, ctx, note?}
	const sec = (title, more) => ({ id: `§${title}`, section: title, more })
	const row = (id, rowName, value, extra = {}) => {
		const kind = extra.kind ?? kindOf(value, extra.keyName ?? rowName)
		const go = extra.go !== undefined
			? extra.go
			: kind === "address"
			? { page: "node", path: addressOf(value).slice(1), key: [] }
			: null
		return { id, name: rowName, value, kind, go, flags: {}, ...extra }
	}
	const fieldRows = (rows, prefix, v, address, key, item, ctx) => {
		const ks = Array.isArray(v) ? v.map((_x, i) => i) : Object.keys(v).sort(order)
		for (const k of ks.slice(0, 400)) {
			const x = v[k], kind = kindOf(x, String(k))
			const into = ["list", "map", "picture", "bytes", "typed", "string"].includes(kind) &&
				address
			rows.push(row(`${prefix}${k}`, Array.isArray(v) ? `[${k}]` : String(k), x, {
				kind,
				item,
				keyName: String(k),
				ctx: ctx ?? v,
				parent: v,
				go: kind === "address"
					? { page: "node", path: addressOf(x).slice(1), key: [] }
					: into
					? { page: "node", path: address.slice(1), key: [...key, k] }
					: null,
				write: address && ["string", "int", "float", "bool", "null"].includes(kind)
					? { address, key: [...key, k] }
					: null,
			}))
		}
		if (ks.length > 400) {
			rows.push(row(`${prefix}…`, "…", `${ks.length - 400} more`, { kind: "string" }))
		}
	}
	// a node's names as rows: each a node, its value previewed, a process marked; on/<name> handlers one row each
	const childRows = (api, rows, address, kids, prefix, pids, made) => {
		// a part runs its maker's program (a compute, an effect); a process inside it, a program of its own
		const maker = made !== undefined
			? made
			: kids.some(([n]) => n === "run")
			? runOf(api, address)?.program?.node ?? null
			: null
		for (const [n, items] of kids) {
			if (n === "run") continue
			const at = [...address, n]
			if (n === "on") {
				for (const [h, hitems] of ls(api, at)) {
					const it = rd(api, [...at, h])[0]
					rows.push(
						row(`${prefix}on/${h}`, `on/${h}`, it?.value, {
							item: it,
							address: [...at, h],
							go: { page: "node", path: [...at, h].slice(1), key: [] },
							flags: { e: hitems.some((i) => i.ephemeral === true) },
						}),
					)
				}
				continue
			}
			const pending = items.length > 0 && items.every((i) => !i.node)
			const sub = pending
				? { items, item: { ...items[0], pending: true }, kids: [], proc: false }
				: nodeAt(api, at)
			const run = sub.proc ? runOf(api, at) : null
			if (sub.proc) { for (const i of items) pids[i.id] = n }
			const own = sub.proc && mine(at)
			const v = own ? undefined : sub.item?.value
			rows.push(row(`${prefix}${n}`, n, v, {
				item: sub.item,
				address: at,
				go: { page: "node", path: at.slice(1), key: [] },
				write: !sub.proc && ["string", "int", "float", "bool"].includes(kindOf(v, n))
					? { address: at, key: [] }
					: null,
				flags: {
					e: items.some((i) => i.ephemeral === true),
					doc: items.length > 0 && items.every((i) => i.ephemeral === false),
					proc: sub.proc,
					part: !!maker && run?.program?.node === maker,
					run,
					pending,
					refused: !!sub.item?.refused,
					many: items.length,
					kids: sub.kids.filter(([k]) => k !== "run").length,
				},
			}))
		}
	}

	const opsNote = (ops) => V.ops(ops)
	// a plane: its pixels where a driver keeps them, outside the graph; serial its count of images
	const planeNote = (p) =>
		`${p.source ?? "?"} #${p.id ?? "?"} · image ${p.serial ?? 0}${
			p.dirty ? ` · drew ${p.dirty.w}×${p.dirty.h} at ${p.dirty.x},${p.dirty.y}` : " · whole"
		}`
	// a program by what it needs (its info ermine.program.provisions: loader.c) and what its value holds
	const programNote = (pv, needs = []) => {
		const by = needs.length ? needs.join(", ") : "needs nothing said"
		if (typeof pv === "string") return `${by} · ${size(enc.encode(pv).length)} of source`
		if (typeof pv?.source === "string") {
			return `${by} · ${size(enc.encode(pv.source).length)} of source`
		}
		if (pv?.argv) return `${by} · ${(pv.argv ?? []).join(" ")}`
		if (typeof pv?.name === "string") return `${by} · ${pv.name}`
		return `${by} · ${kindOf(pv)}`
	}
	const runNote = (run) =>
		`run ${run.run ?? "?"} · ${run.ended ?? "running"} · ${(run.reads ?? []).length} reads · ${
			(run.wrote ?? []).length
		} writes${run.rank ? " · rank " + run.rank : ""}`
	// what a run read: its address as names, or an id
	const readAt = (
		x,
	) => (Array.isArray(x.address)
		? x.address.join("/")
		: x.address !== undefined
		? String(x.address)
		: x.name ?? "")
	const isProc = (api, address) => {
		try {
			return api.children(address).some((n) => n === "run")
		} catch {
			return false
		}
	}

	// what it shows, as the parts last read it (show, below)
	let latest = { rows: [], doc: {}, at: { page: "window" }, target: null, pids: {} }

	// --- drawing
	const TOOL = () => blit.height(FT) + 10 * u
	const FOOT = () => blit.height(F) + 8 * u
	const RH = () => Math.max(blit.height(F), blit.height(FX)) + 4 * u
	const LH = () => blit.height(FX) + u
	let zones = []
	let caret = null
	const button = (f, x, y, label, act, on = true) => {
		const w = blit.measure(label, FT) + 14 * u, h = blit.height(FT) + 4 * u
		blit.fill(f, x, y, w, h, C.line)
		blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
		blit.text(f, x + 7 * u, y + 2 * u, label, on ? C.ink : C.dim, undefined, undefined, FT)
		zones.push({ x, y, w, h, act: on ? act : null, role: "button", label })
		return x + w
	}
	const { text: pieces, tag, fitted } = V

	const LW = () => Math.floor(W * 0.48)
	const NAMEW = () => Math.min(150 * u, Math.floor(LW() * 0.36))
	// the draw list in segments, each {key, ops, zones, caret}: the paper, the bar, each row shown, the list's
	// end, the line between, the one chosen, the footer. A segment whose key, what it is drawn from, is as it
	// was is not drawn again, and only the ops from the first that changed to the last are written, a splice
	// of the layer's draw (paint, below). Fonts, colours, the size or hex changed: all of it
	let segs = [], style = null
	// a row as it is drawn: a list, a map or a long string by its badge and its line, what the row shows of it
	const stamp = (r) => {
		if (!r) return "none"
		const v = r.value
		const val = v === undefined
			? "u"
			: (v === null || typeof v !== "object") && !(typeof v === "string" && v.length > 512)
			? JSON.stringify(v)
			: JSON.stringify([
				V.badge(v, r.kind),
				V.pieces(v, r.kind, r.keyName ?? r.name, ctxName(r)),
			])
		return JSON.stringify([
			r.id,
			r.name,
			r.kind,
			r.note ?? null,
			r.refused ?? null,
			r.flags.run ? runNote(r.flags.run) : null,
			{ ...r.flags, run: undefined },
			val,
		])
	}
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
		const top = TOOL(), foot = FOOT(), rh = RH(), lw = LW()
		seg("paper", (f) => blit.fill(f, 0, 0, W, H, C.paper))
		// the bar: back, up, the window, every window, then the path, each name a way there
		seg(
			`bar ${
				JSON.stringify([
					(v.doc.back ?? []).length > 0,
					v.at,
					v.target?.title ?? null,
					v.target?.name ?? null,
					s.edit?.row === "§path" ? s.edit.field : null,
				])
			}`,
			(f) => {
				blit.fill(f, 0, 0, W, top, C.chrome)
				blit.fill(f, 0, top - u, W, u, C.line)
				let x = button(f, 6 * u, 3 * u, "◀", "back", (v.doc.back ?? []).length > 0) + 4 * u
				x = button(
					f,
					x,
					3 * u,
					"▲",
					"up",
					v.at.page === "node" &&
						((v.at.path ?? []).length > 0 || (v.at.key ?? []).length > 0),
				) + 4 * u
				x = button(f, x, 3 * u, "Window", "window", !!v.target && v.at.page !== "window") +
					4 * u
				x = button(f, x, 3 * u, "All", "windows", v.at.page !== "windows") + 10 * u
				const crumbs = v.at.page === "node" || v.at.page === "history"
					? [
						{ text: "/", go: { page: "node", path: [], key: [] } },
						...(v.at.path ?? []).map((n, i) => ({
							text: n,
							go: { page: "node", path: v.at.path.slice(0, i + 1), key: [] },
						})),
						...(v.at.key ?? []).map((k, i) => ({
							text: `›${k}`,
							go: { page: "node", path: v.at.path, key: v.at.key.slice(0, i + 1) },
						})),
						...(v.at.page === "history" ? [{ text: "› history", go: null }] : []),
					]
					: v.at.page === "window" && v.target
					? [{ text: `${v.target.title || v.target.name}`, go: null }]
					: [{ text: "every window", go: null }]
				const ty = Math.floor((top - blit.height(F)) / 2)
				const room = { x, y: 0, w: W - x - 6 * u, h: top }
				// g: the path bar a field, an address typed
				if (s.edit?.row === "§path") {
					caret = V.field(f, {
						x,
						y: 3 * u,
						w: W - x - 8 * u,
						h: top - 7 * u,
					}, s.edit.field)
				} else {crumbs.forEach((c, i) => {
						if (x >= W - 6 * u) return
						const t = (i > 1 && !c.text.startsWith("›") ? "/" : "") + c.text
						const end = blit.text(
							f,
							x,
							ty,
							t,
							i === crumbs.length - 1 ? C.ink : C.rose,
							undefined,
							room,
							F,
						)
						if (c.go) {
							zones.push({
								x,
								y: 0,
								w: end - x,
								h: top,
								act: "go",
								go: c.go,
								role: "link",
								label: c.text,
							})
						}
						x = end + 2 * u
					})}
			},
		)
		// the list
		const list = { x: 0, y: top, w: lw, h: H - foot - top }
		const seen = Math.max(1, Math.floor(list.h / rh))
		const rows = v.rows
		if (!rows.some((r) => r.id === s.chosen && !r.section)) {
			s.chosen = rows.find((r) => !r.section)?.id ?? null
		}
		// the keyboard keeps the row chosen in view; the wheel lets it go
		const at = rows.findIndex((r) => r.id === s.chosen)
		if (reveal && at >= 0 && at < s.scroll) s.scroll = at
		if (reveal && at >= s.scroll + seen) s.scroll = at - seen + 1
		reveal = false
		s.scroll = Math.max(0, Math.min(s.scroll, rows.length - seen))
		const NW = NAMEW()
		rows.slice(s.scroll, s.scroll + seen).forEach((r, i) => {
			const y = top + i * rh
			if (r.section) {
				return seg(`section ${i} ${JSON.stringify([r.section, r.more ?? null])}`, (f) => {
					blit.fill(f, 0, y, lw, rh, C.chrome)
					blit.fill(f, 0, y + rh - u, lw, u, C.lo)
					const end = blit.text(
						f,
						6 * u,
						y + Math.floor((rh - blit.height(FT)) / 2),
						fitted(r.section, lw - 12 * u, FT),
						C.ink,
						undefined,
						list,
						FT,
					)
					if (r.more) {
						blit.text(
							f,
							end + 8 * u,
							y + Math.floor((rh - blit.height(F)) / 2),
							fitted(r.more, lw - end - 14 * u, F),
							C.dim,
							undefined,
							list,
							F,
						)
					}
				})
			}
			const on = r.id === s.chosen
			seg(
				`row ${i} ${on} ${s.edit?.row === r.id ? JSON.stringify(s.edit.field) : ""} ${
					stamp(r)
				}`,
				(f) => {
					if (on) blit.fill(f, 0, y, lw, rh, C.lemon)
					const clip = { x: 0, y, w: lw - 4 * u, h: rh }
					const ny = y + Math.floor((rh - blit.height(F)) / 2),
						vy = y + Math.floor((rh - blit.height(FX)) / 2)
					let nx = 8 * u
					// a process: a cherry dot; a document: a black one; ephemeral: hollow
					if (r.flags.proc) {
						blit.fillellipse(f, nx + 2 * u, y + Math.floor(rh / 2), 3 * u, 3 * u, C.cherry)
					} else if (r.flags.doc) {
						blit.fillellipse(f, nx + 2 * u, y + Math.floor(rh / 2), 2 * u, 2 * u, C.line)
					} else if (r.flags.e) {
						blit.ellipse(f, nx + 2 * u, y + Math.floor(rh / 2), 2 * u, 2 * u, u, C.dim)
					}
					nx += 10 * u
					const nameEnd = blit.text(
						f,
						nx,
						ny,
						fitted(r.name, NW - nx - 4 * u, F),
						r.refused || r.flags.refused ? C.cherry : r.flags.proc ? C.cherry : C.ink,
						undefined,
						{ x: 0, y, w: NW - 2 * u, h: rh },
						F,
					)
					if (r.flags.many > 1) {
						blit.text(
							f,
							Math.min(nameEnd + 2 * u, NW - 14 * u),
							ny,
							`×${r.flags.many}`,
							C.dim,
							undefined,
							undefined,
							F,
						)
					}
					let bx = NW
					if (s.edit?.row === r.id) {
						caret = V.field(
							f,
							{ x: bx, y: y + u, w: lw - bx - 6 * u, h: rh - 2 * u },
							s.edit.field,
						)
					} else {
						const b = r.flags.proc
							? (r.flags.part ? "part" : "proc")
							: r.flags.pending
							? "…"
							: V.badge(r.value, r.kind)
						bx = r.kind === "fn" && !r.flags.proc
							? tag(f, bx, vy, "fn", C.paper, C.line, C.line)
							: r.kind === "live"
							? tag(f, bx, vy, b, C.lilac, undefined, C.lilac)
							: tag(f, bx, vy, b, r.flags.proc ? C.cherry : C.ink2)
						if (
							r.kind === "address" ||
							(r.note &&
								(r.kind === "null" || r.id.startsWith("r.") || r.name === "draw" ||
									r.id === "w.plane"))
						) {
							const px = r.kind === "address"
								? pieces(f, bx, vy, V.pieces(r.value, r.kind), clip) + 6 * u
								: bx
							if (r.note) {
								blit.text(f, px, vy, r.note, C.dim, undefined, clip, FX)
							}
						} else if (r.flags.proc && (r.value === undefined || r.value === null)) {
							blit.text(
								f,
								bx,
								vy,
								r.flags.run ? runNote(r.flags.run) : `${r.flags.kids} below`,
								C.dim,
								undefined,
								clip,
								FX,
							)
						} else {pieces(
								f,
								bx,
								vy,
								V.pieces(r.value, r.kind, r.keyName ?? r.name, ctxName(r)),
								clip,
							)}
					}
					zones.push({
						x: 0,
						y,
						w: lw,
						h: rh,
						act: "row",
						id: r.id,
						role: "button",
						label: `${r.name}, ${r.flags.proc ? "process" : r.kind}`,
					})
				},
			)
		})
		seg(`end ${rows.length > 0} ${v.gone ?? ""} ${Math.min(rows.length + 1, seen - 1)}`, (f) => {
			if (!rows.length) {
				blit.text(f, 12 * u, top + 10 * u, "nothing to show", C.dim, undefined, undefined, F)
			}
			if (v.gone) {
				blit.text(
					f,
					12 * u,
					top + rh * Math.min(rows.length + 1, seen - 1),
					fitted(`${v.gone} is gone: choose another window`, lw - 24 * u, F),
					C.cherry,
					undefined,
					undefined,
					F,
				)
			}
			blit.fill(f, lw, top, u, H - foot - top, C.line)
		})
		// the one chosen, as what it is; an address says what it reaches, so it is drawn again with anything that changes
		const chosen = rows.find((r) => r.id === s.chosen) ?? rows.find((r) => !r.section) ?? null
		const there = chosen?.kind === "address"
			? lastRead.get(shown(addressOf(chosen.value)))?.[0]?.versions?.[0]?.change?.time ?? null
			: null
		// the right side also says the change that set it, and where it is; a list, a map or a long string drawn whole,
		// so by the change that set it
		const item = chosen?.item
			? JSON.stringify([
				chosen.item.change?.time ?? null,
				chosen.item.id ?? null,
				chosen.item.ephemeral ?? null,
			])
			: ""
		seg(
			`detail ${s.dscroll} ${there} ${item} ${JSON.stringify(v.pids)} ${stamp(chosen)}`,
			(f) =>
				detail(f, api, chosen, { x: lw + u, y: top, w: W - lw - u, h: H - foot - top }, v.pids),
		)
		// the footer: a word, else what the keys do
		const said = s.note ??
			[
				s.edit?.kind === "path"
					? "an address: Enter goes there, Escape lets it be"
					: s.edit?.kind === "call"
					? "args as JSON: Enter calls it, Escape lets it be"
					: s.edit
					? "Enter writes it, Escape lets it be"
					: latest.at.page === "history"
					? "↑↓ choose · p puts it back · h the node · ← back"
					: "↑↓ choose · → go in · ← back · Enter edit · f follow · e editor · g go to · x hex · h history · w window · a all",
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
				fitted(said[0], W - 16 * u, F),
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
	// a row inside a picture's colors: each a colour, whatever its key
	const ctxName = (
		r,
	) => (r.id.startsWith("f.") && latest.at.key?.at(-1) === "colors" ? "colors" : undefined)
	// names for ids (V.ids), read again at most once a second as it draws
	let known = { pids: {}, t: 0 }
	const ids = (api) => {
		if (Date.now() - known.t > 1000) known = { ...V.ids(api), t: Date.now() }
	}
	// --- the right side: the row chosen, drawn as what it is. Blocks, each {h, draw(f, x, y)}, scrolled by dscroll
	const detail = (f, api, r, R, pids) => {
		const B = V.blocks(f, R.w - 20 * u)
		const { w, line, text, rule } = B
		if (!r) {
			text("choose a row", C.dim, F)
		} else {
			const v = r.value, kind = r.flags.proc && r.value === undefined ? "proc" : r.kind
			// the head: its name, what it is and how much
			B.push(blit.height(FT) + 4 * u, (x, y, clip) => {
				const end = blit.text(
					f,
					x,
					y,
					fitted(r.name, w - 120 * u, FT),
					r.flags.proc ? C.cherry : C.ink,
					undefined,
					clip,
					FT,
				)
				tag(
					f,
					end + 8 * u,
					y + Math.floor((blit.height(FT) - blit.height(FX)) / 2),
					r.flags.proc ? (r.flags.part ? "part" : "process") : kind,
					C.ink2,
				)
			})
			// what an address reaches: as a part last read it, else read now
			const reach = { content: (a) => lastRead.get(shown(a)) ?? api.content(a) }
			const o = {
				key: r.keyName ?? r.name,
				name: r.name,
				ctx: ctxName(r),
				parent: r.parent ?? r.ctx,
				write: !!r.write,
				address: r.address,
				api: reach,
				pending: r.flags.pending,
				why,
			}
			const about = V.about(v, kind, o)
			if (about) text(about, C.ink2, F)
			// where it came from: the change that set it, who; ephemeral or a document, where it says
			const it = r.item
			if (it && !it.refused) {
				const c = it.change
				const where = [
					it.ephemeral === undefined ? null : it.ephemeral ? "ephemeral" : "document",
					it.id ? `id ${short(it.id)}` : null,
					(it.route ?? []).length
						? `route ${(it.route ?? []).map((st) => st.name).join("/")}`
						: null,
				].filter((x) => x)
				if (c) {
					ids(api)
					text(`set ${V.head(it.version, { pids: { ...known.pids, ...pids } })}`, C.dim)
					if (c.site?.function) text(`site ${V.site(c.site)} ${c.site.function}`, C.dim)
				} else text("no change kept: the root's first value", C.dim)
				text(where.join(" · "), C.dim)
				if (c?.cause !== undefined && c?.cause !== null) {
					text(`cause ${JSON.stringify(c.cause)}`, C.dim)
				}
			}
			if (r.note) text(r.note, C.dim)
			// a process or a part: its last run, and what it read
			const run = r.flags.run
			if (run) {
				rule()
				text(
					`${r.flags.part ? "a part of its maker's program" : "a process"} · ${runNote(run)}`,
					C.ink2,
					F,
				)
				for (const x of (run.reads ?? []).slice(-12)) {
					line([
						[`${String(x.op).padEnd(9)} `, C.ink2],
						[readAt(x), x.tracked ? C.ink : C.dim],
						[x.times?.length ? "" : "  (nothing)", C.dim],
					])
				}
				// the run keeps when it wrote, not what (the scheduler's wrote: times)
				if (run.wrote?.length) {
					text(
						`wrote ${run.wrote.length}× at ${
							run.wrote.slice(-6).map(clock).join(" ")
						}: when, not what`,
						C.dim,
					)
				}
				if (r.value !== undefined) {
					text(r.flags.part ? "its value, what its compute gave:" : "its value:", C.dim, F)
				}
			}
			rule()
			V.body(B, v, kind, o)
		}
		// laid out from dscroll down
		s.dscroll = V.lay(B, R, s.dscroll)
		zones.push(...B.zones)
	}

	// to VoiceOver: the bar's buttons and names, then each row a button
	const meaning = () => ({
		access: [{
			role: "group",
			label: "Inspector",
			x: 0,
			y: 0,
			w: W,
			h: H,
			children: zones.filter((z) => z.role).map(({ x, y, w, h, role, label }) => ({
				role,
				label,
				x,
				y,
				w,
				h,
			})),
		}],
		input: caret
			? {
				text: caret.text,
				selection: [caret.pos, caret.pos],
				caret: { x: caret.x, y: caret.y, w: 2 * u, h: caret.h },
			}
			: null,
	})
	const title = () => {
		const v = latest
		const t = v.target ? v.target.title || v.target.name : v.gone ?? "every window"
		return v.at.page === "node" || v.at.page === "history"
			? `Inspector  ${t}  /${(v.at.path ?? []).join("/")}${
				v.at.page === "history" ? "  history" : ""
			}`
			: `Inspector  ${t}`
	}
	// painted each time what it shows changed, the draw list's segments that did, as a splice; what else the layer
	// holds (its size, access, input, title) only when it changed. gone: a new page written, whose rows the parts
	// have not read yet; drawn once they have. shows: how many times the parts changed it
	let gone = false, held = null
	const paint = (api) => {
		if (gone || !idAt(api, LAYER)) return
		const was = segs
		const { out, all } = draw(api)
		segs = out
		const m = meaning()
		const now = {
			w: W,
			h: H,
			access: JSON.stringify(m.access),
			input: JSON.stringify(m.input),
			title: title(),
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
				const from = count(was.slice(0, p)), to = count(was.slice(0, was.length - q))
				patches.push({
					path: ["draw"],
					range: [from, to],
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

	// its menus, in the menu bar while its window has the focus (/programs/wmii): written as what it shows changes,
	// what can't be done here greyed
	let menued = null
	const menus = (api) => {
		const r = chosen(), at = latest.at
		const off = (no) => (no ? { off: true } : {})
		const value = [{
			title: "Inspect",
			items: [
				{ label: "Back", key: "cmd-[", ...off(!(latest.doc.back ?? []).length) },
				{
					label: "Enclosing Node",
					key: "cmd-ArrowUp",
					...off(at.page !== "node" || !((at.key ?? []).length || (at.path ?? []).length)),
				},
				{ label: "Go In", key: "cmd-ArrowDown", ...off(!r?.go) },
				"-",
				{ label: "The Window", call: "menu", args: ["window"], ...off(!latest.target) },
				{ label: "Every Window", call: "menu", args: ["windows"] },
				"-",
				{
					label: r?.kind === "fn" && r.address ? "Call…" : "Edit Value",
					key: "Enter",
					...off(
						!r ||
							!(r.write || r.go || r.kind === "address" || (r.kind === "fn" && r.address)),
					),
				},
				{
					label: "Follow Address",
					call: "menu",
					args: ["follow"],
					...off(r?.kind !== "address"),
				},
				{ label: "Open in Editor", key: "cmd-e" },
				"-",
				{ label: s.hex ? "Hide Hex" : "Show Hex", call: "menu", args: ["hex"] },
				"-",
				{
					label: at.page === "history" ? "Hide History" : "History",
					call: "menu",
					args: ["history"],
					key: "h",
					...off(at.page !== "history" && at.page !== "node" && !r?.address),
				},
				{
					label: "Put Back",
					call: "menu",
					args: ["put"],
					key: "p",
					...off(!r?.hist || !("value" in r.hist.change)),
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
	const selectable = () => latest.rows.filter((r) => !r.section)
	const chosen = () => latest.rows.find((r) => r.id === s.chosen) ?? null
	// going somewhere: written to its document, the way back kept (the last 40)
	const go = (api, to) => {
		const doc = latest.doc
		const next = to.window !== undefined
			? {
				...doc,
				window: to.window,
				at: { page: "window" },
				back: [...(doc.back ?? []), { window: doc.window, at: doc.at }].slice(-40),
			}
			: {
				...doc,
				at: to,
				back: [...(doc.back ?? []), { window: doc.window, at: doc.at }].slice(-40),
			}
		try {
			api.write(AT, whole(next))
			latest = { ...latest, doc: next, at: next.at }
			gone = true
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
		s.chosen = null
		s.scroll = 0
		s.dscroll = 0
		s.edit = null
	}
	const back = (api) => {
		const doc = latest.doc, b = doc.back ?? []
		if (!b.length) return
		const last = b.at(-1)
		const next = {
			...doc,
			window: last.window ?? doc.window,
			at: last.at ?? { page: "window" },
			back: b.slice(0, -1),
		}
		api.write(AT, whole(next))
		latest = { ...latest, doc: next, at: next.at }
		gone = true
		s.chosen = null
		s.scroll = 0
		s.dscroll = 0
		s.edit = null
	}
	const up = (api) => {
		const at = latest.at
		if (at.page === "history") {
			return go(api, { page: "node", path: at.path ?? [], key: at.key ?? [] })
		}
		if (at.page !== "node") return
		if ((at.key ?? []).length) go(api, { page: "node", path: at.path, key: at.key.slice(0, -1) })
		else if ((at.path ?? []).length) {
			go(api, { page: "node", path: at.path.slice(0, -1), key: [] })
		}
	}
	const into = (api, r) => {
		if (r?.go) go(api, r.go)
	}
	const follow = (api, r) => {
		if (r?.kind === "address") {
			go(api, { page: "node", path: addressOf(r.value).slice(1), key: [] })
		} else into(api, r)
	}
	// a value written where it is: a set at its key, or the whole node; what the graph refuses said in cherry
	const write = (api, r, value) => {
		if (!r?.write) return void (s.note = ["not writable here", C.cherry])
		const { address, key } = r.write
		try {
			api.write(address, key.length ? [{ path: key, value }] : whole(value))
			s.note = [`wrote ${shown(address)}${key.length ? " › " + key.join(" › ") : ""}`, C.mint]
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
	const open = (g, r) => {
		const a = r?.kind === "address"
			? addressOf(r.value)
			: r?.address ?? (latest.at.page === "node" ? ["/", ...(latest.at.path ?? [])] : null)
		if (!a || a.length < 2) return void (s.note = ["no node to open", C.dim])
		const path = a.slice(1)
		const v = val(g.api, a)
		try {
			if (kindOf(v) === "picture") {
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
			s.note = [`opened ${shown(a)}`, C.mint]
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
	}
	const edit = (g, r) => {
		if (!r) return
		if (r.kind === "bool" && r.write) return write(g.api, r, !r.value)
		if (r.kind === "string" && r.write && r.value.includes("\n")) return open(g, r)
		if (r.kind === "fn" && r.address) {
			return void (s.edit = { row: r.id, kind: "call", field: { text: "", pos: 0, mark: null } })
		}
		const field = r.write
			? V.edit(r.value, r.kind, { key: r.keyName ?? r.name, ctx: ctxName(r) })
			: null
		if (field) return void (s.edit = { row: r.id, kind: r.kind, field })
		if (r.go) return into(g.api, r)
		if (r.kind === "address") return follow(g.api, r)
	}
	const done = (g, keepIt) => {
		const e = s.edit
		s.edit = null
		if (!keepIt || !e) return
		const { api, call } = g
		const r = latest.rows.find((x) => x.id === e.row)
		const t = e.field.text
		if (e.kind === "path") {
			return go(api, {
				page: "node",
				path: t.split("/").filter((n) => n && n !== "."),
				key: [],
			})
		}
		// do it: the handler called with the args typed, as JSON (none, one, or several with commas); the answer in the footer
		if (e.kind === "call" && r) {
			let args
			try {
				args = JSON.parse(`[${t}]`)
			} catch (x) {
				return void (s.note = [`not JSON: ${x.message}`, C.cherry])
			}
			try {
				const got = call(r.address, args)
				let text
				try {
					text = JSON.stringify(got) ?? "undefined"
				} catch {
					text = String(got)
				}
				s.note = [`→ ${text}`, C.mint]
			} catch (x) {
				s.note = [why(x), C.cherry]
			}
			return
		}
		// a number as written: decimal, 0x…, #RRGGBB; a null may become anything JSON says
		const p = V.parse(t, e.kind)
		if (p.none) return
		if (p.error) return void (s.note = [p.error, C.cherry])
		write(api, r, p.value)
	}
	const move = (by) => {
		const rs = selectable()
		const i = rs.findIndex((r) => r.id === s.chosen)
		const to = rs[Math.max(0, Math.min(rs.length - 1, i < 0 ? 0 : i + by))]
		if (to) s.chosen = to.id
		s.dscroll = 0
	}
	const act = (api, what) => {
		s.note = null
		if (what === "back") back(api)
		else if (what === "up") up(api)
		else if (what === "window" && latest.target) go(api, { page: "window" })
		else if (what === "windows") go(api, { page: "windows" })
		else if (what === "hex") s.hex = !s.hex
		else if (what === "follow") follow(api, chosen())
		else if (what === "toggle") edit({ api }, chosen())
		else if (what === "history") history(api)
		else if (what === "put") putBack(api, chosen())
	}
	// h: the history of the node shown (at its key), else of the row chosen's node
	const history = (api) => {
		const at = latest.at, r = chosen()
		if (at.page === "history") return up(api)
		if (at.page === "node") {
			return go(api, { page: "history", path: at.path ?? [], key: at.key ?? [] })
		}
		const a = r?.address ?? (r?.kind === "address" ? addressOf(r.value) : null)
		if (a) go(api, { page: "history", path: a.slice(1), key: [] })
	}

	handler(given, "menu", (g) => {
		const [what] = g.args ?? []
		act(g.api, what)
		paint(g.api)
	})

	// --- the keyboard
	handler(given, "key", (g) => {
		const { api } = g
		const [recs] = g.args ?? []
		reveal = true
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
			if (!r.down) continue
			const cmd = r.mods?.includes("cmd")
			const k = r.key
			s.note = null
			if (cmd && k === "[") back(api)
			else if (cmd && k === "ArrowUp") up(api)
			else if (cmd && k === "ArrowDown") into(api, chosen())
			else if (cmd && k === "e") open(g, chosen())
			else if (cmd) continue
			else if (k === "ArrowDown") move(1)
			else if (k === "ArrowUp") move(-1)
			else if (k === "PageDown") move(10)
			else if (k === "PageUp") move(-10)
			else if (k === "Home") s.chosen = selectable()[0]?.id ?? null
			else if (k === "End") s.chosen = selectable().at(-1)?.id ?? null
			else if (k === "ArrowRight") into(api, chosen())
			else if (k === "ArrowLeft" || k === "Backspace") back(api)
			else if (k === "Enter") edit(g, chosen())
			else if (k === " " && chosen()?.kind === "bool") edit(g, chosen())
			else if (k === "f") follow(api, chosen())
			else if (k === "e") open(g, chosen())
			else if (k === "x") s.hex = !s.hex
			else if (k === "h") act(api, "history")
			else if (k === "p") act(api, "put")
			else if (k === "w") act(api, "window")
			else if (k === "a") act(api, "windows")
			else if (k === "u") up(api)
			else if (k === "g" || k === "/") {
				const t = "/" + (latest.at.page === "node" ? (latest.at.path ?? []).join("/") : "")
				s.edit = { row: "§path", kind: "path", field: { text: t, pos: t.length, mark: null } }
			} else if (k === "j") s.dscroll += 3 * LH()
			else if (k === "k") s.dscroll = Math.max(0, s.dscroll - 3 * LH())
		}
		paint(api)
	})

	// --- the pointer: a click chooses a row, two go in or edit; the bar's buttons and names; the wheel scrolls either side
	let rest = 0
	handler(given, "pointer", (g) => {
		const { api } = g
		const [recs] = g.args ?? []
		for (const r of recs ?? []) {
			if (r.event === "scroll") {
				if (r.x >= LW()) s.dscroll = Math.max(0, s.dscroll + Math.round(r.dy))
				else {
					rest += r.dy / RH()
					const n = Math.trunc(rest)
					rest -= n
					s.scroll = Math.max(0, s.scroll + n)
				}
				continue
			}
			if (r.event !== "down") continue
			const z = [...zones].reverse().find((z) =>
				r.x >= z.x && r.x < z.x + z.w && r.y >= z.y && r.y < z.y + z.h
			)
			if (z?.act === "row" && s.edit?.row === z.id && caret) {
				const c = V.click(caret, r.x)
				s.edit.field = { ...s.edit.field, pos: c, mark: null }
				continue
			}
			if (s.edit) done(g, true)
			if (!z) continue
			s.note = null
			if (z.act === "row") {
				const now = Date.now(), twice = s.click.id === z.id && now - s.click.t < 500
				if (s.chosen !== z.id) s.dscroll = 0
				s.chosen = z.id
				s.click = { id: z.id, t: twice ? 0 : now }
				if (twice) edit(g, chosen())
			} else if (z.act === "go") go(api, z.go)
			else if (z.act) act(api, z.act)
		}
		paint(api)
	})

	// --- following what it shows: the parts; the look and the size the window manager gives, from
	// /dev/display/windows, not its own layer, which changes each time it draws or moves
	// the page, in parts: each a compute of its own that reads only what its rows show, so a change reads
	// again only what it touched (a window moving: its layer's rows, not its process's tree, nor what its
	// last run read) and only the rows that changed are drawn again (Drawing, below).
	// What several parts read is found once, by an effect whose run writes it at <its node>/shows/<name>
	// when it changed: not a compute's own node, which is written each time it is due (its status, pending),
	// so a window moving would read every part again. The compute's value is JSON text, a string: the effect
	// runs when it is not the last, as it did when values were compared whole
	const SHOWS = [...owner, "shows"]
	make(api, owner, "shows", null, { ephemeral: true })
	const derive = (n, fn) =>
		effect(
			given,
			n,
			({ api }) => JSON.stringify(fn({ api }) ?? null),
			({ value, api }) => keepAt(api, [...SHOWS, n], JSON.parse(value)),
		)
	// where: the page, the window, and whose process it is about, so the window moving, which changes
	// /dev/display/windows/<its name>, reads this again and no more
	const WHERE = [...SHOWS, "where"],
		CLIENT = [...SHOWS, "client"],
		SUBJECT = [...SHOWS, "subject"],
		BELOW = [...SHOWS, "kids"]
	derive("where", ({ api }) => {
		const doc = val(api, AT) ?? first
		const at = doc.at ?? { page: "window" }
		const w = doc.window ? val(api, [...WINDOWS, doc.window]) : null
		const target = w
			? {
				name: doc.window,
				title: w.title ?? null,
				owner: Array.isArray(w.owner) ? w.owner : null,
			}
			: null
		// a window's owner, whether a process or not (a driver's node); a node shown, if it holds a run
		let owner = null
		if (at.page === "window") owner = target?.owner ?? null
		else if (at.page === "node" && !(at.key ?? []).length) {
			const A = ["/", ...(at.path ?? [])]
			if (!mine(A) && isProc(api, A)) owner = A
		}
		return { doc, at, target, owner }
	})
	// the session's client: the window's, else the one whose node is the owner; {name, start}, so its geometry
	// changing (a drag writes it each move) reads this again and no more
	derive("client", ({ api }) => {
		const w = val(api, WHERE)
		const owner = w?.owner
		if (!owner) return null
		// a client is named by its window's layer: the window's, else the windows whose owner is the node shown
		const layer = w.at.page === "window" ? w.target?.name : null
		const names = layer
			? [layer]
			: every(api).filter(([, x]) => Array.isArray(x?.owner) && shown(x.owner) === shown(owner))
				.map(([n]) => n)
		for (const n of names) {
			const c = val(api, ["/", "dev", "wm", "client", n])
			if (c) return { name: n, start: c.start ?? null }
		}
		return null
	})
	// the process the page is about: {owner, proc, place, chain, program, pid}; its place where it was started,
	// the names above it that are not processes, chain the processes between
	derive("subject", ({ api }) => {
		const w = val(api, WHERE)
		const owner = w?.owner
		if (!owner) return null
		const proc = isProc(api, owner)
		const start = val(api, CLIENT)?.start ?? null
		let place = owner.slice(0, -1)
		const chain = []
		while (place.length > 1 && isProc(api, place)) {
			chain.push(place)
			place = place.slice(0, -1)
		}
		// the run only when the start does not say the program: a run changes each time it runs
		const run = proc && !start?.program ? runOf(api, owner) : null
		const program = programOf(api, run, start)
		let pid = owner.at(-1)
		try {
			pid = api.children(owner.slice(0, -1), owner.at(-1))[0]?.id ?? pid
		} catch {
			// refused: its name
		}
		return { owner, proc, place, chain, program, pid }
	})

	// a part: rows, from where and what it reads, kept by name with the where they were read for, so a page
	// half read again is not drawn; what its compute returns is a fingerprint of what it read, FNV-1a, a string
	const parts = {}
	const KIDS = 32
	const ORDER = [
		"windows",
		"layer",
		"node",
		"history",
		"head",
		"session",
		"inside",
		"tree",
		...Array.from({ length: KIDS }, (_, i) => `kid${i}`),
		"beside",
		"last",
	]
	const subject = (api) => val(api, SUBJECT) ?? null
	const part = (n, fn) =>
		effect(given, n, ({ api }) => {
			sig = []
			const w = val(api, WHERE) ?? null
			const pids = {}
			let rows
			try {
				rows = w ? fn(api, w, pids) : []
			} catch (e) {
				rows = [
					sec("could not read it"),
					row(`${n}.error`, "error", String(e?.stack ?? e), { kind: "string" }),
				]
			}
			parts[n] = { rows, key: JSON.stringify(w), pids }
			let h = 2166136261
			for (const ch of sig.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
			return `${h}.${sig.length}.${rows.length}`
		}, (g) => soon(g))

	// a document's history (page history): /dev/sync/history/<id>, served while /dev/sync/want/inspect-<pid> names
	// it; each change a row, newest first (at a key, those that changed it), its value the node's after it.
	// With no sync driver nothing is served, and the page says so
	const idOf = (
		api,
		path,
	) => (path.length
		? api.children(["/", ...path.slice(0, -1)], path.at(-1)).find((i) => i.node) ?? null
		: null)
	part("history", (api, w) => {
		if (w.at.page !== "history") return []
		const path = w.at.path ?? [], key = w.at.key ?? [], A = ["/", ...path]
		const i = idOf(api, path)
		const head = sec(
			`history  ${shown(A)}${key.length ? "  ›  " + key.join(" › ") : ""}`,
			"p puts the one chosen back",
		)
		if (!idAt(api, ["/", "dev", "sync", "history"])) {
			return [
				head,
				row("h.none", "none", undefined, {
					note: "no history here: sync keeps it, and its driver is not running",
				}),
			]
		}
		if (!i || i.ephemeral === true) {
			return [head, row("h.none", "none", undefined, { note: "ephemeral: no history kept" })]
		}
		const h = rd(api, ["/", "dev", "sync", "history", i.id.replace(/^ermine:\/\//, "")])[0]?.value
		if (!h) {
			return [
				head,
				row("h.none", "asking", undefined, { note: "asking the sync driver for it" }),
			]
		}
		const rows = [head]
		for (const c of V.changes(h, key)) {
			const after = key.length
				? key.reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), c.value)
				: c.value
			const it = V.itemOf(c)
			rows.push(
				row(
					`h.${c.commit ?? c.time}`,
					V.when(c),
					"value" in c ? (after === undefined ? null : after) : undefined,
					{
						item: { version: it, change: it.change },
						note: V.did(c) +
							(c.kind === "write" && !("value" in c) ? " · over 4 KB: not kept here" : ""),
						hist: { change: c, address: A, key },
					},
				),
			)
		}
		return rows
	})
	let wanted = null
	effect(given, "want", ({ api }) => {
		const at = val(api, AT)?.at
		const i = at?.page === "history" ? idOf(api, at.path ?? []) : null
		return i && i.ephemeral !== true ? i.id : null
	}, ({ value: id, api }) => {
		const want = id ? [id] : [], WANT = ["/", "dev", "sync", "want", `inspect-${self}`]
		if (JSON.stringify(want) === JSON.stringify(wanted)) return
		if (idAt(api, WANT)) api.write(WANT, whole(want))
		else make(api, WANT.slice(0, -1), WANT.at(-1), want, { ephemeral: true })
		wanted = want
	})
	// p: a history's change put back, a write of the value after it (at a key, that key's)
	const putBack = (api, r) => {
		const x = r?.hist
		if (!x) return
		const c = x.change
		if (!("value" in c)) {
			return void (s.note = [
				c.kind === "write" ? "over 4 KB: its value is not in the history" : "no value after it",
				C.cherry,
			])
		}
		const after = x.key.reduce(
			(v, k) => (v === null || v === undefined ? undefined : v[k]),
			c.value,
		)
		try {
			api.write(
				x.address,
				x.key.length
					? [{ path: x.key, ...(after === undefined ? {} : { value: after }) }]
					: whole(c.value),
			)
			s.note = [`put back ${V.when(c)}`, C.mint]
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
	}

	// every window, to choose one; the window's page's when its window is gone
	part("windows", (api, w) => {
		if (w.at.page !== "windows" && !(w.at.page === "window" && !w.target)) return []
		const rows = [sec("every window", "choose one to inspect")]
		for (const [n, x] of every(api, (a) => rd(api, a)[0]?.value)) {
			if (x?.title == null) continue
			rows.push(
				row(`v.${n}`, x.title || n, Array.isArray(x.owner) ? x.owner : null, {
					go: { window: n },
					note: `${n} · ${x.w}×${x.h} at ${x.x},${x.y}${x.hidden ? " · hidden" : ""}`,
				}),
			)
		}
		return rows
	})
	// the window's layer: where it is, what it draws
	part("layer", (api, w) => {
		const t = w.at.page === "window" ? w.target : null
		if (!t) return []
		const rows = []
		const L = [...LAYERS, t.name]
		// its own layer is not read: it changes each time this draws; nor another inspector's, which may be inspecting
		// this, nor a Files window's, which may be showing it: where it is, from /dev/display/windows
		const own = t.name === LAYER.at(-1) || t.name.startsWith("inspect-") ||
			t.name.startsWith("files-")
		const layer = own ? null : rd(api, L)[0] ?? null
		const lv = layer?.value ?? rd(api, [...WINDOWS, t.name])[0]?.value ?? {}
		rows.push(
			sec(`window  ${t.name}`, own ? "an inspector's: where it is, not what it draws" : null),
		)
		rows.push(row("w.layer", "layer", L, { item: layer }))
		// where it is, written to its client: the window manager's, which lays the layer out
		const doc = ["/", "dev", "wm", "client", t.name]
		const client = rd(api, doc).length > 0
		for (
			const k of [
				"title",
				"x",
				"y",
				"w",
				"h",
				"z",
				"hidden",
				"collapsed",
				"over",
				"drags",
				"want",
				"plane",
				"input",
				"access",
				"draw",
			]
		) {
			if (!(k in lv)) continue
			const x = lv[k], kind = kindOf(x, k)
			const at = client && ["x", "y", "w", "h", "z"].includes(k) ? doc : L
			rows.push(row(`w.${k}`, k, x, {
				item: layer,
				keyName: k,
				parent: lv,
				ctx: lv,
				go: ["list", "map"].includes(kind) && !own
					? { page: "node", path: L.slice(1), key: [k] }
					: null,
				write: !own && ["string", "int", "float", "bool"].includes(kind)
					? { address: at, key: [k] }
					: null,
				note: k === "draw" && Array.isArray(x)
					? opsNote(x)
					: k === "plane" && x && typeof x === "object"
					? planeNote(x)
					: null,
			}))
		}
		if (!t.owner) {
			rows.push(row("w.noowner", "owner", null, { note: "no owner: no process answers for it" }))
		}
		return rows
	})
	// a node's page: the value (at key, inside it), its fields, its members, its names; a process's, the parts below
	part("node", (api, w, pids) => {
		if (w.at.page !== "node") return []
		const path = w.at.path ?? [], key = w.at.key ?? []
		const rows = []
		const A = ["/", ...path]
		const n = nodeAt(api, A)
		if (!n.items.length) {
			return [
				sec(`node  ${shown(A)}`),
				row("n.none", "nothing", undefined, { note: "nothing is here" }),
			]
		}
		if (n.item?.refused) {
			return [
				sec(`node  ${shown(A)}`),
				row("n.refused", "refused", why(n.item.refused), { kind: "string", refused: true }),
			]
		}
		const own = mine(A) && n.proc
		let v = own ? undefined : n.item?.value, ctx = null
		for (const k of key) {
			ctx = v
			v = v?.[k]
		}
		const kind = kindOf(v, key.at(-1))
		rows.push(
			sec(
				`node  ${shown(A)}${key.length ? "  ›  " + key.join(" › ") : ""}`,
				n.proc
					? "a process"
					: n.item?.ephemeral === undefined
					? null
					: n.item.ephemeral
					? "ephemeral"
					: "a document",
			),
		)
		rows.push(row("n.self", key.length ? String(key.at(-1)) : "value", v, {
			item: n.item,
			kind,
			keyName: key.at(-1),
			ctx,
			parent: ctx,
			address: A,
			go: null,
			write: !own && ["string", "int", "float", "bool", "null"].includes(kind)
				? { address: A, key }
				: null,
			flags: { e: n.item?.ephemeral === true, doc: n.item?.ephemeral === false },
		}))
		if (n.item?.ephemeral !== true && !n.proc) {
			rows.push(
				row("n.history", "history", undefined, {
					go: { page: "history", path, key },
					note: `its changes${key.length ? " to " + key.join(" › ") : ""}, newest first (h)`,
				}),
			)
		}
		if (kind === "map" || kind === "list") {
			rows.push(
				sec(
					kind === "map" ? "keys" : "items",
					kind === "map" ? "sorted as the graph sorts them" : null,
				),
			)
			fieldRows(rows, "f.", v, A, key, n.item, null)
		} else if (kind === "picture") {
			rows.push(sec("keys"))
			fieldRows(rows, "f.", v, A, key, n.item, null)
		}
		if (key.length) return rows
		if (n.items.length > 1) {
			rows.push(sec("members", "every id in its slot, the first reached"))
			n.items.forEach((i, k) =>
				rows.push(
					row(
						`m.${k}`,
						`${k === 0 ? "▸ " : ""}${short(i.id ?? "?")}`,
						i.pending ? undefined : i.value,
						{ item: i, note: i.pending ? "pending: not here yet" : null },
					),
				)
			)
		}
		// a process: all about it, in the parts below
		// its names, and a process's tree, are the kids' parts
		return rows
	})
	// a process: its node, pid, place, program, who made it, its run
	part("head", (api, w, pids) => {
		const p = subject(api)
		if (!p) return []
		const { owner, place, program } = p
		const item = rd(api, owner).find((i) => !i.pending && !i.refused) ?? null
		const run = p.proc ? runOf(api, owner) : null
		const pv = program ? rd(api, program)[0]?.value : null
		let needs = []
		try {
			needs = program
				? api.info(program, "ermine.program.provisions").find((i) => i.versions)?.versions?.[0]
					?.content?.needs ?? []
				: []
		} catch {
			// refused: said as nothing needed
		}
		pids[p.pid] = owner.at(-1)
		const rows = []
		rows.push(
			sec(
				p.proc ? `process  ${short(p.pid)}` : `owner  ${shown(owner)}`,
				p.proc ? null : "no run in it: a node its driver answers for, not a process",
			),
		)
		rows.push(
			row("p.owner", "node", owner, {
				item,
				flags: { proc: p.proc },
				note: run ? runNote(run) : null,
			}),
		)
		rows.push(row("p.pid", p.proc ? "pid" : "id", p.pid, { kind: "string" }))
		rows.push(row("p.cwd", "place", place, { note: "where it was started: its ." }))
		if (program) {
			rows.push(
				row("p.program", "program", program, {
					item: rd(api, program)[0],
					note: pv ? programNote(pv, needs) : "not found",
				}),
			)
		}
		if (pv && typeof pv === "object" && !Array.isArray(pv)) {
			fieldRows(rows, "p.prog.", pv, program, [], rd(api, program)[0], null)
		}
		rows.push(
			row("p.made", "made by", item?.change ?? null, {
				item,
				kind: item?.change ? "map" : "null",
				go: null,
			}),
		)
		if (run) {
			rows.push(
				row("p.run", "run", run, {
					item: rd(api, [...owner, "run"])[0],
					go: { page: "node", path: [...owner, "run"].slice(1), key: [] },
					note: runNote(run),
				}),
			)
		}
		return rows
	})
	// the session's client, which a drag writes each move: its start, and the document
	part("session", (api) => {
		const c = subject(api) ? val(api, CLIENT) : null
		if (!c) return []
		const item = rd(api, ["/", "dev", "wm", "client", c.name])[0] ?? null
		const start = item?.value?.start ?? null
		const rows = []
		if (start) {
			rows.push(
				row("p.start", "start", start, {
					item,
					go: { page: "node", path: ["dev", "wm", "client", c.name], key: ["start"] },
				}),
			)
		}
		if (item) {
			rows.push(
				row("p.client", "client", ["/", "dev", "wm", "client", c.name], {
					item,
					note: item.ephemeral === undefined
						? null
						: item.ephemeral
						? "the session's: in front of its document while it moves"
						: "the session's: a document",
				}),
			)
		}
		return rows
	})
	// up: the processes it is inside
	part("inside", (api) => {
		const p = subject(api)
		if (!p?.chain.length) return []
		const rows = [sec("inside", "the processes whose node holds it")]
		for (const a of p.chain) {
			rows.push(
				row(`c.${a.join("/")}`, a.at(-1), a, { item: rd(api, a)[0], flags: { proc: true } }),
			)
		}
		return rows
	})
	// its node: parts, handlers, state
	// the names below: a process's tree, else a node's; their list a compute of its own, {address, names, maker,
	// prefix}, and each name a part of its own (KIDS of them, the last all the rest), so one part's run, or a value
	// below changing, reads that name again and no more
	derive("kids", ({ api }) => {
		const w = val(api, WHERE)
		const p = val(api, SUBJECT)
		let address = null, prefix = "t."
		if (p) address = p.owner
		else if (w?.at.page === "node" && !(w.at.key ?? []).length) {
			address = ["/", ...(w.at.path ?? [])], prefix = "k."
		}
		if (!address) return null
		let names = []
		try {
			if (!api.content(address).some((i) => i.node)) return null
			names = api.children(address)
		} catch {
			return null
		}
		const maker = names.includes("run") ? runOf(api, address)?.program?.node ?? null : null
		return { address, names: names.filter((n) => n !== "run"), maker, prefix, proc: !!p }
	})
	const kids = (api) => val(api, BELOW) ?? null
	part("tree", (api) => {
		const k = kids(api)
		if (!k?.names.length && !k?.proc) return []
		return [
			k.proc
				? sec("tree", `${k.address.at(-1)}: its parts, handlers and state`)
				: sec("names", `${k.names.length} below`),
		]
	})
	const kid = (i) =>
		part(`kid${i}`, (api, w, pids) => {
			const k = kids(api)
			if (!k || i >= k.names.length) return []
			const rows = []
			for (const n of i === KIDS - 1 ? k.names.slice(i) : [k.names[i]]) {
				const items = api.children(k.address, n)
				for (const x of items) sig.push(x.id, x.node ? 1 : 0)
				childRows(api, rows, k.address, [[n, items]], k.prefix, pids, k.maker)
			}
			return rows
		})
	for (let i = 0; i < KIDS; i++) kid(i)
	// beside it, in its .: what it keeps there that outlives it (a document), and the other processes started there;
	// a process whose . is ephemeral keeps what lasts in its app's folder: /apps/<its program's name>
	part("beside", (api, w, pids) => {
		const p = subject(api)
		if (!p) return []
		const { owner, place, program } = p
		const rows = []
		const beside = [], siblings = []
		for (const [n, items] of ls(api, place)) {
			if (n === owner.at(-1) && place.length === owner.length - 1) continue
			;(isProc(api, [...place, n]) ? siblings : beside).push([n, items])
		}
		const app = program ? ["/", "apps", program.at(-1)] : null
		if (beside.length) {
			rows.push(sec("beside", `in ${shown(place)}: what it keeps there`))
			childRows(api, rows, place, beside, "b.", pids)
			// named by the process's name: its own (at/<name>, drafts/<name>)
			for (const [n] of beside) {
				const hit = rd(api, [...place, n, owner.at(-1)])[0]
				if (hit && !hit.refused && !hit.pending) {
					rows.push(
						row(`b.${n}.own`, `${n}/${short(owner.at(-1))}`, hit.value, {
							item: hit,
							address: [...place, n, owner.at(-1)],
							go: { page: "node", path: [...place, n, owner.at(-1)].slice(1), key: [] },
							flags: { doc: hit.ephemeral === false, e: hit.ephemeral === true },
						}),
					)
				}
			}
		}
		if (app && shown(app) !== shown(place) && rd(api, app).length) {
			const kept = ls(api, app).filter(([n]) =>
				!(n === owner.at(-1) && shown(app) === shown(place))
			).filter(([n]) => !isProc(api, [...app, n]))
			if (kept.length) {
				rows.push(sec("app", `in ${shown(app)}: its program's folder`))
				childRows(api, rows, app, kept, "a.", pids)
			}
		}
		if (siblings.length) {
			rows.push(sec("siblings", `the other processes in ${shown(place)}`))
			for (const [n, items] of siblings) {
				for (const i of items) pids[i.id] = n
				rows.push(
					row(`s.${n}`, n, [...place, n], {
						item: got(items[0]),
						flags: {
							proc: true,
							e: items.some((i) => i.ephemeral === true),
						},
					}),
				)
			}
		}
		return rows
	})
	// what its own run read and wrote, the last time it ran
	part("last", (api) => {
		const p = subject(api)
		const run = p?.proc ? runOf(api, p.owner) : null
		if (!run) return []
		const rows = [sec("last run", runNote(run))]
		;(run.reads ?? []).slice(-60).forEach((r, i) => {
			rows.push(
				row(`r.${i}`, `${r.op}${r.name ? " " + r.name : ""}`, readAt(r) || r.name || null, {
					note: `${r.tracked ? "tracked" : "untracked"}${
						r.times?.length ? " · " + r.times.length + " seen" : " · nothing there"
					}`,
				}),
			)
		})
		if (run.wrote?.length) {
			rows.push(
				row("r.wrote", "wrote", run.wrote, {
					note: `when, not what: ${run.wrote.map((t) => clock(t)).join(" ")}`,
				}),
			)
		}
		return rows
	})

	// the page, once every part has read for the where there is now: its rows, the parts' in order
	const show = (api) => {
		const w = val(api, WHERE) ?? null
		const key = JSON.stringify(w)
		if (!w || ORDER.some((n) => parts[n]?.key !== key)) return
		gone = false
		const pids = { [self]: "this inspector" }
		for (const n of ORDER) Object.assign(pids, parts[n].pids)
		latest = {
			rows: ORDER.flatMap((n) => parts[n].rows),
			doc: w.doc,
			at: w.at,
			target: w.target,
			gone: w.at.page === "window" && !w.target ? w.doc.window : null,
			pids,
		}
		if (s.chosen && !latest.rows.some((r) => r.id === s.chosen)) s.chosen = null
		paint(api)
	}

	// the parts that changed in a turn shown once, after it, as the next display frame is: a timer, the part's own
	let due = null
	const soon = (g) => {
		if (!due) {
			due = after(g, 0, ({ api }) => {
				due = null
				show(api)
			})
		}
	}
	onCleanup(({ api }) => due?.(api))

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
	effect(
		given,
		"style",
		({ api }) =>
			JSON.stringify({ theme: val(api, ["/", "etc", "theme"]) ?? {}, fonts: fonts(api) }),
		({ value, api }) => {
			colours(JSON.parse(value).theme)
			paint(api)
		},
	)
	// the size, "<w>x<h>", a string, so moving the window runs no effect
	effect(given, "size", ({ api }) => {
		const want = val(api, [...WINDOWS, LAYER.at(-1)])?.want
		return want ? `${want.w}x${want.h}` : null
	}, ({ value, api }) => {
		if (!value) return
		const [w, h] = value.split("x").map(Number)
		W = Math.max(420 * u, w)
		H = Math.max(240 * u, h)
		paint(api)
	})
}
