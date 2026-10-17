// /programs/browser: a web browser with tabs. ermine's own tab strip and toolbar over the selected
// tab's page: a view it places in /dev/web/views, shown by the layer's "web" field. input over the
// page goes to /dev/web/driver/on/input; the pointer takes the page's cursor (/etc/cursors). click
// the page and it has the keyboard; click the strip or toolbar, or cmd-l, and ermine has it back.
// the /etc/browser live (6) most recent tabs keep a view; older ones sleep (grey title) and load
// again when selected. a page that would open another opens as a tab after it.
//
//   /apps/browser/tabs/<name>             {tabs: [id], at, n, closed: [{id, at}]}
//   /apps/browser/tabs/<name>/<id>        {url, title, when, from, opener?}: a change a navigation
//   /apps/browser/tabs/<name>/<id>/state  the engine's history and scroll, restored at boot
//
// a tab's history is its node's (/dev/sync/history, wanted in /dev/sync/want/browser-<pid>): a
// tree. back and forward only move "here" in it, through WebKit's list when it agrees, else
// loading the address. history (cmd-y): a popup of every tab's, searched as typed.
//
//   cmd-t new tab, cmd-w close (the last: the window; s-w in /etc/keys: the wm's close first),
//   cmd-shift-t reopen, ctrl-tab / cmd-shift-] next, ctrl-shift-tab / cmd-shift-[ previous,
//   cmd-1…8 that one, cmd-9 the last; cmd-l address (readline's keys), cmd-[ cmd-] back/forward,
//   cmd-r reload, cmd-y history, cmd-shift-y all of it in a window (/programs/history).
//   strip: click selects, its box or a middle click closes, drag moves, + new tab.
import { data, drop, effect, handler, idAt, key, make, val, whole } from "ermine:kit"
import { here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, self, name } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls; its place, where
	// its tabs are kept
	const me = here(self), place = me.slice(0, -1)
	const blit = blitter(api)
	// the strip and toolbar in /dev/font/text, or the font ROM until it comes
	const fontOf = (api) => {
		const v = val(api, ["/", "dev", "font", "text"])
		return v ? font(v) : undefined
	}
	let F = fontOf(api)
	const settings = val(api, ["/", "etc", "browser"]) ?? {}
	// how many tabs keep their page loaded: the selected one and those selected last
	const LIVE = Math.max(1, Number(settings.live) || 6)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(1100 * u, mode.w - 80 * u), H = Math.min(720 * u, mode.h - 80 * u)
	let SH = blit.height(F) + 10 * u, TOOL = blit.height(F) + 14 * u
	const VIEWS = ["/", "dev", "web", "views"], PAGES = ["/", "dev", "web", "pages"]
	const LAYERS = ["/", "dev", "display", "layers"]
	const LAYER = [...LAYERS, `browser-${self}`]
	const POP = [...LAYERS, `browser-${self}-history`]
	const WINDOW = [...place, "tabs", name]
	const TAB = (id) => [...WINDOW, String(id)]
	const WANT = ["/", "dev", "sync", "want", `browser-${self}`]
	const HISTORY = ["/", "dev", "sync", "history"]
	// a document's history is named by its id's 64 hex digits: a name never holds "/" (ermine://)
	const historyOf = (doc) => [...HISTORY, doc.replace(/^ermine:\/\//, "")]
	const VIEW = [...me, "view"]
	const copy = (v) => JSON.parse(JSON.stringify(v))
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

	const normal = (text) => {
		const t = text.trim()
		if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t
		if (/^[^\s]+\.[^\s]+$/.test(t)) return "https://" + t
		return (settings.search ?? "https://duckduckgo.com/?q=") + encodeURIComponent(t)
	}
	const bare = (url) => (url ? url.replace(/^[a-z]+:\/\//i, "") : "")

	// --- the tabs: the window's document and each tab's, beside the process, which a boot brings back; these their copy
	const boot = data(given)
	const first = boot?.url ?? boot?.args?.join(" ") ?? settings.home ?? "https://webkit.org"
	make(api, place, "tabs", null)
	if (!idAt(api, WINDOW)) {
		make(api, WINDOW.slice(0, -1), name, { tabs: [0], at: 0, n: 1, closed: [] })
		make(api, WINDOW, "0", { url: normal(first), title: "", when: Date.now(), from: null })
	}
	const s = { tabs: [], at: 0, n: 0, closed: [], ...val(api, WINDOW) }
	// a window an older browser kept, its tabs inside its document: each its own, once, its address and state kept; a
	// closed one too
	if (s.tabs.some((t) => t && typeof t === "object")) {
		const made = (t, id) => {
			make(api, WINDOW, String(id), {
				url: t.url ?? "",
				title: t.title ?? "",
				when: null,
				from: null,
				...(t.from != null ? { opener: t.from } : {}),
			})
			if (t.state) make(api, TAB(id), "state", t.state)
			return id
		}
		s.tabs = s.tabs.map((t) => made(t, t.id))
		s.closed = (s.closed ?? []).map((c) => ({ id: made(c, s.n++), at: c.at ?? 0 }))
		api.write(WINDOW, whole(s))
	}
	let kept = copy(s)
	// each tab's value (open and closed), as its node holds it; the patches waiting to be written to it, a change each
	const T = new Map()
	for (const id of [...s.tabs, ...s.closed.map((c) => c.id)]) {
		T.set(id, { url: "", title: "", ...(val(api, TAB(id)) ?? {}) })
	}
	const pend = new Map()
	const queue = (id, patches) => pend.set(id, [...(pend.get(id) ?? []), ...patches])
	// a page's state to be kept: id -> the engine's, or null (gone: the tab went somewhere else)
	const states = new Map()
	const said = new Map() // tab id -> its page's state as last seen
	// what a boot lets go, inside the process's node: the address being typed (a readline field, or null), the tabs
	// selected last, last first; a tab being dragged along the strip; where each tab is in its history (here: tab id ->
	// its entry, none at the newest), the branch last on under each entry (last), the move or load asked of a page and
	// not yet seen (wait); the history popup (pop: {field, at, top}, or null)
	const e = {
		field: null,
		used: [],
		drag: null,
		here: {},
		last: {},
		wait: {},
		pop: null,
		...(val(api, VIEW) ?? {}),
	}
	let viewed = val(api, VIEW) ?? null
	// its menus, in the menu bar while its window has the focus (/programs/wmii): each item calls on/menu, its
	// key only shown; the Tabs menu, each tab
	const item = (text, short, ...args) => ({
		label: text,
		...(short ? { key: short } : {}),
		call: "menu",
		args,
	})
	const menus = () => [
		{
			title: "File",
			items: [
				item("New Tab", "cmd-t", "new"),
				item("Open Location…", "cmd-l", "location"),
				"-",
				item("Close Tab", "cmd-w", "close"),
				{ ...item("Reopen Closed Tab", "cmd-shift-t", "reopen"), off: !s.closed.length },
			],
		},
		{
			title: "View",
			items: [
				item("Reload", "cmd-r", "reload"),
				"-",
				item("Next Tab", "ctrl-Tab", "next"),
				item("Previous Tab", "ctrl-shift-Tab", "prev"),
			],
		},
		{
			title: "History",
			items: [
				{ ...item("Back", "cmd-[", "back"), off: !can(-1) },
				{ ...item("Forward", "cmd-]", "forward"), off: !can(1) },
				"-",
				item("Show History…", "cmd-y", "history"),
				item("Show All History…", "cmd-shift-y", "all"),
			],
		},
		{
			title: "Tabs",
			items: s.tabs.map((id, i) =>
				item(
					`${i === s.at ? "• " : ""}${label(id)}`,
					i < 8 ? `cmd-${i + 1}` : i === s.tabs.length - 1 ? "cmd-9" : null,
					"select",
					i,
				)
			),
		},
	]
	let shown = null
	let gone = false
	// the tabs' documents' ids, as the window's folder lists them: what the histories are asked by
	const docs = (api) =>
		new Map(
			api.children(WINDOW).map((n) => [n, api.children(WINDOW, n)[0]?.id]).filter(([, id]) =>
				typeof id === "string"
			),
		)
	let wanted = null
	const keep = (api) => {
		if (!same(kept, s)) {
			api.write(WINDOW, whole(s))
			kept = copy(s)
		}
		for (const [id, patches] of pend) {
			if (patches.length && idAt(api, TAB(id))) api.write(TAB(id), patches)
		}
		pend.clear()
		for (const [id, state] of states) {
			if (!idAt(api, TAB(id))) continue
			if (idAt(api, [...TAB(id), "state"])) api.write([...TAB(id), "state"], whole(state))
			else if (state) make(api, TAB(id), "state", state)
		}
		states.clear()
		if (!viewed || !same(viewed, e)) {
			if (viewed) api.write(VIEW, whole(e))
			else make(api, me, "view", e, { ephemeral: true })
			viewed = copy(e)
		}
		// the histories wanted: every tab's, the closed ones' too
		const want = [...docs(api).values()].sort()
		if (!same(want, wanted)) {
			if (idAt(api, WANT)) api.write(WANT, whole(want))
			else make(api, WANT.slice(0, -1), WANT.at(-1), want, { ephemeral: true })
			wanted = want
		}
		const m = menus()
		if (same(shown, m)) return
		if (idAt(api, [...me, "menus"])) api.write([...me, "menus"], whole(m))
		else make(api, me, "menus", m, { ephemeral: true })
		shown = m
	}

	// --- the histories: each tab's node's changes, as /dev/sync/history serves them, made entries. A change setting
	// from (or the first value with an address) is an entry; one setting the address alone (a redirect) or the title
	// is the newest entry's. Each entry {commit, url, title, when, i, up, kids}: up the entry it came from (from;
	// none: the one before it), so they are a tree
	const hist = new Map() // tab id -> {list, by}, from the history last read
	// a visit asked for before its tab's history had the entry (not served yet): {id, commit}
	let going = null
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
		// where History and the popup set it: a line goes on at its depth; at a fork each line from it is set in one
		for (const x of list) {
			Object.assign(x, {
				fork: (x.up?.kids.length ?? 0) > 1,
				depth: !x.up ? 0 : x.up.depth + (x.up.kids.length > 1),
			})
		}
		return { list, by }
	}
	const newest = (id) => hist.get(id)?.list.at(-1) ?? null
	// where a tab is: the entry here names, else its newest
	const hereOf = (id) => (e.here[id] && hist.get(id)?.by.get(e.here[id])) || newest(id)
	// what a tab shows: here's entry, or its node's value while it has no history yet
	const shownOf = (id) =>
		(e.here[id] && hist.get(id)?.by.get(e.here[id])) || T.get(id) || { url: "", title: "" }
	const label = (id) => {
		const t = shownOf(id)
		return t.title || bare(t.url) || "New Tab"
	}
	// forward from x: the branch last on, else the newest
	const ahead = (
		x,
	) => (x ? x.kids.find((k) => k.commit === e.last[x.commit]) ?? x.kids.at(-1) ?? null : null)
	// whether the selected tab can go back (-1) or forward (1): its history's, or its page's while it has none
	const can = (d) => {
		const id = s.tabs[s.at]
		if (id === undefined) return false
		if (!hist.get(id)?.list.length) return !!pageOf(id)?.[d < 0 ? "back" : "forward"]
		return d < 0 ? !!hereOf(id)?.up : !!ahead(hereOf(id))
	}

	// --- each tab's page: a view of its own while it is live
	const nameOf = (id) => `web-${self}-${id}`
	const tab = () => s.tabs[s.at] ?? null
	const views = (api) => new Set(api.children(VIEWS))
	// each live page as last read (the pages effect's); the selected one's read again where it matters
	let P = new Map()
	const pageOf = (id) => P.get(id) ?? null
	const page = (api, id) => (id !== null ? val(api, [...PAGES, nameOf(id)]) ?? null : null)
	// a tab's page loaded, if it has an address, and the tab the one used last; then the live ones beyond LIVE
	// let go, the selected one never, the least recently used first
	const wake = (api, id) => {
		const have = views(api)
		if (id !== null) {
			e.used = [id, ...e.used.filter((x) => x !== id)]
			const url = shownOf(id).url
			if (url && !have.has(nameOf(id))) {
				const state = val(api, [...TAB(id), "state"])
				make(api, VIEWS, nameOf(id), {
					url,
					...(typeof state === "string" && state ? { state } : {}),
				}, { ephemeral: true })
				have.add(nameOf(id))
			}
		}
		e.used = e.used.filter((x) => s.tabs.includes(x))
		const order = (x) => (x === tab() ? -1 : e.used.includes(x) ? e.used.indexOf(x) : Infinity)
		const live = s.tabs.filter((x) => have.has(nameOf(x))).sort((a, b) => order(a) - order(b))
		for (const x of live.slice(LIVE)) sleep(api, x)
	}
	const sleep = (api, id) => {
		drop(api, VIEWS, nameOf(id))
		seen.delete(id)
	}
	const page$ = (api) => page(api, tab())
	const viewOf = (api) => (tab() !== null ? val(api, [...VIEWS, nameOf(tab())]) ?? null : null)
	const ask = (api, patches) => {
		if (viewOf(api)) api.write([...VIEWS, nameOf(tab())], patches)
	}
	const go = (api, what) => ask(api, [...key("go", what), ...key("n", (viewOf(api)?.n ?? 0) + 1)])
	const focusPage = (api, on) =>
		ask(api, [...key("focus", on), ...key("fn", (viewOf(api)?.fn ?? 0) + 1)])

	const select = (api, i) => {
		if (!s.tabs.length) return
		s.at = Math.max(0, Math.min(s.tabs.length - 1, i))
		e.field = shownOf(tab()).url ? null : { text: "", pos: 0 }
		wake(api, tab())
		focusPage(api, !e.field)
	}
	// a new tab, its own document: at the end (or at), or opened by a page, after that page's tab and those it opened
	// before; selected, unless behind
	const open = (api, url, { behind = false, after = null, at = s.tabs.length } = {}) => {
		const id = s.n++
		const t = { url: url ?? "", title: "", when: Date.now(), from: null }
		const was = tab()
		at = Math.max(0, Math.min(s.tabs.length, at))
		if (after !== null && s.tabs[after] !== undefined) {
			t.opener = s.tabs[after]
			at = after + 1
			while (at < s.tabs.length && T.get(s.tabs[at])?.opener === t.opener) at++
		}
		make(api, WINDOW, String(id), t)
		T.set(id, t)
		s.tabs.splice(at, 0, id)
		if (was !== null) s.at = s.tabs.indexOf(was)
		if (behind) wake(api, id)
		else select(api, at)
	}
	// a tab's document, unplaced
	const forget = (api, id) => {
		drop(api, WINDOW, String(id))
		T.delete(id)
		hist.delete(id)
	}
	const close = (api, i) => {
		const id = s.tabs[i]
		if (id === undefined) return
		sleep(api, id)
		const was = tab()
		s.tabs.splice(i, 1)
		e.used = e.used.filter((x) => x !== id)
		delete e.here[id]
		delete e.wait[id]
		if (!s.tabs.length) {
			// the last tab: its tabs go, and the window, with this process (as a window's close box kills it)
			drop(api, WINDOW.slice(0, -1), name)
			gone = true
			drop(api, place, name, self)
			return
		}
		// kept, its history with it, until 20 more are closed; a tab that never had a page goes at once
		if (T.get(id)?.url) s.closed = [...s.closed, { id, at: i }]
		else forget(api, id)
		while (s.closed.length > 20) forget(api, s.closed.shift().id)
		// the selected one closed: the one used last; else it stays selected
		const back = e.used.map((x) => s.tabs.indexOf(x)).find((k) => k >= 0)
		select(api, id === was ? back ?? Math.min(i, s.tabs.length - 1) : s.tabs.indexOf(was))
	}
	// the last closed, where it was, its history and state its own
	const reopen = (api) => {
		const c = s.closed.pop()
		if (!c) return
		const at = Math.max(0, Math.min(s.tabs.length, c.at))
		s.tabs.splice(at, 0, c.id)
		select(api, at)
	}

	// --- going places in a tab's history
	// a new entry: the tab's node set to it, from the entry here (none: the one before, the newest), in one change
	const record = (id, url, title = "") => {
		const t = T.get(id)
		if (!t) return
		Object.assign(t, { url, title, when: Date.now(), from: e.here[id] ?? null })
		// the page's title until its next is the last page's
		olds.set(id, pageOf(id)?.title ?? null)
		queue(id, [
			...key("url", url),
			...key("title", title),
			...key("when", t.when),
			...key("from", t.from),
		])
		delete e.here[id]
		states.set(id, null)
	}
	const olds = new Map()
	// the newest entry's address put right (a redirect, replaceState), or its title: no entry of its own
	const amend = (id, field, value) => {
		const t = T.get(id)
		if (!t || t[field] === value) return
		t[field] = value
		queue(id, key(field, value))
	}
	const navigate = (api, text) => {
		const id = tab()
		if (!text.trim() || id === null) return
		const url = normal(text)
		record(id, url)
		e.field = null
		// the page's next list is this load's: an address it ends at is this entry's
		e.wait[id] = { typed: true }
		if (viewOf(api)) {
			ask(api, [
				...key("url", url),
				...key("go", "load"),
				...key("n", (viewOf(api)?.n ?? 0) + 1),
			])
		}
		wake(api, id)
		focusPage(api, true)
	}
	// WebKit's way from entry a to entry b: that far along its back and forward list, when the addresses it holds
	// between are theirs; else null
	const offset = (a, b, L) => {
		if (!L?.urls || !a || L.urls[L.at] !== a.url) return null
		for (let y = a, k = 0; y; y = y.up, k++) {
			if (k && L.urls[L.at - k] !== y.url) break
			if (y === b) return -k
		}
		const path = []
		let y = b
		for (; y && y !== a; y = y.up) path.unshift(y)
		if (y !== a || !path.every((x, i) => L.urls[L.at + 1 + i] === x.url)) return null
		return path.length
	}
	// the selected tab to entry x: here moved, nothing written; WebKit goes there itself when its list goes the same
	// way, else the address is loaded
	const move = (api, x) => {
		const id = tab()
		const h = hist.get(id), a = hereOf(id)
		if (!h || !x || x === a) return
		// the branch each step down was on, so forward takes it again
		for (let y = a; y?.up; y = y.up) e.last[y.up.commit] = y.commit
		for (let y = x; y?.up; y = y.up) e.last[y.up.commit] = y.commit
		if (x === h.list.at(-1)) delete e.here[id]
		else e.here[id] = x.commit
		const k = offset(a, x, pageOf(id)?.list)
		if (viewOf(api) && k !== null) {
			e.wait[id] = { to: x.commit }
			go(api, k === -1 ? "back" : k === 1 ? "forward" : k)
		} else {
			e.wait[id] = { to: x.commit, load: true }
			states.set(id, null)
			if (viewOf(api)) {
				ask(api, [
					...key("url", x.url),
					...key("go", "load"),
					...key("n", (viewOf(api)?.n ?? 0) + 1),
				])
			} else wake(api, id)
		}
	}
	const back = (api) => {
		const id = tab()
		if (id === null) return
		if (!hist.get(id)?.list.length) return go(api, "back")
		move(api, hereOf(id)?.up)
	}
	const forward = (api) => {
		const id = tab()
		if (id === null) return
		if (!hist.get(id)?.list.length) return go(api, "forward")
		move(api, ahead(hereOf(id)))
	}
	// what a page's list says it did, by how it changed: the same addresses, another at, is going back or forward (a
	// gesture, history.back()); the current one's address changed, a redirect or replaceState; anything else a new
	// page (a link, a form, pushState). A move or load this asked for is its own; the first list of a page made again
	// (from its state) puts here at the entry with its address
	const seen = new Map() // tab id -> its page's list as last looked at
	const look = (id, p) => {
		const L = p.list, was = seen.get(id)
		if (!L?.urls || same(L, was)) return
		seen.set(id, L)
		const url = L.urls[L.at], w = e.wait[id], h = hist.get(id)
		if (w) {
			delete e.wait[id]
			if (w.typed && !e.here[id]) amend(id, "url", url)
			return
		}
		if (!was) {
			if (h && hereOf(id)?.url !== url) {
				const near = [hereOf(id), ...h.list.slice().reverse()].find((x) => x?.url === url)
				if (near === h.list.at(-1)) delete e.here[id]
				else if (near) e.here[id] = near.commit
			}
			return
		}
		if (same(L.urls, was.urls) && L.at !== was.at && h) {
			let x = hereOf(id)
			for (let d = L.at - was.at; x && d < 0; d++) x = x.up
			for (let d = L.at - was.at, k = 1; x && d > 0; d--, k++) {
				x = x.kids.find((y) => y.url === L.urls[was.at + k]) ?? ahead(x)
			}
			if (x === h.list.at(-1)) delete e.here[id]
			else if (x) e.here[id] = x.commit
			return
		}
		// the current one's address alone changed
		if (
			L.urls.length === was.urls.length && L.at === was.at &&
			L.urls.every((x, i) => i === L.at || x === was.urls[i]) && !e.here[id]
		) return amend(id, "url", url)
		record(id, url)
	}

	// --- the look, from /etc/theme: platinum tabs on a darker well, the selected one joined to the toolbar
	// with a cherry line on it, the address on paper in a black box
	let C = {}
	const colours = (t = {}) => {
		C = {
			chrome: 0xece5d4,
			paper: 0xfdf8ea,
			ink: 0x2a2228,
			ink3: 0xa89aa2,
			line: 0x1c1a17,
			rose: 0xe2457c,
			cherry: 0xd2244a,
			hi: 0xfffdf6,
			lo: 0xb9ae98,
			lemon: 0xffff88,
			well: 0xd9cfb9,
			...t,
		}
	}
	colours(val(api, ["/", "etc", "theme"]) ?? {})
	// the buttons and the address field, left to right, under the strip
	const BW = 18 * u, GAP = 4 * u, B0 = 6 * u
	const BX = [B0, B0 + BW + GAP, B0 + 2 * (BW + GAP)], FX = B0 + 3 * (BW + GAP) + 2 * u
	// the strip: each tab as wide as there is room for, no wider than 200 points, its close box; + after them
	const strip = () => {
		const n = Math.max(1, s.tabs.length)
		const TW = Math.max(24 * u, Math.min(200 * u, Math.floor((W - SH - 6 * u) / n)))
		return {
			TW,
			CB: Math.max(5 * u, Math.min(11 * u, SH - 12 * u)),
			plus: s.tabs.length * TW + 4 * u,
		}
	}
	// the address's text, and where it starts: scrolled so the caret shows
	const fieldText = (p) => {
		const text = e.field ? e.field.text : p?.url || shownOf(tab()).url || ""
		const room = W - FX - 24 * u
		const shift = e.field ? Math.max(0, blit.measure(text.slice(0, e.field.pos), F) - room) : 0
		return { text, x: FX + 8 * u - shift }
	}
	const draw = (api, p) => {
		const f = blit.list(W, H, C.paper)
		const th = blit.height(F)
		blit.fill(f, 0, 0, W, SH, C.well)
		blit.fill(f, 0, SH - u, W, u, C.line)
		const { TW, CB, plus } = strip(), live = views(api)
		s.tabs.forEach((id, i) => {
			const x = i * TW, on = i === s.at, top = on ? 2 * u : 4 * u
			blit.fill(f, x, top, TW + u, SH - top - (on ? 0 : u), C.line)
			blit.fill(f, x + u, top + u, TW - u, SH - top - (on ? u : 2 * u), on ? C.chrome : C.lo)
			blit.fill(f, x + u, top + u, TW - u, on ? 2 * u : u, on ? C.cherry : C.hi)
			// the close box, System 7's: a square in black lines
			const cy = top + u + Math.floor((SH - top - u - CB) / 2), cx = x + 5 * u
			blit.fill(f, cx, cy, CB, CB, C.line)
			blit.fill(f, cx + u, cy + u, CB - 2 * u, CB - 2 * u, on ? C.hi : C.chrome)
			// asleep, or loading: grey
			const ink = (shownOf(id).url && !live.has(nameOf(id))) || (on && p?.loading)
				? C.ink3
				: C.ink
			const tx = cx + CB + 5 * u,
				clip = { x: tx, y: top, w: Math.max(0, x + TW - 4 * u - tx), h: SH - top }
			blit.text(
				f,
				tx,
				top + u + Math.floor((SH - top - u - th) / 2),
				label(id),
				ink,
				undefined,
				clip,
				F,
			)
		})
		// +: a new tab
		const pw = SH - 6 * u, py = 4 * u
		blit.fill(f, plus, py, pw, pw, C.line)
		blit.fill(f, plus + u, py + u, pw - 2 * u, pw - 2 * u, C.chrome)
		blit.text(
			f,
			plus + Math.floor((pw - blit.measure("+", F)) / 2),
			py + Math.floor((pw - th) / 2),
			"+",
			C.ink,
			undefined,
			undefined,
			F,
		)
		// the toolbar
		blit.fill(f, 0, SH, W, TOOL, C.chrome)
		blit.fill(f, 0, SH + TOOL - u, W, u, C.line)
		const top = SH + 4 * u, bh = TOOL - 9 * u, y = top + Math.floor((bh - th) / 2)
		// the buttons: square, with a hard 90s bevel
		const button = (x, text, on) => {
			blit.fill(f, x, top, BW, bh, C.line)
			blit.fill(f, x + u, top + u, BW - 2 * u, bh - 2 * u, C.hi)
			blit.fill(f, x + 2 * u, top + 2 * u, BW - 3 * u, bh - 3 * u, C.lo)
			blit.fill(f, x + 2 * u, top + 2 * u, BW - 4 * u, bh - 4 * u, C.chrome)
			blit.text(
				f,
				x + Math.floor((BW - blit.measure(text, F)) / 2),
				y,
				text,
				on ? C.ink : C.ink3,
				undefined,
				undefined,
				F,
			)
		}
		button(BX[0], "◀", can(-1))
		button(BX[1], "▶", can(1))
		button(BX[2], p?.loading ? "×" : "○", !!shownOf(tab()).url)
		blit.fill(f, FX, top, W - FX - 8 * u, bh, C.line)
		blit.fill(f, FX + u, top + u, W - FX - 10 * u, bh - 2 * u, C.paper)
		const clip = { x: FX + u, y: top, w: W - FX - 16 * u, h: bh }
		const { text, x: fx } = fieldText(p)
		const sel = e.field ? readline.selection(e.field) : null
		if (sel) {
			blit.fill(
				f,
				Math.max(clip.x, fx + blit.measure(text.slice(0, sel[0]), F)),
				y,
				Math.min(clip.w, blit.measure(text.slice(sel[0], sel[1]), F)),
				th,
				C.lemon,
			)
		}
		const end = blit.text(
			f,
			fx,
			y,
			text,
			p?.error && !e.field ? C.cherry : C.ink,
			undefined,
			clip,
			F,
		)
		if (e.field) {
			blit.fill(
				f,
				Math.min(W - 16 * u, fx + blit.measure(text.slice(0, e.field.pos), F)),
				y,
				2 * u,
				th,
				C.rose,
			)
		}
		if (p?.error && !e.field) blit.text(f, end + 16 * u, y, p.error, C.cherry, undefined, clip, F)
		// progress, under the toolbar
		if (p?.loading) {
			blit.fill(f, 0, SH + TOOL - 2 * u, Math.round(W * (p.progress ?? 0)), 2 * u, C.rose)
		}
		// under the page; a new tab's, with none
		blit.text(
			f,
			20 * u,
			SH + TOOL + 20 * u,
			shownOf(tab()).url
				? "the page shows here"
				: "a new tab: an address, or words to search for",
			C.ink3,
			undefined,
			undefined,
			F,
		)
		return f.ops
	}
	// what it says to the Mac: the tabs, the buttons and the address field, and the caret while typing an address
	const meaning = (p) => {
		const top = SH + 4 * u, bh = TOOL - 9 * u, y = top + Math.floor((bh - blit.height(F)) / 2)
		const { TW, plus } = strip()
		const { text, x: fx } = fieldText(p)
		const pos = e.field ? e.field.pos : text.length
		const selection = (e.field && readline.selection(e.field)) || [pos, pos]
		return {
			access: [
				{
					role: "tabgroup",
					label: "tabs",
					x: 0,
					y: 0,
					w: W,
					h: SH,
					children: [
						...s.tabs.map((id, i) => ({
							role: "tab",
							label: label(id),
							value: i === s.at,
							x: i * TW,
							y: 0,
							w: TW,
							h: SH,
						})),
						{ role: "button", label: "new tab", x: plus, y: 0, w: SH, h: SH },
					],
				},
				{
					role: "toolbar",
					label: "browser",
					x: 0,
					y: SH,
					w: W,
					h: TOOL,
					children: [
						{ role: "button", label: "back", x: BX[0], y: top, w: BW, h: bh },
						{ role: "button", label: "forward", x: BX[1], y: top, w: BW, h: bh },
						{
							role: "button",
							label: p?.loading ? "stop" : "reload",
							x: BX[2],
							y: top,
							w: BW,
							h: bh,
						},
						{
							role: "textfield",
							label: "address",
							value: text,
							selection,
							x: FX,
							y: top,
							w: W - FX - 8 * u,
							h: bh,
						},
					],
				},
			],
			// the address being typed; else, the page having the keyboard, the Mac's input methods on for it, at its top left
			input: e.pop ? null : e.field
				? {
					text,
					selection,
					caret: {
						x: fx + blit.measure(text.slice(0, pos), F),
						y,
						w: 2 * u,
						h: blit.height(F),
					},
				}
				: paging(p)
				? {
					text: "",
					selection: [0, 0],
					caret: { x: 0, y: SH + TOOL, w: 2 * u, h: blit.height(F) },
				}
				: null,
		}
	}

	// --- the history popup: a layer of its own over the page (a page is drawn over its window's ops), untitled, so the
	// window manager gives this its clicks with the layer's name; every tab's entries, newest first, those typed for
	// (title or address), each its time, title, address and tab, set in by its depth in its tab's tree (as History), the
	// first of a line from a fork marked
	const ROWS = 12
	const popRows = () => {
		const q = (e.pop?.field?.text ?? "").trim().toLowerCase()
		const out = []
		for (const id of [...s.tabs, ...s.closed.map((c) => c.id)]) {
			const h = hist.get(id)
			if (!h) continue
			for (const x of h.list) {
				if (!q || x.title.toLowerCase().includes(q) || x.url.toLowerCase().includes(q)) {
					out.push({ id, x, closed: !s.tabs.includes(id) })
				}
			}
		}
		return out.sort((a, b) => (b.x.when ?? 0) - (a.x.when ?? 0) || b.x.i - a.x.i)
	}
	const clock = (ms) => {
		if (!ms) return ""
		const d = new Date(ms), now = new Date(), two = (n) => String(n).padStart(2, "0")
		return d.toDateString() === now.toDateString()
			? `${two(d.getHours())}:${two(d.getMinutes())}`
			: `${d.getDate()} ${
				"JanFebMarAprMayJunJulAugSepOctNovDec".slice(d.getMonth() * 3, d.getMonth() * 3 + 3)
			}`
	}
	const tabName = (id) => {
		const i = s.tabs.indexOf(id)
		return i >= 0 ? `tab ${i + 1}` : "closed"
	}
	// where it is and how big, in the window
	const popBox = () => {
		const th = blit.height(F), rh = th + 6 * u
		const w = Math.max(200 * u, Math.min(W - 40 * u, 620 * u)),
			h = 10 * u + th + 8 * u + ROWS * rh + 8 * u + th + 6 * u
		return {
			x: Math.floor((W - w) / 2),
			y: SH + TOOL + 6 * u,
			w,
			h,
			th,
			rh,
			list: 10 * u + th + 12 * u,
		}
	}
	const popDraw = (api, L) => {
		const has = idAt(api, POP)
		if (!e.pop || !L) {
			if (has) drop(api, LAYERS, POP.at(-1))
			return
		}
		const B = popBox(), rows = popRows(), S = 2 * u
		e.pop.at = Math.max(0, Math.min(rows.length - 1, e.pop.at ?? 0))
		e.pop.top = Math.max(0, Math.min(e.pop.at, Math.max(e.pop.top ?? 0, e.pop.at - ROWS + 1)))
		const f = blit.list(B.w + S, B.h + S)
		blit.fill(f, S, S, B.w, B.h, C.line)
		blit.fill(f, 0, 0, B.w, B.h, C.paper)
		for (let i = 0; i < u; i++) blit.frame(f, i, i, B.w - 2 * i, B.h - 2 * i, C.line)
		// the field: what is typed, the caret
		const fx = 8 * u, fy = 8 * u, fw = B.w - 16 * u, fh = B.th + 6 * u
		blit.fill(f, fx, fy, fw, fh, C.line)
		blit.fill(f, fx + u, fy + u, fw - 2 * u, fh - 2 * u, C.hi)
		const field = e.pop.field, text = field.text
		const fclip = { x: fx + u, y: fy, w: fw - 2 * u, h: fh }
		const sel = readline.selection(field)
		if (sel) {
			blit.fill(
				f,
				fx + 5 * u + blit.measure(text.slice(0, sel[0]), F),
				fy + 3 * u,
				blit.measure(text.slice(sel[0], sel[1]), F),
				B.th,
				C.lemon,
				fclip,
			)
		}
		if (text) blit.text(f, fx + 5 * u, fy + 3 * u, text, C.ink, undefined, fclip, F)
		else {blit.text(
				f,
				fx + 5 * u,
				fy + 3 * u,
				"search every tab's history",
				C.ink3,
				undefined,
				fclip,
				F,
			)}
		blit.fill(
			f,
			Math.min(fx + fw - 3 * u, fx + 5 * u + blit.measure(text.slice(0, field.pos), F)),
			fy + 3 * u,
			2 * u,
			B.th,
			C.rose,
		)
		// the entries
		const tw = 48 * u, nw = 56 * u
		rows.slice(e.pop.top, e.pop.top + ROWS).forEach(({ id, x, closed }, k) => {
			const y = B.list + k * B.rh, lit = e.pop.top + k === e.pop.at, ty = y + 3 * u
			if (lit) blit.fill(f, u, y, B.w - 2 * u, B.rh, C.pick ?? C.line)
			const ink = lit ? C.paper : C.ink, dim = lit ? C.paper : C.ink3
			blit.text(f, 10 * u, ty, clock(x.when), dim, undefined, {
				x: 0,
				y,
				w: 10 * u + tw - 4 * u,
				h: B.rh,
			}, F)
			let lx = 10 * u + tw + Math.min(x.depth, 8) * 12 * u
			// the first of a line from a fork: a corner before it
			if (x.fork) {
				blit.fill(f, lx - 10 * u, y + 2 * u, u, Math.floor(B.rh / 2) - u, dim)
				blit.fill(f, lx - 10 * u, y + Math.floor(B.rh / 2), 6 * u, u, dim)
			}
			// here: a cherry mark
			if (hereOf(id) === x && !closed) {
				blit.fill(
					f,
					lx - 6 * u,
					y + Math.floor(B.rh / 2) - u,
					3 * u,
					3 * u,
					lit ? C.paper : C.cherry,
				)
			}
			const room = B.w - lx - nw - 12 * u
			const title = x.title || bare(x.url)
			const end = blit.text(f, lx, ty, title, ink, undefined, { x: lx, y, w: room, h: B.rh }, F)
			if (x.title && end < lx + room - 12 * u) {
				blit.text(f, end + 10 * u, ty, bare(x.url), dim, undefined, {
					x: end,
					y,
					w: lx + room - end,
					h: B.rh,
				}, F)
			}
			const tn = tabName(id)
			blit.text(f, B.w - 10 * u - blit.measure(tn, F), ty, tn, dim, undefined, undefined, F)
		})
		if (!rows.length) {
			blit.text(
				f,
				12 * u,
				B.list + 3 * u,
				e.pop.field.text ? "nothing found" : "no history yet",
				C.ink3,
				undefined,
				undefined,
				F,
			)
		}
		// how to
		const hint = `${rows.length} ${
			rows.length === 1 ? "entry" : "entries"
		}   ↑ ↓ choose   return go   cmd-return a new tab   esc`
		blit.text(f, 10 * u, B.h - B.th - 6 * u, hint, C.ink3, undefined, {
			x: 0,
			y: 0,
			w: B.w - 10 * u,
			h: B.h,
		}, F)
		const value = {
			x: L.x + B.x,
			y: L.y + B.y,
			w: B.w + S,
			h: B.h + S,
			z: 140000,
			owner: me,
			draw: f.ops,
			access: [{
				role: "list",
				label: "history",
				x: 0,
				y: 0,
				w: B.w,
				h: B.h,
				children: rows.slice(e.pop.top, e.pop.top + ROWS).map(({ id, x }, k) => ({
					role: "row",
					label: `${x.title || bare(x.url)}, ${tabName(id)}`,
					value: e.pop.top + k === e.pop.at,
					x: 0,
					y: B.list + k * B.rh,
					w: B.w,
					h: B.rh,
				})),
			}],
		}
		if (has) api.write(POP, Object.entries(value).flatMap(([k, v]) => key(k, v)))
		else make(api, LAYERS, POP.at(-1), value, { ephemeral: true })
	}
	const showHistory = () => {
		e.pop = { field: { text: "", pos: 0 }, at: 0, top: 0 }
		e.field = null
	}
	// an entry chosen: in the selected tab (here moved, when it is that tab's; else gone to, a new entry), or a new tab
	const visit = (api, row, fresh) => {
		e.pop = null
		if (!row) return
		if (fresh) return open(api, row.x.url)
		if (row.id === tab()) return move(api, row.x)
		if (tab() === null) return
		record(tab(), row.x.url)
		e.wait[tab()] = { typed: true }
		if (viewOf(api)) {
			ask(api, [
				...key("url", row.x.url),
				...key("go", "load"),
				...key("n", (viewOf(api)?.n ?? 0) + 1),
			])
		}
		wake(api, tab())
		focusPage(api, true)
	}
	const popKey = (api, r) => {
		if (r.event === "commit") {
			return void (e.pop.field = readline.type(e.pop.field, r) ?? e.pop.field)
		}
		if (!r.down) return
		const rows = popRows(), cmd = r.mods?.includes("cmd")
		if (r.key === "Escape" || (cmd && r.key === "y" && !r.mods?.includes("shift"))) e.pop = null
		else if (r.key === "Enter") visit(api, rows[e.pop.at], cmd)
		else if (r.key === "ArrowUp") e.pop.at = Math.max(0, e.pop.at - 1)
		else if (r.key === "ArrowDown") e.pop.at = Math.min(rows.length - 1, e.pop.at + 1)
		else if (r.key === "PageUp") e.pop.at = Math.max(0, e.pop.at - ROWS)
		else if (r.key === "PageDown") e.pop.at = Math.min(rows.length - 1, e.pop.at + ROWS)
		else {
			const f = readline.type(e.pop.field, r)
			if (f) {
				if (f.text !== e.pop.field.text) e.pop.at = e.pop.top = 0
				e.pop.field = f
			}
		}
	}
	// all of it, in a window of its own
	const all = ({ api, call, start }) => {
		const op = { address: ["/", "apps", "history"], program: ["programs", "history"] }
		const launch = val(api, ["/", "dev", "wm", "launch"])
		try {
			Array.isArray(launch) ? call(launch, [op]) : start(op)
		} catch {
			// no window manager to ask
		}
	}

	// whether the selected tab's page has the keyboard: keys and text go to it
	const paging = (p) => !e.pop && !e.field && !!shownOf(tab()).url && !!p?.focused
	// what this window is given over the page, to the page, x and y in its pixels
	const toPage = ({ call }, recs) => {
		if (!recs.length || tab() === null) return
		try {
			call(["/", "dev", "web", "driver", "on", "input"], [nameOf(tab()), recs])
		} catch {
			// no page loaded
		}
	}
	const onPage = (r) => ({ ...r, y: r.y - SH - TOOL })
	// the pointer's shape the page asks for, while the pointer is over it: /etc/cursors/<its name>, when there is one
	const CURSOR = ["/", "dev", "pointer", "cursor"]
	let shape = null
	const cursor = (api, name) => {
		const want = name && idAt(api, ["/", "etc", "cursors", name])
			? ["/", "etc", "cursors", name]
			: null
		if (same(want, shape)) return
		shape = want
		if (idAt(api, CURSOR)) api.write(CURSOR, whole(want))
	}
	// a button held down over the page: its moves and its up are the page's, wherever they go
	let pressing = false
	// the selected tab's page, where it shows; none for a tab with no page loaded
	const webOf = (
		api,
	) => (tab() !== null && idAt(api, [...VIEWS, nameOf(tab())])
		? { id: nameOf(tab()), x: 0, y: SH + TOOL, w: W, h: H - SH - TOOL }
		: null)
	const redraw = (api) => {
		if (gone) return
		keep(api)
		const L = val(api, LAYER)
		if (!L) return
		const p = page(api, tab()), m = meaning(p)
		api.write(LAYER, [
			...key("w", W),
			...key("h", H),
			...key("draw", draw(api, p)),
			...key("access", m.access),
			...key("input", m.input),
			...key("web", webOf(api)),
			...key("title", tab() !== null ? label(tab()) : "browser"),
		])
		popDraw(api, L)
		keep(api)
	}

	// --- started: the selected tab's page, then the window
	wake(api, tab())
	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (40 + (n % 5) * 30) * u,
			y: (60 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "browser",
			owner: me,
			draw: [],
			drags: true,
			web: webOf(api),
		}, { ephemeral: true })
	}
	keep(api)

	// --- the keyboard
	const typed = (r) => r.text && r.text >= " " && !/[-]/.test(r.text)
	const next = (api, by) => select(api, (s.at + by + s.tabs.length) % s.tabs.length)
	// the browser's chords: whether r was one
	const chord = (g, r) => {
		const { api } = g
		const cmd = r.mods?.includes("cmd"),
			shift = r.mods?.includes("shift"),
			ctrl = r.mods?.includes("ctrl"),
			alt = r.mods?.includes("alt")
		const k = r.key ?? ""
		if (ctrl && !cmd && !alt && k === "Tab") next(api, shift ? -1 : 1)
		else if (!cmd || ctrl || alt) return false
		else if (k === "t") shift ? reopen(api) : open(api, null)
		else if (k === "w" && !shift) close(api, s.at)
		else if (k === "l" && !shift) location(api)
		else if ((k === "y" || k === "Y") && shift) all(g)
		else if (k === "y") showHistory()
		else if ((k === "[" || k === "{") && shift) next(api, -1)
		else if ((k === "]" || k === "}") && shift) next(api, 1)
		else if (k === "[") back(api)
		else if (k === "]") forward(api)
		else if (k === "r" && !shift) go(api, "reload")
		else if (/^[1-8]$/.test(k) && !shift) select(api, Math.min(Number(k) - 1, s.tabs.length - 1))
		else if (k === "9" && !shift) select(api, s.tabs.length - 1)
		else return false
		return true
	}
	const location = (api) => {
		const t = shownOf(tab()).url ?? ""
		e.pop = null
		e.field = { text: t, pos: t.length, mark: 0 }
		focusPage(api, false)
	}
	handler(given, "key", (g) => {
		const { api } = g, [recs] = g.args
		const page = []
		for (const r of recs) {
			if (gone) return
			// the history popup: every key its own
			if (e.pop) {
				popKey(api, r)
				continue
			}
			// the page has the keyboard: all but the browser's chords are its, text from an input method too
			// (a chord taken there is done: asked again below, it would be done twice)
			const p = viewOf(api) ? page$(api) : null
			if (paging(p)) {
				if (
					!(r.down && chord(g, r)) &&
					(r.event === "key" || r.event === "commit" || r.event === "compose")
				) page.push(r)
				continue
			}
			// text from an input method, into the address being typed
			if (r.event === "commit") {
				if (e.field) e.field = readline.type(e.field, r) ?? e.field
				continue
			}
			if (!r.down || chord(g, r)) continue
			if (!e.field) {
				// typed with no page taking it: an address begun
				if (typed(r) && !r.mods?.some((m) => m === "cmd" || m === "ctrl" || m === "alt")) {
					e.field = { text: r.text, pos: r.text.length }
				}
				continue
			}
			if (r.key === "Enter") navigate(api, e.field.text)
			else if (r.key === "Escape") {
				// a new tab's address stays
				if (shownOf(tab()).url) {
					e.field = null
					focusPage(api, true)
				}
			} else e.field = readline.type(e.field, r, { select: true, api }) ?? e.field
		}
		toPage(g, page)
		redraw(api)
	})

	// --- the pointer: the strip and the toolbar (the page's are WebKit's); every move while a button is down
	// (drags: true), so a tab can be dragged along; the popup's, with its layer's name
	handler(given, "pointer", (g) => {
		const { api } = g, [recs] = g.args
		const page = []
		for (const r of recs) {
			if (gone) return
			if (r.layer === POP.at(-1)) {
				if (!e.pop || r.event !== "down") continue
				const B = popBox(), k = Math.floor((r.y - B.list) / B.rh)
				if (r.y >= B.list && k >= 0 && k < ROWS) {
					visit(api, popRows()[e.pop.top + k], r.mods?.includes("cmd") || r.button === 2)
				}
				continue
			}
			// a click in the window lets the popup go
			if (r.event === "down") e.pop = null
			// over the page, or a press that began there: the page's; a click there gives it the keyboard
			if (
				shownOf(tab()).url && viewOf(api) &&
				(pressing || ((r.event === "down" || r.event === "scroll") && r.y >= SH + TOOL))
			) {
				if (r.event === "down") {
					pressing = true
					e.field = null
					if (!page$(api)?.focused) focusPage(api, true)
				}
				if (r.event === "up") pressing = false
				page.push(onPage(r))
				continue
			}
			const { TW, CB, plus } = strip()
			if (r.event === "move" && e.drag) {
				// a tab dragged along: to where the pointer is, among the others, once it has gone four points
				const from = s.tabs.indexOf(e.drag.id),
					to = Math.max(0, Math.min(s.tabs.length - 1, Math.floor(r.x / TW)))
				if (from < 0 || to === from || Math.abs(r.x - e.drag.x) < 4 * u) continue
				const was = tab()
				s.tabs.splice(to, 0, ...s.tabs.splice(from, 1))
				s.at = s.tabs.indexOf(was)
				continue
			}
			if (r.event === "up") e.drag = null
			if (r.event !== "down" || r.y >= SH + TOOL) continue
			if (r.y < SH) {
				const i = Math.floor(r.x / TW)
				if (r.x >= plus && r.x < plus + SH) open(api, null)
				else if (
					i < s.tabs.length &&
					(r.button === 2 || (r.x >= i * TW + 5 * u && r.x < i * TW + 5 * u + CB))
				) close(api, i)
				else if (i < s.tabs.length) {
					select(api, i)
					e.drag = { id: s.tabs[i], x: r.x }
				}
			} else if (r.x < BX[1] - GAP / 2) back(api)
			else if (r.x < BX[2] - GAP / 2) forward(api)
			else if (r.x < FX - GAP / 2) go(api, page(api, tab())?.loading ? "stop" : "reload")
			else location(api)
		}
		toPage(g, page)
		redraw(api)
	})

	// --- moves over the page with no button down, to it (the window manager calls this while one is over the
	// window); the pointer's shape as the page asks, and the arrow again off it. Over the popup, the row under it lit
	handler(given, "hover", (g) => {
		const { api } = g, [recs] = g.args
		if (gone) return
		const over = recs.filter((r) => r.layer === POP.at(-1) && r.event === "move").at(-1)
		if (over && e.pop) {
			const B = popBox(), k = Math.floor((over.y - B.list) / B.rh), n = popRows().length
			if (
				over.y >= B.list && k >= 0 && k < ROWS && e.pop.top + k < n &&
				e.pop.at !== e.pop.top + k
			) {
				e.pop.at = e.pop.top + k
				redraw(api)
			}
		}
		const page = recs.filter((r) =>
			r.layer !== POP.at(-1) && r.event === "move" && r.y >= SH + TOOL && shownOf(tab()).url &&
			viewOf(api)
		).map(onPage)
		toPage(g, page)
		cursor(api, page.length ? page$(api)?.cursor ?? null : null)
	})

	// --- the menus; and the history window's: visit (a tab's entry), open (an address, in a new tab)
	handler(given, "menu", (g) => {
		const { api } = g, [what, i, commit] = g.args
		if (what === "new") open(api, null)
		else if (what === "location") location(api)
		else if (what === "close") close(api, s.at)
		else if (what === "reopen") reopen(api)
		else if (what === "next") next(api, 1)
		else if (what === "prev") next(api, -1)
		else if (what === "select") select(api, i)
		else if (what === "back") back(api)
		else if (what === "forward") forward(api)
		else if (what === "history") showHistory()
		else if (what === "all") all(g)
		else if (what === "open" && typeof i === "string") open(api, i)
		else if (what === "visit") {
			// its tab selected, brought back if it was closed, then to the entry; one its history does not have yet
			// (not served yet), once it does (going)
			const c = s.closed.findIndex((x) => x.id === i)
			if (c >= 0) {
				const [x] = s.closed.splice(c, 1)
				s.tabs.splice(Math.max(0, Math.min(s.tabs.length, x.at)), 0, x.id)
			}
			if (s.tabs.includes(i)) {
				select(api, s.tabs.indexOf(i))
				const x = hist.get(i)?.by.get(commit)
				going = x ? null : { id: i, commit }
				if (x) move(api, x)
			}
		} else go(api, what)
		redraw(api)
	})

	// --- what WebKit says of the live tabs' pages, and the tabs' histories: titles into the tabs, each page's list
	// looked at; a page one would open, a tab
	const asked = new Map() // a view's name -> the last open seen of its page
	effect(given, "pages", ({ api }) => {
		const ids = docs(api)
		const w = val(api, WINDOW)
		const all = [...(w?.tabs ?? []), ...(w?.closed ?? []).map((c) => c?.id)].filter((id) =>
			typeof id === "number"
		)
		const L = val(api, LAYER)
		const f = val(api, ["/", "dev", "font", "text"])
		return {
			theme: val(api, ["/", "etc", "theme"]) ?? null,
			want: L?.want ?? null,
			at: L ? { x: L.x, y: L.y, z: L.z } : null,
			focus: val(api, ["/", "dev", "display", "focus"]) ?? null,
			font: f ? `${f.family} ${f.size}px` : "rom",
			pages: (w?.tabs ?? []).filter((id) => typeof id === "number").map((id) => {
				const p = val(api, [...PAGES, `web-${self}-${id}`])
				return p
					? {
						id,
						title: p.title,
						url: p.url,
						loading: p.loading,
						progress: p.progress,
						back: p.back,
						forward: p.forward,
						error: p.error ?? null,
						open: p.open ?? null,
						focused: !!p.focused,
						state: p.state ?? null,
						list: p.list ?? null,
					}
					: { id }
			}),
			histories: all.map((id) => {
				const doc = ids.get(String(id))
				return [id, typeof doc === "string" ? val(api, historyOf(doc)) ?? null : null]
			}),
		}
	}, ({ value: { want, theme, pages, histories, focus }, api }) => {
		if (gone) return
		if (theme) colours(theme)
		F = fontOf(api)
		SH = blit.height(F) + 10 * u
		TOOL = blit.height(F) + 14 * u
		// the size the window manager gives
		if (want) {
			W = Math.max(200 * u, want.w)
			H = Math.max(SH + TOOL + 40 * u, want.h)
		}
		// another window focused: the popup goes
		if (e.pop && focus && focus !== LAYER.at(-1)) e.pop = null
		for (const [id, h] of histories) if (h) hist.set(id, entries(h))
		P = new Map(pages.filter((p) => p.url !== undefined).map((p) => [p.id, p]))
		for (const p of pages) {
			const t = T.get(p.id)
			if (!t || p.url === undefined) continue
			look(p.id, p)
			// the page's title, the newest entry's while the tab is there and nothing it asked is under way
			if (
				p.title && p.title !== olds.get(p.id) && !e.here[p.id] && !e.wait[p.id] &&
				(!p.list || p.list.urls?.[p.list.at] === t.url)
			) {
				olds.delete(p.id)
				amend(p.id, "title", p.title)
			}
			// where it is, as the engine said once it settled: kept with the tab
			if (p.state && !e.wait[p.id] && p.state !== said.get(p.id)) {
				said.set(p.id, p.state)
				states.set(p.id, p.state)
			}
			const n = p.open?.n ?? 0, k = nameOf(p.id)
			if (!asked.has(k)) asked.set(k, n)
			else if (n > asked.get(k)) {
				asked.set(k, n)
				// from the selected tab's page, in front unless asked behind; from another's, behind
				open(api, p.open.url, {
					behind: !!p.open.behind || p.id !== tab(),
					after: s.tabs.indexOf(p.id),
				})
			}
		}
		// a visit waiting on its tab's history: to the entry once it is there, after the pages were looked at; another
		// tab selected meanwhile, let go
		if (going && tab() !== going.id) going = null
		const to = going && hist.get(going.id)?.by.get(going.commit)
		if (to) going = null, move(api, to)
		redraw(api)
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
		for (const k of theirs) [e[k], viewed[k]] = [v[k], copy(v[k])]
		redraw(api)
	})
}
