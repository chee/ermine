// guard: a policy's answers (protect's), made into what a run does with them. who asks: the scope
// open (header.ts' createChangeBase); from: where the asker is placed, a path, and the box it is
// in, its folder's id, both given; the policy, given. it asks, and wraps nothing: whoever calls
// places asks first, or after for a list.
//
// a read is asked through places, told: a run asking tracks what the policy read, so a change to
// the rules reruns it, refused or not. a write is asked of the table, told no one: a write makes
// no run depend on the rules. a no throws Refusal, a pending throws the scheduler's PENDING; a
// list keeps a refused member in its place, its id REFUSED. no policy: everything is allowed.
// a Refusal's answer is protect's whole, so its grant (which grant decided) is kept; its ask
// names the target refused
//
// the box, the builder's pick, not chee's (asked for [chee 10-26: "protect should know about the
// box the question came from"]): every ask's from carries box, the box's folder's id (why the id:
// protect.ts), and an action's caller's place its own box, so the second ask is from where the
// caller is; asked once only when both path and box are the caller's. the policy is the host's,
// so the box is the policy's alone: a Refusal's ask is the ask without from.box, since a Refusal
// reaches the process refused, and nothing it reads may say where its box sits (its message names
// only the op and the reason)
import type { Key as Step } from "@ermine/core/changeable/apply"
import {
	type Answer,
	type Ask,
	may,
	no,
	type Place,
	type Policy,
	type Target,
	yes,
} from "@ermine/core/protect"
import { PENDING, type Scheduler } from "@ermine/core/scheduler"
import type { Key, Table } from "@ermine/core/table"
import { createChangeBase } from "./header.ts"
import { at, type Id, type Member, type Path, type Places } from "./places.ts"

// what a refused member's id is, in a list: a stand-in, refused if asked
export const REFUSED: unique symbol = /* @__PURE__ */ Symbol.for("ermine.refused")

export class Refusal extends Error {
	// the answer, no, and what was asked
	constructor(readonly answer: Extract<Answer, { answer: "no" }>, readonly ask: Ask) {
		super(`${ask.op} refused: ${answer.reason}`)
	}
}

export type Setup = {
	places: Pick<Places, "readValue">
	scheduler: Pick<Scheduler, "getCurrentScope">
	table: Pick<Table, "get">
	// none: everything is allowed
	may?: Policy
	// where the asker is placed: a path; none: at none (the host)
	from?: Path
	// the box the asker is in: its folder's id; none: not said
	box?: Id
	// while an action's call is open, the caller: every ask is made again from its place and its
	// box (none: the host), both to allow [chee 10-25: "so it should run as both"; "1. both"]. no
	// call open (or none given): undefined
	caller?: () => { from?: Path; box?: Id } | undefined
}

// what is asked about: an id, and the path it was asked by when there was one
export type Thing = { readonly id: Id; readonly path?: Path }

// the node a thing is, at part and field
export const target = (t: Thing, part?: Key, field?: readonly Step[]): Target =>
	t.path === undefined ? { id: t.id, part, field } : { id: t.id, part, field, path: [...t.path] }

// a name in a parent's children: what a write to it changes
export const slot = (parent: Thing, name: string): Target => target(parent, "children", [name])

const everything: Policy = () => yes

// a place: a path and a box, when either is given
const placeOf = (path?: Path, box?: Id): Place | undefined =>
	path === undefined && box === undefined
		? undefined
		: { ...path !== undefined && { path: [...path] }, ...box !== undefined && { box } }

// an ask as a Refusal carries it: without from.box, the policy's alone
function shown(a: Ask): Ask {
	if (a.from?.box === undefined) return a
	const { box: _, ...place } = a.from
	const { from: _from, ...rest } = a
	return place.path === undefined && place.route === undefined ? rest : { ...rest, from: place }
}

