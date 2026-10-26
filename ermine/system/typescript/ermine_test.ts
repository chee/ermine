// what the suite (conformance/ermine) can't say on the line protocol: the base's own files, a
// made-up context, close() with every teardown held, two onTable layers stacked
import { addTeardown } from "@ermine/system"
import { assert, assertEquals, assertThrows } from "@std/assert"
import { createScheduler, type Scheduler } from "@ermine/core/scheduler"
import {
	createErmine,
	ErmineError,
	type Feature,
	type FeatureAPI,
	type Layer,
	type ProcessContext,
} from "./ermine.ts"

const BASE = ["ermine.ts", "system.ts", "context.ts", "calls.ts", "features.ts"]

// the program a test wrote at a node (ensureNode), as start takes it: its function
const programAt = (e: { read: (x: string) => unknown }, at: string) => e.read(at) as () => unknown

Deno.test("the base holds nothing of patch nodes' or sync's", async () => {
	for (const f of BASE) {
		const text = await Deno.readTextFile(new URL(`./${f}`, import.meta.url))
		const code = text.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n")
		assert(!/@ermine\/(patchy|pully|together)/.test(code), `${f} imports patch nodes or sync`)
		assert(!/"values"|REPLACES|overlay|layers/.test(code), `${f} names sync's or patch nodes'`)
	}
})

Deno.test("close() finishes when a feature holds every teardown back", () => {
	const held: string[] = []
	const hold: Feature = {
		name: "hold",
		setup: (f) => f.onTeardown((_scope, why) => void held.push(why)),
	}
	const told: string[] = []
	const e = createErmine({ features: [hold], schedule: () => {} })
	e.ensureNode("/code/p", () => addTeardown((why) => told.push(why)))
	const p = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in p))
	e.addTeardown((why) => told.push(why))
	e.close()
	assertEquals(told, [])
	assertEquals(held, ["ended", "ended"])
	assertEquals(p.process.scope.state, "gone")
	assertThrows(() => e.read("/"), ErmineError, "closed")
})

Deno.test("two onTable layers stack: table events and commits go through both, inner first", () => {
	const seen: string[] = []
	const counting = (name: string): Feature => ({
		name,
		setup: (f) =>
			f.onTable((table, next) => {
				const under = next(table)
				const layer: Layer = {
					get: under.get,
					who: under.who,
					onTableChange: (part, id) => {
						seen.push(`${name} event`)
						table.ahead().onTableChange(part, id)
					},
					commit: (changed) => {
						seen.push(`${name} commit`)
						table.ahead().commit(changed)
					},
				}
				return layer
			}),
	})
	const e = createErmine({ features: [counting("outer"), counting("inner")], schedule: () => {} })
	seen.length = 0
	e.ensureNode("/x", { n: 1 })
	e.patch("/x", [{ path: ["n"], value: 2 }])
	assertEquals(e.read("/x", ["n"]), 2)
	assert(seen.length > 0)
	for (let i = 0; i < seen.length; i += 2) {
		assertEquals(seen[i].split(" ")[0], "inner")
		assertEquals(seen[i + 1], seen[i].replace("inner", "outer"))
	}
	e.close()
})

// a scheduler whose registerTeardown calls are counted, by scope
function counted() {
	const s = createScheduler()
	const on = new Map<unknown, number>()
	const registerTeardown: Scheduler["registerTeardown"] = (o, f) => {
		on.set(o, (on.get(o) ?? 0) + 1)
		return s.registerTeardown(o, f)
	}
	return { scheduler: { ...s, registerTeardown }, on }
}

Deno.test("a caller's waits made and answered again and again register one teardown", () => {
	const { scheduler, on } = counted()
	const e = createErmine({ scheduler, schedule: () => {} })
	const host = e.getProcessContext()!.scope
	const before = on.get(host) ?? 0
	for (let i = 0; i < 20; i++) {
		assertThrows(() => e.executeAction("/svc"))
		assertEquals(e.records.waits().length, 1)
		e.ensureNode("/svc", () => i)
		assertEquals(e.executeAction("/svc"), i)
		assertEquals(e.records.waits().length, 0)
		e.remove("/svc")
	}
	assert((on.get(host) ?? 0) - before <= 1, `${(on.get(host) ?? 0) - before} registered`)
	e.close()
})

Deno.test("one method placed again and again registers one teardown", () => {
	const { scheduler, on } = counted()
	const e = createErmine({ scheduler, schedule: () => {} })
	const host = e.getProcessContext()!.scope
	const before = on.get(host) ?? 0
	for (let i = 0; i < 20; i++) e.createAction("/svc", () => i)
	assertEquals(e.executeAction("/svc"), 19)
	assert((on.get(host) ?? 0) - before <= 1, `${(on.get(host) ?? 0) - before} registered`)
	e.close()
})

Deno.test("close() takes out what features listen to on the scheduler", () => {
	const s = createScheduler()
	let told = 0
	const listening: Feature = {
		name: "listening",
		setup: (f) => void f.scheduler.onAfterPulse(() => void told++),
	}
	const e = createErmine({ scheduler: s, features: [listening], schedule: () => {} })
	s.pulse()
	assertEquals(told, 1)
	e.close()
	s.pulse()
	assertEquals(told, 1)
})

Deno.test("a feature's scheduler works in every member, the on… ones and the rest", () => {
	const s = createScheduler()
	let inside: unknown
	const using: Feature = {
		name: "using",
		setup: (f) => {
			const scope = f.scheduler.createRootScope({ node: "using" })
			f.scheduler.runWithScope(scope, () => void (inside = f.scheduler.getCurrentScope()))
			assertEquals(inside, scope)
			assertEquals(Object.keys(f.scheduler).sort(), Object.keys(s).sort())
		},
	}
	createErmine({ scheduler: s, features: [using], schedule: () => {} }).close()
	assert(inside !== undefined)
})

Deno.test("closed, records, calling and node throw closed as the other parts do", () => {
	const e = createErmine({ schedule: () => {} })
	e.close()
	assertThrows(() => e.records.call("x"), ErmineError, "closed")
	assertThrows(() => e.records.run("x"), ErmineError, "closed")
	assertThrows(() => e.records.waits(), ErmineError, "closed")
	assertThrows(() => e.calling(), ErmineError, "closed")
	assertThrows(() => e.node, ErmineError, "closed")
})

Deno.test("a feature's context(process) is undefined once the process stopped, and typed so", () => {
	let api: FeatureAPI | undefined
	const keep: Feature = { name: "keep", setup: (f) => void (api = f) }
	const e = createErmine({ features: [keep], schedule: () => {} })
	e.ensureNode("/code/p", () => 1)
	const p = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in p))
	assert(api!.getProcessContext(p.process) !== undefined)
	p.stop()
	// @ts-expect-error: a stopped process has no context
	const o: ProcessContext = api!.getProcessContext(p.process)
	assertEquals(o, undefined)
	const host: ProcessContext = api!.getProcessContext()
	assert(host !== undefined)
	e.close()
})
