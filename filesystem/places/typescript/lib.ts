// the filesystem's reads, built on a places' walk and keys: plain functions that take a places,
// each read told as walk and keys tell theirs. a places given contributors: get and lookup go where
// the first answer goes, entries gives every answer, list and members every contributor's names,
// each name once (places.ts). given none: children alone, read as they always were
import type { Answer, Id, Member, Path, Places } from "./places.ts"

type Reads =
	& Pick<Places, "root" | "walk" | "readKeys" | "readValue">
	& Partial<Pick<Places, "contributors" | "names">>

// the id at a path from the root; nothing there: undefined
export function get(places: Pick<Places, "root" | "walk">, path: Path): Id | undefined {
	let at: Id = places.root, n = 0
	for (const step of places.walk(path)) at = step.id, n++
	return n === path.length ? at : undefined
}

// every answer at a path, the first the one get gives, each with the contributor that gave it: the
// walk to the folder it is in, then every contributor asked its name. the root: itself, from
// "root". nothing there: none
export function entries(places: Pick<Places, "root" | "walk" | "answers">, path: Path): Answer[] {
	if (path.length === 0) return [{ id: places.root, from: "root" }]
	const up = path.slice(0, -1)
	const id = get(places, up)
	return id === undefined ? [] : places.answers({ id, path: up }, path[path.length - 1])
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
// contributor's names (list's reads), then each name's step, as get takes it, with its from.
// nothing there: none
export function members(places: Reads, path: Path): Member[] {
	const id = get(places, path)
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

// the names at a path, in their order there: a read of which names there are, so a name added or
// taken out reruns the reader. contributors given: every contributor's, each name once. nothing
// there: none
export function list(places: Reads, path: Path): string[] {
	const id = get(places, path)
	if (id === undefined) return []
	if (places.contributors !== undefined && places.names !== undefined) {
		return places.names({ id, path }).map((n) => n.name)
	}
	return places.readKeys("children", id)
}
