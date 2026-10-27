// world harness: the world the places and guard harnesses share, made as a composer makes it: one
// scheduler, table and paths, and places (root "R"). the harnesses add their own requests
// (places_harness.ts, guard_harness.ts) and speak the line protocol through serve
// (conformance/typescript/harness.ts).
//
// id: a string. part: any string ("children" is the filesystem's). path: a list of names. value:
// plain JSON. patch: { path, range?, value?, move?: { path, range? } }. info: an object.
// every write below is the host's, from outside, info {"actor":"test"}.
//
// { op: "kids", id, value }                  → {}   the children entry replaced (a table event)
// { op: "value", id, value }                 → {}   the value entry replaced
// { op: "share", value, keys: [[part, id]..] } → {}   one entry under all those keys (table.add)
// { op: "del", part, id }                    → {} | { error: "nothing-there" }   table.del
// { op: "node", part, id }                   → { value? }   the table's, told to no one
// { op: "namesOf", id }                      → { names }   places' namesOf: each { folder, name }
// { op: "held" }                             → { keys, spots, steps }   what paths holds
// { op: "cache" }                            → {}   the path cache made once (or by the first
//    program asking for it); make it before anything reads
// { op: "cacheKept" }                        → { entries, reads }   none made: both 0
// { op: "cacheStop" }                        → {}   the path cache stopped (stop), none made after
//    till asked again
// writes; a PlacesError or ApplyError → { error: code }, an ApplyError also { patch: index }:
// { op: "edit", part, id, patches }          → {}   none there: an entry made with them
// { op: "place", at, name, id }              → {}   at: the parent's id
// { op: "unplace", at, name }                → {}
// { op: "rename", at, name, to }             → {}
// { op: "move", at, name, to: { at, name } } → {}
// { op: "upsert", part, id, path, value }    → {}   upsert.ts; the same value there: no write
// { op: "getOrSet", part, id, path, value }  → { value }   the value at path, else value put there
// { op: "peep", request }                    → request's answer, made under places.peep: its reads tell no one
// status (status.ts):
// { op: "status" }                           → {}   the status listener, made once
// { op: "give", name, id }                   → {}   compute name's status written on node id
// { op: "statusOf", id }                     → { status }   read outside a run:
//    "pending" | { error } | null
// the scheduler:
// { op: "root", name, info? }                → {}   a scope with no parent
// { op: "scope", name, parent, info? }        → {}
//    a "node" key in info: a header's metadata stops after that scope's info
// { op: "dispose", name }                    → {}
// { op: "pulse" }                            → {}
// { op: "state", name }                      → { runs, value }   a watch's run count, last result
// { op: "moments" }                          → { moments }   since last asked, computes by name
// { op: "header", scope?, extra? }           → { actor, reader?, metadata?, timely, sites }
//    the header places makes with scope open, extra its own info; timely: time is now (whole
//    seconds); sites: its external's count. nothing open: { error: "unscoped" }
// { op: "watchPath", name, path, part?, at?, sites? }  → {}   watched: each fact { part, id, patches,
//    actor? }; sites: true adds sites, the count of its change's external (0: no change)
// anything not understood: { error: text }
import createEntry, { type ChangeHeader } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import { ApplyError, type Patch } from "@ermine/core/changeable/apply"
import { type Computer, createScheduler, type Info, type Scope } from "@ermine/core/scheduler"
import { type Told, trace } from "@ermine/core/scheduler/trace"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createPlaces, move, place, PlacesError, rename, unplace, type Where } from "./places.ts"

import type { Answer, Request } from "../../../conformance/typescript/harness.ts"
import { createChangeHeader } from "./header.ts"
import { getOrSet, upsert } from "./upsert.ts"
import { createStatus, PENDING, status } from "./status.ts"
import { createPathCache, type PathCache } from "./cache.ts"
import { frames } from "@ermine/core/util/stacktrace"
type Json = unknown

let moments: Told[] = []
export const scopes = new Map<string, Scope>()
const watches = new Map<string, { told: Json[]; stop: () => void }>()
export const names = new Map<Scope, string>()
const nameOf = (c: Scope) => names.get(c)!

// each computation's latest ended run's reads, in order, as places' spot named each as the run
// ended: where it reads, null: not one of places' spots
export const spotted = new Map<Scope, Json[]>()
export const where = (w: Where | undefined): Json =>
	w === undefined ? null : { part: w.part, id: w.id, path: w.path }

export const s = createScheduler()
trace(s, (m) => {
	moments.push(m)
	if ("ends" in m) spotted.set(m.ends, m.reads.map((k) => where(places.describe(k))))
})
s.onTrackingEnd((key) => places.release(key))
export const table = createTable((part, id) => places.onTableChange(part as Key, id))
export const paths = createPaths<unknown>()
export const places = createPlaces({ root: "R", table, paths, scheduler: s })
export const host = s.createRootScope({ actor: "test" })
// this harness's own line, as the C one's CH_HERE: a write in a run's site (header.ts captures
// none in a run)
const HERE = frames(new Error().stack ?? "")[0]
// a write's header, made now
export const header = (extra?: Info) =>
	createChangeHeader(s, extra, undefined, undefined, s.getRun() === undefined ? undefined : HERE)

