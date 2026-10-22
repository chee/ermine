// dens_harness: dens (dens.ts) and away (away.ts) on the line protocol, one JSON request per line
// in, one answer per line out. two devices, "mac" and "card" (dev; none: "mac"), each its own
// scheduler, table, paths, places (root "R" unless root said; contributors [processes(root),
// away(root), children]), scope nodes, host scope { actor: <dev> }; one clock (ms, from 0) only now
// moves; an in-memory channel pair (presence's createPair) named "mac" and "card", made at the
// first connect. names in answers (and taken back in requests): a den's node "den:<den id>", a
// process "proc:<its name>", a derived id its longest named owner and the rest (den:mac/runners/javascript);
// any other id as it is. a PlacesError: { error: code }. live runners, each a function (its start)
// given the start's facts: record (its run { dev, process, code, args, keys }, keys those of the
// api it makes from them, { den: den.id, places, process }; its stop { dev, process, reason },
// reason null: none; its load { dev, by, code }, by the process loading, its live form's dispose
// { dev, by, code }), boom (throws Error("boom"), its load too), teller (ermine/api's run over the
// device's context, a program whose teardown records { dev, process, why }; no load). the policy
// "grants": protect's grants({ part: "value", id: "rules" }), every ask recorded { op, who: { actor,
// reader?, device? }, part?, id, path? }. a den's pulses asked for (setup.schedule) are held, run
// by later
//
// world
// { op: "root", dev?, root }                         -> {}   before the device's first other line
// { op: "kids" | "attrs" | "value", dev?, id, value? } -> {}   that entry replaced (JSON form), the
//    host's scope open; no value: taken out
// { op: "create", dev?, name, folder }               -> {}   a box over the folder's id
// { op: "now", t }                                   -> {}
// the den
// { op: "den", dev?, id?, name?, device?, policy?, install? } -> { id }   createDen, the host's
//    scope open; id none: dev; policy "grants" | none; install: the install's id (none: none given).
//    its session's process named "session:<den id>"
// { op: "offer", dev?, kind, name, attrs?, live?, by? } -> { id, at } | { refused, ... }
//    live "record" | "boom" | "teller" | none; by: a process's name
// { op: "withdraw", dev?, id }                       -> {}
// { op: "start", dev?, name, runner, program, at, args?, cwd?, box?, pin?, actor? }
//    -> { id, at } | refusal. runner, at: addresses; program: an address or { id, hash?, type?,
//    api?, code? }; actor: a scope { actor } under the host's, open for the call
// { op: "stop", dev?, name, reason?, actor? }        -> {} | refusal   name "den": the den's own
// { op: "load", dev?, name, runner, program, by?, box?, actor? } -> {} | refusal | { failed }
//    the load named name; by: a process's name ("den": the den's own; none: the den); failed: what
//    the load threw, its message
// { op: "release", dev?, name }                      -> {}   the load named name let go
// { op: "later", dev? }                              -> { pulses }   the pulses the den asked for
//    run, and how many
// { op: "ask", dev?, ask: "start", name, who, runner, program, at, args?, cwd? } -> the answer
// { op: "ask", dev?, ask: "stop", who, process, reason? }   -> the answer   process: a name or id
// { op: "write-ask", dev?, as, den?, ask: "start", who, runner, program, at, args?, cwd? }
// { op: "write-ask", dev?, as, den?, ask: "stop", who, process, reason? }
//    -> { id }   asks' ask, written in the graph with the host's scope open, the ask named "ask:<as>";
//    den: a den's node by name (none: the device's den's)
// { op: "answered", dev?, as?, id?, name? } -> { answer }   asks' answer to the ask named as (or
//    at id); null: none yet. name: what a process it started is named (proc:<name>)
// { op: "raw", name }                -> { id }   the id a name stands for, as it is
// { op: "send", dev?, path, body, actor? }           -> what the method there gave (body's name:
//    the process's; process: by name)
// { op: "close", dev?, reason? }                     -> {}
// { op: "pulse", dev? }                              -> {}
// { op: "settle" }                                   -> {}   mac, card, mac, card, mac, card pulsed
//    (those made)
// reads, outside any run, untracked (places.peep)
// { op: "here", dev?, path, box? }                   -> { id }   null: nothing
// { op: "list", dev?, path, box? }                   -> { names }
// { op: "node", dev?, id }                           -> { parts, attributes, status, children, live }
//    parts sorted; attributes without the status (null: no entry); status "pending" | { failed }
//    | null (PENDING, an Error, none; any other value: { raw: it }); children (null: no entry);
//    live: its value is a function
// { op: "runs" }                                     -> { runs, stops }   every device's, in order
// { op: "loads" }                                    -> { loads, unloads }   every device's, in order
// { op: "told" }                                     -> { told }   teller's teardowns, in order
// { op: "asked", dev? }                              -> { asks }   since the last asked
// other dens
// { op: "connect", dev?, topic?, under?, publish?, processes?, ttl? } -> {}   connect, the host's
//    scope open, the device's channel; ttl none: 10000; now: the clock
// { op: "announce" | "beat" | "disconnect", dev? }    -> {}   disconnect: the link's stop, and the
//    link gone (C: dn_link_free at once, the den running)
// { op: "sweep", dev? }                              -> { swept: [{ anchor, who }] }
// { op: "remote", dev?, to, ask: "start", name, runner, program, code?, at, args?, cwd?, actor? }
//    -> { n }   program: an address on dev (carry, with code when code is true) or { id, ... }
// { op: "remote", dev?, to, ask: "stop", process, reason?, actor? } -> { n }   process: a name or id
// { op: "answer", dev?, n }                          -> { answer }   null: none yet
// { op: "forge", dev?, value, ttl? }                 -> {}   setPresence of value (names taken back,
//    keys too) as the device's channel name at its link's anchor, its den bypassed; ttl none: 10000
// { op: "say", dev?, to, message }                   -> {}   message (names taken back) as CBOR on
//    the device's channel at "<its link's anchor>/ask/<to>", its link bypassed
// a remote start's process is named from its answer, as start's is
import createEntry from "@ermine/node/entry"
import { createScheduler, PENDING, type Scheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key, type Table } from "@ermine/table"
import { children, createPlaces, type Places, PlacesError } from "@ermine/places"
import { get, list } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { type Address, type Box, createBox } from "@ermine/boxes"
import { processes } from "@ermine/processes"
import { createScopeNodes, type ScopeNodes } from "@ermine/processes/scopes"
import { type Ask, grants, type Policy } from "@ermine/protect"
import { encode, type Value } from "@ermine/encoding/cbor"
import { setPresence } from "@ermine/together/presence"
import { type Channel, createPair } from "@ermine/together/presence/channel"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { type API, createProcessContext, type ProcessContext } from "@ermine/api"
import {
	createDen,
	type Den,
	type Loaded,
	type Program,
	type Refused,
	type Runnable,
	type Runner,
	type Start,
} from "./dens.ts"
import { away, connect, type Link, type Options, type Remote } from "./away.ts"
import { answer as answerOf, type World, write as writeAsk } from "./asks.ts"

