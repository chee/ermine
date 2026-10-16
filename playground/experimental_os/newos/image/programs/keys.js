// /programs/keys: Keys, the key bindings' settings: /etc/keys as a table,
// each chord the window manager takes and what it runs (wmiirc runs it). The
// world menu and My Computer open it.
//
// A row's command is edited in place: Enter or a double click, then readline's
// keys; Enter writes it, Escape lets it be. Add… (cmd-n) waits for a chord:
// press it (Escape: none), then say what it runs. Change Key… (k, or cmd-k)
// waits for a chord too, and moves the row's command to it. Delete (Backspace, or
// cmd-Backspace) lets a binding go. A command is a program and its words
// (term, view 2, window close, edit apps/workspace/text) or an address, a
// handler or a node holding one's (/dev/wm/ctl kill). An empty one lets the
// binding go too.
//
// While it waits for a chord its node holds grab, true, so the window manager
// gives it every key, the bound ones too. The row chosen, the scroll, a row
// being edited (its field, as readline keeps it), waiting, the footer: the
// node view, inside this process's, read as it changes: a field another
// writes is taken on.
import { blitter, font } from "ermine:draw"
import { effect, handler, idAt, make, val, whole } from "ermine:kit"
import { here } from "ermine:os"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, self } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const ME = here(self)
	const KEYS = ["/", "etc", "keys"]
	// a node of this process's, ephemeral: its value written, or the node made holding it
	const keeps = (api, address, value) =>
		idAt(api, address)
			? api.write(address, whole(value))
			: make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
	// its menus, written as the row chosen changes: what needs one greyed without
	let menued = null
	const menus = (api) => {
		const off = s.chosen ? {} : { off: true }
		const value = [{
			title: "File",
			items: [
				{ label: "Add Binding…", key: "cmd-n" },
				{ label: "Edit Binding", key: "Enter", ...off },
				{ label: "Change Key…", key: "cmd-k", ...off },
				{ label: "Delete Binding", key: "cmd-Backspace", ...off },
				"-",
				{ label: "Close", key: "cmd-w" },
			],
		}]
		const text = JSON.stringify(value)
		if (text === menued) return
		menued = text
		keeps(api, [...ME, "menus"], value)
	}
	const blit = blitter(api)
	// labels in /dev/font/text, chords and buttons in /dev/font/title; the font ROM until they come
	let F, FT
	const fontAt = (api, role) => {
		const v = val(api, ["/", "dev", "font", role])
		return v ? font(v) : undefined
	}
	const fonts = (api) => {
		F = fontAt(api, "text")
		FT = fontAt(api, "title")
		return `${F ? String(F) : "rom"} ${FT ? String(FT) : "rom"}`
	}
	fonts(api)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(560 * u, mode.w - 60 * u), H = Math.min(520 * u, mode.h - 80 * u)
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `keys-${self}`]
	const set = (key, value) => ({ path: [key], value })
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
			// a chosen row, as catclock's chosen cells: rose, its name white
			pick: T.pick ?? T.line ?? 0x1c1a17,
		})
	colours(val(api, ["/", "etc", "theme"]))

	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (100 + (n % 5) * 30) * u,
			y: (80 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "Keys",
			owner: ME,
			draw: [],
		}, { ephemeral: true })
	}

	// the view: the row chosen (its chord), the scroll, the row edited {chord, field, fresh?}, waiting for a chord, the footer
	const s = {
		chosen: null,
		scroll: 0,
		edit: null,
		waiting: false,
		from: null,
		note: null,
		click: { chord: null, t: 0 },
	}
	const VIEW = [...ME, "view"]
	const view = val(api, VIEW)
	if (view) { for (const k of Object.keys(s)) if (k in view) s[k] = view[k] }
	let viewed = view ?? null
	// a key since the last draw: the row chosen scrolled into view
	let reveal = true
	const GRAB = [...ME, "grab"]
	const keep = (api) => {
		const now = { ...s }
		const text = JSON.stringify(now)
		if (!viewed || JSON.stringify(viewed) !== text) {
			keeps(api, VIEW, now)
			viewed = JSON.parse(text)
		}
		// while it waits for a chord, the window manager gives it every key
		if (!idAt(api, GRAB) || val(api, GRAB) !== s.waiting) keeps(api, GRAB, s.waiting)
	}

	// --- the bindings, as /etc/keys holds them: [{chord, run}], by what they run, then by chord
	const listOf = (v) =>
		Object.entries(v && typeof v === "object" && !Array.isArray(v) ? v : {})
			.filter(([, c]) => typeof c === "string")
			.map(([chord, run]) => ({ chord, run }))
			.sort((a, b) =>
				a.run.localeCompare(b.run, undefined, { numeric: true }) ||
				a.chord.localeCompare(b.chord, undefined, { numeric: true })
			)
	let rows = listOf(val(api, KEYS))
	const why = (
		e,
	) => (e.code
		? (String(e.message).startsWith(e.code) ? e.message : `${e.code}: ${e.message}`)
		: `error: ${e.message}`)
	// a binding written, or let go (run null); /etc/keys made if it is not there
	const bind = (api, chord, run) => {
		try {
			make(api, KEYS.slice(0, -1), "keys", {})
			api.write(KEYS, [run === null ? { path: [chord] } : set(chord, run)])
			s.note = run === null ? [`${chord}: let go`, C.ok] : [`${chord} runs ${run}`, C.ok]
		} catch (e) {
			s.note = [why(e), C.cherry]
		}
	}

	// --- drawing
	const TOOL = () => blit.height(FT) + 14 * u
	const FOOT = () => blit.height(F) + 10 * u
	const ROW = () => Math.max(blit.height(F), blit.height(FT)) + 8 * u
	const CHORD = 150 * u
	const fitted = (text, w, font) => {
		const n = blit.fit(text, w, font)
		return n >= text.length ? text : text.slice(0, Math.max(0, n - 1)) + "…"
	}
	let zones = []
	let caret = null
	const button = (f, x, y, label, act, on = true) => {
		const w = blit.measure(label, FT) + 20 * u, h = blit.height(FT) + 8 * u
		blit.fill(f, x, y, w, h, C.line)
		blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
		blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
		blit.text(f, x + 10 * u, y + 4 * u, label, on ? C.ink : C.dim, undefined, undefined, FT)
		zones.push({ x, y, w, h, act: on ? act : null, role: "button", label })
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
		blit.text(
			f,
			b.x + 6 * u,
			b.y + Math.floor((b.h - blit.height(F)) / 2),
			t.slice(from),
			C.ink,
			undefined,
			clip,
			F,
		)
		const cx = Math.min(b.x + b.w - 3 * u, at(x.pos))
		blit.fill(f, cx, b.y + 3 * u, 2 * u, b.h - 6 * u, C.rose)
		caret = { text: t, pos: x.pos, x: cx, y: b.y + 3 * u, h: b.h - 6 * u, from, b }
	}
	const draw = () => {
		zones = []
		caret = null
		const f = blit.list(W, H, C.paper)
		const top = TOOL(), foot = FOOT(), rh = ROW()
		blit.fill(f, 0, 0, W, top, C.chrome)
		blit.fill(f, 0, top - u, W, u, C.line)
		let x = button(f, 6 * u, 4 * u, "Add…", "add") + 6 * u
		x = button(f, x, 4 * u, "Edit", "edit", !!s.chosen) + 6 * u
		x = button(f, x, 4 * u, "Change Key…", "rekey", !!s.chosen) + 6 * u
		button(f, x, 4 * u, "Delete", "delete", !!s.chosen)
		// the heads, then a row a binding
		const hy = top + 4 * u
		blit.text(f, 12 * u, hy, "Chord", C.dim, undefined, undefined, F)
		blit.text(f, 12 * u + CHORD, hy, "Runs", C.dim, undefined, undefined, F)
		blit.fill(f, 0, hy + blit.height(F) + 3 * u, W, u, C.lo)
		const body = {
			x: 0,
			y: hy + blit.height(F) + 4 * u,
			w: W,
			h: H - foot - (hy + blit.height(F) + 4 * u),
		}
		// a new binding being said: a row of its own, first
		const shown = s.edit && !rows.some((r) => r.chord === s.edit.chord)
			? [{ chord: s.edit.chord, run: "" }, ...rows]
			: rows
		const seen = Math.max(1, Math.floor(body.h / rh))
		// the keyboard keeps the row chosen in view; the wheel lets it go
		const at = shown.findIndex((r) => r.chord === (s.edit?.chord ?? s.chosen))
		if (reveal && at >= 0 && at < s.scroll) s.scroll = at
		if (reveal && at >= s.scroll + seen) s.scroll = at - seen + 1
		reveal = false
		s.scroll = Math.max(0, Math.min(s.scroll, shown.length - seen))
		shown.slice(s.scroll, s.scroll + seen).forEach((r, i) => {
			const y = body.y + i * rh
			const on = r.chord === s.chosen && !s.edit
			if (on) blit.fill(f, 0, y, W, rh, C.pick ?? C.line)
			blit.text(
				f,
				12 * u,
				y + Math.floor((rh - blit.height(FT)) / 2),
				fitted(r.chord, CHORD - 16 * u, FT),
				on ? C.paper : C.ink,
				undefined,
				body,
				FT,
			)
			const b = { x: 6 * u + CHORD, y: y + u, w: W - CHORD - 12 * u, h: rh - 2 * u }
			if (s.edit?.chord === r.chord) field(f, b, s.edit.field)
			else {blit.text(
					f,
					12 * u + CHORD,
					y + Math.floor((rh - blit.height(F)) / 2),
					fitted(r.run, W - CHORD - 24 * u, F),
					on ? C.paper : C.ink,
					undefined,
					body,
					F,
				)}
			zones.push({
				x: 0,
				y,
				w: W,
				h: rh,
				act: "row",
				chord: r.chord,
				b,
				role: s.edit?.chord === r.chord ? "textfield" : "button",
				label: `${r.chord}, ${r.run || "nothing yet"}`,
				value: s.edit?.chord === r.chord ? s.edit.field.text : undefined,
			})
		})
		if (!shown.length) {
			blit.text(
				f,
				16 * u,
				body.y + 12 * u,
				"no bindings: Add… binds one",
				C.dim,
				undefined,
				undefined,
				F,
			)
		}
		const fy = H - foot
		blit.fill(f, 0, fy, W, foot, C.chrome)
		blit.fill(f, 0, fy, W, u, C.line)
		const said = s.waiting && s.from
			? [`press the new chord for ${s.from} (Escape: none)`, C.rose]
			: s.waiting
			? ["press the chord to bind (Escape: none)", C.rose]
			: s.edit
			? [
				`${s.edit.chord}: what it runs, a program and its words or an address. Enter writes it`,
				C.dim,
			]
			: s.note ??
				[`/etc/keys: ${rows.length} ${rows.length === 1 ? "binding" : "bindings"}`, C.dim]
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
		return f.ops
	}
	const meaning = () => ({
		access: [{
			role: "group",
			label: "Keys",
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
		const ops = draw()
		const m = meaning()
		api.write(LAYER, [
			set("w", W),
			set("h", H),
			set("draw", ops),
			set("access", m.access),
			set("input", m.input),
			set("title", "Keys"),
		])
		keep(api)
		menus(api)
	}

	// --- doing
	const edit = (said) => {
		// a chord bound as written another way (M-A-x, A-M-x) is that binding
		const had = rows.find((r) => readline.normal(r.chord) === readline.normal(said))
		const chord = had?.chord ?? said, run = had?.run ?? ""
		// all of it selected, so typing replaces it
		s.edit = { chord, field: { text: run, pos: run.length, mark: run ? 0 : null } }
		s.chosen = chord
		s.waiting = false
	}
	const act = (api, what) => {
		s.note = null
		if (what === "add") {
			s.edit = null
			s.from = null
			s.waiting = true
		} else if (what === "rekey" && s.chosen) {
			s.edit = null
			s.from = s.chosen
			s.waiting = true
		} else if (what === "edit" && s.chosen) edit(s.chosen)
		else if (what === "delete" && s.chosen) {
			const i = rows.findIndex((r) => r.chord === s.chosen)
			bind(api, s.chosen, null)
			rows = rows.filter((r) => r.chord !== s.chosen)
			s.chosen = rows[Math.min(i, rows.length - 1)]?.chord ?? null
		}
	}
	const done = (api, write) => {
		const e = s.edit
		s.edit = null
		if (!write || !e) return
		const run = e.field.text.trim()
		const had = rows.find((r) => r.chord === e.chord)
		if (!run && !had) return
		if (run === had?.run) return
		bind(api, e.chord, run || null)
		rows = listOf(val(api, KEYS))
		s.chosen = run ? e.chord : null
	}
	const move = (by) => {
		const i = rows.findIndex((r) => r.chord === s.chosen)
		const to = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + by))]
		if (to) s.chosen = to.chord
	}

	// --- the keyboard
	const MODS = ["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]
	handler(given, "key", ({ api, args: [recs] }) => {
		reveal = true
		for (const r of recs) {
			if (s.waiting) {
				if (!r.down || MODS.includes(r.key)) continue
				s.waiting = false
				const from = s.from
				s.from = null
				if (r.key === "Escape" && !r.mods?.length) continue
				if (from) {
					// the row's command, from its old chord to the new one
					const to = readline.chord(r), run = rows.find((x) => x.chord === from)?.run
					if (run && readline.normal(to) !== readline.normal(from)) {
						bind(api, to, run)
						bind(api, from, null)
						rows = listOf(val(api, KEYS))
						s.chosen = rows.find((x) =>
							readline.normal(x.chord) === readline.normal(to)
						)?.chord ?? to
						s.note = [`${run}: ${from} → ${to}`, C.dim]
					}
					continue
				}
				edit(readline.chord(r))
				continue
			}
			if (s.edit) {
				if (r.down && r.key === "Escape") done(api, false)
				else if (r.down && r.key === "Enter") done(api, true)
				else {
					const next = readline.type(s.edit.field, r, { select: true, api })
					if (next) s.edit.field = next
				}
				continue
			}
			if (!r.down) continue
			const cmd = r.mods?.includes("cmd")
			if (cmd && r.key === "n") act(api, "add")
			else if (r.key === "k" && (cmd || !r.mods?.length)) act(api, "rekey")
			else if (cmd && (r.key === "Backspace" || r.key === "Delete")) act(api, "delete")
			else if (cmd) continue
			else if (r.key === "Backspace" || r.key === "Delete") act(api, "delete")
			else if (r.key === "Enter") act(api, "edit")
			else if (r.key === "ArrowUp") move(-1)
			else if (r.key === "ArrowDown") move(1)
			else if (r.key === "Escape") s.chosen = null
		}
		paint(api)
	})

	// --- the pointer: a click on a row chooses it, two edit it; in the field, the caret goes there
	// a trackpad's scroll comes a few pixels a record: what is not yet a whole row is kept for the next
	let rest = 0
	handler(given, "pointer", ({ api, args: [recs] }) => {
		for (const r of recs) {
			if (r.event === "scroll") {
				rest += r.dy / ROW()
				const n = Math.trunc(rest)
				rest -= n
				s.scroll = Math.max(0, s.scroll + n)
				continue
			}
			if (r.event !== "down") continue
			const z = [...zones].reverse().find((z) =>
				r.x >= z.x && r.x < z.x + z.w && r.y >= z.y && r.y < z.y + z.h
			)
			s.waiting = false
			s.from = null
			if (z?.act === "row" && s.edit?.chord === z.chord && caret) {
				const c = caret.from + blit.at(caret.text.slice(caret.from), r.x - caret.b.x - 6 * u, F)
				s.edit.field = { ...s.edit.field, pos: c, mark: null }
				continue
			}
			if (s.edit) done(api, true)
			if (!z) continue
			if (z.act === "row") {
				const now = Date.now(), twice = s.click.chord === z.chord && now - s.click.t < 500
				s.chosen = z.chord
				s.click = { chord: z.chord, t: twice ? 0 : now }
				if (twice) edit(z.chord)
			} else if (z.act) act(api, z.act)
		}
		paint(api)
	})

	// --- following /etc/keys, the look, the size the window manager gives
	effect(given, "follow", ({ api }) => ({
		keys: val(api, KEYS) ?? null,
		theme: val(api, ["/", "etc", "theme"]) ?? null,
		fonts: fonts(api),
	}), ({ value: v, api }) => {
		rows = listOf(v.keys)
		if (s.chosen && !rows.some((r) => r.chord === s.chosen)) s.chosen = null
		if (v.theme) colours(v.theme)
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
	effect(given, "theirs", ({ api }) => val(api, VIEW) ?? null, ({ value: v, api }) => {
		const theirs = v && viewed
			? Object.keys(viewed).filter((k) => k in v && canon(v[k]) !== canon(viewed[k]))
			: []
		if (!theirs.length) return
		for (const k of theirs) [s[k], viewed[k]] = [v[k], JSON.parse(JSON.stringify(v[k]))]
		paint(api)
	})

	// the size the window manager gives: from /dev/display/windows, not its own layer, which changes each time it
	// draws or moves; so a window moving reads that and no more. The scheduler compares a map by identity but a
	// string by its text, so what is given is the text of the size: no new size, no run
	effect(
		given,
		"size",
		({ api }) =>
			JSON.stringify(val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want ?? null),
		({ value: text, api }) => {
			const want = JSON.parse(text)
			if (!want) return
			W = Math.max(360 * u, want.w)
			H = Math.max(200 * u, want.h)
			paint(api)
		},
	)

	return "keys"
}
