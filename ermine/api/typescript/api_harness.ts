// the process api (api.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. its own world, lasting for the process: a scheduler, a table, paths, scope nodes
// and places at the root "R" (asked [processes("R"), children]), the host's scope [["actor","test"]].
// after every request, what the api asked to run later (its pulse) is run: so a write's readers
// have run by the next request. new ids are "n1", "n2", … in the order made; a process's id is
// "proc:<name>". a value is plain JSON; a node is { path, part } or { id, part }
//
// processes here are started by the harness, not by programs (start, openwith and box need
// programs' and boxes' C, not there yet: the TypeScript tests have them): a scope under the
// programs' own, its node, its row, the api made, and its program run as setup, untracked
//
// the world (first, or none: a plain one):
// { op: "world", deny?, presence?, overlay?, who?, uuid? } → {}   deny: [{ op, path }]: a policy
//    saying no to an ask with that op whose target's path (names joined by "/") is path; presence:
//    a presence world on the host's scope, its clock 0 (now moves it); overlay: places over a patch
//    overlay; who: setup.who; uuid: no setup.id, new ids the api's own (uuidv7)
// { op: "kids", id, value }                → {}   the children entry there, replaced (a table event)
// { op: "put", part, id, value }           → {}   an entry there, replaced
// { op: "saved", part, id }                → { value? }   as the table has it
// { op: "change", part, id }               → { actor?, process?, caller? }   its latest change's:
//    the first of each key in its pairs, however the header nests them (an "owner" pair holding
//    the pairs of the scope above), the actor the header's own when it has one
// { op: "id", path }                       → { id? }   lib's get, from "R"
// { op: "uuids", paths }                   → { v7, ordered }   the id at each path (lib's get): each
//    a uuidv7 (lowercase, 8-4-4-4-12, version 7, variant 10); each after the one before (as text)
// { op: "now", t }                         → {}   the presence clock, ms
// processes:
// { op: "start", name, at, cwd?, args?, program } → { id }   program: steps, run as its setup
// { op: "stop", name, why? }               → {}   the api's stop (programs' stop: the row out, the
//    scope torn down), its teardowns told why (none: "ended")
// { op: "do", process, call, as? }         → { value }   an api function called from outside (no
//    scope open), as the program would: call [fn, ...args]; as: the result named in that
//    process's names (a program's steps name theirs the same way)
// { op: "log", name }                      → { values }   what effects, teardowns and watches put
// { op: "events" }                         → { events }   the table events since last asked, then
//    forgotten: [part, id, "put" | "gone"] each, in order ("gone": nothing there after it; an id
//    not a string: null)
// { op: "pulse" }                          → {}
//
// a program is a list of steps, each { do: [fn, ...args], as? }. "$x" anywhere in an arg is the
// name x (a step's result, or a method's arguments $0, $1, …); anything else is as it is. fn is an api
// function, or one of these, each made with what the api gives:
//   ["memo", name, options, expr]  memo(name, () => expr), options as memo's ({ equal? } with no
//                                  equal: a JSON compare is "json"). in a memo's or effect's
//                                  expr, made again by each of its runs: the one there kept, with
//                                  this expr (api.ts: the same id and node; a run that fails, or
//                                  does not make it, as api.ts says); the same for effect, early
//   ["effect", name, expr, log]    effect(name, () => expr, (v) => log v)
//   ["early", name, expr, log]     early(name, () => expr, (v) => log v)
//   ["log", log, expr]             expr's value put in log, and given back (in a memo: a run counted)
//   ["count", name, log]           how many values name's log holds now, put in log
//   ["method", path, steps, expr?] method(path, (...args) => steps run, $0… the args; expr given back)
//   ["teardown", log]              teardown((why) => log why)
//   ["watch", target, log]         watch(target, (w) => log w.patches)
//   ["ref", path, value]           ref(path, () => value)
//   ["if", test, then, else?]      then's value when test's is true, else else's (none: undefined)
//   ["throw", text]                throws an error of message text
// an expr is a call [fn, ...args], or ["all", expr, …] (a list of each), or "$x"
// errors: a PlacesError { error: code }; a Refusal { error: "refused" }; a SendError
// { error: "not-a-method" }; PENDING { error: "pending" }; else { error: text }
import createEntry from "@ermine/node/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key, type Table } from "@ermine/table"
import { children, createPlaces, type Places, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { Refusal } from "@ermine/places/guard"
import { addProcess, processes, removeProcess } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import type { Process, Programs } from "@ermine/programs/start"
import { no, type Policy, yes } from "@ermine/protect"
import type { World } from "@ermine/presence"
import { createOverlay, type Overlay } from "@ermine/patch-nodes"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { type API, createProcessAPIs, type ProcessAPIs, SendError } from "./api.ts"

type Env = Map<string, unknown>
type Running = { api: API; env: Env; process: Process }

type Made = {
	s: ReturnType<typeof createScheduler>
	table: Table
	places: Places
	apis: ProcessAPIs
	host: Scope
	above: Scope
	scopes: ReturnType<typeof createScopeNodes>
	clock: { now: number }
	running: Map<string, Running>
	logs: Map<string, unknown[]>
	later: (() => void)[]
	events: unknown[][]
}

let w: Made | undefined

function make(o: Request = {}): Made {
	const s = createScheduler()
	const events: unknown[][] = []
	const table: Table = createTable((part, id) => {
		events.push([part, typeof id === "string" ? id : null, table.get(part, id) ? "put" : "gone"])
		overlay ? overlay.onTableChange(part as Key, id) : places.onTableChange(part as Key, id)
	})
	const overlay: Overlay | undefined = o.overlay ? createOverlay(table, () => places) : undefined
	const places: Places = createPlaces({
		root: "R",
		table: overlay ?? table,
		paths: createPaths<unknown>(),
		scheduler: s,
		contributors: [processes("R"), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const commit = (changed: Parameters<Places["commit"]>[0]) =>
		overlay ? overlay.commit(changed) : places.commit(changed)
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope([["actor", "test"]])
	const above = s.createScope([["role", "programs"]], host)
	const clock = { now: 0 }
	const later: (() => void)[] = []
	const deny = (o.deny ?? []) as { op: string; path: string }[]
	const may: Policy | undefined = o.deny
		? (ask) =>
			deny.some((d) => d.op === ask.op && d.path === ask.target.path?.join("/"))
				? no("denied")
				: yes
		: undefined
	const presence: World | undefined = o.presence
		? {
			table,
			places: { commit, readValue: places.readValue },
			scheduler: s,
			scope: host,
			now: () => clock.now,
		}
		: undefined
	let n = 0
	const running = new Map<string, Running>()
	// programs' stop, as the harness starts: the row out, the scope torn down
	const programs: Programs = {
		start: () => {
			throw new Error("start: not in this suite")
		},
		stop: (p) => {
			if (p.scope.state !== "alive") return
			s.runWithScope(p.scope, () => {
				try {
					places.commit(removeProcess(table, "R", p.at, createChangeHeader(s)))
				} catch (e) {
					if (!(e instanceof PlacesError)) throw e
				}
			})
			s.teardown(p.scope)
		},
	}
	const apis = createProcessAPIs({
		scheduler: s,
		table,
		commit,
		host: { places, table, scheduler: s, commit },
		programs: () => programs,
		may,
		presence,
		who: o.who,
		overlay,
		schedule: (f) => void later.push(f),
		id: o.uuid ? undefined : () => `n${++n}`,
	})
	return {
		s,
		table,
		places,
		apis,
		host,
		above,
		scopes,
		clock,
		running,
		logs: new Map(),
		later,
		events,
	}
}

const world = () => (w ??= make())
const hosted = <T>(f: () => T) => world().s.runWithScope(world().host, f)

function log(name: string, v: unknown) {
	const logs = world().logs
	if (!logs.has(name)) logs.set(name, [])
	logs.get(name)!.push(v === undefined ? null : v)
}

// "$x": the name x, anywhere in an argument (inside lists and maps too); anything else as it is
function arg(env: Env, a: unknown): unknown {
	if (typeof a === "string" && a.startsWith("$")) return env.get(a.slice(1))
	if (Array.isArray(a)) return a.map((x) => arg(env, x))
	if (a !== null && typeof a === "object") {
		return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, arg(env, v)]))
	}
	return a
}

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function expr(api: API, env: Env, e: unknown): unknown {
	if (typeof e === "string") return arg(env, e)
	const [fn, ...args] = e as [string, ...unknown[]]
	if (fn === "all") return args.map((x) => expr(api, env, x))
	if (fn === "if") {
		if (expr(api, env, args[0]) === true) return expr(api, env, args[1])
		return args.length > 2 ? expr(api, env, args[2]) : undefined
	}
	if (fn === "throw") throw new Error(args[0] as string)
	return call(api, env, [fn, ...args])
}

function call(api: API, env: Env, [fn, ...raw]: [string, ...unknown[]]): unknown {
	switch (fn) {
		case "memo": {
			const [name, options, e] = raw as [string, Record<string, unknown>, unknown]
			const equal = options?.equal === "json" ? json : undefined
			return api.memo(name, () => expr(api, env, e), { ...options, equal } as never)
		}
		case "effect": {
			const [name, e, to] = raw as [string, unknown, string]
			return api.effect(name, () => expr(api, env, e), (v) => log(to, v))
		}
		case "early": {
			const [name, e, to] = raw as [string, unknown, string]
			return api.early(name, () => expr(api, env, e), (v) => log(to, v))
		}
		case "log": {
			const v = expr(api, env, raw[1])
			log(raw[0] as string, v)
			return v
		}
		case "count":
			return log(raw[1] as string, world().logs.get(raw[0] as string)?.length ?? 0)
		case "method": {
			const [path, steps, back] = raw as [string, unknown[], unknown]
			return api.method(path, (...args: unknown[]) => {
				const inner: Env = new Map(env)
				args.forEach((a, i) => inner.set(String(i), a))
				run(api, inner, steps as Step[])
				return back === undefined ? undefined : expr(api, inner, back)
			})
		}
		case "teardown":
			return api.teardown((why) => log(raw[0] as string, why))
		case "watch":
			return api.watch(arg(env, raw[0]) as never, (x) => log(raw[1] as string, x.patches))
		case "ref":
			return api.ref(raw[0] as string, () => raw[1])
		default: {
			const f = (api as unknown as Record<string, unknown>)[fn]
			if (typeof f !== "function") throw new Error(`no api function ${fn}`)
			return f(...raw.map((a) => arg(env, a)))
		}
	}
}

type Step = { do: [string, ...unknown[]]; as?: string }
function run(api: API, env: Env, steps: readonly Step[]) {
	for (const step of steps) {
		const v = call(api, env, step.do)
		if (step.as !== undefined) env.set(step.as, v)
	}
}

// the api's later calls, run till none is asked for
function drain() {
	const later = world().later
	while (later.length) later.shift()!()
}

function start(r: Request): { id: Id } {
	const m = world()
	const at = r.at as string[]
	const scope = m.s.createScope([["process", at]], m.above)
	const id = m.scopes.give(scope, `proc:${r.name}`)
	m.s.runWithScope(
		scope,
		() => m.places.commit(addProcess(m.table, "R", at, id, createChangeHeader(m.s))),
	)
	const process: Process = { id, at, cwd: (r.cwd as string[]) ?? at.slice(0, -1), scope }
	const api = m.apis.createProcessAPI({
		box: { root: "R", places: m.places },
		places: m.places,
		process: { id, at, args: (r.args as string[]) ?? [], cwd: process.cwd },
		scheduler: m.s,
		table: m.table,
		scope,
	})
	const env: Env = new Map()
	m.running.set(r.name, { api, env, process })
	m.s.runWithScope(scope, () => m.apis.run((a: API) => run(a, env, r.program as Step[]), api))
	return { id }
}

function answer(r: Request): Record<string, unknown> {
	switch (r.op) {
		case "world":
			w = make(r)
			return {}
		case "kids":
			hosted(() =>
				world().table.sub("children", r.id, createEntry(r.value, createChangeHeader(world().s)))
			)
			return {}
		case "put":
			hosted(() =>
				world().table.sub(r.part, r.id, createEntry(r.value, createChangeHeader(world().s)))
			)
			return {}
		case "saved": {
			const v = world().table.get(r.part as Key, r.id)?.value
			return v === undefined ? {} : { value: v }
		}
		case "change": {
			const c = world().table.get(r.part as Key, r.id)?.change
			if (c === undefined) return {}
			const found = new Map<string, unknown>()
			const walk = (pairs: unknown) => {
				if (!Array.isArray(pairs)) return
				for (const pair of pairs) {
					if (!Array.isArray(pair)) continue
					const [k, v] = pair
					if (k === "owner") walk(v)
					else if (!found.has(k)) found.set(k, v)
				}
			}
			walk(c.metadata)
			const actor = c.actor ?? found.get("actor")
			const out: Record<string, unknown> = {}
			if (actor !== undefined) out.actor = actor
			for (const k of ["process", "caller"]) if (found.has(k)) out[k] = found.get(k)
			return out
		}
		case "id": {
			const id = get(world().places, r.path)
			return id === undefined ? {} : { id }
		}
		case "uuids": {
			const ids = (r.paths as string[][]).map((p) => {
				const id = get(world().places, p)
				return typeof id === "string" ? id : undefined
			})
			const v7 = ids.every((id) =>
				id !== undefined &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
			)
			const ordered = ids.every((id, i) => i === 0 || (id ?? "") > (ids[i - 1] ?? ""))
			return { v7, ordered }
		}
		case "now":
			world().clock.now = r.t
			return {}
		case "start":
			return start(r)
		case "stop": {
			const p = world().running.get(r.name)
			if (p === undefined) throw new Error(`no process ${r.name}`)
			world().apis.stop(p.process, r.why)
			return {}
		}
		case "do": {
			const p = world().running.get(r.process)
			if (p === undefined) throw new Error(`no process ${r.process}`)
			const v = call(p.api, p.env, r.call)
			if (r.as !== undefined) p.env.set(r.as, v)
			return v === undefined ? {} : { value: v }
		}
		case "log":
			return { values: world().logs.get(r.name) ?? [] }
		case "events":
			return { events: world().events.splice(0) }
		case "pulse":
			world().s.pulse()
			return {}
		default:
			throw new Error(`no op ${r.op}`)
	}
}

serve((r) => {
	try {
		const out = answer(r)
		drain()
		return out
	} catch (e) {
		drain()
		if (e === PENDING) return { error: "pending" }
		if (e instanceof PlacesError) return { error: e.code }
		if (e instanceof Refusal) return { error: "refused" }
		if (e instanceof SendError) return { error: e.code }
		return { error: String(e) }
	}
})
