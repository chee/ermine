// /programs/macapps: the Mac's apps from /dev/mac, listed as System 7's Finder lists a folder. top:
// Accessibility and Screen Recording permission, and how to grant them. then /dev/mac/apps: regular
// apps by name, background ones folded under a row of their own; each with its state, window count
// and windows by title. right: the chosen row drawn by the views tool.
//
// Enter, a double click or Show Window shows it in /programs/macview (through the wm's launch).
// Launch App… (a name, bundle id or path), Hide and Quit are acts at /dev/mac/do/macapps-<pid>, a
// new n each, answered in the footer.
// keys: up, down, PageUp, PageDown, Home, End; left folds, right unfolds; letters choose by name;
// cmd-o shows, cmd-l launches. the wheel and the scroll bar scroll.
//   start /apps/macapps programs/macapps
//
// folds: /apps/macapps/folds/<name>, a document. view state: <its node>/view.
import { effect, handler, idAt, make, put, val, whole } from "ermine:kit"
import { after, here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as views from "ermine:views"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, self, name, onCleanup } = given
	// this process's own node: the window's owner, whose on/key and on/pointer the window manager calls; where it is run from
	const me = here(self), cwd = me.slice(0, -1)
	const menus = [
		{
			title: "File",
			items: [
				{ label: "Show Window", key: "cmd-o" },
				{ label: "Launch App…", key: "cmd-l" },
				"-",
				{ label: "Hide App", call: "menu", args: ["hide"] },
				{ label: "Quit App…", call: "menu", args: ["quit"] },
				"-",
				{ label: "Close", key: "cmd-w" },
			],
		},
		{
			title: "View",
			items: [
				{ label: "Background Apps", call: "menu", args: ["background"] },
				{ label: "Fold All", call: "menu", args: ["fold"] },
				{ label: "Unfold All", call: "menu", args: ["unfold"] },
				"-",
				{ label: "Ask for Accessibility", call: "menu", args: ["ax"] },
				{ label: "Ask for Screen Recording", call: "menu", args: ["capture"] },
			],
		},
	]
	if (idAt(api, [...me, "menus"])) api.write([...me, "menus"], whole(menus))
	else make(api, me, "menus", menus, { ephemeral: true })
	const blit = blitter(api)
	// names in /dev/font/text, buttons and heads in /dev/font/title, sizes in /dev/font/fixed; the font ROM until they come
	let F, FT, FX
	const face = (v) => (v ? font(v) : undefined)
	const fonts = (api) => {
		F = face(val(api, ["/", "dev", "font", "text"]))
		FT = face(val(api, ["/", "dev", "font", "title"]))
		FX = face(val(api, ["/", "dev", "font", "fixed"]))
		return `${F ? String(F) : "rom"} ${FT ? String(FT) : "rom"} ${FX ? String(FX) : "rom"}`
	}
	fonts(api)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(640 * u, mode.w - 80 * u), H = Math.min(460 * u, mode.h - 80 * u)
	const MAC = ["/", "dev", "mac"]
	const LAYER = ["/", "dev", "display", "layers", `macapps-${self}`]
	const FOLDS = [...cwd, "folds", name]
	const NAME = `macapps-${String(self).replace(/[^A-Za-z0-9]/g, "")}`
	const DO = [...MAC, "do", NAME]
	const set = (key, value) => ({ path: [key], value })
	// the look, from /etc/theme: paper, a platinum toolbar, black lines, cherry for what is wrong
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
			// a chosen row, as catclock's chosen cells: rose, its name white
			pick: T.pick ?? T.line ?? 0x1c1a17,
		})
	colours(val(api, ["/", "etc", "theme"]))
	// values drawn as what they are: the views tool's (deno/views.ts), as the graph browser draws them
	const V = views.make(blit, { u, colours: C, hex: false })

	// what is folded: a document, so the window the session brings back folds what it folded
	if (!idAt(api, FOLDS)) {
		make(api, FOLDS.slice(0, -2), "folds", null)
		make(api, FOLDS.slice(0, -1), name, { folded: ["background"] })
	}
	let folded = new Set(val(api, FOLDS)?.folded ?? ["background"])
	// the document as last read: only a change to it (another window's, a person's in a shell) is taken up, so a read
	// from before this window's own write never undoes it
	let kept = JSON.stringify([...folded])
	const fold = (api, key, on) => {
		if (folded.has(key) === on) return
		if (on) folded.add(key)
		else folded.delete(key)
		api.write(FOLDS, whole({ folded: [...folded] }))
	}
	if (!idAt(api, LAYER)) {
		const n = api.children(["/", "dev", "display", "layers"]).length
		make(api, LAYER.slice(0, -1), LAYER.at(-1), {
			x: (40 + (n % 5) * 30) * u,
			y: (60 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "Mac apps",
			owner: me,
			drags: true,
			draw: [],
		}, { ephemeral: true })
	}

	// what is on screen besides the graph: the row chosen (its key), the list's scroll in rows, the details' in
	// pixels, a dialog, the footer's word, the act asked last and its n; the node view, inside this process's
	const s = {
		chosen: null,
		scroll: 0,
		dscroll: 0,
		dialog: null,
		note: null,
		n: 0,
		asked: null,
		click: { key: null, t: 0 },
	}
	const VIEW = [...me, "view"]
	const view = val(api, VIEW)
	if (view) { for (const k of Object.keys(s)) if (k in view) s[k] = view[k] }
	let viewed = view ?? null
	const keep = (api) => {
		const text = JSON.stringify(s)
		if (viewed && JSON.stringify(viewed) === text) return
		if (idAt(api, VIEW)) api.write(VIEW, whole(JSON.parse(text)))
		else make(api, me, "view", JSON.parse(text), { ephemeral: true })
		viewed = JSON.parse(text)
	}

	// --- /dev/mac, as this window sees it: access, then every app (its value may not be here yet) and its windows
	const look = (api) => {
		const status = val(api, [...MAC, "status"]) ?? null
		const apps = []
		for (const pid of api.children([...MAC, "apps"])) {
			const a = val(api, [...MAC, "apps", pid]) ?? null
			const windows = []
			for (const n of api.children([...MAC, "apps", pid])) {
				if (!n.startsWith("window-")) continue
				const w = val(api, [...MAC, "apps", pid, n]) ?? {}
				// by its id, mac/<n>: that window, never another that took its name
				windows.push({ n, id: api.children([...MAC, "apps", pid], n)[0]?.id ?? null, w })
			}
			apps.push({ pid, id: api.children([...MAC, "apps"], pid)[0]?.id ?? null, a, windows })
		}
		const named = (x) => String(x.a?.name ?? x.pid)
		apps.sort((p, q) =>
			named(p).localeCompare(named(q), undefined, { sensitivity: "base", numeric: true }) ||
			Number(p.pid) - Number(q.pid)
		)
		return { status, apps, there: api.look(MAC).length > 0 }
	}
	let shown = { status: null, apps: [], there: false }
	// an app's own fold: by its bundle id, which outlives its pid; else its name
	const foldOf = (x) => `app:${x.a?.bundle ?? x.a?.name ?? x.pid}`
	const background = (x) => !!x.a?.policy && x.a.policy !== "regular"
	// the rows: the regular apps, each with its windows unless folded; then the background apps' row, and them
	const list = (v) => {
		const rows = []
		const app = (x, depth) => {
			const open = !folded.has(foldOf(x))
			rows.push({ type: "app", key: `app:${x.pid}`, x, depth, open })
			if (open) {
				for (const w of x.windows) {
					rows.push({
						type: "window",
						key: `win:${w.id ?? x.pid + "/" + w.n}`,
						x,
						w,
						depth: depth + 1,
					})
				}
			}
		}
		const regular = v.apps.filter((x) => !background(x)), rest = v.apps.filter(background)
		for (const x of regular) app(x, 0)
		if (rest.length) {
			const open = !folded.has("background")
			rows.push({ type: "group", key: "background", count: rest.length, open, depth: 0 })
			if (open) { for (const x of rest) app(x, 1) }
		}
		return rows
	}
	let rows = []
	const chosen = () => rows.find((r) => r.key === s.chosen) ?? null

	// --- drawing
	const TOOL = () => blit.height(FT) + 14 * u
	const RH = () => Math.max(blit.height(F), blit.height(FX)) + 6 * u
	const FOOT = () => blit.height(F) + 10 * u
	const BARW = 15 * u
	const DW = () => (W >= 520 * u ? Math.min(300 * u, Math.floor(W * 0.4)) : 0)
	let zones = [], caret = null, track = null
	const fitted = V.fitted
	const button = (f, x, y, label, act, on = true, ring = false) => {
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
		zones.push({ x, y, w, h, act: on ? act : null, role: "button", label })
		return x + w
	}
	// a small one, in a line of text: Ask
	const small = (f, x, y, label, act) => {
		const w = blit.measure(label, F) + 12 * u, h = blit.height(F) + 2 * u
		blit.fill(f, x, y, w, h, C.line)
		blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
		blit.text(f, x + 6 * u, y + u, label, C.ink, undefined, undefined, F)
		zones.push({ x, y, w, h, act, role: "button", label })
		return x + w
	}
	// what ermineOS may do: one line, dim while all is well; each thing it may not, in cherry, with the way to let it
	const access = (v) => {
		const st = v.status
		if (!v.there) return [["no /dev/mac: this machine has no mac device", C.cherry]]
		if (!st) return [["waiting for the mac driver", C.dim]]
		const out = []
		if (!st.ax) {
			out.push([
				"Accessibility off: no windows. System Settings › Privacy & Security › Accessibility: ermineOS on",
				C.cherry,
				"ax",
			])
		}
		if (!st.capture) {
			out.push([
				"Screen Recording off: none shown. System Settings › Privacy & Security › Screen Recording: ermineOS on",
				C.cherry,
				"capture",
			])
		}
		if (st.on === false) {
			out.push(["/etc/mac's on is false: apps listed, no windows mirrored", C.cherry])
		}
		if (!out.length) {
			out.push([
				`Accessibility on · Screen Recording on · ${st.apps ?? v.apps.length} apps · ${
					st.elements ?? 0
				} elements${st.cut ? ` · ${st.cut} cut` : ""}`,
				C.dim,
			])
		}
		return out
	}
	const HEAD = (v) => access(v).length * (blit.height(F) + 4 * u) + 6 * u
	// the list's rectangle and how many rows fit it
	const box = (v) => {
		const y = TOOL() + HEAD(v)
		return { x: 0, y, w: W - DW(), h: H - FOOT() - y }
	}
	const seen = (v) => Math.max(1, Math.floor(box(v).h / RH()))
	const clamp = (v) => (s.scroll = Math.max(0, Math.min(s.scroll, rows.length - seen(v))))
	// scrolled so the row chosen shows
	const reveal = (v) => {
		const i = rows.findIndex((r) => r.key === s.chosen)
		if (i >= 0 && i < s.scroll) s.scroll = i
		if (i >= s.scroll + seen(v)) s.scroll = i - seen(v) + 1
		clamp(v)
	}
	// an app's state, as a small tag: running quiet, the rest in their colours
	const STATES = {
		running: "dim",
		launching: "rose",
		hung: "cherry",
		mute: "ink2",
		denied: "cherry",
		skipped: "ink2",
		self: "lilac",
	}
	const tint = (st) => C[STATES[st] ?? "ink2"]
	const badge = (f, x, y, a, on) => {
		const c = on ? C.paper : tint(a?.state)
		return V.tag(f, x, y, a?.state ?? "…", c, undefined, c)
	}
	// a window, small: its frame and title bar
	const glyph = (f, x, y, on) => {
		const w = 11 * u, h = 9 * u
		blit.fill(f, x, y, w, h, on ? C.paper : C.ink2)
		blit.fill(f, x + u, y + 3 * u, w - 2 * u, h - 4 * u, on ? C.pick ?? C.line : C.paper)
	}
	const draw = (v) => {
		zones = []
		caret = null
		const f = blit.list(W, H, C.paper)
		const top = TOOL(), rh = RH(), foot = FOOT(), r = chosen()
		// the toolbar
		blit.fill(f, 0, 0, W, top, C.chrome)
		blit.fill(f, 0, top - u, W, u, C.line)
		const mine = r?.x && r.x.a?.state !== "self"
		let x = button(f, 6 * u, 4 * u, "Show", "show", r?.type === "window") + 6 * u
		x = button(f, x, 4 * u, "Launch…", "launch", v.there) + 6 * u
		x = button(f, x, 4 * u, r?.x?.a?.hidden ? "Unhide" : "Hide", "hide", !!mine) + 6 * u
		button(f, x, 4 * u, "Quit…", "quit", !!mine)
		// access, a line a thing
		let hy = top + 4 * u
		for (const [text, c, ask] of access(v)) {
			const room = W - 16 * u - (ask ? blit.measure("Ask", F) + 20 * u : 0)
			const end = blit.text(f, 8 * u, hy + u, fitted(text, room, F), c, undefined, undefined, F)
			if (ask) small(f, end + 8 * u, hy, "Ask", ask)
			hy += blit.height(F) + 4 * u
		}
		const B = box(v)
		blit.fill(f, 0, B.y - u, W, u, C.line)
		// the list, from the scroll down
		clamp(v)
		const lw = B.w - BARW
		const n = seen(v)
		rows.slice(s.scroll, s.scroll + n).forEach((row, i) => {
			const y = B.y + i * rh, on = row.key === s.chosen
			const ink = on ? C.paper : C.ink, dim = on ? C.paper : C.dim
			if (on) blit.fill(f, 0, y, lw, rh, C.pick ?? C.line)
			const ny = y + Math.floor((rh - blit.height(F)) / 2),
				xy = y + Math.floor((rh - blit.height(FX)) / 2)
			const ind = 8 * u + row.depth * 16 * u
			let right = lw - 8 * u
			const say = (t, c) => {
				right -= blit.measure(t, FX)
				blit.text(f, right, xy, t, c, undefined, undefined, FX)
				right -= 8 * u
			}
			if (row.type === "group") {
				if (!on) blit.fill(f, 0, y, lw, u, C.lo)
				blit.text(f, ind, ny, row.open ? "▾" : "▸", ink, undefined, undefined, F)
				say(`${row.count}`, dim)
				blit.text(
					f,
					ind + 14 * u,
					ny,
					fitted("Background apps: menu bar agents, helpers", right - ind - 14 * u, F),
					on ? C.paper : C.ink2,
					undefined,
					undefined,
					F,
				)
				zones.push({
					x: 0,
					y,
					w: lw,
					h: rh,
					act: "row",
					key: row.key,
					fold: true,
					role: "button",
					label: `background apps, ${row.count}, ${row.open ? "open" : "folded"}`,
				})
				return
			}
			if (row.type === "app") {
				const a = row.x.a, k = row.x.windows.length
				if (k) blit.text(f, ind, ny, row.open ? "▾" : "▸", ink, undefined, undefined, F)
				// the active app: a cherry mark, as the task bar's focused button has
				if (a?.active) {
					blit.fill(
						f,
						ind + 13 * u,
						y + Math.floor(rh / 2) - 2 * u,
						4 * u,
						4 * u,
						on ? C.paper : C.cherry,
					)
				}
				say(k ? `${k} ${k === 1 ? "window" : "windows"}` : "no windows here", dim)
				right -= badge(null, 0, xy, a, on) - 4 * u
				badge(f, right, xy, a, on)
				right -= 8 * u
				if (a?.hidden) say("hidden", dim)
				const nx = ind + 21 * u
				blit.text(
					f,
					nx,
					ny,
					fitted(a?.name ?? `pid ${row.x.pid}`, right - nx, F),
					a?.hidden && !on ? C.ink2 : ink,
					undefined,
					undefined,
					F,
				)
				zones.push({
					x: 0,
					y,
					w: lw,
					h: rh,
					act: "row",
					key: row.key,
					tri: k ? ind + 12 * u : 0,
					role: "button",
					label: `${a?.name ?? row.x.pid}, ${a?.state ?? "arriving"}, ${k} windows${
						on ? ", selected" : ""
					}`,
				})
				return
			}
			const w = row.w.w
			glyph(f, ind + 2 * u, y + Math.floor((rh - 9 * u) / 2), on)
			if (Number.isFinite(w.w) && Number.isFinite(w.h)) say(`${w.w}×${w.h}`, dim)
			if (w.minimized) say("minimized", dim)
			const nx = ind + 21 * u
			blit.text(
				f,
				nx,
				ny,
				fitted(w.title || row.w.n, right - nx, F),
				w.title ? ink : dim,
				undefined,
				undefined,
				F,
			)
			zones.push({
				x: 0,
				y,
				w: lw,
				h: rh,
				act: "row",
				key: row.key,
				role: "button",
				label: `${w.title || row.w.n}${on ? ", selected" : ""}`,
			})
		})
		if (!rows.length) {
			const t = !v.there
				? "no mac device here"
				: v.status?.ax === false
				? "no apps until Accessibility is on"
				: "no apps yet: /etc/mac on, and the metal's mac device"
			blit.text(f, 16 * u, B.y + 12 * u, t, C.dim, undefined, undefined, F)
		}
		scrollbar(f, { x: lw, y: B.y, w: BARW, h: B.h }, n)
		// the row chosen, as the views tool draws it
		if (DW()) {
			const R = { x: W - DW() + u, y: B.y, w: DW() - u, h: B.h }
			blit.fill(f, R.x - u, B.y, u, B.h, C.line)
			details(f, v, r, R)
		}
		// the footer: a word, else what is here
		const fy = H - foot
		blit.fill(f, 0, fy, W, foot, C.chrome)
		blit.fill(f, 0, fy, W, u, C.line)
		const back = v.apps.filter(background).length,
			wins = v.apps.reduce((k, x) => k + x.windows.length, 0)
		const said = s.note ??
			[
				`${v.apps.length - back} apps, ${back} in the background · ${wins} ${
					wins === 1 ? "window" : "windows"
				} · Enter shows · ← → fold`,
				C.dim,
			]
		blit.text(
			f,
			8 * u,
			fy + 5 * u,
			fitted(said[0], W - 16 * u, F),
			said[1],
			undefined,
			undefined,
			F,
		)
		if (s.dialog) sheet(f)
		return f.ops
	}
	// System 7's scroll bar: a track, a box as long as the part shown is of the whole; an empty track when all shows
	const scrollbar = (f, R, n) => {
		blit.fill(f, R.x, R.y, R.w, R.h, rows.length > n ? C.check : C.paper)
		blit.fill(f, R.x, R.y, u, R.h, C.line)
		track = null
		if (rows.length <= n) return
		const th = Math.max(16 * u, Math.floor((R.h * n) / rows.length))
		const ty = R.y + Math.round(((R.h - th) * s.scroll) / Math.max(1, rows.length - n))
		blit.fill(f, R.x + u, ty, R.w - u, th, C.line)
		blit.fill(f, R.x + 2 * u, ty + u, R.w - 3 * u, th - 2 * u, C.hi)
		for (let k = -1; k <= 1; k++) {
			blit.fill(f, R.x + 4 * u, ty + Math.floor(th / 2) + k * 3 * u, R.w - 7 * u, u, C.lo)
		}
		track = { ...R, ty, th, n }
		zones.push({
			...R,
			act: "bar",
			role: "scrollbar",
			label: `rows ${s.scroll + 1} to ${Math.min(rows.length, s.scroll + n)} of ${rows.length}`,
		})
	}
	// the details: what the row chosen is, in lines, then its node's value as the views tool draws it
	const details = (f, v, r, R) => {
		const B = V.blocks(f, R.w - 20 * u)
		const pair = (label, text, c = C.ink) => B.line([[label.padEnd(8), C.dim], [String(text), c]])
		// words wrapped to the pane, a line at a time
		const words = (t, c = C.ink2) => {
			let line = ""
			for (const w of t.split(" ")) {
				if (line && blit.measure(`${line} ${w}`, F) > B.w) {
					B.line([[line, c]], F)
					line = w
				} else line = line ? `${line} ${w}` : w
			}
			if (line) B.line([[line, c]], F)
		}
		const head = (t) =>
			B.push(
				blit.height(FT) + 6 * u,
				(x, y, clip) => blit.text(f, x, y, fitted(t, B.w, FT), C.ink, undefined, clip, FT),
			)
		if (!r) {
			head("Nothing chosen")
			words("Up and down choose an app or a window; Enter shows a window as an ermine window.")
		} else if (r.type === "group") {
			head("Background apps")
			words(
				"Apps with no Dock icon: menu bar agents, accessibility services, helpers. Their windows, if any, are more often panels than documents.",
			)
			B.gap()
			pair("apps", r.count)
			pair("folded", r.open ? "no: ← folds" : "yes: → unfolds")
		} else if (r.type === "app") {
			const a = r.x.a ?? {}, k = r.x.windows.length
			head(a.name ?? `pid ${r.x.pid}`)
			pair("pid", r.x.pid)
			if (a.bundle) pair("bundle", a.bundle)
			pair("kind", background(r.x) ? "background (accessory)" : "regular")
			pair("state", a.state ?? "arriving", a.state === "running" ? C.ink : tint(a.state))
			if (a.active || a.hidden) {
				pair(
					"now",
					[a.active ? "active" : null, a.hidden ? "hidden" : null].filter((x) => x).join(
						" · ",
					),
				)
			}
			pair("windows", k || "none here")
			if (!k) {
				B.gap()
				words(
					a.state === "self"
						? "ermineOS itself: listed, never walked."
						: ["denied", "mute", "hung", "skipped"].includes(a.state)
						? "Its tree is not read, so its windows are not known."
						: "No windows the Mac lists here: none open, or they are on another Space. With ermineOS full screen on a Space of its own, the Mac may list only that Space's windows.",
				)
			}
			B.rule()
			V.body(B, r.x.a, V.kind(r.x.a), { key: r.x.pid, play: true })
		} else {
			const w = r.w.w, a = r.x.a ?? {}
			head(w.title || r.w.n)
			pair("app", `${a.name ?? r.x.pid} (pid ${r.x.pid})`)
			if (Number.isFinite(w.w)) pair("size", `${w.w} × ${w.h} at ${w.x}, ${w.y}`)
			const is = [
				w.main ? "main" : null,
				w.focused ? "focused" : null,
				w.minimized ? "minimized" : null,
				w.fullscreen ? "full screen" : null,
			].filter((x) => x)
			if (is.length) pair("is", is.join(" · "))
			if (r.w.id) pair("id", r.w.id)
			const st = v.status ?? {}
			const can = !st.capture
				? ["no: Screen Recording is off", C.cherry]
				: w.minimized
				? ["minimized: maybe no picture until restored", C.rose]
				: ["yes: Enter shows it", C.mint]
			pair("shows", can[0], can[1])
			B.rule()
			V.body(B, w, V.kind(w), { key: r.w.n, play: true })
		}
		s.dscroll = V.lay(B, R, s.dscroll)
	}

	// a dialog, as System 7's: a box on top, its field, Cancel and the default button
	const sheet = (f) => {
		const d = s.dialog, lh = blit.height(F), fh = lh + 8 * u
		const w = Math.min(W - 40 * u, 420 * u),
			h = 20 * u + lh + 12 * u + d.fields.length * (lh + fh + 14 * u) + blit.height(FT) + 24 * u
		const x = Math.floor((W - w) / 2), y = Math.max(TOOL() + 10 * u, Math.floor((H - h) / 3))
		// everything under it takes no clicks
		zones = [{ x: 0, y: 0, w: W, h: H, act: null }]
		blit.fill(f, x + 3 * u, y + 3 * u, w, h, C.line)
		blit.fill(f, x, y, w, h, C.paper)
		for (let i = 0; i < 2 * u; i++) blit.frame(f, x + i, y + i, w - 2 * i, h - 2 * i, C.line)
		blit.frame(f, x + 4 * u, y + 4 * u, w - 8 * u, h - 8 * u, C.line)
		let fy = y + 16 * u
		blit.text(f, x + 16 * u, fy, fitted(d.title, w - 32 * u, FT), C.ink, undefined, undefined, FT)
		fy += lh + 12 * u
		d.fields.forEach((field) => {
			blit.text(f, x + 16 * u, fy, field.label, C.dim, undefined, undefined, F)
			fy += lh + 4 * u
			const b = { x: x + 16 * u, y: fy, w: w - 32 * u, h: fh }
			blit.fill(f, b.x, b.y, b.w, b.h, C.line)
			blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi)
			const clip = { x: b.x + u, y: b.y, w: b.w - 2 * u, h: b.h }
			// the text from where the caret shows, the selection on lemon, the caret at pos (a readline field)
			const t = field.text, room = b.w - 12 * u
			let from = 0
			while (from < field.pos && blit.measure(t.slice(from, field.pos), F) > room) from++
			const xAt = (k) => b.x + 6 * u + blit.measure(t.slice(from, Math.max(from, k)), F)
			const sel = readline.selection(field)
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
			const cx = Math.min(b.x + b.w - 4 * u, xAt(field.pos))
			blit.fill(f, cx, b.y + 4 * u, 2 * u, lh, C.rose)
			caret = { text: t, pos: field.pos, x: cx, y: b.y + 4 * u, h: lh, from, b }
			zones.push({ ...b, act: "field", role: "textfield", label: field.label, value: t })
			fy += fh + 10 * u
		})
		const bh = blit.height(FT) + 8 * u, by = y + h - bh - 14 * u
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
			label: "Mac apps",
			x: 0,
			y: 0,
			w: W,
			h: H,
			children: zones.filter((z) => z.role).map(({ x, y, w, h, role, label, value }) => ({
				role,
				label,
				value,
				x,
				y,
				w,
				h,
			})),
		}],
		input: s.dialog && caret
			? {
				text: caret.text,
				selection: [caret.pos, caret.pos],
				caret: { x: caret.x, y: caret.y, w: 2 * u, h: caret.h },
			}
			: null,
	})
	// drawn as it changes; what the layer holds besides its draw list written only when it changed
	let held = null
	const paint = (api) => {
		if (!idAt(api, LAYER)) return
		V.fonts({ text: F, title: FT, fixed: FX })
		rows = list(shown)
		if (s.chosen !== null && !rows.some((r) => r.key === s.chosen)) s.chosen = null
		if (s.chosen === null) {
			s.chosen = rows.find((r) => r.type === "window")?.key ?? rows[0]?.key ?? null
		}
		const ops = draw(shown)
		const m = meaning()
		const now = { w: W, h: H, access: JSON.stringify(m.access), input: JSON.stringify(m.input) }
		const patches = [set("draw", ops)]
		for (const k of ["w", "h"]) if (held?.[k] !== now[k]) patches.push(set(k, now[k]))
		if (held?.access !== now.access) patches.push(set("access", m.access))
		if (held?.input !== now.input) patches.push(set("input", m.input))
		held = now
		api.write(LAYER, patches)
		keep(api)
	}

	// --- doing
	const why = (e) => `${e.code ?? "error"}: ${e.message}`
	const say = (text, c = C.dim) => (s.note = [text, c])
	// an act: this window's do node, placed the first time, a new n each act; the driver answers in it
	const ask = (api, value, what) => {
		s.n += 1
		const v = { ...value, n: s.n }
		if (idAt(api, DO)) api.write(DO, whole(v))
		else if (!make(api, DO.slice(0, -1), NAME, v, { ephemeral: true })) {
			throw Object.assign(new Error("no /dev/mac/do"), { code: "nothing-there" })
		}
		s.asked = what
		say(`${what}…`)
	}
	// part: what the part running was given: start and call are its own, not api's
	const show = (part, r) => {
		if (r?.type !== "window") return
		const { data, ...rest } = {
			address: ["/", "apps", "macview"],
			program: ["programs", "macview"],
			data: { window: r.w.id ?? [...MAC, "apps", r.x.pid, r.w.n] },
		}
		const launch = val(part.api, ["/", "dev", "wm", "launch"])
		if (Array.isArray(launch)) part.call(launch, [{ ...rest, data }])
		else put(part.api, part.start(rest), "data", data)
		say(`showing ${r.w.w.title || r.w.n}`, C.mint)
	}
	const dialog = (act, title, ok, fields, more) => {
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
			error: null,
			...more,
		}
	}
	const act = (part, what) => {
		const { api } = part, r = chosen()
		const a = r?.x && r.x.a?.state !== "self" ? r.x : null
		if (what === "show") show(part, r)
		else if (what === "launch") {
			dialog("launch", "Launch an app, and show its first window", "Launch", [[
				"A name (TextEdit), a bundle id or a path",
				"",
			]])
		} else if (what === "hide" && a) {
			ask(
				api,
				{ at: [...MAC, "apps", a.pid], act: a.a?.hidden ? "unhide" : "hide" },
				`${a.a?.hidden ? "unhide" : "hide"} ${a.a?.name ?? a.pid}`,
			)
		} else if (what === "quit" && a) {
			dialog("quit", `Quit ${a.a?.name ?? a.pid}? It may ask to save first.`, "Quit", [], {
				pid: a.pid,
			})
		} else if (what === "ax" || what === "capture") {
			ask(
				api,
				{ at: MAC, act: "ask", key: what },
				`ask for ${what === "ax" ? "Accessibility" : "Screen Recording"}`,
			)
		} else if (what === "background") fold(api, "background", !folded.has("background"))
		else if (what === "fold" || what === "unfold") {
			for (const x of shown.apps) if (x.windows.length) fold(api, foldOf(x), what === "fold")
		}
	}
	const run = (part, what) => {
		try {
			act(part, what)
		} catch (e) {
			say(why(e), C.cherry)
		}
	}
	const answer = (api, ok) => {
		const d = s.dialog
		s.dialog = null
		if (!ok) return
		try {
			if (d.act === "launch") {
				const app = d.fields[0].text.trim()
				if (!app) return void (s.dialog = { ...d, error: "an app, please" })
				ask(api, { act: "launch", app, show: true }, `launch ${app}`)
			} else if (d.act === "quit") {
				ask(
					api,
					{ at: [...MAC, "apps", d.pid], act: "quit" },
					`quit ${shown.apps.find((x) => x.pid === d.pid)?.a?.name ?? d.pid}`,
				)
			}
		} catch (e) {
			say(why(e), C.cherry)
		}
	}
	// the row chosen moved by some, scrolled to show it
	const move = (by) => {
		if (!rows.length) return
		const i = rows.findIndex((r) => r.key === s.chosen)
		s.chosen = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + by))].key
		reveal(shown)
	}
	// folding, from a row: an app's windows, or the background apps
	const toggle = (api, r, on) => {
		if (r?.type === "group") fold(api, "background", on ?? !folded.has("background"))
		else if (r?.type === "app" && r.x.windows.length) {
			fold(api, foldOf(r.x), on ?? !folded.has(foldOf(r.x)))
		}
		rows = list(shown)
		// unfolded: scrolled so what came out shows too, as many as fit below it
		const i = rows.findIndex((x) => x.key === r?.key)
		let k = i + 1
		while (i >= 0 && k < rows.length && rows[k].depth > rows[i].depth) k++
		const end = Math.min(k - 1, i + seen(shown) - 1)
		if (i >= 0 && end >= s.scroll + seen(shown)) s.scroll = end - seen(shown) + 1
		reveal(shown)
	}
	// type to select, as the Finder does: letters typed within a second are one name; an app's first, else a window's
	let typed = "", typedAt = 0
	const find = (ch) => {
		const now = Date.now()
		typed = now - typedAt < 1000 ? typed + ch : ch
		typedAt = now
		const t = typed.toLowerCase()
		const named = (r) =>
			(r.type === "app" ? r.x.a?.name ?? "" : r.type === "window" ? r.w.w.title ?? "" : "")
				.toLowerCase()
		const i = rows.findIndex((r) => r.type === "app" && named(r).startsWith(t))
		const k = i >= 0 ? i : rows.findIndex((r) => named(r).startsWith(t))
		if (k < 0) return
		s.chosen = rows[k].key
		reveal(shown)
	}

	// --- the keyboard
	const printable = (r) => r.text && r.text > " " && !/[\uf700-\uf8ff]/.test(r.text)
	handler(given, "key", (part) => {
		const { api } = part, [recs] = part.args
		for (const r of recs) {
			if (s.dialog) {
				const d = s.dialog, x = d.fields[0]
				if (r.event === "commit" && x) Object.assign(x, readline.type(x, r))
				if (!r.down) continue
				if (r.key === "Escape") answer(api, false)
				else if (r.key === "Enter") answer(api, true)
				else if (x) {
					// readline's keys: C-a, A-f, C-k, C-y, the arrows, shift and a move selects, cmd-c, cmd-v
					const next = readline.type(x, r, { select: true, api })
					if (next) {
						Object.assign(x, next)
						d.error = null
					}
				}
				continue
			}
			if (!r.down) continue
			const cmd = r.mods?.includes("cmd"), row = chosen()
			if (cmd && r.key === "o") run(part, "show")
			else if (cmd && r.key === "l") run(part, "launch")
			else if (cmd) continue
			else if (r.key === "ArrowDown") move(1)
			else if (r.key === "ArrowUp") move(-1)
			else if (r.key === "PageDown") move(seen(shown) - 1)
			else if (r.key === "PageUp") move(1 - seen(shown))
			else if (r.key === "Home") move(-rows.length)
			else if (r.key === "End") move(rows.length)
			else if (r.key === "ArrowLeft") {
				if (row?.type === "window") {
					s.chosen = `app:${row.x.pid}`
					reveal(shown)
				} else toggle(api, row, true)
			} else if (r.key === "ArrowRight") toggle(api, row, false)
			else if (r.key === "Enter") {
				if (row?.type === "window") show(part, row)
				else toggle(api, row)
			} else if (r.key === "Escape") s.note = null
			else if (printable(r)) find(r.text)
		}
		paint(api)
	})

	// a menu's item with no key
	handler(given, "menu", (part) => {
		const { api } = part, [what] = part.args
		run(part, what)
		paint(api)
	})

	// --- the pointer: a click chooses a row, two show its window or fold it, the triangle folds; the bar scrolls,
	// dragged or clicked; the wheel scrolls the list, or the details, a trackpad's pixels kept until they make a row
	let rest = 0, dragging = null
	handler(given, "pointer", (part) => {
		const { api } = part, [recs] = part.args
		for (const r of recs) {
			if (r.event === "scroll") {
				if (s.dialog) continue
				if (DW() && r.x >= W - DW()) s.dscroll = Math.max(0, s.dscroll + Math.round(r.dy))
				else {
					rest += r.dy / RH()
					const k = Math.trunc(rest)
					rest -= k
					s.scroll += k
					clamp(shown)
				}
				continue
			}
			if (r.event === "move" && dragging && track) {
				s.scroll = Math.round(
					dragging.scroll +
						((r.y - dragging.y) * (rows.length - track.n)) / Math.max(1, track.h - track.th),
				)
				clamp(shown)
				continue
			}
			if (r.event === "up") dragging = null
			if (r.event !== "down") continue
			const z = V.hit(zones, r.x, r.y)
			if (s.dialog) {
				if (z?.act === "ok" || z?.act === "cancel") answer(api, z.act === "ok")
				else if (z?.act === "field" && caret) {
					Object.assign(s.dialog.fields[0], {
						pos: caret.from +
							blit.at(caret.text.slice(caret.from), r.x - caret.b.x - 6 * u, F),
						mark: null,
					})
				}
				continue
			}
			if (!z?.act) continue
			s.note = null
			if (z.act === "row") {
				const row = rows.find((x) => x.key === z.key)
				const now = Date.now(), twice = s.click.key === z.key && now - s.click.t < 500
				s.chosen = z.key
				s.click = { key: z.key, t: twice ? 0 : now }
				if ((z.tri && r.x >= z.tri - 14 * u && r.x < z.tri) || z.fold) toggle(api, row)
				else if (twice && row?.type === "window") show(part, row)
				else if (twice) toggle(api, row)
			} else if (z.act === "bar" && track) {
				// on the box, a drag; above or below it, a page
				if (r.y >= track.ty && r.y < track.ty + track.th) {
					dragging = { y: r.y, scroll: s.scroll }
				} else s.scroll += (r.y < track.ty ? -1 : 1) * (track.n - 1)
				clamp(shown)
			} else run(part, z.act)
		}
		paint(api)
	})

	// --- following /dev/mac, what is folded, the look; painted at most ten times a second
	let last = 0, waiting = false, cancel = null
	onCleanup(({ api }) => cancel?.(api))
	effect(given, "list", ({ api }) => ({
		v: look(api),
		folded: val(api, FOLDS)?.folded ?? null,
		theme: val(api, ["/", "etc", "theme"]) ?? null,
		fonts: fonts(api),
	}), (part) => {
		const { v, folded: f, theme } = part.value, { api } = part
		if (theme) colours(theme)
		if (Array.isArray(f) && JSON.stringify(f) !== kept) {
			kept = JSON.stringify(f)
			folded = new Set(f)
		}
		shown = v
		const since = Date.now() - last
		if (since >= 100) {
			last = Date.now()
			return paint(api)
		}
		waiting = true
		if (!cancel) {
			cancel = after(part, 100 - since, ({ api }) => {
				cancel = null
				if (waiting) paint(api)
				waiting = false
			})
		}
	})
	// the act asked last, answered: said in the footer
	effect(given, "answer", ({ api }) => val(api, DO) ?? null, ({ value: d, api }) => {
		if (!d || d.done === undefined || d.done !== s.n || !s.asked) return
		if (d.error) say(`${s.asked}: ${d.error}`, C.cherry)
		else say(`${s.asked}: done${typeof d.value === "number" ? `, pid ${d.value}` : ""}`, C.mint)
		s.asked = null
		paint(api)
	})

	// the size the window manager gives: from /dev/display/windows, not its own layer, which changes each time it
	// draws or moves; so a window moving reads that and no more
	// <its node>/view, read as it changes: a field another wrote (a shell's set) taken on, what it wrote itself let be
	const canon = (v) =>
		JSON.stringify(
			v,
			(_k, x) => (x && typeof x === "object" && !Array.isArray(x)
				? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
				: x),
		)
	effect(given, "theirs", ({ api }) => val(api, VIEW) ?? null, ({ value: v, api }) => {
		const theirs = v && viewed
			? Object.keys(viewed).filter((k) => k in v && canon(v[k]) !== canon(viewed[k]))
			: []
		if (!theirs.length) return
		for (const k of theirs) [s[k], viewed[k]] = [v[k], JSON.parse(JSON.stringify(v[k]))]
		paint(api)
	})
	// the size the window manager gives: deep, as the window's node changes each move and the same want, made
	// again, is no new value
	effect(
		given,
		"size",
		({ api }) => val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want ?? null,
		({ value: want, api }) => {
			if (!want) return
			W = Math.max(280 * u, want.w)
			H = Math.max(160 * u, want.h)
			paint(api)
		},
		{ deep: true },
	)
}
