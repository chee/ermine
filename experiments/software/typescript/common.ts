// common: what offers and run share. the owner of offers, an offer, a process run here, the
// context the parts are given, and the small helpers they use. no question of its own
import type { ChangeHeader, Entry } from "@ermine/core/node/entry"
import type { Id, Path, Places } from "@ermine/core/places"
import type { Process, Processes } from "@ermine/processes/start"
import type { ScopeNodes } from "@ermine/processes/scopes"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Table } from "@ermine/core/table"
import type { Kind, Offered } from "./offers.ts"
import type { Handle } from "./run.ts"

// the one field everything matches on (@ermine/types' ATTRIBUTE)
export const ATTRIBUTE = "ermine.type"
export const TYPE = {
	process: "ermine.process",
	runners: "ermine.runner",
	compilers: "ermine.compiler",
	surfaces: "ermine.surface",
} as const

// a place things are offered under: its node, its path, the scope they go with; stored: they stay
// when it goes (an install's node)
export type Place = {
	readonly id: Id
	readonly at: Path
	readonly scope: Scope
	readonly stored?: boolean
}

// the files of software: a write's site is the first call outside them (each adds its own)
export const ours = new Set<string>([import.meta.url])
const resolved = (name: string): string[] => {
	try {
		return [import.meta.resolve(name)]
	} catch {
		return []
	}
}
// what software calls through on the way to a write
export const through = [
	...resolved("@ermine/core/scheduler"),
	...resolved("@ermine/processes/start"),
]

// an owner's facts: its place, its places, its args and folder (a process's), the folders of what it
// offers, by kind, its offers in order, its holds on loads in order
export type Owner = Place & {
	readonly under: Scope
	readonly places: Places
	readonly args: readonly string[]
	readonly folder: Path
	readonly folders: Map<Kind, { readonly id: Id; readonly scope: Scope }>
	readonly offers: Offer[]
	readonly loads: Held[]
}
// a load, shared by every owner holding it: its key (loads' key), its live form, its scope (what
// its load made goes with it), the holds on it; gone: let go, out of the shared ones
export type Load = {
	readonly key: string
	readonly live: unknown
	readonly scope: Scope
	readonly holds: Set<Held>
	gone: boolean
}
// one owner's hold on a load, until let go
export type Held = { readonly load: Load; released: boolean }
// an offer: its node's scope; why: the reason it is withdrawn with (none: "runner-stopped")
export type Offer = Offered & {
	readonly owner: Owner
	readonly scope: Scope
	why?: unknown
	gone: boolean
}
// a process run here: on the offer it runs on (if offered here); under: a scope under that offer
// holding, newest first, what it offers, its stopper (its handle's stop) and its own scope
export type Running = Owner & {
	process?: Process
	readonly on?: Offer
	readonly stopper: Scope
	handle?: Handle
	ended: boolean
	told: boolean
	reason?: unknown
}

// what the parts share
export type Ctx = {
	readonly s: Scheduler
	readonly table: Table
	readonly home: Places
	readonly scopes: Pick<ScopeNodes, "give">
	readonly processes: Processes
	readonly scope: Scope
	readonly createScope: Scheduler["createScope"]
	readonly commit: (changed: readonly Entry<unknown>[]) => void
	readonly headerOf: () => ChangeHeader
	// what running() and offers() track, and marking it
	readonly version: object
	readonly changed: () => void
	// one pulse asked for outside a run, however many ask
	readonly later: () => void
	readonly running: Running[]
	readonly byId: Map<Id, Running>
	readonly offers: Map<Id, Offer>
	// the loads standing, by key, shared by their holders
	readonly loads: Map<string, Load>
	readonly ownerOf: (by: Place) => Owner
}

export const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

export const bad = (name: unknown) =>
	typeof name !== "string" || name === "" || name === "." || name === ".." || name === "/"

// a hold let go: out of its holder's list, out of its load's holds; the last one: the load's scope
// torn down, so the load goes (run.ts' unload)
export function drop(s: Scheduler, o: Owner, h: Held) {
	if (h.released) return
	h.released = true
	const i = o.loads.indexOf(h)
	if (i !== -1) o.loads.splice(i, 1)
	h.load.holds.delete(h)
	if (h.load.holds.size === 0) s.teardown(h.load.scope)
}

// a live form's dispose called, if it has one
export function dispose(v: unknown) {
	const f = typeof v === "function" || isMap(v)
		? (v as { [Symbol.dispose]?: unknown })[Symbol.dispose]
		: undefined
	if (typeof f === "function") f.call(v)
}

// at an owner's scope's teardown every hold it has let go, newest first (the first error thrown
// after)
export function holder(s: Scheduler, o: Owner) {
	s.registerTeardown(o.scope, () => {
		let failed: { error: unknown } | undefined
		for (const h of [...o.loads].reverse()) {
			try {
				drop(s, o, h)
			} catch (error) {
				failed ??= { error }
			}
		}
		if (failed) throw failed.error
	})
}
