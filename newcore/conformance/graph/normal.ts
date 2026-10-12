// what the harness sees of the graph, as JSON every implementation can give the same (from the
// scheduler's conformance, less status):
//   an item          {"id":id,"loaded":b,"refused"?:why}
//   a content item   {"id":id,"versions"?:[version...],"refused"?:why}  no versions: pending
//   a version        {"content":c,"time":t}
//   a change         its time; several: their times
//   a live value     "<live>"
//   an error         its code: the library's, protect's refusal "refused", else "thrown"
//
// an interface's operations, by name, with their fields:
//   look {address}  lookup {path}  lookups {path}  children {address, name?}  names {address, part}
//   content {address}  info {address, name}
//   write {address, patches, index?, slotindex?}  set {address, name, patches, index?, slotindex?}
//   insert {id, name, child, index?, slotindex?}  remove {id, name, index, slotindex?}
//   pop {id, name, slotindex}  rename {id, name, to}  move {id, name, index, toid, toname, toindex?}
//   create {value?, id?, ephemeral?}             answers the new node's id
//   whole {id}         node(id): {"value":[version],"info":{n:[version]},"children":{n:[version]}};
//                      null: not loaded, or refused
//   as {cause, do}     do (one of these, with its fields) by as({cause})
import type { Api } from "../../graph/ts/graph.ts"

export const LIVE = "<live>"

export function json(v: unknown): unknown {
	if (v === undefined) return null
	if (typeof v === "function" || typeof v === "symbol") return LIVE
	if (Array.isArray(v)) return v.map(json)
	if (v !== null && typeof v === "object") {
		if (ArrayBuffer.isView(v)) return LIVE
		const out: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = json(x)
		return out
	}
	return v
}

type V = { content: unknown; change?: { time?: number } }

export function version(v: V): unknown {
	return { content: json(v.content), time: v.change?.time ?? null }
}

// an error's code
export function code(e: unknown): string {
	if (e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") {
		return (e as { code: string }).code
	}
	return "thrown"
}

// deno-lint-ignore no-explicit-any
type Item = Record<string, any>

export function item(it: Item): unknown {
	const out: Record<string, unknown> = { id: it.id }
	if (Array.isArray(it.versions) || "versions" in it) {
		if (it.versions) out.versions = it.versions.map(version)
	} else out.loaded = it.node !== undefined
	if (it.refused !== undefined) out.refused = json(it.refused)
	return out
}

const times = (c: { time?: number } | { time?: number }[]) =>
	Array.isArray(c) ? c.map((x) => x.time) : c.time

// deno-lint-ignore no-explicit-any
export function operate(api: Api, op: string, f: Record<string, any>): unknown {
	switch (op) {
		case "look":
			return api.look(f.address).map(item)
		case "lookup":
			return api.lookup(f.path).map(item)
		case "lookups":
			return api.lookups(f.path).map(item)
		case "children": {
			const out = api.children(f.address, f.name ?? undefined)
			return f.name === undefined || f.name === null ? out : (out as Item[]).map(item)
		}
		case "names":
			return api.names(f.address, f.part)
		case "content":
			return api.content(f.address).map((it) => item({ versions: undefined, ...it }))
		case "info":
			return api.info(f.address, f.name).map((it) => item({ versions: undefined, ...it }))
		case "write":
			return times(
				api.write(f.address, f.patches, f.index ?? undefined, f.slotindex ?? undefined),
			)
		case "set":
			return times(
				api.set(f.address, f.name, f.patches, f.index ?? undefined, f.slotindex ?? undefined),
			)
		case "insert":
			return times(
				api.insert(f.id, f.name, f.child, f.index ?? undefined, f.slotindex ?? undefined),
			)
		case "remove":
			return times(api.remove(f.id, f.name, f.index, f.slotindex ?? undefined))
		case "pop":
			return times(api.pop(f.id, f.name, f.slotindex))
		case "rename":
			return times(api.rename(f.id, f.name, f.to))
		case "move":
			return times(api.move(f.id, f.name, f.index, f.toid, f.toname, f.toindex ?? undefined))
		case "whole": {
			const n = api.node(f.id)
			if (n === undefined) return null
			const of = (m: Map<string, unknown[]>) =>
				Object.fromEntries([...m].map(([k, vs]) => [k, vs.map((v) => version(v as V))]))
			return {
				value: n.value.map((v) => version(v as V)),
				info: of(n.info),
				children: of(n.children as Map<string, unknown[]>),
			}
		}
		case "as":
			return operate(api.as({ cause: f.cause }), f.do.op, f.do)
		case "create": {
			const o: { id?: string; ephemeral?: boolean } = {}
			if (f.id !== undefined) o.id = f.id
			if (f.ephemeral !== undefined) o.ephemeral = f.ephemeral
			return api.create(f.value, o)
		}
	}
	throw Object.assign(new Error(`unknown op ${op}`), { code: "unknown-op" })
}
