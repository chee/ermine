// the undo of patches: the patches that take what they make back to the value they were given
//   apply(apply(value, patches, o), invert(value, patches, o), o): value
// on apply's terms (apply.ts): undefined is nothing there, the list option is apply's, a string's
// positions are code points. patches apply refuses: its ApplyError, thrown (apply decides). the
// list option given a value not a list: the undo puts it back, which the list option refuses
// the undo is in the order to apply it, the last patch's first. a patch may take several, or
// none (a removal of a missing map key). a map's key put back goes last in its order: patches
// cannot place a key (the canonical encoding sorts keys anyway)
// a move moves back where that is exact; else what it put is undone and what it took put back
// what the undo holds is shared with the value and the patches: never change it
// apply builds it as the patches land (its undo option): this is that, as a function
import apply, { type Patch } from "./apply.ts"

export type Options = {
	// apply's: nothing there starts as [], anything but a list is wrong-kind, a list left empty is
	// nothing
	list?: boolean
}

// the undo of the patches on value, in the order to apply it
export default function invert(
	value: unknown,
	patches: Iterable<Patch>,
	options: Options = {},
): Patch[] {
	const undo: Patch[] = []
	apply(value, patches, { list: options.list === true, undo })
	return undo
}
