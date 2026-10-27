// start_harness: start and stop (start.ts) on the line protocol, one JSON request per line in, one
// answer per line out. one world for the process: scheduler, table, paths, the host's places (root
// "R"), scope nodes. the host writes with its scope open, info {"actor":"test"}. a box's folder
// answers as "box:<name>", a process's node as "proc:<name>". a PlacesError: { error: code }.
// suites: conformance/start, conformance/load (TypeScript only), conformance/native (both).
//
// compilers, each counting calls: upper (uppercase), wrap ({ wasm: input }), slow (input, once
// settled), boom (throws Error("boom")). the runner (@ermine/software's shape, its api the
// harness's createProcessAPI) records code, args and api keys; its program looks each arg up from
// the process's folder every run. createProcessAPI gives { places, process: { id, at, args, folder },
// watch(name, seen) }. software's pulses asked for are never run: each pulse is a request's.
//
// { op: "kids" | "attrs" | "value", id, value }  -> {}   that entry replaced (value: JSON form)
// { op: "compiler", id, compiler }               -> {}   value: the named compiler
// { op: "runner", id, load? }                    -> {}   value: the runner; load "js" | "wasm"
// { op: "create", name, folder?, at? }           -> {}   createBox at folder, or at address from R
// { op: "box", box, path, node }                 -> {}
// { op: "unbox", box, path }                     -> {}
// { op: "programs", cache }                      -> {}   createBuilds then createPrograms
// { op: "start", name, box?, program, from?, chain?, at, args?, folder? } -> { id, at } | refusal
// { op: "start", name, box?, file, from?, way?, at, args?, folder? }      -> the same, via openwith
//    nothing yielded: { refused: why, ...rest }
// { op: "stop", name }                           -> {}
// { op: "pulse" }                                -> {}
// { op: "settle", fail? }                        -> {}   slow calls resolved (or rejected), pulse;
//    again while a process is pending, up to 200 times
// { op: "process", name }  -> { parts, status, args, folder, pin }  status: "pending" | { failed } |
//    { refused } | null
// { op: "here", box?, path }                     -> { id } | null
// { op: "runs" }                                 -> { runs: [{ process, code, args, keys }],
//    stops }
// { op: "found", name }                          -> { runs, found }
// { op: "sites", name }                          -> { sites }  file names, no folder or extension
// { op: "calls" }                                -> { upper, wrap, slow, boom }
// { op: "loads" }                                -> { js, wasm }
// { op: "said" }                                 -> { said }  say(x) calls from loaded code
// { op: "cache" }                                -> { size }
// { op: "fixture", id, name }    -> {}  value: bytes of c/fixtures/<name>.so (native)
// { op: "dlopen", id }           -> {}  value: the dlopen runner (dlopen.ts), its api
//    createProcessAPI's; native gets { ctx, write(ctx, bytes, n) }
// { op: "native" }               -> { loads, compiles, files, signed, wrote }
import createEntry, { type Entry } from "@ermine/core/node/entry"
import { createScheduler, PENDING } from "@ermine/core/scheduler"
import type { Id } from "@ermine/core/table"
import { type Path, type Places, PlacesError } from "@ermine/core/places"
import { get, lookup } from "@ermine/core/places/lib"
import { createChangeHeader } from "@ermine/core/places/header"
import { STATUS, TABLE as STATUS_TABLE } from "@ermine/core/places/status"
import { type Address, type Box, createBox } from "@ermine/boxes"
import { createErmine } from "@ermine/system"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createSites } from "@ermine/sites"
import type { Value } from "@ermine/encoding/cbor"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { BuildError, type Compiler, createBuilds } from "@ermine/compilers"
import { createDlopen, type Live } from "./dlopen.ts"
import { openwith, type Refusal, satisfy, type Way, type Why } from "./programs.ts"
import { ARGS, FOLDER, inside, PIN } from "@ermine/processes/start"
import {
	createPrograms,
	ours,
	type Process,
	type Programs,
	type Runner,
	type Start,
} from "./start.ts"

type Json = unknown

const s = createScheduler()
const ermine = createErmine({ scheduler: s, root: "R", info: { actor: "test" } })
const { table, places } = ermine
const scopes = createScopeNodes({ scheduler: s, table })
// where scopes are made: programs' and software's files and processes' are ours, so a process's
// site is where start was called
const sites = createSites(s, { ours: [...ours, import.meta.resolve("@ermine/processes/start")] })
const hosted = ermine.within
const header = () => createChangeHeader(s)
const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)

