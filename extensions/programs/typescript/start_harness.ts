// start and stop (start.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. its own world, lasting for the process: a scheduler, a table, paths, the host's
// places (root "R", asked [processes(R), children]: the outermost box), scope nodes; the table's
// events and every write told to the host's places (a box's places is a view of them). the host
// writes with its scope open, its info [["actor","test"]]. boxes and processes by name: a folder a
// box made (a fresh id) is answered as "box:<name>", a process's node as "proc:<name>", wherever
// they are in an answer. a PlacesError answers { error: code }. conformance/start's suite and
// conformance/load's (its suite.json naming this harness): load's, with the runners' loads and the
// loads and said requests, are the TypeScript's only (C has no live values to load)
//
// the compilers, by name, each counting its calls (build_harness' own):
//   upper  a string uppercased            wrap  { wasm: input }
//   slow   the input, once settled         boom  throws Error("boom")
// the runner: records the code, the args and the api's keys it was given, and gives a stop that
// records itself. the program it runs, given each arg: a computer of its own, made through the api,
// looking the arg up from the process's folder each run (lib's lookup, nearest first) and keeping
// what it finds
// createProcessAPI: { places: the box's, process: { id, at, args, cwd }, watch(name, seen) } (watch:
// that computer, looking the name up from the process's cwd, nearest first up to its root)
//
// the world:
// { op: "kids", id, value }                 → {}   the children entry there, replaced (a table event)
// { op: "attrs", id, value }                → {}   the attributes entry there, replaced
// { op: "value", id, value }                → {}   the value entry there, replaced (its JSON form:
//    {"/": {"bytes": b64}} bytes)
// { op: "compiler", id, compiler }          → {}   the value entry there: the compiler named
// { op: "runner", id, load? }               → {}   the value entry there: the runner, a function of
//    its own. load, a load on it, each counting its calls: "js" imports the code as a module (a
//    data: URL), its exports given; "wasm" instantiates it, its exports given, a compile(n) with a
//    memory taken as a compiler (a string or bytes written at 0, n bytes read back, as given)
// { op: "create", name, folder?, at? }      → {}   createBox: at the folder id, or at the address at
//    from R (made if missing)
// { op: "box", box, path, node }            → {}
// { op: "unbox", box, path }                → {}
// processes:
// { op: "programs", cache }                 → {}   createBuilds (its cache folder the id cache), then
//    createPrograms, with the host's scope open
// { op: "start", name, box?, program, from?, chain?, at, args?, cwd? } → { id, at }, or a refusal
//    satisfy(program, from) in the box (none: the host's places), then start with its chain
//    numbered chain (none: 0). at and cwd: addresses (names, or a string); from: names, none: the
//    cwd (none: the folder at is in)
// { op: "start", name, box?, file, from?, way?, at, args?, cwd? } → the same: openwith(file,
//    from)'s way numbered way (none: 0). satisfy's or openwith's own whynot (nothing yielded):
//    answered as { refused: its why, ...the rest }
// { op: "stop", name }                      → {}
// { op: "pulse" }                           → {}
// { op: "settle", fail? }                   → {}   every slow call waiting resolved (fail: rejected
//    with Error(fail)), the promises left to land, then a pulse; again while a process is pending
//    (a load lands in a few turns), up to 200 times
// { op: "process", name }                   → { parts, status, args, cwd, pin }   the process's
//    node: its parts' names; its status: "pending", { failed: message }, { refused: code } (a
//    BuildError), null (none); args, cwd and pin as written (null: none)
// { op: "here", box?, path }                → { id }   what the box's places (none: the host's) has
//    at the path (lib's get); null: nothing
// { op: "runs" }                            → { runs: [{ process, code, args, keys }], stops }
//    each runner call in order; each stop called, by process
// { op: "found", name }                     → { runs, found }   the process's program: its
//    computers' runs, and what each arg's last run found (null: nothing)
// { op: "sites", name }                    → { sites }   the process's scope's chain of sites
//    (ermine/sites, start.ts and processes' in its ours): each file's name, no folder and no
//    extension
// { op: "calls" }                           → { upper, wrap, slow, boom }
// { op: "loads" }                           → { js, wasm }   the runners' loads' calls
// { op: "said" }                            → { said }   what loaded code said, in order: say(x), a
//    global of this realm (the loaded code's too)
// { op: "cache" }                           → { size }   the names in the cache folder
// native (conformance/native, both languages; its suite.json gives this harness --allow-write,
// --allow-ffi and --allow-run=/usr/bin/codesign):
// { op: "fixture", id, name }               → {}   the value entry there: the bytes of the native
//    fixture name (c/fixtures/<name>.so, the root Makefile's: reverse, runner, unsigned)
// { op: "dlopen", id }                      → {}   the value entry there: the dlopen runner
//    (dlopen.ts), made as first asked for: its files in a folder of the harness's own, its loads
//    (a by's, or a library run as a program) and their compiles counted, its signings noted; the
//    api it hands native code a struct { ctx, write(ctx, bytes, n) }, write keeping the bytes as
//    text, by process
// { op: "native" }                          → { loads, compiles, files, signed, wrote }   its
//    loads, their compiles, the files in its folder now, the files it signed, and what native
//    code wrote ([{ process, text }], in order)
import createEntry, { type Entry } from "@ermine/node/entry"
import { createScheduler, PENDING } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces, type Places, PlacesError } from "@ermine/places"
import { get, lookup } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { type Address, type Box, box, createBox, inside, unbox } from "@ermine/boxes"
import { processes } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createSites } from "@ermine/sites"
import type { Value } from "@ermine/encoding/cbor"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { BuildError, type Compiler, createBuilds } from "@ermine/build"
import { createDlopen, type Live } from "./dlopen.ts"
import { openwith, type Refusal, satisfy, type Way, type Why } from "./programs.ts"
import { ARGS, CWD, PIN } from "@ermine/processes/start"
import { type Context, createPrograms, type Process, type Programs, type Runner } from "./start.ts"

