import type { Id, Path } from "@ermine/places"
import {
	isPending,
	STATUS,
	status as statusOf,
	TABLE as STATUS_TABLE,
} from "@ermine/processes/status"
import { PENDING } from "@ermine/reactivity"
import type { Field, Run } from "@ermine/processes/runs"
import type { Inner, NodeData, Patch, Target } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { idOf, nodeOf, seen } from "./addressing.ts"
import { mayRead } from "./asking.ts"
import { computerAt } from "./made.ts"
import { here } from "./setting.ts"
import { type Status, type System, WAITING, type Waiting } from "./shapes.ts"

export const getStatus = /* @__PURE__ */ marked(function getStatus(x: Target, key?: string) {
	return go(getStatus, "getStatus", false, getStatusAs, x, key)
}) as System["getStatus"]

// The base's status, then what features show (onStatus). With `key`, only that field is read, so
// a reader of state does not rerun each time n moves.
export function getStatusAs(inner: Inner, x: Target): Status | undefined
export function getStatusAs(inner: Inner, x: Target, key: string | undefined): unknown
export function getStatusAs(inner: Inner, x: Target, key?: string): unknown {
	const { base } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	if (id === undefined) return undefined
	const status = base.statused(
		{ node: n, id, computer: computerAt(base.made, id) !== undefined },
		ownStatus(inner, n, id, key),
	)
	return key === undefined ? status : status?.[key]
}

const waitOf = (inner: Inner, w: { path?: Path; id?: Id; since: number }): Waiting => ({
	send: (w.path !== undefined ? w.path : seen(inner, w.id!)) ?? null,
	since: w.since,
})
const saidOf = (inner: Inner, w: unknown): Waiting => {
	if (w !== null && typeof w === "object" && "missing" in w) {
		return { node: (w as { missing: Path }).missing }
	}
	if (w !== null && typeof w === "object" && "send" in w) {
		const { send, since } = w as { send: Path | Id; since: number }
		return waitOf(
			inner,
			Array.isArray(send) ? { path: send, since } : { id: send as Id, since },
		)
	}
	return w as Waiting
}

// Patches id's status entry (a table of its own): a key set to a value, or taken out.
export const putStatus = (inner: Inner, id: Id, patches: readonly Patch[]) =>
	inner.put({ part: STATUS_TABLE, id, patches })
export const setKey = (key: string, value?: unknown): Patch =>
	value === undefined ? { path: [key] } : { path: [key], value }

const STATUS_KEY = [STATUS]

// Asked, read and told as inner sees it. A computer's run record is read field by field, only
// those the key needs.
function ownStatus(inner: Inner, n: NodeData, id: Id, key?: string): Status {
	const { base, calls, runs, places } = here(inner)
	mayRead(inner, id, n.path, STATUS_TABLE, STATUS_KEY)
	const st = statusOf(places, id)
	const h = base.held.status(id) ?? base.held.row(id)
	const held = h === undefined ? {} : { held: h }
	const computer = computerAt(base.made, id)
	if (computer === undefined) {
		if (st === undefined) return { state: "done", ...held }
		if (st !== PENDING) return { state: "failed", error: st, ...held }
		const said = places.readValue(STATUS_TABLE, id, [WAITING])
		const live = calls.waits(id).map((w) => waitOf(inner, w))
		const waiting = Array.isArray(said) && said.length ? said.map((w) => saidOf(inner, w)) : live
		return { state: "pending", waiting: waiting.length ? waiting : ["PENDING"], ...held }
	}
	const wants = (k: string) => key === undefined || key === k
	const field = <F extends Field>(f: F) => runs.read(id, f) as Run[F] | undefined
	const runN = wants("n") || wants("waiting") ? field("n") : undefined
	const nOf = runN === undefined ? { ...held } : { n: runN, ...held }
	if (st === undefined) return { state: "done", ...nOf }
	if (st !== PENDING) {
		if (!wants("state") && !wants("phase")) return { state: "failed", error: st, ...nOf }
		const end = field("end")
		if (end === "looping") return { state: "looping", error: st, ...nOf }
		if (!wants("phase")) return { state: "failed", error: st, ...nOf }
		const phase = end !== "failed" && field("act")?.end === "failed" ? "act" : "run"
		return { state: "failed", error: st, phase, ...nOf }
	}
	if (!wants("waiting")) return { state: "pending", ...nOf }
	const waiting: Waiting[] = []
	for (const w of field("reads") ?? []) {
		if (!("part" in w) || w.part !== STATUS_TABLE || w.id === id) continue
		if (w.path?.length !== 1 || w.path[0] !== STATUS) continue
		if (places.peep(() => isPending(places, w.id))) {
			waiting.push({ node: seen(inner, w.id) ?? null })
		}
	}
	for (const w of calls.waits(id)) waiting.push(waitOf(inner, w))
	const m = base.missing.get(id)
	if (m !== undefined && runN !== undefined && m.n === runN) {
		for (const p of m.paths) waiting.push({ node: p })
	}
	if (computer.awaiting) waiting.push("a promise")
	if (waiting.length === 0) waiting.push("PENDING")
	return { state: "pending", waiting, ...nOf }
}
