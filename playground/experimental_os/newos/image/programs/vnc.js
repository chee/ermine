// /programs/vnc: another machine's screen in a window, over VNC (RFB): a
// Mac's Screen Sharing, a Linux machine, a VM. The vnc driver connects and
// draws: this places a view in /dev/vnc/views, its name, where the screen
// shows in this window's layer, fit or actual size; the driver writes the
// layer's plane as frames come, and this window costs nothing a frame.
// What the window is given over the screen, keys, clicks, drags, the wheel
// and moves, goes to the driver (/dev/vnc/driver/on/input); the pointer
// takes the other side's cursor while over it (/dev/vnc/sessions/<name>/
// cursor, as /dev/pointer/cursor's address).
//
//   Connection: Connect… (host, port, user, password), Disconnect, Send
//   Clipboard (/dev/clip/text to the other side; its own comes back by
//   itself), and chords the Mac would take for itself: cmd-tab, cmd-space,
//   cmd-option-escape, cmd-q, ctrl-option-delete. View: Fit, Actual Size
//   (scroll bars), Keys to the Other Side (every key, the window manager's
//   chords too: /etc/keys' are its own until it is off again).
//
// From a shell: vnc host[:port] [user]. Its connection is a document beside
// it, /apps/vnc/connections/<its name>, {host, port, user, view, keys?, remember?}: a
// boot brings the window back, connecting again. The password is never in
// the graph: typed into a field this keeps in memory only, handed to the
// driver (on/password), which holds it while the view is there; with
// Remember, the driver keeps it in the Mac's keychain too, once it works.
// The sheet, the scroll, the keys' grab and the footer: <its node>/view.
import { blitter, font } from "ermine:draw"
import { data, drop, effect, handler, idAt, make, snap, val, whole } from "ermine:kit"
import { here } from "ermine:os"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, onCleanup, self, name } = given
	// this process's own node: the window's owner, whose on/key, on/pointer and on/hover the window manager calls
	const me = here(self)
	const place = me.slice(0, -1)
	const blit = blitter(api)
	// the text and title fonts: a font and the pages of it that have come, so a page coming draws again
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
	let W = Math.min(1024 * u, mode.w - 80 * u), H = Math.min(700 * u, mode.h - 80 * u)
	const NAME = `vnc-${String(self).replace(/[^A-Za-z0-9]/g, "")}`
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, NAME]
	const VIEW = ["/", "dev", "vnc", "views", NAME]
	const SESSION = ["/", "dev", "vnc", "sessions", NAME]
	const DRIVER = ["/", "dev", "vnc", "driver", "on"]
	const DOC = [...place, "connections", name]
	const CURSOR = ["/", "dev", "pointer", "cursor"]
	const set = (key, value) => ({ path: [key], value })
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
	// an ephemeral node at address holding value: written whole if it is there, else made
	const hold = (api, address, value) => {
		if (idAt(api, address)) api.write(address, whole(value))
		else make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
	}
	// every item at address let go
	const clear = (api, address) => {
		const parent = address.slice(0, -1), n = address.at(-1)
		for (const i of api.children(parent, n)) drop(api, parent, n, i.id)
	}
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
			mint: T.mint ?? 0x18936b,
			check: T.check ?? 0xe6dcc4,
		})
	colours(val(api, ["/", "etc", "theme"]))

	// --- the connection: the document, or the words it was started with (host[:port], or user@host, then a user)
	const words = data(given)?.args ?? []
	const parse = (text) => {
		let t = String(text ?? "").trim().replace(/^vnc:\/\//i, ""), user = null
		if (t.includes("@")) {
			;[user, t] = [t.slice(0, t.lastIndexOf("@")), t.slice(t.lastIndexOf("@") + 1)]
		}
		const m = /^(.*?)(?::(\d+))?$/.exec(t)
		return { host: m[1], port: m[2] ? Number(m[2]) : 5900, user }
	}
	let conn = val(api, DOC) ?? null
	if (words.length) {
		const p = parse(words[0])
		conn = {
			...(conn ?? {}),
			host: p.host,
			port: p.port,
			user: words[1] ?? p.user ?? conn?.user ?? "",
			view: conn?.view ?? "fit",
		}
	}
	const keepDoc = (api) => {
		if (!conn) return
		make(api, place, "connections", null)
		if (!same(val(api, DOC), conn)) snap(api, DOC, conn)
	}

	// what is on screen besides the graph: the sheet (its fields readline's, but the password's), the scroll, the
	// keys' grab, the connection's n, the footer's word; the node view, inside this process's
	const s = {
		sheet: null,
		view: conn?.view ?? "fit",
		sx: 0,
		sy: 0,
		n: 0,
		grab: false,
		note: null,
		on: false,
	}
	const VIEWNODE = [...me, "view"]
	const kept = val(api, VIEWNODE)
	if (kept) { for (const k of Object.keys(s)) if (k in kept) s[k] = kept[k] }
	let viewed = kept ?? null
	const keep = (api) => {
		const text = JSON.stringify(s)
		if (viewed && JSON.stringify(viewed) === text) return
		hold(api, VIEWNODE, JSON.parse(text))
		viewed = JSON.parse(text)
	}
	// the password: a field held here only, never written; let go once handed to the driver
	let secret = null

	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, NAME, {
			x: (40 + (n % 5) * 30) * u,
			y: (40 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "VNC",
			owner: me,
			drags: true,
			draw: [],
		}, { ephemeral: true })
	}

	// --- the session, as the driver says it
	let session = null, cursorThere = false
	const live = () => s.on && session?.state === "live"
	// the window: the screen's rectangle, the scroll bars' (actual size), the footer
	const FOOT = () => blit.height(F) + 10 * u
	const BAR = 15 * u
	const actual = () => s.view === "actual"
	const R = () => ({
		x: 0,
		y: 0,
		w: W - (actual() ? BAR : 0),
		h: H - FOOT() - (actual() ? BAR : 0),
	})
	const sw = () => session?.w ?? 0, sh = () => session?.h ?? 0
	const clampScroll = () => {
		const r = R()
		s.sx = Math.max(0, Math.min(s.sx, sw() - r.w))
		s.sy = Math.max(0, Math.min(s.sy, sh() - r.h))
	}
	// the view node: what the driver needs; written only when it changed
	let placed = null
	const viewValue = () => {
		const r = R()
		return {
			host: conn.host,
			port: conn.port,
			user: conn.user ?? "",
			layer: NAME,
			x: r.x,
			y: r.y,
			w: r.w,
			h: r.h,
			view: s.view,
			sx: s.sx,
			sy: s.sy,
			hide: !!s.sheet,
			n: s.n,
			ground: C.line,
			...(conn.keys ? { keys: conn.keys } : {}),
			...(typeof conn.remember === "boolean" ? { remember: conn.remember } : {}),
		}
	}
	const sync = (api) => {
		if (!s.on || !conn?.host) {
			if (placed) clear(api, VIEW)
			placed = null
			return
		}
		const v = viewValue()
		if (same(v, placed)) return
		hold(api, VIEW, v)
		placed = v
	}

	// --- drawing
	let zones = [], caret = null, bars = null
	const fitted = (t, w, f) => {
		if (blit.measure(t, f) <= w) return t
		let k = t.length
		while (k > 0 && blit.measure(t.slice(0, k) + "…", f) > w) k--
		return t.slice(0, k) + "…"
	}
	const button = (f, x, y, label, act, ring = false) => {
		const w = blit.measure(label, FT) + 20 * u, h = blit.height(FT) + 8 * u
		if (ring) {
			blit.fill(f, x - 3 * u, y - 3 * u, w + 6 * u, h + 6 * u, C.line)
			blit.fill(f, x - u, y - u, w + 2 * u, h + 2 * u, C.paper)
		}
		blit.fill(f, x, y, w, h, C.line)
		blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
		blit.text(f, x + 10 * u, y + 4 * u, label, C.ink, undefined, undefined, FT)
		zones.push({ x, y, w, h, act, role: "button", label })
		return w
	}
	const where =
		() => (conn?.host
			? `${conn.user ? conn.user + "@" : ""}${conn.host}${
				conn.port !== 5900 ? ":" + conn.port : ""
			}`
			: "")
	// the footer: where it is connected, and how
	const status = () => {
		if (s.note) return s.note
		if (!s.on || !session) {
			return s.on ? [`connecting to ${where()}…`, C.dim] : [
				conn?.host
					? `not connected · ${where()} · Connection › Connect…`
					: "not connected · Connection › Connect…",
				C.dim,
			]
		}
		const st = session.state
		if (st === "connecting") return [`connecting to ${where()}…`, C.dim]
		if (st === "securing") return [`${where()}: securing (${session.security ?? "…"})`, C.dim]
		if (st === "password") {
			return [
				`${where()} wants ${session.want === "user" ? "a user and a password" : "a password"}`,
				C.ink2,
			]
		}
		if (st === "failed") return [`${where()}: ${session.error ?? "failed"}`, C.cherry]
		if (st === "closed") {
			return [`${where()}: closed${session.error ? ": " + session.error : ""}`, C.ink2]
		}
		const scale = actual() ? "actual size" : `fit ${Math.round((session.scale ?? 1) * 100 / u)}%`
		const parts = [
			where(),
			session.desktop || null,
			`${session.w}×${session.h}`,
			session.encoding,
			scale,
			`RFB ${session.version}`,
			session.security,
			s.grab ? "every key to it" : null,
		]
		return [parts.filter((x) => x).join(" · "), C.ink]
	}
	// System 7's scroll bar, across or down: its track, a box as long as the part shown is of the whole
	const bar = (f, B, across, at, shown, total) => {
		blit.fill(f, B.x, B.y, B.w, B.h, total > shown ? C.check : C.paper)
		blit.fill(f, B.x, B.y, across ? B.w : u, across ? u : B.h, C.line)
		if (total <= shown) return null
		const len = across ? B.w : B.h, th = Math.max(16 * u, Math.floor((len * shown) / total))
		const t = Math.round(((len - th) * at) / Math.max(1, total - shown))
		const box = across
			? { x: B.x + t, y: B.y + u, w: th, h: B.h - u }
			: { x: B.x + u, y: B.y + t, w: B.w - u, h: th }
		blit.fill(f, box.x, box.y, box.w, box.h, C.line)
		blit.fill(f, box.x + u, box.y + u, box.w - 2 * u, box.h - 2 * u, C.hi)
		return { ...B, across, t, th, len, shown, total }
	}
	const draw = () => {
		zones = []
		caret = null
		bars = null
		const f = blit.list(W, H)
		const r = R(), foot = FOOT()
		// the screen's rectangle: the driver's plane while live (left undrawn); else the ground and a word
		if (!live() || s.sheet) {
			blit.fill(f, r.x, r.y, r.w, r.h, C.line)
			if (!s.sheet) {
				const st = session?.state, lh = blit.height(FT)
				const head = !s.on
					? "Not connected"
					: st === "failed"
					? "Could not connect"
					: st === "closed"
					? "The connection closed"
					: st === "password"
					? "A password, please"
					: "Connecting…"
				const cy = r.y + Math.floor(r.h / 2) - lh * 2
				blit.text(
					f,
					r.x + Math.floor((r.w - blit.measure(head, FT)) / 2),
					cy,
					head,
					C.paper,
					undefined,
					undefined,
					FT,
				)
				const label = s.on && st !== "failed" && st !== "closed"
					? "Connect…"
					: conn?.host
					? "Connect Again"
					: "Connect…"
				const bw = blit.measure(label, FT) + 20 * u
				button(f, r.x + Math.floor((r.w - bw) / 2), cy + lh + 14 * u, label, "connect")
			}
		}
		if (actual() && live()) {
			const by = r.y + r.h
			bars = {
				x: bar(f, { x: r.x, y: by, w: r.w, h: BAR }, true, s.sx, r.w, sw()),
				y: bar(f, { x: r.x + r.w, y: r.y, w: BAR, h: r.h }, false, s.sy, r.h, sh()),
			}
			blit.fill(f, r.x + r.w, by, BAR, BAR, C.paper)
			blit.fill(f, r.x + r.w, by, u, BAR, C.line)
			blit.fill(f, r.x + r.w, by, BAR, u, C.line)
		}
		const fy = H - foot
		blit.fill(f, 0, fy, W, foot, C.chrome)
		blit.fill(f, 0, fy, W, u, C.line)
		const [said, c] = status()
		// a dot: live in mint, waiting in grey, failed in cherry
		const st = session?.state,
			dot = !s.on ? C.dim : st === "live" ? C.mint : st === "failed" ? C.cherry : C.lo
		blit.fill(f, 8 * u, fy + Math.floor((foot - 6 * u) / 2), 6 * u, 6 * u, dot)
		blit.text(f, 20 * u, fy + 5 * u, fitted(said, W - 28 * u, F), c, undefined, undefined, F)
		if (s.sheet) sheet(f)
		return f.ops
	}

	// the sheet, as System 7's dialog: its fields, Cancel and Connect; the password's shown as dots, held only here
	const FIELDS = ["Host", "Port", "User (a Mac: its login)", "Password (never in the graph)"]
	const fieldOf = (i) => (i === 3 ? secret ?? (secret = { text: "", pos: 0 }) : s.sheet.fields[i])
	const sheet = (f) => {
		const d = s.sheet, lh = blit.height(F), fh = lh + 8 * u
		const w = Math.min(W - 40 * u, 420 * u),
			h = 20 * u + lh + 12 * u + FIELDS.length * (lh + fh + 14 * u) + lh + 12 * u +
				blit.height(FT) + 24 * u
		const x = Math.floor((W - w) / 2), y = Math.max(10 * u, Math.floor((H - FOOT() - h) / 3))
		zones = [{ x: 0, y: 0, w: W, h: H, act: null }]
		blit.fill(f, x + 3 * u, y + 3 * u, w, h, C.line)
		blit.fill(f, x, y, w, h, C.paper)
		for (let i = 0; i < 2 * u; i++) blit.frame(f, x + i, y + i, w - 2 * i, h - 2 * i, C.line)
		blit.frame(f, x + 4 * u, y + 4 * u, w - 8 * u, h - 8 * u, C.line)
		let fy = y + 16 * u
		blit.text(
			f,
			x + 16 * u,
			fy,
			fitted(d.title ?? "Connect to another screen", w - 32 * u, FT),
			C.ink,
			undefined,
			undefined,
			FT,
		)
		fy += lh + 12 * u
		FIELDS.forEach((label, i) => {
			blit.text(f, x + 16 * u, fy, label, C.dim, undefined, undefined, F)
			fy += lh + 4 * u
			const b = { x: x + 16 * u, y: fy, w: w - 32 * u, h: fh }
			const on = d.at === i, field = fieldOf(i)
			blit.fill(f, b.x, b.y, b.w, b.h, C.line)
			blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi)
			const clip = { x: b.x + u, y: b.y, w: b.w - 2 * u, h: b.h }
			const t = i === 3 ? "•".repeat(field.text.length) : field.text, room = b.w - 12 * u
			let from = 0
			while (from < field.pos && blit.measure(t.slice(from, field.pos), F) > room) from++
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
				blit.fill(f, cx, b.y + 4 * u, 2 * u, lh, C.cherry)
				caret = { text: t, pos: field.pos, x: cx, y: b.y + 4 * u, h: lh, from, b, i }
			}
			zones.push({ ...b, act: "field", i, role: "textfield", label })
			fy += fh + 10 * u
		})
		// System 7's checkbox: a box, a cross in it when on
		const n = 12 * u, cy = fy + Math.floor((lh - n) / 2)
		blit.fill(f, x + 16 * u, cy, n, n, C.line)
		blit.fill(f, x + 17 * u, cy + u, n - 2 * u, n - 2 * u, C.hi)
		if (d.remember) {
			for (let i = 2 * u; i < n - 2 * u; i += u) {
				blit.fill(f, x + 16 * u + i, cy + i, u, u, C.line)
				blit.fill(f, x + 16 * u + n - u - i, cy + i, u, u, C.line)
			}
		}
		const label = "Remember password in the Mac's keychain"
		blit.text(f, x + 16 * u + n + 6 * u, fy, label, C.ink, undefined, undefined, F)
		zones.push({
			x: x + 16 * u,
			y: fy,
			w: n + 6 * u + blit.measure(label, F),
			h: lh,
			act: "remember",
			role: "checkbox",
			label: `${label}, ${d.remember ? "on" : "off"}`,
		})
		const bh = blit.height(FT) + 8 * u, by = y + h - bh - 14 * u
		const okw = blit.measure("Connect", FT) + 20 * u, cw = blit.measure("Cancel", FT) + 20 * u
		button(f, x + w - 20 * u - okw, by, "Connect", "ok", true)
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

	// the menus, as they are now: what is chosen already greyed
	const menusOf = () => [
		{
			title: "Connection",
			items: [
				{ label: "Connect…", call: "menu", args: ["connect"] },
				{ label: "Disconnect", call: "menu", args: ["disconnect"], off: !s.on },
				"-",
				{ label: "Send Clipboard", call: "menu", args: ["clip"], off: !live() },
				"-",
				{ label: "Send cmd-Tab", call: "menu", args: ["send", ["cmd", "Tab"]], off: !live() },
				{
					label: "Send cmd-Space",
					call: "menu",
					args: ["send", ["cmd", "Space"]],
					off: !live(),
				},
				{
					label: "Send cmd-option-Escape",
					call: "menu",
					args: ["send", ["cmd", "alt", "Escape"]],
					off: !live(),
				},
				{ label: "Send cmd-Q", call: "menu", args: ["send", ["cmd", "q"]], off: !live() },
				{
					label: "Send ctrl-option-Delete",
					call: "menu",
					args: ["send", ["ctrl", "alt", "Delete"]],
					off: !live(),
				},
				"-",
				{ label: "Close", key: "cmd-w" },
			],
		},
		{
			title: "View",
			items: [
				{ label: "Fit", call: "menu", args: ["fit"], off: !actual() },
				{ label: "Actual Size", call: "menu", args: ["actual"], off: actual() },
				"-",
				{
					label: s.grab ? "Keys to ermine Again" : "Keys to the Other Side",
					call: "menu",
					args: ["grab"],
				},
			],
		},
	]
	let menued = null
	const menus = (api) => {
		const m = menusOf()
		if (same(m, menued)) return
		hold(api, [...me, "menus"], m)
		menued = m
	}
	// every key, the window manager's chords too, while grabbed
	const grab = (api) => {
		if (idAt(api, [...me, "grab"])) api.write([...me, "grab"], whole(!!s.grab))
		else if (s.grab) make(api, me, "grab", true, { ephemeral: true })
	}

	let held = null
	const paint = (api) => {
		if (!idAt(api, LAYER)) return
		clampScroll()
		sync(api)
		const ops = draw()
		const title = session?.desktop
			? `${session.desktop}`
			: conn?.host
			? `VNC: ${conn.host}`
			: "VNC"
		const access = [{
			role: "group",
			label: `VNC, ${status()[0]}`,
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
		}]
		const now = { w: W, h: H, title, access: JSON.stringify(access) }
		const patches = [set("draw", ops)]
		for (const k of ["w", "h", "title"]) if (held?.[k] !== now[k]) patches.push(set(k, now[k]))
		if (held?.access !== now.access) patches.push(set("access", access))
		held = now
		api.write(LAYER, patches)
		menus(api)
		keep(api)
	}

	// --- doing
	const input = ({ call }, events) => {
		if (!events.length || !live()) return
		try {
			call([...DRIVER, "input"], [NAME, events])
		} catch (e) {
			s.note = [`the driver: ${e.message}`, C.cherry]
		}
	}
	const open = (title, at) => {
		const c = conn ?? { host: "", port: 5900, user: "" }
		const fields = [c.host ?? "", String(c.port ?? 5900), c.user ?? ""].map((t) => ({
			text: t,
			pos: t.length,
			mark: t ? 0 : null,
		}))
		s.sheet = { fields, at: at ?? (c.host ? 3 : 0), error: null, title, remember: !!c.remember }
		if (!secret) secret = { text: "", pos: 0 }
	}
	const close = () => {
		s.sheet = null
		secret = null
	}
	const connect = ({ api, call }) => {
		const [h, p, us] = s.sheet.fields.map((x) => x.text.trim())
		const at = parse(h)
		const port = p ? Number(p) : at.port
		if (!at.host) return void (s.sheet.error = "a host, please")
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return void (s.sheet.error = "a port, 1 to 65535")
		}
		const user = us || at.user || ""
		const waiting = s.on && session?.state === "password" && conn?.host === at.host &&
			conn?.port === port
		// remember: true while chosen; false once it was, so the driver takes it out of the keychain
		const { remember: was, ...rest } = conn ?? {}
		conn = {
			...rest,
			host: at.host,
			port,
			user,
			view: s.view,
			...(s.sheet.remember ? { remember: true } : was !== undefined ? { remember: false } : {}),
		}
		keepDoc(api)
		const pw = secret?.text ?? ""
		try {
			if (pw || waiting) call([...DRIVER, "password"], [NAME, pw, user])
		} catch (e) {
			return void (s.sheet.error = `the driver: ${e.message}`)
		}
		close()
		s.note = null
		// waiting for this password: the same connection goes on; else a new one
		if (!waiting) {
			s.n += 1
			s.on = true
			session = null
		}
	}
	const disconnect = (api) => {
		s.on = false
		session = null
		sync(api)
		shape(api, null)
	}
	// the other side's cursor, while over its screen and it sends one
	let shown = null
	const shape = (api, want) => {
		if (same(want, shown)) return
		shown = want
		if (idAt(api, CURSOR)) api.write(CURSOR, whole(want))
	}
	const over = (r) => {
		const b = R()
		return r.x >= b.x && r.y >= b.y && r.x < b.x + b.w && r.y < b.y + b.h
	}
	const act = (g, what, arg) => {
		const { api } = g
		s.note = null
		if (what === "connect") open()
		else if (what === "disconnect") disconnect(api)
		else if (what === "clip") {
			const t = val(api, ["/", "dev", "clip", "text"])?.text
			if (typeof t === "string") {
				input(g, [{ event: "clip", text: t }])
				s.note = [`sent the clipboard, ${t.length} characters`, C.mint]
			} else s.note = ["the clipboard holds no text", C.ink2]
		} else if (what === "send" && Array.isArray(arg)) input(g, [{ event: "chord", keys: arg }])
		else if (what === "fit" || what === "actual") {
			s.view = what
			if (conn) {
				conn = { ...conn, view: what }
				keepDoc(api)
			}
		} else if (what === "grab") {
			s.grab = !s.grab
			grab(api)
		}
	}

	// --- the keyboard: the sheet's, else the other side's, all of it
	handler(given, "key", (g) => {
		const { api } = g, [recs] = g.args
		const out = []
		for (const r of recs) {
			if (s.sheet) {
				const d = s.sheet, x = fieldOf(d.at), cmd = r.mods?.includes("cmd")
				if (r.event === "commit") Object.assign(x, readline.type(x, r))
				if (r.event !== "key" || !r.down) continue
				if (r.key === "Escape") close()
				else if (r.key === "Enter") connect(g)
				else if (r.key === "Tab") d.at = (d.at + (r.mods?.includes("shift") ? 3 : 1)) % 4
				else if (cmd && r.key === "v") {
					const t = val(api, ["/", "dev", "clip", "text"])?.text
					if (typeof t === "string") {
						Object.assign(
							x,
							readline.insert(x, t.replace(/\s+/g, d.at === 3 ? "" : " ").trim()),
						)
					}
				} else if (!cmd || r.key.startsWith("Arrow") || r.key === "Backspace") {
					const next = readline.type(x, r, { select: true })
					if (next) {
						Object.assign(x, next)
						d.error = null
					}
				}
				continue
			}
			if (live()) {
				if (r.event === "key" || r.event === "commit") out.push(r)
				continue
			}
			if (r.event === "key" && r.down && r.key === "Enter") open()
		}
		input(g, out)
		paint(api)
	})

	// --- the pointer: over the screen, the other side's (a press there keeps the drag its own); the scroll bars
	let pressing = false, dragging = null
	handler(given, "pointer", (g) => {
		const { api } = g, [recs] = g.args
		const out = []
		for (const r of recs) {
			if (s.sheet) {
				if (r.event !== "down") continue
				const z = zones.slice().reverse().find((z) =>
					r.x >= z.x && r.y >= z.y && r.x < z.x + z.w && r.y < z.y + z.h
				)
				if (z?.act === "ok") connect(g)
				else if (z?.act === "cancel") close()
				else if (z?.act === "remember") s.sheet.remember = !s.sheet.remember
				else if (z?.act === "field") {
					s.sheet.at = z.i
					if (caret && caret.i === z.i) {
						Object.assign(fieldOf(z.i), {
							pos: caret.from +
								blit.at(caret.text.slice(caret.from), r.x - caret.b.x - 6 * u, F),
							mark: null,
						})
					}
				}
				continue
			}
			if (dragging) {
				if (r.event === "move") {
					const b = dragging.bar, by = (b.across ? r.x : r.y) - dragging.from
					const to = Math.round(
						dragging.at + (by * (b.total - b.shown)) / Math.max(1, b.len - b.th),
					)
					if (b.across) s.sx = to
					else s.sy = to
					clampScroll()
				} else if (r.event === "up") dragging = null
				continue
			}
			if (live() && (pressing || over(r))) {
				if (r.event === "down") pressing = true
				if (r.event === "up") pressing = false
				if (r.event !== "move" || pressing) out.push(r)
				continue
			}
			if (r.event !== "down") continue
			// a scroll bar: its box dragged; its track, a page
			for (const b of [bars?.x, bars?.y]) {
				if (!b || r.x < b.x || r.y < b.y || r.x >= b.x + b.w || r.y >= b.y + b.h) continue
				const p = b.across ? r.x - b.x : r.y - b.y
				if (p >= b.t && p < b.t + b.th) {
					dragging = { bar: b, from: b.across ? r.x : r.y, at: b.across ? s.sx : s.sy }
				} else if (b.across) s.sx += (p < b.t ? -1 : 1) * (b.shown - 40 * u)
				else s.sy += (p < b.t ? -1 : 1) * (b.shown - 40 * u)
				clampScroll()
			}
			const z = zones.find((z) => r.x >= z.x && r.y >= z.y && r.x < z.x + z.w && r.y < z.y + z.h)
			if (z?.act === "connect") {
				if (
					conn?.host && s.on && (session?.state === "failed" || session?.state === "closed")
				) {
					s.n += 1
					session = null
				} else open()
			}
		}
		input(g, out)
		paint(api)
	})

	// --- moves with no button down: to the other side, and the pointer takes its cursor; the arrow again off it
	handler(given, "hover", (g) => {
		const { api } = g, [recs] = g.args
		if (s.sheet || !live()) return shape(api, null)
		const moves = recs.filter((r) => r.event === "move" && over(r))
		input(g, moves)
		const off = recs.some((r) => r.event === "leave") || (recs.length && !over(recs.at(-1)))
		shape(api, !off && moves.length && cursorThere ? [...SESSION, "cursor"] : off ? null : shown)
	})

	handler(given, "menu", (g) => {
		const [what, arg] = g.args
		act(g, what, arg)
		paint(g.api)
	})

	// its layer and view let go (their names would stay names in /dev/display/layers and /dev/vnc/views)
	onCleanup(({ api }) => {
		secret = null
		if (shown) shape(api, null)
		clear(api, VIEW)
		clear(api, LAYER)
	})

	// --- following the session, the look, the window's size, the focus
	effect(given, "session", ({ api }) => ({
		session: val(api, SESSION) ?? null,
		cursor: !!idAt(api, [...SESSION, "cursor"]),
		theme: val(api, ["/", "etc", "theme"]) ?? null,
		fonts: fonts(api),
	}), ({ value: { session: v, cursor, theme }, api }) => {
		if (theme) colours(theme)
		session = s.on ? v : null
		cursorThere = cursor
		// the password wanted: the sheet, at the password (or the user, when it wants one)
		if (v?.state === "password" && s.on && !s.sheet) {
			open(
				v.want === "user"
					? "This Mac wants a user and a password"
					: "This screen wants a password",
				v.want === "user" && !conn?.user ? 2 : 3,
			)
		}
		paint(api)
	})
	effect(
		given,
		"size",
		({ api }) => val(api, ["/", "dev", "display", "windows", NAME])?.want ?? null,
		({ value: want, api }) => {
			if (!want) return
			W = Math.max(320 * u, want.w)
			H = Math.max(200 * u, want.h)
			paint(api)
		},
	)
	// the keyboard gone to another window: every key held let go on the other side, so none sticks
	effect(given, "focus", ({ api }) => val(api, ["/", "dev", "display", "focus"]) === NAME, (g) => {
		if (!g.value) input(g, [{ event: "release" }])
	})

	// started with somewhere to go: connect at once (a password asked for when it is wanted); else the sheet
	if (conn?.host && !s.on && !kept) {
		s.on = true
		s.n += 1
	}
	if (!conn?.host && !s.sheet) open()
	if (s.grab) grab(api)
	keepDoc(api)
	paint(api)
}
