import type { Id, Path } from "@ermine/core/places"
import { get } from "@ermine/core/places/lib"
import { NODE } from "@ermine/core/places/header"
import { PENDING, type Scope } from "@ermine/core/scheduler"
import { isPromise } from "@ermine/core/scheduler/helpers"
import type { Going } from "../calls.ts"
import { enterScheduler, leaveScheduler } from "../registry.ts"
import { ErmineError } from "../features.ts"
import { type Inner, type Node, type NodeData, type Target, whole } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { aimed, handle, idOf, nodeOf, seen } from "./addressing.ts"
import { keepAction } from "./made.ts"
import { actorHere, callAbove, marks, notInAct, owner } from "./scopes.ts"
import { here } from "./setting.ts"
import { type Caller, SendError, type System } from "./shapes.ts"
import { build } from "./tree.ts"

// public (mod.ts exports them): each runs its implementation below, named with As, as the
// context it finds (acting.ts' go)
export const createAction: System["createAction"] = /* @__PURE__ */ marked((path, fn) =>
	go("createAction", true, createActionAs, path, fn)
)
export const executeAction: System["executeAction"] = /* @__PURE__ */ marked((path, ...args) =>
	go("executeAction", true, executeActionAs, path, ...args)
)
export const getCaller: System["getCaller"] = /* @__PURE__ */ marked(() =>
	go("getCaller", false, getCallerAs)
)

export function createActionAs(
	inner: Inner,
	p: string | Path,
	// deno-lint-ignore no-explicit-any
	fn: (...args: any[]) => unknown,
): Node {
	const { parts, methods, places, inside, resolve, ask } = here(inner)
	const own = owner(inner)
	notInAct(own, "createAction")
	if (Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]") {
		throw new ErmineError(
			"not-a-function",
			"createAction takes a function or a function*, not an async function*: use a function* that yields promises",
		)
	}
	const path = resolve(p)
	const made = inside(() => {
		const id = get(places, path)
		if (id === undefined) return build(inner, path, fn)
		ask("edit", aimed(id, path, "value"))
		inner.put({ part: "value", id, path, patches: whole(fn) })
		return id
	})
	// kept while own is: own going takes it out, unless a later placement took over
	methods.set(made, { fn, scope: own })
	keepAction(inner, own, made)
	const n: NodeData = { path, part: "value" }
	parts.onCreateFunction?.({ kind: "method", node: n, id: made, process: inner.node })
	return handle(inner, n)
}

// a generator action (a function*; an async function* is refused by createAction: a catch round
// a rejected yield in one runs with nothing open) is stepped by the system [Solid 2.0's action]:
// each step runs with the call's mark, so a write after a `yield` carries it and is allowed; `yield
// promise` waits for the promise (a throw comes back in at the yield). the call gives a promise of
// the generator's return
type Steps = Iterator<unknown, unknown, unknown>
const isGenerator = (fn: unknown) =>
	Object.prototype.toString.call(fn) === "[object GeneratorFunction]"
// the parent going while it waits at a yield: the generator is returned (its finally blocks run,
// with nothing open: a write there fails as it does after any end), and the promise rejects: gone.
// each step is the call's (open as the record's) till the generator finishes
function stepped(inner: Inner, call: Scope, g: Going, make: () => Steps): Promise<unknown> {
	const { s, calls } = here(inner)
	return new Promise((resolve, reject) => {
		let it: Steps | undefined
		let finished = false
		const done = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
			if (finished) return
			finished = true
			f(...a)
		}
		const ok = done(resolve)
		const fail = done(reject)
		s.registerTeardown(call, () => {
			if (finished) return
			finished = true
			const gone = new ErmineError("gone", "gone: what this action ran in has ended")
			// after the teardown, with nothing open: a write in a finally block fails as after any end
			queueMicrotask(() => {
				try {
					it?.return?.(undefined)
				} catch { /* a finally block's own throw: the call is gone */ }
				reject(gone)
			})
		})
		const step = (v?: unknown, thrown?: boolean) => {
			if (finished) return
			let r: IteratorResult<unknown>
			enterScheduler(s)
			try {
				// the first step makes the iterator (in the call's scope too)
				r = calls.during(g, () =>
					s.runWithScope(call, () => {
						it ??= make()
						return thrown ? it.throw!(v) : it.next(v)
					}))
			} catch (e) {
				return fail(e)
			} finally {
				leaveScheduler()
			}
			run(r)
		}
		const run = (r: IteratorResult<unknown>) => {
			if (finished) return
			if (r.done) return ok(r.value)
			if (isPromise(r.value)) {
				return void r.value.then((v) => step(v), (e) => step(e, true))
			}
			step(r.value)
		}
		step()
	})
}

