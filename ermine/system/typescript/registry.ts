// the registry @ermine/system's functions find their context by (ermine/system/mod.ts): which
// schedulers to look in, and which scope finds which process context. module state, never on a
// global: only createErmine registers (ermine.ts). one copy through the import map is what makes
// the functions find their processes (module identity)
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Inner } from "./context.ts"
import { ErmineError } from "./features.ts"

// each scheduler, and how many ermines registered it
const schedulers = new Map<Scheduler, number>()
// a scope a context is found by → that context
const scopes = new WeakMap<Scope, Inner>()

// a scope found to its context, from here on (kept while the scope is)
export function registerScope(scope: Scope, inner: Inner) {
	scopes.set(scope, inner)
}

// s looked in, from here on (an ermine made); gives its letting go (the ermine closed)
export function registerScheduler(s: Scheduler): () => void {
	schedulers.set(s, (schedulers.get(s) ?? 0) + 1)
	let gone = false
	return () => {
		if (gone) return
		gone = true
		const n = (schedulers.get(s) ?? 1) - 1
		if (n <= 0) schedulers.delete(s)
		else schedulers.set(s, n)
	}
}

// the context scope (or one above it) is found by; none: undefined
function contextAt(scope: Scope | undefined): Inner | undefined {
	for (let o = scope; o !== undefined; o = o.parent) {
		const inner = scopes.get(o)
		if (inner !== undefined) return inner
	}
	return undefined
}

// what a function is given: the context it acts as, and, when that context's scope is to be opened
// round it, the opening (host and feature code acting as a context)
export type Found = { readonly inner: Inner; readonly within?: <T>(f: () => T) => T }

// the context for name: the scope open now's; nothing open: nothing-open, a handle given or not
// [chee 10-26: "let's just make it throw for now, i would like to come back to this later"]
export function foundFor(name: string): Found {
	return { inner: found(name) }
}

// the context the scope open now is in; none: nothing-open, naming the function. of several
// schedulers, the first with a scope open whose walk finds one
export function found(name: string): Inner {
	for (const s of schedulers.keys()) {
		const inner = contextAt(s.getCurrentScope())
		if (inner !== undefined) return inner
	}
	throw new ErmineError(
		"nothing-open",
		`${name}: nothing is open here (a module's top level, a timer, a listener, or after an ` +
			`await): call it from a setup, a memo, an effect or an action`,
	)
}
