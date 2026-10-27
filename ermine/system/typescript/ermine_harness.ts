// @ermine/system (ermine.ts, system.ts) on the line protocol: one JSON request per line in, one answer per line out, in
// order. one ermine per run (a plain one, or the last "ermine" asked): root "R", the host's scope
// { actor: "test" }, new ids "n1", "n2", … in order, a process's id "proc:<name>". pulses as the
// harness chooses: after every request the asked-for ones run, till none is asked.
// node: { path, part } | { id, part }.
//
// the ermine:
// { op: "ermine", features?, deny?, uuid?, calls?, at?, args?, machine? } → {}   features: names
//    ("patchy": the real one; "inline": one written in this file, listing no files; another
//    harness adds its own: named, below) or
//    test features (below); deny: [{ op, path?, id?, from?, box? }] refused (every field given
//    matching; from: the asker's place; box: the box the asker is in, by its name, a "box" step's:
//    that box's folder's id the ask's from.box);
//    uuid: uuidv7 ids; calls: "never". deny: by path, or { op, id } by id; at, args, machine: the host's node's
// { op: "features" }                       → { features }   ermine.features
// { op: "late", feature }                  → {}   a test feature adding a hook now (late: true)
// { op: "uuid", path }                     → { v7 }   whether the id there is a uuidv7
// { op: "node" }                           → { id, attributes }   the host's node
// { op: "context", process? }               → { at, folder, args, process?, scope }   ermine.getProcessContext's;
//    scope: whether it is the process's scope ("process") or the host's ("host")
// { op: "o", process?, within?, call }    → { value? }   the context's (none: the host's): ["resolve",
//    p], ["write", part, id or { id, path }, patches], ["remove", part, id or { id, path }], ["ask", op, id, part],
//    ["within"] (whether its scope is the one open in f), ["api", call] (one of @ermine/system's
//    functions, given that context)
// { op: "host", call, as? }                → { value? }   one of the ermine object's functions,
//    as the host
// { op: "code", at, program, back?, throws?, promise? } → {}   a program (its node, at, holding
//    it too), a setup running
//    program's steps with its api: its value back's (an expr), or it throws text, or (promise) a
//    promise of back's, settled at the next "settle"
// { op: "start", name, at, program?, args?, box? } → { id } | { refused, held? }   ermine.start(fn,
//    at, …): fn the program a code step made at program (none: at, from the root through box's
//    folder); box: a box's name
// { op: "box", name, at }                  → {}   the host's box(at), named
// { op: "boxplace", name, at, id | path }  → {}   that box's place: a node placed in it
// { op: "stop", name, why? }               → {}
// { op: "status", name }                   → { status }   the start's handle's status()
// { op: "close" }                          → {}
// { op: "service", what: "land", at }      → {}   the host places patchy' land at at
// { op: "record", kind: "run" | "call", id } → { record? }   the latest, shown (below)
// { op: "waits" }                          → { waits }   [{ caller, path?, id?, box }]
// { op: "slot", feature, process }         → { value? }   a test feature's slot at the process
// { op: "do", process, call, as? }         → { value }   call [fn, ...args] from outside
// { op: "settle" }                         → {}   every promise the harness made settled, then
//    whatever settles after them
// { op: "log", name } → { values }; { op: "pulse" }; { op: "kids", id, value }; { op: "put", part,
//    id, value }; { op: "saved", part, id, path? }; { op: "id", path }; { op: "metadata", part, id }
//    → { keys, node?, features?, call?, handler?, caller? }; { op: "site", part, id } → { site } (as
//    ermine/api's harness: program, computer, api, other, none)
//
// a test feature: { name, needs?, onTable?, onRead?, onWrite?, onTeardown?, onRecord?, onStatus?, slot?,
// early?, late? }. early: its setup reads places (not made yet); late: it keeps its FeatureAPI.
// each hook logs [name, hook, …] to the log "hooks", then: "log" next as given; "drop" no next;
// "throw" throws "<name> threw"; onWrite "refuse" throws a Refusal; only: "host", it acts on the
// host's context's writes alone; ids: [id], parts: [part], it acts on writes to those alone; takes:
// on writes taking something out alone (logged with "gone" when an entry goes); times: n, on the
// first n it matches alone; onRead "add": next with { value: name, from: { kind: "test" } }
// added; onWrite "copy": next with a copy of the write; onTeardown "why": next with why
// "<name>:<why>"; onStatus "add": next, then the field <name>: true added. slot: true, its onWrite
// counts the writes of each context in its slot.
// onCreateFunction: each made, logged to "onCreateFunction" [kind, id, process].
// what is logged: onWrite [name, hook, part, id]; onRead [name, hook, id]; onTeardown [name, hook,
// why]; onRecord [name, hook, "run" | "call", id, end]; onStatus [name, hook, id]; onTable [name,
// hook].
//
// program: steps { do: [fn, ...args], as? }; "$x" in an arg is name x (results, an action's args
// $0…). fn: one of @ermine/system's functions, called as it is, or one of these forms:
//   ["createMemo", name, options, expr]       createMemo(name, () => expr); options.equal "json":
//                                             compared as JSON
//   ["createEffect", name, expr, log, "throws"?, options?]   createEffect(name, () => expr, (v) =>
//                                             log v; throws: then throws "act <v>"; options:
//                                             { early })
//   ["createAction", path, steps, expr?]      createAction(path, (...args) => steps; expr given
//                                             back)
//   ["addTeardown", log, tag?]                addTeardown((why) => log why, or "<tag>:<why>")
//   ["getStatus", target]                     getStatus(target), shown
//   ["explain", target, key?]                 explain(target, key), shown
//   ["peep", expr]                            peep(() => expr): read untracked
//   ["ref", path, value]                      ref(path, () => value)
//   ["watch", x, log]                         pipe(x, fn, { timing: "write" }): each write's
//                                             patches logged ("refused")
//   ["pipe", from, to | fn, fnA?, fnB?, o?]   pipe(...): a function { steps, gives? }, the write
//                                             as $0; o: { timing, name }
//   ["log", log, expr]                        expr's value logged and given back
//   ["later", expr]                           a promise of expr's value, settled at "settle"
//   ["if", test, then, else?], ["throw", text], ["each", expr, path], ["pick", expr, path] (the
//                                             value at path in expr's), ["is", a, b], ["keys", expr], ["inc", n] (n + 1)
//   ["explaincall", target, key?]             the keys of explain's writer.call, sorted (none: null)
//   ["explainargs", target]                   explain's writer.call: { args, returned } (a handle
//                                             in them: "a handle"; none a call: null)
//   ["explainfrom", target, i?]               explain of readAll(target)[i].from.change, shown
//   ["share", path, name]                     createAction(path, f), f one function per name across
//                                             the whole run: it gives back the NODE key's id of the
//                                             nearest scope above the one open as it runs
//   ["createPatch", at, over, change], ["layers", target, key?]   patchy's library
//   any library function another harness adds (libraries, below)
// expr: [fn, ...args], ["all", expr, …], ["whole", expr] ([{ path: [], value }]), "$x", or any other
// value as it is
// shown: status { state, error?: its message, phase?, waiting?, n?, held? }; explain { writer?: "computer" |
// "method" | "outside", computer?, method?, n? (its record still holding it), site?, fallback?, held? }; a call's record { n,
// caller, handler, args, end, returned?, error?, reads: [[part, id]], writes: [[part, id]], made?:
// [[kind, id]] }; a run's { n, end, error?, writes: [[part, id]], held? }. an error as its message,
// PENDING "PENDING", a function "function"
// errors: PlacesError { error: code }, Refusal "refused" (a hook's: { error, feature, hook }), SendError "not-a-method", PENDING
// "pending", ErmineError its code, FeatureError { error: "feature", feature, hook, cause }, else
// { error: text }
import createEntry from "@ermine/core/node/entry"
import { at } from "@ermine/core/places"
import { PlacesError } from "@ermine/core/places"
import { inside } from "@ermine/boxes"
import { get } from "@ermine/core/places/lib"
import { createChangeHeader, NODE } from "@ermine/core/places/header"
import { Refusal } from "@ermine/core/places/guard"
import type { Process } from "@ermine/processes/start"
import { no, type Policy, yes } from "@ermine/core/protect"
import { PENDING } from "@ermine/core/scheduler"
import type { Id, Key } from "@ermine/core/table"
import patchy, { createPatch, land, layers } from "@ermine/patchy/feature"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import {
	type BoxNode,
	type Call,
	createErmine,
	type Ermine,
	ErmineError,
	type Feature,
	FeatureError,
	type ProcessContext,
	SendError,
	type Started,
} from "./ermine.ts"
import * as system from "@ermine/system"
import type { System } from "./system.ts"
import { isHandle } from "./handles.ts"
import { bare } from "./hints.ts"
import type { Run } from "@ermine/processes/runs"
import { testFeature } from "./features_fixture.ts"

