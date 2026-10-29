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
import createEntry, { type ChangeHeader, type Entry } from "@ermine/graph/entry"
import {
	asId,
	type Contributor,
	crow,
	type Id,
	map,
	none,
	type Path,
	PlacesError,
	type Writer,
} from "@ermine/places"
import { updateEntry } from "@ermine/places/crowify"
import type { Key, Table } from "@ermine/graph/table"
import { isPojo } from "@ermine/changeable/kinds"

// the process part. not declared on the table's Tables
export const PROCESS = "process" as string as Key

// the key a level holds the id of a process at the level's own path under
const SELF = ""

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

// the id of the process at path in a rows value (what the process part holds at a root): a leaf's,
// or a level's own under "". none: no process at exactly that path. for whoever reads the part raw
export function idAt(rows: unknown, path: Path): Id | undefined {
	let v: unknown = rows
	for (const name of path) {
		if (name === SELF || !isPojo(v) || !Object.hasOwn(v, name)) return undefined
		v = v[name]
	}
	return asId(isPojo(v) ? v[SELF] : v)
}

// each name directly under path that a process is at, with its id (a leaf's, or a level's own); a
// level with no process of its own is left out. for whoever reads the part raw
export function idsUnder(rows: unknown, path: Path): [string, Id][] {
	let v: unknown = rows
	for (const name of path) {
		if (name === SELF || !isPojo(v) || !Object.hasOwn(v, name)) return []
		v = v[name]
	}
	const out: [string, Id][] = []
	if (!isPojo(v)) return out
	for (const [name, x] of Object.entries(v)) {
		if (name === SELF) continue
		const id = asId(isPojo(x) ? x[SELF] : x)
		if (id !== undefined) out.push([name, id])
	}
	return out
}

// the processes running under root, by path: the leaf at here's path + the name. a walk from an id
// alone, its path not known: nothing. names: every name directly under here's path, a leaf or a
// level (processes deeper, no id: places' walk goes through it, list and members show it)
//
// a process at here's path + the name, with processes under it too: its id (the walk goes on
// through it by the path). pruning (places.ts): no level at here's path + the name (no leaf, nothing, or under a leaf):
// none, so the walk asks it nothing more under there. the read that said so is of what is at that
// path itself (places' here): a start making something there marks the walk, a start or a stop
// deeper under a level, or elsewhere, does not. no names under
// here's path: none too. a walk from an id alone: none at once (it never has a path)
export const processes = (root: Id): Contributor => trie(PROCESS, root, "process")

// the walk of a trie of ids by path on root's part: processes' rows, and any other rows kept the
// same way. from: what its answers say
export function trie(part: Key, root: Id, from: string): Contributor {
	return {
		from,
		// each step reads only what it needs: what is at path + name itself, and a level's own id, so
		// a start or a stop elsewhere under a level tells a walk through it nothing (the hedgehog's
		// wall 2, 10-28: a sibling started reran every reader of a cell)
		step: ({ path }, name, r) => {
			// "" is the key a level holds its own process under, never a name
			if (path === undefined || name === SELF) return none
			const at = [...path, name]
			const v = r.here(part, root, at)
			if (v === map) return asId(r.read(part, root, [...at, SELF])) ?? undefined
			return asId(v) ?? none
		},
		names: ({ path }, r) => {
			if (path === undefined) return none
			const names = r.keys(part, root, path).filter((n) => n !== SELF)
			return names.length ? names : none
		},
		// a level of the trie (leaves deeper, no id of its own): a walk goes on through it
		level: ({ path }, name, r) =>
			path !== undefined && name !== SELF && r.here(part, root, [...path, name]) === map,
	}
}

// id running at path under root: its leaf put in, the levels on the way made. refused: no name, or
// a name that is not one (not-a-name); a process at exactly the path (already-there). processes
// above or under it are fine (a leaf above becomes a level holding its id under ""). a saved thing
// at the path is fine: the row shadows it.
// the first row under root makes the part's entry (a table event tells readers): nothing given
// back. the entry is written through places' crow, as children are (a copy a start made 300
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

// the value nested under names: { a: { b: value } }
const nest = (names: Path, value: unknown): unknown =>
	names.reduceRight<unknown>((v, k) => ({ [k]: v }), value)

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
	const there = table.get(part, root) as Entry<unknown> | undefined
	if (there === undefined) {
		const trie = nest(path, id)
		if (write !== undefined) write(part, root, [{ path: [], value: trie }], header)
		else table.add(part, root, createEntry(trie, header) as never)
		return []
	}
	// the one patch: value at `at`. the id at the path, unless the path is not all there: then the
	// rest of it, nested, at the first level that is no map (put over) or has no such name
	let v: unknown = there.value
	let value: unknown = id
	let at: Path = path
	for (let i = 0; i < path.length; i++) {
		if (asId(v) !== undefined) {
			if (!nested) throw new PlacesError("already-there", path[i - 1])
			// a leaf above becomes a level: its id under "", the rest of the path beside it
			value = { [SELF]: v, [path[i]]: nest(path.slice(i + 1), id) }
			at = path.slice(0, i)
			break
		}
		if (!isPojo(v)) {
			value = nest(path.slice(i), id)
			at = path.slice(0, i)
			break
		}
		if (!Object.hasOwn(v, path[i])) {
			value = nest(path.slice(i + 1), id)
			at = path.slice(0, i + 1)
			break
		}
		v = v[path[i]]
	}
	if (at === path) {
		if (asId(v) !== undefined || (isPojo(v) && Object.hasOwn(v, SELF))) {
			throw new PlacesError("already-there", path[path.length - 1])
		}
		// a level of processes under the path: the process goes in beside them
		if (isPojo(v) && Object.keys(v).length) {
			if (!nested) throw new PlacesError("already-there", path[path.length - 1])
			at = [...path, SELF]
		}
	}
	const patch = { path: [...at], value }
	if (write !== undefined) {
		write(part, root, [patch], header)
		return []
	}
	updateEntry(crow, there, [patch], header)
	return [there]
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
		if (!isPojo(v) || !Object.hasOwn(v, name)) throw new PlacesError("nothing-there", name)
		levels.push(v)
		v = v[name]
	}
	// a process with processes under it: its id is under "" in its level
	if (isPojo(v) && Object.hasOwn(v, SELF)) {
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
	updateEntry(crow, entry, [{ path: path.slice(0, d + 1) }], header)
	return [entry]
}

// the process context: where and as whom a thing is done (context.ts)
export type { At, ProcessContext } from "./context.ts"
