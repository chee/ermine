// a root, and from it a hierarchy: walks by name, look, lookup (LIBRARY.tex), and placing ids
// in lists. nothing kept between calls, nothing tracked: each place read is said to depend,
// and the caller (the scheduler) tracks. placing is patches to lists, by mutate.ts: each a change
import createChange, { type Change, type Header } from "../../nodes/ts/change.ts"
import mutate, { type Which } from "../../opstreams/ts/mutate.ts"
import createNode, { type List, type Node, type Version } from "../../nodes/ts/node.ts"
import type { Patch } from "../../notify/ts/notify.ts"

// where a read is: names from the root, walked from the root each read
export type Place = readonly string[]

// inside: a place, and the trail cd made, the ids its walk took, the root first; with it,
// reads start from those nodes and walk only the address's own names
type Spot = { names: Place; trail?: readonly string[] }

// an optional first "/", any number of "..", then names
export type Address = readonly string[]

// what a read or write is at: an address, or an id, the node itself, no walk
export type Where = Address | string

// what a read rests on: an id being loaded, or one of its lists
// ["children"], ["info"]: which names it has
export type Part =
	| "loaded"
	| "value"
	| readonly ["info"]
	| readonly ["info", string]
	| readonly ["children"]
	| readonly ["children", string]
export type Depend = (id: string, part: Part) => void

// why an item was given: the node whose list it was, the name, the id taken, its position
export type Step = { node: string; name: string; id: string; at: number }

// node: none if not loaded, pending
// route: a step per name of the address; a lookup's, the step to its list
// up: a lookup's, how many nodes above the place's . its list was
export type Item<V, H> = {
	id: string
	route: Step[]
	node?: Node<V, H>
	up?: number
}

// an item with one object of its node: every version; none if the item is pending
export type Read<V, H> = Item<V, H> & { versions?: Version<V, H>[] }

// get: the node of an id, or none if it is not loaded
export type Get<V, H> = (id: string) => Node<V, H> | undefined

// one, or from up to not including to
export type Span = number | readonly [number, number]

export type Code =
	| "wrong-field"
	| "above-root"
	| "nothing-there"
	| "already-there"
	| "range"

export class PlacesError extends Error {
	constructor(
		readonly code: Code,
		readonly id?: string,
	) {
		super(id === undefined ? code : `${code} (${id})`)
	}
}

export type Options = {
	// the depend of a read given none (the host's, or the person's)
	fallback?: Depend
	// the change's header (change.ts: time, actor, reader?, site?, cause?), asked for each
	// change; none: placing throws
	by?: () => Header
}

// never a name: ".", "..", or "/"; a name may hold a "/"
const never = (name: string) => name === "." || name === ".." || name === "/"

function list<V, H>(n: Node<V, H>, name: string): List | undefined {
	return n.children.get(name)?.[0]?.content
}

// the list's length, none: 0
const size = <V, H>(n: Node<V, H>, name: string) => n.children.get(name)?.[0]?.content?.length ?? 0

// the entry of name to slot, the rest in order; in place, so holders of the node see it
// the names' order is no object (GRAPH.tex, Children): moved outside any change
function slot<V, H>(n: Node<V, H>, name: string, at: number) {
	const entries = [...n.children]
	const i = entries.findIndex(([k]) => k === name)
	if (i === -1) return
	const [e] = entries.splice(i, 1)
	entries.splice(Math.min(at, entries.length), 0, e)
	n.children.clear()
	for (const [k, v] of entries) n.children.set(k, v)
}