// the compilers, and their calls
const calls: Record<string, number> = { upper: 0, wrap: 0, slow: 0, boom: 0 }
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
}

// what the program is given
type Api = {
	places: Places
	process: { id: Id; at: Path; args: readonly string[]; folder: Path }
	watch: (name: string, seen: (id: Id | null) => void) => void
}

// the places the process was started in (a box's, or the host's), the process's facts from the
// start; the scheduler the harness's own
const homes = new Map<Id, Places>()
const createProcessAPI = ({ process, at, args, folder }: Start): Api => ({
	places: homes.get(process.id) ?? places,
	process: { id: process.id, at, args, folder },
	watch: (name, seen) =>
		void s.createComputer(() => {
			const home = homes.get(process.id) ?? places
			const path = lookup(home, [name], folder)
			const id = path === undefined ? null : get(home, path) ?? null
			seen(id)
			return id
		}, () => {}),
})

// the processes by name, and back
const started = new Map<string, Process>()
const procs = new Map<Id, string>()
const named = new Map<string, Box>()
const roots = new Map<Id, string>()
const ran: Json[] = []
const stops: string[] = []
const watching = new Map<string, { runs: number; found: Record<string, Json> }>()

const runner = (code: unknown, ctx: Start) => {
	const a = createProcessAPI(ctx)
	const name = procs.get(a.process.id) ?? String(a.process.id)
	ran.push({ process: name, code, args: a.process.args, keys: Object.keys(a).sort() })
	const p = { runs: 0, found: {} as Record<string, Json> }
	watching.set(name, p)
	for (const arg of a.process.args) {
		a.watch(arg, (id) => {
			p.runs++
			p.found[arg] = id
		})
	}
	return { stop: () => void stops.push(name) }
}

// the loads a runner may have, each counting its calls
const loaded = { js: 0, wasm: 0 }
const text = (code: unknown) =>
	code instanceof Uint8Array ? new TextDecoder().decode(code) : String(code)
// a module's exports: a compile(n) with a memory, taken as a compiler over the memory
function abi(exports: WebAssembly.Exports): unknown {
	const { memory, compile } = exports as { memory?: unknown; compile?: unknown }
	if (!(memory instanceof WebAssembly.Memory) || typeof compile !== "function") return exports
	return {
		...exports,
		compile: (input: unknown) => {
			const bytes = typeof input === "string"
				? new TextEncoder().encode(input)
				: input as Uint8Array
			new Uint8Array(memory.buffer).set(bytes, 0)
			const out = new Uint8Array(memory.buffer).slice(0, compile(bytes.length))
			return typeof input === "string" ? new TextDecoder().decode(out) : out
		},
	}
}
const loads: Record<string, (code: unknown) => unknown> = {
	js: (code) => {
		loaded.js++
		return import(`data:text/javascript,${encodeURIComponent(text(code))}`)
	},
	wasm: async (code) => {
		loaded.wasm++
		const { instance } = await WebAssembly.instantiate(code as Uint8Array<ArrayBuffer>)
		return abi(instance.exports)
	},
}

// the dlopen runner, made as first asked for; what it counts; what native code wrote, by process
const native = { loads: 0, compiles: 0, signed: 0 }
const wrote: { process: string; text: string }[] = []
let dlopen: Runner | undefined
let folder: string | undefined
// each api handed to native code: the process's name, and the struct, kept while native code may
// hold it (the harness's life)
const handed: { name: string; struct: BigUint64Array }[] = []

