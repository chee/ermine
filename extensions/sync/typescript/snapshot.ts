// a node's tables at a head, packed (extensions/subduction/plan.org, Rewrite for the new shape, 5):
// each kept table's entry, value and change, as pack.ts writes a node. read back as new objects
// each time: replay applies to them in place
import { pack, unpack } from "@ermine/encoding/pack"
import type { Tables } from "./replay.ts"

// the id a snapshot's entries are under: the node is the snapshot's, so none of its own
const AT = ""

export function snapshot(tables: Tables): Uint8Array {
	return pack(Object.entries(tables).map(([table, entry]) => [table, AT, entry] as const), {
		op: false,
	})
}

export function tablesOf(bytes: Uint8Array): Tables {
	const out: Tables = {}
	for (const [table, , entry] of unpack(bytes)) out[table as string] = entry
	return out
}
