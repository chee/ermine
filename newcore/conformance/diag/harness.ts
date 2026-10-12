// The reference diag.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. A value is shown in its JSON form (../pack/form.ts); text is a JSON string.
//   {op: "write", value} -> {text} | {code}
//   {op: "read", text}   -> {value} | {code, at, line, column}
// Another implementation joins by speaking this. A read refused is code "not-diag" with the
// offset (in UTF-16 code units), line and column from 1 (the message is not compared). A value
// that cannot be carried (a form standing for none, or a live stand-in) is "cannot-carry".
import { Stand } from "../../encoding/ts/cbor.ts"
import { DiagError, read, write } from "../../files/ts/diag.ts"
import { FormError, fromJson, line, toJson } from "../pack/form.ts"

type Request = { op: string; value?: unknown; text?: string }

// a stand-in anywhere in the value: no diagnostic notation for it
function stands(x: unknown): boolean {
	if (x instanceof Stand) return true
	if (x === null || typeof x !== "object" || ArrayBuffer.isView(x) || x instanceof ArrayBuffer) {
		return false
	}
	return Object.values(x).some(stands)
}

function answer(r: Request): unknown {
	try {
		switch (r.op) {
			case "write": {
				const value = fromJson(r.value) as never
				return stands(value) ? { code: "cannot-carry" } : { text: write(value) }
			}
			case "read":
				return { value: toJson(read(r.text!)) }
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

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		text += line(answer(JSON.parse(l))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
