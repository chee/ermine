// sites: where in the code a scope, computer, effect or frame was made, so an inspector can show a
// memo made at program.ts:12 inside a process started at host.ts:40
//
//   const sited = createSites(scheduler, { ours })
//   sited.createComputer(f, set)   // same signatures as the scheduler's createRootScope,
//   sited.siteOf(computer)         // createScope, createComputer, createEffect, createFrame; the
//   sited.sitesOf(computer)        // site is the first stack frame outside sites.ts and ours
//   sited.note(frame, site)        // (libraries, the api); note: a site its maker knew
//
// held by frame (a scope's: its own frame), in a WeakMap, so a site never keeps a frame alive.
// sitesOf: its own site, then each frame's it is under that has one. made without the wrapper and
// never noted: no site of its own (siteOf: undefined)
// the stack is captured at create and parsed only when asked: create 5.6-12 µs, siteOf +~40 µs once
// core candidate: the scheduler keeping the site on the frame (no wrapper, no WeakMap)
import {
	type Computer,
	type Equal,
	type Frame,
	type Info,
	type PENDING,
	type Scheduler,
	type Scope,
} from "@ermine/core/scheduler"
import { type FileLocation, outside } from "@ermine/core/util/stacktrace"

export type { FileLocation }

export type SitesOptions = {
	// files whose frames are skipped: libraries, the api. a site is the first frame in none of them.
	// this file is always one. a Set is used as given, live (this file added to it): files added
	// later are skipped too, from the next site read
	ours?: Iterable<string>
	// the site known now without a stack (a build's, @ermine/unplugin, or a process's setup's): taken
	// over a capture; none (or it gives undefined): captured. made says what is being made: a
	// scope, a computer (a memo or an effect), or a frame alone
	given?: (made: Made) => FileLocation | undefined
}

export type Made = "scope" | "computer" | "frame"

export type Sited = {
	createRootScope: Scheduler["createRootScope"]
	createScope: Scheduler["createScope"]
	createComputer: Scheduler["createComputer"]
	createEffect: Scheduler["createEffect"]
	createFrame: Scheduler["createFrame"]
	// x's own site from now (a scope's: its frame's), over any it had
	note: (x: Scope | Frame, site: FileLocation) => void
	// where it was made through this wrapper, or noted; none: undefined
	siteOf: (x: Scope | Frame) => FileLocation | undefined
	// its own site if it has one, then each frame's it is under that has one, up to the top
	sitesOf: (x: Scope | Frame) => FileLocation[]
}

// a scope's own frame; a frame itself
const frameOf = (x: Scope | Frame): Frame => "frame" in x ? x.frame : x

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
	const listed = options.ours
	const ours = listed instanceof Set
		? (listed as Set<string>).add(import.meta.url)
		: new Set<string>([import.meta.url, ...(listed ?? [])])
	const held = new WeakMap<Frame, Held>()
	const given = options.given
	// the site given now, or the stack above entry
	const at = (entry: unknown, made: Made): Held => {
		const site = given?.(made)
		return site === undefined ? hold(entry) : { site }
	}

	function keep<S extends Scope | Frame>(x: S, h: Held): S {
		held.set(frameOf(x), h)
		return x
	}

	const createRootScope: Sited["createRootScope"] = (info) =>
		keep(scheduler.createRootScope(info), at(createRootScope, "scope"))
	const createScope: Sited["createScope"] = (info, parent) =>
		keep(scheduler.createScope(info, parent), at(createScope, "scope"))
	const createFrame: Sited["createFrame"] = (info, up) =>
		keep(scheduler.createFrame(info, up), at(createFrame, "frame"))
	const createComputer = <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		set: (value: T) => void,
		equal?: Equal<T>,
		key?: unknown,
		info?: Info,
	): Computer =>
		keep(scheduler.createComputer(f, set, equal, key, info), at(createComputer, "computer"))
	const createEffect = <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		effect: (value: T, previous: T | undefined) => void,
		equal?: Equal<T>,
		options?: Parameters<Scheduler["createEffect"]>[3],
		info?: Info,
	): Computer => {
		const site = at(createEffect, "computer")
		return keep(scheduler.createEffect(f, effect, equal, options, info), site)
	}

	function siteOf(x: Scope | Frame): FileLocation | undefined {
		const h = held.get(frameOf(x))
		if (h === undefined) return undefined
		if (h.site === undefined) {
			h.site = typeof h.stack === "string" ? outside(h.stack, ours) ?? null : null
			// read once: the frames are let go
			delete h.stack
		}
		return h.site ?? undefined
	}

	function sitesOf(x: Scope | Frame): FileLocation[] {
		const out: FileLocation[] = []
		for (let f: Frame | undefined = frameOf(x); f !== undefined; f = f.parent) {
			const site = siteOf(f)
			if (site) out.push(site)
		}
		return out
	}

	return {
		createRootScope,
		createScope,
		createComputer,
		createEffect,
		createFrame,
		note: (x, site) => void held.set(frameOf(x), { site }),
		siteOf,
		sitesOf,
	}
}
