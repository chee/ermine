// /programs/erminex: a window onto one program shared over the link, as
// `erminex <channel or name> <cmd>` shares it from a terminal (the shell
// here; playground/term's erminex): the channel is the window's id, or the
// name it is shared under. It asks /drivers/link for the
// channel, by placing /dev/link/views/<its pid>, and draws the remote
// screen, /dev/link/windows/<its pid>/screen, a grid of rows, colour runs
// and a cursor, as text runs in the font ROM's cells. What is typed here
// goes to the remote program as the remote's keys: "enter", "up", "C-c", a
// character, or a paste as a list of them. data: {channel, layer?}: with a
// layer, a shell window's, it runs in that window, as a program run in a
// rio window does: it is the window's owner, so the keys come here, and it
// draws there; when it ends the shell has its window back.
import { blitter } from "ermine:draw"
import { data, drop, effect, handler, idAt, make, val } from "ermine:kit"
import { here } from "ermine:os"

export default (given) => {
	const { api, onCleanup, self, name } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const me = here(self)
	const place = me.slice(0, -1)
	const d = data(given) ?? {}
	// it asks /drivers/link: with no /dev/link/views (the driver not running), no window, said plainly
	if (!idAt(api, ["/", "dev", "link", "views"])) {
		console.log(
			"erminex: no /dev/link/views: the link driver is not running, so there is no channel to show",
		)
		drop(api, place, name, self)
		return
	}
	const blit = blitter(api)
	const font = blit.cell
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1024, h: 700 }
	const u = mode.unit ?? 1
	const PAD = 4 * u
	const CHANNEL = String(d.channel ?? "")
	const NAME = self
	const VIEW = ["/", "dev", "link", "views", NAME]
	const WINDOW = ["/", "dev", "link", "windows", NAME]
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, d.layer ?? `erminex-${self}`]
	const borrowed = !!d.layer
	const called = /^[0-9a-f]{64}$/i.test(CHANNEL) ? CHANNEL.slice(0, 8) : CHANNEL
	const set = (key, value) => ({ path: [key], value })

	make(api, VIEW.slice(0, -1), NAME, { channel: CHANNEL }, { ephemeral: true })
	const held = val(api, LAYER)
	let W = held?.w ?? 80 * font.w + 2 * PAD, H = held?.h ?? 24 * font.h + 2 * PAD
	if (borrowed && held) api.write(LAYER, [set("owner", me)])
	else if (!held) {
		const n = api.children(LAYERS).length
		const x = Math.max(0, Math.min(mode.w - W, (60 + (n % 6) * 36) * u))
		const y = Math.max(2 * font.h + 14 * u, Math.min(mode.h - H, (70 + (n % 6) * 30) * u))
		make(api, LAYERS, LAYER.at(-1), {
			x,
			y,
			w: W,
			h: H,
			z: n,
			title: `erminex ${called}`,
			owner: me,
			draw: [],
		}, { ephemeral: true })
	}
	// it ends: the link's view let go with it (the layer is its own, unless a shell's)
	const end = (api) => {
		drop(api, VIEW.slice(0, -1), NAME)
		if (!borrowed) drop(api, LAYERS, LAYER.at(-1))
		drop(api, place, name, self)
	}
	onCleanup(({ api }) => {
		drop(api, VIEW.slice(0, -1), NAME)
		if (!borrowed) drop(api, LAYERS, LAYER.at(-1))
	})

	// xterm's colours: the sixteen from /etc/theme, as the shell's are; the rest the cube and the greys
	let T = {}
	const theme = (t = {}) => {
		T = { acme: 0xffffea, ink: 0x2a2228, ink2: 0x6b5a66, ink3: 0xa89aa2, line: 0x1c1a17, ...t }
	}
	theme(val(api, ["/", "etc", "theme"]) ?? {})
	const xterm = (n) => {
		// black the darkest ink, as the shell's: the theme's line is a hairline
		const sixteen = [
			T.ink,
			T.cherry,
			T.mint,
			T.butter,
			T.sky,
			T.lilac,
			T.teal,
			T.ink2,
			T.ink3,
			T.rose,
			T.mint,
			T.peach,
			T.sky,
			T.lilac,
			T.teal,
			T.ink,
		]
		if (n < 16) return sixteen[n] ?? T.ink
		if (n < 232) {
			const c = n - 16, v = (k) => (k ? 55 + k * 40 : 0)
			return (v(Math.floor(c / 36)) << 16) | (v(Math.floor(c / 6) % 6) << 8) | v(c % 6)
		}
		const g = 8 + (n - 232) * 10
		return (g << 16) | (g << 8) | g
	}
	const colours = (st = {}) => {
		let fg = st.fg === undefined ? T.ink : xterm(st.fg),
			bg = st.bg === undefined ? null : xterm(st.bg)
		if (st.reverse) [fg, bg] = [bg ?? T.acme, fg]
		if (st.dim) fg = T.ink3
		return { fg, bg }
	}

	// what an input method is composing, shown at the cursor until it is typed
	let composing = ""
	const draw = (w, focused) => {
		const d = blit.list(W, H, T.acme)
		const g = w?.screen
		if (!g?.lines) {
			const say = w?.state === "gone"
				? `gone: ${w.why ?? "the link ended"}${borrowed ? ". A key gives the shell back" : ""}`
				: `dialing ${called}…${w?.why ? ` ${w.why}` : ""}`
			blit.text(d, PAD, PAD, say, w?.state === "gone" ? T.cherry : T.ink3)
			return d
		}
		const cur = g.cursor?.visible !== false && g.cursor ? g.cursor : null
		g.lines.forEach((text, r) => {
			const cells = [...(text ?? "")]
			const runs = g.styles?.[r] ?? []
			const style = (c) => {
				let st = {}
				for (const [col, s] of runs) if (col <= c) st = s
				return st
			}
			const cols = Math.max(
				cells.length,
				...runs.map(([col]) => col + 1),
				cur?.row === r ? cur.col + 1 : 0,
			)
			let c = 0
			while (c < cols) {
				const st = style(c),
					key = JSON.stringify(st),
					cursor = focused && cur?.row === r && cur.col === c
				let e = c + 1
				if (!cursor) {
					while (
						e < cols && JSON.stringify(style(e)) === key &&
						!(focused && cur?.row === r && cur.col === e)
					) e++
				}
				const s = cells.slice(c, e).map((ch) => ch ?? " ").join("").padEnd(e - c)
				const x = PAD + c * font.w, y = PAD + r * font.h
				const { fg, bg } = colours(st)
				if (cursor) blit.fill(d, x, y, font.w, font.h, T.ink)
				else if (bg !== null) blit.fill(d, x, y, (e - c) * font.w, font.h, bg)
				const shown = cursor ? s : s.replace(/ +$/, "")
				if (shown.trim() || cursor) blit.text(d, x, y, shown, cursor ? T.acme : fg)
				c = e
			}
		})
		if (cur && !focused) {
			blit.fill(
				d,
				PAD + cur.col * font.w,
				PAD + cur.row * font.h + font.h - 2 * u,
				font.w,
				2 * u,
				T.ink2,
			)
		}
		if (cur && composing) {
			const x = PAD + cur.col * font.w,
				y = PAD + cur.row * font.h,
				cw = [...composing].length * font.w
			blit.fill(d, x, y, cw, font.h, T.acme)
			blit.text(d, x, y, composing, T.ink)
			blit.fill(d, x, y + font.h - u, cw, u, T.ink)
		}
		return d
	}
	// what it says to the Mac: the cursor's row, for input methods; the screen, as a text area, for VoiceOver
	const meaning = (w) => {
		const g = w?.screen
		const rows = (g?.lines ?? []).map((l) => (l ?? "").replace(/ +$/, ""))
		const cur = g?.cursor ?? { row: 0, col: 0 }
		const row = rows[cur.row] ?? ""
		const col = Math.min(cur.col, row.length)
		const before = rows.slice(0, cur.row).reduce((n, l) => n + l.length + 1, 0)
		return {
			input: {
				text: row,
				selection: [col, col],
				caret: { x: PAD + cur.col * font.w, y: PAD + cur.row * font.h, w: font.w, h: font.h },
			},
			access: [{
				role: "textarea",
				label: `erminex ${called}${g?.title ? `: ${g.title}` : ""}`,
				value: rows.join("\n"),
				selection: [before + col, before + col],
				x: 0,
				y: 0,
				w: W,
				h: H,
			}],
		}
	}
	const paint = (api, w, focused) => {
		if (JSON.stringify(val(api, LAYER)?.owner) !== JSON.stringify(me)) return
		// a window of its own is the remote screen's size, in cells; a shell's keeps its size
		if (!borrowed && w?.screen?.cols && w?.screen?.rows) {
			W = w.screen.cols * font.w + 2 * PAD
			H = w.screen.rows * font.h + 2 * PAD
		}
		const state = w?.state === "mounted" ? "" : w?.state === "gone" ? "  (gone)" : "  (dialing)"
		const m = meaning(w)
		api.write(LAYER, [
			set("w", W),
			set("h", H),
			set("draw", draw(w, focused).ops),
			set("input", m.input),
			set("access", m.access),
			set("title", `erminex ${called}${w?.screen?.title ? ` — ${w.screen.title}` : ""}${state}`),
		])
	}

	const look = ({ api }) => {
		const v = val(api, WINDOW)
		return {
			window: v ? { ...v, screen: val(api, [...WINDOW, "screen"]) ?? null } : null,
			focused: val(api, ["/", "dev", "display", "focus"]) === LAYER.at(-1),
			theme: val(api, ["/", "etc", "theme"]) ?? null,
		}
	}
	let last = { window: null, focused: false }
	effect(given, "screen", look, ({ value: v, api }) => {
		if (v.theme) theme(v.theme)
		last = v
		paint(api, v.window, v.focused)
	})

	// keys, as the remote window's keys node takes them
	const NAMED = {
		Enter: "enter",
		Tab: "tab",
		Backspace: "backspace",
		Escape: "escape",
		ArrowUp: "up",
		ArrowDown: "down",
		ArrowLeft: "left",
		ArrowRight: "right",
		Home: "home",
		End: "end",
		PageUp: "pageup",
		PageDown: "pagedown",
		Delete: "delete",
	}
	const send = ({ api, call }, keys) => {
		const to = val(api, ["/", "dev", "link", "keys"])
		if (keys.length && Array.isArray(to)) call(to, [NAME, keys])
	}
	handler(given, "key", (g) => {
		const { api } = g, [recs] = g.args
		// the link gone, in a shell's window: a key gives the shell back
		if (borrowed && last.window?.state === "gone" && recs.some((r) => r.down)) return end(api)
		const keys = []
		for (const r of recs) {
			if (r.event === "compose") {
				composing = r.text ?? ""
				continue
			}
			if (r.event === "commit") {
				composing = ""
				// a press-and-hold accent replaces the letter held, just before the cursor: rubbed out first
				if (r.replace) {
					for (let i = r.replace[0]; i < r.replace[1]; i++) keys.push("backspace")
				}
				keys.push(...[...(r.text ?? "")])
				continue
			}
			if (!r.down) continue
			const mods = r.mods ?? []
			if (mods.includes("cmd")) {
				if (r.key === "v") {
					const t = val(api, ["/", "dev", "clip", "text"])?.text
					if (typeof t === "string" && t) {
						keys.push(
							[...t.replace(/\r\n?/g, "\n")].map((ch) => (ch === "\n" ? "enter" : ch)),
						)
					}
				}
				continue
			}
			if (mods.includes("ctrl") && /^[a-z@[\\\]^_]$/.test(r.key)) keys.push(`C-${r.key}`)
			else if (NAMED[r.key]) keys.push(NAMED[r.key])
			else if (r.text && [...r.text].every((ch) => ch >= " " && ch !== "\x7f")) {
				keys.push(...[...r.text])
			}
		}
		send(g, keys)
		paint(api, last.window, last.focused)
	})
}
