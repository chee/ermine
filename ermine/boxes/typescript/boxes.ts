// boxes: a "/" of a process's own, a plain folder placed as a regular child. what is boxed sees
// nothing above that folder.
//
//   const host = { places, table, scheduler }
//   const b = createBox(host, "somewhere/new-folder")   // made if missing: regular folders, saved
//   box(b, ["loaders", "c"], "n:cc-wasm")                // a regular placement in the folder
//   get(b.places, ["loaders", "c"])                      // "n:cc-wasm"; lib.ts' reads, unchanged
//   unbox(b, ["loaders", "c"])
//
// a box: its folder's id (root) and a view of the host's places rooted there, asked
// [processes(root), children]. the graph's root is the outermost box. ".." at its "/" stays there
// (inside). writes through either places tell readers of both.
// writes: saved children only; missing folders made, committed by the host. refused, nothing
// changed: not-a-name, already-there (a name holding no id).
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import {
	asId,
	children,
	type Id,
	type Path,
	place,
	type Places,
	PlacesError,
	unplace,
} from "@ermine/places"
import { createChangeBase } from "@ermine/places/header"
import { parse } from "@ermine/places/path"
import { processes } from "@ermine/processes"
import { type Scheduler, SchedulerError } from "@ermine/scheduler"
import type { Table } from "@ermine/table"
import { capture } from "@ermine/util/stacktrace"

// what a box is made over: the host's places, and what its writes need
export type Host = {
	places: Places
	table: Pick<Table, "get" | "add">
	scheduler: Pick<Scheduler, "getCurrentScope">
	// where its writes are said written; none: places.commit
	commit?: (changed: readonly Entry<unknown>[]) => void
}

export type Box = {
	// its folder's id
	readonly root: Id
	// the host's places from root, asked [processes(root), children]
	readonly places: Places
}

// an address: a string ("a/b", "../c", "/d"; path.ts' parse) or steps, each a name, ".", ".." or "/"
export type Address = string | Path

// each box's host: kept out of the box, so whoever is handed one reaches nothing above its folder
const hosts = new WeakMap<Box, Host>()

function hostOf(b: Box): Host {
	const h = hosts.get(b)
	if (h === undefined) throw new PlacesError("nothing-there", String(b.root))
	return h
}

// the names an address comes to inside a root, from where you are (names from the root): "." here,
// ".." back one (at the root: stays there), "/" back to the root
export function inside(address: Address, from: Path = []): string[] {
	const names = [...from]
	for (const step of typeof address === "string" ? parse(address) : address) {
		if (step === ".") continue
		if (step === "/") names.length = 0
		else if (step === "..") names.pop()
		else names.push(step)
	}
	return names
}

// the folder at an address: from the parent's root (a box, or any places: none, the host's places'),
// found or made; an id: that folder, as it is (none with a parent: an id could be anywhere, and a box
// in another is only ever narrower). its places: the host's, viewed from it
export function createBox(
	host: Host,
	at: Address | { readonly id: Id },
	parent?: { readonly root: Id },
	header?: ChangeHeader,
): Box {
	let root: Id
	if (typeof at === "object" && !Array.isArray(at) && "id" in at) {
		if (parent !== undefined) throw new PlacesError("nothing-there", String(at.id))
		root = at.id
	} else {
		const from = parent?.root ?? host.places.root
		const made = land(host, from, inside(at as Address), undefined, header, createBox)
		root = made.id
		said(host, made.changed)
	}
	const b: Box = { root, places: host.places.view(root, [processes(root), children]) }
	hosts.set(b, host)
	return b
}

// node placed at an address in the box: a regular placement, the folders on the way made. refused:
// no name (not-a-name); something at the path already (already-there: unbox first). gives back the
// entries changed, already committed (none: a table event)
export function box(
	somebox: Box,
	path: Address,
	node: Id,
	header?: ChangeHeader,
): Entry<unknown>[] {
	const host = hostOf(somebox)
	const names = inside(path)
	if (names.length === 0) throw new PlacesError("not-a-name")
	const { changed } = land(host, somebox.root, names, node, header, box)
	said(host, changed)
	return changed
}