type Json = unknown

const s = createScheduler()
const table = createTable((part, id) => places.onTableChange(part as Key, id))
const paths = createPaths<unknown>()
const places = createPlaces({
	root: "R",
	table,
	paths,
	scheduler: s,
	contributors: [processes("R"), children],
})
s.onTrackingEnd((key) => places.release(key))
const scopes = createScopeNodes({ scheduler: s, table })
// where scopes are made: start.ts and processes' are ours, so a process's site is where start was
// called
const sites = createSites(s, {
	ours: [
		new URL("./start.ts", import.meta.url).href,
		import.meta.resolve("@ermine/processes/start"),
	],
})
const host = s.createRootScope([["actor", "test"]])
const hosted = <T>(f: () => T) => s.runWithScope(host, f)
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
	process: Context["process"]
	watch: (name: string, seen: (id: Id | null) => void) => void
}

const createProcessAPI = ({ places, process, scheduler }: Context): Api => ({
	places,
	process,
	watch: (name, seen) =>
		void scheduler.createComputer(() => {
			const path = lookup(places, [name], process.cwd)
			const id = path === undefined ? null : get(places, path) ?? null
			seen(id)
			return id
		}, () => {}),
})

// a folder a box made: a uuid
const FRESH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// the processes by name, and back
const started = new Map<string, Process>()
const procs = new Map<Id, string>()
const named = new Map<string, Box>()
const roots = new Map<Id, string>()
const ran: Json[] = []
const stops: string[] = []
const watching = new Map<string, { runs: number; found: Record<string, Json> }>()

const runner = (code: unknown, api: unknown) => {
	const a = api as Api
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
	const runner = createDlopen({ dir, pointer, note })
	const load = (code: unknown): Live => {
		native.loads++
		const live = runner.load(code)
		const compile = live.compile
		if (compile === undefined) return live
		return { ...live, compile: (input: unknown) => (native.compiles++, compile(input)) }
	}
	const run = (code: unknown, api: unknown) => (native.loads++, runner(code, api))
	return dlopen = Object.assign(run, { load })
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
	[...started.values()].some((p) => table.get("attributes", p.id)?.value?.[STATUS] === PENDING)

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
	const cwd = inside(r.cwd ?? inside(r.at as Address).slice(0, -1))
	const from = r.from ?? cwd
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
	const options = { ...(r.args === undefined ? {} : { args: r.args }), cwd: r.cwd }
	const made = hosted(() => programs!.start(where, chosen, r.at, options))
	if ("refused" in made) return plain(made)
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
			const f: Runner = load === undefined ? runner : Object.assign(
				(code: unknown, api: unknown) => runner(code, api),
				{ load },
			)
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
			const b = hosted(() => createBox({ places, table, scheduler: s }, at))
			named.set(r.name, b)
			if (FRESH.test(String(b.root))) roots.set(b.root, r.name)
			return {}
		}
		case "box":
			hosted(() => box(boxOf(r.box), r.path, r.node))
			return {}
		case "unbox":
			hosted(() => unbox(boxOf(r.box), r.path))
			return {}
		case "programs": {
			cache = r.cache
			hosted(() => {
				const writes = { readValue: places.readValue, commit }
				const builds = createBuilds({ scheduler: s, table, places: writes, cache: r.cache })
				programs = createPrograms({
					scheduler: s,
					table,
					places: writes,
					builds,
					scopes,
					createProcessAPI,
					sites,
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
				status: shown(attrs[STATUS]),
				args: plain(attrs[ARGS]),
				cwd: plain(attrs[CWD]),
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
