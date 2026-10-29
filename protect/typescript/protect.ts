// protect: may this actor do this to that, at this version? an answer, never an effect: protect
// stops and keeps nothing; whoever asks decides what an answer does.
//
// an ask:
//   who     the ChangeHeader being made or asked for; opaque to protect, a policy looks inside
//   op      any string (read, edit, execute, relay, share, place, ...); protect knows none
//   target  a node or a field: { part?, id, field?, path?, route? }; route[i] the id at each path
//           step, route[0] the start (length path.length + 1)
//   from    the asker's place (path, route) and its box (box: the id of the box's folder, where
//           its path and route start); none: the host, outside any process
//   node    a placement's (op place): the node being given the name (its id, the path it came by),
//           beside the target, the folder's slot. a rule may look at either or both: the node's
//           own, where it goes, or the two together
//   at      the version, opaque, passed to the policy and its every read; none: now
//
// a policy reads through the asker's own read, so a change to what it read asks again. a read of
// what is not there is undefined. answers, always at once: yes | no with a reason | pending with
// what it waits for (having read the node the answer will arrive in). a grants answer, a yes or a
// "denied", also says which grant decided: grant { part, id, index }; all, any and only pass the
// deciding answer through whole, so it survives composition
//
// from.box, the builder's pick, not chee's (asked for [chee 10-26: "protect should know about the
// box the question came from"]): the box as its folder's id, not its path from the root. a path is box-
// relative, so two processes at code/q in two boxes ask with the same from.path; the box's id tells
// them apart. why the id: a box is its folder (boxes.ts), and the id names that folder whatever
// names it has, one or many or none (a box made from an id); a path from the root changes with
// every rename above it and needs a walk up to find; a host that wants the path keeps its own map.
// the policy is the host's: from.box is for it, told no process (guard.ts keeps it out of a
// Refusal). a rule by path stays about the name: path and from match names, as before
//
// reading it: every path in an ask (target.path, from.path, route) is as the asker sees it, from its
// own "/"; from.box says whose "/" that is. none: the ermine's own (the host's, and what it started
// outside any box). so a rule meaning "the process at admin" is from.path admin with no from.box: a
// boxed process at its own box's admin has from.box set, and is another process. the ermine sets it
// for every ask of a process started in a box (its places' root, when that is not the ermine's)
import type { Key as Step } from "@ermine/changeable/apply"

export type Key = string | symbol
export type Target = {
	part?: string
	id?: Key
	field?: readonly Step[]
	path?: readonly string[]
	route?: readonly Key[]
}

// where something stands among places: none given: it was not reached by names (by id alone).
// box: the box it stands in, its folder's id (path and route start there); none: not said
export type Place = { path?: readonly string[]; route?: readonly Key[]; box?: Key }

export type Ask = {
	who: unknown
	op: string
	target: Target
	from?: Place
	at?: unknown
	node?: Target
}

// which grant decided: the rules node (part, id) and the grant's index in its list
export type Grant = { part: string; id: Key; index: number }

export type Answer =
	| { answer: "yes"; grant?: Grant }
	| { answer: "no"; reason: string; grant?: Grant }
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
//   box: equal to the asker's box (from.box), its folder's id
//   field: a start of the target's field
//   deny: true: a match is a no, and beats any yes
// a grant with any other field, or a field of the wrong kind (op, id, box: a string; path, from,
// field: a list; deny: a boolean), makes the whole node answer no, naming it: a misspelt field
// must never widen. entries that are not maps are skipped.
// a match: yes, grant the first allowing one that matched; a deny: no "denied", grant that deny; no
// match: no "no grant", no grant. the node not there: pending, waiting for [part, id]
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

// the first field of a grant that is not known, or of the wrong kind
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

// whether list is the start of whole (whole not given: nothing is)
function starts(list: unknown, whole: readonly unknown[] | undefined): boolean {
	if (!Array.isArray(list) || whole === undefined || list.length > whole.length) return false
	return list.every((x, i) => x === whole[i])
}

function isMap(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)
}

// values equal: scalars as ===, lists in order, maps by keys, bytes and typed arrays by content
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
