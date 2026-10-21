// start: run a program on a runner. what a start asks of the program and the runner (its form, its
// hash, the policy), then the process: started at a path, loaded live with no process, stopped, and
// the reasons it is stopped with. which question: how a program runs on a runner
//
// a start is a Start: { box, places, process: { id, at, args, cwd }, scheduler, table, scope, den }.
// what the program gets is the runner's: this makes no api (no ermine/api here); a runner over
// ermine/api builds it from context.createAPI(start), api? saying how (ermine/api's run is one).
// programs' runners are functions given the Start where programs gives an api (realms.run:
// createRealms({ createAPI }); dlopen's: its pointer given it). its limits are the runner's too: a
// loop budget, fuel, a cost a call, by wrapping what it starts or loads; nothing here counts
// start(runner, program, at, { args, cwd, box, pin }): runner from the den's root; program an
// address from where's root (where: box, else the den's places) or { id, hash?, type?, api?,
// code? }. refused, nothing made, the first that holds:
//   stopped        the den is closed
//   not-a-runner   nothing at runner, or its ermine.type is not ermine.runner
//   not-there      no program node, or no value; by id: none, or not the hash given; code given:
//                  not the hash given
//   wrong-form     the program's ermine.type (code given: type) is not the runner's
//                  ermine.runner.takes (both strings, exact); or it names an api
//                  (ermine.program.api; code given: api) the runner's ermine.runner.api is not
//   not-a-runner   the runner's value is no runner here (no start)
//   no-permission  the policy asked { who: the scope open, op: "start", target the runner },
//                  then { op: "read", target the program's value } (not for code given): no, or
//                  pending
//   taken          a process at, above or under at (processes')
// else processes' start under a scope of its own (where it runs: under the runner's offer's, one
// this den offers; else the den's owner), with ermine.type ermine.process, ermine.process.runner
// { id, at },
// .program { id, at?, hash? } (hash: of its value; none: a live value), .den { id, at }; the code
// read once now; at the first pulse, a one-shot effect, the process's scope open: start(code,
// { box, places, process: { id, at, args, cwd }, scheduler, table, scope, den }). a handle: held,
// its stop its stopper's teardown (landing after the stop: called then); a throw, a rejected
// promise: the status. a start made outside a run (an ask's too) asks for a
// pulse (setup.schedule; none: queueMicrotask, as ermine/api's), so a start from a DOM callback runs
// with nothing else pulsing
// load(runner, program, { by?, box? }): the program made live on the runner with no process: its
// load(code, start), start by's facts (by: a running process of this den's; none: the den's own,
// let go at its close), the scope open (none: by's). checked as start is, in its order (no path, so never taken; the
// policy asked start on the runner, read on the program); a runner with no load: not-a-runner.
// what load throws: thrown. { live, release }: live held by by, let go (live[Symbol.dispose], if
// it has one) at release or at by's scope's teardown, after its handle's, newest first. by no running
// process: PlacesError nothing-there. made outside a run: a pulse asked for. no process: what
// live does is its caller's, a call of it a run of the caller's memo or effect, so its cost is
// that run's time and its throw that run's error and status (ermine/api's runs)
// stop(p, reason?): asked { op: "stop", target p's node } (refused: still running); the reason
// told, then where it runs torn down, in the scheduler's order (what is under a scope first,
// newest first, then its teardowns, newest first): its offers and what runs on them
// ("runner-stopped"), its handle's stop(reason) (ermine/api's: its teardowns told reason), then its
// own scope: what its program made, its program's teardowns, its loads, the row out, the node.
// twice, or not this den's: nothing (the den's own: here's). the reason is not written
// a process gone with what it runs under, not told: its reason from what is going: the den
// closing (or its owner torn down), its pending reason; its runner's offer, the offer's why (none:
// "runner-stopped"); else none
import { CborError } from "@ermine/encoding/cbor"
import type { Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/encoding/hash"
import { type Address, type Box, inside } from "@ermine/boxes"
import type { Id, Path, Places } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeBase } from "@ermine/places/header"
import type { Inside, Process, Processes } from "@ermine/processes/start"
import type { Answer, Target } from "@ermine/protect"
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
	REASONS,
	type Running,
	STOPPED,
	TYPE,
} from "./common.ts"
import type { Den } from "./dens.ts"
import { API, runnerOf, TAKES } from "./offers.ts"
import { refuse } from "./policy.ts"

ours.add(import.meta.url)

// a process's attributes, as start writes them
export const PROGRAM_API = "ermine.program.api"
export const RUNNER = "ermine.process.runner"
export const PROGRAM = "ermine.process.program"
export const DEN = "ermine.process.den"

