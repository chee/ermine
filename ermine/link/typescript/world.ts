// The world the link and guard harnesses share, made as a composer makes it: one scheduler, one
// store, one paths and one places (root ["stored","R"]), joined by link. The harnesses add their
// own reads and programs (link_harness.ts, guard_harness.ts), and speak the line protocol
// through serve (conformance/typescript/harness.ts).
//
// sources and ids are strings. an entry is [source, id]; a part is any string ("children" is
// places' hole). a value is plain JSON. a patch is
// { path, range?, value?, move?: { path, range? } }. pairs: [[key, value]..]. the host writes
// with its scope open, its info [["actor","test"]]: every write of the world's below is the
// host's, from outside
//
// { op: "kids", source, id, value }          → {}   the children node there, replaced (a table event)
// { op: "value", source, id, value }         → {}   the value node there, replaced
// { op: "share", value, keys: [[source, part, id]..] } → {}   one node under all those keys (store.add)
// { op: "drop", source }                     → {}   store.drop
// { op: "del", source, part, id }            → {}   store.del
//                                            → { error: "nothing-there" }
// { op: "node", source, part, id }           → { value? }   the node's value as the store has it
//    (not a read: told to no one); none there, or no value: {}
// { op: "kept" }                             → { keys, spots, steps }   what paths keeps
// writes. a PlacesError or an ApplyError answers { error: code } and an ApplyError also
// { patch: index }
// { op: "edit", source, part, id, patches }                           → {}
//    the patches to the node there, then said written; none there: a node made with them, added
// { op: "place", at, name, entry, index? }                            → {}
// { op: "unplace", at, name, index }                                  → {}
// { op: "order", at, name, from, to }                                 → {}
// { op: "rename", at, name, to }                                      → {}
// { op: "move", at, name, index, to: { at, name }, toindex? }         → {}
// the scheduler:
// { op: "root", name, info? }                → {}   a scope with no parent
// { op: "scope", name, parent, info? }       → {}
// { op: "dispose", name }                    → {}
// { op: "pulse" }                            → {}
// { op: "state", name }                      → { runs, value }   of a compute made by a harness's
//    watch: how many times its program ran; its last result given to set (null: none)
// { op: "moments" }                          → { moments }   since last asked: the scheduler's, as
//    core/scheduler/typescript/scheduler_harness.ts shows them, computations by name
// { op: "header", scope?, extra? }           → the header link makes for a write with that scope
//    open (none: nothing open), extra its own pairs, summed up: { actor, reader?, metadata?,
//    timely, sites }: timely, its time is now in whole seconds; sites, how many its external has.
//    nothing open: { error: "unscoped" }
// anything not understood: { error: text }
import createNode, { type ChangeHeader } from "@ermine/node"
import update from "@ermine/node/update"
import { ApplyError, type Patch } from "@ermine/op/apply"
import { createPlaces, type Entry, type Item, PlacesError } from "@ermine/places"
import {
	type Computation,
	createScheduler,
	type Moment,
	type Pair,
	type Scope,
} from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createStore, type Key, type Part } from "@ermine/store"
import { createLink, type Where } from "@ermine/link"

import type { Answer, Request } from "../../../conformance/typescript/harness.ts"
type Json = unknown

let moments: Moment[] = []
export const scopes = new Map<string, Scope>()
export const names = new Map<Scope, string>()
const nameOf = (c: Scope) => names.get(c)!

// each computation's latest ended run's reads, in order, as link's spot named each as the run
// ended: where it reads, null: not one of link's spots
export const spotted = new Map<Scope, Json[]>()
export const where = (w: Where | undefined): Json =>
	w === undefined ? null : { source: w.source, part: w.part, id: w.id, path: w.path }

export const s = createScheduler({
	hook: (m) => {
		moments.push(m)
		if ("ends" in m) spotted.set(m.ends, m.reads.map((k) => where(l.spot(k))))
	},
	forget: (key) => l.forget(key),
})
export const store = createStore((source, part, id) => l.event(source, part, id))
export const paths = createPaths<unknown>()
export const l = createLink({ store, paths, scheduler: s })
export const places = createPlaces({
	root: ["stored", "R"],
	children: store.children,
	read: l.read,
})
export const host = s.root([["actor", "test"]])

