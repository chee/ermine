// patch nodes (patch.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. state lasts for the process: a table, the overlay in front of it, and places (root
// "R") reading through it; the scheduler, scopes, pulse, state and header are world_harness.ts'
// (core/places/typescript), whose own table and places this leaves alone. other
// implementations join by speaking this (HARNESS)
// every write is the host's, outside, scope open. time: whole seconds, now when not given. ids are
// strings, a part any string. patches: op's
//
// writes:
// { op: "kids", id, value, time? }                 → {}   the children entry, replaced
// { op: "value", id, value, time? }                → {}   the value entry, replaced
// { op: "patch", id, on, part?, at?, patches, time? } → {}   a patch node's "patch" entry; part
//    default "value"; at default: the target entry's change time now, or 0 (none there)
// { op: "edit", part, id, patches, time?, metadata?, unread? } → {}   patches to the entry, said
//    through the overlay's commit (none there: made). metadata: over the scope's info. unread: an
//    entry there written through places' unread, as children are (in place where it owns). an
//    ApplyError answers { error: code, patch: index }
// { op: "share", part?, id, ids }                  → {}   the entry under (part, id) put under
//    each of ids too, the same entry (a table event each); none there: { error: "nothing-there" }
// { op: "del", part, id }                          → {}   the entry out of the table, or
//                                                  → { error: "nothing-there" }
// { op: "land", id, time? }                        → {}   patch.ts' land, then the overlay's
//    commit; not a patch node: { error: "nothing-there" }; patches that don't apply: their code
// reads, outside any run (told to no one):
// { op: "read", part?, id, path? }                 → { value? }   places' read, through the overlay
// { op: "entries", part?, id, path? }              → { items }   each { value?, from, stale?,
//    error? }, front first (error: why it was set aside)
// { op: "change", part?, id }                      → { time?, actor?, metadata?, hasOp }   of the
//    entry a read sees
// { op: "node", part?, id }                        → { value? }   the table's, never the overlay's
// { op: "index", id? }                             → { ids }   a target's patch nodes in order; no
//    id: { size }, how many targets have any
// { op: "get", path }                              → { id? }   places' walk, by names
// { op: "watch", name, scope, f }                  → {}   a compute in scope running f each run,
//    its results (compared as JSON) kept (op "state", world_harness.ts)
//
// a program: a scalar is itself, a list its members evaluated, a map one of
//   {"read":[id, path?, part?]}     the value, or null; id may be a program
//   {"entries":[id, path?, part?]}  the items, as the entries request
//   {"get":names}                   the id there, or null
//   {"throw":message}               an error thrown by the run
// or one of the world's plain forms (world_harness.ts, basic)
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import { ApplyError, type Key as Step, type Patch } from "@ermine/core/op/apply"
import { createPlaces, unread } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { get } from "@ermine/core/places/lib"
import type { Info } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { revive } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import {
	answered,
	basic,
	enroll,
	host,
	json,
	s,
	scope,
} from "../../../core/places/typescript/world_harness.ts"
import { createOverlay, entries, type Item, land, type Overlay, PatchError } from "./patch.ts"

type Json = unknown

const table = createTable((part, id) => overlay.onTableChange(part, id))
const overlay: Overlay = createOverlay(table, () => places)
const places = createPlaces({ root: "R", table: overlay, paths: createPaths(), scheduler: s })
s.onTrackingEnd((key) => places.release(key))

const hosted = <T>(f: () => T) => s.runWithScope(host, f)
function header(time?: number, extra?: Info) {
	const h = hosted(() => createChangeHeader(s, extra))
	if (time !== undefined) h.time = time
	return h
}
const put = (part: Key, id: Id, v: unknown, time?: number) =>
	hosted(() => table.sub(part, id, createEntry(v, header(time)) as never))

const id = (x: unknown): Id => {
	if (typeof x !== "string") throw new Error("id: not a string")
	return x
}
const partOf = (x: unknown): Key => (typeof x === "string" ? x : "value") as Key
const path = (x: unknown) => (x ?? []) as Step[]

function item(i: Item): Json {
	const out: Record<string, Json> = { from: String(i.from) }
	if (i.value !== undefined) out.value = i.value
	if (i.stale) out.stale = true
	if ("error" in i) {
		out.error = typeof i.error === "object" && i.error !== null && "code" in i.error
			? String((i.error as { code: unknown }).code)
			: String(i.error)
	}
	return out
}