type Env = Map<string, unknown>
type Step = { do: [string, ...unknown[]]; as?: string }

// ermine's own files: a site in one is the api's
const OURS = ["ermine.ts", "system.ts", "context.ts", "calls.ts", "features.ts"].map((f) =>
	new URL(`./${f}`, import.meta.url).href
)

type Made = {
	ermine: Ermine
	running: Map<string, { started: Started; env: Env; api?: Sys }>
	hostSys: Sys
	logs: Map<string, unknown[]>
	later: (() => void)[]
	// the promises the harness made, to settle
	held: (() => void)[]
	slots: Map<string, (o: ProcessContext | undefined) => unknown>
	boxes: Map<string, BoxNode>
	// each box's folder's id, by its name
	boxIds: Map<string, Id>
	// the programs code steps made, by the path they were written at (from the root)
	programs: Map<string, () => unknown>
	host: Env
	// the functions "share" places, by name
	shared: Map<string, () => unknown>
	// the next process's id, and its name while it starts
	next?: string
	pending?: string
}

let w: Made | undefined
// a test feature's hook added after createErmine (late: true)
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
	}[]
	const may: Policy | undefined = o.deny
		? (ask) =>
			deny.some((d) =>
					d.op === ask.op &&
					(d.id === undefined || d.id === ask.target.id) &&
					(d.path === undefined || d.path === ask.target.path?.join("/")) &&
					(d.from === undefined || d.from === ask.from?.path?.join("/")) &&
					(d.box === undefined ||
						(made.boxIds.has(d.box) && made.boxIds.get(d.box) === ask.from?.box))
				)
				? no("denied")
				: yes
		: undefined
	const features = ((o.features ?? []) as unknown[]).map((f) =>
		typeof f === "string"
			? named.get(f) ?? (() => {
				throw new Error(`no feature ${f}`)
			})()
			: testFeature(f as Record<string, unknown>, { log, slots, late })
	)
	const made: Made = {
		ermine: undefined as never,
		running: new Map(),
		logs: new Map(),
		later,
		held: [],
		slots,
		boxes: new Map(),
		boxIds: new Map(),
		programs: new Map(),
		host: new Map(),
		shared: new Map(),
		hostSys: undefined as never,
	}
	w = made
	made.ermine = createErmine({
		root: "R",
		info: { actor: "test" },
		features,
		may,
		schedule: (f) => void later.push(f),
		onCreateFunction: (n) => log("onCreateFunction", [n.kind, n.id, n.process]),
		...!o.uuid && {
			id: () => {
				const next = made.next
				made.next = undefined
				return next ?? `n${++n}`
			},
		},
		...o.calls !== undefined && { calls: o.calls },
		host: {
			...o.at !== undefined && { at: o.at },
			...o.args !== undefined && { args: o.args },
			...o.machine !== undefined && { machine: o.machine },
		},
	})
	made.hostSys = hostSystem(made.ermine)
	return made
}

