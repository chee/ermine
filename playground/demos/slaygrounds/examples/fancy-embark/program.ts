/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	hasNode,
	patch,
	peep,
	PENDING,
	place,
	read as readNode,
	readChildren,
	rename,
	unplace,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind, each, handler, under } from "ermine-h"

// fancy-embark: a trip plan as a dynamic document, after Ink & Switch's Embark essay. you write an
// outline; @ mentions a place or a date; a line "name: =Formula(…)" computes (routes, weather,
// totals); views (a map, a calendar, a table) show any subtree. all of it is the graph:
//   /embark/doc            the document's root item. every item is a node, its text its value
//     …/items              a folder: each child item at its own id, and the folder's value their
//                          order (a name holds one id, and places keeps no order: the order is
//                          ours). drag, Tab, shift-Tab, alt-shift-↑↓ are places' move plus that list:
//                          each node keeps its id
//     …/mentions           a folder: each place or date the text mentions, its node mounted here
//                          under its label (the same node as in /embark/places)
//     …/result             a formula's result: a compute part reading the nodes it names. a slow
//                          lookup leaves it pending in place (its status node says so) until it lands
//     …/views              views of this item's subtree (a folder, ordered the same way); each
//                          view's data is a compute part under it
//   /embark/places/<name>  the other outline: a place node {name, query}, its own items (its
//                          properties), and geo: a compute part geocoding it through the cache
//   /embark/dates/<label>  a date node {iso}
//   /embark/index          one walk of everything: colours and icons resolved up the tree, who
//                          mentions which place, the formulas, the views
//   /embark/ui/…           focus, hover, the open menu, the card: nodes, so every view reads them
//   /cache/<api>/<hash>    every lookup's answer, by the hash of its url (the host's)
// 💡 explain shows what each element is bound to; hover a result to see what its last run read
// ids: a program names a node by its path, so an item's id is its own name (a random one: the
// name of its node in its parent's items folder, kept with its path in `known`, which a move
// updates), a place's is "place:<label>", a date's "date:<label>"; the places' own names are paths
// (id → path, idFor: path → id). a removal is an unplace. the map and the drags are heard on the
// outline's root (a plain listener has nothing open to call an action from); the timers (the menu's
// search settling, the editor's blur, the map's camera) are a memo returning a promise and an
// effect, or are written at once

// ---- the default trip (seeded once; a reload keeps what you changed) ----
// where a new place is looked for first: a box around the trip's base (Edinburgh)
const NEAR = "-3.50,56.10,-2.90,55.80"
const PLACES: Record<string, { query: string; pick?: string }> = {
	"Edinburgh": { query: "Edinburgh" },
	"Edinburgh Waverley": { query: "Edinburgh Waverley", pick: "node/7149998196" },
	"Edinburgh Castle": { query: "Edinburgh Castle" },
	"Victoria Street": { query: "Victoria Street, Edinburgh" },
	"Oink": { query: "Oink, Victoria Street, Edinburgh" },
	"Mother India's Cafe": { query: "Mother India's Cafe, Edinburgh" },
	"The Witchery": { query: "The Witchery by the Castle, Edinburgh" },
	"St Andrews": { query: "St Andrews, Fife" },
	"St Andrews Cathedral": { query: "St Andrews Cathedral, St Andrews" },
	"West Sands": { query: "West Sands, St Andrews" },
	"Stockbridge Market": { query: "Stockbridge Market, Edinburgh" },
	"Dean Village": { query: "Dean Village, Edinburgh" },
	"Arthur's Seat": { query: "Arthur's Seat" },
	"Calton Hill": { query: "Calton Hill, Edinburgh" },
	"Scottish National Gallery": { query: "Scottish National Gallery" },
}
type Seed = [text: string, kids?: Seed[], extra?: { open?: boolean; views?: View[] }]
type View = { kind: "map" | "calendar" | "table"; where: "inline" | "side"; camera?: Cam | null }
const DOC: Seed = ["A weekend in Edinburgh", [
	["base: @[Edinburgh]"],
	["Ideas, not placed yet", [
		["@[Arthur's Seat] at sunrise, if it is dry"],
		["@[Calton Hill] for the view at dusk"],
		["@[Scottish National Gallery] if it rains"],
	]],
	["@[Fri 16 Oct] in by train, the castle, curry", [
		["color: #ff2284"],
		["weather: =Weather(in: @[Edinburgh], on: @[Fri 16 Oct])"],
		["13:40 train in to @[Edinburgh Waverley]", [["cost: £38.20"]]],
		["15:00–17:00 @[Edinburgh Castle]", [
			["icon: 🏰"],
			["book ahead: last entry is an hour before closing"],
		]],
		["walk: =Walk(from: @[Edinburgh Castle], to: @[Victoria Street])"],
		["17:15 browse @[Victoria Street], a roll at @[Oink]"],
		["19:30 dinner at @[Mother India's Cafe]"],
	], { views: [{ kind: "map", where: "inline" }] }],
	["@[Sat 17 Oct] a day by the sea", [
		["color: #2269ff"],
		["weather: =Weather(in: @[Edinburgh], on: @[Sat 17 Oct])"],
		["09:00–19:00 day trip to @[St Andrews] in a hire car", [
			["route: =Drive(from: @[Edinburgh Waverley], to: @[St Andrews])"],
			["rate: £0.30"],
			["daily: £25"],
			["cost: =route.distance * 2 * rate + daily"],
		]],
		["10:30–12:00 @[St Andrews Cathedral]", [["icon: ⛪"]]],
		["13:00–15:00 a long walk on @[West Sands]"],
	]],
	["@[Sun 18 Oct] the market, then home", [
		["color: #14a888"],
		["10:00 @[Stockbridge Market]", [["hours: 10:00–17:00"]]],
		["@[Dean Village] along the Water of Leith", [
			["walk: =Walk(from: @[Stockbridge Market], to: @[Dean Village])"],
		]],
		["16:30 train home from @[Edinburgh Waverley]", [["cost: £38.20"]]],
	]],
	["Eat & drink", [
		["@[Mother India's Cafe]", [["price: ££"], ["booked: yes, 19:30"]]],
		["@[Oink]", [["price: £"], ["booked: no need"]]],
		["@[The Witchery]", [["price: £££"], ["booked: not yet"]]],
	], { views: [{ kind: "table", where: "inline" }] }],
	["Budget", [["total: =Total(cost)"]]],
], { views: [{ kind: "map", where: "side" }, { kind: "calendar", where: "side" }] }]

// ---- the functions a formula can call ----
type Fn = { args: string[]; icon: string; doc: string; name: string; lazy?: boolean }
const FNS: Record<string, Fn> = {
	Walk: { args: ["from", "to"], icon: "🚶", doc: "a walking route and its time", name: "walk" },
	Bike: { args: ["from", "to"], icon: "🚲", doc: "a cycling route and its time", name: "ride" },
	Drive: { args: ["from", "to"], icon: "🚗", doc: "a driving route and its time", name: "drive" },
	Weather: { args: ["in", "on"], icon: "⛅", doc: "the forecast for a day", name: "weather" },
	Sun: { args: ["in", "on"], icon: "🌅", doc: "sunrise, sunset, daylight", name: "daylight" },
	Distance: { args: ["from", "to"], icon: "📏", doc: "as the crow flies", name: "distance" },
	Total: {
		args: ["of"],
		icon: "Σ",
		doc: "every item with this name, added up",
		name: "total",
		lazy: true,
	},
}

// ---- small types ----
type Id = string
type E = { readonly id: string }
type H = { readonly id: string; readonly path?: string[] }
type Cam = { lat: number; lon: number; z: number }
type Geo = {
	lat: number
	lon: number
	name: string
	display: string
	type: string
	category: string
	hours?: string
	website?: string
	osm: string
}
type V =
	| { t: "num"; n: number; unit?: string; preview?: string }
	| { t: "text"; s: string; preview?: string }
	| { t: "place"; id: Id; name: string; preview?: string }
	| { t: "date"; id: Id; iso: string; label: string; preview?: string }
	| { t: "item"; id: Id; name: string; preview?: string }
	| { t: "rec"; kind: string; preview: string; fields: Record<string, V>; [k: string]: unknown }

// what the host's extend gives (host.ts says what each is for)
type Run = {
	name: string
	of: string
	run: number
	ended: string
	error?: string
	ms?: number
	values: string[][]
	keys: string[]
}
type Host = {
	ask: (api: string, url: string) => string
	retry: (api?: string) => void
	ended: (action: string) => () => void
}

// a value's bytes: its JSON. a memo's result is the same when its bytes are (early cutoff)
const bytes = (v: unknown) => {
	if (v === undefined) return "undefined"
	try {
		return JSON.stringify(v) ?? String(v)
	} catch {
		return String(v)
	}
}
const same = (a: unknown, b: unknown) => a === b || bytes(a) === bytes(b)