type Json = unknown

// a device: its world, its boxes by name, its den and its link, the asks its policy was asked
type Device = {
	readonly name: string
	readonly s: Scheduler
	readonly table: Table
	readonly places: Places
	readonly scopes: ScopeNodes
	readonly host: Scope
	readonly boxes: Map<string, Box>
	den?: Den
	link?: Link
	asks: Json[]
	// the pulses its den asked for, not yet run; its loads by name; teller's context
	asked: (() => void)[]
	loads: Map<string, Loaded>
	context?: ProcessContext
}

const clock = { t: 0 }
const roots = new Map<string, Id>()
const devices = new Map<string, Device>()

function device(name: string): Device {
	const root = roots.get(name) ?? "R"
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({
		root,
		table,
		paths,
		scheduler: s,
		contributors: [processes(root), away(root), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: name })
	return {
		name,
		s,
		table,
		places,
		scopes,
		host,
		boxes: new Map(),
		asks: [],
		asked: [],
		loads: new Map(),
	}
}

const dev = (r: Request): Device => {
	const name: string = r.dev ?? "mac"
	if (name !== "mac" && name !== "card") throw new Error(`no device ${name}`)
	let d = devices.get(name)
	if (d === undefined) devices.set(name, d = device(name))
	return d
}

const denOf = (d: Device): Den => {
	if (d.den === undefined) throw new Error(`no den on ${d.name}`)
	return d.den
}

const linkOf = (d: Device): Link => {
	if (d.link === undefined) throw new Error(`no link on ${d.name}`)
	return d.link
}

// the channel pair, made at the first connect: mac's, card's
let pair: { a: Channel; b: Channel } | undefined
function channelOf(d: Device): Channel {
	pair ??= createPair("mac", "card")
	return d.name === "mac" ? pair.a : pair.b
}

// names: an id as answers show it, and back
const shown = new Map<Id, string>()
const known = new Map<string, Id>()
const name = (id: Id, as: string) => {
	shown.set(id, as)
	known.set(as, id)
}

// a string as shown: a named id, or a derived one (its longest named owner and the rest)
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

// a request's value taken back, its keys too (a row's nodes are by id)
function backAll(x: unknown): unknown {
	const walk = (y: unknown): unknown => {
		if (typeof y === "string") return take(y)
		if (Array.isArray(y)) return y.map(walk)
		if (typeof y === "object" && y !== null && Object.getPrototypeOf(y) === Object.prototype) {
			return Object.fromEntries(
				Object.entries(y).map(([k, z]) => [String(take(k)), walk(z)]),
			)
		}
		return y
	}
	return walk(fromJson(x))
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
	const v = fromJson(x)
	const walk = (y: unknown): unknown => {
		if (typeof y === "string") return take(y)
		if (Array.isArray(y)) return y.map(walk)
		if (typeof y === "object" && y !== null && Object.getPrototypeOf(y) === Object.prototype) {
			return Object.fromEntries(Object.entries(y).map(([k, z]) => [k, walk(z)]))
		}
		return y
	}
	return walk(v)
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

// what the runners did, every device's, in order
const ran: Json[] = []
const stops: Json[] = []

const loads: Json[] = []
const unloads: Json[] = []
const told: Json[] = []

type Api = { den: string; places: Places; process: Start["process"] }

const record = (dev: string): Runnable =>
	Object.assign((code: unknown, start: Start) => {
		const api: Api = { den: start.den.id, places: start.places, process: start.process }
		const { process } = api
		ran.push({
			dev,
			process: process.id,
			code,
			args: process.args,
			keys: Object.keys(api).sort(),
		})
		return {
			stop: (reason?: unknown) =>
				void stops.push({ dev, process: process.id, reason: reason ?? null }),
		}
	}, {
		load: (code: unknown, start: Start) => {
			const by = start.process.id
			loads.push({ dev, by, code })
			return { [Symbol.dispose]: () => void unloads.push({ dev, by, code }) }
		},
	})
const boom: Runnable = Object.assign(() => {
	throw new Error("boom")
}, {
	load: () => {
		throw new Error("boom")
	},
})

// ermine/api's run, the program one whose teardown is recorded
function teller(d: Device): Runner["start"] {
	return (_code, start) => {
		d.context ??= createProcessContext({
			scheduler: d.s,
			table: d.table,
			commit: (changed) => d.places.commit(changed),
			host: { places: d.places, table: d.table, scheduler: d.s },
			schedule: () => {},
		})
		const program = (api: API) =>
			void api.teardown((why) => void told.push({ dev: d.name, process: start.process.id, why }))
		return d.context.run.start(program, start)
	}
}

function live(d: Device, kind: unknown): unknown {
	if (kind === undefined) return undefined
	if (kind === "record") return record(d.name)
	if (kind === "boom") return boom
	if (kind === "teller") return teller(d)
	throw new Error(`no runner ${kind}`)
}

// grants, each ask recorded on the device
function granted(d: Device): Policy {
	const g = grants({ part: "value", id: "rules" })
	return (ask: Ask, read) => {
		const who = isMap(ask.who) ? ask.who : {}
		const w: Record<string, unknown> = {}
		for (const k of ["actor", "reader", "device"]) if (who[k] !== undefined) w[k] = who[k]
		const asked: Record<string, unknown> = { op: ask.op, who: w }
		if (ask.target.part !== undefined) asked.part = ask.target.part
		asked.id = ask.target.id
		if (ask.target.path !== undefined) asked.path = [...ask.target.path]
		d.asks.push(asked)
		return g(ask, read)
	}
}

// the device as asks write in it: the host's scope
const worldOf = (d: Device): World => ({
	table: d.table,
	places: d.places,
	scheduler: d.s,
	scope: d.host,
})

// f with the host's scope open, or a scope { actor } under it
function hosted<T>(d: Device, f: () => T, actor?: unknown): T {
	if (actor === undefined) return d.s.runWithScope(d.host, f)
	const o = d.s.createScope({ actor }, d.host)
	try {
		return d.s.runWithScope(o, f)
	} finally {
		d.s.teardown(o)
	}
}

const boxOf = (d: Device, name: unknown): Box => {
	const b = d.boxes.get(name as string)
	if (b === undefined) throw new Error(`no box ${name}`)
	return b
}
const placesOf = (d: Device, box: unknown): Places =>
	box === undefined ? d.places : boxOf(d, box).places

// a process by its name; "den": the den's own
function processOf(d: Device, name: unknown): Id {
	if (name === "den") return denOf(d).node
	const id = known.get(`proc:${name}`)
	if (id === undefined) throw new Error(`no process ${name}`)
	return id
}

// a request's program: an address as it is, else a Program, its names taken back
function programOf(p: unknown): Address | Program {
	if (typeof p === "string" || Array.isArray(p)) return p as Address
	if (!isMap(p)) throw new Error("a program: an address or { id, ... }")
	const out: Record<string, unknown> = { id: take(String(p.id)) }
	for (const k of ["hash", "type", "api"]) if (p[k] !== undefined) out[k] = p[k]
	if (p.code !== undefined) out.code = fromJson(p.code)
	return out as Program
}

// a process by its name, else an id taken back
const processAt = (name: unknown): Id => known.get(`proc:${name}`) ?? take(String(name))

// the names remote starts are to give their processes, by device and n, until their answer lands
const naming = new Map<string, string>()
function named(d: Device, n: number) {
	const as = naming.get(`${d.name} ${n}`)
	const got: unknown = linkOf(d).answer(n)
	if (as === undefined || !isMap(got) || got.id === undefined) return
	naming.delete(`${d.name} ${n}`)
	name(got.id as Id, `proc:${as}`)
}

// what a start gave: its id named, shown as { id, at }; or the refusal
function started(r: unknown, as: unknown): Json {
	if (isMap(r) && "refused" in r) return plain(r)
	if (isMap(r) && r.id !== undefined && as !== undefined) name(r.id as Id, `proc:${as}`)
	return plain(isMap(r) && r.id !== undefined ? { id: r.id, at: r.at } : r)
}

function entry(d: Device, part: Key, r: Request) {
	const id = take(String(r.id))
	hosted(d, () => {
		if (!("value" in r)) {
			if (d.table.get(part, id) !== undefined) d.table.del(part, id)
		} else d.table.sub(part, id, createEntry(back(r.value) as never, createChangeHeader(d.s)))
	})
	return {}
}

function answer(r: Request): Json {
	switch (r.op) {
		case "root": {
			const n: string = r.dev ?? "mac"
			if (devices.has(n)) throw new Error(`${n} began already`)
			roots.set(n, r.root)
			return {}
		}
		case "kids":
			return entry(dev(r), "children", r)
		case "attrs":
			return entry(dev(r), "attributes", r)
		case "value":
			return entry(dev(r), "value", r)
		case "create": {
			const d = dev(r)
			const b = hosted(
				d,
				() =>
					createBox({ places: d.places, table: d.table, scheduler: d.s }, {
						id: take(r.folder),
					}),
			)
			d.boxes.set(r.name, b)
			return {}
		}
		case "now":
			clock.t = r.t
			return {}
		case "den": {
			const d = dev(r)
			const den = hosted(d, () =>
				createDen({
					scheduler: d.s,
					table: d.table,
					places: d.places,
					scopes: d.scopes,
					schedule: (f) => void d.asked.push(f),
					id: r.id ?? d.name,
					...(r.name === undefined ? {} : { name: r.name }),
					...(r.device === undefined ? {} : { device: back(r.device) }),
					...(r.policy === "grants" ? { may: granted(d) } : {}),
					...(r.install === undefined ? {} : { install: { id: r.install } }),
				}))
			d.den = den
			name(den.node, `den:${den.id}`)
			name(den.process.id, `session:${den.id}`)
			return plain({ id: den.node })
		}
		case "offer": {
			const d = dev(r)
			const den = denOf(d)
			const by = r.by === undefined ? undefined : processOf(d, r.by)
			const attrs = r.attrs === undefined ? undefined : back(r.attrs) as Record<string, unknown>
			const made = hosted(d, () => den.offer(r.kind, r.name, attrs, live(d, r.live), by))
			return plain("refused" in made ? made : { id: made.id, at: made.at })
		}
		case "withdraw": {
			const d = dev(r)
			hosted(d, () => denOf(d).withdraw(take(String(r.id))))
			return {}
		}
		case "start": {
			const d = dev(r)
			const den = denOf(d)
			const options = {
				...(r.args === undefined ? {} : { args: r.args }),
				...(r.cwd === undefined ? {} : { cwd: r.cwd }),
				...(r.box === undefined ? {} : { box: boxOf(d, r.box) }),
				...(r.pin === undefined ? {} : { pin: back(r.pin) }),
			}
			const made = hosted(
				d,
				() => den.start(r.runner, programOf(r.program), r.at, options),
				r.actor,
			)
			return started(made, r.name)
		}
		case "stop": {
			const d = dev(r)
			const id = processOf(d, r.name)
			const reason = r.reason === undefined ? undefined : back(r.reason)
			return plain(hosted(d, () => denOf(d).stop(id, reason), r.actor) ?? {})
		}
		case "load": {
			const d = dev(r)
			const den = denOf(d)
			const options = {
				...(r.by === undefined ? {} : { by: processOf(d, r.by) }),
				...(r.box === undefined ? {} : { box: boxOf(d, r.box) }),
			}
			let made: Loaded | Refused
			try {
				made = hosted(d, () => den.load(r.runner, programOf(r.program), options), r.actor)
			} catch (e) {
				if (e instanceof PlacesError || !(e instanceof Error)) throw e
				return { failed: e.message }
			}
			if ("refused" in made) return plain(made)
			d.loads.set(r.name, made)
			return {}
		}
		case "release": {
			const d = dev(r)
			const l = d.loads.get(r.name)
			if (l === undefined) throw new Error(`no load ${r.name}`)
			hosted(d, () => l.release())
			return {}
		}
		case "later": {
			const d = dev(r)
			const fs = d.asked.splice(0)
			for (const f of fs) f()
			return { pulses: fs.length }
		}
		case "ask": {
			const d = dev(r)
			const den = denOf(d)
			if (r.ask === "start") {
				const a = {
					op: "start" as const,
					who: back(r.who),
					runner: r.runner,
					program: programOf(r.program) as Program,
					at: r.at,
					...(r.args === undefined ? {} : { args: r.args }),
					...(r.cwd === undefined ? {} : { cwd: r.cwd }),
				}
				return started(hosted(d, () => den.ask(a)), r.name)
			}
			if (r.ask === "stop") {
				const id = processAt(r.process)
				const a = {
					op: "stop" as const,
					who: back(r.who),
					process: id,
					...(r.reason === undefined ? {} : { reason: back(r.reason) }),
				}
				return plain(hosted(d, () => den.ask(a)))
			}
			throw new Error(`no ask ${r.ask}`)
		}
		case "write-ask": {
			const d = dev(r)
			const den = r.den === undefined ? denOf(d).node : take(String(r.den))
			const a = r.ask === "start"
				? {
					op: "start" as const,
					who: back(r.who),
					runner: r.runner,
					program: programOf(r.program) as Program,
					at: r.at,
					...(r.args === undefined ? {} : { args: r.args }),
					...(r.cwd === undefined ? {} : { cwd: r.cwd }),
				}
				: {
					op: "stop" as const,
					who: back(r.who),
					process: processAt(r.process),
					...(r.reason === undefined ? {} : { reason: back(r.reason) }),
				}
			const id = writeAsk(worldOf(d), den, a)
			name(id, `ask:${r.as}`)
			return plain({ id })
		}
		case "answered": {
			const d = dev(r)
			const n = r.as === undefined ? take(String(r.id)) : take(`ask:${r.as}`)
			const got = d.places.peep(() => answerOf(worldOf(d), n))
			return { answer: got === undefined ? null : started(got, r.name) }
		}
		case "raw":
			return { id: String(take(String(r.name))) }
		case "send": {
			const d = dev(r)
			const id = d.places.peep(() => get(d.places, r.path))
			const fn = id === undefined ? undefined : d.table.get("value", id)?.value
			if (typeof fn !== "function") throw new Error(`no method at ${JSON.stringify(r.path)}`)
			const body = isMap(r.body) ? back(r.body) as Record<string, unknown> : {}
			if (typeof r.body?.process === "string") {
				body.process = known.get(`proc:${r.body.process}`) ?? take(r.body.process)
			}
			const got = hosted(d, () => fn(body), r.actor)
			return started(got, body.name)
		}
		case "close": {
			const d = dev(r)
			const reason = r.reason === undefined ? undefined : back(r.reason)
			hosted(d, () => denOf(d).close(reason))
			return {}
		}
		case "pulse":
			dev(r).s.pulse()
			return {}
		case "settle":
			for (let i = 0; i < 3; i++) {
				for (const n of ["mac", "card"]) devices.get(n)?.s.pulse()
			}
			return {}
		case "here": {
			const d = dev(r)
			const p = placesOf(d, r.box)
			return { id: plain(p.peep(() => get(p, r.path)) ?? null) }
		}
		case "list": {
			const d = dev(r)
			const p = placesOf(d, r.box)
			return { names: p.peep(() => [...list(p, r.path)]) }
		}
		case "node": {
			const d = dev(r)
			const id = take(String(r.id))
			const parts = d.table.get(id).map(([k]) => k).sort()
			const a = d.table.get("attributes", id)
			let attributes: Json = null, state: Json = null
			if (a !== undefined) {
				const { [STATUS]: was, ...rest } = isMap(a.value) ? a.value : {}
				attributes = plain(rest)
				state = status(was)
			}
			const c = d.table.get("children", id)
			return {
				parts,
				attributes,
				status: state,
				children: c === undefined ? null : plain(c.value),
				live: typeof d.table.get("value", id)?.value === "function",
			}
		}
		case "site": {
			// whether the entry at (part, id) (none: attributes) was last written with this file as its
			// site: the files differ by harness, so only yes or no
			const d = dev(r)
			const e = d.table.get(r.part ?? "attributes", take(String(r.id)))
			return { harness: e?.change.external?.[0]?.file === import.meta.url }
		}
		case "runs":
			return { runs: plain(ran), stops: plain(stops) }
		case "loads":
			return { loads: plain(loads), unloads: plain(unloads) }
		case "told":
			return { told: plain(told) }
		case "asked":
			return { asks: plain(dev(r).asks.splice(0)) }
		case "connect": {
			const d = dev(r)
			const options: Options = { ttl: r.ttl ?? 10000, now: () => clock.t }
			if (r.topic !== undefined) options.topic = take(String(r.topic))
			if (r.under !== undefined) options.under = r.under
			if (r.publish !== undefined) options.publish = r.publish
			if (r.processes !== undefined) options.processes = r.processes
			const den = denOf(d)
			d.link = hosted(d, () => connect(den, channelOf(d), options))
			return {}
		}
		case "announce":
			linkOf(dev(r)).announce()
			return {}
		case "beat":
			linkOf(dev(r)).beat()
			return {}
		case "disconnect": {
			const d = dev(r)
			linkOf(d).stop()
			d.link = undefined
			return {}
		}
		case "sweep":
			return { swept: plain(linkOf(dev(r)).sweep()) }
		case "remote": {
			const d = dev(r)
			const link = linkOf(d)
			let ask: Remote
			if (r.ask === "start") {
				const program = typeof r.program === "string" || Array.isArray(r.program)
					? link.carry(r.program, { code: r.code === true })
					: programOf(r.program) as Program
				ask = {
					op: "start",
					runner: r.runner,
					program,
					at: r.at,
					...(r.args === undefined ? {} : { args: r.args }),
					...(r.cwd === undefined ? {} : { cwd: r.cwd }),
				}
			} else if (r.ask === "stop") {
				ask = {
					op: "stop",
					process: processAt(r.process),
					...(r.reason === undefined ? {} : { reason: back(r.reason) }),
				}
			} else throw new Error(`no ask ${r.ask}`)
			const n = hosted(d, () => link.ask(r.to, ask), r.actor)
			if (r.ask === "start" && r.name !== undefined) naming.set(`${d.name} ${n}`, r.name)
			named(d, n)
			return { n }
		}
		case "answer": {
			const d = dev(r)
			named(d, r.n)
			return { answer: plain(linkOf(d).answer(r.n) ?? null) }
		}
		case "forge": {
			const d = dev(r)
			const link = linkOf(d)
			setPresence(link.world, link.anchor, channelOf(d).name, backAll(r.value), r.ttl ?? 10000)
			return {}
		}
		case "say": {
			const d = dev(r)
			channelOf(d).send(
				`${String(linkOf(d).anchor)}/ask/${r.to}`,
				encode(back(r.message) as Value),
			)
			return {}
		}
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	await serve((r) => {
		try {
			return answer(r) as Record<string, unknown>
		} catch (e) {
			if (e instanceof PlacesError) return { error: e.code }
			throw e
		}
	})
}
