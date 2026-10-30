// Line protocol for @ermine/system: one JSON request per line in, one answer per line out. One
// ermine per run: root "R", host scope { actor: "test" }, ids "n1", "n2", ..., process ids
// "proc:<name>". After every request the asked-for pulses run until none is asked.
// node: { path, part } | { id, part }
// { op: "ermine", features?, deny?, uuid?, calls?, at?, args? } -> {}
//     features: names ("inline" or another harness's own) or test features (below)
//     deny: [{ op, path?, id?, from?, pending? }] refuses (or marks pending) matching ops
//     uuid: use uuidv7 ids; calls: "never" holds no call records; at, args: the host's node
// { op: "features" } -> { features }
// { op: "late", feature } -> {}              a test feature adds a hook now
// { op: "uuid", path } -> { v7 }             whether the id there is a uuidv7
// { op: "node" } -> { id, attributes }       the host's node
// { op: "context", process? } -> { at, folder, args, process?, scope }   scope: "process" | "host"
// { op: "o", process?, within?, call } -> { value? }   call on a context (default the host's):
//     ["resolve", p], ["write", part, id | { id, path }, patches], ["remove", part, id | {id, path}],
//     ["ask", op, id, part], ["within"], ["api", call] (a @ermine/system function as that context)
// { op: "host", call, as? } -> { value? }    a function of the ermine object, as the host
// { op: "code", at, program, back?, throws?, promise? } -> {}   run program's steps as a setup;
//     its value is back's expr, or it throws text, or (promise) a promise settled at "settle"
// { op: "start", name, at, program?, args?, in? } -> { id } | { refused, held? }
//     program: the node holding a code step's program (default at); in: a name in "placed"
// { op: "stop", name, why? } -> {}
// { op: "status", name } -> { status }
// { op: "close" } -> {}
// { op: "record", kind: "run" | "call", id } -> { record? }
// { op: "waits" } -> { waits }               [{ caller, path?, id? }]
// { op: "slot", feature, process } -> { value? }
// { op: "do", process, call, as? } -> { value }   call [fn, ...args] from outside
// { op: "withWriter", process, name, steps?, back? } -> { value? }   call the process's writer
// { op: "activation", active } -> {}         whether the page is user-activated
// { op: "settle" } -> {}                     settle every promise made, then what settles after
// { op: "log", name } -> { values }; { op: "pulse" }; { op: "kids", id, value };
// { op: "put", part, id, value }; { op: "saved", part, id, path? }; { op: "id", path };
// { op: "frame", part, id } -> { frame }     the entry's change's frames, innermost first;
//     { op: "callframe", id } -> { frame }   where the handler's latest call was made from
// A call that gave a promise logs how it settled to "promised".
//
// A test feature: { name, needs?, onTable?, onRead?, onWrite?, onTeardown?, onRecord?, onStatus?,
// slot?, early?, late? }. Each hook logs [name, hook, ...] to "hooks", then does what its value says:
// "log" calls next, "drop" does not, "throw" throws "<name> threw", onWrite "refuse" throws a
// Refusal, onRead "add" adds an item, onWrite "copy" passes a copy, onTeardown "why" prefixes why
// with "<name>:", onStatus "add" adds the field <name>. Limits: only "host", ids, parts, takes,
// times: n.
//
// program: steps { do: [fn, ...args], as? }; "$x" in an arg is the name x. fn is a @ermine/system
// function or one of:
//   ["createMemo", name, options, expr]        options.equal "json"; options.gen: a generator compute
//   ["createEffect", name, expr, log, "throws"?, options?]
//   ["createAction", path, steps, expr?, "gen"?]
//   ["caught", log, steps]                     logs the code of an error the steps throw
//   ["addTeardown", log, tag?]
//   ["getStatus", target, key?]  ["explain", target, key?]  ["peep", expr]  ["ref", path, value]
//   ["log", log, expr]  ["start", name, at, program?, options?]  ["stopped", started, why?]
//   ["withWriter", runner, steps, expr?]  ["laterThrow", text]  ["later", expr]
//   ["if", test, then, else?]  ["throw", text]  ["each", expr, path]  ["pick", expr, path]
//   ["is", a, b]  ["keys", expr]  ["inc", n]
//   ["explaincall", target, key?]  ["explainargs", target]  ["explainfrom", target, i?]
//   ["share", path, name]                      an action; gives the node key id of the nearest scope
//   any library function another harness adds
// expr: [fn, ...args], ["all", expr, ...], ["whole", expr], "$x", or any other value as it is.
// Answers show errors as their message, PENDING as "PENDING", functions as "function". Error answers:
// PlacesError { error: code }, Refusal "refused", SendError "not-a-method", PENDING "pending",
// ErmineError its code, FeatureError { error: "feature", feature, hook, cause }, else { error: text }.
import { userActivation } from "./event_fixture.ts"
import createEntry from "@ermine/graph/entry"
import { at } from "@ermine/places"
import { PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import type { Location } from "@ermine/changeable/stacktrace"
import { Refusal } from "@ermine/processes/guard"
import type { Process } from "@ermine/processes/start"
import { no, pending, type Policy, yes } from "@ermine/protect"
import { PENDING } from "@ermine/reactivity"
import type { Id, Key } from "@ermine/graph/table"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import {
	type Call,
	createErmine,
	type Ermine,
	ErmineError,
	type Feature,
	FeatureError,
	FEATURES,
	type ProcessContext,
	SendError,
	type Started,
} from "./ermine.ts"
import * as system from "@ermine/system"
import type { System } from "./system/shapes.ts"
import { isHandle } from "./handles.ts"
import type { Run } from "@ermine/processes/runs"
import type { Status } from "./system/shapes.ts"
import type { Places } from "@ermine/places"
import { testFeature } from "./features_fixture.ts"
import { type Classify, show } from "../../conformance/typescript/frames.ts"

type Env = Map<string, unknown>
type Step = { do: [string, ...unknown[]]; as?: string }

const REPO = new URL("../../", import.meta.url).href
const inApi = (l: Location) => l.file.startsWith(REPO) && l.file !== import.meta.url

const classify: Classify = (locations) => {
	const at = locations.find((l) => !inApi(l))
	if (at === undefined) return "none"
	if (at.file !== import.meta.url) return "other"
	return at.function === "define" ? "computer" : at.function === "handler" ? "handler" : "program"
}

type Made = {
	ermine: Ermine
	running: Map<string, { started: Started; env: Env; api?: Sys }>
	hostSys: Sys
	logs: Map<string, unknown[]>
	later: (() => void)[]
	held: (() => void)[]
	slots: Map<string, (o: ProcessContext | undefined) => unknown>
	programs: Map<string, () => unknown>
	host: Env
	shared: Map<string, () => unknown>
	next?: string
	pending?: string
}

let w: Made | undefined
const late = new Map<string, () => void>()

function log(name: string, v: unknown) {
	const logs = world().logs
	if (!logs.has(name)) logs.set(name, [])
	logs.get(name)!.push(v === undefined ? null : v)
}

function make(o: Request = {}): Made {
	let n = 0
	const later: (() => void)[] = []
	const slots: Made["slots"] = new Map()
	const deny = (o.deny ?? []) as {
		op: string
		path?: string
		id?: string
		from?: string
		box?: string
		pending?: boolean
	}[]
	const may: Policy | undefined = o.deny
		? (ask) => {
			const d = deny.find((d) =>
				d.op === ask.op &&
				(d.id === undefined || d.id === ask.target.id) &&
				(d.path === undefined || d.path === ask.target.path?.join("/")) &&
				(d.from === undefined || d.from === ask.from?.path?.join("/")) &&
				(d.box === undefined || d.box === ask.from?.box)
			)
			return d === undefined ? yes : d.pending ? pending(["denied"]) : no("denied")
		}
		: undefined
	const features = ((o.features ?? []) as unknown[]).map((f) =>
		typeof f === "string"
			? named.get(f) ?? (() => {
				throw new Error(`no feature ${f}`)
			})()
			: testFeature(f as Record<string, unknown>, { log, slots, late })
	)
	if (o.calls === "never") features.push(noCalls)
	const made: Made = {
		ermine: undefined as never,
		running: new Map(),
		logs: new Map(),
		later,
		held: [],
		slots,
		programs: new Map(),
		host: new Map(),
		shared: new Map(),
		hostSys: undefined as never,
	}
	w = made
	made.ermine = createErmine({
		root: "R",
		info: { actor: "test" },
		features: [...features, {
			name: HARNESS,
			setup: (f) => {
				f.onSchedule((pulse) => void later.push(pulse))
				f.onCreateFunction((n) => log("onCreateFunction", [n.kind, n.id, n.process]))
				if (!o.uuid) {
					f.onId(() => {
						const next = made.next
						made.next = undefined
						return next ?? `n${++n}`
					})
				}
			},
		}],
		may,
		host: {
			...o.at !== undefined && { at: o.at },
			...o.args !== undefined && { args: o.args },
		},
	})
	made.hostSys = hostSystem(made.ermine)
	return made
}

const world = () => w ?? make()

// The features and library functions a program may use. Another harness adds its own.
export const named = new Map<string, Feature>()
export type Library = (
	env: Env,
	raw: unknown[],
	h: {
		arg: typeof arg
		expr: (env: Env, e: unknown) => unknown
		run: (env: Env, steps: readonly Step[]) => void
	},
) => unknown
export const libraries = new Map<string, Library>()

// What another harness adds: extra ops and places a start may live in.
export const ops = new Map<
	string,
	(r: Request, ermine: Ermine) => Record<string, unknown>
>()
export const placed = new Map<string, Places>()
const placesOf = (name: unknown): { places?: Places } => {
	if (name === undefined) return {}
	const places = placed.get(name as string)
	if (places === undefined) throw new Error(`no places ${name}`)
	return { places }
}

const inline: Feature = {
	name: "inline",
	setup: (f) =>
		f.onWrite((o, wr, next) => {
			log("hooks", ["inline", "onWrite", wr.part, wr.id, ...wr.gone ? ["gone"] : []])
			next(o, wr)
		}),
}

function arg(env: Env, a: unknown): unknown {
	if (typeof a === "string" && a.startsWith("$")) return env.get(a.slice(1))
	if (Array.isArray(a)) return a.map((x) => arg(env, x))
	if (isHandle(a)) return a
	if (a !== null && typeof a === "object") {
		return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, arg(env, v)]))
	}
	return a
}

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function expr(api: Sys, env: Env, e: unknown): unknown {
	if (typeof e === "string" || !Array.isArray(e)) return arg(env, e)
	const [fn, ...args] = e as [string, ...unknown[]]
	if (fn === "all") return args.map((x) => expr(api, env, x))
	if (fn === "whole") return [{ path: [], value: expr(api, env, args[0]) }]
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
	if (fn === "pick") return at(expr(api, env, args[0]), args[1] as (string | number)[]) ?? null
	return call(api, env, [fn, ...args])
}

