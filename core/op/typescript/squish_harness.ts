// squish (squish.ts) on the line protocol (conformance/typescript/harness.ts). Another
// implementation joins by speaking this (HARNESS).
//
// { op: "squish", patches }  →  { patches }   the patches pushed one by one, then what is left
// { op: "encode", patches }  →  { columns }
// { op: "decode", columns }  →  { patches }
// values (a patch's, and columns' value) in ENCODING.tex's JSON form: bytes are
// {"/": {"bytes": b64}}, one whole value that squish never joins or cuts
// an op not named here, or none: { error: text }, the text not compared. each line is its own
// squisher: nothing lasts between lines
//
// a patch: { path, range?, value?, move? }; any other field dropped. -0 as a key or a position is
//   0. a map's key order is not part of its value (apply.ts): answers are compared by content
//   path: keys, a string or a whole number; 1 and "1" are other keys. a NUL is a key's like any
//   range: [from, to], whole numbers (2^32 and past too); a string's count code points, a list's
//     elements. no value and no move: a removal
//   move: { path, range? }, passed through as given; squish reads only its path
// squish never reads the content, never checks a patch, and gives patches back as given or joined:
//   joins: the last patch kept and the next, both ranged, at the same path, neither a move; the next
//     - inside or at the end of the span the earlier put ([a, a + n), n its value's length):
//       spliced into its value, the range kept
//     - starting at that span's end, running past it: the earlier's value, plus the later's,
//       its range grown by what the later takes
//     - after a removal [a, b): a removal over a (c <= a <= d) is [c, b + d - a]; an insert at a
//       is a replace [a, b] with its value
//     joined, it is joined, as the next, with the patch kept before it, and so on, while they
//     join (merges reach back): so the patches squished, squished again, are the same, and one
//     at a time is all at once (a fouled place aside)
//   values join only kind with kind: string with string, list with list, a typed array with one
//     of its kind. bytes, numbers, maps, null never join; nor does a removal with an insert of
//     anything else
//   kills: a later patch with no range and no move drops earlier ones at or under its path, last
//     first, until one is not; never a move; never a removal of a list element (a number last)
//     by a patch at the same path (the elements after it moved up)
//   [] with no range and no move clears all before it
//   a lone surrogate anywhere in a patch's value (map values, list elements; not map keys) fouls
//     its path; a move from at or under a fouled path fouls its own path, and a fouled path under
//     what it takes is fouled under where it lands. a patch at or under a fouled path is never
//     joined. a patch with a lone surrogate is never joined either. [] with no range and no move
//     clears the fouling too
// columns: { paths, path, shape, from, size, value, move }
//   paths: each distinct path once, in the order first met
//   path, shape, from, size: runs, [x, count, x, count, ...]; encode gives counts of 1 and more,
//     decode takes a count of 0 as none
//   path: per patch, its index in paths. shape: per patch, 1 a range, 2 a value, 4 a move
//   from: per ranged patch, its from less the last ranged patch's from (the first's less 0); a
//     patch with no range leaves it be. size: per ranged patch, to - from
//   value, move: each patch's that has one, in order, as given (not runs)
// columns that do not cover their shape, and patches or columns missing or not lists: an error
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
