// guard: a policy's answers (protect's), made into what a run does with them. who asks: the scope
// open (link's who); from: where the asker is placed, given; the policy, given. it asks, and
// wraps nothing: whoever calls places or link asks first, or after for a list.
//
// a read is asked through link, told: a run asking tracks what the policy read, so a change to
// the rules reruns it, refused or not. a write is asked of the table, told no one: a write makes
// no run depend on the rules. a no throws Refusal, a pending throws the scheduler's PENDING; a
// list keeps a refused item in its place, as REFUSED. no policy: everything is allowed
import type { Key as Step } from "@ermine/op/apply"
import { type Entry, type Item, path, type Slot } from "@ermine/places"
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
import { PENDING } from "@ermine/scheduler"
import type { Key, Table } from "@ermine/graph/table"
import { at, type Link } from "./link.ts"

// what a refused item is, in a list, in place of its source and id: a stand-in, refused if asked
export const REFUSED: unique symbol = Symbol.for("ermine.refused")

export class Refusal extends Error {
	// the answer, no, and what was asked
	constructor(readonly answer: Extract<Answer, { answer: "no" }>, readonly ask: Ask) {
		super(`${ask.op} refused: ${answer.reason}`)
	}
}

export type Setup = {
	link: Pick<Link, "get" | "who">
	table: Pick<Table, "get">
	// none: everything is allowed
	may?: Policy
	// where the asker is placed: its item, or an entry; none: at none (the host)
	from?: Item | Entry
}

const isEntry = (x: Item | Entry): x is Entry => Array.isArray(x)

// the node an item or entry is; an item also how it was reached, its path and route. an entry is
// a node by id alone
export function target(x: Item | Entry, part?: Key, field?: readonly Step[]): Target {
	if (isEntry(x)) return { source: x[0], id: x[1], part, field }
	const route: Entry[] = []
	for (let up: Item | undefined = x; up; up = up.up) route.unshift([up.source, up.id])
	return { source: x.source, id: x.id, part, field, path: path(x), route }
}

// a name in a parent's children: what a write to the slot changes
export const slot = ([parent, name]: Slot): Target => target(parent, "children", [name])

// where an asker stands: an item's path and route; an entry's route is itself
function place(x: Item | Entry): Place {
	if (isEntry(x)) return { route: [x] }
	const { path, route } = target(x)
	return { path, route }
}

const everything: Policy = () => yes

export function createGuard(setup: Setup): {
	read: (...targets: Target[]) => void
	write: (op: string, ...targets: Target[]) => void
	items: (list: readonly Item[]) => Item[]
} {
	const { link, table } = setup
	const policy = setup.may ?? everything
	const from = setup.from && place(setup.from)
	// the policy asked: a read's reads told, a write's told no one. protect's source is passed over:
	// one table holds every entry
	const told = may(policy, (_source, part, id, field) => link.get(part as Key, id, field))
	const quiet = may(
		policy,
		(_source, part, id, field) => at(table.get(part as Key, id)?.value, field ?? []),
	)

	function asked(ask: (a: Ask) => Answer, op: string, t: Target): [Ask, Answer] {
		const a: Ask = { who: link.who(), op, target: t, from }
		// a stand-in is refused, never asked
		if (t.source === REFUSED || t.id === REFUSED) return [a, no("refused")]
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

	// the items, each asked to be read: a refused one REFUSED in its place, its name and index
	// kept. any pending: PENDING
	function items(list: readonly Item[]): Item[] {
		const answers = list.map((i) => asked(told, "read", target(i))[1])
		if (answers.some((a) => a.answer === "pending")) throw PENDING
		return list.map((it, i) =>
			answers[i].answer === "yes" ? it : { ...it, source: REFUSED, id: REFUSED }
		)
	}

	return {
		read: (...targets) => demand(told, "read", targets),
		write: (op, ...targets) => demand(quiet, op, targets),
		items,
	}
}
