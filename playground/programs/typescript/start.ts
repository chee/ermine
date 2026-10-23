// start: a process from a way (one satisfy or openwith yields), in a box or plain places, at a path
// in it; and its stop. the process is @ermine/software's: this builds the way and hands software
// the runner and the program as built.
//
//   const programs = createPrograms({ scheduler, table, places, builds, scopes })
//   const [way] = satisfy(b.places, "catclock.c", ["clocks"])   // the first; none: undefined
//   const p = programs.start(b, way, "/clock")              // b: a box, or places
//   // { id: "proc:<uuid>", at: ["clock"], cwd: [], scope }, or { refused: "taken", at: ["clock"] }
//   programs.stop(p)
//
// refused, nothing made: no-runner (an empty chain), taken (software's: the path has a process).
// pin: the program's and each step's id, place and hash, the root and cwd; written at start.
// the run: software.run on the chain's runner, carried ({ id, live }: a host runner is a node with
// no type, so software would not take it by its path), and the program carried with a build: the
// chain's compilers folded over the program's value (@ermine/compilers' fold), the value read once
// at start, the fold in the process's first run; status PENDING while building, the Error on
// failure. then the runner's start(code, start), once, the process's scope open: start is
// software's Start (processes' Context), and the program's api is the runner's to make (api.ts'
// runner: its api option, else createProcessAPI). a throw or a promise: that outcome is the status.
// a step a host holds (by empty): its node's value, live (a runner: software's shape, { start,
// load?, api? } or a function, its start). a loaded step (by not empty): software.load on its by's
// runner, carried, given the step's value through its by's compilers, held by the process. shared
// as software shares loads, the chain the keys of its by's steps (programs' keys before software),
// so a step is loaded once while any process holding it runs. asked as a run ends, never in one.
// a load that fails is let go, so the next start loads it again.
// failures: StartError not-a-runner, not-a-loader, not-a-compiler.
// stop(p, reason?): software's: the runner's handle's stop(reason), then the loads held let go
// ([Symbol.dispose] if any). outputs stay cached
//
// open: a new build reaches a running process only by stop and start; showing that newer code
// exists; the pin's box as its root's id; a compiler's identity changing mid-build
import { CborError, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/formats/hash"
import type { Address, Box } from "@ermine/boxes"
import type { Id, Path, Places } from "@ermine/places"
import { type Context, pathsOf, type Process } from "@ermine/processes/start"
import type { ScopeNodes } from "@ermine/processes/scopes"
import { PENDING, type Scheduler } from "@ermine/scheduler"
import { isPromise } from "@ermine/scheduler/helpers"
import type { Sited } from "@ermine/sites"
import type { Table } from "@ermine/table"
import { type Builds, COMPILER, fold, type Live } from "@ermine/compilers"
import {
	createSoftware,
	type Handle,
	ours as softwares,
	type Refused as Refusal,
	type Runnable,
	type Runner,
	runnerOf,
	type Software,
	type Start,
} from "@ermine/software"
import type { Chain, Place, Step, Way } from "./programs.ts"

// a process: processes'; what a runner is handed: software's Start (processes' Context); a runner
// and its handle: software's
export type { Context, Handle, Process, Runnable, Runner, Start }

// the files of programs and software, for a host's sites (@ermine/sites' ours): a scope's site is
// past them, at the call into start
export const ours: ReadonlySet<string> = new Set([import.meta.url, ...softwares])

export type Setup = {
	scheduler: Scheduler
	table: Table
	// the host's places: where software's writes are committed (a box's places shares its commit).
	// with describe and watchAll, each build's latest run is written too (processes' runs.ts)
	places: Places
	// step: a loaded compiler's compile goes through it (none: such a compile is an Error)
	builds: Pick<Builds, "compile"> & Partial<Pick<Builds, "step">>
	// scope nodes (@ermine/processes/scopes)
	scopes: Pick<ScopeNodes, "give">
	// where the programs' scope and the processes' are made, noting each one's site (ermine/sites;
	// its ours holds this file's ours); none: the scheduler's, no sites
	sites?: Pick<Sited, "createScope">
	// how a pulse is asked for after a start (software's; none: queueMicrotask)
	schedule?: (f: () => void) => void
}

// software's refusals (a carried runner and program: taken only), or no-runner
export type Refused = Refusal | { readonly refused: "no-runner"; readonly program: Place }

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
	// its handle's stop told reason (none: none)
	stop: (p: Process, reason?: unknown) => void
	// a process's latest build by its node's id (software's runs)
	runs: Software["runs"]
}

// as the build lands: a runner's node holding no runner, or a live form with no start; a runner
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

// a loaded step in one process: what loads it (its by's runner, carried: its id and live value as
// read), the code given and the keys of its by; how it landed (none: loading); its hold on
// software's load
type Slot = {
	readonly key: string
	readonly state: State
	readonly step: Step
	readonly by: { readonly id: Id; readonly live: Runnable }
	readonly code: unknown
	readonly chain: readonly string[]
	out?: Landed
	release?: () => void
}

