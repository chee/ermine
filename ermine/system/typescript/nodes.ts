// @ermine/system's functions: a node by path, made or not: getNode, hasNode, ensureNode, createNode, ref. each its own export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const getNode: System["getNode"] = /* @__PURE__ */ marked((path) =>
	go("getNode", false, impl.getNode, path)
)
export const hasNode: System["hasNode"] = /* @__PURE__ */ marked((x) =>
	go("hasNode", false, impl.hasNode, x)
)
export const ensureNode: System["ensureNode"] = /* @__PURE__ */ marked((path, value) =>
	go("ensureNode", true, impl.ensureNode, path, value)
)
export const createNode: System["createNode"] = /* @__PURE__ */ marked((folder, value) =>
	go("createNode", true, impl.createNode, folder, value)
)
export const ref: System["ref"] = /* @__PURE__ */ marked((path, make) =>
	go("ref", true, impl.ref, path, make)
)
