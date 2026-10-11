// The reference chain.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. A blop in its JSON form (../pack/form.ts), its byte fields {"/": {"bytes": b64}};
// names lowercase hex (64 digits); an object as BLOP.tex writes it. A session starts at create;
// a later create starts a new one.
//   {op: "create", node}     -> {}; createChains(node, check), check APPLY.tex's (apply.ts)
//   {op: "add", blop, name}  -> "taken" | "passed" | {waiting: [names]} | {stuck: [names]} |
//                               {refused: code}, as add answers it (CHAIN.tex)
//   {op: "heads", object}    -> [{name, blop}], in the agreed order; none: []
//   {op: "get", name}        -> {blop} | {}
//   {op: "waiting"}          -> [{name, waiting: [names]}], sorted by name
//   {op: "refused"}          -> [{name, refused: code} | {name, stuck: [names]}], one list sorted
//                               by name
//   {op: "checked"}          -> [names]: each blop given to check since the last checked (or
//                               create), in the order check was called; how the agreed order of
//                               wakings shows from outside
// Another implementation joins by speaking this.
import { createChains } from "../../sync/ts/chain.ts"
import { check } from "../../sync/ts/apply.ts"
import { encode, name } from "../../encoding/ts/blop.ts"
import { fromJson, line, toJson } from "../pack/form.ts"

type Request = { op: string; node?: string; blop?: unknown; name?: string; object?: unknown }

const hex = (b: Uint8Array | string) =>
	typeof b === "string" ? b : Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the byte fields are Uint8Array in the API (BLOP.tex); the JSON form's bytes are ArrayBuffers
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
const blopIn = (j: unknown) => convert(fromJson(j), toArray) as never
const blopOut = (b: unknown) => toJson(convert(b, toBuffer))

// deno-lint-ignore no-explicit-any
let chains: any
let checked: string[] = []

function answer(r: Request): unknown {
	switch (r.op) {
		case "create":
			checked = []
			chains = createChains(r.node!, (c: never, blop: never) => {
				checked.push(hex(name(encode(blop))))
				return check(c, blop)
			})
			return {}
		case "add":
			return chains.add(blopIn(r.blop), unhex(r.name!))
		case "heads":
			return chains.heads(fromJson(r.object)).map((h: { name: Uint8Array; blop: unknown }) => ({
				name: hex(h.name),
				blop: blopOut(h.blop),
			}))
		case "get": {
			const b = chains.get(unhex(r.name!))
			return b == null ? {} : { blop: blopOut(b) }
		}
		case "waiting":
			return chains.waiting()
		case "refused":
			return chains.refused()
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
