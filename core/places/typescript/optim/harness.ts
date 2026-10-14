// The reference places (core/places/typescript/places.ts) on the line protocol: one JSON request per
// line in, one answer per line out, in order. State lasts for the process. Another implementation
// joins by speaking this (HARNESS).
//
// the world: per source, a map of id -> children node, filled by the requests below; that is the
// hole `children(source, id)`. places made by "make" read it, and tell the harness every read.
// writes use the header { time, actor: "me" }, time from the request (default 1)
//
// keys: a string, {"symbol": name} (one symbol per name for the whole run), or {"root": true}
//   (places' ROOT). they may stand anywhere in a value, deep. an entry is [source, id], two keys
// from/parent specs, where a start or a parent is named:
//   [source, id]                an entry
//   {"item": name, "at"?: n}    item n (default 0) of the list saved as name
//   absent (a start only)       the root
// an address is an array of strings: names, ".", "..", "/"
//
// { op: "children", source, id, value? }   → {}   a fresh children node there (a new object, the
//    value as given, revived; no value key: a node with no value), whatever was there is replaced
// { op: "nothing", source, id }            → {}   no node there (the hole answers undefined)
// { op: "node", source, id }               → { node?: { value?, time } }   as the world has it now
// { op: "make", root }                     → {}   a new places, forgetting the old, its opened
//    places and its saved lists; root: a key (an id: source ROOT) or an entry. the nodes stay
// (before any make: places with the root "R")
// { op: "get", address, from?, save? }                   → { items, reads }
// { op: "lookup", address, from?, all?, save? }          → { items, reads }
// { op: "names", from }                                  → { names, reads }
// { op: "open", address, as }                            → {}   opened place `as` (replaces one)
// { op: "items", open, save? }                           → { items, reads, same }
//    same: true if the list is the very one this open's last items gave
// { op: "drop", open }                                   → {}
// { op: "path", item, at? }                              → { path }   path() of a saved item
// { op: "place", parent, name, entry, index?, time? }
// { op: "unplace", parent, name, index, time? }
// { op: "order", parent, name, from, to, time? }
// { op: "rename", parent, name, to, time? }
// { op: "move", parent, name, index, to: { parent, name }, toindex?, time? }
//    every write → { changes, reads? } and, refused, { error: code, at?, changes: [] }
//    changes: [{ source, id, value?, time, patches }]   the nodes the write gave back, in order:
//       the value the node has after the request (no value key: none), its change's time and
//       patches (the patches that landed)
//    reads: only when the write made some
//    checked here: what a write gives back is every node it changed, each once (the harness sees
//    each change made to a node); else { error: text }
//
// save: the list of items answered is kept under that name, for from, parent and path.
// an item: { source, id, name?, at?, path }   name and at: none on a start. path: path(item)
// a PlacesError answers { error: code, at? } (at: the name it was about, when there was one).
// anything not understood: { error: "text" }
import createEntry, { type Entry } from "@ermine/node"
import type { Item } from "@ermine/places"
import type * as Places from "@ermine/places"

// harness.ts on the version named by PLACES_MODULE (default ../places.ts), for the conformance
// suite: HARNESS="deno run --quiet --allow-env --allow-read core/places/typescript/optim/harness.ts"
const { createPlaces, path, PlacesError, ROOT }: typeof Places = await import(
	new URL(Deno.env.get("PLACES_MODULE") ?? "../places.ts", import.meta.url).href
)

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
type Key = string | symbol
type Json = unknown
type Spec = Item | readonly [Key, Key]

const symbols = new Map<string, symbol>()
function revive(x: unknown): unknown {
	if (Array.isArray(x)) return x.map(revive)
	if (x === null || typeof x !== "object") return x
	const keys = Object.keys(x)
	if (keys.length === 1 && keys[0] === "symbol" && typeof (x as Request).symbol === "string") {
		const name = (x as Request).symbol as string
		let s = symbols.get(name)
		if (!s) symbols.set(name, s = Symbol(name))
		return s
	}
	if (keys.length === 1 && keys[0] === "root" && (x as Request).root === true) return ROOT
	return Object.fromEntries(keys.map((k) => [k, revive((x as Request)[k])]))
}
function dehydrate(x: unknown): Json {
	if (typeof x === "symbol") return x === ROOT ? { root: true } : { symbol: x.description }
	if (Array.isArray(x)) return x.map(dehydrate)
	if (x === null || typeof x !== "object") return x
	return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, dehydrate(v)]))
}
const key = (x: unknown) => {
	const k = revive(x)
	if (typeof k !== "string" && typeof k !== "symbol") {
		throw new Error("key: not a string or a symbol")
	}
	return k
}

const world = new Map<Key, Map<Key, Entry<unknown>>>()
// the changes made to nodes in the request being answered
let changed: { source: Key; id: Key; node: Entry<unknown> }[] = []
let reads: Json[] = []

function made(source: Key, id: Key, value?: unknown) {
	const node = createEntry(value, { time: 0, actor: "setup" })
	let change = node.change
	Object.defineProperty(node, "change", {
		enumerable: true,
		get: () => change,
		set: (c) => {
			change = c
			changed.push({ source, id, node })
		},
	})
	let ids = world.get(source)
	if (!ids) world.set(source, ids = new Map())
	ids.set(id, node)
}

