// build (build.ts) on the line protocol: one JSON request per line in, one answer per line out, in
// order. its own world, lasting for the process: a scheduler, a table, paths and the host's places
// (root "R", children alone), told the table's events. the host writes with its scope open, its info
// [["actor","test"]]; builds are made with it open too
//
// the compilers, by name, each counting its calls:
//   upper  a string uppercased            wrap  { wasm: input }
//   slow   the input, once settled         boom  throws Error("boom")
//   live   a function: no encoding
//
// the world:
// { op: "kids", id, value }                 → {}   the children entry there, replaced (a table event)
// { op: "attrs", id, value }                → {}   the attributes entry there, replaced (a table event)
// { op: "value", id, value }                → {}   the value entry there, replaced (a table event)
// { op: "compiler", id, compiler }          → {}   the value entry there: the compiler named (a live
//    function, never saved)
// { op: "upsert", part, id, path, value }   → {}   value put at path in the entry (places' upsert):
//    a patch, telling only the reads it touches
// build:
// { op: "builds", cache }                   → {}   a fresh createBuilds over the same table, the
//    cache folder the id cache; every watch of the last one torn down first, then it stopped
// { op: "watch", name, compilers, input?, node? } → {}   a computer, in a scope of its own, named:
//    each run, the input (given, or node's value, read) through each compiler in turn, each
//    output the next's input; PENDING or an Error stops there
// { op: "stop", name }                      → {}   that scope torn down
// { op: "pulse" }                           → {}
// { op: "settle", fail? }                   → {}   every slow call waiting resolved (fail: rejected
//    with Error(fail)), the promises left to land, then a pulse
// { op: "state", name }                     → { value }   its last result: the output, "pending",
//    { refused: code } (a BuildError), or { failed: message } (any other Error)
// { op: "runs", name }                      → { runs }    how many times it has run
// { op: "calls" }                           → { upper, wrap, slow, boom, live }
// { op: "cache" }                           → { size, entries }   the cache folder: each name (a
//    key) and its node's value
// { op: "kinds" }                           → { types }   each name in the cache folder and its node's
//    ermine.type (null: none)
import createEntry from "@ermine/node/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { createPlaces, PlacesError } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import type { Value } from "@ermine/encoding/cbor"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { BuildError, type Builds, type Compiler, createBuilds } from "./build.ts"

type Json = unknown

const s = createScheduler()
const table = createTable((part, id) => places.onTableChange(part as Key, id))
const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
s.onTrackingEnd((key) => places.release(key))
const host = s.createRootScope([["actor", "test"]])
const hosted = <T>(f: () => T) => s.runWithScope(host, f)
const header = () => createChangeHeader(s)

// the compilers, and their calls
const calls: Record<string, number> = { upper: 0, wrap: 0, slow: 0, boom: 0, live: 0 }
const waiting: { resolve: () => void; reject: (e: Error) => void }[] = []
const compilers: Record<string, Compiler> = {
	upper: (input) => (calls.upper++, (input as string).toUpperCase()),
	wrap: (input) => (calls.wrap++, { wasm: input }),
	slow: (input) => {
		calls.slow++
		return new Promise<Value>((resolve, reject) =>
			waiting.push({ resolve: () => resolve(input), reject })
		)
	},
	boom: () => {
		calls.boom++
		throw new Error("boom")
	},
	live: () => (calls.live++, (() => {}) as never),
}

let builds: Builds | undefined
let cache: Id | undefined
let made: Scope[] = []
const scopes = new Map<string, Scope>()
const watched = new Map<string, { runs: number; value: unknown }>()

// a result as JSON
function shown(v: unknown): Json {
	if (v === PENDING) return "pending"
	if (v instanceof BuildError) return { refused: v.code }
	if (v instanceof Error) return { failed: v.message }
	return v ?? null
}

const settled = () => new Promise((r) => setTimeout(r, 0))

function watchOf(name: string) {
	const w = watched.get(name)
	if (w === undefined) throw new Error(`no watch ${name}`)
	return w
}

async function answer(r: Request): Promise<Json> {
	switch (r.op) {
		case "kids":
			hosted(() => table.sub("children", r.id, createEntry(r.value, header())))
			return {}
		case "attrs":
			hosted(() => table.sub("attributes", r.id, createEntry(r.value, header())))
			return {}
		case "value":
			hosted(() => table.sub("value", r.id, createEntry(r.value, header())))
			return {}
		case "compiler": {
			const f = compilers[r.compiler]
			if (f === undefined) throw new Error(`no compiler ${r.compiler}`)
			hosted(() => table.sub("value", r.id, createEntry(f, header())))
			return {}
		}
		case "upsert":
			hosted(() => places.commit(upsert(table, r.part, r.id, r.path, r.value, header())))
			return {}
		case "builds": {
			for (const o of made) if (o.state === "alive") s.teardown(o)
			made = []
			builds?.stop()
			cache = r.cache
			builds = hosted(() => createBuilds({ scheduler: s, table, places, cache: r.cache }))
			return {}
		}
		case "watch": {
			const b = builds
			if (b === undefined) throw new Error("no builds")
			const o = s.createScope([], host)
			made.push(o)
			scopes.set(r.name, o)
			const w = { runs: 0, value: undefined as unknown }
			watched.set(r.name, w)
			s.runWithScope(o, () =>
				s.createComputer(() => {
					w.runs++
					let v = r.node === undefined ? r.input : places.readValue("value", r.node)
					for (const c of r.compilers as Id[]) {
						v = b.compile(c, v)
						if (v === PENDING || v instanceof Error) break
					}
					return { v }
				}, ({ v }) => void (w.value = v)))
			return {}
		}
		case "stop": {
			const o = scopes.get(r.name)
			if (o === undefined) throw new Error(`no watch ${r.name}`)
			s.teardown(o)
			return {}
		}
		case "pulse":
			s.pulse()
			return {}
		case "settle": {
			for (const w of waiting.splice(0)) {
				if (r.fail === undefined) w.resolve()
				else w.reject(new Error(r.fail))
			}
			await settled()
			s.pulse()
			return {}
		}
		case "state": {
			const w = watchOf(r.name)
			return { value: w.runs === 0 ? "pending" : shown(w.value) }
		}
		case "runs":
			return { runs: watchOf(r.name).runs }
		case "calls":
			return { ...calls }
		case "cache": {
			if (cache === undefined) throw new Error("no builds")
			const v = table.get("children", cache)?.value as Record<string, Id> | undefined
			const entries: Record<string, Json> = {}
			for (const [k, n] of Object.entries(v ?? {})) entries[k] = table.get("value", n)?.value
			return { size: Object.keys(entries).length, entries }
		}
		case "kinds": {
			if (cache === undefined) throw new Error("no builds")
			const v = table.get("children", cache)?.value as Record<string, Id> | undefined
			const types: Record<string, Json> = {}
			for (const [k, n] of Object.entries(v ?? {})) {
				types[k] = (table.get("attributes", n)?.value as Record<string, Json> | undefined)
					?.["ermine.type"] ?? null
			}
			return { types }
		}
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	await serve(async (r) => {
		try {
			return await answer(r) as Record<string, unknown>
		} catch (e) {
			if (e instanceof PlacesError) return { error: e.code }
			throw e
		}
	})
}
