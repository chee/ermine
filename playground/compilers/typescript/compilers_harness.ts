// compilers (compilers.ts) on the line protocol: one JSON request per line in, one answer per line out, in
// order. one world per process: a scheduler, table, paths and the host's places (root "R", children
// alone), told the table's events. the host writes with its scope open, info {"actor":"test"};
// builds are made with it open too
//
// the compilers, by name, each counting its calls:
//   upper  a string uppercased            wrap  { wasm: input }
//   slow   the input, once settled         boom  throws Error("boom")
//   live   a function: no encoding
//
// the world:
// { op: "kids", id, value }                 → {}   the children entry, replaced (a table event)
// { op: "attrs", id, value }                → {}   the attributes entry, replaced (a table event)
// { op: "value", id, value }                → {}   the value entry, replaced (a table event)
// { op: "compiler", id, compiler }          → {}   value entry: the compiler named (live, unsaved)
// { op: "upsert", part, id, path, value }   → {}   upsert (libraries/upsert) at path: a patch,
//    telling only the reads it touches
// compilers:
// { op: "builds", cache }                   → {}   a fresh createBuilds over the same table, cache
//    folder id cache; the last one's watches torn down first, then it stopped
// { op: "watch", name, compilers, input?, node? } → {}   a computer in its own scope: each run, the
//    input (or node's value) through each compiler in turn; PENDING or an Error stops there
// { op: "stop", name }                      → {}   that scope torn down
// { op: "pulse" }                           → {}
// { op: "settle", fail? }                   → {}   every waiting slow call resolved (fail: rejected
//    with Error(fail)), the promises landed, then a pulse
// { op: "state", name }                     → { value }   last result: the output, "pending",
//    { refused: code } (a BuildError), or { failed: message } (any other Error)
// { op: "runs", name }                      → { runs }
// { op: "calls" }                           → { upper, wrap, slow, boom, live }
// { op: "cache" }                           → { size, entries }   each key and its node's value
// { op: "kinds" }                           → { types }   each key, its node's type (null: none)
// steps (builds.step), by name, each counting its calls, each reading through places:
//   sum     code: ids; the sum of their values
//   pick    code: an id; the value of the node its value names
//   parity  code: an id; { odd } of its value
//   label   code: an id; "odd" or "even", by its value
//   wait    code: an id; its value, once settled
//   oops    code: an id; reads it, throws Error("oops")
//   tick    code: an id; reads it, gives how many times tick has been called
// { op: "step", name, run, code, never?, into? } → {}   a computer in its own scope: each run,
//    builds.step(run, code, the run named, { never }), its result kept as is (same identity as the
//    last: nothing set); into: each result written as the value entry there (an Error: not)
// { op: "found", name }                     → { found, entry, checked, entries }   its last run's
//    step found (onStep): hit, miss or never; the entry hit (null: none)
// { op: "ran" }                             → { sum, pick, parity, label, wait, oops, tick }
// { op: "entries", run, code }              → { entries }   newest first, each { name, reads,
//    output }, reads as [part, id, path] (no hashes)
import createEntry from "@ermine/core/node/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createPlaces, PlacesError } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/upsert"
import type { Value } from "@ermine/encoding/cbor"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { hash } from "@ermine/formats/hash"
import {
	BuildError,
	type Builds,
	type Compiler,
	createBuilds,
	type Found,
	type Read,
	TRACE,
} from "./compilers.ts"

type Json = unknown

const s = createScheduler()
const table = createTable((part, id) => places.onTableChange(part as Key, id))
const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
s.onTrackingEnd((key) => places.release(key))
const host = s.createRootScope({ actor: "test" })
const hosted = <T>(f: () => T) => s.runWithScope(host, f)
const header = () => createChangeHeader(s)

