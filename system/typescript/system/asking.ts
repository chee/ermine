import type { Id, Path } from "@ermine/places"
import { Refusal } from "@ermine/processes/guard"
import type { Target as Aimed } from "@ermine/protect"
import type { Key } from "@ermine/graph/table"
import type { Inner, Step, Target } from "../context.ts"
import { aimed, idOf, nodeOf } from "./addressing.ts"
import { here } from "./setting.ts"

export function mayRead(
	inner: Inner,
	id: Id,
	path: Path | undefined,
	part: Key,
	key?: readonly Step[],
) {
	if (inner.guarded) inner.guard.read(aimed(id, path, part, key))
}
export function refused(inner: Inner, id: Id, path: Path | undefined, part: Key) {
	try {
		mayRead(inner, id, path, part)
		return false
	} catch (e) {
		if (e instanceof Refusal) return true
		throw e
	}
}

// A node given a name in a folder is asked "place" of the slot, then read and edit of the node (and
// execute for an action), so a name cannot widen what anyone may do with it.
export function askPlacing(inner: Inner, slot: Aimed, x: Target, id: Id) {
	const { guard, guarded, methods } = here(inner)
	if (!guarded) return
	const node = aimed(id, nodeOf(inner, x).path, "value")
	guard.place(slot, node, methods.has(id) ? ["read", "edit", "execute"] : ["read", "edit"])
}
