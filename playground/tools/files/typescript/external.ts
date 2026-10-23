// Where a store's manifest is (FILES.tex, The manifest). It is .ermine in the
// store's folder, unless a service that syncs files watches the folder: iCloud
// Drive, which macOS says of a folder; anything under ~/Library/CloudStorage,
// where macOS puts Dropbox, Google Drive and OneDrive; and any place the host
// names, on the home folder's volume. Then it is ~/.ermine/external/<uuid>/,
// <uuid> the store's own, which the folder carries in an attribute.
//
// ~/.ermine/external/stores is a CBOR map from each uuid to {path, bookmark}:
// the folder's last path, and on macOS a bookmark of it, which follows it
// while nothing runs. A host can list its stores and find one by uuid. Every
// store is in it, those whose manifest is in their folder too: a copy is told
// by the bookmark of the store it was copied from.
//
// A folder found carrying a uuid whose bookmark leads to another live folder
// is a copy, as Duplicate makes: a uuid of its own and an empty manifest. A
// folder with a uuid and no manifest here is a new store. A folder that came
// into a synced place, or left one, has its .ermine moved out or in.

import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { type Foundation, system as real } from "./foundation.ts"
import { attr, type Sys } from "./sys.ts"
import { isName } from "./names.ts"

/** Where a host's home is, how to ask Foundation, and the places it names. */
export type Where = {
	/** the home folder; none, and nothing is ever outside and no store is listed */
	home?: string
	foundation?: Foundation
	/** places whose folders have their manifests outside */
	places?: readonly string[]
}

/** A store, as ~/.ermine/external/stores has it. */
export type Stored = { uuid: string; path: string; bookmark?: Uint8Array }

/** Where outside manifests and the list of stores are. */
export const outside = (home: string) => `${home}/.ermine/external`

const utf8 = new TextDecoder()

/** The home folder: the one given, or the person's; undefined if neither. */
export function homeOf(w: Where): string | undefined {
	return w.home ?? Deno.env.get("HOME") ?? undefined
}

const under = (path: string, place: string) => path === place || path.startsWith(place + "/")

async function real_(path: string): Promise<string | undefined> {
	try {
		return await Deno.realPath(path)
	} catch (e) {
		if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.NotADirectory) return
		throw e
	}
}

/** The nearest folder that is there: the path itself, or the first of its parents, as the system names it. */
async function nearest(path: string): Promise<string | undefined> {
	for (let p = path;;) {
		const r = await real_(p)
		if (r !== undefined) return r
		const up = p.slice(0, p.lastIndexOf("/"))
		if (up === p || up === "") return
		p = up
	}
}

/** Whether a service that syncs files watches the folder, so its manifest is outside. */
export async function synced(folder: string, w: Where = {}): Promise<boolean> {
	const home = homeOf(w)
	if (home === undefined) return false
	const at = await nearest(folder)
	const root = await real_(home)
	if (at === undefined || root === undefined) return false
	// swaps and clones need the manifest on the folder's volume
	try {
		if ((await Deno.stat(at)).dev !== (await Deno.stat(root)).dev) return false
	} catch {
		return false
	}
	if ((w.foundation ?? real).ubiquitous(at)) return true
	const places = [`${root}/Library/CloudStorage`]
	for (const p of w.places ?? []) {
		const r = await real_(p)
		if (r !== undefined) places.push(r)
	}
	return places.some((p) => under(at, p))
}

// the list of stores ---------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve()

/** Runs fn after the lists changes already begun in this process, so two do not write over each other. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(fn)
	chain = run.catch(() => {})
	return run
}

/** Every store the list has, by uuid. */
async function read(home: string): Promise<Map<string, Stored>> {
	const out = new Map<string, Stored>()
	let bytes: Uint8Array
	try {
		bytes = await Deno.readFile(`${outside(home)}/stores`)
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return out
		throw e
	}
	const v = decode(bytes)
	if (v === null || typeof v !== "object" || Array.isArray(v) || ArrayBuffer.isView(v)) return out
	for (const [uuid, e] of Object.entries(v as Record<string, Value>)) {
		if (e === null || typeof e !== "object" || Array.isArray(e)) continue
		const { path, bookmark } = e as { path?: Value; bookmark?: Value }
		if (typeof path !== "string") continue
		out.set(uuid, {
			uuid,
			path,
			...(bookmark instanceof Uint8Array ? { bookmark } : {}),
		})
	}
	return out
}

/** Writes the list whole, through a file of its own and a rename. */
async function write(home: string, all: Map<string, Stored>) {
	const dir = outside(home)
	await Deno.mkdir(dir, { recursive: true })
	const body = encode(Object.fromEntries(
		[...all].map(([uuid, s]) => [
			uuid,
			{ path: s.path, ...(s.bookmark ? { bookmark: s.bookmark } : {}) },
		]),
	))
	const tmp = `${dir}/stores.${crypto.randomUUID()}`
	await Deno.writeFile(tmp, body, { createNew: true })
	await Deno.rename(tmp, `${dir}/stores`)
}

/** The stores a host has, with each one's last path and bookmark. */
export async function stores(w: Where = {}): Promise<Stored[]> {
	const home = homeOf(w)
	return home === undefined ? [] : [...(await read(home)).values()]
}

/**
 * Where a store is now: its bookmark's path while that is a folder that is
 * there, and its last path otherwise; undefined if it leads nowhere. A
 * folder that is in the Trash is not found.
 */
