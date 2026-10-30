// what crow's tests write through: a root, a plain object standing for the value it holds and the
// undo of the last write that landed. crow's own api, nothing above it
import type { Patch } from "@ermine/changeable/apply"
import type { Crow } from "./crow.ts"

export type Root = { value?: unknown; undo?: Patch[] }

// a root holding value (none: nothing there)
export const createRoot = (value?: unknown): Root => value === undefined ? {} : { value }

// crow's update on the root's value: the value after in the root, the undo kept. a patch refused:
// it throws, the root as it was
export function write(crow: Crow, root: Root, patches: Iterable<Patch>) {
	const { value, undo } = crow.update(root, root.value, patches)
	if (value === undefined) delete root.value
	else root.value = value
	root.undo = undo
}
