// run: a program on a runner, as a process. what a run asks of the program and the runner (its
// form, its hash), then the process: run at a path, loaded live with no process, stopped, and the
// reasons it is stopped with. which question: how a program runs on a runner
//
// what a runner is handed is a Start: the process context's facts (@ermine/processes'
// ProcessContext: { scope, folder, at, args, process }), not its functions (its host's to make);
// the scheduler and table are the runner's own, from whoever made it. what the program gets is
// the runner's: this makes no api (api? says which one it wants). its limits are the runner's too:
// nothing here counts
// run(runner, program, at, { args, folder, places, pin }): runner from places' root, or carried ({ id,
// live }: its live form in hand, nothing of its node read); program an address from where's root
// (where: places, else the home) or { id, hash?, type?, api?, code?, build? }. refused, nothing made,
// the first that holds:
//   not-a-runner   nothing at runner, or its ermine.type is not ermine.runner
//   not-there      no program node, or no value; by id: none, or not the hash given; code given:
//                  not the hash given
//   wrong-form     the program's type does not fit the runner's takes (TAKES); or it names an
//                  api (ermine.program.api; code given: api) the runner's ermine.runner.api is not
//   not-a-runner   the runner's value (carried: its live) is no runner here (no start)
//   taken          a process exactly at at (processes')
// a carried runner is run as the caller holds it: its form is the caller's to have matched
// (programs' satisfy), so only not-there, not-a-runner and taken are asked
// the program's type: by an address, @ermine/types' typeOf (its ermine.type, else its name's
// extension, by the nearest ermine/types from its folder); by id, its ermine.type; code given, type.
// it fits when the takes (a list; a string, a list of one) holds it or a type it conforms to, by
// the nearest ermine/types from the program's folder (none: from where's root). read untracked
// else processes' start under a scope of its own (under the runner's offer's, when offered here;
// else setup.scope), with ermine.type ermine.process, ermine.process.runner { id, at } (carried:
// { id }), .program { id, at?, hash? } (hash: of its value; none: a live value, or built); the
// code read once now; at the first pulse, a one-shot effect, the process's scope open:
// start(code, Start). build given (carried, no code): the code is what build gives, read in that
// effect's run, tracked: PENDING, the process pending; a throw, its status; start called once it
// gives one. a handle: held, its stop its stopper's teardown (landing after the stop: called
// then); a throw, a rejected promise: the status. a run made outside a pulse asks for one
// (setup.schedule)
// load(runner, program, { by, places?, chain? }): the program made live on the runner with no
// process, shared: one load per key, the program's id, its value's hash (none: the value itself),
// the runner's id and live value, and chain (the keys of what else loads it, programs'; none:
// none). checked as run is (no path, so never taken; a program's build is run's alone, not read
// here); a runner with no load: not-a-runner. a key with no load standing: the runner's
// load(code, start), start by's facts and a scope of the load's own (under setup.scope), open for
// the call; what load throws: thrown, the scope gone.
// { live, release }: one hold by by. release lets go of it, as by's scope's teardown does (after
// its handle's, newest first); the last hold let go, or setup.scope torn down: the load's scope
// torn down, its live form's [Symbol.dispose] (if it has one) called before what its load made goes
// stop(p, reason?): the reason told, then where it runs torn down, in the scheduler's order: its
// offers and what runs on them ("runner-stopped"), its handle's stop(reason), then its own scope.
// twice, or none run here: nothing
// a process gone with what it runs under, not told: its runner's offer going, the offer's why
// (none: "runner-stopped"); else none
import { CborError, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/formats/hash"
import type { Id, Path, Places } from "@ermine/core/places"
import { get } from "@ermine/core/places/lib"
import { conformance, typeOf, typesAt } from "@ermine/types"
import type { ProcessContext } from "@ermine/processes"
import { type Address, type Inside, inside, type Process } from "@ermine/processes/start"
import { isPromise } from "@ermine/core/scheduler/helpers"
import {
	ATTRIBUTE,
	type Ctx,
	dispose,
	drop,
	type Held,
	holder,
	isMap,
	type Load,
	ours,
	type Owner,
	type Place,
	type Running,
	TYPE,
} from "./common.ts"
import { API, runnerOf, TAKES, takesOf } from "./offers.ts"

ours.add(import.meta.url)

// a process's attributes, as run writes them
export const PROGRAM_API = "ermine.program.api"
export const RUNNER = "ermine.process.runner"
export const PROGRAM = "ermine.process.program"

export const REASONS = { withdrawn: "withdrawn", runner: "runner-stopped" } as const

// what a runner gives back; @ermine/programs/start's Handle is one
export type Handle = { readonly stop: (reason?: unknown) => unknown }
// what a runner is handed: the process context's facts, its process always there (a load's: its
// by's, its scope the load's own)
export type Start = Pick<ProcessContext, "scope" | "folder" | "at" | "args"> & {
	readonly process: Process
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
// a runner carried: its node's id, and its live form in hand
export type Carried = { readonly id: Id; readonly live: Runnable }
// a load: the live form, and its letting go now (else at its holder's stop)
export type Loaded = { readonly live: unknown; readonly release: () => void }
// a program by id (its hash, when given, must be its value's), or carried (code: run as it is;
// build: run's, its code made in the process's first run, tracked)
export type Program = {
	readonly id: Id
	readonly hash?: string
	readonly type?: string
	readonly api?: string
	readonly code?: unknown
	readonly build?: () => unknown
}
export type Refused =
	| { readonly refused: "taken"; readonly at: Path }
	// runner: its path (an address given) or its id (carried)
	| { readonly refused: "not-a-runner"; readonly runner: Path | Id }
	// program: its path (an address given) or its id (a Program given)
	| { readonly refused: "not-there"; readonly program: Path | Id }
	| {
		readonly refused: "wrong-form"
		// each field only when a string
		readonly program: { readonly type?: string; readonly api?: string }
		// takes: the runner's, as a list; only when it takes any
		readonly runner: { readonly takes?: readonly string[]; readonly api?: string }
	}
export type Options = {
	args?: readonly string[]
	folder?: Address
	// where it runs, and where program and at are from; none: places
	places?: Places
	// ermine.process.pin, as processes' start writes it
	pin?: unknown
}
export type LoadOptions = {
	// who holds it
	by: Place
	// where the program is from; none: by's places
	places?: Places
	// the keys of what else loads it (programs' chain), part of the load's key
	chain?: readonly string[]
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

// a value's tag in a key: an object or a function, a number of its own; anything else, itself
const tags = new WeakMap<object, number>()
let tagged = 0
function tag(x: unknown): string {
	if ((typeof x === "object" && x !== null) || typeof x === "function") {
		let n = tags.get(x)
		if (n === undefined) tags.set(x, n = ++tagged)
		return `#${n}`
	}
	return typeof x === "string" ? JSON.stringify(x) : String(x)
}

// the fields that are strings
function strings<K extends string>(o: Record<K, unknown>): Partial<Record<K, string>> {
	const out: Partial<Record<K, string>> = {}
	for (const k in o) if (typeof o[k] === "string") out[k] = o[k] as string
	return out
}

export function createRun(c: Ctx) {
	const { s, table, home, processes, changed, later } = c

	// the node at an address from where's root, untracked
	const resolve = (where: Places, address: Address): { path: Path; id: Id | undefined } => {
		const path = inside(address)
		return { path, id: where.peep(() => get(where, path)) }
	}

	const attributesOf = (id: Id) => {
		const v = table.get("attributes", id)?.value
		return isMap(v) ? v : {}
	}

	// what an owner's runner is handed: its facts, and the scope open for the call (none: its own).
	// its process: the one run made; none yet, or a place's: its facts as one
	const startOf = (o: Owner, scope = o.scope): Start => ({
		scope,
		folder: o.folder,
		at: o.at,
		args: o.args,
		process: (o as Partial<Running>).process ??
			{ id: o.id, at: o.at, folder: o.folder, scope: o.scope },
	})

	// a program's type at its place in where: its ermine.type, else its name's (@ermine/types'
	// typeOf), untracked
	const typeAt = (where: Places, id: Id, at: Path) => where.peep(() => typeOf(where, { id, at }))

	// whether a type fits what a runner takes: one is it, or one it conforms to, by the nearest
	// ermine/types from a folder in where, untracked
	function fits(where: Places, from: Path, type: string, takes: readonly string[]): boolean {
		if (takes.includes(type)) return true
		const places = where
		return places.peep(() => conformance(places, typesAt(places, from), type).all)
			.some((t) => takes.includes(t))
	}

	// the checks in order, up to taken (processes'): the runner, the program read once. load: a
	// runner with no load is not-a-runner. value: the runner node's, as read (carried: its live).
	// build: run's, a carried program's code to come
	type Checked = {
		readonly runner: { readonly id: Id; readonly path?: Path; readonly value: unknown }
		readonly program: { readonly id: Id; readonly at?: Path }
		readonly code: unknown
		readonly digest?: string
		readonly build?: () => unknown
		readonly live: Runner
	}
	function check(
		runner: Address | Carried,
		program: Address | Program,
		where: Places,
		load: boolean,
	): Checked | Refused {
		// the runner: its node, looked up and typed; carried, its id alone
		const carried = !isAddress(runner)
		const r = carried ? { id: runner.id, path: undefined } : resolve(home, runner)
		const notRunner = { refused: "not-a-runner", runner: r.path ?? r.id! } as const
		if (r.id === undefined) return notRunner
		const rattrs = carried ? {} : attributesOf(r.id)
		if (!carried && rattrs[ATTRIBUTE] !== TYPE.runners) return notRunner
		// the program: its node (or carried code), its form, and its code read once
		let id: Id, path: Path | undefined, code: unknown, digest: string | undefined
		let type: unknown, api: unknown, build: (() => unknown) | undefined
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
			type = typeAt(where, id, path)
			api = attributesOf(id)[PROGRAM_API]
		} else if (program.code !== undefined || (!load && program.build !== undefined)) {
			id = typeof program.id === "string" ? program.id : ""
			code = program.code
			build = program.code === undefined ? program.build : undefined
			digest = build === undefined ? hashOf(code) : undefined
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
		// its type fits from its folder; by id, or carried, from where's root. a carried runner's
		// form is its caller's
		const takes = takesOf(rattrs[TAKES]), given = rattrs[API]
		const from = path === undefined ? [] : path.slice(0, -1)
		if (
			!carried && (
				typeof type !== "string" || !fits(where, from, type, takes) ||
				(api !== undefined && api !== given)
			)
		) {
			return {
				refused: "wrong-form",
				program: strings({ type, api }),
				runner: { ...(takes.length ? { takes } : {}), ...strings({ api: given }) },
			}
		}
		const value = carried ? runner.live : table.get("value", r.id)?.value
		const live = runnerOf(value)
		if (live === undefined || (load && live.load === undefined)) return notRunner
		return {
			runner: { id: r.id, ...(r.path === undefined ? {} : { path: r.path }), value },
			program: { id, ...(path === undefined ? {} : { at: path }) },
			code,
			...(digest === undefined ? {} : { digest }),
			...(build === undefined ? {} : { build }),
			live,
		}
	}

	function run(
		runner: Address | Carried,
		program: Address | Program,
		address: Address,
		options: Options = {},
	): Process | Refused {
		const where = options.places ?? home
		const ck = check(runner, program, where, false)
		if ("refused" in ck) return ck
		const { live, code, digest, build } = ck
		const on = c.offers.get(ck.runner.id)
		const attrs = {
			[ATTRIBUTE]: TYPE.process,
			[RUNNER]: ck.runner.path === undefined
				? { id: ck.runner.id }
				: { id: ck.runner.id, at: ck.runner.path },
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
				{
					args: options.args,
					folder: options.folder,
					pin: options.pin,
					attributes: attrs,
					under,
				},
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
						places: where,
						args: inner.args,
						folder: inner.folder,
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
					// core candidate (scheduler): an effect that acts once and goes. built: its read
					// makes the code, the process pending while it is
					const first = s.createEffect(() => build === undefined ? true : build(), (made) => {
						try {
							begin(q, inner, live, build === undefined ? code : made)
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
		runner: Address | Carried,
		program: Address | Program,
		options: LoadOptions,
	): Loaded | Refused {
		const by = c.ownerOf(options.by)
		const ck = check(runner, program, options.places ?? by.places, true)
		if ("refused" in ck) return ck
		const key = JSON.stringify([
			String(ck.program.id),
			ck.digest ?? tag(ck.code),
			String(ck.runner.id),
			tag(ck.runner.value),
			...(options.chain ?? []),
		])
		const l = c.loads.get(key) ?? make(key, ck, by)
		const h: Held = { load: l, released: false }
		l.holds.add(h)
		by.loads.push(h)
		later()
		return { live: l.live, release: () => drop(s, by, h) }
	}

	// a load made: its runner's load called, by's facts and the load's own scope open. its going
	// (the last hold let go, or setup.scope torn down): out of the standing ones, its live form
	// disposed, before what its load made goes
	function make(key: string, ck: Checked, by: Owner): Load {
		const scope = c.createScope({ load: ck.program.id, on: ck.runner.id }, c.scope)
		let live: unknown
		try {
			const start = startOf(by, scope)
			live = s.runWithScope(scope, () => ck.live.load!(ck.code, start))
		} catch (e) {
			s.teardown(scope)
			throw e
		}
		const l: Load = { key, live, scope, holds: new Set(), gone: false }
		c.loads.set(key, l)
		s.registerTeardown(scope, () => unload(l))
		return l
	}

	function unload(l: Load) {
		if (l.gone) return
		l.gone = true
		if (c.loads.get(l.key) === l) c.loads.delete(l.key)
		dispose(l.live)
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
