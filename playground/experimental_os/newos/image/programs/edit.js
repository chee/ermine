// /programs/edit: a text editor for any node. a string, or the key /etc/views shows for a value's
// kind (a program's source), as text; any other value as JSON. cmd-s writes it as you, through
// protect, saying if refused. a program: cmd-r replaces it in the windows running it
// (/stack/on/replace). the node changed while editing: it says so; untouched, it follows.
// cmd-d runs the cursor's line as JavaScript with core's api in scope (api.content, api.write, …),
// as you; cmd-p runs it and prints the result below.
//
// C programs (info ermine.program.provisions needs c): C mode (CLOADER.md, The editor). Tab types a
// tab; Program menu: Run (cmd-r: save and start; Run Again restarts its code), Stop (cmd-.), Next
// Error (cmd-'). a two-row strip says how it compiled and how its process is, handlers as buttons;
// an error is a cherry dot at its line. its process: one in the program's folder whose load runs
// it, started through the wm's launch as "<name> running", so it outlives the editor.
//
// keys: arrows, Home, End, PageUp, PageDown (shift selects); Enter keeps the indent; Tab: 2 spaces;
// cmd-s cmd-r cmd-z cmd-a cmd-c cmd-x cmd-v (the Mac's clipboard). click puts the cursor, drag
// selects, the wheel scrolls. draws as text runs, takes the Mac's input methods, a text area to
// VoiceOver.
//
// drafts: /apps/edit/drafts/<the path's names joined by ":">: lines, base change, undo, cursor.
// typing fronts the draft, written after REST ms at rest and at close; saved, the draft goes.
// cursor, selection, scroll, status, saved undo: <its node>/view.
import { data, drop, effect, front, handler, idAt, isStatus, make, val, whole } from "ermine:kit"
import { after, here, kill } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as readline from "ermine:readline"
import * as program from "ermine:program"

