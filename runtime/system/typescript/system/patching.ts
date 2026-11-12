import { get } from "@ermine/places/lib"
import { slot as slotOf } from "@ermine/processes/guard"
import { ErmineError } from "../features.ts"
import type { Inner, Patch, Target } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { aimed, attributesOf, idOf, idThrough, needId, nodeOf, thing } from "./addressing.ts"
import { askPlacing, mayRead } from "./asking.ts"
import { unplaced } from "./made.ts"
import { here } from "./setting.ts"
import { build, childrenOf, placeUnder, runningAt } from "./tree.ts"
import type { Patches, System } from "./shapes.ts"

export const patch: System["patch"] = /* @__PURE__ */ marked(function patch(x, patches) {
	return go(patch, "patch", true, patchAs, x, patches)
})
export const patchAttributes: System["patchAttributes"] = /* @__PURE__ */ marked(
	function patchAttributes(x, patches) {
		return go(patchAttributes, "patchAttributes", true, patchAttributesAs, x, patches)
	},
)
export const patchChildren: System["patchChildren"] = /* @__PURE__ */ marked(
	function patchChildren(x, patches) {
		return go(patchChildren, "patchChildren", true, patchChildrenAs, x, patches)
	},
)

// Patches x's part. A function is given the value untracked (reading it is asked too). Nothing at
// x's path: the node is made there (folders on the way too), given undefined, if there are patches.
export function patchAs(inner: Inner, x: Target, given: Patches) {
	const early = typeof given === "function" ? undefined : patchesOnly(given)
	const { inside, ask, places, newId } = here(inner)
	const asked = (value: unknown) =>
		patchesOnly((given as (value: unknown) => readonly Patch[])(value))
	inside(() => {
		const n = nodeOf(inner, x)
		let id = idOf(inner, n)
		let patches = early
		if (id === undefined) {
			patches ??= asked(undefined)
			if (!patches.length) return
			id = newId()
			ask("edit", aimed(id, n.path, n.part))
			build(inner, n.path!, undefined, id)
		} else {
			ask("edit", aimed(id, n.path, n.part))
			if (patches === undefined) {
				mayRead(inner, id, n.path, n.part)
				patches = asked(places.peep(() => places.readValue(n.part, id!)))
			}
		}
		if (patches.length) {
			inner.put({
				part: n.part,
				id,
				...n.path !== undefined && { path: n.path },
				patches,
			})
		}
	})
}

// Patches a folder's names. One name is a patch: { path: [name], value: node } places, and
// { path: [name] } unplaces. Each name is asked "place". A missing folder is made if a name is placed.
export function patchChildrenAs(inner: Inner, x: Target, given: readonly Patch[]) {
	const patches = patchesOnly(given)
	const { base, places, inside, ask } = here(inner)
	inside(() => {
		const n = nodeOf(inner, x)
		const placing = patches.some((p) => "value" in p && p.value !== undefined)
		const folder = idOf(inner, n) ??
			(placing && n.path !== undefined ? build(inner, n.path, undefined) : needId(inner, n))
		for (const p of patches) {
			const name = p.path[0]
			if (p.path.length !== 1 || typeof name !== "string" || p.move !== undefined) {
				throw new ErmineError(
					"not-patches",
					"patchChildren: one name a patch, { path: [name], value: node } or { path: [name] }",
				)
			}
			const slot = slotOf(thing(folder, n.path), name)
			const children = childrenOf(inner, folder)
			if ("value" in p && p.value !== undefined) {
				const id = idThrough(inner, p.value as Target)
				askPlacing(inner, slot, p.value as Target, id)
				placeUnder(inner, folder, name, id)
			} else {
				const path = n.path === undefined ? undefined : [...n.path, name]
				const at = path === undefined ? undefined : get(places, path)
				if (path !== undefined && runningAt(base, path, at)) {
					ask("place", slot)
					base.stop(at!)
				} else if (children !== undefined) {
					ask("place", slot)
					unplaced(inner, folder, name)
				}
			}
		}
	})
}

export const patchAttributesAs = (inner: Inner, x: Target, patches: Patches) =>
	patchAs(inner, attributesOf(inner, x), patches)

function patchesOnly(patches: unknown): readonly Patch[] {
	if (!Array.isArray(patches)) {
		throw new ErmineError(
			"not-patches",
			"patch takes patches, [{ path, value }], or a function of the value giving them",
		)
	}
	return patches
}
