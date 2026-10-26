// design G, "what the models invented": small and large models, given no api (only "a live tree of
// reactive nodes by path; write the code you'd expect to work"), each question answered as most of
// them did. the words are globals (also on api, for those who destructure):
//   node(path, initial?)   a handle; made holding initial if missing, without one made never
//   x.get()                the value (tracked inside a derived value); not there: undefined
//   x.set(v) / x.set(fn)   replace; a function gets the previous value and returns the next
//   x.watch(fn)            fn(value) now and at each change; first once the node is there.
//                          gives back an unsubscribe function
//   x.call(...args)        a promise of the reply; no handler there yet: waits for one
//   derived(name, f)       a handle (.get, .watch) on a node holding f's result
//   on(path, fn)           a handler at path
//   show(text), onStop(fn)
// paths: "/x" from the root; a bare "x", "./x" (and "../x") from the process's cwd.
// built on: node → open (initial) or a plain path; get → read; set → edit (a recipe for a
// function); watch → a hidden effect (read x, act) in the program's own node; derived → memo;
// on → method; call → sendWaiting (lib/contexts.ts, as E's e.call and F's me.send); onStop →
// teardown.
// decisions (mine):
//   set on a node not there makes it (open with the value; a function is given undefined). models
//     write node("x").set(v) and expect it to land; the real edit throws nothing-there
//   set(fn) is the real recipe: fn's return is the new value. fn's prev is a draft underneath, so
//     mutating it (and returning nothing) also lands, though the sheet says return the next one
//   get() of a derived value with no value yet (the real read throws PENDING) gives undefined:
//     there is no pending in G's words. inside a derived value it is tracked all the same
//   watch on a node not there (or a derived value with no value yet) does not fire: its hidden
//     effect returns PENDING until something is there. it fires once with the value when it comes
//   unsubscribe: the real api can't end one effect before its owner goes. it is the adapter's
//     flag: act does nothing after, and the effect's next run reads nothing (so it never runs again)
//   a function is always a recipe: a function value can't be written through set (as B)
//   derived's parent folder is made when missing (the real memo throws nothing-there)
// G2 and G3 (invented("update"), invented("produce")): G with one change. set(v) replaces the whole
// value, never a recipe; the draft word, x.update(draft => …) (G2) or x.produce(draft => …) (G3),
// is the real edit(x, recipe): the recipe changes the draft and returns nothing, the patches are
// recorded from what it did. mine: a function given to set throws, naming the draft word (it
// would be stored quietly as the value); what the recipe returns is dropped, so d => d.push(v)
// pushes (the real recipe would make the value the returned length); the draft word on a node not
// there throws Missing (there is nothing to draft from)
import type { NodeData as Node } from "@ermine/ermine"
import type { DataAPI } from "../../lib/compat.ts"
import type { Adapter } from "../../lib/trial.ts"
import { NODE, whole } from "../../lib/handles.ts"
import {
	abs,
	missing,
	named,
	resolvePath,
	sendWaiting,
	TrialError,
	where,
} from "../../lib/contexts.ts"

let watches = 0

type Draft = "update" | "produce"

function handle(api: DataAPI, n: Node, draft?: Draft) {
	const path = abs(n.path!)
	const get = () => {
		try {
			return api.read(n as never)
		} catch (e) {
			if (e === api.PENDING) return undefined
			throw named(e)
		}
	}
	const set = (v: unknown) => {
		const there = !missing(api, n)
		if (draft !== undefined && typeof v === "function") {
			throw new TrialError(
				"NotAValue",
				`set takes the whole value, not a function: change part of it with ${draft}(draft => …)`,
			)
		}
		try {
			if (typeof v === "function") {
				if (there) api.edit(n as never, v as never)
				else api.open(path, (v as (prev: unknown) => unknown)(undefined))
			} else if (there) api.edit(n as never, whole(v) as never)
			else api.open(path, v)
		} catch (e) {
			throw named(e)
		}
	}
	const watch = (fn: (value: unknown) => unknown) => {
		let stopped = false
		api.effect(
			`.watch-${++watches}`,
			() => {
				if (stopped) return null
				const v = api.read(n as never)
				if (v === undefined && missing(api, n)) return api.PENDING
				return v as never
			},
			(v: unknown) => {
				if (!stopped) fn(v)
			},
		)
		return () => void (stopped = true)
	}
	const call = (...args: unknown[]) => sendWaiting(api, n, args, named)
	const h: Record<string | symbol, unknown> = { [NODE]: n, get, set, watch, call }
	if (draft !== undefined) {
		h[draft] = (recipe: (d: unknown) => unknown) => {
			if (typeof recipe !== "function") {
				throw new TrialError("BadRecipe", `${draft} takes a function changing a draft`)
			}
			try {
				// TRIAL_DRAFT_RETURN=1: immer's rule. the draft changed: its changes; untouched and a
				// value returned: that value replaces (n => n + 1 on a number). else the return is
				// dropped (10-25: small models write count.update(n => n + 1))
				const back = Deno.env.get("TRIAL_DRAFT_RETURN") === "1"
				api.edit(
					n as never,
					((d: unknown) => {
						const before = back ? JSON.stringify(d) : ""
						const r = recipe(d)
						if (!back || JSON.stringify(d) !== before) return undefined
						return r
					}) as never,
				)
			} catch (e) {
				throw named(e)
			}
		}
	}
	return h
}

// G, or with a draft word G2 (update) and G3 (produce)
export const invented = (draft?: Draft): Adapter => (api, extras) => {
	const of = (n: Node) => handle(api, n, draft)
	const { own, cwd } = where(api)
	const at = (p: string) => resolvePath(p, cwd, own)
	const words: Record<string, unknown> = {
		node(p: string, initial?: unknown) {
			const path = at(p)
			if (initial === undefined) return of({ path, part: "value" })
			try {
				return of(api.open(abs(path), initial))
			} catch (e) {
				throw named(e)
			}
		},
		derived(name: string, f: () => unknown) {
			const path = at(name)
			const up = path.slice(0, -1)
			if (up.length && missing(api, { path: up, part: "value" })) api.make(abs(up))
			return of(api.memo(abs(path), () => f() as never))
		},
		on(p: string, fn: (...args: unknown[]) => unknown) {
			return of(api.method(abs(at(p)), fn))
		},
		onStop(fn: () => unknown) {
			api.teardown(() => fn())
		},
		...extras,
	}
	// the words are globals: a program never has to take them out of api
	for (const [k, v] of Object.entries(words)) {
		Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
	}
	return words
}
export default invented()
