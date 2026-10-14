// places: names from a root, walked through children nodes. a children node's value maps each name
// to an array of entries, in order: [source, id], what put it there and the id. the array is the
// order: the front is first. places knows no source's meaning, and no part but children; whoever
// reads asks for an item's other parts elsewhere
import type { ChangeHeader, Entry as NodeEntry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createTrie, type Entry as Held } from "./trie.ts"

export type Key = string | symbol

// the source of a root given as an id
export const ROOT: unique symbol = Symbol.for("ermine.places.root")

// one thing at a name: what put it there, and its id
export type Entry = readonly [source: Key, id: Key]

// steps, in order: a name, "." here, ".." back one, "/" the root. a name is any other string
export type Address = readonly string[]

// one thing at a place, and how it was reached: up: the item whose children it was found in,
// under name, at index at of that name's array. a start (the root, or an entry given) has none
export type Item = {
	readonly source: Key
	readonly id: Key
	readonly up?: Item
	readonly name?: string
	readonly at?: number
}

// what a read rested on: the children of id as source has them, at path in that node's value; []:
// the whole value. told whether or not anything was there: a read of what is not there yet is
// how a caller learns where to put something. keys: a read of which names there are (path []),
// not of what is under them
export type Read = {
	readonly source: Key
	readonly id: Key
	readonly path: readonly string[]
	readonly keys?: true
}

// a name in a parent's children: the parent (an item, or an entry), and the name
// where a read is told: the setup's, or one given to a call, used instead of it for that call
export type Tell = (read: Read) => void

export type Slot = readonly [parent: Item | Entry, name: string]

export type Setup = {
	// where names start: an id, with the source ROOT, or an entry
	root: Key | Entry
	// the children node of id as source has it; none: not there (not loaded, or never made). where
	// a source's nodes are kept is the caller's: one table for all, a table per source, anything
	children: (source: Key, id: Key) => NodeEntry<unknown> | undefined
	// told of each read, as it is made
	read?: Tell
}

// a children node a write changed, and whose it is: the node's change has the patches that landed
export type Changed = { readonly source: Key; readonly id: Key; readonly node: NodeEntry<unknown> }

export type Code = "not-a-name" | "nothing-there" | "already-there" | "range"

export class PlacesError extends Error {
	// the name asked about, when there was one
	constructor(readonly code: Code, readonly at?: string) {
		super(at === undefined ? code : `${code} (${at})`)
	}
}

// the names from the start to the item
export function path(item: Item): string[] {
	const names: string[] = []
	for (let at: Item | undefined = item; at?.up; at = at.up) names.push(at.name!)
	return names.reverse()
}

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

function isMap(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}

const isKey = (k: unknown): k is Key => typeof k === "string" || typeof k === "symbol"

// an index from lo up to hi, a whole number
const within = (i: number, lo: number, hi: number) => Number.isInteger(i) && i >= lo && i <= hi

// the array under name in a children node; none, or not an array: undefined
function array(node: NodeEntry<unknown> | undefined, name: string): readonly unknown[] | undefined {
	const v = node?.value
	if (!isMap(v)) return undefined
	const list = v[name]
	return Array.isArray(list) ? list : undefined
}

// a name holding something that is not an array: taken, never written over
const taken = (node: NodeEntry<unknown>, name: string) =>
	isMap(node.value) && Object.hasOwn(node.value, name) && !Array.isArray(node.value[name])

// an entry; anything else in an array keeps its position, and is no item
const isEntry = (e: unknown): e is Entry =>
	Array.isArray(e) && e.length === 2 && isKey(e[0]) && isKey(e[1])

// the items an array under name in up's children holds, in order
function entries(up: Item, name: string, list: readonly unknown[]): Item[] {
	const out: Item[] = []
	for (let i = 0; i < list.length; i++) {
		const e = list[i]
		if (isEntry(e)) out.push({ source: e[0], id: e[1], up, name, at: i })
	}
	return out
}

// what an opened place keeps of one item's level: per name, the array walked and the items it gave
type Level = { names: Map<string, { list: readonly unknown[]; items: Item[] }> }

// what a held place keeps per step: the items it was walked from, the children nodes they read
// and at which change, what that gave, and how many opened places share it
type Seen = { source: Key; id: Key; node: NodeEntry<unknown> | undefined; change: unknown }
type Step = { from: readonly Item[] | null; items: readonly Item[]; seen: Seen[]; opened: number }

