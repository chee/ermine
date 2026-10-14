// the filesystem's reads, built on a places' walk and keys: plain functions that take a places,
// each read told as walk and keys tell theirs
import type { Id, Member, Path, Places } from "./places.ts"

type Reads = Pick<Places, "root" | "walk" | "readKeys">

// the id at a path from the root; nothing there: undefined
export function get(places: Reads, path: Path): Id | undefined {
	let at: Id = places.root, n = 0
	for (const step of places.walk(path)) at = step.id, n++
	return n === path.length ? at : undefined
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
		for (const _ of places.walk(names, ids[k])) n++
		if (n < names.length) continue
		const found = [...from.slice(0, k), ...names]
		if (!all) return found
		out.push(found)
	}
	return all ? out : undefined
}

// the names at a path holding an id, and their ids, in their order there: a read of which names
// there are, then of each. nothing there: none
export function members(places: Reads, path: Path): Member[] {
	const id = get(places, path)
	if (id === undefined) return []
	const out: Member[] = []
	for (const name of places.readKeys("children", id)) {
		for (const step of places.walk([name], id)) out.push(step)
	}
	return out
}

// the names at a path holding an id, in their order there: members' names
export const list = (places: Reads, path: Path): string[] =>
	members(places, path).map((m) => m.name)
