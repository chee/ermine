// processes at paths: the rows of a root's running processes, a trie on the root's process part,
// and the contributor that walks it. chee: "a process isn't in /work, it's at /work/clock"; "a
// process exists in one place and has 1 path"
//
//   (process, R).value = { work: { clock: "proc:7f3a" }, dev: { clock: "proc:44d0" } }
//
// a level a map, a leaf a process's id. a process's own things (its subprocesses too) are inside
// its node, its children, so nothing sits under a leaf
//
// the walk: processes(root) is a contributor (places.ts), going by the path, never the id. given
// before children, a process shadows what is saved at its path while it runs ("the ephemeral
// wins"), and what is saved is there again at its stop. a walk reads only its own root's rows
// (whether it counts roots it passes through is put off)
//
//   import { addProcess, processes, removeProcess } from "@ermine/processes"
//   const places = createPlaces({ root, table, paths, scheduler, contributors: [processes(root), children] })
//   places.commit(addProcess(table, root, ["work", "clock"], "proc:7f3a", createChangeHeader(scheduler)))
//
// the rows are never saved: they are the processes running now, on this device. whoever saves a
// root's parts leaves the process part out (pack is not told: it saves what it is given)
//
// writes: plain functions on the table, as places' place is, each giving back the entries it
// changed for places' commit: a patch at the path, so a start or a stop marks its own path and the
// names above it, nothing beside. refused: a PlacesError, nothing changed
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { asId, type Contributor, type Id, type Path, PlacesError } from "@ermine/places"
import { upsert } from "@ermine/places/upsert"
import type { Key, Table } from "@ermine/table"

// the process part. not declared on the table's Tables: a prototype in playground/union-check
// declares "process" another way
export const PROCESS = "process" as string as Key

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

// the processes running under root, by path: the leaf at here's path + the name. a walk from an id
// alone, its path not known: nothing. names: the leaves directly under here's path (a level, with
// processes deeper, is no name of its own: what is there is whatever else is)
export function processes(root: Id): Contributor {
	return {
		from: "process",
		step: ({ path }, name, r) =>
			path === undefined ? undefined : asId(r.read(PROCESS, root, [...path, name])),
		names: ({ path }, r) => path === undefined ? [] : r.keys(PROCESS, root, path, true),
	}
}

// id running at path under root: its leaf put in, the levels on the way made. refused: no name, or
// a name that is not one (not-a-name); a process at the path, above it or under it (already-there:
// a leaf holds no levels, a level is no leaf). a saved thing at the path is fine: the row shadows it.
// the first row under root makes the part's entry (a table event tells readers): nothing given
// back. the entry is changed in place, as places' children are (a copy a start made 300 starts take
// 0.4 s): a reader holding the trie whole sees it change under it, and is told by its spots
export function addProcess(
	table: Pick<Table, "get" | "add">,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
): Entry<unknown>[] {
	if (path.length === 0) throw new PlacesError("not-a-name")
	for (const name of path) if (bad(name)) throw new PlacesError("not-a-name", name)
	const there = table.get(PROCESS, root)
	if (there === undefined) {
		const trie = path.reduceRight<unknown>((v, k) => ({ [k]: v }), id)
		table.add(PROCESS, root, createEntry(trie, header, { cow: false }) as never)
		return []
	}
	let v: unknown = there.value
	for (let i = 0; i < path.length && isMap(v); i++) {
		v = Object.hasOwn(v, path[i]) ? v[path[i]] : undefined
		if (asId(v) !== undefined) throw new PlacesError("already-there", path[i])
	}
	if (isMap(v) && Object.keys(v).length) {
		throw new PlacesError("already-there", path[path.length - 1])
	}
	return upsert(table, PROCESS, root, path, id, header)
}

// the process at path under root taken out, and with it every level left empty: one patch, at the
// highest of them. none there: nothing-there
export function removeProcess(
	table: Pick<Table, "get">,
	root: Id,
	path: Path,
	header: ChangeHeader,
): Entry<unknown>[] {
	const entry = table.get(PROCESS, root) as Entry<unknown> | undefined
	const levels: Record<string, unknown>[] = []
	let v: unknown = entry?.value
	for (const name of path) {
		if (!isMap(v) || !Object.hasOwn(v, name)) throw new PlacesError("nothing-there", name)
		levels.push(v)
		v = v[name]
	}
	if (entry === undefined || path.length === 0 || asId(v) === undefined) {
		throw new PlacesError("nothing-there", path[path.length - 1])
	}
	let d = path.length - 1
	while (d > 0 && Object.keys(levels[d]).length === 1) d--
	update(entry, [{ path: path.slice(0, d + 1) }], header)
	return [entry]
}
