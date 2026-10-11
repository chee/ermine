// The reference graph (graph.ts) on the line protocol: one JSON request per line in, one answer per
// line out, in order. Another implementation joins by speaking this (GRAPH_HARNESS).
//
// owners are names; interfaces are names, "host" made by new. what the graph tells (marked,
// owned, released) is kept as events, in order, until asked.
//
//   {"op":"new","root"?:id,"actor"?:a,"rules"?:[rule],"site"?:site}                     → {}
//       a new graph, root "root", clock at 0, the host's actor "host". rules: protect is
//       rules("rules"), and a node "rules" holding them is introduced (as intro below) before
//       anything is asked. site: options.site, given to every change made with a site.
//       the interface "host": place [], agent the host's actor, writes, alive, site
//   {"op":"bind","as":n,"place"?:[..],"agent"?:a,"reader"?:s,"cause"?:c,"site"?:b,
//    "writes"?:b,"owner"?:o,"track"?:o,"tag"?:t,"wrote"?:b}                               → {}
//       an interface named n (any old one of that name replaced). writes default true.
//       owner: may make ephemeral nodes, owning them. track: reads tracked by o's reader
//       (made if none). wrote: the times of its changes kept, for "wrote"
//   {"op":"stop","as":n}                                 n's alive answers false     → {}
//   {"op":"wrote","as":n}                                its times since asked     → {"ok":[t]}
//   {"op":op,"as"?:n,...}                                an interface's operation, by n (none:
//                                                        "host"), as normal.ts     → {"ok":a}
//   {"op":"reader","owner":o}                            o's reader, made if none     → {}
//   {"op":"begin"|"end"|"untrack","owner":o}             o's reader's                → {}
//   {"op":"intro","id":id,"value"?:c,"info"?:{n:c},"children"?:{n:[id]},"actor"?:a}
//       a node, each object one version at time 0 by actor "host"; intro'd as actor
//       (default the host's)                                                   → {"ok":time}
//   {"op":"release","id":id}         released, cause {actor: host's, time: next, node: id,
//                                    which: "loaded"}                          → {"ok":time}
//   {"op":"make","id"?:id,"value"?:c,"actor"?:a}         make; no value: none   → {"ok":id}
//   {"op":"own","id":id,"owner"?:o}                                                   → {}
//   {"op":"asking","actor":a,"asks":[ask]}                                       → {"ok":null}
//   {"op":"changing","actor":a,"reader"?:s,"cause"?:c,"own"?:o,"tag"?:t,"slot"?:n|null,
//    "snap"?:[[id,which]],"do":[inner]}
//       the graph's changing, around inner ops run straight on places (place []):
//         insert remove pop rename move write set: as normal.ts's, on places
//         {"op":"versions","id":id,"which":w,"contents":[c]}: the object's versions replaced
//         whole, each with one change made by by()
//       answers each inner's answer                                            → {"ok":[a]}
//   {"op":"node","id":id}    {"value":[version],"info":{n:[version]},"children":{n:[version]},
//                             "ephemeral":b,"owner"?:o}; null: not loaded
//   {"op":"events"}          since last asked, in order, then forgotten:
//                              {"marked":o,"by":by,"tag"?:t}
//                              {"owned":o,"id":id}
//                              {"released":id,"owner"?:o}
//   {"op":"clock"}                                                           → {"ok":time}
//
// a by: the change's header as JSON (time, actor, reader?, site?, cause?) and node, which?.
// an error: {"error":code}; a refusal also "why": protect's. the harness goes on.
import createChange, { type Change } from "../../nodes/change.ts"
import createNode from "../../nodes/node.ts"
import { type Patch } from "../../notify.ts"
import { rules } from "../../protect.ts"
import { type Bind, createGraph, type Graph, type Reader } from "../graph.ts"
import { type Which } from "../../opstreams/mutate.ts"
import { code, json, operate, version } from "./normal.ts"

type O = string
// deno-lint-ignore no-explicit-any
type Q = Record<string, any>

let clock = { time: 0 }
let events: unknown[] = []
let g: Graph<O>
let host: unknown = "host"
let site: unknown
const readers = new Map<O, Reader>()
const apis = new Map<string, ReturnType<Graph<O>["bound"]>>()
const alive = new Map<string, boolean>()
const wrote = new Map<string, number[]>()

const at = (time: number, actor: unknown = "host") => (node: string) =>
	({ time, actor, node }) as Change

function nodeOf(q: Q) {
	const ch = at(0)(q.id)
	const one = (c: unknown) => [{ content: c, change: ch }]
	const map = (m: Q | undefined) =>
		Object.entries(m ?? {}).map(([k, v]) => [k, one(v)] as [string, ReturnType<typeof one>])
	return createNode<unknown, Change>(q.id, {
		...(q.value !== undefined ? { value: one(q.value) } : {}),
		info: map(q.info),
		children: map(q.children) as never,
	})
}

function readerOf(o: O): Reader {
	let r = readers.get(o)
	if (!r) readers.set(o, r = g.reader(o))
	return r
}

function bind(name: string, q: Q) {
	alive.set(name, true)
	const b: Bind<O> = {
		place: q.place ?? [],
		agent: q.agent ?? host,
		writes: q.writes ?? true,
		alive: () => alive.get(name) === true,
	}
	if (q.reader !== undefined) b.reader = q.reader
	if (q.cause !== undefined) b.cause = q.cause
	if (q.site) b.site = true
	if (q.owner !== undefined) b.owner = q.owner
	if (q.tag !== undefined) b.tag = q.tag
	if (q.track !== undefined) b.depend = readerOf(q.track).depend
	if (q.wrote) {
		const ts: number[] = []
		wrote.set(name, ts)
		b.wrote = ts
	} else wrote.delete(name)
	apis.set(name, g.bound(b))
}

