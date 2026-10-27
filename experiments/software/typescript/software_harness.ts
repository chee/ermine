// software_harness: software (software.ts) on the line protocol, one JSON request per line in, one
// answer per line out. one world: a scheduler, table, paths and places (root "R"; contributors
// [processes(R), children]), scope nodes, the host's scope { actor: "host" }, and a session: a
// process at /system/session the host started with processes of its own (its body nothing), the
// owner of what is offered with no by. software made over it, its scope the host's, its pulses
// asked for (setup.schedule) held, run by later. names in answers (and taken back in requests): the
// session "session", a process "proc:<its name>", a place by its name, a derived id its longest
// named prefix and the rest (session/runners/javascript); any other id as it is. a value's strings
// are taken back too, so a path inside one is written as a string ("/system/session/..."), never
// a list holding "session". a PlacesError: { error: code }
// live runners, each given the start's facts:
//   record   a function, its start: its run { process, code, args, folder, root, keys, open } (code a
//            function: { live: true }; root: the root of the places it was started in (R, or its
//            box's: the harness notes it, the start has none); keys: the start's, sorted; open: its
//            scope the one open); its stop { process, reason } (reason null: none); its load
//            { by, code, folder, open } (by: the start's process id), its live form's dispose
//            { by, code }
//   object   record's start and load as a map's own { start, load }, not a function
//   boom     throws Error("boom"), its load too
//   quiet    its run recorded as record's; gives back {} (no stop); no load
//   late     its run recorded as record's; gives back a promise of record's handle, settled by land
//   spawn    its run recorded as record's, then, with the code a map { name, runner, program, at },
//            run(runner, program, at), its process named name; record's handle
//   teller   its stop(reason) records { process, why } (none given: "ended", as a process's
//            teardowns are told); no load
// every runner's event, besides, in one list (order): ["ran", process], ["stopped", process,
// reason], ["loaded", by, code], ["unloaded", by, code], ["told", process, why]
//
// world
// { op: "kids" | "attrs" | "value", id, value?, live? } -> {}   that entry replaced (JSON form), the
//    host's scope open; live (value only): a live runner by its name; neither: taken out
// { op: "create", name, folder }                     -> {}   a box over the folder's id
// { op: "place", name, id, at, stored? }             -> {}   a place { id, at, scope, stored }, its
//    scope { place: name } under the host's; named name
// { op: "close-place", name? }                       -> {}   a scope torn down: a place's; a
//    process's own, alone; "host": the host's; none: the session's
// software, each call the host's scope open, or a scope { actor } under it (actor), or none (bare)
// { op: "offer", kind, name, attrs?, live?, by? }    -> { id, at } | { refused, at }
//    by: a place's name, a process's name; none: the session
// { op: "withdraw", id }                             -> {}
// { op: "run", name, runner, program, at, args?, folder?, box?, pin?, actor? } -> { id, at } | refusal
//    runner: an address, or carried { id, live } (live: a runner's name, else its JSON value as
//    it is); at: an address; program: an address or { id, hash?, type?, api?, code?, build? }
//    (build { from }: the code is the value at from, read tracked: none, PENDING; { fail }, an
//    Error of fail thrown); the process named name
// { op: "stop", name, reason?, actor? }              -> {}   name: a process's name; "session"
// { op: "load", name, runner, program, by?, box?, chain?, actor?, bare? } -> {} | refusal | { failed }
//    the load named name; runner as run's; by as offer's; chain: the keys given (strings); failed:
//    what the load threw, its message
// { op: "release", name }                            -> {}   the load named name let go
// { op: "land", fail? }                              -> {}   the oldest late handle not landed:
//    given (fail: rejected with Error("late")); then the promises settled
// { op: "later" }                                    -> { pulses }   the pulses asked for run, and
//    how many
// { op: "pulse" }                                    -> {}
// reads, outside any run, untracked (places.peep)
// { op: "here", path, box? }                         -> { id }   null: nothing
// { op: "list", path, box? }                         -> { names }
// { op: "node", id }                                 -> { parts, attributes, status, children, live }
//    parts sorted; attributes without the status (null: no entry); status "pending" | { failed }
//    | null (PENDING, an Error, none; any other value: { raw: it }); children (null: no entry);
//    live: its value is a function
// { op: "site", id, part? }                          -> { harness }   whether the entry (none:
//    attributes) was last written with this file as its site
// { op: "raw", name }                                -> { id }   the id a name stands for, as it is
// { op: "running" }                                  -> { running }   running()'s ids, in order
// { op: "offers" }                                   -> { offers }   offers(), in order
// { op: "runs" }                                     -> { runs, stops }   in order
// { op: "loads" }                                    -> { loads, unloads }   in order
// { op: "told" }                                     -> { told }   teller's teardowns, in order
// { op: "order" }                                    -> { order }   every runner's event, in order
import createEntry from "@ermine/core/node/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/core/scheduler"
import type { Id, Key } from "@ermine/core/table"
import { type Places, PlacesError } from "@ermine/core/places"
import { get, list } from "@ermine/core/places/lib"
import { createChangeHeader } from "@ermine/core/places/header"
import { STATUS, TABLE as STATUS_TABLE } from "@ermine/core/places/status"
import { type Box, createBox } from "@ermine/boxes"
import { createErmine } from "@ermine/system"
import { idAt, PROCESS } from "@ermine/processes"
import { type Address, createProcesses, type Process } from "@ermine/processes/start"
import { createScopeNodes } from "@ermine/processes/scopes"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import {
	type Carried,
	createSoftware,
	type Handle,
	type Loaded,
	type Place,
	type Program,
	type Refused,
	type Runnable,
	type Start,
} from "./software.ts"

