import type { Id, Path } from "@ermine/core/places"
import { Refusal } from "@ermine/core/places/guard"
import type { Target as Aimed } from "@ermine/core/protect"
import type { Key } from "@ermine/core/table"
import type { Inner, Step, Target } from "../context.ts"
import { aimed, idOf, nodeOf } from "./addressing.ts"
import { here } from "./setting.ts"

// the policy asked "read" of id's part (and a key in it), reached by path: a Refusal when it says
// no, PENDING when it cannot say yet. a write is asked as context's ask has it
export function mayRead(
	inner: Inner,
	id: Id,
	path: Path | undefined,
	part: Key,
	key?: readonly Step[],
) {
	if (inner.guarded) inner.guard.read(aimed(id, path, part, key))
}
// whether the policy refuses the read, asked as mayRead asks (a pending answer: PENDING thrown)
export function refused(inner: Inner, id: Id, path: Path | undefined, part: Key) {
	try {
		mayRead(inner, id, path, part)
		return false
	} catch (e) {
		if (e instanceof Refusal) return true
		throw e
	}
}

// a node already there given a name in a folder: asked as inner "place" of the
// slot with the node beside, then read and edit of the node (an action's: execute too), so a name
// can't widen what anyone may do with it [chee 10-26: "we will do it the protected_hardlinks way
// for now, it's better to over- than under-"]. x: the node as it was given (the path it came by)
export function askPlacing(inner: Inner, slot: Aimed, x: Target, id: Id) {
	const { guard, guarded, methods } = here(inner)
	if (!guarded) return
	const node = aimed(id, nodeOf(inner, x).path, "value")
	guard.place(slot, node, methods.has(id) ? ["read", "edit", "execute"] : ["read", "edit"])
}
