// unread's conformance hooks (unread_conformance_hook.c in C): what only the tests call. Not in the
// package's exports (deno.json), so only a path inside the repo reaches them. createUnread hands each
// unread's own owner lookup here as it makes it
import type { Entry } from "@ermine/node/entry"
import type { Unread } from "./unread.ts"

const owners = new WeakMap<Unread, (entry: Entry<unknown>) => object | undefined>()

// for createUnread only
export function keep(unread: Unread, owner: (entry: Entry<unknown>) => object | undefined) {
	owners.set(unread, owner)
}

// the entry's owner token now: what its writes copied since it was last read is owned while it maps
// to it; none: undefined
export function unread_conformance_hook_owned(
	unread: Unread,
	entry: Entry<unknown>,
): object | undefined {
	return owners.get(unread)?.(entry)
}
