// The optype the conformance suite uses: core/docs/protocol.tex, "The optype basic".
//
// Values are any JSON. { set: v } replaces the whole value and applies to an
// empty node too; { splice: [from, to, s] } edits a string by code points.
// Anything else is not an op. Two values are the same when both are the same
// null, boolean, number or string; an array or an object is never the same as
// anything, so nothing is compared deeply. It is here and not in the core
// because the core has no optypes of its own; a graph is given its optypes
// when made.

import { type Held, type Implementation, type Json, Refused } from "./ermine.ts"

export type Op = { set: Json } | { splice: [number, number, string] }

const isObject = (x: Json): x is { [key: string]: Json } => typeof x === "object" && x !== null && !Array.isArray(x)

const primitive = (x: Json) => x === null || typeof x !== "object"

export const basic: Implementation = {
	holds(_value) {
		return true
	},
	equal(a, b) {
		return primitive(a) && primitive(b) && a === b
	},
	apply(held, ops) {
		let current = held
		for (const op of ops) {
			if (!isObject(op) || Object.keys(op).length !== 1) throw new Refused(`not an op: ${JSON.stringify(op)}`)
			if ("set" in op) {
				current = { present: true, value: op.set }
				continue
			}
			if ("splice" in op) {
				const parts = op.splice
				if (!Array.isArray(parts) || parts.length !== 3) throw new Refused(`not an op: ${JSON.stringify(op)}`)
				const [from, to, insert] = parts
				if (!Number.isInteger(from) || !Number.isInteger(to) || typeof insert !== "string") {
					throw new Refused(`not an op: ${JSON.stringify(op)}`)
				}
				if (!current.present || typeof current.value !== "string") {
					throw new Refused(`splice applies only to a string, not ${current.present ? JSON.stringify(current.value) : "an empty node"}`)
				}
				const points = [...current.value] // code points, not UTF-16 units
				if ((from as number) < 0 || (to as number) < (from as number) || (to as number) > points.length) {
					throw new Refused(`splice [${from}, ${to}) is outside a string of ${points.length} code points`)
				}
				points.splice(from as number, (to as number) - (from as number), ...[...insert])
				current = { present: true, value: points.join("") }
				continue
			}
			throw new Refused(`not an op: ${JSON.stringify(op)}`)
		}
		if (!current.present) throw new Refused("the ops leave no value")
		return current.value
	},
}
