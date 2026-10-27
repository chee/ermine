// what the suite (conformance/ermine) can't say on the line protocol: the base's own files, a
// made-up context, close() with every teardown held, two onTable layers stacked
import { addTeardown, createAction, createBox, read } from "@ermine/system"
import { registrations } from "./registry.ts"
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

// how often the boxes' folders' names are looked up (up, system.ts), as reads walk paths
function namesLooked(e: { places: { namesOf: (id: string) => unknown } }) {
	const places = e.places as { namesOf: (id: string) => unknown }
	const was = places.namesOf
	let n = 0
	places.namesOf = (id) => (n++, was(id))
	return () => n
}

Deno.test("reads walk the boxes by an index: none of the boxes' names looked up again till a name changes", () => {
	const e = createErmine({ schedule: () => {} })
	e.ensureNode("/a/b/c/x", 1)
	for (let i = 0; i < 200; i++) e.createBox(`/boxes/b${i}`)
	const looked = namesLooked(e)
	e.read("/a/b/c/x")
	const once = looked()
	for (let i = 0; i < 100; i++) e.read("/a/b/c/x"), e.read(e.getNode("/a/b/c/x"))
	assertEquals(looked(), once, "a read walked every box")
	// a name changed: walked again, once
	e.ensureNode("/a/y", 2)
	for (let i = 0; i < 100; i++) e.read("/a/b/c/x")
	assert(looked() <= 2 * once + 10, `${looked() - once} looked up after one name changed`)
	e.close()
})

Deno.test("createBox at one folder again and again is one box; a box nothing reaches, holding no rows, let go", () => {
	const e = createErmine({ schedule: () => {} })
	e.ensureNode("/x", 1)
	e.start(() => void createAction("on/box", () => void createBox("./same")), "/code/p")
	for (let i = 0; i < 100; i++) e.executeAction("/code/p/on/box")
	const looked = namesLooked(e)
	e.ensureNode("/y", 1)
	e.read("/x")
	// the root's box and one at /code/same: two folders' names, a few steps each
	assert(looked() < 20, `${looked()} looked up: every createBox kept`)
	e.unplace("/code/same")
	e.read("/x")
	const after = looked()
	e.ensureNode("/z", 1)
	e.read("/x")
	// the one nothing reaches, let go: only the root's walked
	assert(looked() - after <= 2, `${looked() - after} looked up: the unreachable box kept`)
	e.close()
})

Deno.test("a read of a node not there, outside a setup or a run, keeps nothing: reads don't slow as they pile up", () => {
	const e = createErmine({ schedule: () => {} })
	e.start(() => void createAction("on/look", (p: string) => read(p)), "/code/p")
	const missing = (from: string, n: number) => {
		const t = performance.now()
		for (let i = 0; i < n; i++) {
			assertThrows(() => e.read(`/m/${from}${i}`))
			assertThrows(() => e.executeAction("/code/p/on/look", `/m/${from}a${i}`))
		}
		return performance.now() - t
	}
	missing("w", 500)
	const first = missing("f", 1000)
	missing("pile", 20000)
	const last = missing("l", 1000)
	assert(last < first * 4, `1000 reads took ${first.toFixed(1)} ms, then ${last.toFixed(1)} ms`)
	e.close()
})

Deno.test("trace: a write outside a run keeps its whole trace text, through later copies; trace: false, none", async () => {
	const { traceOf } = await import("@ermine/core/places/header")
	const changeAt = (e: ReturnType<typeof createErmine>, path: string[]) => {
		let id = e.places.root as string
		for (const n of path) id = (e.table.get("children", id)?.value as Record<string, string>)[n]
		return e.table.get("value", id)!.change
	}
	const e = createErmine()
	function deepInTheProgram() {
		e.ensureNode("/x", 1)
	}
	deepInTheProgram()
	const text = traceOf(changeAt(e, ["x"]))
	assert(text !== undefined && text.includes("deepInTheProgram"))
	e.patch("/x", [{ path: [], value: 2 }])
	function another() {
		e.patch("/x", [{ path: [], value: 3 }])
	}
	another()
	assert(traceOf(changeAt(e, ["x"]))?.includes("another"))
	const off = createErmine({ trace: false })
	off.ensureNode("/y", 1)
	assertEquals(traceOf(changeAt(off, ["y"])), undefined)
	assertEquals(typeof changeAt(off, ["y"]).external?.[0]?.line, "number")
})

Deno.test("close() runs every step when one throws, throws the first error at the end, and is closed", () => {
	const real = createScheduler()
	let boom = false
	const scheduler: Scheduler = {
		...real,
		teardown: (scope) => {
			if (boom) throw new Error("boom")
			return real.teardown(scope)
		},
	}
	const e = createErmine({ scheduler, schedule: () => {} })
	assertEquals(registrations(scheduler), 1)
	boom = true
	assertThrows(() => e.close(), Error, "boom")
	// every step ran: unregistered, and closed (a second close is nothing)
	assertEquals(registrations(scheduler), 0)
	assertThrows(() => e.read("/"), ErmineError, "closed")
	e.close()
})

Deno.test("createErmine throwing after it registered its scheduler undoes the registration", () => {
	const scheduler = createScheduler()
	assertThrows(() => createErmine({ scheduler, host: { at: "" }, schedule: () => {} }))
	assertEquals(registrations(scheduler), 0)
})
