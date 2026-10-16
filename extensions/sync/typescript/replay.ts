// a node's tables at a commit (extensions/subduction/plan.org, Rewrite for the new shape, 4): back
// along the bases to the newest snapshot (or the root), then forward, each commit decoded from its
// bytes and applied to its table in place. everything built here is new: decoded from bytes,
// shared with nothing, so applying in place costs the patches, not the tables. for a head that
// doesn't show (conflicts), a head switch, a version (ermine://id/commit/…)
//
// a merge commit on the way back: its tables are its rule's merge of its parents, given merges;
// the walk starts there. a rule is given only what is had without merging (a snapshot, or a walk
// back to one or the root that meets no merge commit), so a merge never waits on another
import apply from "@ermine/op/apply"
import { type Commit, decode } from "@ermine/encoding/commit"
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import type { History, Kept } from "./history.ts"

// each table's entry: its value, and the change that last touched it
export type Tables = Record<string, Entry<unknown>>

// the tables at a commit, when a snapshot of them is kept: new objects each time asked
export type Snapshots = (name: Uint8Array) => Tables | undefined

// a merge rule: the tables of a node's heads merged, the same on every device. pure: it changes
// nothing it is given and keeps nothing. get: the tables at a commit, or at several merged by this
// rule, when they are had without merging (new objects each time); else undefined. keeping, when
// a rule has it: a merge by the same rule for one node's history that keeps its work between calls
// (not pure), giving the same tables; for a device merging a node again and again as it grows
export type Merge =
	& ((
		history: History,
		heads: readonly Kept[],
		get: (names: readonly Uint8Array[]) => Tables | undefined,
	) => Tables)
	& { keeping?: () => Merge }

// the rules a device knows, by name
export type Merges = Readonly<Record<string, Merge>>

// a commit's change header, as the graph has one
export function changeOf(c: Commit): ChangeHeader {
	const h: ChangeHeader = { time: c.time, actor: c.actor }
	if (c.reader !== undefined) h.reader = c.reader
	if (c.external !== undefined) h.external = c.external
	if (c.metadata !== undefined) h.metadata = c.metadata
	return h
}

// the tables at name; undefined: not taken in, or a merge on the way by a rule not given
export function replay(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots = () => undefined,
	merges?: Merges,
): Tables | undefined {
	return walk(history, name, snapshot, merges ?? {}, true)
}

// the tables at name when they are had without merging: a snapshot, or a walk back to one or the
// root that meets no merge commit; else undefined. what a rule is given
export function plain(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots = () => undefined,
): Tables | undefined {
	return walk(history, name, snapshot, {}, false)
}

// merging: a merge commit met is merged; else the walk gives undefined
function walk(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots,
	merges: Merges,
	merging: boolean,
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
		if (k.merge !== undefined) {
			const rule = merges[k.merge]
			if (!merging || rule === undefined) return
			const heads = k.parents.map((p) => history.get(p)!)
			tables = rule(
				history,
				heads,
				(ns) => ns.length === 1 ? walk(history, ns[0], snapshot, merges, false) : undefined,
			)
			break
		}
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
