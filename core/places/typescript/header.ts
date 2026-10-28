// header: a write's, from the scope open. levels, innermost first: extra (one level, if given),
// the scope open, its parent, ... the root. actor: the first "actor" over all levels; reader: the
// first "reader" holding a string. metadata: one new object, the levels merged, inner keys over
// outer (extra over all), up to and with the first scope whose own info holds the NODE key; none:
// every level. time: now, whole seconds. site: the one given; none given, outside a run the call's
// own, in a run none (a capture is ~50-70 µs: too dear per write in a run; a caller who knows the
// site gives it: the running computer's own, a process's for its setup). no scope open: unscoped,
// nothing written.
import type { ChangeHeader, Metadata } from "@ermine/core/node/entry"
import { type Info, type Scheduler, SchedulerError, type Scope } from "@ermine/core/scheduler"
import { capture, type FileLocation, outside, trace } from "@ermine/core/util/stacktrace"

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
	// the whole trace text kept beside the change too (traceOf), its site found in it (no frame
	// limit): one capture, written out at once (~40 µs on a shallow stack, ~230 µs 40 deep)
	whole?: boolean,
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
	if (whole === true) {
		// from not on the stack: V8 gives "Error" with no frames, so fall back when none is outside
		let text = trace(from ?? createChangeHeader)
		let at = text === undefined ? undefined : outside(text, all)
		if (at === undefined && from !== undefined) {
			text = trace(createChangeHeader)
			at = text === undefined ? undefined : outside(text, all)
		}
		if (at) h.external = [at]
		if (text !== undefined && h.metadata !== undefined) traces.set(h.metadata, text)
		return h
	}
	const at = near(all, from ?? createChangeHeader)
	if (at) h.external = [at]
	return h
}

// each change's whole trace text [chee 10-26: "keep what we think is the original file and the whole
// text of the trace too"], held beside the change by its metadata (a header's copies share it), never
// in the change: never encoded, stored or synced (where: the builder's pick)
const traces = /* @__PURE__ */ new WeakMap<object, string>()

// the whole trace text the change was made with; none held (made in a run, given its site, or the
// trace not asked for): undefined
export function traceOf(header: Pick<ChangeHeader, "metadata">): string | undefined {
	return header.metadata === undefined ? undefined : traces.get(header.metadata)
}

// to, a copy of from with new metadata, given from's trace: to
export function carryTrace<H extends Pick<ChangeHeader, "metadata">>(
	from: Pick<ChangeHeader, "metadata">,
	to: H,
): H {
	const t = traceOf(from)
	if (t !== undefined && to.metadata !== undefined) traces.set(to.metadata, t)
	return to
}

// the caller of from; from not on the stack (an engine cuts everything then): the caller of
// createChangeHeader
const near = (skip: ReadonlySet<string>, from: unknown) =>
	capture(skip, from) ??
		(from === createChangeHeader ? undefined : capture(skip, createChangeHeader))
