// @ermine/system's functions: actions: made, run, and who called. each its own export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const createAction: System["createAction"] = /* @__PURE__ */ marked((path, fn) =>
	go("createAction", true, impl.createAction, path, fn)
)
export const executeAction: System["executeAction"] = /* @__PURE__ */ marked((path, ...args) =>
	go("executeAction", true, impl.executeAction, path, ...args)
)
export const getCaller: System["getCaller"] = /* @__PURE__ */ marked(() =>
	go("getCaller", false, impl.getCaller)
)