function watched(v: unknown) {
	if (v instanceof Promise) {
		v.then((x) => log("promised", [x]), (x) => log("promised", ["rejected", message(x)]))
	}
}

function promised(f: () => unknown): Promise<unknown> {
	return new Promise((resolve, reject) =>
		world().held.push(() => {
			try {
				resolve(f())
			} catch (e) {
				reject(e)
			}
		})
	)
}

function call(api: Sys, env: Env, [fn, ...raw]: [string, ...unknown[]]): unknown {
	switch (fn) {
		case "createMemo":
		case "createEffect":
			return define(api, env, fn, raw)
		case "log": {
			const v = expr(api, env, raw[1])
			log(raw[0] as string, v)
			return v
		}
		case "createAction": {
			const [path, steps, back, kind] = raw as [string, Step[], unknown, "gen"?]
			if (kind !== undefined) {
				const body = (args: unknown[]) => {
					const inner: Env = new Map(env)
					args.forEach((a, i) => inner.set(String(i), a))
					return inner
				}
				const one = (inner: Env, step: Step) => {
					const v = call(imported, inner, step.do)
					if (step.as !== undefined) inner.set(step.as, v)
				}
				if (kind === "gen") {
					return handler(api, path, function* (...args: unknown[]) {
						const inner = body(args)
						for (const step of steps) {
							if (step.do[0] === "yield") {
								const v: unknown = yield expr(imported, inner, step.do[1])
								if (step.as !== undefined) inner.set(step.as, v)
							} else one(inner, step)
						}
						return back === undefined ? undefined : expr(imported, inner, back)
					})
				}
			}
			return handler(api, path, (...args: unknown[]) => {
				const inner: Env = new Map(env)
				args.forEach((a, i) => inner.set(String(i), a))
				run(imported, inner, steps)
				return back === undefined ? undefined : expr(imported, inner, back)
			})
		}
		case "addTeardown":
			return api.addTeardown((why) =>
				log(raw[0] as string, raw[1] === undefined ? why : `${raw[1]}:${why}`)
			)
		case "share": {
			const shared = world().shared
			const name = raw[1] as string
			let f = shared.get(name)
			if (f === undefined) {
				const s = world().ermine.scheduler
				shared.set(
					name,
					f = () => {
						for (let o = s.getCurrentScope(); o !== undefined; o = o.parent) {
							if ("node" in o.info) return o.info.node
						}
						return null
					},
				)
			}
			return api.createAction(raw[0] as string, f)
		}
		case "ref":
			return api.ref(raw[0] as string, () => raw[1])
		case "getStatus": {
			if (raw.length < 2) return status(api.getStatus(arg(env, raw[0]) as never))
			const key = arg(env, raw[1]) as string
			const v = api.getStatus(arg(env, raw[0]) as never, key as never)
			return key === "error" && v !== undefined ? message(v) : v
		}
		case "explain":
			return explained(api.explain(arg(env, raw[0]) as never, arg(env, raw[1]) as never))
		case "explainfrom": {
			const items = api.readAll(arg(env, raw[0]) as never)
			const c = items[(arg(env, raw[1]) as number | undefined) ?? 0]?.from.change
			return c === undefined ? undefined : explained(api.explain(c as never))
		}
		case "start": {
			const [name, at, program, opts] = raw.map((a) => arg(env, a)) as [
				string,
				string,
				string?,
				{ args?: string[] }?,
			]
			const m = world()
			const fn = m.programs.get(rooted(program ?? at))
			if (fn === undefined) throw new Error(`no program made at ${rooted(program ?? at)}`)
			const [was, pending] = [m.next, m.pending]
			m.next = `proc:${name}`
			m.pending = name
			m.running.set(name, { started: undefined as never, env: new Map() })
			try {
				const out = api.start(fn, at, opts)
				if ("refused" in out) {
					m.running.delete(name)
					return out
				}
				m.running.get(name)!.started = {
					process: { id: `proc:${name}` },
					stop: out.stop,
					status: out.status,
				} as never
				return out
			} catch (e) {
				m.running.delete(name)
				throw e
			} finally {
				m.next = was
				m.pending = pending
			}
		}
		case "caught": {
			try {
				run(api, new Map(env), raw[1] as Step[])
			} catch (err) {
				log(raw[0] as string, (err as { code?: string }).code ?? message(err))
			}
			return undefined
		}
		case "stopped":
			return (arg(env, raw[0]) as { stop: (why?: string) => void }).stop(
				arg(env, raw[1]) as string,
			)
		case "withWriter": {
			const later = arg(env, raw[0]) as (f: () => unknown) => unknown
			return later(() => {
				const inner: Env = new Map(env)
				run(api, inner, raw[1] as Step[])
				return raw[2] === undefined ? undefined : expr(api, inner, raw[2])
			})
		}
		case "laterThrow":
			return promised(() => {
				throw new Error(raw[0] as string)
			})
		case "later":
			return promised(() => expr(api, env, raw[0]))
		case "peep":
			return api.peep(() => expr(api, env, raw[0]))
		case "inc":
			return (expr(api, env, raw[0]) as number) + 1
		case "is":
			return Object.is(expr(api, env, raw[0]), expr(api, env, raw[1]))
		case "keys": {
			const v = expr(api, env, raw[0])
			return v !== null && typeof v === "object" ? Object.keys(v).sort() : []
		}
		case "explaincall": {
			const b = api.explain(arg(env, raw[0]) as never, arg(env, raw[1]) as never)
			const w = b?.writer
			return w?.kind === "method" && w.call !== undefined ? Object.keys(w.call).sort() : null
		}
		case "explainargs": {
			const b = api.explain(arg(env, raw[0]) as never)
			const w = b?.writer
			if (w?.kind !== "method" || w.call === undefined) return null
			const mark = (v: unknown): unknown =>
				isHandle(v) ? "a handle" : Array.isArray(v) ? v.map(mark) : v
			return { args: mark(w.call.args), returned: mark(w.call.returned ?? null) }
		}
		default: {
			const library = libraries.get(fn)
			if (library !== undefined) {
				return api.within(() =>
					library(env, raw, {
						arg,
						expr: (e, x) => expr(imported, e, x),
						run: (e, steps) => run(imported, e, steps),
					})
				)
			}
			const f = (api as unknown as Record<string, unknown>)[fn]
			if (typeof f !== "function") throw new Error(`no api function ${fn}`)
			return f(...raw.map((a) => arg(env, a)))
		}
	}
}