export default function program() {
	const { ask, retry, ended } = host<Host>()
	// what a node holds, as the program takes it (any: its values are its own). what an action reads
	// is for now: each runs inside peep
	// deno-lint-ignore no-explicit-any
	const read = (x: any, key?: readonly (string | number)[]): any => readNode(tg(x), key)
	const method = (name: string, f: (...a: any[]) => unknown) =>
		createAction(name, (...a: unknown[]) => peep(() => f(...a)))
	// the page's events are heard on elements round what is built by hand and call by name
	// (on/do: name, ...args)
	createAction("on/do", (name: string, ...args: unknown[]) => executeAction(`on/${name}`, ...args))
	const onStage = (f: (e: any) => unknown[] | undefined | void) => handler("on/do", f as never)
	if (!document.getElementById("embark-font")) {
		document.head.appendChild(Object.assign(document.createElement("link"), {
			id: "embark-font",
			rel: "stylesheet",
			href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600;700&display=swap",
		}))
	}

	// ---- the nodes ----
	// the trip is saved under ./trip (a reload finds it as it was): doc, places, dates, ui. what is
	// worked out is inside this process (gone at its stop, made again at the next start): index,
	// menu, suggest, lit, and a result, geo or data memo per formula, place or view
	// an id is a name for a path: an item's own name (its node is <parent>/items/<id>), a place's
	// "place:<label>", a date's "date:<label>", any other node its path joined. known is kept up as
	// the outline changes: forest() sets it for everything, insert for what it makes
	const known = new Map<Id, string[]>()
	const pathOf = (id: Id): string[] => {
		if (id.startsWith("place:")) return ["trip", "places", id.slice(6)]
		if (id.startsWith("date:")) return ["trip", "dates", id.slice(5)]
		const p = known.get(id)
		if (!p) throw new Error(`no path known for ${id}`)
		return p
	}
	// the id of the node at names
	function idFor(p: string[]): Id {
		const parent = p[p.length - 2], last = p[p.length - 1]
		if (parent === "items" || parent === "views") return (known.set(last, p), last)
		if (p[0] === "trip" && p.length === 3 && p[1] === "places") return `place:${last}`
		if (p[0] === "trip" && p.length === 3 && p[1] === "dates") return `date:${last}`
		if (parent === "mentions") {
			return peep(() => hasNode(["/", "trip", "places", last]))
				? `place:${last}`
				: `date:${last}`
		}
		const id = p.join("/")
		known.set(id, p)
		return id
	}
	// a node, as every function here takes it: by its path
	// deno-lint-ignore no-explicit-any
	const tg = (x: any): any =>
		typeof x === "object" && x !== null && !Array.isArray(x) && "id" in x ? abs(pathOf(x.id)) : x
	// the node for an id, as a target (a path from the root)
	const S = (id: Id): E => ({ id })
	// the same, for h: the path to bind
	const H = (id: Id): string => "/" + pathOf(id).join("/")
	const abs = (names: string[]) => ["/", ...names]
	// the node at names, made with value if there is none, as an id
	function mk(names: string[], value: unknown): E {
		ensureNode(abs(names), value)
		const id = idFor(names)
		known.set(id, names)
		return S(id)
	}
	const DOCP = ["trip", "doc"]
	const doc = mk(DOCP, { text: DOC[0] })
	const placesE = mk(["trip", "places"], "the other outline: a node per place")
	const datesE = mk(["trip", "dates"], "a node per date")
	const focusE = mk(["trip", "ui", "focus"], null)
	const hoverE = mk(["trip", "ui", "hover"], {})
	const menuE = mk(["trip", "ui", "menu"], null)
	const cardE = mk(["trip", "ui", "card"], null)
	const toastE = mk(["trip", "ui", "toast"], null)
	const threadsE = mk(["trip", "ui", "threads"], true)
	const helpE = mk(["trip", "ui", "help"], false)
	const flowE = mk(["trip", "flow"], {})
	// the search a menu waits on, settled: { id, q }; the editor that lost the caret: { id, n }
	const settledE = mk(["trip", "ui", "settled"], null)
	const blurE = mk(["trip", "ui", "blur"], null)
	// the memos' folders (inside this process), and the handlers'
	for (const name of ["result", "geo", "data", "map"]) ensureNode(name)
	// the memos, by name: the ones the views bind (the process is at /embark)
	const IX = "/embark/index"
	const memoAt = (kind: "result" | "geo" | "data", id: Id) => `/embark/${kind}/${id}`

	// ---- a lookup: the answer to a url is the node at /cache/<api>/<key> (the host's). not there
	// yet: the host is asked (it queues the request) and the run waits (PENDING, which read throws
	// for a node that is not there: the run had read the place, so it runs again when the answer
	// lands). a failure lands as a node too ----
	type Entry = { result?: unknown; error?: string; from?: string; at?: string; ms?: number }
	function peek(api: string, url: string):
		| { result: unknown; from?: string; at?: string; ms?: number }
		| { waiting: true }
		| { error: string; at?: string } {
		const key = ask(api, url)
		// a read of a node that is not there waits, and says so in the graph (a wait recorded): a peek
		// never waits, so it asks whether the node is there first (a tracked check)
		const at = `/cache/${api}/${key}`
		if (!hasNode(at)) return { waiting: true }
		const v: Entry | undefined = read(at)
		if (v?.error !== undefined) return { error: v.error, at: v.at }
		return { result: v?.result, from: v?.from, at: v?.at, ms: v?.ms }
	}
	function lookup(api: string, url: string) {
		const out = peek(api, url)
		if ("error" in out) throw new Error(out.error)
		if ("waiting" in out) throw PENDING
		return out.result
	}

	// ---- reading the outline (tracked inside a run) ----
	const get = (x: { id: Id }): any => read(S(x.id))
	// what a memo holds: its value, or nothing yet (it is out), never PENDING thrown
	const val = (names: string[]): any => {
		try {
			return readNode(names.join("/"))
		} catch (e) {
			if (e === PENDING) return undefined
			throw e
		}
	}
	const textOf = (id: Id): string => {
		const v = get({ id })
		return typeof v?.text === "string" ? v.text : ""
	}
	// the id under a name in a node, and every name in it
	const kidAt = (id: Id, name: string): Id | undefined => {
		const p = pathOf(id)
		return name in readChildren(["/", ...p]) ? idFor([...p, name]) : undefined
	}
	const membersOf = (id: Id): { name: string; id: Id }[] => {
		const p = pathOf(id)
		return Object.keys(readChildren(["/", ...p])).map((name) => ({
			name,
			id: idFor([...p, name]),
		}))
	}
	// an item's items: a folder at <item>/items holding each one at its own id; places keeps no
	// order, so the folder's value is the order (their ids). its views: the same at <item>/views
	const orderOf = (id: Id, name: string): Id[] => {
		const folder = kidAt(id, name)
		const v = folder ? read(S(folder)) : undefined
		return Array.isArray(v) ? v : []
	}
	const kidsOf = (id: Id): Id[] => orderOf(id, "items")
	// its mentions: a folder at <item>/mentions, each mention the place's (or date's) node mounted
	// there under its label
	const mentionsOf = (id: Id) => {
		const folder = kidAt(id, "mentions")
		return folder ? membersOf(folder) : []
	}
	const placeAt = (label: string) => kidAt(placesE.id, label)
	const dateAt = (label: string) => kidAt(datesE.id, label)
	const placeList = () => membersOf(placesE.id)
	// what is in a memo: its value, or that it is out (pending), or that its run failed
	function slotState(
		id: Id,
		kind: "result" | "geo",
	): { v?: any; pending?: boolean; error?: string } {
		const v = val([kind, id])
		if (v == null) return { pending: true }
		if (v.error !== undefined) return { error: v.error }
		return { v }
	}
	// a memo's run, a failure its value ({ error }) so it shows in place; pending passes
	function attempt<T>(f: () => T): T | { error: string } {
		try {
			return f()
		} catch (e) {
			if (e === PENDING) throw e
			return { error: String((e as Error)?.message ?? e) }
		}
	}
	// writing the outline (in methods): a new item, a move, a take-away, keeping the order
	const put = (x: { id: Id }, value: unknown) => patch(tg(x), [{ path: [], value }])
	const setAt = (x: { id: Id }, path: string[], value: unknown) =>
		patch(tg(x), [value === undefined ? { path } as never : { path, value }])
	// an order's patches: one id in at index, out, or moved to another place in it
	const orderIn = (x: { id: Id }, id: Id, index?: number) => {
		const n = (read(x) as Id[]).length
		const at = index === undefined ? n : Math.max(0, Math.min(index, n))
		patch(tg(x), [{ path: [], range: [at, at], value: [id] }])
	}
	const orderOut = (x: { id: Id }, id: Id) => {
		const at = (read(x) as Id[]).indexOf(id)
		if (at >= 0) patch(tg(x), [{ path: [], range: [at, at + 1] } as never])
	}
	function folder(id: Id, name: string): E {
		const there = kidAt(id, name)
		if (there) return (known.set(there, [...pathOf(id), name]), S(there))
		return mk([...pathOf(id), name], name === "mentions" ? null : [])
	}
	function insert(parent: Id, name: string, value: unknown, index?: number): Id {
		const f = folder(parent, name)
		const id = crypto.randomUUID()
		const made = [...pathOf(f.id), id]
		ensureNode(abs(made), value)
		known.set(id, made)
		orderIn(f, id, index)
		return id
	}
	const clamp = (n: number, len: number) => Math.max(0, Math.min(n, len))
	function shift(id: Id, from: Id, to: Id, index: number) {
		const src = folder(from, "items")
		if (from === to) {
			const order = read(src) as Id[]
			const was = order.indexOf(id)
			if (was < 0) return
			// the item out, back in at index counted without it: one move
			const at = clamp(index, order.length - 1)
			return patch(tg(src), [{
				path: [],
				range: [at, at],
				move: { path: [], range: [was, was + 1] },
			}])
		}
		const into = folder(to, "items")
		rename(abs([...pathOf(src.id), id]), abs([...pathOf(into.id), id]))
		orderOut(src, id)
		orderIn(into, id, index)
		forest() // its subtree is somewhere else now
	}
	function cut(parent: Id, name: string, id: Id) {
		const f = folder(parent, name)
		orderOut(f, id)
		gone(id, [...pathOf(f.id), id])
	}
	// a node and everything under it taken out (unplaced from where it is, then deleted). a mentions
	// folder holds placements of nodes that live elsewhere: it goes, what is in it stays
	function gone(id: Id, names?: string[]) {
		for (const k of membersOf(id)) {
			if (k.name === "mentions") unplace(abs(pathOf(k.id)))
			else gone(k.id)
		}
		unplace(abs(names ?? pathOf(id)))
		known.delete(id)
	}
	// the whole forest: the document and every place's own items. parent and children of each
	type Forest = { parent: Map<Id, Id>; kids: Map<Id, Id[]>; root: Map<Id, Id>; place: Set<Id> }
	function forest(): Forest {
		const f: Forest = { parent: new Map(), kids: new Map(), root: new Map(), place: new Set() }
		const walk = (id: Id, root: Id, names: string[]) => {
			known.set(id, names)
			for (const v of orderOf(id, "views")) known.set(v, [...names, "views", v])
			const ks = kidsOf(id)
			f.kids.set(id, ks)
			f.root.set(id, root)
			for (const k of ks) (f.parent.set(k, id), walk(k, root, [...names, "items", k]))
		}
		walk(doc.id, doc.id, DOCP)
		for (const p of placeList()) {
			f.place.add(p.id)
			walk(p.id, p.id, ["trip", "places", p.name])
		}
		return f
	}
	const subtree = (f: Forest, id: Id, out: Id[] = []) => {
		out.push(id)
		for (const k of f.kids.get(id) ?? []) subtree(f, k, out)
		return out
	}
	forest()

	// ---- seed, the first time only ----
	if (!hasNode("/trip/seeded")) {
		for (const [name, p] of Object.entries(PLACES)) {
			mk(["trip", "places", name], { name, query: p.query, near: NEAR, pick: p.pick })
		}
		const grow = ([text, kids = [], extra = {}]: Seed, parent: Id | undefined): Id => {
			const id = parent ? insert(parent, "items", { text, open: extra.open ?? true }) : doc.id
			syncMounts(id, text)
			for (const v of extra.views ?? []) insert(id, "views", v)
			for (const k of kids) grow(k, id)
			return id
		}
		grow(DOC, undefined)
		// the formulas written here are watched too: how their mentions fit the outline is kept
		for (const id of forest().root.keys()) {
			if (parseLine(textOf(id)).formula !== undefined) remember(id)
		}
		ensureNode("/trip/seeded", new Date().toISOString())
	}

	// ---- mentions: a token @[label] is the node at places/<label> (or dates/<label>), mounted
	// under the item too. a date typed by hand is made; a place is made only when asked ----
	function ensureDate(label: string, iso?: string): E | undefined {
		const there = dateAt(label)
		if (there) return S(there)
		iso ??= parseDate(label)
		if (!iso) return undefined
		return mk(["trip", "dates", label], { iso, label })
	}
	function syncMounts(id: Id, text: string) {
		const want = new Map<string, Id>()
		for (const tok of tokens(text)) {
			const node = placeAt(tok.label) ?? dateAt(tok.label) ?? ensureDate(tok.label)?.id
			if (node) want.set(tok.label, node)
		}
		if (!want.size && !kidAt(id, "mentions")) return
		const f = folder(id, "mentions")
		for (const m of membersOf(f.id)) {
			if (want.get(m.name) !== m.id) unplace(abs([...pathOf(f.id), m.name]))
		}
		const have = new Set(membersOf(f.id).map((m) => m.name))
		for (const [label, node] of want) {
			if (!have.has(label)) place(abs([...pathOf(f.id), label]), abs(pathOf(node)))
		}
	}

	// ---- the index: one walk of the forest. colour and icon resolve up the tree (a day's colour
	// is its items'), who mentions which place and date, the formulas, the views ----
	createMemo("index", () =>
		attempt(() => {
			const f = forest()
			const out = {
				color: {} as Record<Id, string>,
				icon: {} as Record<Id, string>,
				mentions: {} as Record<Id, Id[]>,
				formulas: [] as Id[],
				views: [] as { view: Id; item: Id; kind: string; where: string }[],
				kinds: {} as Record<Id, "place" | "date">,
				names: {} as Record<Id, string>,
				order: [] as Id[],
				base: undefined as Id | undefined,
				stale: {} as Record<Id, { i: number; from: string; to: string }[]>,
			}
			const visit = (id: Id, color: string | undefined, open: boolean) => {
				if (open) out.order.push(id)
				let own = color
				for (const k of f.kids.get(id) ?? []) {
					const line = parseLine(textOf(k))
					if (line.name === "color" && /^#[0-9a-f]{3,8}$/i.test(line.value.trim())) {
						own = line.value.trim()
					}
					if (line.name === "icon" && line.value.trim()) out.icon[id] = line.value.trim()
					if (line.name === "base" && id === doc.id) {
						const tok = tokens(line.value)[0]
						if (tok) out.base = placeAt(tok.label)
					}
				}
				if (own) out.color[id] = own
				for (const m of mentionsOf(id)) {
					const v = get(m) as any
					out.kinds[m.id] = v?.iso ? "date" : "place"
					out.names[m.id] = v?.label ?? v?.name ?? "?"
					;(out.mentions[m.id] ??= []).push(id)
				}
				for (const v of orderOf(id, "views")) {
					const w = read(S(v)) as any
					out.views.push({ view: v, item: id, kind: w?.kind, where: w?.where ?? "inline" })
				}
				const line = parseLine(textOf(id))
				if (f.parent.has(id) && line.formula !== undefined) {
					out.formulas.push(id)
					// the staleness watcher (the essay's future work): a formula made from its surroundings
					// whose mention no longer matches them, e.g. its day's date was changed
					const made = (read(S(id)) as any)?.made as Rel[] | undefined
					const toks = tokens(line.formula)
					const off = made?.flatMap((r) => {
						const want = expected(r, f.parent.get(id)!, f), was = toks[r.i]?.label
						return want && was && want !== was ? [{ i: r.i, from: was, to: want }] : []
					})
					if (off?.length) out.stale[id] = off
				}
				const shut = (read(S(id)) as any)?.open === false
				for (const k of f.kids.get(id) ?? []) visit(k, own, open && !shut)
			}
			visit(doc.id, undefined, true)
			for (const p of f.place) visit(p, undefined, false)
			return out
		}), { equal: same })
	const ix = () => (val(["index"]) ?? {}) as any

	// ---- formulas: parsed, evaluated against the outline. a name is found the way the essay says:
	// a sibling, then the parent, then up the tree, again. a lookup that is not in the cache yet
	// throws PENDING: the result waits, pending in place ----
	type Env = { id: Id; f: Forest }
	function geoOf(place: Id, name = "a place"): Geo {
		const g = slotState(place, "geo")
		if (g.pending) throw PENDING
		if (g.error !== undefined) throw new Error(`could not find ${name}: ${g.error}`)
		return g.v as Geo
	}
	function mention(label: string): V {
		const p = placeAt(label)
		if (p) return { t: "place", id: p, name: label }
		const d = dateAt(label)
		if (d) return { t: "date", id: d, iso: (read(S(d)) as any)?.iso, label }
		throw new Error(`no place or date is called “${label}”: pick it from the @ menu`)
	}
	function nameOf(id: Id, f: Forest) {
		if (f.place.has(id)) return norm((read(S(id)) as any)?.name ?? "")
		return norm(parseLine(textOf(id)).name ?? "")
	}
	function resolve(name: string, from: Id, f: Forest): Id | undefined {
		const want = norm(name)
		for (let at: Id | undefined = from; at !== undefined;) {
			const parent = f.parent.get(at)
			if (parent === undefined) return undefined
			for (const sib of f.kids.get(parent) ?? []) {
				if (sib !== at && nameOf(sib, f) === want) return sib
			}
			if (nameOf(parent, f) === want) return parent
			at = parent
		}
	}
	function resultOf(id: Id): V {
		const r = slotState(id, "result")
		if (r.pending) throw PENDING
		if (r.error !== undefined) {
			throw new Error(`${parseLine(textOf(id)).name ?? "a formula"} failed: ${r.error}`)
		}
		return r.v as V
	}
	function valueOf(id: Id, env: Env): V {
		if (env.f.place.has(id)) {
			const name = (read(S(id)) as any)?.name
			return { t: "place", id, name }
		}
		const line = parseLine(textOf(id))
		if (line.formula !== undefined) return resultOf(id)
		if (line.name) return literal(line.value)
		return { t: "item", id, name: plain(textOf(id)) }
	}
	function literal(s: string): V {
		const x = s.trim()
		const toks = tokens(x)
		if (toks.length === 1 && toks[0].start === 0 && toks[0].end === x.length) {
			return mention(toks[0].label)
		}
		const n = number(x)
		if (n) return n
		return { t: "text", s: x }
	}
	function prop(v: V, name: string, env: Env): V {
		const k = norm(name)
		if (v.t === "rec") {
			const got = Object.entries(v.fields).find(([key]) => norm(key) === k)
			if (got) return got[1]
			throw new Error(`a ${v.kind} has no ${name}: it has ${Object.keys(v.fields).join(", ")}`)
		}
		if (v.t === "place") {
			for (const c of env.f.kids.get(v.id) ?? []) {
				if (nameOf(c, env.f) === k) return valueOf(c, env)
			}
			const g = geoOf(v.id, v.name)
			const fields: Record<string, V> = {
				lat: { t: "num", n: g.lat },
				lon: { t: "num", n: g.lon },
				address: { t: "text", s: g.display },
				type: { t: "text", s: g.type },
				hours: { t: "text", s: g.hours ?? "not known" },
				website: { t: "text", s: g.website ?? "none" },
			}
			if (fields[k]) return fields[k]
			throw new Error(`${v.name} has no ${name}: try lat, lon, address, type, hours, website`)
		}
		if (v.t === "date") {
			const d = new Date(v.iso + "T12:00:00")
			if (k === "weekday") {
				return { t: "text", s: d.toLocaleDateString("en-GB", { weekday: "long" }) }
			}
			if (k === "day") return { t: "num", n: d.getDate() }
			if (k === "iso") return { t: "text", s: v.iso }
			throw new Error(`a date has weekday, day and iso, not ${name}`)
		}
		if (v.t === "item") {
			for (const c of env.f.kids.get(v.id) ?? []) {
				if (nameOf(c, env.f) === k) return valueOf(c, env)
			}
			throw new Error(`“${v.name}” has nothing called ${name} under it`)
		}
		throw new Error(`${show(v)} has no ${name}`)
	}
	function arith(op: string, a: V, b: V): V {
		if (a.t === "item" || b.t === "item") {
			throw new Error(`“${(a.t === "item" ? a : b as any).name}” is a heading, not a number`)
		}
		if (a.t !== "num" || b.t !== "num") {
			throw new Error(`${op} wants numbers, not ${show(a.t !== "num" ? a : b)}`)
		}
		const money = (u?: string) => u === "£" || u === "€" || u === "$"
		let unit = a.unit || b.unit
		if (op === "+" || op === "-") {
			if (a.unit && b.unit && a.unit !== b.unit) {
				throw new Error(`can not ${op === "+" ? "add" : "take"} ${b.unit} and ${a.unit}`)
			}
		} else if (op === "*") {
			unit = money(a.unit) ? a.unit : money(b.unit) ? b.unit : a.unit || b.unit
		} else unit = a.unit && a.unit === b.unit ? undefined : a.unit
		const n = op === "+" ? a.n + b.n : op === "-" ? a.n - b.n : op === "*" ? a.n * b.n : a.n / b.n
		if (!Number.isFinite(n)) throw new Error("that is not a number (a divide by zero?)")
		return { t: "num", n, unit }
	}
	function ev(x: Ast, env: Env): V {
		switch (x.k) {
			case "num":
				return { t: "num", n: x.n, unit: x.unit }
			case "str":
				return { t: "text", s: x.s }
			case "mention":
				return mention(x.label)
			case "name": {
				const id = resolve(x.name, env.id, env.f)
				if (id === undefined) throw new Error(`nothing called “${x.name}” beside or above this`)
				return valueOf(id, env)
			}
			case "get":
				return prop(ev(x.of, env), x.name, env)
			case "neg": {
				const v = ev(x.of, env)
				if (v.t !== "num") throw new Error(`- wants a number, not ${show(v)}`)
				return { ...v, n: -v.n }
			}
			case "bin":
				return arith(x.op, ev(x.a, env), ev(x.b, env))
			case "call":
				return call(x, env)
		}
	}
	function args(x: Extract<Ast, { k: "call" }>, fn: Fn) {
		const out: Record<string, Ast> = {}
		let i = 0
		for (const a of x.args) {
			const name = a.name ? norm(a.name) : fn.args[i++]
			if (!fn.args.includes(name)) {
				throw new Error(
					`${x.fn} takes ${fn.args.map((n) => n + ":").join(" ")}, not ${
						a.name ?? "a " + i + "th"
					}`,
				)
			}
			out[name] = a.x
		}
		for (const n of fn.args) {
			if (!(n in out)) {
				throw new Error(
					`${x.fn} needs ${n}: (${x.fn}(${fn.args.map((a) => a + ": …").join(", ")}))`,
				)
			}
		}
		return out
	}
	const asPlace = (v: V, what: string) => {
		if (v.t !== "place") throw new Error(`${what} wants a place (@ one), not ${show(v)}`)
		return v
	}
	const asDate = (v: V, what: string) => {
		if (v.t !== "date") throw new Error(`${what} wants a date (@ one), not ${show(v)}`)
		return v
	}
	function call(x: Extract<Ast, { k: "call" }>, env: Env): V {
		const fn = FNS[x.fn]
		if (!fn) throw new Error(`no function ${x.fn}: there is ${Object.keys(FNS).join(", ")}`)
		const a = args(x, fn)
		if (x.fn === "Total") {
			const of = a.of
			if (of.k !== "name") throw new Error("Total wants a name: Total(of: cost)")
			return total(of.name, env)
		}
		const v = Object.fromEntries(Object.entries(a).map(([k, y]) => [k, ev(y, env)]))
		if (x.fn === "Walk" || x.fn === "Bike" || x.fn === "Drive") {
			const mode = x.fn === "Walk" ? "foot" : x.fn === "Bike" ? "bike" : "car"
			return route(mode, asPlace(v.from, x.fn + "'s from:"), asPlace(v.to, x.fn + "'s to:"))
		}
		if (x.fn === "Weather" || x.fn === "Sun") {
			return weather(
				asPlace(v.in, x.fn + "'s in:"),
				asDate(v.on, x.fn + "'s on:"),
				x.fn === "Sun",
			)
		}
		if (x.fn === "Distance") {
			const p = asPlace(v.from, "Distance's from:"), q = asPlace(v.to, "Distance's to:")
			const g = geoOf(p.id, p.name), h = geoOf(q.id, q.name)
			const km = haversine(g, h)
			return { t: "num", n: km, unit: "km", preview: `📏 ${fmtKm(km)} as the crow flies` }
		}
		throw new Error(`${x.fn} is not built`)
	}
	function total(name: string, env: Env): V {
		const want = norm(name)
		for (
			let scope = env.f.parent.get(env.id);
			scope !== undefined;
			scope = env.f.parent.get(scope)
		) {
			const found = subtree(env.f, scope).filter((id) =>
				id !== env.id && nameOf(id, env.f) === want
			)
			if (!found.length) continue
			let sum: V = { t: "num", n: 0 }
			for (const id of found) sum = arith("+", sum, valueOf(id, env))
			return { ...sum, preview: `Σ ${fmtNum(sum as any)} · ${found.length} × ${name}` }
		}
		throw new Error(`nothing is called “${name}” here, or above`)
	}
	function route(
		mode: "foot" | "bike" | "car",
		from: Extract<V, { t: "place" }>,
		to: Extract<V, { t: "place" }>,
	): V {
		const a = geoOf(from.id, from.name), b = geoOf(to.id, to.name)
		const r = (n: number) => n.toFixed(5)
		const where = `${r(a.lon)},${r(a.lat)};${r(b.lon)},${
			r(b.lat)
		}?overview=simplified&geometries=geojson`
		const url = mode === "car"
			? `https://router.project-osrm.org/route/v1/driving/${where}`
			: `https://routing.openstreetmap.de/routed-${mode}/route/v1/${mode}/${where}`
		const res = lookup("route", url) as any
		const icon = mode === "foot" ? "🚶" : mode === "bike" ? "🚲" : "🚗"
		if (res?.code !== "Ok" || !res.routes?.length) {
			throw new Error(
				`no ${
					mode === "foot" ? "walking" : mode === "bike" ? "cycling" : "driving"
				} route from ${from.name} to ${to.name} (${res?.code ?? "no answer"})`,
			)
		}
		const best = res.routes[0]
		const km = best.distance / 1000, min = best.duration / 60
		return {
			t: "rec",
			kind: "route",
			mode,
			preview: `${icon} ${fmtMin(min)} · ${fmtKm(km)}`,
			fields: {
				distance: { t: "num", n: +km.toFixed(3), unit: "km" },
				duration: { t: "num", n: +min.toFixed(2), unit: "min" },
				from,
				to,
			},
			path: best.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]),
		}
	}
	function weather(
		place: Extract<V, { t: "place" }>,
		date: Extract<V, { t: "date" }>,
		sun: boolean,
	): V {
		const g = geoOf(place.id, place.name)
		const days = Math.round((Date.parse(date.iso + "T12:00:00") - Date.now()) / 864e5)
		if (days > 15) {
			throw new Error(`forecasts reach 16 days ahead: ${date.label} is ${days} days away`)
		}
		const base = days < -60
			? "https://historical-forecast-api.open-meteo.com/v1/forecast"
			: "https://api.open-meteo.com/v1/forecast"
		const url = `${base}?latitude=${g.lat.toFixed(2)}&longitude=${g.lon.toFixed(2)}` +
			"&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
			"&hourly=precipitation_probability,temperature_2m,weather_code&timezone=auto" +
			`&start_date=${date.iso}&end_date=${date.iso}`
		const res = lookup("weather", url) as any
		const d = res?.daily
		if (!d?.time?.length) {
			throw new Error(`no forecast for ${date.label}: ${res?.reason ?? "empty answer"}`)
		}
		const [icon, word] = wmo(d.weather_code[0])
		const min = d.temperature_2m_min[0], max = d.temperature_2m_max[0]
		const rain = d.precipitation_probability_max?.[0] ?? 0
		const rise = String(d.sunrise[0]).slice(11, 16), set = String(d.sunset[0]).slice(11, 16)
		const light = (Date.parse(d.sunset[0]) - Date.parse(d.sunrise[0])) / 6e4
		const fields: Record<string, V> = {
			min: { t: "num", n: min, unit: "°" },
			max: { t: "num", n: max, unit: "°" },
			rain: { t: "num", n: rain, unit: "%" },
			summary: { t: "text", s: word },
			sunrise: { t: "text", s: rise },
			sunset: { t: "text", s: set },
			daylight: { t: "num", n: Math.round(light), unit: "min" },
		}
		if (sun) {
			return {
				t: "rec",
				kind: "sun",
				preview: `🌅 ${rise} → ${set} · ${fmtMin(light)} of light`,
				fields,
				date: date.iso,
			}
		}
		return {
			t: "rec",
			kind: "weather",
			icon,
			preview: `${icon} ${word} ${Math.round(min)}° · ${Math.round(max)}°${
				rain >= 10 ? ` · ${rain}% rain` : ""
			}`,
			fields,
			date: date.iso,
			place: place.name,
			hourly: {
				rain: res.hourly?.precipitation_probability ?? [],
				temp: res.hourly?.temperature_2m ?? [],
				code: res.hourly?.weather_code ?? [],
			},
		}
	}
	// a formula item's run: its text read (so an edit reruns it), parsed, evaluated
	function runFormula(id: Id): V | null {
		const line = parseLine(textOf(id))
		if (line.formula === undefined) return null
		const f = forest()
		const v = ev(parse(line.formula), { id, f })
		return finish(v)
	}
	// a place's run: its query through the geocoder's cache
	function runGeo(id: Id): Geo {
		const v = read(S(id)) as any
		if (!v?.query) throw new Error("this place has no query to look for")
		const res = lookup("geocode", nominatim(v.query, v.near)) as any[]
		if (!Array.isArray(res) || !res.length) throw new Error(`OpenStreetMap knows no “${v.query}”`)
		// the one picked from the menu; else the first inside the box it was looked for in (a name
		// is often in many places); else the first
		const box = String(v.near ?? "").split(",").map(Number)
		const inside = (x: any) =>
			box.length === 4 && +x.lon >= Math.min(box[0], box[2]) &&
			+x.lon <= Math.max(box[0], box[2]) &&
			+x.lat >= Math.min(box[1], box[3]) && +x.lat <= Math.max(box[1], box[3])
		const r = (v.pick && res.find((x) => `${x.osm_type}/${x.osm_id}` === v.pick)) ||
			res.find(inside) || res[0]
		return geo(r)
	}
	// the box searches look in first: around the trip's base (or around Edinburgh)
	function near() {
		const base = ix().base
		if (!base) return NEAR
		try {
			const g = geoOf(base)
			const r = (n: number) => (Math.round(n * 20) / 20).toFixed(2)
			return `${r(g.lon - 0.3)},${r(g.lat + 0.15)},${r(g.lon + 0.3)},${r(g.lat - 0.15)}`
		} catch {
			return NEAR
		}
	}

	// ---- the parts the outline needs, made and taken away as it changes ----
	// a memo per formula (result/<id>), place (geo/<id>) and view (data/<id>), made by this effect: it
	// makes each one the outline wants, again at each run (the same node, its function made again),
	// and one it no longer makes is gone with the run; a map view also has an effect drawing it
	createEffect(
		"running",
		() => {
			const x = ix()
			return {
				formulas: x.formulas ?? [],
				places: placeList().map((p) => p.id as Id),
				views: (x.views ?? []).map((v) => [v.view, v.item, v.kind]),
			}
		},
		(want) => {
			for (const id of want.formulas) {
				createMemo(["result", id], () => attempt(() => runFormula(id)), { equal: same })
			}
			for (const id of want.places) {
				createMemo(["geo", id], () => attempt(() => runGeo(id)), { equal: same })
			}
			for (const [view, item, kind] of want.views) {
				createMemo(["data", view], () => attempt(() => viewData(kind, item)), { equal: same })
				// a drawing: what it reads is stashed, and the value it keeps is a count (a map's
				// data is not worth writing again for each hover)
				if (kind === "map") {
					let stash: unknown, count = 0
					createEffect(
						["map", view],
						() => (stash = {
							data: val(["data", view]),
							lit: val(["lit"]),
							view: read(S(view)),
						},
							++count),
						() => {
							mapFor(view).set(stash)
						},
					)
				}
			}
		},
		{ equal: same },
	)

	// ---- what a view shows, computed from its item's subtree ----
	function geoState(place: Id): { geo?: Geo; pending?: boolean; error?: string } {
		const g = slotState(place, "geo")
		return { geo: g.v as Geo | undefined, pending: g.pending, error: g.error }
	}
	const resultState = (id: Id) => slotState(id, "result")
	function viewData(kind: string, item: Id) {
		if (kind === "map") return mapData(item)
		if (kind === "calendar") return calendarData(item)
		if (kind === "table") return tableData(item)
		return { error: `no ${kind} view` }
	}
	function mapData(item: Id) {
		const x = ix()
		const markers = new Map<Id, any>()
		const routes: any[] = []
		const waiting: string[] = [], failed: { name: string; error: string }[] = []
		const visit = (id: Id) => {
			const color = x.color?.[id] ?? "#000000"
			// a formula's mentions are its arguments, not somewhere to go: its route is drawn instead
			for (const m of x.formulas?.includes(id) ? [] : mentionsOf(id)) {
				const pv = get(m) as any
				if (!pv?.query) continue
				const g = geoState(m.id as Id)
				if (g.pending) {
					if (!waiting.includes(pv.name)) waiting.push(pv.name)
					continue
				}
				if (g.error) {
					if (!failed.some((f) => f.name === pv.name)) {
						failed.push({ name: pv.name, error: g.error })
					}
					continue
				}
				const k = markers.get(m.id as Id) ?? {
					id: m.id,
					name: pv.name,
					lat: g.geo!.lat,
					lon: g.geo!.lon,
					color,
					icon: x.icon?.[id] ?? x.icon?.[m.id as Id] ?? typeIcon(g.geo!),
					items: [],
				}
				k.items.push(id)
				markers.set(m.id as Id, k)
			}
			if (x.formulas?.includes(id)) {
				const r = resultState(id)
				if (r.v?.kind === "route") {
					routes.push({ id, path: r.v.path, color, mode: r.v.mode, preview: r.v.preview })
				}
				if (r.pending) waiting.push(parseLine(textOf(id)).name ?? "a route")
			}
			for (const k of kidsOf(id)) visit(k)
		}
		visit(item)
		return { kind: "map", markers: [...markers.values()], routes, waiting, failed }
	}
	function calendarData(item: Id) {
		const x = ix()
		const days = new Map<string, any>()
		const day = (iso: string, label: string) => {
			if (!days.has(iso)) days.set(iso, { iso, label, events: [], weather: undefined })
			return days.get(iso)
		}
		const visit = (id: Id, date: { iso: string; label: string } | undefined, title: string) => {
			const text = textOf(id)
			for (const m of mentionsOf(id)) {
				const v = get(m) as any
				if (v?.iso) {
					date = { iso: v.iso, label: v.label }
					day(v.iso, v.label)
					break
				}
			}
			const line = parseLine(text)
			const color = x.color?.[id] ?? "#000000"
			if (date && line.time && !line.name) {
				day(date.iso, date.label).events.push({
					id,
					kind: "plan",
					start: line.time.start,
					end: line.time.end ?? line.time.start + 60,
					open: line.time.end === undefined,
					title: plain(line.rest),
					color,
				})
			}
			if (date && line.name === "hours") {
				const tm = parseTime(line.value)
				if (tm?.end !== undefined) {
					day(date.iso, date.label).events.push({
						id,
						kind: "hours",
						start: tm.start,
						end: tm.end,
						title: `${title}: open`,
						color,
					})
				}
			}
			if (line.formula !== undefined && x.formulas?.includes(id)) {
				const r = resultState(id)
				if (r.v?.kind === "weather") {
					const d = day(r.v.date, label(r.v.date))
					d.weather = {
						preview: r.v.preview,
						icon: r.v.icon,
						rain: r.v.hourly?.rain ?? [],
						temp: r.v.hourly?.temp ?? [],
						id,
					}
				}
			}
			const name = line.name ? title : plain(line.time ? line.rest : text)
			for (const k of kidsOf(id)) visit(k, date, name)
		}
		visit(item, undefined, plain(textOf(item)))
		const list = [...days.values()].sort((a, b) => a.iso.localeCompare(b.iso))
		let lo = 8 * 60, hi = 20 * 60
		for (const d of list) {
			for (const e of d.events) (lo = Math.min(lo, e.start), hi = Math.max(hi, e.end))
		}
		return {
			kind: "calendar",
			days: list,
			from: Math.floor(lo / 60),
			to: Math.min(24, Math.ceil(hi / 60)),
		}
	}
	function tableData(item: Id) {
		const cols: string[] = []
		const rows: any[] = []
		for (const id of kidsOf(item)) {
			const line = parseLine(textOf(id))
			if (line.name) continue
			const cells: Record<string, any> = {}
			for (const k of kidsOf(id)) {
				const l = parseLine(textOf(k))
				if (!l.name) continue
				if (!cols.includes(l.name)) cols.push(l.name)
				if (l.formula !== undefined) {
					const r = resultState(k)
					cells[l.name] = {
						id: k,
						formula: true,
						text: r.v?.preview ?? (r.pending ? "…" : `⚠ ${r.error}`),
					}
				} else cells[l.name] = { id: k, text: l.value }
			}
			let where: any
			for (const m of mentionsOf(id)) {
				const pv = get(m) as any
				if (!pv?.query) continue
				const g = geoState(m.id as Id)
				where = {
					name: pv.name,
					address: g.geo ? short(g.geo.display) : g.pending ? "finding…" : `⚠ ${g.error}`,
					hours: g.geo?.hours,
				}
				break
			}
			rows.push({ id, title: plain(textOf(id)), cells, where })
		}
		return { kind: "table", cols, rows }
	}

	// ---- the menus: what @ and / offer, with previews (a compute: previews look things up) ----
	createMemo("menulist", () =>
		attempt(() => {
			const m = read(menuE) as any
			if (!m) return null
			if (m.kind === "@") return { ...m, entries: atEntries(m) }
			return { ...m, entries: slashEntries(m) }
		}), { equal: same })
	const menuList = () => val(["menulist"])
	function atEntries(m) {
		const q = String(m.query ?? "").trim().toLowerCase()
		const out: any[] = []
		for (const p of placeList()) {
			if (q && !fuzzy(q, p.name!)) continue
			const g = geoState(p.id as Id)
			out.push({
				kind: "place",
				label: p.name,
				icon: g.geo ? typeIcon(g.geo) : g.pending ? "⏳" : "⚠",
				sub: g.geo ? short(g.geo.display) : g.pending ? "finding…" : g.error,
			})
			if (out.length >= 5) break
		}
		for (const d of dateChoices(q, membersOf(datesE.id).map((i) => i.name))) {
			out.push({ kind: "date", label: d.label, iso: d.iso, icon: "📅", sub: d.sub })
		}
		if (q.length >= 2) {
			const typed = String(m.query).trim()
			if (!placeAt(typed)) {
				out.push({
					kind: "new",
					label: typed,
					query: typed,
					near: near(),
					icon: "＋",
					sub: "a new place: look it up on OpenStreetMap",
				})
			}
		}
		const s = read(settledE) as { id: Id; q: string } | null
		const settled = String(s && s.id === m.id ? s.q : "").trim()
		if (settled.length >= 3) {
			const where = near()
			const found = peek("geocode", nominatim(settled, where)) as any
			if (found.waiting) {
				out.push({
					kind: "wait",
					icon: "⏳",
					label: `searching OpenStreetMap for “${settled}”…`,
				})
			} else if (found.error) out.push({ kind: "wait", icon: "⚠", label: found.error })
			else {
				for (const r of (found.result ?? []).slice(0, 5)) {
					const name = r.name || String(r.display_name).split(",")[0]
					out.push({
						kind: "found",
						label: name,
						query: settled,
						near: where,
						pick: `${r.osm_type}/${r.osm_id}`,
						icon: typeIcon(geo(r)),
						sub: short(r.display_name),
					})
				}
			}
		}
		return out
	}
	function slashEntries(m) {
		const q = String(m.query ?? "").toLowerCase()
		const f = forest()
		const out: any[] = []
		const cands = candidates(m.id, f)
		// the names that start with what is typed first, then those holding it, then the rest that fit
		const score = (name: string) => {
			const n = name.toLowerCase()
			return !q || n.startsWith(q) ? 0 : n.includes(q) ? 1 : fuzzy(q, n) ? 2 : 9
		}
		const fns = Object.entries(FNS).filter(([fn]) => score(fn) < 9).sort((a, b) =>
			score(a[0]) - score(b[0])
		)
		for (const [fn, spec] of fns) {
			const filled = cands.filter((c) => c.fn === fn)
			if (filled.length) {
				for (const c of filled) {
					out.push({
						kind: "fn",
						fn,
						icon: spec.icon,
						label: c.label,
						text: c.text,
						name: c.name,
						sub: spec.doc,
						...preview(c.text, m.id, f),
					})
				}
			} else {
				out.push({
					kind: "fn",
					fn,
					icon: spec.icon,
					label: `${fn}(${spec.args.map((a) => a + ": …").join(", ")})`,
					text: `=${fn}(${
						spec.args.map((a) => `${a}: ${fn === "Total" ? "cost" : "@[…]"}`).join(", ")
					})`,
					name: spec.name,
					sub: spec.doc,
				})
			}
		}
		for (const kind of ["map", "calendar", "table"]) {
			if (score(kind) === 9 && score("view") === 9) continue
			out.push({
				kind: "view",
				view: kind,
				icon: VIEWICON[kind],
				label: `${kind} view`,
				sub: "a view of this item and everything under it",
			})
		}
		for (const [name, value] of [["color", "#a23cf0"], ["icon", "⭐"]]) {
			if (score(name) === 9) continue
			out.push({
				kind: "prop",
				name,
				value,
				icon: name === "color" ? "🎨" : "⭐",
				label: `${name}: ${value}`,
				sub: `a property: the map ${name === "color" ? "colours this subtree" : "draws it"}`,
			})
		}
		return out
	}
	// a formula's preview, looked up softly: pending or failed is said, never thrown
	function preview(text: string, id: Id, f: Forest) {
		try {
			const v = finish(ev(parse(text.replace(/^=/, "")), { id, f }))
			return { preview: v.preview }
		} catch (e) {
			if (e === PENDING) return { pending: true }
			return { error: String((e as Error)?.message ?? e) }
		}
	}

	// ---- suggestions: what fits the focused item (the essay's suggested formulas), previewed ----
	function contextOf(id: Id, f: Forest) {
		const own = mentionsIn(textOf(id))
		const places = own.filter((m) => m.kind === "place"),
			dates = own.filter((m) => m.kind === "date")
		const parent = f.parent.get(id)
		const sibs = parent ? f.kids.get(parent) ?? [] : []
		let prevPlace
		for (let j = sibs.indexOf(id) - 1; j >= 0 && !prevPlace; j--) {
			const line = parseLine(textOf(sibs[j]))
			if (line.name) continue
			prevPlace = mentionsIn(textOf(sibs[j])).filter((m) => m.kind === "place").at(-1)
		}
		let upDate, upPlace
		for (let a = parent; a !== undefined && (!upDate || !upPlace); a = f.parent.get(a)) {
			const ms = mentionsIn(textOf(a))
			upDate ??= ms.find((m) => m.kind === "date")
			upPlace ??= ms.find((m) => m.kind === "place")
		}
		// the item's parent's place, and the place of the item before the parent: a leg between
		// them belongs under the parent (from the one before, to it)
		const parentPlace = parent === undefined
			? undefined
			: mentionsIn(textOf(parent)).filter((m) => m.kind === "place").at(-1)
		let parentPrev
		const up = parent === undefined ? undefined : f.parent.get(parent)
		const usibs = up === undefined ? [] : f.kids.get(up) ?? []
		for (let j = usibs.indexOf(parent!) - 1; j >= 0 && !parentPrev; j--) {
			if (parseLine(textOf(usibs[j])).name) continue
			parentPrev = mentionsIn(textOf(usibs[j])).filter((m) => m.kind === "place").at(-1)
		}
		const b = ix().base
		const base = b ? { label: (read(S(b)) as any)?.name, kind: "place" } : undefined
		return { places, dates, prevPlace, upDate, upPlace, base, parent, parentPlace, parentPrev }
	}
	function mentionsIn(text: string) {
		const out: { label: string; kind: "place" | "date" }[] = []
		for (const tok of tokens(text)) {
			if (placeAt(tok.label)) out.push({ label: tok.label, kind: "place" })
			else if (dateAt(tok.label)) out.push({ label: tok.label, kind: "date" })
		}
		return out
	}
	function candidates(id: Id, f: Forest) {
		const c = contextOf(id, f)
		const out: { fn: string; text: string; label: string; name: string }[] = []
		const fx = (fn: string, a: Record<string, string>, raw = false) => {
			const inner = Object.entries(a).map(([k, v]) => `${k}: ${raw ? v : `@[${v}]`}`).join(", ")
			const words = Object.entries(a).map(([k, v]) => `${k === "of" ? "of every" : k} ${v}`)
				.join(" ")
			out.push({ fn, text: `=${fn}(${inner})`, label: `${fn} ${words}`, name: FNS[fn].name })
		}
		const where = c.base ?? c.upPlace ?? c.places[0]
		const date = c.dates[0]
		if (date && where) {
			;(fx("Weather", { in: where.label, on: date.label }),
				fx("Sun", { in: where.label, on: date.label }))
		}
		let to = c.places.at(-1)
		let from = c.places.length > 1 ? c.places[0] : c.prevPlace
		if (!to && c.parentPlace) (to = c.parentPlace, from = c.parentPrev)
		if (to && from && from.label !== to.label) {
			for (const fn of ["Walk", "Bike", "Drive"]) fx(fn, { from: from.label, to: to.label })
			fx("Distance", { from: from.label, to: to.label })
		}
		if (
			/budget|total|cost|spend|money/i.test(textOf(id)) &&
			[...f.kids.keys()].some((k) => nameOf(k, f) === "cost")
		) {
			fx("Total", { of: "cost" }, true)
		}
		// what is there already, under it or beside it, is not suggested again
		const nearby = [
			...(f.kids.get(id) ?? []),
			...(c.parent === undefined ? [] : f.kids.get(c.parent) ?? []),
		]
		const have = new Set(nearby.map((k) => parseLine(textOf(k)).formula?.replace(/\s+/g, "")))
		return out.filter((x) => !have.has(x.text.slice(1).replace(/\s+/g, "")))
	}
	createMemo("suggest", () =>
		attempt(() => {
			const focus = read(focusE) as any
			if (!focus?.id) return null
			const f = forest()
			if (!f.root.has(focus.id) || focus.id === doc.id) return null
			const line = parseLine(textOf(focus.id))
			const list = candidates(focus.id, f).map((c) => ({
				...c,
				...preview(c.text, focus.id, f),
			}))
			const out: any = { id: focus.id, list }
			if (line.formula !== undefined) {
				out.formula = line.formula
				out.repeat = repeatPlan(focus.id, f).map((p) => ({ label: p.label }))
				const flow = (read(flowE) as any)?.[focus.id]
				if (flow) out.reads = flow
			}
			return out
		}), { equal: same })

	// ---- repeat (the essay's auto-repeat): how the formula's mentions relate to the outline
	// around it, then the same shape found again, a copy put in each ----
	// the item before id among its siblings (properties skipped), and the labels of a kind it mentions
	function prevOf(id: Id, f: Forest) {
		const sibs = f.kids.get(f.parent.get(id) ?? "") ?? []
		for (let j = sibs.indexOf(id) - 1; j >= 0; j--) {
			if (!parseLine(textOf(sibs[j])).name) return sibs[j]
		}
	}
	function labels(id: Id | undefined, kind: string) {
		return id === undefined
			? []
			: mentionsIn(textOf(id)).filter((m) => m.kind === kind).map((m) => m.label)
	}
	// how a formula's mentions relate to the outline around it: each from its parent (its nth place
	// or date), from the item before its parent, or fixed. what repeat copies, and what the
	// staleness watcher checks again
	type Rel = { i: number; rel: "parent" | "prev" | "fixed"; kind?: string; nth?: number }
	function relationsOf(fid: Id, f: Forest): Rel[] {
		const P = f.parent.get(fid)
		const line = parseLine(textOf(fid))
		if (P === undefined || line.formula === undefined) return []
		return tokens(line.formula).map((tok, i) => {
			const kind = placeAt(tok.label) ? "place" : dateAt(tok.label) ? "date" : undefined
			if (!kind) return { i, rel: "fixed" }
			const inP = labels(P, kind).indexOf(tok.label)
			if (inP >= 0) return { i, rel: "parent", kind, nth: inP }
			const inPrev = labels(prevOf(P, f), kind).indexOf(tok.label)
			if (inPrev >= 0) return { i, rel: "prev", kind, nth: inPrev }
			return { i, rel: "fixed" }
		})
	}
	// what each relation says the mention should be now (undefined: nothing there)
	function expected(r: Rel, P: Id, f: Forest) {
		if (r.rel === "fixed") return undefined
		return labels(r.rel === "parent" ? P : prevOf(P, f), r.kind!)[r.nth!]
	}
	function repeatPlan(fid: Id, f: Forest) {
		const P = f.parent.get(fid)
		if (P === undefined) return []
		const line = parseLine(textOf(fid))
		if (line.formula === undefined) return []
		const G = f.parent.get(P)
		const toks = tokens(line.formula)
		const rels = relationsOf(fid, f).map((r) => ({ ...r, tok: toks[r.i] }))
		if (!rels.some((r) => r.rel !== "fixed") || G === undefined) return []
		const fn = /^\s*([A-Z]\w*)\s*\(/.exec(line.formula)?.[1]
		const out: { parent: Id; index: number; text: string; label: string; made?: any }[] = []
		for (const C of f.kids.get(G) ?? []) {
			if (C === P || parseLine(textOf(C)).name) continue
			let formula = line.formula
			let ok = true
			for (const r of [...rels].reverse()) {
				if (r.rel === "fixed") continue
				const label = expected(r, C, f)
				if (!label) {
					ok = false
					break
				}
				formula = formula.slice(0, r.tok.start) + `@[${label}]` + formula.slice(r.tok.end)
			}
			if (!ok) continue
			const had = (f.kids.get(C) ?? []).some((k) => {
				const l = parseLine(textOf(k)).formula
				return l !== undefined &&
					(l.replace(/\s+/g, "") === formula.replace(/\s+/g, "") ||
						(fn && l.trim().startsWith(fn + "(")))
			})
			if (had) continue
			const index = Math.min((f.kids.get(P) ?? []).indexOf(fid), (f.kids.get(C) ?? []).length)
			out.push({
				parent: C,
				index,
				text: (line.name ? `${line.name}: ` : "") + "=" + formula.trim(),
				label: plain(textOf(C)),
				made: rels.map(({ tok: _, ...r }) => r),
			})
		}
		return out
	}

	// ---- what each part's last run read (the host's ended, the scheduler's ends moment): the host
	// runs on/ran with each memo's run that ends, its reads as paths, so this names them (a part's
	// own memo by what it is of; any other node by its id) ----
	createAction("on/ran", (r: Run) =>
		peep(() => {
			if (!["result", "geo", "data"].includes(r.name)) return
			const of = r.of as Id
			const ids = new Set<string>()
			for (const p of r.values) {
				if (p[0] === "embark" && ["result", "geo", "data"].includes(p[1])) {
					if (p[1] !== "data") ids.add(p[2])
				} else if (p[0] === "trip") ids.add(idFor(p))
			}
			ids.delete(of)
			const was = (read(flowE) ?? {}) as Record<string, any>
			const now = {
				run: r.run,
				ended: r.ended,
				ms: r.ms,
				values: [...ids],
				keys: r.keys,
				error: r.error,
			}
			const unchanged = was[of] &&
				JSON.stringify({ ...was[of], run: 0, ms: 0 }) ===
					JSON.stringify({ ...now, run: 0, ms: 0 })
			if (!unchanged) patch(tg(flowE), [{ path: [of], value: now }])
		}))
	addTeardown(ended("/embark/on/ran"))

	// ---- lit: what a hover touches, in every view: an item and its places, a place and the items
	// mentioning it, a formula and everything its last run read ----
	createMemo("lit", () =>
		attempt(() => {
			const h = (read(hoverE) ?? {}) as any
			const x = ix()
			const items = new Set<Id>(), places = new Set<Id>(), routes = new Set<Id>()
			const item = (id: Id) => {
				items.add(id)
				for (const [p, by] of Object.entries(x.mentions ?? {}) as [Id, Id[]][]) {
					if (by.includes(id)) places.add(p)
				}
				if (x.formulas?.includes(id)) routes.add(id)
			}
			if (h.item) item(h.item)
			if (h.place) {
				places.add(h.place)
				for (const id of x.mentions?.[h.place] ?? []) items.add(id)
			}
			if (h.formula) {
				routes.add(h.formula)
				const flow = (read(flowE) as any)?.[h.formula]
				for (const v of flow?.values ?? []) {
					if (v.startsWith("place:") || v.startsWith("date:") || x.kinds?.[v]) places.add(v)
					else items.add(v)
				}
			}
			return {
				items: [...items],
				places: [...places],
				routes: [...routes],
				formula: h.formula,
				from: h.from,
			}
		}), { equal: same })

	// ---- handlers: every write is a call ----
	function locate(id: Id, f = forest()) {
		const parent = f.parent.get(id)
		if (parent === undefined) return undefined
		return { parent, index: (f.kids.get(parent) ?? []).indexOf(id), f }
	}
	// the items as they show, in order (collapsed ones hide what is under them), in id's outline
	function visible(f: Forest, root: Id) {
		const out: Id[] = []
		const walk = (id: Id) => {
			out.push(id)
			if ((read(S(id)) as any)?.open === false) return
			for (const k of f.kids.get(id) ?? []) walk(k)
		}
		walk(root)
		return out
	}
	const setText = (id: Id, text: string) => {
		if (textOf(id) === text) return
		setAt(S(id), ["text"], text)
		syncMounts(id, text)
	}
	let caretN = 0
	const focus = (id: Id | null, at?: number) =>
		put(focusE, id === null ? null : { id, at, n: ++caretN })
	const toast = (text: string) => put(toastE, { text, at: Date.now() })
	// a new item: under parent at index, its text, focused (the caret at at)
	function addItem(parent: Id, index: number | undefined, text = "", caret = 0) {
		const id = insert(parent, "items", { text, open: true }, index)
		if (text) syncMounts(id, text)
		focus(id, caret)
		return id
	}
	// an item and everything under it: its parts let go first, then it is taken out (its
	// mentions are mounts: the places stay)
	function removeItem(id: Id) {
		const where = locate(id)
		if (!where) return
		for (const x of subtree(where.f, id)) {
		}
		cut(where.parent, "items", id)
	}
	function moveItem(id: Id, parent: Id, index: number) {
		const from = locate(id)
		if (!from) return
		if (subtree(from.f, id).includes(parent)) return // not into itself
		if (from.parent === parent) {
			const to = index > from.index ? index - 1 : index
			if (to !== from.index) shift(id, parent, parent, to)
			return
		}
		shift(id, from.parent, parent, index)
		if ((read(S(parent)) as any)?.open === false) setAt(S(parent), ["open"], true)
	}
	// the menu for what is just before the caret: @query or /query
	function menuFor(id: Id, text: string, caret: number) {
		const before = text.slice(0, caret)
		const was = read(menuE) as any
		let m: any = null
		const at = /(^|[\s(,:])@([^@[\]\n]{0,40})$/.exec(before)
		const sl = /(^|\s)\/([A-Za-z ]{0,20})$/.exec(before)
		if (at) m = { kind: "@", id, from: at.index + at[1].length, to: caret, query: at[2], sel: 0 }
		else if (sl) {
			m = { kind: "/", id, from: sl.index + sl[1].length, to: caret, query: sl[2], sel: 0 }
		}
		if (m && was?.kind === m.kind && was.id === id && was.from === m.from) {
			m.sel = was.query === m.query ? was.sel : 0
		}
		if (JSON.stringify(m) !== JSON.stringify(was)) put(menuE, m)
	}
	// a search waits until typing stops (Nominatim: one request a second at most): a memo gives the
	// query 650ms after it last changed (a promise; the memo runs again with each keystroke), and
	// an effect writes it where the menu looks (settledE)
	createMemo("asked", () => {
		const m = read(menuE) as any
		return m?.kind === "@" ? { id: m.id, q: String(m.query ?? "") } : null
	}, { equal: same })
	const settling = createMemo("settling", () => {
		const m = val(["asked"])
		if (!m) return null
		return new Promise<{ id: Id; q: string }>((done) => setTimeout(() => done(m), 650))
	})
	createEffect("settle", () => read(settling), (v) => {
		if (v) put(settledE, v)
	})
	function pick(m, e) {
		if (!e || e.kind === "wait") return
		const text = textOf(m.id)
		const before = text.slice(0, m.from), after = text.slice(m.to)
		put(menuE, null)
		if (m.kind === "@") {
			let label = e.label
			if (e.kind === "date") ensureDate(label, e.iso)
			if (e.kind === "found" || e.kind === "new") {
				const there = placeAt(label)
				const v = there ? read(S(there)) as any : undefined
				// the same name for another place: the second gets a number
				if (there && !(v?.query === e.query && v?.pick === e.pick)) {
					let n = 2
					while (placeAt(`${label} ${n}`)) n++
					label = `${label} ${n}`
				}
				if (!placeAt(label)) {
					mk(["trip", "places", label], {
						name: label,
						query: e.query,
						near: e.near,
						pick: e.pick,
					})
				}
			}
			const tok = `@[${label}]`
			const rest = after.startsWith(" ") ? after : " " + after
			setText(m.id, before + tok + rest)
			focus(m.id, (before + tok).length + 1)
			return
		}
		const rest = (before + after).replace(/\s+$/, "")
		if (e.kind === "view") {
			setText(m.id, rest)
			insert(m.id, "views", { kind: e.view, where: "inline" })
			focus(m.id, rest.length)
			return
		}
		const line = e.kind === "prop" ? `${e.name}: ${e.value}` : `${e.name}: ${e.text}`
		if (!rest.trim()) {
			setText(m.id, line)
			if (e.kind === "fn") remember(m.id)
			focus(m.id, line.length)
			return
		}
		setText(m.id, rest)
		const f = forest()
		const made = addItem(m.id, propsEnd(m.id, f), line, line.length)
		if (e.kind === "fn") remember(made)
	}
	// a formula made from its surroundings remembers how (relationsOf): the staleness watcher
	function remember(id: Id) {
		const rels = relationsOf(id, forest())
		if (rels.some((r) => r.rel !== "fixed")) setAt(S(id), ["made"], rels)
	}
	// where a new child goes: after the item's properties (color, icon…)
	function propsEnd(id: Id, f: Forest) {
		const ks = f.kids.get(id) ?? []
		let i = 0
		while (
			i < ks.length && parseLine(textOf(ks[i])).name &&
			parseLine(textOf(ks[i])).formula === undefined
		) i++
		return i
	}

	method("on/text", (id: Id, text: string, caret: number) => {
		setText(id, text)
		menuFor(id, text, caret)
	})
	method("on/focus", (id: Id, at?: number) => {
		const m = read(menuE) as any
		if (m && m.id !== id) put(menuE, null)
		focus(id, at)
	})
	method("on/blur", (id: Id) => {
		if ((read(focusE) as any)?.id !== id) return
		put(focusE, null)
		put(menuE, null)
	})
	method("on/pick", (i: number) => {
		const list = menuList() as any
		if (list) pick(list, list.entries?.[i])
	})
	method("on/key", (id: Id, action: string, at: number, text: string) => {
		const f = forest()
		const where = locate(id, f)
		const root = f.root.get(id) ?? doc.id
		if (action.startsWith("menu-")) {
			const list = menuList() as any
			const n = list?.entries?.length ?? 0
			if (action === "menu-pick") return pick(list, list?.entries?.[list.sel ?? 0])
			if (action === "menu-close") return put(menuE, null)
			const sel = ((list?.sel ?? 0) + (action === "menu-down" ? 1 : -1) + n) % Math.max(1, n)
			return setAt(menuE, ["sel"], sel)
		}
		if (action === "enter") {
			const before = text.slice(0, at), after = text.slice(at)
			// an empty item, nested: out one level instead
			if (!text.trim() && where && f.parent.get(where.parent) !== undefined) {
				return outdent(id, f)
			}
			if (
				id === root ||
				((read(S(id)) as any)?.open !== false && at === text.length &&
					(f.kids.get(id)?.length ?? 0) > 0)
			) {
				if (id !== root) setText(id, before)
				return addItem(id, id === root ? 0 : propsEnd(id, f))
			}
			if (!where) return
			setText(id, before)
			return addItem(where.parent, where.index + 1, after, 0)
		}
		if (action === "indent") {
			if (!where || where.index === 0) return
			const prev = f.kids.get(where.parent)![where.index - 1]
			shift(id, where.parent, prev, f.kids.get(prev)?.length ?? 0)
			if ((read(S(prev)) as any)?.open === false) setAt(S(prev), ["open"], true)
			return focus(id, at)
		}
		if (action === "outdent") return outdent(id, f, at)
		if (action === "up" || action === "down") {
			const order = visible(f, root)
			const i = order.indexOf(id) + (action === "up" ? -1 : 1)
			if (i < 0 || i >= order.length) return
			const next = order[i]
			return focus(
				next,
				action === "up" ? textOf(next).length : Math.min(at, textOf(next).length),
			)
		}
		if (action === "move-up" || action === "move-down") {
			if (!where) return
			const to = where.index + (action === "move-up" ? -1 : 1)
			if (to < 0 || to >= (f.kids.get(where.parent)?.length ?? 0)) return
			shift(id, where.parent, where.parent, to)
			return focus(id, at)
		}
		if (action === "fold") {
			if (!f.kids.get(id)?.length) return
			return setAt(S(id), ["open"], (read(S(id)) as any)?.open === false)
		}
		if (action === "esc") return put(focusE, null)
		if (action === "back") {
			if (!where) return
			const order = visible(f, root)
			const prev = order[order.indexOf(id) - 1]
			if (prev === undefined) return
			if (!text && !(f.kids.get(id)?.length)) {
				removeItem(id)
				return focus(prev, textOf(prev).length)
			}
			if (f.kids.get(id)?.length || prev === root) return
			const join = textOf(prev).length
			setText(prev, textOf(prev) + text)
			removeItem(id)
			return focus(prev, join)
		}
	})
	function outdent(id: Id, f: Forest, at = 0) {
		const where = locate(id, f)
		if (!where) return
		const up = locate(where.parent, f)
		if (!up) return
		shift(id, where.parent, up.parent, up.index + 1)
		focus(id, at)
	}
	method("on/add", (parent: Id) => addItem(parent, undefined))
	method("on/remove", (id: Id) => removeItem(id))
	method("on/fold", (id: Id) => setAt(S(id), ["open"], (read(S(id)) as any)?.open === false))
	method("on/move", (id: Id, parent: Id, index: number) => moveItem(id, parent, index))
	method("on/hover", (kind: string | null, id?: Id, from?: string) => {
		const next = kind ? { [kind]: id, from } : {}
		if (JSON.stringify(read(hoverE)) !== JSON.stringify(next)) put(hoverE, next)
	})
	method("on/suggest", (id: Id, i: number) => {
		const s = val(["suggest"]) as any
		const c = s?.list?.[i]
		if (!c) return
		const f = forest()
		const line = `${c.name}: ${c.text}`
		const at = propsEnd(id, f)
		const made = insert(id, "items", { text: line, open: true }, at)
		syncMounts(made, line)
		remember(made)
		if ((read(S(id)) as any)?.open === false) setAt(S(id), ["open"], true)
		toast(`added ${c.label} under “${plain(textOf(id))}”`)
	})
	method("on/unstale", (fid: Id) => {
		const off = ix().stale?.[fid] as { i: number; to: string }[] | undefined
		if (!off) return
		const text = textOf(fid), line = parseLine(text)
		const toks = tokens(line.formula ?? "")
		let out = text
		for (const o of [...off].sort((a, b) => b.i - a.i)) {
			const tok = toks[o.i]
			out = out.slice(0, line.formulaAt + tok.start) + `@[${o.to}]` +
				out.slice(line.formulaAt + tok.end)
		}
		setText(fid, out)
	})
	method("on/repeat", (fid: Id) => {
		const f = forest()
		const plan = repeatPlan(fid, f)
		if (!plan.length) return toast("nothing to repeat into: no other item has the same shape")
		// each copy remembers how its mentions were found, and so does the formula copied: the
		// staleness watcher checks them again when the outline changes
		setAt(S(fid), ["made"], plan[0].made)
		for (const p of plan) {
			syncMounts(
				insert(p.parent, "items", { text: p.text, open: true, made: p.made }, p.index),
				p.text,
			)
		}
		toast(`repeated under ${plan.map((p) => `“${p.label}”`).join(", ")}`)
	})
	method("on/view", (item: Id, kind: string, where = "inline") => {
		insert(item, "views", { kind, where })
		if ((read(S(item)) as any)?.open === false) setAt(S(item), ["open"], true)
	})
	method("on/viewwhere", (view: Id, where: string) => setAt(S(view), ["where"], where))
	method("on/unview", (view: Id) => {
		const v = (ix().views ?? []).find((x) => x.view === view)
		if (!v) return
		cut(v.item, "views", view)
	})
	method("on/camera", (view: Id, cam: Cam | null) => setAt(S(view), ["camera"], cam))
	method("on/color", (id: Id, color: string) => {
		const line = parseLine(textOf(id))
		setText(id, `${line.name ?? "color"}: ${color}`)
	})
	method("on/cell", (row: Id, name: string, value: string) => {
		const f = forest()
		const there = (f.kids.get(row) ?? []).find((k) => nameOf(k, f) === norm(name))
		if (there) return setText(there, `${parseLine(textOf(there)).name}: ${value}`)
		syncMounts(
			insert(row, "items", { text: `${name}: ${value}`, open: true }, propsEnd(row, f)),
			`${name}: ${value}`,
		)
	})
	method("on/time", (id: Id, start: number, end: number | undefined) => {
		const text = textOf(id)
		const line = parseLine(text)
		const span = end === undefined ? hhmm(start) : `${hhmm(start)}–${hhmm(end)}`
		if (line.name === "hours") return setText(id, `${line.name}: ${span}`)
		setText(id, `${span} ${line.time ? line.rest : text}`.trim())
	})
	method(
		"on/card",
		(place: Id | null, x?: number, y?: number) => put(cardE, place ? { place, x, y } : null),
	)
	method("on/select", (item: Id) => {
		queueMicrotask(() => {
			const row = document.querySelector(`li.it[data-id="${item}"] > .row`) as HTMLElement | null
			row?.scrollIntoView({ block: "center", behavior: "smooth" })
			row?.animate(GLOW, 1100)
		})
	})
	// a click on a place of a map: its card, and its first item selected
	method("on/pin", (place: Id, x: number, y: number, item?: Id) => {
		put(cardE, { place, x, y })
		if (item) executeAction("on/select", item)
	})
	method("on/retry", (api?: string) => retry(api))
	method("on/threads", () => put(threadsE, !read(threadsE)))
	method("on/help", () => put(helpE, !read(helpE)))
	method("on/prop", (place: Id) => {
		focus(insert(place, "items", { text: "note: ", open: true }), 6)
	})
	method("on/find", (label: string) => {
		if (placeAt(label)) return
		mk(["trip", "places", label], { name: label, query: label, near: near() })
		const items = ix().mentions ?? {}
		for (const by of Object.values(items) as Id[][]) {
			for (const id of by) syncMounts(id, textOf(id))
		}
		for (const id of forest().root.keys()) {
			if (textOf(id).includes(`@[${label}]`)) syncMounts(id, textOf(id))
		}
	})
	method("on/forget", (place: Id) => {
		if ((ix().mentions?.[place] ?? []).length) {
			return toast("still mentioned: take the mentions out first")
		}
		const p = placeList().find((x) => x.id === place)
		if (!p) return
		gone(place, ["trip", "places", p.name])
		put(cardE, null)
	})

	// ---- the outline's marks: which row is being edited, what is lit, the caret, the threads.
	// an effect drawing on the page (no node of its own) ----
	let lastN = -1
	createEffect(
		"marks",
		() => ({ focus: read(focusE), lit: val(["lit"]), threads: read(threadsE) }),
		(v: any) => {
			queueMicrotask(() => marks(v))
		},
		{ equal: same },
	)
	function marks(v: any) {
		const app = document.querySelector(".embark")
		if (!app) return
		const f = v.focus as { id: Id; at?: number; n: number } | null
		const lit = new Set<Id>(v.lit?.items ?? []), litPlaces = new Set<Id>(v.lit?.places ?? [])
		for (const li of app.querySelectorAll<HTMLElement>("li.it, .title.it")) {
			li.classList.toggle("editing", li.dataset.id === f?.id)
			li.classList.toggle("lit", lit.has(li.dataset.id!))
		}
		for (const c of app.querySelectorAll<HTMLElement>("[data-place]")) {
			c.classList.toggle("lit", litPlaces.has(c.dataset.place!))
		}
		for (const r of app.querySelectorAll<HTMLElement>("[data-formula]")) {
			r.classList.toggle("lit", r.dataset.formula === v.lit?.formula)
		}
		if (f && f.n !== lastN) {
			lastN = f.n
			const ta = app.querySelector<HTMLTextAreaElement>(`textarea[data-ed="${f.id}"]`)
			if (ta) {
				if (document.activeElement !== ta) ta.focus({ preventScroll: true })
				const at = Math.min(f.at ?? ta.value.length, ta.value.length)
				ta.setSelectionRange(at, at)
				ta.closest(".row")?.scrollIntoView({ block: "nearest" })
			}
		}
		trayAt()
		threads(v)
	}
	// the tray sits in the outline's margin beside the item being edited
	function trayAt() {
		const tray = document.querySelector<HTMLElement>(".tray")
		const id = tray?.dataset.for
		const row = id ? document.querySelector<HTMLElement>(`li.it[data-id="${id}"] > .row`) : null
		const outline = document.querySelector<HTMLElement>(".doc")
		if (!tray || !row || !outline) return
		tray.style.top = `${
			row.getBoundingClientRect().top - outline.getBoundingClientRect().top + outline.scrollTop
		}px`
	}
	// threads: from each item a hovered formula read, to it, drawn in the outline's left margin
	// (an svg made here: ermine-h's jsx makes html elements)
	threads.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
	threads.svg.setAttribute("class", "threads")
	threads.svg.setAttribute("width", "40")
	function threads(v: any) {
		const svg = threads.svg
		const outline = document.querySelector<HTMLElement>(".doc")
		if (!svg || !outline) return
		const to = v.lit?.formula
		const box = outline.getBoundingClientRect()
		const y = (id: Id) => {
			const r = document.querySelector(`li.it[data-id="${id}"] > .row`)?.getBoundingClientRect()
			return r && r.height
				? r.top - box.top + outline.scrollTop + Math.min(r.height / 2, 14)
				: undefined
		}
		const end = to ? y(to) : undefined
		svg.setAttribute("height", String(outline.scrollHeight))
		if (!v.threads || end === undefined) return void (svg.innerHTML = "")
		let paths = ""
		for (const id of v.lit.items as Id[]) {
			if (id === to) continue
			const a = y(id)
			if (a === undefined) continue
			const d = Math.min(30, 8 + Math.abs(end - a) / 12)
			paths += `<path d="M22 ${a} C${22 - d} ${a}, ${22 - d} ${end}, 18 ${end}"/>` +
				`<circle cx="22" cy="${a}" r="3"/>`
		}
		svg.innerHTML = paths ? paths + `<path class="head" d="M22 ${end} l-7 -4 v8 z"/>` : ""
	}
	const relay = () => {
		trayAt()
		threads({ lit: lastLit, threads: true })
	}
	let lastLit: any
	createEffect("threads", () => val(["lit"]), (v) => {
		lastLit = v
	}, { equal: same })
	addEventListener("resize", relay)
	addTeardown(() => removeEventListener("resize", relay))

	// ---- the views ----
	// a row's text, shown: properties, a formula's result, a time, mentions as chips. each piece
	// says where it is in the text (data-at), so a click puts the caret there
	function display(id: Id, v: any) {
		const text = String(v?.text ?? "")
		if (!text.trim()) return <span class="ph">{id === doc.id ? "a title" : "…"}</span>
		const line = parseLine(text)
		const out: any[] = []
		if (line.name) out.push(<span class="pname" data-at={0}>{line.name}</span>)
		if (line.formula !== undefined) {
			out.push(<Result id={id} />)
			out.push(<Stale id={id} />)
			out.push(
				<span class="fx" data-at={line.formulaAt - 1}>
					={inline(line.formula, line.formulaAt)}
				</span>,
			)
			return out
		}
		if (line.name === "color") {
			out.push(
				<label
					class="swatch"
					style={`--sw:${line.value.trim()}`}
					title="pick a colour: it writes this line"
				>
					<input
						type="color"
						value={/^#[0-9a-f]{6}$/i.test(line.value.trim()) ? line.value.trim() : "#000000"}
						onInput={handler("on/color", (e) => [id, e.target.value])}
					/>
				</label>,
			)
		}
		if (line.name === "icon") {
			out.push(<span class="bigicon" data-at={line.valueAt}>{line.value}</span>)
		} else if (line.name) out.push(<span class="pval">{inline(line.value, line.valueAt)}</span>)
		else {
			if (line.time) {
				out.push(
					<span class="time" data-at={0}>
						{hhmm(line.time.start)}
						{line.time.end !== undefined ? `–${hhmm(line.time.end)}` : ""}
					</span>,
				)
			}
			out.push(inline(line.rest, line.restAt))
		}
		return out
	}
	// text with mentions: plain runs and chips
	function inline(text: string, offset: number) {
		const out: any[] = []
		let at = 0
		for (const tok of tokens(text)) {
			if (tok.start > at) {
				out.push(
					<span class="tx" data-at={offset + at}>{money(text.slice(at, tok.start))}</span>,
				)
			}
			out.push(<Mention label={tok.label} end={offset + tok.end} />)
			at = tok.end
		}
		if (at < text.length) {
			out.push(<span class="tx" data-at={offset + at}>{money(text.slice(at))}</span>)
		}
		return out
	}
	// a mention: the place's node (or the date's) at its name; neither: said plainly
	function Mention({ label, end }: { label: string; end: number }) {
		return (
			<span class="m" data-at={end} data-label={label}>
				{each(`${H(placesE.id)}/${label}`, () => <PlaceChip label={label} />)}
				{each(
					`${H(datesE.id)}/${label}`,
					() => (
						<span class="chip date" title="a date: its node is /embark/dates">
							📅 {label}
						</span>
					),
				)}
				<button
					class="chip unknown"
					title="no place or date has this name: look it up on OpenStreetMap"
					onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())}
					onClick={handler("on/find", [label])}
				>
					@{label} ?
				</button>
			</span>
		)
	}
	function PlaceChip({ label }: { label: string }) {
		const id = `place:${label}` as Id
		return (
			<span
				class="chip place"
				data-place={id}
				onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())}
				onClick={handler("on/card", (e) => {
					const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
					const app = document.querySelector(".embark")!.getBoundingClientRect()
					return [id, r.left - app.left, r.bottom - app.top + 4]
				})}
				onPointerEnter={handler("on/hover", ["place", id, "outline"])}
				onPointerLeave={handler("on/hover", [null])}
			>
				<span class="uicon">{bind(IX, (x) => x?.icon?.[id] ?? "")}</span>
				<span
					class="gicon"
					data-bad={bind(memoAt("geo", id), (v) => (v?.error !== undefined ? "yes" : null))}
					title={bind(memoAt("geo", id), (v) => v?.error ?? v?.display ?? "")}
				>
					{bind(memoAt("geo", id), (v) => (v?.error !== undefined ? "⚠" : typeIcon(v)))}
				</span>
				{label}
			</span>
		)
	}
	// a formula's result: its part's node, pending or failed in place (the host's markers)
	function Result({ id }: { id: Id }) {
		return (
			<span
				class="result"
				data-formula={id}
				onPointerEnter={handler("on/hover", ["formula", id, "outline"])}
				onPointerLeave={handler("on/hover", [null])}
				onMouseDown={(e) => e.stopPropagation()}
			>
				{bind(memoAt("result", id), (v) =>
					v?.error !== undefined
						? (
							<span class="bad">
								⚠ {v.error}
								<button
									class="mini"
									onMouseDown={(e) => e.preventDefault()}
									onClick={handler("on/retry")}
								>
									retry
								</button>
							</span>
						)
						: v?.preview ?? "")}
			</span>
		)
	}
	// out of date: what the surroundings say now, and a button that writes it
	function Stale({ id }: { id: Id }) {
		return (
			<span class="stalebox">
				{bind(IX, (x) => {
					const off = x?.stale?.[id]
					if (!off) return null
					return (
						<button
							class="stale"
							title="this formula was made from the outline around it, which has changed since: update its mentions"
							onMouseDown={(e) => e.stopPropagation()}
							onClick={handler("on/unstale", [id])}
						>
							⚠ stale: {off.map((o: any) => `${o.from} → ${o.to}`).join(", ")} · update
						</button>
					)
				})}
			</span>
		)
	}
	// the edit layer: the raw text, tokens tinted behind a transparent textarea
	function highlight(text: string) {
		const out: any[] = []
		const line = parseLine(text)
		let at = 0
		const push = (end: number, cls?: string) => {
			if (end > at) {
				out.push(cls ? <span class={cls}>{text.slice(at, end)}</span> : text.slice(at, end))
			}
			at = end
		}
		if (line.name) push(line.nameEnd, "hn")
		for (const tok of tokens(text)) {
			push(tok.start)
			push(tok.end, "ht")
		}
		push(text.length)
		out.push("​")
		return out
	}

	// one outline item: its row (shown, or edited), its inline views, its items
	function Item({ id }: { id: Id }) {
		const e = H(id)
		return (
			<li
				key={id}
				class={bind(e, (v) => "it" + (v?.open === false ? " shut" : ""))}
				data-id={id}
				style={bind(IX, (x) => `--c:${x?.color?.[id] ?? "#000"}`)}
			>
				<Row id={id} />
				<Views id={id} />
				<Kids id={id} />
			</li>
		)
	}
	// an item's items, in the order its items folder keeps (each its own id, keyed by it)
	function Kids({ id }: { id: Id }) {
		return (
			<ul class="kids">
				{bind(
					`${H(id)}/items`,
					(order) => (Array.isArray(order) ? order : []).map((k) => <Item key={k} id={k} />),
				)}
			</ul>
		)
	}
	// its inline views (a side one is drawn beside the document)
	function Views({ id }: { id: Id }) {
		return (
			<div class="views">
				{bind(`${H(id)}/views`, (order) =>
					(Array.isArray(order) ? order : []).map((v) => (
						<div key={v}>
							{bind(H(v), (spec) => (!spec || spec.where === "side"
								? null
								: <ViewBox view={v} item={id} spec={spec} />))}
						</div>
					)))}
			</div>
		)
	}
	function Row({ id, title }: { id: Id; title?: boolean }) {
		const e = H(id)
		return (
			<div
				class="row"
				onPointerEnter={handler("on/hover", ["item", id, "outline"])}
				onPointerLeave={handler("on/hover", [null])}
			>
				{!title && <span class="tog" title="fold (⌘.)" onClick={handler("on/fold", [id])} />}
				{!title && (
					<span
						class="bullet"
						title="drag to move"
						onPointerDown={(ev) => drag(ev, id)}
					/>
				)}
				<div class="body">
					<div class="disp" onMouseDown={handler("on/focus", (ev) => caretFrom(ev, id))}>
						{bind(e, (v) => display(id, v))}
					</div>
					<div class="ed">
						<div class="back" aria-hidden="true">
							{bind(e, (v) => highlight(String(v?.text ?? "")))}
						</div>
						<textarea
							data-ed={id}
							rows={1}
							spellcheck={false}
							value={bind(e, (v) => String(v?.text ?? ""))}
							onInput={handler(
								"on/text",
								(ev) => [id, ev.target.value, ev.target.selectionStart],
							)}
							onKeyDown={handler("on/key", (ev) => keys(ev, id))}
							onKeyUp={handler(
								"on/text",
								(ev) => (/^Arrow(Left|Right)$|^Home$|^End$/.test(ev.key)
									? [id, ev.target.value, ev.target.selectionStart]
									: undefined),
							)}
							onBlur={handler("on/blurred", [id])}
						/>
					</div>
				</div>
				{!title && (
					<span
						class="tools"
						onMouseDown={(ev) => ev.preventDefault()}
					>
						{bind(e, (v) =>
							parseLine(String(v?.text ?? "")).formula !== undefined
								? (
									<button
										title="repeat this formula wherever the outline has the same shape"
										onClick={handler("on/repeat", [id])}
									>
										⟳
									</button>
								)
								: null)}
						<button
							title="a map of this item and everything under it"
							onClick={handler("on/view", [id, "map"])}
						>
							🗺
						</button>
						<button title="a calendar of it" onClick={handler("on/view", [id, "calendar"])}>
							📅
						</button>
						<button
							title="a table of its items and their properties"
							onClick={handler("on/view", [id, "table"])}
						>
							▦
						</button>
						<button
							class="x"
							title="delete it and everything under it"
							onClick={handler("on/remove", [id])}
						>
							✕
						</button>
					</span>
				)}
			</div>
		)
	}
	// the menu as the effect last saw it: the editor's keys are read with nothing open, so no node is
	let menuNow: any = null
	createEffect("menu-copy", () => read(menuE), (m) => void (menuNow = m))
	let cardNow: any = null
	createEffect("card-copy", () => read(cardE), (c) => void (cardNow = c))
	// the editor lost the caret: a moment later, unless an editor for the same item has it again (a
	// move or an indent draws the row anew: the old textarea goes, and the browser says blur). the
	// blur is a node, a memo gives it 150ms later (a promise), and an effect checks the page
	let blurN = 0
	method("on/blurred", (id: Id) => put(blurE, { id, n: ++blurN }))
	const blurring = createMemo("blurring", () => {
		const b = read(blurE) as { id: Id; n: number } | null
		return b ? new Promise<{ id: Id; n: number }>((done) => setTimeout(() => done(b), 150)) : null
	})
	createEffect("blurred", () => read(blurring), (b) => {
		if (!b) return
		const id = b.id
		const ta = document.querySelector(`textarea[data-ed="${id}"]`)
		if (ta && document.activeElement === ta) return
		if (document.activeElement?.closest?.(".menu, .tray, .card")) return
		peep(() => {
			if ((read(focusE) as any)?.id === id) (put(focusE, null), put(menuE, null))
		})
	})
	// a key in the editor: the ones the outline takes (the default prevented), else none
	function keys(ev: KeyboardEvent, id: Id) {
		const ta = ev.target as HTMLTextAreaElement
		const at = ta.selectionStart, end = ta.selectionEnd, text = ta.value
		const take = (...args: unknown[]) => (ev.preventDefault(), [id, ...args])
		if ((menuNow as any)?.id === id) {
			if (ev.key === "ArrowDown") return take("menu-down")
			if (ev.key === "ArrowUp") return take("menu-up")
			if (ev.key === "Enter" || ev.key === "Tab") return take("menu-pick")
			if (ev.key === "Escape") return take("menu-close")
		}
		if (ev.isComposing) return
		if (ev.key === "Enter" && !ev.shiftKey) return take("enter", at, text)
		if (ev.key === "Tab") return take(ev.shiftKey ? "outdent" : "indent", at)
		if (ev.key === "Backspace" && at === 0 && end === 0) return take("back", at, text)
		if (
			(ev.key === "ArrowUp" || ev.key === "ArrowDown") && ev.shiftKey &&
			(ev.altKey || ev.metaKey)
		) {
			return take(ev.key === "ArrowUp" ? "move-up" : "move-down", at)
		}
		if (ev.key === "ArrowUp" && (at === 0 || oneLine(ta))) return take("up", at)
		if (ev.key === "ArrowDown" && (at === text.length || oneLine(ta))) return take("down", at)
		if (ev.key === "." && (ev.metaKey || ev.ctrlKey)) return take("fold")
		if (ev.key === "Escape") return take("esc")
	}
	// where a click in the shown text puts the caret: the piece it hit and the offset in it
	function caretFrom(ev: MouseEvent, id: Id) {
		if ((ev.target as HTMLElement).closest(".chip, .result, .swatch, button")) return
		ev.preventDefault()
		const pos = (document as any).caretPositionFromPoint?.(ev.clientX, ev.clientY)
		const node: Node | undefined = pos?.offsetNode ??
			(document as any).caretRangeFromPoint?.(ev.clientX, ev.clientY)?.startContainer
		const off: number = pos?.offset ??
			(document as any).caretRangeFromPoint?.(ev.clientX, ev.clientY)?.startOffset ?? 0
		const seg = (node?.nodeType === 3 ? node.parentElement : node as HTMLElement)?.closest?.(
			"[data-at]",
		) as HTMLElement | null
		if (!seg) return [id]
		const base = Number(seg.dataset.at)
		return [id, base + (node?.nodeType === 3 && seg.classList.contains("tx") ? off : 0)]
	}

	// ---- drag a bullet: a line shows where it goes (after a row, at a depth by the pointer) ----
	// a drag goes on past the element it started on: the outline's root keeps the pointer (capture)
	// and says each move and the end (a plain listener has nothing open to call an action from)
	type Gesture = {
		move?: (e: PointerEvent) => void
		up: (e: PointerEvent) => unknown[] | undefined
	}
	let gesture: Gesture | undefined
	let root: HTMLElement | undefined
	const hold = (down: PointerEvent, g: Gesture) => {
		gesture = g
		try {
			root?.setPointerCapture(down.pointerId)
		} catch { /* a script's pointer */ }
	}
	let dragging: { id: Id; line: HTMLElement; target?: { parent: Id; index: number } } | undefined
	function drag(down: PointerEvent, id: Id) {
		down.preventDefault()
		const outline = (down.target as HTMLElement).closest(".doc") as HTMLElement
		const line = outline.appendChild(document.createElement("div"))
		line.className = "dropline"
		dragging = { id, line }
		const li = (down.target as HTMLElement).closest("li.it")!
		li.classList.add("dragged")
		const rows = [...outline.querySelectorAll<HTMLElement>("li.it")].filter((r) =>
			r.offsetParent && !li.contains(r)
		)
		const depth = (r: Element) => {
			let n = 0
			for (let a = r.parentElement; a && a !== outline; a = a.parentElement) {
				if (a.matches("li.it")) n++
			}
			return n
		}
		// the gap the pointer is in: after the last row whose middle is above it. how deep it goes
		// is the pointer's x, a step (24px) per level, between the row below's depth (it must stay
		// where it is) and one deeper than the row above (its first item)
		const parentOf = (r: Element) =>
			(r.parentElement?.closest("li.it, .title") as HTMLElement)?.dataset.id ?? doc.id
		const move = (ev: PointerEvent) => {
			const box = outline.getBoundingClientRect()
			let at = -1
			for (const [i, r] of rows.entries()) {
				const rb = r.querySelector(".row")!.getBoundingClientRect()
				if (rb.top + rb.height / 2 < ev.clientY) at = i
			}
			const after = at >= 0 ? rows[at] : undefined
			const next = rows[at + 1]
			let parent: Id = doc.id, index = 0, d = 0, left: number, top: number
			if (!after) {
				const first = outline.querySelector(".outline")!.getBoundingClientRect()
				left = first.left, top = first.top
			} else {
				const row = after.querySelector(".row")!.getBoundingClientRect()
				const ad = depth(after)
				const most = ad + (after.classList.contains("shut") ? 0 : 1)
				const least = next ? Math.min(depth(next), most) : 0
				d = Math.max(least, Math.min(most, ad + Math.round((ev.clientX - row.left - 12) / 24)))
				if (d === ad + 1) parent = after.dataset.id!, index = 0
				else {
					// the row above's ancestor at that depth: it goes right after it
					let a: Element = after
					for (let k = ad; k > d; k--) a = a.parentElement!.closest("li.it")!
					parent = parentOf(a)
					index = [...a.parentElement!.children].filter((c) => c.matches("li.it")).indexOf(a) +
						1
				}
				left = row.left + (d - ad) * 24, top = row.bottom
			}
			dragging!.target = { parent, index }
			line.style.top = `${top - box.top + outline.scrollTop - 1}px`
			line.style.left = `${left - box.left}px`
		}
		const up = () => {
			li.classList.remove("dragged")
			line.remove()
			const target = dragging?.target
			dragging = undefined
			if (target) return ["move", id, target.parent, target.index]
		}
		hold(down, { move, up })
	}

	// ---- a view: its header, then the map, calendar or table drawn from its data node ----
	function ViewBox({ view, item, spec }: { view: Id; item: Id; spec: View }) {
		const data = memoAt("data", view)
		return (
			<section class={`view ${spec.kind} ${spec.where}`} data-view={view}>
				<header class="vh">
					<span class="vk">{VIEWICON[spec.kind]} {spec.kind}</span>
					<span class="of">
						of “{bind(H(item), (v) => plain(String(v?.text ?? "")) || "…")}”
					</span>
					<span class="vstat">{bind(data, (d) => viewStatus(d))}</span>
					<span class="fill" />
					<button
						title={spec.where === "side"
							? "show it inline, under its item"
							: "show it beside the document"}
						onClick={handler("on/viewwhere", [
							view,
							spec.where === "side" ? "inline" : "side",
						])}
					>
						{spec.where === "side" ? "⇤ inline" : "side ⇥"}
					</button>
					<button
						class="x"
						title="take this view away (its item stays)"
						onClick={handler("on/unview", [view])}
					>
						✕
					</button>
				</header>
				{spec.kind === "map"
					? (
						<div
							class="mapbox"
							data-markers={bind(data, (d) => String(d?.markers?.length ?? 0))}
						>
							<div
								class="mapevents"
								onPointerDown={onStage(mapFor(view).down)}
								onPointerMove={onStage(mapFor(view).move)}
								onPointerLeave={onStage(mapFor(view).leave)}
								onPointerUp={onStage(mapFor(view).up)}
								onWheel={onStage(mapFor(view).wheel)}
								onDblClick={onStage(mapFor(view).dblclick)}
								onClick={onStage(mapFor(view).click)}
							>
								{mapFor(view).wrap}
							</div>
						</div>
					)
					: spec.kind === "calendar"
					? <div class="calbox">{bind(data, (d) => calendar(d))}</div>
					: <div class="tablebox">{bind(data, (d) => tableView(d))}</div>}
			</section>
		)
	}
	function viewStatus(d: any) {
		if (!d) return ""
		const out: any[] = []
		if (d.kind === "map") out.push(`${d.markers.length} places · ${d.routes.length} routes`)
		if (d.kind === "calendar") out.push(`${d.days.length} days`)
		if (d.kind === "table") out.push(`${d.rows.length} rows`)
		if (d.waiting?.length) out.push(<span class="wait">◌ finding {d.waiting.join(", ")}</span>)
		for (const f of d.failed ?? []) out.push(<span class="bad" title={f.error}>⚠ {f.name}</span>)
		return out
	}
	function calendar(d: any) {
		if (!d) return null
		if (!d.days.length) {
			return <p class="empty">no dates under here: mention one with @ (a day, like @Fri…)</p>
		}
		const H = 34, hours = Array.from({ length: d.to - d.from }, (_, i) => d.from + i)
		return (
			<div class="cal" style={`--n:${d.days.length}`}>
				<div class="ch">
					<span />
					{d.days.map((day: any) => (
						<div class="dh">
							<b>{day.label}</b>
							<small>{day.weather ? day.weather.preview : ""}</small>
						</div>
					))}
				</div>
				<div class="cb" style={`height:${hours.length * H}px`}>
					<div class="hrs">
						{hours.map((h) => (
							<div class="hr" style={`height:${H}px`}>{String(h).padStart(2, "0")}:00</div>
						))}
					</div>
					{d.days.map((day: any) => (
						<div class="day" data-iso={day.iso}>
							{hours.map((h) => {
								const p = day.weather?.rain?.[h]
								return (
									<div
										class="slot"
										style={`height:${H}px;--a:${
											!p ? 0 : (0.07 + 0.55 * p / 100).toFixed(3)
										}`}
										title={p === undefined
											? ""
											: `${h}:00 · ${p}% chance of rain · ${
												Math.round(day.weather.temp[h])
											}°`}
									>
										{p !== undefined && p >= 10 ? <i>{p}%</i> : null}
									</div>
								)
							})}
							{lanes(day.events).map(({ e, lane, of }) => (
								<div
									class={`ev ${e.kind}`}
									data-id={e.id}
									style={`top:${((e.start - d.from * 60) / 60) * H}px;height:${
										Math.max(18, ((e.end - e.start) / 60) * H - 2)
									}px;` +
										`left:${(lane / of) * 100}%;width:${100 / of}%;--c:${e.color}`}
									title={`${hhmm(e.start)}${
										e.open ? "" : "–" + hhmm(e.end)
									} ${e.title} · drag to move it, its line moves too`}
									onPointerDown={(ev) => dragEvent(ev, e, H)}
									onPointerEnter={handler("on/hover", ["item", e.id, "calendar"])}
									onPointerLeave={handler("on/hover", [null])}
								>
									<b>{hhmm(e.start)}</b> {e.title}
								</div>
							))}
						</div>
					))}
				</div>
			</div>
		)
	}
	// an event dragged up or down: its time moves by quarter hours, written to its line
	function dragEvent(down: PointerEvent, e: any, H: number) {
		down.preventDefault()
		const el = down.currentTarget as HTMLElement
		const top0 = parseFloat(el.style.top)
		let by = 0
		const move = (ev: PointerEvent) => {
			by = Math.round(((ev.clientY - down.clientY) / H) * 4) * 15
			el.style.top = `${top0 + (by / 60) * H}px`
			el.classList.add("moving")
		}
		const up = () => {
			el.classList.remove("moving")
			if (by) {
				return [
					"time",
					e.id,
					Math.max(0, e.start + by),
					e.open ? undefined : Math.min(24 * 60, e.end + by),
				]
			}
		}
		hold(down, { move, up })
	}
	function tableView(d: any) {
		if (!d) return null
		if (!d.rows.length) return <p class="empty">no items under here yet</p>
		return (
			<table class="tbl">
				<thead>
					<tr>
						<th>item</th>
						{d.cols.map((c: string) => <th>{c}</th>)}
						<th>where (OpenStreetMap)</th>
					</tr>
				</thead>
				<tbody>
					{d.rows.map((r: any) => (
						<tr
							data-id={r.id}
							onPointerEnter={handler("on/hover", ["item", r.id, "table"])}
							onPointerLeave={handler("on/hover", [null])}
						>
							<td class="ti">{r.title}</td>
							{d.cols.map((c: string) => {
								const cell = r.cells[c]
								if (cell?.formula) return <td class="fxc">{cell.text}</td>
								return (
									<td>
										<input
											value={cell?.text ?? ""}
											placeholder="…"
											spellcheck={false}
											onChange={handler("on/cell", (ev) => [r.id, c, ev.target.value])}
										/>
									</td>
								)
							})}
							<td class="wh">
								{r.where
									? (
										<span>
											{r.where.address}
											{r.where.hours ? <small>· {r.where.hours}</small> : null}
										</span>
									)
									: ""}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		)
	}

	// ---- the map: a canvas per map view, drawn from its data, OpenStreetMap's tiles under it ----
	const tiles = new Map<string, { img: HTMLImageElement; ok?: boolean; bad?: boolean }>()
	const maps = new Map<Id, ReturnType<typeof makeMap>>()
	addTeardown(() => maps.forEach((m) => m.stop()))
	function mapFor(view: Id) {
		if (!maps.has(view)) maps.set(view, makeMap(view))
		return maps.get(view)!
	}
	function makeMap(view: Id) {
		const wrap = document.createElement("div")
		wrap.className = "mapwrap"
		const canvas = wrap.appendChild(document.createElement("canvas"))
		const ctl = wrap.appendChild(document.createElement("div"))
		ctl.className = "mapctl"
		const attrib = wrap.appendChild(document.createElement("div"))
		attrib.className = "attrib"
		attrib.innerHTML =
			'map © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
		const note = wrap.appendChild(document.createElement("div"))
		note.className = "mapnote"
		let state: any = {}
		let cam: Cam | undefined
		let user = false
		let hover: { place?: Id; route?: Id } = {}
		let frame = 0
		const redraw = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(draw)
		}
		// the buttons are heard with the rest of the map's events (below): each says what it is
		const button = (label: string, title: string, act: string) => {
			const b = ctl.appendChild(document.createElement("button"))
			b.textContent = label
			b.title = title
			b.dataset.act = act
		}
		button("+", "zoom in", "in")
		button("−", "zoom out", "out")
		button("⤢", "fit everything (forget where you moved it)", "fit")
		const size = () => [canvas.clientWidth, canvas.clientHeight] as const
		function fit(): Cam {
			const pts: [number, number][] = [
				...(state.data?.markers ?? []).map((m: any) => [m.lat, m.lon]),
				...(state.data?.routes ?? []).flatMap((r: any) => r.path ?? []),
			]
			if (!pts.length) return { lat: 55.953, lon: -3.19, z: 12 }
			const [w, h] = size()
			const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1])
			const n = Math.max(...lats),
				s = Math.min(...lats),
				e = Math.max(...lons),
				wst = Math.min(...lons)
			const dx = mx(e, 0) - mx(wst, 0), dy = my(s, 0) - my(n, 0)
			const z = Math.min(
				16,
				Math.log2(Math.max(1, w - 70) / Math.max(dx, 1e-9)),
				Math.log2(Math.max(1, h - 70) / Math.max(dy, 1e-9)),
			)
			const cx = (mx(e, 0) + mx(wst, 0)) / 2, cy = (my(s, 0) + my(n, 0)) / 2
			return {
				lon: ux(cx, 0),
				lat: uy(cy, 0),
				z: pts.length === 1 ? 15 : Math.max(3, Math.floor(z * 4) / 4),
			}
		}
		function camera(): Cam {
			if (!cam) cam = state.view?.camera ?? fit()
			return cam!
		}
		function zoom(by: number, at?: [number, number]) {
			const c = camera(), [w, h] = size()
			const p = at ?? [w / 2, h / 2]
			const z = Math.max(3, Math.min(18, c.z + by))
			// the point under the pointer stays there
			const x = mx(c.lon, c.z) + p[0] - w / 2, y = my(c.lat, c.z) + p[1] - h / 2
			const lon = ux(x, c.z), lat = uy(y, c.z)
			const k = 2 ** (z - c.z)
			cam = {
				z,
				lon: ux(mx(lon, z) - (p[0] - w / 2), z),
				lat: uy(my(lat, z) - (p[1] - h / 2), z),
			}
			void k
			user = true
			redraw()
		}
		// the camera is kept at once (it was after half a second without a move: a timer cannot call)
		const keepCamera = () => ["camera", view, cam]
		function tile(z: number, x: number, y: number) {
			const k = `${z}/${x}/${y}`
			let it = tiles.get(k)
			if (!it) {
				const img = new Image()
				it = { img }
				tiles.set(k, it)
				img.onload = () => ((it!.ok = true), maps.forEach((m) => m.redraw()))
				img.onerror = () => ((it!.bad = true), maps.forEach((m) => m.redraw()))
				img.src = `https://tile.openstreetmap.org/${k}.png`
				if (tiles.size > 600) tiles.delete(tiles.keys().next().value!)
			}
			return it
		}
		function project(c: Cam, lat: number, lon: number) {
			const [w, h] = size()
			return [mx(lon, c.z) - mx(c.lon, c.z) + w / 2, my(lat, c.z) - my(c.lat, c.z) + h / 2]
		}
		function draw() {
			const [w, h] = size()
			if (!w || !h) return
			const dpr = devicePixelRatio || 1
			if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
				canvas.width = Math.round(w * dpr)
				canvas.height = Math.round(h * dpr)
			}
			const g = canvas.getContext("2d")!
			g.setTransform(dpr, 0, 0, dpr, 0, 0)
			g.fillStyle = "#fffbe0"
			g.fillRect(0, 0, w, h)
			const c = camera()
			const zi = Math.max(0, Math.min(19, Math.round(c.z)))
			const ts = 256 * 2 ** (c.z - zi)
			const x0 = mx(c.lon, c.z) - w / 2, y0 = my(c.lat, c.z) - h / 2
			const n = 2 ** zi
			let bad = 0
			g.save()
			g.filter = "grayscale(1) contrast(1.05) brightness(1.04)"
			for (let tx = Math.floor(x0 / ts); tx <= Math.floor((x0 + w) / ts); tx++) {
				for (let ty = Math.floor(y0 / ts); ty <= Math.floor((y0 + h) / ts); ty++) {
					if (ty < 0 || ty >= n) continue
					const it = tile(zi, ((tx % n) + n) % n, ty)
					const px = tx * ts - x0, py = ty * ts - y0
					if (it.ok) g.drawImage(it.img, px, py, ts + 0.5, ts + 0.5)
					else {
						if (it.bad) bad++
						g.strokeStyle = "#0000000f"
						g.strokeRect(px, py, ts, ts)
					}
				}
			}
			g.restore()
			// lemon paper: the grey map multiplied with the page's yellow
			g.globalCompositeOperation = "multiply"
			g.fillStyle = "#fff59a"
			g.fillRect(0, 0, w, h)
			g.globalCompositeOperation = "source-over"
			note.textContent = bad
				? "map tiles can not be reached: offline? the places and routes are still here"
				: ""
			const lit = state.lit ?? {}
			const litPlaces = new Set(lit.places ?? []), litRoutes = new Set(lit.routes ?? [])
			// routes: driving solid, walking dotted, cycling dashed, each in its item's colour
			for (const r of state.data?.routes ?? []) {
				const on = litRoutes.has(r.id) || hover.route === r.id
				const pts = (r.path ?? []).map(([la, lo]: number[]) => project(c, la, lo))
				if (pts.length < 2) continue
				const path = () => {
					g.beginPath()
					pts.forEach(([x, y]: number[], i: number) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
				}
				g.lineCap = "round"
				g.lineJoin = "round"
				g.setLineDash([])
				path()
				g.strokeStyle = "#000"
				g.lineWidth = on ? 9 : 6.5
				if (r.mode !== "car") g.setLineDash(r.mode === "foot" ? [0.1, 9] : [10, 7])
				g.stroke()
				path()
				g.strokeStyle = r.color === "#000000" ? "#ffffff" : r.color
				g.lineWidth = on ? 6 : 3.8
				g.stroke()
				g.setLineDash([])
			}
			// places: a white disc, its colour around it, its icon in it
			const ms = [...(state.data?.markers ?? [])].sort((a: any, b: any) =>
				Number(litPlaces.has(a.id)) - Number(litPlaces.has(b.id))
			) // where each was drawn, for whoever asks the canvas (a test, the inspector's console)
			;(canvas as any).drawn = ms.map((m: any) => ({
				id: m.id,
				name: m.name,
				at: project(c, m.lat, m.lon),
			}))
			for (const m of ms) {
				const [x, y] = project(c, m.lat, m.lon)
				if (x < -30 || y < -30 || x > w + 30 || y > h + 30) continue
				const on = litPlaces.has(m.id) || hover.place === m.id
				const r = on ? 16 : 12.5
				if (on) {
					g.fillStyle = "#ff228455"
					g.beginPath()
					g.arc(x, y, r + 9, 0, Math.PI * 2)
					g.fill()
				}
				g.beginPath()
				g.arc(x, y, r, 0, Math.PI * 2)
				g.fillStyle = "#fff"
				g.fill()
				g.lineWidth = 3.5
				g.strokeStyle = m.color === "#000000" ? "#000" : m.color
				g.stroke()
				g.beginPath()
				g.arc(x, y, r + 1.8, 0, Math.PI * 2)
				g.lineWidth = 1
				g.strokeStyle = "#000"
				g.stroke()
				g.font = `${on ? 16 : 13}px system-ui, "Apple Color Emoji", sans-serif`
				g.textAlign = "center"
				g.textBaseline = "middle"
				g.fillStyle = "#000"
				g.fillText(m.icon, x, y + 1)
				if (on || c.z >= 15.5 || ms.length <= 4) {
					g.font = "600 12px Jost, system-ui, sans-serif"
					g.lineWidth = 3.5
					g.strokeStyle = "#fffef4"
					g.strokeText(m.name, x, y + r + 11)
					g.fillText(m.name, x, y + r + 11)
				}
			}
		}
		// the pointer: drag pans, the wheel zooms, a place under it lights the outline
		let pan: { x: number; y: number; cam: Cam; moved: boolean } | undefined
		const hit = (ev: PointerEvent | MouseEvent) => {
			const r = canvas.getBoundingClientRect()
			const p = [ev.clientX - r.left, ev.clientY - r.top]
			const c = camera()
			let best: any, d = 18
			for (const m of state.data?.markers ?? []) {
				const [x, y] = project(c, m.lat, m.lon)
				const k = Math.hypot(x - p[0], y - p[1])
				if (k < d) (d = k, best = { place: m.id, items: m.items })
			}
			if (best) return best
			for (const rt of state.data?.routes ?? []) {
				const pts = (rt.path ?? []).map(([la, lo]: number[]) => project(c, la, lo))
				for (let i = 1; i < pts.length; i++) {
					if (segment(p, pts[i - 1], pts[i]) < 6) return { route: rt.id }
				}
			}
			return {}
		}
		// the map's events are heard on the element round it (nothing is open in a plain listener to
		// call an action from): each says the call it makes, or none
		const down = (ev: PointerEvent) => {
			if (ev.target !== canvas) return
			canvas.setPointerCapture(ev.pointerId)
			pan = { x: ev.clientX, y: ev.clientY, cam: { ...camera() }, moved: false }
		}
		const move = (ev: PointerEvent) => {
			if (pan) {
				const dx = ev.clientX - pan.x, dy = ev.clientY - pan.y
				if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true
				if (!pan.moved) return
				const z = pan.cam.z
				cam = { z, lon: ux(mx(pan.cam.lon, z) - dx, z), lat: uy(my(pan.cam.lat, z) - dy, z) }
				user = true
				return void redraw()
			}
			if (ev.target !== canvas) return
			const h = hit(ev)
			if (h.place === hover.place && h.route === hover.route) return
			hover = h
			canvas.style.cursor = h.place || h.route ? "pointer" : "grab"
			redraw()
			if (h.place) return ["hover", "place", h.place, "map"]
			else if (h.route) return ["hover", "formula", h.route, "map"]
			return ["hover", null]
		}
		const leave = () => {
			if (!hover.place && !hover.route) return
			hover = {}
			redraw()
			return ["hover", null]
		}
		const up = (ev: PointerEvent) => {
			const was = pan
			pan = undefined
			if (was?.moved) return keepCamera()
			if (ev.target !== canvas) return
			const h = hit(ev)
			if (h.place) {
				const app = document.querySelector(".embark")!.getBoundingClientRect()
				return [
					"pin",
					h.place,
					ev.clientX - app.left + 8,
					ev.clientY - app.top + 8,
					h.items?.[0],
				]
			} else if (h.route) return ["select", h.route]
		}
		const wheel = (ev: WheelEvent) => {
			if (ev.target !== canvas) return
			ev.preventDefault()
			const r = canvas.getBoundingClientRect()
			zoom(-Math.sign(ev.deltaY) * 0.5, [ev.clientX - r.left, ev.clientY - r.top])
			return keepCamera()
		}
		const dblclick = (ev: MouseEvent) => {
			if (ev.target !== canvas) return
			const r = canvas.getBoundingClientRect()
			zoom(1, [ev.clientX - r.left, ev.clientY - r.top])
			return keepCamera()
		}
		const click = (ev: MouseEvent) => {
			const b = (ev.target as HTMLElement).closest("button")
			if (!b || !ctl.contains(b)) return
			if (b.dataset.act === "fit") {
				user = false
				cam = undefined
				redraw()
				return ["camera", view, null]
			}
			zoom(b.dataset.act === "in" ? 1 : -1)
			return keepCamera()
		}
		const sizes = new ResizeObserver(() => redraw())
		sizes.observe(canvas)
		return {
			wrap,
			redraw,
			down,
			move,
			leave,
			up,
			wheel,
			dblclick,
			click,
			// new data, lit or camera: the camera fits again, unless someone moved it
			set(v: any) {
				const before = state.data
				state = v
				if (v.view?.camera) {
					if (!user) cam = v.view.camera
				} else if (!user || !before) cam = undefined
				if (
					!v.view?.camera &&
					JSON.stringify(before?.markers?.map((m: any) => m.id)) !==
						JSON.stringify(v.data?.markers?.map((m: any) => m.id))
				) {
					user = false
					cam = undefined
				}
				redraw()
			},
			stop: () => (sizes.disconnect(), cancelAnimationFrame(frame)),
		}
	}

	// ---- the side: views beside the document, the places outline, the network ----
	function Side() {
		return (
			<aside class="side">
				{bind(IX, (x) =>
					(x?.views ?? []).filter((v: any) =>
						v.where === "side"
					).map((v: any) => (
						<div key={v.view}>
							{bind(
								H(v.view),
								(spec) => spec ? <ViewBox view={v.view} item={v.item} spec={spec} /> : null,
							)}
						</div>
					)))}
				<section class="panel places">
					<header class="vh">
						<span class="vk">📍 places</span>
						<span class="of">the other outline: what @ made, from OpenStreetMap</span>
					</header>
					<ul class="plist">{under(H(placesE.id), (p) => <PlaceRow item={p} />)}</ul>
				</section>
				<section class="panel net">
					<header class="vh">
						<span class="vk">🌐 network</span>
						<span class="of">every lookup is a node in /cache</span>
					</header>
					{bind("/net", (n) => netView(n))}
				</section>
			</aside>
		)
	}
	function PlaceRow({ item }: { item: any }) {
		const id = `place:${item.name}` as Id
		return (
			<li
				class="prow"
				data-place={id}
				onPointerEnter={handler("on/hover", ["place", id, "places"])}
				onPointerLeave={handler("on/hover", [null])}
			>
				<div class="ptop">
					<PlaceChip label={item.name} />
					<button
						class="addprop"
						title="a property of this place (icon: the map draws it)"
						onClick={handler("on/prop", [id])}
					>
						+ property
					</button>
					<span class="pcount">
						{bind(IX, (x) => {
							const n = x?.mentions?.[id]?.length ?? 0
							return n
								? `mentioned ${n}×`
								: (
									<button class="mini" onClick={handler("on/forget", [id])}>
										not mentioned: forget it
									</button>
								)
						})}
					</span>
				</div>
				<div class="pgeo">
					{bind(memoAt("geo", id), (v) =>
						v?.error !== undefined
							? (
								<span class="bad">
									⚠ {v.error}{" "}
									<button class="mini" onClick={handler("on/retry")}>retry</button>
								</span>
							)
							: v
							? `${v.type.replace(/_/g, " ")} · ${short(v.display)}${
								v.hours ? " · " + v.hours : ""
							}`
							: "")}
				</div>
				<Kids id={id} />
			</li>
		)
	}
	function netView(n: any) {
		if (!n) return null
		const waiting = Object.entries(n.waiting ?? {}).filter(([, k]) => (k as number) > 0)
		return (
			<div class="netbody">
				<div class="nstats">
					<span
						class="tag mint"
						title="answers already here: committed with this example (seed.json), saved in this browser, or fetched now"
					>
						kept {n.kept.seed} seed · {n.kept.saved} saved · {n.kept.live} new
					</span>
					<span class="tag" title="runs that found their answer in /cache">{n.hits} hits</span>
					<span class="tag" title="asked of the network">{n.requests} requests</span>
					{n.failed
						? (
							<span class="tag bad">
								{n.failed} failed{" "}
								<button class="mini" onClick={handler("on/retry")}>retry</button>
							</span>
						)
						: null}
					{waiting.map(([server, k]) => (
						<span class="tag wait">◌ {String(k)} waiting for {server}</span>
					))}
				</div>
				<ol class="recent">
					{(n.recent ?? []).slice(0, 6).map((r: any) => (
						<li class={r.error ? "bad" : ""} title={r.url}>
							{r.error ? "⚠" : "✓"} {r.api} · {r.error ? r.error : `${r.ms} ms`} ·{" "}
							<code>{r.key.slice(0, 8)}</code>
						</li>
					))}
				</ol>
				<p class="credit">
					places:{" "}
					<a href="https://nominatim.openstreetmap.org/" target="_blank">Nominatim</a>, data ©
					{" "}
					<a href="https://www.openstreetmap.org/copyright" target="_blank">
						OpenStreetMap contributors
					</a>{" "}
					(ODbL) · driving: the <a href="https://project-osrm.org/" target="_blank">OSRM</a>
					{" "}
					demo server · walking and cycling: OSRM at{" "}
					<a href="https://routing.openstreetmap.de/" target="_blank">FOSSGIS</a> · weather:
					{" "}
					<a href="https://open-meteo.com/" target="_blank">Open-Meteo.com</a>{" "}
					(CC BY 4.0) · tiles © OpenStreetMap
				</p>
			</div>
		)
	}

	// ---- the menu, the tray, the card, the toast, the help ----
	function menuView(list: any) {
		if (!list?.entries) return null
		const ta = document.querySelector<HTMLTextAreaElement>(`textarea[data-ed="${list.id}"]`)
		const app = document.querySelector(".embark")
		if (!ta || !app) return null
		const r = ta.getBoundingClientRect(), a = app.getBoundingClientRect()
		return (
			<div
				class="menu"
				style={`left:${Math.max(4, Math.min(r.left - a.left, a.width - 380))}px;top:${
					r.bottom - a.top + 4
				}px`}
			>
				<div class="mh">
					{list.kind === "@" ? "@ a place or a date" : "/ a formula, a view, a property"}
					{list.query ? ` · “${list.query}”` : ""}
				</div>
				{list.entries.length ? null : <div class="mi none">nothing yet: keep typing</div>}
				{list.entries.map((e: any, i: number) => (
					<div
						class={`mi ${e.kind}${i === list.sel ? " sel" : ""}`}
						onMouseDown={(ev) => ev.preventDefault()}
						onClick={handler("on/pick", [i])}
					>
						<span class="mic">{e.icon}</span>
						<span class="mil">
							<b>{e.label}</b>
							{e.sub ? <small>{e.sub}</small> : null}
						</span>
						{e.preview
							? <span class="mip">{e.preview}</span>
							: e.pending
							? <span class="mip wait">◌</span>
							: e.error
							? <span class="mip bad" title={e.error}>⚠</span>
							: null}
					</div>
				))}
			</div>
		)
	}
	function trayView(s: any) {
		if (!s?.id || (!s.list?.length && !s.repeat?.length && !s.reads)) return null
		const reads = s.reads
		const x = ix()
		void x
		return (
			<div class="tray" data-for={s.id}>
				{s.list?.length
					? (
						<div class="tsec">
							<div class="th">✨ suggested</div>
							{s.list.map((c: any, i: number) => (
								<button
									class="sug"
									onMouseDown={(ev) => ev.preventDefault()}
									onClick={handler("on/suggest", [s.id, i])}
									title={`${c.name}: ${c.text}`}
								>
									<span class="sl">{FNS[c.fn]?.icon} {c.label}</span>
									<span class="sp">
										{c.preview ?? (c.pending ? "◌" : c.error ? "⚠ " + c.error : "")}
									</span>
								</button>
							))}
						</div>
					)
					: null}
				{s.repeat?.length
					? (
						<div class="tsec">
							<button
								class="sug rep"
								onMouseDown={(ev) => ev.preventDefault()}
								onClick={handler("on/repeat", [s.id])}
							>
								<span class="sl">⟳ repeat it</span>
								<span class="sp">under {s.repeat.map((r: any) => r.label).join(", ")}</span>
							</button>
						</div>
					)
					: null}
				{reads
					? (
						<div class="tsec reads">
							<div class="th">🧵 its last run read</div>
							<div class="rl">
								{reads.values.length}{" "}
								nodes{reads.keys.length ? ` · ${reads.keys.length} from /cache` : ""} · run
								{" "}
								{reads.run} · {reads.ended}
								{reads.ms !== undefined ? ` · ${reads.ms} ms` : ""}
							</div>
							{reads.keys.map((k: string) => <code class="ck">cache/{k.slice(0, 16)}</code>)}
						</div>
					)
					: null}
			</div>
		)
	}
	function cardView(c: any) {
		if (!c?.place) return null
		const id = c.place as Id
		return (
			<div
				class="card"
				style={`left:${Math.max(6, c.x ?? 0)}px;top:${c.y ?? 0}px`}
				onMouseDown={(ev) => ev.stopPropagation()}
			>
				<header>
					{bind(H(id), (v) => <b>{v?.name}</b>)}
					<span class="fill" />
					<button class="mini" onClick={handler("on/card", [null])}>✕</button>
				</header>
				<div class="cgeo">
					{bind(memoAt("geo", id), (v: any) =>
						v?.error !== undefined ? <p class="bad">⚠ {v.error}</p> : v
							? (
								<dl>
									<dt>location</dt>
									<dd>{v.lat.toFixed(5)}, {v.lon.toFixed(5)}</dd>
									<dt>type</dt>
									<dd>{typeIcon(v)} {v.type.replace(/_/g, " ")} ({v.category})</dd>
									<dt>address</dt>
									<dd>{v.display}</dd>
									{v.hours ? [<dt>hours</dt>, <dd>{v.hours}</dd>] : null}
									{v.website
										? [
											<dt>website</dt>,
											<dd>
												<a href={v.website} target="_blank">
													{v.website.replace(/^https?:\/\//, "")}
												</a>
											</dd>,
										]
										: null}
									<dt>source</dt>
									<dd>
										<a href={`https://www.openstreetmap.org/${v.osm}`} target="_blank">
											{v.osm}
										</a>{" "}
										via Nominatim
									</dd>
								</dl>
							)
							: null)}
				</div>
				<div class="cprops">
					<div class="th">its own properties (its items: the map reads icon)</div>
					<Kids id={id} />
					<button class="addprop" onClick={handler("on/prop", [id])}>+ property</button>
				</div>
			</div>
		)
	}

	return (
		<div
			class="embark"
			ref={(e) => (root = e as HTMLElement)}
			onMouseDown={handler("on/card", (ev: MouseEvent) => {
				if (!(ev.target as HTMLElement).closest(".card, .chip") && cardNow) return [null]
			})}
			onPointerMove={onStage((e) => gesture?.move?.(e))}
			onPointerUp={onStage((e) => {
				const g = gesture
				gesture = undefined
				return g?.up(e)
			})}
			onPointerCancel={onStage((e) => {
				const g = gesture
				gesture = undefined
				return g?.up(e)
			})}
		>
			<style>{LOOK}</style>
			<header class="bar">
				<span class="tag title">fancy-embark</span>
				<span class="lede">
					a trip as a dynamic document: <kbd>@</kbd> a place or a day · <kbd>/</kbd>{" "}
					a formula · <code>name: value</code> · views of any subtree
				</span>
				<span class="fill" />
				<button
					class={bind(H(threadsE.id), (v) => (v ? "on" : ""))}
					title="threads: hover a result to see what its run read"
					onClick={handler("on/threads")}
				>
					🧵 reads
				</button>
				<span class="netpill">
					{bind("/net", (n) => {
						const w = Object.values(n?.waiting ?? {}).reduce(
							(a: number, b) => a + (b as number),
							0,
						) as number
						return w
							? <span class="wait">◌ {w} lookups waiting</span>
							: n?.failed
							? <span class="bad">⚠ {n.failed} failed</span>
							: (
								<span>
									✓ {n?.kept ? n.kept.seed + n.kept.saved + n.kept.live : 0} answers kept
								</span>
							)
					})}
				</span>
				<button title="how it works" onClick={handler("on/help")}>?</button>
			</header>
			{bind(H(helpE.id), (v) => (v ? <Help /> : null))}
			<div class="cols">
				<main class="doc">
					{threads.svg}
					<div class="title it" data-id={doc.id}>
						<Row id={doc.id} title />
						<div class="views">
							<Views id={doc.id} />
						</div>
					</div>
					<div class="outline">
						<Kids id={doc.id} />
					</div>
					<button class="addrow" onClick={handler("on/add", [doc.id])}>+ an item</button>
					{bind("/embark/suggest", (s) => trayView(s))}
				</main>
				<Side />
			</div>
			{bind("/embark/menulist", (m) => menuView(m))}
			{bind(H(cardE.id), (c) => cardView(c))}
			{bind(
				H(toastE.id),
				(v) => (v ? <div class="toast" key={String(v.at)}>{v.text}</div> : null),
			)}
		</div>
	)
}

function Help() {
	return (
		<div class="help">
			<p>
				<b>Write</b>{" "}
				an outline: Enter makes an item, Tab and shift-Tab move it in and out, alt-shift-↑↓
				moves it, drag a bullet anywhere, ▸ folds. <b>@</b>{" "}
				mentions a place (looked up on OpenStreetMap) or a day. <b>name: value</b>{" "}
				is a property (color and icon change the map; hours shows on the calendar).{" "}
				<b>name: =Formula()</b>{" "}
				computes: Walk, Bike, Drive, Weather, Sun, Distance, Total, and + − × ÷ with names (a
				sibling, then the parent, then up). <b>/</b>{" "}
				offers formulas with previews, views and properties.
			</p>
			<p>
				Every item, place, date, result and lookup is a node: the graph tab shows them. A result
				is a compute part reading the nodes it names: pending in place while a lookup is out,
				then landing. Hover a result: its threads are what its last run read.
			</p>
		</div>
	)
}

// ---- text: properties, formulas, times, mentions ----
const TOKEN = /@\[([^\]\n]+)\]/g
function tokens(text: string) {
	const out: { label: string; start: number; end: number }[] = []
	for (const m of text.matchAll(TOKEN)) {
		out.push({ label: m[1], start: m.index!, end: m.index! + m[0].length })
	}
	return out
}
const PROP = /^(\s*)([A-Za-zÀ-ɏ][\wÀ-ɏ -]{0,24}?)\s*:(?!\/\/)\s*/
const TIME = /^(\d{1,2})[:.](\d{2})(?:\s*[–—-]\s*(\d{1,2})[:.](\d{2}))?/
function parseTime(s: string) {
	const m = TIME.exec(s.trim())
	if (!m) return undefined
	const start = +m[1] * 60 + +m[2]
	const end = m[3] !== undefined ? +m[3] * 60 + +m[4] : undefined
	if (start > 24 * 60 || (end !== undefined && end > 24 * 60)) return undefined
	return { start, end, length: m[0].length }
}
function parseLine(text = "") {
	const p = PROP.exec(text)
	const out: {
		name?: string
		nameEnd: number
		value: string
		valueAt: number
		formula?: string
		formulaAt: number
		time?: { start: number; end?: number }
		rest: string
		restAt: number
	} = { nameEnd: 0, value: text, valueAt: 0, formulaAt: 0, rest: text, restAt: 0 }
	if (p && !p[2].includes("@")) {
		out.name = p[2].trim()
		out.nameEnd = p[1].length + p[2].length
		out.value = text.slice(p[0].length)
		out.valueAt = p[0].length
	}
	const v = out.value
	const eq = /^\s*=/.exec(v)
	if (eq) {
		out.formula = v.slice(eq[0].length)
		out.formulaAt = out.valueAt + eq[0].length
		return out
	}
	if (!out.name) {
		const lead = /^\s*/.exec(text)![0].length
		const tm = parseTime(text.slice(lead))
		if (tm && /^(\s|$)/.test(text.slice(lead + tm.length))) {
			out.time = { start: tm.start, end: tm.end }
			const after = lead + tm.length
			const sp = /^\s*/.exec(text.slice(after))![0].length
			out.rest = text.slice(after + sp)
			out.restAt = after + sp
		}
	}
	return out
}
// what a reader sees: mentions as their names, no time in front
const plain = (text: string) =>
	text.replace(TOKEN, "$1").replace(/^\s*\d{1,2}[:.]\d{2}(\s*[–—-]\s*\d{1,2}[:.]\d{2})?\s*/, "")
		.trim()
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "_")
const hhmm = (m: number) =>
	`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`
