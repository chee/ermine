// design D, "methods on the handle": x.read(), x.peep(), x.edit(change), x.set(v), x.reads(),
// x.list(), x.info(), x.why(), x.status(). memo and effect give the same handle (.read(),
// .status()).
// decisions: every handle has every method (a memo's .set works as an edit of its node would);
// x.info() is a handle on x's attributes; x.read() takes no path (the whole value); send takes a
// handle or a path; method gives back a handle
import type { NodeData as Node } from "@ermine/ermine"
import type { DataAPI } from "../../lib/compat.ts"
import type { Adapter } from "../../lib/trial.ts"
import { NODE, unwrap, whole } from "../../lib/handles.ts"

type Handle = Record<string | symbol, unknown>
function handle(api: DataAPI, node: Node): Handle {
	return {
		[NODE]: node,
		read: () => api.read(node),
		peep: () => api.peep(node),
		edit: (change: unknown) => api.edit(node, change as never),
		set: (v: unknown) => api.edit(node, whole(v) as never),
		reads: () => api.reads(node),
		list: () => api.list(node),
		info: () => handle(api, api.info(node)),
		why: () => api.explain(node),
		status: () => api.status(node),
	}
}

const adapter: Adapter = (api, extras) => ({
	open: (p: string, v?: unknown) => handle(api, api.open(p, v)),
	memo: (name: string, f: never, o?: never) => handle(api, api.memo(name, f, o)),
	effect: (name: string, f: never, act: never, o?: never) =>
		handle(api, api.effect(name, f, act, o)),
	method: (p: string, fn: never) => handle(api, api.method(p, fn)),
	send: (p: unknown, ...args: unknown[]) => api.send(unwrap(p) as never, ...args),
	teardown: api.teardown,
	PENDING: api.PENDING,
	...extras,
})
export default adapter
