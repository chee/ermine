// Returns the patches that undo a patch list, in the order to apply them. Patches apply refuses
// throw its ApplyError. The result shares values with the input, so don't change it.
import apply, { type Patch } from "./apply.ts"

export default function invert(value: unknown, patches: Iterable<Patch>): Patch[] {
	const undo: Patch[] = []
	apply(value, patches, { undo })
	return undo
}
