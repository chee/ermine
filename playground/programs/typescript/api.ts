// the process api with programs': ermine/api's, each process's api given start, stop and openwith,
// and the host runners run and runner. ermine/api's stop is the programs' (asked when used)
//
//   const apis = createProcessAPIs({ scheduler, table, commit, host, programs: () => programs })
//   const programs = createPrograms({ ..., createProcessAPI: apis.createProcessAPI })
//   put("value", RUN, apis.run)                       // a host runner for javascript programs
//
// what a program gets beside ermine/api's:
//   start(program, at, { box?, args?, cwd?, onwhynot? })   program: a name or a way;
//                        stopped with this one; no way: refused no-way
//   stop(p)              a process this one started
//   openwith(x, { onwhynot }?)   every way to open x, nearest first (a generator)
//
// run: a javascript program's value (or module's default) called with the api, once, untracked;
// its return the process's value, written to the process's node with its scope open. runner(show):
// the same, show(value, api) making setup's return what is kept (a view made real, say)
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
} from "@ermine/api"
import { inside } from "@ermine/boxes"
import { type Id, type Path, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import type { Context, Process } from "@ermine/processes/start"
import { openwith as openwithIn, satisfy, type Way, type Whynot } from "./programs.ts"
import type { Programs, Runner } from "./start.ts"

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
	// made after this (createPrograms takes createProcessAPI): asked when used
	programs: () => Programs
}

export type ProcessAPIs = Omit<Bases, "createProcessAPI"> & {
	createProcessAPI: (ctx: Context) => API
	// a host runner for a javascript program: its value (or module's default) called with the api,
	// once, untracked; its return the process's value
	run: Runner
	// the same, show(value, api) making setup's return what is kept (a view made real, say), with
	// the process's scope open; its return the process's value
	runner: (show?: (value: unknown, api: API) => unknown) => Runner
}

const isNode = (x: Target): x is Node => typeof x === "object" && !Array.isArray(x)

export function createProcessAPIs(setup: Setup): ProcessAPIs {
	const { programs, ...rest } = setup
	const { scheduler: s, table, commit } = setup
	const apis = createBase({ ...rest, stop: (p) => programs().stop(p) })
	// each api's process
	const contexts = new WeakMap<object, Context>()

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
			if (!("refused" in p)) s.runWithScope(scope, () => base.teardown((w) => apis.stop(p, w)))
			later()
			return p
		}

		function openwith(
			x: Target,
			options: { onwhynot?: (why: Whynot) => void } = {},
		): Generator<Way, void> {
			return openwithIn(places, idOf(x), cwd, options)
		}

		const api: API = { ...base, start, stop: (p) => apis.stop(p, "ended"), openwith }
		contexts.set(api, ctx)
		return api
	}

	const runner = (show?: (value: unknown, api: API) => unknown): Runner => (code, api) => {
		const f = typeof code === "function" ? code : (code as { default?: unknown } | null)?.default
		if (typeof f !== "function") throw new TypeError("not a program: no function, no default")
		const ctx = contexts.get(api as object)
		const made = f(api)
		const value = show === undefined ? made : show(made, api as API)
		if (ctx !== undefined && value !== undefined) {
			s.runWithScope(ctx.scope, () => write(ctx.process.id, value))
			later()
		}
		return { stop: () => {} }
	}

	return { ...apis, createProcessAPI, run: runner(), runner }
}