function number(x: string): Extract<V, { t: "num" }> | undefined {
	let m = /^([£€$])\s*(-?\d+(?:\.\d+)?)$/.exec(x)
	if (m) return { t: "num", n: +m[2], unit: m[1] }
	m = /^(-?\d+(?:\.\d+)?)\s*(km|min|h|%|°|[£€$])?$/.exec(x)
	if (m) {
		return m[2] === "h"
			? { t: "num", n: +m[1] * 60, unit: "min" }
			: { t: "num", n: +m[1], unit: m[2] }
	}
	return undefined
}
// money in plain text gets a little colour
const money = (s: string) => s

// ---- the formula language: a small expression parser ----
type Ast =
	| { k: "num"; n: number; unit?: string }
	| { k: "str"; s: string }
	| { k: "mention"; label: string }
	| { k: "name"; name: string }
	| { k: "get"; of: Ast; name: string }
	| { k: "neg"; of: Ast }
	| { k: "bin"; op: string; a: Ast; b: Ast }
	| { k: "call"; fn: string; args: { name?: string; x: Ast }[] }
type Tok = { k: string; v: any; unit?: string; at: number }
function lex(src: string): Tok[] {
	const out: Tok[] = []
	let i = 0
	while (i < src.length) {
		const c = src[i]
		if (/\s/.test(c)) {
			i++
			continue
		}
		const rest = src.slice(i)
		let m: RegExpExecArray | null
		if (rest.startsWith("@[")) {
			const j = src.indexOf("]", i)
			if (j < 0) throw new SyntaxError("a mention is not closed: add ]")
			out.push({ k: "mention", v: src.slice(i + 2, j), at: i })
			i = j + 1
		} else if ((m = /^([£€$])\s*(\d+(?:\.\d+)?)/.exec(rest))) {
			out.push({ k: "num", v: +m[2], unit: m[1], at: i })
			i += m[0].length
		} else if ((m = /^(\d+(?:\.\d+)?)(?:\s?(km|min|h|%)(?![\w])|([£€$]))?/.exec(rest))) {
			const unit = m[2] ?? m[3]
			out.push({
				k: "num",
				v: unit === "h" ? +m[1] * 60 : +m[1],
				unit: unit === "h" ? "min" : unit,
				at: i,
			})
			i += m[0].length
		} else if ((m = /^["“']([^"”']*)["”']/.exec(rest))) {
			out.push({ k: "str", v: m[1], at: i })
			i += m[0].length
		} else if ((m = /^[A-Za-z_][\w]*/.exec(rest))) {
			out.push({ k: "id", v: m[0], at: i })
			i += m[0].length
		} else if ("()+-*/×÷,:.".includes(c)) {
			out.push({ k: "p", v: c === "×" ? "*" : c === "÷" ? "/" : c, at: i })
			i++
		} else throw new SyntaxError(`“${c}” is not part of a formula`)
	}
	return out
}
function parse(src: string): Ast {
	const toks = lex(src)
	let i = 0
	const peek = () => toks[i]
	const is = (v: string) => toks[i]?.k === "p" && toks[i].v === v
	const expect = (v: string, what: string) => {
		if (!is(v)) {
			throw new SyntaxError(
				`${what}: expected “${v}”${toks[i] ? ` before “${toks[i].v}”` : " at the end"}`,
			)
		}
		i++
	}
	function add(): Ast {
		let a = mul()
		while (is("+") || is("-")) {
			const op = toks[i++].v
			a = { k: "bin", op, a, b: mul() }
		}
		return a
	}
	function mul(): Ast {
		let a = unary()
		while (is("*") || is("/")) {
			const op = toks[i++].v
			a = { k: "bin", op, a, b: unary() }
		}
		return a
	}
	function unary(): Ast {
		if (is("-")) return (i++, { k: "neg", of: unary() })
		return post()
	}
	function post(): Ast {
		let a = prim()
		while (is(".")) {
			i++
			const t = toks[i++]
			if (t?.k !== "id") throw new SyntaxError("after a dot, a property name: route.distance")
			a = { k: "get", of: a, name: t.v }
		}
		return a
	}
	function prim(): Ast {
		const t = peek()
		if (!t) throw new SyntaxError("the formula ends too soon")
		if (t.k === "num") return (i++, { k: "num", n: t.v, unit: t.unit })
		if (t.k === "str") return (i++, { k: "str", s: t.v })
		if (t.k === "mention") return (i++, { k: "mention", label: t.v })
		if (is("(")) {
			i++
			const a = add()
			expect(")", "a bracket is open")
			return a
		}
		if (t.k === "id") {
			i++
			if (!is("(")) return { k: "name", name: t.v }
			i++
			const args: { name?: string; x: Ast }[] = []
			while (!is(")")) {
				if (!peek()) throw new SyntaxError(`${t.v}( is not closed: add )`)
				let name: string | undefined
				if (peek().k === "id" && toks[i + 1]?.k === "p" && toks[i + 1].v === ":") {
					name = toks[i].v
					i += 2
				}
				args.push({ name, x: add() })
				if (is(",")) i++
				else if (!is(")")) throw new SyntaxError(`${t.v}(…): a comma or ) next`)
			}
			i++
			return { k: "call", fn: t.v, args }
		}
		throw new SyntaxError(`“${t.v}” can not start a value`)
	}
	if (!toks.length) throw new SyntaxError("an empty formula: try =Walk(from: @…, to: @…)")
	const a = add()
	if (i < toks.length) throw new SyntaxError(`“${toks[i].v}” is left over`)
	return a
}
// a value with what a reader is shown
function finish(v: V): V {
	if (v.preview) return v
	return { ...v, preview: show(v) }
}
function show(v: V): string {
	switch (v.t) {
		case "num":
			return fmtNum(v)
		case "text":
			return v.s
		case "place":
			return `📍 ${v.name}`
		case "date":
			return `📅 ${v.label}`
		case "item":
			return `“${v.name}”`
		case "rec":
			return v.preview
	}
}
function fmtNum(v: { n: number; unit?: string }) {
	if (v.unit === "£" || v.unit === "€" || v.unit === "$") {
		return `${v.n < 0 ? "-" : ""}${v.unit}${Math.abs(v.n).toFixed(2)}`
	}
	if (v.unit === "km") return fmtKm(v.n)
	if (v.unit === "min") return fmtMin(v.n)
	const n = Math.abs(v.n) >= 100 ? Math.round(v.n) : +v.n.toFixed(2)
	return `${n}${v.unit === "%" || v.unit === "°" ? v.unit : v.unit ? " " + v.unit : ""}`
}
const fmtKm = (
	km: number,
) => (km < 1
	? `${Math.round(km * 1000)} m`
	: km < 20
	? `${km.toFixed(1)} km`
	: `${Math.round(km)} km`)
