// A small graph for the cross-library fuzz tests: a table of children entries and places over it.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/graph/entry"
import { createTable, type Id, type Tables } from "@ermine/graph/table"
import {
	createPlaces,
	move,
	type Path,
	place,
	type Places,
	PlacesError,
	rename,
	unplace,
} from "@ermine/places"
import { createPaths, type Spot } from "@ermine/reactivity/paths"
import type { Pick } from "../../conformance/typescript/gen.ts"

// any value goes in children here, on purpose: places takes what is not an id as taken
type Children = Tables["children"]

export const SYM = Symbol("x")
export const IDS: readonly Id[] = ["R", "A", "B", "C", "D", SYM]
export const NAMES = ["a", "b", "c", "__proto__"]

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
	const header = (): ChangeHeader => ({
		time: ++time,
		actor: "fuzz",
		frame: { info: {}, parent: undefined },
	})

	const entry = (): Id => IDS[1 + pick(IDS.length - 1)]
	function value(): Record<string, unknown> {
		const v: Record<string, unknown> = {}
		for (const name of NAMES) {
			const k = pick(6)
			if (k < 2) continue
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
		if (id === "D") continue
		table.add("children", id, createEntry(value() as Children, header()))
	}

	const nodes = () => IDS.map((id) => ({ id, node: children(id) }))
	const path = (most = 3): Path => Array.from({ length: pick(most + 1) }, () => one(NAMES))
	const parent = (): Id => pick(3) ? "R" : pick(8) === 0 ? "D" : one(IDS)
	const name = () => pick(12) ? one(NAMES) : one([".", "..", "/", ""])
	const has = (at: Id, n: string, ids: boolean) => {
		const v = children(at)?.value
		if (v === null || typeof v !== "object" || !Object.hasOwn(v, n)) return false
		const x = (v as Record<string, unknown>)[n]
		return !ids || typeof x === "string" || typeof x === "symbol"
	}
	function slot(): [Id, string] {
		const at = parent()
		const full = NAMES.filter((n) => has(at, n, true))
		return [at, full.length && pick(3) ? one(full) : name()]
	}
	function free(): [Id, string] {
		const at = parent()
		const empty = NAMES.filter((n) => !has(at, n, false))
		return [at, empty.length && pick(3) ? one(empty) : name()]
	}
	const kid = (id: Id) => {
		const n = children(id)
		if (n === undefined) throw new PlacesError("nothing-there")
		return n
	}

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
		const id = one(IDS)
		const there = children(id)
		if (there && pick(3) === 0) table.del("children", id)
		else table.sub("children", id, createEntry((pick(4) ? value() : undefined) as Children, h))
		return { what: `event ${String(id)}`, changed: [], events: [{ id }] }
	}

	return { p, paths, table, children, nodes, path, entry, write, one }
}

export const show = (x: unknown): string =>
	JSON.stringify(x, (_, v) => typeof v === "symbol" ? String(v) : v)

export type World = ReturnType<typeof createWorld>
