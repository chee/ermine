// start and stop on a real scheduler, table and paths, in a box over a folder W: catclock.c
// (CAT, "hi") at clocks/, a host compiler UP (upper) at cc and a host runner RUN at run, boxed
import { assert, assertEquals, assertInstanceOf, assertStrictEquals } from "@std/assert"
import createEntry, { type Entry } from "@ermine/node/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { createPlaces } from "@ermine/places"
import { createChangeHeader, NODE } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { box, createBox } from "@ermine/boxes"
import { PROCESS } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import type { Value } from "@ermine/encoding/cbor"
import { createSites, type Sited } from "@ermine/sites"
import { type Compiler, createBuilds } from "@ermine/compilers"
import { satisfy, type Way } from "./programs.ts"
import {
	type Context,
	createPrograms,
	type Handle,
	type Process,
	type Runner,
	StartError,
} from "./start.ts"

const C = "public.c-source"
const WASM = "public.wasm-executable"

// sited: the scopes made through ermine/sites, start.ts and processes' in its ours. named: the
// places given to the programs name reads (describe, watchAll), so each build's latest run is written
function world(
	runner: Runner,
	createProcessAPI: (ctx: Context) => unknown = (ctx) => ctx.process,
	sited = false,
	named = false,
) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table, paths, scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: "host" })
	// the programs' scope: a scope of the host's own, so it can be torn down
	const above = s.createScope({ test: "above" }, host)
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header())))
	const waiting: (() => void)[] = []
	const slow: Compiler = (input) => new Promise<Value>((r) => waiting.push(() => r(input)))
	const upper: Compiler = (input) => (input as string).toUpperCase()
	put("children", "W", { clocks: "CL" })
	put("children", "CL", { "catclock.c": "CAT" })
	put("value", "CAT", "hi")
	put("attributes", "CAT", { "ermine.type": C })
	put("value", "UP", upper)
	put("attributes", "UP", { "ermine.programs.takes": [C], "ermine.programs.gives": WASM })
	put("value", "SLOW", slow)
	put("attributes", "SLOW", { "ermine.programs.takes": [C], "ermine.programs.gives": WASM })
	put("value", "RUN", runner)
	put("attributes", "RUN", { "ermine.programs.takes": [WASM] })
	const b = hosted(() => createBox({ places, table, scheduler: s, commit }, { id: "W" }))
	hosted(() => (box(b, ["cc"], "UP"), box(b, ["run"], "RUN")))
	const writes = { readValue: places.readValue, commit }
	const sites = sited
		? createSites(s, {
			ours: [
				new URL("./start.ts", import.meta.url).href,
				import.meta.resolve("@ermine/processes/start"),
			],
		})
		: undefined
	const programs = s.runWithScope(above, () => {
		const builds = createBuilds({ scheduler: s, table, places: writes, cache: "CACHE" })
		return createPrograms({ // where the programs are made
			scheduler: s,
			table,
			places: named
				? { ...writes, describe: places.describe, watchAll: places.watchAll }
				: writes,
			builds,
			scopes,
			createProcessAPI,
			sites,
		})
	})
	const way = (): Way => {
		const [first] = satisfy(b.places, "catclock.c", ["clocks"])
		if (first === undefined) throw new Error("no way")
		return first
	}
	const start = (at: string[], w = way()) => {
		const p = hosted(() => programs.start(b, w, at)) // where start is called
		if ("refused" in p) throw new Error(p.refused)
		return p
	}
	const status = (p: Process) => table.get("attributes", p.id)?.value?.[STATUS]
	const settle = async () => {
		for (const r of waiting.splice(0)) r()
		await new Promise((r) => setTimeout(r, 0))
		s.pulse()
	}
	return { s, table, b, host, above, programs, start, status, settle, put, hosted, way, sites }
}

// a runner recording each call, its stop counted
function recording() {
	const calls: { code: unknown; api: unknown }[] = []
	let stops = 0
	const runner: Runner = (code, api) => {
		calls.push({ code, api })
		return { stop: () => void stops++ }
	}
	return { runner, calls, stops: () => stops }
}

Deno.test("the api is createProcessAPI's return, and nothing else: no scheduler, getCurrentScope or runWithScope unless it puts them there", () => {
	const r = recording()
	const given: Context[] = []
	const made: unknown[] = []
	const w = world(r.runner, (ctx) => {
		given.push(ctx)
		const api = { places: ctx.places, process: ctx.process }
		made.push(api)
		return api
	})
	const p = w.start(["clock"])
	w.s.pulse()
	assertEquals(r.calls.length, 1)
	assertEquals(r.calls[0].code, "HI")
	assertStrictEquals(r.calls[0].api, made[0])
	// the host's function is handed the host's own things
	assertStrictEquals(given[0].scheduler, w.s)
	assertStrictEquals(given[0].scope, p.scope)
	assertStrictEquals(given[0].places, w.b.places)
	assertEquals(given[0].process, { id: p.id, at: ["clock"], args: [], cwd: [] })
	assertStrictEquals(given[0].box, w.b)
	// the program's: none of the scheduler, at any depth
	const forbidden = new Set<unknown>([
		w.s,
		w.s.getCurrentScope,
		w.s.runWithScope,
		w.s.createScope,
		w.s.createComputer,
		p.scope,
	])
	const seen = new Set<unknown>()
	const look = (v: unknown, depth: number) => {
		if (forbidden.has(v)) throw new Error("the program was given the scheduler")
		if (depth === 0 || v === null || typeof v !== "object" || seen.has(v)) return
		seen.add(v)
		for (const k of Object.keys(v)) look((v as Record<string, unknown>)[k], depth - 1)
	}
	look(r.calls[0].api, 3)
	const keys = Object.keys(r.calls[0].api as object)
	for (const k of ["scheduler", "getCurrentScope", "runWithScope", "scope"]) {
		assert(!keys.includes(k), k)
	}
})

