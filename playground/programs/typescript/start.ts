// start: a process from a way (one satisfy or openwith yields), in a box or plain places, at a path
// in it; and its stop. the process's life (scope, node, args, cwd, pin, status, stop) is
// @ermine/processes/start's; this runs the way in it.
//
//   const programs = createPrograms({ scheduler, table, places, builds, scopes, createProcessAPI })
//   const [way] = satisfy(b.places, "catclock.c", ["clocks"])   // the first; none: undefined
//   const p = programs.start(b, way, "/clock")              // b: a box, or places
//   // { id: "proc:<uuid>", at: ["clock"], cwd: [], scope }, or { refused: "taken", at: ["clock"] }
//   programs.stop(p)
//
// refused, nothing made: no-runner (an empty chain), taken (the path has a running process).
// pin: the program's and each step's id, place and hash, the root and cwd; written at start.
// build: the chain's compilers folded over the program's value, read once at start; status
// PENDING while building, the Error on failure. then the runner is called once with the code and
// createProcessAPI({ box, places, process: { id, at, args, cwd }, scheduler, table, scope }), the
// process's scope open. a runner that throws or gives a promise: that outcome is the status.
// loaded steps (by not empty): run through their by's runner's load(code) to a live form (compile
// or run), each loaded once per key (id, value hash, by), held while a process using it runs.
// failures: StartError not-a-runner, not-a-loader, not-a-compiler.
// stop(p): the runner's stop, then held loads let go ([Symbol.dispose] if any). outputs stay
// cached
//
// open: a new build reaches a running process only by stop and start; showing that newer code
// exists; the pin's box as its root's id; a compiler's identity changing mid-build
import { CborError, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/formats/hash"
import type { Address, Box } from "@ermine/boxes"
import type { Id, Path, Places } from "@ermine/places"
import {
	type Context,
	createProcesses,
	type Inside,
	pathsOf,
	type Process,
	type Processes,
	type Refused as Taken,
} from "@ermine/processes/start"
import type { ScopeNodes } from "@ermine/processes/scopes"
import { type Computer, PENDING, type Scheduler } from "@ermine/scheduler"
import { isPromise } from "@ermine/scheduler/helpers"
import type { Sited } from "@ermine/sites"
import type { Table } from "@ermine/table"
import { type Builds, COMPILER } from "@ermine/build"
import type { Chain, Place, Step, Way } from "./programs.ts"

// a process: processes' (start gives back what processes' start does); what createProcessAPI is
// handed: processes' Context
export type { Context, Process }

// what a runner gives back: how to stop what it started
export type Handle = { readonly stop: () => unknown }

// a host runner: its node's value, a live function from the host, never saved. load, if it has
// one: a module's live form from its code (exports; a promise of them)
export type Runner =
	& ((code: unknown, api: unknown) => Handle | PromiseLike<Handle>)
	& { readonly load?: (code: unknown) => unknown }

// a loaded step's live form, as its runner's load gave it: a compiler's has compile, a runner's run
// and maybe load; any, what lets it go as the last process holding it stops
export type Loaded = {
	readonly compile?: (input: unknown) => unknown
	readonly run?: (code: unknown, api: unknown) => Handle | PromiseLike<Handle>
	readonly load?: (code: unknown) => unknown
	readonly [Symbol.dispose]?: () => void
}

export type Setup = {
	scheduler: Scheduler
	table: Table
	// processes' places: where status.ts' writes are committed, the host's (a box's places shares
	// its commit). with describe and watchAll, each build's latest run is written too (runs.ts)
	places: Pick<Places, "commit"> & Partial<Pick<Places, "describe" | "watchAll">>
	// step: a loaded compiler's compile goes through it (none: such a compile is an Error)
	builds: Pick<Builds, "compile"> & Partial<Pick<Builds, "step">>
	// scope nodes (@ermine/processes/scopes)
	scopes: Pick<ScopeNodes, "give">
	// what the program is given: its return, and nothing else
	createProcessAPI: (ctx: Context) => unknown
	// where the programs' scope and the processes' are made, noting each one's site (ermine/sites;
	// its ours holds this file and processes' start.ts); none: the scheduler's, no sites
	sites?: Pick<Sited, "createScope">
}

export type Refused = Taken | { readonly refused: "no-runner"; readonly program: Place }

// a step as pinned: a loaded one's with the hash of its value and its by
export type Pinned = Place & {
	readonly identity?: unknown
	readonly attributes?: string
	readonly hash?: string
	readonly by?: readonly Pinned[]
}

export type Pin = {
	readonly program: Place & { readonly hash?: string }
	readonly chain: readonly Pinned[]
	readonly box: Id
	readonly cwd: Path
}

export type Programs = {
	start: (
		where: Box | Places,
		way: Way,
		at: Address,
		options?: { args?: readonly string[]; cwd?: Address },
	) => Process | Refused
	stop: (p: Process) => void
	// a process's latest run by its node's id (the processes')
	runs: Processes["runs"]
}

// as the build lands: a runner's node holding no function, or a live form with no run; a runner
// asked to load with no load; a loaded compiler's live form with no compile. step: its id
export class StartError extends Error {
	constructor(
		readonly code: "not-a-runner" | "not-a-loader" | "not-a-compiler",
		readonly step: Id,
	) {
		super(code)
		this.name = "StartError"
	}
}

// how a load landed: the live form, or what it threw
type Landed = { readonly live: unknown } | { readonly error: unknown }

// a load: what loads it (a live runner with load) and the code given; how it landed (none:
// loading); its computer; the processes holding it
type Load = {
	readonly key: string
	readonly by: Loaded
	readonly code: unknown
	out?: Landed
	c?: Computer
	readonly holders: Set<State>
}

// a process inside (processes' Inside): its handle once the runner gave one; stopped (the runner's
// stop called, or to be called as its promise lands); the values of its loaded steps and their
// keys, read at start; the loads it holds, by key
type State = Inside & {
	readonly values: Map<Id, unknown>
	readonly keys: Map<Step, string>
	readonly loads: Map<string, Load>
	handle?: Handle
	stopped: boolean
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// hex of a value's hash; no encoding: undefined
function hashOf(v: unknown): string | undefined {
	try {
		return hex(hash(v as Value))
	} catch (e) {
		if (e instanceof CborError) return undefined
		throw e
	}
}

// a part of a load's key: a string as JSON, a symbol or an object (a function, a value with no
// encoding) by a number of its own
const symbols = new Map<symbol, number>()
const objects = new WeakMap<object, number>()
let tags = 0
function tag(x: unknown): string {
	if (typeof x === "symbol") {
		let n = symbols.get(x)
		if (n === undefined) symbols.set(x, n = ++tags)
		return `s${n}`
	}
	if ((typeof x === "object" && x !== null) || typeof x === "function") {
		let n = objects.get(x)
		if (n === undefined) objects.set(x, n = ++tags)
		return `o${n}`
	}
	return typeof x === "string" ? JSON.stringify(x) : String(x)
}

export function createPrograms(setup: Setup): Programs {
	const { scheduler: s, table, places, builds, scopes, createProcessAPI } = setup
	const createScope = setup.sites?.createScope ?? s.createScope
	// the processes' owner, under the scope open; torn down, every process goes, and status with it
	const owner = createScope({ programs: "start" })
	// the loads' computers
	const loading = s.createScope({ programs: "loads" }, owner)
	const processes = createProcesses({
		scheduler: s,
		table,
		places,
		scopes,
		sites: setup.sites,
		owner,
		ours: [import.meta.url],
	})
	// the loaded, by key; loads wanted in a run, made as it ends
	const loads = new Map<string, Load>()
	const wanted: Load[] = []
	const drain = () => {
		while (wanted.length) begin(wanted.shift()!)
	}
	const off = s.onRunEnd(drain)
	s.registerTeardown(owner, off)

	// the loaded steps' values, read untracked now, and their keys
	function keyed(way: Way) {
		const values = new Map<Id, unknown>()
		const keys = new Map<Step, string>()
		const keyOf = (step: Step): string => {
			let k = keys.get(step)
			if (k !== undefined) return k
			const v = table.get("value", step.id)?.value
			if (step.by.length === 0) k = tag(v)
			else {
				values.set(step.id, v)
				k = JSON.stringify([tag(step.id), hashOf(v) ?? tag(v), ...step.by.map(keyOf)])
			}
			keys.set(step, k)
			return k
		}
		for (const step of way.chain) if (step.by.length > 0) keyOf(step)
		return { values, keys }
	}

	// what was chosen, read untracked now
	function pinOf(root: Id, way: Way, value: unknown, values: Map<Id, unknown>, cwd: Path): Pin {
		const step = ({ id, at, by }: Step): Pinned => {
			const attrs = table.get("attributes", id)?.value
			const identity = isMap(attrs) ? attrs[COMPILER] : undefined
			const h = identity !== undefined || attrs === undefined ? undefined : hashOf(attrs)
			const pinned: Pinned = identity !== undefined
				? { id, at, identity }
				: h === undefined
				? { id, at }
				: { id, at, attributes: h }
			if (by.length === 0) return pinned
			const v = hashOf(values.get(id))
			return { ...pinned, ...(v === undefined ? {} : { hash: v }), by: by.map(step) }
		}
		const h = hashOf(value)
		const { id, at } = way.program
		return {
			program: h === undefined ? { id, at } : { id, at, hash: h },
			chain: way.chain.map(step),
			box: root,
			cwd,
		}
	}

	function start(
		where: Box | Places,
		way: Way,
		address: Address,
		options: { args?: readonly string[]; cwd?: Address } = {},
	): Process | Refused {
		const { program, chain } = way
		if (chain.length === 0) return { refused: "no-runner", program }
		const { at, cwd } = pathsOf(address, options.cwd)
		const { values, keys } = keyed(way)
		const value = table.get("value", program.id)?.value
		const pin = pinOf(where.root, way, value, values, cwd)
		const compilers = chain.slice(0, -1)
		const runner = chain[chain.length - 1]
		return processes.start(where, at, { args: options.args, cwd, pin }, (inside) => {
			const p: State = { ...inside, values, keys, loads: new Map(), stopped: false }
			// core candidate (scheduler): an effect that acts once and goes
			const build = s.createEffect<{ code: unknown; live?: Loaded }>(
				() => {
					const code = fold(p, compilers, value)
					if (code === PENDING) return PENDING
					if (runner.by.length === 0) return { code }
					const live = liveOf(p, runner)
					return live === PENDING ? live : { code, live }
				},
				({ code, live }) => {
					try {
						run(p, runner, code, live)
					} finally {
						s.teardown(build)
					}
				},
			)
			inside.give(build, { run: true })
			return () => end(p)
		})
	}

	// the value through the compilers, each a host's (builds.compile) or loaded (builds.step under
	// its identity); PENDING while one is; an Error thrown
	function fold(p: State, compilers: Chain, value: unknown): unknown {
		let v = value
		for (const c of compilers) {
			if (c.by.length === 0) v = builds.compile(c.id, v)
			else {
				const live = liveOf(p, c)
				if (live === PENDING) return PENDING
				if (typeof live?.compile !== "function") throw new StartError("not-a-compiler", c.id)
				if (builds.step === undefined) {
					throw new Error(`a loaded compiler (${String(c.id)}) needs builds.step`)
				}
				const attrs = table.get("attributes", c.id)?.value
				const named = isMap(attrs) ? attrs[COMPILER] : undefined
				const h = named === undefined ? hashOf(p.values.get(c.id)) : undefined
				const identity = named ?? (h === undefined ? c.id : { id: c.id, hash: h })
				const input = v
				v = builds.step(identity, input, () => live.compile!(input))
			}
			if (v === PENDING) return PENDING
			if (v instanceof Error) throw v
		}
		return v
	}

	// a step's live form: a host's, its node's value (a function, else not-a-runner); a loaded
	// one's, its load's, the process holding it; PENDING while it loads; its failure thrown
	function liveOf(p: State, step: Step): Loaded | typeof PENDING {
		if (step.by.length === 0) {
			const fn = table.get("value", step.id)?.value
			if (typeof fn !== "function") throw new StartError("not-a-runner", step.id)
			return fn as Loaded
		}
		const key = p.keys.get(step)!
		let l = p.loads.get(key) ?? loads.get(key)
		if (l === undefined) {
			const runner = step.by[step.by.length - 1]
			const by = liveOf(p, runner)
			if (by === PENDING) return PENDING
			if (typeof by?.load !== "function") throw new StartError("not-a-loader", runner.id)
			const code = fold(p, step.by.slice(0, -1), p.values.get(step.id))
			if (code === PENDING) return PENDING
			l = { key, by, code, holders: new Set() }
			loads.set(key, l)
			if (s.getRun() === undefined) begin(l)
			else wanted.push(l)
		}
		if (!p.loads.has(key)) {
			p.loads.set(key, l)
			l.holders.add(p)
		}
		if (l.out === undefined) {
			s.track(l)
			return PENDING
		}
		if ("error" in l.out) throw l.out.error
		return l.out.live as Loaded
	}

	// a load's computer, under the loads' scope: load called once, how it landed set, its readers
	// marked. a failure is no one's but its holders'. held by none by now: not made
	// core candidate (scheduler): a computer made for a run, not by it (as build.ts' steps)
	function begin(l: Load) {
		if (loads.get(l.key) !== l || l.holders.size === 0 || loading.state !== "alive") return
		l.c = s.runWithScope(loading, () =>
			s.createComputer<Landed>(
				() => {
					let out: unknown
					try {
						out = l.by.load!(l.code)
					} catch (error) {
						return { error }
					}
					if (!isPromise(out)) return { live: out }
					return Promise.resolve(out).then((live) => ({ live }), (error) => ({ error }))
				},
				(landed) => {
					l.out = landed
					if ("error" in landed && loads.get(l.key) === l) loads.delete(l.key)
					s.mark([l], l.c)
				},
			))
	}

	// the loads p holds let go; one held by no process goes, its computer torn down, its live form
	// disposed
	function release(p: State) {
		let failed: { error: unknown } | undefined
		for (const l of p.loads.values()) {
			l.holders.delete(p)
			if (l.holders.size > 0) continue
			if (loads.get(l.key) === l) loads.delete(l.key)
			if (l.c !== undefined && l.c.state === "alive") s.teardown(l.c)
			const live = l.out !== undefined && "live" in l.out ? l.out.live as Loaded : undefined
			try {
				if (typeof live?.[Symbol.dispose] === "function") live[Symbol.dispose]!()
			} catch (error) {
				failed ??= { error }
			}
		}
		p.loads.clear()
		if (failed) throw failed.error
	}

	// the runner called, the process's scope open: a host's function, or a loaded one's run. a
	// handle at once: held; a throw or a promise: a computer holding the outcome, its status the
	// node's
	function run(p: State, runner: Step, code: unknown, live?: Loaded) {
		let out: { value: unknown } | { error: unknown }
		try {
			const fn = live === undefined ? table.get("value", runner.id)?.value : live.run
			if (typeof fn !== "function") throw new StartError("not-a-runner", runner.id)
			const process = { id: p.id, at: p.at, args: p.args, cwd: p.cwd }
			const ctx: Context = {
				box: p.box,
				places: p.box.places,
				process,
				scheduler: s,
				table,
				scope: p.scope,
			}
			const api = createProcessAPI(ctx)
			out = {
				value: s.runWithScope(
					p.scope,
					() => live === undefined ? (fn as Runner)(code, api) : live.run!(code, api),
				),
			}
		} catch (error) {
			out = { error }
		}
		const o = out
		if ("value" in o && !isPromise(o.value)) return hold(p, o.value)
		if ("value" in o) (o.value as PromiseLike<unknown>).then((h) => hold(p, h), () => {})
		const c = s.runWithScope(p.scope, () =>
			s.createComputer(() => {
				if ("error" in o) throw o.error
				return o.value
			}, () => {}))
		p.give(c)
	}

	// a handle given: kept; stopped already, stopped now. no stop in it: nothing to stop
	function hold(p: State, h: unknown) {
		if (!isMap(h) || typeof h.stop !== "function") return
		if (p.stopped) (h as Handle).stop()
		else p.handle = h as Handle
	}

	// the runner's stop, once; its loads let go. every step runs; the first error is thrown after
	function end(p: State) {
		let failed: { error: unknown } | undefined
		if (!p.stopped) {
			p.stopped = true
			const h = p.handle
			p.handle = undefined
			try {
				if (h !== undefined) h.stop()
			} catch (error) {
				failed = { error }
			}
		}
		try {
			release(p)
		} catch (error) {
			failed ??= { error }
		}
		if (failed) throw failed.error
	}

	const stop = (process: Process) => processes.stop(process)

	return { start, stop, runs: processes.runs }
}