type Sys = System & { within: <T>(f: () => T) => T }
const names = Object.keys(system).filter((k) =>
	typeof (system as Record<string, unknown>)[k] === "function"
) as (keyof System)[]
const opened = (within: <T>(f: () => T) => T): Sys => {
	const out: Record<string, unknown> = { within }
	for (const k of names) {
		const f = system[k] as (...a: unknown[]) => unknown
		out[k] = (...a: unknown[]) => within(() => f(...a))
	}
	return out as Sys
}
const imported: Sys = {
	...(system as unknown as System),
	within: (f) => f(),
} as Sys
const hostSystem = (e: Ermine): Sys => opened(e.within)

// The host's steps mint handles for nodes, as the host may.
function minted(e: Ermine, x: unknown): unknown {
	if (Array.isArray(x)) return x.map((y) => minted(e, y))
	if (x === null || typeof x !== "object") return x
	const keys = Object.keys(x)
	const node = keys.length > 0 && "part" in x &&
		keys.every((k) => ["id", "path", "part"].includes(k))
	return node ? e.handleOf(x as never) : x
}

// deno-lint-ignore no-explicit-any
function handler(api: Sys, path: string, fn: (...a: any[]) => unknown) {
	return api.within(function handler() {
		return system.createAction(path, fn)
	})
}