Deno.test("places that name reads: the build's latest run by the process's node id, what it read; none, nothing", () => {
	const r = recording()
	const w = world(r.runner, undefined, false, true)
	const p = w.start(["a"])
	w.s.pulse()
	assertEquals(r.calls.length, 1)
	const run = w.programs.runs!(p.id)!
	// pending while the compile's step was out, then done
	assertEquals([run.n, run.end], [2, "done"])
	// the cache's folder, read for the compile's entry
	assert(run.reads.some((read) => !("key" in read) && read.id === "CACHE"))
	const plain = world(recording().runner)
	const q = plain.start(["a"])
	plain.s.pulse()
	assertEquals(plain.programs.runs?.(q.id), undefined)
})

Deno.test("a runner giving a promise: the process pending till it lands, then clear; stopped before it lands, its stop is called as it lands", async () => {
	let stops = 0
	const resolves: ((h: Handle) => void)[] = []
	const w = world(() => new Promise<Handle>((r) => resolves.push(r)))
	const a = w.start(["a"])
	const b = w.start(["b"])
	w.s.pulse()
	assertEquals(resolves.length, 2)
	assertStrictEquals(w.status(a), PENDING)
	resolves[0]({ stop: () => void stops++ })
	await w.settle()
	assertEquals(w.status(a), undefined)
	assertStrictEquals(w.status(b), PENDING)
	w.programs.stop(b)
	assertEquals(stops, 0)
	resolves[1]({ stop: () => void stops++ })
	await w.settle()
	assertEquals(stops, 1)
	w.programs.stop(a)
	assertEquals(stops, 2)
})

Deno.test("a runner that throws, or rejects: its Error on the process's status", async () => {
	let n = 0
	const w = world(() => {
		if (n++ === 0) throw new Error("no canvas")
		return Promise.reject(new Error("no network"))
	})
	const a = w.start(["a"])
	const b = w.start(["b"])
	w.s.pulse()
	assertEquals((w.status(a) as Error).message, "no canvas")
	assertStrictEquals(w.status(b), PENDING)
	await w.settle()
	assertEquals((w.status(b) as Error).message, "no network")
	w.programs.stop(a)
	w.programs.stop(b)
	assertEquals(w.table.get(a.id), [])
})

Deno.test("the runner's node holding no function as the build lands: a StartError not-a-runner on the status", () => {
	const r = recording()
	const w = world(r.runner)
	const a = w.start(["a"])
	w.put("value", "RUN", "not a function")
	w.s.pulse()
	const e = w.status(a)
	assertInstanceOf(e, StartError)
	assertEquals([e.code, e.step], ["not-a-runner", "RUN"])
	assertEquals(r.calls.length, 0)
})

Deno.test("an edit while the build is pending: what was read at start is built", async () => {
	const r = recording()
	const w = world(r.runner)
	w.put("attributes", "UP", {})
	w.hosted(() => box(w.b, ["slow"], "SLOW"))
	const before = w.way()
	assertEquals(before.chain.map((s) => s.id), ["SLOW", "RUN"])
	w.start(["a"], before)
	w.s.pulse()
	w.put("value", "CAT", "ho")
	w.s.pulse()
	await w.settle()
	assertEquals(r.calls.map((c) => c.code), ["hi"])
})

Deno.test("a scope above torn down: the runner stopped, the row out, the node's entries gone, the program's computers gone", () => {
	let runs = 0
	let stops = 0
	const made: Scope[] = []
	// this createProcessAPI gives a way to make a computer, and nothing else of the scheduler's
	type Api = { compute: (f: () => unknown) => void }
	const w = world((_code, api) => {
		;(api as Api).compute(() => runs++)
		return { stop: () => void stops++ }
	}, (ctx): Api => ({ compute: (f) => void made.push(ctx.scheduler.createComputer(f, () => {})) }))
	const a = w.start(["clock"])
	w.s.pulse()
	assertEquals([runs, stops], [1, 0])
	assert(w.table.get("attributes", a.id) !== undefined)
	w.s.teardown(w.above)
	assertEquals(stops, 1)
	assertEquals(w.table.get(a.id), [])
	assertEquals(w.table.get(PROCESS, w.b.root)?.value, {})
	assertEquals([a.scope.state, made[0].state], ["gone", "gone"])
	// stopped again: nothing
	w.programs.stop(a)
	assertEquals(stops, 1)
})

