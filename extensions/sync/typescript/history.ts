// one node's history (extensions/subduction/plan.org, Rewrite for the new shape, 3): its commits
// as their bytes, each taken in once its parents are, its heads in the agreed order, what waits on
// a parent and what is refused. no values: what a head holds is the table's (the head shown) or
// replay's (replay.ts), worked out from the bytes when asked, so nothing here is ever shared with
// what changes.
//
// taking a commit in: its bytes decoded (a commit's shape, commit.ts), its parents all here and
// taken (else it waits), its lamport above theirs, and check (the integration's: do its patches
// apply to its parent's node) says yes. a commit taken in releases what waited on it, in order
//
// beside it, for merge rules: what a commit's tables follow from (follows), and the commits since a
// set of heads' common ancestor, in causal order (since)
import { type Commit, compare, decode, name as nameOf } from "@ermine/encoding/commit"
import { hex } from "./hex.ts"

// merge: a merge commit by a rule this device doesn't know
export type Refusal = "shape" | "lamport" | "patches" | "parent" | "merge"

export type Added =
	| "taken"
	| "passed"
	| { waiting: string[] }
	| { refused: Refusal }

// what a commit is kept as: its bytes, and what ordering and replay read without decoding again
export type Kept = {
	name: Uint8Array
	bytes: Uint8Array
	table: string
	parents: Uint8Array[]
	// the parent its patches are over: the only one, or the base of several; none for a root or a
	// merge
	base: Uint8Array | undefined
	// a merge commit's rule: its patches are over the merge of its parents
	merge: string | undefined
	lamport: number
}

export type History = {
	// the commit's bytes: taken in, waiting, refused or passed (here already). made: its commit and
	// name, from whoever just encoded it (this device's own): not decoded or named again
	add(bytes: Uint8Array, made?: { commit: Commit; name: Uint8Array }): Added
	// the heads, in the agreed order: higher lamport first; equal, the greater name
	heads(): Kept[]
	get(name: Uint8Array): Kept | undefined
	// told each commit taken in, in the order taken, released ones too
	taken(f: (kept: Kept) => void): () => void
	waiting(): { name: string; waiting: string[] }[]
	refused(): { name: string; refused: Refusal }[]
	// every commit taken in, in the order taken
	all(): Kept[]
	// a head taken in let go of, as if never told of it: its parents heads again where nothing else
	// goes on them. false: not taken, or something goes on it
	forget(name: Uint8Array): boolean
}

// check: given a commit whose parents are all taken, whether its patches apply to its parent's
// node (the integration's, which may apply them as it looks); false is refused "patches", a refusal
// is refused so
export function createHistory(
	check: (kept: Kept, commit: Commit) => boolean | Refusal = () => true,
): History {
	const taken = new Map<string, Kept>()
	const order: Kept[] = []
	const heads = new Set<string>()
	// how many taken commits go on each one, where any do
	const children = new Map<string, number>()
	// a commit not taken in yet: its own, and the names it waits on
	const waits = new Map<string, { kept: Kept; commit: Commit; on: Set<string> }>()
	const waiters = new Map<string, Set<string>>()
	const refusals = new Map<string, Refusal>()
	const listeners = new Set<(kept: Kept) => void>()

	function refuse(n: string, why: Refusal) {
		refusals.set(n, why)
		// what waits on a refused commit never comes in
		for (const w of waiters.get(n) ?? []) {
			const x = waits.get(w)
			if (x === undefined) continue
			waits.delete(w)
			refuse(w, "parent")
		}
		waiters.delete(n)
	}

	// parents all taken: the lamport, then check; taken, then what waited on it
	function settle(kept: Kept, commit: Commit): Added {
		const n = hex(kept.name)
		const top = Math.max(0, ...kept.parents.map((p) => taken.get(hex(p))!.lamport))
		if (kept.lamport <= top) {
			refuse(n, "lamport")
			return { refused: "lamport" }
		}
		const ok = check(kept, commit)
		if (ok !== true) {
			const why = ok === false ? "patches" : ok
			refuse(n, why)
			return { refused: why }
		}
		taken.set(n, kept)
		order.push(kept)
		for (const p of kept.parents) {
			const h = hex(p)
			heads.delete(h)
			children.set(h, (children.get(h) ?? 0) + 1)
		}
		heads.add(n)
		for (const f of listeners) f(kept)
		for (const w of waiters.get(n) ?? []) {
			const x = waits.get(w)
			if (x === undefined) continue
			x.on.delete(n)
			if (x.on.size === 0) {
				waits.delete(w)
				settle(x.kept, x.commit)
			}
		}
		waiters.delete(n)
		return "taken"
	}

	return {
		add(bytes, made) {
			const name = made?.name ?? nameOf(bytes), n = hex(name)
			if (taken.has(n) || waits.has(n)) return "passed"
			const was = refusals.get(n)
			if (was !== undefined) return { refused: was }
			let commit: Commit
			if (made) commit = made.commit
			else {
				try {
					commit = decode(bytes)
				} catch {
					refusals.set(n, "shape")
					return { refused: "shape" }
				}
			}
			const kept: Kept = {
				name,
				bytes,
				table: commit.table,
				parents: commit.parents,
				base: commit.merge === undefined ? commit.base ?? commit.parents[0] : undefined,
				merge: commit.merge,
				lamport: commit.lamport,
			}
			for (const p of commit.parents) {
				if (refusals.has(hex(p))) {
					refuse(n, "parent")
					return { refused: "parent" }
				}
			}
			const missing = commit.parents.map(hex).filter((p) => !taken.has(p))
			if (missing.length) {
				waits.set(n, { kept, commit, on: new Set(missing) })
				for (const p of missing) {
					let s = waiters.get(p)
					if (!s) waiters.set(p, s = new Set())
					s.add(n)
				}
				return { waiting: missing }
			}
			return settle(kept, commit)
		},
		heads: () => [...heads].map((n) => taken.get(n)!).sort(agreed),
		get: (name) => taken.get(hex(name)),
		taken(f) {
			listeners.add(f)
			return () => void listeners.delete(f)
		},
		waiting: () => [...waits].map(([name, w]) => ({ name, waiting: [...w.on] })),
		refused: () => [...refusals].map(([name, refused]) => ({ name, refused })),
		all: () => order.slice(),
		forget(name) {
			const n = hex(name), kept = taken.get(n)
			if (kept === undefined || children.has(n)) return false
			taken.delete(n)
			heads.delete(n)
			// most often among the last taken
			const i = order.lastIndexOf(kept)
			if (i >= 0) order.splice(i, 1)
			for (const p of kept.parents) {
				const h = hex(p), c = children.get(h)! - 1
				if (c > 0) children.set(h, c)
				else {
					children.delete(h)
					if (taken.has(h)) heads.add(h)
				}
			}
			return true
		},
	}
}