function fmtMin(min: number) {
	if (min < 1) return "under a minute"
	if (min < 60) return `${Math.round(min)} min`
	const h = Math.floor(min / 60), m = Math.round(min % 60)
	return m ? `${h} h ${m} min` : `${h} h`
}
function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
	const r = Math.PI / 180
	const d = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
		Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2
	return 2 * 6371 * Math.asin(Math.sqrt(d))
}

// ---- places and dates ----
function nominatim(q: string, near?: string) {
	return `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&extratags=1&q=${
		encodeURIComponent(q)
	}` +
		(near ? `&viewbox=${near}&bounded=0` : "")
}
function geo(r: any): Geo {
	return {
		lat: +(+r.lat).toFixed(6),
		lon: +(+r.lon).toFixed(6),
		name: r.name || String(r.display_name).split(",")[0],
		display: r.display_name,
		type: r.type,
		category: r.category,
		hours: r.extratags?.opening_hours,
		website: r.extratags?.website,
		osm: `${r.osm_type}/${r.osm_id}`,
	}
}
const short = (display = "") =>
	display.split(", ").filter((p) =>
		!/^(Alba \/ Scotland|United Kingdom|City of Edinburgh)$/.test(p)
	).slice(0, 3).join(", ")
function typeIcon(g?: Partial<Geo>) {
	if (!g) return "📍"
	const t = `${g.category}/${g.type}`
	const by: [RegExp, string][] = [
		[/castle|fort/, "🏰"],
		[/place_of_worship|cathedral|church/, "⛪"],
		[/museum|gallery/, "🖼"],
		[/restaurant|fast_food|food/, "🍽"],
		[/cafe/, "☕"],
		[/pub|bar/, "🍺"],
		[/station|railway|train/, "🚉"],
		[/peak|hill|volcano/, "⛰"],
		[/park|garden/, "🌳"],
		[/beach|coast/, "🏖"],
		[/market/, "🧺"],
		[/hotel|guest/, "🛏"],
		[/pedestrian|street|residential|highway/, "🛍"],
		[/boundary|city|town|village|suburb|place\//, "🏘"],
		[/attraction|historic/, "🏛"],
	]
	for (const [re, icon] of by) if (re.test(t)) return icon
	return "📍"
}
function wmo(code: number): [string, string] {
	if (code === 0) return ["☀️", "clear"]
	if (code === 1) return ["🌤", "mostly clear"]
	if (code === 2) return ["⛅", "partly cloudy"]
	if (code === 3) return ["☁️", "overcast"]
	if (code === 45 || code === 48) return ["🌫", "fog"]
	if (code >= 51 && code <= 57) return ["🌦", "drizzle"]
	if (code >= 61 && code <= 67) return ["🌧", "rain"]
	if (code >= 71 && code <= 77) return ["🌨", "snow"]
	if (code >= 80 && code <= 82) return ["🌦", "showers"]
	if (code === 85 || code === 86) return ["🌨", "snow showers"]
	return ["⛈", "thunder"]
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const isoOf = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
		String(d.getDate()).padStart(2, "0")
	}`
function label(iso: string) {
	const d = new Date(iso + "T12:00:00")
	return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}
// a date's label to its day: the year is the one, near now, where the weekday fits
function parseDate(text: string): string | undefined {
	const m = /^(?:(mon|tue|wed|thu|fri|sat|sun)\w*\s+)?(\d{1,2})\s+([a-z]{3})\w*(?:\s+(\d{4}))?$/i
		.exec(text.trim())
	if (!m) return undefined
	const month = MONTHS.findIndex((x) => x.toLowerCase() === m[3].toLowerCase())
	if (month < 0) return undefined
	const now = new Date().getFullYear()
	for (const y of m[4] ? [+m[4]] : [now, now + 1, now - 1]) {
		const d = new Date(y, month, +m[2], 12)
		if (!m[1] || DAYS[d.getDay()].toLowerCase() === m[1].toLowerCase().slice(0, 3)) {
			return isoOf(d)
		}
	}
}
function dateChoices(q: string, known: string[]) {
	const out: { label: string; iso: string; sub: string }[] = []
	const today = new Date()
	const seen = new Set<string>()
	const add = (d: Date, sub: string) => {
		const l = label(isoOf(d))
		if (seen.has(l)) return
		seen.add(l)
		out.push({ label: l, iso: isoOf(d), sub })
	}
	for (const k of known) {
		const iso = parseDate(k)
		if (iso && (!q || fuzzy(q, k))) add(new Date(iso + "T12:00:00"), "a day already mentioned")
	}
	for (let i = 0; i < 28 && out.length < 4; i++) {
		const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i, 12)
		const words = `${label(isoOf(d))} ${i === 0 ? "today" : i === 1 ? "tomorrow" : ""} ${
			d.toLocaleDateString("en-GB", { weekday: "long" })
		}`
		if (q && !fuzzy(q, words)) continue
		add(d, i === 0 ? "today" : i === 1 ? "tomorrow" : `in ${i} days`)
	}
	return out.slice(0, q ? 4 : 2)
}
// every letter of q, in order, in s
function fuzzy(q: string, s: string) {
	const a = q.toLowerCase().replace(/\s+/g, ""), b = s.toLowerCase()
	if (b.includes(q.toLowerCase())) return true
	let i = 0
	for (const ch of b) if (ch === a[i]) i++
	return i >= a.length && a.length > 0
}
const VIEWICON: Record<string, string> = { map: "🗺", calendar: "📅", table: "▦" }
function lanes(events: any[]) {
	const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end)
	const out: { e: any; lane: number; of: number }[] = []
	let group: typeof out = []
	let groupEnd = -1
	const close = () => {
		const of = Math.max(1, ...group.map((g) => g.lane + 1))
		for (const g of group) g.of = of
		group = []
	}
	const ends: number[] = []
	for (const e of sorted) {
		if (e.start >= groupEnd) (close(), ends.length = 0)
		let lane = ends.findIndex((end) => end <= e.start)
		if (lane < 0) lane = ends.length
		ends[lane] = e.end
		const x = { e, lane, of: 1 }
		out.push(x)
		group.push(x)
		groupEnd = Math.max(groupEnd, e.end)
	}
	close()
	return out
}
function oneLine(ta: HTMLTextAreaElement) {
	const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22
	return ta.scrollHeight < lh * 1.8
}
// web mercator, in pixels at zoom z
const mx = (lon: number, z: number) => ((lon + 180) / 360) * 256 * 2 ** z
const my = (lat: number, z: number) => {
	const s = Math.sin((lat * Math.PI) / 180)
	return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z
}
const ux = (x: number, z: number) => (x / (256 * 2 ** z)) * 360 - 180
const uy = (y: number, z: number) => {
	const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** z)
	return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}
function segment(p: number[], a: number[], b: number[]) {
	const dx = b[0] - a[0], dy = b[1] - a[1]
	const k = Math.max(
		0,
		Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
	)
	return Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy)
}
const GLOW = [
	{ boxShadow: "0 0 0 3px #ff2284, 0 0 18px 6px #ff228466" },
	{ boxShadow: "0 0 0 0 #ff228400" },
]

// ---- the look: chee.party's lemon page, black lines, white cards with a pink glow; the document
// inside them a calm page ----
const LOOK = `
[hidden] { display: none !important }
body { margin: 0; background: #ffff88; font: 15px/1.45 Jost, system-ui, sans-serif; color: #000 }
.embark { position: relative; min-height: 100vh; display: flex; flex-direction: column; container-type: inline-size }
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #000; background: #ffff88;
	position: sticky; top: 0; z-index: 20 }
.fill { flex: 1 }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 9px; transform: skew(-8deg);
	font-weight: 600; font-size: 12.5px; white-space: nowrap }
