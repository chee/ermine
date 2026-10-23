// a graph for tests and the harness, made as a host makes one: a scheduler, a table, places (root
// "R", children alone) and a history over them, made before anything is written. one scope, the
// device's, { actor }, which every write here is made in
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key } from "@ermine/table"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import { createHistory } from "./history.ts"

export type World = ReturnType<typeof createWorld>

export function createWorld(actor: string) {
	const scheduler = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler })
	scheduler.onTrackingEnd((key) => places.release(key))
	const scope = scheduler.createRootScope({ actor })
	const history = createHistory({ table, places })

	// value put at path in a node's value (none: the whole), as this device
	function set(node: string, value: unknown, path: string[] = []) {
		scheduler.runWithScope(scope, () => {
			places.commit(upsert(table, "value", node, path, value, createChangeHeader(scheduler)))
		})
	}

	// what the graph holds at a node, read by no one
	const value = (node: string) => table.get("value", node)?.value

	return { scheduler, table, places, scope, history, set, value }
}
