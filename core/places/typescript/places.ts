// places: names from a root, walked through children nodes. a children node's value maps each name
// to an array of entries, in order: [source, id], what put it there and the id. the array is the
// order: the front is first. places knows no source's meaning, and no part but children; whoever
// reads asks for an item's other parts elsewhere
import type { ChangeHeader, Node } from "@ermine/node"
import update from "@ermine/node/update"
import type { Facts, Patch } from "@ermine/op/apply"
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
// how a caller learns where to put something
export type Read = { readonly source: Key; readonly id: Key; readonly path: readonly string[] }

// a name in a parent's children: the parent (an item, or an entry), and the name
export type Slot = readonly [parent: Item | Entry, name: string]

export type Setup = {
	// where names start: an id, with the source ROOT, or an entry
	root: Key | Entry
	// the children node of id as source has it; none: not there (not loaded, or never made). where
	// a source's nodes are kept is the caller's: one table for all, a table per source, anything
	children: (source: Key, id: Key) => Node<unknown> | undefined
	// told of each read, as it is made
	read?: (read: Read) => void
	// told of each patch places' writes landed, with what it found (node's update's each), and
	// the children node's source and id
	each?: (source: Key, id: Key, patch: Patch, facts: Facts) => void
}

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

const bad = (name: string) => name === "." || name === ".." || name === "/"

function isMap(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}

const isKey = (k: unknown): k is Key => typeof k === "string" || typeof k === "symbol"

// the array under name in a children node; none, or not an array: undefined
function array(node: Node<unknown> | undefined, name: string): readonly unknown[] | undefined {
	const v = node?.value
	if (!isMap(v) || !Object.hasOwn(v, name)) return undefined
	const list = v[name]
	return Array.isArray(list) ? list : undefined
}

// an entry, or undefined for anything else in an array: it keeps its position, and is no item
const entry = (e: unknown): Entry | undefined =>
	Array.isArray(e) && e.length === 2 && isKey(e[0]) && isKey(e[1]) ? [e[0], e[1]] : undefined

// what a held place keeps per step: the items it was walked from, the children nodes they read
// and at which change, what that gave, and how many opened places share it
type Seen = { source: Key; id: Key; node: Node<unknown> | undefined; change: unknown }
type Step = { from: readonly Item[] | null; items: Item[]; seen: Seen[]; opened: number }

