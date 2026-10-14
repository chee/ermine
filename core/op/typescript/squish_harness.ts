// squish (squish.ts) on the line protocol (conformance/typescript/harness.ts). Another
// implementation joins by speaking this (HARNESS).
//
// { op: "squish", patches }  →  { patches }   the patches pushed one by one, then what is left
// { op: "encode", patches }  →  { columns }
// { op: "decode", columns }  →  { patches }
// values (a patch's, and columns' value) in ENCODING.tex's JSON form: bytes are
// {"/": {"bytes": b64}}, one whole value that squish never joins or cuts
import { type Columns, decode, encode, squish } from "@ermine/op/squish"
import type { Patch } from "@ermine/op/apply"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

const patchesIn = (ps: Patch[]) =>
	ps.map((p) => "value" in p ? { ...p, value: revive(p.value) } : p)
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
			const columns: Columns = { ...r.columns, value: r.columns.value.map(revive) }
			return { patches: patchesOut(decode(columns)) }
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
