import type { Id, Path } from "@ermine/core/places"
import {
	isPending,
	STATUS,
	status as statusOf,
	TABLE as STATUS_TABLE,
} from "@ermine/core/places/status"
import { PENDING } from "@ermine/core/scheduler"
import type { Field, Run } from "@ermine/processes/runs"
import type { Inner, NodeData, Patch, Target } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { idOf, nodeOf, seen } from "./addressing.ts"
import { mayRead } from "./asking.ts"
import { computerAt } from "./made.ts"
import { here } from "./setting.ts"
import { type Status, type System, WAITING, type Waiting } from "./shapes.ts"

// public (mod.ts exports them): each runs its implementation below, named with As, as the
// context it finds (acting.ts' go)
export const getStatus = /* @__PURE__ */ marked((x: Target, key?: string) =>
	go("getStatus", false, getStatusAs, x, key)
) as System["getStatus"]

// the base's, then what features show (onStatus). key: that field alone, the base reading only
// what it takes [the hedgehog2's wall 3, 10-28: a reader of state reran at every run, n moving;
// chee: "yeah do that"]
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

// a path the waiter at owner recorded, as inner sees it: the path itself when both look from one
// root (the owner's world is its places' root: a computer's context's, a process's), else none
const recordedBy = (inner: Inner, owner: Id, p: Path): Path | null => {
	const { base } = here(inner)
	const root = computerAt(base.made, owner)?.inner.places.root ??
		base.processes.get(owner)?.places.root
	return root === undefined || root === inner.places.root ? p : null
}

// a send's wait as this process sees it: where the send went (its path from the root, or the node
// it named: its path, none: null)
const waitOf = (
	inner: Inner,
	owner: Id,
	w: { path?: Path; id?: Id; since: number },
): Waiting => ({
	send: (w.path !== undefined ? recordedBy(inner, owner, w.path) : seen(inner, w.id!)) ?? null,
	since: w.since,
})
// a wait a process's status says (written as start goes pending): a send's as waitOf, the rest as
// it is
const saidOf = (inner: Inner, owner: Id, w: unknown): Waiting => {
	if (w !== null && typeof w === "object" && "missing" in w) {
		return { node: recordedBy(inner, owner, (w as { missing: Path }).missing) }
	}
	if (w !== null && typeof w === "object" && "send" in w) {
		const { send, since } = w as { send: Path | Id; since: number }
		return waitOf(
			inner,
			owner,
			Array.isArray(send) ? { path: send, since } : { id: send as Id, since },
		)
	}
	return w as Waiting
}

// id's status entry patched (a status is a table of its own, never the node's attributes): a key set
// to a value, or taken out (none). core's status writes a computer's own as its runs end
export const putStatus = (inner: Inner, id: Id, patches: readonly Patch[]) =>
	inner.put({ part: STATUS_TABLE, id, patches })
export const setKey = (key: string, value?: unknown): Patch =>
	value === undefined ? { path: [key] } : { path: [key], value }

// the key a status is read by
const STATUS_KEY = [STATUS]

// asked, read and told as inner sees it. key: the field wanted (none: all); a computer's run record
// is read field by field, only those it takes: n for n, end for state and phase, act for phase,
// reads for waiting
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
		const live = calls.waits(id).map((w) => waitOf(inner, id, w))
		const waiting = Array.isArray(said) && said.length
			? said.map((w) => saidOf(inner, id, w))
			: live
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
	for (const w of calls.waits(id)) waiting.push(waitOf(inner, id, w))
	const m = base.missing.get(id)
	if (m !== undefined && runN !== undefined && m.n === runN) {
		for (const p of m.paths) waiting.push({ node: recordedBy(inner, id, p) })
	}
	if (computer.awaiting) waiting.push("a promise")
	if (waiting.length === 0) waiting.push("PENDING")
	return { state: "pending", waiting, ...nOf }
}
