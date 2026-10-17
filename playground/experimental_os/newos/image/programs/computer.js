// /programs/computer: My Computer, a Finder for the graph. opens at /home; shows a node's names as
// icons. folder: a node holding others, or nothing yet; file: a node with a value; both: opens as a
// folder. the arrow and the path bar go up, as far as /.
// where it is: /apps/computer/at/<name>, {path}, kept across a boot; write it to send it somewhere.
// selection, scroll, dialog, picture shown, footer: <its node>/view.
//
// picture: {kind: "picture", colors: {letter: 0xRRGGBB}, rows: ["..kk..", ...], tile?}, a letter
// not in colors clear. "Set as Desktop" writes /etc/desktop/picture; "Paint" and "New Picture" use
// /programs/paint; "New C Program" makes one from /lib/c/hello.c (info ermine.program.provisions
// {needs: ["c"]}) and opens it in the editor's C mode.
// double-click: a folder goes in, a picture shows, an app ({kind: "app", run, icon}) runs, the rest
// opens in /programs/edit. "Connect…" mounts an id (ermine://… or bare hex). Trash: /home/Trash; in
// the Trash, lets go.
// drag: moves where dropped; onto a folder, the Trash, another My Computer window or the desk
// (/home/desktop), into it, through its on/drop (icons.dropped). option-cmd links instead; cmd-l
// makes "<name> link" beside it. a dialog open or a picture shown takes no drops. into a folder
// already holding it: a move drops the old name, a link does nothing.
//
// keys: arrows select, a letter the first name it starts; cmd-o or cmd-down open, cmd-up up, Enter
// renames, cmd-n new note, cmd-shift-n new folder, cmd-Backspace Trash, cmd-k connect, cmd-e edit
// the value, cmd-p paint. the wheel scrolls.
import { drop, effect, front, handler, idAt, make, snap, val, whole } from "ermine:kit"
import { after, here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as views from "ermine:views"
import * as icons from "ermine:icons"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, self, name, onCleanup } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls; where it is run from
	const me = here(self), cwd = me.slice(0, -1)
	// its menus, in the menu bar while its window has the focus (/programs/wmii): an item with a key is that chord,
	// pressed; one with call calls on/<call>, here on/menu, with args. Written as what it shows changes: what
	// can't be done here greyed
	let menued = null
	const menus = (api, v) => {
		const e = v.entries.find((x) => x.name === s.chosen), off = (no) => (no ? { off: true } : {})
		const value = [
			{
				title: "File",
				items: [
					{ label: "New Note", key: "cmd-n", ...off(s.preview) },
					{ label: "New Folder", key: "cmd-shift-n", ...off(s.preview) },
					{ label: "New Picture", call: "menu", args: ["picture"], ...off(s.preview) },
					{ label: "New C Program", call: "menu", args: ["program"], ...off(s.preview) },
					"-",
					{ label: "Open", key: "cmd-o", ...off(!e || s.preview) },
					{ label: "Rename", key: "Enter", ...off(!e || s.preview) },
					{ label: "Edit Value", key: "cmd-e", ...off(!e && !s.preview) },
					{ label: "Make Link", key: "cmd-l", ...off(!e || e.kind === "trash" || s.preview) },
					{ label: "Paint", key: "cmd-p", ...off(!s.preview && e?.kind !== "picture") },
					"-",
					{ label: "Connect…", key: "cmd-k", ...off(s.preview) },
					"-",
					{
						label: same(v.path, TRASH) ? "Delete" : "Move to Trash",
						key: "cmd-Backspace",
						...off(!e || e.kind === "trash" || s.preview),
					},
					{ label: "Empty Trash", call: "menu", args: ["empty"], ...off(!v.trash) },
					"-",
					{ label: "Close", key: "cmd-w" },
				],
			},
			{
				title: "View",
				items: [{
					label: "Clean Up",
					call: "menu",
					args: ["clean"],
					...off(s.preview || !v.entries.length),
				}],
			},
			{
				title: "Go",
				items: [
					{
						label: "Enclosing Folder",
						key: "cmd-ArrowUp",
						...off(!s.preview && !v.path.length),
					},
					{ label: "Home", call: "menu", args: ["home"] },
					{ label: "Applications", call: "menu", args: ["apps"] },
					"-",
					{ label: "Keys", call: "menu", args: ["keys"] },
				],
			},
		]
		const text = JSON.stringify(value)
		if (text === menued) return
		menued = text
		if (idAt(api, [...me, "menus"])) api.write([...me, "menus"], whole(value))
		else make(api, me, "menus", value, { ephemeral: true })
	}
	const blit = blitter(api)
	// labels in /dev/font/text, buttons in /dev/font/title; the font ROM until they come
	let F, FT
	const face = (v) => (v ? font(v) : undefined)
	const fonts = (api) => {
		F = face(val(api, ["/", "dev", "font", "text"]))
		FT = face(val(api, ["/", "dev", "font", "title"]))
		return `${F ? String(F) : "rom"} ${FT ? String(FT) : "rom"}`
	}
	fonts(api)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(760 * u, mode.w - 60 * u), H = Math.min(500 * u, mode.h - 80 * u)
	const LAYER = ["/", "dev", "display", "layers", `computer-${self}`]
	const AT = [...cwd, "at", name]
	// what changed while it was away from a folder (views' away): /apps/computer/seen/<its name>, a document
	const away = views.away([...cwd, "seen", name])
	const HOME = ["home"]
	const TRASH = ["home", "Trash"]
	const set = (key, value) => ({ path: [key], value })
	// the look, from /etc/theme: its colours, and the shapes it says (as wmii's): buttons "bevel" (System 7's, the
	// default), "soft" (catclock's Files': white, round, hairlines) or "raised" (Windows 98's); selection {shape} "box"
	// or "pill", what is chosen and its name drawn in pick and pickInk; icons as icons.ts reads them
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
			lemon: T.lemon ?? 0xffff88,
			cherry: T.cherry ?? 0xd2244a,
			rose: T.rose ?? 0xe2457c,
			ok: T.mint ?? 0x18936b,
			desk: T.desk ?? 0xf3ead2,
			hair: T.hair ?? T.line ?? 0x1c1a17,
			ink2: T.ink2 ?? 0x6b5a66,
			select: T.select ?? T.lemon ?? 0xffff88,
			pick: T.pick ?? T.line ?? 0x1c1a17,
			blue: T.blue ?? T.sky ?? 0x3772ff,
			pink: T.pink ?? T.rose ?? 0xe2457c,
			pickInk: T.pickInk ?? T.paper ?? 0xfdf8ea,
			light: T.light ?? 0xdfdfdf,
			dark: T.dark ?? 0x000000,
			buttons: T.buttons === "soft" || T.buttons === "raised" ? T.buttons : "bevel",
			pill: T.selection?.shape === "pill",
			icons: T.icons ?? null,
		})
	colours(val(api, ["/", "etc", "theme"]))
	// icons drawn, kinds told and things opened as the desk's (icons, the tool)
	const I = icons.make(blit, { u, colours: C })

	// what is on screen besides the graph: the one selected, a dialog, a picture shown, a word in the footer;
	// the node view, inside this process's, and this its copy, written back once a call
	const s = {
		chosen: null,
		scroll: 0,
		dialog: null,
		preview: null,
		note: null,
		click: { name: null, t: 0 },
	}
	const VIEW = [...me, "view"]
	const view = val(api, VIEW)
	if (view) { for (const k of Object.keys(s)) if (k in view) s[k] = view[k] }
	let viewed = view ?? null
	const keep = (api) => {
		const now = {
			chosen: s.chosen,
			scroll: s.scroll,
			dialog: s.dialog,
			preview: s.preview,
			note: s.note,
			click: s.click,
		}
		const text = JSON.stringify(now)
		if (viewed && JSON.stringify(viewed) === text) return
		if (idAt(api, VIEW)) api.write(VIEW, whole(JSON.parse(text)))
		else make(api, me, "view", JSON.parse(text), { ephemeral: true })
		viewed = JSON.parse(text)
	}

	// opened at a path (the desk's double click): a picture shows, in its folder; the window where that folder's was
	// last closed (its layout's window). What it was started with, d ({path} or {args: ["a/path"]}), is not there when
	// the setup runs (start gives a pid, then data is put in it): so a first run waits for it, an effect (data, below),
	// and, started with none, a timer; one come back (its at/<name> there) needs none
	let started = false
	const open0 = (api, d) => {
		if (started) return
		started = true
		let was = null
		if (!idAt(api, AT)) {
			make(api, AT.slice(0, -2), "at", null)
			let path = d?.path ??
				(typeof d?.args?.[0] === "string" ? d.args[0].split("/").filter((n) => n) : null) ??
				HOME
			if (path.length && I.isPicture(val(api, ["/", ...path]))) {
				;[s.preview, path] = [path, path.slice(0, -1)]
			}
			make(api, AT.slice(0, -1), name, { path })
			const id = icons.folder(api, path)
			was = id ? val(api, icons.layout.at(id))?.window ?? null : null
			if (was) [W, H] = [Math.max(320 * u, was.w * u), Math.max(200 * u, was.h * u)]
		}
		if (!idAt(api, LAYER)) {
			const n = api.children(["/", "dev", "display", "layers"]).length
			make(api, LAYER.slice(0, -1), LAYER.at(-1), {
				x: was ? was.x * u : (70 + (n % 5) * 30) * u,
				y: was ? was.y * u : (64 + (n % 5) * 24) * u,
				w: W,
				h: H,
				z: n,
				title: "My Computer",
				owner: me,
				drags: true,
				draw: [],
			}, { ephemeral: true })
		}
	}
	if (idAt(api, AT)) open0(api, null)
	// where each thing drawn is, from the last draw: what a click does there, and what VoiceOver says
	let zones = []

	// --- the graph, as this window sees it

	const isPicture = I.isPicture, entry = I.entry, describe = I.describe
	const look = (api) => {
		const path = val(api, AT)?.path ?? HOME
		try {
			const listing = api.children(["/", ...path])
			const id = icons.folder(api, path)
			return {
				path,
				id,
				layout: id ? val(api, icons.layout.at(id)) ?? null : null,
				entries: icons.keyed(
					listing.map((n) => entry(api, path, n, api.children(["/", ...path], n))),
				),
			}
		} catch (e) {
			return { path, entries: [], refused: `${e.code ?? "refused"}: ${e.message}` }
		}
	}
	// the desktop picture's path, in a node of its own under /etc/desktop, so the image may still bring /etc/desktop up to date
	const DESK = ["/", "etc", "desktop", "picture"]
	const desktop = (api) => val(api, DESK) ?? null
	const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.join("/") === b.join("/")
	// how many things are in the Trash, for Empty Trash
	const trash = (api) => {
		try {
			return api.children(["/", ...TRASH]).length
		} catch {
			return 0
		}
	}

	// --- pictures and icons: the tool's, 16 × 16 drawn two points a pixel
	const { pattern, framed, icon } = I

	// --- drawing

	const TOOL = () => blit.height(FT) + (C.buttons === "soft" ? 26 : 14) * u
	const FOOT = () => blit.height(F) + (C.buttons === "soft" ? 14 : 10) * u
	const CELLW = 112 * u
	// an icon's side, as the theme's icons are (I.size(), points)
	const ICON = () => I.size() * u
	const CELLH = () => ICON() + 10 * u + 2 * blit.height(F) + 8 * u
	const cols = () => Math.max(1, Math.floor((W - 16 * u) / CELLW))
	const fitted = (text, w, font) => {
		const n = blit.fit(text, w, font)
		return n >= text.length ? text : text.slice(0, Math.max(0, n - 1)) + "…"
	}
	// a name in at most two lines of w, as the Finder's: broken after the last space that fits, else where it
	// fills the line; the rest cut with … if it is longer still
	const wrapped = (text, w, font) => {
		const n = blit.fit(text, w, font)
		if (n >= text.length) return [text]
		const space = text.lastIndexOf(" ", n)
		const at = space > 0 ? space + 1 : Math.max(1, n)
		return [text.slice(0, at).trimEnd(), fitted(text.slice(at).trimStart(), w, font)]
	}

	// a and b mixed, t of a; a box with its corners rounded r, of fills and ellipses
	const mixed = (a, b, t) =>
		[16, 8, 0].reduce(
			(c, k) => c | (Math.round(((a >> k) & 255) * t + ((b >> k) & 255) * (1 - t)) << k),
			0,
		)
	const round = (f, x, y, w, h, r, color, clip) => {
		r = Math.max(0, Math.min(r, Math.floor((w - 1) / 2), Math.floor((h - 1) / 2)))
		blit.fill(f, x + r, y, w - 2 * r, h, color, clip)
		blit.fill(f, x, y + r, w, h - 2 * r, color, clip)
		if (r) {
			for (
				const [cx, cy] of [[x + r, y + r], [x + w - r - 1, y + r], [x + r, y + h - r - 1], [
					x + w - r - 1,
					y + h - r - 1,
				]]
			) blit.fillellipse(f, cx, cy, r, r, color, clip)
		}
	}
	// a soft shadow under a box on the paper: rounded boxes out from it, each fainter, down so none reaches above it
	// (each is solid, over what is under it: the paper's colour mixed in, not blended)
	const soft = (f, x, y, w, h, r, depth) => {
		for (let i = depth; i >= 1; i--) {
			round(
				f,
				x - i,
				y - i + depth,
				w + 2 * i,
				h + 2 * i,
				r + i,
				mixed(C.ink, C.paper, 0.1 * (1 - i / (depth + 1)) ** 2),
			)
		}
	}
	// Windows 98's raised edge round a box: lit above and left, dark below and right, a point each, twice; sunk, the
	// other way round (a field)
	const raised = (f, x, y, w, h, sunk = false) => {
		const lit = [C.hi, C.light], dark = [C.dark, C.lo]
		for (let k = 0; k < 2; k++) {
			const a = sunk ? dark[1 - k] : lit[k], b = sunk ? lit[1 - k] : dark[k]
			blit.fill(f, x + k * u, y + k * u, w - 2 * k * u, u, a)
			blit.fill(f, x + k * u, y + k * u, u, h - 2 * k * u, a)
			blit.fill(f, x + k * u, y + h - (k + 1) * u, w - 2 * k * u, u, b)
			blit.fill(f, x + w - (k + 1) * u, y + k * u, u, h - 2 * k * u, b)
		}
	}
	// a button, as the theme's buttons are: a default one ringed (System 7's OK, Windows 98's), or in candy floss
	const button = (f, x, y, label, act, on = true, ring = false) => {
		if (C.buttons !== "soft") {
			const w = blit.measure(label, FT) + 20 * u, h = blit.height(FT) + 8 * u
			if (C.buttons === "raised") {
				// raised, its face the chrome; a default one in a line besides
				if (ring) blit.frame(f, x - u, y - u, w + 2 * u, h + 2 * u, C.dark)
				blit.fill(f, x, y, w, h, C.chrome)
				raised(f, x, y, w, h)
			} else {
				// a square with a hard 90s bevel; a default one ringed, as System 7's OK is
				if (ring) {
					blit.fill(f, x - 3 * u, y - 3 * u, w + 6 * u, h + 6 * u, C.line)
					blit.fill(f, x - u, y - u, w + 2 * u, h + 2 * u, C.chrome)
				}
				blit.fill(f, x, y, w, h, C.line)
				blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
				blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
				blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
			}
			blit.text(f, x + 10 * u, y + 4 * u, label, on ? C.ink : C.dim, undefined, undefined, FT)
			zones.push({ x, y, w, h, act: on ? act : null, role: "button", label })
			return x + w
		}
		// catclock's: white, its corners round, a hairline round it and a shadow a point under; one that cannot be
		// pressed faint; a default one in candy floss, pink to blue
		const w = blit.measure(label, FT) + 24 * u, h = blit.height(FT) + 10 * u, r = 8 * u
		round(f, x, y + u, w, h, r, mixed(C.ink, C.paper, 0.08))
		round(
			f,
			x - u,
			y - u,
			w + 2 * u,
			h + 2 * u,
			r + u,
			ring ? mixed(0xe678aa, C.paper, 0.45) : C.hair,
		)
		if (ring) {
			// the gradient across, a column at a time, each as tall as the corners let it be
			for (let i = 0; i < w; i++) {
				const t = i / Math.max(1, w - 1),
					c = t < 0.5
						? mixed(0xffd9eb, 0xffc9e2, t * 2)
						: mixed(0xcfe6ff, 0xffd9eb, (t - 0.5) * 2)
				const d = i < r ? r - i - 0.5 : i >= w - r ? i - (w - r) + 0.5 : 0,
					inset = d > 0 ? Math.round(r - Math.sqrt(Math.max(0, r * r - d * d))) : 0
				blit.fill(f, x + i, y + inset, 1, h - 2 * inset, c)
				blit.fill(
					f,
					x + i,
					y + inset,
					1,
					Math.floor((h - 2 * inset) * 0.55),
					mixed(0xffffff, c, 0.45),
				)
			}
		} else round(f, x, y, w, h, r, 0xffffff)
		blit.text(
			f,
			x + 12 * u,
			y + 5 * u,
			label,
			on ? C.ink : mixed(C.ink, 0xffffff, 0.4),
			undefined,
			undefined,
			FT,
		)
		zones.push({ x, y, w, h, act: on ? act : null, role: "button", label })
		return x + w
	}
	// the arrow up: a round button, as catclock's Files' back and forward (white, a hairline round it, its chevron
	// pointing back), with soft buttons; else a button of ◀
	const back = (f, x, y, act, on) => {
		if (C.buttons !== "soft") return button(f, x, y, "◀", act, on)
		const d = blit.height(FT) + 10 * u, r = Math.floor(d / 2)
		blit.fillellipse(f, x + r, y + r + u, r, r, mixed(C.ink, C.paper, 0.06))
		blit.fillellipse(f, x + r, y + r, r + u, r + u, C.hair)
		blit.fillellipse(f, x + r, y + r, r, r, 0xffffff)
		const k = Math.round(r * 0.32),
			ink = on ? C.ink : mixed(C.ink, 0xffffff, 0.4),
			lw = Math.max(1, Math.round(1.6 * u))
		blit.line(f, x + r + Math.round(k / 2), y + r - k, x + r - Math.round(k / 2), y + r, lw, ink)
		blit.line(f, x + r - Math.round(k / 2), y + r, x + r + Math.round(k / 2), y + r + k, lw, ink)
		zones.push({ x, y, w: d, h: d, act: on ? act : null, role: "button", label: "up" })
		return x + d
	}

	// what the toolbar holds, here: the arrow up, then what can be done
	const tools = (v) => {
		const e = chosen(v)
		if (s.preview) {
			const on = same(v.desk, s.preview)
			return [
				["Set as Desktop", "desktop", !on],
				["Plain Desk", "plain", !!v.desk],
				["Paint", "paint", isPicture(v.picture)],
				["Edit", "edit", true],
			]
		}
		const trash = same(v.path, TRASH)
		return [
			["New Note", "note", !v.refused],
			["New Folder", "folder", !v.refused],
			["New Picture", "picture", !v.refused],
			["New C Program", "program", !v.refused],
			["Rename", "rename", !!e],
			[trash ? "Delete" : "Trash", "trash", !!e && e.kind !== "trash"],
			...(trash ? [["Empty Trash", "empty", v.entries.length > 0]] : []),
			["Connect…", "connect", !v.refused],
			...(e?.kind === "picture"
				? [["Paint", "paint", true], [
					"Set as Desktop",
					"desktop",
					!same(v.desk, [...v.path, e.name]),
				]]
				: []),
		]
	}

	const chosen = (v) => v.entries.find((e) => e.name === s.chosen) ?? null

	const draw = (v) => {
		zones = []
		const f = blit.list(W, H, C.paper)
		const top = TOOL(), foot = FOOT()
		// the body: a picture shown, or the folder's icons, where its layout has them (the toolbar drawn over them)
		const body = { x: 0, y: top, w: W, h: H - top - foot }
		if (s.preview) {
			const p = v.picture
			if (isPicture(p)) {
				if (p.tile) blit.tile(f, 0, top, W, body.h, pattern(p, 4 * u), "copy", body)
				else {
					blit.fill(f, 0, top, W, body.h, C.desk)
					framed(f, p, 24 * u, top + 24 * u, W - 48 * u, body.h - 48 * u)
				}
			} else {blit.text(
					f,
					16 * u,
					top + 16 * u,
					"this is not a picture any more",
					C.dim,
					undefined,
					undefined,
					F,
				)}
		} else if (v.refused) {
			blit.text(f, 16 * u, top + 16 * u, v.refused, C.cherry, undefined, body, F)
		} else if (!v.entries.length) {
			const empty = same(v.path, TRASH)
				? "the Trash is empty"
				: "nothing here yet: New Note, or New Folder"
			blit.text(
				f,
				Math.floor((W - blit.measure(empty, F)) / 2),
				top + 40 * u,
				empty,
				C.dim,
				undefined,
				undefined,
				F,
			)
		} else {
			const ch = CELLH()
			const rows = Math.ceil((Math.max(...[...v.spots.values()].map((p) => p[1])) + ch) / ch),
				seen = Math.max(1, Math.floor(body.h / ch))
			s.scroll = Math.max(0, Math.min(s.scroll, rows - seen))
			v.entries.forEach((e) => {
				const [cx, sy] = v.spots.get(e.key), cy = top + sy - s.scroll * ch
				if (cy > H - foot || cy + ch < top) return
				const on = e.name === s.chosen
				icon(f, e, cx + Math.floor((CELLW - ICON()) / 2), cy, on)
				const ly = cy + ICON() + 6 * u
				let lx = 0
				wrapped(e.name, CELLW - 12 * u, F).forEach((label, i) => {
					const lw = blit.measure(label, F),
						x = cx + Math.floor((CELLW - lw) / 2),
						y = ly + i * blit.height(F)
					if (i === 0) lx = x
					// the label selected in pick, its words in pickInk (on a pill, as catclock's chosen tile's, or a box, as
					// System 7's inverted name); changed while it was away, on lemon, as catclock's fresh things glow
					const fresh = v.marked?.has(e.ids[0])
					if ((on || fresh) && C.pill) {
						round(
							f,
							x - 8 * u,
							y - u,
							lw + 16 * u,
							blit.height(F) + 2 * u,
							Math.floor(blit.height(F) / 2) + u,
							on ? C.pick : C.lemon,
							body,
						)
					} else if (on || fresh) {
						blit.fill(
							f,
							x - 3 * u,
							y - u,
							lw + 6 * u,
							blit.height(F) + 2 * u,
							on ? C.pick : C.lemon,
							body,
						)
					}
					blit.text(
						f,
						x,
						y,
						label,
						on ? C.pickInk : e.kind === "pending" ? C.dim : C.ink,
						undefined,
						body,
						F,
					)
				})
				// changed while it was away, from another device: a dot of cherry before its lemon label
				if (v.marked?.has(e.ids[0])) {
					blit.fillellipse(
						f,
						lx - 14 * u,
						ly + Math.floor(blit.height(F) / 2),
						2 * u,
						2 * u,
						C.cherry,
					)
				}
				const zy = Math.max(cy, top)
				zones.push({
					x: cx,
					y: zy,
					w: CELLW,
					h: Math.min(cy + ch, H - foot) - zy,
					act: "entry",
					e,
					role: "button",
					label: `${e.name}, ${describe(e)}${on ? ", selected" : ""}${
						v.marked?.has(e.ids[0]) ? ", changed while away" : ""
					}`,
				})
			})
		}
		// the toolbar: the chrome, a line under it (the hairline where there is one)
		blit.fill(f, 0, 0, W, top, C.chrome)
		blit.fill(f, 0, top - u, W, u, C.hair)
		const sb = C.buttons === "soft"
		const by = sb ? Math.floor((top - u - (blit.height(FT) + 10 * u)) / 2) : 4 * u
		let x = back(f, sb ? 12 * u : 6 * u, by, "up", s.preview || v.path.length > 0) +
			(sb ? 12 : 10) * u
		for (const [label, act, on] of tools(v)) {
			x = button(f, x, by, label, act, on) + (sb ? 8 : 6) * u
		}
		// the path bar: each folder above, a click goes there; and what is selected, or what happened
		// the path, as catclock's crumbs: each folder above a click away, the last on a pink pill
		const fy = H - foot
		blit.fill(f, 0, fy, W, foot, C.chrome)
		blit.fill(f, 0, fy, W, u, C.hair)
		const crumbs = s.preview ?? v.path
		const lh = blit.height(F), ty = fy + Math.floor((foot - lh) / 2)
		let px = 8 * u
		// with pills (catclock's crumbs) the last on a pink pill; else each name, a ▸ between
		const crumb = (label, to, last) => {
			const w = blit.measure(label, F) + (C.pill ? 16 : 0) * u
			if (last && C.pill) round(f, px, ty - u, w, lh + 2 * u, Math.floor(lh / 2) + u, C.select)
			blit.text(
				f,
				px + (C.pill ? 8 : 0) * u,
				ty,
				label,
				last || !C.pill ? C.ink : C.ink2,
				undefined,
				undefined,
				F,
			)
			zones.push({
				x: px,
				y: fy,
				w,
				h: foot,
				act: "go",
				to,
				role: "link",
				label: "/" + to.join("/"),
			})
			px += w
		}
		crumb(C.pill ? "/" : " / ", [], !crumbs.length)
		crumbs.forEach((n, i) => {
			px = blit.text(f, px, ty, C.pill ? "›" : " ▸ ", C.dim, undefined, undefined, F)
			crumb(n, crumbs.slice(0, i + 1), i === crumbs.length - 1)
		})
		const e = chosen(v)
		const said = s.note ??
			(s.preview
				? null
				: e
				? [`${e.name}: ${describe(e)}`, C.dim]
				: [`${v.entries.length} ${v.entries.length === 1 ? "item" : "items"}`, C.dim])
		if (said) {
			const text = fitted(said[0], Math.max(0, W - px - 24 * u), F)
			blit.text(
				f,
				W - (C.pill ? 12 : 8) * u - blit.measure(text, F),
				ty,
				text,
				said[1] === C.dim && C.pill ? C.ink2 : said[1],
				undefined,
				undefined,
				F,
			)
		}
		if (s.dialog) sheet(f)
		return f.ops
	}

	// a dialog: a card on top, round, its shadow soft, its fields, Cancel and the default button
	const sheet = (f) => {
		const d = s.dialog, lh = blit.height(F), fh = lh + 8 * u
		const w = Math.min(W - 40 * u, 420 * u),
			h = 20 * u + lh + 12 * u + d.fields.length * (lh + fh + 14 * u) + blit.height(FT) + 24 * u
		const x = Math.floor((W - w) / 2), y = Math.max(TOOL() + 10 * u, Math.floor((H - h) / 3))
		// everything under it takes no clicks
		zones = [{ x: 0, y: 0, w: W, h: H, act: null }]
		if (C.buttons === "soft") {
			soft(f, x, y, w, h, 14 * u, 12 * u)
			round(f, x - u, y - u, w + 2 * u, h + 2 * u, 15 * u, C.hair)
			round(f, x, y, w, h, 14 * u, C.paper)
		} else if (C.buttons === "raised") {
			blit.fill(f, x, y, w, h, C.chrome)
			raised(f, x, y, w, h)
		} else {
			// System 7's: a box on top, a hard shadow, its frame doubled
			blit.fill(f, x + 3 * u, y + 3 * u, w, h, C.line)
			blit.fill(f, x, y, w, h, C.paper)
			for (let i = 0; i < 2 * u; i++) blit.frame(f, x + i, y + i, w - 2 * i, h - 2 * i, C.line)
			blit.frame(f, x + 4 * u, y + 4 * u, w - 8 * u, h - 8 * u, C.line)
		}
		let fy = y + 16 * u
		blit.text(f, x + 16 * u, fy, d.title, C.ink, undefined, { x, y, w: w - 16 * u, h }, FT)
		fy += lh + 12 * u
		s.caret = null
		d.fields.forEach((field, i) => {
			blit.text(f, x + 16 * u, fy, field.label, C.dim, undefined, undefined, F)
			fy += lh + 4 * u
			const box = { x: x + 16 * u, y: fy, w: w - 32 * u, h: fh }
			// a field: soft, white and round, the one typed in ringed in blue, as catclock's focus; raised buttons', sunk;
			// else a line round it
			const on = i === d.at
			if (C.buttons === "soft") {
				round(
					f,
					box.x - (on ? 2 * u : u),
					box.y - (on ? 2 * u : u),
					box.w + (on ? 4 : 2) * u,
					box.h + (on ? 4 : 2) * u,
					8 * u + (on ? 2 : 1) * u,
					on ? C.blue : C.line,
				)
				round(f, box.x, box.y, box.w, box.h, 8 * u, 0xffffff)
			} else if (C.buttons === "raised") {
				blit.fill(f, box.x, box.y, box.w, box.h, 0xffffff)
				raised(f, box.x, box.y, box.w, box.h, true)
			} else {
				blit.fill(f, box.x, box.y, box.w, box.h, C.line)
				blit.fill(f, box.x + u, box.y + u, box.w - 2 * u, box.h - 2 * u, C.hi)
			}
			const clip = { x: box.x + u, y: box.y, w: box.w - 2 * u, h: box.h }
			// the text from where the caret shows, the selection on lemon, the caret at pos (a readline field)
			const t = field.text, room = box.w - 12 * u
			let from = 0
			while (on && from < field.pos && blit.measure(t.slice(from, field.pos), F) > room) from++
			const xAt = (k) => box.x + 6 * u + blit.measure(t.slice(from, Math.max(from, k)), F)
			const sel = on ? readline.selection(field) : null
			if (sel) {
				blit.fill(
					f,
					xAt(sel[0]),
					box.y + 3 * u,
					Math.max(u, xAt(sel[1]) - xAt(sel[0])),
					lh + 2 * u,
					C.select,
					clip,
				)
			}
			blit.text(f, box.x + 6 * u, box.y + 4 * u, t.slice(from), C.ink, undefined, clip, F)
			if (on) {
				const cx = Math.min(box.x + box.w - 4 * u, xAt(field.pos))
				blit.fill(f, cx, box.y + 4 * u, 2 * u, lh, C.rose)
				s.caret = { text: t, pos: field.pos, x: cx, y: box.y + 4 * u, h: lh }
			}
			zones.push({
				...box,
				act: "field",
				i,
				from,
				role: "textfield",
				label: field.label,
				value: field.text,
			})
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
			label: "My Computer",
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
		input: s.dialog && s.caret
			? {
				text: s.caret.text,
				selection: [s.caret.pos, s.caret.pos],
				caret: { x: s.caret.x, y: s.caret.y, w: 2 * u, h: s.caret.h },
			}
			: null,
	})

	// --- where icons sit: the folder's layout (icons.layout.at(its id), /apps/computer/layout/<id>), its icons,
	// points from the body's top left, unscrolled; none there, the grid, across then down, as the window is wide.
	// A drag is the slot trick (front): the layout in front while it moves, written once when it is let go, every
	// icon where it is shown, so the folder is arranged from then on. A new node in a folder arranged gets the first
	// free place, written, so another going does not move it
	const cell = () => ({ w: CELLW, h: CELLH() })
	const slot = (i) => {
		const n = cols()
		return [
			Math.floor((W - n * CELLW) / 2) + (i % n) * CELLW,
			8 * u + Math.floor(i / n) * CELLH(),
		]
	}
	const spotsOf = (v) => {
		const saved = {}
		for (const [id, p] of Object.entries(v.layout?.icons ?? {})) {
			if (Array.isArray(p)) saved[id] = [Math.round(p[0] * u), Math.round(p[1] * u)]
		}
		return icons.spots(v.entries.map((e) => e.key), saved, slot, cell())
	}
	let held = null
	const slotted = (api) => {
		if (!shown.id) return null
		if (held?.id !== shown.id) held = { id: shown.id, front: front(icons.layout.at(shown.id)) }
		icons.layout.ready(api)
		return held.front
	}
	// the layout with every icon where it is shown, and these (id → spot, in pixels) where they are now
	const arranged = (moved) => {
		const all = new Map(shown.spots)
		for (const [id, p] of moved) all.set(id, p)
		return {
			...(shown.layout ?? {}),
			icons: Object.fromEntries(
				[...all].map(([id, p]) => [id, [Math.round(p[0] / u), Math.round(p[1] / u)]]),
			),
		}
	}
	const save = (api, moved) => {
		const value = arranged(moved)
		slotted(api)?.done(api, value)
		shown.layout = value
	}
	// a spot (pixels) kept whole in the body as it shows, scrolled: an icon let go lands in sight, not under a bar
	const fit = ([x, y]) => {
		const ch = CELLH(), top = s.scroll * ch, body = H - TOOL() - FOOT()
		return [Math.max(0, Math.min(W - CELLW, x)), Math.max(top, Math.min(top + body - ch, y))]
	}
	// the selected one into a folder (a path; the Trash): at a name not used there, moved, or linked (option-cmd);
	// one the folder holds already, linked, stays as it is (icons' into)
	const into = (api, e, at, linked = false) => {
		if ([...e.at, e.name].join("/") === at.join("/")) return null
		const linking = linked && !same(at, TRASH),
			had = linking && I.holds(api, at, e.ids[0]) !== null
		const n = I.into(api, e, at, linking)
		say(
			had
				? `${n} is in ${at.at(-1) ?? "/"} already`
				: `${n} ${linking ? "linked" : "is"} in ${at.at(-1) ?? "/"}`,
		)
		if (!linking) s.chosen = null
		return n
	}
	// Make Link (cmd-l): the selected placed again beside itself, "<name> link", the same node
	const link = (api, e) => {
		const n = free(api, shown.path, `${e.name} link`)
		I.link(api, e, ["/", ...shown.path], n)
		s.chosen = n
		say(`made ${n}`)
	}
	let press = null // {e, x, y, from, moved}: an icon held, to drag

	let shown = { path: HOME, entries: [], spots: new Map() }
	const paint = (api) => {
		if (!idAt(api, LAYER)) return
		shown = look(api)
		shown.desk = desktop(api)
		shown.picture = s.preview ? val(api, ["/", ...s.preview]) : null
		shown.trash = trash(api)
		shown.marked = away.at(
			api,
			shown.path,
			shown.entries.filter((e) => e.commit).map((e) => ({
				id: e.ids[0],
				lamport: e.commit.lamport,
			})),
		)
		if (s.chosen !== null && !shown.entries.some((e) => e.name === s.chosen)) s.chosen = null
		shown.spots = spotsOf(shown)
		const fresh = shown.layout?.icons && !press
			? shown.entries.filter((e) => !shown.layout.icons[e.key])
			: []
		if (fresh.length) save(api, new Map())
		const ops = draw(shown)
		const m = meaning()
		api.write(LAYER, [
			set("w", W),
			set("h", H),
			set("draw", ops),
			set("access", m.access),
			set("input", m.input),
			set("title", (s.preview ?? shown.path).at(-1) ?? "My Computer"),
		])
		keep(api)
		menus(api, shown)
	}

	// --- doing

	// started by the window manager's policy (/dev/wm/launch), so an editor outlives this window
	// part: what the part running was given: start and call are its own, not api's
	const start = I.start
	const edit = (part, path) => start(part, "edit", "programs/edit", { path })
	const paints = (part, path) => start(part, "paint", "programs/paint", { path })
	const go = (api, path) => {
		s.chosen = null
		s.scroll = 0
		s.preview = null
		s.note = null
		api.write(AT, whole({ path }))
	}
	const say = (text, bad) => (s.note = [text, bad ? C.cherry : C.ok])
	const why = (e) => `${e.code ?? "error"}: ${e.message}`
	const taken = (v, n) => v.entries.some((e) => e.name === n)
	// a name not yet used in a folder (n, n 2 …); a node from one name to another, the same node (the tool's)
	const free = I.free, shift = I.move

	const open = (part, e) => {
		if (!e) return
		const { api } = part
		const path = [...shown.path, e.name]
		if (e.kind === "folder" || e.kind === "trash") go(api, path)
		else if (e.kind === "picture") {
			s.preview = path
			s.note = null
		} else {
			// the rest as the desk opens them (the tool's): an application runs, /etc/keys in Keys, the rest in the editor
			const no = I.open(part, path, e)
			if (no) say(no, e.kind !== "pending")
		}
	}

	// shell.js's mount, by hand: a document this machine does not have is followed from the server
	const DOC = /^ermine:\/\/([0-9a-f]{64})$/
	const mount = (api, at, n, id) => {
		const time = api.insert(idAt(api, ["/", ...at]), n, id)
		const there = api.children(["/", ...at], n).find((i) => i.id === id)
		if (DOC.test(id) && !there?.node) {
			const hex = DOC.exec(id)[1],
				shared = ["/", "dev", "sync", "shared"],
				into = idAt(api, shared)
			if (into && !api.children(shared, hex).some((i) => i.id === id)) api.insert(into, hex, id)
			return `${n}: connected; arriving from the server, it shows when it comes`
		}
		return `${n}: connected, t=${time}`
	}
	// an id as a person pastes it: ermine://…, the bare hex, or any id as it is
	const normal = (text) => {
		const t = text.trim()
		return /^[0-9a-f]{64}$/i.test(t) ? `ermine://${t.toLowerCase()}` : t
	}

	// a dialog is data, so the view holds it: act names its answer (answers), name the entry it is about
	const ask = (act, title, ok, fields, more) => {
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
			...more,
		}
	}
	// each dialog's OK: null closes it, a string is what is wrong
	const named = (v, n, old) => {
		if (!n) return "a name, please"
		if (n.includes("/")) return "a name has no /"
		if (n !== old && taken(v, n)) return `there is already something called ${n}`
		return null
	}
	const act = (part, what) => {
		const { api } = part
		const v = shown, e = chosen(v)
		if (what === "up") {
			if (s.preview) {
				s.chosen = s.preview.at(-1)
				s.preview = null
			} else if (v.path.length) {
				const from = v.path.at(-1)
				go(api, v.path.slice(0, -1))
				s.chosen = from
			}
		} else if (what === "note" || what === "folder") {
			ask(what, what === "note" ? "A new note, called:" : "A new folder, called:", "Make", [[
				"Name",
				free(api, v.path, what === "note" ? "untitled note" : "untitled folder"),
			]])
		} else if (what === "picture") {
			// a blank one, 16 × 16, the ink in hand, to paint
			ask(what, "A new picture, called:", "Make", [[
				"Name",
				free(api, v.path, "untitled picture"),
			]])
		} else if (what === "program") {
			ask(what, "A new C program, called:", "Make", [[
				"Name",
				free(api, v.path, "untitled program"),
			]])
		} else if (what === "rename" && e) {
			ask(what, `Rename ${e.name} to:`, "Rename", [["Name", e.name]], { name: e.name })
		} else if (what === "trash" && e) {
			const at = ["/", ...v.path]
			if (same(v.path, TRASH)) {
				drop(api, at, e.name, e.ids[0])
				say(`${e.name} is gone`)
			} else if (same([...v.path, e.name], TRASH.slice(0, v.path.length + 1))) {
				return say(`${e.name} holds the Trash, so it stays`, true)
			} else {
				const n = free(api, TRASH, e.name)
				shift(api, e, ["/", ...TRASH], n)
				say(`${e.name} is in the Trash`)
			}
			s.chosen = null
		} else if (what === "empty") {
			ask(
				what,
				`Empty the Trash? The ${v.entries.length} ${
					v.entries.length === 1 ? "thing" : "things"
				} in it go for good.`,
				"Empty",
				[],
			)
		} else if (what === "connect") {
			ask(what, "Connect a node by its id", "Connect", [[
				"Id (ermine://…, as share prints it)",
				"",
			], ["Name it", ""]])
			s.dialog.fields.forEach((x) => (x.mark = null))
		} else if (what === "desktop") {
			const path = s.preview ?? (e ? [...v.path, e.name] : null)
			if (!path) return
			snap(api, DESK, path)
			say(`${path.at(-1)} is on the desk`)
		} else if (what === "plain") {
			api.write(DESK, whole(null))
			say("the desk is plain again")
		} else if (what === "edit") {
			const path = s.preview ?? (e ? [...v.path, e.name] : null)
			if (path) edit(part, path)
		} else if (what === "paint") {
			const path = s.preview ?? (e?.kind === "picture" ? [...v.path, e.name] : null)
			if (path) paints(part, path)
		}
	}
	// each dialog's OK, in the folder shown: null closes it, a string is what is wrong
	const answers = {
		note: (part, [n]) => made(part, "note", n),
		folder: (part, [n]) => made(part, "folder", n),
		picture: (part, [n]) => made(part, "picture", n),
		program: (part, [n]) => made(part, "program", n),
		rename: ({ api }, [n], d) => {
			const v = shown, e = v.entries.find((x) => x.name === d.name)
			if (!e) return `${d.name} is gone`
			if (n === e.name) return null
			const bad = named(v, n, e.name)
			if (bad) return bad
			// the new name where the old one was
			I.rename(api, e, n)
			s.chosen = n
			say(`renamed to ${n}`)
			return null
		},
		empty: ({ api }) => {
			for (const x of shown.entries) {
				for (const id of x.ids) drop(api, ["/", ...TRASH], x.name, id)
			}
			say("the Trash is empty")
			return null
		},
		connect: ({ api }, [id, n]) => {
			if (!normal(id)) return "an id, please: paste it with cmd-v"
			const bad = named(shown, n)
			if (bad) return bad
			say(mount(api, shown.path, n, normal(id)))
			s.chosen = n
			return null
		},
	}
	// a C program's first text: the template's, /lib/c/hello.c (the image's); none there, the least that runs
	const TEMPLATE = ["/", "lib", "c", "hello.c"]
	const template = (api) => {
		const t = val(api, TEMPLATE)
		return typeof t === "string"
			? t
			: '#include <ermine.h>\n\ner_value setup(void) {\n\treturn er_text("hello, world");\n}\n'
	}
	// a note, a folder, a picture or a C program made in the folder shown: a note or a program opens in the editor, a
	// picture in Paint
	const made = (part, what, n) => {
		const { api } = part, v = shown
		const bad = named(v, n)
		if (bad) return bad
		const value = what === "note"
			? ""
			: what === "folder"
			? null
			: what === "program"
			? template(api)
			: {
				kind: "picture",
				colors: { k: C.line },
				rows: Array.from({ length: 16 }, () => ".".repeat(16)),
			}
		make(api, ["/", ...v.path], n, value)
		// a program says what it needs: its loader is found by that (loader.c)
		if (what === "program") {
			api.set(["/", ...v.path, n], "ermine.program.provisions", whole({ needs: ["c"] }))
		}
		s.chosen = n
		say(`made ${n}`)
		if (what === "note" || what === "program") edit(part, [...v.path, n])
		if (what === "picture") paints(part, [...v.path, n])
		return null
	}
	const run = (part, what) => {
		try {
			act(part, what)
		} catch (e) {
			say(why(e), true)
		}
	}
	const answer = (part, ok) => {
		const d = s.dialog
		if (!ok) return void (s.dialog = null)
		try {
			d.error = answers[d.act]?.(part, d.fields.map((x) => x.text.trim()), d) ?? null
		} catch (e) {
			d.error = why(e)
		}
		if (!d.error) s.dialog = null
	}

	// --- the keyboard

	const typed = (r) => r.text && r.text >= " " && !/[\uf700-\uf8ff]/.test(r.text)

	const dialogKey = (part, r) => {
		const { api } = part, d = s.dialog, x = d.fields[d.at]
		if (r.key === "Escape") s.dialog = null
		else if (r.key === "Enter") answer(part, true)
		else if (r.key === "Tab" && d.fields.length) {
			d.at = (d.at + (r.mods?.includes("shift") ? d.fields.length - 1 : 1)) % d.fields.length
		} else if (x) {
			// readline's keys, the tool's: C-a, A-f, C-k, C-y, the arrows, shift and a move selects, cmd-c, cmd-v
			const next = readline.type(x, r, { select: true, api })
			if (next) {
				Object.assign(x, next)
				d.error = null
			}
		}
	}
	// an arrow: the nearest that way, where the icons are
	const move = (v, dx, dy) => {
		const id = icons.nearest(v.spots, chosen(v)?.key ?? null, dx, dy)
		pick(v, v.entries.findIndex((e) => e.key === id))
	}
	const pick = (v, to) => {
		if (!v.entries[to]) return
		s.chosen = v.entries[to].name
		// scrolled so the selected one shows
		const row = Math.floor((v.spots.get(v.entries[to].key)?.[1] ?? 0) / CELLH()),
			seen = Math.max(1, Math.floor((H - TOOL() - FOOT()) / CELLH()))
		if (row < s.scroll) s.scroll = row
		if (row >= s.scroll + seen) s.scroll = row - seen + 1
	}

	handler(given, "key", (part) => {
		const { api } = part, [recs] = part.args
		for (const r of recs) {
			if (r.event === "commit" && s.dialog) {
				const x = s.dialog.fields[s.dialog.at]
				if (x) Object.assign(x, readline.type(x, r))
				continue
			}
			if (!r.down) continue
			if (s.dialog) {
				dialogKey(part, r)
				continue
			}
			s.note = null
			const v = shown, cmd = r.mods?.includes("cmd"), shift = r.mods?.includes("shift")
			if (s.preview) {
				if (r.key === "Escape" || (cmd && r.key === "ArrowUp")) run(part, "up")
				else if (cmd && r.key === "e") run(part, "edit")
				else if (cmd && r.key === "p") run(part, "paint")
				continue
			}
			if (cmd && r.key === "ArrowUp") run(part, "up")
			else if (cmd && (r.key === "ArrowDown" || r.key === "o")) open(part, chosen(v))
			else if (cmd && r.key === "n") run(part, shift ? "folder" : "note")
			else if (cmd && r.key === "N") run(part, "folder")
			else if (cmd && (r.key === "Backspace" || r.key === "Delete")) run(part, "trash")
			else if (cmd && r.key === "k") run(part, "connect")
			else if (cmd && r.key === "e") run(part, "edit")
			else if (cmd && r.key === "p") run(part, "paint")
			else if (cmd && r.key === "l" && chosen(v) && chosen(v).kind !== "trash") {
				try {
					link(api, chosen(v))
				} catch (e) {
					say(why(e), true)
				}
			} else if (cmd) continue
			else if (r.key === "Enter") run(part, "rename")
			else if (r.key === "ArrowLeft") move(v, -1, 0)
			else if (r.key === "ArrowRight") move(v, 1, 0)
			else if (r.key === "ArrowUp") move(v, 0, -1)
			else if (r.key === "ArrowDown") move(v, 0, 1)
			else if (r.key === "Escape") s.chosen = null
			else if (typed(r)) {
				// type to select, as the Finder does
				const i = v.entries.findIndex((e) =>
					e.name.toLowerCase().startsWith(r.text.toLowerCase())
				)
				pick(v, i)
			}
		}
		paint(api)
	})

	// a menu's item with no key: what a button does, or home; Empty Trash, away from the Trash, goes there first
	handler(given, "menu", (part) => {
		const { api } = part, [what] = part.args
		if (what === "home") go(api, HOME)
		else if (what === "apps") go(api, ["Applications"])
		else if (what === "keys") start(part, "keys", "programs/keys")
		// each icon to the nearest place on the grid, written
		else if (what === "clean" && !s.preview) save(api, icons.clean(shown.spots, slot, cell()))
		else if (what === "empty" && !same(shown.path, TRASH)) go(api, TRASH)
		else run(part, what)
		paint(api)
	})

	// --- the pointer: a click on a zone does what it says; two on one icon open it; the wheel scrolls, a trackpad's
	// pixels kept until they make a row
	let rest = 0
	handler(given, "pointer", (part) => {
		const { api } = part, [recs] = part.args
		for (const r of recs) {
			if (r.event === "scroll" && !s.dialog) {
				rest += r.dy / CELLH()
				const n = Math.trunc(rest)
				rest -= n
				s.scroll = Math.max(0, s.scroll + n)
				continue
			}
			// an icon held and dragged (the layer takes drags: every move and the up, from wmii): it goes with the hand
			if (r.event === "move" && press) {
				const dx = r.x - press.x, dy = r.y - press.y
				if (!press.moved && Math.hypot(dx, dy) < 4 * u) continue
				press.moved = true
				slotted(api)?.put(
					api,
					arranged([[press.e.key, [press.from[0] + dx, press.from[1] + dy]]]),
				)
				continue
			}
			if (r.event === "up" && press) {
				const was = press
				press = null
				if (!was.moved) continue
				// a drag is no click: the next on it is a first, not a double click that opens it
				s.click = { name: null, t: 0 }
				// let go over another window, or the desk: that one takes it (its on/drop, icons.dropped), into the folder under
				// the hand there, or its own, where it was let go; one that takes no drops, it goes back. Here, over a folder or
				// the Trash (not its own icon, which the drag has moved there): into it; else where it was let go, kept in sight
				// (fit). Option-cmd: a link there
				const linked = ["alt", "cmd"].every((m) => r.mods?.includes(m) || was.mods?.includes(m))
				const win = val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])
				const under = win ? icons.dropped(api, win.x + r.x, win.y + r.y) : null
				try {
					if (under && under.layer !== LAYER.at(-1)) {
						slotted(api)?.done(api)
						if (!under.drop) continue
						if (was.e.kind === "trash") {
							say("the Trash stays where it is", true)
							continue
						}
						// the hand on the icon as it was held: from its top left
						const grip = [
							was.x - was.from[0] - Math.floor((CELLW - ICON()) / 2),
							was.y - was.from[1] - TOOL() + s.scroll * CELLH(),
						]
						part.call(under.drop, [{
							items: [{ at: was.e.at, name: was.e.name, id: was.e.ids[0], grip }],
							x: win.x + r.x,
							y: win.y + r.y,
							linked,
						}])
						if (!linked) s.chosen = null
						continue
					}
					const z = [...zones].reverse().find((z) =>
						!(z.act === "entry" && z.e.key === was.e.key) && r.x >= z.x && r.x < z.x + z.w &&
						r.y >= z.y && r.y < z.y + z.h
					)
					const to = z?.act === "entry" && (z.e.kind === "folder" || z.e.kind === "trash")
						? z.e
						: null
					if (to) {
						slotted(api)?.done(api)
						into(api, was.e, to.kind === "trash" ? TRASH : [...shown.path, to.name], linked)
					} else if (r.x >= 0 && r.y >= 0 && r.x < W && r.y < H) {
						save(api, [[
							was.e.key,
							fit([was.from[0] + r.x - was.x, was.from[1] + r.y - was.y]),
						]])
					} else slotted(api)?.done(api)
				} catch (e) {
					say(why(e), true)
				}
				continue
			}
			if (r.event !== "down") continue
			const z = [...zones].reverse().find((z) =>
				r.x >= z.x && r.x < z.x + z.w && r.y >= z.y && r.y < z.y + z.h
			)
			if (!s.dialog) s.note = null
			if (!z) {
				if (!s.dialog) s.chosen = null
				continue
			}
			if (z.act === "entry") {
				const now = Date.now(), twice = s.click.name === z.e.name && now - s.click.t < 500
				s.chosen = z.e.name
				s.click = { name: z.e.name, t: twice ? 0 : now }
				if (twice) open(part, z.e)
				else if (!s.dialog && shown.spots.get(z.e.key)) {
					press = {
						e: z.e,
						x: r.x,
						y: r.y,
						mods: r.mods,
						from: shown.spots.get(z.e.key),
						moved: false,
					}
				}
			} else if (z.act === "go") go(api, z.to)
			else if (z.act === "field") {
				// the caret where the click is
				const x = s.dialog.fields[z.i]
				s.dialog.at = z.i
				Object.assign(x, {
					pos: z.from + blit.at(x.text.slice(z.from), r.x - z.x - 6 * u, F),
					mark: null,
				})
			} else if (z.act === "ok" || z.act === "cancel") answer(part, z.act === "ok")
			else if (z.act) run(part, z.act)
		}
		paint(api)
	})

	// icons dropped here from another window or the desk (icons.dropped): [{items, x, y, linked}], x, y on the screen,
	// each item {at, name, id, grip}. Over a folder or the Trash, into it; else into the folder shown, each where it was
	// let go, the hand on it where it held it, kept in sight (fit). Linked (option-cmd), a link there. While a dialog is
	// open, or a picture shows, it takes none: they stay where they were
	handler(given, "drop", (part) => {
		const { api } = part, [d] = part.args
		s.note = null
		try {
			// the dialog's own word, so it goes with it
			if (s.dialog) s.dialog.error = "finish this first"
			else if (s.preview) say("a picture takes nothing: go up to its folder", true)
			else {
				const win = val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])
				const x = d.x - (win?.x ?? 0), y = d.y - (win?.y ?? 0)
				const z = [...zones].reverse().find((z) =>
					x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h
				)
				const to = z?.act === "entry" && (z.e.kind === "folder" || z.e.kind === "trash")
					? z.e
					: null
				const at = to ? (to.kind === "trash" ? TRASH : [...shown.path, to.name]) : shown.path
				const linked = !!d.linked && !same(at, TRASH)
				const went = I.land(api, d.items, at, linked)
				const ok = went.filter((w) => w.to !== undefined), bad = went.find((w) => w.error)
				if (!to && ok.length) {
					const v = look(api), g = (w) => w.grip ?? [16 * u, 16 * u], top = s.scroll * CELLH()
					const moved = ok.map((
						w,
					) => [
						v.entries.find((e) => e.name === w.to && e.ids[0] === w.id)?.key,
						fit([x - g(w)[0] - Math.floor((CELLW - ICON()) / 2), y - g(w)[1] - TOOL() + top]),
					]).filter(([k]) => k)
					if (moved.length) save(api, moved)
					s.chosen = ok.at(-1).to
				}
				// what came: moved from another folder, or linked anew; what was here already, linked again, or dropped on the
				// folder it is in. Those only moved about in the folder shown, from another window of it, say nothing
				const came = ok.filter((w) => (linked ? !w.already : !same(w.at, at)))
				const had = ok.filter((w) => (linked ? w.already : to && same(w.at, at)))
				const are = (ws) => (ws.length > 1 ? "are" : "is")
				if (bad) say(bad.error, true)
				else if (came.length) {
					say(
						`${came.map((w) => w.to).join(", ")} ${linked ? "linked" : are(came)} in ${
							at.at(-1) ?? "/"
						}`,
					)
				} else if (had.length) {
					say(`${had.map((w) => w.to).join(", ")} ${are(had)} in ${at.at(-1) ?? "/"} already`)
				}
			}
		} catch (e) {
			say(why(e), true)
		}
		paint(api)
	})

	// --- following the graph: the folder shown, its names, the look; painted at most ten times a second

	let last = 0, waiting = false, cancel = null
	onCleanup(({ api }) => cancel?.(api))
	onCleanup(({ api }) => away.leave(api))
	// closed: the folder's window, where it was, in its layout, so the folder opens there again
	onCleanup(({ api }) => {
		// where the compositor has it, or, its layer let go with this process, where the window manager last had it
		const w = [["/", "dev", "display", "windows", LAYER.at(-1)], [
			"/",
			"dev",
			"wm",
			"client",
			LAYER.at(-1),
		]].map((address) => val(api, address)).find((v) => Number.isFinite(v?.x))
		if (!w || !shown.id || s.preview) return
		const window = Object.fromEntries(["x", "y", "w", "h"].map((k) => [k, Math.round(w[k] / u)]))
		icons.layout.ready(api)
		const at = icons.layout.at(shown.id)
		if (idAt(api, at)) api.write(at, [set("window", window)])
		else make(api, at.slice(0, -1), at.at(-1), { window })
	})
	effect(given, "follow", ({ api }) => {
		const path = val(api, AT)?.path ?? HOME
		let names = null
		try {
			// each name, its members, and how many names it holds: a folder filling shows as one
			names = api.children(["/", ...path]).map((n) => {
				let kids = null
				try {
					kids = api.children(["/", ...path, n]).length
				} catch {
					// refused: drawn as such
				}
				return [
					n,
					api.children(["/", ...path], n).map((i) => `${i.id}${i.node ? "" : "…"}`),
					kids,
				]
			})
		} catch {
			// refused: drawn as such
		}
		// its layout: a drag elsewhere (the desk's, another window's) moves the icons here too
		const id = icons.folder(api, path)
		return {
			path,
			names,
			layout: id ? val(api, icons.layout.at(id)) ?? null : null,
			theme: val(api, ["/", "etc", "theme"]) ?? null,
			desk: desktop(api),
			trash: trash(api),
			fonts: fonts(api),
		}
	}, (part) => {
		const { value: v, api } = part
		if (v.theme) colours(v.theme)
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
	// what it was started with (see open0): its first value; none by a moment, it opens at home
	effect(given, "start", ({ api }) => val(api, [...me, "data"]) ?? null, (part) => {
		const { value, api } = part
		if (value) {
			open0(api, value)
			paint(api)
		} else if (!started) {
			after(part, 100, ({ api }) => {
				open0(api, null)
				paint(api)
			})
		}
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
	// draws or moves; so a window moving reads that and no more (deep: the same want, made again, is no new value)
	effect(
		given,
		"size",
		({ api }) => val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want ?? null,
		({ value: want, api }) => {
			if (!want) return
			W = Math.max(320 * u, want.w)
			H = Math.max(200 * u, want.h)
			paint(api)
		},
		{ deep: true },
	)
}
