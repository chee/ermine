// Line-protocol harness for squish.ts, one JSON request per line.
//   { op: "squish", patches }  ->  { patches }
//   { op: "encode", patches }  ->  { columns }
//   { op: "decode", columns }  ->  { patches }
// Anything bad answers { error: text }. Values use the JSON form of conformance/typescript/form.ts.
// Columns: { paths, path, shape, from, size, value, move }; the last four are runs [x, count, ...].
import { type Columns, decode, encode, squish } from "@ermine/changeable/squish"
import type { Patch } from "@ermine/changeable/apply"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"

const patchesIn = (ps: Patch[]) =>
	ps.map(({ path, range, value, move }) => {
		const p: Patch = { path }
		if (range !== undefined) p.range = range
		if (value !== undefined) p.value = revive(value)
		if (move !== undefined) p.move = move
		return p
	})
const patchesOut = (ps: Patch[]) =>
	ps.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p)

function answer(r: Request): Record<string, unknown> {
	switch (r.op) {
		case "squish":
			return { patches: patchesOut(squish(patchesIn(r.patches))) }
		case "encode": {
			const columns = encode(patchesIn(r.patches))
			return { columns: { ...columns, value: columns.value.map(toJson) } }
		}
		case "decode": {
			const c = r.columns
			const fields = ["paths", "path", "shape", "from", "size", "value", "move"]
			if (c === null || typeof c !== "object" || !fields.every((f) => Array.isArray(c[f]))) {
				return { error: "columns: not a map of lists" }
			}
			const columns: Columns = { ...r.columns, value: r.columns.value.map(revive) }
			return { patches: patchesOut(decode(columns)) }
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
