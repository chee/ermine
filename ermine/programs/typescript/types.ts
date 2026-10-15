// types: UTIs as nodes in the graph. chee 10-15: "this is what i was trying to get at with UTI
// because then there'd be a type, and the loader could say it knows how to take that type and
// output the correct thing"; "the nice thing with UTI is conformance"; types are nodes: "for now we
// can have the host install a /types or something in the root". the folder's name is not decided
// ("/ermine.types or /ermine/types maybe"): TYPES says it, once
//
//   installTypes(table, "R", header)        // R/ermine/types/public.text, ... (entries to commit)
//   const types = typesAt(places, ["clocks"])                 // the nearest ermine/types
//   conformance(places, types, "public.c-source")
//   // { known: true, all: ["public.c-source", "public.source-code", "public.plain-text", ...] }
//
// a type: a node named by its UTI in the types folder, its value { conformsTo, fileNameExtension,
// mimeType }, each a list. conformance: a type, then what its conformsTo names, and theirs, each
// once (a UTI conforms to itself). the folder: TYPES looked up from where the search is, nearest
// first (lib's lookup), so a box carries its own (one boxed at ermine/types, or a folder of its own
// there). the nearest folder only: a type not in it is unknown, never looked for farther up (mine,
// open). every read through places, so tracked: a type installed, or its conformsTo written, reruns
// a reader; its mimeType written does not
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { asId, type Id, level, type Path, type Places } from "@ermine/places"
import { get, lookup } from "@ermine/places/lib"
import type { Patch } from "@ermine/op/apply"
import type { Table } from "@ermine/table"
import { KNOWN } from "./utis.ts"

// the types folder, from a root: the one place its path is said
export const TYPES: Path = ["ermine", "types"]

// a type as the well-known list gives it (arlac77/uti): each field a string or a list
export type Known = {
	readonly name: string
	readonly conformsTo?: string | readonly string[]
	readonly fileNameExtension?: string | readonly string[]
	readonly mimeType?: string | readonly string[]
}

// what a type's node holds
export type TypeValue = {
	conformsTo: string[]
	fileNameExtension: string[]
	mimeType: string[]
}

// the types the well-known list lacks, that the scenarios need. public.c-source as Apple's
// (conforms to public.source-code, extension .c); an arm64 executable is mine (open)
export const EXTRA: readonly Known[] = [
	{ name: "public.c-source", conformsTo: "public.source-code", fileNameExtension: ".c" },
	{ name: "party.chee.ermine.arm64-executable", conformsTo: "public.unix-executable" },
]

// a string or a list as a list of its strings
const strings = (v: unknown): string[] =>
	typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((s) => typeof s === "string") : []

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

export const typeValue = (t: Known): TypeValue => ({
	conformsTo: strings(t.conformsTo),
	fileNameExtension: strings(t.fileNameExtension),
	mimeType: strings(t.mimeType),
})

// the id at name in a children entry, read untracked (a write's own look); none: undefined
function childOf(table: Pick<Table, "get">, folder: Id, name: string): Id | undefined {
	const v = table.get("children", folder)?.value
	return isMap(v) && Object.hasOwn(v, name) ? asId(v[name]) : undefined
}

// the list (none: the well-known one and EXTRA) installed at TYPES under root: the
// folders on the way made where missing, a type's node made where missing, its value written where
// there and different. new nodes' ids: ids(their path from root) (none: random). gives back the
// entries changed, each changed once, for commit (an entry made is a table event: not given back).
// a type twice in the list: the last wins
export function installTypes(
	table: Pick<Table, "get" | "add">,
	root: Id,
	header: ChangeHeader,
	list: readonly Known[] = [...KNOWN, ...EXTRA],
	ids: (path: Path) => Id = () => `type:${crypto.randomUUID()}`,
): Entry<unknown>[] {
	const changed: Entry<unknown>[] = []
	// one patch on an entry there, or the entry made
	const put = (part: "children" | "value", id: Id, patches: Patch[], whole: unknown) => {
		const there = table.get(part, id) as Entry<unknown> | undefined
		if (there === undefined) table.add(part, id, createEntry(whole, header) as never)
		else if (patches.length) {
			update(there, patches, header)
			changed.push(there)
		}
	}
	let folder = root
	for (let i = 0; i < TYPES.length; i++) {
		const name = TYPES[i]
		const there = childOf(table, folder, name)
		if (there !== undefined) {
			folder = there
			continue
		}
		const id = ids(TYPES.slice(0, i + 1))
		const kids = table.get("children", folder)?.value
		put("children", folder, [
			isMap(kids) ? { path: [name], value: id } : { path: [], value: { [name]: id } },
		], { [name]: id })
		folder = id
	}
	const last = new Map<string, Known>()
	for (const t of list) last.set(t.name, t)
	const named: Record<string, Id> = {}
	const patches: Patch[] = []
	const kids = table.get("children", folder)?.value
	for (const t of last.values()) {
		const id = childOf(table, folder, t.name) ?? ids([...TYPES, t.name])
		const v = typeValue(t)
		const same = JSON.stringify(table.get("value", id)?.value) === JSON.stringify(v)
		put("value", id, same ? [] : [{ path: [], value: v }], v)
		if (childOf(table, folder, t.name) === undefined) {
			named[t.name] = id
			if (isMap(kids)) patches.push({ path: [t.name], value: id })
		}
	}
	if (Object.keys(named).length) {
		put("children", folder, isMap(kids) ? patches : [{ path: [], value: named }], named)
	}
	return changed
}

// what types reads through: a places, as lib's lookup takes it
export type Reads =
	& Pick<Places, "root" | "walk" | "readKeys" | "readValue">
	& Partial<Pick<Places, "contributors" | "names">>

// the types folder seen from a place: TYPES looked up from it, nearest first; none: undefined
export type Folder = { readonly id: Id; readonly path: Path }

export function typesAt(places: Reads, from: Path): Folder | undefined {
	const path = lookup(places, TYPES, from)
	const id = path === undefined ? undefined : get(places, path)
	return id === undefined || id === level ? undefined : { id, path: path! }
}

// a type's node in the folder; none: undefined
function nodeOf(places: Reads, folder: Folder, uti: string): Id | undefined {
	for (const m of places.walk([uti], folder)) return m.id === level ? undefined : m.id
}

// what a type conforms to, itself first, then each conformsTo followed, each once, in the order
// met (breadth first). known: whether the type itself has a node in the folder (none: only itself).
// reads: each type's name in the folder, and the conformsTo in its value
export function conformance(
	places: Reads,
	folder: Folder | undefined,
	uti: string,
): { known: boolean; all: string[] } {
	const all = [uti]
	let known = false
	for (let i = 0; i < all.length; i++) {
		const id = folder === undefined ? undefined : nodeOf(places, folder, all[i])
		if (id === undefined) continue
		if (i === 0) known = true
		for (const up of strings(places.readValue("value", id, ["conformsTo"]))) {
			if (!all.includes(up)) all.push(up)
		}
	}
	return { known, all }
}