function define(api: Sys, env: Env, fn: string, raw: unknown[]): unknown {
	if (fn === "createMemo") {
		const [name, options, e] = raw as [string, Record<string, unknown>, unknown]
		const equal = options?.equal === "json" ? json : undefined
		if (Array.isArray(options?.gen)) {
			const steps = options.gen as Step[]
			const { gen: _, ...rest } = options
			return api.createMemo(name, function* () {
				const inner: Env = new Map(env)
				for (const step of steps) {
					if (step.do[0] === "yield") {
						const v: unknown = yield expr(api, inner, step.do[1])
						if (step.as !== undefined) inner.set(step.as, v)
					} else {
						const v = call(api, inner, step.do)
						if (step.as !== undefined) inner.set(step.as, v)
					}
				}
				return expr(api, inner, e)
			}, { ...rest, equal } as never)
		}
		return api.createMemo(name, () => expr(api, env, e), { ...options, equal } as never)
	}
	const [name, e, to, throws, options] = raw as [
		string,
		unknown,
		string,
		unknown,
		| { early?: boolean; act?: Step[]; caught?: string; cleanup?: string; returns?: unknown }
		| undefined,
	]
	return api.createEffect(name, () => expr(api, env, e), (v) => {
		log(to, v)
		if (throws === "throws") throw new Error(`act ${JSON.stringify(v)}`)
		if (options?.act !== undefined) {
			try {
				run(api, new Map(env), options.act)
			} catch (err) {
				log(options.caught ?? "caught", (err as { code?: string }).code ?? message(err))
			}
		}
		if (options?.cleanup !== undefined) return () => log(options.cleanup!, v)
		if (options !== undefined && "returns" in options) return options.returns as never
	}, options?.early ? { early: true } : undefined)
}

