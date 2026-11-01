import type { Id, Path } from "@ermine/places"
import { isCallFrame } from "@ermine/places/header"
import type { Frame, Scope } from "@ermine/reactivity"
import { enterScheduler, leaveScheduler } from "../registry.ts"
import { ErmineError } from "../features.ts"
import type { Inner, Why } from "../context.ts"
import type { Base } from "./base.ts"
import { computerAt } from "./made.ts"
import { here } from "./setting.ts"
import { USER_ACTIVATED } from "./shapes.ts"

export const acting = new Set<Scope>()

type By = "node" | "actor" | "call"
function above(o: Frame | undefined, end: Frame | undefined, by: By) {
	for (; o !== undefined && o !== end; o = o.parent) {
		switch (by) {
			case "node":
				if ("node" in o.info) return o
				break
			case "actor":
				if ("actor" in o.info) return o
				break
			case "call":
				if (o.info.call !== undefined && o.info.handler !== undefined) return o
		}
	}
}

export const nodeAbove = (o: Scope | undefined) =>
	above(o?.frame, undefined, "node")?.info.node as Id | undefined
export const callAbove = (o: Frame | undefined) => above(o, undefined, "call")

// Refused in an act, because what it made would go at the next act where nobody can see it.
export function notInAct(own: Scope, fn: string) {
	if (!acting.has(own)) return
	throw new ErmineError(
		"in-act",
		fn === "addTeardown"
			? "addTeardown in an effect's act: return a cleanup function from the act instead"
			: `${fn} in an effect's act: an act makes nothing`,
	)
}
// A memo, effect or pipe is made inside its maker's node, never beside or above it, where it
// would outlive its maker.
export function insideOnly(inner: Inner, path: Path, fn: string) {
	const at = inner.context.at
	if (path.length > at.length && at.every((name, i) => path[i] === name)) return
	throw new ErmineError(
		"outside",
		`${fn}("/${path.join("/")}"): made outside its maker, it would outlive it`,
	)
}
// Refused in an action, because its teardown would pile onto the scope the call runs in.
export function notInAction(inner: Inner, own: Scope) {
	if (above(here(inner).s.getCurrentFrame(), own.frame, "call") !== undefined) {
		throw new ErmineError(
			"not-here",
			"addTeardown in an action: add it in setup, or keep what the call started and stop it from setup's teardown",
		)
	}
}
export const owner = (inner: Inner) => {
	const { s, scope } = here(inner)
	return s.getCurrentScope() ?? scope
}
export const actorHere = (inner: Inner) => {
	const { s, scope } = here(inner)
	return above(s.getCurrentFrame() ?? scope.frame, undefined, "actor")?.info.actor
}

export function teardown(inner: Inner, own: Scope, fn: (why: Why) => unknown) {
	const { base, s, scope } = here(inner)
	s.registerTeardown(own, () => {
		const why = base.whys.get(inner.node) ?? (scope.state !== "alive" ? "ended" : "replaced")
		base.torn(own, why, fn)
	})
}

// createWriter and start are refused here, because a compute runs again and an act makes nothing.
export function notHere(base: Base, own: Scope, message: string) {
	const node = own.info.node as Id | undefined
	if (node !== undefined && computerAt(base.made, node)) {
		throw new ErmineError("not-here", message)
	}
}

// The mark for what is made now: the nearest frame made alone between the open frame and own's,
// without the user-activated flag.
export function markOf(inner: Inner, own: Scope): Scope["info"] | undefined {
	const open = here(inner).s.getCurrentFrame()
	const at = isCallFrame(open) ? open!.parent : open
	const o = at === undefined || at === own.frame ? undefined : at
	if (o === undefined) return undefined
	const { [USER_ACTIVATED]: _, ...rest } = o.info
	return Object.keys(rest).length === 0 ? undefined : rest
}

// Runs f as parent under mark, with nothing else of the caller's.
export function runAs<T>(
	inner: Inner,
	parent: Scope,
	mark: Scope["info"] | undefined,
	f: () => T,
	during = false,
	up: Frame = parent.frame,
): T {
	const { s } = here(inner)
	const info = during ? { ...mark, [USER_ACTIVATED]: true } : mark
	const frame = info === undefined ? up : s.createFrame(info, up)
	enterScheduler(s)
	try {
		return s.runWith(parent, frame, f)
	} finally {
		leaveScheduler()
	}
}
