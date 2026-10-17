// /programs/files: the whole graph as a file browser (catclock's Files on ermineOS). left: places,
// what runs, what changed last; middle: icons, list, columns or map; right: the one picked, its
// value, last change and attributes. live: a change lights its item in lemon. double click goes in,
// or opens: a picture in Paint, the rest in the editor.
//
// read in parts: the root and top folders one, then each region two down (three under /dev, /apps,
// /proc) in one of 96 parts by its path's hash. listed, not read: what ticks each second or changes
// as windows draw or move, its own node, other browsers' process state; picked, read once.
// drawn in keyed segments; a paint rewrites only the changed ones, as splices.
// what runs: each process and each computed node (change site "compute") with its status
// (ermine.computer.status): pending, timed from first seen here, or an error.
// not yet: what a pending run waits on.
//
// view: /apps/files/view, a document, kept once it has stayed a moment.
// keys: arrows move, Enter in or open, Backspace or cmd-up up, cmd-[ cmd-] back/forward, cmd-1…4
// views, e editor, Escape unpicks. the wheel scrolls.
import { effect, handler, idAt, isStatus, make, snap, val } from "ermine:kit"
import { after, here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as views from "ermine:views"
import * as icons from "ermine:icons"

export default (given) => {
	const { api, self, onCleanup } = given
	// this process's own node: a window's owner, whose on/key and on/pointer the window manager calls
	const me = here(self), cwd = me.slice(0, -1)
	const blit = blitter(api)
	// names in /dev/font/fixed, as catclock's are in its mono; the rest in /dev/font/text, titles in /dev/font/title;
	// the font ROM until they come
	let F, FT, FX
	const face = (v) => (v ? font(v) : undefined)
	const fonts = (api) => {
		F = face(val(api, ["/", "dev", "font", "text"]))
		FT = face(val(api, ["/", "dev", "font", "title"]))
		FX = face(val(api, ["/", "dev", "font", "fixed"]))
	}
	fonts(api)
	const mode = val(api, ["/", "dev", "display", "mode"]) ?? { w: 1280, h: 800 }
	const u = mode.unit ?? 1
	let W = Math.min(1180 * u, mode.w - 60 * u), H = Math.min(660 * u, mode.h - 90 * u)
	const LAYERS = ["/", "dev", "display", "layers"], LAYER = [...LAYERS, `files-${self}`]
	const THEME = ["/", "etc", "theme"], KEPT = [...cwd, "view"]
	const set = (key, value) => ({ path: [key], value })

	// the look, from /etc/theme, as My Computer reads it: its colours; buttons "bevel" (System 7's), "soft"
	// (catclock's: white, round, hairlines) or "raised" (Windows 98's); selection {shape} a "pill" or a box, and
	// {rows} "invert" (a row's name in pick, as Windows 98's lists), "soft" (a round pill of select) or the row on
	// the highlighter; icons as icons.ts reads them
	const C = {}
	const colours = (T = {}) =>
		Object.assign(C, {
			paper: T.paper ?? 0xfdf8ea,
			chrome: T.chrome ?? 0xece5d4,
			hi: T.hi ?? 0xfffdf6,
			lo: T.lo ?? 0xb9ae98,
			line: T.line ?? 0x1c1a17,
			hair: T.hair ?? T.line ?? 0x1c1a17,
			ink: T.ink ?? 0x2a2228,
			ink2: T.ink2 ?? 0x6b5a66,
			dim: T.ink3 ?? 0xa89aa2,
			lemon: T.lemon ?? 0xffff88,
			select: T.select ?? T.lemon ?? 0xffff88,
			pick: T.pick ?? T.line ?? 0x1c1a17,
			pickInk: T.pickInk ?? T.paper ?? 0xfdf8ea,
			cherry: T.cherry ?? 0xd2244a,
			rose: T.rose ?? 0xe2457c,
			ok: T.mint ?? 0x18936b,
			blue: T.blue ?? T.sky ?? 0x3772ff,
			pink: T.pink ?? T.rose ?? 0xe2457c,
			light: T.light ?? 0xdfdfdf,
			dark: T.dark ?? 0x000000,
			desk: T.desk ?? 0xf3ead2,
			tag: T.blueSoft,
			buttons: T.buttons === "soft" || T.buttons === "raised" ? T.buttons : "bevel",
			pill: T.selection?.shape === "pill",
			rows: T.selection?.rows === "invert"
				? "invert"
				: T.selection?.rows === "soft"
				? "soft"
				: "box",
			icons: T.icons ?? null,
		})
	colours(val(api, THEME))
	// icons drawn and kinds told as My Computer's and the desk's (icons, the tool); values as the inspector's (views)
	const I = icons.make(blit, { u, colours: C })
	const V = views.make(blit, { u, colours: C })

	// where it is and what it shows: the view, the folder shown (icons, list; columns and the map walk from the
	// root), the one picked by key (its path joined by /, the root ""), or a process or computed node picked from
	// the running; folders open in the list; back and forward; each pane's scroll
	const VIEWS = ["icons", "list", "columns", "map"]
	const kept = val(api, KEPT)
	const s = {
		view: VIEWS.includes(kept) ? kept : "list",
		here: [],
		picked: null,
		run: null,
		open: new Set(),
		past: [],
		ahead: [],
		side: 0,
		info: 0,
		main: { icons: 0, list: 0 },
		cols: {},
		colx: 0,
		map: null,
	}
	const key = (path) => path.join("/")
	const parent = (path) => path.slice(0, -1)
	const under = (path, at) => path.length >= at.length && at.every((n, i) => path[i] === n)

	// ---- reading: every node, in parts

	// what is not read, only listed: this window's own node; what ticks each second; what changes as windows draw; a
	// font's pages and the font ROM (large, and they change as any program asks for a page); what a browser keeps
	// inside its process. A pattern holds a path that starts with it, * any name
	const own = (path) => under(path, me.slice(1))
	const QUIET = [
		// each second: the clock; the bar's clock (status's, in its node and on the window manager's right bar); the
		// window manager's bar, drawn with it; each irq line's counts, while it fires (vsync's, each frame); the serial
		// line's bytes and counts, with each byte on the console; sync's link, with each change it carries
		["dev", "clock", "*"],
		["apps", "status", "*", "clock"],
		["dev", "wm", "rbar", "7clock"],
		["dev", "wm", "*", "bar"],
		["hw", "irq", "*"],
		["dev", "uart0", "stats"],
		["dev", "uart0", "tx"],
		["dev", "uart0", "rx"],
		["dev", "sync", "link"],
		// what a driver keeps inside its process
		["dev", "*", "driver", "*"],
		["dev", "display", "layers", "*"],
		["dev", "display", "text", "*"],
		["dev", "display", "frames"],
		["dev", "display", "again"],
		["dev", "font", "*", "pages", "*"],
		["hw", "font"],
		["dev", "vram", "planes", "*"],
		// what moves as a hand moves or drags a window: where the pointer is, where each window is, the window manager's
		// record of each (a drag writes it, in front, each move), what the hand is doing, and its events (each click
		// and key), as the window manager and wmiirc keep them
		["dev", "pointer", "at"],
		["dev", "display", "windows", "*"],
		["dev", "wm", "client", "*"],
		["dev", "wm", "hand"],
		["dev", "wm", "event"],
		["apps", "wmiirc", "*", "events"],
		["apps", "graph", "*", "*"],
		["apps", "inspect", "*", "*"],
		["apps", "files", "*", "*"],
	]
	const quiet = (path) =>
		own(path) ||
		QUIET.some((q) => path.length >= q.length && q.every((n, i) => n === "*" || n === path[i]))
	const why = (e) =>
		`${e?.code ?? "error"}: ${String(e?.message ?? e).replace(new RegExp(`^${e?.code}: `), "")}`
	// FNV-1a, for a part's fingerprint and a value's
	const fnv = (t, h = 2166136261) => {
		for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619)
		return h >>> 0
	}
	// a value, short: what changes when it does, with its change's time (a second's: two in one second differ only
	// here). A small one whole; a large one by its shape and a sample of it, as reading it all each time costs
	const sample = (
		t,
	) => (t.length > 512
		? `${t.length}.${fnv(t.slice(0, 256))}.${fnv(t.slice(-256))}`
		: `${t.length}.${fnv(t)}`)
	const sigOf = (v, depth = 0) => {
		if (v === undefined || v === null || typeof v !== "object") {
			return typeof v === "string" ? `s${sample(v)}` : typeof v === "function" ? "fn" : String(v)
		}
		if (ArrayBuffer.isView(v)) return `b${v.byteLength}`
		if (Array.isArray(v)) {
			return v.length > 16 || depth >= 3
				? `a${v.length}.${
					depth < 3 ? sigOf(v[0], depth + 1) + "." + sigOf(v[v.length - 1], depth + 1) : ""
				}`
				: `a[${v.map((x) => sigOf(x, depth + 1)).join(",")}]`
		}
		const ks = Object.keys(v)
		if (ks.length > 24 || depth >= 3) return `o${ks.length}`
		return `o{${ks.map((k) => `${k}:${sigOf(v[k], depth + 1)}`).join(",")}}`
	}
	// a node as it is read: its first member (reads are lists: the rest only counted), its value and the change that
	// set it, its status; a quiet one only asked for an attribute it has not (info: its id, and no value carried over,
	// as a look carries the value too)
	const read = (rd, path) => {
		const it = {
			path,
			key: key(path),
			name: path.at(-1) ?? "/",
			id: null,
			members: 0,
			ephemeral: false,
			value: undefined,
			change: null,
			status: null,
			error: null,
			names: [],
			again: false,
			refused: null,
			quiet: quiet(path),
			process: false,
			computed: false,
			sig: "",
		}
		let list
		try {
			list = it.quiet ? rd.info(["/", ...path], "quiet") : rd.content(["/", ...path])
		} catch (e) {
			it.refused = why(e)
			return it
		}
		const first = list.find((i) => i.node) ?? list[0]
		it.members = list.length
		if (!first) return it
		it.id = first.id
		it.ephemeral = first.ephemeral === true
		it.arriving = !first.node
		it.process = first.from === "process"
		if (it.quiet) return it
		const v = first.versions?.find((x) => !isStatus(x)),
			st = first.versions?.find((x) => isStatus(x))?.content
		if (v) {
			it.value = v.content
			it.change = v.change ?? null
		}
		if (st?.pending) it.status = "pending"
		else if (st?.error) {
			it.status = "failed"
			it.error = st.error.message ?? "failed"
		}
		const site = it.change?.site
		it.computed = !it.process &&
			((site?.function === "compute" && site?.file === it.id) || it.status !== null)
		return it
	}
	const namesOf = (rd, path) => {
		try {
			return rd.children(["/", ...path])
		} catch {
			return []
		}
	}
	// what says a node changed: its value and change, its status, its names; a quiet one only by its names
	const signed = (
		it,
	) => (it.quiet ? `q|${it.names.join("/")}` : [
		it.id,
		it.change?.time ?? "",
		it.status ?? "",
		it.error ?? "",
		it.names.join("/"),
		it.members,
		it.refused ?? "",
		sigOf(it.value),
	].join("|"))
	// a region walked: each node, then what is under it; a node whose id is already on the way here not walked into
	// twice (a link back up)
	const DEEP = 24, MOST = 4000
	const walk = (api, peep, path, ids, out, alone = false) => {
		const hush = quiet(path)
		const it = read(hush ? peep : api, path)
		it.again = !!it.id && ids.includes(it.id)
		if (!it.again && !it.refused && path.length < DEEP && out.length < MOST) {
			it.names = namesOf(hush ? peep : api, path)
		}
		it.sig = signed(it)
		out.push(it)
		const up = it.id ? [...ids, it.id] : ids
		if (!alone) { for (const n of it.names) walk(api, peep, [...path, n], up, out) }
	}
	// the regions: a node two down (three under /dev, /apps and /proc, where processes are) with all under it; a
	// process there alone, and each node in it a region of its own, as its parts change apart; the nodes above them
	// are the frame's. Listed by an effect of their own, which gives each part its regions, a path's
	// hash saying which, at <its node>/regions/<part>, written when they change: so a part reads one small value, not
	// every folder above its regions, and only the part a new region is in walks again
	const N = 96
	const DEEPER = ["dev", "apps", "proc"], REGIONS = [...me, "regions"]
	make(api, me, "regions", null, { ephemeral: true })
	const assigned = {}
	effect(given, "list", ({ api, peep }) => {
		// the names tracked; ids, and which is a process, only looked at (a look is told what the node holds, so it would
		// list them all again each time any of them changed)
		const out = [], rootId = idAt(peep, ["/"])
		for (const t of namesOf(api, [])) {
			const tid = idAt(peep, ["/", t])
			if (tid && tid === rootId) continue
			for (const c of namesOf(api, [t])) {
				// each with the ids above it, so a part knows a link back up without looking for them
				if (!DEEPER.includes(t)) {
					out.push({ path: [t, c], ids: [rootId, tid] })
					continue
				}
				const cid = idAt(peep, ["/", t, c])
				if (cid && (cid === rootId || cid === tid)) continue
				for (const d of namesOf(api, [t, c])) {
					const items_ = peep.look(["/", t, c, d]), did = items_.find((i) => i.node)?.id
					if (!items_.some((i) => i.from === "process") || [rootId, tid, cid].includes(did)) {
						out.push({ path: [t, c, d], ids: [rootId, tid, cid] })
						continue
					}
					out.push({ path: [t, c, d], ids: [rootId, tid, cid], alone: true })
					for (const e of namesOf(api, [t, c, d])) {
						out.push({ path: [t, c, d, e], ids: [rootId, tid, cid, did] })
					}
				}
			}
		}
		return JSON.stringify(out)
	}, ({ value, api }) => {
		const each = Array.from({ length: N }, () => [])
		for (const r of JSON.parse(value)) each[fnv(r.path.join("/")) % N].push(r)
		each.forEach((list, k) => {
			const text = JSON.stringify(list)
			if (assigned[k] === text) return
			assigned[k] = text
			snap(api, [...REGIONS, String(k)], text, { ephemeral: true })
		})
	})
	// the parts: N parts of the regions, each region in one by its path's hash, and the frame's (the root, the folders
	// at the top, and under /dev, /apps and /proc the folders in them). Each keeps what it read here, and its value is
	// a fingerprint of it (written as its node's), so its effect runs when what it read changed
	const parts = Array(N + 1).fill(null)
	for (let k = 0; k <= N; k++) {
		effect(given, k === N ? "frame" : `part${k}`, ({ api, peep }) => {
			const out = []
			let used = null
			if (k === N) {
				const root = read(api, [])
				root.names = namesOf(api, [])
				root.sig = signed(root)
				out.push(root)
				const level = (path, ids) => {
					const it = read(api, path)
					it.again = !!it.id && ids.includes(it.id)
					if (!it.again) it.names = namesOf(api, path)
					it.sig = signed(it)
					out.push(it)
					if (path.length === 1 && DEEPER.includes(path[0]) && !it.again) {
						for (const c of it.names) {
							level([...path, c], [...ids, it.id])
						}
					}
				}
				for (const t of root.names) level([t], [root.id])
			} else {
				used = val(api, [...REGIONS, String(k)]) ?? null
				let list = []
				try {
					list = JSON.parse(used ?? "[]")
				} catch {
					// none yet
				}
				for (const r of list) walk(api, peep, r.path, r.ids.filter(Boolean), out, r.alone)
			}
			parts[k] = { out, used }
			dirty.add(k)
			return `${fnv(out.map((i) => i.key + ":" + i.sig).join("\n")).toString(36)}.${out.length}`
		}, (g) => soon(g))
	}
	// every part has read its regions (and the frame has read)
	const ready = () => parts.every((p, k) => p && (k === N || p.used !== null))

	// ---- what the graph holds, as one: each node by key; each id's keys (a node placed twice is two)
	const items = new Map()
	let looks = 0
	// what changed since the last look: lit up for a moment (when, ms); seen, in order, for "changed lately"; each
	// pending node since when this window first saw it so
	const lit = new Map(), seen = new Map(), since = new Map()
	let opened = false
	// the parts read again since the last look, and what each gave then
	const dirty = new Set(), took = []
	const model = () => {
		const now = Date.now(), first = !items.size
		// the tree's shape: a node come or gone, or the names under one changed (the map is laid out again, the
		// children sorted again)
		let shaped = first
		looks++
		for (const k of dirty) {
			const fresh = parts[k].out, keys = new Set(fresh.map((it) => it.key))
			// gone: what it gave last and not now, unless another part has it now
			for (const it of took[k] ?? []) {
				if (keys.has(it.key) || items.get(it.key) !== it) continue
				items.delete(it.key)
				lit.delete(it.key)
				since.delete(it.key)
				shaped = true
			}
			for (const it of fresh) {
				const was = items.get(it.key)
				if (!was || was.names.join("/") !== it.names.join("/")) shaped = true
				if (!first && (!was || was.sig !== it.sig)) {
					lit.set(it.key, now)
					seen.set(it.key, looks)
				}
				items.set(it.key, it)
				if (it.status !== "pending") since.delete(it.key)
				else if (!since.has(it.key)) since.set(it.key, now)
			}
			took[k] = fresh
		}
		dirty.clear()
		for (const [k, t] of lit) if (now - t > BLINK) lit.delete(k)
		// what is worked out from all of them, again when it is first wanted
		memo = { looks }
		if (shaped) kidsOf.clear()
		// the folders at the top start open in the list, once
		if (!opened) {
			opened = true
			for (const it of kids(items.get(""))) if (folder(it)) s.open.add(it.key)
		}
		if (!items.has(key(s.here))) s.here = []
		if (s.picked !== null && !items.has(s.picked)) s.picked = null
		if (s.run !== null && !items.get(s.run)?.process && !items.get(s.run)?.computed) s.run = null
		if (shaped || !laid) (laid = null, shape++)
	}
	// what is worked out from the whole graph, once a look: each id's keys (a node placed twice is two), what changed
	// lately, what runs, the last change
	let memo = { looks: -1 }
	const once = (name, f) => (name in memo ? memo[name] : (memo[name] = f()))
	const idsOf = () =>
		once("ids", () => {
			const m = new Map()
			for (const [k, it] of items) if (it.id) m.set(it.id, [...(m.get(it.id) ?? []), k])
			return m
		})
	// a node's own words, worked out once a node (each read gives new ones)
	const own_ = (it, name, f) => {
		const m = (it.memo ??= {})
		return name in m ? m[name] : (m[name] = f())
	}
	const folder = (it) => !!it && it.names.length > 0 && !it.again
	// a node holding null and nothing under it: an empty folder, as My Computer shows one
	const hollow = (it) =>
		!!it && !folder(it) && it.value === null && !it.quiet && !it.process && !it.computed &&
		!it.again
	// a node's children, folders first, then by name
	const kidsOf = new Map()
	const kids = (it) => {
		if (!it || it.again) return []
		// the order kept by key, as it changes only with the tree's shape; the nodes as they are now
		let k = kidsOf.get(it.key)
		if (!k) {
			k = it.names.map((n) => items.get(key([...it.path, n]))).filter((c) => c)
				.sort((a, b) => Number(folder(b)) - Number(folder(a)) || a.name.localeCompare(b.name))
				.map((c) => c.key)
			kidsOf.set(it.key, k)
		}
		return k.map((c) => items.get(c)).filter((c) => c)
	}

	// ---- what each node is, in words (catclock's)
	const ext = (n) => (n.includes(".") ? n.split(".").pop() : "")
	const TEXTS = {
		c: "C source",
		h: "C header",
		js: "JavaScript",
		ts: "TypeScript",
		json: "JSON text",
		md: "Markdown",
	}
	const isPicture = (v) => v?.kind === "picture" && Array.isArray(v.rows)
	const valueKind = (it) => {
		const v = it.value
		if (it.quiet) return "not read"
		if (ArrayBuffer.isView(v)) return ext(it.name) === "wasm" ? "WebAssembly" : "bytes"
		if (typeof v === "string") return TEXTS[ext(it.name)] ?? "text"
		if (typeof v === "function") return "handler"
		if (v?.constructor?.name === "Stand") return `live ${v.kind ?? ""}`.trim()
		if (Array.isArray(v)) return "list"
		if (isPicture(v)) return "picture"
		if (v?.kind === "app" && typeof v.run === "string") return "application"
		if (v !== null && typeof v === "object") return "record"
		return v === undefined || v === null ? undefined : typeof v
	}
	const kind = (it) => own_(it, "kind", () => kindOf(it))
	const kindOf = (it) => {
		if (it.key === "") return "the root"
		if (it.refused) return "refused"
		if (it.arriving) return "arriving"
		const v = it.process ? "process" : it.computed ? "computed" : valueKind(it)
		const n = it.again ? 0 : it.names.length
		if (it.again) return `${v ?? "folder"}, a link back up`
		if (!n) return v ?? "empty"
		const names = `${n} ${n === 1 ? "name" : "names"}`
		return v ? `${v}, ${names}` : `folder, ${names}`
	}
	const bytes = (
		n,
	) => (n < 1024
		? `${n} B`
		: n < 1048576
		? `${(n / 1024).toFixed(1)} KB`
		: `${(n / 1048576).toFixed(1)} MB`)
	let encoder = null
	const size = (it) => own_(it, "size", () => sizeOf(it))
	const sizeOf = (it) => {
		const v = it.value
		if (it.quiet) return "—"
		if (ArrayBuffer.isView(v)) return bytes(v.byteLength)
		if (typeof v === "string") return bytes((encoder ??= new TextEncoder()).encode(v).length)
		if (Array.isArray(v)) return `${v.length} items`
		if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
			return `${Object.keys(v).length} fields`
		}
		if ((v === undefined || v === null) && it.names.length) {
			return `${it.names.length} ${it.names.length === 1 ? "item" : "items"}`
		}
		return v === undefined || v === null || typeof v === "object" || typeof v === "function"
			? "—"
			: String(v)
	}
	// a change's time is the places' clock, seconds (a host's may be ms or µs)
	const secs = (t) => (typeof t !== "number" ? null : t > 1e14 ? t / 1e6 : t > 1e11 ? t / 1e3 : t)
	const two = (n) => String(n).padStart(2, "0")
	const clock = (t) => {
		const d = new Date(secs(t) * 1000)
		return `${d.getHours()}:${two(d.getMinutes())}:${two(d.getSeconds())}`
	}
	// a time, as of the draw (T, below); and when the words would change: "just now" at ten seconds, "N s ago" the
	// next second, "N min ago" the next minute, a clock's never. The soonest of a draw's says when to draw again
	let due = Infinity
	const ago = (t) => {
		if (!t) return "—"
		const x = T / 1000 - secs(t)
		const next = x < 10 ? 10 - x : x < 60 ? 1 - (x % 1) : x < 3600 ? 60 - (x % 60) : Infinity
		due = Math.min(due, T + next * 1000)
		return x < 10
			? "just now"
			: x < 60
			? `${Math.floor(x)} s ago`
			: x < 3600
			? `${Math.floor(x / 60)} min ago`
			: clock(t)
	}
	// a process by what it is called: its name, or with its folder's when the name says little (@104, driver)
	const label = (it) => {
		if (!it) return ""
		if (it.computed) {
			const up = owner(it)
			return up ? `${label(up)} › ${it.name}` : it.name
		}
		// one in /proc (started inside another's node) by where it was asked to be, the front placed there
		const there = it.path[0] === "proc"
			? (idsOf().get(it.id) ?? []).map((k) => items.get(k)).find((x) =>
				x && x.path[0] !== "proc"
			)
			: null
		if (there) return label(there)
		const n = it.name, p = it.path.at(-2)
		return /^@|^proc:/.test(n) || n === "driver" ? (p && p !== "proc" ? `${p} ${n}` : n) : n
	}
	// the process a computed node is in: the nearest above it
	const owner = (it) => {
		for (let p = parent(it.path); p.length; p = parent(p)) {
			const up = items.get(key(p))
			if (up?.process) return up
		}
		return null
	}
	// whoever wrote it: a process or computed node by its id (the change's site is the scope that wrote it), or the
	// machine. A change says its actor too, when it is someone
	const writer = (id) => {
		if (!id || id === "machine") return null
		const ks = idsOf().get(id)
		const it = ks &&
			(ks.map((k) => items.get(k)).find((x) => x && !x.path[0]?.startsWith("proc")) ??
				items.get(ks[0]))
		return it && (it.process || it.computed) ? label(it) : V.short(id)
	}
	const whoOf = (it) => own_(it, "who", () => who(it.change))
	const who = (c) => {
		if (!c) return "—"
		const actor = typeof c.actor === "string"
			? c.actor
			: typeof c.actor?.actor === "string"
			? c.actor.actor
			: null
		const by = writer(c.site?.file) ?? (typeof c.reader === "string" ? writer(c.reader) : null)
		return [actor && actor !== "machine" ? actor : null, by].filter((x) => x).join(" via ") ||
			actor || "—"
	}
	// where in the code: the op the change was, and the process or computed node that made it (newOS's sites are a
	// scope's, not a line's)
	const site = (c) => {
		const at = c?.site
		if (!at) return null
		const by = writer(at.file) ?? at.file
		return `${at.function ? at.function + " · " : ""}${by}${at.line ? ":" + at.line : ""}${
			at.column ? ":" + at.column : ""
		}`
	}

	// ---- drawing helpers, as My Computer's
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
	// Windows 98's raised edge round a box: lit above and left, dark below and right; sunk, the other way round
	const raised = (f, x, y, w, h, sunk = false) => {
		const lit_ = [C.hi, C.light], dark = [C.dark, C.lo]
		for (let k = 0; k < 2; k++) {
			const a = sunk ? dark[1 - k] : lit_[k], b = sunk ? lit_[1 - k] : dark[k]
			blit.fill(f, x + k * u, y + k * u, w - 2 * k * u, u, a)
			blit.fill(f, x + k * u, y + k * u, u, h - 2 * k * u, a)
			blit.fill(f, x + k * u, y + h - (k + 1) * u, w - 2 * k * u, u, b)
			blit.fill(f, x + w - (k + 1) * u, y + k * u, u, h - 2 * k * u, b)
		}
	}
	const fitted = (text, w, fnt) => {
		if (w <= 0) return ""
		if (blit.measure(text, fnt) <= w + 1) return text
		const n = blit.fit(text, w, fnt)
		return n >= text.length ? text : text.slice(0, Math.max(0, n - 1)) + "…"
	}
	const mid = (y, h, fnt) => y + Math.floor((h - blit.height(fnt)) / 2)
	// where each thing drawn is, from the last draw: what a click does there, and what VoiceOver says
	let zones = []
	const zone = (z) => zones.push(z)
	// a button, as the theme's buttons are: System 7's bevel, Windows 98's raised, catclock's soft white
	const button = (f, x, y, label_, act, on = true, accent = false) => {
		const soft = C.buttons === "soft"
		const w = blit.measure(label_, FT) + (soft ? 22 : 18) * u,
			h = blit.height(FT) + (soft ? 10 : 8) * u
		if (soft) {
			round(f, x, y + u, w, h, 8 * u, mixed(C.ink, C.paper, 0.08))
			round(f, x - u, y - u, w + 2 * u, h + 2 * u, 9 * u, accent ? C.pink : C.hair)
			round(f, x, y, w, h, 8 * u, accent ? mixed(C.pink, 0xffffff, 0.18) : 0xffffff)
		} else if (C.buttons === "raised") {
			if (accent) blit.frame(f, x - u, y - u, w + 2 * u, h + 2 * u, C.dark)
			blit.fill(f, x, y, w, h, C.chrome)
			raised(f, x, y, w, h)
		} else {
			if (accent) {
				blit.fill(f, x - 3 * u, y - 3 * u, w + 6 * u, h + 6 * u, C.line)
				blit.fill(f, x - u, y - u, w + 2 * u, h + 2 * u, C.chrome)
			}
			blit.fill(f, x, y, w, h, C.line)
			blit.fill(f, x + u, y + u, w - 2 * u, h - 2 * u, C.hi)
			blit.fill(f, x + 2 * u, y + 2 * u, w - 3 * u, h - 3 * u, C.lo)
			blit.fill(f, x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, C.chrome)
		}
		blit.text(
			f,
			x + Math.floor((w - blit.measure(label_, FT)) / 2),
			mid(y, h, FT),
			label_,
			on ? C.ink : C.dim,
			undefined,
			undefined,
			FT,
		)
		zone({ x, y, w, h, act: on ? act : null, role: "button", label: label_ })
		return x + w
	}
	// what is chosen, a row's or a cell's, as the theme draws it: a soft pill, the row on the highlighter, or (invert)
	// only its name in pick; the ink its name is drawn in
	const chosen = (f, x, y, w, h, nameX, nameW, clip) => {
		if (C.rows === "invert") {
			blit.fill(f, nameX - 2 * u, y + u, nameW + 4 * u, h - 2 * u, C.pick, clip)
			return C.pickInk
		}
		if (C.rows === "soft") round(f, x, y, w, h, 7 * u, C.select, clip)
		else blit.fill(f, x, y, w, h, C.select, clip)
		return C.ink
	}

	// ---- what just changed: lemon, fading over BLINK ms, as catclock's .fresh (ease-out), in STEP ms steps; what is
	// pending: an hourglass blinking lemon and white, a cog turning. T is the time a draw is of, so every part of it
	// says the same step, which its segment's key holds
	const BLINK = 1800, STEP = 600
	let T = Date.now()
	// how far a node's blink has got, in steps; -1, not lit
	const stage = (k) => {
		const at = lit.get(k)
		if (at === undefined) return -1
		const n = Math.floor((T - at) / STEP)
		return n * STEP >= BLINK ? -1 : n
	}
	const glow = (k, bg) => {
		const n = stage(k)
		return n < 0 ? bg : mixed(C.lemon, bg, (1 - (n * STEP) / BLINK) ** 2)
	}
	// the hourglass's half second, lemon or white
	const tick = () => Math.floor(T / 600) % 2
	const glass = (f, x, y, clip) => {
		const n = 8 * u
		blit.fill(f, x, y, n, n, C.line, clip)
		blit.fill(f, x + u, y + u, n - 2 * u, n - 2 * u, tick() === 0 ? C.lemon : 0xffffff, clip)
	}
	const waiting = (it) => it?.status === "pending"
	const secsSince = (k) => `${((T - (since.get(k) ?? T)) / 1000).toFixed(1)} s`

	// ---- small icons, as catclock's: a folder tinted by where it is, a page with a band saying what it holds, each a
	// few shapes in catclock's units, drawn smooth once a size and kept (icons.ts's, small), blended over what is under
	// them; with the theme's pixel icons, System 7's small ones, a point a pixel. A process: a box with an arrow out
	// (it acts); a computed node: a cog (it makes a value), turning while it is pending
	const outline = (d) => {
		const t = d.match(/[MLHVQZ]|-?[\d.]+/g) ?? []
		const out = []
		let x = 0, y = 0, i = 0
		const n = () => Number(t[i++])
		while (i < t.length) {
			const c = t[i++]
			if (c === "M" || c === "L") (x = n(), y = n(), out.push(x, y))
			else if (c === "H") (x = n(), out.push(x, y))
			else if (c === "V") (y = n(), out.push(x, y))
			else if (c === "Q") {
				const cx = n(), cy = n(), ex = n(), ey = n()
				for (let k = 1; k <= 8; k++) {
					const a = k / 8, b = 1 - a
					out.push(
						b * b * x + 2 * b * a * cx + a * a * ex,
						b * b * y + 2 * b * a * cy + a * a * ey,
					)
				}
				x = ex
				y = ey
			}
		}
		return out
	}
	// how much of each pixel a fill covers (nonzero, four lines a row), or a stroke (half its width either side)
	const filled = (p, w, h, k) => {
		const cover = new Float32Array(w * h), cross = []
		for (let py = 0; py < h; py++) {
			for (let j = 0; j < 4; j++) {
				const y = (py + (j + 0.5) / 4) / k
				cross.length = 0
				for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) {
					const x0 = p[m], y0 = p[m + 1], x1 = p[i], y1 = p[i + 1]
					if ((y0 <= y) === (y1 <= y)) continue
					cross.push([(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0)) * k, y1 > y0 ? 1 : -1])
				}
				cross.sort((a, b) => a[0] - b[0])
				let wind = 0
				for (let c = 0; c < cross.length - 1; c++) {
					wind += cross[c][1]
					if (!wind) continue
					const xa = Math.max(0, cross[c][0]), xb = Math.min(w, cross[c + 1][0])
					for (let px = Math.floor(xa); px < xb && px < w; px++) {
						cover[py * w + px] += (Math.min(px + 1, xb) - Math.max(px, xa)) / 4
					}
				}
			}
		}
		return cover
	}
	const stroked = (p, closed, width, w, h, k) => {
		const cover = new Float32Array(w * h), n = p.length / 2, hw = (width / 2) * k
		for (let i = 0; i < (closed ? n : n - 1); i++) {
			const x0 = p[2 * i] * k,
				y0 = p[2 * i + 1] * k,
				x1 = p[(2 * i + 2) % p.length] * k,
				y1 = p[(2 * i + 3) % p.length] * k
			const dx = x1 - x0, dy = y1 - y0, l = dx * dx + dy * dy
			for (
				let py = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1));
				py < Math.min(h, Math.ceil(Math.max(y0, y1) + hw + 1));
				py++
			) {
				for (
					let px = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1));
					px < Math.min(w, Math.ceil(Math.max(x0, x1) + hw + 1));
					px++
				) {
					const x = px + 0.5,
						y = py + 0.5,
						t = l ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l)) : 0
					const c = Math.max(
						0,
						Math.min(1, hw + 0.5 - Math.hypot(x - x0 - t * dx, y - y0 - t * dy)),
					)
					if (c > cover[py * w + px]) cover[py * w + px] = c
				}
			}
		}
		return cover
	}
	// the shapes over one another by how much of each pixel each covers, its alpha in the top byte (the blitter's blend)
	const raster = (w, h, k, shapes) => {
		const covers = shapes.map((
			sh,
		) => (sh.fill
			? filled(sh.fill, w, h, k)
			: stroked(sh.stroke, !!sh.closed, sh.width ?? 1, w, h, k))
		)
		const bits = new Uint32Array(w * h)
		for (let i = 0; i < w * h; i++) {
			let a = 0, r = 0, g = 0, b = 0
			shapes.forEach((sh, n) => {
				const c = Math.min(1, covers[n][i]) * (sh.alpha ?? 1)
				if (!c) return
				r = r * (1 - c) + ((sh.color >> 16) & 255) * c
				g = g * (1 - c) + ((sh.color >> 8) & 255) * c
				b = b * (1 - c) + (sh.color & 255) * c
				a = a * (1 - c) + c
			})
			const colour = a
				? (Math.round(r / a) << 16) | (Math.round(g / a) << 8) | Math.round(b / a)
				: 0
			bits[i] = (((255 - Math.round(a * 255)) << 24) | colour) >>> 0
		}
		return bits
	}
	// catclock's tints, by the area a folder is in (icons.ts's); a page's band for what it holds
	const TINT = {
		root: [0xffd95e, 0xfff0a6],
		pink: [0xffa9cf, 0xffd2e6],
		blue: [0x94c6ff, 0xc8e2ff],
		mint: [0x8ddbb5, 0xc3f0da],
		lilac: [0xc3b2ff, 0xe0d6ff],
	}
	const AREA = {
		home: TINT.pink,
		programs: TINT.blue,
		lib: TINT.blue,
		Applications: TINT.blue,
		drivers: TINT.mint,
		dev: TINT.mint,
		hw: TINT.mint,
	}
	const tinted = (path) => {
		const own_ = C.icons?.folder
		if (Array.isArray(own_) && own_.length === 2) return own_
		return path.length ? AREA[path[0]] ?? (path.length <= 1 ? TINT.root : TINT.lilac) : TINT.root
	}
	const BAND = {
		text: 0xd9cfdd,
		data: 0xffd84d,
		c: 0xff8fc0,
		javascript: 0x5fcf9f,
		wasm: 0x6eb4ff,
		bytes: 0xb3a5b8,
		fn: 0xb7a2ff,
		refused: 0xe2457c,
	}
	const bandOf = (it) => {
		if (it.refused) return "refused"
		const e = ext(it.name), v = it.value
		if (e === "c" || e === "h") return "c"
		if (e === "js" || e === "ts" || e === "mjs") return "javascript"
		if (e === "wasm") return "wasm"
		if (v === undefined || v === null) return null
		if (ArrayBuffer.isView(v)) return "bytes"
		if (typeof v === "string") return "text"
		if (typeof v === "function" || v?.constructor?.name === "Stand") return "fn"
		return "data"
	}
	const LINE = 0x3a2a43
	const FOLDER = ([back, front]) => [
		{
			fill: outline(
				"M3,9 Q3,4 8,4 H23 Q26,4 28,7 L30,10 H56 Q61,10 61,15 V45 Q61,49 57,49 H7 Q3,49 3,45 Z",
			),
			color: back,
		},
		{
			fill: outline("M3,19 Q3,15 7,15 H57 Q61,15 61,19 V45 Q61,49 57,49 H7 Q3,49 3,45 Z"),
			color: front,
		},
		{ stroke: [8, 19.6, 56, 19.6], width: 1.3, color: 0xffffff, alpha: 0.75 },
	]
	const PAGE = (band, faint) => {
		const body = outline("M8,2 H31 L44,15 V54 Q44,58 40,58 H8 Q4,58 4,54 V6 Q4,2 8,2 Z"),
			corner = outline("M31,2 V11 Q31,15 35,15 H44 Z")
		return [
			{ fill: body, color: 0xffffff, alpha: faint ? 0.5 : 1 },
			...(band === null
				? []
				: [{ fill: outline("M4.5,40 H43.5 V53 H4.5 Z"), color: BAND[band] }]),
			{ stroke: body, closed: true, width: 2, color: LINE, alpha: faint ? 0.25 : 0.4 },
			{ fill: corner, color: 0xf4eef7 },
			{ stroke: corner, width: 2, color: LINE, alpha: 0.4 },
		]
	}
	// System 7's small icons, 16 × 16, a point a pixel: k line, p paper, y lemon, d dim
	const PIXELS = {
		folder: [
			"................",
			"................",
			"..kkkkk.........",
			".kyyyyyk........",
			"kkkkkkkkkkkkkkk.",
			"kyyyyyyyyyyyyyk.",
			"kyyyyyyyyyyyyyk.",
			"kyyyyyyyyyyyyyk.",
			"kyyyyyyyyyyyyyk.",
			"kyyyyyyyyyyyyyk.",
			"kyyyyyyyyyyyyyk.",
			"kyyyyyyyyyyyyyk.",
			"kyyyyyyyyyyyyyk.",
			"kkkkkkkkkkkkkkk.",
			"................",
			"................",
		],
		text: [
			"..kkkkkkkkk.....",
			"..kpppppppkk....",
			"..kpppppppkpk...",
			"..kpppppppkkkk..",
			"..kpkkkkpppppk..",
			"..kppppppppppk..",
			"..kpkkkkkkkppk..",
			"..kppppppppppk..",
			"..kpkkkkkkpppk..",
			"..kppppppppppk..",
			"..kpkkkkkkkppk..",
			"..kppppppppppk..",
			"..kpkkkkkppppk..",
			"..kppppppppppk..",
			"..kkkkkkkkkkkk..",
			"................",
		],
		data: [
			"..kkkkkkkkk.....",
			"..kpppppppkk....",
			"..kpppppppkpk...",
			"..kpppppppkkkk..",
			"..kppppppppppk..",
			"..kppkpppkpppk..",
			"..kpkppppkpppk..",
			"..kpkpppppkppk..",
			"..kkppppppkppk..",
			"..kpkpppppkppk..",
			"..kpkppppkpppk..",
			"..kppkpppkpppk..",
			"..kppppppppppk..",
			"..kppppppppppk..",
			"..kkkkkkkkkkkk..",
			"................",
		],
		empty: [
			"..d.d.d.d.d.....",
			"................",
			"..d.......d.d...",
			"................",
			"..d.........d...",
			"................",
			"..d.........d...",
			"................",
			"..d.........d...",
			"................",
			"..d.........d...",
			"................",
			"..d.........d...",
			"................",
			"..d.d.d.d.d.d...",
			"................",
		],
	}
	const SM = 16 * u
	const smallKept = new Map()
	const vector = () => C.icons?.style === "vector"
	const small = (f, it, x, y, clip) => {
		if (it.process) return actor(f, x, y, clip)
		if (it.computed) return cog(f, it, x, y, clip)
		const isFolder = folder(it) || hollow(it) || it.key === ""
		if (!vector()) {
			const rows = PIXELS[
				isFolder
					? "folder"
					: it.value === undefined || it.value === null || it.quiet
					? (it.quiet ? "data" : "empty")
					: typeof it.value === "string"
					? "text"
					: "data"
			]
			const id = `px ${rows[4]}${rows[7]} ${C.line} ${C.paper} ${C.lemon} ${C.dim}`
			let made = smallKept.get(id)
			if (!made) {
				// drawn once into a form, clear where the icon is not, and kept
				made = blit.form(SM, SM, 0xff000000)
				I.art(made, { rows, colors: { k: C.line, p: C.paper, y: C.lemon, d: C.dim } }, 0, 0, u)
				smallKept.set(id, made)
			}
			return void f.ops.push({
				op: "pixels",
				x,
				y,
				w: SM,
				h: SM,
				bits: made.bits,
				rule: "over",
				...(clip ? { clip } : {}),
			})
		}
		const band = isFolder ? null : bandOf(it)
		const faint = !isFolder && (it.value === undefined || it.value === null) && !it.quiet
		const [list, uw, uh] = isFolder
			? [FOLDER(tinted(it.path)), 64, 52]
			: [PAGE(it.quiet ? "data" : band, faint), 48, 60]
		const k = Math.min((SM - u) / uw, (SM - u) / uh), w = Math.ceil(uw * k), h = Math.ceil(uh * k)
		const id = isFolder
			? `f ${tinted(it.path).join()} ${SM}`
			: `p ${it.quiet ? "data" : band} ${faint} ${SM}`
		let made = smallKept.get(id)
		if (!made) smallKept.set(id, made = { w, h, bits: raster(w, h, k, list) })
		f.ops.push({
			op: "pixels",
			x: x + Math.floor((SM - w) / 2),
			y: y + Math.floor((SM - h) / 2),
			w,
			h,
			bits: made.bits,
			rule: "blend",
			...(clip ? { clip } : {}),
		})
	}
	// a cog: eight teeth round a ring, the theme's blue (cherry when it failed), turning while it is pending
	const cog = (f, it, x, y, clip, side = SM) => {
		const cx = x + side / 2,
			cy = y + side / 2,
			r = side * 0.3,
			ink = it.status === "failed" ? C.cherry : C.blue
		const turn = it.status === "pending" ? ((Math.floor(T / STEP) % 8) / 8) * Math.PI * 2 : 0
		for (let i = 0; i < 8; i++) {
			const a = turn + (i * Math.PI) / 4, b = side * 0.07, o = side * 0.46
			const ca = Math.cos(a), sa = Math.sin(a)
			blit.fillpoly(
				f,
				[
					cx + ca * r - sa * b,
					cy + sa * r + ca * b,
					cx + ca * o - sa * b,
					cy + sa * o + ca * b,
					cx + ca * o + sa * b,
					cy + sa * o - ca * b,
					cx + ca * r + sa * b,
					cy + sa * r - ca * b,
				],
				"nonzero",
				ink,
				clip,
			)
		}
		blit.fillellipse(
			f,
			Math.round(cx),
			Math.round(cy),
			Math.round(r + side * 0.04),
			Math.round(r + side * 0.04),
			ink,
			clip,
		)
		blit.fillellipse(
			f,
			Math.round(cx),
			Math.round(cy),
			Math.round(r * 0.55),
			Math.round(r * 0.55),
			0xffffff,
			clip,
		)
		blit.fillellipse(
			f,
			Math.round(cx),
			Math.round(cy),
			Math.max(u, Math.round(r * 0.22)),
			Math.max(u, Math.round(r * 0.22)),
			ink,
			clip,
		)
	}
	// a process: a box, an arrow out of it in pink (catclock's effect)
	const actor = (f, x, y, clip, side = SM) => {
		const k = side / 16
		blit.fill(
			f,
			x + Math.round(1.5 * k),
			y + Math.round(3.5 * k),
			Math.round(9 * k),
			Math.round(9 * k),
			C.ink,
			clip,
		)
		blit.fill(
			f,
			x + Math.round(1.5 * k) + u,
			y + Math.round(3.5 * k) + u,
			Math.round(9 * k) - 2 * u,
			Math.round(9 * k) - 2 * u,
			0xffffff,
			clip,
		)
		const w = Math.max(u, Math.round(1.6 * k))
		blit.line(
			f,
			x + Math.round(6 * k),
			y + Math.round(8 * k),
			x + Math.round(14.5 * k),
			y + Math.round(8 * k),
			w,
			C.pink,
			clip,
		)
		blit.line(
			f,
			x + Math.round(11.5 * k),
			y + Math.round(5 * k),
			x + Math.round(14.5 * k),
			y + Math.round(8 * k),
			w,
			C.pink,
			clip,
		)
		blit.line(
			f,
			x + Math.round(11.5 * k),
			y + Math.round(11 * k),
			x + Math.round(14.5 * k),
			y + Math.round(8 * k),
			w,
			C.pink,
			clip,
		)
	}
	// what an icon is drawn from, for a segment's key
	const look_ = (it) =>
		it.process
			? "p"
			: it.computed
			? `c${it.status ?? ""}${it.status === "pending" ? Math.floor(T / STEP) % 8 : ""}`
			: `${folder(it) || hollow(it) || it.key === "" ? "f" : "n"}${bandOf(it)}${
				it.quiet ? "q" : ""
			}${it.value === undefined || it.value === null ? "e" : ""}`
	// a node as My Computer's icons draw it, the theme's (icons.ts), big
	const entry = (it) => {
		const e = {
			at: parent(it.path),
			name: it.name,
			ids: it.id ? [it.id] : [],
			e: it.ephemeral,
			kids: it.again ? 0 : it.names.length,
			value: it.quiet ? null : it.value ?? null,
			provisions: null,
		}
		return {
			...e,
			kind: it.refused
				? "refused"
				: it.arriving
				? "pending"
				: it.key === ""
				? "folder"
				: I.kind(e),
		}
	}
	const big = (f, it, x, y, on = false) => {
		const n = I.size() * u
		if (it.process || it.computed) {
			const ring = vector() ? 0xffffff : C.paper
			if (vector()) {
				round(f, x + 2 * u, y + 2 * u, n - 4 * u, n - 4 * u, 12 * u, on ? C.select : ring)
			} else blit.frame(f, x + 2 * u, y + 2 * u, n - 4 * u, n - 4 * u, C.line)
			return it.process
				? actor(f, x + n / 4, y + n / 4, undefined, n / 2)
				: cog(f, it, x + n / 4, y + n / 4, undefined, n / 2)
		}
		I.icon(f, entry(it), x, y, on)
	}

	// ---- going places
	const go = (path, pick = null) => {
		if (key(path) !== key(s.here)) {
			s.past.push(s.here)
			s.ahead.length = 0
		}
		s.here = path
		s.picked = pick
		s.run = null
		s.main[s.view] = 0
	}
	const pick = (k) => {
		s.picked = k
		s.run = null
		const it = items.get(k)
		if (s.view === "columns" && it) s.here = folder(it) ? it.path : parent(it.path)
		if (s.view === "map") s.map = null
	}
	// a double click, Enter: into a folder (picked, in the columns), else opened
	const activate = (g, it) => {
		if (!it) return
		if ((folder(it) || hollow(it)) && s.view !== "map") {
			if (s.view === "columns") pick(it.key)
			else go(it.path)
		} else if (it.key !== "") open(g, it)
	}
	// a program started for the person: through the window manager's launch, else as this process's own (icons.ts's)
	let said = null
	const open = (g, it) => {
		if (!it || it.key === "") return
		try {
			if (isPicture(it.value)) I.start(g, "paint", "programs/paint", { path: it.path })
			else I.start(g, "edit", "programs/edit", { path: it.path })
			said = [`opened /${it.key}`, C.ok]
		} catch (e) {
			said = [why(e), C.cherry]
		}
	}
	const back = () => {
		if (!s.past.length) return
		s.ahead.push(s.here)
		s.here = s.past.pop()
		s.picked = null
		s.run = null
	}
	const forward = () => {
		if (!s.ahead.length) return
		s.past.push(s.here)
		s.here = s.ahead.pop()
		s.picked = null
		s.run = null
	}
	const up = () => {
		if (s.view === "columns" || s.view === "map") {
			const it = s.picked !== null ? items.get(s.picked) : null
			if (it && it.path.length) pick(key(parent(it.path)))
			return
		}
		if (s.here.length) go(parent(s.here), key(s.here))
	}
	const view = (g, v) => {
		if (!VIEWS.includes(v) || v === s.view) return
		s.view = v
		if (v === "columns" && s.picked === null && s.here.length) s.picked = key(s.here)
		if (v === "map") s.map = null
		// kept once it has stayed a moment (a document: each write is signed and saved)
		keeping?.(g.api)
		keeping = after(g, 2000, ({ api }) => {
			keeping = null
			try {
				snap(api, KEPT, s.view)
			} catch {
				// kept for this window only
			}
		})
	}
	let keeping = null
	// a node picked elsewhere (changed lately, a process's parts): shown where it is
	const reveal = (k) => {
		const it = items.get(k)
		if (!it) return
		for (let i = 1; i < it.path.length; i++) s.open.add(key(it.path.slice(0, i)))
		if (s.view === "icons") go(parent(it.path), k)
		else if (s.view === "list") {
			if (!(it.path.length > s.here.length && under(it.path, s.here))) go([], k)
			else pick(k)
		} else pick(k)
	}

	// ---- drawing: the panes, then over them the bar, the places and the one picked, the status
	const RH = () => Math.max(blit.height(F), blit.height(FX), SM) + 8 * u
	const TB = () => blit.height(FT) + (C.buttons === "soft" ? 26 : 16) * u
	const FOOT = () => blit.height(F) + (C.buttons === "soft" ? 12 : 8) * u
	const SIDEW = () => (W >= 820 * u ? 184 * u : 0)
	const INFOW = () => (W >= 560 * u ? Math.min(272 * u, Math.floor(W * 0.3)) : 0)
	const panes = () => {
		const top = TB(), h = H - TB() - FOOT(), sw = SIDEW(), iw = INFOW()
		return {
			side: { x: 0, y: top, w: sw, h },
			main: { x: sw, y: top, w: W - sw - iw, h },
			info: { x: W - iw, y: top, w: iw, h },
		}
	}
	const tint = () => mixed(0xffffff, C.paper, 0.5)
	const scrolled = (want, total, room) => Math.max(0, Math.min(want, Math.max(0, total - room)))

	// ---- drawing in segments, as the graph browser draws: the paper, each pane's ground, each row, tile, cell or box,
	// the bar, the one picked, the status. A segment's key says what it is drawn from; one whose key is as it was is not
	// drawn again, and only the ops of those that changed are written (paint, below). The look (the size, the theme,
	// the fonts and the pages of them that have come) changed: all of it
	let segs = [], prior = new Map(), pieces = [], style = null, whole_ = true
	const seg = (k, fn) => {
		const old = prior.get(k)
		if (old) return void pieces.push(old)
		const was = zones
		zones = []
		const f = blit.list(W, H)
		fn(f)
		pieces.push({ key: k, ops: f.ops, zones })
		zones = was
	}
	const pages = (role) => items.get(`dev/font/${role}/pages`)?.names.join(",") ?? ""
	const draw = (g) => {
		T = Date.now()
		due = Infinity
		const look = JSON.stringify([
			W,
			H,
			C,
			String(F ?? ""),
			String(FT ?? ""),
			String(FX ?? ""),
			pages("text"),
			pages("title"),
			pages("fixed"),
		])
		whole_ = look !== style
		prior = whole_ ? new Map() : new Map(segs.map((x) => [x.key, x]))
		style = look
		pieces = []
		zones = []
		const P = panes()
		// the paper under the middle only: the panes round it and the bars are drawn whole over theirs
		seg(
			`paper ${JSON.stringify(P.main)}`,
			(f) => blit.fill(f, P.main.x, P.main.y, P.main.w, P.main.h, C.paper),
		)
		if (s.view === "icons") drawIcons(P.main)
		else if (s.view === "list") drawList(P.main)
		else if (s.view === "columns") drawColumns(P.main)
		else drawMap(P.main)
		if (P.side.w) drawSide(P.side)
		if (P.info.w) drawInfo(g, P.info, s.picked !== null ? items.get(s.picked) : null)
		drawBar()
		drawStatus()
		segs = pieces
		zones = pieces.flatMap((x) => x.zones)
		return pieces
	}

	// the bar: back and forward, where it is, the views
	const drawBar = () => {
		const trail = (s.view === "columns" || s.view === "map") && s.picked !== null
			? items.get(s.picked)?.path ?? s.here
			: s.here
		seg(`bar ${JSON.stringify([s.view, trail, s.past.length > 0, s.ahead.length > 0])}`, (f) => {
			const top = TB(), soft = C.buttons === "soft"
			blit.fill(f, 0, 0, W, top, soft ? mixed(0xffffff, C.paper, 0.45) : C.chrome)
			blit.fill(f, 0, top - u, W, u, C.hair)
			const bh = soft ? 26 * u : blit.height(FT) + 8 * u, by = Math.floor((top - u - bh) / 2)
			let x = 12 * u
			// catclock's round buttons, a chevron each; else the theme's buttons, an arrow each
			const nav = (dir, act, on) => {
				if (!soft) {
					x = button(f, x, by, dir < 0 ? "◀" : "▶", act, on) + 4 * u
					return
				}
				const w = 28 * u
				round(
					f,
					x - u,
					by - u,
					w + 2 * u,
					bh + 2 * u,
					8 * u,
					on ? C.line : mixed(C.line, C.paper, 0.45),
				)
				round(f, x, by, w, bh, 7 * u, 0xffffff)
				const cx = x + w / 2,
					cy = by + bh / 2,
					k = 4 * u,
					ink = on ? C.ink : mixed(C.ink, 0xffffff, 0.35),
					lw = Math.max(1, Math.round(1.6 * u))
				blit.line(
					f,
					Math.round(cx + (dir * -k) / 2),
					Math.round(cy - k),
					Math.round(cx + (dir * k) / 2),
					Math.round(cy),
					lw,
					ink,
				)
				blit.line(
					f,
					Math.round(cx + (dir * k) / 2),
					Math.round(cy),
					Math.round(cx + (dir * -k) / 2),
					Math.round(cy + k),
					lw,
					ink,
				)
				zone({
					x,
					y: by,
					w,
					h: bh,
					act: on ? act : null,
					role: "button",
					label: dir < 0 ? "back" : "forward",
				})
				x += w + 4 * u
			}
			nav(-1, "back", s.past.length > 0)
			nav(1, "forward", s.ahead.length > 0)
			x += 8 * u
			// the views, a segmented control at the right: a line round it, the one shown on the highlighter (catclock's);
			// Windows 98's, raised, the one shown sunk; System 7's, the one shown inverted
			const vw = 34 * u,
				vh = soft ? 24 * u : bh,
				vx = W - 12 * u - VIEWS.length * vw,
				vy = Math.floor((top - u - vh) / 2)
			if (soft) {
				round(f, vx - u, vy - u, VIEWS.length * vw + 2 * u, vh + 2 * u, 8 * u, C.line)
				round(f, vx, vy, VIEWS.length * vw, vh, 7 * u, 0xffffff)
			} else if (C.buttons !== "raised") blit.fill(f, vx, vy, VIEWS.length * vw + u, vh, C.line)
			VIEWS.forEach((v, i) => {
				const bx = vx + i * vw, on = s.view === v
				let ink = on ? C.ink : C.ink2
				if (soft) {
					if (on) {
						if (i === 0) round(f, bx, vy, vw, vh, 7 * u, C.lemon)
						else if (i === VIEWS.length - 1) round(f, bx, vy, vw, vh, 7 * u, C.lemon)
						blit.fill(
							f,
							i === 0 ? bx + 7 * u : bx,
							vy,
							vw - (i === 0 || i === VIEWS.length - 1 ? 7 * u : 0),
							vh,
							C.lemon,
						)
					}
					if (i) blit.fill(f, bx, vy, u, vh, C.line)
				} else if (C.buttons === "raised") {
					blit.fill(f, bx, vy, vw, vh, on ? mixed(C.hi, C.chrome, 0.5) : C.chrome)
					raised(f, bx, vy, vw, vh, on)
				} else {
					// System 7's: boxes side by side in a black line, the one shown inverted
					blit.fill(f, bx + u, vy + u, vw - u, vh - 2 * u, on ? C.line : C.hi)
					ink = on ? C.hi : C.ink
				}
				glyph(f, v, bx + vw / 2, vy + vh / 2, ink)
				zone({
					x: bx,
					y: vy,
					w: vw,
					h: vh,
					act: "view",
					v,
					role: "button",
					label: `as ${v}${on ? ", shown" : ""}`,
				})
			})
			// where it is: the root's icon and "graph", then each name, the last in ink (on a pill, with pills)
			const room = vx - 12 * u, lh = blit.height(FX), ty = mid(0, top - u, FX)
			const crumb = (text, path, last, root) => {
				const w = blit.measure(text, root ? F : FX) + (root ? SM + 6 * u : 0) + 12 * u
				if (x + w > room) return false
				if (last && C.pill) {
					round(f, x, ty - 2 * u, w, lh + 4 * u, Math.floor(lh / 2) + 2 * u, C.select)
				} else if (last && C.rows === "invert") blit.fill(f, x, ty - u, w, lh + 2 * u, C.pick)
				let cx = x + 6 * u
				if (root) {
					small(
						f,
						{ path: [], key: "", names: [1], name: "/" },
						cx,
						Math.floor((top - u - SM) / 2),
					)
					cx += SM + 6 * u
				}
				blit.text(
					f,
					cx,
					root ? mid(0, top - u, F) : ty,
					text,
					last && C.rows === "invert" ? C.pickInk : last ? C.ink : C.ink2,
					undefined,
					undefined,
					root ? F : FX,
				)
				zone({ x, y: 0, w, h: top, act: "go", path, role: "link", label: "/" + path.join("/") })
				x += w
				return true
			}
			crumb("graph", [], !trail.length, true)
			trail.forEach((n, i) => {
				if (x + blit.measure("›", F) + 4 * u > room) return
				x = blit.text(f, x + 2 * u, mid(0, top - u, F), "›", C.dim, undefined, undefined, F) +
					2 * u
				crumb(n, trail.slice(0, i + 1), i === trail.length - 1, false)
			})
		})
	}
	// the views' marks, as catclock's: four squares, three lines, three columns, a little tree
	const glyph = (f, v, cx, cy, ink) => {
		const k = u, lw = Math.max(1, Math.round(1.4 * u))
		cx = Math.round(cx)
		cy = Math.round(cy)
		if (v === "icons") {
			for (const [dx, dy] of [[-6, -6], [1, -6], [-6, 1], [1, 1]]) {
				blit.frame(f, cx + dx * k, cy + dy * k, 5 * k, 5 * k, ink)
			}
		} else if (v === "list") {
			for (const dy of [-4, 0, 4]) blit.fill(f, cx - 6 * k, cy + dy * k, 12 * k, lw, ink)
		} else if (v === "columns") {
			for (const dx of [-6, -2, 2]) blit.frame(f, cx + dx * k, cy - 5 * k, 4 * k, 10 * k, ink)
		} else {
			blit.ellipse(f, cx - 5 * k, cy, 2 * k, 2 * k, lw, ink)
			blit.ellipse(f, cx + 5 * k, cy - 4 * k, 2 * k, 2 * k, lw, ink)
			blit.ellipse(f, cx + 5 * k, cy + 4 * k, 2 * k, 2 * k, lw, ink)
			blit.line(f, cx - 3 * k, cy - k, cx + 3 * k, cy - 4 * k, lw, ink)
			blit.line(f, cx - 3 * k, cy + k, cx + 3 * k, cy + 4 * k, lw, ink)
		}
	}

	// the places: the root and what is at the top; what changed lately; what runs, the pending first (catclock has
	// what runs above what changed, but here what runs is every process, too many to see past). A row a segment
	const drawSide = (R) => {
		const clip = { x: R.x, y: R.y, w: R.w - u, h: R.h }, rh = RH(), gh = blit.height(F) + 12 * u
		seg(`side ${R.y} ${R.h}`, (f) => {
			blit.fill(f, R.x, R.y, R.w, R.h, tint())
			blit.fill(f, R.x + R.w - u, R.y, u, R.h, C.hair)
			zone({ x: R.x, y: R.y, w: R.w, h: R.h, act: "pane", pane: "side" })
		})
		const rows = []
		const group = (text) =>
			rows.push({
				h: gh,
				draw: (y) =>
					seg(`group ${y} ${text}`, (f) =>
						blit.text(
							f,
							R.x + 16 * u,
							y + gh - blit.height(F) - 3 * u,
							text,
							C.dim,
							undefined,
							clip,
							F,
						)),
			})
		const spot = (it, text, on, em, act, emInk) =>
			rows.push({
				h: rh,
				draw: (y) =>
					seg(
						`spot ${y} ${
							JSON.stringify([
								it.key,
								text,
								on,
								em,
								emInk ?? null,
								act,
								stage(it.key),
								it.status,
								waiting(it) ? tick() : 0,
								look_(it),
							])
						}`,
						(f) => {
							const x = R.x + 8 * u, w = R.w - 17 * u
							const tw = Math.min(
								blit.measure(text, F),
								w - SM - 26 * u - (em ? blit.measure(em, F) + 6 * u : 0),
							)
							let ink = C.ink
							if (on) ink = chosen(f, x, y + u, w, rh - 2 * u, x + SM + 14 * u, tw, clip)
							else {
								const bg = it.status === "pending" ? mixed(C.lemon, tint(), 0.45) : tint(),
									c = glow(it.key, bg)
								if (c !== tint()) {
									round(
										f,
										x,
										y + u,
										w,
										rh - 2 * u,
										C.buttons === "soft" ? 7 * u : 0,
										c,
										clip,
									)
								}
							}
							small(f, it, x + 8 * u, y + Math.floor((rh - SM) / 2), clip)
							const end = blit.text(
								f,
								x + SM + 14 * u,
								mid(y, rh, F),
								fitted(text, tw, F),
								ink,
								undefined,
								clip,
								F,
							)
							if (waiting(it) && !em) {
								glass(f, end + 4 * u, y + Math.floor(rh / 2) - 4 * u, clip)
							}
							if (em) {
								blit.text(
									f,
									x + w - 8 * u - blit.measure(em, F),
									mid(y, rh, F),
									em,
									on && C.rows === "invert" ? C.pickInk : emInk ?? C.dim,
									undefined,
									clip,
									F,
								)
							}
							zone({
								x,
								y,
								w,
								h: rh,
								...act,
								role: "button",
								label: `${text}${em ? ", " + em : ""}`,
							})
						},
					),
			})
		const top = items.get("")
		group("graph")
		if (top) {
			spot(top, "the root", !s.picked && !s.run && !s.here.length, null, { act: "go", path: [] })
			for (const it of kids(top)) {
				spot(it, it.name, !s.picked && !s.run && key(s.here) === it.key, null, {
					act: "go",
					path: it.path,
				})
			}
		}
		// changed lately: what this window has seen change, newest first; then the rest by time. A node placed twice shown
		// once, at its first place
		const recent = once("recent", () => {
			const out = [], ids = new Set()
			for (
				const it of [...items.values()].filter((it) =>
					it.value !== undefined && it.key !== "" && !it.quiet
				)
					.sort((a, b) =>
						(seen.get(b.key) ?? 0) - (seen.get(a.key) ?? 0) ||
						(secs(b.change?.time) ?? 0) - (secs(a.change?.time) ?? 0) ||
						a.key.localeCompare(b.key)
					)
			) {
				if (out.length === 4) break
				if (ids.has(it.id)) continue
				ids.add(it.id)
				out.push(it)
			}
			return out
		})
		if (recent.length) {
			group("changed lately")
			for (const it of recent) {
				spot(it, it.name, s.picked === it.key, ago(it.change?.time), {
					act: "reveal",
					k: it.key,
				})
			}
		}
		// running: each process, and each computed node that is pending or failed; the pending first
		const runs = once("runs", () => {
			const ids = new Set()
			return [...items.values()].filter((it) =>
				(it.process || (it.computed && it.status)) && !ids.has(it.id) && ids.add(it.id)
			)
				.sort((a, b) =>
					Number(waiting(b)) - Number(waiting(a)) ||
					Number(b.status === "failed") - Number(a.status === "failed") ||
					label(a).localeCompare(label(b))
				)
		})
		if (runs.length) {
			group("running")
			for (const it of runs) {
				spot(
					it,
					label(it),
					s.run === it.key,
					it.status === "pending"
						? secsSince(it.key)
						: it.status === "failed"
						? "failed"
						: null,
					{ act: "run", k: it.key },
					it.status === "failed"
						? C.cherry
						: it.status === "pending"
						? mixed(C.ink, C.lemon, 0.7)
						: undefined,
				)
			}
		}
		const total = rows.reduce((n, r) => n + r.h, 0) + 12 * u
		s.side = scrolled(s.side, total, R.h)
		let y = R.y + 4 * u - s.side
		for (const r of rows) {
			if (y + r.h > R.y && y < R.y + R.h) r.draw(y)
			y += r.h
		}
	}

	const nothing = (f, R, text) =>
		blit.text(f, R.x + 18 * u, R.y + 18 * u, text, C.dim, undefined, R, F)
	// a pane's ground: what a click on nothing in it does, and what it says when it shows nothing
	const ground = (R, act, label_, empty) =>
		seg(`ground ${JSON.stringify([R, act, label_, empty])}`, (f) => {
			zone({ x: R.x, y: R.y, w: R.w, h: R.h, act, role: "list", label: label_ })
			if (empty) nothing(f, R, empty)
		})

	// the icons of the folder shown, a grid; a tile a segment
	const drawIcons = (R) => {
		const at = items.get(key(s.here)), list = kids(at)
		ground(R, "blank", "/" + key(s.here), list.length ? null : "nothing under here yet")
		if (!list.length) return
		const n = I.size() * u,
			lh = blit.height(FX),
			cw = 112 * u,
			ch = 10 * u + n + 6 * u + 2 * lh + blit.height(F) + 10 * u
		const per = Math.max(1, Math.floor((R.w - 32 * u) / cw)),
			x0 = R.x + Math.floor((R.w - per * cw) / 2)
		const total = Math.ceil(list.length / per) * ch + 32 * u
		s.main.icons = scrolled(s.main.icons, total, R.h)
		list.forEach((it, i) => {
			const x = x0 + (i % per) * cw, y = R.y + 16 * u + Math.floor(i / per) * ch - s.main.icons
			if (y + ch < R.y || y > R.y + R.h) return
			const on = s.picked === it.key, clip = R
			seg(
				`tile ${
					JSON.stringify([
						x,
						y,
						it.key,
						it.sig,
						on,
						stage(it.key),
						waiting(it) ? tick() : 0,
						look_(it),
						kind(it),
						size(it),
					])
				}`,
				(f) => {
					const bg = glow(it.key, C.paper)
					if (bg !== C.paper) {
						round(
							f,
							x + 3 * u,
							y,
							cw - 6 * u,
							ch - 4 * u,
							C.buttons === "soft" ? 10 * u : 0,
							bg,
							clip,
						)
					}
					if (on && C.buttons === "soft") {
						round(
							f,
							x + 3 * u - u,
							y - u,
							cw - 6 * u + 2 * u,
							ch - 4 * u + 2 * u,
							10 * u,
							C.line,
							clip,
						)
						round(f, x + 3 * u, y, cw - 6 * u, ch - 4 * u, 10 * u, bg, clip)
					}
					big(f, it, x + Math.floor((cw - n) / 2), y + 10 * u, on)
					if (waiting(it)) glass(f, x + cw - 30 * u, y + 10 * u, clip)
					// the name in two lines at most, the one picked in pick (a pill, or a box), as My Computer's
					let ly = y + 10 * u + n + 6 * u
					wrapped(it.name, cw - 14 * u, FX).forEach((t) => {
						const tw = blit.measure(t, FX), tx = x + Math.floor((cw - tw) / 2)
						let ink = C.ink
						if (on) {
							if (C.pill) {
								round(
									f,
									tx - 6 * u,
									ly - u,
									tw + 12 * u,
									lh + 2 * u,
									Math.floor(lh / 2) + u,
									C.select,
									clip,
								)
							} else {
								blit.fill(f, tx - 3 * u, ly - u, tw + 6 * u, lh + 2 * u, C.pick, clip)
								ink = C.pickInk
							}
						}
						blit.text(f, tx, ly, t, ink, undefined, clip, FX)
						ly += lh
					})
					const sub = size(it)
					blit.text(
						f,
						x + Math.floor((cw - blit.measure(sub, F)) / 2),
						ly + 2 * u,
						sub,
						C.dim,
						undefined,
						clip,
						F,
					)
					zone({
						x,
						y: Math.max(y, R.y),
						w: cw,
						h: Math.min(y + ch, R.y + R.h) - Math.max(y, R.y),
						act: "item",
						k: it.key,
						role: "button",
						label: `${it.name}, ${kind(it)}${on ? ", picked" : ""}`,
					})
				},
			)
		})
	}
	const wrapped = (text, w, fnt) => {
		const n = blit.fit(text, w, fnt)
		if (n >= text.length) return [text]
		const space = text.lastIndexOf(" ", n)
		const at = space > 0 ? space + 1 : Math.max(1, n)
		return [text.slice(0, at).trimEnd(), fitted(text.slice(at).trimStart(), w, fnt)]
	}

	// the list: the folder shown, folders opening in place; a row's name, kind, size, when and by whom
	const rowsOf = () => {
		const out = []
		const row = (it, depth) => {
			out.push({ it, depth })
			if (folder(it) && s.open.has(it.key)) { for (const c of kids(it)) row(c, depth + 1) }
		}
		for (const it of kids(items.get(key(s.here)))) row(it, 0)
		return out
	}
	const drawList = (R) => {
		const rh = RH(), rows = rowsOf(), hh = blit.height(F) + 12 * u
		ground(R, "blank", "/" + key(s.here), rows.length ? null : "nothing under here yet")
		if (!rows.length) return
		// the columns: what does not fit goes, by from the right
		const gap = 10 * u, pad = 14 * u
		let cols = [["kind", 150 * u], ["size", 72 * u], ["changed", 84 * u], ["by", 104 * u]]
		for (const drop of ["by", "kind", "changed", "size"]) {
			if (R.w - 2 * pad - cols.reduce((n, [, w]) => n + w + gap, 0) < 200 * u) {
				cols = cols.filter(([n]) => n !== drop)
			}
		}
		const nameW = R.w - 2 * pad - cols.reduce((n, [, w]) => n + w + gap, 0)
		const xs = {}
		let cx = R.x + pad + nameW + gap
		for (const [n, w] of cols) (xs[n] = [cx, w], cx += w + gap)
		const total = rows.length * rh + hh + 8 * u
		s.main.list = scrolled(s.main.list, total, R.h)
		const body = { x: R.x, y: R.y + hh, w: R.w, h: R.h - hh }
		const stripe = mixed(C.ink, C.paper, 0.025)
		rows.forEach(({ it, depth }, i) => {
			const y = body.y + i * rh - s.main.list
			if (y + rh < body.y || y > body.y + body.h) return
			const on = s.picked === it.key, open_ = s.open.has(it.key)
			const text = {
				kind: kind(it),
				size: size(it),
				changed: it.change ? ago(it.change.time) : "—",
				by: whoOf(it),
			}
			seg(
				`row ${
					JSON.stringify([
						y,
						i % 2,
						it.key,
						it.sig,
						depth,
						on,
						open_,
						stage(it.key),
						waiting(it) ? tick() : 0,
						look_(it),
						text,
					])
				}`,
				(f) => {
					// even rows a little darker, as catclock's
					const bg = glow(it.key, i % 2 ? stripe : C.paper)
					if (bg !== C.paper && !on) blit.fill(f, R.x, y, R.w, rh, bg, body)
					if (waiting(it) && !on) {
						blit.fill(f, R.x, y, R.w, rh, mixed(C.lemon, C.paper, 0.35), body)
					}
					const nx = R.x + pad + depth * 18 * u
					const tx = nx + 16 * u + SM + 6 * u
					const tw = Math.min(
						blit.measure(it.name, FX),
						R.x + pad + nameW - tx - (waiting(it) ? 14 * u : 0),
					)
					let ink = C.ink
					if (on) {
						ink = C.rows === "invert" ? chosen(f, R.x, y, R.w, rh, tx, tw, body) : chosen(
							f,
							R.x + (C.rows === "soft" ? 4 * u : 0),
							y + (C.rows === "soft" ? u : 0),
							R.w - (C.rows === "soft" ? 8 * u : 0),
							rh - (C.rows === "soft" ? 2 * u : 0),
							tx,
							tw,
							body,
						)
					}
					zone({
						x: R.x,
						y: Math.max(y, body.y),
						w: R.w,
						h: Math.min(y + rh, body.y + body.h) - Math.max(y, body.y),
						act: "item",
						k: it.key,
						role: "row",
						label: `${it.name}, ${text.kind}, ${text.size}${on ? ", picked" : ""}`,
					})
					// the twisty: a folder's, turned down when it is open; it takes its own clicks
					if (folder(it)) {
						const tcx = nx + 7 * u, tcy = y + Math.floor(rh / 2), k = 3 * u
						blit.fillpoly(
							f,
							open_
								? [tcx - k, tcy - k / 2, tcx + k, tcy - k / 2, tcx, tcy + k]
								: [tcx - k / 2, tcy - k, tcx + k, tcy, tcx - k / 2, tcy + k],
							"nonzero",
							C.dim,
							body,
						)
						zone({
							x: nx,
							y,
							w: 14 * u,
							h: rh,
							act: "twist",
							k: it.key,
							role: "button",
							label: `${open_ ? "close" : "open"} ${it.name}`,
						})
					}
					small(f, it, nx + 16 * u, y + Math.floor((rh - SM) / 2), body)
					const end = blit.text(
						f,
						tx,
						mid(y, rh, FX),
						fitted(it.name, tw, FX),
						ink,
						undefined,
						body,
						FX,
					)
					if (waiting(it)) {
						glass(f, end + 5 * u, y + Math.floor(rh / 2) - 4 * u, body)
					}
					for (const [n, t] of Object.entries(text)) {
						if (!xs[n]) {
							continue
						}
						const [x, w] = xs[n]
						blit.text(f, x, mid(y, rh, F), fitted(t, w, F), C.ink2, undefined, body, F)
					}
				},
			)
		})
		// the head, over the rows; the stripes under them
		seg(`head ${JSON.stringify([R, cols.map(([n]) => n)])}`, (f) => {
			blit.fill(f, R.x, R.y, R.w, hh, C.paper)
			blit.fill(f, R.x, R.y + hh - u, R.w, u, C.hair)
			blit.text(f, R.x + pad, mid(R.y, hh, F), "name", C.dim, undefined, R, F)
			for (const [n] of cols) blit.text(f, xs[n][0], mid(R.y, hh, F), n, C.dim, undefined, R, F)
		})
	}

	// columns: one for each folder from the root down to the one picked, the last few that fit; walked by clicking
	const COLW = 216 * u
	const drawColumns = (R) => {
		const trail = s.picked !== null ? items.get(s.picked)?.path ?? s.here : s.here
		const folders = [[]]
		for (let i = 1; i <= trail.length; i++) {
			if (folder(items.get(key(trail.slice(0, i))))) folders.push(trail.slice(0, i))
		}
		const fit = Math.max(1, Math.floor(R.w / COLW))
		s.colx = Math.max(0, Math.min(s.colx, Math.max(0, folders.length - fit)))
		const first = Math.max(0, folders.length - fit - s.colx), rh = RH()
		ground(R, "blank", "columns", null)
		folders.slice(first, first + fit).forEach((path, ci) => {
			const depth = first + ci, x = R.x + ci * COLW, clip = { x, y: R.y, w: COLW - u, h: R.h }
			const list = kids(items.get(key(path)))
			seg(`col ${JSON.stringify([x, R, path, list.length > 0])}`, (f) => {
				blit.fill(f, x + COLW - u, R.y, u, R.h, C.hair)
				zone({
					x,
					y: R.y,
					w: COLW,
					h: R.h,
					act: "col",
					path,
					role: "list",
					label: "/" + key(path),
				})
				if (!list.length) {
					blit.text(f, x + 16 * u, R.y + 14 * u, "empty", C.dim, undefined, clip, F)
				}
			})
			if (!list.length) return
			// the cell on the trail kept in sight
			const at = list.findIndex((it) =>
				it.name === trail[depth] && key(trail.slice(0, depth)) === key(path)
			)
			let top = s.cols[key(path)] ?? 0
			const shown = Math.floor((R.h - 12 * u) / rh)
			if (at >= 0 && s.colsFollow) top = Math.max(Math.min(top, at), at - shown + 1)
			top = Math.max(0, Math.min(top, Math.max(0, list.length - shown)))
			s.cols[key(path)] = top
			list.slice(top, top + shown + 1).forEach((it, i) => {
				const y = R.y + 6 * u + i * rh,
					onTrail = trail[depth] === it.name && key(trail.slice(0, depth)) === key(path)
				const last = onTrail && it.key === s.picked
				seg(
					`cell ${
						JSON.stringify([
							x,
							y,
							it.key,
							it.sig,
							onTrail,
							last,
							stage(it.key),
							waiting(it) ? tick() : 0,
							look_(it),
							folder(it),
						])
					}`,
					(f) => {
						const cx = x + 6 * u, cw = COLW - 13 * u
						const tx = cx + 10 * u + SM + 8 * u,
							tw = Math.min(blit.measure(it.name, FX), cw - (tx - cx) - 22 * u)
						let ink = C.ink
						if (last) ink = chosen(f, cx, y, cw, rh, tx, tw, clip)
						else if (onTrail) {
							round(
								f,
								cx,
								y,
								cw,
								rh,
								C.buttons === "soft" ? 7 * u : 0,
								mixed(C.ink, C.paper, 0.07),
								clip,
							)
						} else {
							const bg = glow(it.key, C.paper)
							if (bg !== C.paper) {
								round(f, cx, y, cw, rh, C.buttons === "soft" ? 7 * u : 0, bg, clip)
							}
						}
						small(f, it, cx + 10 * u, y + Math.floor((rh - SM) / 2), clip)
						const end = blit.text(
							f,
							tx,
							mid(y, rh, FX),
							fitted(it.name, tw, FX),
							ink,
							undefined,
							clip,
							FX,
						)
						if (waiting(it)) {
							glass(f, end + 5 * u, y + Math.floor(rh / 2) - 4 * u, clip)
						}
						if (folder(it)) {
							blit.text(
								f,
								cx + cw - 8 * u - blit.measure("›", F),
								mid(y, rh, F),
								"›",
								last && C.rows === "invert" ? ink : C.dim,
								undefined,
								clip,
								F,
							)
						}
						zone({
							x: cx,
							y,
							w: cw,
							h: rh,
							act: "item",
							k: it.key,
							role: "button",
							label: `${it.name}, ${kind(it)}${last ? ", picked" : ""}`,
						})
					},
				)
			})
		})
		s.colsFollow = false
	}

	// the map: the whole graph as a tree, the root on the left, a node's children to its right, each a box with its
	// icon and name, a soft curve from each to each child; scrolled both ways
	const MROW = 40 * u, MCOL = 200 * u, MPAD = 22 * u, MW = 160 * u, MH = 30 * u
	let laid = null, shape = 0
	const layout = () => {
		if (laid) return laid
		const at = new Map()
		let rows = 0, deep = 0
		const lay = (it, depth) => {
			deep = Math.max(deep, depth)
			const ks = kids(it)
			if (!ks.length) {
				return void at.set(it.key, { x: MPAD + depth * MCOL, y: MPAD + rows++ * MROW })
			}
			for (const c of ks) lay(c, depth + 1)
			at.set(it.key, {
				x: MPAD + depth * MCOL,
				y: (at.get(ks[0].key).y + at.get(ks.at(-1).key).y) / 2,
			})
		}
		const top = items.get("")
		if (top) lay(top, 0)
		laid = {
			at,
			w: MPAD * 2 + deep * MCOL + MW,
			h: MPAD * 2 + Math.max(0, rows * MROW - (MROW - MH)),
		}
		return laid
	}
	// a curve from a to b, a little off true, the same each time for the same pair (catclock's), as points
	const curve = (k, ax, ay, bx, by) => {
		const off = ((fnv(k) / 4294967296) - 0.5) * 8 * u, mx = (ax + bx) / 2
		const c1x = mx + off, c1y = ay, c2x = mx - off, c2y = by + off / 2, out = []
		for (let i = 0; i <= 12; i++) {
			const t = i / 12, r = 1 - t
			out.push(
				r * r * r * ax + 3 * r * r * t * c1x + 3 * r * t * t * c2x + t * t * t * bx,
				r * r * r * ay + 3 * r * r * t * c1y + 3 * r * t * t * c2y + t * t * t * by,
			)
		}
		return out
	}
	const drawMap = (R) => {
		const L = layout(), clip = R
		ground(R, "blank", "the map", null)
		// first shown with the one picked (or the root) in the middle
		if (!s.map) {
			const p = L.at.get(s.picked ?? key(s.here)) ?? L.at.get("") ?? { x: 0, y: 0 }
			s.map = { x: p.x + MW / 2 - R.w / 2, y: p.y + MH / 2 - R.h / 2 }
		}
		s.map.x = Math.max(0, Math.min(s.map.x, Math.max(0, L.w - R.w)))
		s.map.y = Math.max(0, Math.min(s.map.y, Math.max(0, L.h - R.h)))
		const ox = R.x - s.map.x, oy = R.y - s.map.y
		const seen_ = (x, y, w, h) => x + w >= R.x && x <= R.x + R.w && y + h >= R.y && y <= R.y + R.h
		// the ties, as the tree is shaped and where it is scrolled
		seg(`ties ${JSON.stringify([shape, R, s.map.x, s.map.y])}`, (f) => {
			const tie = mixed(C.ink, C.paper, 0.35)
			for (const [k, p] of L.at) {
				const it = items.get(k)
				for (const c of kids(it)) {
					const q = L.at.get(c.key)
					if (!q) continue
					const ax = ox + p.x + MW,
						ay = oy + p.y + MH / 2,
						bx = ox + q.x,
						by = oy + q.y + MH / 2
					if (
						!seen_(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
					) continue
					blit.poly(f, curve(c.key, ax, ay, bx, by), u, tie, clip)
				}
			}
		})
		for (const [k, p] of L.at) {
			const x = ox + p.x, y = oy + p.y
			if (!seen_(x, y, MW, MH)) continue
			const it = items.get(k), on = s.picked === k
			seg(
				`box ${
					JSON.stringify([
						x,
						y,
						R,
						k,
						it.sig,
						on,
						stage(k),
						waiting(it) ? tick() : 0,
						look_(it),
					])
				}`,
				(f) => {
					const fill = on
						? C.select
						: glow(k, waiting(it) ? mixed(C.lemon, 0xffffff, 0.45) : 0xffffff)
					if (C.buttons === "soft") {
						round(f, x - u, y - u, MW + 2 * u, MH + 2 * u, 8 * u, on ? C.line : C.hair, clip)
						round(f, x, y, MW, MH, 7 * u, fill, clip)
					} else if (C.buttons === "raised") {
						blit.fill(
							f,
							x,
							y,
							MW,
							MH,
							on && C.rows === "invert" ? C.pick : fill === 0xffffff ? C.hi : fill,
							clip,
						)
						if (!on) raised(f, x, y, MW, MH, true)
					} else {
						blit.fill(f, x, y, MW, MH, C.line, clip)
						blit.fill(
							f,
							x + u,
							y + u,
							MW - 2 * u,
							MH - 2 * u,
							fill === 0xffffff ? C.hi : fill,
							clip,
						)
					}
					small(f, it, x + 9 * u, y + Math.floor((MH - SM) / 2), clip)
					const tw = MW - SM - 26 * u - (waiting(it) ? 12 * u : 0)
					const end = blit.text(
						f,
						x + SM + 16 * u,
						mid(y, MH, FX),
						fitted(k === "" ? "graph" : it.name, tw, FX),
						on && C.rows === "invert" ? C.pickInk : C.ink,
						undefined,
						clip,
						FX,
					)
					if (waiting(it)) glass(f, end + 4 * u, y + Math.floor(MH / 2) - 4 * u, clip)
					zone({
						x,
						y,
						w: MW,
						h: MH,
						act: "item",
						k,
						role: "button",
						label: `${it.name}, ${kind(it)}${on ? ", picked" : ""}`,
					})
				},
			)
		}
	}

	// the one picked (or the folder shown): what it is, its last change, its attributes, its value; or a process's.
	// One segment, its key what it shows; its attributes read (by id, never tracked) only as it is drawn
	const drawInfo = (g, R, picked) => {
		const run = s.run !== null ? items.get(s.run) : null
		const it = run ?? picked ?? items.get(key(s.here))
		const inside = run
			? [...items.values()].filter((c) =>
				c.computed && c.key !== run.key && under(c.path, run.path)
			)
			: []
		const k = JSON.stringify([
			R,
			it?.key ?? null,
			it?.sig ?? null,
			!!run,
			it ? stage(it.key) : -1,
			it && waiting(it) ? [tick(), secsSince(it.key)] : 0,
			s.info,
			s.view,
			key(s.here),
			it?.change ? [whoOf(it), ago(it.change.time), site(it.change)] : null,
			it ? [kind(it), size(it), look_(it)] : null,
			inside.map((c) => [c.key, c.sig, stage(c.key), waiting(c) ? tick() : 0]),
		])
		seg(`info ${k}`, (f) => {
			blit.fill(f, R.x, R.y, R.w, R.h, tint())
			blit.fill(f, R.x, R.y, u, R.h, C.hair)
			const clip = { x: R.x + u, y: R.y, w: R.w - u, h: R.h }
			zone({ x: R.x, y: R.y, w: R.w, h: R.h, act: "pane", pane: "info" })
			if (!it) return
			const x = R.x + 16 * u, w = R.w - 32 * u, lh = blit.height(F), fh = blit.height(FX)
			const blocks = []
			const push = (h, fn) => blocks.push({ h, fn })
			// the hero: its icon, big, lit up when it changed; its name; what it is and how much
			const n = I.size() * u
			push(n + 20 * u + blit.height(FT) + lh + 8 * u, (y) => {
				const bg = glow(it.key, tint())
				if (bg !== tint()) {
					round(
						f,
						x - 6 * u,
						y,
						w + 12 * u,
						n + 20 * u + blit.height(FT) + lh,
						C.buttons === "soft" ? 10 * u : 0,
						bg,
						clip,
					)
				}
				big(f, it, R.x + Math.floor((R.w - n) / 2), y + 8 * u)
				if (waiting(it)) glass(f, R.x + Math.floor((R.w + n) / 2) - 4 * u, y + 6 * u, clip)
				const title = it.key === "" ? "the root" : run ? label(it) : it.name
				const t = fitted(title, w, FT)
				blit.text(
					f,
					R.x + Math.floor((R.w - blit.measure(t, FT)) / 2),
					y + n + 14 * u,
					t,
					C.ink,
					undefined,
					clip,
					FT,
				)
				const what = fitted(
					run
						? `${it.process ? "a process" : "a computed node"} · ${it.status ?? "running"}`
						: `${kind(it)} · ${size(it)}`,
					w,
					F,
				)
				blit.text(
					f,
					R.x + Math.floor((R.w - blit.measure(what, F)) / 2),
					y + n + 14 * u + blit.height(FT) + 2 * u,
					what,
					C.ink2,
					undefined,
					clip,
					F,
				)
			})
			// pending: since when this window saw it so
			if (waiting(it)) {
				const text = `pending ${secsSince(it.key)}: waiting on a promise`
				push(lh + 16 * u, (y) => {
					if (C.buttons === "soft") round(f, x, y, w, lh + 10 * u, 8 * u, C.line, clip)
					else blit.fill(f, x, y, w, lh + 10 * u, C.line, clip)
					if (C.buttons === "soft") {
						round(
							f,
							x + u,
							y + u,
							w - 2 * u,
							lh + 8 * u,
							7 * u,
							mixed(C.lemon, 0xffffff, 0.5),
							clip,
						)
					} else {blit.fill(
							f,
							x + u,
							y + u,
							w - 2 * u,
							lh + 8 * u,
							mixed(C.lemon, 0xffffff, 0.5),
							clip,
						)}
					glass(f, x + 8 * u, y + 5 * u + Math.floor((lh - 8 * u) / 2), clip)
					blit.text(
						f,
						x + 22 * u,
						y + 5 * u,
						fitted(text, w - 30 * u, F),
						C.ink,
						undefined,
						clip,
						F,
					)
				})
			}
			// a process's or a computed node's word, as catclock's for a computation
			if (run) {
				const said_ = it.status === "pending"
					? "Waiting on a promise. What it makes stays as it was until it settles."
					: it.status === "failed"
					? `Its latest run threw: ${it.error}`
					: it.process
					? "A program running: its setup ran once, and its value is what that gave. Its parts run again when what they read changes."
					: "Runs again when what it read changes, and sets its node's value."
				for (const l of lines(said_, w, F)) {
					push(lh + 2 * u, (y) => blit.text(f, x, y, l, C.ink2, undefined, clip, F))
				}
				push(8 * u, () => {})
			}
			// its facts, a label and a value each, the label at the right of its column
			const rows = [["where", "/" + it.key]]
			if (it.id) rows.push(["id", it.id.startsWith("ermine://") ? it.id.slice(9, 17) : it.id])
			if (it.members > 1) rows.push(["members", `${it.members}, the first shown`])
			if (it.id && it.key !== "") rows.push(["keeps", it.ephemeral ? "ephemeral" : "a document"])
			if (it.change) {
				rows.push(["changed", `${clock(it.change.time)} · ${ago(it.change.time)}`])
				rows.push(["by", who(it.change)])
				const at = site(it.change)
				if (at) rows.push(["in the code", at])
				if (it.change.cause !== undefined && it.change.cause !== null) {
					rows.push(["cause", short(it.change.cause)])
				}
			}
			if (it.status === "failed") rows.push(["threw", it.error])
			if (it.again) rows.push(["a link", "back up to a node above it: not walked twice"])
			if (it.quiet) {
				rows.push([
					"not read",
					own(it.path) ? "this window's own" : "it changes as windows draw",
				])
			}
			// its attributes, by id (never tracked: read as it draws)
			if (it.id && !it.quiet) {
				try {
					const node = g.api.node(it.id)
					for (const [k, vs] of Object.entries(node?.info ?? {})) {
						const v = Array.isArray(vs)
							? vs.find((x) => x && !isStatus(x))?.content
							: undefined
						if (k !== "ermine.computer.status") {
							rows.push([k, typeof v === "string" ? v : short(v)])
						}
					}
				} catch {
					// refused: none shown
				}
			}
			const lw = Math.min(88 * u, Math.floor(w * 0.36))
			for (const [k, v] of rows) {
				const ls = lines(String(v ?? "—"), w - lw - 10 * u, FX, 4)
				push(Math.max(lh, ls.length * fh) + 5 * u, (y) => {
					blit.text(
						f,
						x + lw - blit.measure(fitted(k, lw, F), F),
						y,
						fitted(k, lw, F),
						C.dim,
						undefined,
						clip,
						F,
					)
					ls.forEach((l, i) =>
						blit.text(
							f,
							x + lw + 10 * u,
							y + i * fh + Math.floor((lh - fh) / 2),
							l,
							k === "threw" ? C.cherry : C.ink,
							undefined,
							clip,
							FX,
						)
					)
				})
			}
			push(8 * u, () => {})
			// a process's own computed nodes, each a way to it
			if (run) {
				const parts_ = [...items.values()].filter((c) =>
					c.computed && c.key !== it.key && under(c.path, it.path)
				)
				push(
					lh + 8 * u,
					(y) =>
						blit.text(
							f,
							x,
							y,
							`its parts: ${parts_.length} computed ${
								parts_.length === 1 ? "node" : "nodes"
							}`,
							C.dim,
							undefined,
							clip,
							F,
						),
				)
				const rh = RH()
				for (const c of parts_.slice(0, 60)) {
					push(rh, (y) => {
						const bg = glow(c.key, tint())
						if (bg !== tint()) {
							round(
								f,
								x - 4 * u,
								y,
								w + 8 * u,
								rh,
								C.buttons === "soft" ? 7 * u : 0,
								bg,
								clip,
							)
						}
						small(f, c, x, y + Math.floor((rh - SM) / 2), clip)
						const end = blit.text(
							f,
							x + SM + 8 * u,
							mid(y, rh, FX),
							fitted("/" + c.path.slice(it.path.length).join("/"), w - SM - 30 * u, FX),
							C.ink,
							undefined,
							clip,
							FX,
						)
						if (waiting(c)) glass(f, end + 4 * u, y + Math.floor(rh / 2) - 4 * u, clip)
						zone({
							x: x - 4 * u,
							y,
							w: w + 8 * u,
							h: rh,
							act: "reveal",
							k: c.key,
							role: "button",
							label: c.name,
						})
					})
				}
			} else if (it.key !== "") {
				// its value, a few lines of it (catclock's peek): a picture drawn, bytes in hex, text, JSON
				let v = it.value
				if (it.quiet) {
					try {
						v = isPicture(v)
							? v
							: (g.api.content(["/", ...it.path]).find((i) => i.versions)?.versions?.find((
								x,
							) => !isStatus(x)))?.content
					} catch {
						v = undefined
					}
				}
				if (isPicture(v)) {
					const ph = Math.min(140 * u, w)
					push(ph + 12 * u, (y) => {
						round(f, x, y, w, ph, C.buttons === "soft" ? 8 * u : 0, C.hair, clip)
						round(
							f,
							x + u,
							y + u,
							w - 2 * u,
							ph - 2 * u,
							C.buttons === "soft" ? 7 * u : 0,
							C.desk,
							clip,
						)
						I.framed(f, v, x + 8 * u, y + 8 * u, w - 16 * u, ph - 16 * u)
					})
				} else if (v === undefined || v === null) {
					push(
						lh + 12 * u,
						(y) =>
							blit.text(
								f,
								x,
								y,
								folder(it) ? "no value: only names under it" : "no value",
								C.dim,
								undefined,
								clip,
								F,
							),
					)
				} else {
					const text = peek(v), pw = w - 20 * u
					const ls = text.split("\n").map((l) => fitted(l, pw, FX))
					const ph = ls.length * fh + 16 * u
					push(ph + 12 * u, (y) => {
						const soft = C.buttons === "soft"
						round(f, x, y, w, ph, soft ? 8 * u : 0, C.hair, clip)
						round(f, x + u, y + u, w - 2 * u, ph - 2 * u, soft ? 7 * u : 0, 0xffffff, clip)
						ls.forEach((l, i) =>
							blit.text(f, x + 10 * u, y + 8 * u + i * fh, l, C.ink, undefined, clip, FX)
						)
					})
				}
			}
			// what can be done: opened in the editor (a picture in Paint), gone into
			const edit = !run && it.key !== "" && !it.quiet && it.value !== null &&
				it.value !== undefined
			const enter = !run && (folder(it) || hollow(it)) && key(s.here) !== it.key &&
				s.view !== "map"
			const bh = blit.height(FT) + 12 * u
			if (edit || enter || run) {
				push(bh + 8 * u, (y) => {
					let bx = x
					if (edit) {
						bx = button(
							f,
							bx,
							y + 2 * u,
							isPicture(it.value) ? "Paint" : "Open in Editor",
							"open",
							true,
							true,
						) + 8 * u
					}
					if (enter) bx = button(f, bx, y + 2 * u, "Go In", "enter") + 8 * u
					if (run) button(f, bx, y + 2 * u, "Show Its Node", "show")
				})
			}
			const total = blocks.reduce((m, b) => m + b.h, 0) + 36 * u
			s.info = scrolled(s.info, total, R.h)
			let y = R.y + 18 * u - s.info
			for (const b of blocks) {
				if (y + b.h > R.y && y < R.y + R.h) b.fn(y)
				y += b.h
			}
			// what is drawn above the pane's top and below its foot is the bar's and the status's, drawn over it
		})
	}
	// text in lines of w, broken at spaces where it can be, at most most of them
	const lines = (text, w, fnt, most = 12) => {
		const out = []
		let rest = text
		while (rest.length && out.length < most) {
			let n = Math.max(1, blit.fit(rest, w, fnt))
			if (n < rest.length) {
				const sp = rest.lastIndexOf(" ", n)
				if (sp > n / 2) n = sp + 1
			}
			out.push(rest.slice(0, n).trimEnd())
			rest = rest.slice(n)
		}
		if (rest.length && out.length) out[out.length - 1] = fitted(out.at(-1) + "…", w, fnt)
		return out
	}
	// a value cut down, to say in a line or show in a few: long lists and maps cut, bytes counted
	const cut = (v, depth = 0) => {
		if (ArrayBuffer.isView(v)) {
			return `<${v.constructor.name.replace("Array", "").toLowerCase()} ${v.length}>`
		}
		if (typeof v === "function") return "<handler>"
		if (v?.constructor?.name === "Stand") return `<live ${v.kind ?? ""}>`
		if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v
		if (Array.isArray(v)) {
			return depth > 4 ? `[${v.length}]` : [
				...v.slice(0, 24).map((x) => cut(x, depth + 1)),
				...(v.length > 24 ? [`… ${v.length - 24} more`] : []),
			]
		}
		if (v && typeof v === "object") {
			if (depth > 4) return "{…}"
			const ks = Object.keys(v)
			const o = Object.fromEntries(ks.slice(0, 40).map((k) => [k, cut(v[k], depth + 1)]))
			if (ks.length > 40) o["…"] = `${ks.length - 40} more`
			return o
		}
		return v
	}
	const short = (v) => {
		try {
			return (JSON.stringify(cut(v)) ?? String(v)).slice(0, 240)
		} catch {
			return String(v)
		}
	}
	const peek = (v) => {
		let text
		if (ArrayBuffer.isView(v)) {
			const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength), rows = []
			for (let i = 0; i < Math.min(b.length, 96); i += 8) {
				rows.push(
					i.toString(16).padStart(4, "0") + "  " +
						[...b.subarray(i, i + 8)].map((x) => x.toString(16).padStart(2, "0")).join(" "),
				)
			}
			return rows.join("\n") + (b.length > 96 ? "\n…" : "")
		}
		if (typeof v === "string") text = v
		else {
			try {
				text = JSON.stringify(cut(v), null, 2) ?? String(v)
			} catch {
				text = String(v)
			}
		}
		const ls = text.split("\n")
		return ls.slice(0, 16).join("\n") + (ls.length > 16 ? "\n…" : "")
	}

	// the status: how many nodes, how many here, what is pending, the last change; a segment, its key what it says
	const drawStatus = () => {
		const at = items.get(key(s.here))
		const pend = [...since.keys()].map((k) => items.get(k)).filter((it) => it).slice(0, 3).map((
			it,
		) => [label(it), secsSince(it.key)])
		const last = once("last", () => {
			let best = null
			for (const it of items.values()) {
				if (!it.change || it.quiet) continue
				if (
					!best || (seen.get(it.key) ?? 0) - (seen.get(best.key) ?? 0) > 0 ||
					((seen.get(it.key) ?? 0) === (seen.get(best.key) ?? 0) &&
						(secs(it.change.time) ?? 0) > (secs(best.change.time) ?? 0))
				) best = it
			}
			return best
		})
		const lastly = last ? [last.name, ago(last.change.time), whoOf(last)] : null
		seg(
			`status ${
				JSON.stringify([
					said,
					items.size,
					at?.names.length ?? 0,
					pend,
					pend.length ? tick() : 0,
					lastly,
				])
			}`,
			(f) => {
				const fh = FOOT(), y = H - fh, soft = C.buttons === "soft"
				blit.fill(f, 0, y, W, fh, soft ? mixed(0xffffff, C.paper, 0.45) : C.chrome)
				blit.fill(f, 0, y, W, u, C.hair)
				const ty = mid(y, fh, F), clip = { x: 0, y, w: W, h: fh }
				let x = 16 * u
				const say = (
					text,
					ink = C.ink2,
					fnt = F,
				) => (x = blit.text(
					f,
					x,
					fnt === F ? ty : mid(y, fh, fnt),
					text,
					ink,
					undefined,
					clip,
					fnt,
				))
				const dot = () => say("  ·  ", C.dim)
				if (said) return void say(said[0], said[1])
				say(`${items.size} nodes in the graph`)
				dot()
				say(`${at?.names.length ?? 0} here`)
				for (const [name, since_] of pend) {
					dot()
					glass(f, x, ty + Math.floor((blit.height(F) - 8 * u) / 2), clip)
					x += 12 * u
					say(name, C.ink, FX)
					say(` pending, ${since_}`, mixed(C.ink, C.lemon, 0.6))
				}
				if (lastly) {
					const text = [["last change: ", C.ink2, F], [lastly[0], C.ink, FX], [
						`, ${lastly[1]}, by ${lastly[2]}`,
						C.ink2,
						F,
					]]
					const tw = text.reduce((m, [t, , fnt]) => m + blit.measure(t, fnt), 0)
					x = Math.max(x + 24 * u, W - 16 * u - tw)
					for (const [t, ink, fnt] of text) say(t, ink, fnt)
				}
			},
		)
	}

	// ---- painting: what changed of the draw list written: at once for a key or a click, else (the graph changed, a
	// blink's next step, a wait's tick, the times it says, "12 s ago", when they would change, every so often at most)
	// GAP ms after the last at least.
	// A paint owed is a timer (a handler node, made and let go): one owed within slack ms of when another is wanted
	// is that one, not cancelled and made again
	const GAP = 250
	let owed = null, owedAt = 0, last = 0
	const later = (g, ms, slack = 0) => {
		const at = Date.now() + ms
		// one owed and not come long after it was due is lost (its process busy, or gone): asked for again
		if (owed && owedAt < Date.now() - 1000) owed = null
		if (owed && owedAt <= at + slack) return
		if (owed) owed(g.api)
		owedAt = at
		owed = after(g, Math.max(0, ms), (g2) => {
			owed = null
			paint(g2)
		})
	}
	let menued = null
	// what the layer holds, as this last wrote it: its segments (segs, above), and its size, title and access
	let held = null
	const paint = (g, gap = GAP) => {
		const { api } = g
		if (!idAt(api, LAYER) || !ready()) return
		const wait = gap - (Date.now() - last)
		if (wait > 0) return later(g, wait)
		last = Date.now()
		// what the parts read since, taken in; the look, as it may have changed with it (the theme and the fonts are
		// nodes the parts read, so taken from what they read)
		if (dirty.size || !items.size) {
			model()
			const was = [F, FT, FX], at = (role) => items.get(`dev/font/${role}`)?.value
			;[F, FT, FX] = [
				face(at("text")) ?? was[0],
				face(at("title")) ?? was[1],
				face(at("fixed")) ?? was[2],
			]
			const theme = items.get("etc/theme")?.value
			if (theme && typeof theme === "object") colours(theme)
		}
		const was = segs
		const now = draw(g)
		const patches = []
		if (!held || whole_) patches.push(set("draw", now.flatMap((x) => x.ops)))
		else {
			// each run of segments drawn anew, between those kept as they were, a splice of the old ops it replaces: from
			// the last run back, so the ones before it are where they were
			const at = new Map(was.map((x, i) => [x, i])), off = [0]
			for (const x of was) off.push(off.at(-1) + x.ops.length)
			const runs = []
			let i = 0, j = 0
			while (i < was.length || j < now.length) {
				if (i < was.length && j < now.length && was[i] === now[j]) {
					i++, j++
					continue
				}
				let j2 = j
				while (j2 < now.length && !(at.has(now[j2]) && at.get(now[j2]) >= i)) j2++
				const i2 = j2 < now.length ? at.get(now[j2]) : was.length
				runs.push([i, i2, j, j2])
				i = i2, j = j2
			}
			for (const [i1, i2, j1, j2] of runs.reverse()) {
				patches.push({
					path: ["draw"],
					range: [off[i1], off[i2]],
					value: now.slice(j1, j2).flatMap((x) => x.ops),
				})
			}
		}
		const access = JSON.stringify([{
			role: "group",
			label: "Files",
			x: 0,
			y: 0,
			w: W,
			h: H,
			children: zones.filter((z) => z.role).map(({ x, y, w, h, role, label: l }) => ({
				role,
				label: l,
				x,
				y,
				w,
				h,
			})),
		}])
		const title = s.here.length ? `Files  /${key(s.here)}` : "Files"
		if (held?.w !== W) patches.push(set("w", W))
		if (held?.h !== H) patches.push(set("h", H))
		if (held?.title !== title) patches.push(set("title", title))
		if (held?.access !== access) patches.push(set("access", JSON.parse(access)))
		held = { w: W, h: H, title, access }
		if (patches.length) api.write(LAYER, patches)
		menus(api)
		// again at the blink's next step while something is lit or waits; else when the times it says would change, now
		// and then at most; none said, or all an hour old: not until something changes
		for (const [k, t] of lit) if (T - t >= BLINK) lit.delete(k)
		if (lit.size || since.size) later(g, STEP)
		else if (due < Infinity) later(g, Math.max(15000, due - T))
	}
	// its menus, in the menu bar while its window has the focus (/programs/wmii): an item with a key is that chord,
	// pressed (on/key, below); one with call calls on/menu
	const menus = (api) => {
		const it = s.picked !== null ? items.get(s.picked) : null
		const off = (no) => (no ? { off: true } : {})
		const value = [
			{
				title: "File",
				items: [
					{ label: "Open", key: "cmd-o", ...off(!it) },
					{
						label: isPicture(it?.value) ? "Open in Paint" : "Open in Editor",
						key: "cmd-e",
						...off(!it || it.quiet),
					},
					"-",
					{ label: "Close", key: "cmd-w" },
				],
			},
			{
				title: "View",
				items: VIEWS.map((v, i) => ({
					label: `as ${v[0].toUpperCase()}${v.slice(1)}`,
					key: `cmd-${i + 1}`,
				})),
			},
			{
				title: "Go",
				items: [
					{ label: "Back", key: "cmd-[", ...off(!s.past.length) },
					{ label: "Forward", key: "cmd-]", ...off(!s.ahead.length) },
					{
						label: "Enclosing Folder",
						key: "cmd-ArrowUp",
						...off(!s.here.length && s.picked === null),
					},
					"-",
					{ label: "The Root", call: "menu", args: ["root"] },
					{ label: "Home", call: "menu", args: ["home"] },
					{ label: "Applications", call: "menu", args: ["apps"] },
				],
			},
		]
		const text = JSON.stringify(value)
		if (text === menued) return
		menued = text
		snap(api, [...me, "menus"], value, { ephemeral: true })
	}

	// a part read: drawn after it, with whatever else was read by then (paint takes what the parts read in), when
	// GAP has gone since the last; a paint already owed by then is that one
	const soon = (g) => {
		later(g, Math.max(0, GAP - (Date.now() - last)), 250)
	}
	onCleanup(({ api }) => owed?.(api))

	// ---- doing
	// a second click on the same thing soon after is a double click
	let click = { k: null, t: 0 }
	const twice = (k) => {
		const now = Date.now(), again = click.k === k && now - click.t < 450
		click = again ? { k: null, t: 0 } : { k, t: now }
		return again
	}
	const hit = (x, y) =>
		[...zones].reverse().find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) ??
			null
	handler(given, "pointer", (g) => {
		const [recs] = g.args ?? []
		for (const r of recs ?? []) {
			if (r.event === "scroll") {
				const P = panes(),
					at = (R) => r.x >= R.x && r.x < R.x + R.w && r.y >= R.y && r.y < R.y + R.h
				const dy = Math.round(r.dy ?? 0), dx = Math.round(r.dx ?? 0)
				if (at(P.side)) s.side = Math.max(0, s.side + dy)
				else if (at(P.info)) s.info = Math.max(0, s.info + dy)
				else if (at(P.main)) {
					if (s.view === "map" && s.map) {
						s.map.x += dx
						s.map.y += dy
					} else if (s.view === "columns") {
						const z = [...zones].reverse().find((z) =>
							z.act === "col" && r.x >= z.x && r.x < z.x + z.w
						)
						if (z) {
							s.cols[key(z.path)] = Math.max(
								0,
								(s.cols[key(z.path)] ?? 0) +
									Math.sign(dy) * Math.max(1, Math.round(Math.abs(dy) / RH())),
							)
						}
						if (Math.abs(dx) > Math.abs(dy)) s.colx = Math.max(0, s.colx - Math.sign(dx))
					} else s.main[s.view] = Math.max(0, (s.main[s.view] ?? 0) + dy)
				}
				continue
			}
			if (r.event !== "down") continue
			said = null
			const z = hit(r.x, r.y)
			if (!z?.act) continue
			if (z.act === "back") back()
			else if (z.act === "forward") forward()
			else if (z.act === "view") view(g, z.v)
			else if (z.act === "go") {
				if (s.view === "columns" || s.view === "map") {
					s.here = z.path
					s.picked = z.path.length ? key(z.path) : null
					s.run = null
					s.map = null
					s.colsFollow = true
				} else go(z.path)
			} else if (z.act === "reveal") {
				reveal(z.k)
				s.colsFollow = true
			} else if (z.act === "run") {
				s.run = z.k
				s.info = 0
			} else if (z.act === "twist") s.open.has(z.k) ? s.open.delete(z.k) : s.open.add(z.k)
			else if (z.act === "item") {
				const it = items.get(z.k)
				if (twice(z.k)) activate(g, it)
				else pick(z.k)
				s.info = 0
			} else if (z.act === "open") open(g, items.get(s.picked ?? key(s.here)))
			else if (z.act === "enter") activate(g, items.get(s.picked ?? key(s.here)))
			else if (z.act === "show") {
				const k = s.run
				s.run = null
				reveal(k)
			} else if (z.act === "blank" && (s.view === "icons" || s.view === "list")) {
				s.picked = null
				s.run = null
			}
		}
		paint(g, 0)
	})

	// the keys: arrows among what is shown, Enter in, Backspace up, cmd-[ and cmd-] back and forward, cmd-1 to cmd-4
	// the views, e the editor
	const order = () => {
		if (s.view === "list") return rowsOf().map((r) => r.it)
		if (s.view === "icons") return kids(items.get(key(s.here)))
		if (s.view === "columns") {
			const it = s.picked !== null ? items.get(s.picked) : null
			return kids(items.get(key(it ? parent(it.path) : [])))
		}
		return [...layout().at.keys()].map((k) => items.get(k)).filter((x) => x)
	}
	const step = (by) => {
		const list = order()
		if (!list.length) return
		const i = list.findIndex((it) => it.key === s.picked)
		const to = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + by))]
		pick(to.key)
		s.colsFollow = true
		// kept in sight
		if (s.view === "list") {
			const rh = RH(), y = list.indexOf(to) * rh, room = panes().main.h - blit.height(F) - 12 * u
			if (y < s.main.list) s.main.list = y
			if (y + rh > s.main.list + room) s.main.list = y + rh - room
		}
	}
	handler(given, "key", (g) => {
		const [recs] = g.args ?? []
		for (const r of recs ?? []) {
			if (!r.down) continue
			said = null
			const cmd = r.mods?.includes("cmd"), k = r.key
			const it = s.picked !== null ? items.get(s.picked) : null
			if (cmd && (k === "[" || k === "bracketleft")) back()
			else if (cmd && (k === "]" || k === "bracketright")) forward()
			else if (cmd && /^[1-4]$/.test(k)) view(g, VIEWS[Number(k) - 1])
			else if (cmd && k === "ArrowUp") up()
			else if (cmd && (k === "o" || k === "ArrowDown")) activate(g, it)
			else if (cmd && k === "e") open(g, it)
			else if (cmd) continue
			else if (k === "ArrowDown") step(s.view === "icons" ? perRow() : 1)
			else if (k === "ArrowUp") step(s.view === "icons" ? -perRow() : -1)
			else if (k === "ArrowRight") {
				if (s.view === "list" && folder(it) && !s.open.has(it.key)) s.open.add(it.key)
				else if (s.view === "columns" && folder(it)) {
					pick(kids(it)[0]?.key ?? it.key)
					s.colsFollow = true
				} else step(1)
			} else if (k === "ArrowLeft") {
				if (s.view === "list" && folder(it) && s.open.has(it.key)) s.open.delete(it.key)
				else if (
					(s.view === "list" || s.view === "columns") && it &&
					it.path.length > s.here.length + (s.view === "list" ? 1 : 0)
				) {
					pick(key(parent(it.path)))
					s.colsFollow = true
				} else step(-1)
			} else if (k === "Enter") activate(g, it)
			else if (k === "Backspace") up()
			else if (k === "e") open(g, it)
			else if (k === "Escape") {
				s.picked = null
				s.run = null
			}
		}
		paint(g, 0)
	})
	const perRow = () => Math.max(1, Math.floor((panes().main.w - 32 * u) / (112 * u)))
	// a menu's item with no key: the root, home, the Applications
	handler(given, "menu", (g) => {
		const [what] = g.args ?? []
		const to = { root: [], home: ["home"], apps: ["Applications"] }[what]
		if (to) {
			if (s.view === "columns" || s.view === "map") {
				s.here = to
				s.picked = to.length ? key(to) : null
				s.map = null
				s.colsFollow = true
			} else go(to)
		}
		paint(g, 0)
	})

	// the window: a layer, as each program's; started with a path ({path}, or a shell's words, {args: ["dev/wm"]}),
	// it goes there once the data comes (it is put in after the setup runs)
	if (!idAt(api, LAYER)) {
		const n = api.children(LAYERS).length
		make(api, LAYERS, LAYER.at(-1), {
			x: (40 + (n % 5) * 30) * u,
			y: (50 + (n % 5) * 24) * u,
			w: W,
			h: H,
			z: n,
			title: "Files",
			owner: me,
			draw: [],
		}, { ephemeral: true })
	}
	let started = false
	effect(given, "start", ({ api }) => val(api, [...me, "data"]) ?? null, (g) => {
		const d = g.value
		if (started || !d) return
		started = true
		const path = Array.isArray(d.path)
			? d.path
			: typeof d.args?.[0] === "string"
			? d.args[0].split("/").filter((n) => n)
			: null
		if (!path) return
		if (s.view === "columns" || s.view === "map") s.picked = key(path)
		else s.here = path
		s.colsFollow = true
		paint(g, 0)
	})
	// the size the window manager gives: from /dev/display/windows, not its own layer, which changes each time it draws
	effect(given, "size", ({ api }) => {
		const want = val(api, ["/", "dev", "display", "windows", LAYER.at(-1)])?.want
		return want ? `${want.w}x${want.h}` : null
	}, (g) => {
		if (!g.value) return
		const [w, h] = g.value.split("x").map(Number)
		W = Math.max(420 * u, w)
		H = Math.max(280 * u, h)
		laid = null
		paint(g, 0)
	})
}
