// Turns a protect policy's answers into what a run does with them. With no policy everything is
// allowed.
import type { Key as Step } from "@ermine/changeable/apply"
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
import { PENDING, type Scheduler } from "@ermine/reactivity"
import type { Key, Table } from "@ermine/graph/table"
import { createChangeBase } from "@ermine/places/header"
import { at, type Id, type Member, type Path, type Places } from "@ermine/places"

export const REFUSED: unique symbol = /* @__PURE__ */ Symbol.for("ermine.refused")

export class Refusal extends Error {
	readonly code = "refused"
	constructor(readonly answer: Extract<Answer, { answer: "no" }>, readonly ask: Ask) {
		super(`${ask.op} refused: ${answer.reason}`)
	}
}

export type Setup = {
	places: Pick<Places, "readValue">
	scheduler: Pick<Scheduler, "getCurrentFrame">
	table: Pick<Table, "get">
	may?: Policy
	from?: Path
	caller?: () => { from?: Path } | undefined
}

export type Thing = { readonly id: Id; readonly path?: Path }

export const target = (t: Thing, part?: Key, field?: readonly Step[]): Target =>
	t.path === undefined ? { id: t.id, part, field } : { id: t.id, part, field, path: [...t.path] }

export const slot = (parent: Thing, name: string): Target => target(parent, "children", [name])

const everything: Policy = () => yes

const placeOf = (path?: Path): Place | undefined =>
	path === undefined ? undefined : { path: [...path] }

export function createGuard(setup: Setup): {
	read: (...targets: Target[]) => void
	write: (op: string, ...targets: Target[]) => void
	place: (slot: Target, node: Target, ops: readonly string[]) => void
	members: (list: readonly Member[], at?: Path) => Member[]
	move: (source: Path, to: Path) => void
} {
	const { places, table, scheduler } = setup
	const policy = setup.may ?? everything
	const from = placeOf(setup.from)
	const told = may(policy, (part, id, field) => places.readValue(part as Key, id, field))
	const quiet = may(
		policy,
		(part, id, field) => at(table.get(part as Key, id)?.value, field ?? []),
	)

	function both(ask: (a: Ask) => Answer, a: Ask): [Ask, Answer] {
		const first = ask(a)
		const c = setup.caller?.()
		if (c === undefined || first.answer === "no") return [a, first]
		const same = (x?: readonly unknown[], y?: readonly unknown[]) =>
			x === undefined ? y === undefined : y !== undefined && x.length === y.length &&
				x.every((n, i) => n === y[i])
		if (same(a.from?.path, c.from)) return [a, first]
		const { from: _, ...rest } = a
		const place = placeOf(c.from)
		const b: Ask = place === undefined ? rest : { ...rest, from: place }
		const second = ask(b)
		if (second.answer === "no" || (first.answer === "yes" && second.answer === "pending")) {
			return [b, second]
		}
		return [a, first]
	}

	function asked(ask: (a: Ask) => Answer, op: string, t: Target): [Ask, Answer] {
		const a: Ask = { who: createChangeBase(scheduler), op, target: t, from }
		if (t.id === REFUSED) return [a, no("refused")]
		return both(ask, a)
	}

	function demand(ask: (a: Ask) => Answer, op: string, targets: Target[]) {
		let waiting = false
		for (const t of targets) {
			const [a, answer] = asked(ask, op, t)
			if (answer.answer === "no") throw new Refusal(answer, a)
			if (answer.answer === "pending") waiting = true
		}
		if (waiting) throw PENDING
	}

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
		if (answer.answer === "no") throw new Refusal(answer, a)
		let waiting = answer.answer === "pending"
		for (const op of ops) {
			const [b, got] = asked(quiet, op, node)
			if (got.answer === "no") throw new Refusal(got, b)
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
