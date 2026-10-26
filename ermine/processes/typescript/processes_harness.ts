// processes (processes.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. one world per process: a scheduler, table, paths, and places (root "R",
// contributors [processes("R"), children]). ids are strings, a path a list of names. the host
// writes with its scope open, info {"actor":"test"}. a PlacesError answers { error: code }
//
// the world:
// { op: "root", name, info }               → {}   a scope with no parent, that info
// { op: "kids", id, value }                → {}   the children entry, replaced (a table event)
// { op: "place", at, name, id }            → {}   places' place, at the parent's id
// { op: "rename", at, name, to }           → {}
// { op: "start", path, id }                → {}   addProcess, said written
// { op: "stop", path }                     → {}   removeProcess, said written
// { op: "rows" }                           → { value? }   the root's process trie, as in the table
// { op: "patches" }                        → { patches? }   the trie's latest change's patches
// { op: "asked" }                          → { steps, names }   steps and names asked of the rows'
//    contributor since last asked (its level not counted)
// reads, outside any run (lib.ts):
// { op: "get", path }                      → { id? }
// { op: "entries", path }                  → { entries }   each { id, from }
// { op: "list", at }                       → { names }
// { op: "members", at }                    → { members }   each { name, id?, from } (level: no id)
// { op: "lookup", names, from }            → { path? }
// scope nodes (scopes.ts):
// { op: "scope", name, parent, info }      → {}   a scope under the named one, that info
// { op: "give", scope, id? }               → { id }   the scope's node id, made the first time
// { op: "write", id, part, value }         → {}   the entry, replaced (a table event)
// { op: "parts", id }                      → { parts }   the parts at the id, sorted
// { op: "teardown", scope }                → {}
// computes:
// { op: "watch", name, scope, f }          → {}   a compute in scope running f each run, results
//    compared as JSON. f: {"get":path} {"entries":path} {"names":path} {"members":path}
//    {"lookup":[names,from]}, or a list of them
// { op: "pulse" }                          → {}
// { op: "state", name }                    → { runs, value }   run count; last result (null: none)
import createEntry from "@ermine/core/node/entry"
import { type Computer, createScheduler, type Scope } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Key } from "@ermine/core/table"
import {
	children,
	type Contributor,
	createPlaces,
	place,
	PlacesError,
	rename,
} from "@ermine/core/places"
import { get, gets, list, lookup, members } from "@ermine/core/places/lib"
import { createChangeHeader } from "@ermine/core/places/header"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { addProcess, PROCESS, processes, removeProcess } from "./processes.ts"
import { createScopeNodes } from "./scopes.ts"

type Json = unknown

const s = createScheduler()
const table = createTable((part, id) => places.onTableChange(part as Key, id))
const paths = createPaths<unknown>()
// the rows' contributor, each ask counted
const asked = { steps: 0, names: 0 }
const rows = processes("R")
const counted: Contributor = {
	...rows,
	step: (here, name, r) => (asked.steps++, rows.step(here, name, r)),
	names: (here, r) => (asked.names++, rows.names(here, r)),
}
const places = createPlaces({
	root: "R",
	table,
	paths,
	scheduler: s,
	contributors: [counted, children],
})
s.onTrackingEnd((key) => places.release(key))
const host = s.createRootScope({ actor: "test" })
const nodes = createScopeNodes({ scheduler: s, table })
const hosted = <T>(f: () => T) => s.runWithScope(host, f)
const header = () => createChangeHeader(s)

const scopes = new Map<string, Scope>()
const watched = new Map<string, { runs: number; value: Json }>()

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const plain = (x: unknown): Json => JSON.parse(JSON.stringify(x ?? null))

function named(name: unknown): Scope {
	const o = scopes.get(name as string)
	if (o === undefined) throw new Error(`no scope ${name}`)
	return o
}
function kid(id: unknown) {
	const n = table.get("children", String(id))
	if (n === undefined) throw new PlacesError("nothing-there")
	return n
}

function evaluate(e: Json): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map(evaluate)
	const m = e as Request
	if ("get" in m) return get(places, m.get) ?? null
	if ("entries" in m) return plain(gets(places, m.entries))
	if ("names" in m) return [...list(places, m.names)]
	if ("members" in m) return plain(members(places, m.members))
	if ("lookup" in m) return lookup(places, m.lookup[0], m.lookup[1]) ?? null
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
		case "place":
			hosted(() => places.commit(place(kid(r.at), r.name, r.id, header())))
			return {}
		case "rename":
			hosted(() => places.commit(rename(kid(r.at), r.name, r.to, header())))
			return {}
		case "start":
			hosted(() => places.commit(addProcess(table, "R", r.path, r.id, header())))
			return {}
		case "stop":
			hosted(() => places.commit(removeProcess(table, "R", r.path, header())))
			return {}
		case "rows": {
			const v = table.get(PROCESS, "R")?.value
			return v === undefined ? {} : { value: v }
		}
		case "patches": {
			const p = table.get(PROCESS, "R")?.change.op?.patches
			return p === undefined ? {} : { patches: p }
		}
		case "asked": {
			const was = { ...asked }
			asked.steps = asked.names = 0
			return was
		}
		case "get": {
			const id = get(places, r.path)
			return id === undefined ? {} : { id }
		}
		case "entries":
			return { entries: plain(gets(places, r.path)) }
		case "list":
			return { names: [...list(places, r.at)] }
		case "members":
			return { members: plain(members(places, r.at)) }
		case "lookup": {
			const path = lookup(places, r.names, r.from)
			return path === undefined ? {} : { path }
		}
		case "watch": {
			const o = scopes.get(r.scope)
			if (o === undefined) throw new Error(`no scope ${r.scope}`)
			const w = { runs: 0, value: null as Json }
			const c: Computer = s.runWithScope(o, () =>
				s.createComputer(
					() => (w.runs++, evaluate(r.f)),
					(v) => void (w.value = v),
					json,
				))
			scopes.set(r.name, c)
			watched.set(r.name, w)
			return {}
		}
		case "scope": {
			const up = scopes.get(r.parent)
			if (up === undefined) throw new Error(`no scope ${r.parent}`)
			scopes.set(r.name, s.createScope(r.info, up))
			return {}
		}
		case "give":
			return { id: nodes.give(named(r.scope), r.id) }
		case "write":
			hosted(() => table.sub(r.part, r.id, createEntry(r.value, header())))
			return {}
		case "parts":
			return { parts: [...table.get(r.id)].map(([part]) => part).sort() }
		case "teardown":
			s.teardown(named(r.scope))
			return {}
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