function layers(part: Key, i: Id, p: Step[]): Json[] {
	return entries(places, overlay, part, i, p).map(item)
}

function evaluate(e: Json): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map(evaluate)
	const m = e as Request
	if ("read" in m) {
		const [i, p, part] = m.read
		return places.readValue(partOf(part), evaluate(i) as Id, p && (evaluate(p) as Step[])) ?? null
	}
	if ("entries" in m) {
		const [i, p, part] = m.entries
		return layers(partOf(part), evaluate(i) as Id, path(p && evaluate(p)))
	}
	if ("get" in m) return get(places, m.get) ?? null
	if ("throw" in m) throw new Error(m.throw)
	const plain = basic(m, evaluate)
	if (plain !== undefined) return plain
	throw new Error("unknown program")
}

function answer(r: Request): Json | undefined {
	switch (r.op) {
		case "root":
		case "scope":
			// a scope needs an info key: a step that gives none is the test's
			if (typeof r.info !== "object" || r.info === null || Object.keys(r.info).length === 0) {
				r.info = { test: r.name }
			}
			return undefined
		case "kids":
			put("children", id(r.id), revive(r.value), r.time)
			return {}
		case "value":
			put("value", id(r.id), revive(r.value), r.time)
			return {}
		case "patch": {
			const part = partOf(r.part)
			const at = r.at ?? table.get(part, id(r.on))?.change.time ?? 0
			put("patch", id(r.id), { on: r.on, part, at, patches: revive(r.patches) }, r.time)
			return {}
		}
		case "edit": {
			const part = partOf(r.part), i = id(r.id)
			const patches = revive(r.patches) as Patch[]
			hosted(() => {
				const h = header(r.time, r.metadata)
				const there = table.get(part, i)
				if (there === undefined) {
					const node = createEntry<unknown>(undefined, h)
					update(node, patches, h)
					table.add(part, i, node as never)
				} else {
					const write = r.unread ? unread.update : update
					write(there, patches, h)
					overlay.commit([there])
				}
			})
			return {}
		}
		case "share": {
			const part = partOf(r.part), there = table.get(part, id(r.id))
			if (there === undefined) throw new PatchError("nothing-there", id(r.id))
			hosted(() => {
				for (const i of r.ids as unknown[]) table.sub(part, id(i), there as never)
			})
			return {}
		}
		case "del":
			hosted(() => table.del(partOf(r.part), id(r.id)))
			return {}
		case "land":
			hosted(() => overlay.commit(land(table, id(r.id), header(r.time))))
			return {}
		case "read": {
			const v = places.readValue(partOf(r.part), id(r.id), path(r.path))
			return v === undefined ? {} : { value: v }
		}
		case "entries":
			return { items: layers(partOf(r.part), id(r.id), path(r.path)) }
		case "change": {
			const c = places.readChange(partOf(r.part), id(r.id))
			if (c === undefined) return {}
			return {
				time: c.time,
				...(c.actor !== undefined && { actor: c.actor }),
				...(c.metadata !== undefined && { metadata: c.metadata }),
				hasOp: c.op !== undefined,
			}
		}
		case "node": {
			const n = table.get(partOf(r.part), id(r.id))
			return n === undefined || n.value === undefined ? {} : { value: n.value }
		}
		case "index":
			return r.id === undefined
				? { size: overlay.index.size }
				: { ids: overlay.index.get(id(r.id)) ?? [] }
		case "get": {
			const found = get(places, r.path)
			return found === undefined ? {} : { id: found }
		}
		case "watch": {
			const w = { runs: 0, value: null as Json }
			const c = s.runWithScope(scope(r.scope), () =>
				s.createComputer(
					() => (w.runs++, evaluate(r.f)),
					(v) => void (w.value = v),
					json,
				))
			enroll(r.name, c, w)
			return {}
		}
	}
}

if (import.meta.main) {
	await serve((r) =>
		answered((q) => {
			try {
				return answer(q)
			} catch (e) {
				if (e instanceof ApplyError) return { error: e.code, patch: e.patch }
				if (e instanceof PatchError) return { error: e.code }
				throw e
			}
		}, r)
	)
}
