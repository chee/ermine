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
// { op: "node", entries: { <table>: { value?, header? }, ... } } → { node: { <table>: entry, ... } }
//    each table name any string; each entry as above, made the way "entry" makes one. the node
//    has the tables given and no others
// Anything not understood: { error }.
import createEntry, { createNode, type Entry } from "@ermine/node"
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
		const node = createNode(
			Object.fromEntries(
				Object.entries(r.entries as Record<string, Request>).map(([t, e]) => [t, make(e)]),
			),
		)
		return { node: Object.fromEntries(Object.entries(node).map(([t, e]) => [t, show(e)])) }
	}
	return { error: `unknown op ${r.op}` }
}

if (import.meta.main) await serve(answer)