// the compilers, and their calls
const calls: Record<string, number> = { upper: 0, wrap: 0, slow: 0, boom: 0, live: 0 }
const waiting: { resolve: () => void; reject: (e: Error) => void }[] = []
const compilers: Record<string, Compiler> = {
	upper: (input) => (calls.upper++, (input as string).toUpperCase()),
	wrap: (input) => (calls.wrap++, { wasm: input }),
	slow: (input) => {
		calls.slow++
		return new Promise<Value>((resolve, reject) =>
			waiting.push({ resolve: () => resolve(input), reject })
		)
	},
	boom: () => {
		calls.boom++
		throw new Error("boom")
	},
	live: () => (calls.live++, (() => {}) as never),
}

// the step runs, and their calls
const ran: Record<string, number> = {
	sum: 0,
	pick: 0,
	parity: 0,
	label: 0,
	wait: 0,
	oops: 0,
	tick: 0,
}
const value = (id: unknown) => places.readValue("value", id as Id)
const runs: Record<string, (code: Json) => unknown> = {
	sum: (ids) => (ran.sum++, (ids as Id[]).reduce((n, id) => n + (value(id) as number), 0)),
	pick: (id) => (ran.pick++, value(value(id))),
	parity: (id) => (ran.parity++, { odd: (value(id) as number) % 2 === 1 }),
	label: (id) => (ran.label++, (value(id) as { odd?: boolean })?.odd ? "odd" : "even"),
	wait: (id) => {
		ran.wait++
		const v = value(id) as Value
		return new Promise<Value>((resolve, reject) =>
			waiting.push({ resolve: () => resolve(v), reject })
		)
	},
	oops: (id) => {
		ran.oops++
		value(id)
		throw new Error("oops")
	},
	tick: (id) => (value(id), ++ran.tick),
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

let builds: Builds | undefined
let cache: Id | undefined
let made: Scope[] = []
const scopes = new Map<string, Scope>()
const watched = new Map<string, { runs: number; value: unknown; found?: Found }>()
// what each watch's runs found, by its computer
const finding = new WeakMap<object, { found?: Found }>()

// a result as JSON
function shown(v: unknown): Json {
	if (v === PENDING) return "pending"
	if (v instanceof BuildError) return { refused: v.code }
	if (v instanceof Error) return { failed: v.message }
	return v ?? null
}

const settled = () => new Promise((r) => setTimeout(r, 0))

function watchOf(name: string) {
	const w = watched.get(name)
	if (w === undefined) throw new Error(`no watch ${name}`)
	return w
}

async function answer(r: Request): Promise<Json> {
	switch (r.op) {
		case "kids":
			hosted(() => table.sub("children", r.id, createEntry(r.value, header())))
			return {}
		case "attrs":
			hosted(() => table.sub("attributes", r.id, createEntry(r.value, header())))
			return {}
		case "value":
			hosted(() => table.sub("value", r.id, createEntry(r.value, header())))
			return {}
		case "compiler": {
			const f = compilers[r.compiler]
			if (f === undefined) throw new Error(`no compiler ${r.compiler}`)
			hosted(() => table.sub("value", r.id, createEntry(f, header())))
			return {}
		}
		case "upsert":
			hosted(() => places.commit(upsert(table, r.part, r.id, r.path, r.value, header())))
			return {}
		case "builds": {
			for (const o of made) if (o.state === "alive") s.teardown(o)
			made = []
			builds?.stop()
			cache = r.cache
			builds = hosted(() => createBuilds({ scheduler: s, table, places, cache: r.cache }))
			builds.onStep((f) => {
				const w = finding.get(s.getRun()?.computer as object)
				if (w !== undefined) w.found = f
			})
			return {}
		}
		case "watch": {
			const b = builds
			if (b === undefined) throw new Error("no builds")
			const o = s.createScope({ watch: r.name }, host)
			made.push(o)
			scopes.set(r.name, o)
			const w = { runs: 0, value: undefined as unknown }
			watched.set(r.name, w)
			s.runWithScope(o, () =>
				s.createComputer(() => {
					w.runs++
					let v = r.node === undefined ? r.input : places.readValue("value", r.node)
					for (const c of r.compilers as Id[]) {
						v = b.compile(c, v)
						if (v === PENDING || v instanceof Error) break
					}
					return { v }
				}, ({ v }) => void (w.value = v)))
			return {}
		}
		case "step": {
			const b = builds
			if (b === undefined) throw new Error("no builds")
			const run = runs[r.run]
			if (run === undefined) throw new Error(`no run ${r.run}`)
			const o = s.createScope({ watch: r.name }, host)
			made.push(o)
			scopes.set(r.name, o)
			const w: { runs: number; value: unknown; found?: Found } = { runs: 0, value: undefined }
			watched.set(r.name, w)
			const c = s.runWithScope(o, () =>
				s.createComputer(() => {
					w.runs++
					w.found = undefined
					return w.value = b.step(r.run, r.code, () => run(r.code), {
						never: r.never === true,
					})
				}, (v) => {
					if (r.into !== undefined && !(v instanceof Error)) {
						table.sub("value", r.into, createEntry(v, header()))
					}
				}))
			finding.set(c, w)
			return {}
		}
		case "found": {
			const f = watchOf(r.name).found
			if (f === undefined) return { found: null, entry: null, checked: 0, entries: 0 }
			return { found: f.found, entry: f.entry ?? null, checked: f.checked, entries: f.entries }
		}
		case "ran":
			return { ...ran }
		case "entries": {
			if (cache === undefined) throw new Error("no builds")
			const key = hex(hash([r.run, r.code] as Value))
			const folder = (table.get("children", cache)?.value as Record<string, Id> | undefined)
				?.[key]
			const kids = folder === undefined
				? {}
				: (table.get("children", folder)?.value ?? {}) as Record<string, Id>
			const entries = Object.entries(kids)
				.sort((a, b) => Number(b[0]) - Number(a[0]))
				.map(([name, id]) => {
					const reads = (table.get("attributes", id)?.value as Record<string, Read[]>)[TRACE]
					return {
						name,
						reads: reads.map(([part, id, path]) => [part, id, path]),
						output: table.get("value", id)?.value ?? null,
					}
				})
			return { entries }
		}
		case "stop": {
			const o = scopes.get(r.name)
			if (o === undefined) throw new Error(`no watch ${r.name}`)
			s.teardown(o)
			return {}
		}
		case "pulse":
			s.pulse()
			return {}
		case "settle": {
			for (const w of waiting.splice(0)) {
				if (r.fail === undefined) w.resolve()
				else w.reject(new Error(r.fail))
			}
			await settled()
			s.pulse()
			return {}
		}
		case "state": {
			const w = watchOf(r.name)
			return { value: w.runs === 0 ? "pending" : shown(w.value) }
		}
		case "runs":
			return { runs: watchOf(r.name).runs }
		case "calls":
			return { ...calls }
		case "cache": {
			if (cache === undefined) throw new Error("no builds")
			const v = table.get("children", cache)?.value as Record<string, Id> | undefined
			const entries: Record<string, Json> = {}
			for (const [k, n] of Object.entries(v ?? {})) entries[k] = table.get("value", n)?.value
			return { size: Object.keys(entries).length, entries }
		}
		case "kinds": {
			if (cache === undefined) throw new Error("no builds")
			const v = table.get("children", cache)?.value as Record<string, Id> | undefined
			const types: Record<string, Json> = {}
			for (const [k, n] of Object.entries(v ?? {})) {
				types[k] = (table.get("attributes", n)?.value as Record<string, Json> | undefined)
					?.["ermine.type"] ?? null
			}
			return { types }
		}
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	await serve(async (r) => {
		try {
			return await answer(r) as Record<string, unknown>
		} catch (e) {
			if (e instanceof PlacesError) return { error: e.code }
			throw e
		}
	})
}
