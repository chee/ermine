// The reference because on the line protocol: one JSON request per line in, one answer per line
// out, in order. Another implementation joins by speaking this.
//
// { op: "create", layer, place, why?, outside? }  →  { because }
// why left out of the request: not given. outside: the harness's own call is the site.
import createBecause from "../../because.ts"

type Request = { op: string; layer?: string; place?: unknown; why?: unknown; outside?: boolean }

function answer(r: Request): unknown {
	switch (r.op) {
		case "create":
			return {
				because: createBecause(r.layer!, r.place, r.why, { outside: r.outside === true }),
			}
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
		text += JSON.stringify(answer(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
