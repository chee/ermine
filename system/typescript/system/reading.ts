import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import type { Id, Path } from "@ermine/places"
import { get, gets, list as listAt } from "@ermine/places/lib"
import { REFUSED } from "@ermine/processes/guard"
import { isPending } from "@ermine/processes/status"
import { PENDING } from "@ermine/reactivity"
import type { Inner, Node, Step, Target, Version } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { attributesOf, byId, handle, idOf, keyOf, nodeOf, viewOf } from "./addressing.ts"
import { mayRead, refused } from "./asking.ts"
import { computerAt } from "./made.ts"
import { here } from "./setting.ts"
import type { Item, System } from "./shapes.ts"

export const read: System["read"] = /* @__PURE__ */ marked(function read(x, key) {
	return go(read, "read", false, readAs, x, key)
})
export const readAttributes: System["readAttributes"] = /* @__PURE__ */ marked(
	function readAttributes(x, key) {
		return go(readAttributes, "readAttributes", false, readAttributesAs, x, key)
	},
)
export const readChildren: System["readChildren"] = /* @__PURE__ */ marked(
	function readChildren(x) {
		return go(readChildren, "readChildren", false, readChildrenAs, x)
	},
)
export const readAll: System["readAll"] = /* @__PURE__ */ marked(function readAll(x, key) {
	return go(readAll, "readAll", false, readAllAs, x, key)
})
export const readAllAttributes: System["readAllAttributes"] = /* @__PURE__ */ marked(
	function readAllAttributes(x, key) {
		return go(readAllAttributes, "readAllAttributes", false, readAllAttributesAs, x, key)
	},
)
export const readAllChildren: System["readAllChildren"] = /* @__PURE__ */ marked(
	function readAllChildren(x) {
		return go(readAllChildren, "readAllChildren", false, readAllChildrenAs, x)
	},
)
export const readEntries: System["readEntries"] = /* @__PURE__ */ marked(function readEntries(x) {
	return go(readEntries, "readEntries", false, readEntriesAs, x)
})
export const peep: System["peep"] = /* @__PURE__ */ marked(function peep(f) {
	return go(peep, "peep", false, peepAs, f)
})
export const list: System["list"] = /* @__PURE__ */ marked(function list(x) {
	return go(list, "list", false, listAs, x)
})

export function readAs(inner: Inner, x: Target, path: readonly Step[] = []): unknown {
	const { base, calls, state, places, guarded } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	// A node that is not there is pending, like a memo with no value. The read is tracked so the node's
	// arrival reruns it, and the wait is recorded.
	if (id === undefined) {
		if (n.path !== undefined && state.peeping === 0) waitFor(inner, n.path)
		throw PENDING
	}
	// Asked only when there is a policy, because this is the hottest read.
	if (guarded) mayRead(inner, id, n.path, n.part, path)
	if (state.peeping === 0) calls.read(n.part, id, path)
	if (n.part === "value" && computerAt(base.made, id)?.memo) {
		const v = places.readValue("value", id, path)
		if (v === undefined && isPending(places, id)) {
			throw PENDING
		}
		return v
	}
	return places.readValue(n.part, id, path)
}

function versions(inner: Inner, x: Target, path: readonly Step[] = []): Version[] {
	const { base, table, context } = here(inner)
	const n = nodeOf(inner, x)
	const shown = readAs(inner, x, path)
	const id = idOf(inner, n)
	if (id === undefined) return []
	const items: Version[] = []
	if (shown !== undefined) {
		const change = (table.get(n.part, id) as Entry<unknown> | undefined)?.change
		items.push({ value: shown, from: change === undefined ? {} : { change } })
	}
	return base.shown({ node: n, part: n.part, id, path, context }, items).map((v) =>
		v.from.change === undefined || base.changes.has(v.from.change as never) ? v : {
			...v,
			from: { ...v.from, change: viewOf(base, v.from.change as ChangeHeader) as never },
		}
	)
}

