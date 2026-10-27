// @ermine/system's functions: names: a node placed, unplaced, renamed, removed; a folder's names. each its own export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const place: System["place"] = /* @__PURE__ */ marked((path, x) =>
	go("place", true, impl.place, path, x)
)
export const unplace: System["unplace"] = /* @__PURE__ */ marked((path) =>
	go("unplace", true, impl.unplace, path)
)
export const rename: System["rename"] = /* @__PURE__ */ marked((from, to) =>
	go("rename", true, impl.rename, from, to)
)
export const list: System["list"] = /* @__PURE__ */ marked((x) => go("list", false, impl.list, x))
// unplaced and its entries gone, every part's (asked "remove")
export const remove: System["remove"] = /* @__PURE__ */ marked((x) =>
	go("remove", true, impl.remove, x)
)