type Json = unknown

// the world
const s = createScheduler()
const ermine = createErmine({ scheduler: s, root: "R", info: { actor: "host" } })
const { table, places } = ermine
const scopes = createScopeNodes({ scheduler: s, table })
const host = ermine.within(() => s.getCurrentScope()!)
const hostProcesses = createProcesses({ scheduler: s, table, places, scopes, owner: host })
const made = s.runWithScope(
	host,
	() => hostProcesses.start(places, "/system/session", {}, () => {}),
)
if ("refused" in made) throw new Error("no session")
const session: Process = made
// the pulses software asked for, not yet run
const asked: (() => void)[] = []
const software = createSoftware({
	scheduler: s,
	table,
	places,
	scopes,
	scope: host,
	schedule: (f) => void asked.push(f),
})

const boxes = new Map<string, Box>()
// the root of the places software started a process in: where its row is (the process part of
// that root holds it at its path), as software wrote it; read as the runner starts
const rootOf = (process: Process): Id | undefined =>
	[places.root, ...[...boxes.values()].map((b) => b.root)].find((root) =>
		idAt(table.get(PROCESS, root)?.value, process.at) === process.id
	)
const placed = new Map<string, Place>()
const procs = new Map<string, Process>()
const held = new Map<string, Loaded>()

// names: an id as answers show it, and back
const shown = new Map<Id, string>()
const known = new Map<string, Id>()
const name = (id: Id, as: string) => {
	shown.set(id, as)
	known.set(as, id)
}
name(session.id, "session")

// a string as shown: a named id, or a derived one (its longest named prefix and the rest)
function show(v: string): string {
	const named = shown.get(v)
	if (named !== undefined) return named
	for (let i = v.lastIndexOf("/"); i > 0; i = v.lastIndexOf("/", i - 1)) {
		const owner = shown.get(v.slice(0, i))
		if (owner !== undefined) return owner + v.slice(i)
	}
	return v
}

// a string taken back: a name's id, or a derived one's
function take(v: string): Id {
	const id = known.get(v)
	if (id !== undefined) return id
	for (let i = v.lastIndexOf("/"); i > 0; i = v.lastIndexOf("/", i - 1)) {
		const owner = known.get(v.slice(0, i))
		if (owner !== undefined) return `${String(owner)}${v.slice(i)}`
	}
	return v
}

