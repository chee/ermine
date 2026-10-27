// what a call of @ermine/system's functions acts as: the context of the scope open (a process's, or
// the host's, process 0's: registry.ts), its implementation (system.ts) run as it
import { PENDING } from "@ermine/core/scheduler"
import type { Inner } from "./context.ts"
import { found, unfound } from "./registry.ts"
import { take } from "./site.ts"
import { here } from "./system.ts"

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
		const i = inner = found(name)
		return writer ? here(i).base.enter(f, i, a, site) : f(i, ...a)
	} catch (e) {
		// through the ermine's onError hooks (hints.ts adds advice); PENDING as it is. no context
		// found (nothing-open): through the first ermine open with any
		if (e === PENDING) throw e
		throw inner === undefined ? unfound(e, name) : here(inner).base.errored(e, name)
	}
}
