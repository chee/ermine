// The reference blop.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. A blop is shown in its JSON form (../pack/form.ts); bytes and names are lowercase hex.
//   {op: "encode", blop}  -> {bytes} | {code, field?}
//   {op: "decode", bytes} -> {blop}  | {code, field?}
//   {op: "name", bytes}   -> {name}
// Another implementation joins by speaking this.
import { BlopError, decode, encode, name } from "../../encoding/ts/blop.ts"
import { FormError, fromJson, line, toJson } from "../pack/form.ts"

type Request = { op: string; blop?: unknown; bytes?: string }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the four byte fields are Uint8Array in the API (BLOP.tex); the JSON form's bytes are ArrayBuffers.
// An ArrayBuffer given to encode is the wrong kind, so it cannot be written in JSON form: only the
// conversion is tested here.
const FIELDS = ["signer", "nonce", "base"]
const map = (b: unknown, f: (x: ArrayBuffer | Uint8Array) => unknown) =>
	b instanceof ArrayBuffer || b instanceof Uint8Array ? f(b) : b
function convert(blop: unknown, f: (x: ArrayBuffer | Uint8Array) => unknown): unknown {
	if (typeof blop !== "object" || blop === null || Array.isArray(blop)) return blop
	const o: Record<string, unknown> = { ...blop }
	for (const k of FIELDS) if (k in o) o[k] = map(o[k], f)
	if (Array.isArray(o.parents)) o.parents = o.parents.map((p) => map(p, f))
	return o
}
const toArray = (b: ArrayBuffer | Uint8Array) => b instanceof ArrayBuffer ? new Uint8Array(b) : b
const toBuffer = (b: ArrayBuffer | Uint8Array) => b instanceof Uint8Array ? b.slice().buffer : b

function answer(r: Request): unknown {
	try {
		switch (r.op) {
			case "encode":
				return { bytes: hex(encode(convert(fromJson(r.blop), toArray) as never)) }
			case "decode":
				return { blop: toJson(convert(decode(unhex(r.bytes!)), toBuffer)) }
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
