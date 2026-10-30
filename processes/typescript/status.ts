// A computer's status, in a table of its own (not the node's attributes), so a program that
// writes attributes can't forge a status.
import type { Id, Table } from "@ermine/graph/table"
import createEntry, { type Entry } from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { type Computer, type Ended, PENDING, type Scheduler } from "@ermine/reactivity"
import { createChangeHeader } from "@ermine/places/header"
import type { Places, Writer } from "@ermine/places"

export type StatusTables = { status: Record<string, unknown> }

export const TABLE = "status"
export const STATUS = "ermine.computer.status"
export { PENDING }

export type Setup = {
	write?: Writer
	places: Pick<Places, "commit">
	table: Pick<Table, "get" | "add">
	scheduler: Pick<
		Scheduler,
		"runWithScope" | "getCurrentScope" | "getCurrentFrame" | "getRun" | "onRunEnd" | "onEffect"
	>
	now?: () => number
}

export function createStatus(setup: Setup): {
	give: (computer: Computer, id: Id) => void
	stop: () => void
} {
	const { places, table, scheduler } = setup
	const ids = new WeakMap<Computer, Id>()
	const acted = new WeakSet<Computer>()

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

	function write(c: Computer, id: Id, status: unknown) {
		scheduler.runWithScope(c, () => {
			const there = table.get(TABLE, id) as Entry<unknown> | undefined
			const v = there?.value as Record<string, unknown> | undefined
			const had = v !== undefined && v !== null && typeof v === "object" &&
				Object.hasOwn(v, STATUS)
			if (status === undefined ? !had : had && v![STATUS] === status) return
			const header = createChangeHeader(scheduler, { now: setup.now })
			if (setup.write !== undefined) {
				const patches: Patch[] = there === undefined ||
						v === undefined || v === null || typeof v !== "object"
					? [{ path: [], value: { ...status === undefined ? {} : { [STATUS]: status } } }]
					: [status === undefined ? { path: [STATUS] } : { path: [STATUS], value: status }]
				setup.write(TABLE, id, patches, header)
				return
			}
			if (there === undefined) {
				const made = createEntry<Record<string, unknown>>({ [STATUS]: status }, header)
				table.add(TABLE, id, made)
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

export const status = (places: Pick<Places, "readValue">, id: Id): unknown =>
	places.readValue(TABLE, id, [STATUS])

export const isPending = (places: Pick<Places, "readValue">, id: Id): boolean =>
	status(places, id) === PENDING
