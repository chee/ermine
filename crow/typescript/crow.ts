// Copy referenced on write. A write changes in place what crow itself copied and nobody else
// has, and copies anything else first, along the patches' paths only. So a burst of writes no one
// else sees costs one copy.
//
//   const crow = createCrow()
//   const { value, undo } = crow.update(root, value, patches)   // root: the thing written through
//   crow.letGo(root)                         // someone else has all of root's value
//   crow.letGoIn(value, subtrees)            // someone else has value
//
// root is any object standing for what is written through (the graph uses an entry); crow only
// uses it as a key. subtrees are containers in the value that came out of a root as crow left
// them, which can be walked cheaply (only crow's own copies). Promise: a container the caller
// made itself is never one.
//
// Owned: copies made here, and lists a span move takes out. Never a patch's value (any owned
// container in one is let go first) nor what a write takes out (its undo holds it). A write that
// throws changes nothing, including what is owned.
import apply, { type Patch } from "@ermine/changeable/apply"
import { isPojo, isTyped } from "@ermine/changeable/kinds"

export type Crow = {
	// Applies patches to value (what root holds now), in place where crow owns it. Returns the value
	// after and the undo (each patch's, the last one's first). Throws, changing nothing, if apply
	// refuses a patch.
	update: (
		root: object,
		value: unknown,
		patches: Iterable<Patch>,
	) => { value: unknown; undo: Patch[] }
	// Someone else has all of root's value: nothing under it is owned, so the next write copies.
	letGo: (root: object) => void
	// Someone else has value (such as a computation's result): every owned container in it is let
	// go, with all under it. subtrees are containers as they came out of a root; at one, only what
	// is owned under it is let go.
	letGoIn: (value: unknown, subtrees?: ReadonlySet<unknown>) => void
}

const container = (v: unknown): v is object => Array.isArray(v) || isPojo(v) || isTyped(v)

export function createCrow(): Crow {
	const owns = new WeakMap<object, object>()
	const owner = new WeakMap<object, object>()
	const gone: object[] = []
	let noting = false

	const out = (v: object): boolean => {
		if (!noting) return owner.delete(v)
		const t = owner.get(v)
		if (t === undefined) return false
		gone.push(v, t)
		return owner.delete(v)
	}

	const take = (mine: object) => (v: object): object => {
		if (owner.get(v) === mine) return v
		const c = Array.isArray(v) || isTyped(v) ? v.slice() : { ...v }
		owner.set(c, mine)
		return c
	}

	// What a write took out (its undo holds it) is no longer owned. Owned containers are connected
	// from the root, so only those are walked, below the top.
	function free(v: unknown, mine: object, top = true) {
		if (!container(v)) return
		const was = owner.get(v) === mine
		if (was) owner.delete(v)
		if (!was && !top || isTyped(v)) return
		for (const x of Array.isArray(v) ? v : Object.values(v)) free(x, mine, false)
	}

	function update(root: object, value: unknown, patches: Iterable<Patch>) {
		const ps: readonly Patch[] = Array.isArray(patches) ? patches : [...patches]
		const was = owns.get(root)
		noting = true
		const undo: Patch[] = []
		let after: unknown
		try {
			for (const p of ps) {
				if (p !== null && typeof p === "object" && "value" in p && container(p.value)) {
					letGoAll(p.value)
				}
			}
			let mine = owns.get(root)
			if (mine === undefined) owns.set(root, mine = {})
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

	function drop(v: unknown) {
		if (!container(v) || !out(v) || isTyped(v)) return
		if (Array.isArray(v)) { for (const x of v) drop(x) }
		else for (const k in v) drop((v as Record<string, unknown>)[k])
	}

	// Lets go of every container in v. At one of subtrees, only what is owned under it is let go.
	// Containers seen are noted from the first step into a container, since a value a run made may
	// share or loop, so a plain or flat value makes nothing.
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