function dlopenRunner(): Runner {
	if (dlopen !== undefined) return dlopen
	const dir = folder = Deno.makeTempDirSync({ prefix: "ermine-native-" })
	globalThis.addEventListener("unload", () => {
		try {
			Deno.removeSync(dir, { recursive: true })
		} catch { /* gone */ }
	})
	const write = new Deno.UnsafeCallback(
		{ parameters: ["pointer", "pointer", "usize"], result: "void" } as const,
		(ctx, bytes, n) => {
			const at = Number(Deno.UnsafePointer.value(ctx)) - 1
			const len = Number(n)
			const text = bytes === null || len === 0
				? ""
				: new TextDecoder().decode(Deno.UnsafePointerView.getArrayBuffer(bytes, len))
			wrote.push({ process: handed[at].name, text })
		},
	)
	const pointer = (api: unknown): Deno.PointerValue => {
		const a = api as Api
		const struct = new BigUint64Array(2)
		handed.push({ name: procs.get(a.process.id) ?? String(a.process.id), struct })
		struct[0] = BigInt(handed.length)
		struct[1] = BigInt(Deno.UnsafePointer.value(write.pointer))
		return Deno.UnsafePointer.of(struct)
	}
	const note = (what: string) => void (what === "signed" && native.signed++)
	const runner = createDlopen({ dir, pointer, note, api: createProcessAPI })
	const load = (code: unknown): Live => {
		native.loads++
		const live = runner.load(code)
		const compile = live.compile
		if (compile === undefined) return live
		return { ...live, compile: (input: unknown) => (native.compiles++, compile(input)) }
	}
	const start = (code: unknown, ctx: Start) => (native.loads++, runner.start(code, ctx))
	return dlopen = { start, load, api: createProcessAPI }
}

function files(): number {
	if (folder === undefined) return 0
	return [...Deno.readDirSync(folder)].length
}

// what loaded code says
const said: unknown[] = []
;(globalThis as Record<string, unknown>).say = (x: unknown) => void said.push(x)

let programs: Programs | undefined
let cache: Id | undefined

// an answer as JSON: every box's own id as "box:<name>", every process's node as "proc:<name>",
// bytes in their JSON form
function plain(x: unknown): Json {
	return JSON.parse(
		JSON.stringify(x ?? null, (_, v) => {
			if (v instanceof Uint8Array) return toJson(v)
			if (typeof v === "string" && roots.has(v)) return `box:${roots.get(v)}`
			if (typeof v === "string" && procs.has(v)) return `proc:${procs.get(v)}`
			return v
		}),
	)
}

function shown(v: unknown): Json {
	if (v === undefined) return null
	if (v === PENDING) return "pending"
	if (v instanceof BuildError) return { refused: v.code }
	if (v instanceof Error) return { failed: v.message }
	return plain(v)
}

function boxOf(name: unknown): Box {
	const b = named.get(name as string)
	if (b === undefined) throw new Error(`no box ${name}`)
	return b
}

function processOf(name: unknown): Process {
	const p = started.get(name as string)
	if (p === undefined) throw new Error(`no process ${name}`)
	return p
}

const settled = () => new Promise((r) => setTimeout(r, 0))
// a process started is pending
const busy = () =>
	[...started.values()].some((p) => table.get(STATUS_TABLE, p.id)?.value?.[STATUS] === PENDING)

// the search's own whynot as satisfy's or openwith's refusal was before they were generators
function refused(r: Refusal, why: readonly Why[]): Json {
	if (r.why === "nothing-there") return { refused: r.why, path: r.path, at: r.from }
	if (r.at === undefined) return { refused: r.why, id: r.id }
	const program = { id: r.id, at: r.at }
	return r.why === "no-type" ? { refused: r.why, program } : { refused: r.why, program, why }
}

