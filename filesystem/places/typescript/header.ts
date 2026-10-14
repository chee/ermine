// a write's header, from the scheduler's scope open: the pairs of the scope (current().pairs), then
// the write's own extra: the first actor its actor, the first reader its reader, every other pair
// its metadata, in order; the time now, whole seconds; the site of the call. no scope open:
// unscoped, and nothing is written, as the header comes first
import type { ChangeHeader } from "@ermine/node/entry"
import { type Pair, type Scheduler, SchedulerError } from "@ermine/scheduler"
import { capture } from "@ermine/util/stacktrace"

// who a change is: its header, but the time, site and op
export type Who = Omit<ChangeHeader, "time" | "external" | "op">

const ours = new Set([import.meta.url])

// who the scope open says a write is, extra after its pairs. none open: undefined
export function getWriter(
	scheduler: Pick<Scheduler, "current">,
	extra: Iterable<Pair> = [],
): Who | undefined {
	const open = scheduler.current()
	if (open === undefined) return undefined
	const out: Who = { actor: undefined }
	const metadata: [string, unknown][] = []
	let actor = false, reader = false
	for (const [k, v] of [...open.pairs, ...extra]) {
		if (k === "actor" && !actor) (out.actor = v, actor = true)
		else if (k === "reader" && !reader) (out.reader = v as string, reader = true)
		else metadata.push([k, v])
	}
	if (metadata.length) out.metadata = metadata
	return out
}

// the header of a write made now
export function createChangeHeader(
	scheduler: Pick<Scheduler, "current">,
	extra?: Iterable<Pair>,
): ChangeHeader {
	const w = getWriter(scheduler, extra)
	if (w === undefined) throw new SchedulerError("unscoped", "a write with no scope open")
	const h: ChangeHeader = { ...w, time: Math.floor(Date.now() / 1000) }
	const site = capture(ours, createChangeHeader)
	if (site) h.external = [site]
	return h
}
