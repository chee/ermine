// guard: a policy's answers (protect's), made into what a run does with them. who asks: the scope
// open (header.ts' createChangeBase); from: where the asker is placed, a path, given; the policy, given. it asks,
// and wraps nothing: whoever calls places asks first, or after for a list.
//
// a read is asked through places, told: a run asking tracks what the policy read, so a change to
// the rules reruns it, refused or not. a write is asked of the table, told no one: a write makes
// no run depend on the rules. a no throws Refusal, a pending throws the scheduler's PENDING; a
// list keeps a refused member in its place, its id REFUSED. no policy: everything is allowed.
// a Refusal's answer is protect's whole, so its grant (which grant decided) is kept; its ask
// names the target refused
import type { Key as Step } from "@ermine/core/op/apply"
import {
	type Answer,
	type Ask,
	may,
	no,
	type Place,
	type Policy,
	type Target,
	yes,
} from "@ermine/protect"
import { PENDING, type Scheduler } from "@ermine/core/scheduler"
import type { Key, Table } from "@ermine/core/table"
import { createChangeBase } from "./header.ts"
import { at, type Id, type Member, type Path, type Places } from "./places.ts"

// what a refused member's id is, in a list: a stand-in, refused if asked
export const REFUSED: unique symbol = Symbol.for("ermine.refused")

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
}

// what is asked about: an id, and the path it was asked by when there was one
export type Thing = { readonly id: Id; readonly path?: Path }

// the node a thing is, at part and field
export const target = (t: Thing, part?: Key, field?: readonly Step[]): Target =>
	t.path === undefined ? { id: t.id, part, field } : { id: t.id, part, field, path: [...t.path] }

// a name in a parent's children: what a write to it changes
export const slot = (parent: Thing, name: string): Target => target(parent, "children", [name])

const everything: Policy = () => yes

export function createGuard(setup: Setup): {
	read: (...targets: Target[]) => void
	write: (op: string, ...targets: Target[]) => void
	members: (list: readonly Member[], at?: Path) => Member[]
	move: (source: Path, to: Path) => void
} {
	const { places, table, scheduler } = setup
	const policy = setup.may ?? everything
	const from: Place | undefined = setup.from === undefined ? undefined : { path: [...setup.from] }
	// the policy asked: a read's reads told, a write's told no one
	const told = may(policy, (part, id, field) => places.readValue(part as Key, id, field))
	const quiet = may(
		policy,
		(part, id, field) => at(table.get(part as Key, id)?.value, field ?? []),
	)

	function asked(ask: (a: Ask) => Answer, op: string, t: Target): [Ask, Answer] {
		const a: Ask = { who: createChangeBase(scheduler), op, target: t, from }
		// a stand-in is refused, never asked
		if (t.id === REFUSED) return [a, no("refused")]
		return [a, ask(a)]
	}

	// every target asked: the first no is thrown, else a pending
	function demand(ask: (a: Ask) => Answer, op: string, targets: Target[]) {
		let waiting = false
		for (const t of targets) {
			const [a, answer] = asked(ask, op, t)
			if (answer.answer === "no") throw new Refusal(answer, a)
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
		throw new Refusal(no("into-itself"), a)
	}

	return {
		read: (...targets) => demand(told, "read", targets),
		write: (op, ...targets) => demand(quiet, op, targets),
		members,
		move,
	}
}