function start(r: Request): Json {
	if (programs === undefined) throw new Error("no programs")
	const where: Box | Places = r.box === undefined ? places : boxOf(r.box)
	const p = "places" in where ? where.places : where
	const folder = inside(r.folder ?? inside(r.at as Address).slice(0, -1))
	const from = r.from ?? folder
	// the way numbered n, the search going no further; nothing yielded: the search's own whynot
	const why: Why[] = []
	let refusal: Refusal | undefined
	const onwhynot = (w: Why | Refusal) => "for" in w ? why.push(w) : refusal = w
	const ways = r.file === undefined
		? satisfy(p, r.program, from, { onwhynot })
		: openwith(p, r.file, from, { onwhynot })
	const n: number = (r.file === undefined ? r.chain : r.way) ?? 0
	let way: Way | undefined
	let i = 0
	for (const w of ways) {
		if (i++ < n) continue
		way = w
		break
	}
	if (refusal !== undefined) return plain(refused(refusal, why))
	if (way === undefined) throw new Error(`no way ${n}`)
	const chosen = way
	const options = { ...(r.args === undefined ? {} : { args: r.args }), folder: r.folder }
	const made = hosted(() => programs!.start(where, chosen, r.at, options))
	if ("refused" in made) return plain(made)
	homes.set(made.id, p)
	started.set(r.name, made)
	procs.set(made.id, r.name)
	return plain({ id: made.id, at: made.at })
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
			hosted(() => table.sub("value", r.id, createEntry(fromJson(r.value), header())))
			return {}
		case "compiler": {
			const f = compilers[r.compiler]
			if (f === undefined) throw new Error(`no compiler ${r.compiler}`)
			hosted(() => table.sub("value", r.id, createEntry(f, header())))
			return {}
		}
		case "runner": {
			const load = r.load === undefined ? undefined : loads[r.load]
			if (r.load !== undefined && load === undefined) throw new Error(`no load ${r.load}`)
			const f: Runner = { start: runner, api: createProcessAPI, ...(load ? { load } : {}) }
			hosted(() => table.sub("value", r.id, createEntry(f, header())))
			return {}
		}
		case "fixture": {
			const name = String(r.name)
			let bytes: Uint8Array
			try {
				if (name.includes("/")) throw new Error("a name")
				bytes = Deno.readFileSync(new URL(`../c/fixtures/${name}.so`, import.meta.url))
			} catch {
				throw new Error(`no fixture ${name}: make builds it`)
			}
			hosted(() => table.sub("value", r.id, createEntry(bytes, header())))
			return {}
		}
		case "dlopen": {
			const f = dlopenRunner()
			hosted(() => table.sub("value", r.id, createEntry(f, header())))
			return {}
		}
		case "native":
			return { ...native, files: files(), wrote: [...wrote] }
		case "create": {
			const at = r.folder !== undefined ? { id: r.folder } : r.at as Address
			const b = hosted(() => createBox(ermine, at))
			named.set(r.name, b)
			if (r.folder === undefined && !Array.isArray(r.at) && r.at === undefined) {
				roots.set(b.root, r.name)
			}
			return {}
		}
		case "box":
			hosted(() => boxOf(r.box).put(r.path, r.node))
			return {}
		case "unbox":
			hosted(() => boxOf(r.box).take(r.path))
			return {}
		case "programs": {
			cache = r.cache
			hosted(() => {
				const writes = { readValue: places.readValue, commit }
				const builds = createBuilds({ scheduler: s, table, places: writes, cache: r.cache })
				programs = createPrograms({
					scheduler: s,
					table,
					places,
					builds,
					scopes,
					sites,
					schedule: () => {},
				})
			})
			return {}
		}
		case "start":
			return start(r)
		case "stop":
			programs!.stop(processOf(r.name))
			return {}
		case "pulse":
			s.pulse()
			return {}
		case "settle": {
			for (const w of waiting.splice(0)) {
				if (r.fail === undefined) w.resolve()
				else w.reject(new Error(r.fail))
			}
			for (let i = 0; i < 200; i++) {
				await settled()
				s.pulse()
				if (!busy()) break
			}
			return {}
		}
		case "process": {
			const id = processOf(r.name).id
			const attrs = table.get("attributes", id)?.value ?? {}
			return {
				parts: table.get(id).map(([k]) => k).sort(),
				status: shown(table.get(STATUS_TABLE, id)?.value?.[STATUS]),
				args: plain(attrs[ARGS]),
				folder: plain(attrs[FOLDER]),
				pin: plain(attrs[PIN]),
			}
		}
		case "here": {
			const p = r.box === undefined ? places : boxOf(r.box).places
			return { id: plain(get(p, r.path) ?? null) }
		}
		case "runs":
			return { runs: plain(ran), stops: [...stops] }
		case "found": {
			const p = watching.get(r.name)
			if (p === undefined) throw new Error(`no program ran for ${r.name}`)
			return { runs: p.runs, found: plain(p.found) }
		}
		case "sites": {
			const chain = sites.sitesOf(processOf(r.name).scope)
			return { sites: chain.map((x) => x.file.split("/").pop()!.replace(/\.[^.]*$/, "")) }
		}
		case "calls":
			return { ...calls }
		case "loads":
			return { ...loaded }
		case "said":
			return { said: plain(said) }
		case "cache": {
			if (cache === undefined) throw new Error("no programs")
			const v = table.get("children", cache)?.value
			return { size: Object.keys(v ?? {}).length }
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
