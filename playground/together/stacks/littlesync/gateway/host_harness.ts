// a lab-pig-style TS device for tests: a table, places, a scheduler and sync.ts (@ermine/together)
// over its own device, as lab-pig's sync world composes one; stored writes and ephemeral writes
// (waves) of a node's value
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import type { Patch } from "@ermine/core/op/apply"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createSync } from "../../../typescript/sync.ts"
import { createSigner } from "../../../typescript/seal.ts"

export async function createHost(name = "ts") {
	const signer = await createSigner()
	const scheduler = createScheduler()
	let waving: string | undefined
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths(), scheduler })
	const sync = createSync({
		table,
		signer,
		zeros: true,
		commit: (changed) => places.commit(changed),
		ephemeral: (doc, part) => doc === waving && part === "value",
	})
	const scope = scheduler.createRootScope({ actor: name })
	// every node it writes is shared, as writing used to follow it
	const write = (part: Key, id: Id, patches: Patch[]) => {
		if (typeof id === "string") sync.share(id).catch(() => {})
		scheduler.runWithScope(scope, () => {
			let e = table.get(part, id)
			if (e === undefined) {
				table.add(
					part,
					id,
					createEntry(patches[0].value as never, createChangeHeader(scheduler)),
				)
				patches = patches.slice(1)
				e = table.get(part, id)!
			}
			if (patches.length) {
				update(e, patches as never, createChangeHeader(scheduler))
				places.commit([e])
				sync.wrote([e])
			}
		})
	}
	return {
		name,
		signer,
		sync,
		device: sync.device,
		table,
		// a stored write of the node's whole value
		store: (id: string, value: unknown) => write("value", id, [{ path: [], value }]),
		// a stored write of the node's whole children
		place: (id: string, children: Record<string, string>) =>
			write("children", id, [{ path: [], value: children }]),
		// one key of the node's value
		set: (id: string, key: string, value: unknown) =>
			write("value", id, [{ path: [key], value }]),
		// one name taken out of the node's children (the node stays)
		unplace: (id: string, name: string) => write("children", id, [{ path: [name] }]),
		// an ephemeral write of it
		wave(id: string, value: unknown) {
			waving = id
			try {
				write("value", id, [{ path: [], value }])
			} finally {
				waving = undefined
			}
		},
		read: (id: string) => table.get("value", id)?.value as Record<string, unknown> | undefined,
		children: (id: string) =>
			table.get("children", id)?.value as Record<string, unknown> | undefined,
		close: () => sync.close(),
	}
}
export type Host = Awaited<ReturnType<typeof createHost>>
