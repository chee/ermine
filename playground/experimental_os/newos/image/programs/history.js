// /programs/history: History, every browser window's tabs' histories in one
// window: each window, each tab (open, then closed), and its entries as a
// tree, oldest first: a line at its depth, and where it forks each line from
// there set in one under the fork, in the order gone on. Each entry its time,
// title and address; where the tab is now (here, the browser's view) marked
// in cherry. Read from the graph alone: the windows' documents
// (/apps/browser/tabs/<window>, each tab a document in it), the histories of
// those documents (/dev/sync/history, asked for in
// /dev/sync/want/history-<pid>), the browsers' views. "Show All History…"
// in a browser's History menu (cmd-shift-y), or "History…" in the world menu.
//
//   Typing filters by title and address (readline's keys). Up and down
//   choose, PageUp and PageDown, the wheel scrolls; Return or a click goes
//   there, in its tab (the browser's on/menu, visit: its window started
//   again, by its name, when it is not running); cmd-Return opens it in a new
//   tab of that window. Escape empties the search.
//
// The search, the entry chosen, the scroll: <its node>/view, ephemeral, read
// as it changes: a field another writes is taken on.
//
// /dev/sync/history is the sync driver's (newos/drv_sync.c): a tab document's changes as the card
// holds them, each a blop, its name the commit an entry is known by, so a boot brings them back.
import { effect, handler, idAt, make, val, whole } from "ermine:kit"
import { here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, self } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const owner = here(self)
	const blit = blitter(api)
	let F, FT
	// a font from what the font driver wrote; the font ROM until it has
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
	let W = Math.min(720 * u, mode.w - 60 * u), H = Math.min(560 * u, mode.h - 80 * u)
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `history-${self}`]
	const WINDOWS = ["/", "dev", "display", "windows"]
	const THEME = ["/", "etc", "theme"]
	const TABS = ["/", "apps", "browser", "tabs"]
	const WANT = ["/", "dev", "sync", "want", `history-${self}`]
	const HISTORY = ["/", "dev", "sync", "history"]
	const set = (key, value) => ({ path: [key], value })
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
	const bare = (url) => (url ? url.replace(/^[a-z]+:\/\//i, "") : "")
	// the node at address written whole, or made there (ephemeral) if none is
	const keepAt = (api, address, value) => {
		if (idAt(api, address)) api.write(address, whole(value))
		else make(api, address.slice(0, -1), address.at(-1), value, { ephemeral: true })
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
			dim: T.ink3 ?? 0xa89aa2,
			lemon: T.select ?? T.lemon ?? 0xffff88,
			cherry: T.cherry ?? 0xd2244a,
			rose: T.rose ?? 0xe2457c,
			// a chosen row, as catclock's chosen cells: rose, its name white
			pick: T.pick ?? T.line ?? 0x1c1a17,
		})
	colours(val(api, THEME))
	const menus = [{
		title: "History",
		items: [
			{ label: "Go There", key: "Enter", call: "menu", args: ["go"] },
			{ label: "Open in a New Tab", key: "cmd-Enter", call: "menu", args: ["open"] },
			"-",
			{ label: "Close", key: "cmd-w" },
		],
	}]
	keepAt(api, [...owner, "menus"], menus)

	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (120 + (n % 5) * 30) * u,
			y: (70 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "History",
			owner,
			draw: [],
		}, { ephemeral: true })
	}

	// the view: the search (a readline field), the entry chosen (window, tab, commit), the scroll
	const VIEW = [...owner, "view"]
	const s = { field: { text: "", pos: 0 }, chosen: null, scroll: 0, ...(val(api, VIEW) ?? {}) }
	let viewed = val(api, VIEW) ?? null
	const keep = (api) => {
		if (viewed && same(viewed, s)) return
		keepAt(api, VIEW, s)
		viewed = JSON.parse(JSON.stringify(s))
	}
	// a key since the last draw: the entry chosen scrolled into view
	let reveal = true

	// --- the histories, as the browser reads them: a change setting from (or the first value with an address) is an
	// entry, one setting the address or the title alone the newest entry's; up the entry it came from (from; none:
	// the one before). A patch at path [] is the whole value, one at [key] sets that key
	const entries = (h) => {
		const list = []
		let v = {}
		for (const c of h?.changes ?? []) {
			if (c.kind !== "write") continue
			const ps = c.patches ?? []
			if (c.value) v = c.value
			else {for (const p of ps) {
					if (!p.path?.length) v = p.value ?? {}
					else if (p.path.length === 1) v = { ...v, [p.path[0]]: p.value }
				}}
			const last = list.at(-1)
			const nav = ps.some((p) =>
				(!p.path?.length && p.value?.url) || (p.path?.length === 1 && p.path[0] === "from")
			)
			if (nav && v.url) {
				list.push({
					commit: c.commit,
					url: v.url ?? "",
					title: v.title ?? "",
					when: v.when ?? null,
					from: v.from ?? null,
				})
			} else if (last) {
				Object.assign(last, { url: v.url || last.url, title: v.title ?? last.title })
			}
		}
		const by = new Map(list.map((x) => [x.commit, x]))
		list.forEach((x, i) => {
			const up = x.from ? by.get(x.from) : null
			Object.assign(x, { i, up: up && up.i < i ? up : i ? list[i - 1] : null, kids: [] })
		})
		for (const x of list) x.up?.kids.push(x)
		// where it is drawn: a line goes on at its depth; at a fork each line from it is set in one, in the order gone on
		for (const x of list) {
			Object.assign(x, {
				fork: (x.up?.kids.length ?? 0) > 1,
				depth: !x.up ? 0 : x.up.depth + (x.up.kids.length > 1),
			})
		}
		return { list, by }
	}
	// every window's tabs: [{window, running, tabs: [{id, closed, doc, h, here}]}], as the graph has them
	let windows = []
	const windowsOf = (api) => {
		const out = []
		for (const win of api.children(TABS)) {
			if (!api.children(TABS, win).some((x) => x.node)) continue
			const w = val(api, [...TABS, win])
			if (!Array.isArray(w?.tabs)) continue
			const docs = new Map(
				api.children([...TABS, win]).map((n) => [
					n,
					api.children([...TABS, win], n).find((x) => x.node)?.id,
				]),
			)
			const view = val(api, ["/", "apps", "browser", win, "view"]) ?? null
			const ids = [
				...w.tabs.map((id) => [id, false]),
				...(w.closed ?? []).map((c) => [c?.id, true]),
			].filter(([id]) => typeof id === "number")
			out.push({
				window: win,
				running: !!idAt(api, ["/", "apps", "browser", win]),
				// its menus' handler there: what a visit is asked of (a browser started is there after its setup)
				ready: !!idAt(api, ["/", "apps", "browser", win, "on", "menu"]),
				tabs: ids.map(([id, closed]) => {
					const doc = docs.get(String(id))
					return {
						id,
						closed,
						doc,
						h: typeof doc === "string" ? historyOf(api, doc) : null,
						here: view?.here?.[id] ?? null,
					}
				}),
			})
		}
		return out
	}
	// a document's history, /dev/sync/history/<its id>: none while sync serves none (an id that is no name has none)
	const historyOf = (api, doc) => {
		try {
			return val(api, [...HISTORY, doc.replace(/^ermine:/, "")]) ?? null
		} catch {
			return null
		}
	}
	// the rows shown: a window's, a tab's, then its entries depth first, each line under the entry it left, in the order
	// gone on; with a search, only the entries it finds (and their tab and window)
	const rowsOf = () => {
		const q = s.field.text.trim().toLowerCase()
		const rows = []
		for (const w of windows) {
			const wrows = []
			w.tabs.forEach((t, k) => {
				const { list } = entries(t.h)
				if (!list.length) return
				const at = t.here ? list.find((x) => x.commit === t.here) : list.at(-1)
				const trows = []
				const stack = list.filter((x) => !x.up).reverse()
				while (stack.length) {
					const y = stack.pop()
					if (!q || y.title.toLowerCase().includes(q) || y.url.toLowerCase().includes(q)) {
						trows.push({
							kind: "entry",
							window: w.window,
							tab: t.id,
							x: y,
							here: y === at && !t.closed,
						})
					}
					stack.push(...[...y.kids].reverse())
				}
				if (!trows.length) return
				const newest = list.at(-1)
				wrows.push({
					kind: "tab",
					window: w.window,
					tab: t.id,
					text: `${t.closed ? "closed" : `tab ${k + 1}`}: ${newest.title || bare(newest.url)}`,
					closed: t.closed,
				}, ...trows)
			})
			if (wrows.length) {
				rows.push({
					kind: "window",
					window: w.window,
					text: `${w.running ? "browser" : "browser, not running"} ${w.window}`,
				}, ...wrows)
			}
		}
		return rows
	}
	const picks = (rows) => rows.filter((r) => r.kind === "entry")
	const key = (r) => (r ? { window: r.window, tab: r.tab, commit: r.x.commit } : null)
	const chosenOf = (rows) => rows.find((r) => r.kind === "entry" && same(key(r), s.chosen)) ?? null

	// --- drawing
	const TOP = () => blit.height(F) + 18 * u
	const ROW = () => blit.height(F) + 6 * u
	const FOOT = () => blit.height(F) + 10 * u
	const clock = (ms) => {
		if (!ms) return ""
		const d = new Date(ms), two = (n) => String(n).padStart(2, "0")
		return `${d.getDate()} ${
			"JanFebMarAprMayJunJulAugSepOctNovDec".slice(d.getMonth() * 3, d.getMonth() * 3 + 3)
		} ${two(d.getHours())}:${two(d.getMinutes())}`
	}
	let shown = [] // the rows drawn, with where: {y, h, row}
	let caret = null
	const draw = () => {
		const f = blit.list(W, H, C.paper)
		const th = blit.height(F), top = TOP(), rh = ROW(), foot = FOOT()
		// the search
		blit.fill(f, 0, 0, W, top, C.chrome)
		blit.fill(f, 0, top - u, W, u, C.line)
		const b = { x: 8 * u, y: 5 * u, w: W - 16 * u, h: th + 8 * u }
		blit.fill(f, b.x, b.y, b.w, b.h, C.line)
		blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi)
		const clip = { x: b.x + u, y: b.y, w: b.w - 2 * u, h: b.h }, t = s.field.text
		const sel = readline.selection(s.field)
		if (sel) {
			blit.fill(
				f,
				b.x + 6 * u + blit.measure(t.slice(0, sel[0]), F),
				b.y + 4 * u,
				blit.measure(t.slice(sel[0], sel[1]), F),
				th,
				C.lemon,
				clip,
			)
		}
		if (t) blit.text(f, b.x + 6 * u, b.y + 4 * u, t, C.ink, undefined, clip, F)
		else {blit.text(
				f,
				b.x + 6 * u,
				b.y + 4 * u,
				"search every tab's history: a title or an address",
				C.dim,
				undefined,
				clip,
				F,
			)}
		const cx = Math.min(b.x + b.w - 3 * u, b.x + 6 * u + blit.measure(t.slice(0, s.field.pos), F))
		blit.fill(f, cx, b.y + 4 * u, 2 * u, th, C.rose)
		caret = { x: cx, y: b.y + 4 * u, h: th }
		// the rows; the first entry chosen when none is
		const rows = rowsOf(), seen = Math.max(1, Math.floor((H - top - foot) / rh))
		if (!chosenOf(rows)) s.chosen = key(picks(rows)[0])
		// the keyboard keeps the entry chosen in view; the wheel lets it go
		const at = rows.indexOf(chosenOf(rows))
		if (reveal && at >= 0 && at < s.scroll) s.scroll = at
		if (reveal && at >= s.scroll + seen) s.scroll = at - seen + 1
		reveal = false
		s.scroll = Math.max(0, Math.min(s.scroll, rows.length - seen))
		shown = []
		const tw = 96 * u
		rows.slice(s.scroll, s.scroll + seen).forEach((r, i) => {
			const y = top + i * rh, ty = y + 3 * u
			shown.push({ y, h: rh, row: r })
			if (r.kind === "window") {
				blit.fill(f, 0, y, W, rh, C.lo)
				blit.text(f, 8 * u, ty, r.text, C.ink, undefined, undefined, FT)
				return
			}
			if (r.kind === "tab") {
				blit.text(f, 14 * u, ty, r.text, r.closed ? C.dim : C.ink, undefined, {
					x: 0,
					y,
					w: W - 8 * u,
					h: rh,
				}, FT)
				blit.fill(f, 14 * u, y + rh - u, W - 28 * u, u, C.lo)
				return
			}
			const lit = r === chosenOf(rows)
			if (lit) blit.fill(f, 0, y, W, rh, C.pick ?? C.line)
			const ink = lit ? C.paper : C.ink, dim = lit ? C.paper : C.dim
			blit.text(f, 22 * u, ty, clock(r.x.when), dim, undefined, {
				x: 0,
				y,
				w: 22 * u + tw - 6 * u,
				h: rh,
			}, F)
			let x = 22 * u + tw + Math.min(r.x.depth, 12) * 16 * u
			// a line from a fork: a corner before its first
			if (r.x.fork) {
				blit.fill(f, x - 12 * u, y + 2 * u, u, Math.floor(rh / 2) - u, dim)
				blit.fill(f, x - 12 * u, y + Math.floor(rh / 2), 7 * u, u, dim)
			}
			if (r.here) {
				blit.fill(f, x, y + Math.floor(rh / 2) - 2 * u, 4 * u, 4 * u, lit ? C.paper : C.cherry)
			}
			x += 8 * u
			const end = blit.text(f, x, ty, r.x.title || bare(r.x.url), ink, undefined, {
				x,
				y,
				w: W - x - 8 * u,
				h: rh,
			}, F)
			if (r.x.title) {
				blit.text(f, end + 12 * u, ty, bare(r.x.url), dim, undefined, {
					x: end,
					y,
					w: Math.max(0, W - end - 8 * u),
					h: rh,
				}, F)
			}
		})
		if (!rows.length) {
			blit.text(
				f,
				16 * u,
				top + 12 * u,
				t ? "nothing found" : "no history: a browser's tabs keep theirs here",
				C.dim,
				undefined,
				undefined,
				F,
			)
		}
		const fy = H - foot
		blit.fill(f, 0, fy, W, foot, C.chrome)
		blit.fill(f, 0, fy, W, u, C.line)
		const n = picks(rows).length
		blit.text(
			f,
			8 * u,
			fy + 5 * u,
			`${n} ${
				n === 1 ? "entry" : "entries"
			}   return or a click: go there   cmd-return: a new tab`,
			C.dim,
			undefined,
			undefined,
			F,
		)
		return { ops: f.ops, rows }
	}
	const paint = (api) => {
		if (!idAt(api, LAYER)) return
		const { ops } = draw()
		const access = [{
			role: "list",
			label: "History",
			x: 0,
			y: 0,
			w: W,
			h: H,
			children: shown.map(({ y, h, row }) => ({
				role: row.kind === "entry" ? "row" : "heading",
				label: row.kind === "entry"
					? `${row.x.title || bare(row.x.url)}, ${clock(row.x.when)}`
					: row.text,
				value: row.kind === "entry" ? same(key(row), s.chosen) : undefined,
				x: 0,
				y,
				w: W,
				h,
			})),
		}]
		const input = caret
			? {
				text: s.field.text,
				selection: [s.field.pos, s.field.pos],
				caret: { x: caret.x, y: caret.y, w: 2 * u, h: caret.h },
			}
			: null
		api.write(LAYER, [
			set("w", W),
			set("h", H),
			set("draw", ops),
			set("access", access),
			set("input", input),
			set("title", "History"),
		])
		keep(api)
	}

	// --- going there: the browser window the tab is in, its on/menu; started again by its name when it is not running,
	// and asked once its on/menu is there (calling): a process started runs its setup after the part that started it
	let calling = null // {window, args}
	const ask = (call, window, args) => {
		try {
			call(["/", "apps", "browser", window, "on", "menu"], args)
		} catch {
			// gone meanwhile
		}
	}
	const go = ({ api, start, call }, fresh) => {
		const rows = rowsOf(), r = chosenOf(rows)
		if (!r) return
		const args = fresh ? ["open", r.x.url] : ["visit", r.tab, r.x.commit]
		calling = null
		if (!idAt(api, ["/", "apps", "browser", r.window])) {
			const op = {
				address: ["/", "apps", "browser"],
				program: ["programs", "browser"],
				name: r.window,
			}
			const launch = val(api, ["/", "dev", "wm", "launch"])
			try {
				Array.isArray(launch) ? call(launch, [op]) : start(op)
			} catch {
				return
			}
		}
		if (idAt(api, ["/", "apps", "browser", r.window, "on", "menu"])) ask(call, r.window, args)
		else calling = { window: r.window, args }
	}
	const move = (by) => {
		const p = picks(rowsOf()), i = p.findIndex((r) => same(key(r), s.chosen))
		const to = p[Math.max(0, Math.min(p.length - 1, i < 0 ? 0 : i + by))]
		if (to) s.chosen = key(to)
	}

	handler(given, "key", (g) => {
		const { api, args: [recs] } = g
		reveal = true
		for (const r of recs) {
			if (r.event === "commit") {
				s.field = readline.type(s.field, r) ?? s.field
				continue
			}
			if (!r.down) continue
			const cmd = r.mods?.includes("cmd")
			if (r.key === "Enter") go(g, cmd)
			else if (r.key === "ArrowUp") move(-1)
			else if (r.key === "ArrowDown") move(1)
			else if (r.key === "PageUp") move(-10)
			else if (r.key === "PageDown") move(10)
			else if (r.key === "Escape") s.field = { text: "", pos: 0 }
			else {
				const f = readline.type(s.field, r, { select: true, api })
				if (f) {
					if (f.text !== s.field.text) s.scroll = 0
					s.field = f
				}
			}
		}
		paint(api)
	})
	// a trackpad's scroll comes a few pixels a record: what is not yet a whole row is kept for the next
	let rest = 0
	handler(given, "pointer", (g) => {
		const { api, args: [recs] } = g
		for (const r of recs) {
			if (r.event === "scroll") {
				rest += r.dy / ROW()
				const n = Math.trunc(rest)
				rest -= n
				s.scroll = Math.max(0, s.scroll + n)
				continue
			}
			if (r.event !== "down") continue
			const z = shown.find((z) => r.y >= z.y && r.y < z.y + z.h)
			if (z?.row.kind !== "entry") continue
			s.chosen = key(z.row)
			go(g, r.mods?.includes("cmd") || r.button === 2)
		}
		paint(api)
	})
	handler(given, "menu", (g) => {
		const [what] = g.args
		go(g, what === "open")
		paint(g.api)
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

	// --- following the windows, their tabs and histories; the look; the size the window manager gives (from
	// /dev/display/windows, not its own layer, which changes each time it draws)
	let wanted = null
	effect(given, "follow", ({ api }) => ({
		windows: windowsOf(api),
		theme: val(api, THEME) ?? null,
		fonts: fonts(api),
		want: val(api, [...WINDOWS, LAYER.at(-1)])?.want ?? null,
		// where sync asks for a history from, once it is there
		synced: !!idAt(api, WANT.slice(0, -1)),
	}), ({ value: v, api, call }) => {
		windows = v.windows
		// a browser started to go there, set up: asked
		if (calling && windows.some((w) => w.window === calling.window && w.ready)) {
			const { window, args } = calling
			calling = null
			ask(call, window, args)
		}
		if (v.theme) colours(v.theme)
		if (v.want) {
			W = Math.max(360 * u, v.want.w)
			H = Math.max(200 * u, v.want.h)
		}
		// every tab's history, asked for
		const want = windows.flatMap((w) => w.tabs.map((t) => t.doc)).filter((d) =>
			typeof d === "string"
		).sort()
		if (!same(want, wanted) && idAt(api, WANT.slice(0, -1))) {
			keepAt(api, WANT, want)
			wanted = want
		}
		paint(api)
	})
}
