// /programs/term: a terminal window. places a layer and a line under its node (rx, stats, tx), and
// starts a shell on it as its child. keys from the wm become bytes on rx; tx is read by a small VT
// (\r \n \b \t, colours, clear, erase line) into vt beside them (ephemeral), drawn as text runs in
// the font ROM's cells: selectable, read aloud. a right click on a node's name opens it (acme's
// button 3). tells the Mac's input methods where its cursor is.
//
// data {line} (a session's, /dev/pty/1): shows that line, starts no shell; reads tx by stats.tx,
// never draining; typing appends to rx. while a session lists its line, it writes the session's
// size, {cols, rows}.
// a session's screen comes from the driver's libvterm (256 and true colour, bold, underline,
// reverse, cursor shape); keys go as key records. cmd-v pastes (bracketed if asked), cmd-left and
// cmd-right Home and End, cmd-Backspace C-u; the mouse when asked, else the wheel and shift-PageUp,
// shift-PageDown scroll back. a session ending leaves its screen in the small VT, the shell below.
import { blitter } from "ermine:draw"
import { data, effect, first, handler, idAt, make, put, val, whole } from "ermine:kit"
import { here, kill } from "ermine:os"
import * as views from "ermine:views"

export default (given) => {
	const { api, start, self, name } = given
	// this process's own node, from the root: a window's owner, whose on/key and on/pointer the window manager
	// calls; its effects are placed inside it, so they read it by this
	const ME = here(self)
	// a node of this process's, ephemeral: its value written, or the node made holding it
	const keeps = (api, address, value) =>
		idAt(api, address)
			? api.write(address, whole(value))
			: make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
	// its menus, in the menu bar while its window has the focus (/programs/wmii): an item with a key is that chord, pressed
	const menus = [
		{
			title: "Shell",
			items: [{ label: "New Shell", key: "alt-Enter" }, "-", { label: "Close", key: "cmd-w" }],
		},
		{ title: "Edit", items: [{ label: "Copy", key: "cmd-c" }, { label: "Paste", key: "cmd-v" }] },
	]
	keeps(api, [...ME, "menus"], menus)
	const blit = blitter(api)
	const font = blit.cell
	const desk = val(api, ["/", "etc", "desktop"]) ?? {}
	let COLS = desk.term?.cols ?? 80, ROWS = desk.term?.rows ?? 24
	// paper round the cells, as catclock's panes keep: even, and room from the window's rounded corners
	const PAD = 12 * (val(api, ["/", "dev", "display", "mode"])?.unit ?? 1)
	let W = COLS * font.w + 2 * PAD, H = ROWS * font.h + 2 * PAD
	// the line shown: one given, a session's, or its own, inside this node
	const asked = data(given)?.line
	const ATTACHED = Array.isArray(asked) && asked.length
		? ["/", ...asked.filter((n) => n !== "/")]
		: null
	const LN = ATTACHED ?? ME
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `term-${self}`]
	const set = (key, value) => ({ path: [key], value })
	/** a program started through the window manager's policy (/dev/wm/launch), so it outlives this run, or here */
	const launch = ({ api, start, call }, op) => {
		const at = val(api, ["/", "dev", "wm", "launch"])
		if (Array.isArray(at)) return call(at, [op])
		const pid = start({
			address: op.address,
			program: op.program,
			...(op.name ? { name: op.name } : {}),
		})
		if (op.data != null) put(api, pid, "data", op.data)
		return pid
	}

	// stats.screen: this window shows a session's screen, so the driver copies none of its output onto this tx
	for (
		const [n, value] of ATTACHED
			? []
			: [["rx", new Uint8Array(0)], ["stats", { rx: 0, screen: true }], [
				"tx",
				new Uint8Array(0),
			]]
	) {
		make(api, ME, n, value, { ephemeral: true })
	}
	if (!ATTACHED && val(api, [...ME, "stats"])?.screen !== true) {
		api.write([...ME, "stats"], [set("screen", true)])
	}
	const TITLE = ATTACHED ? `pty ${ATTACHED.at(-1)}` : "shell"

	// the window, cascaded from the others
	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1024, h: 700 }
		const u = mode.unit ?? 1
		const x = Math.max(0, Math.min(mode.w - W, (60 + (n % 6) * 36) * u))
		const y = Math.max(2 * font.h + 14 * u, Math.min(mode.h - H, (70 + (n % 6) * 30) * u))
		make(
			api,
			LAYERS,
			LAYER.at(-1),
			{ x, y, w: W, h: H, z: n, title: TITLE, owner: ME, draw: [] },
			{ ephemeral: true },
		)
	}
	if (!ATTACHED) {
		// the shell's node goes in this one, so it ends when this window does
		const pid = start({ address: ME, program: ["programs", "shell"], name: "shell" })
		put(api, pid, "data", { line: ME.slice(1) })
	}

	// --- a small VT
	// colours by name, from /etc/theme: its acme body, its ink, bold and black its darkest ink
	// (its line is a hairline now); a cell keeps the name, so a new theme recolours what is already there
	const FG = "fg"
	let BG = 0xffffea
	let PALETTE = {}
	const palette = (T) => {
		BG = T.acme ?? 0xffffea
		PALETTE = {
			fg: T.ink ?? 0x2a2228,
			1: T.ink ?? 0x1c1a17,
			2: T.ink2 ?? 0x6b5a66,
			30: T.ink,
			31: T.cherry,
			32: T.mint,
			33: T.butter,
			34: T.sky,
			35: T.lilac,
			36: T.teal,
			37: T.ink2,
			90: T.ink3,
			91: T.rose,
			92: T.mint,
			93: T.peach,
			94: T.sky,
			95: T.lilac,
			96: T.teal,
			97: T.ink,
		}
	}
	palette(val(api, ["/", "etc", "theme"]) ?? {})
	const COLOURS = {
		30: 1,
		31: 1,
		32: 1,
		33: 1,
		34: 1,
		35: 1,
		36: 1,
		37: 1,
		90: 1,
		91: 1,
		92: 1,
		93: 1,
		94: 1,
		95: 1,
		96: 1,
		97: 1,
	}
	const blank = () => Array.from({ length: COLS }, () => ({ ch: " ", fg: FG }))
	// seen: a session's stats.tx already shown, when the line is one given
	const vt = {
		grid: Array.from({ length: ROWS }, blank),
		row: 0,
		col: 0,
		fg: FG,
		state: "text",
		params: "",
		seen: null,
	}
	// what an input method is composing, shown at the cursor until it is typed
	let composing = ""
	// the screen is the node vt, inside this one: each row's text and its ink, a letter a cell, the cursor,
	// the colour in hand, the parser's state, the size, what is being composed. Replaced, this takes it up;
	// vt here is its copy, written back once a call. Only the decoder's half a character is not there, and
	// above, the rows gone off the top, newest last, which come back as the window grows
	const VT = [...ME, "vt"]
	let above = []
	const INK = {
		fg: " ",
		1: "1",
		2: "2",
		30: "a",
		31: "b",
		32: "c",
		33: "d",
		34: "e",
		35: "f",
		36: "g",
		37: "h",
		90: "i",
		91: "j",
		92: "k",
		93: "l",
		94: "m",
		95: "n",
		96: "o",
		97: "p",
	}
	const INKED = Object.fromEntries(
		Object.entries(INK).map(([k, v]) => [v, k === "fg" ? FG : Number(k)]),
	)
	const screen = () => ({
		text: vt.grid.map((line) => line.map((c) => c.ch).join("")),
		ink: vt.grid.map((line) => line.map((c) => INK[c.fg] ?? " ").join("")),
		row: vt.row,
		col: vt.col,
		fg: vt.fg,
		state: vt.state,
		params: vt.params,
		cols: COLS,
		rows: ROWS,
		composing,
		seen: vt.seen,
	})
	let kept = val(api, VT) ?? null
	if (kept?.text?.length) {
		COLS = kept.cols
		ROWS = kept.rows
		W = COLS * font.w + 2 * PAD
		H = ROWS * font.h + 2 * PAD
		vt.grid = kept.text.map((t, r) => {
			const ink = [...(kept.ink[r] ?? "")]
			const line = [...t].map((ch, c) => ({ ch, fg: INKED[ink[c]] ?? FG }))
			while (line.length < COLS) line.push({ ch: " ", fg: FG })
			return line
		})
		Object.assign(vt, {
			row: kept.row,
			col: kept.col,
			fg: kept.fg,
			state: kept.state,
			params: kept.params,
			seen: kept.seen ?? null,
		})
		composing = kept.composing ?? ""
	} else kept = null
	// what changed since it was last written: a splice for each row, a set for the rest
	const keep = (api) => {
		const now = screen()
		if (!kept || kept.text.length !== now.text.length) {
			keeps(api, VT, now)
			kept = now
			return
		}
		const patches = []
		for (const k of ["text", "ink"]) {
			now[k].forEach((t, r) =>
				t !== kept[k][r] && patches.push({ path: [k], range: [r, r + 1], value: [t] })
			)
		}
		for (
			const k of ["row", "col", "fg", "state", "params", "cols", "rows", "composing", "seen"]
		) if (now[k] !== kept[k]) patches.push(set(k, now[k]))
		if (patches.length) api.write(VT, patches)
		kept = now
	}
	const decoder = new TextDecoder()
	const newline = () => {
		vt.row++
		if (vt.row >= ROWS) {
			above.push(vt.grid.shift())
			if (above.length > 500) above.shift()
			vt.grid.push(blank())
			vt.row = ROWS - 1
		}
	}
	const sgr = (params) => {
		for (const p of (params || "0").split(";").map(Number)) {
			if (p === 0) vt.fg = FG
			else if (p === 1 || p === 2 || COLOURS[p]) vt.fg = p
		}
	}
	const feed = (text) => {
		for (const ch of text) {
			if (vt.state === "esc") {
				vt.state = ch === "[" ? "csi" : "text"
				vt.params = ""
				continue
			}
			if (vt.state === "csi") {
				if (/[0-9;?]/.test(ch)) {
					vt.params += ch
					continue
				}
				vt.state = "text"
				if (ch === "m") sgr(vt.params)
				else if (ch === "J") {
					vt.grid = Array.from({ length: ROWS }, blank)
					above = []
					vt.row = 0
					vt.col = 0
				} else if (ch === "H") {
					vt.row = 0
					vt.col = 0
				} else if (ch === "K") {
					for (let c = vt.col; c < vt.grid[vt.row].length; c++) {
						vt.grid[vt.row][c] = { ch: " ", fg: FG }
					}
				}
				continue
			}
			if (ch === "\x1b") vt.state = "esc"
			else if (ch === "\r") vt.col = 0
			else if (ch === "\n") newline()
			else if (ch === "\b") vt.col = Math.max(0, vt.col - 1)
			else if (ch === "\t") vt.col = Math.min(COLS - 1, (vt.col + 8) & ~7)
			else if (ch >= " ") {
				if (vt.col >= COLS) {
					newline()
					vt.col = 0
				}
				vt.grid[vt.row][vt.col++] = { ch, fg: vt.fg }
			}
		}
	}

	// --- a session's screen (drivers/pty): {rows, cols, lines, styles, cursor, alt, mouse, ...}, libvterm's
	// the session shown, its base address, or null; its screen as last read; its scrollback, read while scrolled back
	let session = null
	let shown = null
	let back = null
	let scroll = 0 // rows scrolled back, 0 at the bottom
	let rest = 0 // the wheel's part of a row
	// xterm's 256: the first 16 the theme's, then the 6x6x6 cube and the greys
	const LEVEL = [0, 95, 135, 175, 215, 255]
	const xterm = (n) => {
		if (n < 8) return PALETTE[30 + n] ?? PALETTE.fg
		if (n < 16) return PALETTE[90 + n - 8] ?? PALETTE.fg
		if (n < 232) {
			return (LEVEL[Math.floor((n - 16) / 36)] << 16) |
				(LEVEL[Math.floor((n - 16) / 6) % 6] << 8) | LEVEL[(n - 16) % 6]
		}
		const g = 8 + 10 * (n - 232)
		return (g << 16) | (g << 8) | g
	}
	const fgOf = (st) => st.rgb?.fg ?? (st.fg !== undefined ? xterm(st.fg) : PALETTE.fg)
	const bgOf = (st) => st.rgb?.bg ?? (st.bg !== undefined ? xterm(st.bg) : null)
	// two cells: East Asian wide letters and emoji, as libvterm counts them, near enough
	const wide = (cp) =>
		(cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
	// a row as cells: each letter and its column
	const cellsOf = (line) => {
		const out = []
		let c = 0
		for (const ch of line ?? "") {
			out.push({ ch, c })
			c += wide(ch.codePointAt(0)) ? 2 : 1
		}
		return out
	}
	// the rows shown: the screen's, or, scrolled back, the scrollback's last rows above it
	const viewRows = () => {
		const lines = shown?.lines ?? [], styles = shown?.styles ?? []
		if (!scroll || !back) return { lines, styles }
		const from = back.lines.length - scroll
		return {
			lines: [...back.lines.slice(from), ...lines].slice(0, ROWS),
			styles: [...back.styles.slice(from), ...styles].slice(0, ROWS),
		}
	}
	// a row's stretches of one style: [from, to, style], columns, to the grid's edge
	const stretches = (runs) => {
		const out = []
		let at = 0, st = {}
		for (const [c, next] of runs ?? []) {
			if (c > at) out.push([at, Math.min(c, COLS), st])
			at = Math.max(at, c)
			st = next
		}
		if (at < COLS) out.push([at, COLS, st])
		return out
	}
	// each row's draw ops, kept while its text and runs are the same: a burst changes few rows a frame
	let drawn = []
	const drawScreen = (focused, u) => {
		const d = blit.list(W, H, BG)
		const { lines, styles } = viewRows()
		const flip = !!shown?.reverse
		for (let r = 0; r < Math.min(ROWS, lines.length); r++) {
			const key = `${flip}${COLS}${BG}${PALETTE.fg}${PALETTE[31]}${PALETTE[34]}\0${lines[r]}\0${
				JSON.stringify(styles[r] ?? [])
			}`
			if (drawn[r]?.key === key) {
				for (const op of drawn[r].ops) d.ops.push(op)
				continue
			}
			const at = d.ops.length
			const cells = cellsOf(lines[r]), y = PAD + r * font.h
			for (const [from, to, st] of stretches(styles[r])) {
				let fg = fgOf(st), bg = bgOf(st)
				if (!!st.reverse !== flip) [fg, bg] = [bg ?? BG, fg]
				const x = PAD + from * font.w, w = (to - from) * font.w
				const part = cells.filter((p) => p.c >= from && p.c < to)
				// a background to the end of the stretch; text as far as it goes
				if (bg !== null) blit.fill(d, x, y, w, font.h, bg)
				const str = part.map((p) => p.ch).join("")
				if (!st.conceal && str.trim()) {
					// a wide letter takes two cells: then each is drawn at its own column
					if (part.some((p, n) => n && p.c !== part[n - 1].c + 1)) {
						for (const p of part) blit.text(d, PAD + p.c * font.w, y, p.ch, fg)
					} else blit.text(d, x, y, str.replace(/ +$/, ""), fg)
					if (st.bold) blit.text(d, x + u, y, str.replace(/ +$/, ""), fg)
				}
				const tw = part.length ? (part.at(-1).c + 1 - from) * font.w : 0
				if (st.underline && tw) blit.fill(d, x, y + font.h - u, tw, u, fg)
				if (st.strike && tw) blit.fill(d, x, y + (font.h >> 1), tw, u, fg)
			}
			drawn[r] = { key, ops: d.ops.slice(at) }
		}
		drawn.length = Math.min(ROWS, lines.length)
		// the cursor: as the program shaped it; an underline when another window has the keys
		const cur = shown?.cursor ?? {}
		if (scroll === 0 && cur.visible !== false) {
			const row = cur.row ?? 0, col = Math.min(cur.col ?? 0, COLS - 1)
			const x = PAD + col * font.w, y = PAD + row * font.h
			const under = cellsOf(lines[row]).find((p) => p.c === col)?.ch ?? " "
			if (!focused) blit.fill(d, x, y + font.h - 2 * u, font.w, 2 * u, PALETTE[2])
			else if (cur.shape === "underline") {
				blit.fill(d, x, y + font.h - 2 * u, font.w, 2 * u, PALETTE.fg)
			} else if (cur.shape === "bar") blit.fill(d, x, y, 2 * u, font.h, PALETTE.fg)
			else {
				blit.fill(d, x, y, font.w, font.h, PALETTE.fg)
				if (under.trim()) blit.text(d, x, y, under, BG)
			}
		}
		// an input method's text in progress, over the cells from the cursor, underlined
		if (composing) {
			const x = PAD + (cur.col ?? 0) * font.w,
				y = PAD + (cur.row ?? 0) * font.h,
				w = [...composing].length * font.w
			blit.fill(d, x, y, w, font.h, BG)
			blit.text(d, x, y, composing, PALETTE.fg)
			blit.fill(d, x, y + font.h - u, w, u, PALETTE.fg)
		}
		return d
	}
	// what the session's screen showed, into the small VT: it stays, and the shell goes on below it
	const INKS = {
		0: 30,
		1: 31,
		2: 32,
		3: 33,
		4: 34,
		5: 35,
		6: 36,
		7: 37,
		8: 90,
		9: 91,
		10: 92,
		11: 93,
		12: 94,
		13: 95,
		14: 96,
		15: 97,
	}
	const adopt = (sc) => {
		vt.grid = Array.from({ length: ROWS }, (_, r) => {
			const line = blank()
			for (const [from, to, st] of stretches(sc.styles?.[r])) {
				for (const p of cellsOf(sc.lines?.[r])) {
					if (p.c >= from && p.c < to) {
						line[p.c] = { ch: p.ch, fg: INKS[st.fg] ?? (st.bold ? 1 : FG) }
					}
				}
			}
			return line
		})
		vt.row = Math.min(ROWS - 1, sc.cursor?.row ?? 0)
		vt.col = Math.min(COLS, sc.cursor?.col ?? 0)
		Object.assign(vt, { fg: FG, state: "text", params: "" })
	}
	// key records to the session's keys, counted in its stats.keys, as bytes are on rx and in stats.rx
	const typeTo = (api, base, recs) => {
		if (!recs.length) return
		const old = val(api, [...base, "keys"]) ?? []
		api.write([...base, "keys"], whole([...old, ...recs].slice(-64)))
		const stats = val(api, [...base, "stats"]) ?? {}
		api.write([...base, "stats"], [set("keys", (stats.keys ?? 0) + recs.length)])
	}
	const scrollTo = (api, n) => {
		back = n > 0 ? val(api, [...session, "scrollback"]) ?? null : null
		scroll = Math.max(0, Math.min(back?.lines?.length ?? 0, n))
	}

	const text = (row) => vt.grid[row].slice(0, COLS).map((c) => c.ch).join("")
	const draw = (focused, u) => {
		if (session) return drawScreen(focused, u)
		const d = blit.list(W, H, BG)
		const cc = Math.min(vt.col, COLS - 1)
		for (let r = 0; r < ROWS; r++) {
			// a run for each stretch of one colour; the cell under the cursor a run of its own
			let c = 0
			while (c < COLS) {
				const fg = vt.grid[r][c].fg, cursor = focused && r === vt.row && c === cc
				let e = c + 1
				if (!cursor) {
					while (
						e < COLS && vt.grid[r][e].fg === fg && !(focused && r === vt.row && e === cc)
					) e++
				}
				const s = vt.grid[r].slice(c, e).map((x) => x.ch).join("")
				const shown = cursor ? s : s.replace(/ +$/, "")
				const x = PAD + c * font.w, y = PAD + r * font.h
				if (cursor) blit.fill(d, x, y, font.w, font.h, PALETTE.fg)
				if (shown.trim() || cursor) {
					blit.text(d, x, y, shown, cursor ? BG : PALETTE[fg] ?? PALETTE.fg)
				}
				c = e
			}
		}
		const cx = PAD + cc * font.w, cy = PAD + vt.row * font.h
		// an underline when another window has the keys
		if (!focused) blit.fill(d, cx, cy + font.h - 2 * u, font.w, 2 * u, PALETTE[2])
		// an input method's text in progress, over the cells from the cursor, underlined
		if (composing) {
			const w = [...composing].length * font.w
			blit.fill(d, cx, cy, w, font.h, BG)
			blit.text(d, cx, cy, composing, PALETTE.fg)
			blit.fill(d, cx, cy + font.h - u, w, u, PALETTE.fg)
		}
		return d
	}
	// what it says to the Mac: the row being typed on, the cursor in it, and the whole screen as a text area
	const meaning = () => {
		const at = session
			? { row: shown?.cursor?.row ?? 0, col: shown?.cursor?.col ?? 0 }
			: { row: vt.row, col: vt.col }
		const rows = session
			? Array.from({ length: ROWS }, (_, r) => (viewRows().lines[r] ?? "").replace(/ +$/, ""))
			: vt.grid.map((_, r) => text(r).replace(/ +$/, ""))
		const before = rows.slice(0, at.row).reduce((n, l) => n + l.length + 1, 0)
		const col = Math.min(at.col, (rows[at.row] ?? "").length)
		return {
			input: {
				text: rows[at.row] ?? "",
				selection: [col, col],
				caret: { x: PAD + at.col * font.w, y: PAD + at.row * font.h, w: font.w, h: font.h },
			},
			access: [{
				role: "textarea",
				label: "shell",
				value: rows.join("\n"),
				selection: [before + col, before + col],
				x: 0,
				y: 0,
				w: W,
				h: H,
			}],
		}
	}
	const paint = (api, focused) => {
		// while a program run in it has the window, it draws there, not this (as /dev/display/windows says: not its
		// own layer, which this writes each time it draws; not there yet, a window just placed, its own)
		const owner = val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.owner
		if (owner && JSON.stringify(owner) !== JSON.stringify(ME)) return
		const u = val(api, ["/", "dev", "display", "mode"])?.unit ?? 1
		const m = meaning()
		// a program that asks for the mouse gets every move while a button is down, as an editor's drags do
		const drags = !!session && (shown?.mouse ?? "none") !== "none"
		const title = session && shown?.title ? `${TITLE}: ${shown.title}` : TITLE
		api.write(LAYER, [
			set("w", W),
			set("h", H),
			set("draw", draw(focused, u).ops),
			set("input", m.input),
			set("access", m.access),
			set("title", title),
			set("drags", drags),
		])
	}
	let focusedNow = false

	// a program run in this window (erminex) has it, as its owner, until it ends: then the shell has it back
	effect(given, "owner", ({ api }) => {
		const owner = val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.owner ?? null
		const mine = JSON.stringify(owner) === JSON.stringify(ME)
		return { owner, mine, alive: !!owner && !mine && Array.isArray(owner) && !!idAt(api, owner) }
	}, ({ value: { owner, mine, alive }, api }) => {
		if (!owner || mine || alive || !idAt(api, LAYER)) return
		api.write(LAYER, [set("owner", ME)])
		paint(api, focusedNow)
		// deep: the window's node changes as it moves, the same owner made again is no new value
	}, { deep: true })

	// when its shell ends, by exit, this window ends too; showing a session, when the session goes
	effect(
		given,
		"watch",
		({ api }) => ATTACHED ? !!idAt(api, ATTACHED) : api.children(ME, "shell").length > 0,
		({ value: alive }) => {
			if (alive) return
			kill(self)
		},
	)

	// keys, from the window manager: bytes on rx
	const KEYS = {
		Enter: "\r",
		Backspace: "\x7f",
		Tab: "\t",
		Escape: "\x1b",
		ArrowUp: "\x1b[A",
		ArrowDown: "\x1b[B",
		ArrowRight: "\x1b[C",
		ArrowLeft: "\x1b[D",
		Delete: "\x1b[3~",
		Home: "\x1b[H",
		End: "\x1b[F",
	}
	const ALT = { ArrowLeft: "\x1b[1;3D", ArrowRight: "\x1b[1;3C", Backspace: "\x1b\x7f" }
	// control and an arrow, by words too; cmd and one, the line's ends, as a Mac's text does
	const CTRL = { ArrowLeft: "\x1b[1;5D", ArrowRight: "\x1b[1;5C" }
	const CMD = { ArrowLeft: "\x1b[H", ArrowRight: "\x1b[F", Backspace: "\x15" }
	// shown a session: key records to its keys, for the driver's keyboard
	const MODS = ["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]
	const sessionKeys = (api, recs) => {
		const out = [], was = composing, scrolled = scroll
		for (const r of recs) {
			if (r.event === "compose") {
				composing = r.text ?? ""
				continue
			}
			if (r.event === "commit") {
				for (let n = r.replace ? r.replace[1] - r.replace[0] : 0; n > 0; n--) {
					out.push({ key: "Backspace" })
				}
				composing = ""
				if (r.text) out.push({ text: r.text })
				continue
			}
			if (!r.down || MODS.includes(r.key)) continue
			const mods = (r.mods ?? []).filter((m) => m === "shift" || m === "ctrl" || m === "alt")
			if (r.mods?.includes("cmd")) {
				if (r.key === "v") {
					out.push({ paste: val(api, ["/", "dev", "clip", "text"])?.text ?? "" })
				} else if (r.key === "ArrowLeft") out.push({ key: "Home" })
				else if (r.key === "ArrowRight") out.push({ key: "End" })
				else if (r.key === "Backspace") out.push({ key: "u", mods: ["ctrl"] })
				continue
			}
			// option and an arrow, by words, as the Mac's terminals send it (escape b, escape f), which readline,
			// zsh and emacs all take
			if (
				mods.length === 1 && mods[0] === "alt" &&
				(r.key === "ArrowLeft" || r.key === "ArrowRight")
			) {
				out.push({ key: r.key === "ArrowLeft" ? "b" : "f", mods })
				continue
			}
			// shift and a page key go back through the scrollback, on the main screen
			if (
				mods.length === 1 && mods[0] === "shift" &&
				(r.key === "PageUp" || r.key === "PageDown") && !shown?.alt
			) {
				scrollTo(api, scroll + (r.key === "PageUp" ? 1 : -1) * Math.max(1, ROWS - 1))
				continue
			}
			out.push({
				key: r.key,
				...(mods.length ? { mods } : {}),
				...(r.text && !/[\uf700-\uf8ff]/.test(r.text) ? { text: r.text } : {}),
			})
		}
		// drawn again now only for what shows here at once (a composition, the scrollback); the rest comes back on
		// the screen
		const again = composing !== was || (scroll && out.length)
		if (out.length) scroll = 0
		typeTo(api, session, out)
		if (again || scroll !== scrolled) paint(api, focusedNow)
		if (composing !== was) keep(api)
	}
	handler(given, "key", ({ api, args: [recs] }) => {
		if (session) return sessionKeys(api, recs)
		let text = ""
		for (const r of recs) {
			if (r.event === "compose") {
				composing = r.text ?? ""
				paint(api, focusedNow)
				keep(api)
				continue
			}
			if (r.event === "commit") {
				// a press-and-hold accent replaces the letter held, just before the cursor: rubbed out first
				if (r.replace) text += "\x7f".repeat(Math.max(0, r.replace[1] - r.replace[0]))
				composing = ""
				text += r.text ?? ""
				continue
			}
			if (!r.down) continue
			if (r.mods?.includes("cmd")) {
				if (r.key === "v") text += val(api, ["/", "dev", "clip", "text"])?.text ?? ""
				else if (CMD[r.key]) text += CMD[r.key]
				continue
			}
			// option is meta, as readline takes it: with an arrow or backspace it goes by words, and with any
			// other key that reaches here (the window manager keeps option with its own) it is escape then the key
			const alt = r.mods?.includes("alt") && !r.mods?.includes("ctrl")
			if (alt && ALT[r.key]) text += ALT[r.key]
			else if (r.mods?.includes("ctrl") && CTRL[r.key]) text += CTRL[r.key]
			else if (alt && r.key?.length === 1) {
				text += "\x1b" + (r.mods.includes("shift") ? r.key.toUpperCase() : r.key)
			} else if (KEYS[r.key]) text += KEYS[r.key]
			else if (r.text && !/[-]/.test(r.text)) text += r.text
		}
		if (!text) return paint(api, focusedNow)
		const bytes = new TextEncoder().encode(text)
		const old = new Uint8Array(val(api, [...LN, "rx"]) ?? new Uint8Array(0))
		const all = new Uint8Array(old.length + bytes.length)
		all.set(old)
		all.set(bytes, old.length)
		api.write([...LN, "rx"], whole(all.slice(-4096)))
		// rx counted, and nothing else of stats touched: a session's says tx too
		const stats = val(api, [...LN, "stats"]) ?? { rx: 0 }
		api.write([...LN, "stats"], [set("rx", (stats.rx ?? 0) + bytes.length)])
	})

	// the pointer, shown a session: the program's, if it asked for the mouse (xterm's buttons: 1 left, 2 middle,
	// 3 right); else the wheel goes back through the scrollback
	const BUTTONS = { 0: 1, 1: 3, 2: 2 }
	let held = false
	// the small VT's: a right click on a word that names a node opens it, as acme's button 3 does, a picture
	// in Paint, else in the graph browser, as graph's e does; a name is from where the shell is (its line)
	const V = views.make(blit, { colours: {} })
	const look = (g, row, col) => {
		const { api } = g
		const line = text(row), part = (ch) => !!ch && !/[\s"'`,;()[\]{}<>]/.test(ch)
		if (!part(line[col])) return
		let a = col, b = col + 1
		while (part(line[a - 1])) a--
		while (part(line[b])) b++
		const word = line.slice(a, b).replace(/[:.]+$/, "")
		const sh = val(api, [...ME, "shell", "line"]) ?? {}
		const path = word.startsWith("/") ? [] : [...(sh.cwd ?? [])]
		for (const n of word.split("/")) {
			if (n === "..") path.pop()
			else if (n && n !== ".") path.push(n)
		}
		const at = [...(sh.root ?? []), ...path]
		let item
		try {
			item = api.content(["/", ...at]).find((i) => i.versions)
		} catch {
			return
		}
		if (!item) return
		launch(
			g,
			V.kind(first(item.versions)) === "picture"
				? {
					address: ["/", "apps", "paint"],
					program: ["programs", "paint"],
					data: { path: at },
				}
				: {
					address: ["/", "apps", "graph"],
					program: ["programs", "graph"],
					data: { path: at },
				},
		)
	}
	handler(given, "pointer", (g) => {
		const { api, args: [recs] } = g
		if (!session) {
			for (const r of recs) {
				if (r.event === "down" && r.button === 1) {
					look(
						g,
						Math.max(0, Math.min(ROWS - 1, Math.floor((r.y - PAD) / font.h))),
						Math.floor((r.x - PAD) / font.w),
					)
				}
			}
			return
		}
		const mouse = shown?.mouse ?? "none"
		const out = []
		for (const r of recs) {
			const row = Math.max(0, Math.min(ROWS - 1, Math.floor((r.y - PAD) / font.h))),
				col = Math.max(0, Math.min(COLS - 1, Math.floor((r.x - PAD) / font.w)))
			const mods = (r.mods ?? []).filter((m) => m === "shift" || m === "ctrl" || m === "alt")
			if (r.event === "scroll") {
				rest += (r.dy ?? 0) / font.h
				const n = Math.trunc(rest)
				rest -= n
				if (!n) continue
				if (mouse !== "none") {
					for (let k = 0; k < Math.abs(n); k++) {
						out.push({ mouse: "wheel", dy: Math.sign(n), row, col })
					}
				} else if (!shown?.alt) scrollTo(api, scroll - n)
			} else if (mouse === "none") continue
			else if (r.event === "down" || r.event === "up") {
				held = r.event === "down"
				out.push({
					mouse: r.event,
					button: BUTTONS[r.button] ?? 1,
					row,
					col,
					...(mods.length ? { mods } : {}),
				})
			} else if (r.event === "move" && held && mouse !== "click") {
				out.push({ mouse: "move", row, col })
			}
		}
		typeTo(api, session, out)
		paint(api, focusedNow)
	})

	// the sessions whose to lists a line this shows (/dev/pty/<n>; one made elsewhere says where, {at}), and the
	// one given: each told the grid's size, as a terminal's resize does
	const LINED = [JSON.stringify(ME), ...(ATTACHED ? [JSON.stringify(ATTACHED)] : [])]
	let redirected = []
	const sized = (api, bases) => {
		for (const base of bases) {
			const size = val(api, [...base, "size"])
			if (size && (size.cols !== COLS || size.rows !== ROWS)) {
				api.write([...base, "size"], whole({ cols: COLS, rows: ROWS }))
			}
		}
	}
	// the size the window manager gives, as want: the grid grows or shrinks to it. The scheduler compares a map by
	// identity but a string by its text, so what is given is the text of the size: no new size, no run
	effect(
		given,
		"size",
		({ api }) =>
			JSON.stringify(val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want ?? null),
		({ value: text, api }) => {
			const want = JSON.parse(text)
			if (!want) return
			const cols = Math.max(10, Math.floor((want.w - 2 * PAD) / font.w)),
				rows = Math.max(3, Math.floor((want.h - 2 * PAD) / font.h))
			// a row keeps what is past the edge, only drawn to it, so it shows again as the window grows
			for (const line of vt.grid) while (line.length < cols) line.push({ ch: " ", fg: FG })
			while (vt.grid.length > rows) {
				// the blank rows under the cursor go first; then the top, as a terminal scrolls
				const last = vt.grid.at(-1)
				if (vt.grid.length - 1 > vt.row && last.every((c) => c.ch === " ")) vt.grid.pop()
				else if (vt.row > 0) {
					above.push(vt.grid.shift())
					vt.row--
				} else vt.grid.pop()
			}
			while (vt.grid.length < rows && above.length) {
				const line = above.pop()
				while (line.length < cols) line.push({ ch: " ", fg: FG })
				vt.grid.unshift(line)
				vt.row++
			}
			while (vt.grid.length < rows) {
				vt.grid.push(
					Array.from({ length: cols }, () => ({ ch: " ", fg: FG })),
				)
			}
			COLS = cols
			ROWS = rows
			W = want.w
			H = want.h
			vt.col = Math.min(vt.col, COLS)
			// drawn at its new size now, whichever of this and the screen's effect ran first
			paint(api, focusedNow)
			keep(api)
			sized(api, redirected)
		},
	)

	const PTY = ["/", "dev", "pty"]
	effect(given, "pty", ({ api }) =>
		api.children(PTY).flatMap((n) => {
			if (n === "driver" || !api.children(PTY, n).length) return []
			const at = val(api, ["/", "dev", "pty", n])?.at
			const base = Array.isArray(at) ? at : ["/", "dev", "pty", n]
			const to = val(api, [...base, "to"])
			const shown = LINED.includes(JSON.stringify(base)) ||
				(Array.isArray(to) && to.some((l) => LINED.includes(JSON.stringify(l))))
			return shown ? [base] : []
		}), ({ value: bases, api }) => {
		redirected = bases
		sized(api, bases)
	})

	// the session shown: the one given, else the newest whose to lists this window's line
	const showing = (api) => {
		if (ATTACHED) return idAt(api, [...ATTACHED, "screen"]) ? ATTACHED : null
		const found = api.children(PTY).flatMap((n) => {
			if (n === "driver" || !api.children(PTY, n).length) return []
			const at = val(api, ["/", "dev", "pty", n])?.at
			const base = Array.isArray(at) ? at : ["/", "dev", "pty", n]
			const to = val(api, [...base, "to"])
			return Array.isArray(to) && to.some((l) => JSON.stringify(l) === JSON.stringify(ME))
				? [base]
				: []
		})
		return found.at(-1) ?? null
	}

	// what the shell sent: into the VT, off tx, onto the screen; or a session's screen. Not the window's
	// node, which changes as it moves: its size is size's, which draws it again
	effect(given, "screen", ({ api }) => {
		const base = showing(api)
		return {
			base,
			shown: base ? val(api, [...base, "screen"]) ?? null : null,
			theme: val(api, ["/", "etc", "theme"]) ?? null,
			// a session's tx (given one) is not read while its screen is: it changes each turn
			tx: ATTACHED && base ? new Uint8Array(0) : val(api, [...LN, "tx"]) ?? new Uint8Array(0),
			total: ATTACHED && !base ? val(api, [...LN, "stats"])?.tx ?? 0 : null,
			focused: val(api, ["/", "dev", "display", "focus"]) === LAYER.at(-1),
		}
	}, ({ value: { base, shown: now, tx, total, focused, theme }, api }) => {
		if (theme) palette(theme)
		let bytes = new Uint8Array(tx)
		const was = session
		session = base
		if (base) {
			// a session's: its screen. This line's tx has only what the shell says meanwhile (stats.screen)
			shown = now
			if (scroll) scrollTo(api, scroll)
			if (!ATTACHED && bytes.length) {
				feed(decoder.decode(bytes, { stream: true }))
				api.write([...ME, "tx"], whole(new Uint8Array(0)))
			}
			if (focused !== focusedNow && shown?.focus) typeTo(api, base, [{ focus: focused }])
			focusedNow = focused
			paint(api, focused)
			keep(api)
			return
		}
		if (was && shown && !ATTACHED) {
			// it ended: what its screen showed stays, and what the shell says now goes on below it
			adopt(val(api, [...was, "screen"]) ?? shown)
			shown = null
			scroll = 0
			back = null
		}
		if (ATTACHED) {
			// a session's tx is the driver's: the last (stats.tx - seen) of it, all it holds at first
			const n = vt.seen === null
				? bytes.length
				: Math.min(bytes.length, Math.max(0, total - vt.seen))
			vt.seen = total
			bytes = bytes.slice(bytes.length - n)
			if (bytes.length) feed(decoder.decode(bytes, { stream: true }))
		} else if (bytes.length) {
			feed(decoder.decode(bytes, { stream: true }))
			api.write([...ME, "tx"], whole(new Uint8Array(0)))
		}
		focusedNow = focused
		paint(api, focused)
		keep(api)
	})

	return "term"
}
