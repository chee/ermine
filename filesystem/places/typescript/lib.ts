// the filesystem's reads, built on a places' walk and keys: plain functions that take a places,
// each read told as walk and keys tell theirs. a places given contributors: get and lookup go where
// the first answer goes, gets gives every answer, list and members every contributor's names,
// each name once (places.ts). given none: children alone, read as they always were
//
// a level (a contributor's, places.ts: no id, names under it) is a name with no id: in its parent,
// list gives its name and members gives it with the id level; at it, list, members and gets read
// under it as under a folder, get finds no id, and lookup finds its path
//
// pruning (places.ts): each read goes on from the here its walk got to, so a contributor that said
// none on the way is not asked under it: not its names (list, members), nor its step (gets, members,
// lookup's walks from each place on the way)
import {
	type Answer,
	type Here,
	type Id,
	level,
	type Member,
	type Path,
	type Places,
} from "./places.ts"

type Reads =
	& Pick<Places, "root" | "walk" | "readKeys" | "readValue">
	& Partial<Pick<Places, "contributors" | "names">>

// where a path's walk ends: the here it got to (an id, or level; the contributors gone under it),
// from the root or from a here; the walk stopped short: undefined
function reach(places: Pick<Places, "walk">, path: Path, from?: Here): Here | undefined {
	const steps = places.walk(path, from)
	let r = steps.next()
	while (!r.done) r = steps.next()
	return r.value
}

// the id at a path from the root; nothing there, or a level: undefined
export function get(places: Pick<Places, "root" | "walk">, path: Path): Id | undefined {
	const at = reach(places, path)?.id
	return at === level ? undefined : at
}

// every answer at a path, the first the one get gives, each with the contributor that gave it: the
// walk to the folder it is in (a level too), then every contributor asked its name. the root:
// itself, from "root". nothing there, or a level: none
export function gets(places: Pick<Places, "root" | "walk" | "answers">, path: Path): Answer[] {
	if (path.length === 0) return [{ id: places.root, from: "root" }]
	const here = reach(places, path.slice(0, -1))
	return here === undefined
		? []
		: places.answers(here, path[path.length - 1]).filter((a) => a.id !== level)
}

// the names from where you are (a path from the root), then from each place above it, nearest
// first: the path where the nearest is found; none: undefined. all: the path of each, nearest
// first. the walk to where you are is made once, a step at a time, and each place's own walk goes
// on from there
export function lookup(places: Reads, names: Path, from: Path, all?: false): string[] | undefined
export function lookup(places: Reads, names: Path, from: Path, all: true): string[][]
export function lookup(
	places: Reads,
	names: Path,
	from: Path,
	all = false,
): string[] | undefined | string[][] {
	const out: string[][] = []
	const heres: Here[] = [{ id: places.root, path: [] }]
	for (const name of from) {
		const next = reach(places, [name], heres[heres.length - 1])
		if (next === undefined) break
		heres.push(next)
	}
	for (let k = heres.length - 1; k >= 0; k--) {
		if (reach(places, names, heres[k]) === undefined) continue
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
	const here = reach(places, path)
	if (here === undefined) return []
	if (places.contributors !== undefined && places.names !== undefined) {
		const named = places.names(here)
		// those whose names said none: gone for each name's walk too
		const under = named.gone === (here.gone ?? 0) ? here : { ...here, gone: named.gone }
		const out: Member[] = []
		for (const { name } of named) {
			for (const m of places.walk([name], under)) out.push(m)
		}
		return out
	}
	const map = places.readValue("children", here.id)
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
	const here = reach(places, path)
	if (here === undefined) return
	if (places.contributors !== undefined && places.names !== undefined) {
		for (const n of places.names(here)) yield n.name
		return
	}
	yield* places.readKeys("children", here.id)
}