export async function find(uuid: string, w: Where = {}): Promise<string | undefined> {
	const home = homeOf(w)
	if (home === undefined) return
	const s = (await read(home)).get(uuid)
	if (!s) return
	const f = w.foundation ?? real
	for (const p of [s.bookmark ? f.resolve(s.bookmark) : undefined, s.path]) {
		if (p === undefined) continue
		const r = await real_(p)
		if (r === undefined || under(r, (await real_(`${home}/.Trash`)) ?? `${home}/.Trash`)) continue
		if ((await Deno.stat(r)).isDirectory) return r
	}
}

/** Records where a store is, if that is not what the list has. */
export function note(uuid: string, folder: string, w: Where = {}): Promise<void> {
	const home = homeOf(w)
	if (home === undefined) return Promise.resolve()
	return serial(async () => {
		const at = (await real_(folder)) ?? folder
		const all = await read(home)
		const had = all.get(uuid)
		if (had?.path === at && had.bookmark) return
		const bookmark = (w.foundation ?? real).bookmark(at)
		all.set(uuid, { uuid, path: at, ...(bookmark ? { bookmark } : {}) })
		await write(home, all)
	})
}

/** Whether a folder carrying a uuid is a copy: the list leads that uuid to another folder that is there. */
async function copied(uuid: string, folder: string, sys: Sys, w: Where): Promise<boolean> {
	const home = homeOf(w)
	if (home === undefined) return false
	const s = (await read(home)).get(uuid)
	if (!s) return false
	const f = w.foundation ?? real
	const led = s.bookmark ? f.resolve(s.bookmark) : undefined
	const r = await real_(led ?? s.path)
	const mine = await real_(folder)
	if (r === undefined || r === mine) return false
	const trash = (await real_(`${home}/.Trash`)) ?? `${home}/.Trash`
	if (under(r, trash) || !(await Deno.stat(r)).isDirectory) return false
	// a path alone is a store's only if the folder there carries the uuid still
	if (led === undefined) {
		const found = await sys.get(r, attr.store)
		if (!found || utf8.decode(found) !== uuid) return false
	}
	return true
}

// where a manifest is ---------------------------------------------------------

/** Where a store's manifest is, and what loading must do about it. */
export type Located = {
	/** the manifest's folder, absolute */
	dir: string
	/** the store's uuid, new or as the folder carries it */
	uuid: string
	/** the folder must be given the uuid: it carried none, or a copy's */
	set: boolean
	/** the folder is a copy: its own manifest, if inside, is not its own */
	copy: boolean
}

async function has(dir: string): Promise<boolean> {
	try {
		return (await Deno.lstat(`${dir}/manifest`)).isFile
	} catch (e) {
		if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.NotADirectory) return false
		throw e
	}
}

async function copyTree(from: string, to: string) {
	await Deno.mkdir(to)
	for await (const e of Deno.readDir(from)) {
		const a = `${from}/${e.name}`, b = `${to}/${e.name}`
		if (e.isDirectory) await copyTree(a, b)
		else if (e.isSymlink) await Deno.symlink(await Deno.readLink(a), b)
		else await Deno.copyFile(a, b)
	}
}

/** Moves a folder, by a rename, or across volumes by a copy. A folder of ours already in the way, which holds no manifest, is removed. */
async function move(from: string, to: string, sys: Sys) {
	await Deno.mkdir(to.slice(0, to.lastIndexOf("/")), { recursive: true })
	await Deno.remove(to, { recursive: true }).catch((e) => {
		if (!(e instanceof Deno.errors.NotFound)) throw e
	})
	try {
		await Deno.rename(from, to)
	} catch (e) {
		if ((e as { code?: string }).code !== "EXDEV") throw e
		await copyTree(from, to)
		await Deno.remove(from, { recursive: true })
	}
	for (const p of [from, to]) {
		try {
			await sys.sync(p.slice(0, p.lastIndexOf("/")))
		} catch {
			// a folder that will not sync is not a store that will not load
		}
	}
}

/**
 * Finds a store's manifest, moving it when its folder came into a synced place
 * or left one, as the store's folder says. A folder that is not there, or has
 * no uuid, or is a copy, is a store to make: the answer says where.
 */
export async function locate(folder: string, sys: Sys, w: Where = {}): Promise<Located> {
	const inside = `${folder}/.ermine`
	const home = homeOf(w)
	let uuid: string | undefined
	try {
		const b = await sys.get(folder, attr.store)
		// a uuid names a folder in ~/.ermine/external: one that is no name there (".." or "/" in
		// it) is none, and the folder a store with no uuid
		if (b && isName(utf8.decode(b))) uuid = utf8.decode(b)
	} catch (e) {
		if (!(e instanceof Deno.errors.NotFound)) throw e
	}
	const out = home === undefined ? undefined : await synced(folder, w)
	const where = (u: string) => (out ? `${outside(home!)}/${u}` : inside)
	let copy = false
	if (uuid !== undefined && (await copied(uuid, folder, sys, w))) {
		copy = true
		uuid = undefined
	}
	if (uuid === undefined) {
		// a store with a manifest in it and no uuid, as an app dropped it, keeps its manifest
		const mine = !copy && (await has(inside))
		const u = crypto.randomUUID()
		if (mine && out) await move(inside, where(u), sys)
		return { dir: where(u), uuid: u, set: true, copy }
	}
	const other = out ? inside : `${outside(home ?? "")}/${uuid}`
	const here = where(uuid)
	if (!(await has(here)) && home !== undefined && (await has(other))) await move(other, here, sys)
	return { dir: here, uuid, set: false, copy: false }
}