export function createPlaces(setup: Setup): Places {
	const { children, read: tell } = setup
	const top: Item = Array.isArray(setup.root)
		? { source: setup.root[0], id: setup.root[1] }
		: { source: ROOT, id: setup.root as Key }

	const begin = (from?: Item | Entry): Item =>
		from === undefined
			? top
			: Array.isArray(from)
			? { source: from[0], id: from[1] }
			: from as Item

	// the item the names are walked from, and the names. ".." takes back a name, else goes up the
	// way the start was reached; above it: undefined. an address with no steps is the names
	// already, given back as it is
	function plan(address: Address, from?: Item | Entry): [Item, readonly string[]] | undefined {
		let at: Item | undefined = begin(from)
		if (!address.some(bad)) return [at, address]
		const names: string[] = []
		for (const s of address) {
			if (s === ".") continue
			if (s === "/") at = top, names.length = 0
			else if (s !== "..") names.push(s)
			else if (names.length) names.pop()
			else at = at?.up
		}
		return at && [at, names]
	}

	// one name down from each item: every entry under the name in its children, in order
	function step(items: readonly Item[], name: string, tell?: Tell, seen?: Seen[]): Item[] {
		const out: Item[] = []
		for (const up of items) {
			const node = children(up.source, up.id)
			tell?.({ source: up.source, id: up.id, path: [name] })
			seen?.push({ source: up.source, id: up.id, node, change: node?.change })
			const list = array(node, name)
			if (list !== undefined) out.push(...entries(up, name, list))
		}
		return out
	}

	// what is at the address, front first: from the root, an item, or an entry. read: told the
	// reads of this call, instead of the setup's
	function get(address: Address, from?: Item | Entry, read: Tell | undefined = tell): Item[] {
		const p = plan(address, from)
		if (!p) return []
		let items = [p[0]]
		for (const name of p[1]) {
			if (!items.length) break
			items = step(items, name, read)
		}
		return items
	}

	// the address from the start, then from each place the start was found in, nearest first:
	// what the nearest gives; all: what each gives, nearest first.
	// read: as for get
	function lookup(
		address: Address,
		from?: Item | Entry,
		all = false,
		read: Tell | undefined = tell,
	): Item[] {
		const out: Item[] = []
		for (let at: Item | undefined = begin(from); at; at = at.up) {
			const found = get(address, at, read)
			if (found.length && !all) return found
			out.push(...found)
		}
		return out
	}

	// the names in an item's children, in their order there; a read of which names there are.
	// read: as for get
	function names(at: Item | Entry, read: Tell | undefined = tell): string[] {
		const item = begin(at)
		const v = children(item.source, item.id)?.value
		read?.({ source: item.source, id: item.id, path: [], keys: true })
		const out: string[] = []
		if (isMap(v)) { for (const k of Object.keys(v)) if (Array.isArray(v[k])) out.push(k) }
		return out
	}

	// every item at a level: each name's entries in an item's children, in name order then slot
	// order. its reads: the keys read, and each name's array (as get([name], at, read) tells)
	function members(at: Item | Entry, read: Tell | undefined = tell): Item[] {
		const up = begin(at)
		const v = children(up.source, up.id)?.value
		read?.({ source: up.source, id: up.id, path: [], keys: true })
		const out: Item[] = []
		if (!isMap(v)) return out
		for (const name of Object.keys(v)) {
			const list = v[name]
			if (!Array.isArray(list)) continue
			read?.({ source: up.source, id: up.id, path: [name] })
			out.push(...entries(up, name, list))
		}
		return out
	}

	// opened places: a trie of the opened addresses from the root, each step keeping what it
	// read. places opened with the same beginning share its steps
	const held = createTrie<Step>()
	// every open is from the root: one start list, so their shared steps compare it as the same
	const starts: readonly Item[] = [top]
	const none: readonly Item[] = []

	// two walks gave the same items: the same entries, found in the same items, at the same places
	function alike(a: readonly Item[], b: readonly Item[]) {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) {
			const x = a[i], y = b[i]
			if (x.source !== y.source || x.id !== y.id || x.up !== y.up || x.name !== y.name) {
				return false
			}
			if (x.at !== y.at) return false
		}
		return true
	}

	// a step still good: every children node it read is the one there, at the same change
	function good(s: Step) {
		for (const x of s.seen) {
			const node = children(x.source, x.id)
			if (node !== x.node || node?.change !== x.change) return false
		}
		return true
	}

	// the address from the root, opened: items() gives what is there now; members() the members of
	// every one of those items, kept across calls (below). a step is walked again
	// only when the step before it gave other items, or a children node it read is not the one
	// there or is at another change; nothing changed: the same list. each call tells every read
	// the held address rests on, to the sink given to items, else the one given to open, else the
	// setup's: whoever asks is who depends on it, and a re-walk is theirs. the sink is never kept
	// in a shared step. drop: let go
	function open(address: Address, opened: Tell | undefined = tell) {
		const p = plan(address)
		const start = p ? starts : none
		// its own copy: the hold outlives the call
		const names = p ? p[1].slice() : []
		const path: Held<Step>[] = []
		let e = held.root
		for (const name of names) {
			e = held.make([name], e)
			e.value ??= { from: null, items: [], seen: [], opened: 0 }
			e.value.opened++
			path.push(e)
		}
		let dropped = false
		function items(read: Tell | undefined = opened): readonly Item[] {
			if (dropped || !p) return none
			let before: readonly Item[] = start
			for (let i = 0; i < path.length; i++) {
				const s = path[i].value!
				if (s.from !== before || !good(s)) {
					s.from = before
					s.seen = []
					const walked = before.length ? step(before, names[i], read, s.seen) : none
					if (!alike(walked, s.items)) s.items = walked
				} else if (read) {
					for (const x of s.seen) read({ source: x.source, id: x.id, path: [names[i]] })
				}
				before = s.items
			}
			return before
		}
		// the members of every item, concatenated in item order, each in name order then slot order,
		// kept per item: a name whose array is the one walked last time keeps its items (its read
		// is told again, so it stays tracked); a name with a new array is walked again; a name gone
		// is let go. a children node in place (cow === false) changes its arrays without a new
		// one: every name is walked again. the sink: as for items
		let levels = new Map<Item, Level>()
		function members(read: Tell | undefined = opened): Item[] {
			if (dropped) return []
			const out: Item[] = []
			const next = new Map<Item, Level>()
			for (const up of items(read)) {
				const node = children(up.source, up.id)
				read?.({ source: up.source, id: up.id, path: [], keys: true })
				const was = levels.get(up)?.names
				const level: Level = { names: new Map() }
				next.set(up, level)
				const v = node?.value
				if (!isMap(v)) continue
				for (const name of Object.keys(v)) {
					const list = v[name]
					if (!Array.isArray(list)) continue
					read?.({ source: up.source, id: up.id, path: [name] })
					const kept = was?.get(name)
					const there = kept !== undefined && kept.list === list && node!.cow !== false
						? kept
						: { list, items: entries(up, name, list) }
					level.names.set(name, there)
					out.push(...there.items)
				}
			}
			levels = next
			return out
		}
		function drop() {
			if (dropped) return
			dropped = true
			levels = new Map()
			for (const e of path) if (--e.value!.opened === 0) e.value = undefined
			if (path.length) held.prune(path[path.length - 1])
		}
		return { items, members, drop }
	}

	// writing

	const parentOf = (at: Item | Entry) => begin(at)

	function node(parent: Item) {
		const n = children(parent.source, parent.id)
		if (n === undefined) throw new PlacesError("nothing-there")
		return n
	}

	function write(
		parent: Item,
		n: NodeEntry<unknown>,
		patches: Patch[],
		header: ChangeHeader,
	): Changed[] {
		update(n, patches, header)
		return [{ source: parent.source, id: parent.id, node: n }]
	}

	// the patches that make sure n's value is a map, first
	const base = (n: NodeEntry<unknown>): Patch[] => isMap(n.value) ? [] : [{ path: [], value: {} }]

	// every write: the nodes it changed, in order. refused: it throws, and nothing changes

	// entry placed under name, at index (default the end): one change on the parent's children
	function place(
		[at, name]: Slot,
		entry: Entry,
		header: ChangeHeader,
		index?: number,
	): Changed[] {
		if (bad(name)) throw new PlacesError("not-a-name", name)
		const parent = parentOf(at)
		const n = node(parent)
		if (taken(n, name)) throw new PlacesError("already-there", name)
		const list = array(n, name)
		const i = index ?? list?.length ?? 0
		if (!within(i, 0, list?.length ?? 0)) throw new PlacesError("range", name)
		const ps = base(n)
		const put = [[entry[0], entry[1]]]
		ps.push(list ? { path: [name], range: [i, i], value: put } : { path: [name], value: put })
		return write(parent, n, ps, header)
	}

	// the entry at index under name taken out; the last one: the name too. one change
	function unplace([at, name]: Slot, index: number, header: ChangeHeader): Changed[] {
		const parent = parentOf(at)
		const n = node(parent)
		const list = array(n, name)
		if (!list?.length) throw new PlacesError("nothing-there", name)
		if (!within(index, 0, list.length - 1)) throw new PlacesError("range", name)
		const ps: Patch[] = list.length === 1
			? [{ path: [name] }]
			: [{ path: [name], range: [index, index + 1] }]
		return write(parent, n, ps, header)
	}

	// the entry at from under name moved to index to, counted with it taken out: one change. to 0:
	// the front, the one chosen
	function order([at, name]: Slot, from: number, to: number, header: ChangeHeader): Changed[] {
		const parent = parentOf(at)
		const n = node(parent)
		const list = array(n, name) ?? []
		if (!within(from, 0, list.length - 1) || !within(to, 0, list.length - 1)) {
			throw new PlacesError("range", name)
		}
		if (from === to) return []
		return write(parent, n, [{
			path: [name],
			range: [to, to],
			move: { path: [name], range: [from, from + 1] },
		}], header)
	}

	// everything under name moved to the name to: one change
	function rename([at, name]: Slot, to: string, header: ChangeHeader): Changed[] {
		if (bad(to)) throw new PlacesError("not-a-name", to)
		const parent = parentOf(at)
		const n = node(parent)
		if (!array(n, name)?.length) throw new PlacesError("nothing-there", name)
		if (to === name) return []
		if (isMap(n.value) && Object.hasOwn(n.value, to)) throw new PlacesError("already-there", to)
		return write(parent, n, [{ path: [to], move: { path: [name] } }], header)
	}

	// the entry at index under one slot put under another, at toindex (default the end): one
	// children node (the same node, whatever keys reach it), one change, returned with the key of
	// the target; two nodes, a change on each, the one it goes into first
	function move(
		from: Slot,
		index: number,
		to: Slot,
		header: ChangeHeader,
		toindex?: number,
	): Changed[] {
		const [at, name] = from, [toat, toname] = to
		if (bad(toname)) throw new PlacesError("not-a-name", toname)
		const parent = parentOf(at), into = parentOf(toat)
		const n = node(parent)
		const list = array(n, name) ?? []
		if (!within(index, 0, list.length - 1)) {
			throw new PlacesError(list.length ? "range" : "nothing-there", name)
		}
		const moved = list[index]
		if (!isEntry(moved)) throw new PlacesError("nothing-there", name)
		// the same node, not the same key: the table may hold one node under several keys
		const same = children(into.source, into.id) === n
		if (same && name === toname) {
			return order(to, index, toindex ?? list.length - 1, header)
		}
		if (same) {
			if (taken(n, toname)) throw new PlacesError("already-there", toname)
			const target = array(n, toname)
			const i = toindex ?? target?.length ?? 0
			if (!within(i, 0, target?.length ?? 0)) throw new PlacesError("range", toname)
			const ps: Patch[] = []
			if (!target) ps.push({ path: [toname], value: [] })
			ps.push({
				path: [toname],
				range: [i, i],
				move: { path: [name], range: [index, index + 1] },
			})
			if (list.length === 1) ps.push({ path: [name] })
			return write(into, n, ps, header)
		}
		return [...place(to, moved, header, toindex), ...unplace(from, index, header)]
	}

	return { get, lookup, names, members, open, place, unplace, order, rename, move }
}

export type Places = {
	get: (address: Address, from?: Item | Entry, read?: Tell) => Item[]
	lookup: (address: Address, from?: Item | Entry, all?: boolean, read?: Tell) => Item[]
	names: (at: Item | Entry, read?: Tell) => string[]
	members: (at: Item | Entry, read?: Tell) => Item[]
	open: (address: Address, opened?: Tell) => {
		items: (read?: Tell) => readonly Item[]
		members: (read?: Tell) => readonly Item[]
		drop: () => void
	}
	place: (slot: Slot, entry: Entry, header: ChangeHeader, index?: number) => Changed[]
	unplace: (slot: Slot, index: number, header: ChangeHeader) => Changed[]
	order: (slot: Slot, from: number, to: number, header: ChangeHeader) => Changed[]
	rename: (slot: Slot, to: string, header: ChangeHeader) => Changed[]
	move: (from: Slot, index: number, to: Slot, header: ChangeHeader, toindex?: number) => Changed[]
}
