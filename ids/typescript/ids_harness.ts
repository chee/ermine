// ids (ids.ts) on the line protocol: one JSON request per line in, one answer per line out, in
// order. bytes are lowercase hex; nothing is null. another implementation joins by speaking this
// (HARNESS)
//
// { op: "fresh" }                      → { kind, size, head, round, differs }
//    head: its first two bytes; round: its text parses back to it; differs: from a second fresh
// { op: "hashed", domain, inputs }     → { id }    inputs: strings (UTF-8) or { hex }
// { op: "child", parent, name }        → { id }    parent: not an ermine id is an error
// { op: "outside", outside }           → { id }    outside: a string or { hex }
// { op: "kind", id }                   → { kind }
// { op: "text", id }                   → { text }
// { op: "parse", text }                → { id }
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { child, fresh, hashed, kind, outside, parse, text } from "./ids.ts"

const hex = (b: Uint8Array | undefined) =>
	b === undefined ? null : Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
function unhex(s: unknown): Uint8Array {
	if (typeof s !== "string" || !/^([0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s}`)
	return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
}
const input = (x: unknown) =>
	typeof x === "string" ? x : unhex((x as { hex?: unknown } | null)?.hex)
const str = (x: unknown, what: string) => {
	if (typeof x !== "string") throw new Error(`no ${what}`)
	return x
}

export function answer(r: Request): Record<string, unknown> {
	switch (r.op) {
		case "fresh": {
			const a = fresh(), b = fresh()
			const back = parse(text(a)!)
			return {
				kind: kind(a) ?? null,
				size: a.length,
				head: hex(a.subarray(0, 2)),
				round: back !== undefined && hex(back) === hex(a),
				differs: hex(a) !== hex(b),
			}
		}
		case "hashed":
			if (!Array.isArray(r.inputs)) throw new Error("no inputs")
			return { id: hex(hashed(str(r.domain, "domain"), ...r.inputs.map(input))) }
		case "child":
			return { id: hex(child(unhex(r.parent), str(r.name, "name"))) }
		case "outside":
			return { id: hex(outside(input(r.outside))) }
		case "kind":
			return { kind: kind(unhex(r.id)) ?? null }
		case "text":
			return { text: text(unhex(r.id)) ?? null }
		case "parse":
			return { id: hex(parse(str(r.text, "text"))) }
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

if (import.meta.main) {
	await serve(answer)
}