// the moments, computations by name
function moment(m: Told): Json {
	if ("due" in m) {
		return m.by
			? { due: nameOf(m.due), tick: m.tick, writer: nameOf(m.by) }
			: { due: nameOf(m.due), tick: m.tick }
	}
	if ("starts" in m) return { starts: nameOf(m.starts), run: m.run, rank: m.rank }
	if ("acts" in m) {
		const out: Record<string, Json> = { acts: nameOf(m.acts), run: m.run }
		if ("error" in m) out.error = String(m.error)
		return out
	}
	const out: Record<string, Json> = { ends: nameOf(m.ends), run: m.run, ended: m.ended }
	if (m.equal !== undefined) out.equal = m.equal
	if ("error" in m) out.error = errorOf(m.error)
	if (m.waits) out.waits = nameOf(m.waits)
	if (m.through) out.through = m.through.map(nameOf)
	return out
}

const errorOf = (e: unknown): string =>
	typeof e === "object" && e !== null && "code" in e
		? String((e as { code: unknown }).code)
		: e instanceof Error
		? e.message
		: String(e)

// the computes made by a harness's watch, by name
export const watched = new Map<string, { runs: number; value: Json }>()
// a compute made by a harness's watch: named, and its state kept
export function enroll(name: string, c: Computer, w: { runs: number; value: Json }) {
	watched.set(name, w)
	scopes.set(name, c)
	names.set(c, name)
}
export function scope(name: unknown): Scope {
	const o = scopes.get(name as string)
	if (o === undefined) throw new Error(`no scope ${name}`)
	return o
}

export const id = (x: unknown): Id => {
	if (typeof x !== "string") throw new Error("id: not a string")
	return x
}

// a change, summed up
export function summary(change: ChangeHeader): Json {
	const { actor, reader, metadata, time, external } = change
	return {
		actor,
		...(reader !== undefined && { reader }),
		...(metadata !== undefined && { metadata }),
		timely: Number.isInteger(time) && Math.abs(time - Date.now() / 1000) < 5,
		sites: external?.length ?? 0,
	}
}

// a value write: the patches to the entry there, then said written; none there: an entry made
// with them, then added (a table event)
export function edit(part: Key, id: Id, patches: Patch[]) {
	const h = header()
	const there = table.get(part, id)
	if (there === undefined) {
		const node = createEntry<unknown>(undefined, h)
		update(node, patches, h)
		table.add(part, id, node)
		return node
	}
	update(there, patches, h)
	places.commit([there])
	return there
}

// the path cache, once it is asked for
let cache: PathCache | undefined
export const cached = () => cache ??= createPathCache({ places, scheduler: s })

// the status listener, once it is asked for
let statuses: ReturnType<typeof createStatus> | undefined

// a status, as the requests tell it: "pending", { error: message }, or null
export const statusJson = (v: unknown): Json =>
	v === PENDING ? "pending" : v instanceof Error ? { error: v.message } : null

// a write request, with the scope open as it is
export function write(r: Request): void {
	// a parent's children entry; none: nothing-there, the world's answer
	const at = (x: unknown) => {
		const n = table.get("children", id(x))
		if (n === undefined) throw new PlacesError("nothing-there")
		return n
	}
	const h = () => header()
	switch (r.op) {
		case "edit":
			edit(r.part, r.id, r.patches as Patch[])
			return
		case "upsert":
			places.commit(
				upsert(table, r.part, id(r.id), r.path as string[], r.value, h()),
			)
			return
		case "place":
			places.commit(place(at(r.at), r.name, id(r.id), h()))
			return
		case "unplace":
			places.commit(unplace(at(r.at), r.name, h()))
			return
		case "rename":
			places.commit(rename(at(r.at), r.name, r.to, h()))
			return
		case "move":
			places.commit(move([at(r.at), r.name], [at(r.to.at), r.to.name], h()))
			return
	}
	throw new Error(`unknown write ${r.op}`)
}

// a request with {"eval": e} anywhere in it replaced by e evaluated
export function fill(x: Json, ev: (e: Json) => Json): Json {
	if (Array.isArray(x)) return x.map((y) => fill(y, ev))
	if (x === null || typeof x !== "object") return x
	const keys = Object.keys(x)
	if (keys.length === 1 && keys[0] === "eval") return ev((x as Request).eval)
	return Object.fromEntries(keys.map((k) => [k, fill((x as Request)[k], ev)]))
}

