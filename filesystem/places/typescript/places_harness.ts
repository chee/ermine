// The reference places (filesystem/places/typescript/places.ts) on the line protocol: one JSON
// request per line in, one answer per line out, in order. State lasts for the process: the world of
// world.ts, the computes made by name. Another implementation joins by speaking this (HARNESS). The
// world's requests (the table, the writes, the scheduler) are in world.ts; these are places' own,
// with the programs. a path is a list of names from the root "R".
//
// reads, outside any run (told to no one):
// { op: "read", part, id, path? }           → { value? }
// { op: "change", part, id }                → { patches? }   the patches of its latest edit
// { op: "get", path }                       → { id? }   the id there; none: no id
// { op: "list", at }                        → { names }
// { op: "lookup", names, from, all? }       → { path? } | { paths }
// { op: "at", value, path }                 → { value? }   places' at
// the path cache (world.ts: cache), outside any run, so an entry made goes at once unless a run
// tracks it:
// { op: "cached", path }                    → { id? }   the cache's get
// { op: "cachedList", at }                  → { names }   the cache's list
// { op: "watch", name, scope, f }           → {}   a compute made with scope open, running the
//    program f each run, its results (compared as JSON) kept (world: state)
// watching a path (world.ts):
// { op: "watchPath", name, path, part?, at? } → {}   places' watchPath, what it is told kept
// { op: "watched", name }                   → { facts }   told since last asked, in order:
//    { part, id, patches, actor? }
// { op: "unwatch", name }                   → {}   stopped
// spots:
// { op: "reads", name }                     → { reads }   the reads of the latest ended run of the
//    compute named, in order, each as places' spot named it as the run ended: { part, id, path }
//    (path null: the change spot), null: not one of places' spots; no run ended: []
// { op: "spot", key }                       → { spot? }   places' spot of a string key
//
// a program e: a number, string, boolean or null is itself; a list, its members evaluated; a map
// is one of, or one of the world's plain forms (world.ts, basic):
//   {"read":[part,id,path?]}          the value, or null (the path's steps evaluated)
//   {"change":[part,id]}              the patches of its latest edit, or null
//   {"get":path}                      the id there, or null
//   {"values":path}                   the value part of the id there, or null
//   {"names":path}                    the names there
//   {"cached":path}                   the cache's get: the id there, or null
//   {"cachedNames":path}              the cache's list: the names there
//   {"cachedEntries":path}            the cache's entries: each { id, from }
//   {"cachedMembers":path}            the cache's members: each { name, id, from? }
//   {"level":path}                    the ids of the members there
//   {"lookup":[names,from]}           the path of the nearest, or null; "all": true, every path
//   {"status":id}                     the id's status as statusOf tells it ("pending", { error }, or
//                                     null), the read told (so a reader of it reruns)
//   {"wait":null}                     the scheduler's PENDING: the run is pending
//   {"throw":message}                 an error thrown by the run
//   {"write":request}                 the write request, made with the run's scope open (by the
//                                     run); null. {"eval":e} anywhere in it is e evaluated
import type { Key as Step } from "@ermine/op/apply"
import { type Computer, PENDING } from "@ermine/scheduler"
import type { Key } from "@ermine/table"
import { at } from "./places.ts"
import {
	answered,
	basic,
	cached,
	enroll,
	fill,
	json,
	places,
	s,
	scope,
	spotted,
	statusJson,
	where,
	write,
} from "./world.ts"
import { status } from "./status.ts"
import { revive } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { get, list, lookup, members } from "./lib.ts"

type Json = unknown

const patchesOf = (part: Key, id: string) => places.readChange(part, id)?.op?.patches

const ids = (ms: { id: unknown }[]) => ms.map((m) => String(m.id))

function evaluate(e: Json): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map(evaluate)
	const m = e as Request
	if ("read" in m) {
		const [part, id, path] = m.read
		return places.readValue(part, id, path && (evaluate(path) as Step[])) ?? null
	}
	if ("change" in m) return patchesOf(...m.change as [Key, string]) ?? null
	if ("get" in m) return get(places, m.get) ?? null
	if ("values" in m) {
		const id = get(places, m.values)
		return id === undefined ? null : places.readValue("value", id) ?? null
	}
	if ("names" in m) return [...list(places, m.names)]
	if ("level" in m) return ids(members(places, m.level))
	if ("cached" in m) return cached().get(m.cached) ?? null
	if ("cachedNames" in m) return [...cached().list(m.cachedNames)]
	if ("cachedEntries" in m) return JSON.parse(JSON.stringify(cached().gets(m.cachedEntries)))
	if ("cachedMembers" in m) return JSON.parse(JSON.stringify(cached().members(m.cachedMembers)))
	if ("lookup" in m) {
		const [names, from] = m.lookup
		return m.all === true
			? lookup(places, names, from, true)
			: lookup(places, names, from) ?? null
	}
	if ("status" in m) return statusJson(status(places, m.status))
	if ("wait" in m) return PENDING
	if ("throw" in m) throw new Error(m.throw)
	if ("write" in m) {
		write(fill(m.write, evaluate) as Request)
		return null
	}
	const plain = basic(m, evaluate)
	if (plain !== undefined) return plain
	throw new Error("unknown program")
}

function answer(r: Request): Json | undefined {
	switch (r.op) {
		case "at": {
			const v = at(revive(r.value), r.path)
			return v === undefined ? {} : { value: v }
		}
		case "read": {
			const v = places.readValue(r.part as Key, r.id, r.path)
			return v === undefined ? {} : { value: v }
		}
		case "change": {
			const patches = patchesOf(r.part, r.id)
			return patches === undefined ? {} : { patches }
		}
		case "get": {
			const id = get(places, r.path)
			return id === undefined ? {} : { id }
		}
		case "list":
			return { names: [...list(places, r.at)] }
		case "cached": {
			const id = cached().get(r.path)
			return id === undefined ? {} : { id }
		}
		case "cachedList":
			return { names: [...cached().list(r.at)] }
		case "lookup": {
			if (r.all === true) return { paths: lookup(places, r.names, r.from, true) }
			const path = lookup(places, r.names, r.from)
			return path === undefined ? {} : { path }
		}
		case "watch": {
			const w = { runs: 0, value: null as Json }
			const c: Computer = s.runWithScope(scope(r.scope), () =>
				s.createComputer(
					() => (w.runs++, evaluate(r.f)),
					(v) => void (w.value = v),
					json,
				))
			enroll(r.name, c, w)
			return {}
		}
		case "reads":
			return { reads: spotted.get(scope(r.name)) ?? [] }
		case "spot": {
			const w = places.describe(r.key)
			return w === undefined ? {} : { spot: where(w) }
		}
	}
}

if (import.meta.main) await serve((r) => answered(answer, r))
