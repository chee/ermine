import type { Id, Path } from "@ermine/core/places"
import {
	isPending,
	STATUS,
	status as statusOf,
	TABLE as STATUS_TABLE,
} from "@ermine/core/places/status"
import { PENDING } from "@ermine/core/scheduler"
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
export const getStatus: System["getStatus"] = /* @__PURE__ */ marked((x) =>
	go("getStatus", false, getStatusAs, x)
)

// the base's, then what features show (onStatus)
export function getStatusAs(inner: Inner, x: Target): Status | undefined {
	const { base } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	if (id === undefined) return undefined
	return base.statused(
		{ node: n, id, computer: computerAt(base.made, id) !== undefined },
		ownStatus(inner, n, id),
	)
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

// asked, read and told as inner sees it
function ownStatus(inner: Inner, n: NodeData, id: Id): Status {
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
	const r = runs.read(id)
	const nOf = r === undefined ? { ...held } : { n: r.n, ...held }
	if (st === undefined) return { state: "done", ...nOf }
	if (st !== PENDING) {
		if (r?.end === "looping") return { state: "looping", error: st, ...nOf }
		const phase = r?.end !== "failed" && r?.act?.end === "failed" ? "act" : "run"
		return { state: "failed", error: st, phase, ...nOf }
	}
	const waiting: Waiting[] = []
	for (const w of r?.reads ?? []) {
		if (!("part" in w) || w.part !== STATUS_TABLE || w.id === id) continue
		if (w.path?.length !== 1 || w.path[0] !== STATUS) continue
		if (places.peep(() => isPending(places, w.id))) {
			waiting.push({ node: seen(inner, w.id) ?? null })
		}
	}
	for (const w of calls.waits(id)) waiting.push(waitOf(inner, id, w))
	const m = base.missing.get(id)
	if (m !== undefined && r !== undefined && m.n === r.n) {
		for (const p of m.paths) waiting.push({ node: recordedBy(inner, id, p) })
	}
	if (computer.awaiting) waiting.push("a promise")
	if (waiting.length === 0) waiting.push("PENDING")
	return { state: "pending", waiting, ...nOf }
}
