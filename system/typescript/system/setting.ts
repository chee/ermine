import { ErmineError } from "../features.ts"
import type { Inner, ProcessContext } from "../context.ts"
import type { Base } from "./base.ts"

// one context's setting, what every function works from: its ermine's base, its own (places,
// guard, scope, asks), and its state (a peep going). no api object per
// process [chee 10-25: ">Drop the objects. ye"]: each function is given the context it found
// (acting.ts) and works from its setting
//
// where state is kept: an ermine's tables by node or path in its base (ermine.ts builds them); a
// fact about a scope or a context in a WeakMap beside the code that asks it (a mark, an act, a
// scope's bin, a context's base and setting); a context's own counters here
const bases = new WeakMap<Inner, Base>()
const inners = new WeakMap<ProcessContext, Inner>()
const settings = new WeakMap<Inner, Setting>()
type Setting = ReturnType<typeof setting>
// a context of base's: each one base makes, before any function is given it
export function attach(base: Base, inner: Inner) {
	bases.set(inner, base)
	inners.set(inner.context, inner)
}
// a process context's inner side (the host's and features' code: the harness); base given, only one
// of that ermine's
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
