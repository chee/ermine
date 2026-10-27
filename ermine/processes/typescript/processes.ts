// processes at paths: the rows of a root's running processes, a trie on the root's process part,
// and the contributor that walks it. a process is not in /work, it is at /work/clock: one place,
// one path
//
//   (process, R).value = { work: { clock: "proc:7f3a" }, dev: { clock: "proc:44d0" } }
//
// a level a map, a leaf a process's id. a process at a path that has processes under it too is a
// level with its id under the key "" (no name is ""): { work: { "": "proc:1", clock: "proc:2" } }
// is a process at /work and one at /work/clock. a process's own things are inside its node, its
// children
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
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import {
	asId,
	type Contributor,
	type Id,
	none,
	type Path,
	PlacesError,
	unread,
	type Writer,
} from "@ermine/core/places"
import { upsert } from "@ermine/core/places/upsert"
import type { Key, Table } from "@ermine/core/table"

// the process part. not declared on the table's Tables: a prototype in playground/union-check
// declares "process" another way
export const PROCESS = "process" as string as Key

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// the key a level holds the id of a process at the level's own path under
const SELF = ""

// a map with a name in it: a level of a trie (one emptied is taken out, but the top)
function filled(v: unknown): boolean {
	if (!isMap(v)) return false
	for (const _ in v) return true
	return false
}

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

// the processes running under root, by path: the leaf at here's path + the name. a walk from an id
// alone, its path not known: nothing. names: every name directly under here's path, a leaf or a
// level (processes deeper, no id: places' walk goes through it, list and members show it)
//
// a process at here's path + the name, with processes under it too: its id (the walk goes on
// through it by the path). pruning (places.ts): no level at here's path + the name (no leaf, nothing, or under a leaf):
// none, so the walk asks it nothing more under there. the read that said so is of all under that
// path, so a start anywhere under it marks the walk, and one elsewhere does not. no names under
// here's path: none too. a walk from an id alone: none at once (it never has a path)
export const processes = (root: Id): Contributor => trie(PROCESS, root, "process")

// the walk of a trie of ids by path on root's part: processes' rows, and any other rows kept the
// same way. from: what its answers say
export function trie(part: Key, root: Id, from: string): Contributor {
	return {
		from,
		step: ({ path }, name, r) => {
			if (path === undefined) return none
			const v = r.read(part, root, [...path, name])
			if (isMap(v) && Object.hasOwn(v, SELF)) return asId(v[SELF]) ?? none
			return asId(v) ?? (filled(v) ? undefined : none)
		},
		names: ({ path }, r) => {
			if (path === undefined) return none
			const names = r.keys(part, root, path).filter((n) => n !== SELF)
			return names.length ? names : none
		},
		// a level of the trie (leaves deeper, no id of its own): a walk goes on through it
		level: ({ path }, name, r) =>
			path !== undefined && isMap(r.read(part, root, [...path, name])),
	}
}

// id running at path under root: its leaf put in, the levels on the way made. refused: no name, or
// a name that is not one (not-a-name); a process at exactly the path (already-there). processes
// above or under it are fine (a leaf above becomes a level holding its id under ""). a saved thing
// at the path is fine: the row shadows it.
// the first row under root makes the part's entry (a table event tells readers): nothing given
// back. the entry is written through places' unread, as children are (a copy a start made 300
// starts take 0.4 s)
// write: none, written here; given (places' Writer), handed the patches to do and say, and nothing
// given back
export const addProcess = (
	table: Pick<Table, "get" | "add">,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
	write?: Writer,
): Entry<unknown>[] => put(table, PROCESS, root, path, id, header, write, true)

// addProcess on any part: id at path in root's trie there, by the rules of a trie of one thing
// at a path: refused too (already-there) where a leaf is above the path or a level under it. a
// leaf and leaves under it together are a process's, so addProcess's alone
export const addLeaf = (
	table: Pick<Table, "get" | "add">,
	part: Key,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
	write?: Writer,
): Entry<unknown>[] => put(table, part, root, path, id, header, write, false)

function put(
	table: Pick<Table, "get" | "add">,
	part: Key,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
	write: Writer | undefined,
	nested: boolean,
): Entry<unknown>[] {
	if (path.length === 0) throw new PlacesError("not-a-name")
	for (const name of path) if (bad(name)) throw new PlacesError("not-a-name", name)
	const there = table.get(part, root)
	if (there === undefined) {
		const trie = path.reduceRight<unknown>((v, k) => ({ [k]: v }), id)
		if (write !== undefined) write(part, root, [{ path: [], value: trie }], header)
		else table.add(part, root, createEntry(trie, header) as never)
		return []
	}
	let v: unknown = there.value
	let value: unknown = id
	let at: Path = path
	for (let i = 0; i < path.length; i++) {
		if (asId(v) !== undefined) {
			if (!nested) throw new PlacesError("already-there", path[i - 1])
			// a leaf above becomes a level: its id under "", the rest of the path beside it
			value = {
				[SELF]: v,
				[path[i]]: path.slice(i + 1).reduceRight<unknown>((x, k) => ({ [k]: x }), id),
			}
			at = path.slice(0, i)
			break
		}
		v = isMap(v) && Object.hasOwn(v, path[i]) ? v[path[i]] : undefined
	}
	if (at === path) {
		if (asId(v) !== undefined || (isMap(v) && Object.hasOwn(v, SELF))) {
			throw new PlacesError("already-there", path[path.length - 1])
		}
		// a level of processes under the path: the process goes in beside them
		if (isMap(v) && Object.keys(v).length) {
			if (!nested) throw new PlacesError("already-there", path[path.length - 1])
			at = [...path, SELF]
		}
	}
	if (write === undefined) return upsert(table, part, root, at, value, header, unread.update)
	upsert(
		table,
		part,
		root,
		at,
		value,
		header,
		(_e, patches, h) => void write(part, root, [...patches], h),
	)
	return []
}

// the process at path under root taken out, and with it every level left empty: one patch, at the
// highest of them (processes under it stay). none there: nothing-there
export const removeProcess = (
	table: Pick<Table, "get">,
	root: Id,
	path: Path,
	header: ChangeHeader,
	write?: Writer,
): Entry<unknown>[] => removeLeaf(table, PROCESS, root, path, header, write)

// removeProcess on any part: the leaf at path in root's trie there, by the same rules
export function removeLeaf(
	table: Pick<Table, "get">,
	part: Key,
	root: Id,
	path: Path,
	header: ChangeHeader,
	write?: Writer,
): Entry<unknown>[] {
	const entry = table.get(part, root) as Entry<unknown> | undefined
	const levels: Record<string, unknown>[] = []
	let v: unknown = entry?.value
	for (const name of path) {
		if (!isMap(v) || !Object.hasOwn(v, name)) throw new PlacesError("nothing-there", name)
		levels.push(v)
		v = v[name]
	}
	// a process with processes under it: its id is under "" in its level
	if (isMap(v) && Object.hasOwn(v, SELF)) {
		levels.push(v)
		path = [...path, SELF]
		v = v[SELF]
	}
	if (entry === undefined || path.length === 0 || asId(v) === undefined) {
		throw new PlacesError("nothing-there", path[path.length - 1])
	}
	let d = path.length - 1
	while (d > 0 && Object.keys(levels[d]).length === 1) d--
	if (write !== undefined) {
		write(part, root, [{ path: path.slice(0, d + 1) }], header)
		return []
	}
	unread.update(entry, [{ path: path.slice(0, d + 1) }], header)
	return [entry]
}

// the process context: where and as whom a thing is done (context.ts)
export type { At, ProcessContext } from "./context.ts"
