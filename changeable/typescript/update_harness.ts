// The reference for node's update on the line protocol (conformance/typescript/harness.ts): one
// JSON request per line in, one answer per line out, in order. State lasts for the process: one
// entry. Another implementation joins by speaking this (HARNESS).
//
// { op: "start", value?, header? }  → {}   a fresh entry: the value (not given: none), the
//    header its change (not given, or with no time: the time now added, whole seconds since 1970,
//    as node's entry)
//    before any start: an entry with no value and a change of only the time now
// { op: "update", patches, header? }
//    patches: a list (always given) of JSON patches as op's apply has them, applied in order, each
//    on what the last left; header: the change's (default { time: 1, actor: "me" }, never an op),
//    as given: no time added when it has none, {} a change of only the op
//    → {}
//    → { error: { code, patch } }   an ApplyError: code no-key, range, wrong-kind, into-itself or
//      not-a-patch (a patch that is no map, or a path, range or move of the wrong shape), patch the
//      index of the first refused; nothing changes, the change still the last good update's
// { op: "entry" }                   → { entry: { value?, change } }
//    no value key when none; change: the header of the latest update, with op: { patches, undo }
//    (the patches as given, undo their inverse: in the order to apply, applied to the value
//    after it gives the value before). an update's undo given as an update takes the value back;
//    the undo of that makes it again
//    the change's fields: time, actor, reader, frame (a list of infos, innermost first: node's), op; a patch's: path, range,
//    value, move, any other field dropped; -0 as an index is 0
//    a map's key order is not part of its value (op's apply.ts): answers are compared by content
//
// Values are in the JSON form (conformance/typescript/form.ts: revive reads it, toJson writes it),
// typed arrays and bytes too. the header's are plain JSON (node_harness.ts).
// Errors as text, { error: "text" }, the harness going on with the entry as it was: an op not
// understood or not given; an update with no patches, or patches not a list; a value whose JSON
// form stands for none, in a start or an update.
import type { Changeable, ChangeHeader } from "@ermine/changeable"
import update from "@ermine/changeable/update"
import { ApplyError, type Patch } from "@ermine/changeable/apply"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { fromList, toList } from "../../conformance/typescript/frames.ts"

// a changeable of this value and change (no change given: the time now, whole seconds since 1970)
const createChangeable = <V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
): Changeable<V> => {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const c: Changeable<V> = { change }
	if (value !== undefined) c.value = value
	return c
}
let entry: Changeable<unknown> = createChangeable(undefined)

// a change as answered: the header's own fields, a patch's path, range, value and move only
const pick = (o: Record<string, unknown>, keys: string[]) => {
	const out: Record<string, unknown> = {}
	for (const k of keys) if (k in o) out[k] = o[k]
	return out
}
const patchShape = (p: Patch) =>
	pick(p as unknown as Record<string, unknown>, ["path", "range", "value", "move"])
const changeShape = (c: Changeable<unknown>["change"]) => {
	const out = pick(c, ["time", "actor", "reader"])
	if (c.frame !== undefined) out.frame = toList(c.frame)
	if (c.op) {
		out.op = {
			patches: c.op.patches.map(patchShape),
			undo: c.op.undo.map(patchShape),
		}
	}
	return toJson(out)
}

// the header as given, its frame (a list of infos) made into frames
const given = (h: ChangeHeader | undefined) => {
	if (h === undefined || !("frame" in h)) return h
	const frame = fromList(h.frame)
	if (frame === undefined) throw new Error("frame is not a list of objects")
	return { ...h, frame }
}

function answer(r: Request) {
	try {
		return run(r)
	} catch (e) {
		if (e instanceof ApplyError) return { error: { code: e.code, patch: e.patch } }
		throw e
	}
}

function run(r: Request) {
	switch (r.op) {
		case "start":
			entry = createChangeable(
				r.value === undefined ? undefined : revive(r.value),
				given(r.header),
			)
			return {}
		case "entry": {
			const change = changeShape(entry.change)
			return {
				entry: { ...("value" in entry ? { value: toJson(entry.value) } : {}), change },
			}
		}
		case "update": {
			const header = given(r.header) ?? { time: 1, actor: "me" } as ChangeHeader
			const patches = (r.patches as Patch[]).map((p) => revive(p) as Patch)
			update(entry, patches, header)
			return {}
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
