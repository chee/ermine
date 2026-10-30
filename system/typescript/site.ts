// Build locations: a call's location written in at build time by @ermine/bundling, so a write
// made through it captures no stack. A site is an opaque token minted here by the plugin's module;
// holders cannot change where it points or make one. The runtime accepts a build location only
// from a token minted here, only for one of @ermine/system's functions, and only for the first
// function run after the call starts. The plugin refuses to build a program that names this entry.
import type { Location } from "@ermine/changeable/stacktrace"

export type Site = { readonly __site: unique symbol }

const minted = new WeakMap<Site, { at: Location; f?: unknown; w?: unknown }>()
const sited = new WeakSet<object>()
let pending: Location | undefined

export function site(file: string, line: number, column: number, fn?: string): Site {
	const s = {} as Site
	minted.set(s, {
		at: { file, line, column, ...fn !== undefined && { function: fn }, external: true },
	})
	return s
}

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

export function mark(fs: Iterable<unknown>) {
	for (const f of fs) if (typeof f === "function") sited.add(f)
}
export function take(): Location | undefined {
	const p = pending
	pending = undefined
	return p
}
export function marked<F>(f: F): F {
	mark([f])
	return f
}
