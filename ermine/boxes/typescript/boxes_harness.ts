// boxes (boxes.ts) on the line protocol: one JSON request per line in, one answer per line out, in
// order. one world per run: a scheduler, a table, the host's places (root "R"). boxes by name. a
// folder a write made is answered as "new:<name>". path: a list of names; address: a string or a
// list of steps. the host writes with scope {"actor":"test"}. PlacesError: { error: code }
//
// world:
// { op: "root", name }                     → {}   a scope with no parent
// { op: "kids", id, value }                → {}   children entry replaced (a table event)
// { op: "saved", id }                      → { value? }   the children entry as the table has it
// { op: "place", at, name, id }            → {}   places' place, committed to the host's places
// boxes:
// { op: "create", name, at?, id?, parent? } → { root }   at an address (none: "/") or folder id, in
//    box parent (none: the host's)
// { op: "box", box, path, node }           → {}
// { op: "unbox", box, path }               → {}
// { op: "inside", address, from? }         → { path }
// { op: "write", box, path, name, id }     → {}   name placed in the folder at path, via the box
// { op: "start", box, path, id }           → {}   addProcess at the box's root, committed
// { op: "stop", box, path }                → {}   removeProcess at the box's root, committed
// { op: "rows", box }                      → { value? }   the process rows at the box's root
// reads, outside any run, in box (none: the host's); cached: through a path cache:
// { op: "get", box?, path, cached? }       → { id? }
// { op: "entries", box?, path, cached? }   → { entries }   each { id, from }
// { op: "list", box?, at, cached? }        → { names }
// { op: "members", box?, at, cached? }     → { members }   each { name, id?, from? }
// { op: "lookup", box?, names, from }      → { path? }
// computes:
// { op: "watch", name, scope, box?, cached?, f } → {}   a compute running f each run, compared as
//    JSON. f: {"get":path} {"entries":path} {"names":path} {"members":path}
//    {"lookup":[names,from]}, or a list of them
// { op: "pulse" }                          → {}
// { op: "state", name }                    → { runs, value }   runs so far; last result or null
import createEntry from "@ermine/core/node/entry"
import { type Computer, createScheduler, type Scope } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Key } from "@ermine/core/table"
import { createPlaces, type Id, type Path, place, PlacesError } from "@ermine/places"
import { createPathCache, type PathCache } from "@ermine/places/cache"
import { get, gets, list, lookup, members } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { addProcess, PROCESS, removeProcess } from "@ermine/processes"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { type Address, type Box, box, createBox, type Host, inside, unbox } from "./boxes.ts"

type Json = unknown

const s = createScheduler()
const table = createTable((part, id) => places.onTableChange(part as Key, id))
const paths = createPaths<unknown>()
const places = createPlaces({ root: "R", table, paths, scheduler: s })
s.onTrackingEnd((key) => places.release(key))
const host: Host = { places, table, scheduler: s }
const scope = s.createRootScope({ actor: "test" })
const hosted = <T>(f: () => T) => s.runWithScope(scope, f)
const header = () => createChangeHeader(s)

const scopes = new Map<string, Scope>()
const watched = new Map<string, { runs: number; value: Json }>()
const named = new Map<string, Box>()
const caches = new Map<Box, PathCache>()
// the ids writes made, by the name each was made at
const fresh = new Map<Id, string>()

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// the folders on the way from an id along names, through saved children, each one a write made
// (a fresh id) named by its name
function learn(from: Id, names: Path) {
	let at = from
	for (const name of names) {
		const v = table.get("children", at)?.value as Record<string, unknown> | undefined
		const id = v?.[name]
		if (typeof id !== "string") return
		if (UUID.test(id) && !fresh.has(id)) fresh.set(id, `new:${name}`)
		at = id
	}
}

// an answer as JSON, every fresh id as "new:<name>"
function plain(x: unknown): Json {
	return JSON.parse(
		JSON.stringify(
			x ?? null,
			(_, v) => typeof v === "string" && fresh.has(v) ? fresh.get(v) : v,
		),
	)
}

function boxOf(name: unknown): Box {
	const b = named.get(name as string)
	if (b === undefined) throw new Error(`no box ${name}`)
	return b
}

function kid(id: unknown) {
	const n = table.get("children", String(id))
	if (n === undefined) throw new PlacesError("nothing-there")
	return n
}