export function executeActionAs(inner: Inner, p: Target, ...args: unknown[]): unknown {
	const { base, calls, methods, s, table, queuePulse, context, scope, places, ask } = here(inner)
	const n = nodeOf(inner, p)
	const id = idOf(inner, n)
	const at = n.path !== undefined ? { path: n.path } : { id: n.id }
	// in a run, the computer waits; else whoever this context is
	const run = s.getRun()
	const caller = (run?.computer.info[NODE] as Id | undefined) ?? inner.node
	// tracked in a run, so the handler coming reruns it
	const fn = id === undefined ? undefined : places.readValue("value", id)
	if (fn === undefined) {
		// kept while the caller is: a computer's with it, else the context's. the path: from the root
		calls.wait(caller, at, run?.computer ?? scope)
		throw PENDING
	}
	if (typeof fn !== "function") {
		throw new SendError("not-a-method", n.path?.join("/") ?? "a node it was handed")
	}
	calls.answered(caller, at)
	const k = calls.next()
	// the placement's scope while the node still holds what was placed; else (its owner gone, or
	// a function written there by edit) the sender's, as any function value
	const placed = methods.get(id!)
	// the call's mark: the caller on the call's changes, its own field: its node, and the actor its
	// writes carry (the handler's writes are the handler's: their actor its own). it owns nothing
	// [marks-2026-10-27]: what the action makes belongs to the scope above it
	const call = base.sited.createScope(
		{ caller: { node: inner.node, actor: actorHere(inner) }, handler: id, call: k },
		placed !== undefined && placed.fn === fn ? placed.scope : scope,
	)
	marks.add(call)
	try {
		s.runWithScope(call, () => ask("execute", aimed(id!, n.path, "value")))
	} catch (e) {
		s.teardown(call)
		throw e
	}
	const g = calls.begin(k, call, {
		caller: inner.node,
		context,
		handler: { id: id!, change: table.get("value", id!)?.change },
		args,
	})
	// the mark lasts as the record does: a promise's till it settles (the record ended first), else
	// till the handler returns or throws. a pulse is asked for as it returns (go), and here as it
	// throws and as a promise settles
	let out: unknown
	try {
		out = isGenerator(fn)
			? stepped(inner, call, g, () => s.runWithScope(call, () => fn(...args) as Steps))
			: s.runWithScope(call, () => fn(...args))
		calls.end(g, { returned: out })
	} catch (e) {
		calls.end(g, e === PENDING ? { pending: true } : { error: e })
		s.teardown(call)
		queuePulse()
		throw e
	}
	if (isPromise(out)) {
		const ended = () => {
			s.teardown(call)
			queuePulse()
		}
		out.then(ended, ended)
	} else s.teardown(call)
	return out
}

// the call open now: its scope's info names its caller (send's call scope)
export function getCallerAs(inner: Inner): Caller | undefined {
	const { s, scope } = here(inner)
	const o = callAbove(s.getCurrentScope() ?? scope)
	if (o === undefined) return undefined
	const c = o.info.caller as { node?: Id; actor?: unknown } | undefined
	const p = c?.node === undefined ? undefined : seen(inner, c.node)
	return p === undefined ? { actor: c?.actor } : { actor: c?.actor, process: p }
}