Deno.test("writes carry the process's scope: the row and the node's attributes, by the host's actor, [process, at] in their metadata, then [node, the process's id] (stopping there), their site the call into start", () => {
	const r = recording()
	const w = world(r.runner)
	const a = w.start(["clock"])
	const row = w.table.get(PROCESS, w.b.root)!
	const attrs = w.table.get("attributes", a.id)!
	for (const e of [row, attrs]) {
		assertEquals(e.change.actor, "host")
		// flat: the process's own pairs, then its node; the owners' above it not repeated
		assertEquals(e.change.metadata, { process: ["clock"], [NODE]: a.id })
		assert(e.change.external?.[0].file.endsWith("start_test.ts"), e.change.external?.[0].file)
	}
})

Deno.test("sites: a computer the program makes reports the program's line; its chain goes through its process, made where start was called, to where the programs were made", () => {
	let made: Scope | undefined
	let sites!: Sited
	type Api = { computer: Sited["createComputer"] }
	const w = world(
		(_code, api) => {
			made = (api as Api).computer(() => 1, () => {}) // the program's line
			return { stop: () => {} }
		},
		(): Api => ({ computer: sites.createComputer }),
		true,
	)
	sites = w.sites!
	const p = w.start(["clock"])
	w.s.pulse()
	const text = Deno.readTextFileSync(new URL(import.meta.url)).split("\n")
	const line = (mark: string) => text.findIndex((l) => l.endsWith(mark)) + 1
	const at = (x: { file: string; line: number }) => [x.file.split("/").pop(), x.line]
	assertEquals(sites.sitesOf(p.scope).map(at), [
		["start_test.ts", line("// where start is called")],
		["start_test.ts", line("// where the programs are made")],
	])
	assertEquals(sites.sitesOf(made!).map(at), [
		["start_test.ts", line("// the program's line")],
		...sites.sitesOf(p.scope).map(at),
	])
})

// a way by hand: catclock.c's value through a step loaded by H (at h), then RUN
const loadedWay = (step: string): Way => ({
	program: { id: "CAT", at: ["clocks", "catclock.c"] },
	chain: [
		{ id: step, at: [step.toLowerCase()], by: [{ id: "H", at: ["h"], by: [] }] },
		{ id: "RUN", at: ["run"], by: [] },
	],
})

Deno.test("a load giving its live form at once: loaded, compiled and run in the pulse asking for it", () => {
	const r = recording()
	const w = world(r.runner)
	let loads = 0
	const h = Object.assign(() => ({ stop: () => {} }), {
		load: (code: unknown) => (loads++, { compile: (s: string) => s + code }),
	})
	w.put("value", "H", h)
	w.put("value", "LC", "!")
	const a = w.start(["a"], loadedWay("LC"))
	const b = w.start(["b"], loadedWay("LC"))
	w.s.pulse()
	assertEquals(r.calls.map((c) => c.code), ["hi!", "hi!"])
	assertEquals([loads, w.status(a), w.status(b)], [1, undefined, undefined])
})

Deno.test("an instantiate failing: its Error on the status, nothing run", async () => {
	const r = recording()
	const w = world(r.runner)
	const h = Object.assign(() => ({ stop: () => {} }), {
		load: (code: unknown) => WebAssembly.instantiate(code as Uint8Array<ArrayBuffer>),
	})
	w.put("value", "H", h)
	w.put("value", "WC", new Uint8Array([0, 97, 115, 109, 9, 9, 9, 9]))
	const a = w.start(["a"], loadedWay("WC"))
	w.s.pulse()
	for (let i = 0; i < 100 && w.status(a) === PENDING; i++) await w.settle()
	assertInstanceOf(w.status(a), WebAssembly.CompileError)
	assertEquals(r.calls.length, 0)
})

Deno.test("the loaded let go at the last holder's stop: its live form's Symbol.dispose called once, then; a load after that loads again", () => {
	const r = recording()
	const w = world(r.runner)
	let loads = 0
	let disposed = 0
	const h = Object.assign(() => ({ stop: () => {} }), {
		load: (code: unknown) => (loads++, {
			compile: (s: string) => s + code,
			[Symbol.dispose]: () => void disposed++,
		}),
	})
	w.put("value", "H", h)
	w.put("value", "LC", "!")
	const a = w.start(["a"], loadedWay("LC"))
	const b = w.start(["b"], loadedWay("LC"))
	w.s.pulse()
	assertEquals([loads, disposed], [1, 0])
	w.programs.stop(a)
	assertEquals(disposed, 0)
	w.programs.stop(b)
	w.programs.stop(b)
	assertEquals(disposed, 1)
	const c = w.start(["c"], loadedWay("LC"))
	w.s.pulse()
	assertEquals([loads, disposed, w.status(c)], [2, 1, undefined])
	w.programs.stop(c)
	assertEquals(disposed, 2)
})