const world = () => w ?? make()

// the features asked for by name ("patchy", "inline"; another harness adds its own), and the
// library functions a program may call beside @ermine/system's (patchy's createPatch and layers;
// another harness adds its own): each given the names, its raw arguments, and the harness's arg
// and expr, and run with its caller's scope open (they call @ermine/system's functions, which find
// it)
export const named = new Map<string, Feature>()
export type Library = (
	env: Env,
	raw: unknown[],
	h: { arg: typeof arg; expr: typeof expr },
) => unknown
export const libraries = new Map<string, Library>()

// a feature written here, beside the programs, listing no files: their lines keep their sites
const inline: Feature = {
	name: "inline",
	setup: (f) =>
		f.onWrite((o, wr, next) => {
			log("hooks", ["inline", "onWrite", wr.part, wr.id, ...wr.gone ? ["gone"] : []])
			next(o, wr)
		}),
}

// "$x": the name x, anywhere in an argument (inside lists and maps too); anything else as it is
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
	// a whole value's patches, the value expr's
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

// a promise of f's value, settled at the next "settle"
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
			const [path, steps, back] = raw as [string, Step[], unknown]
			return api.createAction(path, (...args: unknown[]) => {
				const inner: Env = new Map(env)
				args.forEach((a, i) => inner.set(String(i), a))
				run(api, inner, steps)
				return back === undefined ? undefined : expr(api, inner, back)
			})
		}
		case "addTeardown":
			return api.addTeardown((why) =>
				log(raw[0] as string, raw[1] === undefined ? why : `${raw[1]}:${why}`)
			)
		// a pipe told as each write lands, logging its patches (the form watch had)
		case "watch":
			return api.pipe(
				arg(env, raw[0]) as never,
				(x) => log(raw[1] as string, x.refused ? "refused" : x.patches),
				{ timing: "write" },
			)
		// pipe(from, to | fn, fnA?, fnB?, options?): a function is { steps, gives? }, run with the
		// write as $0 ({ patches, value, refused? }); gives: what it gives back (a transform's patches)
		case "pipe": {
			const [from, ...rest] = raw as unknown[]
			const isFn = (x: unknown) =>
				x !== null && typeof x === "object" && !Array.isArray(x) && "steps" in x
			const fn = (f: unknown) => {
				const { steps, gives } = f as { steps: Step[]; gives?: unknown }
				return (w: { patches: unknown; value: unknown; refused?: true }) => {
					const inner: Env = new Map(env)
					inner.set("0", {
						patches: w.patches,
						value: w.value,
						...w.refused && { refused: true },
					})
					run(api, inner, steps)
					return gives === undefined ? undefined : expr(api, inner, gives)
				}
			}
			const args = rest.map((x, i) => isFn(x) ? fn(x) : i === 0 ? arg(env, x) : x)
			return api.pipe(arg(env, from) as never, ...args as [never])
		}
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
							if (NODE in o.info) return o.info[NODE]
						}
						return null
					},
				)
			}
			return api.createAction(raw[0] as string, f)
		}
		case "ref":
			return api.ref(raw[0] as string, () => raw[1])
		case "getStatus":
			return status(api.getStatus(arg(env, raw[0]) as never))
		case "explain":
			return explained(api.explain(arg(env, raw[0]) as never, arg(env, raw[1]) as never))
		case "explainfrom": {
			const items = api.readAll(arg(env, raw[0]) as never)
			const c = items[(arg(env, raw[1]) as number | undefined) ?? 0]?.from.change
			return c === undefined ? undefined : explained(api.explain(c as never))
		}
		case "later":
			return promised(() => expr(api, env, raw[0]))
		// peep(f): its expression read untracked
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
			// a library's (patchy's createPatch, pully's provide …), in its caller's scope
			const library = libraries.get(fn)
			if (library !== undefined) return api.within(() => library(env, raw, { arg, expr }))
			const f = (api as unknown as Record<string, unknown>)[fn]
			if (typeof f !== "function") throw new Error(`no api function ${fn}`)
			return f(...raw.map((a) => arg(env, a)))
		}
	}
}

