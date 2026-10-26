// made: the nodes a person makes in this den, in the files view or at the terminal: a folder, or a
// node with a value typed (a number, true, false, text). each is this den's own, under its node
// (<node>/files/<8 hex>), so it is kept and travels as steps like the rest of the den; one made at
// the top (/) or in /home is placed there by its "file.at" (a trie of this page's, "made"), and the
// other dens place it the same way (host.ts' away). one made in a folder made here is a name in
// that folder's children. writes through writes.ts, passing over this file, so each one's site is
// the line in the files view or the terminal that asked
//
//   const made = createMade({ scheduler, table, places, scope, node, ... })
//   made.make(["home"], "notes")              // a folder: { path } | { refused: words }
//   made.make(["home", "notes"], "n", 3)      // a node with a value
//   const r = made.unplace(["home", "notes"]) // { name, undo } | { refused } | { thing: id }
//   r.undo()                                  // back where it was
//
// unplace: the node leaves this place and stays a node (undo puts its name back). a running thing:
// { thing }, its process for the caller to stop (main.ts' ×). refused, in words: another den's
// ("not yours: <name>'s"), the den's machinery (/system, /things, /programs, /sync: "the den needs
// this"), the root, and what isn't a folder made here
import { type Id, type Path, PlacesError } from "@ermine/core/places"
import { get, members } from "@ermine/core/places/lib"
import { addLeaf, removeLeaf } from "@ermine/processes"
import { inside } from "@ermine/boxes"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Key, Table } from "@ermine/core/table"
import type { Places } from "@ermine/core/places"
import { createWrites } from "./writes.ts"

// a made folder's type, and where a made node at the top is placed
export const FOLDER = "dens.folder"
export const FILE_AT = "file.at"
// the trie this page places its own made nodes in
export const MADE = "made" as string as Key
// the den's machinery: nothing made or taken out there
export const MACHINERY = ["system", "things", "programs", "sync"]

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)
const bad = (name: string) => name === "" || name === "." || name === ".." || name.includes("/")
const show = (p: Path) => `/${p.join("/")}`
const hex8 = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0"))
		.join("")

export type Made = ReturnType<typeof createMade>
export type Unplaced = { name: string; path: Path; undo: () => void }

