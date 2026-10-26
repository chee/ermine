// pully: nodes whose value is made only while something reads it (dmesg, /dev/clock, a camera),
// as a feature (chee 10-24: "Feature only"). providing is written in the graph: a node's attribute
// ermine.provider names a handler, a method node, by its id. the first run to read the node's
// value wakes it, the last to stop reading puts it to sleep: pully sends the handler "wake" or
// "sleep", once no run is open. the handler writes the value with @ermine/system's functions, as
// any action does, so its writes go through onWrite, protect, records and sites
//
//   import pully, { check, provide } from "@ermine/pully"
//   const ermine = createErmine({ features: [pully] })
//   // a program providing:
//   const clock = ensureNode("/dev/clock", { time: "--:--:--" })
//   let timer
//   const on = createAction("on/clock", (what, node) => {
//     if (what === "wake") timer = setInterval(() => patch(node, [{ path: ["time"], value: now() }]), 1000)
//     if (what === "sleep") clearInterval(timer)
//     if (what === "check") return now()
//   })
//   provide(clock, on)
//   // a program reading: the last value at once, and how fresh (getStatus(x).provider)
//   createEffect("show", () => [read(clock), getStatus(clock).provider], ([c, s]) => draw(c, s))
//   check(clock)                           // the handler's answer to "check", nothing woken
//
// naming: the attribute ermine.provider holds the handler's node id (provide writes it). whoever may
// edit the node's attributes names it (asked "edit", as any attribute write): nothing host-only.
// the namer: the context whose write named it, as onWrite saw it. a name pully didn't see written
// (saved before this ermine) wakes nothing till it is named again. one provider a node: one
// attribute. named again with another: the old one, awake, is sent sleep; the new wakes if read.
// the name taken out (or the attributes gone): sleep if awake, then asleep. the namer's scope gone
// (its process stopped): let go, asleep, nothing sent.
// what wakes it: any read of the node's value in a run (any path, its names, its change): the
// scheduler's onTrackingStart. its attributes or children wake nothing; a read outside a run (a
// peep, the host's, one in a send) wakes nothing; the path cache's holds wake nothing (chee 10-21,
// for now).
// when: never inside a run. what a run's read sets going (a wake) or stops (a sleep) is sent once
// no run is open (the pulse's end), so a handler's writes are never the reading run's; what
// happens outside a run (a naming, a value landing, a reader torn down) is settled at once.
// the sends, as the namer (caller: the namer's node; protect asks "execute" as it):
//   send({ id: handler }, "wake", node, reader)   node: { id, part: "value" }; reader: the node of the
//                                                 computer whose read woke it
//   send({ id: handler }, "sleep", node)
//   check: no function of pully's. anyone reaching the handler sends it "check" (the library's check):
//   its answer is the handler's
// a send that throws PENDING (no handler there yet): its wait is recorded, the status stays waking.
// any other throw comes out of the pulse (the first, once every node due is settled), and is on
// the send's record.
// status: the attribute ermine.provider.status, "asleep" | "waking" (sent wake, nothing written
// since) | "awake", written by the host's context (bookkeeping, as a process's row is). status(x)
// shows it as provider (onStatus), read from the attribute: one source. how stale an asleep value
// is: its entry's change.time.
import {
	ErmineError,
	executeAction,
	patchAttributes,
	readAttributes,
	readEntries,
} from "@ermine/system"
import type { Feature, FeatureAPI, Node, NodeData, ProcessContext, Target } from "@ermine/system"
import { NODE } from "@ermine/core/places/header"
import { PENDING, type Scope } from "@ermine/core/scheduler"
import type { Id } from "@ermine/core/table"

// the attribute naming a node's provider: the handler's node id
export const PROVIDER = "ermine.provider"
// the attribute a provided node's status is on
export const STATUS = "ermine.provider.status"
export type Status = "asleep" | "waking" | "awake"

type Provided = {
	readonly handler: Id
	readonly namer: ProcessContext
	// sent wake, not sleep since
	woken: boolean
	// a value landed since the wake
	fresh: boolean
	// its namer's scope gone
	gone: boolean
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)

