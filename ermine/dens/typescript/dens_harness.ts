// dens_harness: dens (dens.ts) on the line protocol, one JSON request per line in, one answer per
// line out. two devices, "mac" and "card" (dev; none: "mac"), each its own scheduler, table,
// paths, places (root "R" unless root said; contributors [processes(root), away(root), children]),
// scope nodes, host scope { actor: <dev> }; one clock (ms, from 0) only now moves. names in answers
// (and taken back in requests): a den's node "den:<den id>", a process "proc:<its name>", a derived
// id its owner's name and the rest (den:mac/runners/javascript); any other id as it is. a
// PlacesError: { error: code }. live runners: record ({ dev, process, code, args, keys }; its stop
// { dev, process, reason }, reason null: none), boom (throws Error("boom")). createProcessAPI:
// { den: den.id, places, process }. the policy "grants": protect's grants({ part: "value", id:
// "rules" }), every ask recorded { op, who: { actor, reader?, device? }, part?, id, path? }
//
// world
// { op: "root", dev?, root }                         -> {}   before the device's first other line
// { op: "kids" | "attrs" | "value", dev?, id, value? } -> {}   that entry replaced (JSON form), the
//    host's scope open; no value: taken out
// { op: "create", dev?, name, folder }               -> {}   a box over the folder's id
// { op: "now", t }                                   -> {}
// the den
// { op: "den", dev?, id?, name?, device?, policy? }   -> { id }   createDen, the host's scope open;
//    id none: dev; policy "grants" | none
// { op: "offer", dev?, kind, name, attrs?, live?, by? } -> { id, at } | { refused, ... }
//    live "record" | "boom" | none; by: a process's name
// { op: "withdraw", dev?, id }                       -> {}
// { op: "start", dev?, name, runner, program, at, args?, cwd?, box?, pin?, actor? }
//    -> { id, at } | refusal. runner, at: addresses; program: an address or { id, hash?, type?,
//    api?, code? }; actor: a scope { actor } under the host's, open for the call
// { op: "stop", dev?, name, reason?, actor? }        -> {} | refusal   name "den": the den's own
// { op: "ask", dev?, ask: "start", name, who, runner, program, at, args?, cwd? } -> the answer
// { op: "ask", dev?, ask: "stop", who, process, reason? }   -> the answer   process: a name or id
// { op: "send", dev?, path, body, actor? }           -> what the method there gave (body's name:
//    the process's; process: by name)
// { op: "close", dev?, reason? }                     -> {}
// { op: "pulse", dev? }                              -> {}
// { op: "settle" }                                   -> {}   mac, card, mac, card, mac, card pulsed
// reads, outside any run, untracked (places.peep)
// { op: "here", dev?, path, box? }                   -> { id }   null: nothing
// { op: "list", dev?, path, box? }                   -> { names }
// { op: "node", dev?, id }                           -> { parts, attributes, status, children, live }
//    parts sorted; attributes without the status (null: no entry); status "pending" | { failed }
//    | null; children (null: no entry); live: its value is a function
// { op: "runs" }                                     -> { runs, stops }   every device's, in order
// { op: "asked", dev? }                              -> { asks }   since the last asked
//
// open: other dens (away.ts): connect, announce, beat, disconnect, sweep, remote, answer, forge,
// on the in-memory channel pair (presence's createPair) named "mac" and "card"
import createEntry from "@ermine/node/entry"
import { createScheduler, PENDING, type Scheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key, type Table } from "@ermine/table"
import { children, createPlaces, type Places, PlacesError } from "@ermine/places"
import { get, list } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { type Address, type Box, createBox } from "@ermine/boxes"
import { processes, trie } from "@ermine/processes"
import { createScopeNodes, type ScopeNodes } from "@ermine/processes/scopes"
import { type Ask, grants, type Policy } from "@ermine/protect"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { type Context, createDen, type Den, type Program, type Runner } from "./dens.ts"

type Json = unknown

// away.ts' part: other dens' rows, walked as processes' are
const AWAY = "away" as string as Key

// a device: its world, its boxes by name, its den, the asks its policy was asked
type Device = {
	readonly name: string
	readonly s: Scheduler
	readonly table: Table
	readonly places: Places
	readonly scopes: ScopeNodes
	readonly host: Scope
	readonly boxes: Map<string, Box>
	den?: Den
	asks: Json[]
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
		contributors: [processes(root), trie(AWAY, root, "away"), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: name })
	return { name, s, table, places, scopes, host, boxes: new Map(), asks: [] }
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

// names: an id as answers show it, and back
const shown = new Map<Id, string>()
const known = new Map<string, Id>()
const name = (id: Id, as: string) => {
	shown.set(id, as)
	known.set(as, id)
}

// a string as shown: a named id, or a derived one (its owner's name and the rest)
function show(v: string): string {
	const named = shown.get(v)
	if (named !== undefined) return named
	const i = v.indexOf("/")
	const owner = i > 0 ? shown.get(v.slice(0, i)) : undefined
	return owner === undefined ? v : owner + v.slice(i)
}

// a string taken back: a name's id, or a derived one's
function take(v: string): Id {
	const id = known.get(v)
	if (id !== undefined) return id
	const i = v.indexOf("/")
	const owner = i > 0 ? known.get(v.slice(0, i)) : undefined
	return owner === undefined ? v : `${String(owner)}${v.slice(i)}`
}

// an answer as JSON: ids by name, bytes in their JSON form
function plain(x: unknown): Json {
	return JSON.parse(
		JSON.stringify(x ?? null, (_, v) => {
			if (v instanceof Uint8Array) return toJson(v)
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
	return plain(v)
}

// what the runners did, every device's, in order
const ran: Json[] = []
const stops: Json[] = []

type Api = { den: string; places: Places; process: Context["process"] }

const record = (dev: string): Runner => (code, api) => {
	const { process } = api as Api
	ran.push({ dev, process: process.id, code, args: process.args, keys: Object.keys(api!).sort() })
	return {
		stop: (reason?: unknown) =>
			void stops.push({ dev, process: process.id, reason: reason ?? null }),
	}
}
const boom: Runner = () => {
	throw new Error("boom")
}

function live(d: Device, kind: unknown): unknown {
	if (kind === undefined) return undefined
	if (kind === "record") return record(d.name)
	if (kind === "boom") return boom
	throw new Error(`no runner ${kind}`)
}

const createProcessAPI = ({ den, places, process }: Context): Api => ({
	den: den.id,
	places,
	process,
})

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
					createBox({ places: d.places, table: d.table, scheduler: d.s }, { id: take(r.folder) }),
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
					createProcessAPI,
					id: r.id ?? d.name,
					...(r.name === undefined ? {} : { name: r.name }),
					...(r.device === undefined ? {} : { device: back(r.device) }),
					...(r.policy === "grants" ? { may: granted(d) } : {}),
				}))
			d.den = den
			name(den.node, `den:${den.id}`)
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
				const id = known.get(`proc:${r.process}`) ?? take(String(r.process))
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
		case "runs":
			return { runs: plain(ran), stops: plain(stops) }
		case "asked":
			return { asks: plain(dev(r).asks.splice(0)) }
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
