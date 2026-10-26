// sites: where in the code a scope, computer or effect was made, so an inspector can show a memo
// made at program.ts:12 inside a process started at host.ts:40
//
//   const sited = createSites(scheduler, { ours })
//   sited.createComputer(f, set)   // same signatures as the scheduler's createRootScope,
//   sited.siteOf(computer)         // createScope, createComputer, createEffect; the site is the
//   sited.sitesOf(computer)        // first frame outside sites.ts and ours (libraries, the api)
//
// sitesOf: its own site, then each parent's. kept in a WeakMap by scope, so a site never keeps a
// scope alive; made without the wrapper: no site of its own (siteOf: undefined)
// the stack is captured at create and parsed only when asked: create 5.6-12 µs, siteOf +~40 µs once
// core candidate: the scheduler keeping the site on the scope (no wrapper, no WeakMap)
import {
	type Computer,
	type Equal,
	type Info,
	type PENDING,
	type Scheduler,
	type Scope,
} from "@ermine/core/scheduler"
import { type FileLocation, frames, outside } from "@ermine/core/util/stacktrace"

export type { FileLocation }

export type SitesOptions = {
	// files whose frames are skipped: libraries, the api. a site is the first frame in none of them.
	// this file is always one. a Set is kept as given, live (this file added to it): files added
	// later are skipped too, from the next site read
	ours?: Iterable<string>
}

export type Sited = {
	createRootScope: Scheduler["createRootScope"]
	createScope: Scheduler["createScope"]
	createComputer: Scheduler["createComputer"]
	createEffect: Scheduler["createEffect"]
	// where the scope was made through this wrapper; none: made without it
	siteOf: (scope: Scope) => FileLocation | undefined
	// its own site if it has one, then each parent's that has one, up to the root
	sitesOf: (scope: Scope) => FileLocation[]
	// the whole stack it was made with, every frame (kept here, never in the graph) [chee 10-26:
	// "we should just keep the whole stack"]; made without the wrapper: undefined
	stackOf: (scope: Scope) => FileLocation[] | undefined
}

type Held = { stack?: string; site?: FileLocation | null }

type V8Error = {
	captureStackTrace?: (holder: object, entry?: unknown) => void
	stackTraceLimit?: number
}

// the stack as of now, above entry, left unread
export function hold(entry: unknown): Held {
	const E = Error as unknown as V8Error
	const holder: Held = {}
	const limit = E.stackTraceLimit
	if (typeof limit === "number" && limit < 64) E.stackTraceLimit = 64 // the whole stack (stackOf)
	try {
		if (typeof E.captureStackTrace === "function") {
			E.captureStackTrace(holder, entry)
		} else holder.stack = new Error().stack
	} finally {
		if (typeof limit === "number") E.stackTraceLimit = limit
	}
	return holder
}

export function createSites(
	scheduler: Scheduler,
	options: SitesOptions = {},
): Sited {
	const given = options.ours
	const ours = given instanceof Set
		? (given as Set<string>).add(import.meta.url)
		: new Set<string>([import.meta.url, ...(given ?? [])])
	const held = new WeakMap<Scope, Held>()

	function note<S extends Scope>(scope: S, h: Held): S {
		held.set(scope, h)
		return scope
	}

	const createRootScope: Sited["createRootScope"] = (info) =>
		note(scheduler.createRootScope(info), hold(createRootScope))
	const createScope: Sited["createScope"] = (info, parent) =>
		note(scheduler.createScope(info, parent), hold(createScope))
	const createComputer = <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		set: (value: T) => void,
		equal?: Equal<T>,
		key?: unknown,
		info?: Info,
	): Computer => note(scheduler.createComputer(f, set, equal, key, info), hold(createComputer))
	const createEffect = <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		effect: (value: T, previous: T | undefined) => void,
		equal?: Equal<T>,
		options?: Parameters<Scheduler["createEffect"]>[3],
		info?: Info,
	): Computer => {
		const site = hold(createEffect)
		return note(scheduler.createEffect(f, effect, equal, options, info), site)
	}

	function siteOf(scope: Scope): FileLocation | undefined {
		const h = held.get(scope)
		if (h === undefined) return undefined
		if (h.site === undefined) {
			h.site = typeof h.stack === "string" ? outside(h.stack, ours) ?? null : null
		}
		return h.site ?? undefined
	}

	function stackOf(scope: Scope): FileLocation[] | undefined {
		const h = held.get(scope)
		return typeof h?.stack === "string" ? frames(h.stack) : undefined
	}

	function sitesOf(scope: Scope): FileLocation[] {
		const out: FileLocation[] = []
		for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
			const site = siteOf(s)
			if (site) out.push(site)
		}
		return out
	}

	return {
		createRootScope,
		createScope,
		createComputer,
		createEffect,
		siteOf,
		sitesOf,
		stackOf,
	}
}
