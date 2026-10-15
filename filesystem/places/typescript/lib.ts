// the filesystem's reads, built on a places' walk and keys: plain functions that take a places,
// each read told as walk and keys tell theirs. a places given contributors: get and lookup go where
// the first answer goes, gets gives every answer, list and members every contributor's names,
// each name once (places.ts). given none: children alone, read as they always were
//
// a level (a contributor's, places.ts: no id, names under it) is a name with no id: in its parent,
// list gives its name and members gives it with the id level; at it, list, members and gets read
// under it as under a folder, get finds no id, and lookup finds its path
import { type Answer, type Id, level, type Member, type Path, type Places } from "./places.ts"

type Reads =
	& Pick<Places, "root" | "walk" | "readKeys" | "readValue">
	& Partial<Pick<Places, "contributors" | "names">>

// where a path's walk ends: an id, or level; the walk stopped short: undefined
function reach(places: Pick<Places, "root" | "walk">, path: Path): Id | undefined {
	let at: Id = places.root, n = 0
	for (const step of places.walk(path)) at = step.id, n++
	return n === path.length ? at : undefined
}

// the id at a path from the root; nothing there, or a level: undefined
export function get(places: Pick<Places, "root" | "walk">, path: Path): Id | undefined {
	const at = reach(places, path)
	return at === level ? undefined : at
}

// every answer at a path, the first the one get gives, each with the contributor that gave it: the
// walk to the folder it is in (a level too), then every contributor asked its name. the root:
// itself, from "root". nothing there, or a level: none
export function gets(places: Pick<Places, "root" | "walk" | "answers">, path: Path): Answer[] {
	if (path.length === 0) return [{ id: places.root, from: "root" }]
	const up = path.slice(0, -1)
	const id = reach(places, up)
	return id === undefined
		? []
		: places.answers({ id, path: up }, path[path.length - 1]).filter((a) => a.id !== level)
}

// the names from where you are (a path from the root), then from each place above it, nearest
// first: the path where the nearest is found; none: undefined. all: the path of each, nearest
// first. the walk to where you are is made once, and each place's own walk goes on from there
export function lookup(places: Reads, names: Path, from: Path, all?: false): string[] | undefined
export function lookup(places: Reads, names: Path, from: Path, all: true): string[][]
export function lookup(
	places: Reads,
	names: Path,
	from: Path,
	all = false,
): string[] | undefined | string[][] {
	const out: string[][] = []
	const ids: Id[] = [places.root]
	for (const step of places.walk(from)) ids.push(step.id)
	for (let k = ids.length - 1; k >= 0; k--) {
		let n = 0
		for (const _ of places.walk(names, { id: ids[k], path: from.slice(0, k) })) n++
		if (n < names.length) continue
		const found = [...from.slice(0, k), ...names]
		if (!all) return found
		out.push(found)
	}
	return all ? out : undefined
}

// the names at a path holding an id, and their ids, in their order there. children alone: one read
// of the children map whole, so any change to it reruns the reader. contributors given: every
// contributor's names (list's reads), then each name's step, as get takes it, with its from (a
// level: the id level, no id of its own). nothing there: none
export function members(places: Reads, path: Path): Member[] {
	const id = reach(places, path)
	if (id === undefined) return []
	if (places.contributors !== undefined && places.names !== undefined) {
		const here = { id, path }
		const out: Member[] = []
		for (const { name } of places.names(here)) {
			for (const m of places.walk([name], here)) out.push(m)
		}
		return out
	}
	const map = places.readValue("children", id)
	if (map === null || typeof map !== "object" || Array.isArray(map)) return []
	const out: Member[] = []
	for (const [name, to] of Object.entries(map)) {
		if (typeof to === "string" || typeof to === "symbol") out.push({ name, id: to })
	}
	return out
}

// the names at a path, one at a time (an iterator: C returns an array, it has no generators), in
// their order there: a read of which names there are, so a name added or taken out reruns the
// reader. contributors given: every contributor's, each name once, in canonical CBOR's key order.
// nothing there: none. the read is made at the first next()
export function* list(places: Reads, path: Path): Generator<string> {
	const id = reach(places, path)
	if (id === undefined) return
	if (places.contributors !== undefined && places.names !== undefined) {
		for (const n of places.names({ id, path })) yield n.name
		return
	}
	yield* places.readKeys("children", id)
}
