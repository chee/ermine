// patches to a node's value (op's apply), as the change given: the value they make, and the change
// with the patches and their undo (apply's undo option, invert.ts's) as its op. any patch invalid:
// it throws (ApplyError), and nothing changes
import apply, { type Patch } from "@ermine/op/apply"
import type { ChangeHeader, Node } from "./node.ts"

export type Options = {
	// as apply's: nothing there starts as [], and a list left empty is nothing there
	list?: boolean
}

// none there: a put at [] makes it; nothing left: the value removed. the node changes in place;
// the patches are kept on its change, not copied: never change them
export default function update<V>(
	node: Node<V>,
	patches: Iterable<Patch>,
	change: ChangeHeader,
	options: Options = {},
): void {
	const ps: readonly Patch[] = Array.isArray(patches) ? patches : [...patches]
	const undo: Patch[] = []
	const after = apply(node.value, ps, { list: options.list === true, undo })
	if (after === undefined) delete node.value
	else node.value = after as V
	node.change = { ...change, op: { patches: ps, undo } }
}
