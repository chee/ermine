import { ErmineError } from "../features.ts"
import type { Inner, ProcessContext } from "../context.ts"
import type { Base } from "./base.ts"

// One context's setting, which every function works from: its ermine's base, its own places, guard,
// scope and asks, and its state.
const bases = new WeakMap<Inner, Base>()
const inners = new WeakMap<ProcessContext, Inner>()
const settings = new WeakMap<Inner, Setting>()
type Setting = ReturnType<typeof setting>
export function attach(base: Base, inner: Inner) {
	bases.set(inner, base)
	inners.set(inner.context, inner)
}
export function innerOf(context: ProcessContext, base?: Base): Inner | undefined {
	const inner = inners.get(context)
	return inner === undefined || (base !== undefined && bases.get(inner) !== base)
		? undefined
		: inner
}
function setting(inner: Inner) {
	const base = bases.get(inner)
	if (base === undefined) throw new ErmineError("not-yet", "a process context no ermine made")
	const { parts, calls, runs, methods, newId } = base
	const { scheduler: s, table, queuePulse } = parts
	const { context, places, guard, guarded, inside } = inner
	return {
		base,
		parts,
		calls,
		runs,
		methods,
		newId,
		s,
		table,
		queuePulse,
		context,
		places,
		guard,
		guarded,
		inside,
		scope: context.scope,
		resolve: context.resolve,
		ask: context.ask,
		state: {
			peeping: 0,
		},
	}
}
export function here(c: Inner): Setting {
	let h = settings.get(c)
	if (h === undefined) settings.set(c, h = setting(c))
	return h
}
