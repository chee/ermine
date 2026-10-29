import type { Entry } from "@ermine/graph/entry"
import { type Id, type Path, PlacesError, placing, unplacing } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { type Inner, whole } from "../context.ts"
import { slotAt } from "./addressing.ts"
import type { Base } from "./base.ts"
import { here } from "./setting.ts"

// the folder a path is in; none: it is not there
export const parentOf = (inner: Inner, path: Path): Id | undefined =>
	get(here(inner).places, path.slice(0, -1))
// ... or nothing-there
export function folderOf(inner: Inner, path: Path): Id {
	const parent = parentOf(inner, path)
	if (parent === undefined) throw new PlacesError("nothing-there", path.join("/"))
	return parent
}
// ... or nothing-there, as the root has none
export function needParent(inner: Inner, path: Path): Id {
	if (path.length === 0) throw new PlacesError("nothing-there", "")
	return folderOf(inner, path)
}

// the folder's children entry as it is now, and the names it holds, each its node's id
export const childrenOf = (inner: Inner, folder: Id) =>
	here(inner).table.get("children", folder) as Entry<unknown> | undefined
export const namesIn = (children: Entry<unknown> | undefined) =>
	children?.value as Record<string, Id> | undefined

// id placed under name in the folder parent (at path, its name the last): its children entry
// made when it has none
export function placeUnder(inner: Inner, parent: Id, name: string, id: Id, path?: Path) {
	if (path !== undefined) here(inner).ask("place", slotAt(path, parent))
	inner.put({
		part: "children",
		id: parent,
		patches: placing(childrenOf(inner, parent), name, id),
	})
}
// name taken out of the folder's children entry; with only, while it holds that node (else not)
export function takeOut(inner: Inner, folder: Id, name: string, only?: Id) {
	const children = childrenOf(inner, folder)
	if (only !== undefined && namesIn(children)?.[name] !== only) return
	inner.put({ part: "children", id: folder, patches: unplacing(children, name) })
}
// a node at path holding value (none: nothing in it), the nodes on the way made
export function build(inner: Inner, path: Path, value: unknown, given?: Id): Id {
	const { newId, places, ask } = here(inner)
	const id = given ?? newId()
	if (path.length === 0) throw new PlacesError("already-there", "/")
	let parent: Id = places.root
	for (let i = 0; i < path.length - 1; i++) {
		const there = get(places, path.slice(0, i + 1))
		if (there !== undefined) parent = there
		else {
			const folder = newId()
			placeUnder(inner, parent, path[i], folder, path.slice(0, i + 1))
			parent = folder
		}
	}
	ask("place", slotAt(path, parent))
	if (value !== undefined) inner.put({ part: "value", id, path, patches: whole(value) })
	placeUnder(inner, parent, path[path.length - 1], id)
	return id
}
// the children entry of the folder a path is in, and the name
export function slot(inner: Inner, path: Path): [Entry<unknown>, string] {
	const children = childrenOf(inner, needParent(inner, path))
	if (children === undefined) throw new PlacesError("nothing-there", path.join("/"))
	return [children, path[path.length - 1]]
}

// a node's entries taken out, every part's, then what was kept of it let go as asked: its run (a
// computer's), its calls (a handler's), what a feature held back at it
export function nodeGone(
	inner: Inner,
	id: Id,
	drop: { runs?: true; calls?: true; held?: true } = {},
) {
	const { base, calls, runs, table } = here(inner)
	for (const [part] of table.get(id)) inner.put({ part, id, patches: [], gone: true })
	if (drop.runs) runs.drop(id)
	if (drop.calls) calls.drop(id)
	if (drop.held) base.held.drop(id)
}

// a process running at path, by its node's id: its row names it there, no children entry
export const runningAt = (base: Base, path: Path, id: Id | undefined) => {
	const at = id === undefined ? undefined : base.processes.get(id)?.context.at
	return at !== undefined && at.length === path.length && at.every((n, i) => path[i] === n)
}

// a saved child of a folder that something else shadows at its path (a box's binding): not the
// process's to move or take out, and left as it is. nothing-there, the code for a name the folder's
// own slot does not give this path
export function notShadowed(inner: Inner, path: Path, children: Entry<unknown>, name: string) {
	const saved = namesIn(children)?.[name]
	if (saved !== undefined && saved !== get(here(inner).places, path)) {
		throw new PlacesError("nothing-there", path.join("/"))
	}
}

// id and every node under it (by the children parts), each once
export function under(inner: Inner, id: Id): Id[] {
	const seen = new Set<Id>()
	const go = (at: Id) => {
		if (seen.has(at)) return
		seen.add(at)
		for (const k of Object.values(namesIn(childrenOf(inner, at)) ?? {})) {
			if (typeof k === "string") go(k)
		}
	}
	go(id)
	return [...seen]
}
