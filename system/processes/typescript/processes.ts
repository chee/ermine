// Running processes at paths: the rows of a root's process part, a trie, and the contributor
// that walks it. The rows are never saved: they are the processes running now on this device.
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

export const PROCESS = "process"

const SELF = ""

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

export function idAt(rows: unknown, path: Path): Id | undefined {
	let v: unknown = rows
	for (const name of path) {
		if (name === SELF || !isPojo(v) || !Object.hasOwn(v, name)) return undefined
		v = v[name]
	}
	return asId(isPojo(v) ? v[SELF] : v)
}

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

// Walks the processes running under root by path. A walk from an id alone has no path.
export const processes = (root: Id): Contributor => trie(PROCESS, root, "process")

export function trie(part: Key, root: Id, from: string): Contributor {
	return {
		from,
		step: ({ path }, name, r) => {
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
		level: ({ path }, name, r) =>
			path !== undefined && name !== SELF && r.here(part, root, [...path, name]) === map,
	}
}

// The entry is written through places' crow, as children are, because copying on a start made
// 300 starts take 0.4 s.
export const addProcess = (
	table: Pick<Table, "get" | "add">,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
	write?: Writer,
): Entry<unknown>[] => put(table, PROCESS, root, path, id, header, write, true)

export const addLeaf = (
	table: Pick<Table, "get" | "add">,
	part: Key,
	root: Id,
	path: Path,
	id: Id,
	header: ChangeHeader,
	write?: Writer,
): Entry<unknown>[] => put(table, part, root, path, id, header, write, false)

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
	let v: unknown = there.value
	let value: unknown = id
	let at: Path = path
	for (let i = 0; i < path.length; i++) {
		if (asId(v) !== undefined) {
			if (!nested) throw new PlacesError("already-there", path[i - 1])
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

export const removeProcess = (
	table: Pick<Table, "get">,
	root: Id,
	path: Path,
	header: ChangeHeader,
	write?: Writer,
): Entry<unknown>[] => removeLeaf(table, PROCESS, root, path, header, write)

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

export type { At, ProcessContext } from "./context.ts"
