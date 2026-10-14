// The reference node.ts on the line protocol (conformance/typescript/harness.ts): one JSON request
// per line in, one answer per line out, in order. Another implementation joins by speaking this
// (HARNESS).
//
// { op: "entry", value?, header? } → { entry: { value?, change } }
//    value: any JSON (null is a value; not given: none), typed arrays and bytes in the JSON form
//    (conformance/typescript/form.ts: revive reads it, toJson writes it). header: the change
//    header as given (never an op)
//    entry: no value key when none; change: the header's fields as given, and the time now (whole
//    seconds since 1970) when it gave none
// { op: "node", values: { <table>: value, ... }, header? } → { node: { <table>: entry, ... } }
//    each table name any string, each value as above (JSON has no undefined: a table left out is
//    not given); one header for every table, and with no time the same time now for all
// Anything not understood: { error }.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import createNode from "@ermine/node"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../../conformance/typescript/form.ts"

const make = (r: Request) =>
	createEntry(r.value === undefined ? undefined : revive(r.value), r.header)

const show = (e: Entry<unknown>) => ({
	...("value" in e ? { value: toJson(e.value) } : {}),
	change: toJson(e.change),
})

function answer(r: Request) {
	if (r.op === "entry") return { entry: show(make(r)) }
	if (r.op === "node") {
		const values: Record<string, unknown> = {}
		for (const [t, v] of Object.entries(r.values as Record<string, unknown>)) {
			Object.defineProperty(values, t, {
				value: revive(v),
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		const node = createNode(values, r.header as ChangeHeader | undefined)
		const out: Record<string, unknown> = {}
		for (const [t, e] of Object.entries(node)) {
			Object.defineProperty(out, t, {
				value: show(e),
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		return { node: out }
	}
	return { error: `unknown op ${r.op}` }
}

if (import.meta.main) await serve(answer)
