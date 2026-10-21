// what the conformance suites cannot say (dens.ts, away.ts): runners giving promises (a late
// handle's stop throwing too), an offer at an id another wrote, a process offering from inside its
// run, a runner as { start, load, api } and as a function, ermine/api's runner on a den (its api
// composed over, a stop's reason told to its teardowns, a load's live form called in a memo: its
// throw the memo's), the pulse a start asks for, what nodes() shows, the owner torn down from above,
// and the type-level fits; and of a link: what connect needs, answer(n) tracked over a
// channel that delivers later, carry, what a link drops or answers with an error, what a stopped
// link leaves on the den (nothing), a mirrored failure as an Error, and its scope torn down from
// above. one world: a scheduler, table and places
// (root R, asked processes' rows, the away trie and children), the host's scope { actor: "host" },
// a program /apps/clock.js ("hi", javascript source), a den "mac" with no policy (a link's two
// devices: dens "mac" and "card", each saying yes to all, on an in-memory pair)
import {
	assert,
	assertEquals,
	assertInstanceOf,
	assertStrictEquals,
	assertThrows,
} from "@std/assert"
import { encode } from "@ermine/encoding/cbor"
import createEntry, { type Entry } from "@ermine/node/entry"
import { createScheduler, PENDING, SchedulerError } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { processes } from "@ermine/processes"
import { readPresence } from "@ermine/together/presence"
import { type Channel, createPair } from "@ermine/together/presence/channel"
import { createScopeNodes } from "@ermine/processes/scopes"
import { type API, createProcessContext, type ProcessContext } from "@ermine/api"
import type { Runner as ProgramsRunner, Start as ProgramsStart } from "@ermine/programs/start"
import type { Realms } from "@ermine/realms"
import {
	API as GIVES_API,
	createDen,
	type Handle,
	hashOf,
	type Process,
	PROGRAM_API,
	REASONS,
	type Runnable,
	type Runner,
	type Setup,
	type Start,
	TAKES,
} from "./dens.ts"
import { anchorOf, away, connect } from "./away.ts"

const JS = "com.netscape.javascript-source"
const RUNNER = ["system", "den", "runners", "javascript"]
const CLOCK = ["apps", "clock.js"]
const tick = () => new Promise((r) => setTimeout(r, 0))

// a runner as a function: its start
type Fn = Runner["start"]

// schedule none: the den's pulses asked for are dropped (these tests pulse by hand)
function world(
	o: { schedule?: Setup["schedule"] | null; id?: string; may?: Setup["may"] } = {},
) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({
		root: "R",
		table,
		paths,
		scheduler: s,
		contributors: [processes("R"), away("R"), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: "host" })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v as never, createChangeHeader(s))))
	put("children", "R", { apps: "APPS" })
	put("children", "APPS", { "clock.js": "CLOCK" })
	put("value", "CLOCK", "hi")
	put("attributes", "CLOCK", { "ermine.type": JS })
	const den = hosted(() =>
		createDen({
			scheduler: s,
			table,
			places,
			scopes,
			...(o.schedule === null ? {} : { schedule: o.schedule ?? (() => {}) }),
			id: o.id ?? "mac",
			...(o.may === undefined ? {} : { may: o.may }),
		})
	)
	const offer = (name: string, live: unknown, attributes: Record<string, unknown> = {}) =>
		hosted(() => den.offer("runners", name, { [TAKES]: JS, ...attributes }, live))
	const start = (runner: string[], at: string[], program: string[] = CLOCK): Process => {
		const p = hosted(() => den.start(runner, program, at))
		if ("refused" in p) throw new Error(p.refused)
		return p
	}
	const status = (p: Process) => table.get("attributes", p.id)?.value?.[STATUS]
	// promises landed, then a pulse, a few times over
	const settle = async () => {
		for (let i = 0; i < 4; i++) {
			await tick()
			s.pulse()
		}
	}
	return { s, table, places, den, hosted, commit, put, offer, start, status, settle }
}

// a runner giving a promise of a handle, landed by hand; its handle's stops, with their reasons
function slow(fail = false) {
	const stops: unknown[] = []
	let land!: () => void
	let calls = 0
	const runner: Fn = () => {
		calls++
		return new Promise<Handle>((resolve, reject) => {
			land = () =>
				fail
					? reject(new Error("no engine"))
					: resolve({ stop: (reason?: unknown) => void stops.push(reason) })
		})
	}
	return { runner, stops, land: () => land(), calls: () => calls }
}

