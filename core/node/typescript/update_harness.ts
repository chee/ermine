// The reference for node's update on the line protocol (conformance/typescript/harness.ts): one
// JSON request per line in, one answer per line out, in order. State lasts for the process: one
// node. Another implementation joins by speaking this (HARNESS).
//
// { op: "start", value?, header?, cow? }  → {}   a fresh node: the value (not given: none), the
//    header its change (not given: an empty one); cow: false: a node whose value update changes in
//    place (createNode's cow option). Everything it answers is the same as without it, a refused
//    update included: the node as it was (by content: a key put back goes last in its order).
//    The values the patches put become the node's value and change with it, so this harness gives
//    such a node copies of them and answers the patches as the request had them
// { op: "update", patches, header? }
//    patches: JSON patches as op's apply has them; header: the change's (default
//    { time: 1, actor: "me" }, never an op)
//    → {}
//    → { error: { code, patch } }   an ApplyError; nothing changes
// { op: "node" }                    → { node: { value?, change } }
//    no value key when none; change: the header of the latest update, with op: { patches, undo }
//    (the patches as given, undo their inverse)
//
// Values are in the JSON form (conformance/typescript/form.ts: revive reads it, toJson writes it),
// typed arrays and bytes too.
// Anything not understood: { error: "text" }.
import createNode, { type Node } from "@ermine/node"
import update from "@ermine/node/update"
import { ApplyError, type Patch } from "@ermine/op/apply"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../../conformance/typescript/form.ts"

let node: Node<unknown> = createNode()
// the patches of the latest update as asked, for a node that changes in place
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
			node = createNode(
				r.value === undefined ? undefined : revive(r.value),
				r.header,
				r.cow === false ? { cow: false } : {},
			)
			asked = undefined
			return {}
		case "node": {
			// deno-lint-ignore no-explicit-any
			const change = toJson(node.change) as Record<string, any>
			if (node.cow === false && asked && change.op) change.op.patches = toJson(asked)
			return {
				node: { ...("value" in node ? { value: toJson(node.value) } : {}), change },
			}
		}
		case "update": {
			const header = r.header ?? { time: 1, actor: "me" }
			const patches = (r.patches as Patch[]).map((p) => revive(p) as Patch)
			if (node.cow === false) {
				update(node, structuredClone(patches), header)
				asked = patches
			} else update(node, patches, header)
			return {}
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
