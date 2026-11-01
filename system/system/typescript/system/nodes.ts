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

export const getNode: System["getNode"] = /* @__PURE__ */ marked(function getNode(path) {
	return go(getNode, "getNode", false, getNodeAs, path)
})
export const hasNode: System["hasNode"] = /* @__PURE__ */ marked(function hasNode(x) {
	return go(hasNode, "hasNode", false, hasNodeAs, x)
})
export const ensureNode: System["ensureNode"] = /* @__PURE__ */ marked(
	function ensureNode(path, value) {
		return go(ensureNode, "ensureNode", true, ensureNodeAs, path, value)
	},
)
export const createNode: System["createNode"] = /* @__PURE__ */ marked(
	function createNode(folder, value) {
		return go(createNode, "createNode", true, createNodeAs, folder, value)
	},
)
export const ref: System["ref"] = /* @__PURE__ */ marked(function ref(path, make) {
	return go(ref, "ref", true, refAs, path, make)
})

export function getNodeAs(inner: Inner, p: string | Path): Node {
	const { resolve } = here(inner)
	return nodeAt(inner, resolve(p))
}

export function ensureNodeAs(inner: Inner, p: string | Path, value?: unknown): Node {
	return refAs(inner, p, () => value)
}

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

export const hasNodeAs = (inner: Inner, x: Target) =>
	readEntriesAs(inner, x).some((i) => i.refused !== true)
