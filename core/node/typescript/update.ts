import apply, { type Patch } from "@ermine/core/changeable/apply"
import type { ChangeHeader, Entry } from "./entry.ts"

export default function update<V>(
	entry: Entry<V>,
	patches: Iterable<Patch>,
	change: ChangeHeader,
): void {
	const ps: readonly Patch[] = Array.isArray(patches) ? patches : [...patches]
	const undo: Patch[] = []

	const after = apply(entry.value, ps, { undo })
	if (after === undefined) delete entry.value
	else entry.value = after as V
	entry.change = { ...change, op: { patches: ps, undo } }
}