export function createPlaces<V, H>(
	get: Get<V, H>,
	root: string,
	options: Options = {},
) {
	type N = Node<V, H>
	const { fallback } = options

	// the names an address reaches, from the root, and how many are the address's own
	function resolve(
		place: Spot,
		address: Address,
	): { names: string[]; own: number; base: number } {
		for (const n of place.names) {
			if (never(n)) throw new PlacesError("wrong-field")
		}
		let i = 0
		const names = address[0] === "/" ? [] : place.names.slice()
		if (address[0] === "/") i = 1
		for (; address[i] === ".."; i++) {
			if (names.length === 0) throw new PlacesError("above-root")
			names.pop()
		}
		const own = address.length - i
		const base = names.length
		for (; i < address.length; i++) {
			if (never(address[i])) throw new PlacesError("wrong-field")
			names.push(address[i])
		}
		return { names, own, base }
	}

	// down the names from the node of id start (the root, or a trail's); taken: the nodes gone
	// through, start first. last: the last name's list, with the node it was in; none if the
	// walk stopped before it. pick: take the last list's first loaded, the place's . (look,
	// which gives every id of it, does not)
	function walk(
		names: readonly string[],
		depend?: Depend,
		start = root,
		from = 0,
		pick = true,
	) {
		const taken: N[] = []
		const steps: Step[] = []
		depend?.(start, "loaded")
		let at = get(start)
		if (at === undefined) return { taken, steps, last: undefined }
		taken.push(at)
		for (let k = from; k < names.length; k++) {
			const name = names[k]
			// past the first name, said when the id was asked for it
			if (k === from) depend?.(at.id, ["children", name])
			const ids = list(at, name)
			if (ids === undefined) return { taken, steps, last: undefined }
			if (k === names.length - 1) {
				// the place's . : the first loaded
				if (pick) {
					for (let j = 0; j < ids.length; j++) {
						const id = ids[j]
						if (typeof id !== "string") continue
						depend?.(id, "loaded")
						const n = get(id)
						if (n === undefined) continue
						taken.push(n)
						steps.push({ node: at.id, name, id, at: j })
						break
					}
				}
				return { taken, steps, last: { node: at.id, name, ids } }
			}
			const next = names[k + 1]
			let found: N | undefined
			for (let j = 0; j < ids.length; j++) {
				const id = ids[j]
				if (typeof id !== "string") continue
				depend?.(id, "loaded")
				const n = get(id)
				if (n === undefined) continue
				depend?.(id, ["children", next])
				if (list(n, next) === undefined) continue
				found = n
				steps.push({ node: at.id, name, id, at: j })
				break
			}
			if (found === undefined) return { taken, steps, last: undefined }
			taken.push(found)
			at = found
		}
		return { taken, steps, last: undefined }
	}

	function items(
		node: string,
		name: string,
		ids: List,
		route: Step[],
		depend?: Depend,
		up?: number,
	): Item<V, H>[] {
		const out: Item<V, H>[] = []
		for (let j = 0; j < ids.length; j++) {
			const id = ids[j]
			if (typeof id !== "string") continue
			depend?.(id, "loaded")
			const item: Item<V, H> = { id, route: [...route, { node, name, id, at: j }] }
			const n = get(id)
			if (n !== undefined) item.node = n
			if (up !== undefined) item.up = up
			out.push(item)
		}
		return out
	}

	// an item per id in the last name's list, in order; no names: the root; an id: its node
	function look(
		place: Spot,
		address: Where,
		depend = fallback,
	): Item<V, H>[] {
		if (typeof address === "string") {
			depend?.(address, "loaded")
			const n = get(address)
			return [n === undefined ? { id: address, route: [] } : { id: address, route: [], node: n }]
		}
		const { names, own, base } = resolve(place, address)
		if (names.length === 0) {
			depend?.(root, "loaded")
			const n = get(root)
			return [
				n === undefined ? { id: root, route: [] } : { id: root, route: [], node: n },
			]
		}
		// with a trail: from the node the last kept name reached, or its parent for none of
		// the address's own; a step it did not take reaches nothing
		const trail = place.trail
		const from = own > 0 ? base : base - 1
		if (trail !== undefined && from >= trail.length) return []
		const w = trail === undefined
			? walk(names, depend, root, 0, false)
			: walk(names, depend, trail[from], from, false)
		if (w.last === undefined) return []
		// the steps down to the last list, the address's own names only
		const walked = names.length - (trail === undefined ? 0 : from)
		const route = own > 1 ? w.steps.slice(walked - own, walked - 1) : []
		return items(w.last.node, w.last.name, w.last.ids, route, depend)
	}

	// the lists of name in the nodes the place's walk went through, from its . up to its start
	// from n, already said loaded, down path to its last list: an id taken only if it has the
	// next name, as a walk takes it; none if the path is not there
	function down(n: N, path: readonly string[], depend?: Depend) {
		const steps: Step[] = []
		let at = n
		for (let k = 0; k < path.length - 1; k++) {
			const name = path[k]
			const next = path[k + 1]
			if (k === 0) depend?.(at.id, ["children", name])
			const ids = list(at, name)
			if (ids === undefined) return undefined
			let found: N | undefined
			for (let j = 0; j < ids.length; j++) {
				const id = ids[j]
				if (typeof id !== "string") continue
				depend?.(id, "loaded")
				const c = get(id)
				if (c === undefined) continue
				depend?.(id, ["children", next])
				if (list(c, next) === undefined) continue
				found = c
				steps.push({ node: at.id, name, id, at: j })
				break
			}
			if (found === undefined) return undefined
			at = found
		}
		const name = path[path.length - 1]
		if (path.length === 1) depend?.(at.id, ["children", name])
		const ids = list(at, name)
		return ids === undefined ? undefined : { steps, node: at.id, name, ids }
	}

	// the nodes the place's walk went through, from its . up to its start: in each, path, down
	function search(
		place: Spot,
		path: readonly string[],
		all: boolean,
		depend = fallback,
	): Item<V, H>[] {
		for (const name of path) if (never(name)) throw new PlacesError("wrong-field")
		const out: Item<V, H>[] = []
		if (path.length === 0) return out
		const { names } = resolve(place, [])
		const taken = place.trail === undefined
			? walk(names, depend).taken
			: along(place.trail, depend)
		for (let i = taken.length - 1; i >= 0; i--) {
			const d = down(taken[i], path, depend)
			if (d === undefined) continue
			const found = items(d.node, d.name, d.ids, d.steps, depend, taken.length - 1 - i)
			if (!found.some((it) => it.node !== undefined)) continue
			if (!all) return found
			out.push(...found)
		}
		return out
	}

	// a trail's nodes, up to the first not loaded
	function along(trail: readonly string[], depend?: Depend): N[] {
		const out: N[] = []
		for (const id of trail) {
			depend?.(id, "loaded")
			const n = get(id)
			if (n === undefined) break
			out.push(n)
		}
		return out
	}

	// a trail: the address walked once, from from; the walk said to depend, so a caller can cd
	// again when what it read changes
	function enter(
		address: Address,
		from: Spot,
		depend = fallback,
	): Spot {
		const { names, own, base } = resolve(from, address)
		const was = from.trail
		let trail: string[]
		if (was === undefined) trail = walk(names, depend).taken.map((n) => n.id)
		// back up the trail, or past its end: the steps it took, no walk
		else if (own === 0 || base >= was.length) trail = was.slice(0, base + 1)
		else {
			const w = walk(names, depend, was[base], base)
			trail = [...was.slice(0, base), ...w.taken.map((n) => n.id)]
		}
		return { names, trail }
	}

	// the nearest path of names whose last list holds a loaded node; none given: none
	const lookup = (place: Spot, path: readonly string[], depend?: Depend) =>
		search(place, path, false, depend)
	// every such path's list, nearest first
	const lookups = (place: Spot, path: readonly string[], depend?: Depend) =>
		search(place, path, true, depend)

	// with a name: that list's ids in each loaded node the address selects, node by node
	// without: every name they have, once, first seen first
	function children(
		place: Spot,
		address: Where,
		name?: string,
		depend = fallback,
	) {
		if (name !== undefined && never(name)) throw new PlacesError("wrong-field")
		const out: Item<V, H>[] = []
		const seen = new Set<string>()
		for (const it of look(place, address, depend)) {
			if (it.node === undefined) continue
			if (name === undefined) {
				depend?.(it.id, ["children"])
				for (const k of it.node.children.keys()) seen.add(k)
				continue
			}
			depend?.(it.id, ["children", name])
			const ids = list(it.node, name)
			if (ids !== undefined) {
				out.push(...items(it.id, name, ids, it.route, depend))
			}
		}
		return name === undefined ? [...seen] : out
	}

	// every name of one part, of each loaded node the address selects, once, first seen first,
	// in each node's order
	function names(place: Spot, address: Where, part: "info" | "children", depend = fallback) {
		if (part !== "info" && part !== "children") throw new PlacesError("wrong-field")
		const seen = new Set<string>()
		for (const it of look(place, address, depend)) {
			if (it.node === undefined) continue
			depend?.(it.id, [part])
			for (const k of (part === "info" ? it.node.info : it.node.children).keys()) seen.add(k)
		}
		return [...seen]
	}

	// placing: by the node whose list it is (its id, or the node), and the list's name

	type C = Node<V, Change>
	function by(): Header {
		if (options.by === undefined) throw new TypeError("no by: places that only read")
		return options.by()
	}
	// a parent: its id, or the node itself, for a holder of the table
	type Parent = string | N
	function held(parent: Parent): C {
		if (typeof parent !== "string") return parent as unknown as C
		const n = get(parent)
		if (n === undefined) throw new PlacesError("nothing-there", parent)
		return n as unknown as C
	}

	// one object of a node: its versions, and putting new ones; none left: the name gone
	function versions(n: C, which: Which) {
		if (which === "value") {
			return {
				get: () => n.value,
				set: (vs: C["value"]) => void (n.value = vs),
				scratch: (base: C["value"]) => createNode<V, Change>(n.id, { value: base }),
			}
		}
		const map = (which[0] === "info" ? n.info : n.children) as Map<
			string,
			C["value"]
		>
		const name = which[1]
		return {
			get: () => map.get(name) ?? [],
			set: (vs: C["value"]) => void (vs.length === 0 ? map.delete(name) : map.set(name, vs)),
			scratch: (base: C["value"]) => createNode<V, Change>(n.id, { [which[0]]: [[name, base]] }),
		}
	}

	// patches to the version from of one object of n; the versions from to to replaced by what
	// they make, at from: one change. no versions: slots 0 makes the first
	function edit(
		n: C,
		which: Which,
		slots: Span,
		patches: (content: unknown) => Patch[],
	): Change {
		const o = versions(n, which)
		const vs = o.get()
		const [from, to] = typeof slots === "number" ? [slots, slots + 1] : slots
		const ok = vs.length === 0 ? from === 0 && to <= 1 : from < to && to <= vs.length
		if (!ok || from < 0) throw new PlacesError("range", n.id)
		const base = vs.slice(from, from + 1)
		const scratch = o.scratch(base)
		const list = which !== "value" && which[0] === "children"
		const c = mutate(
			scratch,
			which,
			patches(base[0]?.content ?? (list ? [] : undefined)),
			by(),
		)
		const made = versions(scratch, which).get()
		o.set([...vs.slice(0, from), ...made, ...vs.slice(to)])
		return c
	}

	// ids put in at index, a gap (default the end); a span: the ids there replaced
	function place(
		n: C,
		name: string,
		ids: List,
		index?: Span,
		slotindex: Span = 0,
	): Change {
		if (never(name)) throw new PlacesError("wrong-field", n.id)
		return edit(n, ["children", name], slotindex, (content) => {
			const have = content as List
			const [a, b] = index === undefined
				? [have.length, have.length]
				: typeof index === "number"
				? [index, index]
				: index
			if (a < 0 || a > b || b > have.length) {
				throw new PlacesError("range", n.id)
			}
			return [{ path: [], range: [a, b], value: ids }]
		})
	}

	// child put in id's list of name; it need not be loaded
	// slotindex: the version (default 0); a span: those versions replaced by the one made
	const insert = (
		id: Parent,
		name: string,
		child: string,
		index?: Span,
		slotindex?: Span,
	) => place(held(id), name, [child], index, slotindex)

	// the ids at index taken out of id's list of name, leaving nothing in their place: one change
	// slotindex: the version (default 0); a span: those versions replaced by the one made
	function remove(
		id: Parent,
		name: string,
		index: Span,
		slotindex: Span = 0,
	): Change {
		return cut(held(id), name, index, slotindex)
	}
	function cut(n: C, name: string, index: Span, slotindex: Span = 0): Change {
		return edit(n, ["children", name], slotindex, (content) => {
			const have = content as List
			const [a, b] = typeof index === "number" ? [index, index + 1] : index
			if (a < 0 || a >= b || b > have.length) throw new PlacesError("range", n.id)
			return [{ path: [], range: [a, b] }]
		})
	}

	// the versions slotindex of id's list of name dropped whole (GRAPH.tex, pop): one change
	// the others as they were; none left: the name gone
	function pop(id: Parent, name: string, slotindex: Span): Change {
		const n = held(id)
		const vs = n.children.get(name) ?? []
		const [from, to] = typeof slotindex === "number" ? [slotindex, slotindex + 1] : slotindex
		if (from < 0 || from >= to || to > vs.length) {
			throw new PlacesError("range", n.id)
		}
		const next = [...vs.slice(0, from), ...vs.slice(to)]
		if (next.length === 0) n.children.delete(name)
		else n.children.set(name, next)
		return createChange(n.id, by())
	}

	// a list to a new name: a removal and a put (GRAPH.tex: no move across objects), two changes
	// its entry keeps its slot; the old name's later versions stay
	function rename(id: Parent, name: string, to: string): Change[] {
		const n = held(id)
		if (never(to)) throw new PlacesError("wrong-field", n.id)
		if (n.children.has(to)) throw new PlacesError("already-there", n.id)
		const ids = n.children.get(name)?.[0]?.content
		if (ids === undefined) throw new PlacesError("nothing-there", n.id)
		const at = [...n.children.keys()].indexOf(name)
		const gone = mutate(n, ["children", name], [{ path: [] }], by())
		const put = place(n, to, ids)
		slot(n, to, at)
		return [gone, put]
	}

	// the entry at index of id's list of name to toid's list of toname, at toindex
	// (default the end), counted after it left; one list: one change, else two; first versions
	function move(
		id: Parent,
		name: string,
		index: number,
		toid: Parent,
		toname: string,
		toindex?: number,
	): Change[] {
		const from = held(id)
		const to = held(toid)
		// all checked before the first change, so a failed move changes nothing
		if (never(toname)) throw new PlacesError("wrong-field", to.id)
		const ids = from.children.get(name)?.[0]?.content
		if (ids === undefined || index < 0 || index >= ids.length) {
			throw new PlacesError("range", from.id)
		}
		const same = from === to && name === toname
		const room = size(to, toname) - (same ? 1 : 0)
		const at = toindex ?? room
		if (at < 0 || at > room) throw new PlacesError("range", to.id)
		if (same) {
			const patch = {
				path: [],
				range: [at, at] as [number, number],
				move: { path: [index] },
			}
			return [mutate(from, ["children", name], [patch], by())]
		}
		const entry = ids[index]
		return [cut(from, name, index), place(to, toname, [entry], at)]
	}

	// an object of each item look gives, every version: the first loaded item's wins
	// said to depend: the walk, as look, then the object of each loaded item
	function read(
		place: Spot,
		address: Where,
		part: "value" | readonly ["info", string],
		depend?: Depend,
	): Read<V, H>[] {
		const out: Read<V, H>[] = look(place, address, depend)
		for (const it of out) {
			if (it.node === undefined) continue
			depend?.(it.id, part)
			it.versions = part === "value" ? it.node.value : (it.node.info.get(part[1]) ?? [])
		}
		return out
	}
	const content = (place: Spot, address: Where, depend = fallback) =>
		read(place, address, "value", depend)
	function info(
		place: Spot,
		address: Where,
		name: string,
		depend = fallback,
	) {
		if (never(name)) throw new PlacesError("wrong-field")
		return read(place, address, ["info", name], depend)
	}

	// writing by path, by mutate.ts: one change. the item: the index-th look gives, default its
	// first loaded; slotindex as insert's. the walk to it is said to no depend: a write reads nothing
	const quiet: Depend = () => {}
	function at(place: Spot, address: Where, index?: number): C {
		const items = look(place, address, quiet)
		const it = index === undefined ? items.find((it) => it.node) : items[index]
		if (index !== undefined && (index < 0 || it === undefined)) {
			throw new PlacesError("range")
		}
		if (it?.node === undefined) throw new PlacesError("nothing-there", it?.id)
		return it.node as unknown as C
	}
	// the value
	function write(
		place: Spot,
		address: Where,
		patches: Iterable<Patch>,
		index?: number,
		slotindex: Span = 0,
	): Change {
		const n = at(place, address, index)
		return edit(n, "value", slotindex, () => [...patches])
	}
	// one info, by name
	function set(
		place: Spot,
		address: Where,
		name: string,
		patches: Iterable<Patch>,
		index?: number,
		slotindex: Span = 0,
	): Change {
		if (never(name)) throw new PlacesError("wrong-field")
		const n = at(place, address, index)
		return edit(n, ["info", name], slotindex, () => [...patches])
	}

	// a place cd made: the reads, at it, taking only the address
	function here(spot: Spot) {
		return {
			names: spot.names,
			trail: spot.trail!,
			cd: (address: Address, depend = fallback) => here(enter(address, spot, depend)),
			look: (address: Where, depend?: Depend) => look(spot, address, depend),
			lookup: (path: readonly string[], depend?: Depend) => lookup(spot, path, depend),
			lookups: (path: readonly string[], depend?: Depend) => lookups(spot, path, depend),
			children: (address: Where, name?: string, depend?: Depend) =>
				children(spot, address, name, depend),
			content: (address: Where, depend?: Depend) => content(spot, address, depend),
			info: (address: Where, name: string, depend?: Depend) => info(spot, address, name, depend),
			write: (
				address: Where,
				patches: Iterable<Patch>,
				index?: number,
				slotindex?: Span,
			) => write(spot, address, patches, index, slotindex),
			set: (
				address: Where,
				name: string,
				patches: Iterable<Patch>,
				index?: number,
				slotindex?: Span,
			) => set(spot, address, name, patches, index, slotindex),
		}
	}

	return {
		cd: (address: Address, depend = fallback) => here(enter(address, { names: [] }, depend)),
		look: (place: Place, address: Where, depend?: Depend) =>
			look({ names: place }, address, depend),
		lookup: (place: Place, path: readonly string[], depend?: Depend) =>
			lookup({ names: place }, path, depend),
		lookups: (place: Place, path: readonly string[], depend?: Depend) =>
			lookups({ names: place }, path, depend),
		children: (
			place: Place,
			address: Where,
			name?: string,
			depend?: Depend,
		) => children({ names: place }, address, name, depend),
		names: (place: Place, address: Where, part: "info" | "children", depend?: Depend) =>
			names({ names: place }, address, part, depend),
		content: (place: Place, address: Where, depend?: Depend) =>
			content({ names: place }, address, depend),
		info: (place: Place, address: Where, name: string, depend?: Depend) =>
			info({ names: place }, address, name, depend),
		write: (
			place: Place,
			address: Where,
			patches: Iterable<Patch>,
			index?: number,
			slotindex?: Span,
		) => write({ names: place }, address, patches, index, slotindex),
		set: (
			place: Place,
			address: Where,
			name: string,
			patches: Iterable<Patch>,
			index?: number,
			slotindex?: Span,
		) => set({ names: place }, address, name, patches, index, slotindex),
		insert,
		remove,
		pop,
		rename,
		move,
	}
}
