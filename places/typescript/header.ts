// header: a write's, from the frame open. frame: the frame open itself (extra, one level, if given:
// a frame of its own on top of it), shared, never copied: where a change came from is a walk up its
// parents. actor: the first "actor" over all frames; reader: the first "reader" holding a string.
// time: now, whole seconds. made from outside the graph (no run open, no frame up the chain holding
// locations): one more frame on top of it, its info the locations, every line of the stack there
// (or build's, a location known without a stack); made inside, none (a capture is ~50-70 µs: a
// change inside says where it came from through its frames). no frame open: unscoped, nothing
// written.
import type { ChangeHeader, Frame, Info, Location } from "@ermine/graph/entry"
import { type Scheduler, SchedulerError } from "@ermine/reactivity"
import { capture } from "@ermine/changeable/stacktrace"

// a change base: what a change is from the frame open alone (actor, reader, frame), the header
// without its time and op
export type ChangeBase = Omit<ChangeHeader, "time" | "op">

// the nearest value of key up from frame, innermost first, stopping after the first frame whose
// info names a node (Info's node: what is above a node's scope is not its); none: undefined
export function nearest(frame: Frame | undefined, key: string): unknown {
	for (let f = frame; f !== undefined; f = f.parent) {
		if (key in f.info) return f.info[key]
		if ("node" in f.info) return undefined
	}
	return undefined
}

// the locations nearest up from frame, innermost first: where, from outside the graph, what made
// a change began; none held: undefined
export function locationsOf(frame: Frame | undefined): readonly Location[] | undefined {
	for (let f = frame; f !== undefined; f = f.parent) {
		if (f.info.locations !== undefined) return f.info.locations
	}
	return undefined
}

// whether a call made now is from outside the graph: no run open, and no frame up from the one
// open holds locations in its info (something inside began there already)
export function isOutside(scheduler: Pick<Scheduler, "getCurrentFrame" | "getRun">): boolean {
	if (scheduler.getRun() !== undefined) return false
	for (let f: Frame | undefined = scheduler.getCurrentFrame(); f !== undefined; f = f.parent) {
		if (f.info.locations !== undefined) return false
	}
	return true
}

// the locations of a call made now, when it is from outside the graph: every line of the stack, or
// build's alone (a location known without a stack); inside: undefined
export function outsideAt(
	scheduler: Pick<Scheduler, "getCurrentFrame" | "getRun">,
	build?: Location,
): Location[] | undefined {
	return isOutside(scheduler) ? capture(build) : undefined
}

// the change base the frame open makes, extra its innermost level. none open: undefined
export function createChangeBase(
	scheduler: Pick<Scheduler, "getCurrentFrame">,
	extra?: Info,
): ChangeBase | undefined {
	const open = scheduler.getCurrentFrame()
	if (open === undefined) return undefined
	const frame: Frame = extra === undefined ? open : { info: extra, parent: open }
	let actor: unknown
	let found = false
	let reader: string | undefined
	for (let f: Frame | undefined = frame; f !== undefined; f = f.parent) {
		const info = f.info
		if (!found && "actor" in info) actor = info.actor, found = true
		if (reader === undefined && typeof info.reader === "string") reader = info.reader
	}
	const out: ChangeBase = { actor, frame }
	if (reader !== undefined) out.reader = reader
	return out
}

// the header of a write made now. build: the location of the call as the caller knows it without
// a stack, standing in for the capture when the write is from outside
export function createChangeHeader(
	scheduler: Pick<Scheduler, "getCurrentFrame" | "getRun">,
	extra?: Info,
	build?: Location,
): ChangeHeader {
	const w = createChangeBase(scheduler, extra)
	if (w === undefined) throw new SchedulerError("unscoped", "a write with no frame open")
	const h: ChangeHeader = { ...w, time: Math.floor(Date.now() / 1000) }
	const locations = outsideAt(scheduler, build)
	if (locations !== undefined) h.frame = { info: { locations }, parent: h.frame }
	return h
}
