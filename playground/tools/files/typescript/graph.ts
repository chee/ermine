// The graph the files program works on, as today's core has it: a table of entries (value,
// attributes and children at an id), places joining it to the scheduler, writes made with a scope
// open. The program and the store were written against a graph whose nodes keep ordered lists of
// ids in named slots and versions of a value; this is what they are given of today's:
//
//   a node: the entries under its id. It is there when its children entry is; a node made here
//   always has one. value: the value entry's, one version (core keeps no more; a side, a second
//   version, is left out). slots: the children entry's value maps a slot name to its ids: none,
//   the name is not there; one, the bare id (so places' walk goes through it); several, a list of
//   ids in order, which a walk does not go through, as places has "a name holding anything".
//
// get and intro turn between this and the shape the store saves (saved.ts): a version of a value
// is the entry's value and change, a slot's one list is its ids, an info name's one version is the
// attributes entry's name. Nothing here is the store's or the program's rule.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createGuard, type Setup as GuardSetup, slot as slotTarget } from "@ermine/places/guard"
import { createChangeHeader } from "@ermine/places/header"
import { createPlaces, type Places } from "@ermine/places"
import type { Policy } from "@ermine/protect"
import { createScheduler, type Pair, type Scheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key, type Table } from "@ermine/table"
import createNode, { type Node as Saved, type Side } from "./saved.ts"

/** What the program does to the graph, each write a change by whoever the api is as. */
export type Api = {
	/** a node, with the value if there is one; ephemeral: never saved and left out of every list */
	create(value?: unknown, o?: { ephemeral?: boolean }): Id
	/** whether the node is in the graph */
	loaded(id: Id): boolean
	/** the node's value; none: undefined */
	value(id: Id): unknown
	/** a slot's ids in order */
	ids(holder: Id, slot: string): Id[]
	/** a node's slot names, in the order the graph has them */
	slots(id: Id): string[]
	/** id put into a slot at a position (none: the end); a range [at, to] is replaced by it */
	insert(holder: Id, slot: string, id: Id, at?: number | [number, number]): void
	/** the members of a slot at a position, or in a range [at, to) */
	remove(holder: Id, slot: string, at: number | [number, number]): void
	/** a member moved to a position in another slot (none: the end); in one slot, the position it ends at */
	move(holder: Id, slot: string, from: number, into: Id, to: string, at?: number): void
	/** patches to a node's value; version: only 0 is there */
	write(id: Id, patches: readonly Patch[], version?: number): void
	/** the api as the same actor with pairs more in every change it makes: a cause, a path */
	as(extra: Record<string, unknown>): Api
}

export type Graph = {
	readonly root: Id
	readonly scheduler: Scheduler
	readonly table: Table
	readonly places: Places
	/** the api for changes by an actor */
	api(actor?: unknown): Api
	/** the node as the store saves it; none: not in the graph */
	get(id: Id): Saved<unknown, unknown> | undefined
	/** a node the store loaded, taken in whole */
	intro(node: Saved<unknown, unknown>): void
	/** whether the node was made ephemeral */
	ephemeral(id: Id): boolean
}

type Id = string

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)

/** A slot's ids as a children entry's value says them. */
function idsOf(v: unknown): Id[] {
	if (typeof v === "string") return [v]
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
	return []
}

/** A slot's ids as the value to keep them as: one, bare; several, a list; none: the name is not there. */
const keepIds = (ids: readonly Id[]): unknown => ids.length === 1 ? ids[0] : [...ids]

/** A change as the store saves it: the header less the patches that made it, which a version has no room for. */
function saved(change: ChangeHeader): unknown {
	const { op: _, ...rest } = change
	return rest
}