Deno.test("a runner giving a promise of a handle: pending until it lands, then the status gone and the handle kept; a stop gives it the reason", async () => {
	const w = world()
	const r = slow()
	w.offer("javascript", r.runner)
	const p = w.start(RUNNER, ["work", "clock"])
	w.s.pulse()
	assertEquals([r.calls(), w.status(p)], [1, PENDING])
	r.land()
	await w.settle()
	assertEquals(w.status(p), undefined)
	assertEquals(r.stops, [])
	w.hosted(() => w.den.stop(p, "bye"))
	assertEquals(r.stops, ["bye"])
	assertEquals(w.table.get(p.id), [])
})

Deno.test("a runner's promise rejected: its Error the process's status, the process still at its path", async () => {
	const w = world()
	const r = slow(true)
	w.offer("javascript", r.runner)
	const p = w.start(RUNNER, ["work", "clock"])
	w.s.pulse()
	r.land()
	await w.settle()
	const st = w.status(p)
	assertInstanceOf(st, Error)
	assertEquals(st.message, "no engine")
	assertEquals(w.places.peep(() => get(w.places, ["work", "clock"])), p.id)
	w.hosted(() => w.den.stop(p))
	assertEquals(w.places.peep(() => get(w.places, ["work", "clock"])), undefined)
})

Deno.test("stopped before the promise lands: the handle's stop called once as it lands, with the stop's reason", async () => {
	const w = world()
	const r = slow()
	w.offer("javascript", r.runner)
	const p = w.start(RUNNER, ["work", "clock"])
	w.s.pulse()
	w.hosted(() => w.den.stop(p, "SIGTERM"))
	assertEquals([r.stops, w.table.get(p.id)], [[], []])
	r.land()
	await w.settle()
	assertEquals(r.stops, ["SIGTERM"])
	await w.settle()
	assertEquals(r.stops, ["SIGTERM"])
})

Deno.test("stopped before the promise lands, its handle's stop throwing: nothing uncaught (the process gone, nobody to tell)", async () => {
	const w = world()
	let land!: () => void
	const stops: unknown[] = []
	const runner: Fn = () =>
		new Promise<Handle>((resolve) => {
			land = () =>
				resolve({
					stop: (reason?: unknown) => {
						stops.push(reason)
						throw new Error("engine gone")
					},
				})
		})
	w.offer("javascript", runner)
	const p = w.start(RUNNER, ["work", "clock"])
	w.s.pulse()
	w.hosted(() => w.den.stop(p, "bye"))
	land()
	await w.settle()
	assertEquals([stops, w.table.get(p.id)], [["bye"], []])
})

Deno.test("an offer at an id with entries already (another's): refused taken, nothing made, the entries left as they are", () => {
	const w = world()
	const id = `${String(w.den.node)}/runners/lisp`
	w.put("attributes", id, { "ermine.type": "x" })
	const got = w.hosted(() => w.den.offer("runners", "lisp", { [TAKES]: JS }, () => {}))
	assertEquals(got, { refused: "taken", at: ["system", "dens", "mac", "runners", "lisp"] })
	assertEquals(w.den.offers(), [])
	assertEquals(w.table.get("attributes", id)?.value, { "ermine.type": "x" })
	assertEquals(w.table.get("children", `${String(w.den.node)}/runners`), undefined)
})

