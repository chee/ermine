// header: a write's, from the scope open. levels, innermost first: extra (one level, if given),
// the scope open, its parent, ... the root. actor: the first "actor" over all levels; reader: the
// first "reader" holding a string. metadata: one new object, the levels merged, inner keys over
// outer (extra over all), up to and with the first scope whose own info holds the NODE key; none:
// every level. time: now, whole seconds. site: the one given; none given, outside a run the call's
// own, in a run none (a capture is ~50-70 µs: too dear per write in a run; a caller who knows the
// running computer's own site gives it). no scope open: unscoped, nothing written.
import type { ChangeHeader, Metadata } from "@ermine/core/node/entry"
import { type Info, type Scheduler, SchedulerError, type Scope } from "@ermine/core/scheduler"
import {
	capture,
	captureStack,
	type FileLocation,
	framesOf,
	outside,
	type Stack,
} from "@ermine/core/util/stacktrace"

// a change base: what a change is from the scope open alone (actor, reader, metadata), the header
// without its time, site and op
export type ChangeBase = Omit<ChangeHeader, "time" | "external" | "op">

// the key naming a scope's node (its id): a write's metadata stops at the first scope holding it.
// the one spelling: use this, never the string
export const NODE = "node"

const ours = new Set([import.meta.url])

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
// skip: files a library calls through on the way here (its own, and what it wraps calls in), so the
// site is the first frame outside them too. from: the function whose caller is the site, where the
// engine allows (a removal's header made inside table.del's event: del); none, this one. site: the
// write's, as the caller knows it (in a run: the running computer's own); none: see above
export function createChangeHeader(
	scheduler: Pick<Scheduler, "getCurrentScope" | "getRun">,
	extra?: Info,
	skip?: Iterable<string>,
	from?: unknown,
	site?: FileLocation,
): ChangeHeader {
	const w = createChangeBase(scheduler, extra)
	if (w === undefined) throw new SchedulerError("unscoped", "a write with no scope open")
	const h: ChangeHeader = { ...w, time: Math.floor(Date.now() / 1000) }
	if (site !== undefined) {
		h.external = [site]
		return h
	}
	if (scheduler.getRun() !== undefined) return h
	const all = skip === undefined ? ours : new Set([...ours, ...skip])
	// the whole stack kept beside the change, unread till stackOf asks (~2 µs)
	const whole = captureStack(createChangeHeader)
	stacks.set(h, whole)
	// the site: from the nearest 10 frames (cheap); none there outside ours, from the whole stack
	// (read out then, ~100 µs: only when a library's frames fill the 10)
	const at = near(all, from ?? createChangeHeader) ??
		(typeof whole.stack === "string" ? outside(whole.stack, all) : undefined)
	if (at) h.external = [at]
	return h
}

// the caller of from; from not on the stack (an engine cuts everything then): the caller of
// createChangeHeader
const near = (skip: ReadonlySet<string>, from: unknown) =>
	capture(skip, from) ??
		(from === createChangeHeader ? undefined : capture(skip, createChangeHeader))

// each change's whole stack, as it was made (outside a run), kept here beside the change, never in
// it: nothing more is stored or synced [chee 10-26: "we should just keep the whole stack"; where it
// is kept: the builder's pick]
const stacks = new WeakMap<ChangeHeader, Stack>()

// the whole stack a change was made with, each frame (the engine's, ermine's and the program's);
// none kept (made in a run, or given its site): undefined
export function stackOf(header: ChangeHeader): FileLocation[] | undefined {
	const s = stacks.get(header)
	return s === undefined ? undefined : framesOf(s)
}