// the agreed order: higher lamport first; equal, the greater name
export const agreed = (a: Kept, b: Kept) =>
	a.lamport !== b.lamport ? b.lamport - a.lamport : compare(b.name, a.name)

// what a commit's tables follow from: a merge's parents, else its base (a commit with a base keeps
// what that one held, whatever its other parents did), else nothing (a root)
export function follows(k: Kept): Uint8Array[] {
	if (k.merge !== undefined) return k.parents
	return k.base === undefined ? [] : [k.base]
}

// the commits since heads' common ancestors, along follows. walked back from the heads in the
// agreed order, a frontier of what is not walked yet; from: the first frontier that every commit
// walked follows from, all of it (so nothing since is beside it), and known says its tables can be
// had (one commit's, or several merged). a frontier of one commit is such once no root is walked;
// none: from nothing (empty), every commit back to the roots. from in the agreed order; commits: the
// ones walked, in causal
// order, lower lamport first, equal lamport the lesser name first
export function since(
	history: History,
	heads: readonly Kept[],
	known: (from: readonly Kept[]) => boolean = () => true,
): { from: Kept[]; commits: Kept[] } {
	const frontier = new Map<string, Kept>()
	for (const k of heads) frontier.set(hex(k.name), k)
	const walked: Kept[] = [], seen = new Set<string>()
	let root = false
	// every commit walked follows from all of the frontier
	const under = () => {
		const reach = new Map<string, Set<string>>()
		for (let i = walked.length - 1; i >= 0; i--) {
			const got = new Set<string>()
			for (const p of follows(walked[i])) {
				const h = hex(p)
				if (frontier.has(h)) got.add(h)
				else for (const x of reach.get(h) ?? []) got.add(x)
			}
			if (got.size !== frontier.size) return false
			reach.set(hex(walked[i].name), got)
		}
		return true
	}
	for (;;) {
		if (frontier.size === 0) return { from: [], commits: walked.reverse() }
		if (!root) {
			const from = [...frontier.values()].sort(agreed)
			if ((from.length === 1 || walked.length === 0) && known(from)) {
				return { from, commits: walked.reverse() }
			}
			if (from.length > 1 && walked.length > 0 && known(from) && under()) {
				return { from, commits: walked.reverse() }
			}
		}
		let top: Kept | undefined
		for (const k of frontier.values()) if (top === undefined || agreed(k, top) < 0) top = k
		const n = hex(top!.name)
		frontier.delete(n)
		seen.add(n)
		walked.push(top!)
		const up = follows(top!)
		if (up.length === 0) root = true
		for (const p of up) {
			const h = hex(p)
			if (seen.has(h) || frontier.has(h)) continue
			const k = history.get(p)
			if (k !== undefined) frontier.set(h, k)
		}
	}
}
