// protect: may this actor do this to that, at this version? an answer, never an effect: protect
// stops nothing and keeps nothing. whoever asks (handle, sync, a host) decides what an answer does
//
// an ask is five things:
//   who: the change being made, or asked for: a whole ChangeHeader (time, actor, reader, external,
//     metadata), so a policy sees the caller and whoever defined what it calls, wherever the
//     header puts them. opaque: protect never looks inside it, a policy does
//   op: what for. any string, an open set (read, edit, execute, relay, share, place, ...): protect
//     knows none of them, a policy matches the ones it means
//   target: what on, a node or one field of it (below)
//   from: the place the asker is at: its path and route, as a target's are (a process: where its
//     node is placed). none: it is at none (the host, outside any process)
//   at: the version the question is asked at. opaque, passed to the policy and to every read it
//     makes (the reader's last argument), so what a version means is the reader's. none: now
//
// a target says as much as the asker knows. id: the node, with part when it is one of the
// table's. field: steps into its value (none: the whole node). path: names from a start, when
// it was asked by path; route: the id reached at each step of it, route[0] the start, so a
// policy sees what the path went through (route.length is path.length + 1)
//
// a policy decides, and reads what it needs through the read it is given: that read is the asker's
// own, so what a policy reads is tracked as the asker's reads are, and a change to it asks again.
// a read of what is not there (not loaded yet, or never made) is undefined: a policy that needs it
// answers pending
//
// answers: yes; no, with a reason; pending, with what it waits for (opaque). always at once: a
// policy that cannot decide yet answers pending, having read the node its answer will arrive in
// (an access node), so the asker is asked again when it changes
import type { Key as Step } from "@ermine/op/apply"

export type Key = string | symbol
export type Target = {
	part?: string
	id?: Key
	field?: readonly Step[]
	path?: readonly string[]
	route?: readonly Key[]
}

// where something stands among places: none given: it was not reached by names (by id alone)
export type Place = { path?: readonly string[]; route?: readonly Key[] }

export type Ask = { who: unknown; op: string; target: Target; from?: Place; at?: unknown }

export type Answer =
	| { answer: "yes" }
	| { answer: "no"; reason: string }
	| { answer: "pending"; need?: unknown }

// what a policy reads through: the value at path in the node under (part, id)
export type Read = (part: string, id: Key, path?: readonly Step[]) => unknown
// what a host gives protect to read with: as Read, and the version asked at
export type Reader = (
	part: string,
	id: Key,
	path: readonly Step[] | undefined,
	at: unknown,
) => unknown

export type Policy = (ask: Ask, read: Read) => Answer
export type May = (ask: Ask) => Answer

export const yes: Answer = { answer: "yes" }
export const no = (reason: string): Extract<Answer, { answer: "no" }> => ({
	answer: "no",
	reason,
})
export const pending = (need?: unknown): Answer => ({ answer: "pending", need })

// a policy asked with a reader: reads go to it, at the ask's version
export function may(policy: Policy, reader: Reader): May {
	return (ask) => policy(ask, (part, id, path) => reader(part, id, path, ask.at))
}

// all: every policy must say yes. a no is final (the first one's reason), even after a pending;
// else any pending is pending (the first one's need). each is asked until a no
export function all(...policies: Policy[]): Policy {
	return (ask, read) => {
		let waiting: Answer | undefined
		for (const policy of policies) {
			const a = policy(ask, read)
			if (a.answer === "no") return a
			if (a.answer === "pending") waiting ??= a
		}
		return waiting ?? yes
	}
}

// any: one policy saying yes is enough. else any pending is pending (the first one's need), else
// no (the first one's reason; none given: "no policy"). each is asked until a yes
export function any(...policies: Policy[]): Policy {
	return (ask, read) => {
		let refused: Answer | undefined, waiting: Answer | undefined
		for (const policy of policies) {
			const a = policy(ask, read)
			if (a.answer === "yes") return a
			if (a.answer === "no") refused ??= a
			else waiting ??= a
		}
		return waiting ?? refused ?? no("no policy")
	}
}

// only: the policy for the ops given; any other op: yes, so it stands in an all beside the others
export function only(ops: readonly string[], policy: Policy): Policy {
	return (ask, read) => ops.includes(ask.op) ? policy(ask, read) : yes
}

// where a rules node is
export type Where = { part: string; id: Key }

// grants: the one data-driven policy. the value of the node at where is a list of grants, each a
// map; every field it has must match, a field it has not matches anything:
//   actor: equal (as values) to the actor of the ask's who
//   reader: the same, of its reader
//   op: the ask's op
//   id: the target's id
//   path: a start of the target's path (it, or something under it)
//   from: a start of the asker's place's path
//   field: a start of the target's field
//   deny: true: a match is a no, and beats any yes
// a match: yes; no match: no. the node not there: pending, waiting for [part, id]
export function grants(where: Where): Policy {
	return (ask, read) => {
		const rules = read(where.part, where.id)
		if (rules === undefined) return pending([where.part, where.id])
		if (!Array.isArray(rules)) return no("rules are not a list")
		let allowed = false
		for (const g of rules) {
			if (!isMap(g) || !matches(g, ask)) continue
			if (g.deny === true) return no("denied")
			allowed = true
		}
		return allowed ? yes : no("no grant")
	}
}

function matches(g: Record<string, unknown>, ask: Ask): boolean {
	const { target } = ask
	const who = isMap(ask.who) ? ask.who : {}
	if (Object.hasOwn(g, "actor") && !same(g.actor, who.actor)) return false
	if (Object.hasOwn(g, "reader") && !same(g.reader, who.reader)) return false
	if (Object.hasOwn(g, "op") && g.op !== ask.op) return false
	if (Object.hasOwn(g, "id") && g.id !== target.id) return false
	if (Object.hasOwn(g, "path") && !starts(g.path, target.path)) return false
	if (Object.hasOwn(g, "from") && !starts(g.from, ask.from?.path)) return false
	if (Object.hasOwn(g, "field") && !starts(g.field, target.field)) return false
	return true
}

// whether list is the start of whole (whole not given: nothing is)
function starts(list: unknown, whole: readonly unknown[] | undefined): boolean {
	if (!Array.isArray(list) || whole === undefined || list.length > whole.length) return false
	return list.every((x, i) => x === whole[i])
}

function isMap(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)
}

// values equal: scalars as ===, lists in order, maps by keys
export function same(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
	}
	if (isMap(a) && isMap(b)) {
		const ks = Object.keys(a)
		return ks.length === Object.keys(b).length &&
			ks.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
	}
	return false
}