Deno.test("a process offering from inside its run: its runner under its node, started on; its stop stops its users first, runner-stopped", () => {
	const w = world()
	const log: unknown[] = []
	const xs: Fn = (code, { process }) => {
		log.push(["x ran", code, process.at])
		return { stop: (reason) => void log.push(["x stopped", process.at, reason]) }
	}
	let offered: unknown
	const lisp: Fn = (_, { den, process }) => {
		offered = den.offer("runners", "x", { [TAKES]: "ermine.x-source" }, xs, process.id)
		return { stop: (reason) => void log.push(["lisp stopped", reason]) }
	}
	w.offer("javascript", lisp)
	w.put("value", "X", "(x)")
	w.put("attributes", "X", { "ermine.type": "ermine.x-source" })
	w.put("children", "APPS", { "clock.js": "CLOCK", "x.x": "X" })
	const p = w.start(RUNNER, ["work", "lisp"])
	assertEquals(offered, undefined)
	w.s.pulse()
	const at = ["work", "lisp", "runners", "x"]
	assertEquals(offered, {
		id: `${String(p.id)}/runners/x`,
		at,
		kind: "runners",
		name: "x",
		by: p.id,
	})
	assertEquals(w.places.peep(() => get(w.places, at)), `${String(p.id)}/runners/x`)
	assertEquals(w.table.get("children", p.id)?.value, { runners: `${String(p.id)}/runners` })
	const q = w.start(at, ["work", "q"], ["apps", "x.x"])
	w.s.pulse()
	assertEquals(log, [["x ran", "(x)", ["work", "q"]]])
	w.hosted(() => w.den.stop(p, "done"))
	assertEquals(log.slice(1), [["x stopped", ["work", "q"], REASONS.runner], [
		"lisp stopped",
		"done",
	]])
	assertEquals([w.den.find(q.id), w.places.peep(() => get(w.places, at))], [undefined, undefined])
	assertEquals(w.den.offers().map((o) => o.name), ["javascript"])
})

// ermine/api's context over a world's host: no programs (a den starts processes), no pulses of its own
function contextOf(w: ReturnType<typeof world>): ProcessContext {
	return createProcessContext({
		scheduler: w.s,
		table: w.table,
		commit: w.commit,
		host: { places: w.places, table: w.table, scheduler: w.s, commit: w.commit },
		schedule: () => {},
	})
}

Deno.test("ermine/api on a den: its run offered as runners/javascript, the api the runner's (made from the start); a module program's default export runs and writes through the api", () => {
	const w = world()
	const context = contextOf(w)
	w.offer("javascript", context.run, { [GIVES_API]: "ermine.api" })
	const seen: unknown[] = []
	const program = {
		default: (api: API) => {
			const note = api.open("./note", { n: 1 })
			const twice = api.memo("twice", () => (api.read(note, ["n"]) as number) * 2)
			api.effect("seen", () => api.read(twice), (v) => void seen.push(v))
			return "ran"
		},
	}
	w.put("value", "MOD", program)
	w.put("attributes", "MOD", { "ermine.type": JS, [PROGRAM_API]: "ermine.api" })
	w.put("children", "APPS", { "clock.js": "CLOCK", "mod.js": "MOD" })
	const p = w.start(RUNNER, ["work", "mod"], ["apps", "mod.js"])
	// a live value: no hash pinned
	assertEquals(w.table.get("attributes", p.id)?.value?.["ermine.process.program"], {
		id: "MOD",
		at: ["apps", "mod.js"],
	})
	for (let i = 0; i < 3; i++) w.s.pulse()
	assertEquals(w.table.get("value", p.id)?.value, "ran")
	const note = w.places.peep(() => get(w.places, ["work", "note"]))
	assert(note !== undefined)
	assertEquals(w.table.get("value", note)?.value, { n: 1 })
	assertEquals(seen, [2])
	assertEquals(w.status(p), undefined)
})

Deno.test("a runner as { start, load, api }: start given the start's facts (box, places, process, scheduler, table, scope, den), with its own this; load given the loader's; a function is its start, its own load counted too", () => {
	const w = world()
	const facts: Start[] = []
	const loaded: [unknown, Start][] = []
	const runner = {
		started: 0,
		start(_code: unknown, start: Start) {
			this.started++
			facts.push(start)
			return { stop: () => {} }
		},
		load: (code: unknown, start: Start) => (loaded.push([code, start]), { code }),
		api: (start: Start) => ({ id: start.process.id }),
	}
	w.offer("javascript", runner)
	const p = w.start(RUNNER, ["work", "clock"])
	w.s.pulse()
	assertEquals(runner.started, 1)
	const [f] = facts
	assertEquals(Object.keys(f).sort(), [
		"box",
		"den",
		"places",
		"process",
		"scheduler",
		"scope",
		"table",
	])
	assertEquals(f.process, { id: p.id, at: ["work", "clock"], args: [], cwd: ["work"] })
	assertStrictEquals(f.den, w.den)
	assertStrictEquals(f.scope, p.scope)
	assertEquals(f.box.root, "R")
	const l = w.hosted(() => w.den.load(RUNNER, CLOCK, { by: p }))
	assert(!("refused" in l))
	assertEquals(l.live, { code: "hi" })
	assertEquals(loaded.map(([c, s]) => [c, s.process.id, s.scope === p.scope]), [[
		"hi",
		p.id,
		true,
	]])
	// a function with a load of its own: shorthand for { start, load }
	const calls: unknown[] = []
	const fn = Object.assign((code: unknown) => void calls.push(["start", code]), {
		load: (code: unknown) => (calls.push(["load", code]), {}),
	})
	w.offer("fn", fn)
	const q = w.start(["system", "den", "runners", "fn"], ["work", "fn"])
	w.s.pulse()
	w.hosted(() => w.den.load(["system", "den", "runners", "fn"], CLOCK, { by: q }))
	assertEquals(calls, [["start", "hi"], ["load", "hi"]])
	// a map with no start, a value that is no runner: not-a-runner
	w.offer("nostart", { load: () => 1 })
	assertEquals(
		w.hosted(() => w.den.start(["system", "den", "runners", "nostart"], CLOCK, ["x"])),
		{
			refused: "not-a-runner",
			runner: ["system", "den", "runners", "nostart"],
		},
	)
})

