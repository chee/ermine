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
// alone, its path not known: nothing. names: every name directly under here's path, a leaf or a
// level (processes deeper, no id: places' walk goes through it, list and members show it)
export const processes = (root: Id): Contributor => trie(PROCESS, root, "process")

// the walk of a trie of ids by path on root's part: processes' rows, and any other rows kept the
// same way (ermine/boxes' boxed items). from: what its answers say
export function trie(part: Key, root: Id, from: string): Contributor {
	return {
		from,
		step: ({ path }, name, r) =>
			path === undefined ? undefined : asId(r.read(part, root, [...path, name])),
		names: ({ path }, r) => path === undefined ? [] : r.keys(part, root, path),
		// a level of the trie (leaves deeper, no id of its own): a walk goes on through it
		level: ({ path }, name, r) =>
			path !== undefined && isMap(r.read(part, root, [...path, name])),
	}
}

// id running at path under root: its leaf put in, the levels on the way made. refused: no name, or
// a name that is not one (not-a-name); a process at the path, above it or under it (already-there:
// a leaf holds no levels, a level is no leaf). a saved thing at the path is fine: the row shadows it.
// the first row under root makes the part's entry (a table event tells readers): nothing given
// back. the entry is changed in place, as places' children are (a copy a start made 300 starts take
// 0.4 s): a reader holding the trie whole sees it change under it, and is told by its spots
export const addProcess = (
	table: Pick<Table, "get" | "add">,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
): Entry<unknown>[] => addLeaf(table, PROCESS, root, path, id, header)

// addProcess on any part: id at path in root's trie there, by the same rules
export function addLeaf(
	table: Pick<Table, "get" | "add">,
	part: Key,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
): Entry<unknown>[] {
	if (path.length === 0) throw new PlacesError("not-a-name")
	for (const name of path) if (bad(name)) throw new PlacesError("not-a-name", name)
	const there = table.get(part, root)
	if (there === undefined) {
		const trie = path.reduceRight<unknown>((v, k) => ({ [k]: v }), id)
		table.add(part, root, createEntry(trie, header, { cow: false }) as never)
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
	return upsert(table, part, root, path, id, header)
}

// the process at path under root taken out, and with it every level left empty: one patch, at the
// highest of them. none there: nothing-there
export const removeProcess = (
	table: Pick<Table, "get">,
	root: Id,
	path: Path,
	header: ChangeHeader,
): Entry<unknown>[] => removeLeaf(table, PROCESS, root, path, header)

// removeProcess on any part: the leaf at path in root's trie there, by the same rules
export function removeLeaf(
	table: Pick<Table, "get">,
	part: Key,
	root: Id,
	path: Path,
	header: ChangeHeader,
): Entry<unknown>[] {
	const entry = table.get(part, root) as Entry<unknown> | undefined
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
