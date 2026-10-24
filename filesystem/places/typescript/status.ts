// a computer's status, on its own node: never saved, at one place. the attribute
// ermine.computer.status holds PENDING while a run is pending, what a failed run threw, as thrown
// (a loop: an Error "looping"), and is gone when a run is done. a run stopped (a newer one
// follows) leaves it. an effect's act that throws writes what it threw the same way (told by
// onEffect); a run done leaves that, until an act succeeds and takes it away (a thrown undefined
// is an Error "undefined": none would read as done). written as each run ends (the scheduler's
// onRunEnd), with the computer's scope open and the run open when the pulse began: from a pulse
// with none, from outside. a computer reading its own status runs once more for each status
// written, then stops: the same status is not written again
import type { Id, Table, Tables } from "@ermine/table"
import createEntry, { type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import type { Computer, Ended, Scheduler } from "@ermine/scheduler"
import { createChangeHeader } from "./header.ts"
import type { Places } from "./places.ts"

// the attribute, and what it holds while a run is pending
export const STATUS = "ermine.computer.status"
export const PENDING: unique symbol = Symbol.for("ermine.pending") as never

export type Setup = {
	places: Pick<Places, "commit">
	table: Pick<Table, "get" | "add">
	scheduler: Pick<
		Scheduler,
		"runWithScope" | "getCurrentScope" | "getRun" | "onRunEnd" | "onEffect"
	>
}

// listens to the scheduler's onRunEnd from here on
export function createStatus(setup: Setup): {
	// the node a computer's status is written on
	give: (computer: Computer, id: Id) => void
	// stop listening
	stop: () => void
} {
	const { places, table, scheduler } = setup
	const ids = new WeakMap<Computer, Id>()
	// computers whose last act failed: their status is the act's
	const acted = new WeakSet<Computer>()

	// the status a run's end leaves; undefined: none; keep: as it was
	const keep = Symbol("keep")
	function of(ended: Ended, error: unknown): unknown {
		switch (ended) {
			case "pending":
				return PENDING
			case "failed":
				return error === undefined ? new Error("undefined") : error
			case "looping":
				return new Error("looping")
			case "done":
				return undefined
			default:
				return keep
		}
	}

	// the status written, with c open: nothing when it is already so
	function write(c: Computer, id: Id, status: unknown) {
		scheduler.runWithScope(c, () => {
			const there = table.get("attributes", id) as Entry<unknown> | undefined
			const v = there?.value as Record<string, unknown> | undefined
			const had = v !== undefined && v !== null && typeof v === "object" &&
				Object.hasOwn(v, STATUS)
			if (status === undefined ? !had : had && v![STATUS] === status) return
			// made only for a write: its site is a stack read
			const header = createChangeHeader(scheduler)
			if (there === undefined) {
				const made = createEntry<Record<string, unknown>>({ [STATUS]: status }, header)
				table.add("attributes", id, made as Entry<Tables["attributes"]>)
				return
			}
			const patches: Patch[] = []
			if (v === undefined || v === null || typeof v !== "object") {
				patches.push({ path: [], value: {} })
			}
			patches.push(status === undefined ? { path: [STATUS] } : { path: [STATUS], value: status })
			update(there, patches, header)
			places.commit([there])
		})
	}

	const stopRuns = scheduler.onRunEnd((c, _n, ended, _reads, more) => {
		const id = ids.get(c)
		if (id === undefined) return
		const status = of(ended, more.error)
		if (status === keep) return
		// done leaves a failed act's; any other end is the status
		if (status === undefined && acted.has(c)) return
		acted.delete(c)
		write(c, id, status)
	})
	const stopActs = scheduler.onEffect((c, _n, more) => {
		const id = ids.get(c)
		if (id === undefined) return
		if ("error" in more) {
			acted.add(c)
			write(c, id, more.error === undefined ? new Error("undefined") : more.error)
		} else if (acted.delete(c)) write(c, id, undefined)
	})
	const stop = () => {
		stopRuns()
		stopActs()
	}

	return { give: (c, id) => void ids.set(c, id), stop }
}

// a computer's status, by its node's id, the read told: PENDING, an Error, or undefined
export const status = (places: Pick<Places, "readValue">, id: Id): unknown =>
	places.readValue("attributes", id, [STATUS])

// whether a computer's run is pending, by its node's id, the read told
export const isPending = (places: Pick<Places, "readValue">, id: Id): boolean =>
	status(places, id) === PENDING
