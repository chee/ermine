// The reference link (ermine/link/typescript/link.ts) on the line protocol: one JSON request per
// line in, one answer per line out, in order. State lasts for the process: the world of world.ts,
// the computes made by name. Another implementation joins by speaking this (HARNESS). The
// world's requests (the table, the writes, the scheduler) are in world.ts; these are the link's
// own, with the programs.
//
// reads, outside any run (told to no one):
// { op: "read", part, id, path? }           → { value? }
// { op: "change", part, id }                → { patches? }   the patches of its latest edit
// { op: "get", address, from? }             → { items }   "source:id", front first
// { op: "names", at }                       → { names }
// { op: "at", value, path }                 → { value? }   link's at
// { op: "watch", name, scope, f }           → {}   a compute made with scope open, running the
//    program f each run, its results (compared as JSON) kept (world: state)
// { op: "open", name, address }             → {}   an opened place, opened outside a run
// { op: "close", name }                     → {}   its drop
// spots:
// { op: "reads", name }                     → { reads }   the reads of the latest ended run of the
//    compute named, in order, each as link's spot named it as the run ended: { part, id, path }
//    (path null: the change spot), null: not one of link's spots; no run ended: []
// { op: "spot", key }                       → { spot? }   link's spot of a string key
//
// a program e: a number, string, boolean or null is itself; a list, its members evaluated; a map
// is one of, or one of the world's plain forms (world.ts, basic):
//   {"read":[part,id,path?]}          the value, or null (the path's steps evaluated)
//   {"change":[part,id]}              the patches of its latest edit, or null
//   {"values":[name..]}               the value part of each item
//   {"get":[name..]}   {"get":[name..],"from":[source,id]}    "source:id" of each item, a list
//   {"names":[source,id]}   {"level":[source,id]}             the names; every item at a level
//   {"items":h}   {"kept":h}          the items, the members, of the opened place h
//   {"write":request}                 the write request, made with the run's scope open (by the
//                                     run); null. {"eval":e} anywhere in it is e evaluated
import type { Key as Step } from "@ermine/op/apply"
import type { Computation } from "@ermine/scheduler"
import type { Key } from "@ermine/graph/table"
import { at } from "@ermine/link"
import {
	answered,
	basic,
	enroll,
	entry,
	fill,
	item,
	json,
	l,
	places,
	s,
	scope,
	spotted,
	where,
	write,
} from "./world.ts"
import { revive } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

type Json = unknown

const held = new Map<string, ReturnType<typeof places.open>>()

const patchesOf = (part: Key, id: string) => l.change(part, id)?.op?.patches

function evaluate(e: Json): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map(evaluate)
	const m = e as Request
	if ("read" in m) {
		const [part, id, path] = m.read
		return l.get(part, id, path && (evaluate(path) as Step[])) ?? null
	}
	if ("change" in m) return patchesOf(...m.change as [Key, string]) ?? null
	if ("get" in m) return places.get(m.get, m.from && entry(m.from)).map(item)
	if ("values" in m) {
		return places.get(m.values).map((i) => l.get("value", i.id) ?? null)
	}
	if ("names" in m) return places.names(entry(m.names))
	if ("level" in m) return places.members(entry(m.level)).map(item)
	if ("items" in m) return held.get(m.items)!.items().map(item)
	if ("kept" in m) return held.get(m.kept)!.members().map(item)
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
			const v = l.get(r.part as Key, r.id, r.path)
			return v === undefined ? {} : { value: v }
		}
		case "change": {
			const patches = patchesOf(r.part, r.id)
			return patches === undefined ? {} : { patches }
		}
		case "get":
			return { items: places.get(r.address, r.from && entry(r.from)).map(item) }
		case "names":
			return { names: places.names(entry(r.at)) }
		case "watch": {
			const w = { runs: 0, value: null as Json }
			const c: Computation = s.run(scope(r.scope), () =>
				s.compute(
					() => (w.runs++, evaluate(r.f)),
					(v) => void (w.value = v),
					json,
				))
			enroll(r.name, c, w)
			return {}
		}
		case "open":
			held.set(r.name, places.open(r.address))
			return {}
		case "close":
			held.get(r.name)!.drop()
			return {}
		case "reads":
			return { reads: spotted.get(scope(r.name)) ?? [] }
		case "spot": {
			const w = l.spot(r.key)
			return w === undefined ? {} : { spot: where(w) }
		}
	}
}

if (import.meta.main) await serve((r) => answered(answer, r))
