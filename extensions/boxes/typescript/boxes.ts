// boxes: another namespace over the same store [chee 10-27: "a child that doesn't know about its
// parent"]. a box has a "/" of its own and names only it sees. nothing above its root is reachable
// by a name, and nothing of the box is written into the folders it looks at.
//
//   const box = createBox(ermine, "/catclock")      // its "/" is the folder at /catclock
//   box.put("lib/loaders", loaders)                 // only this box sees it, at lib/loaders
//   box.start(clock, "/clock")                      // a process whose "/" is the box's
//   box.take("lib/loaders")
//
// underneath: ermine.places.view(root, [bindings, processes(root), children]). the box's places
// are a view of the ermine's, sharing its table, scheduler and spots; only the contributors and the
// root differ.
//   bindings   a local map from a path inside the box to a node id: a row part ("binding") on a key
//              of the box's own, never saved, never synced, and asked only by this box's view (two
//              boxes over one folder each have their own). a path with several names is a level
//              (places' Contributor.level) so a walk goes through it. a binding shadows what is
//              saved at its path, as a running process does
//   processes  the rows of the processes started in the box, on the box's root (@ermine/processes)
//   children   what is saved under the root, if it is a folder
// ".." at a box's "/" stays at "/" (the base's resolve, for every process).
//
// picks (tippi's, chee may change them):
//   - the root: an existing folder (its own children are seen, and a process started in the box is
//     a row on that folder's id, not on the ermine's root), or a fresh empty node
//   - a process started in the box is not in the host's own walk: the host asks the box
//     (box.places) to see it
//   - the host, and features, make boxes; programs do not
//   - process rows are on the box's root, so two boxes over one folder share them: a path a process
//     runs at is taken in both, and each lists the other's processes (their bindings stay apart)
//   - close: every binding the box put goes (as take does, a running reader is told) and every process
//     started through box.start is stopped ("box closed"). what those started belong to their
//     starters and go with them. after it put, take and start throw gone; close again does nothing.
//     box.places stays a view (the folder's own children are not the box's). the box's fresh root
//     (no folder given) is left: an id nothing names
//
// put refused, nothing changed: something there already (a binding, a saved child or a process, at
// the path, above it holding a node, or under it): already-there; no name: not-a-name. take of a
// path with no binding: nothing-there
import { createChangeHeader } from "@ermine/core/places/header"
import { get } from "@ermine/core/places/lib"
import { type Id, type Path, type Places, PlacesError } from "@ermine/core/places"
import { children } from "@ermine/core/places"
import type { Key } from "@ermine/core/table"
import { addLeaf, processes, removeLeaf, trie } from "@ermine/processes"
import { inside } from "@ermine/processes/start"
import { type Ermine, ErmineError, type StartOptions } from "@ermine/system"

// the part the bindings are rows of
export const BINDING = "binding" as string as Key

// what Ermine["start"] gives when it started
type Started = Extract<ReturnType<Ermine["start"]>, { stop: unknown }>

// a path: a string ("a/b", "/c") or its names
export type Address = string | Path

export type Box = {
	// the folder its "/" is
	readonly root: Id
	// the ermine's places, from root: [bindings, processes(root), children]
	readonly places: Places
	// node (an id) at path, seen only by this box
	put: (path: Address, node: Id) => void
	// what put put at path, gone
	take: (path: Address) => void
	// ermine.start(fn, at, …) with at in the box: its "/" is the box's, its row on the box's root
	start: Ermine["start"]
	// its bindings gone, its processes stopped ("box closed"); then put, take and start are gone
	close: () => void
}

// a box over the folder at a path from the ermine's root (nothing there: nothing-there), or the
// folder with that id as it is, or (none given) a new empty node
export function createBox(ermine: Ermine, at?: Address | { readonly id: Id }): Box {
	let root: Id
	if (at === undefined) root = `box:${crypto.randomUUID()}`
	else if (typeof at === "object" && !Array.isArray(at) && "id" in at) root = at.id
	else {
		const found = ermine.places.peep(() => get(ermine.places, inside(at as Address)))
		if (found === undefined) throw new PlacesError("nothing-there", String(at))
		root = found
	}
	// the key of this box's binding rows: its own, so another box over the same folder has others
	const key: Id = `bindings:${crypto.randomUUID()}`
	const places = ermine.places.view(root, [
		trie(BINDING, key, "box"),
		processes(root),
		children,
	])
	// what is put and not taken (by names), and what is started and not stopped
	const bound = new Map<string, readonly string[]>()
	const running = new Set<Started>()
	let closed = false
	const alive = () => {
		if (closed) throw new ErmineError("gone", "gone: this box was closed")
	}
	return {
		root,
		places,
		put(path, node) {
			alive()
			const names = inside(path)
			if (names.length > 0 && places.peep(() => get(places, names)) !== undefined) {
				throw new PlacesError("already-there", names[names.length - 1])
			}
			ermine.within(() => {
				const header = createChangeHeader(ermine.scheduler)
				ermine.places.commit(addLeaf(ermine.table, BINDING, key, names, node, header))
			})
			bound.set(JSON.stringify(names), names)
		},
		take(path) {
			alive()
			const names = inside(path)
			ermine.within(() => {
				const header = createChangeHeader(ermine.scheduler)
				ermine.places.commit(removeLeaf(ermine.table, BINDING, key, names, header))
			})
			bound.delete(JSON.stringify(names))
		},
		start(fn, to, options?: StartOptions) {
			alive()
			const made = ermine.start(fn, to, { ...options, places })
			if (!("refused" in made)) running.add(made)
			return made
		},
		close() {
			if (closed) return
			closed = true
			for (const s of running) s.stop("box closed")
			running.clear()
			ermine.within(() => {
				for (const names of bound.values()) {
					const header = createChangeHeader(ermine.scheduler)
					try {
						ermine.places.commit(removeLeaf(ermine.table, BINDING, key, names, header))
					} catch (e) {
						if (!(e instanceof PlacesError && e.code === "nothing-there")) throw e
					}
				}
			})
			bound.clear()
		},
	}
}
