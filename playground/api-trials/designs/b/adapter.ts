// design B, "call the handle": a node is a function. x() reads (tracked), x(v) replaces with v
// (not a function), x(fn) edits by recipe, x.peep() reads untracked. reads, list, status, why,
// send take a handle or a path. memo and effect give a handle back too.
// decisions: x() with no argument at all is the read (x(undefined) writes undefined); a function
// value can't be written through x(v), it is always a recipe; a handle has no path argument (the
// whole value only); method gives back a handle (reading it gives the function)
import type { NodeData as Node } from "@ermine/ermine"
import type { DataAPI } from "../../lib/compat.ts"
import type { Adapter } from "../../lib/trial.ts"
import { NODE, unwrap, whole } from "../../lib/handles.ts"

function handle(api: DataAPI, node: Node) {
	const h = function (...a: unknown[]) {
		if (a.length === 0) return api.read(node)
		const v = a[0]
		api.edit(node, typeof v === "function" ? v as never : whole(v) as never)
	}
	return Object.assign(h, { [NODE]: node, peep: () => api.peep(node) })
}

const adapter: Adapter = (api, extras) => ({
	open: (p: string, v?: unknown) => handle(api, api.open(p, v)),
	reads: (x: unknown) => api.reads(unwrap(x) as never),
	list: (x: unknown) => api.list(unwrap(x) as never),
	memo: (name: string, f: never, o?: never) => handle(api, api.memo(name, f, o)),
	effect: (name: string, f: never, act: never, o?: never) =>
		handle(api, api.effect(name, f, act, o)),
	method: (p: string, fn: never) => handle(api, api.method(p, fn)),
	send: (p: unknown, ...args: unknown[]) => api.send(unwrap(p) as never, ...args),
	status: (x: unknown) => api.status(unwrap(x) as never),
	why: (x: unknown) => api.explain(unwrap(x) as never),
	teardown: api.teardown,
	PENDING: api.PENDING,
	...extras,
})
export default adapter