// what a runner gives back; @ermine/programs/start's Handle is one
export type Handle = { readonly stop: (reason?: unknown) => unknown }
// what a runner is handed: the start's facts (@ermine/programs/start's Start, and the den). a
// load's: its by's
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
	readonly den: Den
}
// a live runner: start a process's program; load, a program live with no process; api, what its
// programs get (the runner's, over context.createAPI(start) for ermine/api's)
export type Runner = {
	readonly start: (code: unknown, start: Start) => Handle | PromiseLike<Handle> | void
	readonly load?: (code: unknown, start: Start) => unknown
	readonly api?: (start: Start) => unknown
}
// what a runner node may hold: a Runner, or a function, its start (with its own load and api, if
// it has them); @ermine/programs/start's Runner is one (realms.run, createDlopen's), ermine/api's run
// both
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
export type Stopped = { readonly refused: "stopped" }
export type Taken = { readonly refused: "taken"; readonly at: Path }
export type NoPermission = {
	readonly refused: "no-permission"
	readonly op: "start" | "read" | "stop"
	readonly answer: { readonly answer: "no"; readonly reason: string } | {
		readonly answer: "pending"
	}
}
export type Refused =
	| Stopped
	| Taken
	| NoPermission
	| { readonly refused: "not-a-runner"; readonly runner: Path }
	// program: its path (an address given) or its id (a Program given)
	| { readonly refused: "not-there"; readonly program: Path | Id }
	| { readonly refused: "not-there"; readonly process: Id }
	| {
		readonly refused: "wrong-form"
		// each field only when a string
		readonly program: { readonly type?: string; readonly api?: string }
		readonly runner: { readonly takes?: string; readonly api?: string }
	}
