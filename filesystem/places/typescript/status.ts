// a computation's status, on its own node: never saved, at one place. the attribute
// ermine.computer.status holds PENDING while a run is pending, an Error when one failed (a loop:
// an Error "looping"), and is gone when a run is done. a run stopped (a newer one follows) leaves
// it. written from the scheduler's moments by the computation itself, so a computation reading its
// own status is its own loop, as any write of its is
import type { Id, Table, Tables } from "@ermine/graph/table"
import createEntry, { type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import type { Computation, Moment, Scheduler } from "@ermine/scheduler"
import { createChangeHeader } from "./header.ts"
import type { Places } from "./places.ts"

// the attribute, and what it holds while a run is pending
export const STATUS = "ermine.computer.status"
export const PENDING: unique symbol = Symbol.for("ermine.pending") as never

export type Setup = {
	places: Pick<Places, "markChanged">
	table: Pick<Table, "get" | "add">
	scheduler: Pick<Scheduler, "run" | "current">
}

export function createStatus(setup: Setup): {
	// the node a computation's status is written on
	give: (computation: Computation, id: Id) => void
	// the scheduler's hook, or called from it: each run's end writes the status
	moment: (moment: Moment) => void
} {
	const { places, table, scheduler } = setup
	const ids = new WeakMap<Computation, Id>()

	// the status a run's end leaves; undefined: none; keep: as it was
	const keep = Symbol("keep")
	function of(m: Extract<Moment, { ends: unknown }>): unknown {
		switch (m.ended) {
			case "pending":
				return PENDING
			case "failed":
				return m.error instanceof Error ? m.error : new Error(String(m.error))
			case "looping":
				return new Error("looping")
			case "done":
				return undefined
			default:
				return keep
		}
	}

	// the status written, by the computation: nothing when it is already so
	function write(c: Computation, id: Id, status: unknown) {
		scheduler.run(c, () => {
			const header = createChangeHeader(scheduler)
			const there = table.get("attributes", id) as Entry<unknown> | undefined
			const v = there?.value as Record<string, unknown> | undefined
			const had = v !== undefined && v !== null && typeof v === "object" &&
				Object.hasOwn(v, STATUS)
			if (status === undefined ? !had : had && v![STATUS] === status) return
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
			places.markChanged([there])
		})
	}

	function moment(m: Moment) {
		if (!("ends" in m)) return
		const id = ids.get(m.ends)
		if (id === undefined) return
		const status = of(m)
		if (status !== keep) write(m.ends, id, status)
	}

	return { give: (c, id) => void ids.set(c, id), moment }
}

// a computation's status, by its node's id, the read told: PENDING, an Error, or undefined
export const status = (places: Pick<Places, "readValue">, id: Id): unknown =>
	places.readValue("attributes", id, [STATUS])

// whether a computation's run is pending, by its node's id, the read told
export const isPending = (places: Pick<Places, "readValue">, id: Id): boolean =>
	status(places, id) === PENDING