.tag.title { background: #ff2284; color: #fff; font-size: 16px; padding: 1px 12px }
.tag.mint { background: #40dcba } .tag.bad { background: #ff2284; color: #fff } .tag.wait { background: #fff }
.lede { font-size: 12.5px; color: #000b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0 }
kbd, code { font: 12px ui-monospace, Menlo, monospace; background: #fff; border: 1px solid #0003; padding: 0 3px; border-radius: 2px }
button { font: inherit; font-size: 13px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 0 8px; box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform 90ms, box-shadow 90ms }
button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
button:active { transform: translate(1px, 1px); box-shadow: 0 0 0 #000 }
button.on { background: #40dcba }
button.mini { font-size: 11px; padding: 0 5px; box-shadow: 1px 1px 0 #000; margin-left: 4px }
.netpill { font-size: 12px }
.wait { color: #0009 } .bad { color: #d1006a }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 42%); gap: 12px; padding: 12px; flex: 1; align-items: start }
@container (max-width: 820px) { .cols { grid-template-columns: 1fr } .side { position: static !important; max-height: none !important } .lede { display: none } }
.doc { position: relative; background: #fff; border: 1px solid #000; border-radius: 2px; box-shadow: 0 0 16px 3px #ff228426;
	padding: 18px 18px 30px 40px; min-width: 0 }
@container (min-width: 1180px) { .doc { padding-right: 250px } .tray { right: 10px !important; width: 226px !important; left: auto !important } }
.threads { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 2 }
.threads path { fill: none; stroke: #ff2284; stroke-width: 1.6 } .threads path.head { fill: #ff2284; stroke: none }
.threads circle { fill: #fff; stroke: #ff2284; stroke-width: 1.5 }
.title > .row { margin: 0 0 10px -22px }
.title .disp, .title textarea, .title .back { font-size: 26px; font-weight: 600; line-height: 1.2 }
ul.kids { list-style: none; margin: 0; padding: 0 }
.outline > ul.kids { padding-left: 0; margin-left: 0 }
ul.kids { padding-left: 24px; border-left: 1px solid #0000; margin-left: 4px }
li.it:hover > ul.kids { border-left-color: #0001 }
li.it.shut > ul.kids, li.it.shut > .views { display: none }
.row { position: relative; display: flex; align-items: flex-start; gap: 2px; min-height: 26px; border-radius: 2px; padding: 1px 0; scroll-margin: 60px 0 40px }
li.it.lit > .row, .title.lit > .row { background: #ffff8899; box-shadow: 0 0 0 1px #0002 }
li.it.dragged > .row { opacity: .35 }
.tog { width: 16px; flex: none; cursor: pointer; color: #0007; font-size: 13px; line-height: 26px; text-align: center; margin-left: -20px;
	opacity: 0; transition: opacity 100ms }
.row:hover > .tog, li.it.shut > .row > .tog { opacity: 1 }
li.it:has(> ul.kids > li) > .row .tog::before { content: "▾" }
li.it.shut:has(> ul.kids > li) > .row .tog::before { content: "▸"; color: #000 }
.bullet { width: 18px; height: 26px; flex: none; cursor: grab; display: grid; place-items: center; touch-action: none }
.bullet::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--c, #000) }
li.it.shut:has(> ul.kids > li) > .row .bullet::before { box-shadow: 0 0 0 4px color-mix(in srgb, var(--c, #000) 25%, transparent) }
.body { flex: 1; min-width: 0; position: relative }
.disp { min-height: 26px; line-height: 26px; cursor: text; word-wrap: break-word; white-space: pre-wrap }
.ed { display: none; position: relative }
li.it.editing > .row .disp, .title.editing > .row .disp { display: none }
li.it.editing > .row .ed, .title.editing > .row .ed { display: block }
.back, .ed textarea { font: inherit; line-height: 26px; padding: 0 4px 0 0; margin: 0; border: 0; white-space: pre-wrap;
	word-wrap: break-word; overflow-wrap: break-word; letter-spacing: normal; box-sizing: border-box; width: 100% }
.back { color: #000; min-height: 26px }
.back .hn { color: #ff2284 } .back .ht { background: #ffff88; box-shadow: 0 0 0 1px #0003; border-radius: 2px }
.ed textarea { position: absolute; inset: 0; color: transparent; caret-color: #ff2284; background: transparent; resize: none;
	outline: none; overflow: hidden }
.ed textarea::selection { background: #2269ff44; color: transparent }
li.it.editing > .row, .title.editing > .row { background: #fffdf0; box-shadow: 0 0 0 1px #000 }
.ph { color: #0004 }
.pname { color: #ff2284; font-weight: 600; margin-right: 6px }
.pname::after { content: ":"; color: #0005 }
.pval { color: #000 }
.time { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 13px; background: #fff; border: 1px solid #000;
	padding: 0 5px; margin-right: 6px; border-radius: 2px; box-shadow: 1px 1px 0 var(--c, #000) }
.bigicon { font-size: 18px }
.swatch { display: inline-block; width: 16px; height: 16px; border: 1px solid #000; background: var(--sw); vertical-align: -3px;
	margin-right: 6px; cursor: pointer; border-radius: 2px }
.swatch input { opacity: 0; width: 100%; height: 100%; padding: 0; border: 0; cursor: pointer }
.m { display: inline }
.m:has(.chip.place, .chip.date) .chip.unknown { display: none }
.chip { display: inline-flex; align-items: center; gap: 4px; line-height: 20px; padding: 0 7px 0 5px; margin: 0 1px;
	border: 1px solid #000; border-radius: 11px; background: #fff; font-size: 14px; cursor: pointer; vertical-align: 1px;
	box-shadow: 1px 1px 0 var(--c, #000); white-space: nowrap }
.chip.place:hover, .chip.place.lit { background: #ffff88; box-shadow: 0 0 0 2px #ff2284 }
.chip.date { background: #fff; border-style: solid; border-color: #0006; box-shadow: none; cursor: default }
.chip.unknown { border-style: dashed; color: #d1006a; box-shadow: none; transform: none; font-size: 13px }
.chip .uicon:empty { display: none } .chip:has(.uicon:not(:empty)) .gicon { display: none }
.gicon[data-bad] { color: #d1006a }
/* pending in place: ermine-h marks a binding whose node's run is out (data-ermine-waiting) */
.gicon[data-ermine-waiting] { display: inline-block; width: 14px; height: 14px; border-radius: 50%; color: transparent;
	border: 2px solid #ff2284; border-right-color: transparent; animation: spin .8s linear infinite; overflow: hidden }
.chip:has(.gicon[data-ermine-waiting]) { border-style: dashed; background: repeating-linear-gradient(-45deg, #ffff88 0 6px, #fff 6px 12px) }
@keyframes spin { to { transform: rotate(360deg) } }
.pgeo[data-ermine-waiting]::after, .cgeo[data-ermine-waiting]::after { content: "◌ looking it up on OpenStreetMap…"; color: #ff2284 }
.result { display: inline-flex; align-items: center; gap: 6px; margin-right: 6px }
/* the result is the bound element itself: its text is the part's node's preview */
.result:not(:has(.bad)) { background: #40dcba; border: 1px solid #000; padding: 0 8px; border-radius: 2px; transform: skew(-6deg);
	display: inline-block; font-weight: 500; font-size: 14px; line-height: 22px }
.result[data-ermine-waiting] { background: #40dcba73 !important; gap: 0 }
.result[data-ermine-waiting]::before { content: "◌ looking it up"; background: repeating-linear-gradient(-45deg, #ffff88 0 6px, #fff 6px 12px);
	background-size: 34px 34px; border: 1px dashed #000; padding: 0 8px; font-size: 13px; animation: wait 1s linear infinite; line-height: 20px;
	margin: 0 8px 0 -8px; display: inline-block }
@keyframes wait { to { background-position: 34px 0 } }
.result .bad { background: #ff228414; border-left: 3px solid #ff2284; padding: 0 6px; font-size: 13px; white-space: normal }
.result.lit { box-shadow: 0 0 0 2px #ff2284 }
.stale { font-size: 12px; background: #ffff88; border-color: #d1006a; color: #d1006a; box-shadow: 1px 1px 0 #d1006a; margin-right: 6px }
.fx { font: 12px ui-monospace, Menlo, monospace; color: #0007; display: inline-block; max-width: 48%; white-space: nowrap;
	overflow: hidden; text-overflow: ellipsis; vertical-align: -4px }
.fx .chip { font: 12px Jost, system-ui, sans-serif; line-height: 17px; box-shadow: none }
.tools { display: flex; gap: 3px; opacity: 0; transition: opacity 100ms; margin-left: 6px; flex: none; padding-top: 2px }
.row:hover > .tools { opacity: 1 }
.tools button { font-size: 12px; padding: 0 4px; box-shadow: 1px 1px 0 #000; line-height: 18px }
.tools .x:hover { background: #ff2284; color: #fff }
.addrow { margin: 10px 0 0 0; box-shadow: 1px 1px 0 #000; font-size: 12.5px }
.dropline { position: absolute; height: 2px; right: 10px; background: #ff2284; z-index: 5; pointer-events: none }
.dropline::before { content: ""; position: absolute; left: -4px; top: -3px; width: 6px; height: 6px; border: 1.5px solid #ff2284; border-radius: 50%; background: #fff }
.views { margin: 2px 0 4px 18px }
.view { border: 1px solid #000; background: #fff; border-radius: 2px; margin: 6px 0 8px; overflow: hidden }
.view.inline { box-shadow: 2px 2px 0 var(--c, #000) }
.vh { display: flex; align-items: center; gap: 8px; padding: 3px 6px 3px 8px; border-bottom: 1px solid #000; background: #ffff88; font-size: 12.5px }
.vk { font-weight: 600; white-space: nowrap } .of { color: #0009; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto }
.vh button { flex: none }
.vstat { color: #0009; display: inline-flex; gap: 8px; white-space: nowrap; overflow: hidden; min-width: 0; flex: 0 1 auto }
.vh button { font-size: 11.5px; padding: 0 6px; box-shadow: 1px 1px 0 #000 }
.mapbox { position: relative; height: 240px }
.side .mapbox { height: 330px }
.mapwrap { position: absolute; inset: 0 }
.mapwrap canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none }
.mapctl { position: absolute; right: 8px; top: 8px; display: flex; flex-direction: column; gap: 4px }
.mapctl button { width: 24px; height: 24px; padding: 0; font-size: 14px; line-height: 20px }
.attrib { position: absolute; right: 0; bottom: 0; font-size: 10.5px; background: #fffef4dd; padding: 1px 6px; border-top-left-radius: 2px }
.attrib a { color: #000 }
.mapnote:not(:empty) { position: absolute; left: 8px; bottom: 22px; right: 60px; font-size: 12px; background: #fff; border: 1px dashed #ff2284; padding: 2px 6px }
.side { display: flex; flex-direction: column; gap: 10px; position: sticky; top: 50px; max-height: calc(100vh - 62px); overflow: auto; min-width: 0 }
.side .view, .panel { margin: 0; background: #fff; border: 1px solid #000; border-radius: 2px; box-shadow: 0 0 16px 3px #ff228426 }
.calbox { overflow: auto; max-height: 520px }
.inline .calbox { max-height: 360px }
.cal { font-size: 12px; min-width: calc(48px + var(--n) * 110px) }
.ch { display: grid; grid-template-columns: 44px repeat(var(--n), 1fr); position: sticky; top: 0; background: #fff; z-index: 3; border-bottom: 1px solid #000 }
.dh { padding: 3px 6px; border-left: 1px solid #0002 } .dh b { display: block; font-size: 13px } .dh small { color: #000a; white-space: nowrap }
.cb { display: grid; grid-template-columns: 44px repeat(var(--n), 1fr); position: relative }
.hr { font-size: 10.5px; color: #0008; text-align: right; padding-right: 5px; border-top: 1px solid #0001; box-sizing: border-box }
.day { position: relative; border-left: 1px solid #0002 }
.slot { border-top: 1px solid #0001; box-sizing: border-box; background: rgb(34 105 255 / var(--a)); position: relative }
.slot i { position: absolute; right: 3px; top: 1px; font-size: 9.5px; font-style: normal; color: #1d3f99 }
.ev { position: absolute; box-sizing: border-box; padding: 1px 5px; overflow: hidden; border: 1px solid #000; border-left: 4px solid var(--c);
	background: #fffffff0; border-radius: 2px; font-size: 11.5px; line-height: 1.25; cursor: ns-resize; z-index: 2 }
.ev.hours { background: repeating-linear-gradient(-45deg, #ffffffd0 0 5px, color-mix(in srgb, var(--c) 18%, #fff) 5px 10px); border-style: dashed; border-left-style: solid }
.ev.moving { box-shadow: 3px 3px 0 #000; opacity: .9 }
.ev b { font-variant-numeric: tabular-nums }
.empty { color: #0008; font-size: 13px; padding: 8px 10px; margin: 0 }
.tablebox { overflow: auto }
.tbl { border-collapse: collapse; width: 100%; font-size: 13px }
.tbl th { text-align: left; font-weight: 600; font-size: 11.5px; border-bottom: 1px solid #000; padding: 3px 8px; background: #fffdf0; white-space: nowrap }
.tbl td { border-bottom: 1px solid #0001; padding: 2px 8px; vertical-align: top }
.tbl tr:hover td { background: #ffff8866 }
.tbl input { font: inherit; border: 0; background: transparent; width: 100%; min-width: 60px; outline: none; padding: 1px 0 }
.tbl input:focus { background: #fffdf0; box-shadow: 0 0 0 1px #000 }
.tbl .ti { font-weight: 500; white-space: nowrap } .tbl .wh { color: #0009; font-size: 12px } .tbl .fxc { background: #40dcba33 }
.panel .plist { list-style: none; margin: 0; padding: 4px 8px }
.prow { padding: 4px 0; border-bottom: 1px solid #0001 }
.prow.lit { background: #ffff8866 }
.ptop { display: flex; align-items: center; gap: 6px }
.pcount { font-size: 11.5px; color: #0008 }
.pgeo { font-size: 11.5px; color: #0009; padding-left: 4px }
.prow ul.kids { padding-left: 16px; font-size: 13.5px }
.prow .tools { display: none }
.addprop { font-size: 11px; padding: 0 5px; box-shadow: 1px 1px 0 #000; margin: 2px 0 2px 16px }
.prow .addprop { order: 9; margin: 0 0 0 auto; opacity: 0 } .prow:hover .addprop { opacity: 1 }
.netbody { padding: 6px 8px; font-size: 12px }
.nstats { display: flex; flex-wrap: wrap; gap: 6px 10px }
.recent { list-style: none; margin: 6px 0; padding: 0; color: #0009 } .recent li.bad { color: #d1006a }
.credit { color: #0008; font-size: 11px; margin: 4px 0 0 } .credit a { color: #000 }
.menu { position: absolute; z-index: 40; width: 370px; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 3px 3px 0 #000, 0 0 22px 4px #ff228440; font-size: 13px; overflow: hidden }
.mh { font-size: 11px; color: #0008; padding: 3px 8px; border-bottom: 1px solid #0002; background: #ffff88 }
.mi { display: flex; align-items: center; gap: 8px; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #0001 }
.mi.sel { background: #ffff88; box-shadow: inset 3px 0 0 #ff2284 }
.mi:hover { background: #fffdf0 }
.mi.none, .mi.wait { color: #0008; cursor: default }
.mic { width: 22px; text-align: center; font-size: 15px; flex: none }
.mil { flex: 1; min-width: 0; display: flex; flex-direction: column } .mil small { color: #0008; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.mip { font-size: 12px; background: #40dcba; border: 1px solid #000; padding: 0 6px; white-space: nowrap; transform: skew(-6deg) }
.mip.wait { background: #fff } .mip.bad { background: #ff2284; color: #fff }
.tray { position: absolute; left: 40px; right: 18px; z-index: 6; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 3px 3px 0 #000; padding: 6px; font-size: 12px; margin-top: 30px }
@container (min-width: 1180px) { .tray { margin-top: 0 } }
.tsec + .tsec { margin-top: 6px; border-top: 1px solid #0002; padding-top: 6px }
.th { font-size: 11px; color: #0008; margin-bottom: 3px; font-weight: 600 }
.sug { display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left; margin: 0 0 4px; box-shadow: 1px 1px 0 #000; padding: 2px 6px }
.sug .sl { font-weight: 500 } .sug .sp { font-size: 11.5px; color: #000a }
.sug.rep { background: #ffff88 }
.reads .rl { color: #000a } .ck { display: inline-block; margin: 2px 4px 0 0; font-size: 10.5px }
.card { position: absolute; z-index: 45; width: 340px; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 3px 3px 0 #000, 0 0 22px 4px #ff228440; padding: 8px 10px; font-size: 13px }
.card header { display: flex; align-items: center; gap: 6px; font-size: 16px }
.card dl { display: grid; grid-template-columns: 70px 1fr; gap: 2px 8px; margin: 6px 0; font-size: 12.5px }
.card dt { color: #0008 } .card dd { margin: 0; word-break: break-word } .card a { color: #2269ff }
.cprops { border-top: 1px solid #0002; padding-top: 4px } .cprops .tools { display: none }
.toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%) skew(-6deg); background: #000; color: #fff;
	padding: 4px 14px; z-index: 60; font-size: 13px; animation: toast 3.6s forwards; pointer-events: none; max-width: 80vw }
@keyframes toast { 0% { opacity: 0; translate: 0 8px } 8% { opacity: 1; translate: 0 0 } 85% { opacity: 1 } 100% { opacity: 0 } }
.help { margin: 10px 12px 0; background: #fff; border: 1px solid #000; padding: 6px 12px; font-size: 13px; box-shadow: 0 0 16px 3px #ff228426 }
.help p { margin: 4px 0 }
`