let saved = new Map<string, readonly Item[]>()
let opened = new Map<string, { held: { items(): readonly Item[]; drop(): void }; last?: unknown }>()
let places = make_("R")

function make_(root: Key | readonly [Key, Key]) {
	return createPlaces({
		root: root as Key,
		children: (source, id) => world.get(source)?.get(id),
		read: (r) => reads.push(dehydrate(r)),
	})
}

function spec(x: unknown): Spec {
	if (Array.isArray(x)) {
		const e = revive(x) as unknown[]
		if (e.length !== 2) throw new Error("entry: not two keys")
		return [key(x[0]), key(x[1])]
	}
	if (x !== null && typeof x === "object" && typeof (x as Request).item === "string") {
		const list = saved.get((x as Request).item)
		const item = list?.[(x as Request).at ?? 0]
		if (!item) throw new Error("no such saved item")
		return item
	}
	throw new Error("not an entry or a saved item")
}
const from = (x: unknown) => (x === undefined ? undefined : spec(x))

function show(item: Item) {
	return {
		source: dehydrate(item.source),
		id: dehydrate(item.id),
		...(item.name === undefined ? {} : { name: item.name, at: item.at }),
		path: path(item),
	}
}
function list(r: Request, items: readonly Item[]) {
	if (typeof r.save === "string") saved.set(r.save, items)
	return items.map(show)
}

const entry = (x: unknown) => {
	const e = revive(x)
	if (!Array.isArray(e) || e.length !== 2) throw new Error("entry: not two keys")
	return [key(e[0]), key(e[1])] as const
}
const slot = (parent: unknown, name: unknown) => [spec(parent), name] as [Spec, string]

type Gave = readonly { source: Key; id: Key; node: Entry<unknown> }[]
function write(r: Request, f: (h: { time: number; actor: string }) => Gave): Json {
	const header = { time: r.time ?? 1, actor: "me" }
	let error: Json = {}, gave: Gave = []
	try {
		gave = f(header)
	} catch (e) {
		if (!(e instanceof PlacesError)) throw e
		error = { error: e.code, ...(e.at === undefined ? {} : { at: e.at }) }
	}
	const same = gave.length === changed.length &&
		gave.every((c, i) =>
			c.node === changed[i].node && c.source === changed[i].source && c.id === changed[i].id
		)
	if (!same) return { error: "a write gave back other than what it changed" }
	return {
		...(error as object),
		changes: gave.map((c) => ({
			source: dehydrate(c.source),
			id: dehydrate(c.id),
			...("value" in c.node ? { value: dehydrate(c.node.value) } : {}),
			time: c.node.change.time,
			patches: dehydrate(c.node.change.op?.patches ?? []),
		})),
		...(reads.length ? { reads } : {}),
	}
}

function answer(r: Request): Json {
	changed = [], reads = []
	switch (r.op) {
		case "children":
			made(key(r.source), key(r.id), "value" in r ? revive(r.value) : undefined)
			return {}
		case "nothing":
			world.get(key(r.source))?.delete(key(r.id))
			return {}
		case "node": {
			const n = world.get(key(r.source))?.get(key(r.id))
			if (!n) return {}
			return {
				node: { ...("value" in n ? { value: dehydrate(n.value) } : {}), time: n.change.time },
			}
		}
		case "make":
			places = make_(r.root !== null && Array.isArray(r.root) ? entry(r.root) : key(r.root))
			saved = new Map(), opened = new Map()
			return {}
		case "get": {
			const items = places.get(r.address, from(r.from))
			return { items: list(r, items), reads }
		}
		case "lookup": {
			const items = places.lookup(r.address, from(r.from), r.all === true)
			return { items: list(r, items), reads }
		}
		case "names": {
			const names = places.names(spec(r.from))
			return { names, reads }
		}
		case "open":
			opened.set(r.as, { held: places.open(r.address) })
			return {}
		case "items": {
			const o = opened.get(r.open)
			if (!o) throw new Error("no such open")
			const items = o.held.items()
			const same = o.last === items
			o.last = items
			return { items: list(r, items), reads, same }
		}
		case "drop":
			opened.get(r.open)?.held.drop()
			return {}
		case "path": {
			const item = spec({ item: r.item, at: r.at })
			return { path: path(item as Item) }
		}
		case "place":
			return write(r, (h) => places.place(slot(r.parent, r.name), entry(r.entry), h, r.index))
		case "unplace":
			return write(r, (h) => places.unplace(slot(r.parent, r.name), r.index, h))
		case "order":
			return write(r, (h) => places.order(slot(r.parent, r.name), r.from, r.to, h))
		case "rename":
			return write(r, (h) => places.rename(slot(r.parent, r.name), r.to, h))
		case "move":
			return write(
				r,
				(h) =>
					places.move(
						slot(r.parent, r.name),
						r.index,
						slot(r.to.parent, r.to.name),
						h,
						r.toindex,
					),
			)
		default:
			return { error: `unknown op ${r.op}` }
	}
}

function safe(r: Request): Json {
	try {
		if (r === null || typeof r !== "object") throw new Error("not an object")
		return answer(r)
	} catch (e) {
		return { error: String(e) }
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		text += JSON.stringify(safe(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