// a process being built: its node (once software has made it); the values of its loaded steps and
// their keys, read at start; its loaded steps by key; the chain's runner, live, once built
type State = {
	process?: Process
	readonly values: Map<Id, unknown>
	readonly keys: Map<Step, string>
	readonly slots: Map<string, Slot>
	runner?: Runner
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

// a part of a step's key: a string as JSON, a symbol or an object (a function, a value with no
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
	const { scheduler: s, table, builds } = setup
	const createScope = setup.sites?.createScope ?? s.createScope
	// the processes' scope, under the scope open; torn down, every process goes, and status with it
	const owner = createScope({ programs: "start" })
	const software = createSoftware({
		scheduler: s,
		table,
		places: setup.places,
		scopes: setup.scopes,
		scope: owner,
		sites: setup.sites,
		schedule: setup.schedule,
		ours: [import.meta.url],
	})
	// loads wanted in a run, asked of software as it ends; promises landed, by the promise, so a
	// load shared with a process before is had at once
	const wanted: Slot[] = []
	const landed = new WeakMap<object, Landed>()
	const off = s.onRunEnd(() => {
		while (wanted.length) load(wanted.shift()!)
	})
	s.registerTeardown(owner, off)

	// the loaded steps' values, read untracked now, and every step's key below them
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
		const box: Box = "places" in where ? where : { root: where.root, places: where }
		const { cwd } = pathsOf(address, options.cwd)
		const { values, keys } = keyed(way)
		const value = table.get("value", program.id)?.value
		const pin = pinOf(where.root, way, value, values, cwd)
		const runner = chain[chain.length - 1]
		const p: State = { values, keys, slots: new Map() }
		// the runner as the build found it, started by software
		const live: Runner = { start: (code, start) => p.runner!.start(code, start) }
		const made = software.run(
			{ id: runner.id, live },
			{ id: program.id, build: () => built(p, way, value) },
			address,
			{ box, args: options.args, cwd: options.cwd, pin },
		)
		if ("refused" in made) return made
		p.process = made
		// gone: what it was still loading lands for no one
		s.registerTeardown(made.scope, () => p.slots.clear())
		return made
	}

	// the program's code, its value through the chain's compilers, once the runner is live too;
	// PENDING while either is; a failure thrown
	function built(p: State, way: Way, value: unknown): unknown {
		const code = folded(p, way.chain.slice(0, -1), value)
		if (code === PENDING) return PENDING
		const runner = runnerAt(p, way.chain[way.chain.length - 1])
		if (runner === PENDING) return PENDING
		p.runner = runner
		return code
	}

	// the value through the compilers (the compilers library's fold), each a host's or loaded;
	// PENDING while one is; an Error thrown
	function folded(p: State, compilers: Chain, value: unknown): unknown {
		return fold({ builds, table, loaded: (c) => compilerOf(p, c) }, compilers, value)
	}

	// a loaded compiler for fold: its live form's compile (none: not-a-compiler), and its value as
	// read at start; PENDING while it loads; its failure thrown
	function compilerOf(p: State, c: Step): Live | typeof PENDING {
		const live = liveOf(p, c) as { compile?: (input: unknown) => unknown } | typeof PENDING
		if (live === PENDING) return PENDING
		if (typeof live?.compile !== "function") throw new StartError("not-a-compiler", c.id)
		return { compile: (input) => live.compile!(input), value: p.values.get(c.id) }
	}

	// a step as a runner: its live form a runner (none: not-a-runner); PENDING while it loads
	function runnerAt(p: State, step: Step): Runner | typeof PENDING {
		const live = liveOf(p, step)
		if (live === PENDING) return PENDING
		const runner = runnerOf(live)
		if (runner === undefined) throw new StartError("not-a-runner", step.id)
		return runner
	}

	// a step's live form: a host's, its node's value; a loaded one's, its load's, asked of software
	// as this run ends (its by's runner with no load: not-a-loader); PENDING while it loads; its
	// failure thrown
	function liveOf(p: State, step: Step): unknown {
		if (step.by.length === 0) return table.get("value", step.id)?.value
		const key = p.keys.get(step)!
		let slot = p.slots.get(key)
		if (slot === undefined) {
			const runner = step.by[step.by.length - 1]
			const by = liveOf(p, runner)
			if (by === PENDING) return PENDING
			if (runnerOf(by)?.load === undefined) {
				throw new StartError(runnerOf(by) ? "not-a-loader" : "not-a-runner", runner.id)
			}
			const code = folded(p, step.by.slice(0, -1), p.values.get(step.id))
			if (code === PENDING) return PENDING
			slot = {
				key,
				state: p,
				step,
				by: { id: runner.id, live: by as Runnable },
				code,
				chain: step.by.map((b) => p.keys.get(b)!),
			}
			p.slots.set(key, slot)
			wanted.push(slot)
		}
		if (slot.out === undefined) {
			s.track(slot)
			return PENDING
		}
		if ("error" in slot.out) throw slot.out.error
		return slot.out.live
	}

	// a slot's load asked of software, held by its process; a promise: landed as it settles. its
	// process gone by now: nothing asked
	function load(slot: Slot) {
		const p = slot.state
		if (p.process === undefined || p.slots.get(slot.key) !== slot) return
		let got: ReturnType<Software["load"]>
		try {
			got = software.load(
				slot.by,
				{ id: slot.step.id, code: slot.code },
				{ by: p.process, chain: slot.chain },
			)
		} catch (error) {
			return land(slot, { error })
		}
		if ("refused" in got) return land(slot, { error: new Error(`not loaded: ${got.refused}`) })
		slot.release = got.release
		const live = got.live
		if (!isPromise(live)) return land(slot, { live })
		const known = landed.get(live)
		if (known !== undefined) return land(slot, known)
		Promise.resolve(live).then(
			(v) => land(slot, remember(live, { live: v })),
			(error) => land(slot, remember(live, { error })),
		)
	}

	const remember = (promise: object, out: Landed): Landed => (landed.set(promise, out), out)

	// how a slot's load landed, its readers marked. a failure is no one's but its holders': let go
	// now, so a later start loads it again
	function land(slot: Slot, out: Landed) {
		if (slot.state.slots.get(slot.key) !== slot) return
		slot.out = out
		if ("error" in out) {
			slot.release?.()
			slot.release = undefined
		}
		s.mark([slot])
	}

	return {
		start,
		stop: (p, reason) => software.stop(p, reason),
		runs: software.runs,
	}
}
