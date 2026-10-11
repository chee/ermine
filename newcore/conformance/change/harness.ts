// The reference change library on the line protocol: one JSON request per line in, one answer
// per line out, in order. {op: "make", node, header, outside?} → {change}. Another
// implementation joins by speaking this.
import createChange, { type Header } from "../../change.ts"

type Request = { op: string; node?: string; header?: Header; outside?: boolean }

function answer(r: Request): unknown {
	if (r.op !== "make") return { error: `unknown op ${r.op}` }
	return { change: createChange(r.node!, r.header!, { outside: r.outside }) }
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