// a function's target: ["info", x] the attributes of x, else the argument as it is
// what steps call: @ermine/system's functions; within, the caller's scope opened round a library's
// call
type Sys = System & { within: <T>(f: () => T) => T }
const names = Object.keys(system).filter((k) =>
	typeof (system as Record<string, unknown>)[k] === "function"
) as (keyof System)[]
// the functions, each run in within's scope (the host's, process 0's: ermine.within; a process's:
// its context's)
const opened = (within: <T>(f: () => T) => T): Sys => {
	const out: Record<string, unknown> = { within }
	for (const k of names) {
		const f = system[k] as (...a: unknown[]) => unknown
		out[k] = (...a: unknown[]) => within(() => f(...a))
	}
	return out as Sys
}
// a program's: the imported ones (setup is given nothing), found from the scope open
const imported: Sys = { ...(system as unknown as System), within: (f) => f() }
// the host's: in its scope
const hostSystem = (e: Ermine): Sys => opened(e.within)

// the host's steps: a node written as { id?, path?, part } is minted a handle, as the host may
// (ermine.handleOf); a process's stay as written (an object no handle: not-a-handle)
function minted(e: Ermine, x: unknown): unknown {
	if (Array.isArray(x)) return x.map((y) => minted(e, y))
	if (x === null || typeof x !== "object") return x
	const keys = Object.keys(x)
	const node = keys.length > 0 && "part" in x &&
		keys.every((k) => ["id", "path", "part"].includes(k))
	return node ? e.handleOf(x as never) : x
}

