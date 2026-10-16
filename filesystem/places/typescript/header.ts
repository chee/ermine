// a write's header, from the scheduler's scope open. the write's pairs: the scope's info
// (getInfo(), nested: its own pairs, then ["owner", the info of the scope it is under]); with
// extra given, the extra then ["owner", info], the write as its own innermost level. the actor:
// the nearest "actor" pair walking outward from the innermost level; the reader: the nearest
// "reader" holding a string the same way. a level's last pair, keyed "owner", is the way up; an
// "owner" before it is only a pair. the metadata: the write's pairs whole, nested, actor and reader left in
// place. the time now, whole seconds; the site of the call. no scope open: unscoped, and nothing
// is written, as the header comes first. the site: a write from outside a run captures its own;
// in a run, the run's first write captures one and every later write of that run (its set, its
// effect's act) is given the same: a stack is read once a run, not once a write
import type { ChangeHeader } from "@ermine/node/entry"
import { type Pair, type Run, type Scheduler, SchedulerError } from "@ermine/scheduler"
import { capture, type FileLocation } from "@ermine/util/stacktrace"

// who a change is: its header, but the time, site and op
export type Who = Omit<ChangeHeader, "time" | "external" | "op">

const ours = new Set([import.meta.url])

// each run's site, once captured
const sites = new WeakMap<Run, FileLocation | undefined>()

// the nearest value of a key walking outward through pairs, the first at each level that counts.
// the level above: the last pair's value, keyed "owner" (an "owner" before it is only a pair, as
// the scheduler puts its own last). none: undefined
export function nearest(
	pairs: readonly Pair[],
	key: string,
	counts: (v: unknown) => boolean = () => true,
): unknown {
	for (let p: readonly Pair[] | undefined = pairs; p !== undefined;) {
		for (const [k, v] of p) if (k === key && counts(v)) return v
		const last = p.at(-1)
		p = last?.[0] === "owner" ? last[1] as readonly Pair[] : undefined
	}
}

// who the scope open says a write is, extra its innermost level. none open: undefined
export function getWho(
	scheduler: Pick<Scheduler, "getInfo">,
	extra: Iterable<Pair> = [],
): Who | undefined {
	const info = scheduler.getInfo()
	if (info === undefined) return undefined
	const more = [...extra]
	const pairs: readonly Pair[] = more.length ? [...more, ["owner", info]] : info
	const out: Who = { actor: nearest(pairs, "actor") }
	const reader = nearest(pairs, "reader", (v) => typeof v === "string")
	if (reader !== undefined) out.reader = reader as string
	out.metadata = pairs as [string, unknown][]
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