export function createGuard(setup: Setup): {
	read: (...targets: Target[]) => void
	write: (op: string, ...targets: Target[]) => void
	place: (slot: Target, node: Target, ops: readonly string[]) => void
	members: (list: readonly Member[], at?: Path) => Member[]
	move: (source: Path, to: Path) => void
} {
	const { places, table, scheduler } = setup
	const policy = setup.may ?? everything
	const from = placeOf(setup.from, setup.box)
	// the policy asked: a read's reads told, a write's told no one
	const told = may(policy, (part, id, field) => places.readValue(part as Key, id, field))
	const quiet = may(
		policy,
		(part, id, field) => at(table.get(part as Key, id)?.value, field ?? []),
	)

	// a, and in an action's call the same again from the caller's place: the first no; else a
	// pending; else a's answer
	function both(ask: (a: Ask) => Answer, a: Ask): [Ask, Answer] {
		const first = ask(a)
		const c = setup.caller?.()
		if (c === undefined || first.answer === "no") return [a, first]
		// already asked from the caller's place (an execute is asked as the caller): once is enough
		const same = (x?: readonly unknown[], y?: readonly unknown[]) =>
			x === undefined ? y === undefined : y !== undefined && x.length === y.length &&
				x.every((n, i) => n === y[i])
		if (same(a.from?.path, c.from) && a.from?.box === c.box) return [a, first]
		const { from: _, ...rest } = a
		const place = placeOf(c.from, c.box)
		const b: Ask = place === undefined ? rest : { ...rest, from: place }
		const second = ask(b)
		if (second.answer === "no" || (first.answer === "yes" && second.answer === "pending")) {
			return [b, second]
		}
		return [a, first]
	}

	function asked(ask: (a: Ask) => Answer, op: string, t: Target): [Ask, Answer] {
		const a: Ask = { who: createChangeBase(scheduler), op, target: t, from }
		// a stand-in is refused, never asked
		if (t.id === REFUSED) return [a, no("refused")]
		return both(ask, a)
	}

	// every target asked: the first no is thrown, else a pending
	function demand(ask: (a: Ask) => Answer, op: string, targets: Target[]) {
		let waiting = false
		for (const t of targets) {
			const [a, answer] = asked(ask, op, t)
			if (answer.answer === "no") throw new Refusal(answer, shown(a))
			if (answer.answer === "pending") waiting = true
		}
		if (waiting) throw PENDING
	}

	// the members of a list, each asked to be read (at: the path they are under): a refused one in
	// its place, its name and from kept and its id REFUSED. any pending: PENDING
	function members(list: readonly Member[], at?: Path): Member[] {
		const answers = list.map((m) =>
			asked(told, "read", target({ id: m.id, path: at && [...at, m.name] }))[1]
		)
		if (answers.some((a) => a.answer === "pending")) throw PENDING
		return list.map((m, i) =>
			answers[i].answer === "yes"
				? m
				: m.from === undefined
				? { name: m.name, id: REFUSED }
				: { name: m.name, id: REFUSED, from: m.from }
		)
	}

	// a move by path, refused when to is under from (strictly: the same place is no move): the
	// node would be cut off, its own descendant its parent. needs no policy, asks none
	function move(source: Path, to: Path) {
		if (to.length <= source.length || !source.every((name, i) => to[i] === name)) return
		const a: Ask = {
			who: createChangeBase(scheduler),
			op: "move",
			target: { path: [...source] },
			from,
		}
		throw new Refusal(no("into-itself"), shown(a))
	}

	// a node given a name: "place" asked of the slot with the node beside it (where it goes, what it
	// is, together), then each of ops of the node itself, the asker holding all a name there could
	// hand out (can't widen [chee 10-26]: linux's protected_hardlinks, read and edit). told no one,
	// as a write's
	function place(slot: Target, node: Target, ops: readonly string[]) {
		const placing: Ask = {
			who: createChangeBase(scheduler),
			op: "place",
			target: slot,
			from,
			node,
		}
		const [a, answer] = slot.id === REFUSED || node.id === REFUSED
			? [placing, no("refused")]
			: both(quiet, placing)
		if (answer.answer === "no") throw new Refusal(answer, shown(a))
		let waiting = answer.answer === "pending"
		for (const op of ops) {
			const [b, got] = asked(quiet, op, node)
			if (got.answer === "no") throw new Refusal(got, shown(b))
			if (got.answer === "pending") waiting = true
		}
		if (waiting) throw PENDING
	}

	return {
		read: (...targets) => demand(told, "read", targets),
		write: (op, ...targets) => demand(quiet, op, targets),
		place,
		members,
		move,
	}
}
