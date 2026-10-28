import type { ChangeHeader } from "@ermine/core/node/entry"
import { type Id, type Path, type Places, PlacesError } from "@ermine/core/places"
import { get } from "@ermine/core/places/lib"
import { slot as slotOf, target as targetOf, type Thing } from "@ermine/core/places/guard"
import type { Key } from "@ermine/core/table"
import { dataOf, mint } from "../handles.ts"
import type { Inner, Node, NodeData, Step, Target } from "../context.ts"
import type { Base } from "./base.ts"
import { here } from "./setting.ts"
import { type ChangeView, USER_ACTIVATED } from "./shapes.ts"

// a change's view (ChangeView): made once, and kept so explain can take it back
export function viewOf(base: Base, h: ChangeHeader): ChangeView {
	let v = base.views.get(h)
	if (v === undefined) {
		const site = h.external?.[0]
		v = Object.freeze({
			time: h.time,
			actor: h.actor,
			...site !== undefined && { site },
			...h.metadata?.[USER_ACTIVATED] === true && { userActivated: true as const },
		})
		base.views.set(h, v)
		base.changes.set(v, h)
	}
	return v
}

// the names from root down to id, up id's names now (places' namesOf, the latest placed first at
// each step; a process's node, named by its row: where it runs);
// none: nothing reaches it from root. read untracked
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

// id's path from the root: up its names, then walked down (tracked: a rename on the way reruns who
// asked). none: nothing reaches it
export function seenIn(base: Base, reader: Inner, id: Id): Path | undefined {
	const p = up(base, reader.places, reader.places.root, id)
	return p !== undefined && get(reader.places, p) === id ? p : undefined
}

export const thing = (id: Id, path?: Path): Thing => path === undefined ? { id } : { id, path }
// what a policy is asked about: id's part (and a key in it), by the path it was reached by
export const aimed = (id: Id, path: Path | undefined, part?: Key, key?: readonly Step[]) =>
	targetOf(thing(id, path), part, key)
// the parent at path's folder, and the name: what placing there changes
export const slotAt = (path: Path, parent: Id) =>
	slotOf(thing(parent, path.slice(0, -1)), path[path.length - 1])

// what x reaches, as inner reaches it: a path (resolved here); a handle's place (its path from the
// root); a handle by id, that node. an object that is no handle: not-a-handle
export function nodeOf(inner: Inner, x: Target): NodeData {
	const { base, parts, resolve } = here(inner)
	parts.alive()
	if (typeof x === "string" || Array.isArray(x)) return { path: resolve(x), part: "value" }
	return dataOf(base.handles, x).node
}
// a handle for n: a place (its path from the root) or a node by id. no maker: a handle names a
// place, whoever made it
export const handle = (inner: Inner, n: NodeData): Node => mint(here(inner).base.handles, n)
export const byId = (inner: Inner, id: Id, part: Key): Node => handle(inner, { id, part })
// the node at path, as a handle
export const nodeAt = (inner: Inner, path: Path): Node => handle(inner, { path, part: "value" })
// id's path from the root (seenIn; none: nothing reaches it)
export const seen = (inner: Inner, id: Id) => {
	const { base } = here(inner)
	return seenIn(base, inner, id)
}
export const idOf = (inner: Inner, n: NodeData): Id | undefined => {
	const { places } = here(inner)
	return n.id ?? (n.path ? get(places, n.path) : undefined)
}
// x's id, as inner reaches it
export const idThrough = (inner: Inner, x: Target): Id => needId(inner, nodeOf(inner, x))
export function needId(inner: Inner, n: NodeData): Id {
	const id = idOf(inner, n)
	if (id === undefined) throw new PlacesError("nothing-there", n.path?.join("/"))
	return id
}

// x's attributes, as a node
export const attributesOf = (inner: Inner, x: Target): Node =>
	handle(inner, { ...nodeOf(inner, x), part: "attributes" })

export const keyOf = (path: Path) => JSON.stringify(path)