export type Options = {
	args?: readonly string[]
	cwd?: Address
	// where it runs, and where program and at are from; none: the den's places
	box?: Box
	// ermine.process.pin, as processes' start writes it
	pin?: unknown
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// core candidate (@ermine/encoding): hex of a value's hash; no encoding: undefined (programs' hashOf)
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

export type Deps = {
	readonly processes: Processes
	readonly permit: (who: unknown, op: string, target: Target, remote: boolean) => Answer
}

export function createStart(c: Ctx, { processes, permit }: Deps) {
	const { s, table, home, changed, later } = c

	// the node at an address from a box's root, untracked
	const resolve = (where: Box, address: Address): { path: Path; id: Id | undefined } => {
		const path = inside(address)
		return { path, id: where.places.peep(() => get(where.places, path)) }
	}

	const attributesOf = (id: Id) => {
		const v = table.get("attributes", id)?.value
		return isMap(v) ? v : {}
	}

	// what an owner's runner is handed: its facts
	const startOf = (o: Owner): Start => ({
		box: o.box,
		places: o.box.places,
		process: { id: o.id, at: o.at, args: o.args, cwd: o.cwd },
		scheduler: s,
		table,
		scope: o.scope,
		den: c.den,
	})

	// start's checks in order, up to taken (processes'): the runner, the program read once, the
	// policy asked. load: a runner with no load is not-a-runner
	type Checked = {
		readonly runner: { readonly id: Id; readonly path: Path }
		readonly program: { readonly id: Id; readonly at?: Path }
		readonly code: unknown
		readonly digest?: string
		readonly live: Runner
	}
	function check(
		who: unknown,
		remote: boolean,
		runner: Address,
		program: Address | Program,
		where: Box,
		load: boolean,
	): Checked | Refused {
		if (c.closed) return STOPPED
		const r = resolve(home, runner)
		const notRunner = { refused: "not-a-runner", runner: r.path } as const
		if (r.id === undefined) return notRunner
		const rattrs = attributesOf(r.id)
		if (rattrs[ATTRIBUTE] !== TYPE.runners) return notRunner
		// the program: its node (or carried code), its form, and its code read once
		let id: Id, path: Path | undefined, code: unknown, digest: string | undefined
		let type: unknown, api: unknown
		const carried = !isAddress(program) && program.code !== undefined
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
		} else if (carried) {
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
		const allowed = permit(who, "start", { id: r.id, path: [...r.path] }, remote)
		if (allowed.answer !== "yes") return refuse("start", allowed)
		if (!carried) {
			const target: Target = path === undefined
				? { part: "value", id }
				: { part: "value", id, path: [...path] }
			const read = permit(who, "read", target, remote)
			if (read.answer !== "yes") return refuse("read", read)
		}
		return {
			runner: { id: r.id, path: r.path },
			program: { id, ...(path === undefined ? {} : { at: path }) },
			code,
			...(digest === undefined ? {} : { digest }),
			live,
		}
	}

	// start's checks, then processes' start. who: the policy's; remote: another den's ask
	function begin(
		who: unknown,
		remote: boolean,
		runner: Address,
		program: Address | Program,
		address: Address,
		options: Options,
	): Running | Refused {
		const where = options.box ?? home
		const ck = check(who, remote, runner, program, where, false)
		if ("refused" in ck) return ck
		const { live, code, digest } = ck
		const on = c.offers.get(ck.runner.id)
		const attrs = {
			[ATTRIBUTE]: TYPE.process,
			[RUNNER]: { id: ck.runner.id, at: ck.runner.path },
			[PROGRAM]: digest === undefined ? ck.program : { ...ck.program, hash: digest },
			[DEN]: { id: c.node, at: c.mine.at },
		}
		// where it runs: a scope under its runner's offer (none: the owner) holding, newest first,
		// what it offers, its handle's stop, then its own scope
		const under = c.createScope({ on: ck.runner.id }, on?.scope ?? c.owner)
		let p: Running | undefined
		let made: Process | { refused: "taken"; at: Path }
		try {
			made = processes.start(
				where,
				address,
				{
					args: options.args,
					cwd: options.cwd,
					pin: options.pin,
					attributes: attrs,
					under,
				},
				(inside) => {
					// its handle's stop: the teardown of a scope beside its own, newer, so it goes
					// before it (what its program made told the reason) and after what it offers
					// (newer still). its writes the process's: its info
					const stopper = c.createScope({ ...inside.scope.info }, under)
					const q: Running = {
						id: inside.id,
						at: inside.at,
						scope: inside.scope,
						under,
						stopper,
						box: inside.box,
						args: inside.args,
						cwd: inside.cwd,
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
							run(q, inside, live, code)
						} finally {
							s.teardown(first)
						}
					})
					inside.give(first, { run: true })
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
		return p!
	}

	// the runner's start called, the process's scope open. a handle at once: held; a throw or a
	// promise: a computer holding the outcome, its status the node's
	function run(p: Running, inner: Inside, live: Runner, code: unknown) {
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
		const c = s.runWithScope(p.scope, () =>
			s.createComputer(() => {
				if ("error" in o) throw o.error
				return o.value
			}, () => {}))
		inner.give(c)
	}

	// a handle given: held, its stop its stopper's teardown; gone already, stopped now with its
	// reason. no stop in it: nothing
	function hold(p: Running, h: unknown) {
		if (!isMap(h) || typeof h.stop !== "function") return
		if (p.stopper.state !== "alive") (h as Handle).stop(reasonOf(p))
		else p.handle = h as Handle
	}

	// why a process goes: told by a stop; else the den closing (or its owner torn down), its
	// pending reason; else its runner's offer going, the offer's why (none: "runner-stopped")
	function reasonOf(p: Running): unknown {
		if (p.told) return p.reason
		if (c.closed || c.owner.state !== "alive") return c.pending
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

	// a process stopped with a reason: told, then where it runs torn down
	function halt(p: Running, why: unknown) {
		if (p.ended) return
		p.told = true
		p.reason = why
		s.teardown(p.under)
	}

	function start(
		runner: Address,
		program: Address | Program,
		at: Address,
		options: Options = {},
	): Process | Refused {
		const r = begin(createChangeBase(s), false, runner, program, at, options)
		return "refused" in r ? r : r.process!
	}

	function load(
		runner: Address,
		program: Address | Program,
		options: { by?: Process | Id; box?: Box } = {},
	): Loaded | Refused {
		if (c.closed) return STOPPED
		const by = c.ownerOf(options.by)
		const ck = check(createChangeBase(s), false, runner, program, options.box ?? by.box, true)
		if ("refused" in ck) return ck
		const start = startOf(by)
		const f = () => ck.live.load!(ck.code, start)
		const live = s.getCurrentScope() !== undefined ? f() : s.runWithScope(by.scope, f)
		const h: Held = { live, released: false }
		by.loads.push(h)
		later()
		return { live, release: () => drop(by, h) }
	}

	function stop(x: Process | Id, reason?: unknown): NoPermission | undefined {
		const id = typeof x === "object" ? x.id : x
		const p = c.byId.get(id)
		if (p === undefined || p.ended) return
		const a = permit(createChangeBase(s), "stop", { id, path: [...p.at] }, false)
		if (a.answer !== "yes") return refuse("stop", a)
		halt(p, reason)
	}
	return { start, load, stop, begin, halt, startOf }
}
