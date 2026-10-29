// build locations: a call's location written in at build time (@ermine/bundling), so a write made
// through it captures nothing (it stands in for the stack, as a one-item list of locations). the
// plugin's module (ermine:site) mints them here, one per call it rewrote, and wraps the call:
// at(s, patch)(x, p). a site is an opaque token, its place held here by it, so no holder can change
// where it points or make one of its own from what it holds; the runtime takes a build location
// only from a token minted here, and only for one of @ermine/system's functions (marked by mod.ts),
// set as the call starts (after its arguments are evaluated) and taken by the first function to run
// (acting.ts's go), so a call in the arguments, or one the function makes, never gets it. anything
// else: the stack, from outside the graph. this entry (@ermine/system/site) is the plugin's: it
// refuses to build a program that names it or its module, so a program never holds the mint, only
// the tokens of its own calls, through calls
import type { Location } from "@ermine/changeable/stacktrace"

// a site minted here: nothing to read in it
export type Site = { readonly __site: unique symbol }

// each token's place, and the wrapper of the one function called there (a call site calls one)
const minted = new WeakMap<Site, { at: Location; f?: unknown; w?: unknown }>()
// @ermine/system's functions: the only ones a build site is set for
const sited = new WeakSet<object>()
// the site of the call starting now, till a function takes it
let pending: Location | undefined

// a token for file:line:column (the plugin's module's, one per call it rewrote)
export function site(file: string, line: number, column: number, fn?: string): Site {
	const s = {} as Site
	minted.set(s, {
		at: { file, line, column, ...fn !== undefined && { function: fn }, external: true },
	})
	return s
}

// f, its call given s's site; s not minted here, or f not one of @ermine/system's functions: f
export function at<F>(s: Site, f: F): F {
	const m = minted.get(s)
	if (m === undefined || !sited.has(f as object)) return f
	if (m.f === f) return m.w as F
	const where = m.at
	const g = f as (...a: unknown[]) => unknown
	const w = (...a: unknown[]) => {
		pending = where
		try {
			return g(...a)
		} finally {
			pending = undefined
		}
	}
	m.f = f
	m.w = w
	return w as F
}

// @ermine/system's own: fs are its functions (mod.ts); the site set now, taken (go, as each starts)
export function mark(fs: Iterable<unknown>) {
	for (const f of fs) if (typeof f === "function") sited.add(f)
}
export function take(): Location | undefined {
	const p = pending
	pending = undefined
	return p
}
// f, marked as one of @ermine/system's functions (nodes.ts, reading.ts …, each as it is made)
export function marked<F>(f: F): F {
	mark([f])
	return f
}
