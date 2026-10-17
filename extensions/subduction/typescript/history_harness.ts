// The reference history.ts on the line protocol (conformance/run.ts: one JSON request per line in,
// one answer per line out, in order; an answer is an object). A blop in its JSON form
// (conformance/typescript/form.ts), its byte fields {"/": {"bytes": b64}};
// names lowercase hex (64 digits); an object as BLOP.tex writes it. A session starts at create;
// a later create starts a new one.
//   {op: "create", node}     -> {}; createHistories(node, check), check APPLY.tex's (apply.ts)
//   {op: "add", blop, name}  -> {added}: "taken" | "passed" | {waiting: [names]} |
//                               {stuck: [names]} | {refused: code}, as add answers it (HISTORY.tex)
//   {op: "heads", object}    -> {heads: [{name, blop}]}, in the agreed order; none: []
//   {op: "get", name}        -> {blop} | {}
//   {op: "waiting"}          -> {waiting: [{name, waiting: [names]}]}, sorted by name
//   {op: "refused"}          -> {refused: [{name, refused: code} | {name, stuck: [names]}]}, one
//                               list sorted by name
//   {op: "checked"}          -> {checked: [names]}: each blop given to check since the last checked (or
//                               create), in the order check was called; how the agreed order of
//                               wakings shows from outside
// Another implementation joins by speaking this.
import { createHistories } from "@ermine/subduction/history"
import { check } from "@ermine/subduction/apply"
import { encode, name } from "@ermine/encoding/blop"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { serve } from "../../../conformance/typescript/harness.ts"

type Request = { op: string; node?: string; blop?: unknown; name?: string; object?: unknown }

const hex = (b: Uint8Array | string) =>
	typeof b === "string" ? b : Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the byte fields Uint8Arrays, in the API (BLOP.tex) and in the JSON form (form.ts)
const blopIn = (j: unknown) => fromJson(j) as never
const blopOut = (b: unknown) => toJson(b)

// deno-lint-ignore no-explicit-any
let histories: any
let checked: string[] = []

export function answer(r: Request): Record<string, unknown> {
	switch (r.op) {
		case "create":
			checked = []
			histories = createHistories(r.node!, (c: never, blop: never) => {
				checked.push(hex(name(encode(blop))))
				return check(c, blop)
			})
			return {}
		case "add":
			return { added: histories.add(blopIn(r.blop), unhex(r.name!)) }
		case "heads":
			return {
				heads: histories.heads(fromJson(r.object)).map((
					h: { name: Uint8Array; blop: unknown },
				) => ({
					name: hex(h.name),
					blop: blopOut(h.blop),
				})),
			}
		case "get": {
			const b = histories.get(unhex(r.name!))
			return b == null ? {} : { blop: blopOut(b) }
		}
		case "waiting":
			return { waiting: histories.waiting() }
		case "refused":
			return { refused: histories.refused() }
		case "checked": {
			const c = checked
			checked = []
			return { checked: c }
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve((r) => answer(r as never))
