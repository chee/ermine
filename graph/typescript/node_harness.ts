// The reference node.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order.
//
// { op: "entry", value?, header? } → { entry: { value?, change } }
//   value: any JSON (null is a value; absent means none), with typed arrays and bytes in the JSON
//   form of conformance/typescript/form.ts. header: the change header as given, never an op.
//   entry has no value key when there is none. change has the header's fields as given (time,
//   actor, reader, frame, op) and any other field dropped, with the time now (whole seconds since
//   1970) when none was given. A time of -0 is 0; time is a whole number (0 and negatives stay);
//   actor is any JSON, null too; reader is a string; frame is a list of infos, innermost first
//   (conformance/typescript/frames.ts), each an object, with its locations (what began outside
//   the graph) a list of { file, line, column?, function?, external } in plain JSON.
//   The value comes back as it was read: -0 stays, and NUL and lone surrogates stay in strings
//   and keys. A typed array's elements are as its kind holds them (float32 rounded, an integer
//   kind's -0 is 0, 64-bit as plain decimal). A map's key order is not part of its value, so
//   answers are compared by content.
// { op: "node", values: { <table>: value, ... }, header? } → { node: { <table>: entry, ... } }
//   Table names are any string. Values are as above (a table left out is not given). One header
//   for every table, with the same time now for all if it has none.
// Errors are { error: "text" } (the text is not part of the protocol) and the harness goes on:
//   an op not understood or absent (ops are case-sensitive); a node with no values map; a frame
//   that is not a non-empty list of objects; a value whose JSON form is refused (fromJson in
//   form.ts: bad base64, an element out of its kind's range, an unknown kind, a "/" map that is
//   no form), at any depth, in any table. Nothing is made.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/graph/entry"
import createNode from "@ermine/graph/node"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { fromList, toList } from "../../conformance/typescript/frames.ts"

// The header as given, with its frame (a list of infos) made into frames.
const checked = (h: ChangeHeader | undefined) => {
	if (h === undefined || !("frame" in h)) return h
	const frame = fromList(h.frame)
	if (frame === undefined) throw new Error("frame is not a list of objects")
	return { ...h, frame }
}

const make = (r: Request) =>
	createEntry(r.value === undefined ? undefined : revive(r.value), checked(r.header))

// A header's fields in a fixed order, since a record's order has no meaning.
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
