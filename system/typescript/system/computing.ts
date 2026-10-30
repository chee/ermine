import type { Path } from "@ermine/places"
import type { Equal, PENDING } from "@ermine/reactivity"
import { ErmineError } from "../features.ts"
import { type Inner, type Node, type NodeData, whole } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { handle } from "./addressing.ts"
import { again, type Code, computerNode, ran, same } from "./made.ts"
import { acting, insideOnly, notInAct, owner, teardown } from "./scopes.ts"
import { here } from "./setting.ts"
import type { System } from "./shapes.ts"

export const createMemo: System["createMemo"] = /* @__PURE__ */ marked(
	function createMemo(name, f, options) {
		return go(createMemo, "createMemo", true, createMemoAs, name, f as never, options as never)
	},
)
export const createEffect: System["createEffect"] = /* @__PURE__ */ marked(function createEffect(
	name,
	f,
	act,
	options,
) {
	return go(
		createEffect,
		"createEffect",
		true,
		createEffectAs,
		name,
		f as never,
		act as never,
		options as never,
	)
})
export const pulse: System["pulse"] = /* @__PURE__ */ marked(function pulse() {
	return go(pulse, "pulse", false, pulseAs)
})

type Compute<T> = (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING
type Act<T> = (value: T, before: T | undefined) => void | (() => unknown)

export function createMemoAs<T>(
	inner: Inner,
	name: string | Path,
	f: Compute<T>,
	options: { equal?: Equal<T> } = {},
): Node {
	return makeComputer(inner, "memo", name, f, undefined, options)
}

// An effect at its own node: f is tracked, and act runs after the round. An early effect runs and
// acts at once, and later acts before other effects'.
export function createEffectAs<T>(
	inner: Inner,
	name: string | Path,
	f: Compute<T>,
	act: Act<T>,
	options: { equal?: Equal<T>; early?: boolean } = {},
): Node {
	const { early, ...o } = options
	return makeComputer(inner, early === true ? "early" : "effect", name, f, act, o)
}

// An early effect runs and acts inside createEffect, so its first run gives its node the status and
// run record from inside.
function makeComputer<T>(
	inner: Inner,
	kind: "memo" | "effect" | "early",
	name: string | Path,
	f: Compute<T>,
	act: Act<T> | undefined,
	options: { equal?: Equal<T> },
): Node {
	const { base, parts, runs, s, table, resolve } = here(inner)
	const own = owner(inner)
	notInAct(own, act === undefined ? "createMemo" : "createEffect")
	const path = resolve(name)
	insideOnly(inner, path, act === undefined ? "createMemo" : "createEffect")
	const n: NodeData = { path, part: "value" }
	const code: Code = { f, ...act !== undefined && { act }, equal: options.equal }
	if (again(inner, own, path, code)) return handle(inner, n)
	const m = computerNode(inner, own, path, code, kind)
	const id = m.id
	const set = (v: T) => {
		if (v !== undefined || table.get("value", id) !== undefined) {
			inner.put({ part: "value", id, patches: whole(v) })
		}
	}
	const then = (v: T, before: T | undefined) => {
		set(v)
		// An act may return a cleanup, run before the next act and when the effect goes. Anything else
		// returned is refused, as Solid does.
		const sc = s.getCurrentScope()
		if (sc !== undefined) acting.add(sc)
		let cleanup: unknown
		try {
			cleanup = m.code.act!(v, before)
		} finally {
			if (sc !== undefined) acting.delete(sc)
		}
		if (cleanup === undefined || sc === undefined) return
		if (typeof cleanup !== "function") {
			throw new ErmineError(
				"bad-cleanup",
				`an effect's act returned ${typeof cleanup}: return a function (its cleanup), or nothing`,
			)
		}
		teardown(inner, sc, () => (cleanup as () => unknown)())
	}
	const locations = base.locations()
	const info = { node: id, ...locations !== undefined && { locations } }
	let given = false
	const run = (previous: T | undefined) => {
		if (!given) {
			given = true
			const c = s.getRun()!.computer
			base.statuses.give(c, id)
			runs.give(c, id)
		}
		return ran(m, previous) as T
	}
	const c = s.runWithScope(
		own,
		() =>
			kind === "early"
				? s.createEffect<T>(run, then, same(m), { early: true }, info)
				: act === undefined
				? s.createComputer<T>(
					(previous) => ran(m, previous) as T,
					set,
					same(m),
					undefined,
					info,
				)
				: s.createEffect<T>(
					(previous) => ran(m, previous) as T,
					then,
					same(m),
					undefined,
					info,
				),
	)
	m.c = c
	base.statuses.give(c, id)
	runs.give(c, id)
	parts.onCreateFunction?.({
		kind: act === undefined ? "memo" : "effect",
		computer: c,
		node: n,
		id,
		process: inner.node,
	})
	return handle(inner, n)
}

export const pulseAs = (inner: Inner) => here(inner).base.pulse()
