// each scope's node: an id of its own beside the scheduler's scope. nothing saves it today (nothing
// saved reaches it). a process's value, its status and its pin are written there. at the scope's
// teardown its node's entries go, as table events, so whoever read them is told. which node a scope
// has, for a write's frames: its own NODE key (places' header.ts), given as it is made; this is
// only the teardown. a memo's or effect's node is the api's: a computer's teardowns run after each
// of its runs, so its node's entries are the api's to take out
//
// the scheduler imports no table, so the map is kept here, beside it.
// core candidate: the scheduler's teardown could take a NODE key's entries, instead of a map and a
// teardown registered from outside
import type { Scheduler, Scope } from "@ermine/reactivity"
import type { Id, Key, Table } from "@ermine/graph/table"

export type Setup = {
	scheduler: Pick<Scheduler, "registerTeardown">
	table: Pick<Table, "get" | "del">
}

export type ScopeNodes = {
	// the scope's node id, made the first time (given, or `scope:<uuid>`); the same after; a scope
	// torn down has none
	give: (scope: Scope, id?: Id) => Id | undefined
}

export function createScopeNodes(setup: Setup): ScopeNodes {
	const { scheduler, table } = setup
	const ids = new WeakMap<Scope, Id>()

	function give(scope: Scope, id: Id = `scope:${crypto.randomUUID()}`): Id | undefined {
		const had = ids.get(scope)
		if (had !== undefined) return had
		if (scope.state !== "alive") return undefined
		ids.set(scope, id)
		scheduler.registerTeardown(scope, () => {
			ids.delete(scope)
			for (const [part] of table.get(id)) table.del(part as Key, id)
		})
		return id
	}

	return { give }
}
