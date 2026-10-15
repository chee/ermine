// a write's header, from the scheduler's scope open: the pairs of the scope (getInfo()), then
// the write's own extra: the first actor its actor, the first reader its reader, every other pair
// its metadata, in order; the time now, whole seconds; the site of the call. no scope open:
// unscoped, and nothing is written, as the header comes first. the site: a write from outside a
// run captures its own; in a run, the run's first write captures one and every later write of that
// run (its set, its effect's act) is given the same: a stack is read once a run, not once a write
import type { ChangeHeader } from "@ermine/node/entry"
import { type Pair, type Run, type Scheduler, SchedulerError } from "@ermine/scheduler"
import { capture, type FileLocation } from "@ermine/util/stacktrace"

// who a change is: its header, but the time, site and op
export type Who = Omit<ChangeHeader, "time" | "external" | "op">

const ours = new Set([import.meta.url])

// each run's site, once captured
const sites = new WeakMap<Run, FileLocation | undefined>()

// who the scope open says a write is, extra after its pairs. none open: undefined
export function getWho(
	scheduler: Pick<Scheduler, "getInfo">,
	extra: Iterable<Pair> = [],
): Who | undefined {
	const pairs = scheduler.getInfo()
	if (pairs === undefined) return undefined
	const out: Who = { actor: undefined }
	const metadata: [string, unknown][] = []
	let actor = false, reader = false
	for (const [k, v] of [...pairs, ...extra]) {
		if (k === "actor" && !actor) (out.actor = v, actor = true)
		else if (k === "reader" && !reader) (out.reader = v as string, reader = true)
		else metadata.push([k, v])
	}
	if (metadata.length) out.metadata = metadata
	return out
}

// the header of a write made now
export function createChangeHeader(
	scheduler: Pick<Scheduler, "getInfo" | "getRun">,
	extra?: Iterable<Pair>,
): ChangeHeader {
	const w = getWho(scheduler, extra)
	if (w === undefined) throw new SchedulerError("unscoped", "a write with no scope open")
	const h: ChangeHeader = { ...w, time: Math.floor(Date.now() / 1000) }
	const site = siteOf(scheduler.getRun())
	if (site) h.external = [site]
	return h
}

// outside a run, the call's own; in a run, the run's, captured at its first write
function siteOf(run: Run | undefined): FileLocation | undefined {
	if (run === undefined) return capture(ours, createChangeHeader)
	if (sites.has(run)) return sites.get(run)
	const site = capture(ours, createChangeHeader)
	sites.set(run, site)
	return site
}