const byOf = (by: Record<string, unknown>) => {
	const { patched: _, ...rest } = by
	return json(rest)
}

function make(q: Q) {
	clock = { time: 0 }
	events = []
	readers.clear()
	apis.clear()
	alive.clear()
	wrote.clear()
	host = q.actor ?? "host"
	site = q.site
	g = createGraph<O>({
		root: q.root ?? "root",
		clock,
		actor: host,
		...(q.rules ? { may: rules("rules") } : {}),
		...(q.site !== undefined ? { site: () => site as never } : {}),
		marked: (o, by, tag) => {
			const e: Q = { marked: o, by: byOf(by) }
			if (tag !== undefined) e.tag = json(tag)
			events.push(e)
		},
		owned: (o, id) => void events.push({ owned: o, id }),
		released: (id, o) => void events.push(o === undefined ? { released: id } : { released: id, owner: o }),
	})
	if (q.rules) g.intro(nodeOf({ id: "rules", value: q.rules }))
	bind("host", { site: q.site !== undefined })
}

const times = (c: Change | Change[]) => (Array.isArray(c) ? c.map((x) => x.time) : c.time)

function inner(q: Q): unknown {
	const p = g.places
	switch (q.op) {
		case "versions": {
			const n = g.get(q.id)
			if (!n) throw Object.assign(new Error("nothing-there"), { code: "nothing-there" })
			const change = createChange(q.id, g.by())
			const vs = (q.contents as unknown[]).map((c) => ({ content: c, change }))
			const w = q.which as Which
			if (w === "value") n.value = vs
			else (w[0] === "info" ? n.info : n.children as Map<string, unknown>).set(w[1], vs)
			return change.time
		}
		case "insert":
			return times(p.insert(q.id, q.name, q.child, q.index ?? undefined, q.slotindex ?? undefined))
		case "remove":
			return times(p.remove(q.id, q.name, q.index, q.slotindex ?? undefined))
		case "pop":
			return times(p.pop(q.id, q.name, q.slotindex))
		case "rename":
			return times(p.rename(q.id, q.name, q.to))
		case "move":
			return times(p.move(q.id, q.name, q.index, q.toid, q.toname, q.toindex ?? undefined))
		case "write":
			return times(p.write([], q.address, q.patches as Patch[], q.index ?? undefined, q.slotindex ?? undefined))
		case "set":
			return times(p.set([], q.address, q.name, q.patches as Patch[], q.index ?? undefined, q.slotindex ?? undefined))
	}
	throw Object.assign(new Error(`unknown op ${q.op}`), { code: "unknown-op" })
}

function answer(q: Q): unknown {
	switch (q.op) {
		case "new":
			make(q)
			return undefined
		case "bind":
			bind(q.as, q)
			return undefined
		case "stop":
			alive.set(q.as, false)
			return undefined
		case "wrote": {
			const ts = wrote.get(q.as) ?? []
			const out = ts.splice(0)
			return out
		}
		case "reader":
			readerOf(q.owner)
			return undefined
		case "begin":
			readerOf(q.owner).begin()
			return undefined
		case "end":
			readerOf(q.owner).end()
			return undefined
		case "untrack":
			readerOf(q.owner).untrack()
			return undefined
		case "intro": {
			g.intro(nodeOf(q), { actor: q.actor ?? host })
			return clock.time
		}
		case "release": {
			const time = ++clock.time
			g.release(q.id, { actor: host, time, node: q.id, which: "loaded" })
			return time
		}
		case "make":
			return g.make(q.id ?? undefined, q.value, { actor: q.actor ?? host }, q.value !== undefined)
		case "own":
			g.own(q.id, q.owner ?? undefined)
			return undefined
		case "asking":
			g.asking(q.actor, q.asks, "asking")
			return null
		case "changing": {
			const who: Q = { actor: q.actor }
			if (q.reader !== undefined) who.reader = q.reader
			if (q.cause !== undefined) who.cause = q.cause
			const o: Q = {}
			if (q.own !== undefined) o.own = q.own
			if (q.tag !== undefined) o.tag = q.tag
			if (q.slot !== undefined) o.slot = q.slot
			if (q.snap !== undefined) o.snap = q.snap
			return g.changing(who as never, o, () => (q.do as Q[]).map(inner))
		}
		case "node": {
			const n = g.get(q.id)
			if (!n) return null
			const of = (m: Map<string, unknown[]>) =>
				Object.fromEntries([...m].map(([k, vs]) => [k, vs.map((v) => version(v as never))]))
			const out: Q = {
				value: n.value.map((v) => version(v)),
				info: of(n.info),
				children: of(n.children as Map<string, unknown[]>),
				ephemeral: g.ephemeral(q.id),
			}
			const o = g.owner(q.id)
			if (o !== undefined) out.owner = o
			return out
		}
		case "events":
			return events.splice(0)
		case "clock":
			return clock.time
		default: {
			const { op, as, ...fields } = q
			const api = apis.get(as ?? "host")
			if (!api) throw Object.assign(new Error(`no interface ${as}`), { code: "no-interface" })
			return operate(api, op, fields)
		}
	}
}

make({})

const out = (v: unknown) => Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(v) + "\n"))
const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream())
let buffer = ""
for await (const chunk of lines) {
	buffer += chunk
	let i
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		try {
			const a = answer(JSON.parse(line))
			out(a === undefined ? {} : { ok: a })
		} catch (e) {
			const why = (e as { why?: unknown }).why
			out(why === undefined ? { error: code(e) } : { error: code(e), why: json(why) })
		}
	}
}