// a memo or effect made: the line a computer's site is ("computer" to site)
function define(api: Sys, env: Env, fn: string, raw: unknown[]): unknown {
	if (fn === "createMemo") {
		const [name, options, e] = raw as [string, Record<string, unknown>, unknown]
		const equal = options?.equal === "json" ? json : undefined
		return api.createMemo(name, () => expr(api, env, e), { ...options, equal } as never)
	}
	// createEffect's fifth: its options ({ early })
	const [name, e, to, throws, options] = raw as [
		string,
		unknown,
		string,
		unknown,
		{ early?: boolean } | undefined,
	]
	return api.createEffect(name, () => expr(api, env, e), (v) => {
		log(to, v)
		if (throws === "throws") throw new Error(`act ${JSON.stringify(v)}`)
	}, options?.early ? { early: true } : undefined)
}

function run(api: Sys, env: Env, steps: readonly Step[]) {
	for (const step of steps) {
		const v = call(api, env, step.do)
		if (step.as !== undefined) env.set(step.as, v)
	}
}

// shown: plain, for an answer. an error's text as the base gives it (its hint left out: the C gives
// none)
const message = (e: unknown) => e === PENDING ? "PENDING" : e instanceof Error ? bare(e) : String(e)
function plain(v: unknown): unknown {
	// a handle: what it reaches, as the host sees it (the harness's eyes; programs can't)
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
function status(st: ReturnType<System["getStatus"]>) {
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
	return { ...shownWriter(b.writer), ...held }
}
function shownWriter(w: NonNullable<NonNullable<ReturnType<System["explain"]>>["writer"]>) {
	if (w.kind === "computer") {
		return { writer: w.kind, path: w.path ?? null, ...w.run && { n: w.run.n } }
	}
	if (w.kind === "method") {
		return { writer: w.kind, path: w.path ?? null, ...w.call && { n: w.call.n } }
	}
	if (w.kind === "pipe") return { writer: w.kind, path: w.path ?? null }
	return { writer: w.kind, site: siteOf(w.site) }
}
const pairs = (list: readonly object[]) =>
	list.flatMap((x: { part?: unknown; id?: unknown }) =>
		"part" in x ? [[x.part, typeof x.id === "string" ? x.id : null]] : []
	)
function callShown(c: Call) {
	return plain({
		n: c.n,
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
		end: r.end,
		...r.error !== undefined && { error: message(r.error) },
		writes: pairs(r.writes),
		...(r as Run & { held?: unknown }).held !== undefined && {
			held: (r as Run & { held?: unknown }).held,
		},
	})

function siteOf(at: { file: string; function?: string } | undefined): string {
	if (at === undefined) return "none"
	if (at.file === import.meta.url) return at.function === "define" ? "computer" : "program"
	if (OURS.includes(at.file)) return "api"
	return "other"
}

// the harness's later calls, run till none is asked for
function drain() {
	const later = world().later
	while (later.length) later.shift()!()
}

// a setup from the request: the program's steps with its api
function code(r: Request) {
	const steps = (r.program ?? []) as Step[]
	// a setup is given nothing: its program calls @ermine/system's functions, found from the scope
	// open
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

// a path from the root, as a key: "/a/b"
const rooted = (p: string | readonly string[]) =>
	"/" + (typeof p === "string" ? p.split("/") : p).filter((n) => n !== "").join("/")

function start(r: Request): Record<string, unknown> {
	const m = world()
	m.next = `proc:${r.name}`
	m.pending = r.name
	m.running.set(r.name, { started: undefined as never, env: new Map() })
	try {
		const box = r.box === undefined ? undefined : m.boxes.get(r.box)!
		const where = r.program ?? [...box?.at ?? [], ...String(r.at).split("/")]
		const program = m.programs.get(rooted(where))
		if (program === undefined) throw new Error(`no program made at ${rooted(where)}`)
		const s = m.ermine.start(program, r.at, {
			...box !== undefined && { box },
			...r.args !== undefined && { args: r.args },
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
			return { features: e.features }
		case "late":
			late.get(r.feature)!()
			return {}
		case "uuid": {
			const id = get(e.places, r.path)
			const v7 = typeof id === "string" &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
			return { v7 }
		}
		case "node":
			return { id: e.node, attributes: plain(e.table.get("attributes", e.node)?.value) }
		case "context": {
			const p = r.process === undefined ? undefined : m.running.get(r.process)?.started.process
			const o = e.getProcessContext(p as Process | undefined)
			if (o === undefined) return {}
			return {
				at: o.at,
				folder: o.folder,
				args: o.args,
				...o.process && { process: o.process.id },
				scope: o.scope.info[NODE] === e.node ? "host" : o.process ? "process" : "other",
			}
		}
		case "o": {
			const p = r.process === undefined ? undefined : m.running.get(r.process)?.started.process
			const o = e.getProcessContext(p as Process | undefined)!
			const [fn, ...a] = r.call as [string, ...unknown[]]
			// within: true, the call made with the context's scope opened (as feature code acting as a
			// process does: a process's context with nothing open throws nothing-open)
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
		case "box":
			m.boxes.set(r.name, m.hostSys.createBox(r.at))
			m.boxIds.set(r.name, get(e.places, inside(r.at)) as Id)
			return {}
		case "boxplace": {
			const b = m.boxes.get(r.name)!
			b.place(r.at, r.id !== undefined ? e.handleOf({ id: r.id, part: "value" }) : r.path)
			return {}
		}
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
		case "service":
			if (r.what !== "land") throw new Error(`no service ${r.what}`)
			m.hostSys.createAction(r.at, land(e))
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
					box: x.box,
				})),
			}
		case "slot": {
			const p = m.running.get(r.process)?.started.process
			const v = m.slots.get(r.feature)?.(e.getProcessContext(p))
			return v === undefined ? {} : { value: v }
		}
		case "do": {
			// the process doing it: its scope opened (its imported functions find it)
			const p = m.running.get(r.process)
			if (p?.api === undefined) throw new Error(`no process ${r.process}`)
			const context = e.getProcessContext(p.started.process)
			if (context === undefined) throw new Error(`process ${r.process} stopped`)
			const v = context.within(() => call(p.api!, p.env, r.call))
			if (r.as !== undefined) p.env.set(r.as, v)
			return v === undefined ? {} : { value: plain(v) }
		}
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
		case "metadata": {
			const c = e.table.get(r.part as Key, r.id)?.change
			const md = c?.metadata ?? {}
			return {
				keys: Object.keys(md).sort(),
				...NODE in md && { node: md[NODE] },
				..."features" in md && { features: md.features },
				..."call" in md && { call: md.call },
				..."handler" in md && { handler: md.handler },
				..."caller" in md && { caller: (md.caller as { node?: unknown })?.node },
			}
		}
		// a call's change's caller: its node and actor
		case "caller": {
			const md = e.table.get(r.part as Key, r.id)?.change?.metadata ?? {}
			return "caller" in md ? plain(md.caller) as Record<string, unknown> : {}
		}
		case "site":
			return { site: siteOf(e.table.get(r.part as Key, r.id)?.change?.external?.[0]) }
		default:
			throw new Error(`no op ${r.op}`)
	}
}

named.set("patchy", patchy)
named.set("inline", inline)
libraries.set(
	"createPatch",
	(env, raw) =>
		createPatch(raw[0] as string, arg(env, raw[1]) as never, arg(env, raw[2]) as never),
)
libraries.set("layers", (env, raw) => layers(arg(env, raw[0]) as never, (raw[1] ?? []) as never))

// the harness on stdin and stdout
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
