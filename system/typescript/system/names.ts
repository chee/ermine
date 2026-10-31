import { moving, type Path } from "@ermine/places"
import { get } from "@ermine/places/lib"
import type { Inner, Target } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { aimed, idThrough, needId, nodeOf, slotAt } from "./addressing.ts"
import { askPlacing } from "./asking.ts"
import { stopMade, unplaced } from "./made.ts"
import { here } from "./setting.ts"
import {
	childrenOf,
	needParent,
	nodeGone,
	notShadowed,
	parentOf,
	placeUnder,
	runningAt,
	slot,
	takeOut,
	under,
} from "./tree.ts"
import type { System } from "./shapes.ts"

export const place: System["place"] = /* @__PURE__ */ marked(function place(path, x) {
	return go(place, "place", true, placeAs, path, x)
})
export const unplace: System["unplace"] = /* @__PURE__ */ marked(function unplace(path) {
	return go(unplace, "unplace", true, unplaceAs, path)
})
export const rename: System["rename"] = /* @__PURE__ */ marked(function rename(from, to) {
	return go(rename, "rename", true, renameAs, from, to)
})
export const remove: System["remove"] = /* @__PURE__ */ marked(function remove(x) {
	return go(remove, "remove", true, removeAs, x)
})

export function placeAs(inner: Inner, p: string | Path, x: Target) {
	const { inside, resolve } = here(inner)
	inside(() => {
		const path = resolve(p)
		const id = idThrough(inner, x)
		const parent = needParent(inner, path)
		askPlacing(inner, slotAt(path, parent), x, id)
		placeUnder(inner, parent, path[path.length - 1], id)
	})
}

// Taking a name out of a folder stops the process whose row names it. A saved child that something
// else shadows at that name is not the folder's to take out: that is nothing-there.
export function unplaceAs(inner: Inner, p: string | Path) {
	const { base, places, inside, resolve, ask } = here(inner)
	inside(() => {
		const path = resolve(p)
		const id = get(places, path)
		if (runningAt(base, path, id)) {
			const folder = parentOf(inner, path)
			ask("place", folder === undefined ? aimed(id!, path) : slotAt(path, folder))
			return base.stop(id!)
		}
		const [children, name] = slot(inner, path)
		notShadowed(inner, path, children, name)
		const parent = parentOf(inner, path)!
		ask("place", slotAt(path, parent))
		unplaced(inner, parent, name)
	})
}

export function renameAs(inner: Inner, from: string | Path, to: string | Path) {
	const { guard, inside, resolve, ask } = here(inner)
	inside(() => {
		const fromPath = resolve(from)
		const source = slot(inner, fromPath)
		notShadowed(inner, fromPath, source[0], source[1])
		const sourceParent = parentOf(inner, fromPath)!
		guard.move(fromPath, resolve(to))
		ask("place", slotAt(fromPath, sourceParent))
		const path = resolve(to)
		const parent = needParent(inner, path)
		ask("place", slotAt(path, parent))
		const into = childrenOf(inner, parent)
		for (const m of moving(source, [into, path[path.length - 1]])) {
			inner.put({
				part: "children",
				id: m.entry === "from" ? sourceParent : parent,
				patches: m.patches,
			})
		}
	})
}

export function removeAs(inner: Inner, x: Target) {
	const { base, inside, ask } = here(inner)
	inside(() => {
		const n = nodeOf(inner, x)
		const id = needId(inner, n)
		ask("remove", aimed(id, n.path))
		const below = under(inner, id)
		if (base.processes.has(id)) base.stop(id)
		else if (n.path !== undefined && n.path.length) {
			const [, name] = slot(inner, n.path)
			takeOut(inner, parentOf(inner, n.path)!, name, id)
		}
		nodeGone(inner, id, { runs: true, calls: true, held: true })
		stopMade(inner, below, id)
	})
}