const pully: Feature = {
	name: "pully",
	files: [import.meta.url],
	setup(f) {
		const provided = new Map<Id, Provided>()
		// every value spot read now, by node: the keys, each from onTrackingStart till onTrackingEnd
		const reading = new Map<Id, Set<unknown>>()
		const ids = new Map<unknown, Id>()
		// the reader whose read came first, while any reads
		const woke = new Map<Id, Id | undefined>()
		// nodes to settle once no run is open; sleeps owed to providers let go
		const due = new Set<Id>()
		const owed: { p: Provided; id: Id }[] = []
		// the namers whose scope's going is listened for
		const heard = new WeakSet<Scope>()

		installed.add(new WeakRef(f))
		const host = () => f.getProcessContext()
		// a node by its id (pully's power: minted from its id); its use asked as whoever uses it
		const node = (id: Id, _as?: ProcessContext): Node => f.handleOf({ id, part: "value" })
		const said = (id: Id): unknown => {
			const v = f.table.get("attributes", id)?.value
			return isMap(v) ? v[STATUS] : undefined
		}
		// the status written, as the host, when it changes
		// (pully's own write: not a naming)
		let marking = false
		function mark(id: Id, s: Status) {
			if (said(id) === s || f.table.get("attributes", id) === undefined) return
			const o = host()
			marking = true
			try {
				o.within(() => o.write("attributes", id, [{ path: [STATUS], value: s }]))
			} finally {
				marking = false
			}
		}

		let thrown: { e: unknown } | undefined
		function send(p: Provided, what: "wake" | "sleep", id: Id, reader?: Id) {
			if (p.gone || p.namer.scope.state !== "alive") return
			try {
				const at = node(id, p.namer)
				const args = what === "wake" ? [what, at, reader] : [what, at]
				// as the namer: its scope opened (a flush runs with nothing open), executeAction finding it
				p.namer.within(() => executeAction(node(p.handler, p.namer), ...args))
			} catch (e) {
				// no handler there yet: its wait is recorded
				if (e !== PENDING) thrown ??= { e }
			}
		}

		function settle(id: Id) {
			const p = provided.get(id)
			if (p === undefined) return
			const n = reading.get(id)?.size ?? 0
			// let go: asleep, kept as let go till it is named again
			if (p.gone) {
				p.woken = false
				mark(id, "asleep")
				return
			}
			if (n > 0 && !p.woken) {
				p.woken = true
				p.fresh = false
				const reader = woke.get(id)
				mark(id, "waking")
				send(p, "wake", id, reader)
			} else if (n === 0 && p.woken) {
				p.woken = false
				send(p, "sleep", id)
				mark(id, "asleep")
			} else if (n === 0 && said(id) === undefined) mark(id, "asleep")
			if (p.woken && p.fresh && provided.get(id) === p) mark(id, "awake")
		}

		let flushing = false
		function flush() {
			if (flushing) return
			flushing = true
			try {
				while (owed.length || due.size) {
					for (const { p, id } of owed.splice(0)) {
						send(p, "sleep", id)
						if (!provided.has(id)) mark(id, "asleep")
					}
					for (const id of due) {
						due.delete(id)
						settle(id)
					}
				}
			} finally {
				flushing = false
			}
			const t = thrown
			thrown = undefined
			if (t) throw t.e
		}
		// now, when no run is open; else at the pulse's end
		function soon(id: Id) {
			due.add(id)
			if (f.scheduler.getRun() === undefined) flush()
		}

		// the name at id as the table holds it now, against what pully knows: o named it
		function named(o: ProcessContext, id: Id) {
			const v = f.table.get("attributes", id)?.value
			const h = isMap(v) && typeof v[PROVIDER] === "string" ? v[PROVIDER] as Id : undefined
			const was = provided.get(id)
			// the same name (none, or the same handler), whoever wrote: nothing changes; a provider let
			// go (its namer gone) named again: a new naming
			if (was?.handler === h && !was?.gone) return
			if (was !== undefined) {
				provided.delete(id)
				if (was.woken && !was.gone) owed.push({ p: was, id })
			}
			if (h !== undefined) {
				provided.set(id, { handler: h, namer: o, woken: false, fresh: false, gone: false })
				if (!heard.has(o.scope)) {
					heard.add(o.scope)
					// as its scope goes: settled at the next pulse's end, not in the middle of the going
					f.scheduler.registerTeardown(o.scope, () => {
						for (const [at, p] of provided) {
							if (p.namer.scope !== o.scope) continue
							p.gone = true
							due.add(at)
						}
						host().queuePulse()
					})
				}
			}
			soon(id)
		}

		f.onWrite((o, w, next) => {
			const before = f.table.get(w.part, w.id)?.change
			next(o, w)
			if (marking) return
			// held back by a hook after this one, or nothing changed: nothing to do
			if (f.table.get(w.part, w.id)?.change === before) return
			if (w.part === "attributes") named(o, w.id)
			else if (w.part === "value") {
				const p = provided.get(w.id)
				if (p?.woken && !p.fresh) {
					p.fresh = true
					soon(w.id)
				}
			}
		})

		f.onStatus((x, status, next) => {
			const out = next(x, status)
			const s = f.places.readValue("attributes", x.id, [STATUS])
			return s === undefined || out === undefined ? out : { ...out, provider: s }
		})

		f.scheduler.onTrackingStart((key) => {
			const w = f.places.describe(key)
			if (w === undefined || w.part !== "value") return
			let keys = reading.get(w.id)
			if (keys === undefined) reading.set(w.id, keys = new Set())
			ids.set(key, w.id)
			if (keys.size === 0) {
				woke.set(w.id, f.scheduler.getRun()?.computer.info[NODE] as Id | undefined)
			}
			keys.add(key)
			if (keys.size === 1 && provided.has(w.id)) soon(w.id)
		})
		// places may have let the key go already: it is looked up here, not described
		f.scheduler.onTrackingEnd((key) => {
			const id = ids.get(key)
			if (id === undefined) return
			ids.delete(key)
			const keys = reading.get(id)
			if (keys === undefined || !keys.delete(key) || keys.size) return
			reading.delete(id)
			woke.delete(id)
			if (provided.has(id)) soon(id)
		})
		f.scheduler.onAfterPulse(flush)
	},
}
export default pully

