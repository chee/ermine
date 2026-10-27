// @ermine/system's functions: reads, tracked (peep: untracked): read, readAll and readEntries, a node's value, attributes and children. each its own export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const read: System["read"] = /* @__PURE__ */ marked((x, key) =>
	go("read", false, impl.read, x, key)
)
export const readAttributes: System["readAttributes"] = /* @__PURE__ */ marked((x, key) =>
	go("readAttributes", false, impl.readAttributes, x, key)
)
export const readChildren: System["readChildren"] = /* @__PURE__ */ marked((x) =>
	go("readChildren", false, impl.readChildren, x)
)
export const readAll: System["readAll"] = /* @__PURE__ */ marked((x, key) =>
	go("readAll", false, impl.readAll, x, key)
)
export const readAllAttributes: System["readAllAttributes"] = /* @__PURE__ */ marked((x, key) =>
	go("readAllAttributes", false, impl.readAllAttributes, x, key)
)
export const readAllChildren: System["readAllChildren"] = /* @__PURE__ */ marked((x) =>
	go("readAllChildren", false, impl.readAllChildren, x)
)
export const readEntries: System["readEntries"] = /* @__PURE__ */ marked((x) =>
	go("readEntries", false, impl.readEntries, x)
)
export const peep: System["peep"] = /* @__PURE__ */ marked((f) => go("peep", false, impl.peep, f))
