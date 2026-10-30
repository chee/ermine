// The registry that @ermine/system's functions find their context by. It is module state, and
// only createErmine registers. Functions find their processes by module identity, so a second
// copy of this file is detected only to report it (two-copies).
import type { Scheduler, Scope } from "@ermine/reactivity"
import type { Inner } from "./context.ts"
import { ErmineError, type Errored } from "./features.ts"

const schedulers = new Map<Scheduler, number>()
const scopes = new WeakMap<Scope, Inner>()

export function registerScope(scope: Scope, inner: Inner) {
	scopes.set(scope, inner)
}

const erring: Errored[] = []
export const unfound = (e: unknown, fn?: string): unknown => erring.length ? erring[0](e, fn) : e

export function registerScheduler(s: Scheduler, onError?: Errored): () => void {
	schedulers.set(s, (schedulers.get(s) ?? 0) + 1)
	if (onError) erring.push(onError)
	let gone = false
	return () => {
		if (gone) return
		gone = true
		if (onError) erring.splice(erring.indexOf(onError), 1)
		const n = (schedulers.get(s) ?? 1) - 1
		if (n <= 0) schedulers.delete(s)
		else schedulers.set(s, n)
	}
}

export const registrations = (s: Scheduler): number => schedulers.get(s) ?? 0

function contextAt(scope: Scope | undefined): Inner | undefined {
	for (let o = scope; o !== undefined; o = o.parent) {
		const inner = scopes.get(o)
		if (inner !== undefined) return inner
	}
	return undefined
}

// The ermines entered now, innermost last, so code of one ermine run inside another's finds its own.
const entered: Scheduler[] = []
export function enterScheduler(s: Scheduler) {
	entered.push(s)
}
export function leaveScheduler() {
	entered.pop()
}

// The context of the open scope. With none open this throws nothing-open naming the function.
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

// Every copy of this file loaded, only so an error can say a second copy exists.
type Copy = { readonly url: string; readonly open: () => boolean }
const COPIES = Symbol.for("party.chee.ermine.system.copies")
const copy: Copy = {
	url: import.meta.url,
	open: () => [...schedulers.keys()].some((s) => contextAt(s.getCurrentScope()) !== undefined),
}
const copies: Copy[] = ((globalThis as Record<symbol, Copy[] | undefined>)[COPIES] ??= [])
copies.push(copy)
