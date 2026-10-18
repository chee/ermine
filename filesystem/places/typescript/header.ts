// header: a write's, from the scope open. levels, innermost first: extra (one level, if given),
// the scope open, its parent, ... the root. actor: the first "actor" over all levels; reader: the
// first "reader" holding a string. metadata: one new object, the levels merged, inner keys over
// outer (extra over all), up to and with the first scope whose own info holds the NODE key; none:
// every level. time: now, whole seconds. site: outside a run the call's own; in a run, captured at
// its first write and shared by the rest. no scope open: unscoped, nothing written.
import type { ChangeHeader, Metadata } from "@ermine/node/entry"
import { type Info, type Run, type Scheduler, SchedulerError, type Scope } from "@ermine/scheduler"
import { capture, type FileLocation } from "@ermine/util/stacktrace"

// a change base: what a change is from the scope open alone (actor, reader, metadata), the header
// without its time, site and op
export type ChangeBase = Omit<ChangeHeader, "time" | "external" | "op">

// the key naming a scope's node (its id): a write's metadata stops at the first scope holding it.
// the one spelling: use this, never the string
export const NODE = "node"

const ours = new Set([import.meta.url])

// each run's site, once captured
const sites = new WeakMap<Run, FileLocation | undefined>()

// the change base the scope open makes, extra its innermost level. none open: undefined
export function createChangeBase(
	scheduler: Pick<Scheduler, "getCurrentScope">,
	extra?: Info,
): ChangeBase | undefined {
	const open = scheduler.getCurrentScope()
	if (open === undefined) return undefined
	let actor: unknown
	let reader: string | undefined
	let found = false
	let shown = true
	// the levels taken, innermost first; merged outermost first so inner keys win
	const levels: Info[] = []
	const see = (info: Info) => {
		if (!found && "actor" in info) actor = info.actor, found = true
		if (reader === undefined && typeof info.reader === "string") reader = info.reader
		if (shown) levels.push(info)
		if (NODE in info) shown = false
	}
	if (extra !== undefined) {
		if (!found && "actor" in extra) actor = extra.actor, found = true
		if (typeof extra.reader === "string") reader = extra.reader
		levels.push(extra)
	}
	for (let o: Scope | undefined = open; o !== undefined; o = o.parent) see(o.info)
	const metadata: Metadata = {}
	for (let i = levels.length - 1; i >= 0; i--) Object.assign(metadata, levels[i])
	const out: ChangeBase = { actor }
	if (reader !== undefined) out.reader = reader
	out.metadata = metadata
	return out
}

// the header of a write made now
export function createChangeHeader(
	scheduler: Pick<Scheduler, "getCurrentScope" | "getRun">,
	extra?: Info,
): ChangeHeader {
	const w = createChangeBase(scheduler, extra)
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