export function createMade(o: {
	scheduler: Scheduler
	table: Table
	places: Places
	scope: Scope
	root: Id
	// this den's node
	node: string
	// another den's name, from a node of its (its install's id first)
	owner: (id: string) => string | undefined
	// whether an id is a thing this den runs
	running: (id: string) => boolean
}) {
	const { scheduler: s, table, places, root, node } = o
	const FILES = `${node}/files`
	const w = createWrites({
		scheduler: s,
		table,
		places,
		scope: o.scope,
		skip: [import.meta.url],
	})
	const hosted = <T>(f: () => T) => s.runWithScope(o.scope, f)
	const mine = (id: unknown) => typeof id === "string" && id.startsWith(`${FILES}/`)
	const peep = <T>(f: () => T) => places.peep(f)
	const attributes = (id: string) => {
		const a = table.get("attributes", id)?.value
		return isMap(a) ? a : {}
	}
	// whose node it is when it isn't this den's: a name, else undefined
	const theirs = (id: unknown) =>
		typeof id === "string" && !id.startsWith(node) ? o.owner(id) : undefined
	const notYours = (who: string) => ({ refused: `not yours: ${who}'s` })
	const needs = (p: Path) => ({ refused: `${show(p)} is the den's own: the den needs this` })

	// a folder, or a node with a value, named name in the folder at path
	function make(
		folder: Path,
		name: string,
		value?: unknown,
	): { path: Path } | { refused: string } {
		name = name.trim()
		if (bad(name)) return { refused: `"${name}" can't be a name: no /, and not empty, . or ..` }
		if (MACHINERY.includes(folder[0])) return needs(folder)
		const path = [...folder, name]
		// at the top or in /home: placed by its file.at; in a folder made here: in its children
		const top = folder.length === 0 || (folder.length === 1 && folder[0] === "home")
		let parent: string | undefined
		if (!top) {
			const at = peep(() => get(places, folder))
			if (at === undefined) return { refused: `nothing is at ${show(folder)}` }
			const who = theirs(at)
			if (who !== undefined) return notYours(who)
			if (!mine(at) || attributes(String(at))["ermine.type"] !== FOLDER) {
				return { refused: `${show(folder)} isn't a folder made here, so nothing can go in it` }
			}
			parent = String(at)
		}
		const there = peep(() => members(places, folder)).some((m) => m.name === name)
		if (there) return { refused: `something is already called ${name} in ${show(folder)}` }
		const id = `${FILES}/${hex8()}`
		if (value === undefined) {
			w.put("children", id, {})
			w.put("attributes", id, { "ermine.type": FOLDER, ...top ? { [FILE_AT]: show(path) } : {} })
		} else {
			w.put("value", id, value)
			if (top) w.put("attributes", id, { [FILE_AT]: show(path) })
		}
		w.patch("children", FILES, [id.slice(FILES.length + 1)], id)
		if (parent !== undefined) w.patch("children", parent, [name], id)
		return { path }
	}

	// the node at path out of its place; refused in words, or a running thing to stop
	function unplace(path: Path): Unplaced | { refused: string } | { thing: string } {
		if (path.length === 0) return { refused: "the root stays" }
		if (MACHINERY.includes(path[0])) return needs(path)
		const folder = path.slice(0, -1), name = path.at(-1)!
		const m = peep(() => members(places, folder)).find((x) => x.name === name)
		if (m === undefined) return { refused: `nothing is at ${show(path)}` }
		const id = typeof m.id === "string" ? m.id : undefined
		const who = theirs(id) ?? (m.from === "away" ? "another den" : undefined)
		if (who !== undefined) return notYours(who)
		if (id !== undefined && o.running(id)) return { thing: id }
		if (m.from === "process" || id === undefined) {
			return { refused: `${show(path)} holds what runs here: it stays` }
		}
		// at the top or in /home: its file.at taken off (the trie follows); undo puts it back
		if (m.from === "made") {
			const at = attributes(id)[FILE_AT]
			w.drop("attributes", id, [FILE_AT])
			return { name, path, undo: () => w.patch("attributes", id, [FILE_AT], at) }
		}
		// a name in a folder's children (a folder made here, or one of this page's own)
		const up = folder.length === 0 ? String(root) : peep(() => get(places, folder))
		if (m.from === "children" && typeof up === "string") {
			const owner = theirs(up)
			if (owner !== undefined) return notYours(owner)
			w.drop("children", up, [name])
			return { name, path, undo: () => w.patch("children", up, [name], id) }
		}
		return { refused: `${show(path)} can't be taken out here` }
	}

	// this den's made nodes at the top or in /home, placed: each listed one with a file.at
	const placed = new Map<string, { path: Path; id: string }>()
	function place(want: Map<string, { path: Path; id: string }>) {
		for (const [k, l] of [...placed]) {
			if (want.get(k)?.id === l.id) continue
			placed.delete(k)
			try {
				w.commit(removeLeaf(table, MADE, root, l.path, w.header()))
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
		}
		for (const [k, l] of want) {
			if (placed.has(k)) continue
			try {
				w.commit(addLeaf(table, MADE, root, l.path, l.id, w.header()))
				placed.set(k, l)
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
		}
	}
	hosted(() =>
		s.createEffect(() => placements(places, FILES), (want) => hosted(() => place(want)))
	)

	return { make, unplace, mine, theirs }
}

// the made nodes a den lists under files (its node + /files) that have a file.at: where each goes,
// by its path. tracked: host.ts' away places another den's the same way
export function placements(places: Places, files: string) {
	const want = new Map<string, { path: Path; id: string }>()
	const listed = places.readValue("children", files)
	for (const id of Object.values(isMap(listed) ? listed : {})) {
		if (typeof id !== "string") continue
		const at = places.readValue("attributes", id, [FILE_AT])
		if (typeof at !== "string") continue
		const path = inside(at)
		want.set(JSON.stringify(path), { path, id })
	}
	return want
}
