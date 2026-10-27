// @ermine/system's functions: the process's own: its status, teardowns and args. each its own
// export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const getStatus: System["getStatus"] = /* @__PURE__ */ marked((x) =>
	go("getStatus", false, impl.getStatus, x)
)
export const addTeardown: System["addTeardown"] = /* @__PURE__ */ marked((fn) =>
	go("addTeardown", false, impl.addTeardown, fn)
)
export const getArgs: System["getArgs"] = /* @__PURE__ */ marked(() =>
	go("getArgs", false, impl.getArgs)
)
