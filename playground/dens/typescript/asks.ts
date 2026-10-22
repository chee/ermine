// asks: telling a den something through the graph. an ask is a node under one of the den's methods
// (<den>/on/start, <den>/on/stop), named by its hash, its value the ask. whoever has the den's node
// (here, or carried from elsewhere) can write one; the den answers each once, at <ask>/answer. an
// ask written while the den is not running waits: it is answered when the den next starts. the same
// ask written twice is one ask (one hash), answered once: to ask for the same thing again, ask
// something that differs (its who, its args). which question: how it is asked
//
//   const n = ask(world, den.node, { op: "start", who, runner, program, at })   // the ask's id
//   answer(world, n)              // { id, at } | {} | a refusal | { error }; undefined until then
//
// the den's side (answering): every ask under its methods with no answer, as its ask(a) answers
// another den's (the policy asked, remote), in a run of one effect. only a name whose id is the
// method's own <method>/<name> is an ask (a child pointing elsewhere is passed over), and only once
// its value is there (a carrier may bring the name first); a value that is no ask: { error:
// "not-an-ask" }; one that throws: { error: its code, or its message }. a den with no install: its
// asks and their answers go with its session
// who an ask is from is what it says (who): checked once installs sign what they carry; nothing
// here checks it
import createEntry from "@ermine/node/entry"
import type { Address } from "@ermine/boxes"
import { type Id, type Places, PlacesError } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Key, Table } from "@ermine/table"
import { type Ctx, isMap, ON, ours } from "./common.ts"
import type { Ask, Asked } from "./handlers.ts"
import { hashOf } from "./start.ts"

ours.add(import.meta.url)

// the name of an ask's answer, under the ask
export const ANSWER = "answer"
const OPS = ["start", "stop"] as const

// what an ask got back: the den's answer, or what answering it threw
export type Answered = Asked | { readonly error: string }

export type World = {
	table: Table
	places: Pick<Places, "commit" | "readValue">
	scheduler: Pick<Scheduler, "getCurrentScope" | "getRun" | "runWithScope">
	// the scope the ask is written in (its header's actor)
	scope: Scope
}

// the method's id at a den
const methodOf = (den: Id, op: string): Id => `${String(den)}/${ON}/${op}`

// the ask written under the den's method, and the method reached from the den's node (so whatever
// carries the den's node by its children carries the ask, the den having started or not): its id.
// one that does not encode: TypeError
export function ask(w: World, den: Id, a: Ask): Id {
	const { op, ...body } = a
	const name = hashOf(body)
	if (name === undefined) throw new TypeError("an ask that does not encode")
	const folder: Id = `${String(den)}/${ON}`
	const method = methodOf(den, op)
	const id: Id = `${String(method)}/${name}`
	w.scheduler.runWithScope(w.scope, () => {
		const header = createChangeHeader(w.scheduler)
		if (w.table.get("value", id) === undefined) {
			w.table.add("value", id, createEntry<unknown>(body, header))
		}
		w.places.commit([
			...upsert(w.table, "children", den, [ON], folder, header),
			...upsert(w.table, "children", folder, [op], method, header),
			...upsert(w.table, "children", method, [name], id, header),
		])
	})
	return id
}

// the answer to the ask n; undefined until there. tracked
export function answer(w: Pick<World, "places">, n: Id): Answered | undefined {
	return w.places.readValue("value", `${String(n)}/${ANSWER}`) as Answered | undefined
}

// the ask a stored value says, for the method op; none: not one
export function askOf(op: string, v: unknown): Ask | undefined {
	if (!isMap(v)) return undefined
	const isAddress = (x: unknown): x is Address => typeof x === "string" || Array.isArray(x)
	if (op === "start") {
		if (!isAddress(v.runner) || !isAddress(v.at)) return undefined
		if (!isMap(v.program) || typeof v.program.id !== "string") return undefined
		const a: Record<string, unknown> = {
			op,
			who: v.who,
			runner: v.runner,
			program: v.program,
			at: v.at,
		}
		if (v.args !== undefined) a.args = v.args
		if (v.cwd !== undefined) a.cwd = v.cwd
		return a as Ask
	}
	if (op === "stop") {
		if (typeof v.process !== "string") return undefined
		const a: Record<string, unknown> = { op, who: v.who, process: v.process }
		if (v.reason !== undefined) a.reason = v.reason
		return a as Ask
	}
	return undefined
}

// the den's side: an effect, made with scope open, answering every ask with no answer yet
export function answering(c: Ctx, asked: (a: Ask) => Asked, scope: Scope) {
	const { s, table, places, commit, headerOf } = c
	// answered this session (its answer may not have landed yet)
	const done = new Set<Id>()

	// each ask with its value there and no answer: its method, its id and its value
	function waiting(): { op: string; id: Id; value: unknown }[] {
		const out: { op: string; id: Id; value: unknown }[] = []
		for (const op of OPS) {
			const method = methodOf(c.node, op)
			const kids = places.readValue("children", method)
			if (!isMap(kids)) continue
			for (const [name, id] of Object.entries(kids)) {
				if (id !== `${String(method)}/${name}` || done.has(id)) continue
				const value = places.readValue("value", id)
				if (value === undefined) continue
				if (places.readValue("value", `${id}/${ANSWER}`) === undefined) {
					out.push({ op, id, value })
				}
			}
		}
		return out
	}

	function reply(op: string, id: Id, value: unknown) {
		done.add(id)
		const a = askOf(op, value)
		let out: unknown
		try {
			out = a === undefined ? { error: "not-an-ask" } : asked(a)
		} catch (e) {
			out = { error: e instanceof PlacesError ? e.code : String((e as Error)?.message ?? e) }
		}
		const at: Id = `${String(id)}/${ANSWER}`
		const header = headerOf()
		if (table.get("value", at) === undefined) table.add("value", at, createEntry(out, header))
		commit(upsert(table, "children", id, [ANSWER], at, header))
		if (!c.stored) s.registerTeardown(scope, () => forget([id, at]))
	}

	// ids' entries out, every part
	function forget(ids: Id[]) {
		for (const id of ids) for (const [part] of table.get(id)) table.del(part as Key, id)
	}

	s.createEffect(waiting, (asks) => {
		for (const { op, id, value } of asks) reply(op, id, value)
	})
}
