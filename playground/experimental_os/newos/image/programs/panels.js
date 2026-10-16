// /programs/panels: Control Panels, System 7's folder of them as one
// window: the panels down the left, the one chosen on the right. A panel is
// a node, /etc/panels/<Name>, {kind: "panel", rows}, read live: a new panel
// is a node placed there, not code. A row says what it edits and how:
//
//   {label, at, key?, control, ...}
//     at       the node, an address (["/", "etc", "desktop"]) or its text ("/etc/desktop")
//     key      a key of its value, or a list of them, a path into it (["window", "radius"]); none: the whole value
//     default  what is shown while the node or key holds nothing
//   control:
//     check    a box; with run, a command, toggling runs `<run> on` or `<run> off` and the box reads at's key
//     choice   choices: [..], radio buttons
//     number   step (1), min?, max?
//     colour   a swatch and its hex; a palette of /etc/theme's colours
//     colours  a colour row for each key of at's value holding a number
//     picture  from: [address, ...] (/home, /etc), the pictures under them, or none: its path written
//     preset   from: an address (/etc/themes), each node there a choice, by its name: chosen, that node
//              placed again at at (/etc/theme), in place of the one there, as the shell's ln; so the rows
//              editing at edit the chosen one itself. The one shown chosen is the one placed at at. New: a
//              copy of the one at at, under from, named "<its name> copy", chosen. One at at that is none of
//              from's, chosen away from, is kept under from first, as "untitled"
//     text     a readline field
//     button   run, a command as /etc/keys has them, through /dev/wm/ctl run; text, its word
//     show     the value, read only
//     head     a heading
//
// Every change is written at once, a set at its key (the maps on the way
// made); a text, a number typed or a hex is written by Enter. Each row says
// the node and key it edits, in ink2; a click there opens the graph browser
// at it, and the footer's path at the panel itself.
//
// Keys: up and down the rows (in the list, the panels), Tab between the two,
// Space toggles, left and right step a number, a choice, a preset or a picture, Enter
// edits a text, a number or a colour (Escape lets it be), cmd-g the graph
// browser at the row's node. The panel and row chosen, the scroll, a field
// being edited, the footer: the node view, inside this process's.
import { blitter, font } from "ermine:draw"
import { drop, effect, handler, idAt, make, val, whole } from "ermine:kit"
import { here } from "ermine:os"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, onCleanup, self } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const me = here(self)
	const PANELS = ["/", "etc", "panels"]
	const blit = blitter(api)
	// labels in /dev/font/text, headings and buttons in /dev/font/title; the font ROM until they come. A font and
	// the pages of it that have come, so a page coming draws again
	let F, FT
	const fonts = (api) => {
		const at = (role) => {
			const v = val(api, ["/", "dev", "font", role])
			return [
				v ? font(v) : undefined,
				api.children(["/", "dev", "font", role, "pages"]).join(" "),
			]
		}
		const [text, a] = at("text"), [title, b] = at("title")
		F = text
		FT = title
		return `${F ? String(F) : "rom"} ${a} ${FT ? String(FT) : "rom"} ${b}`
	}
	fonts(api)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(660 * u, mode.w - 60 * u), H = Math.min(460 * u, mode.h - 80 * u)
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `panels-${self}`]
	const set = (key, value) => ({ path: [key], value })
	// an ephemeral node at address holding value: written whole if it is there, else made
	const hold = (api, address, value) => {
		if (idAt(api, address)) api.write(address, whole(value))
		else make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
	}
	const C = {}
	let theme = {}
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
			ok: T.mint ?? 0x18936b,
			// a chosen row, as catclock's chosen cells: rose, its name white
			pick: T.pick ?? T.line ?? 0x1c1a17,
		})
	theme = val(api, ["/", "etc", "theme"]) ?? {}
	colours(theme)

	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (90 + (n % 5) * 30) * u,
			y: (70 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "Control Panels",
			owner: me,
			draw: [],
		}, { ephemeral: true })
	}

	// the view: the panel chosen, the row chosen (its id), which side has the keys, the scroll, a field being
	// edited {id, kind, field}, the footer
	const s = { panel: null, row: null, side: "list", scroll: 0, edit: null, note: null }
	const VIEW = [...me, "view"]
	const view = val(api, VIEW)
	if (view) { for (const k of Object.keys(s)) if (k in view) s[k] = view[k] }
	let viewed = view ?? null
	const keep = (api) => {
		const text = JSON.stringify(s)
		if (viewed && JSON.stringify(viewed) === text) return
		hold(api, VIEW, JSON.parse(text))
		viewed = JSON.parse(text)
	}

	// --- the panels, as the graph holds them
	const isMap = (v) =>
		v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof ArrayBuffer) &&
		!ArrayBuffer.isView(v)
	const address = (at) =>
		typeof at === "string"
			? ["/", ...at.split("/").filter((n) => n)]
			: Array.isArray(at) && at.every((n) => typeof n === "string")
			? (at[0] === "/" ? at : ["/", ...at])
			: null
	const keysOf = (key) =>
		key === undefined || key === null ? [] : Array.isArray(key) ? key.map(String) : [String(key)]
	// a part as a boolean is its on, as the theme's window has them (stripes: false)
	const dig = (v, keys) =>
		keys.reduce(
			(o, k) => (isMap(o) ? o[k] : typeof o === "boolean" && k === "on" ? o : undefined),
			v,
		)
	const read = (api, at) => {
		try {
			return val(api, at)
		} catch {
			return undefined
		}
	}
	// panels: [{name, rows}], by name; each row with its node's value as read, and an id
	let panels = []
	// the pictures a picture row offers: [{path, v}]
	let pictures = []
	const look = (api) => {
		const out = []
		for (const n of api.children(PANELS)) {
			const p = read(api, [...PANELS, n])
			if (p?.kind !== "panel" || !Array.isArray(p.rows)) continue
			const rows = []
			for (const r of p.rows) {
				if (!isMap(r) || typeof r.control !== "string") continue
				const at = address(r.at)
				const v = at ? read(api, at) : undefined
				// a colour row each key holding a number
				if (r.control === "colours") {
					if (isMap(v)) {
						for (const [k, c] of Object.entries(v)) {
							if (typeof c === "number") {
								rows.push({ label: k, at, keys: [k], control: "colour", value: c })
							}
						}
					}
					continue
				}
				const keys = keysOf(r.key)
				const got = at ? dig(v, keys) : undefined
				// a preset row's choices: the nodes under its from, by name, each with its id; and the id placed at at
				const from = r.control === "preset" ? address(r.from) : null
				const presets = from
					? api.children(from).map((n) => ({ name: n, id: idAt(api, [...from, n]) })).filter((
						p,
					) => p.id)
					: null
				rows.push({
					...r,
					at,
					keys,
					value: got === undefined || got === null && r.default !== undefined
						? r.default
						: got,
					...(presets ? { presets, from, inUse: at ? idAt(api, at) ?? null : null } : {}),
				})
			}
			rows.forEach((
				r,
				i,
			) => (r.id = `${(r.at ?? []).slice(1).join("/")}|${r.keys.join(".")}|${r.control}|${
				r.label ?? i
			}`))
			out.push({ name: n, rows })
		}
		return out.sort((a, b) => a.name.localeCompare(b.name))
	}
	const panel = () => panels.find((p) => p.name === s.panel) ?? null
	const rowsOf = () => panel()?.rows ?? []
	const row = () => rowsOf().find((r) => r.id === s.row) ?? null
	const pickable = (r) => r.control !== "head"

	// the menus, in the menu bar while its window has the focus: Panels, each by name
	let menued = null
	const menus = (api) => {
		const m = [
			{
				title: "File",
				items: [{ label: "Open in Graph", key: "cmd-g" }, "-", {
					label: "Close",
					key: "cmd-w",
				}],
			},
			{
				title: "Edit",
				items: [
					{ label: "Cut", key: "cmd-x" },
					{ label: "Copy", key: "cmd-c" },
					{ label: "Paste", key: "cmd-v" },
					"-",
					{ label: "Select All", key: "cmd-a" },
				],
			},
			{
				title: "Panels",
				items: panels.length
					? panels.map((p) => ({ label: p.name, call: "menu", args: ["panel", p.name] }))
					: [{ label: "none", off: true }],
			},
		]
		const text = JSON.stringify(m)
		if (text === menued) return
		hold(api, [...me, "menus"], m)
		menued = text
	}

	// --- writing
	const why = (e) => `${e.code ?? "error"}: ${e.message}`
	const where = (r) =>
		r.at
			? `${r.at.length > 1 ? "/" + r.at.slice(1).join("/") : "/"}${
				r.keys.map((k) => ` › ${k}`).join("")
			}`
			: ""
	// value at the row's node and key: a set at its key, the maps on the way made (a part that is not a map, as
	// stripes: false, made one); the node placed if it is not there
	const put = (api, r, value) => {
		const at = r.at, keys = r.keys
		if (!at) return
		try {
			if (!idAt(api, at)) {
				if (
					!make(
						api,
						at.slice(0, -1),
						at.at(-1),
						keys.reduceRight((v, k) => ({ [k]: v }), value),
					)
				) throw new Error("nothing there to place it in")
			} else if (!keys.length) api.write(at, whole(value))
			else if (!isMap(val(api, at))) {
				api.write(at, whole(keys.reduceRight((v, k) => ({ [k]: v }), value)))
			} else {
				let o = val(api, at), i = 0
				while (i < keys.length - 1 && isMap(o[keys[i]])) o = o[keys[i++]]
				const v = keys.slice(i + 1).reduceRight((v, k) => ({ [k]: v }), value)
				api.write(at, [{ path: [...keys.slice(0, i), keys[i]], value: v }])
			}
			r.value = value
			s.note = null
		} catch (e) {
			s.note = [`${where(r)}: ${why(e)}`, C.cherry]
		}
	}
	// a command, as /etc/keys has them: a Run, which wmiirc runs
	const run = ({ api, call }, line) => {
		const ctl = read(api, ["/", "dev", "wm", "ctl"])
		if (Array.isArray(ctl)) call(ctl, [`run ${line}`])
		else s.note = [`${line}: no window manager to run it`, C.cherry]
	}
	const graph = (g, at) =>
		at && run(g, `graph ${at.length > 1 ? "/" + at.slice(1).join("/") : "/"}`)

	// --- doing a row: toggled, stepped by, or edited
	const choices = (r) => (Array.isArray(r.choices) ? r.choices : [])
	const pictureAt = (r) =>
		pictures.findIndex((p) => Array.isArray(r.value) && p.path.join("/") === r.value.join("/"))
	// the preset placed at the row's address, or -1
	const presetAt = (r) => (r.presets ?? []).findIndex((p) => p.id === r.inUse)
	// a name under from not taken: name, else "name 2", "name 3"…
	const free = (r, name) => {
		const taken = new Set((r.presets ?? []).map((p) => p.name))
		let n = name
		for (let i = 2; taken.has(n); i++) n = `${name} ${i}`
		return n
	}
	// the preset with this id placed at the row's address in place of what is there; what is there kept under from
	// first when it is none of its
	const choose = (api, r, id) => {
		const at = r.at,
			parent = at ? idAt(api, at.slice(0, -1)) : null,
			home = r.from ? idAt(api, r.from) : null
		if (!parent || !home || !id || id === r.inUse) return
		if (r.inUse && !(r.presets ?? []).some((p) => p.id === r.inUse)) {
			api.insert(home, free(r, "untitled"), r.inUse)
		}
		for (let k = 0; k < 8 && api.children(at.slice(0, -1), at.at(-1)).length; k++) {
			drop(api, at.slice(0, -1), at.at(-1))
		}
		api.insert(parent, at.at(-1), id)
	}
	// a new preset: a copy of the one at the row's address, under from, chosen
	const copy = (api, r) => {
		const home = r.from ? idAt(api, r.from) : null
		if (!home || !r.at) return
		const now = (r.presets ?? []).find((p) => p.id === r.inUse)
		const id = api.create(val(api, r.at) ?? null)
		api.insert(home, free(r, `${now?.name ?? "untitled"} copy`), id)
		choose(api, { ...r, presets: [...(r.presets ?? []), { name: "", id }] }, id)
	}
	const toggle = (g, r) => {
		if (r.control === "check") {
			const on = !r.value
			if (typeof r.run === "string") run(g, `${r.run} ${on ? "on" : "off"}`)
			else put(g.api, r, on)
		} else if (r.control === "choice" || r.control === "picture" || r.control === "preset") {
			step(g.api, r, 1)
		} else if (r.control === "button" && typeof r.run === "string") run(g, r.run)
		else if (r.control === "show") graph(g, r.at)
		else edit(r)
	}
	const step = (api, r, by) => {
		if (r.control === "number") {
			const n = (typeof r.value === "number" ? r.value : 0) +
				by * (typeof r.step === "number" ? r.step : 1)
			put(
				api,
				r,
				Math.max(r.min ?? -Infinity, Math.min(r.max ?? Infinity, Math.round(n * 1000) / 1000)),
			)
		} else if (r.control === "choice" && choices(r).length) {
			const i = choices(r).indexOf(r.value)
			put(
				api,
				r,
				choices(
					r,
				)[
					((i < 0 ? (by > 0 ? -1 : 0) : i) + Math.sign(by) + choices(r).length) %
					choices(r).length
				],
			)
		} else if (r.control === "preset" && r.presets?.length) {
			const i = presetAt(r), n = r.presets.length
			choose(api, r, r.presets[((i < 0 ? (by > 0 ? -1 : 0) : i) + Math.sign(by) + n) % n].id)
		} else if (r.control === "picture") {
			// none, then each picture
			const i = pictureAt(r) + 1, n = pictures.length + 1
			const to = (i + Math.sign(by) + n) % n
			put(api, r, to === 0 ? null : pictures[to - 1].path)
		}
	}
	const hex = (c) => `#${(c >>> 0 & 0xffffff).toString(16).padStart(6, "0")}`
	const edit = (r) => {
		const kind = r.control === "text"
			? "text"
			: r.control === "number"
			? "number"
			: r.control === "colour"
			? "colour"
			: null
		if (!kind) return
		const text = kind === "colour"
			? (typeof r.value === "number" ? hex(r.value) : String(r.value ?? ""))
			: r.value === undefined || r.value === null
			? ""
			: String(r.value)
		// all of it selected, so typing replaces it
		s.edit = { id: r.id, kind, field: { text, pos: text.length, mark: text ? 0 : null } }
	}
	// the field written (Enter), or let be
	const done = (api, write) => {
		const e = s.edit, r = rowsOf().find((x) => x.id === e?.id)
		s.edit = null
		if (!write || !e || !r) return
		const t = e.field.text.trim()
		if (e.kind === "text") put(api, r, e.field.text)
		else if (e.kind === "number") {
			const n = Number(t)
			if (t === "" || !Number.isFinite(n)) s.note = [`${t}: not a number`, C.cherry]
			else put(api, r, Math.max(r.min ?? -Infinity, Math.min(r.max ?? Infinity, n)))
		} else {
			const m = /^(?:#|0x)?([0-9a-f]{6})$/i.exec(t)
			if (m) put(api, r, parseInt(m[1], 16))
			else if (typeof theme[t] === "number") put(api, r, t)
			else s.note = [`${t}: a colour is #RRGGBB, or a theme colour's name`, C.cherry]
		}
	}
	const moveRow = (by) => {
		const rs = rowsOf().filter(pickable)
		const i = rs.findIndex((r) => r.id === s.row)
		const to = rs[Math.max(0, Math.min(rs.length - 1, i < 0 ? 0 : i + by))]
		if (to) s.row = to.id
	}
	const movePanel = (by) => {
		const i = panels.findIndex((p) => p.name === s.panel)
		const to = panels[Math.max(0, Math.min(panels.length - 1, i < 0 ? 0 : i + by))]
		if (to && to.name !== s.panel) {
			s.panel = to.name
			s.row = null
			s.scroll = 0
		}
	}
	// a panel and a row always chosen, while there are some
	const settle = () => {
		if (!panels.some((p) => p.name === s.panel)) {
			s.panel = (panels.find((p) => p.name === "Desktop") ?? panels[0])?.name ?? null
			s.scroll = 0
		}
		if (!row()) s.row = rowsOf().find(pickable)?.id ?? null
		if (s.edit && !rowsOf().some((r) => r.id === s.edit.id)) s.edit = null
	}

	// --- drawing
	const LIST = 150 * u, LABEL = 128 * u, PAD = 10 * u
	const FOOT = () => blit.height(F) + 10 * u
	const ROW = () => Math.max(blit.height(F), blit.height(FT)) + 10 * u
	const THUMB = 32 * u
	const height = (r) =>
		r.control === "picture"
			? THUMB + 8 * u
			: r.control === "preset"
			? ROW() * Math.max(1, r.presets?.length ?? 0)
			: ROW()
	const fitted = (text, w, font) => {
		if (w <= 0) return ""
		const n = blit.fit(text, w, font)
		return n >= text.length ? text : text.slice(0, Math.max(0, n - 1)) + "…"
	}
	// where each thing drawn is, from the last draw: what a click does there; and what VoiceOver says
	let zones = [], told = []
	let caret = null
	const mid = (y, h, font) => y + Math.floor((h - blit.height(font)) / 2)
	const button = (f, x, y, label, act, extra = {}) => {
		const w = blit.measure(label, FT) + 20 * u, h = blit.height(FT) + 6 * u
		blit.fill(f, x, y, w, h, C.line)
		blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
		blit.text(f, x + 10 * u, y + 3 * u, label, C.ink, undefined, undefined, FT)
		zones.push({ x, y, w, h, act, ...extra })
		return x + w
	}
	// a field: its text from where the caret shows, the selection on lemon, the caret at pos
	const field = (f, b, x) => {
		const t = x.text, room = b.w - 12 * u
		let from = 0
		while (from < x.pos && blit.measure(t.slice(from, x.pos), F) > room) from++
		const at = (i) => b.x + 6 * u + blit.measure(t.slice(from, Math.max(from, i)), F)
		blit.fill(f, b.x, b.y, b.w, b.h, C.line)
		blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi)
		const clip = { x: b.x + u, y: b.y, w: b.w - 2 * u, h: b.h }
		const sel = readline.selection(x)
		if (sel) {
			blit.fill(
				f,
				at(sel[0]),
				b.y + 3 * u,
				Math.max(u, at(sel[1]) - at(sel[0])),
				b.h - 6 * u,
				C.lemon,
				clip,
			)
		}
		blit.text(f, b.x + 6 * u, mid(b.y, b.h, F), t.slice(from), C.ink, undefined, clip, F)
		const cx = Math.min(b.x + b.w - 3 * u, at(x.pos))
		blit.fill(f, cx, b.y + 3 * u, 2 * u, b.h - 6 * u, C.rose)
		caret = { text: t, pos: x.pos, x: cx, y: b.y + 3 * u, h: b.h - 6 * u, from, b }
	}
	// a box drawn as a text field is, holding text
	const box = (f, b, text, colour) => {
		blit.fill(f, b.x, b.y, b.w, b.h, C.line)
		blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi)
		blit.text(
			f,
			b.x + 6 * u,
			mid(b.y, b.h, F),
			fitted(text, b.w - 12 * u, F),
			colour,
			undefined,
			b,
			F,
		)
	}
	// a picture as big as fits in a square of side n: whole pixels when it is small, else every so many
	const thumb = (f, v, x, y, n) => {
		const w = Math.max(1, ...v.rows.map((r) => r.length)), h = v.rows.length
		const scale = n / Math.max(w, h)
		const k = scale >= 1 ? Math.floor(scale) : scale
		const cols = Math.min(n, Math.floor(w * k)), lines = Math.min(n, Math.floor(h * k))
		const ox = x + Math.floor((n - cols) / 2), oy = y + Math.floor((n - lines) / 2)
		const px = Math.max(1, Math.round(k >= 1 ? k : 1))
		for (let j = 0; j < lines; j += px) {
			const src = v.rows[Math.min(h - 1, Math.floor(j / k))]
			let i = 0
			while (i < cols) {
				const ch = src[Math.min(w - 1, Math.floor(i / k))]
				let e = i + px
				while (e < cols && src[Math.min(w - 1, Math.floor(e / k))] === ch) e += px
				const c = v.colors?.[ch]
				if (typeof c === "number") blit.fill(f, ox + i, oy + j, Math.min(e, cols) - i, px, c)
				i = e
			}
		}
	}
	const colourOf = (v) =>
		typeof v === "number"
			? v
			: typeof v === "string" && typeof theme[v] === "number"
			? theme[v]
			: null
	const said = (v) =>
		v === undefined || v === null
			? "—"
			: v === true
			? "yes"
			: v === false
			? "no"
			: typeof v === "string"
			? v
			: typeof v === "number"
			? String(v)
			: JSON.stringify(v)
	// a row's control, from x to the right edge e; answers where it ended and what VoiceOver says of it
	const control = (f, r, x, y, h, e) => {
		const ty = mid(y, h, F)
		const editing = s.edit?.id === r.id
		if (r.control === "check") {
			const b = 12 * u, by = y + Math.floor((h - b) / 2)
			blit.fill(f, x, by, b, b, C.line)
			blit.fill(f, x + u, by + u, b - 2 * u, b - 2 * u, C.hi)
			if (r.value) {
				blit.line(f, x + 2 * u, by + 2 * u, x + b - 3 * u, by + b - 3 * u, u, C.line)
				blit.line(f, x + b - 3 * u, by + 2 * u, x + 2 * u, by + b - 3 * u, u, C.line)
			}
			zones.push({ x, y, w: b + 8 * u, h, act: "toggle", id: r.id })
			return [x + b, r.value ? "on" : "off"]
		}
		if (r.control === "choice") {
			let cx = x
			for (const c of choices(r)) {
				const rad = 5 * u, cy = y + Math.floor(h / 2)
				const w = 2 * rad + 5 * u + blit.measure(String(c), F)
				if (cx + w > e) break
				blit.fillellipse(f, cx + rad, cy, rad, rad, C.hi)
				blit.ellipse(f, cx + rad, cy, rad, rad, u, C.line)
				if (c === r.value) blit.fillellipse(f, cx + rad, cy, 2 * u, 2 * u, C.ink)
				blit.text(f, cx + 2 * rad + 5 * u, ty, String(c), C.ink, undefined, undefined, F)
				zones.push({ x: cx, y, w, h, act: "choose", id: r.id, value: c })
				cx += w + 12 * u
			}
			return [cx - 12 * u, said(r.value)]
		}
		if (r.control === "preset") {
			// a radio button for each, by name, a line each; New beside the first
			const at = presetAt(r), lh = ROW()
			let right = x
			for (const [i, p] of (r.presets ?? []).entries()) {
				const rad = 5 * u, ly = y + i * lh, cy = ly + Math.floor(lh / 2)
				const w = Math.min(e - x, 2 * rad + 5 * u + blit.measure(p.name, F))
				blit.fillellipse(f, x + rad, cy, rad, rad, C.hi)
				blit.ellipse(f, x + rad, cy, rad, rad, u, C.line)
				if (i === at) blit.fillellipse(f, x + rad, cy, 2 * u, 2 * u, C.ink)
				// cut short only past the row's end (fit and measure round apart by a pixel)
				blit.text(
					f,
					x + 2 * rad + 5 * u,
					mid(ly, lh, F),
					fitted(p.name, e - x - 2 * rad - 5 * u, F),
					C.ink,
					undefined,
					undefined,
					F,
				)
				zones.push({ x, y: ly, w, h: lh, act: "preset", id: r.id, value: p.id })
				right = Math.max(right, x + w)
			}
			// a new one, copied from the one in use
			const bw = blit.measure("New", FT) + 20 * u, bx = Math.max(right + 16 * u, x + 120 * u)
			if (bx + bw <= e) {
				right = button(
					f,
					bx,
					y + Math.floor((lh - blit.height(FT) - 6 * u) / 2),
					"New",
					"copy",
					{ id: r.id },
				)
			}
			return [right, at < 0 ? said(undefined) : r.presets[at].name]
		}
		if (r.control === "number") {
			const bh = h - 6 * u, bw = 16 * u, vw = 52 * u, by = y + 3 * u
			const minus = { x, y: by, w: bw, h: bh },
				plus = { x: x + bw + vw + 4 * u, y: by, w: bw, h: bh }
			for (const [b, t, by1] of [[minus, "−", -1], [plus, "+", 1]]) {
				blit.fill(f, b.x, b.y, b.w, b.h, C.line)
				blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.chrome)
				blit.text(
					f,
					b.x + Math.floor((b.w - blit.measure(t, F)) / 2),
					mid(b.y, b.h, F),
					t,
					C.ink,
					undefined,
					undefined,
					F,
				)
				zones.push({ ...b, act: "step", id: r.id, by: by1 })
			}
			const b = { x: x + bw + 2 * u, y: by, w: vw, h: bh }
			if (editing) field(f, b, s.edit.field)
			else box(f, b, Array.isArray(r.value) ? JSON.stringify(r.value) : said(r.value), C.ink)
			zones.push({ ...b, act: "edit", id: r.id })
			return [plus.x + bw, said(r.value)]
		}
		if (r.control === "text") {
			const b = { x, y: y + 3 * u, w: Math.max(80 * u, Math.min(260 * u, e - x)), h: h - 6 * u }
			if (editing) field(f, b, s.edit.field)
			else {box(
					f,
					b,
					typeof r.value === "string"
						? r.value
						: r.value === undefined || r.value === null
						? ""
						: said(r.value),
					C.ink,
				)}
			zones.push({ ...b, act: "edit", id: r.id })
			return [b.x + b.w, typeof r.value === "string" ? r.value : ""]
		}
		if (r.control === "colour") {
			const c = colourOf(r.value), sw = 28 * u, by = y + 4 * u, bh = h - 8 * u
			blit.fill(f, x, by, sw, bh, C.line)
			if (c !== null) blit.fill(f, x + u, by + u, sw - 2 * u, bh - 2 * u, c)
			const t = typeof r.value === "number" ? hex(r.value) : said(r.value)
			blit.text(f, x + sw + 8 * u, ty, t, C.ink, undefined, undefined, F)
			zones.push({ x, y, w: sw + 8 * u + blit.measure(t, F), h, act: "edit", id: r.id })
			return [x + sw + 8 * u + blit.measure(t, F), t]
		}
		if (r.control === "picture") {
			// none, then each picture; as many as fit, the one chosen among them
			const cell = THUMB + 6 * u, n = Math.max(1, Math.floor((e - x) / cell))
			const all = [null, ...pictures], at = pictureAt(r) + 1
			const first = Math.max(0, Math.min(at - Math.floor(n / 2), all.length - n))
			all.slice(first, first + n).forEach((p, i) => {
				const cx = x + i * cell, cy = y + 4 * u
				blit.fill(f, cx, cy, THUMB, THUMB, C.line)
				blit.fill(f, cx + u, cy + u, THUMB - 2 * u, THUMB - 2 * u, C.hi)
				if (p) thumb(f, p.v, cx + 2 * u, cy + 2 * u, THUMB - 4 * u)
				else blit.line(f, cx + u, cy + THUMB - 2 * u, cx + THUMB - 2 * u, cy + u, u, C.dim)
				if (first + i === at) {
					for (let k = 0; k < 2 * u; k++) {
						blit.frame(
							f,
							cx - 2 * u + k,
							cy - 2 * u + k,
							THUMB + 4 * u - 2 * k,
							THUMB + 4 * u - 2 * k,
							C.cherry,
						)
					}
				}
				zones.push({ x: cx, y, w: cell, h, act: "picture", id: r.id, value: p ? p.path : null })
			})
			return [x + Math.min(all.length, n) * cell, at ? pictures[at - 1].path.join("/") : "none"]
		}
		if (r.control === "button") {
			const t = typeof r.text === "string" ? r.text : "Open"
			return [
				button(f, x, y + Math.floor((h - blit.height(FT) - 6 * u) / 2), t, "toggle", {
					id: r.id,
				}),
				t,
			]
		}
		// show
		const t = said(r.value)
		blit.text(
			f,
			x,
			ty,
			fitted(t, e - x, F),
			r.value === false ? C.cherry : r.value === undefined || r.value === null ? C.dim : C.ink,
			undefined,
			undefined,
			F,
		)
		return [x + Math.min(blit.measure(t, F), e - x), t]
	}
	// the colour being edited: under its row, over the rest, its hex in a field and the theme's colours to click
	const palette = (f, r, x, y) => {
		const n = 11,
			cell = 16 * u,
			cs = Object.entries(theme).filter(([, c]) => typeof c === "number")
		const w = n * cell + 2 * PAD, fh = ROW() - 6 * u
		const h = PAD + fh + 6 * u + Math.ceil(cs.length / n) * cell + PAD
		x = Math.min(x, W - w - 4 * u)
		blit.fill(f, x + 2 * u, y + 2 * u, w, h, C.line)
		blit.fill(f, x, y, w, h, C.line)
		blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.paper)
		zones.push({ x, y, w, h, act: "inside" })
		field(f, { x: x + PAD, y: y + PAD, w: w - 2 * PAD, h: fh }, s.edit.field)
		zones.push({ x: x + PAD, y: y + PAD, w: w - 2 * PAD, h: fh, act: "caret" })
		cs.forEach(([k, c], i) => {
			const cx = x + PAD + (i % n) * cell, cy = y + PAD + fh + 6 * u + Math.floor(i / n) * cell
			blit.fill(f, cx, cy, cell - 2 * u, cell - 2 * u, C.line)
			blit.fill(f, cx + u, cy + u, cell - 4 * u, cell - 4 * u, c)
			if (colourOf(r.value) === c) blit.frame(f, cx - u, cy - u, cell, cell, C.cherry)
			zones.push({ x: cx, y: cy, w: cell, h: cell, act: "swatch", id: r.id, value: c })
			told.push({ x: cx, y: cy, w: cell, h: cell, role: "button", label: `${k}, ${hex(c)}` })
		})
	}
	const draw = () => {
		zones = []
		told = []
		caret = null
		const f = blit.list(W, H, C.paper)
		const foot = FOOT(), rh = ROW()
		// the list of panels
		blit.fill(f, 0, 0, LIST, H - foot, C.hi)
		blit.fill(f, LIST, 0, u, H - foot, C.line)
		panels.forEach((p, i) => {
			const y = 4 * u + i * rh
			const on = p.name === s.panel
			// the chosen one rose, its name white, as catclock's chosen cells; the list not in use, pink, its name ink
			if (on) blit.fill(f, 0, y, LIST, rh, s.side === "list" ? C.pick ?? C.line : C.lemon)
			blit.text(
				f,
				12 * u,
				mid(y, rh, FT),
				fitted(p.name, LIST - 20 * u, FT),
				on && s.side === "list" ? C.paper : C.ink,
				undefined,
				undefined,
				FT,
			)
			zones.push({ x: 0, y, w: LIST, h: rh, act: "panel", panel: p.name })
			told.push({
				x: 0,
				y,
				w: LIST,
				h: rh,
				role: "button",
				label: `${p.name}${on ? ", chosen" : ""}`,
			})
		})
		if (!panels.length) blit.text(f, 12 * u, 10 * u, "no panels", C.dim, undefined, undefined, F)
		// the panel chosen: a row a line, its label, its control, where it writes
		const x0 = LIST + u, body = { x: x0, y: 0, w: W - x0, h: H - foot }
		const rs = rowsOf()
		const tops = []
		let y = 4 * u
		for (const r of rs) {
			tops.push(y)
			y += r.control === "head" ? rh : height(r)
		}
		const total = y + 4 * u
		// the row chosen in view
		const at = rs.findIndex((r) => r.id === s.row)
		if (at >= 0) {
			if (tops[at] - s.scroll < 0) s.scroll = tops[at] - 4 * u
			if (tops[at] + height(rs[at]) - s.scroll > body.h) {
				s.scroll = tops[at] + height(rs[at]) - body.h + 4 * u
			}
		}
		s.scroll = Math.max(0, Math.min(s.scroll, total - body.h))
		let pop = null
		rs.forEach((r, i) => {
			const y = tops[i] - s.scroll, h = r.control === "head" ? rh : height(r)
			if (y + h < 0 || y > body.h) return
			if (r.control === "head") {
				blit.text(
					f,
					x0 + 12 * u,
					mid(y, h, FT) + 2 * u,
					fitted(String(r.label ?? ""), body.w - 24 * u, FT),
					C.ink,
					undefined,
					body,
					FT,
				)
				blit.fill(f, x0 + 12 * u, y + h - 3 * u, body.w - 24 * u, u, C.lo)
				return
			}
			const on = r.id === s.row
			if (on) blit.fill(f, x0, y, body.w, h, s.side === "rows" ? C.lemon : C.chrome)
			zones.push({ x: x0, y, w: body.w, h, act: "row", id: r.id })
			// a tall row (a preset's) says its label and path on its first line
			const lh = r.control === "preset" ? ROW() : h
			blit.text(
				f,
				x0 + 12 * u,
				mid(y, lh, F),
				fitted(String(r.label ?? ""), LABEL - 16 * u, F),
				C.ink,
				undefined,
				body,
				F,
			)
			const cx = x0 + LABEL
			const path = where(r), pw = path ? Math.min(blit.measure(path, F), 170 * u) : 0
			const [end, value] = control(f, r, cx, y, h, W - PAD - pw - 12 * u)
			if (path) {
				const room = W - PAD - Math.max(end + 12 * u, W - PAD - pw)
				const t = fitted(path, room, F), tw = blit.measure(t, F)
				blit.text(f, W - PAD - tw, mid(y, lh, F), t, C.ink2, undefined, body, F)
				zones.push({ x: W - PAD - tw, y, w: tw, h, act: "graph", id: r.id })
			}
			told.push({
				x: x0,
				y,
				w: body.w,
				h,
				role: s.edit?.id === r.id ? "textfield" : "button",
				label: `${r.label}, ${value}${path ? `, ${path}` : ""}`,
			})
			if (s.edit?.id === r.id && s.edit.kind === "colour") pop = [r, cx, y + h]
		})
		if (panel() && !rs.length) {
			blit.text(f, x0 + 12 * u, 10 * u, "no rows", C.dim, undefined, undefined, F)
		}
		if (pop) palette(f, ...pop)
		// the footer: what happened, else the panel's own node
		const fy = H - foot
		blit.fill(f, 0, fy, W, foot, C.chrome)
		blit.fill(f, 0, fy, W, u, C.line)
		const note = s.note ??
			(panel() ? [`/etc/panels/${panel().name}`, C.ink2] : ["/etc/panels", C.ink2])
		const t = fitted(note[0], W - 16 * u, F)
		blit.text(f, 8 * u, fy + 5 * u, t, note[1], undefined, undefined, F)
		if (!s.note) {
			zones.push({
				x: 8 * u,
				y: fy,
				w: blit.measure(t, F),
				h: foot,
				act: "graph",
				at: [...PANELS, ...(panel() ? [panel().name] : [])],
			})
		}
		return f.ops
	}
	const meaning = () => ({
		access: [{
			role: "group",
			label: "Control Panels",
			x: 0,
			y: 0,
			w: W,
			h: H,
			children: told.map(({ x, y, w, h, role, label }) => ({ role, label, x, y, w, h })),
		}],
		input: caret
			? {
				text: caret.text,
				selection: [caret.pos, caret.pos],
				caret: { x: caret.x, y: caret.y, w: 2 * u, h: caret.h },
			}
			: null,
	})
	const paint = (api) => {
		if (!idAt(api, LAYER)) return
		settle()
		const ops = draw()
		const m = meaning()
		api.write(LAYER, [
			set("w", W),
			set("h", H),
			set("draw", ops),
			set("access", m.access),
			set("input", m.input),
			set("title", "Control Panels"),
		])
		menus(api)
		keep(api)
	}

	// --- the keyboard
	handler(given, "key", (g) => {
		const { api } = g, [recs] = g.args
		for (const r of recs) {
			if (!r.down) continue
			if (s.edit) {
				if (r.key === "Escape") done(api, false)
				else if (r.key === "Enter") done(api, true)
				else {
					const next = readline.type(s.edit.field, r, { select: true, api })
					if (next) s.edit.field = next
				}
				continue
			}
			const cmd = r.mods?.includes("cmd"), shift = r.mods?.includes("shift")
			s.note = null
			if (cmd && r.key === "g") {
				graph(g, s.side === "rows" ? row()?.at : [...PANELS, ...(s.panel ? [s.panel] : [])])
			} else if (cmd) continue
			else if (r.key === "Tab") s.side = s.side === "list" ? "rows" : "list"
			else if (s.side === "list") {
				if (r.key === "ArrowUp") movePanel(-1)
				else if (r.key === "ArrowDown") movePanel(1)
				else if (r.key === "ArrowRight" || r.key === "Enter") s.side = "rows"
			} else {
				const x = row()
				if (r.key === "ArrowUp") moveRow(-1)
				else if (r.key === "ArrowDown") moveRow(1)
				else if (!x) continue
				else if (r.key === "ArrowLeft" || r.key === "ArrowRight") {
					const by = (r.key === "ArrowLeft" ? -1 : 1) * (shift ? 10 : 1)
					if (["number", "choice", "preset", "picture"].includes(x.control)) step(api, x, by)
					else if (r.key === "ArrowLeft") s.side = "list"
				} else if (r.key === " " || r.key === "Space") toggle(g, x)
				else if (r.key === "Enter") {
					x.control === "check" || x.control === "choice" || x.control === "preset"
						? toggle(g, x)
						: ["text", "number", "colour"].includes(x.control)
						? edit(x)
						: toggle(g, x)
				}
			}
		}
		paint(api)
	})

	// --- the pointer: a click does what is there; a row's path opens the graph browser at its node
	handler(given, "pointer", (g) => {
		const { api } = g, [recs] = g.args
		for (const r of recs) {
			if (r.event === "scroll") {
				s.scroll = Math.max(0, s.scroll + Math.sign(r.dy) * ROW())
				continue
			}
			if (r.event !== "down") continue
			const z = [...zones].reverse().find((z) =>
				z.act && r.x >= z.x && r.x < z.x + z.w && r.y >= z.y && r.y < z.y + z.h
			)
			s.note = null
			if (s.edit && z?.act === "caret" && caret) {
				const c = caret.from + blit.at(caret.text.slice(caret.from), r.x - caret.b.x - 6 * u, F)
				s.edit.field = { ...s.edit.field, pos: c, mark: null }
				continue
			}
			if (s.edit && z?.act === "edit" && z.id === s.edit.id && caret) {
				const c = caret.from + blit.at(caret.text.slice(caret.from), r.x - caret.b.x - 6 * u, F)
				s.edit.field = { ...s.edit.field, pos: c, mark: null }
				continue
			}
			if (s.edit && z?.act === "swatch") {
				const x = rowsOf().find((x) => x.id === z.id)
				if (x) put(api, x, z.value)
				const t = hex(z.value)
				s.edit.field = { text: t, pos: t.length, mark: 0 }
				continue
			}
			if (s.edit && z?.act === "inside") continue
			// a click elsewhere writes what was typed, as Enter
			if (s.edit) done(api, s.edit.kind !== "colour")
			if (!z) continue
			const x = z.id ? rowsOf().find((x) => x.id === z.id) : null
			if (x) {
				s.row = x.id
				s.side = "rows"
			}
			if (z.act === "panel") {
				if (z.panel !== s.panel) {
					s.panel = z.panel
					s.row = null
					s.scroll = 0
				}
				s.side = "list"
			} else if (z.act === "graph") graph(g, z.at ?? x?.at)
			else if (!x) continue
			else if (z.act === "toggle") toggle(g, x)
			else if (z.act === "choose") put(api, x, z.value)
			else if (z.act === "preset") choose(api, x, z.value)
			else if (z.act === "copy") copy(api, x)
			else if (z.act === "picture") put(api, x, z.value)
			else if (z.act === "step") step(api, x, z.by)
			else if (z.act === "edit") edit(x)
		}
		paint(api)
	})

	// --- the menu bar's Panels
	handler(given, "menu", ({ api, args: [what, which] }) => {
		if (what === "panel" && panels.some((p) => p.name === which)) {
			s.panel = which
			s.row = null
			s.scroll = 0
			s.side = "list"
		}
		paint(api)
	})

	// --- following the panels and what their rows read, the look
	effect(given, "follow", ({ api }) => ({
		panels: look(api),
		theme: val(api, ["/", "etc", "theme"]) ?? null,
		fonts: fonts(api),
	}), ({ value: v, api }) => {
		panels = v.panels
		theme = v.theme ?? {}
		colours(theme)
		paint(api)
	})

	// the pictures a picture row offers: those under its from (/home and /etc), the Trash's not, four deep at most
	effect(given, "pictures", ({ api }) => {
		const froms = []
		for (const n of api.children(PANELS)) {
			for (const r of read(api, [...PANELS, n])?.rows ?? []) {
				if (r?.control !== "picture") continue
				for (const a of Array.isArray(r.from) ? r.from : [["/", "home"], ["/", "etc"]]) {
					const at = address(a)
					if (at && !froms.some((x) => x.join("/") === at.join("/"))) froms.push(at)
				}
			}
		}
		const out = []
		const walk = (at, depth) => {
			if (out.length >= 64 || depth > 4) return
			let names = []
			try {
				names = api.children(at)
			} catch {
				return
			}
			for (const n of names) {
				const to = [...at, n]
				if (to.length === 3 && to[1] === "home" && to[2] === "Trash") continue
				const v = read(api, to)
				if (
					v?.kind === "picture" && Array.isArray(v.rows) &&
					v.rows.every((r) => typeof r === "string")
				) out.push({ path: to.slice(1), v })
				walk(to, depth + 1)
			}
		}
		for (const at of froms) walk(at, 1)
		return out
	}, ({ value: v, api }) => {
		pictures = v ?? []
		paint(api)
	})

	// the size the window manager gives: from /dev/display/windows, not its own layer, which changes each time it
	// draws or moves; so a window moving reads that and no more (deep: the same want, made again, is no new value)
	effect(
		given,
		"size",
		({ api }) => val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want ?? null,
		({ value: want, api }) => {
			if (!want) return
			W = Math.max(420 * u, want.w)
			H = Math.max(220 * u, want.h)
			paint(api)
		},
		{ deep: true },
	)

	// its layer let go (its name would stay a name in /dev/display/layers)
	onCleanup(({ api }) => drop(api, LAYERS, LAYER.at(-1)))
}
