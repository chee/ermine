// patches to a node's value (op's apply), as the change given: the value they make, and the change
// with the patches and their undo (op's invert) as its op. any patch invalid: it throws
// (ApplyError), and nothing changes
import apply, { type Facts, type Patch } from "@ermine/op/apply"
import invert from "@ermine/op/invert"
import type { ChangeHeader, Node } from "./node.ts"

export type Options = {
	// told of each patch once all have landed and the node has its value, in order, with what it
	// found (op's facts)
	each?: (patch: Patch, facts: Facts) => void
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
	const list = options.list === true
	const seen: [Patch, Facts][] = []
	const before = node.value
	const after = apply(before, ps, {
		list,
		each: options.each ? (p, f) => void seen.push([p, f]) : undefined,
	})
	const undo = invert(before, ps, { list })
	if (after === undefined) delete node.value
	else node.value = after as V
	node.change = { ...change, op: { patches: ps, undo } }
	for (const [p, f] of seen) options.each!(p, f)
}
