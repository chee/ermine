import type { Path } from "@ermine/places"
import { get } from "@ermine/places/lib"
import type { Inner, Node, Target } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { nodeAt } from "./addressing.ts"
import { readEntriesAs } from "./reading.ts"
import { here } from "./setting.ts"
import { build } from "./tree.ts"
import type { System } from "./shapes.ts"

// public (mod.ts exports them): each runs its implementation below, named with As, as the
// context it finds (acting.ts' go)
export const getNode: System["getNode"] = /* @__PURE__ */ marked((path) =>
	go("getNode", false, getNodeAs, path)
)
export const hasNode: System["hasNode"] = /* @__PURE__ */ marked((x) =>
	go("hasNode", false, hasNodeAs, x)
)
export const ensureNode: System["ensureNode"] = /* @__PURE__ */ marked((path, value) =>
	go("ensureNode", true, ensureNodeAs, path, value)
)
export const createNode: System["createNode"] = /* @__PURE__ */ marked((folder, value) =>
	go("createNode", true, createNodeAs, folder, value)
)
export const ref: System["ref"] = /* @__PURE__ */ marked((path, make) =>
	go("ref", true, refAs, path, make)
)

// the node at p, as a handle: made nothing
export function getNodeAs(inner: Inner, p: string | Path): Node {
	const { resolve } = here(inner)
	return nodeAt(inner, resolve(p))
}

// the node at p, made (with the folders on the way) if missing: holding value, or nothing (no
// value); there already: as it is
export function ensureNodeAs(inner: Inner, p: string | Path, value?: unknown): Node {
	return refAs(inner, p, () => value)
}

// a new node under folder, named by a fresh name of its own: drawn as an id is, but never its id
// (a name is what list gives, and a process holds no ids)
export function createNodeAs(inner: Inner, folder: string | Path, value: unknown): Node {
	const { newId, inside, resolve } = here(inner)
	const id = newId()
	const path = [...resolve(folder), String(newId())]
	inside(() => build(inner, path, value, id))
	return nodeAt(inner, path)
}

export function refAs<T>(inner: Inner, p: string | Path, made: () => T): Node {
	const { places, inside, resolve } = here(inner)
	const path = resolve(p)
	inside(() => {
		if (get(places, path) === undefined) build(inner, path, made())
	})
	return nodeAt(inner, path)
}

// whether a node is there: one that readEntries gives, the policy not refusing it
export const hasNodeAs = (inner: Inner, x: Target) =>
	readEntriesAs(inner, x).some((i) => i.refused !== true)
