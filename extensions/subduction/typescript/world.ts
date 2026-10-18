// the graph of today around a wiring: a table, paths, a scheduler and places composed as a host
// composes them, with one root scope for the host's own writes. A write goes to the table, tells
// places, and goes out as records (wiring.ts's fromFact); the versions of a blop taken in come
// back as writes to the table, not sent again. Left out: several heads at one object (an entry
// holds one value, so the first head in the agreed order is what shows; the rest are in the
// histories), and a node not in memory is made when its first version comes
import { equal } from "@std/assert"
import type { Blop } from "@ermine/encoding/blop"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createPlaces, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler, type Scheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key, type Table } from "@ermine/table"
import type { At } from "./commit.ts"
import type { Signer } from "./seal.ts"
import type { Device } from "./transport.ts"
import { createWiring, fromFact, type Versions, type Wiring } from "./wiring.ts"

export type World = {
	scheduler: Scheduler
	table: Table
	places: Places
	wiring: Wiring
	// the host's scope: its writes are made in it
	host: Scope
	// patches to the entry under (part, id), made with them if none: told to places, pulsed, and
	// sent out. refused patches throw (an ApplyError) and nothing changes
	write(
		part: Key,
		id: Id,
		patches: Patch[],
		options?: { at?: At; ephemeral?: boolean },
	): Entry<unknown>
	// what sync hands the host for a blop taken in: written to the table, not sent out
	versions: Versions
}

export type Options = {
	// where places' names start
	root: Id
	actor: unknown
	signer: Signer
	random: (n: number) => Uint8Array
	roots?: string[]
	kind?: (live: unknown) => unknown
	// told after each blop taken in, whether or not it changed what shows (the table shows one head
	// of several)
	arrived?: (node: string, object: Blop["object"]) => void
}

const names = { info: "attributes", children: "children" } as const

export function createWorld(device: Device, o: Options): World {
	const scheduler = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: o.root, table, paths, scheduler })
	scheduler.onTrackingEnd((key) => places.release(key))
	const host = scheduler.createRootScope({ actor: o.actor })

	// patches to an entry that is there, or one made with them; told to places
	function put(part: Key, id: Id, patches: Patch[], header: ChangeHeader): Entry<unknown> {
		const there = table.get(part, id)
		const entry = there ?? createEntry<unknown>(undefined, header)
		update(entry, patches, header)
		if (there === undefined) table.add(part, id, entry)
		else places.commit([entry])
		scheduler.pulse()
		return entry
	}

	const versions: Versions = (node, object, list, from) => {
		try {
			show(node, object, list, from)
		} finally {
			o.arrived?.(node, object)
		}
	}
	const show: Versions = (node, object, list, from) => {
		const part: Key = object === "value" ? "value" : names[object[0]]
		const name = object === "value" ? undefined : object[1]
		// the side changes in place with the next blop: the table holds a copy
		const content = structuredClone(list[0]?.content)
		const header: ChangeHeader = list[0]?.change ?? { time: 0, actor: from.actor }
		const entry = table.get(part, node)
		const held = entry?.value as Record<string, unknown> | undefined
		const now = name === undefined ? entry?.value : held?.[name]
		if (equal(now, content)) return
		if (name === undefined) {
			return void put(part, node, [
				content === undefined ? { path: [] } : { path: [], value: content },
			], header)
		}
		const isMap = held !== null && typeof held === "object" && !Array.isArray(held)
		if (content === undefined) {
			if (isMap && Object.hasOwn(held, name)) put(part, node, [{ path: [name] }], header)
			return
		}
		put(part, node, [...isMap ? [] : [{ path: [] as string[], value: {} }], {
			path: [name],
			value: content,
		}], header)
	}

	const wiring = createWiring(device, {
		versions,
		signer: o.signer,
		random: o.random,
		roots: o.roots,
		kind: o.kind,
	})

	return {
		scheduler,
		table,
		places,
		wiring,
		host,
		versions,
		write(part, id, patches, options = {}) {
			const header = scheduler.runWithScope(host, () => createChangeHeader(scheduler))
			const entry = put(part, id, patches, header)
			for (const fact of places.eachEntryChange([entry])) {
				for (const r of fromFact(fact, options.at ?? 0, options.ephemeral ?? false)) {
					wiring.changed(r)
				}
			}
			return entry
		},
	}
}
