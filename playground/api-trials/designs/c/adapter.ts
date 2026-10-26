// design C, "a hook tuple": const [x, patchX] = usePath("./p", init). x is the read, patchX the
// write (a value replaces, a function is a recipe). useMemo and useEffect give [x].
// the read form: x is a getter, x() reads (tracked), x.peep() untracked. why: x has to stay
// live (a plain value would be the value at setup, read once, stale after). a getter is the shape
// of the tuple this design borrows (Solid's createSignal: [count, setCount], count()), the call
// is where the read happens (so where it is tracked), and it can't be mistaken for a snapshot as
// a .value getter can (destructured or copied, a .value is a stale plain value again).
// decisions: patchX(v) with a function is always a recipe; reads, list, status, why, send take
// x or a path, as A's words; handlers, teardown as A's (no use- prefix: they aren't hooks here)
import type { NodeData as Node } from "@ermine/ermine"
import type { DataAPI } from "../../lib/compat.ts"
import type { Adapter } from "../../lib/trial.ts"
import { NODE, unwrap, whole } from "../../lib/handles.ts"

const getter = (api: DataAPI, node: Node) =>
	Object.assign(() => api.read(node), { [NODE]: node, peep: () => api.peep(node) })
const patcher = (api: DataAPI, node: Node) => (v: unknown) =>
	api.edit(node, typeof v === "function" ? v as never : whole(v) as never)

const adapter: Adapter = (api, extras) => ({
	usePath: (p: string, init?: unknown) => {
		const n = api.open(p, init)
		return [getter(api, n), patcher(api, n)]
	},
	useMemo: (name: string, f: never, o?: never) => [getter(api, api.memo(name, f, o))],
	useEffect: (name: string, f: never, act: never, o?: never) => [
		getter(api, api.effect(name, f, act, o)),
	],
	reads: (x: unknown) => api.reads(unwrap(x) as never),
	list: (x: unknown) => api.list(unwrap(x) as never),
	method: api.method,
	send: (p: unknown, ...args: unknown[]) => api.send(unwrap(p) as never, ...args),
	status: (x: unknown) => api.status(unwrap(x) as never),
	why: (x: unknown) => api.explain(unwrap(x) as never),
	teardown: api.teardown,
	PENDING: api.PENDING,
	...extras,
})
export default adapter