function run(api: Sys, env: Env, steps: readonly Step[]) {
	for (const step of steps) {
		const v = call(api, env, step.do)
		if (step.as !== undefined) env.set(step.as, v)
	}
}

const message = (e: unknown) =>
	e === PENDING ? "PENDING" : e instanceof Error ? e.message : String(e)
function plain(v: unknown): unknown {
	if (isHandle(v)) return plain(w?.ermine.dataOf(v)?.node ?? "a handle of no ermine")
	if (v === PENDING) return "PENDING"
	if (typeof v === "symbol") return String(v.description ?? v.toString())
	if (typeof v === "function") return "function"
	if (v instanceof Error) return message(v)
	if (Array.isArray(v)) return v.map(plain)
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(
			Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, plain(x)]),
		)
	}
	return v
}
function status(st: Status | undefined) {
	if (st === undefined) return undefined
	const { hint: _, ...bareStatus } = st
	return plain({
		...bareStatus,
		...st.error !== undefined && { error: message(st.error) },
		...st.waiting && {
			waiting: st.waiting.map((x) =>
				typeof x === "object" && "since" in x ? { send: x.send } : x
			),
		},
	})
}
function explained(b: ReturnType<System["explain"]>) {
	if (b === undefined) return undefined
	const held = b.held === undefined ? {} : { held: b.held }
	if (b.writer === undefined) return held
	return {
		...shownWriter(b.writer),
		...b.change?.userActivated && { userActivated: true },
		...held,
	}
}
function shownWriter(w: NonNullable<NonNullable<ReturnType<System["explain"]>>["writer"]>) {
	if (w.kind === "computer") {
		return { writer: w.kind, path: w.path ?? null, ...w.run && { n: w.run.n } }
	}
	if (w.kind === "method") {
		return { writer: w.kind, path: w.path ?? null, ...w.call && { n: w.call.n } }
	}
	if (w.kind === "feature") return { writer: w.feature, path: w.path ?? null }
	return {
		writer: w.kind,
		...w.locations !== undefined && { locations: [classify(w.locations)] },
	}
}
const pairs = (list: readonly object[]) =>
	list.flatMap((x: { part?: unknown; id?: unknown }) =>
		"part" in x ? [[x.part, typeof x.id === "string" ? x.id : null]] : []
	)
