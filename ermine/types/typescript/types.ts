// utis.json, the well-known UTIs, is Markus Felten's (arlac77) list from his uti library (npm
// uti@8.11.3) as JSON, with thanks; its licence (0BSD) is utis.LICENSE. EXTRA adds what it lacks
//
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
// the type of a node: typeOf(places, { id, at }), `at` the path it was reached by
//   typeOf(places, { id: CAT, at: ["clocks", "catclock.c"] })           // "public.c-source"
// its ermine.type attribute if it has one (a string); else the type whose fileNameExtension the
// name it is placed under ends with, from the nearest ermine/types (the folder of the placement,
// looked up as typesAt does); no extension, or no match: undefined. THE NAME BELONGS TO THE
// PLACEMENT, NOT THE NODE: one node at notes/a.c and notes/a.txt has two types by name; an explicit
// ermine.type is the same everywhere
//   extensions compare case-insensitively, ASCII ("A.C" is a.c's type); an extension is the name's end
//   from a ".", with a name before it (".c" alone is a name, no extension); the longest wins
//   (".tar.gz" before ".gz", if both are claimed)
//   two types claiming one extension: the first in the folder's order, which is places' member
//   order (canonical key order of the names: shorter first, then bytewise), NOT the order the list
//   was installed in, which the folder does not keep (mine, open: keeping it would take a field)
// every read through places, so tracked: a computer reruns when a type is installed or its
// fileNameExtension written, the attribute written, or the placement renamed (the name); a
// type's mimeType written does not. the extensions are read only for a node with no ermine.type
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
import { get, lookup, members } from "@ermine/places/lib"
import { keyOrder } from "@ermine/encoding/cbor"
import type { Patch } from "@ermine/op/apply"
import type { Table } from "@ermine/table"
import list from "./utis.json" with { type: "json" }

// the types folder, from a root: the one place its path is said
export const TYPES: Path = ["ermine", "types"]

// the attribute a node's own type is in: the one place its name is said
export const ATTRIBUTE = "ermine.type"

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

// the well-known list (utis.json)
export const KNOWN: readonly Known[] = list

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

// a node, and the path it was reached by (its name last)
export type Placed = { readonly id: Id; readonly at: Path }

// a string with its ASCII capitals lowered (the same in C: names are compared this way)
const lowered = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

// each extension claimed (lowercase, with its "."), and the type that claims it
export type Extensions = ReadonlyMap<string, string>

// the extensions the types in a folder claim: each type's fileNameExtension read (its value's
// field alone), the types in the folder's order (names' canonical key order), the first to claim
// an extension keeping it. no folder: none
export function extensionsOf(places: Reads, folder: Folder | undefined): Extensions {
	const by = new Map<string, string>()
	if (folder === undefined) return by
	const here = members(places, folder.path).filter((m) => m.id !== level)
	here.sort((a, b) => keyOrder(a.name, b.name))
	for (const m of here) {
		for (const x of strings(places.readValue("value", m.id, ["fileNameExtension"]))) {
			const e = lowered(x)
			if (!by.has(e)) by.set(e, m.name)
		}
	}
	return by
}

// the type a name's extension gives: the longest end from a "." that is claimed, with a name
// before it, compared in lowercase; none: undefined
export function typeByName(extensions: Extensions, name: string): string | undefined {
	const lower = lowered(name)
	for (let i = lower.indexOf(".", 1); i !== -1; i = lower.indexOf(".", i + 1)) {
		const uti = extensions.get(lower.slice(i))
		if (uti !== undefined) return uti
	}
}

// the type of a node at a place: its ermine.type if a string, else its name's (typeByName), the
// extensions given (as a search holds them, read once) or those of the nearest ermine/types from
// the placement's folder; none: undefined
export function typeOf(places: Reads, at: Placed, extensions?: Extensions): string | undefined {
	const t = places.readValue("attributes", at.id, [ATTRIBUTE])
	if (typeof t === "string") return t
	const name = at.at[at.at.length - 1]
	if (name === undefined) return
	return typeByName(extensions ?? extensionsOf(places, typesAt(places, at.at.slice(0, -1))), name)
}
