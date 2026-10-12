// The reference id.ts on the line protocol: one JSON request per line in, one answer per line out,
// in order. Bytes are lowercase hex. Another implementation joins by speaking this.
//   {op: "id", lock, made}: {id} or {code}
//   {op: "bytes", id}: {bytes} or {code}
//   {op: "is", id}: {is}
// {code} for an IdError
import { bytes, id, IdError, is } from "../../sync/ts/id.ts"

type Request = { op: string; lock?: string; made?: string; id?: string }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

function answer(r: Request): unknown {
	try {
		switch (r.op) {
			case "id":
				return { id: id(r.lock!, unhex(r.made!)) }
			case "bytes":
				return { bytes: hex(bytes(r.id!)) }
			case "is":
				return { is: is(r.id!) }
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof IdError) return { code: e.code }
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
		text += JSON.stringify(answer(JSON.parse(l))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
