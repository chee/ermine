// Each scope's node: an id of its own beside the scheduler's scope. The scheduler imports no
// table, so the scope-to-node map is kept here.
import type { Scheduler, Scope } from "@ermine/reactivity"
import type { Id, Key, Table } from "@ermine/graph/table"

export type Setup = {
	scheduler: Pick<Scheduler, "registerTeardown">
	table: Pick<Table, "get" | "del">
}

export type ScopeNodes = {
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