export default (given) => {
	const { api, onCleanup, self, name } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const me = here(self)
	const cwd = me.slice(0, -1)
	// the value written whole at address, or made there (ephemeral) if nothing is
	const store = (api, address, value) => {
		if (idAt(api, address)) api.write(address, whole(value))
		else make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
	}
	// the value at address, its change's time and the id of its node: the first item with versions, its first not a status
	const read = (api, address) => {
		const item = api.content(address).find((i) => i.versions?.length)
		const v = item?.versions.find((x) => !isStatus(x))
		return item && v ? { value: v.content, time: v.change?.time ?? null, node: item.id } : null
	}
	// what a refusal or a failure says
	const why = (e) => `${e?.code ?? e?.name ?? "error"}: ${e?.message ?? e}`
	// its menus, in the menu bar while its window has the focus (/programs/wmii): an item with a key is that chord,
	// pressed. Written as the editor changes: Save while there is something to save, Replace in the windows running
	// the code saved over, Undo, Cut and Copy while there is one
	let menued = null, running = 0
	// C mode's program, as the strip shows it: its processes, the last compile it finished and its diagnostics, since when
	// one is compiling (ms), whether Stop ended it (and the pids it ended), when Run last launched one
	let cmode = false
	const prog = {
		procs: [],
		load: null,
		diags: [],
		since: 0,
		stopped: false,
		killed: new Set(),
		launched: 0,
	}
	const menus = (api) => {
		const off = (no) => (no ? { off: true } : {}), sel = !!selection()
		const edits = {
			title: "Edit",
			items: [
				{ label: "Undo", key: "cmd-z", ...off(!s.undo.length) },
				"-",
				{ label: "Cut", key: "cmd-x", ...off(!sel) },
				{ label: "Copy", key: "cmd-c", ...off(!sel) },
				{ label: "Paste", key: "cmd-v" },
				"-",
				{ label: "Select All", key: "cmd-a" },
			],
		}
		// C mode: Program in place of Do, as THINK C's Project menu
		const live = prog.procs.length > 0
		const value = cmode
			? [
				{
					title: "File",
					items: [{ label: "Save", key: "cmd-s", ...off(!s.modified) }, "-", {
						label: "Close",
						key: "cmd-w",
					}],
				},
				edits,
				{
					title: "Program",
					items: [
						{ label: live ? "Run Again" : "Run", key: "cmd-r" },
						{ label: "Stop", key: "cmd-.", ...off(!live) },
						"-",
						{ label: "Next Error", key: "cmd-'", ...off(!errors().length) },
					],
				},
			]
			: [
				{
					title: "File",
					items: [
						{ label: "Save", key: "cmd-s", ...off(!s.modified) },
						{
							label: running
								? `Replace in ${running} ${running === 1 ? "process" : "processes"}`
								: "Replace",
							key: "cmd-r",
							...off(!running),
						},
						"-",
						{ label: "Close", key: "cmd-w" },
					],
				},
				edits,
				{
					title: "Do",
					items: [{ label: "Do It", key: "cmd-d" }, { label: "Print It", key: "cmd-p" }],
				},
			]
		const text = JSON.stringify(value)
		if (text === menued) return
		menued = text
		store(api, [...me, "menus"], value)
	}
	const blit = blitter(api)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	// the text in /dev/font/fixed, the status line in /dev/font/text; the font ROM until they come.
	// CW is a column's width, a fraction of a pixel in a font from the chip
	let F, FX, CW, CH, GUT, STATUS, ROW
	const PAD = 4 * u
	const face = (api, role) => {
		const v = val(api, ["/", "dev", "font", role])
		return v && typeof v === "object" ? font(v) : undefined
	}
	const fonts = (api) => {
		F = face(api, "text")
		FX = face(api, "fixed")
		CW = blit.measure("0".repeat(20), FX) / 20
		CH = blit.height(FX)
		GUT = Math.ceil(CW * 5) + 2 * PAD
		STATUS = blit.height(F) + 8 * u
		ROW = blit.height(F) + 8 * u
		return `${F ? String(F) : "rom"} ${FX ? String(FX) : "rom"}`
	}
	fonts(api)
	let W = Math.min(900 * u, mode.w - 60 * u), H = Math.min(640 * u, mode.h - 80 * u)
	let ROWS, COLS
	// C mode's strip: two rows, fixed, between the text and the status line
	const strip = () => (cmode ? 2 * ROW : 0)
	const size = (w, h) => {
		W = Math.max(GUT + Math.ceil(CW * 20), w)
		H = Math.max(STATUS + strip() + CH * 3, h)
		ROWS = Math.floor((H - STATUS - strip() - PAD * 2) / CH)
		COLS = Math.floor((W - GUT - PAD * 2) / CW)
	}
	size(W, H)
	// data {path}, or a binding's words, {args: ["apps/workspace/text"]}
	const asked = data(given)
	const path = asked?.path ??
		(typeof asked?.args?.[0] === "string" ? asked.args[0].split("/").filter((n) => n) : null) ??
		["apps", "workspace", "text"]
	const NODE = ["/", ...path]
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `edit-${self}`]
	const THEME = ["/", "etc", "theme"]
	// the look, from /etc/theme: paper, ink, a platinum gutter and status line, a rose caret
	const C = {}
	const colours = (T = {}) =>
		Object.assign(C, {
			bg: T.paper ?? 0xfdf8ea,
			gut: T.chrome ?? 0xece5d4,
			num: T.ink3 ?? 0xa89aa2,
			ink: T.ink ?? 0x2a2228,
			dim: T.ink3 ?? 0xa89aa2,
			com: T.lilac ?? 0x7b5ce6,
			cur: T.rose ?? 0xe2457c,
			bar: T.chrome ?? 0xece5d4,
			sel: T.select ?? 0xffff88,
			line: T.line ?? 0x1c1a17,
			bad: T.cherry ?? 0xd2244a,
			ok: T.mint ?? 0x18936b,
			warn: T.butter ?? 0xa87d00,
			hi: T.hi ?? 0xfffdf6,
			lo: T.lo ?? 0xb9ae98,
		})
	colours(val(api, THEME))

	// a value whose kind /etc/views gives a show key holding text (a program's source) is that text, saved at the key
	const load = (api) => {
		const got = read(api, NODE)
		if (!got) return { text: "", kind: "text", time: null, node: null, missing: true }
		const v = got.value
		const show = v && typeof v === "object" && !Array.isArray(v)
			? val(api, ["/", "etc", "views"])?.[v.kind]?.show
			: undefined
		const key = typeof show === "string" && typeof v[show] === "string" ? show : undefined
		const text = key ? v[key] : typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "null"
		// c: a program in C, text its loader /c compiles (C mode)
		const c = typeof v === "string" && program.needs(api, NODE).includes("c")
		return {
			text,
			kind: key || typeof v === "string" ? "text" : "json",
			key,
			time: got.time,
			node: got.node,
			c,
		}
	}
	const loaded = load(api)
	cmode = !!loaded.c
	size(W, H)
	const s = {
		lines: loaded.text.split("\n"),
		kind: loaded.kind,
		base: loaded,
		r: 0,
		c: 0,
		top: 0,
		left: 0,
		// the selection's other end, or null; and an input method's text in progress at the cursor
		mark: null,
		composing: "",
		// readline's: the kills (C-k, C-y), what the key before did, the column up and down keep to
		ring: [],
		was: "",
		goal: null,
		modified: false,
		status: loaded.missing ? ["nothing is here yet: cmd-s makes it", C.warn] : [
			`${loaded.c ? "C program" : loaded.kind === "text" ? "text" : "JSON"}, t=${loaded.time}`,
			C.dim,
		],
		// each change, newest last, as what undoes it: {at, gone, put, r, c}, the lines before it being these
		// with the put lines from at taken out and gone put back, the cursor at r, c
		undo: [],
	}

	// --- the draft, a document beside this process, by the path it edits; and the view, inside this process
	// named by the path, its names between colons, as the Mac's were: drafts/apps:workspace:text
	const DRAFT = [...cwd, "drafts", path.join(":")]
	const VIEW = [...me, "view"]
	const draft = val(api, DRAFT)
	if (Array.isArray(draft?.lines)) {
		Object.assign(s, {
			lines: [...draft.lines],
			kind: draft.kind ?? s.kind,
			modified: true,
			base: { ...loaded, time: draft.base ?? null },
		})
		Object.assign(s, {
			undo: Array.isArray(draft.undo) ? [...draft.undo] : [],
			r: draft.r ?? 0,
			c: draft.c ?? 0,
		})
		s.status = [`not saved since t=${draft.base}: kept as it was`, C.warn]
	}
	const view = val(api, VIEW)
	if (view) {
		for (
			const k of ["r", "c", "top", "left", "mark", "composing", "status", "ring", "was", "goal"]
		) if (k in view) s[k] = view[k]
	}
	if (!draft && Array.isArray(view?.undo)) s.undo = [...view.undo]
	// the patches from one map to the next: a list spliced where it changed, anything else set
	const delta = (was, now) => {
		const out = []
		const same = (x, y) => x === y || JSON.stringify(x) === JSON.stringify(y)
		for (const k of new Set([...Object.keys(was ?? {}), ...Object.keys(now)])) {
			const a = was?.[k], b = now[k]
			if (!(k in now)) out.push({ path: [k] })
			else if (Array.isArray(a) && Array.isArray(b)) {
				let p = 0, q = 0
				while (p < a.length && p < b.length && same(a[p], b[p])) p++
				while (
					q < a.length - p && q < b.length - p &&
					same(a[a.length - 1 - q], b[b.length - 1 - q])
				) q++
				if (p + q < a.length || p + q < b.length) {
					out.push({ path: [k], range: [p, a.length - q], value: b.slice(p, b.length - q) })
				}
			} else if (!same(a, b)) out.push({ path: [k], value: b ?? null })
		}
		return out
	}
	// the lines before the change being made, until it is made: then it is an undo, the lines it changed
	let pending = null
	const done = () => {
		if (!pending) return
		const was = pending.lines, now = s.lines
		let p = 0, q = 0
		while (p < was.length && p < now.length && was[p] === now[p]) p++
		while (
			q < was.length - p && q < now.length - p &&
			was[was.length - 1 - q] === now[now.length - 1 - q]
		) q++
		if (p + q < was.length || p + q < now.length) {
			s.undo.push({
				at: p,
				gone: was.slice(p, was.length - q),
				put: now.length - q - p,
				r: pending.r,
				c: pending.c,
			})
		}
		if (s.undo.length > 200) s.undo.shift()
		pending = null
	}
	let drafted = draft ?? null, viewed = view ?? null
	// the draft typed into: in front of its document (ahead), which is kept as last written; the document written once
	// the keys rest: a burst of typing one change on the card (a commit, ~3 ms, and taken in again at each boot), not one a key
	const REST = 400
	const ahead = front(DRAFT)
	let kept = draft ?? null
	// the timer waiting for the keys to rest: taken back when more keys come, or the editor is closed
	let resting = null
	const settle = (api) => {
		if (!drafted || !ahead.held(api)) return
		ahead.done(api, drafted)
		kept = drafted
	}
	onCleanup(({ api }) => {
		resting?.(api)
		settle(api)
	})
	// what changed, written: the draft while anything is not saved, once the text or the undo list changes,
	// and gone once it is saved; the view as it moves. g: the part's map (a timer is asked of it)
	const keep = (g) => {
		const { api } = g
		done()
		const now = {
			path,
			kind: s.kind,
			base: s.base.time ?? null,
			lines: [...s.lines],
			r: s.r,
			c: s.c,
			undo: [...s.undo],
		}
		try {
			// where the cursor is goes with a change, not alone
			const patches = s.modified ? delta(drafted, now) : []
			if (
				s.modified && (!drafted || patches.some((x) => x.path[0] !== "r" && x.path[0] !== "c"))
			) {
				if (!make(api, DRAFT.slice(0, -2), "drafts", null)) {
					throw new Error(`${DRAFT.slice(0, -2).join("/")} is not here`)
				}
				ahead.put(api, now, drafted && ahead.held(api) ? patches : undefined)
				drafted = now
				resting?.(api)
				resting = after(g, REST, ({ api }) => {
					resting = null
					settle(api)
				})
			} else if (!s.modified && drafted) {
				ahead.done(api)
				kept = null
				for (const i of api.children(DRAFT.slice(0, -1), DRAFT.at(-1))) {
					drop(api, DRAFT.slice(0, -1), DRAFT.at(-1), i.id)
				}
				drafted = null
			}
		} catch (e) {
			s.status = [`the draft is not kept: ${e?.code ?? e?.message}`, C.bad]
		}
		const shown = {
			r: s.r,
			c: s.c,
			top: s.top,
			left: s.left,
			mark: s.mark,
			composing: s.composing,
			status: s.status,
			ring: [...s.ring],
			was: s.was,
			goal: s.goal,
			...(s.modified ? {} : { undo: [...s.undo] }),
		}
		if (!viewed) make(api, me, "view", shown, { ephemeral: true })
		else {
			const patches = delta(viewed, shown)
			if (patches.length) api.write(VIEW, patches)
		}
		viewed = shown
		menus(api)
	}

	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (80 + (n % 5) * 30) * u,
			y: (70 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "edit  /" + path.join("/"),
			owner: me,
			draw: [],
			drags: true,
		}, { ephemeral: true })
	}

	const clamp = () => {
		s.r = Math.max(0, Math.min(s.lines.length - 1, s.r))
		s.c = Math.max(0, Math.min(s.lines[s.r].length, s.c))
		if (s.r < s.top) s.top = s.r
		if (s.r >= s.top + ROWS) s.top = s.r - ROWS + 1
		if (s.c < s.left) s.left = s.c
		if (s.c >= s.left + COLS) s.left = s.c - COLS + 1
	}
	const remember = () => {
		done()
		pending = { lines: [...s.lines], r: s.r, c: s.c }
	}
	// the selection, first end first, or null when there is none
	const before = (a, b) => a.r < b.r || (a.r === b.r && a.c < b.c)
	const selection = () => {
		if (!s.mark || (s.mark.r === s.r && s.mark.c === s.c)) return null
		const cur = { r: s.r, c: s.c }
		return before(s.mark, cur) ? [s.mark, cur] : [cur, s.mark]
	}
	const selected = () => {
		const sel = selection()
		if (!sel) return ""
		const [a, b] = sel
		if (a.r === b.r) return s.lines[a.r].slice(a.c, b.c)
		return [s.lines[a.r].slice(a.c), ...s.lines.slice(a.r + 1, b.r), s.lines[b.r].slice(0, b.c)]
			.join("\n")
	}
	// the selection's text, gone; the cursor where it began
	const cut = () => {
		const sel = selection()
		s.mark = null
		if (!sel) return false
		const [a, b] = sel
		remember()
		s.lines.splice(a.r, b.r - a.r + 1, s.lines[a.r].slice(0, a.c) + s.lines[b.r].slice(b.c))
		s.r = a.r
		s.c = a.c
		s.modified = true
		return true
	}
	// an offset in the whole text, as the Mac counts (UTF-16)
	const offset = (r, c) => s.lines.slice(0, r).reduce((n, l) => n + l.length + 1, 0) + c
	const CLIP = ["/", "dev", "clip", "text"]
	const copy = (api, text) => {
		if (!text) return
		try {
			api.write(CLIP, whole({ text }))
		} catch (e) {
			s.status = [`not copied: ${why(e)}`, C.bad]
		}
	}
	const insert = (text) => {
		// typed over a selection, the cut and the typing are one change
		if (!cut()) remember()
		const line = s.lines[s.r]
		const parts = (line.slice(0, s.c) + text + line.slice(s.c)).split("\n")
		s.lines.splice(s.r, 1, ...parts)
		const lastLen = text.split("\n").at(-1).length
		s.r += parts.length - 1
		s.c = parts.length > 1 ? lastLen : s.c + text.length
		s.modified = true
	}

	// a line as drawn: each tab to the next of every TAB columns; cols[i], the column its index i starts at
	const TAB = 4
	const spread = (line) => {
		let text = ""
		const cols = []
		for (let i = 0; i < line.length; i++) {
			cols.push(text.length)
			text += line[i] === "\t" ? " ".repeat(TAB - (text.length % TAB)) : line[i]
		}
		cols.push(text.length)
		return { text, cols }
	}
	const draw = () => {
		const d = blit.list(W, H, C.bg)
		const B = H - STATUS - strip()
		blit.fill(d, 0, 0, GUT, B, C.gut)
		const sel = selection()
		// C mode: what its compile said of each line, an error over a warning, as a dot in the gutter
		const marks = new Map()
		if (cmode) {
			for (const x of prog.diags) {
				if (!x.file && x.line && marks.get(x.line) !== "error") marks.set(x.line, x.level)
			}
		}
		const DOT = Math.max(4 * u, Math.round(CH * 0.4))
		for (let i = 0; i < ROWS; i++) {
			const r = s.top + i
			if (r >= s.lines.length) break
			const y = PAD + i * CH
			blit.text(
				d,
				PAD,
				y,
				String(r + 1).padStart(4),
				r === s.r ? C.ink : C.num,
				undefined,
				undefined,
				FX,
			)
			const mark = marks.get(r + 1)
			if (mark === "error" || mark === "warning") {
				blit.fill(
					d,
					PAD + Math.floor((CW - DOT) / 2),
					y + Math.floor((CH - DOT) / 2),
					DOT,
					DOT,
					mark === "error" ? C.bad : C.warn,
				)
			}
			// the line as shown: with what an input method is composing, at the cursor; its tabs spread
			const line = r === s.r && s.composing
				? s.lines[r].slice(0, s.c) + s.composing + s.lines[r].slice(s.c)
				: s.lines[r]
			const { text, cols } = spread(line)
			const from = cols[Math.min(s.left, line.length)]
			const shown = text.slice(from, from + COLS)
			const x0 = GUT + PAD
			const xAt = (c) =>
				x0 + blit.measure(text.slice(from, Math.max(from, cols[Math.min(c, line.length)])), FX)
			// the selection, on a highlighter, under the text
			if (sel && r >= sel[0].r && r <= sel[1].r) {
				const a = r === sel[0].r ? sel[0].c : 0, b = r === sel[1].r ? sel[1].c : line.length
				const xa = xAt(a), xb = r === sel[1].r ? xAt(b) : xAt(b) + CW / 2
				if (xb > xa) blit.fill(d, xa, y, Math.ceil(xb - xa), CH, C.sel)
			}
			// comments dim, the rest plain: enough to read a program by
			const at = s.kind === "text" ? line.indexOf("//") : -1
			if (at >= 0 && cols[at] < from + COLS) {
				const cut = Math.max(0, cols[at] - from)
				const mid = blit.text(d, x0, y, shown.slice(0, cut), C.ink, undefined, undefined, FX)
				blit.text(d, mid, y, shown.slice(cut), C.com, undefined, undefined, FX)
			} else blit.text(d, x0, y, shown, C.ink, undefined, undefined, FX)
			if (r === s.r && s.composing) {
				const xa = xAt(s.c), xb = xAt(s.c + s.composing.length)
				blit.fill(d, xa, y + CH - u, xb - xa, u, C.ink)
			}
		}
		// the cursor
		const cy = PAD + (s.r - s.top) * CH, cx = caretX()
		blit.fill(d, cx, cy, 2 * u, CH, C.cur)
		// the status line
		blit.fill(d, 0, H - STATUS, W, STATUS, C.bar)
		blit.fill(d, 0, H - STATUS, W, u, C.line)
		blit.fill(d, GUT - u, 0, u, B, C.line)
		if (cmode) stripped(d, B)
		const left = `/${path.join("/")}${s.modified ? " •" : ""}  ${s.r + 1}:${s.c + 1}`
		const end = blit.text(d, 6 * u, H - STATUS + 4 * u, left, C.ink, undefined, undefined, F)
		blit.text(d, end + 16 * u, H - STATUS + 4 * u, s.status[0], s.status[1], undefined, {
			x: 0,
			y: H - STATUS,
			w: W - 6 * u,
			h: STATUS,
		}, F)
		return d.ops
	}

	// --- C mode: its errors, and the strip
	// this program's errors (not a header's), in order
	const errors = () =>
		prog.diags.filter((x) => x.level === "error" && !x.file && x.line).sort((a, b) =>
			a.line - b.line || (a.column ?? 0) - (b.column ?? 0)
		)
	// one is compiling and has been for 200 ms: said; a quick one is not
	const compiling = () => prog.since > 0 && Date.now() - prog.since >= 200
	// what the strip says, row by row: the compile, then the process; the error the first row names, and the handlers
	const words = () => {
		const p = prog.procs[0]
		const one = compiling()
			? { text: "compiling…", tone: "dim" }
			: program.compiled(prog.load, prog.diags, s.r + 1) ??
				{ text: "cmd-r runs it", tone: "dim" }
		const two = program.state(p, prog.stopped)
		if (prog.procs.length > 1) two.text += ` · ${prog.procs.length} running`
		const all = errors()
		const named = !compiling() && prog.load?.compile === "failed"
			? all.find((x) => x.line === s.r + 1) ?? all[0] ?? null
			: null
		return { one, two, named, handlers: p ? p.handlers.map((n) => ({ n, at: p.address })) : [] }
	}
	// where the strip's buttons were drawn, and what VoiceOver hears of it
	let buttons = [], heard = []
	// a push button, square, a hard bevel, as My Computer's
	const push = (d, x, y, w, h, label) => {
		blit.fill(d, x, y, w, h, C.line)
		blit.fill(d, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
		blit.fill(d, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
		blit.fill(d, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.bar)
		blit.text(
			d,
			x + 8 * u,
			y + Math.floor((h - blit.height(F)) / 2),
			label,
			C.ink,
			undefined,
			undefined,
			F,
		)
	}
	const stripped = (d, top) => {
		const w = words()
		buttons = []
		blit.fill(d, 0, top, W, 2 * ROW, C.bar)
		blit.fill(d, 0, top, W, u, C.line)
		blit.text(d, 6 * u, top + 4 * u, w.one.text, C[w.one.tone], undefined, {
			x: 0,
			y: top,
			w: W - 6 * u,
			h: ROW,
		}, F)
		// the handlers, from the right
		let x = W - 6 * u
		for (const b of [...w.handlers].reverse()) {
			const bw = blit.measure(b.n, F) + 16 * u, bh = ROW - 4 * u, by = top + ROW + 2 * u
			x -= bw
			push(d, x, by, bw, bh, b.n)
			buttons.push({ x, y: by, w: bw, h: bh, ...b })
			x -= 4 * u
		}
		blit.text(d, 6 * u, top + ROW + 4 * u, w.two.text, C[w.two.tone], undefined, {
			x: 0,
			y: top + ROW,
			w: Math.max(0, x - 6 * u),
			h: ROW,
		}, F)
		heard = [
			{ role: "text", label: w.one.text, x: 0, y: top, w: W, h: ROW },
			{ role: "text", label: w.two.text, x: 0, y: top + ROW, w: x, h: ROW },
			...buttons.map((b) => ({ role: "button", label: b.n, x: b.x, y: b.y, w: b.w, h: b.h })),
		]
	}
	// the next error after the cursor, from the top again past the last: the cursor there
	const seek = () => {
		const all = errors()
		if (!all.length) return (s.status = ["no errors", C.dim])
		onto(
			all.find((x) => x.line - 1 > s.r || (x.line - 1 === s.r && (x.column ?? 1) - 1 > s.c)) ??
				all[0],
		)
	}
	const onto = (e) => {
		s.r = e.line - 1
		s.c = Math.max(0, (e.column ?? 1) - 1)
		s.mark = null
		clamp()
	}

	const caretX = () => {
		const line = s.lines[s.r] ?? "",
			{ text, cols } = spread(line),
			from = cols[Math.min(s.left, line.length)]
		return GUT + PAD +
			blit.measure(
				text.slice(from, Math.max(from, cols[Math.min(s.c, line.length)])) + s.composing,
				FX,
			)
	}
	// what it says to the Mac: the line being typed on, for input methods, and the whole text, for VoiceOver
	const meaning = () => {
		const sel = selection()
		const onLine = sel && sel[0].r === s.r && sel[1].r === s.r ? [sel[0].c, sel[1].c] : [s.c, s.c]
		const all = sel
			? [offset(sel[0].r, sel[0].c), offset(sel[1].r, sel[1].c)]
			: [offset(s.r, s.c), offset(s.r, s.c)]
		return {
			input: {
				text: s.lines[s.r],
				selection: onLine,
				caret: { x: caretX(), y: PAD + (s.r - s.top) * CH, w: 2 * u, h: CH },
			},
			access: [{
				role: "textarea",
				label: `edit /${path.join("/")}`,
				value: s.lines.join("\n"),
				selection: all,
				x: 0,
				y: 0,
				w: W,
				h: H - STATUS - strip(),
			}, ...(cmode ? heard : [])],
		}
	}
	const paint = (api) => {
		if (!idAt(api, LAYER)) return
		const set = (key, value) => ({ path: [key], value })
		const ops = draw(), m = meaning()
		api.write(LAYER, [
			set("w", W),
			set("h", H),
			set("draw", ops),
			set("input", m.input),
			set("access", m.access),
			set("title", `edit  /${path.join("/")}${s.modified ? " •" : ""}`),
		])
	}

	// the processes the window manager started that run this node as their program: each client's start,
	// its program searched for up from where it runs, as the scheduler does; the node a program was found in is its item's id
	const runners = (api, node) => {
		const out = []
		const WM = ["/", "dev", "wm", "client"]
		for (const id of api.children(WM)) {
			const c = val(api, [...WM, id])
			if (!c?.pid || !Array.isArray(c.node) || c.away) continue
			if (!api.children(c.node.slice(0, -1), c.node.at(-1)).some((i) => i.id === c.pid)) continue
			const p = c.start?.program
			const names = typeof p === "string" ? p.split("/") : Array.isArray(p) ? p : []
			const from = names[0] === "/" || p?.[0] === "/"
				? [["/"]]
				: c.node.slice(0, -1).map((_, i, at) => at.slice(0, at.length - i))
			for (const at of from) {
				const found = api.look([...at, ...names.filter((n) => n && n !== "/")]).find((i) =>
					i.node
				)
				if (!found) continue
				if (found.id === node) out.push({ pid: c.pid, node: c.node })
				break
			}
		}
		return out
	}

	const save = (api) => {
		const text = s.lines.join("\n")
		let value = text
		if (s.kind === "json") {
			try {
				value = JSON.parse(text)
			} catch (e) {
				s.status = [`not JSON: ${e.message}`, C.bad]
				return
			}
		}
		try {
			let t
			if (s.base.key && idAt(api, NODE)) t = api.write(NODE, [{ path: [s.base.key], value }])
			else if (idAt(api, NODE)) t = api.write(NODE, whole(value))
			else if (make(api, NODE.slice(0, -1), NODE.at(-1), value)) t = read(api, NODE)?.time
			else {
				s.status = [
					`nothing to save it in: ${NODE.slice(0, -1).join("/") || "/"} is not here`,
					C.bad,
				]
				return
			}
			s.modified = false
			s.base = load(api)
			const procs = s.kind === "text" && !cmode ? runners(api, s.base.node) : []
			running = procs.length
			s.status = procs.length
				? [`saved, t=${t}. ${procs.length} running the old code: cmd-r replaces`, C.warn]
				: [`saved, t=${t}`, C.ok]
		} catch (e) {
			s.status = [
				e?.code === "refused"
					? `refused by a rule (${e.message}): go stack> to see /etc/rules`
					: why(e),
				C.bad,
			]
		}
	}

	const replace = (api, call) => {
		const procs = runners(api, s.base.node)
		if (!procs.length) {
			s.status = ["no window runs this", C.dim]
			return
		}
		try {
			for (const p of procs) call(["/", "stack", "on", "replace"], [p.node])
			running = 0
			s.status = [`replaced in ${procs.map((p) => p.pid).join(", ")}`, C.ok]
		} catch (e) {
			s.status = [why(e), C.bad]
		}
	}

	// C mode's Run: saved first; then its processes (by its node: ermine:program) start their code over, or, none
	// running, one starts in its folder, "<name> running", through the window manager's launch, so it outlives this
	// editor (with none, as this editor's child). g: the handler's map
	const runs = (g) => {
		const { api, call, start } = g
		if (s.modified) save(api)
		if (s.modified) return
		const procs = program.processes(api, NODE)
		prog.stopped = false
		try {
			if (procs.length) {
				for (const p of procs) call(["/", "stack", "on", "replace"], [p.address])
				s.status = [`started over: ${procs.map((p) => p.name).join(", ")}`, C.dim]
				return
			}
			// launched a moment ago, its load not yet written: not twice
			if (Date.now() - prog.launched < 2000) return
			const folder = NODE.slice(0, -1), names = api.children(folder)
			let n = `${NODE.at(-1)} running`
			for (let i = 2; names.includes(n); i++) n = `${NODE.at(-1)} running ${i}`
			const op = { address: folder, program: [NODE.at(-1)], name: n }
			const launch = val(api, ["/", "dev", "wm", "launch"])
			if (Array.isArray(launch)) call(launch, [op])
			else start(op)
			prog.launched = Date.now()
			s.status = [`started ${n}`, C.dim]
		} catch (e) {
			s.status = [why(e), C.bad]
		}
	}
	// C mode's Stop: each of its processes killed
	const stops = (api) => {
		const procs = program.processes(api, NODE)
		for (const p of procs) {
			kill(p.id)
			prog.killed.add(p.id)
		}
		if (procs.length) prog.stopped = true
		prog.launched = 0
		s.status = procs.length
			? [`stopped ${procs.map((p) => p.name).join(", ")}`, C.dim]
			: ["nothing of it is running", C.dim]
	}

	// do it, and print it: the line as an expression, or else as statements
	const run = (api, print) => {
		const code = s.lines[s.r].replace(/^\s*\/\/\s?→.*$/, "").trim()
		if (!code) return
		let got
		try {
			let f
			try {
				f = new Function("api", `return (${code})`)
			} catch {
				f = new Function("api", code)
			}
			got = f(api)
			const shown = (v) => {
				try {
					return JSON.stringify(
						v,
						(
							_k,
							x,
						) => (x instanceof Uint8Array
							? `<bytes ${x.byteLength}>`
							: ArrayBuffer.isView(x)
							? `<${x.constructor.name} ${x.length}>`
							: x),
					) ?? String(v)
				} catch {
					return String(v)
				}
			}
			s.status = [`did it`, C.ok]
			if (print) {
				const indent = s.lines[s.r].match(/^\s*/)?.[0] ?? ""
				const text = shown(got)
				remember()
				s.lines.splice(
					s.r + 1,
					0,
					`${indent}// → ${text.length > 400 ? text.slice(0, 400) + "…" : text}`,
				)
				s.modified = true
			}
		} catch (e) {
			s.status = [`${e?.code ?? e?.name}: ${e?.message}`, C.bad]
		}
	}

	// a change undone: the lines it changed as they were, the cursor where it was
	const undo = () => {
		done()
		const u = s.undo.pop()
		if (u) {
			s.lines.splice(u.at, u.put, ...u.gone)
			Object.assign(s, { r: u.r, c: u.c, mark: null, modified: true })
		}
	}
	// a key done by the readline tool, the text its field: the cursor and the selection as offsets in it,
	// the kill ring, what the key before did and the column up and down keep to beside them (the view)
	const rc = (pos) => {
		let r = 0
		while (r < s.lines.length - 1 && pos > s.lines[r].length) pos -= s.lines[r++].length + 1
		return { r, c: pos }
	}
	const line = (r) => {
		const text = s.lines.join("\n")
		const f = {
			text,
			pos: offset(s.r, s.c),
			mark: s.mark ? offset(s.mark.r, s.mark.c) : null,
			ring: s.ring,
			last: s.was,
			goal: s.goal,
		}
		const next = readline.type(f, r, { lines: true, select: true })
		if (!next) return
		if (next.text !== text) {
			remember()
			s.lines = next.text.split("\n")
			s.modified = true
		}
		Object.assign(s, rc(next.pos), {
			mark: next.mark === null || next.mark === undefined ? null : rc(next.mark),
			ring: next.ring,
			was: next.last,
			goal: next.goal,
		})
	}

	// a key with cmd, control or alt held: not Enter's or Tab's own
	const held = (r) => ["cmd", "ctrl", "alt"].some((m) => r.mods?.includes(m))
	handler(given, "key", (g) => {
		const { api, call } = g
		const [recs] = g.args
		for (const r of recs) {
			if (r.event === "compose") {
				if (r.text) cut()
				s.composing = r.text ?? ""
				continue
			}
			if (r.event === "commit") {
				s.composing = ""
				if (r.replace) {
					// a press-and-hold accent: the letter held, on this line, is replaced
					remember()
					const line = s.lines[s.r]
					s.lines[s.r] = line.slice(0, r.replace[0]) + r.text + line.slice(r.replace[1])
					s.c = r.replace[0] + r.text.length
					s.mark = null
					s.modified = true
				} else insert(r.text ?? "")
				clamp()
				continue
			}
			if (!r.down) continue
			const cmd = r.mods?.includes("cmd")
			const shift = r.mods?.includes("shift")
			if (cmd) {
				if (r.key === "s") save(api)
				else if (r.key === "a") {
					s.mark = { r: 0, c: 0 }
					s.r = s.lines.length - 1
					s.c = s.lines[s.r].length
				} else if (r.key === "c") copy(api, selected())
				else if (r.key === "x") {
					copy(api, selected())
					cut()
				} else if (r.key === "d" && !cmode) run(api, false)
				else if (r.key === "p" && !cmode) run(api, true)
				else if (r.key === "r") cmode ? runs(g) : replace(api, call)
				else if (r.key === "." && cmode) stops(api)
				else if (r.key === "'" && cmode) seek()
				else if (r.key === "z") undo()
				else if (r.key.startsWith("Arrow") || r.key === "Backspace") line(r)
				else if (r.key === "v") {
					const t = val(api, CLIP)?.text
					if (typeof t === "string") insert(t.replace(/\r\n?/g, "\n"))
				}
				clamp()
				continue
			}
			// PageUp and PageDown, Enter and Tab are the editor's; the rest readline's, the tool's, on the
			// whole text as one field: C-n and C-p, the arrows, move by lines; shift and a move selects
			if (r.key === "PageUp" || r.key === "PageDown") {
				s.mark = shift ? s.mark ?? { r: s.r, c: s.c } : null
				s.r += (r.key === "PageUp" ? -1 : 1) * (ROWS - 1)
			} else if (r.key === "Enter" && !held(r)) {
				insert("\n" + (s.lines[s.r].match(/^\s*/)?.[0] ?? ""))
			} else if (r.key === "Tab" && !held(r)) insert(cmode ? "\t" : "  ")
			else if (["C-_", "C-slash", "C-S-minus"].includes(readline.chord(r))) undo()
			else line(r)
			clamp()
		}
		clamp()
		paint(api)
		keep(g)
	})

	// where a point in the text is: a row and a column, the cursor's place for a click there
	const hit = (x, y) => {
		const r = Math.max(0, Math.min(s.lines.length - 1, s.top + Math.floor((y - PAD) / CH)))
		const line = s.lines[r],
			{ text, cols } = spread(line),
			from = cols[Math.min(s.left, line.length)]
		const at = from + blit.at(text.slice(from), x - GUT - PAD, FX)
		// the index whose column is nearest: a click in a tab's room goes to its nearer side
		let c = cols.findIndex((k) => k >= at)
		if (c < 0) c = line.length
		if (c > 0 && cols[c] > at && at - cols[c - 1] < cols[c] - at) c--
		return { r, c: Math.max(c, Math.min(s.left, line.length)) }
	}
	let dragging = false
	// a trackpad's scroll comes a few pixels a record: what is not yet a whole line is kept for the next
	let rest = 0
	handler(given, "pointer", (g) => {
		const { api, call } = g
		const [recs] = g.args
		for (const r of recs) {
			if (r.event === "scroll") {
				rest += r.dy / CH
				const lines = Math.trunc(rest)
				rest -= lines
				s.top = Math.max(0, Math.min(s.lines.length - 1, s.top + lines))
			} else if (r.event === "down" && r.y >= H - STATUS - strip() && r.y < H - STATUS) {
				// the strip: a handler's button calls it, with no args; the compile's row goes to the error it names
				const b = buttons.find((b) =>
					r.x >= b.x && r.x < b.x + b.w && r.y >= b.y && r.y < b.y + b.h
				)
				const named = words().named
				try {
					if (b) call([...b.at, "on", b.n], [])
					else if (named && r.y < H - STATUS - ROW) onto(named)
				} catch (e) {
					s.status = [why(e), C.bad]
				}
			} else if (r.event === "down" && r.y < H - STATUS - strip()) {
				const from = { r: s.r, c: s.c }
				Object.assign(s, hit(r.x, r.y))
				// shift-click extends the selection; a click starts a new one, empty until a drag
				s.mark = r.mods?.includes("shift") ? s.mark ?? from : { r: s.r, c: s.c }
				dragging = true
				clamp()
			} else if (r.event === "move" && dragging) {
				Object.assign(s, hit(r.x, r.y))
				clamp()
			} else if (r.event === "up") dragging = false
		}
		paint(api)
		keep(g)
	})

	// a new look, or new fonts: drawn again in them
	effect(
		given,
		"theme",
		({ api }) => ({ T: val(api, THEME) ?? null, fonts: fonts(api) }),
		({ value: { T }, api }) => {
			colours(T ?? {})
			size(W, H)
			clamp()
			paint(api)
		},
	)

	// the size the window manager gives: deep, as the window's node changes each move and the same want, made
	// again, is no new value
	effect(
		given,
		"size",
		({ api }) => val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want ?? null,
		({ value: want, api }) => {
			if (!want) return
			size(want.w, want.h)
			clamp()
			paint(api)
		},
		{ deep: true },
	)

	// <its node>/view, read as it changes: a field another wrote (a shell's set) taken on, what it wrote itself let be
	const canon = (v) =>
		JSON.stringify(
			v,
			(_k, x) => (x && typeof x === "object" && !Array.isArray(x)
				? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
				: x),
		)
	effect(given, "theirs", ({ api }) => val(api, VIEW) ?? null, (g) => {
		const v = g.value
		const theirs = v && viewed
			? Object.keys(viewed).filter((k) => k in v && canon(v[k]) !== canon(viewed[k]))
			: []
		if (!theirs.length) return
		for (const k of theirs) [s[k], viewed[k]] = [v[k], JSON.parse(JSON.stringify(v[k]))]
		if (theirs.includes("r") || theirs.includes("c")) clamp()
		paint(g.api)
		keep(g)
	})

	// the node, as it is now: followed while untouched, flagged while edited
	effect(given, "node", ({ api }) => {
		const got = read(api, NODE)
		return got ? { time: got.time } : null
	}, (g) => {
		const { api, value: now } = g
		if (now && now.time !== s.base.time) {
			const theirs = load(api)
			if (!s.modified) {
				// followed, as a change of its own: undone, it is as it was
				remember()
				s.lines = theirs.text.split("\n")
				s.kind = theirs.kind
				s.base = theirs
				clamp()
				s.status = [`changed elsewhere, t=${theirs.time}: shown`, C.dim]
			} else {s.status = [
					`changed elsewhere at t=${theirs.time}; cmd-s puts yours over it`,
					C.warn,
				]}
		}
		paint(api)
		keep(g)
	})

	// C mode: whether the node is a program in C, its processes (in its folder, by its node), how it last compiled
	effect(given, "program", ({ api }) => {
		const c = typeof read(api, NODE)?.value === "string" && program.needs(api, NODE).includes("c")
		if (!c) return { c }
		const procs = program.processes(api, NODE)
		const load = procs.find((p) => p.load?.compile)?.load ?? null
		return { c, procs, load, diags: load?.leaf ? program.diagnostics(api, load) : null }
	}, (g) => {
		const { api, value: v } = g
		if (v.c !== cmode) {
			cmode = v.c
			size(W, H)
			clamp()
		}
		if (v.c) {
			prog.procs = v.procs
			// one running that Stop did not end: no longer stopped
			if (v.procs.some((p) => !prog.killed.has(p.id))) prog.stopped = false
			if (v.load?.compile === "compiling") {
				// said once it has taken 200 ms
				if (!prog.since) {
					prog.since = Date.now()
					after(g, 220, ({ api }) => paint(api))
				}
			} else if (v.load) {
				prog.since = 0
				prog.load = v.load
				if (v.diags) prog.diags = v.diags
			}
		}
		paint(api)
		menus(api)
	}, { deep: true })
}
