import { assert, assertEquals, assertInstanceOf } from "@std/assert"
import { createTable, type Key } from "@ermine/graph/table"
import { createScheduler, PENDING as WAIT } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createPlaces } from "@ermine/places"
import { createStatus, isPending, PENDING, status } from "./status.ts"

function world() {
	const s = createScheduler()
	s.onTrackingEnd((k) => places.release(k))
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	const statuses = createStatus({ places, table, scheduler: s })
	const o = s.createRootScope({ actor: "host" })
	return { s, table, places, statuses, o }
}

Deno.test("status: pending while a run waits, gone when it is done; a reader of it reruns", async () => {
	const { s, places, statuses, o } = world()
	let resolve!: (v: number) => void
	const gate = new Promise<number>((r) => resolve = r)
	const c = s.runWithScope(o, () => s.createComputer(async () => await gate, () => {}))
	statuses.give(c, "C")
	const seen: unknown[] = []
	s.runWithScope(o, () => s.createComputer(() => isPending(places, "C"), (v) => void seen.push(v)))
	s.pulse()
	assertEquals(status(places, "C"), PENDING)
	resolve(1)
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals(status(places, "C"), undefined)
	assertEquals(seen, [true, false])
})

Deno.test("status: an Error when a run fails, the error itself; gone at the next done", () => {
	const { s, table, places, statuses, o } = world()
	table.add("value", "k", {
		value: 0,
		change: { time: 0, actor: "host", frame: { info: {}, parent: undefined } },
	})
	const c = s.runWithScope(o, () =>
		s.createComputer(() => {
			const k = places.readValue("value", "k") as number
			if (k === 1) throw new Error("one")
			return k
		}, () => {}))
	statuses.give(c, "C")
	s.pulse()
	assertEquals(status(places, "C"), undefined)
	const set = (v: number) =>
		s.runWithScope(o, () => {
			table.get("value", "k")!.value = v
			places.onTableChange("value", "k")
		})
	set(1)
	s.pulse()
	const e = status(places, "C")
	assertInstanceOf(e, Error)
	assertEquals(e.message, "one")
	set(2)
	s.pulse()
	assertEquals(status(places, "C"), undefined)
})

Deno.test("status: a computation returning the scheduler's PENDING is pending too; one not given a node, nothing", () => {
	const { s, table, places, statuses, o } = world()
	const c = s.runWithScope(o, () => s.createComputer(() => WAIT, () => {}))
	statuses.give(c, "C")
	s.runWithScope(o, () => s.createComputer(() => WAIT, () => {}))
	s.pulse()
	assertEquals(status(places, "C"), PENDING)
	assert(table.get("status", "C") !== undefined)
	assertEquals([...table.get("C")].map(([part]) => part), ["status"])
})
