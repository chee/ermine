// Applies patches to a changeable's value in place, and sets its change with the patches and
// their undo.
import apply, { type Patch } from "./apply.ts"
import type { Changeable, ChangeHeader } from "./changeable.ts"

export default function update<V>(
	entry: Changeable<V>,
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