Deno.test("ermine/api on a den, its api composed: a runner's own over context.createAPI ({ ...api, more }); the process's value, its memos' status and runs still written (an api is not its process)", () => {
	const w = world()
	const context = contextOf(w)
	type More = API & { offer: (name: string) => unknown }
	const run = context.runner({
		api: (start) => ({
			...context.createAPI(start),
			offer: (name: string) =>
				(start as Start).den.offer(
					"runners",
					name,
					{ [TAKES]: "x" },
					() => {},
					start.process.id,
				),
		}),
	})
	w.offer("javascript", run)
	const program = {
		default: (api: More) => {
			api.offer("inner")
			const m = api.memo("m", () => {
				throw new Error("boom")
			})
			api.effect("e", () => api.read(m), () => {})
			return "composed"
		},
	}
	w.put("value", "MOD", program)
	w.put("children", "APPS", { "clock.js": "CLOCK", "mod.js": "MOD" })
	w.put("attributes", "MOD", { "ermine.type": JS })
	const p = w.start(RUNNER, ["work", "mod"], ["apps", "mod.js"])
	for (let i = 0; i < 3; i++) w.s.pulse()
	assertEquals(w.table.get("value", p.id)?.value, "composed")
	assertEquals(w.den.offers().map((o) => [o.name, o.by]), [["javascript", w.den.node], [
		"inner",
		p.id,
	]])
	const m = w.places.peep(() => get(w.places, ["work", "mod", "m"]))
	assert(m !== undefined)
	const st = w.table.get("attributes", m)?.value?.[STATUS]
	assertInstanceOf(st, Error)
	assertEquals(context.runs(m)?.error instanceof Error, true)
	// called as programs' runner is, run(code, api), with a copy of an api: it finds its process the same
	w.offer("copy", (code: unknown, start: Start) => context.run(code, { ...run.api(start) }))
	const q = w.start(["system", "den", "runners", "copy"], ["work", "two"], ["apps", "mod.js"])
	w.s.pulse()
	assertEquals(w.table.get("value", q.id)?.value, "composed")
})

Deno.test("a stop's reason reaches ermine/api's teardowns through a den: the handle's stop tells them (SIGHUP, runner-stopped, withdrawn, den-stopped; none: ended); a memo's teardown too", () => {
	const w = world()
	const context = contextOf(w)
	w.offer("javascript", context.run)
	const told: unknown[] = []
	const program = {
		default: (api: API) => {
			api.teardown((why) => void told.push([api.args[0], why]))
			api.memo("m", () => api.teardown((why) => void told.push([api.args[0], "memo", why])))
		},
	}
	w.put("value", "MOD", program)
	w.put("children", "APPS", { "clock.js": "CLOCK", "mod.js": "MOD" })
	w.put("attributes", "MOD", { "ermine.type": JS })
	const go = (name: string, runner = RUNNER) => {
		const p = w.hosted(() =>
			w.den.start(runner, ["apps", "mod.js"], ["work", name], { args: [name] })
		)
		if ("refused" in p) throw new Error(p.refused)
		for (let i = 0; i < 2; i++) w.s.pulse()
		return p
	}
	const a = go("a")
	w.hosted(() => w.den.stop(a, "SIGHUP"))
	const b = go("b")
	w.hosted(() => w.den.stop(b))
	// a process offering ermine/api's runner, a user on it
	const h = go("h")
	w.hosted(() => w.den.offer("runners", "inner", { [TAKES]: JS }, context.run, h.id))
	go("c", ["work", "h", "runners", "inner"])
	w.hosted(() => w.den.stop(h, "done"))
	go("d")
	w.hosted(() => w.den.close())
	assertEquals(told, [
		["a", "memo", "SIGHUP"],
		["a", "SIGHUP"],
		["b", "memo", "ended"],
		["b", "ended"],
		["c", "memo", "runner-stopped"],
		["c", "runner-stopped"],
		["h", "memo", "done"],
		["h", "done"],
		["d", "memo", "den-stopped"],
		["d", "den-stopped"],
	])
})

