// boxes' harness: the ermine harness (ermine/system/typescript/ermine_harness.ts: its ermine,
// programs, requests and logs, all as documented there) with boxes (boxes.ts) beside. a box has a
// name here; a node is named by its path in the host's graph.
//   { op: "box", name, at?, id? }       → {}   createBox(ermine, at | { id }): none: a new empty node
//   { op: "boxput", box, path, node }      → {}   box.put(path, the node at the host's path node)
//   { op: "boxtake", box, path }           → {}
//   { op: "boxclose", box }                → {}   box.close()
//   { op: "boxstart", box, name, at }      → {} | { refused }   box.start(a program that only adds a
//      teardown noting its why, at); started under box.start itself, which the "start" op's in: is not
//      throws: true: the teardown notes its why, then throws "teardown threw" (the TypeScript harness only)
//   { op: "boxwhy", name }                 → { whys }   the whys the teardowns of boxstart's name were told
//   { op: "look", in?, path }           → { there, value? }   the node at path as a box's places (in:
//      its name; none: the host's) see it: whether it is there, and its value
//   { op: "names", in?, path }          → { names }   the names under path there, sorted
// and the "start" op takes in: a box's name: box.start(…) in place of ermine.start(…)
import { addTeardown, type Ermine } from "@ermine/system"
import { get, list } from "@ermine/core/places/lib"
import { type Id, type Places, PlacesError } from "@ermine/core/places"
import { type Box, createBox } from "./boxes.ts"
import { ops, placed, serveErmine } from "../../../ermine/system/typescript/ermine_harness.ts"

const boxes = new Map<string, Box>()
const names = (path: unknown): string[] =>
	(typeof path === "string" ? path.split("/") : path as string[]).filter((n) => n !== "")

function boxOf(name: unknown): Box {
	const b = boxes.get(name as string)
	if (b === undefined) throw new Error(`no box ${name}`)
	return b
}
const placesOf = (e: Ermine, name: unknown): Places =>
	name === undefined ? e.places : boxOf(name).places
function idAt(e: Ermine, path: unknown): Id {
	const id = get(e.places, names(path))
	if (id === undefined) throw new PlacesError("nothing-there", String(path))
	return id
}

ops.set("box", (r, e) => {
	const box = createBox(
		e,
		r.at !== undefined ? names(r.at) : r.id !== undefined ? { id: r.id } : undefined,
	)
	boxes.set(r.name, box)
	placed.set(r.name, box.places)
	return {}
})
ops.set("boxput", (r, e) => {
	boxOf(r.box).put(names(r.path), idAt(e, r.node))
	return {}
})
ops.set("boxtake", (r) => {
	boxOf(r.box).take(names(r.path))
	return {}
})
ops.set("boxclose", (r) => {
	boxOf(r.box).close()
	return {}
})
const whys = new Map<string, string[]>()
ops.set("boxstart", (r) => {
	const told: string[] = []
	whys.set(r.name, told)
	const made = boxOf(r.box).start(() => {
		addTeardown((why) => {
			told.push(why)
			if (r.throws) throw new Error("teardown threw")
		})
	}, names(r.at))
	return "refused" in made ? { refused: made.refused } : {}
})
ops.set("boxwhy", (r) => ({ whys: whys.get(r.name) ?? [] }))
ops.set("look", (r, e) => {
	const places = placesOf(e, r.in)
	const id = get(places, names(r.path))
	if (id === undefined) return { there: false }
	const value = places.readValue("value", id)
	return value === undefined ? { there: true } : { there: true, value }
})
ops.set("names", (r, e) => ({ names: [...list(placesOf(e, r.in), names(r.path))].sort() }))

if (import.meta.main) serveErmine()
