// children: the children format, a contributor, the plain functions that edit a children entry and
// the index of what names each id.
import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import { createCrow, type Crow } from "@ermine/crow"
import type { Patch } from "@ermine/changeable/apply"
import { isPojo } from "@ermine/changeable/kinds"
import type { Id, Key } from "@ermine/graph/table"
import { updateEntry } from "./crowify.ts"
import { asId, type Contributor, level, type Places, PlacesError } from "./places.ts"

export const children: Contributor = {
	from: "children",
	step: ({ id }, name, r) => id === level ? undefined : asId(r.read("children", id, [name])),
	names: ({ id }, r) => id === level ? [] : r.keys("children", id),
}

function child(children: Entry<unknown> | undefined, name: string): Id | undefined {
	const v = children?.value
	if (!isPojo(v) || !Object.hasOwn(v, name)) return undefined
	return asId(v[name])
}

// Every children entry is written through this crow, so a place into n names costs one step
// (10k names: 12.6 s copying, 8 ms in place). A host should wire crowify(scheduler, crow,
// subtreeOf), or a folder held past a run changes under its holder.
export const crow: Crow = /* @__PURE__ */ createCrow()

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

const taken = (children: Entry<unknown> | undefined, name: string) =>
	isPojo(children?.value) && Object.hasOwn(children!.value as object, name)

const base = (children: Entry<unknown> | undefined): Patch[] =>
	isPojo(children?.value) ? [] : [{ path: [], value: {} }]

function write(children: Entry<unknown>, patches: Patch[], header: ChangeHeader) {
	updateEntry(crow, children, patches, header)
	return [children]
}

export type Writer = (part: Key, id: Id, patches: readonly Patch[], header: ChangeHeader) => void

export function placing(children: Entry<unknown> | undefined, name: string, id: Id): Patch[] {
	if (bad(name)) throw new PlacesError("not-a-name", name)
	if (taken(children, name)) throw new PlacesError("already-there", name)
	return [...base(children), { path: [name], value: id }]
}

export function unplacing(children: Entry<unknown> | undefined, name: string): Patch[] {
	if (child(children, name) === undefined) throw new PlacesError("nothing-there", name)
	return [{ path: [name] }]
}

export function moving(
	[from, name]: readonly [Entry<unknown>, string],
	[into, to]: readonly [Entry<unknown> | undefined, string],
): { entry: "from" | "into"; patches: Patch[] }[] {
	if (bad(to)) throw new PlacesError("not-a-name", to)
	const id = child(from, name)
	if (id === undefined) throw new PlacesError("nothing-there", name)
	if (from === into) {
		if (name === to) return []
		if (taken(from, to)) throw new PlacesError("already-there", to)
		return [{ entry: "from", patches: [{ path: [to], move: { path: [name] } }] }]
	}
	return [
		{ entry: "into", patches: placing(into, to, id) },
		{ entry: "from", patches: unplacing(from, name) },
	]
}

export function place(
	children: Entry<unknown>,
	name: string,
	id: Id,
	header: ChangeHeader,
): Entry<unknown>[] {
	return write(children, placing(children, name, id), header)
}

export function unplace(
	children: Entry<unknown>,
	name: string,
	header: ChangeHeader,
): Entry<unknown>[] {
	return write(children, unplacing(children, name), header)
}

export function rename(
	children: Entry<unknown>,
	name: string,
	to: string,
	header: ChangeHeader,
): Entry<unknown>[] {
	if (bad(to)) throw new PlacesError("not-a-name", to)
	if (child(children, name) === undefined) throw new PlacesError("nothing-there", name)
	if (to === name) return []
	if (taken(children, to)) throw new PlacesError("already-there", to)
	return write(children, [{ path: [to], move: { path: [name] } }], header)
}

export function move(
	[from, name]: readonly [Entry<unknown>, string],
	[into, to]: readonly [Entry<unknown>, string],
	header: ChangeHeader,
): Entry<unknown>[] {
	return moving([from, name], [into, to]).flatMap((m) =>
		write(m.entry === "from" ? from : into, m.patches, header)
	)
}

export type Slot = { readonly folder: Id; readonly name: string }

export type Index = { readonly of: (id: Id) => readonly Slot[] }

function touched(patches: readonly Patch[]): string[] | undefined {
	const out: string[] = []
	for (const p of patches) {
		if (p.path.length === 0 || (p.move !== undefined && p.move.path.length === 0)) {
			return undefined
		}
		if (typeof p.path[0] === "string") out.push(p.path[0])
		if (typeof p.move?.path[0] === "string") out.push(p.move.path[0])
	}
	return out
}

// Every folder and name that names an id, latest placed last. It learns from what places tells,
// after a walk from the root through what the table already holds (a table handed in).
export function createNames(
	places: Pick<Places, "watchAll" | "root" | "peep" | "readValue">,
): Index {
	const indexed = new Map<Id, Map<string, Id>>()
	const named = new Map<Id, Slot[]>()
	function unindex(folder: Id, name: string) {
		const k = indexed.get(folder)
		const id = k?.get(name)
		if (id === undefined) return
		k!.delete(name)
		if (k!.size === 0) indexed.delete(folder)
		const list = named.get(id)!
		list.splice(list.findIndex((n) => n.folder === folder && n.name === name), 1)
		if (list.length === 0) named.delete(id)
	}
	function index(folder: Id, name: string, now: Id | undefined) {
		if (indexed.get(folder)?.get(name) === now) return
		unindex(folder, name)
		if (now === undefined) return
		let k = indexed.get(folder)
		if (k === undefined) indexed.set(folder, k = new Map())
		k.set(name, now)
		let list = named.get(now)
		if (list === undefined) named.set(now, list = [])
		list.push({ folder, name })
	}
	places.watchAll(({ part, id, patches, entry }) => {
		if (part !== "children") return
		let names: Iterable<string> | undefined = touched(patches)
		if (names === undefined) {
			const v = entry?.value
			names = new Set([...indexed.get(id)?.keys() ?? [], ...isPojo(v) ? Object.keys(v) : []])
		}
		for (const name of names) index(id, name, child(entry, name))
	})
	const walked = new Set<Id>(), folders = [places.root]
	for (let folder; (folder = folders.pop()) !== undefined;) {
		if (walked.has(folder)) continue
		walked.add(folder)
		const v = places.peep(() => places.readValue("children", folder!))
		if (!isPojo(v)) continue
		for (const [name, x] of Object.entries(v)) {
			const id = asId(x)
			index(folder, name, id)
			if (id !== undefined) folders.push(id)
		}
	}
	return { of: (id) => named.get(id) ?? [] }
}