export function createPlaces(setup: Setup) {
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
	// way the start was reached; above it: undefined
	function plan(address: Address, from?: Item | Entry): [Item, string[]] | undefined {
		let at: Item | undefined = begin(from)
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
	function step(items: readonly Item[], name: string, seen?: Seen[]): Item[] {
		const out: Item[] = []
		for (const up of items) {
			const node = children(up.source, up.id)
			tell?.({ source: up.source, id: up.id, path: [name] })
			seen?.push({ source: up.source, id: up.id, node, change: node?.change })
			const list = array(node, name) ?? []
			for (let i = 0; i < list.length; i++) {
				const e = entry(list[i])
				if (e) out.push({ source: e[0], id: e[1], up, name, at: i })
			}
		}
		return out
	}

	// what is at the address, front first: from the root, an item, or an entry
	function get(address: Address, from?: Item | Entry): Item[] {
		const p = plan(address, from)
		if (!p) return []
		let items = [p[0]]
		for (const name of p[1]) {
			if (!items.length) break
			items = step(items, name)
		}
		return items
	}

	// the address from the start, then from each place the start was found in, nearest first:
	// what the nearest gives; all: what each gives, nearest first
	function lookup(address: Address, from?: Item | Entry, all = false): Item[] {
		const out: Item[] = []
		for (let at: Item | undefined = begin(from); at; at = at.up) {
			const found = get(address, at)
			if (found.length && !all) return found
			out.push(...found)
		}
		return out
	}

	// the names in an item's children, in their order there; a read of the whole value
	function names(at: Item | Entry): string[] {
		const item = begin(at)
		const v = children(item.source, item.id)?.value
		tell?.({ source: item.source, id: item.id, path: [] })
		return isMap(v) ? Object.keys(v).filter((k) => Array.isArray(v[k])) : []
	}

	// opened places: a trie of the opened addresses from the root, each step keeping what it
	// read. places opened with the same beginning share its steps
	const held = createTrie<Step>()

	// a step still good: every children node it read is the one there, at the same change
	const good = (s: Step) =>
		s.seen.every((x) => {
			const node = children(x.source, x.id)
			return node === x.node && node?.change === x.change
		})

	// the address from the root, opened: items() gives what is there now. a step is walked again
	// only when the step before it gave other items, or a children node it read is not the one
	// there or is at another change; nothing changed: the same list. each call tells every read
	// the held address rests on. drop: let go
	function open(address: Address) {
		const p = plan(address)
		const start = p ? [p[0]] : []
		const names = p ? p[1] : []
		const path: Held<Step>[] = []
		for (let i = 1; i <= names.length; i++) {
			const e = held.make(names.slice(0, i))
			e.value ??= { from: null, items: [], seen: [], opened: 0 }
			e.value.opened++
			path.push(e)
		}
		let dropped = false
		function items(): readonly Item[] {
			if (dropped || !p) return []
			let before: readonly Item[] = start
			for (let i = 0; i < path.length; i++) {
				const s = path[i].value!
				if (s.from !== before || !good(s)) {
					s.from = before
					s.seen = []
					s.items = before.length ? step(before, names[i], s.seen) : []
				} else if (tell) {
					for (const x of s.seen) tell({ source: x.source, id: x.id, path: [names[i]] })
				}
				before = s.items
			}
			return before
		}
		function drop() {
			if (dropped) return
			dropped = true
			for (const e of path) if (--e.value!.opened === 0) e.value = undefined
			if (path.length) held.prune(path[path.length - 1])
		}
		return { items, drop }
	}

	// writing

	const parentOf = (at: Item | Entry) => begin(at)

	function node(parent: Item) {
		const n = children(parent.source, parent.id)
		if (n === undefined) throw new PlacesError("nothing-there")
		return n
	}

	function write(parent: Item, n: Node<unknown>, patches: Patch[], header: ChangeHeader) {
		const each = setup.each
		update(
			n,
			patches,
			header,
			each ? { each: (p, f) => each(parent.source, parent.id, p, f) } : {},
		)
	}

	// the patches that make sure n's value is a map, first
	const base = (n: Node<unknown>): Patch[] => isMap(n.value) ? [] : [{ path: [], value: {} }]

	// entry placed under name, at index (default the end): one change on the parent's children
	function place([at, name]: Slot, entry: Entry, header: ChangeHeader, index?: number) {
		if (bad(name)) throw new PlacesError("not-a-name", name)
		const parent = parentOf(at)
		const n = node(parent)
		const list = array(n, name)
		const i = index ?? list?.length ?? 0
		if (i < 0 || i > (list?.length ?? 0)) throw new PlacesError("range", name)
		const ps = base(n)
		const put = [[entry[0], entry[1]]]
		ps.push(list ? { path: [name], range: [i, i], value: put } : { path: [name], value: put })
		write(parent, n, ps, header)
	}

	// the entry at index under name taken out; the last one: the name too. one change
	function unplace([at, name]: Slot, index: number, header: ChangeHeader) {
		const parent = parentOf(at)
		const n = node(parent)
		const list = array(n, name)
		if (!list?.length) throw new PlacesError("nothing-there", name)
		if (index < 0 || index >= list.length) throw new PlacesError("range", name)
		const ps: Patch[] = list.length === 1
			? [{ path: [name] }]
			: [{ path: [name], range: [index, index + 1] }]
		write(parent, n, ps, header)
	}

	// the entry at from under name moved to index to, counted with it taken out: one change. to 0:
	// the front, the one chosen
	function order([at, name]: Slot, from: number, to: number, header: ChangeHeader) {
		const parent = parentOf(at)
		const n = node(parent)
		const list = array(n, name) ?? []
		if (from < 0 || from >= list.length || to < 0 || to > list.length - 1) {
			throw new PlacesError("range", name)
		}
		if (from === to) return
		write(parent, n, [{
			path: [name],
			range: [to, to],
			move: { path: [name], range: [from, from + 1] },
		}], header)
	}

	// everything under name moved to the name to: one change
	function rename([at, name]: Slot, to: string, header: ChangeHeader) {
		if (bad(to)) throw new PlacesError("not-a-name", to)
		const parent = parentOf(at)
		const n = node(parent)
		if (!array(n, name)?.length) throw new PlacesError("nothing-there", name)
		if (to === name) return
		if (isMap(n.value) && Object.hasOwn(n.value, to)) throw new PlacesError("already-there", to)
		write(parent, n, [{ path: [to], move: { path: [name] } }], header)
	}

	// the entry at index under one slot put under another, at toindex (default the end): one
	// parent, one change; two, a change on each, the one it goes into first
	function move(from: Slot, index: number, to: Slot, header: ChangeHeader, toindex?: number) {
		const [at, name] = from, [toat, toname] = to
		if (bad(toname)) throw new PlacesError("not-a-name", toname)
		const parent = parentOf(at), into = parentOf(toat)
		const n = node(parent)
		const list = array(n, name) ?? []
		if (index < 0 || index >= list.length) {
			throw new PlacesError(list.length ? "range" : "nothing-there", name)
		}
		const moved = entry(list[index])
		if (!moved) throw new PlacesError("nothing-there", name)
		if (parent.source === into.source && parent.id === into.id && name === toname) {
			return order(from, index, toindex ?? list.length - 1, header)
		}
		if (parent.source === into.source && parent.id === into.id) {
			const target = array(n, toname)
			const i = toindex ?? target?.length ?? 0
			if (i < 0 || i > (target?.length ?? 0)) throw new PlacesError("range", toname)
			const ps: Patch[] = []
			if (!target) ps.push({ path: [toname], value: [] })
			ps.push({
				path: [toname],
				range: [i, i],
				move: { path: [name], range: [index, index + 1] },
			})
			if (list.length === 1) ps.push({ path: [name] })
			write(parent, n, ps, header)
			return
		}
		place(to, moved, header, toindex)
		unplace(from, index, header)
	}

	return { get, lookup, names, open, place, unplace, order, rename, move }
}

export type Places = ReturnType<typeof createPlaces>
