// pullynode (pullynode.ts) on a real scheduler, table and places
import { assert, assertEquals, assertRejects } from "@std/assert"
import { createTable, type Key } from "@ermine/table"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createPlaces } from "@ermine/places"
import { createProviders, type Provider, STATUS, statusOf, type Write } from "./pullynode.ts"

function world() {
	const s = createScheduler()
	s.onTrackingEnd((k) => places.release(k))
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	const providers = createProviders({ scheduler: s, places, table })
	const o = s.createRootScope({ actor: "test" })
	// a reader of f while its switch is on; what it saw, each run
	const reader = (f: () => unknown) => {
		const on = { reading: true }
		const key = {}
		const seen: unknown[] = []
		const c = s.runWithScope(o, () =>
			s.createComputer(() => {
				s.track(key)
				return on.reading ? f() : "off"
			}, (v) => void seen.push(v)))
		s.pulse()
		const stop = () => {
			on.reading = false
			s.runWithScope(o, () => s.mark([key], undefined))
			s.pulse()
		}
		return { c, seen, stop }
	}
	return { s, table, places, providers, reader }
}

// a provider that writes when told, and says what was done to it
function hand() {
	const said: string[] = []
	let write: Write | undefined
	const provider: Provider = {
		start(w, woke) {
			said.push(woke ? "start in a run" : "start")
			write = w
			return () => {
				said.push("stop")
				write = undefined
			}
		},
	}
	const put = (value: unknown) => write!([{ path: [], value }])
	return { provider, said, put, running: () => write !== undefined }
}

Deno.test("pullynode: provided, asleep; nothing reads it, nothing starts", () => {
	const { places, providers } = world()
	const p = hand()
	providers.provide("N", p.provider)
	assertEquals(p.said, [])
	assertEquals(places.peep(() => statusOf(places, "N")), "asleep")
})

Deno.test("pullynode: a read in a run wakes it, after the run; waking, then awake at its first write", () => {
	const { s, places, providers, reader } = world()
	const p = hand()
	providers.provide("N", p.provider)
	const r = reader(() => [places.readValue("value", "N"), statusOf(places, "N")])
	assertEquals(p.said, ["start in a run"])
	// the status lands as the pulse ends: its readers run in the next
	s.pulse()
	assertEquals(r.seen, [[undefined, "asleep"], [undefined, "waking"]])
	p.put(1)
	s.pulse()
	assertEquals(r.seen.at(-1), [1, "awake"])
})

Deno.test("pullynode: any read of the value wakes it, at any path, its names, its change; one start", () => {
	const { places, providers, reader } = world()
	const p = hand()
	providers.provide("N", p.provider)
	reader(() => places.readValue("value", "N", ["a", "b"]))
	reader(() => places.readKeys("value", "N"))
	reader(() => places.readChange("value", "N"))
	assertEquals(p.said, ["start in a run"])
	assertEquals(providers.reading("N"), true)
})

Deno.test("pullynode: reads of attributes or children wake nothing", () => {
	const { places, providers, reader } = world()
	const p = hand()
	providers.provide("N", p.provider)
	reader(() => places.readValue("attributes", "N", ["size"]))
	reader(() => places.readValue("children", "N"))
	assertEquals(p.said, [])
})

Deno.test("pullynode: two readers, one start; the last leaving stops it, asleep, its value kept", () => {
	const { places, providers, reader } = world()
	const p = hand()
	providers.provide("N", p.provider)
	const a = reader(() => places.readValue("value", "N"))
	const b = reader(() => places.readValue("value", "N", ["x"]))
	p.put({ x: 2 })
	a.stop()
	assertEquals([p.said, p.running()], [["start in a run"], true])
	b.stop()
	assertEquals([p.said, p.running()], [["start in a run", "stop"], false])
	assertEquals(places.peep(() => statusOf(places, "N")), "asleep")
	assertEquals(places.peep(() => places.readValue("value", "N")), { x: 2 })
})

Deno.test("pullynode: woken again, the reader gets the last value at once, waking, then the new one", () => {
	const { s, places, providers, reader } = world()
	const p = hand()
	providers.provide("N", p.provider)
	reader(() => places.readValue("value", "N")).stop()
	assertEquals(p.said, ["start in a run", "stop"])
	const r0 = reader(() => places.readValue("value", "N"))
	p.put("old")
	r0.stop()
	const r = reader(() => [places.readValue("value", "N"), statusOf(places, "N")])
	s.pulse()
	assertEquals(r.seen[0], ["old", "asleep"])
	assertEquals(r.seen.at(-1), ["old", "waking"])
	p.put("new")
	s.pulse()
	assertEquals(r.seen.at(-1), ["new", "awake"])
})