// the moments, computations by name
function moment(m: Moment): Json {
	if ("due" in m) {
		return m.by
			? { due: nameOf(m.due), tick: m.tick, by: nameOf(m.by) }
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
export function enroll(name: string, c: Computation, w: { runs: number; value: Json }) {
	watched.set(name, w)
	scopes.set(name, c)
	names.set(c, name)
}
export function scope(name: unknown): Scope {
	const o = scopes.get(name as string)
	if (o === undefined) throw new Error(`no scope ${name}`)
	return o
}

export const entry = (x: unknown): Entry => {
	if (!Array.isArray(x) || x.length !== 2) throw new Error("entry: not two keys")
	return [x[0], x[1]]
}
export const item = (i: Item) => `${String(i.source)}:${String(i.id)}`

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

// a value write: the patches to the node there, then said written; none there: a node made with
// them, then added (a table event)
export function edit(source: Key, part: Part, id: Key, patches: Patch[]) {
	const h = l.header()
	const there = store.get(source, part, id)
	if (there === undefined) {
		const node = createNode<unknown>(undefined, h)
		update(node, patches, h)
		store.add(source, part, id, node)
		return node
	}
	update(there, patches, h)
	l.wrote([{ source, node: there }])
	return there
}

// a write request, with the scope open as it is
export function write(r: Request): void {
	const slot = (at: unknown, name: string) => [entry(at), name] as [Entry, string]
	switch (r.op) {
		case "edit":
			edit(r.source, r.part, r.id, r.patches as Patch[])
			return
		case "place":
			l.wrote(places.place(slot(r.at, r.name), entry(r.entry), l.header(), r.index))
			return
		case "unplace":
			l.wrote(places.unplace(slot(r.at, r.name), r.index, l.header()))
			return
		case "order":
			l.wrote(places.order(slot(r.at, r.name), r.from, r.to, l.header()))
			return
		case "rename":
			l.wrote(places.rename(slot(r.at, r.name), r.to, l.header()))
			return
		case "move":
			l.wrote(
				places.move(
					slot(r.at, r.name),
					r.index,
					slot(r.to.at, r.to.name),
					l.header(),
					r.toindex,
				),
			)
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
//   {"within":[pairs,e]}  e with a scope of those pairs open, made under the one open
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
	if ("within" in m) return s.run(s.scope(m.within[0] as Pair[]), () => ev(m.within[1]))
	if ("header" in m) return summary(l.header())
}

// the world's requests; undefined: not one of them
export function worldAnswer(r: Request): Json | undefined {
	const hosted = <T>(f: () => T) => s.run(host, f)
	switch (r.op) {
		case "kids":
			hosted(() => store.sub(r.source, "children", r.id, createNode(r.value, l.header())))
			return {}
		case "value":
			hosted(() => store.sub(r.source, "value", r.id, createNode<unknown>(r.value, l.header())))
			return {}
		case "share": {
			hosted(() => {
				const node = createNode<unknown>(r.value, l.header())
				for (const [source, part, id] of r.keys) store.add(source, part, id, node)
			})
			return {}
		}
		case "drop":
			hosted(() => store.drop(r.source))
			return {}
		case "del":
			hosted(() => store.del(r.source, r.part, r.id))
			return {}
		case "node": {
			const n = store.get(r.source, r.part, r.id)
			return n === undefined || n.value === undefined ? {} : { value: n.value }
		}
		case "kept":
			return paths.kept()
		case "edit":
		case "place":
		case "unplace":
		case "order":
		case "rename":
		case "move":
			hosted(() => write(r))
			return {}
		case "root":
		case "scope": {
			const o = r.op === "root" ? s.root(r.info) : s.scope(r.info, scope(r.parent))
			scopes.set(r.name, o)
			names.set(o, r.name)
			return {}
		}
		case "dispose":
			s.dispose(scope(r.name))
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
			const made = () => summary(l.header(r.extra))
			return r.scope === undefined ? made() : s.run(scope(r.scope), made)
		}
	}
}

// a harness's answer to a request, else the world's. the errors that are codes answer as such
export function answered(own: (r: Request) => Json | undefined, r: Request): Answer {
	try {
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
