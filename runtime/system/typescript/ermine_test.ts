// What the conformance suite cannot say on the line protocol: the base's own files, a made-up
// context, and the ids.
import {
	createAction,
	ensureNode,
	executeAction,
	patch,
	read,
	readAll,
	remove,
} from "@ermine/system"
import { registrations } from "./registry.ts"
import { NAMES } from "./system/index.ts"
import { assert, assertEquals, assertThrows } from "@std/assert"
import { createScheduler, type Scheduler } from "@ermine/reactivity"
import {
	createErmine,
	ErmineError,
	type Feature,
	type FeatureAPI,
	type ProcessContext,
} from "./ermine.ts"

const programAt = (e: { within: <T>(f: () => T) => T }, at: string) =>
	e.within(() => read(at)) as () => unknown

Deno.test("the system folder's list of files names every file in it", async () => {
	const files: string[] = []
	for await (const f of Deno.readDir(new URL("./system/", import.meta.url))) files.push(f.name)
	assertEquals(files.sort(), NAMES.map((f) => `${f}.ts`).sort())
})

Deno.test("every change takes its time from the clock createErmine is given", () => {
	const e = createErmine({ now: () => 1_700_000_000_999 })
	e.within(() => ensureNode("/a", 1))
	e.within(() => patch("/a", [{ path: [], value: 2 }]))
	const p = e.start(() => ensureNode("made", 3), "/code/p")
	assert(!("refused" in p))
	const times = e.within(() =>
		["/a", "/code/p", "/code/p/made"].map((at) => readAll(at)[0]?.from.change?.time)
	)
	assertEquals(times, [1_700_000_000, 1_700_000_000, 1_700_000_000])
	e.close()
})

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
	const e = createErmine({ autopulse: false, scheduler })
	const host = e.getProcessContext()!.scope
	const before = on.get(host) ?? 0
	for (let i = 0; i < 20; i++) {
		assertThrows(() => e.within(() => executeAction("/svc")))
		assertEquals(e.records.waits().length, 1)
		e.within(() => ensureNode("/svc", () => i))
		assertEquals(e.within(() => executeAction("/svc")), i)
		assertEquals(e.records.waits().length, 0)
		e.within(() => remove("/svc"))
	}
	assert((on.get(host) ?? 0) - before <= 1, `${(on.get(host) ?? 0) - before} registered`)
	e.close()
})

Deno.test("one method placed again and again registers one teardown", () => {
	const { scheduler, on } = counted()
	const e = createErmine({ autopulse: false, scheduler })
	const host = e.getProcessContext()!.scope
	const before = on.get(host) ?? 0
	for (let i = 0; i < 20; i++) e.within(() => createAction("/svc", () => i))
	assertEquals(e.within(() => executeAction("/svc")), 19)
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
	const e = createErmine({ scheduler: s, autopulse: false, features: [listening] })
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
	createErmine({ scheduler: s, autopulse: false, features: [using] }).close()
	assert(inside !== undefined)
})

Deno.test("closed, records, a feature's calling and id throw closed as the other parts do", () => {
	let api: FeatureAPI | undefined
	const e = createErmine({
		autopulse: false,
		features: [{ name: "keep", setup: (f) => void (api = f) }],
	})
	e.close()
	assertThrows(() => e.records.call("x"), ErmineError, "closed")
	assertThrows(() => e.records.run("x"), ErmineError, "closed")
	assertThrows(() => e.records.waits(), ErmineError, "closed")
	assertThrows(() => api!.calling(), ErmineError, "closed")
	assertThrows(() => e.id, ErmineError, "closed")
})

Deno.test("a feature's context(process) is undefined once the process stopped, and typed so", () => {
	let api: FeatureAPI | undefined
	const keep: Feature = { name: "keep", setup: (f) => void (api = f) }
	const e = createErmine({ autopulse: false, features: [keep] })
	e.within(() => ensureNode("/code/p", () => 1))
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

Deno.test("a read of a node not there, outside a setup or a run, keeps nothing: reads don't slow as they pile up", () => {
	const e = createErmine({ autopulse: false })
	e.start(() => void createAction("on/look", (p: string) => read(p)), "/code/p")
	const missing = (from: string, n: number) => {
		const t = performance.now()
		for (let i = 0; i < n; i++) {
			assertThrows(() => e.within(() => read(`/m/${from}${i}`)))
			assertThrows(() => e.within(() => executeAction("/code/p/on/look", `/m/${from}a${i}`)))
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
	const e = createErmine({ autopulse: false, scheduler })
	assertEquals(registrations(scheduler), 1)
	boom = true
	assertThrows(() => e.close(), Error, "boom")
	assertEquals(registrations(scheduler), 0)
	assertThrows(() => e.within(() => read("/")), ErmineError, "closed")
	e.close()
})

// A scheduler that counts what is listening on it. The first off of a listener on throwing (an on…
// name) throws after it took its listener out.
function counting(throwing?: string) {
	const real = createScheduler()
	const s = { ...real } as Scheduler & { live: number }
	s.live = 0
	for (const k of Object.keys(real)) {
		const on = (real as unknown as Record<string, unknown>)[k]
		if (!/^on[A-Z]/.test(k) || typeof on !== "function") continue
		;(s as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
			const off = (on as (...a: unknown[]) => () => void)(...a)
			const kind = k
			s.live++
			let done = false
			return () => {
				if (!done) s.live--
				done = true
				off()
				if (throwing === kind) {
					throwing = undefined
					throw new Error("off")
				}
			}
		}
	}
	return s
}

Deno.test("createErmine throwing leaves nothing listening on a scheduler it was given", () => {
	const setting = counting()
	const late: Feature = {
		name: "late",
		setup: (f) => {
			f.scheduler.onAfterPulse(() => {})
			throw new Error("late")
		},
	}
	const early: Feature = { name: "early", setup: (f) => void f.scheduler.onSettle(() => {}) }
	assertThrows(
		() => createErmine({ autopulse: false, features: [early, late], scheduler: setting }),
		Error,
	)
	assertEquals(setting.live, 0)

	const closing = counting()
	createErmine({ autopulse: false, features: [early], scheduler: closing }).close()
	assertEquals(closing.live, 0)
})

Deno.test("code outside any process acts as the root; a feature's newId is createId's", () => {
	let api: FeatureAPI | undefined
	let n = 0
	const ids: Feature = {
		name: "ids",
		setup: (f) => {
			assertThrows(() => f.newId(), ErmineError, "newId")
			api = f
		},
	}
	const e = createErmine({ root: "R", features: [ids], createId: () => `n${n++}` })
	assertEquals([e.places.root, e.id], ["R", "R"])
	const made = api!.newId()
	assert(made.startsWith("n"), made)
	e.close()
})

Deno.test("a hook added while createErmine is making is refused setup-only, not kept by some chains", () => {
	const scheduler = counting()
	let api: FeatureAPI | undefined
	const late: Feature = { name: "late", setup: (f) => void (api = f) }
	const createId = () => {
		api!.onRead((x, items, next) => next(x, items))
		return "x"
	}
	assertThrows(
		() => createErmine({ autopulse: false, features: [late], scheduler, createId }),
		Error,
		"setup-only",
	)
	assertEquals(scheduler.live, 0)
})
