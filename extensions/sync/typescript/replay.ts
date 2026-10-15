// a node's tables at a commit (extensions/subduction/plan.org, Rewrite for the new shape, 4): back
// along the bases to the newest snapshot (or the root), then forward, each commit decoded from its
// bytes and applied to its table in place. everything built here is new: decoded from bytes,
// shared with nothing, so applying in place costs the patches, not the tables. for a head that
// doesn't show (conflicts), a head switch, a version (ermine://id/commit/…)
import apply from "@ermine/op/apply"
import { type Commit, decode } from "@ermine/encoding/commit"
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import type { History } from "./history.ts"

// each table's entry: its value, and the change that last touched it
export type Tables = Record<string, Entry<unknown>>

// the tables at a commit, when a snapshot of them is kept: new objects each time asked
export type Snapshots = (name: Uint8Array) => Tables | undefined

// a commit's change header, as the graph has one
export function changeOf(c: Commit): ChangeHeader {
	const h: ChangeHeader = { time: c.time, actor: c.actor }
	if (c.reader !== undefined) h.reader = c.reader
	if (c.external !== undefined) h.external = c.external
	if (c.metadata !== undefined) h.metadata = c.metadata
	return h
}

// the tables at name; undefined: not taken in
export function replay(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots = () => undefined,
): Tables | undefined {
	if (history.get(name) === undefined) return
	const line: Uint8Array[] = []
	let tables: Tables = {}
	for (let k = history.get(name); k !== undefined;) {
		const s = snapshot(k.name)
		if (s !== undefined) {
			tables = s
			break
		}
		line.push(k.bytes)
		k = k.base === undefined ? undefined : history.get(k.base)
	}
	for (let i = line.length - 1; i >= 0; i--) {
		const c = decode(line[i])
		const value = apply(tables[c.table]?.value, c.patches, { cow: false })
		if (value === undefined) delete tables[c.table]
		else tables[c.table] = { value, change: changeOf(c) }
	}
	return tables
}
