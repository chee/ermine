// the blops of one node, each object's in a history of its own, and which are its heads (HISTORY.tex)
// takes blops already unsealed: no bytes, no signatures; patches only checked, through the check given
import type { Blop } from "../../encoding/ts/blop.ts"

export type Refusal = "node" | "history" | "lamport" | "patches"

export type Added =
	| "taken"
	| "passed"
	| { waiting: string[] }
	| { stuck: string[] }
	| { refused: Refusal }

export type Head = { name: Uint8Array; blop: Blop }

export type Histories = {
	add(blop: Blop, name: Uint8Array): Added
	heads(object: Blop["object"]): Head[]
	get(name: Uint8Array): Blop | undefined
	waiting(): { name: string; waiting: string[] }[]
	refused(): ({ name: string; refused: Refusal } | { name: string; stuck: string[] })[]
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const by = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

type Entry = { name: string; blop: Blop; key: string }

// the histories of one node, empty; check is APPLY.tex's, step 7
export function createHistories(
	node: string,
	check: (histories: never, blop: never) => boolean,
): Histories {
	// a history is told apart by its object, compared as a value
	const history = (b: Blop) => JSON.stringify(b.object)
	const taken = new Map<string, Entry>()
	const waits = new Map<string, { blop: Blop; on: string[] }>()
	// a name not taken in, to the names waiting on it
	const waiters = new Map<string, Set<string>>()
	const refusals = new Map<string, { blop: Blop; code: Refusal }>()
	const stuck = new Map<string, Blop>()
	const heads = new Map<string, Set<string>>()

	// the agreed order: higher lamport first; equal, the greater name
	const lamport = (n: string) => (taken.get(n)?.blop ?? waits.get(n)!.blop).lamport
	const agreed = (a: string, b: string) => {
		const x = lamport(a), y = lamport(b)
		return x !== y ? y - x : by(b, a)
	}

	const bad = (n: string) => refusals.has(n) || stuck.has(n)
	const parents = (b: Blop) => b.parents.map(hex)

	function forget(n: string) {
		const w = waits.get(n)
		if (w) { for (const p of w.on) waiters.get(p)?.delete(n) }
		waits.delete(n)
		refusals.delete(n)
		stuck.delete(n)
	}

	function enter(blop: Blop, n: string): Added {
		const ps = parents(blop)
		const refuse = (code: Refusal): Added => {
			refusals.set(n, { blop, code })
			return { refused: code }
		}
		if (blop.node !== node) return refuse("node")
		const gone = ps.filter(bad)
		if (gone.length) {
			stuck.set(n, blop)
			return { stuck: gone }
		}
		const missing = ps.filter((p) => !taken.has(p))
		if (missing.length) {
			waits.set(n, { blop, on: missing })
			for (const p of missing) {
				if (!waiters.has(p)) waiters.set(p, new Set())
				waiters.get(p)!.add(n)
			}
			return { waiting: missing }
		}
		const key = history(blop)
		if (ps.some((p) => taken.get(p)!.key !== key)) return refuse("history")
		const top = ps.length ? Math.max(...ps.map((p) => taken.get(p)!.blop.lamport)) : 0
		if (blop.lamport !== top + 1) return refuse("lamport")
		if (!check(histories as never, blop as never)) return refuse("patches")
		taken.set(n, { name: n, blop, key })
		if (!heads.has(key)) heads.set(key, new Set())
		const hs = heads.get(key)!
		for (const p of ps) hs.delete(p)
		hs.add(n)
		return "taken"
	}

	// n added: through the steps; what waited on it, added again in the agreed order, and so on
	function run(blop: Blop, n: string): Added {
		forget(n)
		const result = enter(blop, n)
		if (typeof result === "object" && "waiting" in result) return result
		const woken = [...waiters.get(n) ?? []].sort(agreed)
		waiters.delete(n)
		const entries = woken.map((w) => waits.get(w))
		woken.forEach((w, i) => {
			// added again by an earlier one's waking: its entry is another, or gone
			const e = entries[i]
			if (e && waits.get(w) === e) run(e.blop, w)
		})
		return result
	}

	const histories: Histories = {
		add(blop, name) {
			const n = hex(name)
			if (taken.has(n)) return "passed"
			return run(blop, n)
		},
		heads(object) {
			const hs = [...heads.get(JSON.stringify(object)) ?? []]
			hs.sort(agreed)
			return hs.map((n) => ({ name: unhex(n), blop: taken.get(n)!.blop }))
		},
		get: (name) => taken.get(hex(name))?.blop,
		waiting() {
			return [...waits].sort(([a], [b]) => by(a, b)).map(([name, w]) => ({
				name,
				waiting: [...w.on],
			}))
		},
		refused() {
			const out: ReturnType<Histories["refused"]> = []
			for (const [name, r] of refusals) out.push({ name, refused: r.code })
			for (const [name, b] of stuck) out.push({ name, stuck: parents(b).filter(bad) })
			return out.sort((a, b) => by(a.name, b.name))
		},
	}
	return histories
}
