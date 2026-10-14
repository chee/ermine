// The reference node.ts on the line protocol (conformance/typescript/harness.ts): one JSON request
// per line in, one answer per line out, in order. Another implementation joins by speaking this
// (HARNESS).
//
// { op: "make", value?, header? } → { node: { value?, change } }
//    value: any JSON (null is a value; not given: none), typed arrays and bytes in the JSON form
//    (conformance/typescript/form.ts: revive reads it, toJson writes it). header: the change
//    header as given (never an op)
//    node: no value key when none; change: the header's fields as given, and the time now (whole
//    seconds since 1970) when it gave none
// Anything not understood: { error }.
import createNode from "@ermine/node"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../../conformance/typescript/form.ts"

function answer(r: Request) {
	if (r.op !== "make") return { error: `unknown op ${r.op}` }
	const n = createNode(r.value === undefined ? undefined : revive(r.value), r.header)
	return {
		node: { ...("value" in n ? { value: toJson(n.value) } : {}), change: toJson(n.change) },
	}
}

if (import.meta.main) await serve(answer)
