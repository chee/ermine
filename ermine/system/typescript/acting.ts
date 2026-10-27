// what a call of @ermine/system's functions acts as: the context of the scope open (a process's, or
// the host's, process 0's: registry.ts), its implementation (system.ts) run as it
import { PENDING } from "@ermine/core/scheduler"
import type { Inner } from "./context.ts"
import { foundFor, hinting } from "./registry.ts"
import { attach as attachHint } from "./hints.ts"
import { take } from "./site.ts"
import { here, hintsOn } from "./system.ts"

// name's implementation run as the context found (a writer: entered, so its writes' site is the
// line calling in; few frames between: a site is found in the stack's first ten)
export function go<A extends unknown[], T>(
	name: string,
	writer: boolean,
	f: (inner: Inner, ...a: A) => T,
	...a: A
): T {
	// the call's build site, if one was set for it (site.ts): taken first, so nothing it runs gets it
	const site = take()
	let inner: Inner | undefined
	try {
		const found = foundFor(name)
		inner = found.inner
		const i = inner
		if (found.within !== undefined) {
			return found.within(() => writer ? here(i).base.enter(f, i, a, site) : f(i, ...a))
		}
		return writer ? here(i).base.enter(f, i, a, site) : f(i, ...a)
	} catch (e) {
		// an ermine error given its advice as it passes (hints.ts); PENDING as it is. no context
		// found (nothing-open): as the ermines open say
		if (e !== PENDING && (inner === undefined ? hinting() : hintsOn(inner))) {
			attachHint(e, { fn: name })
		}
		throw e
	}
}
