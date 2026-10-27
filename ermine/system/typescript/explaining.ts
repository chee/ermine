// @ermine/system's functions: who wrote what: a change and its writer, one step. each its own export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const explain: System["explain"] = /* @__PURE__ */ marked((x, key) =>
	go("explain", false, impl.explain, x, key)
)
export const explainAttributes: System["explainAttributes"] = /* @__PURE__ */ marked((x) =>
	go("explainAttributes", false, impl.explainAttributes, x)
)
export const explainChildren: System["explainChildren"] = /* @__PURE__ */ marked((x) =>
	go("explainChildren", false, impl.explainChildren, x)
)
