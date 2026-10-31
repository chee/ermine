// The world the places and guard harnesses share: scheduler, table, paths and places (root "R").
// Every write is the host's, with info {"actor":"test"}. patch: { path, range?, value?, move? }.
//
// { op: "kids", id, value }                  → {}   the children entry replaced (a table event)
// { op: "value", id, value }                 → {}   the value entry replaced
// { op: "share", value, keys: [[part, id]..] } → {}   one entry under all those keys (table.add)
// { op: "del", part, id }                    → {} | { error: "nothing-there" }
// { op: "node", part, id }                   → { value? }   the table's, told to no one
// { op: "namesOf", id }                      → { names }   each { folder, name }
// { op: "held" }                             → { keys, spots, steps }   what paths holds
// Errors answer { error: code }, an ApplyError also { patch: index }:
// { op: "edit", part, id, patches }          → {}   none there: an entry made with them
// { op: "place", at, name, id }              → {}   at: the parent's id
// { op: "unplace", at, name }                → {}
// { op: "rename", at, name, to }             → {}
// { op: "move", at, name, to: { at, name } } → {}
// { op: "peep", request }                    → the request's answer, made under places.peep
// { op: "root", name, info? }                → {}   a scope with no parent
// { op: "scope", name, parent, info? }       → {}   a "node" key in info stops a frame lookup there
// { op: "dispose", name }                    → {}
// { op: "pulse" }                            → {}
// { op: "state", name }                      → { runs, value }   a watch's run count, last result
// { op: "moments" }                          → { moments }   since last asked, computes by name
// { op: "header", scope?, extra? }           → { actor, reader?, frame, timely }
//    timely: time is now in whole seconds; frame: infos innermost first, locations shown as
//    ["program"]. No scope open: { error: "unscoped" }
// { op: "watchAll", name, id?, part?, frame? } → {}   watched facts { part, id, patches, actor? }
//    none: every fact; frame: true adds the frame of the fact's change
// anything not understood: { error: text }
import createEntry, { type ChangeHeader } from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import { ApplyError, type Patch } from "@ermine/changeable/apply"
import { type Computer, createScheduler, type Info, type Scope } from "@ermine/reactivity"
import { type Told, trace } from "../../reactivity/typescript/scheduler_harness.ts"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Id, type Key } from "@ermine/graph/table"
import {
	type Contributor,
	createPlaces,
	move,
	place,
	PlacesError,
	rename,
	unplace,
	type Where,
} from "./places.ts"

import type { Answer, Request } from "../../conformance/typescript/harness.ts"
import { toJson } from "../../conformance/typescript/form.ts"
import { createChangeHeader } from "./header.ts"
import { show } from "../../conformance/typescript/frames.ts"
type Json = unknown

let moments: Told[] = []
export const scopes = new Map<string, Scope>()
const watches = new Map<string, { told: Json[]; stop: () => void }>()
export const names = new Map<Scope, string>()
const nameOf = (c: Scope) => names.get(c)!

// each computation's latest ended run's reads, as places' spots (null: not a spot)
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
export let places = createPlaces({ root: "R", table, paths, scheduler: s })
// From here on, places walks with these contributors (the same table, paths and scheduler).
export function contribute(contributors: readonly Contributor[]) {
	places = createPlaces({ root: "R", table, paths, scheduler: s, contributors })
}
export const host = s.createRootScope({ actor: "test" })
export const header = (extra?: Info) => createChangeHeader(s, { extra })

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

export const watched = new Map<string, { runs: number; value: Json }>()
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

export function summary(change: ChangeHeader): Json {
	const { actor, reader, frame, time } = change
	return {
		actor,
		...(reader !== undefined && { reader }),
		frame: show(frame),
		timely: Number.isInteger(time) && Math.abs(time - Date.now() / 1000) < 5,
	}
}

// a value write: the patches to the entry there, or an entry made with them and added
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

export function write(r: Request): void {
	// a parent's children entry; none: nothing-there
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

export function fill(x: Json, ev: (e: Json) => Json): Json {
	if (Array.isArray(x)) return x.map((y) => fill(y, ev))
	if (x === null || typeof x !== "object") return x
	const keys = Object.keys(x)
	if (keys.length === 1 && keys[0] === "eval") return ev((x as Request).eval)
	return Object.fromEntries(keys.map((k) => [k, fill((x as Request)[k], ev)]))
}

export const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// the programs' plain forms, shared by the harnesses (undefined: not one of them):
//   {"cat":[e..]} {"join":e} {"count":e} {"add":[a,b]} {"lt":[a,b]} {"if":[t,a,b]}
//   {"do":[e..]} {"quote":x} {"within":[info,e]} (e with a scope of that info open)
//   {"header":null}       the header of a write made now, summed up
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
			return n === undefined || n.value === undefined ? {} : { value: toJson(n.value) }
		}
		case "namesOf":
			return { names: places.namesOf(r.id).map((n) => ({ folder: n.folder, name: n.name })) }
		case "held":
			return paths.held()
		case "watchAll": {
			const told: Json[] = []
			const stop = places.watchAll((f) => {
				if (r.id !== undefined && f.id !== id(r.id)) return
				if (r.part !== undefined && f.part !== r.part) return
				const fact: Record<string, Json> = { part: f.part, id: f.id, patches: f.patches }
				if (f.change !== undefined) fact.actor = f.change.actor
				if (r.frame === true) fact.frame = f.change === undefined ? [] : show(f.change.frame)
				told.push(fact)
			})
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
		case "place":
		case "unplace":
		case "rename":
		case "move":
			hosted(() => write(r))
			return {}
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
			return { runs: w.runs, value: toJson(w.value) }
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
