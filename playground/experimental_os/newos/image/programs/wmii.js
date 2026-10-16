// /programs/wmii: the window manager's core, after wmii's architecture,
// which is Plan 9's: the window manager is a file server. It has no policy
// (what keys do, what the bar says, what a click on the root opens are
// wmiirc's and the status program's) and serves all it keeps as nodes in its
// ".", /dev/wm, as rio serves /dev/wsys and wmii serves /:
//
//   ctl          the address of its "ctl" handler, which takes a line, as wctl does:
//                  view <tag> | select next|prev|<id> | raise [id] | lower [id]
//                  move [id] <x> <y> | resize [id] <w> <h> | kill [id] | tag [id] <tag>[+<tag>...]
//                  minimize [id] | restore [id] (none: the last minimized in view)
//                  layout float|tile|toggle, and while tiled: select left|right|up|down,
//                  send sel left|right|up|down, colmode sel default|stack|max
//                  run <command>: a Run event, {command}, which wmiirc runs (a menu item's run)
//   event        {n, events}: the last 64, each {n, type, ...}: CreateClient, DestroyClient,
//                FocusClient, CreateTag, DestroyTag, FocusTag, Key, Run, LeftBarClick,
//                RightBarClick, ClientClick, RootClick, TaskBarClick
//   view         the tag shown
//   tag/<name>   its layout, its columns and the one selected (col) when tiled; its clients are those whose
//                tags hold it, front first by z
//   client/<id>  {label, tags, owner, x, y, w, h, n, z, sized, mini?, start?, pid?, node?, away?}:
//                n its place in the task bar, z in the stack, mini the order it was minimized in; start
//                what launch was given, pid and node its process; away while its window is not here (after
//                a boot, or its process killed), until launch brings it back. The focus is the front one
//   lbar, rbar   bar items, {text, fg?, bg?, from?}, placed by anyone: lbar's at the task bar's left, rbar's at
//                the menu bar's right; fg and bg an /etc/theme key (mint) or a colour, from the node a reading reads
//   menu         the menu pulled down from the menu bar, {client, menu, x} (menu 0 the rabbit's), or null
//   menu/at      the rows lit in it, a path, each one with items opening its submenu, or null: a node of its
//                own, so the pointer going down a menu writes only it
//   hand         what the pointer is doing: {drag?, grab?, pick?, held?, hovered?}
//   launch       the address of its "launch" handler, which takes a start, {address, program, name?, data?},
//                program a path (["programs", "term"], or "programs/term"), data written into the process as
//                its node "data"; and starts it as its child, named as start names it, else by its pid, kept; with a place,
//                {client} an away client's id, or {x, y, w, h, sized, tags}, the window the program opens
//                goes there, not where it asks
//   coming       each launch whose window has not come, by pid: {start, node, client?}
//
// The Mac's menu bar shows what this one does: it writes /dev/display/menus, {n, menus}, the same
// menus, the world menu first, which the compositor sends to the metal; an item chosen there,
// /dev/display/chosen, is what choosing it here is.
//
// view, tag and client are documents, kept on the card: what the window manager holds is there, and
// this process only a copy of it, written back once a call; started again (after a boot, or killed and
// started), it takes them up; written by another (a shell's set, the inspector), it takes them up as ctl's
// doings. A client is written when it opens, closes, is clicked or focused, or ctl
// moves, resizes, tags or minimizes it. A drag, a move or a resize, is the slot trick (front, from
// kit): its client, each move, into an ephemeral item in front of its document, so whoever reads it
// sees the window go; the document written once, when the hand has rested REST ms after the button is
// up. The rest are ephemeral. wmiirc starts each away client again, through launch
//
// Two bars, a menu bar as System 7's and a task bar, a dock as catclock's. The menu bar, at the top, of
// frosted glass: its menus, the world menu first, drawn as the rabbit, then the focused window's; rbar's
// items at the right, quiet, the clock in a tray (its bg a pair of colours). A program's
// menus are a node in its own, the window's owner: <owner>/menus,
//   [{title, items: [{label, key?, call?, args?, run?, off?, check?, items?, from?} | "-"]}]
// and the world menu's items are /etc/menu, a document, [item | "-"], items as these. An item with
// call calls <owner>/on/<call> (or call, an address) with args; one with run runs a command as
// /etc/keys has them (a Run event, which wmiirc runs); one with only key is that chord pressed, as
// if typed: a chord in /etc/keys the wm's, any other the window's. Beside one that runs a command,
// the chord /etc/keys binds to it, else its key; off, greyed; check, {from, key?}, ticked while the
// node from reads (its key) true. A submenu: items, or from, a folder whose nodes that say what they
// run ({run, icon?}: /Applications) are its items, by name. A title pressed pulls its menu down: a
// click on an item, or the button let go over one, chooses it; an item with items, hovered or
// clicked, opens them beside it; Escape or a click elsewhere lets it go. Menus are cards, round, their
// shadows soft (a layer's shape, which the compositor rounds). The task bar, a pill floating in the
// middle at the bottom, as wide as it holds: lbar's items (wmiirc's tags) a segmented control, then a
// button for each window in view, in the order they came; a click focuses one, restores a minimized
// one, minimizes the focused one. Under everything, /etc/theme's wallpaper (catclock's sky, clouds and
// hills) and the hint, as XP's balloon pointing at the rabbit.
//
// A client is a layer with a title and an owner. Windows overlap: each opens
// where and as big as it asks, a click raises it, its title bar moves it,
// its edges and corners resize it, as the Mac's do, and its grip at its
// bottom right (the wm writes want: {w, h} into its layer, and the client
// draws itself at that size; over an edge the cursor is a double arrow, its
// way), its × closes it, its box
// at the right minimizes it: hidden, its button left in the task bar; the
// box left of that inspects it (a Run of inspect <id>, /programs/inspect). A view
// may be tiled, in wmii's columns, when asked (layout tile). Keys go to the
// focused client, but for the chords /etc/keys binds (wmiirc runs them), which
// it turns into Key events: {key} the chord as /etc/keys writes it (A-return,
// s-S-1). A window whose owner holds grab, true, gets every key, as one that
// records a chord does (the Keys app). In windows mode the Mac places the
// windows; the wm keeps the tags and lays nothing out.
import {
	compute,
	drop,
	effect,
	front,
	handler,
	idAt,
	key as set,
	make,
	put,
	val,
	whole,
} from "ermine:kit"
import { after, here as locate, kill as stop } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as readline from "ermine:readline"
import * as views from "ermine:views"

