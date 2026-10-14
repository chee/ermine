// The reference guard (ermine/link/typescript/guard.ts) on the line protocol: one JSON request per
// line in, one answer per line out, in order (conformance/typescript/harness.ts). State lasts for the process: the world of world.ts,
// guards by name, the computes made by name. Each program asks its guard, then reads and writes
// itself, as a process layer will. Another implementation joins by speaking this (HARNESS).
//
// a policy is data: "yes", "pending", {no: reason}, {grants: [source, part, id]}, {all: [policy]},
// {any: [policy]}, {only: [op], policy}, {access: [source, part, id]} (the value there: not there,
// pending; "allow", yes; else no "closed"), {denyid: id} (no "denied id" for that target id),
// {whois: [actor, reader]} (yes for that actor and reader of who, else no "whois"). every ask of a
// guard's policy is recorded, whole, for asks
// a start (ts): an entry [source, id], or {"item": [name..], "n"?: k}, the kth item (0) of the
// guarded get of those names; a refused one too
// from: where the asker is: an entry, or {"get": [name..]}, the first item places gets there
//
// { op: "guard", name, may?, from? }           → {}
// { op: "eval", guard, scope?, e }              → { value } of the program e, with scope open
//    (none: nothing open). refused: { error: "refused", reason, op }; pending: { error: "pending" };
//    another error: { error: its code }
// { op: "watch", name, scope, guard, f, then?, effect? } → {}   a compute made with scope open,
//    running f each run, its results (compared as JSON) kept (world: state). then: a program run
//    in its set, {"given":null} the value. "effect": true: an effect, then its act
// { op: "asks" }                                → { asks }   the asks of any policy since last
//    asked, then forgotten: { op, target: {source?, part?, id?, field?, path?, route?}, who, from? }
//
// programs, the world's plain forms (world.ts, basic), and:
//   {"get":[name..]} {"get":[..],"from":ts} {"get":[..],"full":true}   the items "source:id" of the
//       guarded get (REFUSED for a refused one); full: [source, id, name, at] of each
//   {"members":ts}                    the guarded members of a level
//   {"read":[ts,part,path?]}          the value, asked; null for none
//   {"edit":[ts,part,patches]}        each patch asked by its path (and a move's), then written;
//                                     the change, summed up (world.ts, summary)
//   {"place":[[ts,name],entry]}       the slot asked, then placed; null
//   {"try":e}                         e; refused: "refused"; pending: "pending"; an error: its code
//   {"given":null}                    in then: the value
import { PENDING } from "@ermine/scheduler"
import { all, any, grants, no, only, pending, type Policy, yes } from "@ermine/protect"
import type { Entry, Item } from "@ermine/places"
import type { Patch } from "@ermine/op/apply"
import type { Key } from "@ermine/graph/table"
import { createGuard, Refusal, REFUSED, slot, target } from "@ermine/link/guard"
import {
	answered,
	basic,
	edit,
	enroll,
	entry,
	fill,
	json,
	l,
	places,
	s,
	scope,
	summary,
	table,
	write,
} from "./world.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

type Json = unknown
type Guard = ReturnType<typeof createGuard>

let asked: Json[] = []
const dump = (x: unknown): Json =>
	typeof x === "symbol" ? String(x.description) : Array.isArray(x) ? x.map(dump) : x

function policy(p: Json): Policy {
	if (p === "yes") return () => yes
	if (p === "pending") return () => pending()
	const m = p as Request
	if ("no" in m) return () => no(m.no)
	if ("grants" in m) {
		const [source, part, id] = m.grants
		return grants({ source, part, id })
	}
	if ("all" in m) return all(...(m.all as Json[]).map(policy))
	if ("any" in m) return any(...(m.any as Json[]).map(policy))
	if ("only" in m) return only(m.only, policy(m.policy))
	if ("access" in m) {
		const [source, part, id] = m.access
		return (_, read) => {
			const a = read(source, part, id)
			return a === undefined ? pending([source, part, id]) : a === "allow" ? yes : no("closed")
		}
	}
	if ("denyid" in m) return (ask) => ask.target.id === m.denyid ? no("denied id") : yes
	if ("whois" in m) {
		return (ask) => {
			const who = ask.who as Request
			return who.actor === m.whois[0] && who.reader === m.whois[1] ? yes : no("whois")
		}
	}
	throw new Error("unknown policy")
}
// a policy that writes down what it is asked
const recording = (p: Policy): Policy => (ask, read) => {
	asked.push({
		op: ask.op,
		target: dump(ask.target),
		who: ask.who,
		...(ask.from && { from: ask.from }),
	})
	return p(ask, read)
}

