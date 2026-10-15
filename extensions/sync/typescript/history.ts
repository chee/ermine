// one node's history (extensions/subduction/plan.org, Rewrite for the new shape, 3): its commits
// as their bytes, each taken in once its parents are, its heads in the agreed order, what waits on
// a parent and what is refused. no values: what a head holds is the table's (the head shown) or
// replay's (replay.ts), worked out from the bytes when asked, so nothing here is ever shared with
// what changes.
//
// taking a commit in: its bytes decoded (a commit's shape, commit.ts), its parents all here and
// taken (else it waits), its lamport above theirs, and check (the integration's: do its patches
// apply to its parent's node) says yes. a commit taken in releases what waited on it, in order
import { type Commit, compare, decode, name as nameOf } from "@ermine/encoding/commit"
import { hex } from "./hex.ts"

export type Refusal = "shape" | "lamport" | "patches" | "parent"

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
	base: Uint8Array | undefined
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
}

// check: given a commit whose parents are all taken, whether its patches apply to its parent's
// node (the integration's, which may apply them as it looks)
export function createHistory(
	check: (kept: Kept, commit: Commit) => boolean = () => true,
): History {
	const taken = new Map<string, Kept>()
	const order: Kept[] = []
	const heads = new Set<string>()
	// a commit not taken in yet: its own, and the names it waits on
	const waits = new Map<string, { kept: Kept; commit: Commit; on: Set<string> }>()
	const waiters = new Map<string, Set<string>>()
	const refusals = new Map<string, Refusal>()
	const listeners = new Set<(kept: Kept) => void>()

	const agreed = (a: Kept, b: Kept) =>
		a.lamport !== b.lamport ? b.lamport - a.lamport : compare(b.name, a.name)

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
		if (!check(kept, commit)) {
			refuse(n, "patches")
			return { refused: "patches" }
		}
		taken.set(n, kept)
		order.push(kept)
		for (const p of kept.parents) heads.delete(hex(p))
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
				base: commit.base ?? commit.parents[0],
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
	}
}