function callShown(c: Call) {
	return plain({
		n: c.n,
		frame: show(c.frame, classify),
		caller: c.caller,
		handler: c.handler.id,
		args: c.args,
		end: c.end,
		...("returned" in c && c.returned !== undefined) && { returned: c.returned },
		...c.error !== undefined && { error: message(c.error) },
		reads: pairs(c.reads),
		writes: pairs(c.writes),
		...c.made && { made: c.made.map((m) => [m.kind, m.id]) },
	})
}
const runShown = (r: Run) =>
	plain({
		n: r.n,
		frame: show(r.frame, classify),
		end: r.end,
		...r.error !== undefined && { error: message(r.error) },
		writes: pairs(r.writes),
		...(r as Run & { held?: unknown }).held !== undefined && {
			held: (r as Run & { held?: unknown }).held,
		},
	})

function drain() {
	const later = world().later
	while (later.length) later.shift()!()
}

function code(r: Request) {
	const steps = (r.program ?? []) as Step[]
	return () => {
		const api = imported
		const env: Env = new Map()
		const named = world().pending
		if (named !== undefined) world().running.get(named)!.api = api
		run(api, env, steps)
		if (named !== undefined) world().running.get(named)!.env = env
		if (r.throws !== undefined) throw new Error(r.throws)
		const back = () => r.back === undefined ? undefined : expr(api, env, r.back)
		if (r.promise) return promised(back)
		return back()
	}
}

