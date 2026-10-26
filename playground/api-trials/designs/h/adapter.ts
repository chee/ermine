// design H, B with two changes: the words are globals (on globalThis always, as G's, and api too),
// and a write to a node not there makes it, as G's set does. everything else is B's
// (designs/b/adapter.ts): open(p, v?), x() read (tracked), x(v) replace, x(fn) a recipe,
// x.peep(), reads, list, memo, effect, method, send, status, why, teardown, PENDING; paths as B's
// (a bare "x" inside the program's own node, "./x" the cwd).
// design I (verbs: true): H with verb-first words, as Solid's createMemo. memo → createMemo,
// effect → createEffect, method → createMethod (ermine's word "method" kept, only the verb put
// first). words already verbs stay: open, list, send, show, teardown, the handle's peep.
// decisions:
//   x(v) on a node not there: open(path, v). x(fn) there: fn given undefined, the node made
//     holding what it returns (nothing returned: nothing made)
//   x(fn): immer's rule (G2's TRIAL_DRAFT_RETURN, always on here). the draft changed: its changes;
//     untouched and a value came back: that value replaces (n => n + 1 on a number). so
//     d => d.push(v) pushes (the real recipe would write the returned length)
// design J (small: true): H with every word a program can do without dropped. kept: open, x(),
//   x(v), x(fn), memo, effect, method, send, show. dropped: peep, reads, list, info, status, why,
//   teardown, PENDING. not there yet is x() giving undefined, as G: a memo with no value yet (the
//   real read throws PENDING) reads undefined. a send to no handler still throws the real PENDING
//   (the setup, memo or effect runs again from its start), with no word for it
//   I, mine: status → getStatus, why → getWhy, reads → getReads, so that every word starts with a
//     verb (status, why and reads, the versions, are not verbs). list stays (a verb)
import type { NodeData as Node } from "@ermine/ermine"
import type { DataAPI } from "../../lib/compat.ts"
import type { Adapter } from "../../lib/trial.ts"
import { NODE, unwrap, whole } from "../../lib/handles.ts"
import { abs, missing } from "../../lib/contexts.ts"

// immer's rule over the real recipe: a changed draft wins, else what came back
const immer = (fn: (d: unknown) => unknown) => (d: unknown) => {
	const before = JSON.stringify(d)
	const r = fn(d)
	return JSON.stringify(d) !== before ? undefined : r
}

function handle(api: DataAPI, node: Node, small = false) {
	const h = function (...a: unknown[]) {
		if (a.length === 0) {
			if (!small) return api.read(node)
			try {
				return api.read(node)
			} catch (e) {
				if (e === api.PENDING) return undefined
				throw e
			}
		}
		const v = a[0]
		const fn = typeof v === "function" ? v as (d: unknown) => unknown : undefined
		if (node.path !== undefined && missing(api, node)) {
			const made = fn ? fn(undefined) : v
			if (made !== undefined || !fn) api.open(abs(node.path), made)
			return
		}
		api.edit(node, fn ? immer(fn) as never : whole(v) as never)
	}
	if (small) return Object.assign(h, { [NODE]: node })
	return Object.assign(h, { [NODE]: node, peep: () => api.peep(node) })
}

// H; with verb-first words I; with the fewest words J
export const called = ({ verbs = false, small = false } = {}): Adapter => (api, extras) => {
	const of = (n: Node) => handle(api, n, small)
	const memo = (name: string, f: never, o?: never) => of(api.memo(name, f, o))
	const effect = (name: string, f: never, act: never, o?: never) => of(api.effect(name, f, act, o))
	const method = (p: string, fn: never) => of(api.method(p, fn))
	const open = (p: string, v?: unknown) => of(api.open(p, v))
	const send = (p: unknown, ...args: unknown[]) => api.send(unwrap(p) as never, ...args)
	const status = (x: unknown) => api.status(unwrap(x) as never)
	const why = (x: unknown) => api.explain(unwrap(x) as never)
	const reads = (x: unknown) => api.reads(unwrap(x) as never)
	const words: Record<string, unknown> = small
		? { open, memo, effect, method, send, ...extras }
		: {
			open,
			list: (x: unknown) => api.list(unwrap(x) as never),
			send,
			teardown: api.teardown,
			PENDING: api.PENDING,
			...(verbs
				? {
					createMemo: memo,
					createEffect: effect,
					createMethod: method,
					getStatus: status,
					getWhy: why,
					getReads: reads,
				}
				: { memo, effect, method, status, why, reads }),
			...extras,
		}
	// the words are globals: a program never has to take them out of api
	for (const [k, v] of Object.entries(words)) {
		Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
	}
	return words
}
export default called()
