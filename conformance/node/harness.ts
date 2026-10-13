// The reference node.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. Another implementation joins by speaking this (NODE_HARNESS).
//
// { op: "make", value?, header? } → { node: { value?, change } }
//    value: any JSON (null is a value; not given: none), typed arrays and bytes as in
//    conformance/update/form.ts. header: the change header as given (never an op)
//    node: no value key when none; change: the header's fields as given, and the time now (whole
//    seconds since 1970) when it gave none
// Anything not understood: { error }.
import createNode from "@ermine/node"
import type { ChangeHeader } from "@ermine/node"
import { dehydrate, revive } from "../update/form.ts"

type Request = { op: string; value?: unknown; header?: ChangeHeader }

function answer(r: Request): unknown {
	if (r.op !== "make") return { error: `unknown op ${r.op}` }
	const n = createNode(
		r.value === undefined ? undefined : revive(r.value),
		r.header,
	)
	return { node: { ...("value" in n ? { value: dehydrate(n.value) } : {}), change: n.change } }
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
