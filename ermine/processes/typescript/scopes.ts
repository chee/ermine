// each scope's node: an id of its own beside the scheduler's scope, never saved (nothing saved
// reaches it). a process's value, its status and its pin are written there. at the scope's teardown
// its node's entries go, as table events, so whoever read them is told. which node a scope has, for
// a write's metadata: its own NODE key (places' header.ts), given as it is made; this is only the
// teardown. a memo's or effect's node is the api's: a computer's teardowns run after each of its
// runs, so its node's entries are the api's to take out
//
// the scheduler knows no table, so the map is kept here, beside it.
// core candidate: the scheduler's teardown could take a NODE key's entries, instead of a map and a
// teardown registered from outside
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Id, Key, Table } from "@ermine/table"

export type Setup = {
	scheduler: Pick<Scheduler, "registerTeardown">
	table: Pick<Table, "get" | "del">
}

export type ScopeNodes = {
	// the scope's node id, made the first time (given, or `scope:<uuid>`); the same after
	give: (scope: Scope, id?: Id) => Id
}

export function createScopeNodes(setup: Setup): ScopeNodes {
	const { scheduler, table } = setup
	const ids = new WeakMap<Scope, Id>()

	function give(scope: Scope, id: Id = `scope:${crypto.randomUUID()}`): Id {
		const had = ids.get(scope)
		if (had !== undefined) return had
		ids.set(scope, id)
		scheduler.registerTeardown(scope, () => {
			ids.delete(scope)
			for (const [part] of table.get(id)) table.del(part as Key, id)
		})
		return id
	}

	return { give }
}
