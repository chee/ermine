// A write's header, from the frame open (shared, never copied). A write from outside the graph
// gets one more frame holding the call's locations; capturing a stack costs about 50-70 µs, so
// a write inside does not. No frame open means unscoped, and nothing is written.
import type { ChangeHeader, Frame, Info, Location } from "@ermine/graph/entry"
import { type Scheduler, SchedulerError } from "@ermine/reactivity"
import { capture } from "@ermine/changeable/stacktrace"

export type ChangeBase = Omit<ChangeHeader, "time" | "op">

export function nearest(frame: Frame | undefined, key: string): unknown {
	for (let f = frame; f !== undefined; f = f.parent) {
		if (key in f.info) return f.info[key]
		if ("node" in f.info) return undefined
	}
	return undefined
}

export function locationsOf(frame: Frame | undefined): readonly Location[] | undefined {
	for (let f = frame; f !== undefined; f = f.parent) {
		if (f.info.locations !== undefined) return f.info.locations
	}
	return undefined
}

export function isOutside(scheduler: Pick<Scheduler, "getCurrentFrame" | "getRun">): boolean {
	if (scheduler.getRun() !== undefined) return false
	for (let f: Frame | undefined = scheduler.getCurrentFrame(); f !== undefined; f = f.parent) {
		if (f.info.locations !== undefined) return false
	}
	return true
}

export function outsideAt(
	scheduler: Pick<Scheduler, "getCurrentFrame" | "getRun">,
	build?: Location,
	cut?: unknown,
): Location[] | undefined {
	return isOutside(scheduler) ? capture(build, cut) : undefined
}

const calls = /* @__PURE__ */ new WeakSet<Frame>()

export function callFrame(
	scheduler: Pick<Scheduler, "getCurrentFrame">,
	locations: Location[],
): Frame {
	const f: Frame = { info: { locations }, parent: scheduler.getCurrentFrame() }
	calls.add(f)
	return f
}

export const isCallFrame = (f: Frame | undefined): boolean => f !== undefined && calls.has(f)

export function locationsHere(
	scheduler: Pick<Scheduler, "getCurrentFrame" | "getRun">,
	build?: Location,
	cut?: unknown,
): Location[] | undefined {
	const open = scheduler.getCurrentFrame()
	return outsideAt(scheduler, build, cut) ??
		(isCallFrame(open) ? open!.info.locations : undefined)
}

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

export function createChangeHeader(
	scheduler: Pick<Scheduler, "getCurrentFrame" | "getRun">,
	{ extra, build, now = Date.now }: { extra?: Info; build?: Location; now?: () => number } = {},
): ChangeHeader {
	const w = createChangeBase(scheduler, extra)
	if (w === undefined) throw new SchedulerError("unscoped", "a write with no frame open")
	const h: ChangeHeader = { ...w, time: Math.floor(now() / 1000) }
	const locations = outsideAt(scheduler, build)
	if (locations !== undefined) h.frame = { info: { locations }, parent: h.frame }
	return h
}
