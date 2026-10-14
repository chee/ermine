import apply, { type Patch } from "@ermine/op/apply"
import type { ChangeHeader, Node } from "./node.ts"

export default function update<V>(
	node: Node<V>,
	patches: Iterable<Patch>,
	change: ChangeHeader,
): void {
	const ps: readonly Patch[] = Array.isArray(patches) ? patches : [...patches]
	const undo: Patch[] = []

	const after = apply(node.value, ps, {
		// lol, c shit going on here, passing a thing to mutate
		undo,
		cow: node.cow !== false,
	})
	if (after === undefined) delete node.value
	else node.value = after as V
	node.change = { ...change, op: { patches: ps, undo } }
}
