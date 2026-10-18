// boxes on a real scheduler, table and paths, made over the host's places (root R, children alone):
// read through lib.ts and through a path cache on a box's places. the suite (conformance/boxes) holds
// the rules; these hold what it cannot say: sites, the host's commit, the cache, a stand-in
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry, { type Entry } from "@ermine/node/entry"
import { type Computer, createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces, PlacesError } from "@ermine/places"
import { createPathCache } from "@ermine/places/cache"
import { get, list, lookup } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { addProcess, processes } from "@ermine/processes"
import { type Box, box, createBox, type Host, unbox } from "./boxes.ts"

function world(commit?: Host["commit"]) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table, paths, scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const host: Host = { places, table, scheduler: s, commit }
	const scope = s.createRootScope({ actor: "host" })
	const notes = s.createRootScope({ actor: "notes" })
	const hosted = <T>(f: () => T) => s.runWithScope(scope, f)
	const header = () => createChangeHeader(s)
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, header())))
	type W<T> = { runs: number; values: T[]; c: Computer }
	function watch<T>(f: () => T): W<T> {
		const w = { runs: 0, values: [] } as unknown as W<T>
		w.c = s.runWithScope(
			notes,
			() => s.createComputer(() => (w.runs++, f()), (v) => void w.values.push(v)),
		)
		return w
	}
	// R/work is W: fetch (F0) and notes (N, with pad); R/tools is T
	function tree() {
		kids("R", { work: "W", tools: "T" })
		kids("W", { fetch: "F0", notes: "N" })
		kids("N", { pad: "PAD" })
	}
	return { s, table, places, host, hosted, header, kids, watch, tree }
}

const refused = (f: () => unknown, code: string) => {
	const e = assertThrows(f, PlacesError)
	assertEquals(e.code, code)
}

Deno.test("a box is its folder and the host's places viewed from it, nothing more", () => {
	const w = world()
	w.tree()
	const b = w.hosted(() => createBox(w.host, "work"))
	assertEquals(Object.keys(b).sort(), ["places", "root"])
	assertEquals([b.root, b.places.root, get(b.places, [])], ["W", "W", "W"])
	assertEquals(b.places.contributors?.map((c) => c.from), ["process", "children"])
	assertEquals(get(b.places, ["notes", "pad"]), "PAD")
	assertEquals([get(b.places, ["work"]), get(b.places, ["tools"])], [undefined, undefined])
	assertEquals(lookup(b.places, ["tools"], ["notes", "pad"]), undefined)
})

Deno.test("a folder made is a plain uuid, placed as a regular child, saved, with the site of the caller", () => {
	const w = world()
	w.tree()
	const b = w.hosted(() => createBox(w.host, "work/fresh/inner"))
	const fresh = get(w.places, ["work", "fresh"])!
	assertEquals(get(w.places, ["work", "fresh", "inner"]), b.root)
	assert(/^[0-9a-f-]{36}$/.test(String(fresh)), String(fresh))
	const made = w.table.get("children", "W")!.change
	assertEquals(made.actor, "host")
	assert(made.external?.[0].file.endsWith("boxes_test.ts"), JSON.stringify(made.external))
	// the folder with no children entry before: one made, by a table event
	assertEquals(w.table.get("children", fresh)!.value, { inner: b.root })
	assert(w.table.get("children", fresh)!.change.external?.[0].file.endsWith("boxes_test.ts"))
})

Deno.test("box and unbox: their site is the caller's; a header given is used as it is; the entries changed are given back, committed by the host's commit", () => {
	const told: Entry<unknown>[][] = []
	const w = world((changed) => (told.push([...changed]), w.places.commit(changed)))
	w.tree()
	const b = w.hosted(() => createBox(w.host, "work"))
	assertEquals(told, [])
	const changed = w.hosted(() => box(b, ["a"], "A"))
	assertEquals(changed, [w.table.get("children", "W")!])
	assertEquals(told, [changed])
	const change = w.table.get("children", "W")!.change
	assert(change.external?.[0].file.endsWith("boxes_test.ts"), JSON.stringify(change.external))
	const h = w.hosted(() => w.header())
	w.hosted(() => unbox(b, ["a"], h))
	assertEquals(w.table.get("children", "W")!.change.time, h.time)
	assertEquals(told.length, 2)
	// no scope open: unscoped, nothing written
	assertThrows(() => box(b, ["d"], "D"))
	assertEquals(get(b.places, ["d"]), undefined)
})

Deno.test("a reader in a box reruns on box and unbox, read directly and through a path cache on its places", () => {
	const w = world()
	w.tree()
	const b = w.hosted(() => createBox(w.host, "work"))
	const cache = createPathCache({ places: b.places, scheduler: w.s })
	const direct = w.watch(() => get(b.places, ["fetch"]))
	const cached = w.watch(() => cache.get(["fetch"]))
	const names = w.watch(() => cache.list([]))
	w.s.pulse()
	w.hosted(() => unbox(b, ["fetch"]))
	w.s.pulse()
	w.hosted(() => box(b, ["fetch"], "NF"))
	w.s.pulse()
	assertEquals(direct.values, ["F0", undefined, "NF"])
	assertEquals(cached.values, ["F0", undefined, "NF"])
	assertEquals(names.values, [["fetch", "notes"], ["notes"], ["fetch", "notes"]])
})

Deno.test("any places rooted at the root and asked the same stands in for a box: the root is the outermost box", () => {
	const w = world()
	w.tree()
	const root: Box = {
		root: w.places.root,
		places: w.places.view(w.places.root, [processes(w.places.root), children]),
	}
	w.hosted(() =>
		w.places.commit(addProcess(w.table, root.root, ["work", "clock"], "P", w.header()))
	)
	assertEquals(get(root.places, ["work", "clock"]), "P")
	assertEquals([...list(root.places, ["work"])], ["clock", "fetch", "notes"])
	// a box in it by its root: work, as one made from the host
	const b = w.hosted(() => createBox(w.host, "work", root))
	assertEquals(b.root, "W")
	// it was not made by createBox: no host to write with
	refused(() => w.hosted(() => box(root, ["x"], "X")), "nothing-there")
})