export default (given) => {
	const { api, onCleanup, self } = given
	// this process's own node: its handlers are here/on/<name>
	const here = locate(self)
	// the folder it serves, /dev/wm, and an address in it: read from the root, as the parts it starts (its effects
	// and computes) have this process's own node for their place, and this process's own parts the folder
	const home = here.slice(0, -1)
	const wm = (...names) => [...home, ...names]
	const DISPLAY = ["/", "dev", "display"]
	// what each layer is and where, without what it draws: the compositor's /dev/display/windows/<name>,
	// each written only when it changes, so a window that draws costs the window manager nothing.
	// win reads one (none, as the rabbit's menu's client with no window focused: null); windows all, by name
	const WINDOWS = [...DISPLAY, "windows"]
	const win = (api, name) => typeof name === "string" ? val(api, [...WINDOWS, name]) : null
	// the names in a folder with a loaded node in their list
	const listed = (api, at) =>
		api.children(at).filter((n) => api.children(at, n).some((i) => i.node))
	const windows = (api) => Object.fromEntries(listed(api, WINDOWS).map((n) => [n, win(api, n)]))
	const LAYERS = [...DISPLAY, "layers"]
	const blit = blitter(api)
	// a font role's font, or none: the font ROM's
	const face = (api, role) => {
		const v = val(api, ["/", "dev", "font", role])
		return v ? font(v) : undefined
	}
	// u: pixels a point (2 on a Retina screen), so a line keeps its weight and a pad its size.
	// The bars are in /dev/font/title, as System 7's are in Chicago, and as tall as its line
	// and three points above and below; in the font ROM until it comes. A window's chrome is
	// /etc/theme's window, which the compositor draws: TB its title bar, FRAME its frame's line,
	// EDGE half that (where tiled windows' frames meet), DROP its hard shadow, GRIP its corner
	// that resizes, as the compositor reckons them. Where it drew a window's boxes and grip,
	// its clicks' places, are in /dev/display/windows/<name>, its parts
	// TOP the menu bar's height: BAR and /etc/desktop's top, points of paper above and below its titles.
	// DOCK the dock's height, a pill floating over the bottom of the screen; LOW the band it floats in, kept
	// clear of windows, as the task bar's was
	let u, FT, TB, BAR, TOP, GRIP, FRAME, EDGE, DROP, DOCK, LOW
	const titles = (api) => {
		u = val(api, [...DISPLAY, "mode"])?.unit ?? 1
		FT = face(api, "title")
		BAR = blit.height(FT) + 6 * u
		const top = val(api, ["/", "etc", "desktop"])?.top
		TOP = BAR + 2 * Math.trunc((typeof top === "number" && top >= 0 ? top : 3) * u)
		const T = val(api, ["/", "etc", "theme"]) ?? {}
		DOCK = BAR + 12 * u
		LOW = T.dock === "pill" ? DOCK + 18 * u : BAR
		const w = T.window ?? {}
		const size = (v, otherwise) =>
			Math.trunc((typeof v === "number" && v >= 0 ? v : otherwise) * u)
		const role = typeof w.title?.font === "string" ? w.title.font : "title"
		const titled = role === "title" ? FT : face(api, role)
		TB = typeof w.bar?.height === "number" && w.bar.height >= 0
			? size(w.bar.height, 0)
			: blit.height(titled) + size(w.bar?.pad, 6)
		FRAME = size(w.frame?.width, 1)
		EDGE = Math.ceil(FRAME / 2)
		DROP = size(w.drop?.size, 1)
		GRIP = size(w.grip, 12)
		return `${u} ${FT ? String(FT) : "rom"} ${TOP} ${TB} ${FRAME} ${DROP} ${GRIP} ${LOW}`
	}
	titles(api)
	// the look, from /etc/theme
	const theme = (api) => ({
		paper: 0xfdf8ea,
		desk: 0xf3ead2,
		grain: 0xe4d6b4,
		ink: 0x2a2228,
		ink2: 0x6b5a66,
		ink3: 0xa89aa2,
		line: 0x1c1a17,
		rose: 0xe2457c,
		cherry: 0xd2244a,
		risoPink: 0xff48b0,
		risoBlue: 0x0078bf,
		mint: 0x18936b,
		butter: 0xa87d00,
		peach: 0xd4622d,
		...(val(api, ["/", "etc", "theme"]) ?? {}),
	})
	// the shapes it takes, from /etc/theme, each with what it was before themes said it as the default:
	//   dock       "bar" a task bar across the bottom, "pill" a dock floating in its middle
	//   start      a word: a button at the task bar's left that pulls the world menu up, as Windows' Start
	//   menus      "square" menus with a hard shadow, the row lit in pick; "card" round, soft, the row on a pill
	//   hint       "plain" a line of text on the desk; "balloon" XP's balloon pointing at the rabbit
	//   selection  {shape}: "box" or "pill", the shape of what is chosen (a menu title, a button in the dock)
	//   buttons    "bevel" or "raised" (Windows 98's) or "soft": a button in the task bar
	//   pick, pickInk  what is chosen is drawn in: its fill and its text (the line and the paper by default)
	const shapes = (T) => ({
		dock: T.dock === "pill" ? "pill" : "bar",
		start: typeof T.start === "string" && T.start ? T.start : null,
		menus: T.menus === "card" ? "card" : "square",
		hint: T.hint === "balloon" ? "balloon" : "plain",
		pill: T.selection?.shape === "pill",
		buttons: T.buttons === "raised" || T.buttons === "soft" ? T.buttons : "bevel",
		pick: T.pick ?? T.line,
		pickInk: T.pickInk ?? T.paper,
	})
	// a bar item's colour: a key of the theme, as it is now, or a colour
	const hue = (T, v, otherwise) => (typeof v === "string" ? T[v] ?? otherwise : v ?? otherwise)
	// Windows 98's raised edge round a box: lit above and left, dark below and right, a point each, twice; pressed,
	// the other way round
	const raised = (f, x, y, w, h, T, pressed = false) => {
		const lit = [T.hi ?? 0xffffff, T.light ?? 0xdfdfdf],
			dark = [T.dark ?? 0x000000, T.lo ?? 0x808080]
		for (let k = 0; k < 2; k++) {
			const a = pressed ? dark[k] : lit[k], b = pressed ? lit[k] : dark[k]
			blit.fill(f, x + k * u, y + k * u, w - 2 * k * u, u, a)
			blit.fill(f, x + k * u, y + k * u, u, h - 2 * k * u, a)
			blit.fill(f, x + k * u, y + h - (k + 1) * u, w - 2 * k * u, u, b)
			blit.fill(f, x + w - (k + 1) * u, y + k * u, u, h - 2 * k * u, b)
		}
	}
	// the rabbit, as a pixel sprite
	const RABBIT = [
		"...XX....XX...",
		"..X..X..X..X..",
		"..X..X..X..X..",
		"..X..X..X..X..",
		"..X..X..X..X..",
		"...X..XX..X...",
		"..XXXXXXXXXX..",
		".XXXXXXXXXXXX.",
		".XX.XXXXXX.XX.",
		".XXXXXXXXXXXX.",
		".XXXXX..XXXXX.",
		"..XXXXXXXXXX..",
		"...XXXXXXXX...",
		"..XX......XX..",
	]
	// a checked menu item's tick
	const TICK = ["......X", ".....XX", "X...XX.", "XX.XX..", ".XXX...", "..X...."]
	const sprite = (f, rows, x, y, scale, color, clip) => {
		rows.forEach((row, j) =>
			[...row].forEach((ch, i) => {
				if (ch === "X") blit.fill(f, x + i * scale, y + j * scale, scale, scale, color, clip)
			})
		)
	}
	// the shapes of the look, catclock's: soft and round. mixed: a, t of it, and b. rounded: a box with its corners
	// rounded r, of fills and ellipses, its edge stepped (a pale colour on a pale one hides that). glossy: one drawn
	// smooth, each pixel mixed by how much of it the box covers, its colour a gradient across (colours, one or two),
	// as pixels blended over what is under them: on what is not clear only. Each kept, as it is drawn again and again
	const mixed = (a, b, t) =>
		[16, 8, 0].reduce(
			(c, k) => c | (Math.round(((a >> k) & 255) * t + ((b >> k) & 255) * (1 - t)) << k),
			0,
		)
	const rounded = (f, x, y, w, h, r, color, clip) => {
		r = Math.max(0, Math.min(r, Math.floor((w - 1) / 2), Math.floor((h - 1) / 2)))
		if (!r) return blit.fill(f, x, y, w, h, color, clip)
		blit.fill(f, x + r, y, w - 2 * r, h, color, clip)
		blit.fill(f, x, y + r, w, h - 2 * r, color, clip)
		for (
			const [cx, cy] of [[x + r, y + r], [x + w - r - 1, y + r], [x + r, y + h - r - 1], [
				x + w - r - 1,
				y + h - r - 1,
			]]
		) {
			blit.fillellipse(f, cx, cy, r, r, color, clip)
		}
	}
	const smooth = new Map()
	const glossy = (f, x, y, w, h, r, colours) => {
		const key = `${w} ${h} ${r} ${colours.join(" ")}`
		let form = smooth.get(key)
		if (!form) {
			form = blit.form(w, h, 0)
			const [a, b = a] = colours
			for (let j = 0; j < h; j++) {
				for (let i = 0; i < w; i++) {
					const qx = Math.abs(i + 0.5 - w / 2) - (w / 2 - r),
						qy = Math.abs(j + 0.5 - h / 2) - (h / 2 - r)
					const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
						Math.min(Math.max(qx, qy), 0) - r
					const cover = Math.max(0, Math.min(1, 0.5 - out))
					form.bits[j * w + i] = (((255 - Math.round(cover * 255)) << 24) |
						mixed(b, a, w > 1 ? i / (w - 1) : 0)) >>> 0
				}
			}
			if (smooth.size > 64) smooth.clear()
			smooth.set(key, form)
		}
		blit.blit(f, x, y, form, 0, 0, w, h, "blend")
	}
	for (
		const [name, value] of [
			["event", { n: 0, events: [] }],
			["lbar", null],
			["rbar", null],
			["menu", null],
			["hand", {}],
			["coming", {}],
		]
	) {
		make(api, home, name, value, { ephemeral: true })
	}
	// view, tag and client are documents: not ephemeral, made if they are not there
	for (const [name, value] of [["view", "1"], ["tag", null], ["client", null]]) {
		make(api, home, name, value)
	}
	make(api, wm("menu"), "at", null, { ephemeral: true })
	// a menu pulled down before it started again: gone
	if (val(api, wm("menu"))) api.write(wm("menu"), whole(null))
	if (val(api, wm("menu", "at"))) api.write(wm("menu", "at"), whole(null))
	make(api, home, "ctl", [...here, "on", "ctl"], { ephemeral: true })
	// launch: starts a program for whoever asks (wmiirc's keys and menu items, a shell), as this process's child,
	// so it lives as long as the window manager, not as long as the run that asked (SCHEDULER.tex, Children);
	// one started from a program's path is coming until its window comes, and its client keeps its start, named,
	// so started again it has the same name, and finds what it kept by it; with none, until its process ends
	// the op: {address, program, name?, data?}, program a path (an array of names, or "programs/term"); its data is
	// the node "data" in the process, as data(given) reads it
	handler(given, "launch", ({ api, start, args: [op, place] }) => {
		const program = typeof op?.program === "string"
			? op.program.split("/").filter((n) => n)
			: op?.program
		const path = Array.isArray(program) && program.every((n) => typeof n === "string")
		if (!path || !Array.isArray(op.address)) return null
		const pid = start({
			address: op.address,
			program,
			...(typeof op.name === "string" ? { name: op.name } : {}),
		})
		if (op.data != null) put(api, pid, "data", op.data)
		if (pid) {
			const name = typeof op.name === "string" ? op.name : pid
			const began = {
				address: op.address,
				program,
				name,
				...(op.data != null ? { data: op.data } : {}),
			}
			const node = [...(op.address[0] === "/" ? [] : home), ...op.address, name]
			// given a place: an away client coming back, or a place of its own, an away client until its window comes
			let back = place ? clients.get(place.client) : null
			if (!back?.away) back = null
			if (!back && Number.isFinite(place?.x)) {
				back = {
					id: pid,
					label: "",
					owner: null,
					...where(place),
					tags: new Set(where(place).tags),
					z: Number.isFinite(place.z) ? place.z : ++top,
					n: ++made,
					mini: place.mini ? ++minis : 0,
					away: true,
				}
				clients.set(pid, back)
			}
			if (back) Object.assign(back, { start: began, pid, node })
			coming.set(pid, { start: began, node, ...(back ? { client: back.id } : {}) })
			publish(api)
		}
		return pid
	})
	make(api, home, "launch", [...here, "on", "launch"], { ephemeral: true })
	api.write(["/", "dev", "kbd", "to"], whole([...here, "on", "key"]))
	api.write(["/", "dev", "pointer", "to"], whole([...here, "on", "pointer"]))

	// --- what it keeps: the documents view, tag/<name> and client/<id>, taken up as it starts; these are their copy
	const clients = new Map() // id -> { id, label, owner, tags: Set, x, y, w, h, z, sized, n, mini, start?, pid?, node?, away? }
	const tags = new Map() // name -> { layout: "float" | "tile", columns: [{ mode, clients, sel }], col }
	let view = typeof val(api, wm("view")) === "string" ? val(api, wm("view")) : "1"
	for (const name of listed(api, wm("tag"))) {
		const t = val(api, wm("tag", name))
		if (t) {
			tags.set(name, {
				layout: t.layout === "tile" ? "tile" : "float",
				columns: Array.isArray(t.columns) ? t.columns : [],
				col: t.col ?? 0,
			})
		}
	}
	// the one with the focus: kept as the front one (relayout), so not written
	let focused = null
	// one document under two names (a launch's, brought back twice) is one client: the second name goes,
	// else both come back, the same window twice, one exactly over the other
	const docs = new Set()
	for (const id of listed(api, wm("client"))) {
		const items = api.children(wm("client"), id)
		const doc = items.find((i) => i.node)?.id
		if (doc && docs.has(doc)) {
			for (const i of items) drop(api, wm("client"), id, i.id)
			continue
		}
		if (doc) docs.add(doc)
		const c = val(api, wm("client", id))
		if (c) {
			clients.set(id, {
				...c,
				id,
				tags: new Set(Array.isArray(c.tags) ? c.tags : []),
				z: c.z ?? 0,
				n: c.n ?? 0,
				mini: c.mini === true ? 1 : c.mini ?? 0,
				sized: !!c.sized,
			})
		}
	}
	// n: the order windows came, the task bar's; mini: the order they were minimized, 0 while not; top: the front's z
	let top = Math.max(0, ...[...clients.values()].map((c) => c.z))
	let made = Math.max(0, ...[...clients.values()].map((c) => c.n))
	let minis = Math.max(0, ...[...clients.values()].map((c) => c.mini))
	const was = val(api, wm("event"))
	const events = { n: was?.n ?? 0, events: Array.isArray(was?.events) ? [...was.events] : [] }
	let pendingEvents = []
	const emit = (e) => pendingEvents.push(e)
	const tagOf = (name) => {
		let t = tags.get(name)
		if (!t) {
			t = { layout: "float", columns: [], col: 0 }
			tags.set(name, t)
			emit({ type: "CreateTag", tag: name })
		}
		return t
	}
	tagOf(view)
	const mode = (api) => val(api, [...DISPLAY, "mode"]) ?? { w: 1280, h: 800 }
	// the windows shown in the view, front first: a minimized one is not
	const inView = () =>
		[...clients.values()].filter((c) => c.tags.has(view) && !c.mini && !c.away).sort((a, b) =>
			b.z - a.z
		)
	const focusOn = (id) => {
		focused = id
	}
	// one already in front stays as it is, so a click on it writes nothing
	const raise = (id) => {
		const c = clients.get(id)
		if (c && inView().some((x) => x !== c && x.z >= c.z)) c.z = ++top
	}
	// minimized: hidden, out of its tiled columns, the focus to the front one left (relayout gives it);
	// restored: back in them, in front, focused
	const minimize = (c) => {
		if (c.mini) return
		c.mini = ++minis
		for (const name of c.tags) untile(tagOf(name), c.id)
		placed.delete(c.id)
	}
	const restore = (c) => {
		if (c.mini) {
			c.mini = 0
			for (const name of c.tags) if (tagOf(name).layout === "tile") tile(tagOf(name), c.id)
		}
		raise(c.id)
		focusOn(c.id)
		placed.delete(c.id)
	}

	// tiling, only when a view asks for it
	const untile = (t, id) => {
		for (const col of t.columns) {
			const i = col.clients.indexOf(id)
			if (i < 0) continue
			col.clients.splice(i, 1)
			col.sel = Math.max(0, Math.min(col.sel, col.clients.length - 1))
		}
		t.columns = t.columns.filter((c) => c.clients.length)
		t.col = Math.max(0, Math.min(t.col, t.columns.length - 1))
	}
	const tile = (t, id) => {
		if (!t.columns.length) t.columns.push({ mode: "default", clients: [], sel: 0 })
		const col = t.columns[t.col] ?? t.columns[0]
		col.clients.splice(col.sel + 1, 0, id)
		col.sel = col.clients.indexOf(id)
	}
	const tileOf = (t, id) => {
		for (let c = 0; c < t.columns.length; c++) {
			const i = t.columns[c].clients.indexOf(id)
			if (i >= 0) return { col: c, i }
		}
		return null
	}

	// --- the layout, written into the layers
	const placed = new Map() // id -> what was last written
	const relayout = (api) => {
		const m = mode(api)
		const t = tagOf(view)
		const geo = new Map()
		if (!m.windows && t.layout === "tile") {
			// between the menu bar and the task bar, each as tall as a title bar
			const H = m.h - TOP - LOW, W = m.w, n = t.columns.length
			t.columns.forEach((col, ci) => {
				const x0 = Math.floor((ci * W) / n), x1 = Math.floor(((ci + 1) * W) / n)
				// an away client keeps its place in the column, and no room, until its window comes back
				const ids = col.clients.filter((id) => !clients.get(id)?.away),
					sel = col.clients[col.sel]
				const k = ids.length, frame = TB + 2 * EDGE
				let y = TOP
				ids.forEach((id) => {
					let h
					if (col.mode === "max") {
						if (id !== sel) return geo.set(id, { hidden: true })
						h = H - frame
					} else if (col.mode === "stack") h = id === sel ? H - k * frame : 0
					else h = Math.floor(H / k) - frame
					geo.set(id, {
						x: x0 + EDGE,
						y: y + TB + EDGE,
						w: x1 - x0 - 2 * EDGE,
						h: Math.max(0, h),
						collapsed: h <= 0,
						z: 0,
						want: true,
					})
					y += frame + Math.max(0, h)
				})
			})
		}
		for (const [id, c] of clients) {
			let g
			if (!c.tags.has(view) || c.mini) g = { hidden: true }
			else if (m.windows) g = { natural: true }
			else g = geo.get(id) ?? { x: c.x, y: c.y, w: c.w, h: c.h, z: c.z, want: c.sized }
			const key = JSON.stringify(g)
			if (placed.get(id) === key) continue
			placed.set(id, key)
			if (!win(api, id)) continue
			const patches = []
			if (g.hidden) patches.push(...set("hidden", true))
			else if (g.natural) patches.push(...set("hidden", false), ...set("collapsed", false))
			else {
				patches.push(
					...set("hidden", false),
					...set("collapsed", !!g.collapsed),
					...set("x", g.x),
					...set("y", g.y),
					...set("z", g.z),
				)
				if (g.want && !g.collapsed) patches.push(...set("want", { w: g.w, h: g.h }))
			}
			try {
				api.write([...LAYERS, id], patches)
			} catch {
				// its layer gone since /dev/display/windows said it was there (a window closed by its box, killed
				// in this run): the client goes when the windows say so
			}
		}
		// the focus: the focused client if it is in view, or the front one
		const shown = inView()
		if (!shown.some((c) => c.id === focused)) focused = shown[0]?.id ?? null
		// a menu pulled down is the focused window's: another focused, it goes
		if (pulled && pulled.client !== focused) pull(api, null)
		if (val(api, [...DISPLAY, "focus"]) !== focused) {
			api.write([...DISPLAY, "focus"], whole(focused))
			if (focused) emit({ type: "FocusClient", client: focused })
		}
	}

	// --- what it serves: each node written only when what it holds changes, as it last wrote it (wrote)
	const wrote = new Map()
	const keep = (api, at, value, ephemeral) => {
		const key = at.join("/"), text = JSON.stringify(value)
		if (wrote.get(key) === text) return
		wrote.set(key, text)
		if (idAt(api, wm(...at))) api.write(wm(...at), whole(value))
		else make(api, wm(...at.slice(0, -1)), at.at(-1), value, ephemeral ? { ephemeral: true } : {})
	}
	const forget = (api, folder, name) => {
		wrote.delete([...folder, name].join("/"))
		for (const i of api.children(wm(...folder), name)) drop(api, wm(...folder), name, i.id)
	}
	// a client as its node holds it
	const record = (c) => ({
		label: c.label,
		tags: [...c.tags],
		owner: c.owner,
		x: c.x,
		y: c.y,
		w: c.w,
		h: c.h,
		n: c.n,
		z: c.z,
		sized: !!c.sized,
		...(c.mini ? { mini: c.mini } : {}),
		...(c.start ? { start: c.start, pid: c.pid, node: c.node } : {}),
		...(c.away ? { away: true } : {}),
	})
	const index = (t) => ({
		layout: t.layout,
		...(t.layout === "tile" ? { columns: t.columns, col: t.col } : {}),
	})
	// a client being dragged, by its id: {f, text}, its front (the slot trick) and what was last put there.
	// REST: how long after a drag's up the document is written: a person letting go and taking the window
	// again (a second nudge, a resize after a move) is one change on the card, not two; and a boot or a
	// crash loses at most that much of where it went (a kill lets the front go: the window back where its
	// document says)
	const REST = 400
	const fronts = new Map()
	const ahead = (api, id, value) => {
		let a = fronts.get(id)
		if (!a) fronts.set(id, a = { f: front(wm("client", id)), text: null })
		const text = JSON.stringify(value)
		if (a.text === text) return
		a.text = text
		a.f.put(api, value)
	}
	// the hand rested: each front let go, but a drag's going on, and its document written once
	const rest = (api) => {
		for (const [id, a] of [...fronts]) {
			if (drag?.id === id) continue
			fronts.delete(id)
			a.f.done(api)
			if (clients.has(id)) keep(api, ["client", id], record(clients.get(id)))
		}
	}
	// the timer of the rest: its cancel, which takes the api of the part cancelling
	let resting = null
	const restLater = (part) => {
		if (resting) resting(part.api)
		resting = after(part, REST, ({ api }) => {
			resting = null
			lately = null
			rest(api)
		})
	}
	// killed or replaced: what is in front kept now, a drag going on as far as it went
	onCleanup(({ api }) => {
		if (resting) resting(api)
		drag = null
		rest(api)
	})
	// what it holds, as it starts: nothing written that has not changed
	wrote.set("view", JSON.stringify(val(api, wm("view"))))
	for (const name of listed(api, wm("tag"))) {
		wrote.set(`tag/${name}`, JSON.stringify(val(api, wm("tag", name))))
	}
	for (const id of listed(api, wm("client"))) {
		wrote.set(`client/${id}`, JSON.stringify(val(api, wm("client", id))))
	}
	const publish = (api) => {
		keep(api, ["view"], view)
		for (const [name, t] of tags) keep(api, ["tag", name], index(t))
		// what it wrote that it no longer holds goes
		const gone = (folder, has) =>
			[...wrote.keys()].filter((k) =>
				k.startsWith(`${folder}/`) && !has(k.slice(folder.length + 1))
			)
		for (const k of gone("tag", (n) => tags.has(n))) forget(api, ["tag"], k.slice(4))
		// a window being dragged, or let go of less than REST ago, in front of its document
		for (const [id, c] of clients) {
			if (drag?.id === id || fronts.has(id)) ahead(api, id, record(c))
			else keep(api, ["client", id], record(c))
		}
		for (const k of gone("client", (n) => clients.has(n))) {
			fronts.delete(k.slice(7))
			forget(api, ["client"], k.slice(7))
		}
		keep(api, ["coming"], Object.fromEntries(coming), true)
		keep(api, ["hand"], {
			...(drag ? { drag } : {}),
			...(grab ? { grab } : {}),
			...(pick ? { pick } : {}),
			...(held ? { held } : {}),
			...(hovered ? { hovered } : {}),
		}, true)
		if (pendingEvents.length) {
			for (const e of pendingEvents) events.events.push({ n: ++events.n, ...e })
			events.events = events.events.slice(-64)
			pendingEvents = []
			api.write(wm("event"), whole(events))
		}
	}
	const settle = (api) => {
		// tags with no clients go, but the one shown; an away client's stay for it
		for (const [name, t] of [...tags]) {
			const used = [...clients.values()].some((c) => c.tags.has(name))
			if (!used && name !== view) {
				tags.delete(name)
				emit({ type: "DestroyTag", tag: name })
			} else if (!used) t.columns = []
		}
		relayout(api)
		publish(api)
	}

	// --- launches: each one coming, by pid, {start, node, client?}, until its window comes or, with none, its process ends
	const coming = new Map(Object.entries(val(api, wm("coming")) ?? {}))
	// a window's place, as launch is given it
	const where = (c) => ({
		x: c.x,
		y: c.y,
		w: c.w,
		h: c.h,
		z: Number.isFinite(c.z) ? c.z : 0,
		sized: !!c.sized,
		tags: c.tags instanceof Set
			? [...c.tags]
			: Array.isArray(c.tags)
			? c.tags.filter((t) => typeof t === "string")
			: [],
		...(c.mini ? { mini: true } : {}),
	})
	const running = (api, node, pid) =>
		Array.isArray(node) && api.children(node.slice(0, -1), node.at(-1)).some((i) => i.id === pid)
	// the launch whose process owns a new window, found as kill finds a process: by the owner's node
	const launchOf = (api, owner) => {
		if (!coming.size || !Array.isArray(owner) || owner.length < 2) return null
		const items = api.children(owner.slice(0, -1), owner.at(-1))
		const pid = items.find((i) => coming.has(i.id))?.id
		return pid ? { pid, ...coming.get(pid) } : null
	}
	// started: a client whose window is not here is away, if launch started it, to come back; else gone
	{
		const there = windows(api)
		for (const [id, c] of [...clients]) {
			if (there[id]) continue
			if (c.start) c.away = true
			else clients.delete(id)
		}
	}

	// --- clients come and go as titled layers do. Deep: the same list made again (a window moved) is no new
	// value, so no run of what follows; a launch whose process ended with no window (below) is forgotten as
	// the list next changes
	effect(given, "clients", ({ api }) => {
		const out = []
		for (const [name, l] of Object.entries(windows(api))) {
			// not where it is: a window moving (a drag moves one a hundred times a second) changes nothing here
			if (l && l.title !== undefined && l.title !== null) {
				out.push({ id: name, owner: l.owner ?? null, label: l.title, w: l.w, h: l.h })
			}
		}
		return out
	}, ({ value: list, api }) => {
		const seen = new Set()
		for (const l of list) {
			seen.add(l.id)
			const c = clients.get(l.id)
			if (c) {
				c.label = l.label
				// a program that takes another's window, as one run in a shell window does, gets its keys
				c.owner = l.owner
				// a floating client's size is its own, unless the person gave it one
				if (!c.sized) {
					c.w = l.w
					c.h = l.h
				}
				continue
			}
			// a new window: where and as big as it asks, between the bars, in front, focused. One whose launch
			// brings an away client back takes it up, under its new id: where it was, in its columns, as far back
			// in the stack, minimized if it was
			const from = launchOf(api, l.owner)
			if (from) coming.delete(from.pid)
			const back = from?.client ? clients.get(from.client) : null
			if (back?.away) {
				const old = back.id
				const c = {
					...back,
					id: l.id,
					label: l.label,
					owner: l.owner,
					away: false,
					pid: from.pid,
					node: from.node,
					start: from.start,
				}
				if (!c.sized) Object.assign(c, { w: l.w, h: l.h })
				clients.delete(old)
				clients.set(l.id, c)
				for (const t of tags.values()) {
					for (const col of t.columns) {
						col.clients = col.clients.map((id) => (id === old ? l.id : id))
					}
				}
				if (!c.mini) {
					for (const name of c.tags) {
						if (tagOf(name).layout === "tile" && !tileOf(tagOf(name), l.id)) {
							tile(tagOf(name), l.id)
						}
					}
				}
				// the same document, under the new id
				const doc = api.children(wm("client"), old).find((i) => i.node)?.id
				if (doc) {
					api.insert(idAt(api, wm("client")), l.id, doc)
					wrote.set(`client/${l.id}`, wrote.get(`client/${old}`))
					forget(api, ["client"], old)
				}
				// the front one back in view has the focus, unless one in front of it has it (the person's)
				if (!c.mini && c.tags.has(view) && !(clients.get(focused)?.z > c.z)) focusOn(l.id)
				emit({ type: "CreateClient", client: l.id })
				continue
			}
			const asks = win(api, l.id) ?? {}
			// one asking to sit over the task bar comes up above it, as far as the menu bar lets it
			const y = Math.max(
				TOP + TB + EDGE,
				Math.min(asks.y ?? 0, mode(api).h - LOW - l.h - FRAME - DROP),
			)
			// no wider than the screen, and on it
			const W = mode(api).w, w = Math.max(80, Math.min(l.w, W - 2 * FRAME - DROP))
			const x = Math.max(FRAME, Math.min(asks.x ?? 0, W - w - FRAME - DROP))
			const client = {
				id: l.id,
				label: l.label,
				owner: l.owner,
				tags: new Set([view]),
				x,
				y,
				w,
				h: l.h,
				z: ++top,
				sized: w < l.w,
				n: ++made,
				mini: 0,
			}
			if (from) Object.assign(client, { start: from.start, pid: from.pid, node: from.node })
			clients.set(l.id, client)
			for (const name of client.tags) if (tagOf(name).layout === "tile") tile(tagOf(name), l.id)
			focusOn(l.id)
			emit({ type: "CreateClient", client: l.id })
		}
		// a window closed is forgotten; an away client stays, to come back
		for (const [id, c] of [...clients]) {
			if (seen.has(id) || c.away) continue
			clients.delete(id)
			placed.delete(id)
			for (const t of tags.values()) untile(t, id)
			emit({ type: "DestroyClient", client: id })
		}
		// a launch whose process ended with no window, as power's, is forgotten
		for (const [pid, l] of coming) if (!running(api, l.node, pid)) coming.delete(pid)
		settle(api)
	}, { deep: true })
	effect(given, "screen", ({ api }) => {
		const m = mode(api)
		return { w: m.w, h: m.h, windows: !!m.windows, font: titles(api) }
	}, ({ api }) => {
		placed.clear()
		settle(api)
	})

	// a tag laid out: tiled, its windows in columns; floating, each back where it was, at the size it was
	const lay = (api, name, to) => {
		const t = tagOf(name)
		const its = [...clients.values()].filter((c) => c.tags.has(name) && !c.mini && !c.away).sort((
			a,
			b,
		) => b.z - a.z)
		if (to === "tile" && t.layout !== "tile") {
			t.columns = []
			for (const x of its.reverse()) tile(t, x.id)
		}
		if (to === "float") {
			for (const x of its) {
				try {
					if (win(api, x.id)) {
						api.write([...LAYERS, x.id], set("want", x.sized ? { w: x.w, h: x.h } : null))
					}
				} catch {
					// its layer gone, as above
				}
			}
		}
		t.layout = to
		placed.clear()
	}
	const retag = (c, next) => {
		for (const name of c.tags) if (!next.has(name)) untile(tagOf(name), c.id)
		for (const name of next) {
			if (!c.tags.has(name) && !c.mini && tagOf(name).layout === "tile") {
				tile(tagOf(name), c.id)
			}
		}
		c.tags = next
		placed.clear()
	}

	// --- what another writes into view, tag/<name> or client/<id> (a shell's set, the inspector): taken up, as
	// ctl's doings are. What this wrote itself (wrote) is let be, and a client in front (a drag's) is this one's
	const canon = (v) =>
		JSON.stringify(
			v,
			(_k, x) => (x && typeof x === "object" && !Array.isArray(x)
				? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
				: x),
		)
	const theirs = (key, v) =>
		wrote.has(key) && canon(v) !== canon(JSON.parse(wrote.get(key) ?? "null"))
	// taken up: written back only if what it holds now is not what was written
	const took = (key, x, now) => wrote.set(key, JSON.stringify(canon(now) === canon(x) ? now : x))
	// read deep, and without a client in front (a drag's, written each move, which what follows lets be): a
	// window dragged runs only this
	effect(given, "edits", ({ api }) => ({
		view: val(api, wm("view")) ?? null,
		tag: listed(api, wm("tag")).map((n) => [n, val(api, wm("tag", n)) ?? null]),
		client: listed(api, wm("client")).flatMap((
			id,
		) => (fronts.has(id) ? [] : [[id, val(api, wm("client", id)) ?? null]])),
	}), ({ api }) => {
		let changed = false
		const v = val(api, wm("view"))
		if (typeof v === "string" && v && theirs("view", v)) {
			view = v
			tagOf(view)
			placed.clear()
			emit({ type: "FocusTag", tag: view })
			took("view", v, view)
			changed = true
		}
		for (const name of listed(api, wm("tag"))) {
			const x = val(api, wm("tag", name))
			if (!x || typeof x !== "object" || !tags.has(name) || !theirs(`tag/${name}`, x)) continue
			const t = tags.get(name), to = x.layout === "tile" ? "tile" : "float"
			if (to !== t.layout) lay(api, name, to)
			if (to === "tile" && Array.isArray(x.columns)) {
				const columns = x.columns.filter((col) => Array.isArray(col?.clients)).map((col) => ({
					mode: ["default", "stack", "max"].includes(col.mode) ? col.mode : "default",
					clients: col.clients.filter((id) => clients.get(id)?.tags.has(name)),
					sel: Number.isInteger(col.sel) ? col.sel : 0,
				})).filter((col) => col.clients.length)
				for (const col of columns) {
					col.sel = Math.max(0, Math.min(col.sel, col.clients.length - 1))
				}
				t.columns = columns
				t.col = Math.max(0, Math.min(Number.isInteger(x.col) ? x.col : 0, columns.length - 1))
				// one of its windows left out of every column: in the column selected
				for (const c of clients.values()) {
					if (c.tags.has(name) && !c.mini && !tileOf(t, c.id)) tile(t, c.id)
				}
			}
			placed.clear()
			took(`tag/${name}`, x, index(t))
			changed = true
		}
		for (const id of listed(api, wm("client"))) {
			const c = clients.get(id)
			if (!c || drag?.id === id || fronts.has(id)) continue
			const x = val(api, wm("client", id))
			if (!x || typeof x !== "object" || !theirs(`client/${id}`, x)) continue
			const num = (n, was) => (Number.isFinite(n) ? n : was)
			const w = Math.max(80, num(x.w, c.w)), h = Math.max(40, num(x.h, c.h))
			if (w !== c.w || h !== c.h) Object.assign(c, { w, h, sized: true })
			// where ctl's move puts it
			Object.assign(c, {
				x: num(x.x, c.x),
				y: Math.max(TOP + TB + EDGE, Math.min(num(x.y, c.y), mode(api).h - LOW - TB)),
			})
			if (Number.isFinite(x.z) && x.z !== c.z) {
				c.z = x.z
				top = Math.max(top, c.z)
			}
			const next = Array.isArray(x.tags)
				? new Set(x.tags.filter((n) => typeof n === "string" && n))
				: c.tags
			if (next.size && [...next].join("+") !== [...c.tags].join("+")) retag(c, next)
			if (!!x.mini !== !!c.mini) x.mini ? minimize(c) : restore(c)
			placed.delete(id)
			took(`client/${id}`, x, record(c))
			changed = true
		}
		if (changed) settle(api)
	}, { deep: true })

	// --- ctl
	const kill = (api, id) => {
		const c = clients.get(id)
		// an away client, killed, is forgotten: it does not come back
		if (c?.away) {
			clients.delete(id)
			for (const t of tags.values()) untile(t, id)
			settle(api)
			return "ok"
		}
		// a client's owner is the node of the process that drew it: its id is the process, killed
		const at = Array.isArray(c?.owner) ? c.owner : null
		const node = at && api.children(at.slice(0, -1), at.at(-1)).find((i) => i.node)
		if (!node) return "no such client"
		stop(node.id)
		return "ok"
	}
	const ctl = (api, line) => {
		const words = String(line).trim().split(/\s+/)
		const cmd = words[0]
		if (cmd === "point") {
			pointing = !pointing
			shape(api, pointing ? HELP : null)
			return "ok"
		}
		if (cmd === "run") {
			const command = String(line).trim().slice(3).trim()
			if (!command) return "run <command>"
			emit({ type: "Run", command })
			publish(api)
			return "ok"
		}
		// an id may follow the command; sel, or none, is the focused client
		const named = words[1] && clients.has(words[1]) ? words[1] : null
		const id = named ?? focused
		const a = words.slice(named || words[1] === "sel" ? 2 : 1)
		const t = tagOf(view)
		const c = id ? clients.get(id) : null
		switch (cmd) {
			case "view":
				if (!a[0]) return "view <tag>"
				view = a[0]
				tagOf(view)
				placed.clear()
				emit({ type: "FocusTag", tag: view })
				break
			case "select": {
				const shown = inView()
				if (a[0] === "next" || a[0] === "prev") {
					if (!shown.length) return "no windows"
					// next: the one at the back comes to the front, as rio's cycling does
					const next = a[0] === "next" ? shown.at(-1) : shown[1] ?? shown[0]
					raise(next.id)
					focusOn(next.id)
				} else if (a[0] && clients.has(a[0])) {
					// a minimized one comes back
					restore(clients.get(a[0]))
				} else if (t.layout === "tile" && t.columns.length) {
					const col = t.columns[t.col]
					if (a[0] === "left") t.col = Math.max(0, t.col - 1)
					if (a[0] === "right") t.col = Math.min(t.columns.length - 1, t.col + 1)
					if (a[0] === "up") col.sel = Math.max(0, col.sel - 1)
					if (a[0] === "down") col.sel = Math.min(col.clients.length - 1, col.sel + 1)
					const now = t.columns[t.col]
					focusOn(now.clients[now.sel])
				} else return "select next|prev|<id>, or left|right|up|down when tiled"
				placed.clear()
				break
			}
			case "raise":
			case "lower":
				if (!c) return "no window"
				if (cmd === "raise") raise(c.id)
				else c.z = Math.min(...[...clients.values()].map((x) => x.z)) - 1
				break
			case "move":
			case "resize": {
				if (!c) return "no window"
				const [p, q] = a.map(Number)
				if (!Number.isFinite(p) || !Number.isFinite(q)) {
					return `${cmd} [id] <${cmd === "move" ? "x> <y" : "w> <h"}>`
				}
				if (cmd === "move") {
					Object.assign(c, {
						x: p,
						y: Math.max(TOP + TB + EDGE, Math.min(q, mode(api).h - LOW - TB)),
					})
				} else Object.assign(c, { w: Math.max(80, p), h: Math.max(40, q), sized: true })
				break
			}
			case "layout": {
				const to = a[0] === "toggle" ? (t.layout === "tile" ? "float" : "tile") : a[0]
				if (to !== "float" && to !== "tile") return "layout float|tile|toggle"
				lay(api, view, to)
				break
			}
			case "send": {
				if (t.layout !== "tile" || !c) return "send works on a tiled view"
				const w = tileOf(t, c.id)
				const col = t.columns[w.col]
				const dir = a[0]
				if (dir === "up" && w.i > 0) {
					;[col.clients[w.i - 1], col.clients[w.i]] = [col.clients[w.i], col.clients[w.i - 1]]
					col.sel = w.i - 1
				} else if (dir === "down" && w.i < col.clients.length - 1) {
					;[col.clients[w.i + 1], col.clients[w.i]] = [col.clients[w.i], col.clients[w.i + 1]]
					col.sel = w.i + 1
				} else if (dir === "left" || dir === "right") {
					col.clients.splice(w.i, 1)
					col.sel = Math.max(0, Math.min(col.sel, col.clients.length - 1))
					let to = w.col + (dir === "right" ? 1 : -1)
					if (to < 0 || to >= t.columns.length) {
						t.columns.splice(to < 0 ? 0 : t.columns.length, 0, {
							mode: "default",
							clients: [],
							sel: 0,
						})
						to = to < 0 ? 0 : t.columns.length - 1
					}
					const target = t.columns[to]
					target.clients.splice(target.sel + 1, 0, c.id)
					target.sel = target.clients.indexOf(c.id)
					t.columns = t.columns.filter((x) => x.clients.length)
					t.col = t.columns.indexOf(target)
				}
				placed.clear()
				break
			}
			case "colmode": {
				const m = a.find((x) => ["default", "stack", "max"].includes(x))
				if (t.layout !== "tile" || !m || !t.columns[t.col]) {
					return "colmode sel default|stack|max, on a tiled view"
				}
				t.columns[t.col].mode = m
				placed.clear()
				break
			}
			case "tag": {
				if (!c || !a[0]) return "tag [id] <tag>[+<tag>...]"
				retag(c, new Set(a[0].split("+").filter((x) => x)))
				break
			}
			case "kill":
				return c ? kill(api, c.id) : "no window"
			case "minimize":
				if (!c) return "no window"
				minimize(c)
				break
			case "restore": {
				// named, that one; else the last minimized in view
				const r = named
					? c
					: [...clients.values()].filter((x) => x.mini && x.tags.has(view)).sort((p, q) =>
						q.mini - p.mini
					)[0]
				if (!r) return "none minimized"
				restore(r)
				break
			}
			default:
				return `no such command: ${cmd}`
		}
		settle(api)
		return "ok"
	}
	// a call answers nothing, so the answer is said in /dev/wm/said {n, line, answer}, as /dev/mac/do
	handler(given, "ctl", ({ api, args: [line] }) => {
		const answer = ctl(api, line) ?? ""
		const n = (val(api, wm("said"))?.n ?? 0) + 1
		keep(api, ["said"], { n, line: String(line), answer }, true)
		return answer
	})

	// --- keys: the chords /etc/keys binds are events; the rest are the focused client's
	const chord = (r) => readline.chord(r)
	// the chords bound, each made the one way chord writes one, while /etc/keys is as it was
	let bound = { at: null, set: new Set() }
	const boundOf = (api) => {
		const item = api.content(["/", "etc", "keys"]).find((i) => i.versions)
		// m, meta: cmd (s) while ermineOS takes the Mac over, else alt (A)
		const meta = val(api, [...DISPLAY, "mode"])?.takeover ? "s" : "A"
		const t = item?.versions?.[0]?.change?.time ?? null
		if (bound.at !== t || bound.meta !== meta || t === null) {
			const v = val(api, ["/", "etc", "keys"])
			bound = {
				at: t,
				meta,
				set: new Set(
					v && typeof v === "object" && !Array.isArray(v)
						? Object.keys(v).map((k) => readline.normal(k, meta))
						: [],
				),
			}
		}
		return bound.set
	}
	const send = ({ api, call }, id, what, recs) => {
		const owner = clients.get(id)?.owner ?? win(api, id)?.owner
		if (!owner) return
		try {
			call([...owner, "on", what], [recs])
		} catch {
			// a client that takes no such thing
		}
	}
	const press = (g, recs) => {
		const { api } = g
		const keys = boundOf(api)
		// a window recording a chord takes every key
		const owner = focused ? clients.get(focused)?.owner : null
		const grabbing = Array.isArray(owner) && val(api, [...owner, "grab"]) === true
		const pass = []
		for (const r of recs) {
			// cmd-c, over text selected across a window: copied, through the Mac's clipboard
			const sel = r.down && chord(r) === "s-c" ? val(api, SELECTION) : null
			if (sel?.text && sel.layer === focused) {
				api.write(["/", "dev", "clip", "text"], whole({ text: sel.text }))
			} // Escape lets go of a menu pulled down
			else if (r.down && pulled && r.key === "Escape") pull(api, null)
			else if (r.down && !grabbing && keys.has(chord(r))) emit({ type: "Key", key: chord(r) })
			else pass.push(r)
		}
		// no window focused: the desk's (the layer desk, /programs/desk), as the Finder's desktop takes them
		if (pass.length) send(g, focused ?? "desk", "key", pass)
	}
	handler(given, "key", (g) => {
		press(g, g.args[0])
		publish(g.api)
	})

	// --- the pointer
	// x, y (from a window's content's top left) in a part of its chrome, {x, y, w, h}
	const box = (p, x, y) => !!p && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h
	// in its grip: as the compositor said, else from gx, gy down and right
	const grips = (grip, x, y, gx, gy) => grip ? box(grip, x, y) : x >= gx && y >= gy
	const under = (api, x, y) => {
		// the owned layer under the pointer, front first
		const all = []
		for (const [name, l] of Object.entries(windows(api))) {
			if (!l || l.hidden || !l.owner || !l.w) continue
			// a window's frame, as the compositor drew it
			const f = l.parts?.frame
			if (
				f
					? x >= l.x + f.x && x < l.x + f.x + f.w && y >= l.y + f.y && y < l.y + f.y + f.h
					: x >= l.x - 1 && x < l.x + l.w + 1 && y >= (l.title ? l.y - TB - 1 : l.y) &&
						y < l.y + (l.collapsed ? 0 : l.h) + 1
			) all.push({ name, ...l })
		}
		return all.sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0] ?? null
	}
	// what the pointer is doing is the node hand, as it was when this started (replaced, a drag goes on)
	const hand = val(api, wm("hand")) ?? {}
	// {id, how: "move", dx, dy}, or {id, how: "resize", sides, from: [x, y], was: {x, y, w, h}}: its edges pressed (n, se…),
	// where the hand was pressed, and where the window was (a resize begun before sides were kept: let go)
	let drag = hand.drag?.how === "resize" && !hand.drag.sides ? null : hand.drag ?? null
	// the window a drag let go of less than REST ago: where this put it, though its layer may not be drawn there yet
	let lately = null
	// a window that takes drags (drags: true, as an editor's selection) gets every move and the up
	// after a down in it; any other window's text is selected by a drag across it, here
	let grab = hand.grab ?? null // {id, x, y}: the layer, and where it was
	let pick = hand.pick ?? null // {layer, x, y, from, started}
	const SELECTION = [...DISPLAY, "selection"]
	const fontOf = (api) => (role) => face(api, role)
	const unselect = (api) => {
		if (val(api, SELECTION)) api.write(SELECTION, whole(null))
	}
	let bar = [] // what the menu bar drew where: {side: "m" | "r", item?, menu?, x0, x1}
	let low = [] // what the task bar drew where: {side: "l" | "t", item?, client?, x0, x1}
	// the menu pulled down, {client, menu, x, at?}: the node menu holds it but at, which menu/at holds; held, the
	// button down since its title was pressed
	let pulled = null, held = !!hand.held
	const pull = (api, value) => {
		pulled = value
		const { at = null, ...top } = value ?? {}
		for (const [address, v] of [[wm("menu"), value ? top : null], [wm("menu", "at"), at]]) {
			if (canon(val(api, address) ?? null) !== canon(v)) api.write(address, whole(v))
		}
	}
	// a menu pulled down, laid out under its title, and each submenu open (at, the rows lit, a path: one lit
	// that has items opens them beside it): {menu, owner, at, panels: [{x, y, w, h, left, rows: [{y0, y1, it}]}]},
	// or null; as the pointer finds it and as it is drawn, so a hand quicker than the drawing finds it where it will be
	const opened = (api, p) => {
		const owner = p ? win(api, p.client)?.owner ?? null : null
		const menu = p ? menusOf(api, owner)[p.menu] ?? null : null
		if (!menu) return null
		// card menus (the theme's menus): rows roomier, no hard shadow; square ones, System 7's, a hard shadow S
		const card = shapes(theme(api)).menus === "card"
		const SEP = (card ? 9 : 8) * u,
			S = card ? 0 : 2 * u,
			screen = mode(api),
			pad = (card ? 6 : 3) * u
		const panel = (items, x, y, up) => {
			// a menu whose items have icons: each row as tall as one, its label after it
			const icons = items.some((it) => it !== "-" && it.icon)
			const ROW = Math.max(
				blit.height(FT) + (card ? 10 : 6) * u,
				icons ? (card ? 24 : 20) * u : 0,
			)
			const left = icons ? (card ? 38 : 32) * u : (card ? 20 : 14) * u,
				end = (card ? 20 : 14) * u
			const text = (it) =>
				left + blit.measure(it.label, FT) +
				(it.shown ? blit.measure(it.shown, FT) + 32 * u : 0) + (it.items ? 16 * u : 0) + end
			const w = Math.max(140 * u, ...items.map((it) => (it === "-" ? 0 : text(it))))
			const rows = []
			let at = pad
			for (const it of items) {
				const h = it === "-" ? SEP : ROW
				rows.push({ y0: at, y1: at + h, it })
				at += h
			}
			const h = at + pad
			// pulled up (from the start button): its foot on the task bar
			if (up) y = screen.h - LOW - h - S
			return {
				x: Math.max(0, Math.min(x, screen.w - w - S)),
				y: Math.max(0, Math.min(y, screen.h - h - S)),
				w,
				h,
				left,
				rows,
			}
		}
		const panels = [panel(menu.items, p.x ?? 0, card ? TOP + 3 * u : TOP - u, p.up === true)]
		const at = Array.isArray(p.at) ? p.at : typeof p.at === "number" ? [p.at] : []
		for (const i of at) {
			const last = panels.at(-1), r = last.rows[i]
			if (!r || r.it === "-" || r.it.off || !Array.isArray(r.it.items)) break
			// beside its item, or on its other side where the screen ends
			const x = last.x + last.w + (card ? 2 : -1) * u,
				sub = panel(r.it.items, x, last.y + r.y0 - pad)
			if (x + sub.w + S > screen.w) sub.x = Math.max(0, last.x - sub.w - (card ? 2 : -1) * u)
			panels.push(sub)
		}
		return { menu, owner, at, panels }
	}
	// the item under x, y, the deepest menu open first: {at, it}, at the rows' path to it; null on a line,
	// undefined off them all
	const itemAt = (d, x, y) => {
		if (!d) return undefined
		for (let k = d.panels.length - 1; k >= 0; k--) {
			const q = d.panels[k]
			if (x < q.x || x >= q.x + q.w || y < q.y || y >= q.y + q.h) continue
			const i = q.rows.findIndex((r) => y - q.y >= r.y0 && y - q.y < r.y1)
			const it = q.rows[i]?.it
			return it && it !== "-" ? { at: [...d.at.slice(0, k), i], it } : null
		}
		return undefined
	}
	// a task bar button: a minimized window restored, the focused one minimized, another focused
	const task = (id) => {
		const c = clients.get(id)
		if (!c) return
		if (c.mini) restore(c)
		else if (id === focused) minimize(c)
		else {
			raise(id)
			focusOn(id)
		}
	}
	// the cursor: its picture's address, in /dev/pointer/cursor (programs/cursor draws it). Over an edge or corner that
	// resizes, its double arrow: resize the diagonal from top left to bottom right, the others as CSS names them
	const CURSORS = ["/", "etc", "cursors"]
	const RESIZE = [...CURSORS, "resize"], HELP = [...CURSORS, "help"]
	const EW = [...CURSORS, "ew-resize"],
		NS = [...CURSORS, "ns-resize"],
		NESW = [...CURSORS, "nesw-resize"]
	const ARROWS = { n: NS, s: NS, e: EW, w: EW, ne: NESW, sw: NESW, nw: RESIZE, se: RESIZE }
	const CURSOR = ["/", "dev", "pointer", "cursor"]
	let cursor = val(api, CURSOR) ?? null
	// a shape it wants is written again if another wrote the cursor since (a web page's, told the pointer left it
	// after this wrote); the arrow only when it wanted another, so a page's own shape over the page is let be
	const shape = (api, want) => {
		if (want === cursor && (!want || canon(val(api, CURSOR) ?? null) === canon(want))) return
		cursor = want
		if (idAt(api, CURSOR)) api.write(CURSOR, whole(want))
	}
	// where a press resizes a floating window, as the Mac's do: {id, sides}, sides the edges a drag moves (n, e, sw…),
	// or null. An edge is OUT out past its frame, its line and IN in from it: a little, as just inside a window is the
	// window's own; a corner as far along each of its edges as its grip is big; its grip is its bottom right. Front first:
	// a press on a window is its own, not the edge of one behind; and an owned layer in front (a menu, an icon) is its
	// own, and a menu pulled down from the menu bar is the menu's
	const resizing = (api, r) => {
		const m = mode(api)
		if (
			r.surface || m.windows || tagOf(view).layout === "tile" || r.y < TOP || r.y >= m.h - LOW
		) return null
		if (pulled && itemAt(opened(api, pulled), r.x, r.y) !== undefined) return null
		const OUT = 4 * u, IN = FRAME + 2 * u, reach = Math.max(GRIP, OUT + IN)
		for (const c of inView()) {
			const l = win(api, c.id)
			if (!l || l.hidden || !l.w) continue
			// where it is drawn; one let go of a moment ago where this put it, so a hand quicker than the drawing finds it
			// where it will be: each part moved as far as the side it is nearer (the grip and the right boxes with the right)
			const [dx, dy, dw, dh] = c.id === lately
				? [c.x - l.x, c.y - l.y, c.w - l.w, c.h - l.h]
				: [0, 0, 0, 0]
			const part = (p) =>
				p && { ...p, x: p.x + (2 * p.x > l.w ? dw : 0), y: p.y + (2 * p.y > l.h ? dh : 0) }
			const drawn = l.parts?.frame ??
				{ x: -FRAME, y: -TB - FRAME, w: l.w + 2 * FRAME, h: l.h + TB + 2 * FRAME }
			const f = { ...drawn, w: drawn.w + dw, h: drawn.h + dh }
			// from its content's top left (cx, cy), and from its frame's (x, y)
			const cx = r.x - l.x - dx, cy = r.y - l.y - dy, x = cx - f.x, y = cy - f.y
			if (x < -OUT || y < -OUT || x >= f.w + OUT || y >= f.h + OUT) continue
			if (["close", "minimize", "inspect"].some((p) => box(part(l.parts?.[p]), cx, cy))) {
				return null
			}
			let ns = y < IN ? "n" : y >= f.h - IN ? "s" : "",
				ew = x < IN ? "w" : x >= f.w - IN ? "e" : ""
			if (ns && !ew) ew = x < reach ? "w" : x >= f.w - reach ? "e" : ""
			else if (ew && !ns) ns = y < reach ? "n" : y >= f.h - reach ? "s" : ""
			else if (
				!ns && !ew && grips(part(l.parts?.grip), cx, cy, l.w + dw - GRIP, l.h + dh - GRIP)
			) [ns, ew] = ["s", "e"]
			if (!ns && !ew) return null
			const front = under(api, r.x, r.y), z = c.id === lately ? c.z : l.z ?? 0
			return front && front.name !== c.id && (front.z ?? 0) > z
				? null
				: { id: c.id, sides: ns + ew }
		}
		return null
	}
	// a window whose owner has on/hover gets each move over what it draws while no button is down,
	// and {event: "leave"} when the pointer goes elsewhere
	let hovered = hand.hovered ?? null // {name, owner}
	// told the pointer left it in this run, a window may let go of a shape it asked for (null: the arrow) after this has
	// written its own: this writes its own again after that (cursor, below)
	let told = false
	const hover = ({ api, call }, r) => {
		// over a window's edge the pointer is the window manager's, not what is under it
		const l = r.event !== "move" || resizing(api, r)
			? null
			: r.surface
			? { name: r.surface, ...win(api, r.surface) }
			: under(api, r.x, r.y)
		const owner = l?.owner && r.y >= l.y && idAt(api, [...l.owner, "on", "hover"])
			? l.owner
			: null
		const tell = (to, recs) => {
			try {
				call([...to, "on", "hover"], [recs])
			} catch {
				// gone
			}
		}
		if (hovered && (!owner || hovered.name !== l.name)) {
			tell(hovered.owner, [{ event: "leave" }])
			told = true
		}
		hovered = owner ? { name: l.name, owner } : null
		if (owner) tell(owner, [{ ...r, x: r.x - l.x, y: r.y - l.y, layer: l.name }])
	}
	// pointing at anything (ctl point: the world menu's Point at…, a chord): the next click opens the inspector at what
	// is under it. A window's chrome: where its look comes from, the window's own chrome or /etc/theme's window, and the
	// theme's colour its name says; anything else: its layer, as the window's page shows it (its owner, its last run's reads)
	let pointing = false
	const point = ({ api, call }, r) => {
		const m = mode(api)
		const bars = !m.windows && !r.surface
			? (r.y < TOP ? "bar" : r.y >= m.h - LOW ? "task" : null)
			: null
		const l = bars
			? { name: bars, ...win(api, bars) }
			: r.surface
			? { name: r.surface, ...win(api, r.surface) }
			: under(api, r.x, r.y)
		const name = l?.name ?? "root"
		const x = r.x - (l?.x ?? 0), y = r.y - (l?.y ?? 0)
		const inside = !!l && x >= 0 && y >= 0 && x < l.w && y < l.h
		const part = !bars && l?.title != null
			? ["close", "minimize", "inspect", "grip", "bar", "frame"].find((p) =>
				box(l.parts?.[p], x, y) && (p !== "frame" || !inside)
			)
			: null
		const ids = views.ids(api)
		let at = { page: "window" }, note
		if (part) {
			const T = val(api, ["/", "etc", "theme"]) ?? {}
			const key = ["close", "minimize", "inspect"].includes(part) ? "boxes" : part
			const own = l.chrome?.[key] !== undefined
			const look = own ? l.chrome[key] : T.window?.[key]
			const colour = look && typeof look === "object" ? look.color : undefined
			const named = typeof colour === "string" && T[colour] !== undefined
			at = own
				? { page: "node", path: ["dev", "display", "layers", name], key: ["chrome", key] }
				: named
				? { page: "node", path: ["etc", "theme"], key: [colour] }
				: {
					page: "node",
					path: ["etc", "theme"],
					key: T.window?.[key] !== undefined ? ["window", key] : [],
				}
			const item = api.content(own ? [...LAYERS, name] : ["/", "etc", "theme"]).find((i) =>
				i.versions
			)
			note = `${own ? name + " chrome" : "window"}.${key}${
				colour !== undefined ? ".color = " + colour : ""
			}${
				named
					? ` → /etc/theme ${colour}${
						Number.isInteger(T[colour])
							? " #" + T[colour].toString(16).padStart(6, "0").toUpperCase()
							: ""
					}`
					: ""
			} · set ${views.head(item?.versions?.[0], ids)}`
		} else {note = `${name}: set ${
				views.head(api.content([...LAYERS, name]).find((i) => i.versions)?.versions?.[0], ids)
			}`}
		try {
			call([...here, "on", "launch"], [{
				address: ["/", "apps", "inspect"],
				program: "programs/inspect",
				data: { window: name, at, note },
			}])
		} catch {
			// no inspector
		}
	}
	handler(given, "pointer", (g) => {
		const { api, args: [recs] } = g
		for (const r of recs) {
			if (r.event === "down" && pointing) {
				pointing = false
				point(g, r)
				continue
			}
			if (r.event === "down") {
				unselect(api)
				pick = null
				const m = mode(api)
				// a menu pulled down: a click on an item chooses it; anywhere else lets go of it, and does what it does
				const d = pulled && !r.surface ? opened(api, pulled) : null
				const hit = itemAt(d, r.x, r.y)
				// an item with items opens them, and stays
				if (hit?.it.items) {
					if (!hit.it.off) pull(api, { ...pulled, at: hit.at })
					continue
				}
				if (hit !== undefined) {
					pull(api, null)
					if (hit) choose(g, d.owner, hit.it)
					continue
				}
				const was = pulled
				if (pulled) pull(api, null)
				if (!m.windows && !r.surface && r.y < TOP) {
					const hit = bar.find((b) => r.x >= b.x0 && r.x < b.x1)
					if (hit?.side === "r") {
						emit({ type: "RightBarClick", button: r.button, item: hit.item })
					} // a title, the rabbit's too, pulls its menu down; pressed again, it goes
					else if (hit?.side === "m" && !(was && was.menu === hit.menu)) {
						pull(api, { client: focused, menu: hit.menu, x: hit.x0 })
						held = true
					}
					continue
				}
				if (!m.windows && !r.surface && r.y >= m.h - LOW) {
					const hit = low.find((b) => r.x >= b.x0 && r.x < b.x1)
					// the start button: the world menu pulled up from it; pressed again, it goes
					if (hit?.side === "s") {
						if (!was?.up) {
							pull(api, { client: focused, menu: 0, x: hit.x0, up: true })
							held = true
						}
					} else if (hit?.side === "l") {
						emit({ type: "LeftBarClick", button: r.button, item: hit.item })
					} else if (hit?.side === "t") {
						task(hit.client)
						emit({ type: "TaskBarClick", button: r.button, client: hit.client })
						settle(api)
					}
					continue
				}
				// a floating window's edge, corner or grip: that window's, though it reaches past its frame
				const edge = resizing(api, r)
				const l = edge
					? { name: edge.id, ...win(api, edge.id) }
					: r.surface
					? { name: r.surface, ...val(api, [...LAYERS, r.surface]) }
					: under(api, r.x, r.y)
				if (!l?.name) {
					emit({ type: "RootClick", button: r.button, x: r.x, y: r.y })
					continue
				}
				if (!clients.has(l.name)) {
					// an owned layer that is no window, as a menu is: it gets its clicks, with its name (its owner may have two)
					send(g, l.name, "pointer", [{ ...r, x: r.x - l.x, y: r.y - l.y, layer: l.name }])
					// one that takes drags (the desk's icons) gets every move and the up, as a window does
					if (l.drags) grab = { id: l.name, x: l.x, y: l.y }
					// the desk is the root as the policy is told: its icons are on it
					if (l.name === "desk") emit({ type: "RootClick", button: r.button, x: r.x, y: r.y })
					continue
				}
				const c = clients.get(l.name)
				raise(c.id)
				focusOn(c.id)
				emit({ type: "ClientClick", client: c.id, button: r.button })
				const tiled = tagOf(view).layout === "tile"
				// a resize: the edges pressed follow the hand, from where they were
				if (edge) {
					drag = {
						id: c.id,
						how: "resize",
						sides: edge.sides,
						from: [r.x, r.y],
						was: { x: c.x, y: c.y, w: c.w, h: c.h },
					}
				} else if (!r.surface && r.y < l.y) {
					// its boxes, where the compositor drew them (/etc/theme's window): close, minimize, and
					// inspect, a Run, as a menu item's run is, which wmiirc runs
					const at = (part) => box(l.parts?.[part], r.x - l.x, r.y - l.y)
					if (at("close")) kill(api, c.id)
					else if (at("minimize")) minimize(c)
					else if (at("inspect")) emit({ type: "Run", command: `inspect ${c.id}` })
					else if (!tiled) drag = { id: c.id, how: "move", dx: r.x - c.x, dy: r.y - c.y }
				} else {
					send(g, c.id, "pointer", [{ ...r, x: r.x - l.x, y: r.y - l.y }])
					if (l.drags) grab = { id: c.id, x: l.x, y: l.y }
					else {pick = {
							layer: c.id,
							x: l.x,
							y: l.y,
							from: [r.x - l.x, r.y - l.y],
							started: false,
						}}
				}
				placed.delete(c.id)
				settle(api)
			} else if (r.event === "move" && grab) {
				send(g, grab.id, "pointer", [{ ...r, x: r.x - grab.x, y: r.y - grab.y }])
			} else if (r.event === "move" && pick) {
				const to = [r.x - pick.x, r.y - pick.y]
				// a drag, not a shaky click: four points from where it began
				if (!pick.started && Math.hypot(to[0] - pick.from[0], to[1] - pick.from[1]) < 4 * u) {
					continue
				}
				pick.started = true
				const runs = val(api, [...DISPLAY, "text", pick.layer]) ?? []
				const sel = blit.select(runs, pick.from, to, fontOf(api))
				api.write(SELECTION, whole({ layer: pick.layer, from: pick.from, to, ...sel }))
			} else if (r.event === "move" && drag) {
				const c = clients.get(drag.id)
				if (!c) continue
				// some of its title bar kept on the screen
				if (drag.how === "move") {
					Object.assign(c, {
						x: Math.max(40 * u - c.w, Math.min(r.x - drag.dx, mode(api).w - 40 * u)),
						y: Math.max(TOP + TB + EDGE, r.y - drag.dy),
					})
				} else {
					// the edges pressed follow the hand, the others stay: no smaller than 120 by 60 points (one smaller already, no
					// smaller than it was, so no edge jumps when pressed), its top below the menu bar
					const { sides: s, from: [px, py], was } = drag
					const least = { w: Math.min(120 * u, was.w), h: Math.min(60 * u, was.h) }
					const w = /[ew]/.test(s)
						? Math.max(least.w, was.w + (s.includes("e") ? r.x - px : px - r.x))
						: was.w
					const h = /[ns]/.test(s)
						? Math.max(
							least.h,
							s.includes("s")
								? was.h + r.y - py
								: Math.min(was.h + py - r.y, was.y + was.h - TOP - TB - EDGE),
						)
						: was.h
					Object.assign(c, {
						x: s.includes("w") ? was.x + was.w - w : was.x,
						y: s.includes("n") ? was.y + was.h - h : was.y,
						w,
						h,
						sized: true,
					})
				}
				placed.delete(drag.id)
			} else if (r.event === "move" && pulled && !r.surface) {
				// over the menu, the row under it lit; over another title, that one pulled down, as System 7's slide
				const hit = r.y < TOP
					? bar.find((b) => b.side === "m" && r.x >= b.x0 && r.x < b.x1)
					: null
				if (hit && hit.menu !== pulled.menu) {
					pull(api, { client: pulled.client, menu: hit.menu, x: hit.x0 })
				} else if (!hit) {
					// the row under it lit, a submenu's opening; off them all, the submenus open stay
					const d = opened(api, pulled)
					const on = itemAt(d, r.x, r.y)
					const at = on ? on.at : d ? d.at.slice(0, d.panels.length - 1) : []
					if (JSON.stringify(pulled.at ?? []) !== JSON.stringify(at)) {
						pull(api, { ...pulled, at })
					}
				}
			} else if (r.event === "move" || r.event === "exit") {
				hover(g, r)
			} else if (r.event === "up") {
				// the button let go over an item, dragged there from its title: chosen
				const d = held && pulled && !r.surface ? opened(api, pulled) : null
				const hit = itemAt(d, r.x, r.y)
				held = false
				if (hit && !hit.it.items) {
					pull(api, null)
					choose(g, d.owner, hit.it)
				}
				if (grab) send(g, grab.id, "pointer", [{ ...r, x: r.x - grab.x, y: r.y - grab.y }])
				grab = null
				pick = null
				const ended = drag
				drag = null
				// where a drag left its window, laid out (its last move may have come with this up), and kept once the hand rests
				if (ended) {
					lately = ended.id
					relayout(api)
					restLater(g)
				}
			} else if (r.event === "scroll") {
				const l = r.surface
					? { name: r.surface, ...val(api, [...LAYERS, r.surface]) }
					: under(api, r.x, r.y)
				if (l?.name) send(g, l.name, "pointer", [{ ...r, x: r.x - l.x, y: r.y - l.y }])
			}
		}
		if (drag) relayout(api)
		// the cursor says where a drag would resize, and which way, and keeps saying it while one does
		const last = recs.at(-1)
		if (last && !grab && !pick) {
			const sides = pointing
				? null
				: drag
				? (drag.how === "resize" ? drag.sides : null)
				: resizing(api, last)?.sides
			shape(api, pointing ? HELP : ARROWS[sides] ?? null)
			// a window told it left may write its own away after this: once it has (calls run in turn), this one again
			if (told && cursor) g.call([...here, "on", "cursor"], [])
		}
		told = false
		publish(api)
	})
	// the shape this wants, written again if another wrote over it since
	handler(given, "cursor", ({ api }) => {
		if (cursor && idAt(api, CURSOR) && canon(val(api, CURSOR) ?? null) !== canon(cursor)) {
			api.write(CURSOR, whole(cursor))
		}
	})

	// a Mac window's close button, in windows mode
	effect(
		given,
		"close",
		({ api }) => val(api, [...DISPLAY, "close"]) ?? null,
		({ value: c, api }) => {
			if (c?.layer && clients.has(c.layer)) kill(api, c.layer)
		},
	)
	// the Mac's key window, in windows mode: the compositor writes it to /dev/display/focus, and the wm follows
	effect(
		given,
		"follow",
		({ api }) => ({ on: val(api, [...DISPLAY, "focus"]) ?? null, windows: !!mode(api).windows }),
		({ value: { on, windows }, api }) => {
			if (!windows || !on || on === focused || !clients.has(on)) return
			raise(on)
			focusOn(on)
			emit({ type: "FocusClient", client: on })
			publish(api)
		},
	)

	// --- the menu bar at the top: the rabbit, the focused window's menus, rbar's items; the task bar at
	// the bottom: lbar's items, a button for each window in view. Each as tall as a title bar
	const items = (api, side) =>
		listed(api, wm(side))
			.map((name) => ({ name, ...(val(api, wm(side, name)) ?? {}) }))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
	// the menus in the menu bar: the world menu (/etc/menu), then the owner's (<owner>/menus), each
	// {title, items}; beside an item that runs a command, the chord /etc/keys binds to it, else its key
	// a chord as the Mac's menus show it (mac/metal/Menus.swift, AppKit's): made readline's normal form, then
	// its modifiers' glyphs, fn ⌃ ⌥ ⇧ ⌘, and its key
	const LONG = { cmd: "s", ctrl: "C", alt: "A", shift: "S", fn: "H" }
	const GLYPHS = [["H", "fn"], ["C", "⌃"], ["A", "⌥"], ["S", "⇧"], ["s", "⌘"]]
	const NAMED = {
		return: "↩",
		tab: "⇥",
		backspace: "⌫",
		delete: "⌦",
		escape: "⎋",
		space: "Space",
		left: "←",
		right: "→",
		up: "↑",
		down: "↓",
		home: "↖",
		end: "↘",
		pageup: "⇞",
		pagedown: "⇟",
		period: ".",
		comma: ",",
		minus: "-",
		equal: "=",
		slash: "/",
		backslash: "\\",
		semicolon: ";",
		quote: "'",
		grave: "`",
		bracketleft: "[",
		bracketright: "]",
	}
	const glyphs = (chord, meta) => {
		const parts = chord.split("-")
		const mods = readline.normal(
			parts.map((p, i) => (i < parts.length - 1 ? LONG[p] ?? p : p)).join("-"),
			meta,
		).split("-")
		const key = mods.pop()
		return GLYPHS.filter(([m]) => mods.includes(m)).map(([, g]) => g).join("") +
			(NAMED[key] ?? key.toUpperCase())
	}
	const menusOf = (api, owner) => {
		const bound = {}
		const keys = val(api, ["/", "etc", "keys"])
		const meta = val(api, [...DISPLAY, "mode"])?.takeover ? "s" : "A"
		if (keys && typeof keys === "object") {
			for (const [k, c] of Object.entries(keys)) {
				if (typeof c === "string" && !(c.trim() in bound)) {
					bound[c.trim()] = readline.normal(k, meta)
				}
			}
		}
		const address = (a) =>
			Array.isArray(a) && a[0] === "/" && a.every((n) => typeof n === "string")
		// a folder's nodes that say what they run, as items, by name: /Applications's apps, {kind: "app", run, icon}
		const folder = (at) => {
			try {
				return listed(api, at).flatMap((name) => {
					const v = val(api, [...at, name])
					return typeof v?.run === "string"
						? [{
							label: name,
							run: v.run,
							...(v.icon?.kind === "picture" && Array.isArray(v.icon.rows)
								? { icon: v.icon }
								: {}),
						}]
						: []
				}).sort((a, b) => a.label.localeCompare(b.label))
			} catch {
				return []
			}
		}
		// an item's submenu, its items or a folder's (from); a check, {from, key?}, ticked while what it reads is
		// true, read as the menu is
		const items = (list, depth = 0) =>
			list.flatMap((it) => {
				if (it === "-") return ["-"]
				if (typeof it?.label !== "string") return []
				const out = { ...it }
				delete out.items
				if (depth < 4 && (Array.isArray(it.items) || address(it.from))) {
					out.items = items(Array.isArray(it.items) ? it.items : folder(it.from), depth + 1)
					if (!out.items.length) out.off = true
				}
				if (address(it.check?.from)) {
					const v = val(api, it.check.from)
					out.on = !!(typeof it.check.key === "string" ? v?.[it.check.key] : v)
				}
				const key = typeof it.run === "string" ? bound[it.run.trim()] ?? it.key : it.key
				return [{ ...out, ...(key ? { key, shown: glyphs(key, meta) } : {}) }]
			})
		const world = val(api, ["/", "etc", "menu"])
		const v = Array.isArray(owner) ? val(api, [...owner, "menus"]) : null
		return [
			{ title: "ermine", items: items(Array.isArray(world) ? world : []) },
			...(Array.isArray(v)
				? v.filter((m) => typeof m?.title === "string" && Array.isArray(m.items)).map((m) => ({
					title: m.title,
					items: items(m.items),
				}))
				: []),
		]
	}
	// an item chosen: call calls <owner>/on/<call>, or the address call; run is a Run event, which
	// wmiirc runs; key is the chord pressed, as if typed
	const choose = (g, owner, it) => {
		if (it.off) return
		if (typeof it.call === "string" || Array.isArray(it.call)) {
			try {
				g.call(
					Array.isArray(it.call) ? it.call : [...owner, "on", it.call],
					Array.isArray(it.args) ? it.args : [],
				)
			} catch {
				// a program that takes no such call
			}
		} else if (typeof it.run === "string") emit({ type: "Run", command: it.run })
		else if (typeof it.key === "string") {
			const mods = it.key.split("-"), key = mods.pop()
			press(g, [{ key, mods, down: true }, { key, mods, down: false }])
		}
	}
	// the focused window and its owner, {focus, owner}: a part of its own, so a window moving (each move a
	// change to /dev/display/windows/<its name>) costs the bar and the Mac's menus one small read, not a run
	// each: deep, so the same focus and owner, made again, is no new value
	const FOCUS = [...here, "focus"]
	compute(given, "focus", ({ api }) => {
		const focus = val(api, [...DISPLAY, "focus"]) ?? null
		return { focus, owner: focus ? win(api, focus)?.owner ?? null : null }
	}, { deep: true })
	const owned = (api) => val(api, FOCUS)?.owner ?? null
	const BARLAYER = [...LAYERS, "bar"]
	const paint = (api, at, value) => {
		if (idAt(api, at)) api.write(at, whole(value))
		else make(api, at.slice(0, -1), at.at(-1), value, { ephemeral: true })
	}
	effect(given, "bar", ({ api }) => {
		const m = mode(api)
		const owner = owned(api)
		return {
			w: m.w,
			windows: !!m.windows,
			r: items(api, "rbar"),
			T: theme(api),
			font: titles(api),
			// points kept clear at each end, for a screen with rounded corners
			pad: val(api, ["/", "etc", "desktop"])?.pad ?? 12,
			// the world menu's title: a picture, /etc/menu/icon (Paint draws it); the rabbit without one
			icon: val(api, ["/", "etc", "menu", "icon"]) ?? null,
			menus: menusOf(api, owner).map((x) => x.title),
			pulled: val(api, wm("menu"))?.menu ?? null,
		}
	}, ({ value: d, api }) => {
		const T = d.T, k = shapes(T)
		// the strip: /etc/theme's menubar colour; under a sky, frosted glass (the sky's top seen through white, one
		// colour: a layer is solid); else the paper. A line under it, the hairline where there is one
		const sky = T.wallpaper?.sky?.[0]?.[1]
		const glass = typeof T.menubar === "number"
			? T.menubar
			: typeof sky === "number"
			? mixed(0xffffff, sky, 0.6)
			: T.paper
		const f = blit.list(Math.max(1, d.w), TOP, glass)
		blit.fill(f, 0, TOP - u, d.w, u, T.hair ?? T.line)
		// below the strip kept at the top: where the bar's titles and readings sit
		const dy = (TOP - BAR) / 2
		// the one pulled down: on a pill of the soft highlight (card menus), else filled in pick (square, as System 7's)
		const pillY = dy + u, pillH = BAR - 2 * u
		const lit = (x, w) =>
			k.menus === "card"
				? rounded(f, x, pillY, w, pillH, Math.floor(pillH / 2), T.select ?? T.line)
				: blit.fill(f, x, 0, w, TOP - u, k.pick)
		const litInk = k.menus === "card" ? T.ink : k.pickInk
		// the world menu's title is the rabbit, where System 7 has its apple
		const p = Math.max(0, Math.round(d.pad)) * u
		const icon = Array.isArray(d.icon?.rows) && d.icon.rows.length ? d.icon : null
		const rows = icon ? icon.rows.map(String) : RABBIT
		const iw = Math.max(0, ...rows.map((r) => r.length)), wide = (iw + 12) * u
		if (d.pulled === 0) lit(p + 4 * u, wide)
		const iy = dy + Math.floor((BAR - rows.length * u) / 2)
		// pulled down in a square menu, its shape in the pick's ink, as the rabbit's
		const inverted = d.pulled === 0 && k.menus !== "card"
		if (icon) {
			rows.forEach((row, j) =>
				[...row].forEach((ch, i) => {
					const c = ch === " " || ch === "."
						? undefined
						: inverted
						? litInk
						: icon.colors?.[ch]
					if (typeof c === "number") blit.fill(f, p + 10 * u + i * u, iy + j * u, u, u, c)
				})
			)
		} else sprite(f, RABBIT, p + 10 * u, iy, u, inverted ? litInk : T.rose)
		bar = [{ side: "m", menu: 0, text: "world menu", x0: p + 4 * u, x1: p + 4 * u + wide }]
		let x = p + 8 * u + wide
		const ty = dy + Math.floor((BAR - blit.height(FT)) / 2)
		d.menus.forEach((title, i) => {
			if (!i) return
			const w = blit.measure(title, FT) + 20 * u
			if (d.pulled === i) lit(x, w)
			blit.text(
				f,
				x + 10 * u,
				ty,
				title,
				d.pulled === i ? litInk : T.ink,
				undefined,
				undefined,
				FT,
			)
			bar.push({ side: "m", menu: i, text: title, x0: x, x1: x + w })
			x += w + 2 * u
		})
		// the readings, quiet; with card menus a dot between each. One with a bg the theme has: on it, a pair of
		// colours (the clock's tray) a gradient across, on a pill where what is chosen is; one whose bg the theme
		// has none of, plain
		let rx = d.w - 6 * u - p
		const readings = [...d.r].reverse()
		readings.forEach((it, i) => {
			const text = String(it.text ?? it.name)
			const tw = blit.measure(text, FT)
			const bg = it.bg === undefined
				? undefined
				: Array.isArray(T[it.bg])
				? T[it.bg]
				: hue(T, it.bg, undefined)
			if (bg !== undefined) {
				const w = tw + 22 * u, colours = Array.isArray(bg) ? bg : [bg]
				rx -= w
				if (k.pill) glossy(f, rx, pillY, w, pillH, Math.floor(pillH / 2), colours)
				else blit.fill(f, rx, 0, w, TOP - u, colours[0])
				blit.text(f, rx + 11 * u, ty, text, hue(T, it.fg, T.paper), undefined, undefined, FT)
				bar.push({ side: "r", item: it.name, text, x0: rx, x1: rx + w })
			} else {
				rx -= tw
				blit.text(
					f,
					rx,
					ty,
					text,
					it.bg !== undefined ? T.ink : hue(T, it.fg, k.menus === "card" ? T.ink2 : T.ink),
					undefined,
					undefined,
					FT,
				)
				bar.push({ side: "r", item: it.name, text, x0: rx, x1: rx + tw })
			}
			if (i === readings.length - 1) return
			const gap = (k.menus === "card" ? 14 : 12) * u
			rx -= gap
			if (k.menus === "card") {
				blit.text(
					f,
					rx + Math.floor((gap - blit.measure("·", FT)) / 2),
					ty,
					"·",
					T.ink3,
					undefined,
					undefined,
					FT,
				)
			}
		})
		// to VoiceOver: the rabbit and the menus are buttons, the readings text
		const access = [{
			role: "toolbar",
			label: "menu bar",
			x: 0,
			y: 0,
			w: Math.max(1, d.w),
			h: TOP,
			children: bar.map((b) => ({
				role: b.side === "r" ? "text" : "button",
				label: b.text,
				value: b.side === "r" ? b.text : undefined,
				x: b.x0,
				y: 0,
				w: b.x1 - b.x0,
				h: TOP,
			})),
		}]
		paint(api, BARLAYER, {
			x: 0,
			y: 0,
			w: Math.max(1, d.w),
			h: TOP,
			z: 100000,
			hidden: d.windows,
			draw: f.ops,
			access,
		})
	})
	const TASK = [...LAYERS, "task"]
	// the windows in view, as their clients say: a part of its own, so a window dragged (its client written
	// each move) runs this, and the task bar only when what it shows changed (deep: the same list made again
	// is no new value)
	const SHOWN = [...here, "shown"]
	compute(given, "shown", ({ api }) => {
		const view = val(api, wm("view"))
		return listed(api, wm("client")).flatMap((id) => {
			const c = val(api, wm("client", id))
			return c?.tags?.includes(view) && !c.away
				? [{ id, label: c.label, n: c.n ?? 0, mini: !!c.mini }]
				: []
		})
	}, { deep: true })
	effect(given, "task", ({ api }) => {
		const m = mode(api)
		const shown = [...(val(api, SHOWN) ?? [])]
		return {
			w: m.w,
			h: m.h,
			windows: !!m.windows,
			l: items(api, "lbar"),
			T: theme(api),
			font: titles(api),
			focus: val(api, [...DISPLAY, "focus"]) ?? null,
			shown: shown.sort((a, b) => a.n - b.n),
			// the world menu pulled up from the start button
			start: val(api, wm("menu"))?.up === true,
		}
	}, ({ value: d, api }) => {
		const T = d.T
		const W = Math.max(1, d.w)
		if (shapes(T).dock !== "pill") return taskbar(d, api)
		// the dock: a pill of frosted glass floating over the bottom of the screen, as catclock's: wmiirc's tags a
		// segmented control, then a button for each window in view. The compositor rounds it and casts its shadow
		// (shape); it is as wide as what it holds, in the middle
		const sky = T.wallpaper?.sky?.at(-1)?.[1]
		const glass = typeof sky === "number" ? mixed(0xffffff, sky, 0.7) : T.paper
		const pad = 6 * u, bh = DOCK - 2 * pad, gap = 6 * u, th = blit.height(FT)
		const seg = d.l.map((it) => ({
			it,
			text: String(it.text ?? it.name),
			w: Math.max(bh + 4 * u, blit.measure(String(it.text ?? it.name), FT) + 20 * u),
		}))
		const track = seg.length ? seg.reduce((n, s) => n + s.w, 0) + 2 * 3 * u : 0
		// a button for each window, as wide as its title wants, no wider than 180 points; all narrower when they do not fit
		const natural = (c) => Math.min(180 * u, blit.measure(String(c.label ?? c.id), FT) + 36 * u)
		const room = W - 40 * u - 2 * pad - track - (track ? 2 * gap : 0)
		const wants = d.shown.reduce((n, c) => n + natural(c) + gap, 0)
		const squeeze = wants > room ? room / Math.max(1, wants) : 1
		const buttons = d.shown.map((c) => ({
			c,
			w: Math.max(24 * u, Math.floor(natural(c) * squeeze)),
		}))
		const dw = Math.max(
			bh + 2 * pad,
			2 * pad + track + (track && buttons.length ? 2 * gap : 0) + buttons.reduce((n, b) =>
				n + b.w + gap, 0) -
				(buttons.length ? gap : 0),
		)
		const dx = Math.floor((W - dw) / 2), dyy = d.h - LOW + Math.floor((LOW - DOCK) / 2)
		const f = blit.list(dw, DOCK, glass)
		low = []
		let x = pad
		if (seg.length) {
			// the tags: a track, the one shown a white pill on it, its name in rose, as catclock's view switch
			const ink = mixed(T.ink, glass, 0.06)
			rounded(f, x, pad, track, bh, Math.floor(bh / 2), ink)
			let sx = x + 3 * u
			for (const { it, text, w } of seg) {
				const on = it.bg !== undefined
				if (on) {
					rounded(
						f,
						sx,
						pad + 3 * u + u,
						w,
						bh - 6 * u,
						Math.floor((bh - 6 * u) / 2),
						mixed(T.ink, ink, 0.05),
					)
					rounded(f, sx, pad + 3 * u, w, bh - 6 * u, Math.floor((bh - 6 * u) / 2), 0xffffff)
				}
				blit.text(
					f,
					sx + Math.floor((w - blit.measure(text, FT)) / 2),
					pad + Math.floor((bh - th) / 2),
					text,
					on ? T.rose : hue(T, it.fg, T.ink2),
					undefined,
					undefined,
					FT,
				)
				low.push({ side: "l", item: it.name, text, x0: dx + sx, x1: dx + sx + w })
				sx += w
			}
			x += track + gap
			blit.fill(f, x, pad + 4 * u, u, bh - 8 * u, T.hair ?? T.line)
			x += gap
		}
		for (const { c, w } of buttons) {
			// the focused one on a pink pill, a dot of pink before its name; a minimized one faint, its window not on the desk
			const on = c.id === d.focus
			if (on) rounded(f, x, pad, w, bh, Math.floor(bh / 2), T.select ?? T.line)
			const r = Math.max(2 * u, Math.floor(3 * u))
			blit.fillellipse(
				f,
				x + 14 * u,
				pad + Math.floor(bh / 2),
				r,
				r,
				on ? T.pink ?? T.rose : c.mini ? T.hair ?? T.ink3 : T.ink3,
			)
			let text = String(c.label ?? c.id)
			const fits = w - 30 * u
			if (blit.measure(text, FT) > fits) {
				while (text.length && blit.measure(text + "…", FT) > fits) text = text.slice(0, -1)
				text += "…"
			}
			blit.text(
				f,
				x + 24 * u,
				pad + Math.floor((bh - th) / 2),
				text,
				on ? T.ink : c.mini ? T.ink3 : T.ink2,
				undefined,
				undefined,
				FT,
			)
			low.push({
				side: "t",
				client: c.id,
				text: (c.mini ? "minimized " : "") + (c.label ?? c.id),
				x0: dx + x,
				x1: dx + x + w,
			})
			x += w + gap
		}
		const access = [{
			role: "toolbar",
			label: "dock",
			x: dx,
			y: dyy,
			w: dw,
			h: DOCK,
			children: low.map((b) => ({
				role: "button",
				label: b.side === "l" ? `view ${b.text}` : b.text,
				x: b.x0,
				y: dyy,
				w: b.x1 - b.x0,
				h: DOCK,
			})),
		}]
		paint(api, TASK, {
			x: dx,
			y: dyy,
			w: dw,
			h: DOCK,
			z: 100000,
			hidden: d.windows,
			draw: f.ops,
			access,
			shape: { radius: DOCK / 2 / u, shadow: true },
		})
	})
	// the task bar across the bottom, as tall as the menu bar: /etc/theme's start button first (it pulls the world
	// menu up), then lbar's items (wmiirc's tags), then a button for each window in view. Its buttons as the theme's
	// are: "raised", Windows 98's, the focused one pressed; else framed, the focused one filled in pick, its cherry
	const taskbar = (d, api) => {
		const T = d.T, k = shapes(T), W = Math.max(1, d.w), up = k.buttons === "raised"
		const f = blit.list(W, BAR, up ? T.chrome ?? T.paper : T.paper)
		if (up) {
			blit.fill(f, 0, 0, W, u, T.light ?? 0xdfdfdf)
			blit.fill(f, 0, u, W, u, T.hi ?? 0xffffff)
		} else blit.fill(f, 0, 0, W, u, T.line)
		low = []
		const by = up ? 4 * u : 2 * u,
			bh = up ? BAR - 6 * u : BAR - 3 * u,
			ty = by + Math.floor((bh - blit.height(FT)) / 2)
		let x = up ? 4 * u : 6 * u
		if (k.start) {
			// Start: the rabbit and the word, bold, raised (pressed while the world menu is up)
			const w = blit.measure(k.start, FT) + 34 * u, on = d.start
			if (up) {
				blit.fill(f, x, by, w, bh, T.chrome ?? T.paper)
				raised(f, x, by, w, bh, T, on)
			} else {
				if (on) blit.fill(f, x, by, w, bh, k.pick)
				for (let i = 0; i < u; i++) blit.frame(f, x + i, by + i, w - 2 * i, bh - 2 * i, T.line)
			}
			sprite(
				f,
				RABBIT,
				x + 6 * u,
				by + Math.floor((bh - RABBIT.length * u) / 2),
				u,
				on && !up ? k.pickInk : T.rose,
			)
			blit.text(
				f,
				x + 26 * u,
				ty,
				k.start,
				on && !up ? k.pickInk : T.ink,
				undefined,
				undefined,
				FT,
			)
			low.push({ side: "s", text: k.start, x0: x, x1: x + w })
			x += w + 6 * u
		}
		for (const it of d.l) {
			const text = ` ${it.text ?? it.name} `
			const w = blit.measure(text, FT)
			// a lit item: pressed (raised buttons); else it reads as a pulled-down menu title: inverted
			const lit = it.bg !== undefined
			if (up) {
				blit.fill(f, x, by, w, bh, T.chrome ?? T.paper)
				raised(f, x, by, w, bh, T, lit)
				blit.text(f, x, ty, text, hue(T, it.fg, T.ink), undefined, undefined, FT)
			} else {
				if (lit) blit.fill(f, x, u, w, BAR - u, k.pick)
				blit.text(
					f,
					x,
					4 * u,
					text,
					lit ? k.pickInk : hue(T, it.fg, T.ink),
					undefined,
					undefined,
					FT,
				)
			}
			low.push({ side: "l", item: it.name, text: it.text ?? it.name, x0: x, x1: x + w })
			x += w + 2 * u
		}
		x += 4 * u
		if (up) {
			blit.fill(f, x, by, u, bh, T.lo ?? 0x808080)
			blit.fill(f, x + u, by, u, bh, T.hi ?? 0xffffff)
		} else blit.fill(f, x, u, u, BAR - u, T.line)
		x += 7 * u
		// a button for each window, as wide as its share and no wider than a title wants
		const room = W - x - 6 * u, gap = 4 * u
		const bw = Math.max(
			24 * u,
			Math.min(180 * u, Math.floor(room / Math.max(1, d.shown.length)) - gap),
		)
		for (const c of d.shown) {
			if (x + bw > W) break
			const on = c.id === d.focus
			if (up) {
				blit.fill(f, x, by, bw, bh, on ? T.light ?? 0xdfdfdf : T.chrome ?? T.paper)
				raised(f, x, by, bw, bh, T, on)
			} else {
				if (on) blit.fill(f, x, by, bw, bh, k.pick)
				// a minimized one, grey: its window is not on the desk
				for (let i = 0; i < u; i++) {
					blit.frame(f, x + i, by + i, bw - 2 * i, bh - 2 * i, c.mini ? T.ink3 : T.line)
				}
				// the focused one's cherry
				if (on) blit.fill(f, x + 4 * u, by + 4 * u, 3 * u, bh - 8 * u, T.cherry)
			}
			let text = c.label ?? c.id
			const fits = bw - 16 * u
			if (blit.measure(text, FT) > fits) {
				while (text.length && blit.measure(text + "…", FT) > fits) text = text.slice(0, -1)
				text += "…"
			}
			blit.text(
				f,
				x + 11 * u,
				ty,
				text,
				on && !up ? k.pickInk : c.mini ? T.ink3 : T.ink,
				undefined,
				undefined,
				FT,
			)
			low.push({
				side: "t",
				client: c.id,
				text: (c.mini ? "minimized " : "") + (c.label ?? c.id),
				x0: x,
				x1: x + bw,
			})
			x += bw + gap
		}
		const access = [{
			role: "toolbar",
			label: "task bar",
			x: 0,
			y: d.h - BAR,
			w: W,
			h: BAR,
			children: low.map((b) => ({
				role: "button",
				label: b.side === "l" ? `view ${b.text}` : b.text,
				x: b.x0,
				y: d.h - BAR,
				w: b.x1 - b.x0,
				h: BAR,
			})),
		}]
		paint(api, TASK, {
			x: 0,
			y: d.h - BAR,
			w: W,
			h: BAR,
			z: 100000,
			hidden: d.windows,
			draw: f.ops,
			access,
		})
	}
	// the menu pulled down, under its title: a layer of the wm's, its clicks the wm's (the pointer handler)
	const PULL = [...LAYERS, "pull"]
	// the layer of a submenu k deep, pull-<k>; hidden, while shown, once it is not
	const sublayer = (k) => [...LAYERS, `pull-${k}`]
	const hide = (api, at) => {
		if (idAt(api, at) && !val(api, at)?.hidden) api.write(at, set("hidden", true))
	}
	effect(given, "pull", ({ api }) => {
		const p = val(api, wm("menu")) ?? null
		const at = p ? val(api, wm("menu", "at")) ?? null : null
		return { d: opened(api, p && at ? { ...p, at } : p), T: theme(api), font: titles(api) }
	}, ({ value: { d, T }, api }) => {
		if (!d) {
			for (const at of [PULL, ...[1, 2, 3, 4].map(sublayer)]) hide(api, at)
			return
		}
		// a layer for the menu, and one for each submenu open (pull-1, pull-2…), drawn where it sits: as the theme's
		// menus are, square or a card
		if (shapes(T).menus !== "card") return squareMenus(d, T, api)
		// a card: its corners round and its shadow soft (shape), the row the hand is on a pink pill, as catclock's places
		d.panels.forEach((q, k) => {
			const { w, h } = q
			const f = blit.list(w, h, T.paper)
			const ring = T.hair ?? T.line, r = 10 * u
			// its edge a hairline, rounded as its shape is
			blit.fill(f, r, 0, w - 2 * r, u, ring)
			blit.fill(f, r, h - u, w - 2 * r, u, ring)
			blit.fill(f, 0, r, u, h - 2 * r, ring)
			blit.fill(f, w - u, r, u, h - 2 * r, ring)
			for (
				const [cx, cy, cl] of [
					[r, r, { x: 0, y: 0, w: r, h: r }],
					[w - r - 1, r, { x: w - r, y: 0, w: r, h: r }],
					[r, h - r - 1, { x: 0, y: h - r, w: r, h: r }],
					[w - r - 1, h - r - 1, { x: w - r, y: h - r, w: r, h: r }],
				]
			) {
				blit.ellipse(f, cx, cy, r, r, u, ring, cl)
			}
			q.rows.forEach(({ y0, y1, it }, i) => {
				if (it === "-") {
					return blit.fill(f, 12 * u, y0 + Math.floor((y1 - y0) / 2), w - 24 * u, u, ring)
				}
				const lit = i === d.at[k] && !it.off
				const ink = it.off ? T.ink3 : T.ink
				if (lit) rounded(f, 6 * u, y0, w - 12 * u, y1 - y0, 8 * u, T.select ?? T.line)
				const mid = y0 + Math.floor((y1 - y0) / 2), ty = mid - Math.floor(blit.height(FT) / 2)
				if (it.on) sprite(f, TICK, 8 * u, mid - 3 * u, u, lit ? T.rose : ink)
				// an app's icon, a point a pixel
				if (it.icon) {
					it.icon.rows.forEach((row, j) =>
						[...String(row)].forEach((ch, c) => {
							const colour = ch === " " || ch === "." ? undefined : it.icon.colors?.[ch]
							if (typeof colour === "number") {
								blit.fill(f, 16 * u + c * u, mid - 8 * u + j * u, u, u, colour)
							}
						})
					)
				}
				blit.text(f, q.left, ty, it.label, ink, undefined, undefined, FT)
				if (it.shown) {
					blit.text(
						f,
						w - 14 * u - blit.measure(it.shown, FT),
						ty,
						it.shown,
						T.ink3,
						undefined,
						undefined,
						FT,
					)
				}
				// a submenu's: a small chevron pointing to it
				if (it.items) {
					for (let t = 0; t < 4; t++) {
						blit.fill(
							f,
							w - 18 * u + t * u,
							mid - (3 - t) * u,
							u,
							(7 - 2 * t) * u,
							lit ? T.rose : T.ink3,
						)
					}
				}
			})
			const access = [{
				role: "menu",
				label: k ? d.at.slice(0, k).reduce((m, i) => m.items[i], d.menu).label : d.menu.title,
				x: 0,
				y: 0,
				w,
				h,
				children: q.rows.filter((r) => r.it !== "-").map((r) => ({
					role: "menuitem",
					label: [
						r.it.label,
						r.it.on ? "checked" : null,
						r.it.items ? "submenu" : null,
						r.it.shown,
					].filter((t) => t).join(", "),
					x: u,
					y: r.y0,
					w: w - 2 * u,
					h: r.y1 - r.y0,
				})),
			}]
			paint(api, k ? sublayer(k) : PULL, {
				x: q.x,
				y: q.y,
				w,
				h,
				z: 150000 + k,
				draw: f.ops,
				access,
				shape: { radius: 10, shadow: true },
			})
		})
		// submenus no longer open
		for (let k = d.panels.length; k <= 4; k++) hide(api, sublayer(k))
	})

	// square menus, System 7's: the paper (/etc/theme's menu colour, if it has one) in a line with a hard shadow,
	// the row the hand is on filled in pick, its words in pickInk; with raised buttons, Windows 98's: raised, and
	// no shadow (the layer's corner clear)
	const squareMenus = (d, T, api) => {
		const k = shapes(T), S = 2 * u, up = k.buttons === "raised"
		d.panels.forEach((q, n) => {
			const { w, h } = q
			const f = blit.list(w + S, h + S)
			if (!up) blit.fill(f, S, S, w, h, T.line)
			blit.fill(f, 0, 0, w, h, T.menu ?? T.paper)
			if (up) raised(f, 0, 0, w, h, T)
			else for (let i = 0; i < u; i++) blit.frame(f, i, i, w - 2 * i, h - 2 * i, T.line)
			const inset = up ? 3 * u : u
			q.rows.forEach(({ y0, y1, it }, i) => {
				if (it === "-") {
					const my = y0 + Math.floor((y1 - y0) / 2)
					if (up) {
						blit.fill(f, inset, my, w - 2 * inset, u, T.lo ?? 0x808080)
						return blit.fill(f, inset, my + u, w - 2 * inset, u, T.hi ?? 0xffffff)
					}
					return blit.fill(f, u, my, w - 2 * u, u, T.ink3)
				}
				const lit = i === d.at[n] && !it.off
				const ink = lit ? k.pickInk : it.off ? T.ink3 : T.ink
				if (lit) blit.fill(f, inset, y0, w - 2 * inset, y1 - y0, k.pick)
				const mid = y0 + Math.floor((y1 - y0) / 2), ty = mid - Math.floor(blit.height(FT) / 2)
				if (it.on) sprite(f, TICK, 4 * u, mid - 3 * u, u, ink)
				// an app's icon, a point a pixel; lit, its shape in pickInk
				if (it.icon) {
					it.icon.rows.forEach((row, j) =>
						[...String(row)].forEach((ch, c) => {
							const colour = ch === " " || ch === "."
								? undefined
								: lit
								? k.pickInk
								: it.icon.colors?.[ch]
							if (typeof colour === "number") {
								blit.fill(f, 12 * u + c * u, mid - 8 * u + j * u, u, u, colour)
							}
						})
					)
				}
				blit.text(f, q.left, ty, it.label, ink, undefined, undefined, FT)
				if (it.shown) {
					blit.text(
						f,
						w - 12 * u - blit.measure(it.shown, FT),
						ty,
						it.shown,
						lit ? k.pickInk : T.ink3,
						undefined,
						undefined,
						FT,
					)
				}
				// a submenu's: a triangle pointing to it
				if (it.items) {
					for (let t = 0; t < 4; t++) {
						blit.fill(f, w - 14 * u + t * u, mid - (3 - t) * u, u, (7 - 2 * t) * u, ink)
					}
				}
			})
			const access = [{
				role: "menu",
				label: n ? d.at.slice(0, n).reduce((m, i) => m.items[i], d.menu).label : d.menu.title,
				x: 0,
				y: 0,
				w,
				h,
				children: q.rows.filter((r) => r.it !== "-").map((r) => ({
					role: "menuitem",
					label: [
						r.it.label,
						r.it.on ? "checked" : null,
						r.it.items ? "submenu" : null,
						r.it.shown,
					].filter((t) => t).join(", "),
					x: u,
					y: r.y0,
					w: w - 2 * u,
					h: r.y1 - r.y0,
				})),
			}]
			paint(api, n ? sublayer(n) : PULL, {
				x: q.x,
				y: q.y,
				w: w + S,
				h: h + S,
				z: 150000 + n,
				draw: f.ops,
				access,
				...(up ? { over: true } : {}),
			})
		})
		for (let n = d.panels.length; n <= 4; n++) hide(api, sublayer(n))
	}

	// --- the Mac's menu bar: the same menus, through /dev/display/menus and /dev/display/chosen
	const MENUS = [...DISPLAY, "menus"], CHOSEN = [...DISPLAY, "chosen"]
	// what the Mac shows, as this last wrote it, by its n: a choice made from an older one is let be
	let mac = { n: val(api, MENUS)?.n ?? 0, owner: null, menus: [] }
	effect(given, "mac", ({ api }) => {
		const owner = owned(api)
		return { owner, menus: menusOf(api, owner) }
	}, ({ value: v, api }) => {
		mac = { ...v, n: mac.n + 1 }
		const item = (it) => (it === "-" ? "-" : {
			label: it.label,
			...(typeof it.key === "string" ? { key: it.key } : {}),
			...(it.off ? { off: true } : {}),
			...(it.on ? { on: true } : {}),
			...(it.icon ? { icon: it.icon } : {}),
			...(it.items ? { items: it.items.map(item) } : {}),
		})
		if (idAt(api, MENUS)) {
			api.write(
				MENUS,
				whole({
					n: mac.n,
					menus: v.menus.map((m) => ({ title: m.title, items: m.items.map(item) })),
				}),
			)
		}
	})
	let chosen = val(api, CHOSEN)?.n ?? 0
	effect(given, "chosen", ({ api }) => val(api, CHOSEN) ?? null, (g) => {
		const { api, value: c } = g
		if (!c || !(c.n > chosen)) return
		chosen = c.n
		if (c.for !== mac.n) return
		// one in a submenu: sub its place in each, down from item
		let it = mac.menus[c.menu]?.items[c.item]
		for (const k of Array.isArray(c.sub) ? c.sub : []) it = it?.items?.[k]
		if (it && it !== "-" && !it.items) choose(g, mac.owner, it)
		publish(api)
	})

	// --- the root, under everything
	const ROOT = [...LAYERS, "root"]
	// a picture, as My Computer (/programs/computer) keeps them: {kind: "picture", colors: {letter: 0xRRGGBB}, rows, tile?}
	const picture = (api) => {
		const at = val(api, ["/", "etc", "desktop", "picture"])
		if (!Array.isArray(at) || at.some((n) => typeof n !== "string")) return null
		const v = val(api, ["/", ...at])
		return v?.kind === "picture" && Array.isArray(v.rows) && v.rows.length &&
				v.rows.every((r) => typeof r === "string")
			? v
			: null
	}
	// catclock's sky, onto the root's list: a gradient down the screen (one column of it, repeated across), two clouds,
	// soft (rings of white, each a little stronger, as a blurred edge falls off), and two low hills along their curves,
	// as catclock's page draws them (its SVG's numbers, scaled). The near hill's height at x, for what sits on it
	const skyOf = (list, d, T, wp) => {
		const stops = wp.sky.filter((s) => Array.isArray(s) && typeof s[1] === "number").sort((
			a,
			b,
		) => a[0] - b[0])
		const tint = (t) => {
			let k = 0
			while (k < stops.length - 2 && t > stops[k + 1][0]) k++
			const [a, b] = [stops[k], stops[k + 1] ?? stops[k]]
			return b[0] > a[0]
				? mixed(b[1], a[1], Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))))
				: a[1]
		}
		const column = blit.form(1, d.h, 0)
		for (let y = 0; y < d.h; y++) column.bits[y] = tint(y / Math.max(1, d.h - 1))
		blit.tile(list, 0, 0, d.w, d.h, column)
		// the clouds: the SVG 1600 × 500 fitted across the top, its blur 16 of its units
		const U = d.u,
			W = d.w / U,
			k = Math.min(W / 1600, 1),
			oy = (500 - 500 * k) / 2,
			blur = 16 * k * U
		const strength = typeof wp.clouds === "number" ? wp.clouds : 0.7
		// a blurred edge's cover at distance t out from it: the normal distribution's tail
		const tail = (t) => 0.5 * (1 - Math.tanh(0.7978845608 * (t + 0.044715 * t * t * t)))
		const clouds = [[[240, 110, 170, 34], [320, 92, 90, 36]], [[1220, 80, 190, 34], [
			1300,
			62,
			96,
			36,
		]]]
		if (strength > 0) {
			for (const cloud of clouds) {
				const cy = (oy + cloud[0][1] * k) * U, under = tint(cy / Math.max(1, d.h - 1))
				for (let t = 2.5; t >= -2.25; t -= 0.35) {
					const colour = mixed(0xffffff, under, strength * tail(t))
					for (const [x, y, rx, ry] of cloud) {
						const a = rx * k * U + t * blur, b = ry * k * U + t * blur
						if (a >= 1 && b >= 1) {
							blit.fillellipse(
								list,
								Math.round(x * k * U),
								Math.round((oy + y * k) * U),
								Math.round(a),
								Math.round(b),
								colour,
							)
						}
					}
				}
			}
		}
		// the hills: 1600 × 200 stretched across the bottom 150 points
		const hills = Array.isArray(wp.hills) ? wp.hills : []
		const paths = [
			[0, 120, [[300, 50, 560, 60, 820, 115], [1060, 165, 1300, 95, 1600, 70]]],
			[0, 170, [[320, 125, 640, 130, 940, 165], [1180, 190, 1400, 160, 1600, 145]]],
		]
		const X = (x) => Math.round((x / 1600) * d.w),
			Y = (y) => Math.round(d.h - 150 * U + (y / 200) * 150 * U)
		let near = null
		paths.forEach(([x0, y0, curves], i) => {
			if (typeof hills[i] !== "number") return
			const points = [X(x0), Y(y0)]
			let [px, py] = [x0, y0]
			for (const [ax, ay, bx, by, cx, cy] of curves) {
				for (let n = 1; n <= 48; n++) {
					const t = n / 48, s = 1 - t
					points.push(
						X(s * s * s * px + 3 * s * s * t * ax + 3 * s * t * t * bx + t * t * t * cx),
						Y(s * s * s * py + 3 * s * s * t * ay + 3 * s * t * t * by + t * t * t * cy),
					)
				}
				;[px, py] = [cx, cy]
			}
			const edge = points.slice()
			points.push(d.w, d.h, 0, d.h)
			blit.fillpoly(list, points, "nonzero", hills[i])
			near = edge
		})
		// the near hill's top at x: between the two points about it
		return near && ((x) => {
			for (let i = 2; i < near.length; i += 2) {
				if (near[i] >= x) {
					const [x0, y0, x1, y1] = [near[i - 2], near[i - 1], near[i], near[i + 1]]
					return Math.round(x1 > x0 ? y0 + ((x - x0) / (x1 - x0)) * (y1 - y0) : y1)
				}
			}
			return near.at(-1)
		})
	}
	// the hint, as XP's balloon: a layer of its own over the root, butter on the sky, round, its shadow soft (shape),
	// its tail (drawn on the root, under it) pointing up at the rabbit; an i in a blue disc, the hint's first part
	// bold, the rest under it. None: hidden
	const HINT = [...LAYERS, "hint"]
	const balloon = (api, hint, root, d, T, F) => {
		if (!hint) {
			if (idAt(api, HINT) && !val(api, HINT)?.hidden) api.write(HINT, set("hidden", true))
			return
		}
		const [head, ...rest] = hint.split(" · ")
		const pad = 16 * u, lh = blit.height(F) + 3 * u, disc = 20 * u
		const w =
			Math.max(disc + 9 * u + blit.measure(head, FT), ...rest.map((t) => blit.measure(t, F))) +
			2 * pad
		const h = pad + Math.max(disc, blit.height(FT)) + 6 * u + rest.length * lh + pad - 3 * u
		const p = Math.max(0, Math.round(val(api, ["/", "etc", "desktop"])?.pad ?? 12)) * u
		const x = p + 4 * u, y = TOP + 12 * u
		const bg = T.balloon ?? T.paper
		const f = blit.list(w, h, bg)
		// its edge, a ring of gold faint enough to be a hairline, rounded as its shape is
		const ring = mixed(0xaa8c3c, bg, 0.22), r = 12 * u
		blit.fill(f, r, 0, w - 2 * r, u, ring)
		blit.fill(f, r, h - u, w - 2 * r, u, ring)
		blit.fill(f, 0, r, u, h - 2 * r, ring)
		blit.fill(f, w - u, r, u, h - 2 * r, ring)
		for (
			const [cx, cy, cl] of [
				[r, r, { x: 0, y: 0, w: r, h: r }],
				[w - r - 1, r, { x: w - r, y: 0, w: r, h: r }],
				[r, h - r - 1, { x: 0, y: h - r, w: r, h: r }],
				[w - r - 1, h - r - 1, { x: w - r, y: h - r, w: r, h: r }],
			]
		) {
			blit.ellipse(f, cx, cy, r, r, u, ring, cl)
		}
		// the i: a blue disc, lit from its top left, smooth
		const info = blit.form(disc, disc, 0)
		for (let j = 0; j < disc; j++) {
			for (let i = 0; i < disc; i++) {
				const cover = Math.max(
					0,
					Math.min(1, disc / 2 + 0.5 - Math.hypot(i + 0.5 - disc / 2, j + 0.5 - disc / 2)),
				)
				const lit = Math.min(
					1,
					Math.hypot(i + 0.5 - disc * 0.35, j + 0.5 - disc * 0.3) / (disc * 0.75),
				)
				info.bits[j * disc + i] =
					(((255 - Math.round(cover * 255)) << 24) | mixed(0x4a95e6, 0x9fd0ff, lit)) >>> 0
			}
		}
		blit.blit(f, pad, pad, info, 0, 0, disc, disc, "blend")
		blit.text(
			f,
			pad + Math.floor((disc - blit.measure("i", FT)) / 2),
			pad + Math.floor((disc - blit.height(FT)) / 2),
			"i",
			0xffffff,
			undefined,
			undefined,
			FT,
		)
		blit.text(
			f,
			pad + disc + 9 * u,
			pad + Math.floor((disc - blit.height(FT)) / 2),
			head,
			T.ink,
			undefined,
			undefined,
			FT,
		)
		rest.forEach((t, i) =>
			blit.text(f, pad, pad + disc + 6 * u + i * lh, t, T.ink, undefined, undefined, F)
		)
		// the tail, on the root under its top edge, near its left: a corner of the balloon turned up at the rabbit
		const tx = x + 22 * u, ty = y
		blit.fillpoly(root, [tx - 8 * u, ty + u, tx, ty - 8 * u, tx + 8 * u, ty + u], "nonzero", bg)
		blit.line(root, tx - 8 * u, ty, tx, ty - 8 * u, u, ring)
		blit.line(root, tx, ty - 8 * u, tx + 8 * u, ty, u, ring)
		paint(api, HINT, {
			x,
			y,
			w,
			h,
			z: -990,
			draw: f.ops,
			shape: { radius: 12, shadow: { color: 0x786428, opacity: 0.12, radius: 12, x: 0, y: 6 } },
			access: [{ role: "text", label: hint, x, y, w, h }],
		})
	}

	effect(given, "root", ({ api }) => {
		const m = mode(api)
		return {
			w: m.w,
			h: m.h,
			u: m.unit ?? 1,
			T: theme(api),
			hint: val(api, ["/", "etc", "desktop"])?.hint ?? null,
			// the desktop picture: /etc/desktop/picture, a path, read through, so editing the picture redraws the desk
			picture: picture(api),
			// how it covers the screen: centre (half the screen, whole pixels), fit, fill (cropped), stretch
			fit: val(api, ["/", "etc", "desktop"])?.fit ?? "centre",
			font: String(face(api, "text") ?? "rom"),
			// the bars' heights, BAR, TOP and LOW, with the title font
			title: titles(api),
		}
	}, ({ value: d, api }) => {
		const T = d.T
		// the paper as ops, small enough to read: every read of the layers carries it
		const list = blit.list(d.w, d.h)
		// how much of each the desk is: a riso print (the grain, the inks not lining up), and
		// chee's rabbits (the rabbit and its cherries), 1 as they were
		const riso = 0.76, rabbits = 1.19
		// riso grain: a speckle, the same every time, on a tile the screen repeats; riso as much, and as dark
		const G = 128
		const grain = blit.form(G, G, T.desk)
		const mix = (a, b, t) =>
			[16, 8, 0].reduce(
				(c, k) => c | (Math.round(((a >> k) & 255) * t + ((b >> k) & 255) * (1 - t)) << k),
				0,
			)
		const speck = mix(T.grain, T.desk, riso)
		let seed = 7
		const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
		for (let i = 0; i < Math.round(((G * G) / 40) * riso); i++) {
			grain.bits[Math.floor(rand() * G * G)] = speck
		}
		const p = d.picture
		// with no picture, /etc/theme's wallpaper: {style: "sky", sky, clouds, hills} catclock's candy sky, two clouds
		// and low hills far away; {style: "flat"} the desk's colour alone; none ("riso"), the grain and the rabbit
		const wp = !p && Array.isArray(d.T.wallpaper?.sky) && d.T.wallpaper.style !== "flat"
			? d.T.wallpaper
			: null
		const flat = !p && !wp && d.T.wallpaper?.style === "flat"
		if (flat) blit.fill(list, 0, 0, d.w, d.h, T.desk)
		else if (!p?.tile && !wp) blit.tile(list, 0, 0, d.w, d.h, grain)
		// a pattern, a tile the screen repeats, each of its pixels four points; a letter not in its colors the desk
		if (p?.tile) {
			const s = 4 * d.u, pw = Math.max(...p.rows.map((r) => r.length)), ph = p.rows.length
			const tile = blit.form(pw * s, ph * s, T.desk)
			p.rows.forEach((row, j) =>
				[...row].forEach((ch, i) => {
					if (typeof p.colors?.[ch] === "number") {
						blit.fill(tile, i * s, j * s, s, s, p.colors[ch])
					}
				})
			)
			blit.tile(list, 0, 0, d.w, d.h, tile)
		} else if (p) {
			// a picture on the grain, in the middle, as /etc/desktop's fit says; a fill for each run of one colour
			const pw = Math.max(...p.rows.map((r) => r.length)), ph = p.rows.length
			const big = Math.max(d.w / pw, d.h / ph), small = Math.min(d.w / pw, d.h / ph)
			const [sx, sy] = d.fit === "stretch"
				? [d.w / pw, d.h / ph]
				: d.fit === "fill"
				? [big, big]
				: d.fit === "fit"
				? [small, small]
				: Array(2).fill(Math.max(1, Math.floor(Math.min(d.w, d.h) / 2 / Math.max(pw, ph))))
			const x0 = Math.floor((d.w - pw * sx) / 2), y0 = Math.floor((d.h - ph * sy) / 2)
			// each pixel's edges rounded down, so neighbours meet with no gap whatever the scale
			const X = (i) => x0 + Math.floor(i * sx), Y = (j) => y0 + Math.floor(j * sy)
			p.rows.forEach((row, j) => {
				for (let i = 0, k; i < row.length; i = k) {
					for (k = i; k < row.length && row[k] === row[i]; k++);
					const c = p.colors?.[row[i]]
					if (typeof c === "number") {
						blit.fill(list, X(i), Y(j), X(k) - X(i), Y(j + 1) - Y(j), c)
					}
				}
			})
		}
		let ground = null
		if (wp) ground = skyOf(list, d, T, wp)
		// with none, a rabbit and a cherry, printed in two colours that do not quite line up: under the sky,
		// smaller, sitting on the near hill
		if (!p && !flat) {
			const s = ground ? 3 * d.u : Math.max(4, Math.round((Math.min(d.w, d.h) / 90) * rabbits))
			const rx = ground ? Math.round(d.w * 0.07) : d.w - RABBIT[0].length * s - 70
			const ry = ground
				? ground(rx + 7 * s) - RABBIT.length * s + 2 * s
				: d.h - LOW - RABBIT.length * s - 60
			// the blue a little off the pink, riso as far off as it was (in whole pixels)
			const off = ground ? d.u : Math.max(1, Math.round(2 * riso)),
				stem = Math.max(1, Math.round(off / 2))
			sprite(list, RABBIT, rx + off, ry + off, s, T.risoBlue)
			sprite(list, RABBIT, rx, ry, s, T.risoPink)
			const cherry = (cx, cy, r) => blit.fillellipse(list, cx, cy, r, r, T.cherry)
			const cx = ground ? rx + RABBIT[0].length * s + 9 * s : rx - 9 * s,
				cy = ground ? ground(cx) - Math.round(1.6 * s) : ry + RABBIT.length * s - 3 * s
			for (let i = 0; i <= 5 * s; i++) {
				blit.fill(list, cx - Math.floor(i / 2) + stem, cy - 2 * s - i + stem, 2, 2, T.risoBlue)
				blit.fill(
					list,
					cx + Math.floor(i / 3) + 2 * s + stem,
					cy - 2 * s - i + stem,
					2,
					2,
					T.risoBlue,
				)
				blit.fill(list, cx - Math.floor(i / 2), cy - 2 * s - i, 2, 2, T.mint)
				blit.fill(list, cx + Math.floor(i / 3) + 2 * s, cy - 2 * s - i, 2, 2, T.mint)
			}
			cherry(cx - 2 * s, cy, Math.round(1.6 * s))
			cherry(cx + 3 * s, cy + s, Math.round(1.6 * s))
		}
		const hint = d.hint ??
			"the rabbit is the world menu · drag a title bar to move, an edge to resize · the policy is /programs/wmiirc"
		const F = face(api, "text")
		// the hint, on the plain desk only ("" none): under the sky, XP's balloon, pointing up at the rabbit; else a text run
		// the hint as the theme's hint says: a balloon, or a plain line of text above the task bar
		const balloonish = shapes(T).hint === "balloon"
		if (!p && hint && !balloonish) {
			blit.text(
				list,
				16 * u,
				d.h - LOW - blit.height(F) - 10 * u,
				hint,
				T.deskInk ?? T.ink3,
				undefined,
				undefined,
				F,
			)
		}
		balloon(api, !p && hint && balloonish ? hint : null, list, d, T, F)
		const value = { x: 0, y: 0, w: d.w, h: d.h, z: -1000, draw: list.ops }
		paint(api, ROOT, value)
	})
	return { served: "/dev/wm" }
}