// an answer as JSON: ids by name, bytes and numbers in their JSON form
function plain(x: unknown): Json {
	return JSON.parse(
		JSON.stringify(x ?? null, (_, v) => {
			if (v instanceof Uint8Array) return toJson(v)
			if (typeof v === "number" || typeof v === "bigint") return toJson(v)
			if (typeof v === "string") return show(v)
			return v
		}),
	)
}

// a request's value: its JSON form read, names taken back
function back(x: unknown): unknown {
	const walk = (y: unknown): unknown => {
		if (typeof y === "string") return take(y)
		if (Array.isArray(y)) return y.map(walk)
		if (typeof y === "object" && y !== null && Object.getPrototypeOf(y) === Object.prototype) {
			return Object.fromEntries(Object.entries(y).map(([k, z]) => [k, walk(z)]))
		}
		return y
	}
	return walk(fromJson(x))
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// a status as answers show it
function status(v: unknown): Json {
	if (v === undefined) return null
	if (v === PENDING) return "pending"
	if (v instanceof Error) return { failed: v.message }
	return { raw: plain(v) }
}

// what the runners did, in order
const ran: Json[] = []
const stops: Json[] = []
const loads: Json[] = []
const unloads: Json[] = []
const told: Json[] = []
const order: Json[] = []

// a run recorded, and record's handle
function noted(code: unknown, start: Start) {
	const { process } = start
	ran.push({
		process: process.id,
		code: typeof code === "function" ? { live: true } : code,
		args: start.args,
		folder: start.folder,
		root: rootOf(process) ?? null,
		keys: Object.keys(start).sort(),
		open: s.getCurrentScope() === start.scope,
	})
	order.push(["ran", process.id])
}
function handle(start: Start): Handle {
	const id = start.process.id
	return {
		stop: (reason?: unknown) => {
			stops.push({ process: id, reason: reason ?? null })
			order.push(["stopped", id, reason ?? null])
		},
	}
}
function recordStart(code: unknown, start: Start): Handle {
	noted(code, start)
	return handle(start)
}
function recordLoad(code: unknown, start: Start) {
	const by = start.process.id
	loads.push({ by, code, folder: start.folder, open: s.getCurrentScope() === start.scope })
	order.push(["loaded", by, code])
	return {
		[Symbol.dispose]: () => {
			unloads.push({ by, code })
			order.push(["unloaded", by, code])
		},
	}
}

const record: Runnable = Object.assign(
	(code: unknown, start: Start) => recordStart(code, start),
	{ load: recordLoad },
)
const object = { start: recordStart, load: recordLoad }
const boom: Runnable = Object.assign(() => {
	throw new Error("boom")
}, {
	load: () => {
		throw new Error("boom")
	},
})
const quiet: Runnable = (code, start) => {
	noted(code, start)
	return {} as Handle
}
// the late handles not landed, oldest first
const landing: { start: Start; resolve: (h: Handle) => void; reject: (e: unknown) => void }[] = []
const late: Runnable = (code, start) => {
	noted(code, start)
	return new Promise<Handle>((resolve, reject) => void landing.push({ start, resolve, reject }))
}
const spawn: Runnable = (code, start) => {
	noted(code, start)
	if (isMap(code)) {
		const p = software.run(
			code.runner as Address,
			programOf(code.program),
			code.at as Address,
		)
		if (!("refused" in p)) named(p, code.name)
	}
	return handle(start)
}

// the program one whose stop(reason) is told, as a process's teardowns are: none given, ended
const teller: Runnable = (_code, start): Handle => ({
	stop: (reason?: unknown) => {
		const why = reason ?? "ended"
		told.push({ process: start.process.id, why })
		order.push(["told", start.process.id, why])
	},
})

const runners: Record<string, unknown> = { record, object, boom, quiet, late, spawn, teller }
function live(kind: unknown): unknown {
	if (kind === undefined) return undefined
	if (!Object.hasOwn(runners, String(kind))) throw new Error(`no runner ${kind}`)
	return runners[String(kind)]
}

// f with the host's scope open, or a scope { actor } under it, or none
function hosted<T>(f: () => T, actor?: unknown, bare?: boolean): T {
	if (bare === true) return f()
	if (actor === undefined) return s.runWithScope(host, f)
	const o = s.createScope({ actor }, host)
	try {
		return s.runWithScope(o, f)
	} finally {
		s.teardown(o)
	}
}

const boxOf = (name: unknown): Box => {
	const b = boxes.get(name as string)
	if (b === undefined) throw new Error(`no box ${name}`)
	return b
}
const placesOf = (box: unknown): Places => box === undefined ? places : boxOf(box).places

// a process by its name
function procOf(name: unknown): Process {
	const p = procs.get(String(name))
	if (p === undefined) throw new Error(`no process ${name}`)
	return p
}

// an owner by its name: a place's, a process's; none: the session
function byOf(name: unknown): Place {
	if (name === undefined) return session
	return placed.get(String(name)) ?? procOf(name)
}

// a request's runner: an address as it is, else carried, its live a runner by name or a value
function runnerOf(r: unknown): Address | Carried {
	if (typeof r === "string" || Array.isArray(r)) return r as Address
	if (!isMap(r)) throw new Error("a runner: an address or { id, live }")
	const named = typeof r.live === "string" && Object.hasOwn(runners, r.live)
	return { id: take(String(r.id)), live: (named ? live(r.live) : fromJson(r.live)) as Runnable }
}

// a build of the value at an id: read tracked; none, PENDING; { fail }, an Error thrown
function buildOf(b: unknown): () => unknown {
	if (!isMap(b) || typeof b.from !== "string") throw new Error("a build: { from }")
	const from = take(b.from)
	return () => {
		const v = places.readValue("value", from)
		if (v === undefined) return PENDING
		if (isMap(v) && typeof v.fail === "string") throw new Error(v.fail)
		return v
	}
}

// a request's program: an address as it is, else a Program, its names taken back
function programOf(p: unknown): Address | Program {
	if (typeof p === "string" || Array.isArray(p)) return p as Address
	if (!isMap(p)) throw new Error("a program: an address or { id, ... }")
	const out: Record<string, unknown> = { id: take(String(p.id)) }
	for (const k of ["hash", "type", "api"]) if (p[k] !== undefined) out[k] = p[k]
	if (p.code !== undefined) out.code = fromJson(p.code)
	if (p.build !== undefined) out.build = buildOf(p.build)
	return out as Program
}

// a process made: named
function named(p: Process, as: unknown) {
	if (as === undefined) return
	name(p.id, `proc:${as}`)
	procs.set(String(as), p)
}

function entry(part: Key, r: Request) {
	const id = take(String(r.id))
	hosted(() => {
		if (part === "value" && r.live !== undefined) {
			table.sub(part, id, createEntry(live(r.live) as never, createChangeHeader(s)))
		} else if (!("value" in r)) {
			if (table.get(part, id) !== undefined) table.del(part, id)
		} else table.sub(part, id, createEntry(back(r.value) as never, createChangeHeader(s)))
	})
	return {}
}

// the promises settled: a turn of the loop
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function answer(r: Request): Promise<Json> {
	switch (r.op) {
		case "kids":
			return entry("children", r)
		case "attrs":
			return entry("attributes", r)
		case "value":
			return entry("value", r)
		case "create": {
			const b = hosted(() => createBox(ermine, { id: take(r.folder) }))
			boxes.set(r.name, b)
			return {}
		}
		case "place": {
			const scope = s.createScope({ place: r.name }, host)
			const id = take(String(r.id))
			placed.set(r.name, { id, at: r.at, scope, ...(r.stored ? { stored: true } : {}) })
			name(id, r.name)
			return {}
		}
		case "close-place": {
			let scope: Scope
			if (r.name === undefined) scope = session.scope
			else if (r.name === "host") scope = host
			else scope = byOf(r.name).scope
			s.teardown(scope)
			return {}
		}
		case "offer": {
			const by = byOf(r.by)
			const attrs = r.attrs === undefined ? undefined : back(r.attrs) as Record<string, unknown>
			const made = hosted(() => software.offer(by, r.kind, r.name, attrs, live(r.live)))
			return plain("refused" in made ? made : { id: made.id, at: made.at })
		}
		case "withdraw":
			hosted(() => software.withdraw(take(String(r.id))))
			return {}
		case "run": {
			const options = {
				...(r.args === undefined ? {} : { args: r.args }),
				...(r.folder === undefined ? {} : { folder: r.folder }),
				...(r.box === undefined ? {} : { places: boxOf(r.box).places }),
				...(r.pin === undefined ? {} : { pin: back(r.pin) }),
			}
			const made = hosted(
				() => software.run(runnerOf(r.runner), programOf(r.program), r.at, options),
				r.actor,
			)
			if ("refused" in made) return plain(made)
			named(made, r.name)
			return plain({ id: made.id, at: made.at })
		}
		case "stop": {
			const id = r.name === "session" ? session.id : procOf(r.name).id
			const reason = r.reason === undefined ? undefined : back(r.reason)
			hosted(() => software.stop(id, reason), r.actor)
			return {}
		}
		case "load": {
			const options = {
				by: byOf(r.by),
				...(r.box === undefined ? {} : { places: boxOf(r.box).places }),
				...(r.chain === undefined ? {} : { chain: r.chain as string[] }),
			}
			let made: Loaded | Refused
			try {
				made = hosted(
					() => software.load(runnerOf(r.runner), programOf(r.program), options),
					r.actor,
					r.bare,
				)
			} catch (e) {
				if (e instanceof PlacesError || !(e instanceof Error)) throw e
				return { failed: e.message }
			}
			if ("refused" in made) return plain(made)
			held.set(r.name, made)
			return {}
		}
		case "release": {
			const l = held.get(r.name)
			if (l === undefined) throw new Error(`no load ${r.name}`)
			hosted(() => l.release())
			return {}
		}
		case "land": {
			const l = landing.shift()
			if (l === undefined) throw new Error("no late handle")
			if (r.fail === true) l.reject(new Error("late"))
			else l.resolve(handle(l.start))
			await settled()
			return {}
		}
		case "later": {
			const fs = asked.splice(0)
			for (const f of fs) f()
			return { pulses: fs.length }
		}
		case "pulse":
			s.pulse()
			return {}
		case "here": {
			const p = placesOf(r.box)
			return { id: plain(p.peep(() => get(p, r.path)) ?? null) }
		}
		case "list": {
			const p = placesOf(r.box)
			return { names: p.peep(() => [...list(p, r.path)]) }
		}
		case "node": {
			const id = take(String(r.id))
			const parts = table.get(id).map(([k]) => k).sort()
			const a = table.get("attributes", id)
			// its status: the status table's (places' status.ts), not its attributes
			const st = table.get(STATUS_TABLE, id)
			const attributes: Json = a === undefined ? null : plain(isMap(a.value) ? a.value : {})
			const state: Json = st === undefined
				? null
				: status(isMap(st.value) ? st.value[STATUS] : undefined)
			const c = table.get("children", id)
			return {
				parts,
				attributes,
				status: state,
				children: c === undefined ? null : plain(c.value),
				live: typeof table.get("value", id)?.value === "function",
			}
		}
		case "site": {
			// the files differ by harness, so only yes or no
			const e = table.get(r.part ?? "attributes", take(String(r.id)))
			return { harness: e?.change.external?.[0]?.file === import.meta.url }
		}
		case "raw":
			return { id: String(take(String(r.name))) }
		case "running":
			return { running: plain(places.peep(() => software.running().map((p) => p.id))) }
		case "offers":
			return { offers: plain(places.peep(() => software.offers())) }
		case "runs":
			return { runs: plain(ran), stops: plain(stops) }
		case "loads":
			return { loads: plain(loads), unloads: plain(unloads) }
		case "told":
			return { told: plain(told) }
		case "order":
			return { order: plain(order) }
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	await serve(async (r) => {
		try {
			return await answer(r) as Record<string, unknown>
		} catch (e) {
			if (e instanceof PlacesError) return { error: e.code }
			throw e
		}
	})
}
