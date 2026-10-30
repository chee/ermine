// The filesystem's reads as plain functions that take a places. A level (no id, names under it)
// has a name but no id: list and members read under it as under a folder, and get finds no id.
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

function reach(places: Pick<Places, "walk">, path: Path, from?: Here): Here | undefined {
	const steps = places.walk(path, from)
	let r = steps.next()
	while (!r.done) r = steps.next()
	return r.value
}

export function get(places: Pick<Places, "root" | "walk">, path: Path): Id | undefined {
	const at = reach(places, path)?.id
	return at === level ? undefined : at
}

// The root answers with itself, from "root".
export function gets(places: Pick<Places, "root" | "walk" | "answers">, path: Path): Answer[] {
	if (path.length === 0) return [{ id: places.root, from: "root" }]
	const here = reach(places, path.slice(0, -1))
	return here === undefined
		? []
		: places.answers(here, path[path.length - 1]).filter((a) => a.id !== level)
}

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

// One read of the whole children map, so any change to it reruns the reader.
export function members(places: Reads, path: Path): Member[] {
	const here = reach(places, path)
	if (here === undefined) return []
	if (places.contributors !== undefined && places.names !== undefined) {
		const named = places.names(here)
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

// Reads only which names there are. With contributors, each name once, in canonical CBOR key
// order. The read is made at the first next().
export function* list(places: Reads, path: Path): Generator<string> {
	const here = reach(places, path)
	if (here === undefined) return
	if (places.contributors !== undefined && places.names !== undefined) {
		for (const n of places.names(here)) yield n.name
		return
	}
	yield* places.readKeys("children", here.id)
}
