// each scope's node: an id of its own beside the scheduler's scope, never saved (nothing saved
// reaches it). a process's value, its status and its pin are written there. a computer is a scope,
// so it can have one too, but its status node is status.ts's own. at the scope's teardown its
// node's entries go, as table events, so whoever read them is told
//
// the scheduler knows no table, so the map is kept here, beside it.
// core candidate: a scope could carry its node's id itself (as a computer could), and the
// scheduler's teardown take its entries, instead of a map and a teardown registered from outside
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Id, Key, Table } from "@ermine/table"

export type Setup = {
	scheduler: Pick<Scheduler, "registerTeardown">
	table: Pick<Table, "get" | "del">
}

export type ScopeNodes = {
	// the scope's node id, made the first time (given, or `scope:<uuid>`); the same after
	give: (scope: Scope, id?: Id) => Id
	// the scope's own node; none: undefined
	nodeOf: (scope: Scope) => Id | undefined
	// the node of the scope, or of the nearest scope above it that has one: whose a computer's run
	// is, inside a process
	nearest: (scope: Scope | undefined) => Id | undefined
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

	function nearest(scope: Scope | undefined): Id | undefined {
		for (let o = scope; o !== undefined; o = o.parent) {
			const id = ids.get(o)
			if (id !== undefined) return id
		}
		return undefined
	}

	return { give, nodeOf: (scope) => ids.get(scope), nearest }
}
