// a small graph for the cross-library fuzz tests: one table of children entries and places over
// it, random writes through places' write functions, and now and then a table event (a children
// entry put in place of another, taken out, put back). places tells its reads and what changed to
// the scheduler; here that is two hooks: told, each spot read; marked, each spot said changed
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import { createTable, type Id, type Tables } from "@ermine/core/table"
import {
	createPlaces,
	move,
	type Path,
	place,
	type Places,
	PlacesError,
	rename,
	unplace,
} from "@ermine/core/places"
import { createPaths, type Spot } from "@ermine/core/scheduler/paths"
import type { Pick } from "./gen_harness.ts"

// any value goes in children here, on purpose: places takes what is not an id as taken
type Children = Tables["children"]

export const SYM = Symbol("x")
export const IDS: readonly Id[] = ["R", "A", "B", "C", "D", SYM]
export const NAMES = ["a", "b", "c", "__proto__"]

// a whole-entry event at an id: its children entry put, replaced or taken out
export type Event = { id: Id }
export type Wrote = { what: string; changed: Entry<unknown>[]; events: Event[] }

export function createWorld(
	pick: Pick,
	told?: (spot: Spot<unknown>) => void,
	marked?: (spots: readonly unknown[]) => void,
) {
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	const paths = createPaths<unknown>()
	const scheduler = {
		track: (key: unknown) => told?.(key as Spot<unknown>),
		mark: (keys: readonly unknown[]) => marked?.(keys),
		getRun: () => undefined,
	} as unknown as Parameters<typeof createPlaces>[0]["scheduler"]
	const table = createTable((part, id) => p.onTableChange(part, id))
	const p: Places = createPlaces({ root: "R", table, paths, scheduler })
	const children = (id: Id) => table.get("children", id)
	let time = 0
	const header = (): ChangeHeader => ({ time: ++time, actor: "fuzz" })

	// an id to place: any but the root
	const entry = (): Id => IDS[1 + pick(IDS.length - 1)]
	// a children value: names to ids, with now and then a name holding something that is no id
	function value(): Record<string, unknown> {
		const v: Record<string, unknown> = {}
		for (const name of NAMES) {
			const k = pick(6)
			if (k < 2) continue
			// any name, "__proto__" too
			Object.defineProperty(v, name, {
				value: k === 5 ? one([5, { not: "an id" }, [entry()], null]) : entry(),
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		return v
	}
	for (const id of IDS) {
		// D has no children entry: a parent that is not there
		if (id === "D") continue
		table.add("children", id, createEntry(value() as Children, header()))
	}

	// every id, and its children entry now
	const nodes = () => IDS.map((id) => ({ id, node: children(id) }))
	// a path: names from the root
	const path = (most = 3): Path => Array.from({ length: pick(most + 1) }, () => one(NAMES))
	// a parent: mostly the root
	const parent = (): Id => pick(3) ? "R" : pick(8) === 0 ? "D" : one(IDS)
	const name = () => pick(12) ? one(NAMES) : one([".", "..", "/", ""])
	// what a name holds in a parent now
	const has = (at: Id, n: string, ids: boolean) => {
		const v = children(at)?.value
		if (v === null || typeof v !== "object" || !Object.hasOwn(v, n)) return false
		const x = (v as Record<string, unknown>)[n]
		return !ids || typeof x === "string" || typeof x === "symbol"
	}
	// a slot: mostly a name holding an id, when the parent has one
	function slot(): [Id, string] {
		const at = parent()
		const full = NAMES.filter((n) => has(at, n, true))
		return [at, full.length && pick(3) ? one(full) : name()]
	}
	// a slot to put something in: mostly a name holding nothing, when the parent has one
	function free(): [Id, string] {
		const at = parent()
		const empty = NAMES.filter((n) => !has(at, n, false))
		return [at, empty.length && pick(3) ? one(empty) : name()]
	}
	// a parent's children entry; none: nothing-there
	const kid = (id: Id) => {
		const n = children(id)
		if (n === undefined) throw new PlacesError("nothing-there")
		return n
	}

	// one random write (it may throw PlacesError, and then nothing changed), said written; or a
	// table event
	function write(events = true): Wrote {
		const k = pick(events ? 13 : 12)
		const h = header()
		const said = (what: string, changed: Entry<unknown>[]): Wrote => {
			p.commit(changed)
			return { what, changed, events: [] }
		}
		if (k < 4) {
			const [at, n] = free(), e = entry()
			return said(`place ${show([at, n, e])}`, place(kid(at), n, e, h))
		}
		if (k < 7) {
			const [at, n] = slot()
			return said(`unplace ${show([at, n])}`, unplace(kid(at), n, h))
		}
		if (k < 8) {
			const [at, n] = slot()
			const empty = NAMES.filter((x) => !has(at, x, false))
			const to = empty.length && pick(3) ? one(empty) : name()
			return said(`rename ${show([at, n, to])}`, rename(kid(at), n, to, h))
		}
		if (k < 12) {
			const [a, n] = slot(), [b, m] = free()
			return said(`move ${show([a, n, b, m])}`, move([kid(a), n], [kid(b), m], h))
		}
		// a table event: an entry in place of the one there, or none, or one put where none is
		const id = one(IDS)
		const there = children(id)
		if (there && pick(3) === 0) table.del("children", id)
		else table.sub("children", id, createEntry((pick(4) ? value() : undefined) as Children, h))
		return { what: `event ${String(id)}`, changed: [], events: [{ id }] }
	}

	return { p, paths, table, children, nodes, path, entry, write, one }
}

// a value for messages: symbols shown
export const show = (x: unknown): string =>
	JSON.stringify(x, (_, v) => typeof v === "symbol" ? String(v) : v)

export type World = ReturnType<typeof createWorld>
