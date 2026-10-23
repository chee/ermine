// the smallest history: one graph's writes named and given parents, so holders can hold them. it
// is itself a holder (holder.ts), the graph's side of every link. one way of doing history, this
// experiment's own; the graph's side is fixed: writes out through places.watchAll, changes in at a
// node, a part and patches
//
//   const history = createHistory({ table, places })   // made before the graph's first write
//   createLink(history, createMemory()).start()
//
// out: each fact as it lands (places.watchAll) at a string id is a write, its parents the part's
// heads then, and it becomes the one head. a fact with something no encoding has (a function, a
// symbol) is not named, and is counted in skipped
//
// in: put takes a write whose parents are held. on top of the heads (its parents are all of them),
// its patches land as they are. beside them (made at the same time as another), the part's whole
// history is played again, in one order every graph finds the same (parents first; of writes
// ready together, the lower name first), and the value that gives lands as one patch, so every
// graph holding the same writes holds the same value. a write's own patches that don't apply
// there are passed over in the playing
//
// echo: a write landing here is told back by watchAll; facts at its node and part while it lands
// are its own, never named again
// deno-lint-ignore-file require-await -- the graph answers at once; async so it is a holder like any
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import type { Fact, Places } from "@ermine/places"
import type { Key, Table } from "@ermine/table"
import type { Holder, Outcome } from "./holder.ts"
import { createLog } from "./log.ts"
import { fresh, name, same, type Write } from "./write.ts"

export type History = Holder & {
	// the names of a part's heads now, sorted: one, unless writes made at once came in
	readonly heads: (node: string, part: Key) => string[]
	// the facts that could not be named
	readonly skipped: () => number
	readonly writes: () => Write[]
	// the history stops recording
	stop(): void
}

export function createHistory(
	setup: {
		table: Pick<Table, "get" | "add" | "del">
		places: Pick<Places, "watchAll" | "commit">
	},
): History {
	const { table, places } = setup
	const log = createLog()
	const pokes = new Set<() => void>()
	const poke = () => [...pokes].forEach((p) => p())
	let skipped = 0

	// node → part → the names of its heads
	const tips = new Map<string, Map<Key, Set<string>>>()
	function headsOf(node: string, part: Key): Set<string> {
		let parts = tips.get(node)
		if (parts === undefined) tips.set(node, parts = new Map())
		let set = parts.get(part)
		if (set === undefined) parts.set(part, set = new Set())
		return set
	}

	// the node and part a write is landing at, while it lands
	let landing: { node: string; part: Key } | undefined

	function record(fact: Fact) {
		if (typeof fact.id !== "string") return
		if (landing && landing.node === fact.id && landing.part === fact.part) return
		const heads = headsOf(fact.id, fact.part)
		let write: Write
		try {
			write = name({
				node: fact.id,
				part: fact.part,
				parents: [...heads],
				patches: fact.patches,
				change: changeOf(fact.change),
			})
		} catch {
			skipped++
			return
		}
		log.add(write)
		heads.clear()
		heads.add(write.name)
		poke()
	}

	const stop = places.watchAll(record)

	// every write of one part, played again in the one order, from nothing: the value it gives
	function replay(node: string, part: Key): unknown {
		const writes = log.get(node).filter((w) => w.part === part)
		const waiting = new Map(writes.map((w) => [w.name, new Set(w.parents)]))
		let value: unknown
		while (waiting.size) {
			const ready = writes.filter((w) => waiting.get(w.name)?.size === 0)
				.sort((a, b) => a.name < b.name ? -1 : 1)
			const next = ready[0]
			waiting.delete(next.name)
			for (const parents of waiting.values()) parents.delete(next.name)
			try {
				value = apply(value, next.patches)
			} catch { /* passed over */ }
		}
		return value
	}

	// the patches that make the graph hold the part's history played again; none: it holds it
	function merged(node: string, part: Key): Patch[] {
		const value = replay(node, part)
		if (same(value, table.get(part, node)?.value)) return []
		// fresh: the played value shares the held writes' values (see write.ts' name)
		return [value === undefined ? { path: [] } : { path: [], value: fresh(value) }]
	}

	// patches landed at the write's node and part, as the write's own change says, told as one
	// write. nothing left there after: the entry taken out
	function land(write: Write, patches: Patch[]) {
		const { node, part } = write
		const header = fresh(write.change) as ChangeHeader
		const entry = table.get(part, node) as Entry<unknown> | undefined
		const after = apply(entry?.value, patches)
		landing = { node, part }
		try {
			if (entry === undefined) {
				if (after !== undefined) table.add(part, node, createEntry(after, header) as never)
			} else if (after === undefined) table.del(part, node)
			else {
				update(entry, patches, header)
				places.commit([entry])
			}
		} finally {
			landing = undefined
		}
	}

	function take(write: Write) {
		const heads = headsOf(write.node, write.part)
		const onTop = write.parents.length === heads.size && write.parents.every((p) => heads.has(p))
		log.add(write)
		for (const p of write.parents) heads.delete(p)
		heads.add(write.name)
		if (onTop) {
			try {
				return land(write, fresh([...write.patches]))
			} catch { /* doesn't apply here: played again below */ }
		}
		const patches = merged(write.node, write.part)
		if (patches.length) land(write, patches)
	}

	async function put(writes: readonly Write[]): Promise<Outcome[]> {
		const out = writes.map((w): Outcome => {
			const said = log.check(w)
			if (said !== undefined) return said
			take(w)
			return "taken"
		})
		if (out.includes("taken")) poke()
		return out
	}

	return {
		since: async (cursor, limit) => log.since(cursor, limit),
		get: async (node) => log.get(node),
		put,
		// the node's writes and heads let go of; its value in the graph stays
		async drop(node) {
			log.remove((w) => w.node === node)
			tips.delete(node)
		},
		watch(p) {
			pokes.add(p)
			return () => void pokes.delete(p)
		},
		heads: (node, part) => [...headsOf(node, part)].sort(),
		skipped: () => skipped,
		writes: log.all,
		stop,
	}
}

// what of a fact's change travels. none (an entry taken out with no scope open: places makes a
// removal's change from the scope open, its site table.del's caller, and with none open has none):
// a change made here, now, by no one
function changeOf(change: ChangeHeader | undefined): Omit<ChangeHeader, "op"> {
	if (change === undefined) return { time: Math.floor(Date.now() / 1000), actor: null }
	const { op: _, ...rest } = change
	return rest
}
