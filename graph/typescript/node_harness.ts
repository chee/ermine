// The reference node.ts on the line protocol (conformance/typescript/harness.ts): one JSON request
// per line in, one answer per line out, in order. Another implementation joins by speaking this
// (HARNESS).
//
// { op: "entry", value?, header? } → { entry: { value?, change } }
//    value: any JSON (null is a value; not given: none), typed arrays and bytes in the JSON form
//    (conformance/typescript/form.ts: revive reads it, toJson writes it). header: the change
//    header as given (never an op)
//    entry: no value key when none; change: the header's fields as given (time, actor, reader,
//    frame, op), and the time now (whole seconds since 1970) when it gave none. any
//    other field dropped. a time of -0 is 0
//    the header's fields: time a whole number (0 and negatives kept); actor any JSON, null too;
//    reader a string; frame a list of infos, innermost first (conformance/typescript/frames.ts):
//    each an object, any keys, any values; an info's locations (what began outside the graph) a
//    list of { file, line, column?, function?, external }, column and function only when given.
//    plain JSON, not the JSON form: give no form there
//    the value given back as it was read: -0 kept, NUL and lone surrogates kept in strings and
//    keys; a typed array's elements as its kind holds them
//    (float32 rounded, an integer kind's -0 is 0, 64-bit as plain decimal: "-0" is "0", "007"
//    is "7"). a map's key order is not part of its value (op's apply.ts): answers are compared by
//    content
// { op: "node", values: { <table>: value, ... }, header? } → { node: { <table>: entry, ... } }
//    each table name any string (NUL, lone surrogates, __proto__ too); each
//    value as above (JSON has no undefined: a table left out is not given); one header for every
//    table, and with no time the same time now for all. values: a map, always given
// Errors, as { error: "text" } (the text is no part of the protocol), the harness going on:
//    an op not understood or not given (ops are case-sensitive); a node with no values map; a
//    frame that is not a non-empty list of objects (an object, null, a list of lists, ...); a value whose JSON form stands
//    for none (form.ts fromJson's refusals: bad base64 or padding, an element out of its kind's
//    range, an unknown kind, a "/" map that is no form), at any depth, in any table: nothing made
import createEntry, { type ChangeHeader, type Entry } from "@ermine/graph/entry"
import createNode from "@ermine/graph/node"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { fromList, toList } from "../../conformance/typescript/frames.ts"

// the header as given, its frame (a list of infos) made into frames
const checked = (h: ChangeHeader | undefined) => {
	if (h === undefined || !("frame" in h)) return h
	const frame = fromList(h.frame)
	if (frame === undefined) throw new Error("frame is not a list of objects")
	return { ...h, frame }
}

const make = (r: Request) =>
	createEntry(r.value === undefined ? undefined : revive(r.value), checked(r.header))

// a header's fields in its order: a record, whose order is no meaning, answered in one
const FIELDS = ["time", "actor", "reader", "frame", "op"]
const header = (c: ChangeHeader) => {
	const out: Record<string, unknown> = {}
	for (const k of FIELDS) {
		if (k in c) {
			out[k] = k === "frame" ? toList(c.frame) : c[k as keyof ChangeHeader]
		}
	}
	return toJson(out)
}

const show = (e: Entry<unknown>) => ({
	...("value" in e ? { value: toJson(e.value) } : {}),
	change: header(e.change),
})

function answer(r: Request) {
	if (r.op === "entry") return { entry: show(make(r)) }
	if (r.op === "node") {
		if (typeof r.values !== "object" || r.values === null || Array.isArray(r.values)) {
			throw new Error("no values map")
		}
		const values: Record<string, unknown> = {}
		for (const [t, v] of Object.entries(r.values as Record<string, unknown>)) {
			Object.defineProperty(values, t, {
				value: revive(v),
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		const node = createNode(values, checked(r.header as ChangeHeader | undefined))
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
