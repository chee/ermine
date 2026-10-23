// the process api with programs': ermine/api's, each process's api given start, stop and openwith,
// and the runners run and runner. ermine/api's stop is the programs' (asked when used)
//
//   const apis = createProcessAPIs({ scheduler, table, commit, host, programs: () => programs })
//   const programs = createPrograms({ scheduler, table, places, builds, scopes })
//   put("value", RUN, apis.run)                       // a host runner for javascript programs
//   software.offer(session, "runners", "javascript", attributes, apis.run)   // software's, the same
//   apis.runner({ api: (ctx) => ({ ...apis.createProcessAPI(ctx), offer }) })   // its own api
//
// programs none (a den's world, its starter the den): an api's start throws, and stop only tells
// the process's teardowns, its starter stopping it
//
// what a program gets beside ermine/api's:
//   start(program, at, { box?, args?, cwd?, onwhynot? })   program: a name or a way;
//                        stopped with this one; no way: refused no-way
//   stop(p)              a process this one started
//   openwith(x, { onwhynot }?)   every way to open x, nearest first (a generator)
//
// run: a runner in @ermine/software's shape, { start(code, ctx), api(ctx) }, ctx the start's facts
// (software's Start, @ermine/processes/start's Context): a javascript program's value (or its
// module's default) called with api(ctx), once, untracked; its return the process's value,
// written to the process's node with its scope open.
// runner({ show?, api? }): the same, show(value, api)'s return the process's value instead (a view
// made real, say); api: what the program is given (none: createProcessAPI), a runner's own over
// this one ({ ...createProcessAPI(ctx), more }). its handle's stop(reason): the process's
// teardowns told reason (the starter's stop is under way: it is what calls the handle's)
// a start, and a write of a process's value, asks for one pulse soon (setup.schedule, as the api's)
import createEntry, { type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import {
	type API as Base,
	type BoxNode,
	createProcessAPIs as createBase,
	type Node,
	type ProcessAPIs as Bases,
	type Setup as BaseSetup,
	type Target,
	type Why,
} from "@ermine/api"
import { inside } from "@ermine/boxes"
import { type Id, type Path, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import type { Context, Process } from "@ermine/processes/start"
import type { Scope } from "@ermine/scheduler"
import { openwith as openwithIn, satisfy, type Way, type Whynot } from "./programs.ts"
import type { Handle, Programs, Runner } from "./start.ts"

export * from "@ermine/api"

// what a refusal from start says: start's, or no-way (satisfy yielded none), with the whynots
export type Refusal = { readonly refused: string; readonly why?: readonly Whynot[] }

export type API = Base & {
	start: (
		program: string | Way,
		at: string | Path,
		options?: {
			box?: BoxNode
			args?: readonly string[]
			cwd?: string | Path
			onwhynot?: (why: Whynot) => void
		},
	) => Process | Refusal
	stop: (p: Process) => void
	openwith: (x: Target, options?: { onwhynot?: (why: Whynot) => void }) => Generator<Way, void>
}

export type Setup = Omit<BaseSetup, "stop"> & {
	// made after this (createPrograms takes createProcessAPI): asked when used. none (a den's
	// world): an api's start throws, stop only tells its teardowns
	programs?: () => Programs
}

// what a runner of these gives back: its stop(reason) tells the process's teardowns reason
export type Told = Handle & { readonly stop: (reason?: unknown) => void }

// a runner (software's shape): start given the start's facts, the program given api(ctx)
export type Run = Runner & {
	readonly start: (code: unknown, ctx: Context) => Told
	readonly api: (ctx: Context) => API
}

export type ProcessAPIs = Omit<Bases, "createProcessAPI"> & {
	createProcessAPI: (ctx: Context) => API
	// a runner for a javascript program: its value (or module's default) called with the api, once,
	// untracked; its return the process's value
	run: Run
	// the same, show(value, api) called with the process's scope open, its return the process's
	// value (a view made real, say). api: what the program is given (none: createProcessAPI), a
	// runner's own over this one ({ ...createProcessAPI(ctx), more })
	runner: (
		options?: { show?: (value: unknown, api: API) => unknown; api?: (ctx: Context) => API },
	) => Run
}

const isNode = (x: Target): x is Node => typeof x === "object" && !Array.isArray(x)

export function createProcessAPIs(setup: Setup): ProcessAPIs {
	const { programs: given, ...rest } = setup
	const { scheduler: s, table, commit } = setup
	const apis = createBase({ ...rest, stop: (p) => void given?.().stop(p) })
	// the reason a process's scope goes, told by its handle's stop (or stop with no programs)
	// before it goes; its teardowns told it over ermine/api's why
	const reasons = new WeakMap<Scope, unknown>()

	function programs(): Programs {
		if (given === undefined) throw new Error("no programs here: the host gave none")
		return given()
	}

	// a process's teardowns to be told why: a reason given; none, ermine/api's ("ended" as it goes,
	// or the why its stop was given)
	function tell(scope: Scope, why?: unknown) {
		if (why !== undefined) reasons.set(scope, why)
	}

	// a process stopped, its teardowns told why: programs' stop; none, told only
	function stop(p: Process, why?: Why) {
		if (given === undefined) tell(p.scope, why)
		else apis.stop(p, why)
	}

	// one pulse, soon, however many ask (the api's schedule; none: queueMicrotask)
	let queued = false
	const schedule = setup.schedule ?? queueMicrotask
	function later() {
		if (queued) return
		queued = true
		schedule(() => {
			queued = false
			s.pulse()
		})
	}

	// the process's value: its node's entry made when there is none (the table event tells its
	// readers), else updated and committed; the open scope's change
	function write(id: Id, value: unknown) {
		const header = createChangeHeader(s)
		const entry = table.get("value", id) as Entry<unknown> | undefined
		if (entry === undefined) table.add("value", id, createEntry(value, header) as never)
		else {
			update(entry, [{ path: [], value }], header)
			commit([entry])
		}
	}

	function createProcessAPI(ctx: Context): API {
		const base = apis.createProcessAPI(ctx)
		const { box: home, places, process, scope } = ctx
		const cwd = process.cwd

		// f with a scope open: the one open, else the process's own
		const within = <T>(f: () => T): T =>
			s.getCurrentScope() !== undefined ? f() : s.runWithScope(scope, f)
		// ermine/api's, told the reason the process's scope goes with, when it was given one
		const teardown: Base["teardown"] = (fn) =>
			base.teardown((why) =>
				fn(scope.state !== "alive" && reasons.has(scope) ? reasons.get(scope) as Why : why)
			)
		// a path from the process's place, as the api walks it (open with no value makes nothing)
		const resolve = (p: string | Path): Path => base.open(p).path!
		function idOf(x: Target): Id {
			const n = isNode(x) ? x : base.open(x)
			const id = n.id ?? (n.path ? get(places, n.path) : undefined)
			if (id === undefined) throw new PlacesError("nothing-there", n.path?.join("/"))
			return id
		}

		function start(
			program: string | Way,
			where: string | Path,
			options: {
				box?: BoxNode
				args?: readonly string[]
				cwd?: string | Path
				onwhynot?: (why: Whynot) => void
			} = {},
		): Process | Refusal {
			const target = options.box?.box ?? home
			const path = options.box ? inside(where) : resolve(where)
			const dir = options.cwd === undefined
				? undefined
				: options.box
				? inside(options.cwd)
				: resolve(options.cwd)
			let way: Way | undefined
			const why: Whynot[] = []
			if (typeof program !== "string") way = program
			else {
				const onwhynot = (w: Whynot) => (why.push(w), options.onwhynot?.(w))
				const from = target === home ? cwd : []
				for (const w of satisfy(target.places, program, from, { onwhynot })) {
					way = w
					break
				}
			}
			if (way === undefined) return { refused: "no-way", why }
			const more = {
				...(options.args === undefined ? {} : { args: options.args }),
				...(dir === undefined ? {} : { cwd: dir }),
			}
			const found = way
			const p = within(() => programs().start(target, found, path, more))
			// stopped with this one, told its why
			if (!("refused" in p)) s.runWithScope(scope, () => teardown((w) => stop(p, w)))
			later()
			return p
		}

		function openwith(
			x: Target,
			options: { onwhynot?: (why: Whynot) => void } = {},
		): Generator<Way, void> {
			return openwithIn(places, idOf(x), cwd, options)
		}

		return { ...base, teardown, start, stop: (p) => stop(p, "ended"), openwith }
	}

	const runner: ProcessAPIs["runner"] = (options = {}) => {
		const { show } = options
		const api = options.api ?? createProcessAPI
		const start = (code: unknown, ctx: Context): Told => {
			const f = typeof code === "function"
				? code
				: (code as { default?: unknown } | null)?.default
			if (typeof f !== "function") throw new TypeError("not a program: no function, no default")
			const given = api(ctx)
			const made = f(given)
			const value = show === undefined ? made : show(made, given)
			if (value !== undefined) {
				s.runWithScope(ctx.scope, () => write(ctx.process.id, value))
				later()
			}
			return { stop: (reason?: unknown) => tell(ctx.scope, reason) }
		}
		return { start, api }
	}

	return { ...apis, createProcessAPI, stop, run: runner(), runner }
}
