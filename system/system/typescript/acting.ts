// What a call of @ermine/system's functions acts as: the context of the open scope (a process's or
// the host's), with the implementation run as it.
import { PENDING } from "@ermine/reactivity"
import type { Inner } from "./context.ts"
import { found, unfound } from "./registry.ts"
import { take } from "./site.ts"
import { here } from "./system/setting.ts"

// Runs the implementation as the context found, then asks for a pulse as it returns. `cut` is the
// public function itself, so a capture starts at its caller.
export function go<A extends unknown[], T>(
	cut: unknown,
	name: string,
	writer: boolean,
	f: (inner: Inner, ...a: A) => T,
	...a: A
): T {
	const site = take()
	let inner: Inner | undefined
	try {
		const i = inner = found(name)
		if (!writer) return f(i, ...a)
		const h = here(i)
		const out = h.base.enter(cut, site, () => f(i, ...a))
		h.queuePulse()
		return out
	} catch (e) {
		// Errors go through the ermine's onError hooks; PENDING passes as it is.
		if (e === PENDING) throw e
		throw inner === undefined ? unfound(e, name) : here(inner).base.errored(e, name)
	}
}