export const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// the programs' plain forms, shared by the harnesses; undefined: not one of them
//   {"cat":[e..]} the strings joined   {"join":e} a list joined with ","   {"count":e} its length
//   {"add":[a,b]} {"lt":[a,b]} {"if":[t,a,b]} {"do":[e..]} (the last)   {"quote":x}
//   {"within":[info,e]}  e with a scope of that info open, made under the one open
//   {"header":null}       the header of a write made now, summed up (as the header request)
export function basic(m: Request, ev: (e: Json) => Json): Json | undefined {
	if ("cat" in m) return (ev(m.cat) as unknown[]).join("")
	if ("join" in m) return (ev(m.join) as unknown[]).join(",")
	if ("count" in m) return (ev(m.count) as unknown[]).length
	if ("add" in m) return (ev(m.add[0]) as number) + (ev(m.add[1]) as number)
	if ("lt" in m) return (ev(m.lt[0]) as number) < (ev(m.lt[1]) as number)
	if ("if" in m) return ev(m.if[0]) ? ev(m.if[1]) : ev(m.if[2])
	if ("do" in m) return (m.do as Json[]).reduce<Json>((_, x) => ev(x), null)
	if ("quote" in m) return m.quote
	if ("within" in m) {
		return s.runWithScope(s.createScope(m.within[0] as Info), () => ev(m.within[1]))
	}
	if ("header" in m) return summary(header())
}

// the world's requests; undefined: not one of them
export function worldAnswer(r: Request): Json | undefined {
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	switch (r.op) {
		case "kids":
			hosted(() => table.sub("children", r.id, createEntry(r.value, header())))
			return {}
		case "value":
			hosted(() => table.sub("value", r.id, createEntry<unknown>(r.value, header())))
			return {}
		case "share": {
			hosted(() => {
				const node = createEntry<unknown>(r.value, header())
				for (const [part, id] of r.keys) table.add(part, id, node)
			})
			return {}
		}
		case "del":
			hosted(() => table.del(r.part, r.id))
			return {}
		case "node": {
			const n = table.get(r.part, r.id)
			return n === undefined || n.value === undefined ? {} : { value: n.value }
		}
		case "namesOf":
			return { names: places.namesOf(r.id).map((n) => ({ folder: n.folder, name: n.name })) }
		case "held":
			return paths.held()
		case "cache":
			cached()
			return {}
		case "cacheKept":
			return cache?.kept() ?? { entries: 0, reads: 0 }
		case "cacheStop":
			cache?.stop()
			cache = undefined
			return {}
		case "watchPath": {
			const told: Json[] = []
			const stop = places.watchPath(r.path, (f) => {
				const fact: Record<string, Json> = { part: f.part, id: f.id, patches: f.patches }
				if (f.change !== undefined) fact.actor = f.change.actor
				if (r.sites === true) fact.sites = f.change?.external?.length ?? 0
				told.push(fact)
			}, { part: r.part, at: r.at })
			watches.set(r.name, { told, stop })
			return {}
		}
		case "watched": {
			const w = watches.get(r.name)
			if (!w) throw new Error(`no watch ${r.name}`)
			const facts = w.told.splice(0)
			return { facts }
		}
		case "unwatch":
			watches.get(r.name)?.stop()
			watches.delete(r.name)
			return {}
		case "edit":
		case "upsert":
		case "place":
		case "unplace":
		case "rename":
		case "move":
			hosted(() => write(r))
			return {}
		case "getOrSet":
			return {
				value: hosted(() => {
					const got = getOrSet(
						table,
						r.part,
						id(r.id),
						r.path as string[],
						() => r.value,
						header(),
					)
					places.commit(got.changed)
					return got.value
				}),
			}
		case "status":
			statuses ??= createStatus({ places, table, scheduler: s })
			return {}
		case "give":
			if (statuses === undefined) throw new Error("no status")
			statuses.give(scope(r.name) as Computer, id(r.id))
			return {}
		case "statusOf":
			return { status: statusJson(status(places, id(r.id))) }
		case "root":
		case "scope": {
			const o = r.op === "root"
				? s.createRootScope(r.info)
				: s.createScope(r.info, scope(r.parent))
			scopes.set(r.name, o)
			names.set(o, r.name)
			return {}
		}
		case "dispose":
			s.teardown(scope(r.name))
			return {}
		case "pulse":
			s.pulse()
			return {}
		case "state": {
			const w = watched.get(r.name)!
			return { runs: w.runs, value: w.value }
		}
		case "moments": {
			const out = moments.map(moment)
			moments = []
			return { moments: out }
		}
		case "header": {
			const made = () => summary(header(r.extra))
			return r.scope === undefined ? made() : s.runWithScope(scope(r.scope), made)
		}
	}
}

// a harness's answer to a request, else the world's. the errors that are codes answer as such
export function answered(own: (r: Request) => Json | undefined, r: Request): Answer {
	try {
		if (r.op === "peep") return places.peep(() => answered(own, r.request))
		const a = own(r) ?? worldAnswer(r)
		if (a === undefined) throw new Error(`unknown op ${r.op}`)
		return a as Answer
	} catch (e) {
		if (e instanceof PlacesError) return { error: e.code }
		if (e instanceof ApplyError) return { error: e.code, patch: e.patch }
		if (typeof e === "object" && e !== null && "code" in e) {
			return { error: String((e as { code: unknown }).code) }
		}
		if (e instanceof Error) return { error: e.message }
		throw e
	}
}
