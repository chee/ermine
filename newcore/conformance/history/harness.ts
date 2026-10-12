// The reference history.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. A blop in its JSON form (../pack/form.ts), its byte fields {"/": {"bytes": b64}};
// names lowercase hex (64 digits); an object as BLOP.tex writes it. A session starts at create;
// a later create starts a new one.
//   {op: "create", node}     -> {}; createHistories(node, check), check APPLY.tex's (apply.ts)
//   {op: "add", blop, name}  -> "taken" | "passed" | {waiting: [names]} | {stuck: [names]} |
//                               {refused: code}, as add answers it (HISTORY.tex)
//   {op: "heads", object}    -> [{name, blop}], in the agreed order; none: []
//   {op: "get", name}        -> {blop} | {}
//   {op: "waiting"}          -> [{name, waiting: [names]}], sorted by name
//   {op: "refused"}          -> [{name, refused: code} | {name, stuck: [names]}], one list sorted
//                               by name
//   {op: "checked"}          -> [names]: each blop given to check since the last checked (or
//                               create), in the order check was called; how the agreed order of
//                               wakings shows from outside
// Another implementation joins by speaking this.
import { createHistories } from "../../sync/ts/history.ts"
import { check } from "../../sync/ts/apply.ts"
import { encode, name } from "../../encoding/ts/blop.ts"
import { fromJson, line, toJson } from "../pack/form.ts"

type Request = { op: string; node?: string; blop?: unknown; name?: string; object?: unknown }

const hex = (b: Uint8Array | string) =>
	typeof b === "string" ? b : Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the byte fields Uint8Arrays, in the API (BLOP.tex) and in the JSON form (form.ts)
const blopIn = (j: unknown) => fromJson(j) as never
const blopOut = (b: unknown) => toJson(b)

// deno-lint-ignore no-explicit-any
let histories: any
let checked: string[] = []

function answer(r: Request): unknown {
	switch (r.op) {
		case "create":
			checked = []
			histories = createHistories(r.node!, (c: never, blop: never) => {
				checked.push(hex(name(encode(blop))))
				return check(c, blop)
			})
			return {}
		case "add":
			return histories.add(blopIn(r.blop), unhex(r.name!))
		case "heads":
			return histories.heads(fromJson(r.object)).map((
				h: { name: Uint8Array; blop: unknown },
			) => ({
				name: hex(h.name),
				blop: blopOut(h.blop),
			}))
		case "get": {
			const b = histories.get(unhex(r.name!))
			return b == null ? {} : { blop: blopOut(b) }
		}
		case "waiting":
			return histories.waiting()
		case "refused":
			return histories.refused()
		case "checked": {
			const c = checked
			checked = []
			return c
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
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		text += line(answer(JSON.parse(l))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
