// a stand-in library: makes a scope on behalf of its caller
import type { Scope } from "@ermine/core/scheduler"
import type { Sited } from "./sites.ts"

export function make(sited: Sited, parent: Scope): Scope {
	return sited.createScope(INFO, parent)
}

export const INFO = { owner: "test" }
