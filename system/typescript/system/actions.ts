import type { Id, Path } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { type Frame, PENDING, type Scope } from "@ermine/reactivity"
import { isPromise } from "@ermine/reactivity/helpers"
import type { Going } from "../calls.ts"
import { enterScheduler, leaveScheduler } from "../registry.ts"
import { ErmineError } from "../features.ts"
import { type Inner, type Node, type NodeData, type Target, whole } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { aimed, handle, idOf, nodeOf, seen } from "./addressing.ts"
import { keepAction } from "./made.ts"
import { actorHere, callAbove, notInAct, owner } from "./scopes.ts"
import { here } from "./setting.ts"
import { type Caller, SendError, type System } from "./shapes.ts"
import { build } from "./tree.ts"

export const createAction: System["createAction"] = /* @__PURE__ */ marked(
	function createAction(path, fn) {
		return go(createAction, "createAction", true, createActionAs, path, fn)
	},
)
export const executeAction: System["executeAction"] = /* @__PURE__ */ marked(
	function executeAction(path, ...args) {
		return go(executeAction, "executeAction", true, executeActionAs, path, ...args)
	},
)
export const getCaller: System["getCaller"] = /* @__PURE__ */ marked(function getCaller() {
	return go(getCaller, "getCaller", false, getCallerAs)
})

export function createActionAs(
	inner: Inner,
	p: string | Path,
	// deno-lint-ignore no-explicit-any
	fn: (...args: any[]) => unknown,
): Node {
	const { base, parts, methods, places, inside, resolve, ask } = here(inner)
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
	methods.set(made, {
		fn,
		scope: own,
		frame: parts.scheduler.createFrame({ handler: made }, own.frame),
	})
	keepAction(inner, own, made)
	const n: NodeData = { path, part: "value" }
	parts.onCreateFunction?.({ kind: "method", node: n, id: made, process: inner.node })
	return handle(inner, n)
}

// A generator action is stepped by the system, each step under the call's frame, so a write after
// a `yield` is allowed. `yield promise` waits for the promise. The call gives a promise of the
// return. An async function* is refused by createAction.
type Steps = Iterator<unknown, unknown, unknown>
const isGenerator = (fn: unknown) =>
	Object.prototype.toString.call(fn) === "[object GeneratorFunction]"
// If the parent goes while it waits at a yield, the generator is returned (its finally blocks run
// with nothing open) and the promise rejects. Its scope is its own under `under`, so its teardown
// does not pile up there.
function stepped(
	inner: Inner,
	under: Scope,
	call: Frame,
	g: Going,
	make: () => Steps,
): Promise<unknown> {
	const { s, calls } = here(inner)
	const life = s.createScope({ stepping: g.n }, under)
	return new Promise((resolve, reject) => {
		let it: Steps | undefined
		let finished = false
		const done = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
			if (finished) return
			finished = true
			s.teardown(life)
			f(...a)
		}
		const ok = done(resolve)
		const fail = done(reject)
		s.registerTeardown(life, () => {
			if (finished) return
			finished = true
			const gone = new ErmineError("gone", "gone: what this action ran in has ended")
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
				r = calls.during(g, () =>
					s.runWith(under, call, () => {
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
	const run = s.getRun()
	const caller = (run?.computer.info.node as Id | undefined) ?? inner.node
	const fn = id === undefined ? undefined : places.readValue("value", id)
	if (fn === undefined) {
		calls.wait(caller, at, run?.computer ?? scope)
		throw PENDING
	}
	if (typeof fn !== "function") {
		throw new SendError("not-a-method", n.path?.join("/"))
	}
	calls.answered(caller, at)
	const k = calls.next()
	// The placement's scope while the node still holds what was placed, else the sender's.
	const placed = methods.get(id!)
	// The call's frame holds the caller, its node and the actor its writes carry. It owns nothing:
	// what the action makes belongs to `under`. Where it was called from is found by walking up its
	// frames to the locations.
	const own = placed !== undefined && placed.fn === fn ? placed : undefined
	const under = own?.scope ?? scope
	const locations = base.locations()
	const call = s.createFrame(
		{
			caller: { node: inner.node, actor: actorHere(inner) },
			handler: id,
			call: k,
			...locations !== undefined && { locations },
		},
		own?.frame ?? under.frame,
	)
	s.runWith(under, call, () => ask("execute", aimed(id!, n.path, "value")))
	const g = calls.begin(k, call, {
		caller: inner.node,
		context,
		handler: { id: id!, change: table.get("value", id!)?.change },
		args,
	})
	let out: unknown
	try {
		out = isGenerator(fn)
			? stepped(inner, under, call, g, () => s.runWith(under, call, () => fn(...args) as Steps))
			: s.runWith(under, call, () => fn(...args))
		calls.end(g, { returned: out })
	} catch (e) {
		calls.end(g, e === PENDING ? { pending: true } : { error: e })
		queuePulse()
		throw e
	}
	if (isPromise(out)) out.then(queuePulse, queuePulse)
	return out
}

export function getCallerAs(inner: Inner): Caller | undefined {
	const { s, scope } = here(inner)
	const o = callAbove(s.getCurrentFrame() ?? scope.frame)
	if (o === undefined) return undefined
	const c = o.info.caller as { node?: Id; actor?: unknown } | undefined
	const p = c?.node === undefined ? undefined : seen(inner, c.node)
	return p === undefined ? { actor: c?.actor } : { actor: c?.actor, process: p }
}
