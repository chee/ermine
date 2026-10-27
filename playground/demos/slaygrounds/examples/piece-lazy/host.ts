// lazy's host: the world (@ermine/slaygrounds/world), /dev/clock and /provider seeded, and the
// clock's provider (the library below, what @ermine/pully was before it became a feature): awake only
// while a run reads the clock. it hears the scheduler (onTrackingStart: a key gained its first
// tracker; onTrackingEnd: it lost its last) and starts or stops the provider once no run is open.
// the provider is the host's: a program only reads the time. the library it uses is below, in this
// file: slaygrounds loads host.ts and program.ts only, so a host cannot import a file beside it
import { createWorld } from "@ermine/slaygrounds/world"
import type { Patch } from "@ermine/core/op/apply"
import createEntry, { type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import type { Info, Run, Scheduler, Scope } from "@ermine/core/scheduler"
import type { Places } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import type { Id, Key, Table, Tables } from "@ermine/core/table"
import { get } from "@ermine/core/places/lib"
import { render } from "ermine-h"

// ---- the clock's providers: the library @ermine/pully was before it became a
// feature (extensions/pully). createWorld takes no features (but patchy's overlay), so it keeps the
// library here; when it does, host.ts names the clock's provider in the graph (pully's provide)
// and this file goes. it writes the table itself, under its own scope, as it always did.
// nodes whose value is made only while something reads it. a provider is given a node's id; the
// first run to read the node wakes it (start), the last one to stop reading puts it to sleep
// (start's stop). built on the scheduler's onTrackingStart and onTrackingEnd and places' describe
// alone (../../../../../../ermine-plans/playground/pullynode/plan.org)
//
//   const providers = createProviders({ scheduler, places, table })
//   const stop = providers.provide(id, {
//     start(write, woke) { const t = setInterval(() => write([{ path: [], value: now() }]), 1000); return () => clearInterval(t) },
//     once() { return now() },          // optional: what a check takes, nothing kept running
//   })
//   await providers.check(id)            // from outside a run: the value now
//   providers.stop()                     // every provider stopped, the listeners off (a reload)
//
// what wakes it: any read of the node's value (any path, its names, its change) in a run. reads of
// its attributes or children wake nothing. a read outside a run (a peep) wakes nothing; check is
// the way to ask from outside.
// what a reader gets: the value last written, whenever that was, and the node's status (the
// attribute STATUS; attributes that are not a map are replaced by one): "asleep", "waking"
// (started, nothing written since), "awake". how stale an asleep value is: its entry's
// change.time.
// when: never inside a run. what a run's read sets going (a start) or stops waits till no run is
// open (the pulse's end); so a provider's writes are never the reading run's (a provide made in a
// run writes its first status then too). writes are the provider's own, under a root scope of the
// info given (default: actor, the id).
// the path cache's holds wake nothing (chee 10-21: for now; a possible places bug)

// the attribute a provided node's status is on
const STATUS = "ermine.provider.status"
type Status = "asleep" | "waking" | "awake"

// a write to the provided node's value: patches, as op's apply takes them
type Write = (patches: readonly Patch[]) => void

type Provider = {
	// the first reader came: make the value, writing it through write, till the stop given back is
	// called. woke: the run whose read woke it (its computer: who wanted it); none for a check
	start: (write: Write, woke: Run | undefined) => () => void
	// a check, with no reader: the value now (or a promise of it), nothing kept running. none: a
	// check starts it, takes its first write and stops it
	once?: () => unknown
}

type Setup = {
	scheduler: Pick<
		Scheduler,
		| "onTrackingStart"
		| "onTrackingEnd"
		| "onAfterPulse"
		| "getRun"
		| "getCurrentScope"
		| "createRootScope"
		| "runWithScope"
	>
	places: Pick<Places, "describe" | "commit">
	table: Pick<Table, "get" | "add">
}

type Providers = {
	// id's value made by provider from here on; info: its writes' scope (default { actor: id }).
	// gives back its stop: stopped if running (then asleep). one provider an id: a second throws
	provide: (id: Id, provider: Provider, info?: Info) => () => void
	// the node's value now, asked from outside a run: awake, the value there; else once's (written
	// to the node), or start's first write (started, stopped; the provider let go first: the value
	// there). the status is not changed by it
	check: (id: Id) => Promise<unknown>
	// whether a run reads it now
	reading: (id: Id) => boolean
	// every provider stopped, the listeners off
	stop: () => void
}

type Held = {
	provider: Provider
	scope: Scope
	// the keys read now (value spots of the id), each from onTrackingStart till onTrackingEnd
	keys: Set<unknown>
	// the run that woke it, kept till it starts
	woke?: Run
	// running: start's stop; checking: started by a check, not yet written
	running?: () => void
	checking?: () => void
	status?: Status
}

function createProviders(setup: Setup): Providers {
	const { scheduler, places, table } = setup
	const held = new Map<Id, Held>()
	// a key read now, to the id it reads
	const ids = new Map<unknown, Id>()
	// ids to look at once no run is open
	const due = new Set<Id>()

	// a write to (part, id), under the provider's scope: a new entry, or patches on the one there
	function put(h: Held, part: Key, id: Id, patches: readonly Patch[]) {
		scheduler.runWithScope(h.scope, () => {
			const header = createChangeHeader(scheduler)
			const there = table.get(part, id) as Entry<unknown> | undefined
			if (there === undefined) {
				const made = createEntry<unknown>(undefined, header)
				update(made, patches, header)
				table.add(part, id, made as Entry<Tables[typeof part]>)
				return
			}
			update(there, patches, header)
			places.commit([there])
		})
	}

	function status(h: Held, id: Id, s: Status) {
		if (h.status === s) return
		h.status = s
		// attributes not a map: replaced by one
		const v = table.get("attributes", id)?.value
		const map = v !== null && typeof v === "object" && !Array.isArray(v)
		const patches: Patch[] = map ? [] : [{ path: [], value: {} }]
		patches.push({ path: [STATUS], value: s })
		put(h, "attributes", id, patches)
	}

	// what start is given: writes land; the first after waking says awake
	const writer = (h: Held, id: Id): Write => (patches) => {
		if (held.get(id) !== h) return
		put(h, "value", id, patches)
		if (h.checking) {
			const done = h.checking
			h.checking = undefined
			done()
		}
		// started for readers (waking is only then), and this its first write since
		if (h.keys.size && h.status === "waking") status(h, id, "awake")
	}

	// started or stopped as its readers say
	function settle(id: Id) {
		const h = held.get(id)
		if (h === undefined) return
		if (h.keys.size === 0 && h.status === undefined) {
			// provided in a run: its first status, now
			status(h, id, "asleep")
		} else if (h.keys.size && h.running === undefined) {
			status(h, id, "waking")
			const woke = h.woke
			h.woke = undefined
			h.running = h.provider.start(writer(h, id), woke)
		} else if (h.keys.size && h.checking) {
			// a reader came while a check runs: it stays running after, for the reader
			status(h, id, "waking")
		} else if (h.keys.size && h.status === "asleep") {
			// running from a check that has written: the reader keeps it
			status(h, id, "awake")
		} else if (h.keys.size === 0 && h.running !== undefined && !h.checking) {
			const off = h.running
			h.running = undefined
			off()
			status(h, id, "asleep")
		}
	}

	// now when no run is open; else at the pulse's end
	function soon(id: Id) {
		due.add(id)
		if (scheduler.getRun() === undefined) flush()
	}
	function flush() {
		for (const id of due) {
			due.delete(id)
			settle(id)
		}
	}

	const offs = [
		scheduler.onTrackingStart((key) => {
			const w = places.describe(key)
			if (w === undefined || w.part !== "value") return
			const h = held.get(w.id)
			if (h === undefined) return
			ids.set(key, w.id)
			if (h.keys.size === 0) h.woke = scheduler.getRun()
			h.keys.add(key)
			soon(w.id)
		}),
		// places may have let the key go already: it is looked up here, not described
		scheduler.onTrackingEnd((key) => {
			const id = ids.get(key)
			if (id === undefined) return
			ids.delete(key)
			const h = held.get(id)
			if (h === undefined || !h.keys.delete(key) || h.keys.size) return
			soon(id)
		}),
		scheduler.onAfterPulse(flush),
	]

	function provide(id: Id, provider: Provider, info: Info = { actor: id }): () => void {
		if (held.has(id)) throw new Error(`${String(id)} has a provider already`)
		const h: Held = { provider, scope: scheduler.createRootScope(info), keys: new Set() }
		held.set(id, h)
		const there = table.get("attributes", id)?.value as Record<string, unknown> | undefined
		const was = there !== null && typeof there === "object" ? there[STATUS] : undefined
		if (was === "asleep") h.status = "asleep"
		else soon(id)
		return () => {
			if (held.get(id) !== h) return
			for (const k of h.keys) ids.delete(k)
			end(id, h)
		}
	}

	// h stopped and let go: asleep if it was running, and no run is open to write in. a check
	// waiting on a first write answers with the value there
	function end(id: Id, h: Held) {
		const off = h.running, waiting = h.checking
		h.running = h.checking = h.woke = undefined
		off?.()
		if (off && scheduler.getRun() === undefined) status(h, id, "asleep")
		held.delete(id)
		waiting?.()
	}

	async function check(id: Id): Promise<unknown> {
		const h = held.get(id)
		const value = () => table.get("value", id)?.value
		if (h === undefined || h.running !== undefined) return value()
		if (h.provider.once) {
			const v = await h.provider.once()
			if (held.get(id) === h) put(h, "value", id, [{ path: [], value: v }])
			return v
		}
		await new Promise<void>((resolve) => {
			h.checking = resolve
			h.running = h.provider.start(writer(h, id), undefined)
		})
		// no reader came meanwhile: stopped again; one did: it keeps running, awake
		const off = h.running as (() => void) | undefined
		if (held.get(id) === h && off !== undefined) {
			if (h.keys.size === 0) {
				h.running = undefined
				off()
			} else if (h.status === "asleep") status(h, id, "awake")
		}
		return value()
	}

	return {
		provide,
		check,
		reading: (id) => (held.get(id)?.keys.size ?? 0) > 0,
		stop: () => {
			for (const off of offs) off()
			for (const [id, h] of [...held]) end(id, h)
			ids.clear()
			due.clear()
		},
	}
}

// a provided node's status, the read told: "asleep", "waking", "awake"; none: no provider
const statusOf = (places: Pick<Places, "readValue">, id: Id): Status | undefined =>
	places.readValue("attributes", id, [STATUS]) as Status | undefined

// ---- the demo ----
const world = createWorld({ render, processes: [{ name: "lazy" }] })
const { s, places, table, host } = world.world
const e = world.ermine

type Said = { starts: number; stops: number; log: unknown[] }

world.seed((h) => {
	h.ensureNode("/dev/clock", { time: "--:--:--", ticks: 0 })
	h.ensureNode("/provider", { awake: false, ticks: 0, starts: 0, stops: 0, log: [] })
})
// the clock's id: what the provider is given
const at = e.dataOf(e.getNode("/dev/clock"))!.node
const clock = at.id ?? get(places, at.path!)!

let ticks = 0
const hhmmss = () => new Date().toTimeString().slice(0, 8)

// the provider says what happened: awake or not, and a line in its log (the last six)
function say(what: string, awake: boolean) {
	s.runWithScope(host, () => {
		const was = e.peep(() => e.read("/provider")) as Said
		e.patch("/provider", [
			{ path: ["awake"], value: awake },
			{ path: [awake ? "starts" : "stops"], value: (awake ? was.starts : was.stops) + 1 },
			{ path: ["log"], value: [{ at: hhmmss(), what, awake }, ...was.log].slice(0, 6) },
		])
	})
}

// the clock's own writes are under its own scope (actor /dev/clock): the providers'
const providers = createProviders({ scheduler: s, places, table })
providers.provide(clock, {
	start(write) {
		say("a reader came: ticking", true)
		const tick = () => {
			ticks++
			write([{ path: ["time"], value: hhmmss() }, { path: ["ticks"], value: ticks }])
			s.runWithScope(host, () => e.patch("/provider", [{ path: ["ticks"], value: ticks }]))
		}
		tick()
		const timer = setInterval(tick, 1000)
		return () => {
			clearInterval(timer)
			say("the last reader left: stopped", false)
		}
	},
}, { actor: "/dev/clock" })

export const reload = world.reload
