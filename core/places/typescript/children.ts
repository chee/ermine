// children: the children format, a contributor and the plain functions that edit a children entry.
import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import { createCrow, type Crow } from "@ermine/crow"
import type { Patch } from "@ermine/changeable/apply"
import { isPojo } from "@ermine/changeable/kinds"
import type { Id, Key } from "@ermine/graph/table"
import { updateEntry } from "./crowify.ts"
import { asId, type Contributor, level, PlacesError } from "./places.ts"

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
