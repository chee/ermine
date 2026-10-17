// The reference for node's update on the line protocol (conformance/typescript/harness.ts): one
// JSON request per line in, one answer per line out, in order. State lasts for the process: one
// entry. Another implementation joins by speaking this (HARNESS).
//
// { op: "start", value?, header?, cow? }  → {}   a fresh entry: the value (not given: none), the
//    header its change (not given, or with no time: the time now added, whole seconds since 1970,
//    as node's entry); cow: false: an entry whose value update changes in place (createEntry's
//    cow option; any other cow, an ordinary entry). Everything it answers is the same as without
//    it, a refused update included: the entry as it was.
//    The values the patches put become the entry's value and change with it, so this harness gives
//    such an entry copies of them and answers the patches as the request had them
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
//    the change's fields: time, actor, reader, external, metadata, op; a patch's: path, range,
//    value, move, any other field dropped; -0 as an index is 0
//    a map's key order is not part of its value (op's apply.ts): answers are compared by content
//
// Values are in the JSON form (conformance/typescript/form.ts: revive reads it, toJson writes it),
// typed arrays and bytes too. the header's are plain JSON (node_harness.ts).
// Errors as text, { error: "text" }, the harness going on with the entry as it was: an op not
// understood or not given; an update with no patches, or patches not a list; a value whose JSON
// form stands for none, in a start or an update.
import createEntry, { type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { ApplyError, type Patch } from "@ermine/op/apply"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../../conformance/typescript/form.ts"

let entry: Entry<unknown> = createEntry(undefined)
// the patches of the latest update as asked, for an entry that changes in place
let asked: Patch[] | undefined

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
			entry = createEntry(
				r.value === undefined ? undefined : revive(r.value),
				r.header,
				r.cow === false ? { cow: false } : {},
			)
			asked = undefined
			return {}
		case "entry": {
			// deno-lint-ignore no-explicit-any
			const change = toJson(entry.change) as Record<string, any>
			if (entry.cow === false && asked && change.op) change.op.patches = toJson(asked)
			return {
				entry: { ...("value" in entry ? { value: toJson(entry.value) } : {}), change },
			}
		}
		case "update": {
			const header = r.header ?? { time: 1, actor: "me" }
			const patches = (r.patches as Patch[]).map((p) => revive(p) as Patch)
			if (entry.cow === false) {
				update(entry, structuredClone(patches), header)
				asked = patches
			} else update(entry, patches, header)
			return {}
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
