// The reference squish on the line protocol: one JSON request per line in, one answer per line
// out, in order. Another implementation joins by speaking this.
//
// { op: "squish", patches }  →  { patches }   the patches pushed one by one, then what is left
// { op: "encode", patches }  →  { columns }
// { op: "decode", columns }  →  { patches }
// bytes, which JSON has none of: {"$bytes": [0, 255, ...]} (a Uint8Array)
import { decode, encode, squish } from "@ermine/op/squish"

type Request = { op: string; patches?: never[]; columns?: never }

function revive(_: string, v: unknown): unknown {
	if (v !== null && typeof v === "object" && !Array.isArray(v) && "$bytes" in v) {
		return new Uint8Array((v as { $bytes: number[] }).$bytes)
	}
	return v
}
function replace(_: string, v: unknown): unknown {
	return v instanceof Uint8Array ? { $bytes: [...v] } : v
}

function answer(r: Request): unknown {
	switch (r.op) {
		case "squish":
			return { patches: squish(r.patches!) }
		case "encode":
			return { columns: encode(r.patches!) }
		case "decode":
			return { patches: decode(r.columns!) }
		default:
			return { error: `unknown op ${r.op}` }
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
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		text += JSON.stringify(answer(JSON.parse(line, revive)), replace) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
