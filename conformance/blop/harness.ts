// The reference blop.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. A blop is shown in its JSON form (../pack/form.ts); bytes and names are lowercase hex.
//   {op: "encode", blop}  -> {bytes} | {code, field?}
//   {op: "decode", bytes} -> {blop}  | {code, field?}
//   {op: "name", bytes}   -> {name}
// Another implementation joins by speaking this.
import { BlopError, decode, encode, name } from "@ermine/encoding/blop"
import { FormError, fromJson, line, toJson } from "../pack/form.ts"

type Request = { op: string; blop?: unknown; bytes?: string }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

function answer(r: Request): unknown {
	try {
		switch (r.op) {
			case "encode":
				return { bytes: hex(encode(fromJson(r.blop) as never)) }
			case "decode":
				return { blop: toJson(decode(unhex(r.bytes!))) }
			case "name":
				return { name: hex(name(unhex(r.bytes!))) }
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof BlopError) {
			return e.field === undefined ? { code: e.code } : { code: e.code, field: e.field }
		}
		// a value whose form stands for none: cannot be carried
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