// what is at an address in the box unplaced: a regular unplace (the folders on the way stay). none
// there, or no name: nothing-there. gives back the entries changed, already committed
export function unbox(somebox: Box, path: Address, header?: ChangeHeader): Entry<unknown>[] {
	const host = hostOf(somebox)
	const names = inside(path)
	if (names.length === 0) throw new PlacesError("nothing-there")
	let at = somebox.root
	for (const name of names.slice(0, -1)) {
		const v = host.table.get("children", at)?.value
		const id = isMap(v) && Object.hasOwn(v, name) ? asId(v[name]) : undefined
		if (id === undefined) throw new PlacesError("nothing-there", name)
		at = id
	}
	const kids = host.table.get("children", at) as Entry<unknown> | undefined
	if (kids === undefined) throw new PlacesError("nothing-there", names[names.length - 1])
	const changed = unplace(kids, names[names.length - 1], header ?? headerOf(host, unbox))
	said(host, changed)
	return changed
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

// what name holds in the saved children of at: an id, or undefined (nothing; something that is no
// id: thrown, already-there)
function saved(host: Host, at: Id, name: string): Id | undefined {
	const v = host.table.get("children", at)?.value
	if (!isMap(v) || !Object.hasOwn(v, name)) return undefined
	const id = asId(v[name])
	if (id === undefined) throw new PlacesError("already-there", name)
	return id
}

// names from the folder from, through saved children: each there gone into, each missing one made (a
// new id; the last, leaf when given, and then it must be missing). checked first, so a refusal
// changes nothing. gives the id at the end and the entries changed, not yet committed
function land(
	host: Host,
	from: Id,
	names: readonly string[],
	leaf: Id | undefined,
	header: ChangeHeader | undefined,
	entry: unknown,
): { id: Id; changed: Entry<unknown>[] } {
	let at = from, k = 0
	for (; k < names.length; k++) {
		const id = saved(host, at, names[k])
		if (id === undefined) break
		if (leaf !== undefined && k === names.length - 1) {
			throw new PlacesError("already-there", names[k])
		}
		at = id
	}
	const changed: Entry<unknown>[] = []
	if (k === names.length) return { id: at, changed }
	for (const name of names.slice(k)) if (bad(name)) throw new PlacesError("not-a-name", name)
	const h = header ?? headerOf(host, entry)
	for (; k < names.length; k++) {
		const id = leaf !== undefined && k === names.length - 1 ? leaf : crypto.randomUUID()
		const kids = host.table.get("children", at) as Entry<unknown> | undefined
		if (kids !== undefined) changed.push(...place(kids, names[k], id, h))
		else host.table.add("children", at, createEntry<unknown>({ [names[k]]: id }, h) as never)
		at = id
	}
	return { id: at, changed }
}

// a write said written, by the host's commit
function said(host: Host, changed: readonly Entry<unknown>[]) {
	if (changed.length) (host.commit ?? host.places.commit)(changed)
}

// the header of a write made now, as places' createChangeHeader makes it, its site the call into
// entry (createBox, box or unbox): the caller's own, never this file
// core candidate (places' header.ts): createChangeHeader taking the function called, so a site
// is the caller's of a wrapper like this one
const ours = new Set([import.meta.url])
function headerOf(host: Host, entry: unknown): ChangeHeader {
	const who = createChangeBase(host.scheduler)
	if (who === undefined) throw new SchedulerError("unscoped", "a write with no scope open")
	const h: ChangeHeader = { ...who, time: Math.floor(Date.now() / 1000) }
	const site = capture(ours, entry)
	if (site) h.external = [site]
	return h
}