Deno.test("a start or a load outside a run asks for a pulse (as ermine/api's: a microtask, none given), so a start from a DOM callback runs with nothing else pulsing; once, however many ask; none in a run", async () => {
	const w = world({ schedule: null })
	const ran: unknown[] = []
	w.offer(
		"javascript",
		Object.assign((_code: unknown, s: Start) => void ran.push(s.process.at), {
			load: () => ({}),
		}),
	)
	w.start(RUNNER, ["work", "a"])
	w.start(RUNNER, ["work", "b"])
	assertEquals(ran, [])
	await tick()
	assertEquals(ran, [["work", "a"], ["work", "b"]])
	// asked through setup.schedule: one, however many start before it runs
	const asked: (() => void)[] = []
	const v = world({ schedule: (f) => void asked.push(f) })
	v.offer("javascript", () => {})
	v.start(RUNNER, ["work", "a"])
	v.start(RUNNER, ["work", "b"])
	assertEquals(asked.length, 1)
	asked.shift()!()
	v.hosted(() => v.den.load(RUNNER, CLOCK, {}))
	assertEquals(asked.length, 0)
	// a start in a run: none asked (its pulse is under way)
	v.offer("loads", Object.assign(() => {}, { load: () => ({}) }))
	v.hosted(() => v.s.createComputer(() => v.den.start(RUNNER, CLOCK, ["work", "c"]), () => {}))
	v.s.pulse()
	assertEquals([asked.length, v.den.processes().length], [0, 3])
})

Deno.test("a load is no process: its live form held by its loader, called in the loader's memo, its throw that memo's status and run (ermine/api's runs), its time that run's; let go at the loader's stop, after its handle's, newest first", () => {
	const w = world()
	const context = contextOf(w)
	const order: unknown[] = []
	const LETTER = "ermine.letter"
	w.offer("letter", {
		start: () => {},
		load: (code: unknown) => ({
			draw: () => {
				if (code === "bad") throw new Error("bad letter")
				return `drew ${code}`
			},
			[Symbol.dispose]: () => void order.push(["disposed", code]),
		}),
	}, { [TAKES]: LETTER })
	// the engine's api: ermine/api's, and a load by the process (a runner's own, composed)
	type Engine = API & { load: (code: string) => { draw: () => string } }
	const run = context.runner({
		api: (start) => ({
			...context.createAPI(start),
			load: (code: string) => {
				const l = (start as Start).den.load(["system", "den", "runners", "letter"], {
					id: code,
					code,
					type: LETTER,
				}, { by: start.process.id })
				if ("refused" in l) throw new Error(l.refused)
				return l.live
			},
		}),
	})
	w.offer("javascript", {
		start: (code: unknown, start: Start) => {
			const h = run.start(code, start)
			return { stop: (reason?: unknown) => (order.push("engine handle"), h.stop(reason)) }
		},
	})
	const program = {
		default: (api: Engine) => {
			api.open("cells", {})
			api.open("shown", {})
			for (const code of ["e", "bad"]) {
				const live = api.load(code)
				const cell = api.memo(`cells/${code}`, () => live.draw())
				api.effect(`shown/${code}`, () => api.read(cell), () => {})
			}
		},
	}
	w.put("value", "MOD", program)
	w.put("children", "APPS", { "clock.js": "CLOCK", "mod.js": "MOD" })
	w.put("attributes", "MOD", { "ermine.type": JS })
	const p = w.start(RUNNER, ["work", "engine"], ["apps", "mod.js"])
	for (let i = 0; i < 3; i++) w.s.pulse()
	const cell = (c: string) => w.places.peep(() => get(w.places, ["work", "engine", "cells", c]))!
	assertEquals(w.table.get("value", cell("e"))?.value, "drew e")
	const st = w.table.get("attributes", cell("bad"))?.value?.[STATUS]
	assertInstanceOf(st, Error)
	assertEquals(st.message, "bad letter")
	const ran = context.runs(cell("bad"))!
	assertEquals([ran.end, ran.error?.message, typeof ran.ended], ["failed", "bad letter", "number"])
	assertEquals(w.den.processes().map((q) => q.id), [p.id])
	w.hosted(() => w.den.stop(p))
	assertEquals(order, ["engine handle", ["disposed", "bad"], ["disposed", "e"]])
})

