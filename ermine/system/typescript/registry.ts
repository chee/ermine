// the registry @ermine/system's functions find their context by (ermine/system/mod.ts): which
// schedulers to look in, the ermines entered now, and which scope finds which process context.
// module state, never on a global: only createErmine registers (ermine.ts). one copy through the
// import map is what makes the functions find their processes (module identity); a second copy
// loaded is told apart only to say so (two-copies)
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

// how many ermines registered give hints (createErmine's hints, hints.ts)
let hinted = 0
// whether a function finding no context (nothing-open) gives its advice: some ermine open does
export const hinting = (): boolean => hinted > 0

// s looked in, from here on (an ermine made, hints: whether it gives them); gives its letting go
// (the ermine closed)
export function registerScheduler(s: Scheduler, hints = true): () => void {
	schedulers.set(s, (schedulers.get(s) ?? 0) + 1)
	if (hints) hinted++
	let gone = false
	return () => {
		if (gone) return
		gone = true
		if (hints) hinted--
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

// the ermines entered now, by scheduler, the innermost last: an ermine's host functions, start,
// close, pulse and a context's within enter it as they run and leave it as they return, so code of
// one ermine run inside another's (b.executeAction in an action of a) finds its own
const entered: Scheduler[] = []
export function enterScheduler(s: Scheduler) {
	entered.push(s)
}
export function leaveScheduler() {
	entered.pop()
}

// the context the scope open now is in; none: nothing-open, naming the function. the innermost
// ermine entered with a scope open whose walk finds one; none entered: of several schedulers, the
// first with one
export function found(name: string): Inner {
	for (let i = entered.length - 1; i >= 0; i--) {
		const inner = contextAt(entered[i].getCurrentScope())
		if (inner !== undefined) return inner
	}
	for (const s of schedulers.keys()) {
		const inner = contextAt(s.getCurrentScope())
		if (inner !== undefined) return inner
	}
	const other = copies.find((c) => c !== copy && c.open())
	if (other !== undefined) {
		throw new ErmineError(
			"two-copies",
			`${name}: two copies of @ermine/system are loaded (${other.url} and ${copy.url}): ` +
				`each finds only the processes its own createErmine made`,
		)
	}
	throw new ErmineError(
		"nothing-open",
		`${name}: nothing is open here (a module's top level, a timer, a listener, or after an ` +
			`await): call it from a setup, a memo, an effect or an action`,
	)
}

// every copy of this file loaded, on one global list, only so a function finding nothing can say
// a second copy is what it missed: its file, and whether one of its ermines has a scope open
type Copy = { readonly url: string; readonly open: () => boolean }
const COPIES = Symbol.for("party.chee.ermine.system.copies")
const copy: Copy = {
	url: import.meta.url,
	open: () => [...schedulers.keys()].some((s) => contextAt(s.getCurrentScope()) !== undefined),
}
const copies: Copy[] = ((globalThis as Record<symbol, Copy[] | undefined>)[COPIES] ??= [])
copies.push(copy)
