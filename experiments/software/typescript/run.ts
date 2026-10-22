// run: a program on a runner, as a process. what a run asks of the program and the runner (its
// form, its hash), then the process: run at a path, loaded live with no process, stopped, and the
// reasons it is stopped with. which question: how a program runs on a runner
//
// what a runner is handed is a Start: { box, places, process: { id, at, args, cwd }, scheduler,
// table, scope }. what the program gets is the runner's: this makes no api; a runner over
// ermine/api builds it from context.createAPI(start) (api? saying how). its limits are the
// runner's too: nothing here counts
// run(runner, program, at, { args, cwd, box, pin }): runner from places' root; program an address
// from where's root (where: box, else places) or { id, hash?, type?, api?, code? }. refused,
// nothing made, the first that holds:
//   not-a-runner   nothing at runner, or its ermine.type is not ermine.runner
//   not-there      no program node, or no value; by id: none, or not the hash given; code given:
//                  not the hash given
//   wrong-form     the program's ermine.type (code given: type) is not the runner's
//                  ermine.runner.takes (both strings, exact); or it names an api
//                  (ermine.program.api; code given: api) the runner's ermine.runner.api is not
//   not-a-runner   the runner's value is no runner here (no start)
//   taken          a process at, above or under at (processes')
// else processes' start under a scope of its own (under the runner's offer's, when offered here;
// else setup.scope), with ermine.type ermine.process, ermine.process.runner { id, at },
// .program { id, at?, hash? } (hash: of its value; none: a live value); the code read once now;
// at the first pulse, a one-shot effect, the process's scope open: start(code, Start). a handle:
// held, its stop its stopper's teardown (landing after the stop: called then); a throw, a
// rejected promise: the status. a run made outside a pulse asks for one (setup.schedule)
// load(runner, program, { by, box? }): the program made live on the runner with no process: its
// load(code, start), start by's facts, by's scope open (unless one is). checked as run is (no
// path, so never taken); a runner with no load: not-a-runner. what load throws: thrown.
// { live, release }: live held by by, let go (live[Symbol.dispose], if it has one) at release or at
// by's scope's teardown, after its handle's, newest first
// stop(p, reason?): the reason told, then where it runs torn down, in the scheduler's order: its
// offers and what runs on them ("runner-stopped"), its handle's stop(reason), then its own scope.
// twice, or none run here: nothing
// a process gone with what it runs under, not told: its runner's offer going, the offer's why
// (none: "runner-stopped"); else none
import { CborError, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/encoding/hash"
import { type Address, type Box, inside } from "@ermine/boxes"
import type { Id, Path, Places } from "@ermine/places"
import { get } from "@ermine/places/lib"
import type { Inside, Process } from "@ermine/processes/start"
import type { Scheduler, Scope } from "@ermine/scheduler"
import { isPromise } from "@ermine/scheduler/helpers"
import type { Table } from "@ermine/table"
import {
	ATTRIBUTE,
	type Ctx,
	drop,
	type Held,
	holder,
	isMap,
	ours,
	type Owner,
	type Place,
	type Running,
	TYPE,
} from "./common.ts"
import { API, runnerOf, TAKES } from "./offers.ts"

ours.add(import.meta.url)

// a process's attributes, as run writes them
export const PROGRAM_API = "ermine.program.api"
export const RUNNER = "ermine.process.runner"
export const PROGRAM = "ermine.process.program"

export const REASONS = { withdrawn: "withdrawn", runner: "runner-stopped" } as const

// what a runner gives back; @ermine/programs/start's Handle is one
export type Handle = { readonly stop: (reason?: unknown) => unknown }
// what a runner is handed: the run's facts (a load's: its by's)
export type Start = {
	readonly box: Box
	readonly places: Places
	readonly process: {
		readonly id: Id
		readonly at: Path
		readonly args: readonly string[]
		readonly cwd: Path
	}
	readonly scheduler: Scheduler
	readonly table: Table
	readonly scope: Scope
}
// a live runner: start a process's program; load, a program live with no process; api, what its
// programs get
export type Runner = {
	readonly start: (code: unknown, start: Start) => Handle | PromiseLike<Handle> | void
	readonly load?: (code: unknown, start: Start) => unknown
	readonly api?: (start: Start) => unknown
}
// what a runner node may hold: a Runner, or a function, its start
export type Runnable = Runner | (Runner["start"] & Partial<Pick<Runner, "load" | "api">>)
// a load: the live form, and its letting go now (else at its holder's stop)
export type Loaded = { readonly live: unknown; readonly release: () => void }
// a program by id (its hash, when given, must be its value's), or carried (code: run as it is)
export type Program = {
	readonly id: Id
	readonly hash?: string
	readonly type?: string
	readonly api?: string
	readonly code?: unknown
}
export type Refused =
	| { readonly refused: "taken"; readonly at: Path }
	| { readonly refused: "not-a-runner"; readonly runner: Path }
	// program: its path (an address given) or its id (a Program given)
	| { readonly refused: "not-there"; readonly program: Path | Id }
	| {
		readonly refused: "wrong-form"
		// each field only when a string
		readonly program: { readonly type?: string; readonly api?: string }
		readonly runner: { readonly takes?: string; readonly api?: string }
	}
export type Options = {
	args?: readonly string[]
	cwd?: Address
	// where it runs, and where program and at are from; none: places
	box?: Box
	// ermine.process.pin, as processes' start writes it
	pin?: unknown
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// hex of a value's hash; no encoding: undefined
export function hashOf(v: unknown): string | undefined {
	try {
		return hex(hash(v as Value))
	} catch (e) {
		if (e instanceof CborError) return undefined
		throw e
	}
}

const isAddress = (x: unknown): x is Address => typeof x === "string" || Array.isArray(x)

// the fields that are strings
function strings<K extends string>(o: Record<K, unknown>): Partial<Record<K, string>> {
	const out: Partial<Record<K, string>> = {}
	for (const k in o) if (typeof o[k] === "string") out[k] = o[k] as string
	return out
}

export function createRun(c: Ctx) {
	const { s, table, home, processes, changed, later } = c

	// the node at an address from a box's root, untracked
	const resolve = (where: Box, address: Address): { path: Path; id: Id | undefined } => {
		const path = inside(address)
		return { path, id: where.places.peep(() => get(where.places, path)) }
	}

	const attributesOf = (id: Id) => {
		const v = table.get("attributes", id)?.value
		return isMap(v) ? v : {}
	}

	// what an owner's runner is handed
	const startOf = (o: Owner): Start => ({
		box: o.box,
		places: o.box.places,
		process: { id: o.id, at: o.at, args: o.args, cwd: o.cwd },
		scheduler: s,
		table,
		scope: o.scope,
	})

	// the checks in order, up to taken (processes'): the runner, the program read once. load: a
	// runner with no load is not-a-runner
	type Checked = {
		readonly runner: { readonly id: Id; readonly path: Path }
		readonly program: { readonly id: Id; readonly at?: Path }
		readonly code: unknown
		readonly digest?: string
		readonly live: Runner
	}
	function check(
		runner: Address,
		program: Address | Program,
		where: Box,
		load: boolean,
	): Checked | Refused {
		const r = resolve(home, runner)
		const notRunner = { refused: "not-a-runner", runner: r.path } as const
		if (r.id === undefined) return notRunner
		const rattrs = attributesOf(r.id)
		if (rattrs[ATTRIBUTE] !== TYPE.runners) return notRunner
		// the program: its node (or carried code), its form, and its code read once
		let id: Id, path: Path | undefined, code: unknown, digest: string | undefined
		let type: unknown, api: unknown
		if (isAddress(program)) {
			const p = resolve(where, program)
			path = p.path
			const entry = p.id === undefined ? undefined : table.get("value", p.id)
			if (p.id === undefined || entry === undefined) {
				return { refused: "not-there", program: p.path }
			}
			id = p.id
			code = entry.value
			digest = hashOf(code)
			;({ [ATTRIBUTE]: type, [PROGRAM_API]: api } = attributesOf(id))
		} else if (program.code !== undefined) {
			id = typeof program.id === "string" ? program.id : ""
			code = program.code
			digest = hashOf(code)
			if (program.hash !== undefined && program.hash !== digest) {
				return { refused: "not-there", program: id }
			}
			type = program.type
			api = typeof program.api === "string" ? program.api : undefined
		} else {
			id = typeof program.id === "string" ? program.id : ""
			const entry = table.get("value", id)
			if (entry === undefined) return { refused: "not-there", program: id }
			code = entry.value
			digest = hashOf(code)
			if (program.hash !== undefined && program.hash !== digest) {
				return { refused: "not-there", program: id }
			}
			;({ [ATTRIBUTE]: type, [PROGRAM_API]: api } = attributesOf(id))
		}
		const takes = rattrs[TAKES], given = rattrs[API]
		if (
			typeof type !== "string" || typeof takes !== "string" || type !== takes ||
			(api !== undefined && api !== given)
		) {
			return {
				refused: "wrong-form",
				program: strings({ type, api }),
				runner: strings({ takes, api: given }),
			}
		}
		const live = runnerOf(table.get("value", r.id)?.value)
		if (live === undefined || (load && live.load === undefined)) return notRunner
		return {
			runner: { id: r.id, path: r.path },
			program: { id, ...(path === undefined ? {} : { at: path }) },
			code,
			...(digest === undefined ? {} : { digest }),
			live,
		}
	}

	function run(
		runner: Address,
		program: Address | Program,
		address: Address,
		options: Options = {},
	): Process | Refused {
		const where = options.box ?? home
		const ck = check(runner, program, where, false)
		if ("refused" in ck) return ck
		const { live, code, digest } = ck
		const on = c.offers.get(ck.runner.id)
		const attrs = {
			[ATTRIBUTE]: TYPE.process,
			[RUNNER]: { id: ck.runner.id, at: ck.runner.path },
			[PROGRAM]: digest === undefined ? ck.program : { ...ck.program, hash: digest },
		}
		// where it runs: a scope under its runner's offer (none: setup.scope) holding, newest first,
		// what it offers, its handle's stop, then its own scope
		const under = c.createScope({ on: ck.runner.id }, on?.scope ?? c.scope)
		let p: Running | undefined
		let made: Process | { refused: "taken"; at: Path }
		try {
			made = processes.start(
				where,
				address,
				{ args: options.args, cwd: options.cwd, pin: options.pin, attributes: attrs, under },
				(inner) => {
					// its handle's stop: the teardown of a scope beside its own, newer, so it goes
					// before it (what its program made told the reason) and after what it offers
					// (newer still). its writes the process's: its info
					const stopper = c.createScope({ ...inner.scope.info }, under)
					const q: Running = {
						id: inner.id,
						at: inner.at,
						scope: inner.scope,
						under,
						stopper,
						box: inner.box,
						args: inner.args,
						cwd: inner.cwd,
						folders: new Map(),
						offers: [],
						loads: [],
						on,
						ended: false,
						told: false,
					}
					s.registerTeardown(stopper, () => {
						const h = q.handle
						q.handle = undefined
						h?.stop(reasonOf(q))
					})
					// its own scope torn down alone (from above it, by a host): the rest go too
					s.registerTeardown(q.scope, () => s.teardown(under))
					holder(s, q)
					p = q
					c.running.push(q)
					c.byId.set(q.id, q)
					// core candidate (scheduler): an effect that acts once and goes
					const first = s.createEffect(() => true, () => {
						try {
							begin(q, inner, live, code)
						} finally {
							s.teardown(first)
						}
					})
					inner.give(first, { run: true })
					return () => done(q)
				},
			)
		} catch (e) {
			s.teardown(under)
			throw e
		}
		if ("refused" in made) {
			s.teardown(under)
			return made
		}
		p!.process = made
		changed()
		later()
		return made
	}

	// the runner's start called, the process's scope open. a handle at once: held; a throw or a
	// promise: a computer holding the outcome, its status the node's
	function begin(p: Running, inner: Inside, live: Runner, code: unknown) {
		let out: { value: unknown } | { error: unknown }
		try {
			const start = startOf(p)
			out = { value: s.runWithScope(p.scope, () => live.start(code, start)) }
		} catch (error) {
			out = { error }
		}
		const o = out
		if ("value" in o && !isPromise(o.value)) return hold(p, o.value)
		// a handle landing late: what its stop throws, the process gone, has nobody to tell
		if ("value" in o) {
			;(o.value as PromiseLike<unknown>).then((h) => {
				try {
					hold(p, h)
				} catch {
					// dropped
				}
			}, () => {})
		}
		const status = s.runWithScope(p.scope, () =>
			s.createComputer(() => {
				if ("error" in o) throw o.error
				return o.value
			}, () => {}))
		inner.give(status)
	}

	// a handle given: held, its stop its stopper's teardown; gone already, stopped now with its
	// reason. no stop in it: nothing
	function hold(p: Running, h: unknown) {
		if (!isMap(h) || typeof h.stop !== "function") return
		if (p.stopper.state !== "alive") (h as Handle).stop(reasonOf(p))
		else p.handle = h as Handle
	}

	// why a process goes: told by a stop; else its runner's offer going, the offer's why (none:
	// "runner-stopped"); else none
	function reasonOf(p: Running): unknown {
		if (p.told) return p.reason
		if (p.on !== undefined && p.on.scope.state !== "alive") return p.on.why ?? REASONS.runner
		return undefined
	}

	// a process going (its done, called by processes' stop, or by its scope torn down from above):
	// out of the lists. what goes with it is its scope's
	function done(p: Running) {
		if (p.ended) return
		p.ended = true
		const i = c.running.indexOf(p)
		if (i !== -1) c.running.splice(i, 1)
		c.byId.delete(p.id)
		changed()
	}

	function load(
		runner: Address,
		program: Address | Program,
		options: { by: Place; box?: Box },
	): Loaded | Refused {
		const by = c.ownerOf(options.by)
		const ck = check(runner, program, options.box ?? by.box, true)
		if ("refused" in ck) return ck
		const start = startOf(by)
		const f = () => ck.live.load!(ck.code, start)
		const live = s.getCurrentScope() !== undefined ? f() : s.runWithScope(by.scope, f)
		const h: Held = { live, released: false }
		by.loads.push(h)
		later()
		return { live, release: () => drop(by, h) }
	}

	function stop(x: Process | Id, reason?: unknown) {
		const p = c.byId.get(typeof x === "object" ? x.id : x)
		if (p === undefined || p.ended) return
		p.told = true
		p.reason = reason
		s.teardown(p.under)
	}

	return { run, load, stop }
}
