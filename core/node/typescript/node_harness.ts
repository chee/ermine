// The reference node.ts on the line protocol (conformance/typescript/harness.ts): one JSON request
// per line in, one answer per line out, in order. Another implementation joins by speaking this
// (HARNESS).
//
// { op: "entry", value?, header? } → { entry: { value?, change } }
//    value: any JSON (null is a value; not given: none), typed arrays and bytes in the JSON form
//    (conformance/typescript/form.ts: revive reads it, toJson writes it). header: the change
//    header as given (never an op)
//    entry: no value key when none; change: the header's fields as given, and the time now (whole
//    seconds since 1970) when it gave none; in the header's order: time, actor, reader, external,
//    metadata, op. any other field dropped. a time of -0 is 0
//    the header's fields: time a whole number (0 and negatives kept); actor any JSON, null too;
//    reader a string; external a list of sites { file, line, column?, function? }, answered in
//    that order, column and function only when given; metadata a list of [string, value] pairs,
//    in order, repeats kept. plain JSON, not the JSON form: give no form there
//    the value given back as it was read: a map's keys in their order, -0 kept, NUL and lone
//    surrogates kept in strings and keys; a typed array's elements as its kind holds them
//    (float32 rounded, an integer kind's -0 is 0, 64-bit as plain decimal: "-0" is "0", "007"
//    is "7")
// { op: "node", values: { <table>: value, ... }, header? } → { node: { <table>: entry, ... } }
//    each table name any string (NUL, lone surrogates, __proto__ too), in the order given; each
//    value as above (JSON has no undefined: a table left out is not given); one header for every
//    table, and with no time the same time now for all. values: a map, always given
// Errors, as { error: "text" } (the text is no part of the protocol), the harness going on:
//    an op not understood or not given (ops are case-sensitive); a node with no values map; a
//    metadata entry that is not a [string, value] pair; a value whose JSON form stands
//    for none (form.ts fromJson's refusals: bad base64 or padding, an element out of its kind's
//    range, an unknown kind, a "/" map that is no form), at any depth, in any table: nothing made
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import createNode from "@ermine/node"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../../conformance/typescript/form.ts"

const make = (r: Request) =>
	createEntry(r.value === undefined ? undefined : revive(r.value), r.header)

// a header's fields in its order: a record, whose order is no meaning, answered in one
const FIELDS = ["time", "actor", "reader", "external", "metadata", "op"]
const header = (c: ChangeHeader) => {
	const out: Record<string, unknown> = {}
	for (const k of FIELDS) if (k in c) out[k] = c[k as keyof ChangeHeader]
	for (const k of Object.keys(c)) if (!(k in out)) out[k] = c[k as keyof ChangeHeader]
	return toJson(out)
}

const show = (e: Entry<unknown>) => ({
	...("value" in e ? { value: toJson(e.value) } : {}),
	change: header(e.change),
})

function answer(r: Request) {
	if (r.op === "entry") return { entry: show(make(r)) }
	if (r.op === "node") {
		const values: Record<string, unknown> = {}
		for (const [t, v] of Object.entries(r.values as Record<string, unknown>)) {
			Object.defineProperty(values, t, {
				value: revive(v),
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		const node = createNode(values, r.header as ChangeHeader | undefined)
		const out: Record<string, unknown> = {}
		for (const [t, e] of Object.entries(node)) {
			Object.defineProperty(out, t, {
				value: show(e),
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		return { node: out }
	}
	return { error: `unknown op ${r.op}` }
}

if (import.meta.main) await serve(answer)
