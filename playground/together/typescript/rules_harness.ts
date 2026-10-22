// the merge rules together's own suites and tests know: "serial/1", and "serial/2", the same rule
// under a newer version (for a device that knows one and not the other). a rule's name carries its
// version, "name/version", and a device knows a rule by that whole string; nothing parses it. a
// rule for testing merging, no rule anyone ships (one that is: playground/egwalker). a harness built
// with others is given its own (history_harness.ts's run, sync_harness.ts's run).
// c/rules_harness.c, the same in C.
//
// serial: every commit the heads follow (history.ts, follows), back to the roots, applied in causal
// order (lower lamport, then lesser name) to its table; one whose patches don't apply is left out
// whole. a table's change: the last commit applied to it. get is not asked: the same from any start
import apply from "@ermine/op/apply"
import { decode } from "@ermine/encoding/commit"
import { since } from "./history.ts"
import { changeOf, type Merge, type Merges, type Tables } from "./replay.ts"

export const serial: Merge = (history, heads) => {
	const tables: Tables = {}
	for (const k of since(history, heads, () => false).commits) {
		const c = decode(k.bytes)
		let value
		try {
			value = apply(tables[c.table]?.value, c.patches)
		} catch {
			continue
		}
		if (value === undefined) delete tables[c.table]
		else tables[c.table] = { value, change: changeOf(c, k.name) }
	}
	return tables
}

export const rules: Merges = { "serial/1": serial, "serial/2": serial }