Deno.test("nodes: the den's description as it travels, tracked; status as pending, an attribute with no encoding left out, children only the den's own; processes: false, none", () => {
	const w = world()
	const record: Fn = () => ({ stop: () => {} })
	const js = w.offer("javascript", record, { live: () => 1 })
	assert(!("refused" in js))
	const D = w.den.node
	let runs = 0
	w.hosted(() =>
		w.s.createComputer(() => {
			runs++
			return w.den.nodes()
		}, () => {})
	)
	w.s.pulse()
	assertEquals(runs, 1)
	const p = w.start(RUNNER, ["work", "clock"])
	w.s.pulse()
	assertEquals(runs, 2)
	const seen = w.den.nodes()
	assertEquals(seen.den, D)
	assertEquals(seen.processes, [{ id: p.id, at: ["work", "clock"] }])
	assertEquals(seen.nodes[D], {
		attributes: {
			"ermine.type": "ermine.den",
			"ermine.den.id": "mac",
			"ermine.process.cwd": ["system", "dens"],
		},
		children: { on: `${String(D)}/on`, runners: `${String(D)}/runners` },
	})
	assertEquals(seen.nodes[`${String(D)}/runners`], { children: { javascript: js.id } })
	assertEquals(seen.nodes[js.id], {
		attributes: { [TAKES]: JS, "ermine.type": "ermine.runner" },
	})
	assertEquals(seen.nodes[p.id].attributes?.["ermine.process.program"], {
		id: "CLOCK",
		at: CLOCK,
		hash: hashOf("hi"),
	})
	const hidden = w.den.nodes({ processes: false })
	assertEquals([hidden.processes, hidden.nodes[p.id]], [undefined, undefined])
	// a status as it travels
	const boom: Fn = () => {
		throw new Error("boom")
	}
	w.offer("boom", boom)
	const q = w.start(["system", "den", "runners", "boom"], ["work", "boom"])
	assertEquals(w.den.nodes().nodes[q.id].attributes?.[STATUS], "pending")
	w.s.pulse()
	w.s.pulse()
	assertEquals(w.den.nodes().nodes[q.id].attributes?.[STATUS], { failed: "boom" })
})

Deno.test("the owner torn down from above: every process goes newest first, its handle given den-stopped; the den's rows gone, the den closed", () => {
	const w = world()
	const stops: unknown[] = []
	const record: Fn = (_, { process }) => {
		return { stop: (reason) => void stops.push([process.at[1], reason]) }
	}
	w.offer("javascript", record)
	w.start(RUNNER, ["work", "a"])
	w.start(RUNNER, ["work", "b"])
	w.s.pulse()
	w.s.teardown(w.den.scope)
	assertEquals(stops, [["b", REASONS.den], ["a", REASONS.den]])
	assertEquals(w.places.peep(() => get(w.places, ["system", "den"])), undefined)
	assertEquals(w.places.peep(() => get(w.places, ["system", "dens", "mac"])), undefined)
	assertEquals(w.table.get(w.den.node), [])
	assertEquals(w.hosted(() => w.den.start(RUNNER, CLOCK, ["work", "c"])), { refused: "stopped" })
})

// assignment checks, at type level: A fits where B is asked
type Fits<A, B> = [A] extends [B] ? true : false

Deno.test("types: realms.run and programs' Runner fit a den's runner as functions, ermine/api's run as one and as a Runner; an api made from programs' Start is made from a den's", () => {
	const fits: [
		Fits<Realms["run"], Runnable>,
		Fits<ProgramsRunner, Runnable>,
		Fits<ProcessContext["run"], Runnable>,
		Fits<ProcessContext["run"], Runner>,
		Fits<(start: ProgramsStart) => API, (start: Start) => unknown>,
		Fits<ProcessContext["createAPI"], NonNullable<Runner["api"]>>,
	] = [true, true, true, true, true, true]
	assertStrictEquals(fits.every((x) => x), true)
})