const rooted = (p: string | readonly string[]) =>
	"/" + (typeof p === "string" ? p.split("/") : p).filter((n) => n !== "").join("/")

function start(r: Request): Record<string, unknown> {
	const m = world()
	m.next = `proc:${r.name}`
	m.pending = r.name
	m.running.set(r.name, { started: undefined as never, env: new Map() })
	try {
		const where = r.program ?? String(r.at).split("/")
		const program = m.programs.get(rooted(where))
		if (program === undefined) throw new Error(`no program made at ${rooted(where)}`)
		const s = m.ermine.start(program, r.at, {
			...r.args !== undefined && { args: r.args },
			...placesOf(r.in),
		})
		if ("refused" in s) {
			m.running.delete(r.name)
			return { refused: s.refused, ...s.held && { held: s.held } }
		}
		m.running.get(r.name)!.started = s
		return { id: s.process.id }
	} finally {
		m.next = undefined
		m.pending = undefined
	}
}

async function answer(r: Request): Promise<Record<string, unknown>> {
	const m = world()
	const e = m.ermine
	switch (r.op) {
		case "ermine":
			make(r)
			return {}
		case "features":
			return { features: e.features.filter((f) => f.name !== HARNESS) }
		case "late":
			late.get(r.feature)!()
			return {}
		case "uuid": {
			const id = get(e.places, r.path)
			const v7 = typeof id === "string" &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
			return { v7 }
		}
		case "node": {
			const attrs = e.table.get("attributes", e.id)?.value as
				| Record<string, unknown>
				| undefined
			const shown = attrs?.[FEATURES] as { name: string }[] | undefined
			return {
				id: e.id,
				attributes: plain(
					shown === undefined
						? attrs
						: { ...attrs, [FEATURES]: shown.filter((f) => f.name !== HARNESS) },
				),
			}
		}
		case "context": {
			const p = r.process === undefined ? undefined : m.running.get(r.process)?.started.process
			const o = e.getProcessContext(p as Process | undefined)
			if (o === undefined) return {}
			return {
				at: o.at,
				folder: o.folder,
				args: o.args,
				...o.process && { process: o.process.id },
				scope: o.scope.info.node === e.id ? "host" : o.process ? "process" : "other",
			}
		}
		case "o": {
			const p = r.process === undefined ? undefined : m.running.get(r.process)?.started.process
			const o = e.getProcessContext(p as Process | undefined)!
			const [fn, ...a] = r.call as [string, ...unknown[]]
			const as = <T>(f: () => T): T => r.within === true ? o.within(f) : f()
			switch (fn) {
				case "resolve":
					return { value: o.resolve(a[0] as string) }
				case "write":
					as(() => o.write(a[0] as Key, a[1] as never, a[2] as never))
					return {}
				case "remove":
					as(() => o.remove(a[0] as Key, a[1] as never))
					return {}
				case "ask":
					o.ask(a[0] as string, { id: a[1] as Id, part: a[2] as Key })
					return {}
				case "within":
					return { value: o.within(() => e.scheduler.getCurrentScope() === o.scope) }
				case "api": {
					const sys: Sys = opened(o.within)
					const v = call(sys, m.host, a[0] as [string, ...unknown[]])
					return v === undefined ? {} : { value: plain(v) }
				}
				default:
					throw new Error(`no context function ${fn}`)
			}
		}
		case "host": {
			const v = call(m.hostSys, m.host, minted(e, r.call) as [string, ...unknown[]])
			watched(v)
			if (r.as !== undefined) m.host.set(r.as, v)
			return v === undefined ? {} : { value: plain(v) }
		}
		case "code":
			{
				const program = code(r)
				m.programs.set(rooted(r.at), program)
				m.hostSys.ensureNode(r.at, program)
			}
			return {}
		case "start":
			return start(r)
		case "stop": {
			const p = m.running.get(r.name)
			if (p === undefined) throw new Error(`no process ${r.name}`)
			p.started.stop(r.why)
			return {}
		}
		case "status": {
			const p = m.running.get(r.name)
			if (p === undefined) throw new Error(`no process ${r.name}`)
			return { status: status(p.started.status()) }
		}
		case "close":
			e.close()
			return {}
		case "record": {
			const id = r.id ?? get(e.places, r.path)
			if (r.kind === "call") {
				const c = e.records.call(id)
				return c === undefined ? {} : { record: callShown(c) }
			}
			const run = e.records.run(id)
			return run === undefined ? {} : { record: runShown(run) }
		}
		case "waits":
			return {
				waits: e.records.waits().map((x) => ({
					caller: x.caller,
					...x.path && { path: x.path },
					...x.id !== undefined && { id: x.id },
				})),
			}
		case "slot": {
			const p = m.running.get(r.process)?.started.process
			const v = m.slots.get(r.feature)?.(e.getProcessContext(p))
			return v === undefined ? {} : { value: v }
		}
		case "do": {
			const p = m.running.get(r.process)
			if (p?.api === undefined) throw new Error(`no process ${r.process}`)
			const context = e.getProcessContext(p.started.process)
			if (context === undefined) throw new Error(`process ${r.process} stopped`)
			const v = context.within(() => call(p.api!, p.env, r.call))
			watched(v)
			if (r.as !== undefined) p.env.set(r.as, v)
			return v === undefined ? {} : { value: plain(v) }
		}
		case "withWriter": {
			const p = m.running.get(r.process)
			if (p === undefined) throw new Error(`no process ${r.process}`)
			const v = call(imported, p.env, ["withWriter", `$${r.name}`, r.steps ?? [], r.back])
			return v === undefined ? {} : { value: plain(v) }
		}
		case "activation":
			userActivation.active = r.active === true
			return {}
		case "settle": {
			while (m.held.length) {
				for (const f of m.held.splice(0)) f()
				await new Promise((res) => setTimeout(res, 0))
				drain()
			}
			return {}
		}
		case "log":
			return { values: m.logs.get(r.name) ?? [] }
		case "pulse":
			e.scheduler.pulse()
			return {}
		case "kids":
		case "put": {
			const part = r.op === "kids" ? "children" : r.part
			const s = e.scheduler
			e.getProcessContext()!.within(() =>
				e.table.sub(part, r.id, createEntry(r.value, createChangeHeader(s)))
			)
			return {}
		}
		case "saved": {
			let v: unknown = e.table.get(r.part as Key, r.id)?.value
			for (const k of (r.path ?? []) as string[]) {
				v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined
			}
			return v === undefined ? {} : { value: plain(v) }
		}
		case "id": {
			const id = get(e.places, r.path)
			return id === undefined ? {} : { id: id as Id }
		}
		case "frame":
			return { frame: show(e.table.get(r.part as Key, r.id)?.change?.frame, classify) }
		case "callframe":
			return { frame: show(e.records.call(r.id)?.frame, classify) }
		default: {
			const extra = ops.get(r.op)
			if (extra === undefined) throw new Error(`no op ${r.op}`)
			return extra(r, e)
		}
	}
}

const HARNESS = "harness"
const noCalls: Feature = {
	name: "no-calls",
	setup: (f) => f.onRecord((r, next) => r.call === undefined && next(r)),
}

named.set("inline", inline)

export const serveErmine = () =>
	serve(async (r) => {
		try {
			const out = await answer(r)
			drain()
			return out
		} catch (e) {
			drain()
			if (e === PENDING) return { error: "pending" }
			if (e instanceof PlacesError) return { error: e.code }
			if (e instanceof Refusal) {
				const by = e as Refusal & { feature?: string; hook?: string }
				return by.feature === undefined
					? { error: "refused" }
					: { error: "refused", feature: by.feature, hook: by.hook }
			}
			if (e instanceof SendError) return { error: e.code }
			if (e instanceof ErmineError) return { error: e.code }
			if (e instanceof FeatureError) {
				return { error: "feature", feature: e.feature, hook: e.hook, cause: message(e.cause) }
			}
			return { error: String(e) }
		}
	})
if (import.meta.main) serveErmine()
