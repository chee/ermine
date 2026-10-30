// The reference guard (guard.ts) on the line protocol: one JSON request per line in, one answer out.
// policy: "yes" | "pending" | {no: reason} | {grants: [part, id]} | {all: [policy]} | {any: [policy]}
//   | {only: [op], policy} | {denyid: id} | {denynode: id} | {access: [part, id]} | {whois: [actor, reader]}
// { op: "guard", name, may?, from?, box?, caller? } → {}
// { op: "eval", guard, scope?, e, detail? } → { value } | { error: "pending" } | { error: code }
//   | { error: "refused", reason, op, grant?, field? }   (detail: true adds grant and field)
// { op: "watch", name, scope, guard, f, then?, effect? } → {}
// { op: "asks" } → { asks }   every policy ask since last asked
// programs, besides the world's:
//   {"get":path,"full"?:true}  {"members":path,"full"?:true}  {"ask":[[name,id,from?]],"at"?:path}
//   {"read":[ts,part,path?]}  {"edit":[ts,part,patches]}  {"place":[[ts,name],id]}
//   {"name":[[ts,name],id,ops?]}  {"try":e}  {"given":null} (in then: the value)
// ts (a start): an id, or {"at": path} asked through the guard (refused: REFUSED).
import { PENDING } from "@ermine/reactivity"
import { all, any, grants, no, only, pending, type Policy, yes } from "@ermine/protect"
import type { Member, Path } from "@ermine/places"
import type { Patch } from "@ermine/changeable/apply"
import type { Key } from "@ermine/graph/table"
import type { Frame } from "@ermine/graph/entry"
import { show } from "../../conformance/typescript/frames.ts"
import { createGuard, Refusal, REFUSED, slot, target, type Thing } from "./guard.ts"
import {
	answered,
	basic,
	edit,
	enroll,
	fill,
	id,
	json,
	places,
	s,
	scope,
	summary,
	table,
	write,
} from "../../places/typescript/world_harness.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { get, members } from "@ermine/places/lib"

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
		const [part, id] = m.grants
		return grants({ part, id })
	}
	if ("all" in m) return all(...(m.all as Json[]).map(policy))
	if ("any" in m) return any(...(m.any as Json[]).map(policy))
	if ("only" in m) return only(m.only, policy(m.policy))
	if ("access" in m) {
		const [part, id] = m.access
		return (_, read) => {
			const a = read(part, id)
			return a === undefined ? pending([part, id]) : a === "allow" ? yes : no("closed")
		}
	}
	if ("denyid" in m) return (ask) => ask.target.id === m.denyid ? no("denied id") : yes
	if ("denynode" in m) return (ask) => ask.node?.id === m.denynode ? no("denied node") : yes
	if ("whois" in m) {
		return (ask) => {
			const who = ask.who as Request
			return who.actor === m.whois[0] && who.reader === m.whois[1] ? yes : no("whois")
		}
	}
	throw new Error("unknown policy")
}
const shownWho = (who: unknown) => {
	if (who === undefined) return who
	const { frame, ...rest } = who as { frame?: Frame }
	return frame === undefined ? rest : { ...rest, frame: show(frame) }
}
const recording = (p: Policy): Policy => (ask, read) => {
	asked.push({
		op: ask.op,
		target: dump(ask.target),
		who: shownWho(ask.who),
		...(ask.from && { from: ask.from }),
		...(ask.node && { node: dump(ask.node) }),
	})
	return p(ask, read)
}

const guards = new Map<string, Guard>()
const shown = (m: Member) => m.id === REFUSED ? "REFUSED" : String(m.id)
const full = (m: Member) => m.from === undefined ? [shown(m), m.name] : [shown(m), m.name, m.from]

type Ctx = { g: Guard; given?: Json }

function guarded(c: Ctx, path: Path): Member | undefined {
	const at = get(places, path)
	if (at === undefined) return undefined
	return c.g.members([{ name: path.at(-1) ?? "", id: at }], path.slice(0, -1))[0]
}

function start(c: Ctx, ts: Json): Thing {
	if (typeof ts === "string") return { id: id(ts) }
	const path = (ts as Request).at as Path
	const m = guarded(c, path)
	if (m === undefined) throw new Error("nothing there")
	return { id: m.id, path }
}

function evaluate(e: Json, c: Ctx): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map((x) => evaluate(x, c))
	const p = e as Request
	const ev = (x: Json) => evaluate(x, c)
	const { g } = c
	if ("get" in p) {
		const m = guarded(c, p.get)
		return m === undefined ? null : p.full ? full(m) : shown(m)
	}
	if ("members" in p) {
		const ms = g.members(members(places, p.members), p.members)
		return p.full ? ms.map(full) : ms.map(shown)
	}
	if ("ask" in p) {
		const given = (p.ask as string[][]).map(([name, x, from]): Member =>
			from === undefined ? { name, id: id(x) } : { name, id: id(x), from }
		)
		return g.members(given, p.at).map(full)
	}
	if ("read" in p) {
		const [ts, part, path] = p.read
		const x = start(c, ts)
		g.read(target(x, part, path))
		return places.readValue(part as Key, x.id, path) ?? null
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
		return summary(edit(part, x.id, list).change)
	}
	if ("place" in p) {
		const [[ts, name], at] = p.place
		const parent = start(c, ts)
		g.write("place", slot(parent, name))
		write({ op: "place", at: parent.id, name, id: at })
		return null
	}
	if ("name" in p) {
		const [[ts, name], at, ops] = p.name
		const parent = start(c, ts)
		g.place(slot(parent, name), target({ id: at }), ops ?? ["read", "edit"])
		write({ op: "place", at: parent.id, name, id: at })
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
			guards.set(
				r.name,
				createGuard({
					places,
					scheduler: s,
					table,
					from: r.from,
					...r.box !== undefined && { box: r.box },
					...r.caller !== undefined && { caller: () => r.caller },
					may: r.may === undefined ? undefined : recording(policy(r.may)),
				}),
			)
			return {}
		}
		case "eval": {
			const c: Ctx = { g: guards.get(r.guard)! }
			const run = () => evaluate(r.e, c)
			try {
				return { value: r.scope === undefined ? run() : s.runWithScope(scope(r.scope), run) }
			} catch (e) {
				if (e instanceof Refusal) {
					const { grant } = e.answer, { field } = e.ask.target
					return {
						error: "refused",
						reason: e.answer.reason,
						op: e.ask.op,
						...(r.detail === true && grant && { grant }),
						...(r.detail === true && field && { field }),
					}
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
			const made = s.runWithScope(
				scope(r.scope),
				() =>
					r.effect === true
						? s.createEffect(f, then)
						: s.createComputer(f, (v) => (w.value = v, then(v)), json),
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
