// @ermine/system's functions: writes, patches only: a node's value, attributes and children. each its own export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const patch: System["patch"] = /* @__PURE__ */ marked((x, patches) =>
	go("patch", true, impl.patch, x, patches)
)
export const patchAttributes: System["patchAttributes"] = /* @__PURE__ */ marked((x, patches) =>
	go("patchAttributes", true, impl.patchAttributes, x, patches)
)
export const patchChildren: System["patchChildren"] = /* @__PURE__ */ marked((x, patches) =>
	go("patchChildren", true, impl.patchChildrenOnly, x, patches)
)
