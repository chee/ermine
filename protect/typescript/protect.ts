// Answers whether an actor may do an op to a target at a version. An answer is never an effect;
// whoever asks decides what it means.
//
// An ask has:
//   who     the ChangeHeader being made or asked for; opaque to protect, a policy looks inside
//   op      any string (read, edit, place, ...)
//   target  a node or a field: { part?, id, field?, path?, route? }; route[i] is the id at each
//           path step, route[0] the start
//   from    where the asker stands: path, route, and box (the id of its box's folder, where its
//           path and route start). Absent for the host.
//   node    for a placement, the node being given the name, beside the target (the folder's slot)
//   at      the version, passed to the policy and every read. Absent means now.
//
// A policy reads through the asker's own read, so a change to what it read asks again. Answers are
// always immediate: yes, no with a reason, or pending with what it waits for. A grants answer
// also says which grant decided; all, any and only pass that answer through whole.
//
// from.box is the box's folder id rather than its path, because paths are box-relative: two
// processes at code/q in two boxes ask with the same from.path. Paths in an ask are as the asker
// sees them, from its own "/"; no from.box means the ermine's own.
import type { Key as Step } from "@ermine/changeable/apply"

export type Key = string | symbol
export type Target = {
	part?: string
	id?: Key
	field?: readonly Step[]
	path?: readonly string[]
	route?: readonly Key[]
}

export type Place = { path?: readonly string[]; route?: readonly Key[]; box?: Key }

export type Ask = {
	who: unknown
	op: string
	target: Target
	from?: Place
	at?: unknown
	node?: Target
}

export type Grant = { part: string; id: Key; index: number }

export type Answer =
	| { answer: "yes"; grant?: Grant }
	| { answer: "no"; reason: string; grant?: Grant }
	| { answer: "pending"; need?: unknown }

export type Read = (part: string, id: Key, path?: readonly Step[]) => unknown
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

export function may(policy: Policy, reader: Reader): May {
	return (ask) => policy(ask, (part, id, path) => reader(part, id, path, ask.at))
}

// Every policy must say yes. A no is final, even after a pending; otherwise any pending is
// pending. Stops at the first no.
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

// One yes is enough. Otherwise any pending is pending, otherwise no ("no policy" if none given).
// Stops at the first yes.
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

export function only(ops: readonly string[], policy: Policy): Policy {
	return (ask, read) => ops.includes(ask.op) ? policy(ask, read) : yes
}

export type Where = { part: string; id: Key }

// The one data-driven policy. The node at where holds a list of grants, each a map. Every field
// a grant has must match; a field it lacks matches anything:
//   actor, reader  equal to the actor / reader of the ask's who
//   op, id         the ask's op, the target's id
//   path, field    a start of the target's path / field
//   from           a start of the asker's path
//   box            the asker's box (from.box)
//   deny           if true, a match is a no and beats any yes
// A grant with an unknown field or a field of the wrong kind makes the whole node answer no, so
// a misspelt field can never widen access. Entries that are not maps are skipped.
// The first matching allow is the yes; a matching deny is "denied"; none is "no grant". A
// missing node is pending on [part, id].
export function grants(where: Where): Policy {
	return (ask, read) => {
		const rules = read(where.part, where.id)
		if (rules === undefined) return pending([where.part, where.id])
		if (!Array.isArray(rules)) return no("rules are not a list")
		for (let i = 0; i < rules.length; i++) {
			const bad = isMap(rules[i]) ? malformed(rules[i]) : undefined
			if (bad !== undefined) return no(`bad grant ${i}: ${bad}`)
		}
		let allowed: Grant | undefined
		for (let i = 0; i < rules.length; i++) {
			const g = rules[i]
			if (!isMap(g) || !matches(g, ask)) continue
			if (g.deny === true) {
				return { ...no("denied"), grant: { part: where.part, id: where.id, index: i } }
			}
			allowed ??= { part: where.part, id: where.id, index: i }
		}
		return allowed ? { answer: "yes", grant: allowed } : no("no grant")
	}
}

function malformed(g: Record<string, unknown>): string | undefined {
	for (const [k, v] of Object.entries(g)) {
		switch (k) {
			case "actor":
			case "reader":
				break
			case "op":
			case "id":
			case "box":
				if (typeof v !== "string") return k
				break
			case "path":
			case "from":
			case "field":
				if (!Array.isArray(v)) return k
				break
			case "deny":
				if (typeof v !== "boolean") return k
				break
			default:
				return k
		}
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
	if (Object.hasOwn(g, "box") && g.box !== ask.from?.box) return false
	if (Object.hasOwn(g, "field") && !starts(g.field, target.field)) return false
	return true
}

function starts(list: unknown, whole: readonly unknown[] | undefined): boolean {
	if (!Array.isArray(list) || whole === undefined || list.length > whole.length) return false
	return list.every((x, i) => x === whole[i])
}

function isMap(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)
}

export function same(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (ArrayBuffer.isView(a)) {
		return ArrayBuffer.isView(b) && a.constructor === b.constructor &&
			a.byteLength === b.byteLength &&
			new Uint8Array(a.buffer, a.byteOffset, a.byteLength).every((x, i) =>
				x === new Uint8Array(b.buffer, b.byteOffset, b.byteLength)[i]
			)
	}
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
