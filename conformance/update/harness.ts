// The reference for node's update on the line protocol: one JSON request per line in, one answer
// per line out, in order. State lasts for the process: one node. Another implementation joins by
// speaking this (UPDATE_HARNESS).
//
// { op: "start", value?, header? }  → {}   a fresh node: the value (not given: none), the header
//    its change (not given: an empty one)
// { op: "update", patches, header?, list? }
//    patches: JSON patches as op's apply has them; header: the change's (default
//    { time: 1, actor: "me" }, never an op); list: apply's option
//    → {}
//    → { error: { code, patch } }   an ApplyError; nothing changes
// { op: "node" }                    → { node: { value?, change } }
//    no value key when none; change: the header of the latest update, with op: { patches, undo }
//    (the patches as given, undo their inverse)
//
// Values are JSON, typed arrays and bytes as in form.ts; an implementation without typed arrays
// skips those scenarios (UPDATE_SKIP).
// Anything not understood: { error: "text" }.
import createNode, { type Node } from "@ermine/node"
import update from "@ermine/node/update"
import { ApplyError, type Patch } from "@ermine/op/apply"
import { dehydrate, revive } from "./form.ts"

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
type Json = unknown

let node: Node<unknown> = createNode()

function answer(r: Request): Json {
	switch (r.op) {
		case "start":
			node = createNode(
				r.value === undefined ? undefined : revive(r.value),
				r.header,
			)
			return {}
		case "node":
			return {
				node: {
					...("value" in node ? { value: dehydrate(node.value) } : {}),
					change: dehydrate(node.change),
				},
			}
		case "update": {
			const header = r.header ?? { time: 1, actor: "me" }
			const patches = (r.patches as Patch[]).map((p) => revive(p) as Patch)
			update(node, patches, header, { list: r.list === true })
			return {}
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

function safe(r: Request): Json {
	try {
		return answer(r)
	} catch (e) {
		if (e instanceof ApplyError) return { error: { code: e.code, patch: e.patch } }
		return { error: String(e) }
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
		text += JSON.stringify(safe(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
