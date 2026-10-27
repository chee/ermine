// @ermine/system's functions: computing: memos, effects, pipes, and a pulse now. each its own export, so a build keeps only those imported;
// each runs its implementation (system.ts) as the context it finds (acting.ts)
import { go } from "./acting.ts"
import { marked } from "./site.ts"
import * as impl from "./system.ts"
import type { System } from "./system.ts"

export const createMemo: System["createMemo"] = /* @__PURE__ */ marked((name, f, options) =>
	go("createMemo", true, impl.createMemo, name, f as never, options as never)
)
export const createEffect: System["createEffect"] = /* @__PURE__ */ marked((
	name,
	f,
	act,
	options,
) => go("createEffect", true, impl.createEffect, name, f as never, act as never, options as never))
export const pipe: System["pipe"] = /* @__PURE__ */ marked((from, ...rest) =>
	go("pipe", true, impl.pipe, from, ...rest)
)
// the pending pulse, now (in a pulse: nothing)
export const pulse: System["pulse"] = /* @__PURE__ */ marked(() => go("pulse", false, impl.pulse))
