// a holder in memory: a log (log.ts) and the pokes of whoever watches it
//   const m = createMemory()                         // lists, takes anything well named
//   const n = createMemory({ lists: false })         // asked only by node: get, never since
//   const o = createMemory({ refuse: (w) => w.node === "secret" ? "not-here" : undefined })
// deno-lint-ignore-file require-await -- memory answers at once; async so it is a holder like any
import type { Holder, Outcome } from "./holder.ts"
import { createLog } from "./log.ts"
import type { Write } from "./write.ts"

export type MemoryOptions = {
	// false: it can't list, so it has no since (a holder whose names are hashes, as Subduction's)
	lists?: boolean
	// the holder's own say on a write: why it won't take it, or undefined to take it
	refuse?: (write: Write) => string | undefined
}

export type Memory = Holder & { readonly writes: () => Write[] }

export function createMemory(options: MemoryOptions = {}): Memory {
	const log = createLog()
	const pokes = new Set<() => void>()
	const poke = () => [...pokes].forEach((p) => p())

	async function put(writes: readonly Write[]): Promise<Outcome[]> {
		const out = writes.map((w): Outcome => {
			const said = log.check(w)
			if (said !== undefined) return said
			const why = options.refuse?.(w)
			if (why !== undefined) return { refused: why }
			log.add(w)
			return "taken"
		})
		if (out.includes("taken")) poke()
		return out
	}

	const holder: Memory = {
		get: async (node) => log.get(node),
		put,
		drop: async (node) => void log.remove((w) => w.node === node),
		watch(p) {
			pokes.add(p)
			return () => void pokes.delete(p)
		},
		writes: log.all,
	}
	if (options.lists !== false) holder.since = async (cursor, limit) => log.since(cursor, limit)
	return holder
}