export function createGraph(
	o: { root: Id; may?: Policy; ids?: () => Id } = { root: "r" },
): Graph {
	const { root } = o
	const scheduler = createScheduler()
	// created after, as the table's event goes to places, which is made with the table
	// deno-lint-ignore prefer-const
	let places: Places
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	places = createPlaces({ root, table, paths, scheduler })
	scheduler.onTrackingEnd((key) => places.release(key))
	const guard = createGuard(
		{ places, scheduler, table, may: o.may } satisfies GuardSetup,
	)
	const ephemerals = new Set<Id>()
	let counter = 0
	const fresh = o.ids ?? (() => `n${(++counter).toString(36)}-${crypto.randomUUID().slice(0, 8)}`)

	const kids = (id: Id) => table.get("children", id)

	/** The value entry or the children entry of a node, patched, and said written; made if it was not there. */
	function patch(part: Key, id: Id, patches: Patch[], header: ChangeHeader) {
		const there = table.get(part, id)
		if (there === undefined) {
			const entry = createEntry<unknown>(undefined, header)
			update(entry, patches, header)
			table.add(part, id, entry)
			return
		}
		update(there, patches, header)
		places.commit([there])
	}

	function ensure(id: Id, header: ChangeHeader) {
		if (kids(id) === undefined) table.add("children", id, createEntry({}, header))
	}

	function make(info: readonly Pair[]): Api {
		const scope: Scope = scheduler.createRootScope(info)
		const within = <T>(f: (header: () => ChangeHeader) => T): T =>
			scheduler.runWithScope(scope, () => f(() => createChangeHeader(scheduler)))

		function setSlot(holder: Id, name: string, ids: readonly Id[], header: ChangeHeader) {
			ensure(holder, header)
			const had = isMap(kids(holder)!.value) &&
				Object.hasOwn(kids(holder)!.value as object, name)
			// a slot emptied is gone
			if (ids.length === 0 && !had) return
			patch("children", holder, [
				ids.length === 0 ? { path: [name] } : { path: [name], value: keepIds(ids) },
			], header)
		}

		const slotIds = (holder: Id, name: string): Id[] => {
			const v = kids(holder)?.value
			return isMap(v) && Object.hasOwn(v, name) ? idsOf(v[name]) : []
		}

		const api: Api = {
			create(value, opt) {
				return within((header) => {
					const id = fresh()
					const h = header()
					if (value !== undefined) table.add("value", id, createEntry<unknown>(value, h))
					ensure(id, h)
					if (opt?.ephemeral) ephemerals.add(id)
					return id
				})
			},
			loaded: (id) => kids(id) !== undefined || table.get("value", id) !== undefined,
			value: (id) => table.get("value", id)?.value,
			ids: slotIds,
			slots(id) {
				const v = kids(id)?.value
				return isMap(v) ? Object.keys(v) : []
			},
			insert(holder, name, id, at) {
				within((header) => {
					const h = header()
					guard.write("place", slotTarget({ id: holder }, name))
					const ids = slotIds(holder, name)
					if (at === undefined) ids.push(id)
					else if (typeof at === "number") ids.splice(at, 0, id)
					else ids.splice(at[0], at[1] - at[0], id)
					setSlot(holder, name, ids, h)
				})
			},
			remove(holder, name, at) {
				within((header) => {
					const h = header()
					guard.write("unplace", slotTarget({ id: holder }, name))
					const ids = slotIds(holder, name)
					if (typeof at === "number") ids.splice(at, 1)
					else ids.splice(at[0], at[1] - at[0])
					setSlot(holder, name, ids, h)
				})
			},
			move(holder, name, from, into, to, at) {
				within((header) => {
					const h = header()
					guard.write("place", slotTarget({ id: into }, to))
					const ids = slotIds(holder, name)
					const [id] = ids.splice(from, 1)
					if (id === undefined) {
						throw new Error(`the slot ${JSON.stringify(name)} has no member ${from}`)
					}
					if (holder === into && name === to) {
						ids.splice(at ?? ids.length, 0, id)
						setSlot(holder, name, ids, h)
						return
					}
					setSlot(holder, name, ids, h)
					const there = slotIds(into, to)
					there.splice(at ?? there.length, 0, id)
					setSlot(into, to, there, h)
				})
			},
			write(id, patches, version = 0) {
				within((header) => {
					if (version !== 0) throw new Error("the node has no such version")
					if (!api.loaded(id)) throw new Error("the node is not loaded")
					const h = header()
					guard.write("write", { id, part: "value" })
					patch("value", id, [...patches], h)
				})
			},
			as(extra) {
				return make([...info, ...Object.entries(extra)])
			},
		}
		return api
	}

	return {
		root,
		scheduler,
		table,
		places,
		// a scope says something (the scheduler refuses one with no pairs): with no actor, whose it is
		api: (actor) => make(actor === undefined ? [["program", "files"]] : [["actor", actor]]),
		ephemeral: (id) => ephemerals.has(id),
		get(id) {
			const parts = table.get(id)
			if (parts.length === 0) return undefined
			const value = table.get("value", id)
			const attributes = table.get("attributes", id)
			const children = kids(id)
			const side = <C>(content: C, e: Entry<unknown>): Side<C, unknown> => ({
				content,
				change: saved(e.change),
			})
			const node = createNode<unknown, unknown>(String(id), {
				value: value && value.value !== undefined ? [side(value.value, value)] : [],
				attributes: isMap(attributes?.value)
					? Object.entries(attributes.value).map(([name, v]) => [name, [side(v, attributes!)]])
					: [],
				children: isMap(children?.value)
					? Object.entries(children.value).map((
						[name, v],
					) => [name, [side(idsOf(v), children!)]])
					: [],
			}, { header: { time: value?.change.time ?? children?.change.time } })
			return node
		},
		intro(node) {
			const id = node.id
			const entry = <V>(content: V, change: unknown) => {
				const c = (change ?? {}) as Partial<ChangeHeader>
				return createEntry<V>(content, {
					...c,
					time: c.time ?? node.change.time ?? 0,
					actor: c.actor,
				} as ChangeHeader)
			}
			const first = node.value[0]
			if (first && first.content !== undefined) {
				table.sub("value", id, entry(first.content, first.change))
			}
			const info: Record<string, unknown> = {}
			let ichange: unknown
			for (const [name, vs] of node.attributes) {
				if (vs[0]) (info[name] = vs[0].content, ichange ??= vs[0].change)
			}
			if (Object.keys(info).length) table.sub("attributes", id, entry(info, ichange))
			const slots: Record<string, unknown> = {}
			let schange: unknown
			for (const [name, vs] of node.children) {
				const ids = (vs[0]?.content ?? []).filter((x): x is string => typeof x === "string")
				if (ids.length === 0) continue
				slots[name] = keepIds(ids)
				schange ??= vs[0]?.change
			}
			table.sub("children", id, entry(slots, schange ?? node.change))
		},
	}
}
