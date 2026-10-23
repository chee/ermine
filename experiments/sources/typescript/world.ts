// a graph for tests and the harness, made as a host makes one: a scheduler, a table, places (root
// "R", its processes' rows then children), its processes (ermine/processes' start, mirrors and
// links among them) and a history over them, made before anything is written. one scope, the
// device's, { actor }, which every write here is made in. the processes' rows and nodes, and the
// history's own node, are this device's, now: the host's rule leaves them out of the history, so
// they are never sent anywhere
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces } from "@ermine/places"
import { PROCESS, processes as rows } from "@ermine/processes"
import { createProcesses } from "@ermine/processes/start"
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createHistory } from "./history.ts"

export type World = ReturnType<typeof createWorld>

export function createWorld(actor: string) {
	const scheduler = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({
		root: "R",
		table,
		paths: createPaths<unknown>(),
		scheduler,
		contributors: [rows("R"), children],
	})
	scheduler.onTrackingEnd((key) => places.release(key))
	const scope = scheduler.createRootScope({ actor })
	// every scope's node, noted: the device's own
	const nodes = createScopeNodes({ scheduler, table })
	const local = new Set<Id>()
	const scopes = {
		give(s: Parameters<typeof nodes.give>[0], id?: Id) {
			const got = nodes.give(s, id)
			local.add(got)
			return got
		},
	}
	const history = createHistory({
		table,
		places,
		scheduler,
		scope,
		scopes,
		records: (id, part) => part !== PROCESS && !local.has(id),
	})
	const processes = scheduler.runWithScope(
		scope,
		() => createProcesses({ scheduler, table, places, scopes }),
	)

	// value put at path in a node's value (none: the whole), as this device
	function set(node: string, value: unknown, path: string[] = []) {
		scheduler.runWithScope(scope, () => {
			places.commit(upsert(table, "value", node, path, value, createChangeHeader(scheduler)))
		})
	}

	// what the graph holds at a node, read by no one
	const value = (node: string) => table.get("value", node)?.value

	return { scheduler, table, places, scope, scopes, processes, history, set, value }
}