Deno.test("pullynode: woke is the reading run; a write in start is the provider's, not the reader's", () => {
	const { s, places, providers, reader, table } = world()
	let woke: unknown
	providers.provide("N", {
		start(write, run) {
			woke = run?.computer
			write([{ path: [], value: "now" }])
			return () => {}
		},
	}, { actor: "the provider" })
	const r = reader(() => places.readValue("value", "N"))
	assertEquals(woke, r.c)
	s.pulse()
	assertEquals(r.seen.at(-1), "now")
	assertEquals(table.get("value", "N")!.change.actor, "the provider")
	assertEquals(places.peep(() => statusOf(places, "N")), "awake")
})

Deno.test("pullynode: check, with once: once's value written and given, nothing started, status kept", async () => {
	const { places, providers } = world()
	let started = 0
	providers.provide("N", {
		start: () => (started++, () => {}),
		once: () => Promise.resolve(7),
	})
	assertEquals(await providers.check("N"), 7)
	assertEquals(started, 0)
	assertEquals(places.peep(() => places.readValue("value", "N")), 7)
	assertEquals(places.peep(() => statusOf(places, "N")), "asleep")
})

Deno.test("pullynode: check, without once: started, its first write taken, stopped", async () => {
	const { places, providers } = world()
	const p = hand()
	providers.provide("N", p.provider)
	const v = providers.check("N")
	assertEquals(p.said, ["start"])
	p.put(3)
	assertEquals(await v, 3)
	assertEquals([p.said, p.running()], [["start", "stop"], false])
	assertEquals(places.peep(() => statusOf(places, "N")), "asleep")
})

Deno.test("pullynode: a reader coming while a check runs keeps it running, awake", async () => {
	const { s, places, providers, reader } = world()
	const p = hand()
	providers.provide("N", p.provider)
	const v = providers.check("N")
	const r = reader(() => places.readValue("value", "N"))
	assertEquals(p.said, ["start"])
	p.put(4)
	assertEquals(await v, 4)
	s.pulse()
	assertEquals([p.said, p.running(), r.seen.at(-1)], [["start"], true, 4])
	assertEquals(places.peep(() => statusOf(places, "N")), "awake")
	r.stop()
	assertEquals(p.said, ["start", "stop"])
})

Deno.test("pullynode: check while awake gives the value there, starting nothing", async () => {
	const { places, providers, reader } = world()
	const p = hand()
	providers.provide("N", p.provider)
	reader(() => places.readValue("value", "N"))
	p.put(5)
	assertEquals(await providers.check("N"), 5)
	assertEquals(p.said, ["start in a run"])
})

Deno.test("pullynode: a second provider for an id throws; its stop lets another provide", () => {
	const { providers } = world()
	const stop = providers.provide("N", hand().provider)
	let threw = false
	try {
		providers.provide("N", hand().provider)
	} catch {
		threw = true
	}
	assert(threw)
	stop()
	providers.provide("N", hand().provider)
})

Deno.test("pullynode: a provider's stop stops it running, asleep; readers then wake nothing", () => {
	const { places, providers, reader } = world()
	const p = hand()
	const stop = providers.provide("N", p.provider)
	const r = reader(() => places.readValue("value", "N"))
	stop()
	assertEquals([p.said, places.peep(() => statusOf(places, "N"))], [
		["start in a run", "stop"],
		"asleep",
	])
	r.stop()
	reader(() => places.readValue("value", "N"))
	assertEquals(p.said, ["start in a run", "stop"])
})

Deno.test("pullynode: stop: every provider stopped, the listeners off", () => {
	const { places, providers, reader } = world()
	const a = hand(), b = hand()
	providers.provide("A", a.provider)
	providers.provide("B", b.provider)
	reader(() => places.readValue("value", "A"))
	providers.stop()
	assertEquals([a.said, b.said], [["start in a run", "stop"], []])
	reader(() => places.readValue("value", "B"))
	assertEquals(b.said, [])
})

Deno.test("pullynode: a late write after the last reader left lands, the status stays asleep", () => {
	const { places, providers, reader } = world()
	let write: Write | undefined
	providers.provide("N", { start: (w) => (write = w, () => {}) })
	reader(() => places.readValue("value", "N")).stop()
	write!([{ path: [], value: "late" }])
	assertEquals(places.peep(() => places.readValue("value", "N")), "late")
	assertEquals(places.peep(() => statusOf(places, "N")), "asleep")
})

Deno.test("pullynode: what once throws comes out of check", async () => {
	const { providers } = world()
	providers.provide("N", { start: () => () => {}, once: () => Promise.reject(new Error("nope")) })
	await assertRejects(() => providers.check("N"), Error, "nope")
})

Deno.test("pullynode: the status is an attribute beside others there", () => {
	const { table, places, providers } = world()
	table.add("attributes", "N", { value: { size: 9 }, change: { time: 0, actor: "host" } })
	providers.provide("N", hand().provider)
	assertEquals(places.peep(() => places.readValue("attributes", "N")), {
		size: 9,
		[STATUS]: "asleep",
	})
})
