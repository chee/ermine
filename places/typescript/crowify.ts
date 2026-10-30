// Tells a crow about the scheduler's runs, so a run's result is let go of as its body returns.
// Reads after an async function's first await are outside any run and not known here.
import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import type { Patch } from "@ermine/changeable/apply"
import type { Crow } from "@ermine/crow"
import type { Scheduler } from "@ermine/reactivity"
import type { Id, Table } from "@ermine/graph/table"

export function crowify(
	scheduler: Pick<Scheduler, "onRunStart" | "onTrack" | "onRunReturn" | "onRunEnd">,
	crow: Pick<Crow, "letGoIn">,
	subtreeOf?: (key: unknown) => unknown,
): () => void {
	const runs = new Map<unknown, Set<unknown>>()
	const offs = [
		scheduler.onRunStart((c) => void runs.set(c, new Set())),
		scheduler.onRunReturn((c, _n, value) => {
			const given = runs.get(c)
			crow.letGoIn(value, given?.size ? given : undefined)
		}),
		scheduler.onRunEnd((c, _n, ended) => {
			const given = runs.get(c)
			if (ended === "pending" && given?.size) crow.letGoIn([...given], given)
			runs.delete(c)
		}),
	]
	if (subtreeOf !== undefined) {
		offs.push(scheduler.onTrack((key, run) => {
			const x = subtreeOf(key)
			if (x !== undefined) runs.get(run.computer)?.add(x)
		}))
	}
	return () => offs.forEach((off) => off())
}

export function updateEntry<V>(
	crow: Pick<Crow, "update">,
	entry: Entry<V>,
	patches: Iterable<Patch>,
	header: ChangeHeader,
) {
	const ps: readonly Patch[] = Array.isArray(patches) ? patches : [...patches]
	const { value, undo } = crow.update(entry, entry.value, ps)
	if (value === undefined) delete entry.value
	else entry.value = value as V
	entry.change = { ...header, op: { patches: ps, undo } }
}

export function crowifyTable<T extends Pick<Table, "get" | "who">>(
	table: T,
	crow: Pick<Crow, "letGo">,
): T {
	function get(a: unknown, b?: unknown): unknown {
		if (arguments.length === 1) {
			const all = (table.get as (id: Id) => [string, Entry<unknown>][])(a as Id)
			for (const [, e] of all) crow.letGo(e)
			return all
		}
		const got = (table.get as (a: unknown, b: unknown) => unknown)(a, b)
		if (typeof b === "string" || typeof b === "symbol") {
			if (got !== undefined) crow.letGo(got as Entry<unknown>)
		}
		return got
	}
	return { ...table, get: get as Table["get"] }
}