// the reads, in a box (none: the host's places), through its cache when cached
function reader(name: unknown, cached: unknown) {
	const b = name === undefined ? undefined : boxOf(name)
	const p = b?.places ?? places
	let c: PathCache | undefined
	if (cached && b !== undefined) {
		c = caches.get(b)
		if (c === undefined) caches.set(b, c = createPathCache({ places: b.places, scheduler: s }))
	}
	return {
		get: (path: Path) => c ? c.get(path) : get(p, path),
		entries: (path: Path) => c ? c.gets(path) : gets(p, path),
		names: (path: Path) => c ? [...c.list(path)] : [...list(p, path)],
		members: (path: Path) => c ? c.members(path) : members(p, path),
		lookup: (n: Path, from: Path) => lookup(p, n, from),
	}
}
type Reader = ReturnType<typeof reader>

function evaluate(r: Reader, e: Json): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map((x) => evaluate(r, x))
	const m = e as Request
	if ("get" in m) return plain(r.get(m.get))
	if ("entries" in m) return plain(r.entries(m.entries))
	if ("names" in m) return r.names(m.names)
	if ("members" in m) return plain(r.members(m.members))
	if ("lookup" in m) return r.lookup(m.lookup[0], m.lookup[1]) ?? null
	throw new Error("unknown program")
}

function answer(r: Request): Json {
	switch (r.op) {
		case "root":
			scopes.set(r.name, s.createRootScope(r.info))
			return {}
		case "kids":
			hosted(() => table.sub("children", r.id, createEntry(r.value, header())))
			return {}
		case "saved": {
			const v = table.get("children", r.id)?.value
			return v === undefined ? {} : { value: plain(v) }
		}
		case "place":
			hosted(() => places.commit(place(kid(r.at), r.name, r.id, header())))
			return {}
		case "create": {
			const parent = r.parent === undefined ? undefined : boxOf(r.parent)
			const at: Address = r.at ?? "/"
			const b = hosted(() => createBox(host, r.id !== undefined ? { id: r.id } : at, parent))
			if (r.id === undefined) learn(parent?.root ?? places.root, inside(at))
			named.set(r.name, b)
			return { root: plain(b.root) }
		}
		case "box": {
			const b = boxOf(r.box)
			hosted(() => box(b, r.path, r.node))
			learn(b.root, inside(r.path))
			return {}
		}
		case "unbox":
			hosted(() => unbox(boxOf(r.box), r.path))
			return {}
		case "inside":
			return { path: inside(r.address, r.from) }
		case "write": {
			const b = boxOf(r.box)
			const at = get(b.places, r.path)
			if (at === undefined) throw new PlacesError("nothing-there")
			hosted(() => b.places.commit(place(kid(at), r.name, r.id, header())))
			return {}
		}
		case "start":
			hosted(() => places.commit(addProcess(table, boxOf(r.box).root, r.path, r.id, header())))
			return {}
		case "stop":
			hosted(() => places.commit(removeProcess(table, boxOf(r.box).root, r.path, header())))
			return {}
		case "rows": {
			const v = table.get(PROCESS, boxOf(r.box).root)?.value
			return v === undefined ? {} : { value: plain(v) }
		}
		case "get": {
			const id = reader(r.box, r.cached).get(r.path)
			return id === undefined ? {} : { id: plain(id) }
		}
		case "entries":
			return { entries: plain(reader(r.box, r.cached).entries(r.path)) }
		case "list":
			return { names: reader(r.box, r.cached).names(r.at) }
		case "members":
			return { members: plain(reader(r.box, r.cached).members(r.at)) }
		case "lookup": {
			const path = reader(r.box, r.cached).lookup(r.names, r.from)
			return path === undefined ? {} : { path }
		}
		case "watch": {
			const o = scopes.get(r.scope)
			if (o === undefined) throw new Error(`no scope ${r.scope}`)
			const rd = reader(r.box, r.cached)
			const w = { runs: 0, value: null as Json }
			const c: Computer = s.runWithScope(o, () =>
				s.createComputer(
					() => (w.runs++, evaluate(rd, r.f)),
					(v) => void (w.value = v),
					json,
				))
			scopes.set(r.name, c)
			watched.set(r.name, w)
			return {}
		}
		case "pulse":
			s.pulse()
			return {}
		case "state": {
			const w = watched.get(r.name)
			if (w === undefined) throw new Error(`no compute ${r.name}`)
			return { runs: w.runs, value: w.value }
		}
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	await serve((r) => {
		try {
			return answer(r) as Record<string, unknown>
		} catch (e) {
			if (e instanceof PlacesError) return { error: e.code }
			throw e
		}
	})
}
