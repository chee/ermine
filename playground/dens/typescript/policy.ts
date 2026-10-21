// policy: may this be done. the protect policy asked with who, the op, the target and whether the
// ask is another den's; none given: yes here, no for another den's. which question: may it
//
// policy reads: the table, untracked
import { at as valueAt } from "@ermine/places"
import { type Answer, may as asking, no, type Policy, type Target } from "@ermine/protect"
import type { Key, Table } from "@ermine/table"
import { ours } from "./common.ts"
import type { NoPermission } from "./start.ts"

ours.add(import.meta.url)

// the policy asked; none: yes here, no for another den's
export function createPolicy(table: Table, may?: Policy) {
	const policy = may === undefined
		? undefined
		: asking(may, (part, id, path) => valueAt(table.get(part as Key, id)?.value, path ?? []))
	return function permit(who: unknown, op: string, target: Target, remote: boolean): Answer {
		if (policy === undefined) return remote ? no("no policy") : { answer: "yes" }
		return policy({ who, op, target })
	}
}

export const refuse = (op: NoPermission["op"], a: Answer): NoPermission => ({
	refused: "no-permission",
	op,
	answer: a.answer === "no" ? { answer: "no", reason: a.reason } : { answer: "pending" },
})