const guards = new Map<string, Guard>()
const isEntry = (x: Item | Entry): x is Entry => Array.isArray(x)
const ids = (x: Item | Entry): Entry => isEntry(x) ? x : [x.source, x.id]

const shown = (i: Item) => i.source === REFUSED ? "REFUSED" : `${String(i.source)}:${String(i.id)}`
const full = (i: Item) => [
	i.source === REFUSED ? "REFUSED" : i.source,
	i.id === REFUSED ? "REFUSED" : i.id,
	i.name ?? null,
	i.at ?? null,
]

type Ctx = { g: Guard; given?: Json }

// the items a start names, through the guard
function start(c: Ctx, ts: Json): Item | Entry {
	if (Array.isArray(ts)) return entry(ts)
	const t = ts as Request
	return c.g.items(places.get(t.item))[t.n ?? 0]
}

function evaluate(e: Json, c: Ctx): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map((x) => evaluate(x, c))
	const p = e as Request
	const ev = (x: Json) => evaluate(x, c)
	const { g } = c
	if ("get" in p) {
		const items = g.items(places.get(p.get, p.from && start(c, p.from)))
		return p.full ? items.map(full) : items.map(shown)
	}
	if ("members" in p) return g.items(places.members(start(c, p.members))).map(shown)
	if ("read" in p) {
		const [ts, part, path] = p.read
		const x = start(c, ts)
		g.read(target(x, part, path))
		return l.get(part as Key, ids(x)[1], path) ?? null
	}
	if ("edit" in p) {
		const [ts, part, patches] = p.edit
		const x = start(c, ts)
		const list = fill(patches, ev) as Patch[]
		g.write(
			"edit",
			...list.flatMap((q) =>
				[q.path, ...(q.move ? [q.move.path] : [])].map((f) => target(x, part, f))
			),
		)
		return summary(edit(part, ids(x)[1], list).change)
	}
	if ("place" in p) {
		const [[ts, name], at] = p.place
		const parent = start(c, ts)
		g.write("place", slot([parent, name]))
		const [source, id] = ids(parent)
		write({ op: "place", at: [source, id], name, entry: at })
		return null
	}
	if ("try" in p) {
		try {
			return ev(p.try)
		} catch (x) {
			return x instanceof Refusal ? "refused" : x === PENDING ? "pending" : codeOf(x)
		}
	}
	if ("given" in p) return c.given
	const plain = basic(p, ev)
	if (plain !== undefined) return plain
	throw new Error("unknown program")
}

const codeOf = (x: unknown): string =>
	typeof x === "object" && x !== null && "code" in x
		? String((x as { code: unknown }).code)
		: x instanceof Error
		? x.message
		: String(x)

function answer(r: Request): Json | undefined {
	switch (r.op) {
		case "guard": {
			const from = r.from === undefined
				? undefined
				: Array.isArray(r.from)
				? entry(r.from)
				: places.get(r.from.get)[0]
			guards.set(
				r.name,
				createGuard({
					link: l,
					table,
					from,
					may: r.may === undefined ? undefined : recording(policy(r.may)),
				}),
			)
			return {}
		}
		case "eval": {
			const c: Ctx = { g: guards.get(r.guard)! }
			const run = () => evaluate(r.e, c)
			try {
				return { value: r.scope === undefined ? run() : s.run(scope(r.scope), run) }
			} catch (e) {
				if (e instanceof Refusal) {
					return { error: "refused", reason: e.answer.reason, op: e.ask.op }
				}
				if (e === PENDING) return { error: "pending" }
				return { error: codeOf(e) }
			}
		}
		case "watch": {
			const w = { runs: 0, value: null as Json }
			const c: Ctx = { g: guards.get(r.guard)! }
			const f = () => (w.runs++, evaluate(r.f, c))
			const then = (v: unknown) =>
				void (r.then !== undefined && evaluate(r.then, { ...c, given: v }))
			const made = s.run(
				scope(r.scope),
				() =>
					r.effect === true
						? s.effect(f, then)
						: s.compute(f, (v) => (w.value = v, then(v)), json),
			)
			enroll(r.name, made, w)
			return {}
		}
		case "asks": {
			const out = asked
			asked = []
			return { asks: out }
		}
	}
}

if (import.meta.main) await serve((r) => answered(answer, r))
