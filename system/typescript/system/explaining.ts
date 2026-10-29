import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import { type Id, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { locationsOf, nearest, NODE } from "@ermine/places/header"
import type { Run } from "@ermine/processes/runs"
import type { Key } from "@ermine/graph/table"
import type { Call } from "../calls.ts"
import { dataOf, isHandle } from "../handles.ts"
import type { Inner, Step, Target } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { handle, idOf, nodeOf, seen, viewOf } from "./addressing.ts"
import { mayRead } from "./asking.ts"
import { here } from "./setting.ts"
import type { CallView, ChangeView, Explained, RunView, System, Touched } from "./shapes.ts"

// public (mod.ts exports them): each runs its implementation below, named with As, as the
// context it finds (acting.ts' go)
export const explain: System["explain"] = /* @__PURE__ */ marked((x, key) =>
	go("explain", false, explainAs, x, key)
)
export const explainAttributes: System["explainAttributes"] = /* @__PURE__ */ marked((x) =>
	go("explainAttributes", false, explainAttributesAs, x)
)
export const explainChildren: System["explainChildren"] = /* @__PURE__ */ marked((x) =>
	go("explainChildren", false, explainChildrenAs, x)
)

const explainPart = (inner: Inner, x: Target, part: "value" | "attributes" | "children") =>
	explainAs(inner, handle(inner, { ...nodeOf(inner, x), part }))

export function explainAs(
	inner: Inner,
	x: Target | ChangeView,
	path: readonly Step[] = [],
): Explained | undefined {
	const { base, table, places } = here(inner)
	// a change's view (a reads item's from.change, a watch's): its change. a view is known only
	// by base.changes, so none can be forged into a record's lookup
	const viewed = typeof x === "object" && !isHandle(x) && !Array.isArray(x)
		? base.changes.get(x as ChangeView)
		: undefined
	if (viewed !== undefined) return writerOf(inner, viewed)
	if (typeof x === "object" && !isHandle(x) && !Array.isArray(x)) {
		throw new PlacesError("nothing-there", "not a change this ermine shows")
	}
	const n = nodeOf(inner, x as Target)
	const id = idOf(inner, n)
	if (id === undefined) return undefined
	mayRead(inner, id, n.path, n.part, path)
	places.readChange(n.part, id)
	const change = (table.get(n.part, id) as Entry<unknown> | undefined)?.change
	const h = base.held.at(n.part, id)
	if (change === undefined) return h === undefined ? undefined : { held: h }
	const by = writerOf(inner, change)
	return h === undefined ? by : { ...by, held: h }
}

// a record's read or write, as this process sees it
const touched = (inner: Inner, t: { part: Key; id: Id }): Touched => {
	const p = seen(inner, t.id)
	return p === undefined ? { part: t.part } : { part: t.part, path: p }
}
const pathOf = (inner: Inner, id: Id) => {
	const p = seen(inner, id)
	return p === undefined ? {} : { path: p }
}
const runView = (inner: Inner, r: Run): RunView => ({
	n: r.n,
	...r.started !== undefined && { started: r.started },
	ended: r.ended,
	end: r.end,
	..."error" in r && { error: r.error },
	...r.act !== undefined && { act: r.act },
	reads: r.reads.flatMap((x) => "part" in x ? [touched(inner, x)] : []),
	writes: r.writes.map((t) => touched(inner, t)),
})
// a value a record holds (a call's args, what it returned) as inner is shown it: a handle in it, the
// path it reaches as inner sees it (none: null), never the handle [the dormouse's finding 2]. lists
// and plain maps looked through; anything else as it is
function shown(inner: Inner, v: unknown, seenAlready = new Map<object, unknown>()): unknown {
	if (isHandle(v)) {
		const d = dataOf(here(inner).base.handles, v).node
		const id = d.id ?? get(here(inner).places, d.path!)
		return (id === undefined ? undefined : seen(inner, id)) ?? null
	}
	// a writer is a power, never data: shown as a marker, as a handle is shown as its path
	if (typeof v === "function" && here(inner).base.writers.has(v)) return "[writer]"
	if (v === null || typeof v !== "object") return v
	const proto = Object.getPrototypeOf(v)
	if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v
	const again = seenAlready.get(v)
	if (again !== undefined) return again
	if (Array.isArray(v)) {
		const out: unknown[] = []
		seenAlready.set(v, out)
		for (const x of v) out.push(shown(inner, x, seenAlready))
		return out
	}
	const out: Record<string, unknown> = {}
	seenAlready.set(v, out)
	for (const [k, x] of Object.entries(v)) out[k] = shown(inner, x, seenAlready)
	return out
}

const callView = (inner: Inner, c: Call): CallView => ({
	n: c.n,
	args: shown(inner, c.args) as unknown[],
	end: c.end,
	..."returned" in c && { returned: shown(inner, c.returned) },
	..."error" in c && { error: shown(inner, c.error) },
	started: c.started,
	...c.ended !== undefined && { ended: c.ended },
	reads: c.reads.flatMap((x) => "part" in x ? [touched(inner, x)] : []),
	writes: c.writes.map((t) => touched(inner, t)),
	...c.made !== undefined &&
		{ made: c.made.map((m) => ({ kind: m.kind, ...pathOf(inner, m.id) })) },
})

// the change's writer, one step: its view, the writer by path as this process sees it
function writerOf(inner: Inner, change: ChangeHeader): Explained & { change: ChangeView } {
	const { base, calls, runs } = here(inner)
	const at = (key: string) => nearest(change.frame, key)
	const holds = (writes: readonly { change: ChangeHeader | undefined }[]) =>
		writes.some((w) => w.change === change)
	const view = viewOf(base, change)
	if (at("run") !== undefined && at(NODE) !== undefined) {
		const computer = at(NODE) as Id
		const run = runs.read(computer)
		return run !== undefined && run.n === at("run") && holds(run.writes)
			? {
				change: view,
				writer: { kind: "computer", ...pathOf(inner, computer), run: runView(inner, run) },
			}
			: { change: view, writer: { kind: "computer", ...pathOf(inner, computer) } }
	}
	if (at("call") !== undefined && at("handler") !== undefined) {
		const handler = at("handler") as Id
		const call = calls.latest(handler)
		// any write carrying the call's mark: the call's view, while it is the handler's latest
		if (call !== undefined && call.n === at("call")) {
			return {
				change: view,
				writer: { kind: "method", ...pathOf(inner, handler), call: callView(inner, call) },
			}
		}
		return { change: view, writer: { kind: "method", ...pathOf(inner, handler) } }
	}
	// pipe-extension: core gap. a scope whose info holds NODE and a feature's name: that feature's
	// thing, writing as itself, at its node
	const feature = at("feature")
	if (typeof feature === "string" && at(NODE) !== undefined) {
		return {
			change: view,
			writer: { kind: "feature", feature, ...pathOf(inner, at(NODE) as Id) },
		}
	}
	const locations = locationsOf(change.frame)
	return {
		change: view,
		writer: {
			kind: "outside",
			...locations !== undefined && { locations },
		},
	}
}

export const explainAttributesAs = (inner: Inner, x: Target) => explainPart(inner, x, "attributes")
export const explainChildrenAs = (inner: Inner, x: Target) => explainPart(inner, x, "children")