export function readEntriesAs(inner: Inner, x: Target): Item[] {
	const { calls, table, places, guard, guarded, state } = here(inner)
	const n = nodeOf(inner, x)
	if (n.path === undefined) {
		if (n.id === undefined) return []
		if (refused(inner, n.id, undefined, n.part)) {
			return [{ value: undefined, from: "id", refused: true }]
		}
		if (state.peeping === 0) calls.read(n.part, n.id, [])
		const value = places.readValue(n.part, n.id)
		if (value === undefined && table.get(n.id).length === 0) return []
		return [{ value, from: "id", node: byId(inner, n.id, n.part) }]
	}
	const found = gets(places, n.path)
	if (state.peeping === 0) { for (const a of found) calls.read(n.part, a.id, []) }
	const item = (a: (typeof found)[number]): Item => ({
		value: places.readValue(n.part, a.id),
		from: a.from,
		node: byId(inner, a.id, n.part),
	})
	if (!guarded) return found.map(item)
	if (n.path.length === 0) {
		return found.map((a) =>
			refused(inner, a.id, n.path, n.part)
				? { value: undefined, from: a.from, refused: true as const }
				: item(a)
		)
	}
	const name = n.path[n.path.length - 1]
	const asked = guard.members(found.map((a) => ({ name, id: a.id })), n.path.slice(0, -1))
	return found.map((a, i) =>
		asked[i].id === REFUSED ? { value: undefined, from: a.from, refused: true as const } : item(a)
	)
}

export function listAs(inner: Inner, x: Target): string[] {
	const { calls, places, state } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	if (id !== undefined) mayRead(inner, id, n.path, "children")
	if (id !== undefined && state.peeping === 0) calls.read("children", id, [], true)
	if (n.path === undefined) return n.id === undefined ? [] : places.readKeys("children", n.id)
	return [...listAt(places, n.path)]
}

export function readChildrenAs(inner: Inner, x: Target): Record<string, Node> {
	const { places } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	const names = listAs(inner, x)
	const kids = id === undefined
		? {}
		: places.readValue("children", id) as Record<string, Id> | undefined ?? {}
	const out: Record<string, Node> = {}
	for (const name of names) {
		const at = (n.path === undefined ? undefined : get(places, [...n.path, name])) ?? kids[name]
		if (at !== undefined) out[name] = byId(inner, at, "value")
	}
	return out
}

function allOf(
	inner: Inner,
	x: Target,
	part: "value" | "attributes" | "children",
	path: readonly Step[] = [],
): Version[] {
	const all = versions(inner, handle(inner, { ...nodeOf(inner, x), part }), path)
	if (part !== "children") return all
	return all.map((v) => ({ ...v, value: handlesFor(inner, v.value) }))
}
const handlesFor = (inner: Inner, v: unknown) =>
	v === null || typeof v !== "object" ? v : Object.fromEntries(
		Object.entries(v as Record<string, unknown>).map(([k, id]) => [
			k,
			typeof id === "string" ? byId(inner, id, "value") : id,
		]),
	)

// The path the reader waits on: a computer's, else a setup's. Anyone else's is not kept.
function waitFor(inner: Inner, path: Path) {
	const { base, s, runs } = here(inner)
	const run = s.getRun()
	const computer = run?.computer.info.node as Id | undefined
	if (computer === undefined && !base.setting.has(inner.node)) return
	const key = computer ?? inner.node
	const n = computer === undefined ? undefined : (runs.read(computer)?.n ?? 0) + 1
	let m = base.missing.get(key)
	if (m === undefined || m.n !== n) {
		m = n === undefined ? { paths: [], keys: new Set() } : { n, paths: [], keys: new Set() }
		base.missing.set(key, m)
	}
	const k = keyOf(path)
	if (!m.keys.has(k)) m.keys.add(k), m.paths.push(path)
}

export function peepAs<T>(inner: Inner, f: () => T): T {
	const { places, state } = here(inner)
	state.peeping++
	try {
		return places.peep(() => {
			try {
				return f()
			} catch (e) {
				if (e === PENDING) return undefined as T
				throw e
			}
		})
	} finally {
		state.peeping--
	}
}

export const readAttributesAs = (inner: Inner, x: Target, key?: readonly Step[]) =>
	readAs(inner, attributesOf(inner, x), key)

export const readAllAs = (inner: Inner, x: Target, key?: readonly Step[]) =>
	allOf(inner, x, "value", key)
export const readAllAttributesAs = (inner: Inner, x: Target, key?: readonly Step[]) =>
	allOf(inner, x, "attributes", key)
export const readAllChildrenAs = (inner: Inner, x: Target) => allOf(inner, x, "children")
