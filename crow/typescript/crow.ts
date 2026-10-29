// crow: copy referenced on write. a write onto a root's value changes in place what crow copied
// itself and no one else has; anything else it copies first (along the patches' paths only, as op's
// copy-on-write does) and owns the copies. so a burst of writes no one else sees costs one copy, and
// a write after someone else has the value costs what copy-on-write does
//
//   const crow = createCrow()
//   const { value, undo } = crow.update(root, value, patches)   // root: the thing written through
//   crow.letGo(root)                         // someone else has all of root's value: the next write copies
//   crow.letGoIn(value, subtrees)            // someone else has value: never changed in place after
//
// root: any object the caller picks to stand for what it writes through (the graph's: an entry); crow
// keys what it owns by it and never looks inside. letGo: all of a root's value, one token dropped;
// letGoIn: every container crow owns in value, with all under it, walked. a look that lets go again
// is not told, so it costs nothing: whoever lends says what outlives the loan (places' crowify).
// subtrees: containers in the value that came out of a root as crow left them, walked the cheap way
// (only crow's own copies, which hang together from the top); the rest of the value walked whole. a
// promise: a container the caller made itself is never one
//
// owned: only copies made here, from the root down along the paths written (a container's parent is
// owned when it is), and the list a span move takes out (op gives it to owned as it lands). never a
// patch's value (op puts it in as given: the caller's; an owned container in one, of any root, is let
// go first: a walk over every container in each patch's value), nor what a write takes out (its undo
// holds it): the next write through those copies them. a write that throws changes nothing, which
// container is where and what is owned too: what it lets go of first is put back
import apply, { type Patch } from "@ermine/changeable/apply"
import { isPojo, isTyped } from "@ermine/changeable/kinds"

export type Crow = {
	// patches onto value (what root holds now), in place where crow owns: the value after and the
	// undo (each patch's, the last one's first). a patch apply refuses: it throws, nothing changes
	update: (
		root: object,
		value: unknown,
		patches: Iterable<Patch>,
	) => { value: unknown; undo: Patch[] }
	// someone else has all of root's value: nothing under it is owned, the next write copies
	letGo: (root: object) => void
	// someone else has value (a computation's result, kept past now): every owned container in it
	// let go, with all under it. walked (lists, maps, typed arrays): one made by a run may hold what
	// a read gave. subtrees: containers in it as they came out of a root (a promise: none the caller
	// made); at one, what is owned under it is let go, no deeper
	letGoIn: (value: unknown, subtrees?: ReadonlySet<unknown>) => void
}

const container = (v: unknown): v is object => Array.isArray(v) || isPojo(v) || isTyped(v)

export function createCrow(): Crow {
	// a root → its token: made at its first write since it was let go of
	const owns = new WeakMap<object, object>()
	// a copy → the token it was made under: owned while that is its root's token. one record per
	// copy; letGo gives the root a new token, letting go of all of it at once
	const owner = new WeakMap<object, object>()
	// in a write, before it lands: what it let go of (each copy, then its token), put back if
	// it throws, so ownership changes only once the write has
	const gone: object[] = []
	let noting = false

	// v owned no longer (noting: noted); whether it was
	const out = (v: object): boolean => {
		if (!noting) return owner.delete(v)
		const t = owner.get(v)
		if (t === undefined) return false
		gone.push(v, t)
		return owner.delete(v)
	}

	// apply's owned: a container a write changes, owned, or its copy, owned from now
	const take = (mine: object) => (v: object): object => {
		if (owner.get(v) === mine) return v
		const c = Array.isArray(v) || isTyped(v) ? v.slice() : { ...v }
		owner.set(c, mine)
		return c
	}

	// what a write took out (its undo holds it) no longer owned: owned containers are connected
	// from the root, so only those are walked, under the top (a span's undo: a list made for it)
	function free(v: unknown, mine: object, top = true) {
		if (!container(v)) return
		const was = owner.get(v) === mine
		if (was) owner.delete(v)
		if (!was && !top || isTyped(v)) return
		for (const x of Array.isArray(v) ? v : Object.values(v)) free(x, mine, false)
	}

	function update(root: object, value: unknown, patches: Iterable<Patch>) {
		const ps: readonly Patch[] = Array.isArray(patches) ? patches : [...patches]
		// what is let go of before the apply is noted, and put back if it throws
		const was = owns.get(root)
		noting = true
		const undo: Patch[] = []
		let after: unknown
		try {
			// what a patch puts is the caller's from now: nothing in it owned
			for (const p of ps) {
				if (p !== null && typeof p === "object" && "value" in p && container(p.value)) {
					letGoAll(p.value)
				}
			}
			let mine = owns.get(root)
			if (mine === undefined) owns.set(root, mine = {})
			// one apply, in place where owned: what a patch changes that is not owned yet is copied
			// as it lands, in the tree the patches before it left (one may move a subtree, or put a
			// value in, that the next writes under). a throw changes nothing, what is owned too
			after = apply(value, ps, { undo, cow: false, owned: take(mine) })
		} catch (e) {
			for (let i = 0; i < gone.length; i += 2) owner.set(gone[i], gone[i + 1])
			if (was === undefined) owns.delete(root)
			else owns.set(root, was)
			throw e
		} finally {
			noting = false
			gone.length = 0
		}
		const mine = owns.get(root)!
		for (const u of undo) if ("value" in u) free(u.value, mine)
		return { value: after, undo }
	}

	// what is owned under v let go, v too: owned copies are connected from the root, so only those
	// are walked
	function drop(v: unknown) {
		if (!container(v) || !out(v) || isTyped(v)) return
		if (Array.isArray(v)) { for (const x of v) drop(x) }
		else for (const k in v) drop((v as Record<string, unknown>)[k])
	}

	// every container in v let go; at one of subtrees, what is owned under it, no deeper. what was
	// walked is noted from the first step into a container (a value a run made may share, or
	// loop), so a plain or flat one makes nothing
	function letGoAll(v: unknown, subtrees?: ReadonlySet<unknown>, seen?: Set<object>) {
		if (!container(v)) return
		if (subtrees?.has(v)) return drop(v)
		if (seen !== undefined) {
			if (seen.has(v)) return
			seen.add(v)
		}
		out(v)
		if (isTyped(v)) return
		if (Array.isArray(v)) {
			for (const x of v) if (container(x)) letGoAll(x, subtrees, seen ??= new Set([v]))
		} else {
			for (const k in v) {
				const x = (v as Record<string, unknown>)[k]
				if (container(x)) letGoAll(x, subtrees, seen ??= new Set([v]))
			}
		}
	}

	return {
		update,
		letGo: (root) => void owns.delete(root),
		letGoIn: (value, subtrees) => letGoAll(value, subtrees),
	}
}
