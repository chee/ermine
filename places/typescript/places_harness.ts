// The reference places on the line protocol (world: world_harness.ts). A path is names from "R".
// Reads outside any run are told to no one.
// { op: "read", part, id, path? }           → { value? }
// { op: "change", part, id }                → { patches? }   of its latest edit
// { op: "get", path }                       → { id? }
// { op: "list", at }                        → { names }
// { op: "lookup", names, from, all? }       → { path? } | { paths }
// { op: "at", value, path }                 → { value? }
// { op: "watch", name, scope, f }           → {}   a compute running program f
// { op: "watchAll", name, id?, part? }     → {}   places' watchAll, for that id and part
// { op: "watched", name }                   → { facts }   since last asked: { part, id, patches, actor? }
// { op: "unwatch", name }                   → {}
// { op: "reads", name }                     → { reads }   the latest ended run's, as { part, id, path }
//                                                         (path null: change spot), null: not a spot
// { op: "spot", key }                       → { spot? }
// { op: "mark", keys }                      → {}   keys (as track's) marked from outside
// { op: "rows", of? }                       → {}   reads go through a view of "R" with [rows, children]
//    rows: a trie on value entry "rows"; of: ids of value entries, each a trie, asked in order
// { op: "asked" }                           → { steps, names }   rows' asks since last asked
//
// program e: a scalar is itself; a list, its members evaluated; a map, a plain form or one of:
//   {"read":[part,id,path?]}    the value or null
//   {"change":[part,id]}        its latest edit's patches or null
//   {"get":path}                the id there or null
//   {"values":path}             the value part of the id there or null
//   {"names":path}              the names there
//   {"level":path}              the member ids there
//   {"lookup":[names,from]}     the nearest path or null; "all": true, every path
//   {"wait":null}               the scheduler's PENDING
//   {"track":name}              a key of its own per name, tracked; null
//   {"throw":message}           throws
//   {"write":request}           the request, made with the run's scope open; null

import type { Key as Step } from "@ermine/changeable/apply"
import { type Computer, PENDING } from "@ermine/reactivity"
import type { Key } from "@ermine/graph/table"
import { asId, at, children, type Contributor, none, type Places } from "./places.ts"
import {
	answered,
	basic,
	enroll,
	fill,
	json,
	places,
	s,
	scope,
	spotted,
	table,
	where,
	write,
} from "./world_harness.ts"
import { revive } from "../../conformance/typescript/form.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { get, list, lookup, members } from "./lib.ts"

type Json = unknown

const patchesOf = (part: Key, id: string) => places.readChange(part, id)?.op?.patches

const ids = (ms: { id: unknown }[]) => ms.map((m) => String(m.id))

const keys = new Map<string, { name: string }>()
const keyOf = (name: string) => {
	let k = keys.get(name)
	if (k === undefined) keys.set(name, k = { name })
	return k
}

// more program forms from a harness built on this one: the first that answers is the value
export const forms: ((m: Request) => { value: Json } | undefined)[] = []

const asked = { steps: 0, names: 0 }
const filled = (v: unknown) =>
	v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0
const trie = (from: string): Contributor => ({
	from,
	step: ({ path }, name, r) => {
		asked.steps++
		if (path === undefined) return none
		const v = r.read("value", from, [...path, name])
		return asId(v) ?? (filled(v) ? undefined : none)
	},
	names: ({ path }, r) => {
		asked.names++
		if (path === undefined) return none
		const names = r.keys("value", from, path)
		return names.length ? names : none
	},
	level: ({ path }, name, r) =>
		path !== undefined && filled(r.read("value", from, [...path, name])),
})
let reader: Places = places

function evaluate(e: Json): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map(evaluate)
	const m = e as Request
	if ("read" in m) {
		const [part, id, path] = m.read
		return places.readValue(part, id, path && (evaluate(path) as Step[])) ?? null
	}
	if ("change" in m) return patchesOf(...m.change as [Key, string]) ?? null
	if ("get" in m) return get(reader, m.get) ?? null
	if ("values" in m) {
		const id = get(reader, m.values)
		return id === undefined ? null : places.readValue("value", id) ?? null
	}
	if ("names" in m) return [...list(reader, m.names)]
	if ("level" in m) return ids(members(reader, m.level))
	if ("lookup" in m) {
		const [names, from] = m.lookup
		return m.all === true
			? lookup(reader, names, from, true)
			: lookup(reader, names, from) ?? null
	}
	if ("wait" in m) return PENDING
	if ("track" in m) {
		s.track(keyOf(m.track))
		return null
	}
	if ("throw" in m) throw new Error(m.throw)
	if ("write" in m) {
		write(fill(m.write, evaluate) as Request)
		return null
	}
	const plain = basic(m, evaluate)
	if (plain !== undefined) return plain
	for (const form of forms) {
		const v = form(m)
		if (v !== undefined) return v.value
	}
	throw new Error("unknown program")
}

export function answer(r: Request): Json | undefined {
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
			const id = get(reader, r.path)
			return id === undefined ? {} : { id }
		}
		case "list":
			return { names: [...list(reader, r.at)] }
		case "lookup": {
			if (r.all === true) return { paths: lookup(reader, r.names, r.from, true) }
			const path = lookup(reader, r.names, r.from)
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
		case "mark":
			s.mark((r.keys as string[]).map(keyOf))
			return {}
		case "rows":
			reader = places.view("R", [...((r.of as string[]) ?? ["rows"]).map(trie), children])
			return {}
		case "asked": {
			const was = { ...asked }
			asked.steps = asked.names = 0
			return was
		}
	}
}

if (import.meta.main) await serve((r) => answered(answer, r))
