// crow and the graph: what of the graph crow is told, and how an entry is written through it
//
// crowify: a scheduler's runs told to crow, each a loan of what it reads. a read in a run tells crow
// nothing (a look costs nothing); what outlives the run is its result, fixed as its body returns:
// crow lets go of it then (letGoIn), so a write after (its set's, or anyone's) never changes it in
// place. subtreeOf: from a key a run tracked, the value that key gave it, as it came out of an entry
// (with places, the value at its spot's path): the result's subtrees; none: results walked whole. a
// run's own writes in its body come before its return: in place, as any. a run that stops to wait
// (it ends pending: an await, a generator's yielded promise) keeps what it read so far across the
// wait: those subtrees are let go of then, so a write while it waits copies them (none known, with no
// subtreeOf: nothing). an awaited result is let go of when its promise lands (the scheduler's
// onRunReturn). open: an async function's reads after its first await are outside any run, so they
// are not known here
//
//   const stop = crowify(scheduler, crow, (key) => {
//     const where = places.describe(key)
//     return where?.path ? at(table.get(where.part, where.id)?.value, where.path) : undefined
//   })
//   updateEntry(crow, entry, patches, header)   // node's update, through crow (the entry its root)
//   const t = crowifyTable(table, crow)         // a table whose gets let go of what they give
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
	// each run going on → the values its tracked keys gave it
	const runs = new Map<unknown, Set<unknown>>()
	const offs = [
		scheduler.onRunStart((c) => void runs.set(c, new Set())),
		scheduler.onRunReturn((c, _n, value) => {
			const given = runs.get(c)
			crow.letGoIn(value, given?.size ? given : undefined)
		}),
		scheduler.onRunEnd((c, _n, ended) => {
			const given = runs.get(c)
			// it stopped to wait: what it read so far stays in its hands across the wait
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

// node's update through crow: the entry is the root written through; its value the one after, its
// change the header with the patches and their undo. a patch refused: it throws, nothing changes
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

// a table whose gets let go: each entry a get gives is let go of (crow's letGo) first. give it to
// whatever hands values out (places, an overlay); write through the table itself
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
		// (part, id): an entry, let go of; (part, entry): ids
		if (typeof b === "string" || typeof b === "symbol") {
			if (got !== undefined) crow.letGo(got as Entry<unknown>)
		}
		return got
	}
	return { ...table, get: get as Table["get"] }
}