// a library on @ermine/system's functions, as the process calling it: x's provider named handler
// (an action node), by its id
export function provide(x: Target, handler: Target) {
	const h = idOf(handler)
	if (h === undefined) throw new Error("nothing-there: the handler")
	patchAttributes(x, [{ path: [PROVIDER], value: h }])
}

// x's provider's name taken out
export function unprovide(x: Target) {
	patchAttributes(x, [{ path: [PROVIDER] }])
}

// x's handler sent "check": its answer (the value now, as the handler gives it); none named:
// undefined
export function check(x: Target): unknown {
	const h = readAttributes(x, [PROVIDER])
	const n = readEntries(x)[0]?.node
	if (typeof h !== "string" || n === undefined) return undefined
	const { f, node: d } = featureOf(n)
	if (d.id === undefined) return undefined
	// the handler and the node by their ids (pully's power: minted from ids), used as the caller
	const at = (i: Id) => f.handleOf({ id: i, part: "value" })
	return executeAction(at(h), "check", at(d.id))
}

// x's id: a handle's own (one minted from an id), else the node its path reaches (readEntries)
const idOf = (x: Target): Id | undefined =>
	(typeof x === "string" || Array.isArray(x) ? undefined : featureOf(x as Node).node.id) ??
		idByEntries(x)

// the node a path reaches, by the handle readEntries gives (pully's power: dataOf)
function idByEntries(x: Target): Id | undefined {
	const n = readEntries(x)[0]?.node
	return n === undefined ? undefined : featureOf(n).node.id
}

// every pully set up, one per ermine, held weakly (its hooks hold it while its ermine is): a handle
// is known to its own ermine's only (dataOf). one closed (its dataOf throws closed) or let go is
// dropped as it is met
const installed = new Set<WeakRef<FeatureAPI>>()
function featureOf(h: Node): { f: FeatureAPI; node: NodeData } {
	for (const r of installed) {
		const f = r.deref()
		const d = known(f, h)
		if (d === null) installed.delete(r)
		else if (d !== undefined) return { f: f!, node: d.node }
	}
	throw new Error("a node no ermine with pully gave")
}
// what h reaches in f's ermine (none: undefined); f's ermine gone or closed: null
function known(f: FeatureAPI | undefined, h: Node): { node: NodeData } | undefined | null {
	if (f === undefined) return null
	try {
		return f.dataOf(h)
	} catch (e) {
		if (e instanceof ErmineError && e.code === "closed") return null
		throw e
	}
}