// two devices, each saying yes to all, a javascript runner offered on each; their channels deliver
// at flush (held: a channel that delivers later), else at once
function two(held = false) {
	const pair = createPair("mac", "card")
	const queue: (() => void)[] = []
	const hold = (c: Channel): Channel =>
		held ? { name: c.name, on: c.on, send: (t, b) => void queue.push(() => c.send(t, b)) } : c
	const yes = () => ({ answer: "yes" as const })
	const mac = world({ id: "mac", may: yes }), card = world({ id: "card", may: yes })
	const record: Fn = () => ({ stop: () => {} })
	mac.offer("javascript", record)
	card.offer("javascript", record)
	const flush = () => {
		while (queue.length) queue.shift()!()
	}
	return { mac, card, channels: { mac: hold(pair.a), card: hold(pair.b) }, flush }
}

Deno.test("connect: a scope open, and a channel named its den's id", () => {
	const { mac, channels } = two()
	assertThrows(() => mac.hosted(() => connect(mac.den, channels.card)), Error, "named its id")
	assertThrows(() => connect(mac.den, channels.mac), SchedulerError)
	const link = mac.hosted(() => connect(mac.den, channels.mac))
	assertEquals(link.anchor, anchorOf("R"))
	link.stop()
})

Deno.test("answer(n) is tracked: undefined until the answer lands from the den it was sent to, a reader then rerun; an answer from another den is dropped", () => {
	const { mac, card, channels, flush } = two(true)
	const toCard = mac.hosted(() => connect(mac.den, channels.mac))
	card.hosted(() => connect(card.den, channels.card))
	const program = toCard.carry(CLOCK)
	const n = mac.hosted(() =>
		toCard.ask("card", { op: "start", runner: RUNNER, program, at: ["work", "clock"] })
	)
	const seen: unknown[] = []
	mac.hosted(() => mac.s.createComputer(() => toCard.answer(n), (v) => void seen.push(v)))
	mac.s.pulse()
	assertEquals(seen, [undefined])
	flush()
	mac.s.pulse()
	const got = toCard.answer(n)
	assert(got !== undefined && "id" in got)
	assertEquals(seen, [undefined, got])
	assertEquals(card.den.find(got.id)?.at, ["work", "clock"])
	// an ask to a den nobody is: an answer from card to its n is not kept
	const m = mac.hosted(() => toCard.ask("nobody", { op: "stop", process: got.id }))
	channels.card.send(`${anchorOf("R")}/answer/mac`, encode({ n: m, answer: {} }))
	flush()
	assertEquals(toCard.answer(m), undefined)
})

Deno.test("carry: a node of the den's as a program, by address or id: its id, its value's hash, its form; its code when asked; no value there: PlacesError nothing-there", () => {
	const { mac, channels } = two()
	const link = mac.hosted(() => connect(mac.den, channels.mac))
	const js = "com.netscape.javascript-source"
	assertEquals(link.carry("/apps/clock.js"), { id: "CLOCK", hash: hashOf("hi"), type: js })
	mac.put("attributes", "CLOCK", { "ermine.type": js, [PROGRAM_API]: "ermine.api" })
	assertEquals(link.carry({ id: "CLOCK" }, { code: true }), {
		id: "CLOCK",
		hash: hashOf("hi"),
		type: js,
		api: "ermine.api",
		code: "hi",
	})
	const nothing = assertThrows(() => link.carry(["apps", "none.js"]), PlacesError)
	assertEquals(nothing.code, "nothing-there")
	assertThrows(() => link.carry({ id: "APPS" }), PlacesError)
})

