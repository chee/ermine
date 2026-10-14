// protect (protect.ts) on the line protocol (conformance/typescript/harness.ts). State lasts for
// the process. Another implementation joins by speaking this (HARNESS).
//
// the world: nodes a policy reads, by (part, id) and the version they are visible at.
// a node with no value reads as not there (undefined), as a read does in link. ids are strings
//
// a policy is data: "yes", "pending", {no: reason}, {grants: [part, id]}, {all: [policy]},
// {any: [policy]}, {only: [op], policy}
//
// { op: "load", part, id, value?, at? }          → {}   the node there, for version at (none: for
//    every version; one made for the version asked wins). loaded again: replaced
// { op: "drop", part, id, at? }                  → {}   that node not there
// { op: "ask", policy, who?, what, target, at? } → { answer, reason?, need?, reads }
//    from?: {path?, route?}, the place the asker is at
//    who: a change header (a map with actor, reader, ...)
//    target: {part?, id?, field?, path?, route?}, as protect.ts's Target (route: ids)
//    reads: each read the policy made, in order: [part, id, path?]
import {
	all,
	type Answer,
	any,
	type Ask,
	grants,
	may,
	no,
	only,
	pending,
	type Policy,
	same,
	yes,
} from "./protect.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

type Cell = {
	part: string
	id: string
	at: unknown
	given: boolean
	value: unknown
}
let world: Cell[] = []
let reads: unknown[][] = []

function policy(p: unknown): Policy {
	if (p === "yes") return () => yes
	if (p === "pending") return () => pending()
	const m = p as Record<string, unknown>
	if ("no" in m) return () => no(m.no as string)
	if ("grants" in m) {
		const [part, id] = m.grants as string[]
		return grants({ part, id })
	}
	if ("all" in m) return all(...(m.all as unknown[]).map(policy))
	if ("any" in m) return any(...(m.any as unknown[]).map(policy))
	if ("only" in m) return only(m.only as string[], policy(m.policy))
	throw new Error("unknown policy")
}

const reader = (
	part: string,
	id: unknown,
	path: readonly (string | number)[] | undefined,
	at: unknown,
) => {
	reads.push(path === undefined ? [part, id] : [part, id, path])
	const here = world.filter((c) => c.part === part && c.id === id)
	const hit = here.find((c) => c.given && same(c.at, at)) ?? here.find((c) => !c.given)
	return hit?.value
}

const same_cell = (c: Cell, r: Request) =>
	c.part === r.part && c.id === r.id &&
	c.given === ("at" in r) && same(c.at, r.at)

function answer(r: Request): Record<string, unknown> {
	switch (r.op) {
		case "load":
			world = world.filter((c) => !same_cell(c, r))
			world.push({
				part: r.part,
				id: r.id,
				at: r.at,
				given: "at" in r,
				value: r.value,
			})
			return {}
		case "drop":
			world = world.filter((c) => !same_cell(c, r))
			return {}
		case "ask": {
			reads = []
			const ask: Ask = { who: r.who, op: r.what, target: r.target ?? {}, from: r.from, at: r.at }
			const a: Answer = may(policy(r.policy), reader)(ask)
			return { ...a, reads }
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
