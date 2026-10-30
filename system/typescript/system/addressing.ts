import type { ChangeHeader } from "@ermine/graph/entry"
import { locationsOf, nearest } from "@ermine/places/header"
import { type Id, type Path, type Places, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { slot as slotOf, target as targetOf, type Thing } from "@ermine/processes/guard"
import type { Key } from "@ermine/graph/table"
import { dataOf, mint } from "../handles.ts"
import type { Inner, Node, NodeData, Step, Target } from "../context.ts"
import type { Base } from "./base.ts"
import { here } from "./setting.ts"
import { type ChangeView, USER_ACTIVATED } from "./shapes.ts"

export function viewOf(base: Base, h: ChangeHeader): ChangeView {
	let v = base.views.get(h)
	if (v === undefined) {
		const locations = locationsOf(h.frame)
		v = Object.freeze({
			time: h.time,
			actor: h.actor,
			...locations !== undefined && { locations },
			...nearest(h.frame, USER_ACTIVATED) === true && { userActivated: true as const },
		})
		base.views.set(h, v)
		base.changes.set(v, h)
	}
	return v
}

// The names from root down to id, going up id's names now. None if nothing reaches it.
export function up(base: Base, places: Places, root: Id, id: Id): Path | undefined {
	const visited = new Set<Id>()
	const go = (at: Id): Path | undefined => {
		if (at === root) return []
		visited.add(at)
		const running = base.processes.get(at)?.context.at
		if (running !== undefined) return [...running]
		const names = places.namesOf(at)
		for (let i = names.length - 1; i >= 0; i--) {
			if (visited.has(names[i].folder)) continue
			const above = go(names[i].folder)
			if (above !== undefined) return [...above, names[i].name]
		}
		return undefined
	}
	return go(id)
}

export function seenIn(base: Base, reader: Inner, id: Id): Path | undefined {
	const p = up(base, reader.places, reader.places.root, id)
	return p !== undefined && get(reader.places, p) === id ? p : undefined
}

export const thing = (id: Id, path?: Path): Thing => path === undefined ? { id } : { id, path }
export const aimed = (id: Id, path: Path | undefined, part?: Key, key?: readonly Step[]) =>
	targetOf(thing(id, path), part, key)
export const slotAt = (path: Path, parent: Id) =>
	slotOf(thing(parent, path.slice(0, -1)), path[path.length - 1])

// What x reaches: a path, a handle's place, or a handle by id. Other objects are not-a-handle.
export function nodeOf(inner: Inner, x: Target): NodeData {
	const { base, parts, resolve } = here(inner)
	parts.alive()
	if (typeof x === "string" || Array.isArray(x)) return { path: resolve(x), part: "value" }
	return dataOf(base.handles, x).node
}
export const handle = (inner: Inner, n: NodeData): Node => mint(here(inner).base.handles, n)
export const byId = (inner: Inner, id: Id, part: Key): Node => handle(inner, { id, part })
export const nodeAt = (inner: Inner, path: Path): Node => handle(inner, { path, part: "value" })
export const seen = (inner: Inner, id: Id) => {
	const { base } = here(inner)
	return seenIn(base, inner, id)
}
export const idOf = (inner: Inner, n: NodeData): Id | undefined => {
	const { places } = here(inner)
	return n.id ?? (n.path ? get(places, n.path) : undefined)
}
export const idThrough = (inner: Inner, x: Target): Id => needId(inner, nodeOf(inner, x))
export function needId(inner: Inner, n: NodeData): Id {
	const id = idOf(inner, n)
	if (id === undefined) throw new PlacesError("nothing-there", n.path?.join("/"))
	return id
}

export const attributesOf = (inner: Inner, x: Target): Node =>
	handle(inner, { ...nodeOf(inner, x), part: "attributes" })

export const keyOf = (path: Path) => JSON.stringify(path)
