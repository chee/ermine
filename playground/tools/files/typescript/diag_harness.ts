// diag (diag.ts) on the line protocol (conformance/typescript/harness.ts). Nothing lasts between
// lines. A value is in its JSON form (conformance/typescript/form.ts); text is a JSON string.
//   {op: "write", value} -> {text} | {code: "cannot-carry"}
//   {op: "read", text}   -> {value} | {code: "not-diag", at, line, column}
// A read refused: the offset in UTF-16 code units, the line and column from 1 (the message is not
// answered). A value that cannot be carried (a form standing for none): "cannot-carry". Another
// implementation joins by speaking this (HARNESS).
import { DiagError, read, write } from "./diag.ts"
import { FormError, fromJson, toJson } from "../../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../../conformance/typescript/harness.ts"

function answer(r: Request): Answer {
	try {
		switch (r.op) {
			case "write":
				return { text: write(fromJson(r.value) as never) }
			case "read":
				return { value: toJson(read(r.text)) }
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof DiagError) {
			return { code: "not-diag", at: e.at, line: e.line, column: e.column }
		}
		if (e instanceof FormError) return { code: "cannot-carry" }
		throw e
	}
}

if (import.meta.main) await serve(answer)
