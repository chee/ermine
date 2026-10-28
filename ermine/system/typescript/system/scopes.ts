import type { Id } from "@ermine/core/places"
import { NODE } from "@ermine/core/places/header"
import type { Scope } from "@ermine/core/scheduler"
import { enterScheduler, leaveScheduler } from "../registry.ts"
import { ErmineError } from "../features.ts"
import type { Inner, Why } from "../context.ts"
import type { Base } from "./base.ts"
import { computerAt } from "./made.ts"
import { here } from "./setting.ts"
import { USER_ACTIVATED } from "./shapes.ts"

// the scopes that are marks (a call's: executeAction): they own nothing, so what is made while
// one is open belongs to the scope above it; their info still rides on the writes made in them
export const marks = new WeakSet<Scope>()
// the computers' scopes whose act is running now: an act makes nothing [marks-2026-10-27]
export const acting = new Set<Scope>()

// what a scope is looked for by: the NODE key in its info; an actor in it; a call's info (caller,
// handler and call); a mark; not a mark; a mark an action's call made
type By = "node" | "actor" | "call" | "mark" | "plain" | "action"
// the first scope from o up, short of end, that is by; none: undefined
function above(o: Scope | undefined, end: Scope | undefined, by: By) {
	for (; o !== undefined && o !== end; o = o.parent) {
		switch (by) {
			case "node":
				if (NODE in o.info) return o
				break
			case "actor":
				if ("actor" in o.info) return o
				break
			case "call":
				if (o.info.call !== undefined && o.info.handler !== undefined) return o
				break
			case "mark":
				if (marks.has(o)) return o
				break
			case "plain":
				if (!marks.has(o)) return o
				break
			case "action":
				if (marks.has(o) && "call" in o.info) return o
		}
	}
}

// the NODE key's id of o or the nearest scope above it with one; none: undefined
export const nodeAbove = (o: Scope | undefined) =>
	above(o, undefined, "node")?.info[NODE] as Id | undefined
// the scope of the call open from o up: its info names the caller, the handler and the call
export const callAbove = (o: Scope | undefined) => above(o, undefined, "call")

// refused in an act: what it would make would be the effect's, and go at its next act, where
// nobody can see it. fn names the function called
export function notInAct(own: Scope, fn: string) {
	if (!acting.has(own)) return
	throw new ErmineError(
		"in-act",
		fn === "addTeardown"
			? "addTeardown in an effect's act: return a cleanup function from the act instead"
			: `${fn} in an effect's act: an act makes nothing`,
	)
}
// refused in an action: its teardown would pile onto the scope above the call, one closure a call,
// till the process ends. a call's mark (an action's, or a writer made in one) is open between the
// scope open and own
export function notInAction(inner: Inner, own: Scope) {
	if (above(here(inner).s.getCurrentScope(), own, "action") !== undefined) {
		throw new ErmineError(
			"not-here",
			"addTeardown in an action: add it in setup, or keep what the call started and stop it from setup's teardown",
		)
	}
}
// the scope what is made now belongs to: the scope open, past any marks; none open: the context's
export const owner = (inner: Inner) => {
	const { s, scope } = here(inner)
	return above(s.getCurrentScope(), undefined, "plain") ?? scope
}
// the actor a write made now would carry: the first the open scope (none: the context's) or one
// above it gives
export const actorHere = (inner: Inner) => {
	const { s, scope } = here(inner)
	return above(s.getCurrentScope() ?? scope, undefined, "actor")?.info.actor
}

// fn(why) as scope goes, through onTeardown
export function teardown(inner: Inner, own: Scope, fn: (why: Why) => unknown) {
	const { base, s, scope } = here(inner)
	s.registerTeardown(own, () => {
		const why = base.whys.get(inner.node) ?? (scope.state !== "alive" ? "ended" : "replaced")
		base.torn(own, why, fn)
	})
}

// where a memo or effect's function runs: createWriter and start are not here (a compute runs
// again, so its writer would die at each rerun or start a process every run; an act makes nothing)
// message: as the scenarios pin it (the C side says the same)
export function notHere(base: Base, own: Scope, message: string) {
	const node = own.info[NODE] as Id | undefined
	if (node !== undefined && computerAt(base.made, node)) {
		throw new ErmineError("not-here", message)
	}
}

// the mark a scope open under own gives what is made now: the nearest call's info, without the
// user-activated flag (only a run that happens during an event has it)
export function markOf(inner: Inner, own: Scope): Scope["info"] | undefined {
	const o = above(here(inner).s.getCurrentScope(), own, "mark")
	if (o === undefined) return undefined
	const { [USER_ACTIVATED]: _, ...rest } = o.info
	return Object.keys(rest).length === 0 ? undefined : rest
}

// f run as parent under mark, with nothing else of the caller's: its writes carry the mark (and the
// user-activated flag, when asked)
export function runAs<T>(
	inner: Inner,
	parent: Scope,
	mark: Scope["info"] | undefined,
	f: () => T,
	during = false,
): T {
	const { s } = here(inner)
	const info = during ? { ...mark, [USER_ACTIVATED]: true } : mark
	const at = info === undefined ? parent : s.createScope(info, parent)
	if (at !== parent) marks.add(at)
	enterScheduler(s)
	try {
		return s.runWithScope(at, f)
	} finally {
		leaveScheduler()
		if (at !== parent) s.teardown(at)
	}
}
