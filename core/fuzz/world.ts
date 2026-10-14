// a small graph for the cross-library fuzz tests: a table per source holding children nodes, as
// places' own tests keep them, and random writes on it through places, and now and then a table
// event (a children node put in place of another, taken out, put back)
import createEntry, { type ChangeHeader, type Entry as NodeEntry } from "@ermine/node"
import { createTable, type Key } from "@ermine/graph/table"
import {
	type Address,
	type Changed,
	createPlaces,
	type Entry,
	type Item,
	path,
	type Places,
	type Read,
} from "@ermine/places"
import type { Pick } from "./gen.ts"

export const SYM = Symbol("x")
export const SOURCES: readonly Key[] = ["stored", "drag", SYM]
export const IDS = ["R", "A", "B", "C", "D"]
export const NAMES = ["a", "b", "c", "__proto__"]
export const TOP: Entry = ["stored", "R"]

// a whole-node event at a key: its children node put, replaced or taken out
export type Event = { source: Key; id: Key }
export type Wrote = { what: string; changed: Changed[]; events: Event[] }

export function createWorld(pick: Pick, read?: (r: Read) => void) {
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	const tables = new Map<Key, ReturnType<typeof createTable<unknown>>>()
	const table = (source: Key) =>
		tables.get(source) ?? tables.set(source, createTable<unknown>()).get(source)!
	const children = (source: Key, id: Key) =>
		table(source).get("children", id) as NodeEntry<unknown> | undefined
	const p = createPlaces({ root: TOP, children, read })
	// the same graph read with nothing told
	const plain = createPlaces({ root: TOP, children })
	let time = 0
	const header = (): ChangeHeader => ({ time: ++time, actor: "fuzz" })

	const entry = (): Entry => [one(SOURCES), IDS[1 + pick(IDS.length - 1)]]
	// a children value: names to entries, with now and then something that is no entry in an
	// array, or a name holding something that is not an array
	function value(): Record<string, unknown> {
		const v: Record<string, unknown> = {}
		for (const name of NAMES) {
			const k = pick(6)
			if (k < 2) continue
			if (k === 5) v[name] = pick(2) ? 5 : { not: "an array" }
			else {
				v[name] = Array.from(
					{ length: pick(4) },
					() => pick(7) ? entry() : one([7, ["x"], null]),
				)
			}
		}
		return v
	}
	for (const source of SOURCES) {
		for (const id of IDS) {
			// D of "stored" has no children node: a parent that is not there
			if (source === "stored" && id === "D") continue
			table(source).add("children", id, createEntry<unknown>(value(), header()))
		}
	}

	// every key, and its node now
	const keys = () => SOURCES.flatMap((source) => IDS.map((id) => ({ source, id })))
	const nodes = () => keys().map(({ source, id }) => ({ source, id, node: children(source, id) }))

	// an address: names, and now and then a step
	const address = (most = 3): Address =>
		Array.from({ length: pick(most + 1) }, () => pick(7) ? one(NAMES) : one([".", "..", "/"]))
	// where to start: the root, an entry, or an item found from the root
	function from(): Item | Entry | undefined {
		const k = pick(4)
		if (k === 0) return undefined
		if (k === 1) return entry()
		const found = plain.get(Array.from({ length: 1 + pick(2) }, () => one(NAMES)))
		return found.length ? one(found) : undefined
	}
	// a parent of a slot: mostly an entry, the root most of all; else an item found
	function parent(): Item | Entry {
		if (pick(4) === 0) {
			const found = plain.get(Array.from({ length: 1 + pick(2) }, () => one(NAMES)))
			if (found.length) return one(found)
		}
		return pick(3) ? TOP : [one(SOURCES), pick(8) === 0 ? "D" : one(IDS)]
	}
	const name = () => pick(12) ? one(NAMES) : one([".", "..", "/"])
	// what a slot's name holds now: its array's length (none: 0)
	function size(at: Item | Entry, n: string): number {
		const [source, id] = Array.isArray(at) ? at : [(at as Item).source, (at as Item).id]
		const v = children(source, id)?.value as Record<string, unknown> | undefined
		const list = v !== null && typeof v === "object" && Object.hasOwn(v, n) ? v[n] : undefined
		return Array.isArray(list) ? list.length : 0
	}
	// a slot: mostly a name holding entries, when the parent has one
	function slot(): [Item | Entry, string] {
		const at = parent()
		const full = NAMES.filter((n) => size(at, n) > 0)
		return [at, full.length && pick(3) ? one(full) : name()]
	}
	// an index into what a slot holds: mostly one that is there
	const into = (s: [Item | Entry, string], end = 0) => {
		const n = size(s[0], s[1]) + end
		return n && pick(6) ? pick(n) : pick(n + 2)
	}

	// one random write through places (it may throw PlacesError, and then nothing changed), or a
	// table event
	function write(events = true): Wrote {
		const k = pick(events ? 13 : 12)
		const h = header()
		if (k < 3) {
			const s = slot(), e = entry(), i = pick(2) ? undefined : into(s, 1)
			return {
				what: `place ${show(s)} ${show(e)} ${i}`,
				changed: p.place(s, e, h, i),
				events: [],
			}
		}
		if (k < 5) {
			const s = slot(), i = into(s)
			return { what: `unplace ${show(s)} ${i}`, changed: p.unplace(s, i, h), events: [] }
		}
		if (k < 7) {
			const s = slot(), a = into(s), b = into(s)
			return { what: `order ${show(s)} ${a} ${b}`, changed: p.order(s, a, b, h), events: [] }
		}
		if (k < 8) {
			const s = slot(), to = name()
			return { what: `rename ${show(s)} ${to}`, changed: p.rename(s, to, h), events: [] }
		}
		if (k < 12) {
			const a = slot(), b = slot(), i = into(a), j = pick(2) ? undefined : into(b, 1)
			return {
				what: `move ${show(a)} ${i} ${show(b)} ${j}`,
				changed: p.move(a, i, b, h, j),
				events: [],
			}
		}
		// a table event: a node in place of the one there, or none, or one put where none is
		const source = one(SOURCES), id = one(IDS)
		const t = table(source), there = t.get("children", id)
		if (there && pick(3) === 0) t.del("children", id)
		else t.sub("children", id, createEntry<unknown>(pick(4) ? value() : undefined, h))
		return { what: `event ${String(source)} ${id}`, changed: [], events: [{ source, id }] }
	}

	return { p, plain, children, table, keys, nodes, address, from, parent, entry, write, one }
}

// an item for messages and comparing: its key, the names to it, its index, and its start
export const show = (x: unknown): string =>
	JSON.stringify(
		x,
		(_, v) =>
			typeof v === "symbol"
				? String(v)
				: v && typeof v === "object" && "source" in v && "id" in v && !Array.isArray(v)
				? `${String(v.source)}:${String(v.id)}@${path(v as Item).join("/")}#${v.at ?? "-"}`
				: v,
	)
export const items = (xs: readonly Item[]) => xs.map((i) => show(i))

// two items alike: the same entries, found in alike items, at the same places
export function alike(a: Item | undefined, b: Item | undefined): boolean {
	if (a === undefined || b === undefined) return a === b
	if (a === b) return true
	return a.source === b.source && a.id === b.id && a.name === b.name && a.at === b.at &&
		alike(a.up, b.up)
}

export type World = ReturnType<typeof createWorld>
export type { Places }
