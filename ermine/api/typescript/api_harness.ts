// the process api (api.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. one world per run: a scheduler, a table, places at the root "R", host scope
// {"actor":"test"}. after every request the api's pulse runs, so readers have run by the next.
// new ids "n1", "n2", … in order; a process's id "proc:<name>".
// node: { path, part } | { id, part }.
// processes are started by the harness (start, openwith, box need C not there yet).
//
// world (first, or a plain one):
// { op: "world", deny?, overlay?, uuid? } → {}   deny: [{ op, path }] refused;
//    overlay: places over a patch overlay; uuid: uuidv7 ids
// { op: "kids", id, value }                → {}   children entry replaced
// { op: "put", part, id, value }           → {}   entry replaced
// { op: "saved", part, id, path? }        → { value? }   at path (none: the whole value)
// { op: "change", part, id }               → { actor?, process?, caller? }   latest change's, from
//    its metadata; the header's own actor if it has one
// { op: "metadata", part, id }             → { keys, node?, replaces? }   latest change's metadata:
//    its keys, sorted, and the NODE key's and "replaces" key's values
// { op: "id", path }                       → { id? }   from "R"
// { op: "uuids", paths }                   → { v7, ordered }   each a uuidv7, each after the last
// processes:
// { op: "start", name, at, cwd?, args?, program } → { id }   program run as setup
// { op: "stop", name, why? }               → {}   teardowns told why (none: "ended")
// { op: "do", process, call, as? }         → { value }   call [fn, ...args] from outside;
//    as: name the result
// { op: "log", name }                      → { values }
// { op: "events" }                         → { events }   [part, id, "put" | "gone"] since last
//    asked, then forgotten; a non-string id: null
// { op: "pulse" }                          → {}
//
// program: steps { do: [fn, ...args], as? }; "$x" in an arg is name x (results, method args $0…).
// fn: an api function, or:
//   ["memo", name, options, expr]  memo(name, () => expr); no equal: "json"
//   ["effect", name, expr, log]    effect(name, () => expr, (v) => log v)
//   ["early", name, expr, log]     early(name, () => expr, (v) => log v)
//   ["log", log, expr]             expr's value logged and given back
//   ["count", name, log]           how many values name's log holds, logged
//   ["method", path, steps, expr?] method(path, (...args) => steps; expr given back)
//   ["teardown", log]              teardown((why) => log why)
//   ["watch", target, log]         watch(target, (w) => log w.patches)
//   ["ref", path, value]           ref(path, () => value)
//   ["if", test, then, else?]      then's or else's value (none: undefined)
//   ["throw", text]                throws an error of message text
//   ["each", expr, path]           each item of expr's list, at path (none: null)
// expr: [fn, ...args], ["all", expr, …], or "$x"
// errors: PlacesError { error: code }, Refusal "refused", SendError "not-a-method", PENDING
// "pending", else { error: text }
import createEntry from "@ermine/node/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key, type Table } from "@ermine/table"
import { at, children, createPlaces, type Places, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader, NODE } from "@ermine/places/header"
import { Refusal } from "@ermine/places/guard"
import { addProcess, processes, removeProcess } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import type { Process, Programs } from "@ermine/programs/start"
import { no, type Policy, yes } from "@ermine/protect"
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
	const host = s.createRootScope({ actor: "test" })
	const above = s.createScope({ role: "programs" }, host)
	const later: (() => void)[] = []
	const deny = (o.deny ?? []) as { op: string; path: string }[]
	const may: Policy | undefined = o.deny
		? (ask) =>
			deny.some((d) => d.op === ask.op && d.path === ask.target.path?.join("/"))
				? no("denied")
				: yes
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
		runs: undefined,
	}
	const apis = createProcessAPIs({
		scheduler: s,
		table,
		commit,
		host: { places, table, scheduler: s, commit },
		programs: () => programs,
		may,
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
	if (fn === "each") {
		const list = expr(api, env, args[0])
		return Array.isArray(list)
			? list.map((v) => at(v, args[1] as (string | number)[]) ?? null)
			: []
	}
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
	const id: Id = `proc:${r.name}`
	const scope = m.s.createScope({ process: at, [NODE]: id }, m.above)
	m.scopes.give(scope, id)
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
			let v: unknown = world().table.get(r.part as Key, r.id)?.value
			for (const k of (r.path ?? []) as string[]) {
				v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined
			}
			return v === undefined ? {} : { value: v }
		}
		case "metadata": {
			const c = world().table.get(r.part as Key, r.id)?.change
			const m = c?.metadata ?? {}
			const keys = Object.keys(m).sort()
			return {
				keys,
				...NODE in m && { node: m[NODE] },
				..."replaces" in m && { replaces: m.replaces },
			}
		}
		case "change": {
			const c = world().table.get(r.part as Key, r.id)?.change
			if (c === undefined) return {}
			const m = c.metadata ?? {}
			const actor = c.actor ?? m.actor
			const out: Record<string, unknown> = {}
			if (actor !== undefined) out.actor = actor
			for (const k of ["process", "caller"]) if (k in m) out[k] = m[k]
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
