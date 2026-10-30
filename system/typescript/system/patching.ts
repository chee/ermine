import { get } from "@ermine/places/lib"
import { slot as slotOf } from "@ermine/processes/guard"
import { ErmineError } from "../features.ts"
import type { Inner, Patch, Target } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { aimed, attributesOf, idThrough, needId, nodeOf, thing } from "./addressing.ts"
import { askPlacing } from "./asking.ts"
import { unplaced } from "./made.ts"
import { here } from "./setting.ts"
import { childrenOf, placeUnder, runningAt } from "./tree.ts"
import type { System } from "./shapes.ts"

// public (mod.ts exports them): each runs its implementation below, named with As, as the
// context it finds (acting.ts' go)
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

// x's part patched: patches only, never a recipe (the base is mechanical [chee 10-25: "the core
// lib should actually not have proxies, and should be this kind of mechanical thing"])
export function patchAs(inner: Inner, x: Target, given: readonly Patch[]) {
	const patches = patchesOnly(given)
	const { inside, ask } = here(inner)
	inside(() => {
		const n = nodeOf(inner, x)
		const id = needId(inner, n)
		ask("edit", aimed(id, n.path, n.part))
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

// a folder's names patched: one name a patch, { path: [name], value: node } placing node there,
// { path: [name] } unplacing it; anything else not-patches (a process never writes a children
// entry whole: its ids). each name asked "place", as place asks
export function patchChildrenAs(inner: Inner, x: Target, given: readonly Patch[]) {
	const patches = patchesOnly(given)
	const { base, places, inside, ask } = here(inner)
	inside(() => {
		const n = nodeOf(inner, x)
		const folder = needId(inner, n)
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
				// a path in a patch: the caller's, resolved as the caller resolves it [the dormouse's finding 1]
				const id = idThrough(inner, p.value as Target)
				askPlacing(inner, slot, p.value as Target, id)
				placeUnder(inner, folder, name, id)
			} else {
				// as unplace has it (names.ts): a process running at the name (a row names it) is stopped
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

export const patchAttributesAs = (inner: Inner, x: Target, patches: readonly Patch[]) =>
	patchAs(inner, attributesOf(inner, x), patches)

// patches, never a recipe; anything else: not-patches
function patchesOnly(patches: unknown): readonly Patch[] {
	if (!Array.isArray(patches)) {
		throw new ErmineError("not-patches", "patch takes patches: [{ path, value }]")
	}
	return patches
}
