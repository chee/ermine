// sites: where in the code a scope, computer or effect was made, recorded once when it was, so an
// inspector can show a memo made at program.ts:12 inside the process started at host.ts:40. each
// scope's own site is where its create call was; the chain is its own then each parent's.
//
//   const sited = createSites(scheduler, { ours })
//   sited.createComputer(f, set)   // same signatures as the scheduler's createRootScope,
//   sited.siteOf(computer)         // createScope, createComputer, createEffect; the site is the
//   sited.sitesOf(computer)        // first frame outside sites.ts and outside ours (libraries,
//                                  // the api): the code that asked
//
// a WeakMap keyed by scope: a scope is never kept alive by its site. one made without the wrapper
// has no site of its own (siteOf: undefined) but its parents' show in sitesOf.
//
// cost, at the create (deno bench ermine/sites, Apple A18 Pro, Deno 2.9, 2026-10-15; the bare
// create is 0.3-1.4 µs of it):
//   scope, held unread (used)         5.6-6.7 µs
//   scope, parsed at once (capture)   55-67 µs
//   computer, held unread (used)      11-12 µs
//   siteOf asked on a held scope      +~40 µs, once, and only for the scopes someone asks about
// the stack is captured at the create (Error.captureStackTrace into a holder) and parsed when
// siteOf/sitesOf is asked: V8 keeps the frames structured and formats the string only when .stack
// is read, so the create pays for the capture alone, ten times less than parsing at once. what
// it keeps until the scope goes (the WeakMap's value): the holder's captured frames, until the
// site is asked for, then the parsed site alone
//
// core candidate: the scheduler could keep the site on the scope itself, so a computer made
// without this wrapper has one too, and no WeakMap is needed
import {
	type Computer,
	type Equal,
	type Pair,
	type PENDING,
	type Scheduler,
	type Scope,
} from "@ermine/scheduler"
import { type FileLocation, outside } from "@ermine/util/stacktrace"

export type { FileLocation }

export type SitesOptions = {
	// files whose frames are skipped: libraries, the api. a site is the first frame in none of them.
	// this file is always one
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
	if (typeof limit === "number" && limit < 10) E.stackTraceLimit = 10
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
	const ours = new Set<string>([import.meta.url, ...(options.ours ?? [])])
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
	): Computer => note(scheduler.createComputer(f, set, equal, key), hold(createComputer))
	const createEffect = <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		effect: (value: T, previous: T | undefined) => void,
		equal?: Equal<T>,
		options?: Parameters<Scheduler["createEffect"]>[3],
	): Computer => {
		const site = hold(createEffect)
		return note(scheduler.createEffect(f, effect, equal, options), site)
	}

	function siteOf(scope: Scope): FileLocation | undefined {
		const h = held.get(scope)
		if (h === undefined) return undefined
		if (h.site === undefined) {
			h.site = typeof h.stack === "string" ? outside(h.stack, ours) ?? null : null
			// read once: the frames are let go
			delete h.stack
		}
		return h.site ?? undefined
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
	}
}
