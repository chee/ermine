// common: what every part of a den shares. the facts of one den (its scheduler, table, places, the
// processes it runs, the offers it makes, whether it is closed) as one context the parts are given,
// the types of what it holds (an owner, an offer, a process it runs), and the small helpers they
// all use. no question of its own: each part answers its own
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import type { Box } from "@ermine/boxes"
import { type Id, type Path, type Places, PlacesError } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Sited } from "@ermine/sites"
import type { Table } from "@ermine/table"
import type { Process } from "@ermine/processes/start"
import type { Den, Setup } from "./dens.ts"
import type { Handle, Stopped } from "./start.ts"
import type { Kind, Offered } from "./offers.ts"

// what dens calls through on the way to a write, beside its own files (ours): the scheduler's
// runWithScope, processes' start (which calls the den's body). places' header skips these too, so a write's site is the caller's
const through = [
	import.meta.resolve("@ermine/scheduler"),
	import.meta.resolve("@ermine/processes/start"),
]

// the files of a den: a write's site is the first call outside them (each part adds its own)
export const ours = new Set<string>()
ours.add(import.meta.url)

// the one field everything matches on (@ermine/types' ATTRIBUTE)
export const ATTRIBUTE = "ermine.type"
export const TYPE = {
	den: "ermine.den",
	process: "ermine.process",
	runners: "ermine.runner",
	compilers: "ermine.compiler",
	surfaces: "ermine.surface",
} as const
export const REASONS = {
	withdrawn: "withdrawn",
	runner: "runner-stopped",
	den: "den-stopped",
} as const

export const STOPPED: Stopped = { refused: "stopped" }

export const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

export const bad = (name: unknown) =>
	typeof name !== "string" || name === "" || name === "." || name === ".." || name === "/"

// a den's node or a process's: its scope, the scope its offers' folders go under, where it runs,
// its args and cwd; the folders of what it offers, by kind, and its offers in order; the loads it
// holds, in order (let go at its scope's teardown: holder)
export type Owner = {
	readonly id: Id
	readonly at: Path
	readonly scope: Scope
	readonly under: Scope
	readonly box: Box
	readonly args: readonly string[]
	readonly cwd: Path
	readonly folders: Map<Kind, { readonly id: Id; readonly scope: Scope }>
	readonly offers: Offer[]
	readonly loads: Held[]
}

// a load's live form, held until let go
export type Held = { readonly live: unknown; released: boolean }

// an offer: its node's scope, the processes running on it under it; why: the reason it is
// withdrawn with (none: "runner-stopped", its owner going)
export type Offer = Offered & {
	readonly owner: Owner
	readonly scope: Scope
	why?: unknown
	gone: boolean
}

// a process this den started: processes' (once start gives it back), the offer it runs on; under:
// where it runs, a scope under the offer's holding (newest first) what it offers, its stopper (its
// handle's stop the teardown), then its own scope; its handle once the runner gave one; ended: out
// of the lists; the reason given (told: by a stop)
export type Running = Owner & {
	process?: Process
	readonly on?: Offer
	readonly stopper: Scope
	handle?: Handle
	ended: boolean
	told: boolean
	reason?: unknown
}

// one den's facts, as its parts are given them
export type Ctx = {
	readonly s: Scheduler
	readonly table: Table
	readonly places: Places
	readonly scopes: Setup["scopes"]
	readonly sites?: Pick<Sited, "createScope">
	readonly createScope: Scheduler["createScope"]
	// the places commit goes through (setup.commit, else the places')
	readonly host: Places
	readonly home: Box
	// the den's owner scope: torn down, every process goes
	readonly owner: Scope
	readonly commit: (changed: readonly Entry<unknown>[]) => void
	// the header of a write made now, its site the first call outside the den's files
	readonly headerOf: () => ChangeHeader
	// what nodes() tracks, and marking it
	readonly version: object
	readonly changed: () => void
	// one pulse asked for outside a run, however many ask
	readonly later: () => void
	// the processes running, in start order, and by id; the offers by id
	readonly running: Running[]
	readonly byId: Map<Id, Running>
	readonly offers: Map<Id, Offer>
	readonly ownerOf: (by: Process | Id | undefined) => Owner
	closed: boolean
	// the reason the den's own process goes with, said by close
	pending: unknown
	// the den's own node, as an owner, and its id; the den itself: set as it is made
	mine: Owner
	node: Id
	den: Den
}

// a held load let go: out of its holder's list, its live form disposed (if it can be)
export function drop(o: Owner, h: Held) {
	if (h.released) return
	h.released = true
	const i = o.loads.indexOf(h)
	if (i !== -1) o.loads.splice(i, 1)
	const v = h.live
	const dispose = typeof v === "function" || isMap(v)
		? (v as { [Symbol.dispose]?: unknown })[Symbol.dispose]
		: undefined
	if (typeof dispose === "function") dispose.call(v)
}

// an owner just made, in its process's body: at its scope's teardown every load it holds let go,
// newest first (the first error thrown after). registered now, so after what is registered later
// (its handle's stop, its program's teardowns), before processes' own
export function holder(s: Scheduler, o: Owner) {
	s.registerTeardown(o.scope, () => {
		let failed: { error: unknown } | undefined
		for (const h of [...o.loads].reverse()) {
			try {
				drop(o, h)
			} catch (error) {
				failed ??= { error }
			}
		}
		if (failed) throw failed.error
	})
}

export function createCtx(setup: Setup): Ctx {
	const { scheduler: s, table, places, scopes } = setup
	const host: Places = setup.commit === undefined ? places : { ...places, commit: setup.commit }
	const version = {}
	const queued = { now: false }
	const schedule = setup.schedule ?? queueMicrotask
	const c = {
		s,
		table,
		places,
		scopes,
		sites: setup.sites,
		createScope: setup.sites?.createScope ?? s.createScope,
		host,
		home: { root: places.root, places: host } as Box,
		owner: undefined as unknown as Scope,
		commit: (changed: readonly Entry<unknown>[]) => host.commit(changed),
		// places' header, its site the first frame outside dens and what it calls through
		headerOf(): ChangeHeader {
			return createChangeHeader(s, undefined, [...ours, ...through])
		},
		changed: () => void s.mark([version]),
		later() {
			if (queued.now || s.getRun() !== undefined) return
			queued.now = true
			schedule(() => {
				queued.now = false
				s.pulse()
			})
		},
		running: [] as Running[],
		byId: new Map<Id, Running>(),
		offers: new Map<Id, Offer>(),
		ownerOf(by: Process | Id | undefined): Owner {
			const id = by === undefined ? c.node : typeof by === "object" ? by.id : by
			if (id === c.node) return c.mine
			const p = c.byId.get(id)
			if (p === undefined || p.ended) throw new PlacesError("nothing-there", String(id))
			return p
		},
		closed: false,
		pending: REASONS.den as unknown,
		version,
	} as unknown as Ctx
	;(c as { owner: Scope }).owner = c.createScope({ den: setup.id })
	return c
}