Deno.test("what a link is sent that is no ask is dropped; an ask its den throws on is answered with the error's code", () => {
	const { mac, card, channels } = two()
	const toCard = mac.hosted(() => connect(mac.den, channels.mac))
	card.hosted(() => connect(card.den, channels.card))
	const sent: unknown[] = []
	channels.mac.on(`${anchorOf("R")}/answer/mac`, (_, bytes) => void sent.push(bytes))
	channels.mac.send(`${anchorOf("R")}/ask/card`, new Uint8Array([0xff]))
	channels.mac.send(`${anchorOf("R")}/ask/card`, encode({ n: 9, op: "dance" }))
	channels.mac.send(`${anchorOf("R")}/ask/card`, encode({ op: "stop", process: "x" }))
	// a start whose program has no id: no ask (its answer could not say which program)
	channels.mac.send(
		`${anchorOf("R")}/ask/card`,
		encode({ n: 7, op: "start", runner: RUNNER, program: {}, at: ["work", "x"] }),
	)
	assertEquals(sent, [])
	const n = mac.hosted(() =>
		toCard.ask("card", {
			op: "start",
			runner: RUNNER,
			program: toCard.carry(CLOCK),
			at: ["work", ".."],
		})
	)
	assertEquals(toCard.answer(n), { error: "not-a-name" })
	assertEquals([sent.length, card.den.processes()], [1, []])
})

Deno.test("a link stopped by hand leaves nothing on the den's owner; the den's close still stops a live one", () => {
	const { mac, channels } = two()
	const before = mac.den.scope.teardowns.length
	for (let i = 0; i < 3; i++) mac.hosted(() => connect(mac.den, channels.mac)).stop()
	assertEquals(mac.den.scope.teardowns.length, before)
	const link = mac.hosted(() => connect(mac.den, channels.mac))
	mac.hosted(() => mac.den.close())
	assertThrows(() => link.ask("card", { op: "stop", process: "x" }), Error, "stopped")
	// connected to a den closed already: stopped at once
	const late = mac.hosted(() => connect(mac.den, channels.mac))
	assertThrows(() => late.ask("card", { op: "stop", process: "x" }), Error, "stopped")
})

Deno.test("a mirrored node's status as this side holds it: a failure an Error, its message the other's", () => {
	const { mac, card, channels } = two()
	card.offer("boom", () => {
		throw new Error("boom")
	})
	mac.hosted(() => connect(mac.den, channels.mac))
	card.hosted(() => connect(card.den, channels.card))
	const p = card.start(["system", "den", "runners", "boom"], ["work", "b"])
	for (let i = 0; i < 3; i++) card.s.pulse(), mac.s.pulse()
	const st = mac.table.get("attributes", p.id)?.value?.[STATUS]
	assertInstanceOf(st, Error)
	assertEquals(st.message, "boom")
})

Deno.test("a link's scope torn down from above: the link stopped, its mirrors out, its listeners off; its row left on the other device to lapse", () => {
	const { mac, card, channels } = two()
	const o = mac.hosted(() => mac.s.createScope({ for: "a while" }))
	const toCard = mac.s.runWithScope(o, () => connect(mac.den, channels.mac))
	const toMac = card.hosted(() => connect(card.den, channels.card))
	for (let i = 0; i < 2; i++) mac.s.pulse(), card.s.pulse()
	const there = (w: ReturnType<typeof world>, path: string[]) =>
		w.places.peep(() => get(w.places, path))
	assertEquals(there(mac, ["system", "dens", "card"]), card.den.node)
	assertEquals(there(card, ["system", "dens", "mac"]), mac.den.node)
	mac.s.teardown(o)
	assertEquals(there(mac, ["system", "dens", "card"]), undefined)
	assertEquals(mac.table.get(card.den.node), [])
	card.s.pulse()
	assertEquals(there(card, ["system", "dens", "mac"]), mac.den.node)
	assertEquals(readPresence(toMac.world, toMac.anchor).map((r) => r.who), ["mac", "card"])
	// stopped: asks refused, the rest nothing
	assertThrows(() => mac.hosted(() => toCard.ask("card", { op: "stop", process: "x" })), Error)
	toCard.stop()
	toCard.beat()
	assertEquals(toCard.sweep(), [])
})

Deno.test("a den's writes name the outside call that made them: an offer's site and the den's node's are in the file that called", () => {
	const w = world()
	const o = w.offer("javascript", () => ({ stop: () => {} })) as { id: Id }
	const offered = w.table.get("attributes", o.id)?.change.external?.[0]
	assert(offered?.file.endsWith("dens_test.ts"), JSON.stringify(offered))
	const made = w.table.get("attributes", w.den.node)?.change.external?.[0]
	assert(made?.file.endsWith("dens_test.ts"), JSON.stringify(made))
	// the den's body: its children (on), on's children, on/start's value
	const on = w.table.get("children", w.den.node)?.change.external?.[0]
	assert(on?.file.endsWith("dens_test.ts"), JSON.stringify(on))
})
