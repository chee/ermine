// link: the connections between the store, places, tracked paths and the scheduler, set up once
// by whoever makes them. it makes none of them and wraps none of their calls: callers use places
// and the store themselves, with a scope open.
//
//   createStore((source, part, id) => link.event(source, part, id))
//   createPlaces({ root, children: store.children, read: link.read })
//   createScheduler({ forget: (key) => link.forget(key) })
//   link.wrote(places.place(slot, entry, link.header()))
//
// a read is told to the scheduler as a spot (paths'), so a run reading tracks it; after an await
// it counts for nothing. a write says changed the spots its patches mark, at every key the node
// is under; a table event the spots of its key. both by the writer open (the scheduler's
// current().by), none: from outside
//
// a write's header is the pairs of the scope open (current().pairs), then the write's own extra:
// the first actor its actor, the first reader its reader, every other pair its metadata, in
// order; the time now, whole seconds; the site of the call. no scope open: unscoped, and nothing
// is written, as the header comes first
//
// paths keys a spot by two parts, (source, id); the store by three. the first two go into one
// object per (source, part), made once and kept: the same always, so the key is the same by
// identity. a spot nobody reads any more is let go: the scheduler's forget calls link's with each
// key it stops tracking. a spot read outside a run is tracked by none, so never let go
//
// spot(key) names a key told to the scheduler: one of this link's spots, held, is where it reads,
// so a run's reads (the scheduler's ends moment) can be named as places in the graph. anything
// else, or a spot let go: undefined
import type { ChangeHeader, Entry } from "@ermine/node"
import type { Key as Step } from "@ermine/op/apply"
import type { Read as PlacesRead } from "@ermine/places"
import { type Pair, type Scheduler, SchedulerError } from "@ermine/scheduler"
import type { createPaths, Spot } from "@ermine/scheduler/paths"
import type { Key, Part, Store } from "@ermine/store"
import { capture } from "@ermine/util/stacktrace"

export type Paths = ReturnType<typeof createPaths<unknown>>

export type Setup = {
	store: Store
	paths: Paths
	scheduler: Pick<Scheduler, "read" | "changed" | "current">
}

// who a change is: its header, but the time, site and op
export type Who = Omit<ChangeHeader, "time" | "external" | "op">

// a node a write changed, and the source whose table it is in: places' Changed is one
export type Wrote = { readonly source: Key; readonly node: Entry<unknown> }

// where a spot reads: the node under (source, part, id), and the path in its value (kept by
// paths, never change it); null: the change spot, reads of the change itself
export type Where = {
	readonly source: Key
	readonly part: Part
	readonly id: Key
	readonly path: readonly Step[] | null
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)

// a typed array: a sequence of its elements; bytes, a Uint8Array, one whole value (op's test)
const typed = (v: unknown): v is ArrayLike<unknown> =>
	ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof Uint8Array)

// what is at path in a value: a number into a list or a typed array, a name into a map; nothing
// there: undefined
export function at(v: unknown, path: readonly Step[]): unknown {
	for (const k of path) {
		if (typeof k === "number") {
			if (!Array.isArray(v) && !typed(v)) return undefined
			v = v[k]
		} else {
			if (!isMap(v) || !Object.hasOwn(v, k)) return undefined
			v = v[k]
		}
	}
	return v
}

const ours = new Set([import.meta.url])

export function createLink(setup: Setup): Link {
	const { store, paths, scheduler } = setup

	const firsts = new Map<Key, Map<Part, { source: Key; part: Part }>>()
	// the one key part of (source, part)
	function first(source: Key, part: Part) {
		let parts = firsts.get(source)
		if (parts === undefined) firsts.set(source, parts = new Map())
		let p = parts.get(part)
		if (p === undefined) parts.set(part, p = { source, part })
		return p
	}

	// this link's spots: their owner, so forget knows them
	const mine = {}
	function tell(s: Spot<unknown>) {
		s.owner = mine
		scheduler.read(s)
	}

	const held = (key: unknown): key is Spot<unknown> =>
		typeof key === "object" && key !== null && (key as Spot<unknown>).owner === mine

	// a key the scheduler stopped tracking: one of this link's spots is released, and is not
	// this link's any more
	function forget(key: unknown) {
		if (!held(key)) return
		paths.release(key)
		key.owner = undefined
	}

	// where a key reads, when it is one of this link's spots, held; else undefined
	function spot(key: unknown): Where | undefined {
		if (!held(key)) return undefined
		const { source, part } = key.source as { source: Key; part: Part }
		return { source, part, id: key.id as Key, path: key.path }
	}

	// spots said changed, in one call, by the writer open; none: nothing said
	function say(spots: readonly unknown[]) {
		if (spots.length) scheduler.changed(spots, scheduler.current()?.by)
	}

	// places' read hook: a read of a children node's value at a path, or of its names
	const read = (r: PlacesRead) =>
		tell(paths.spot(first(r.source, "children"), r.id, r.path, r.keys === true))

	// the store's: a table event, every spot of its key
	const event = (source: Key, part: Part, id: Key) => say(paths.event(first(source, part), id))

	// what a write changed: the spots each node's latest patches mark, at every key it is under in
	// its source's table
	function wrote(changed: readonly Wrote[]) {
		const out: unknown[] = []
		for (const { source, node } of changed) {
			const op = node.change.op
			if (op === undefined) continue
			for (const [part, id] of store.who(source, node)) {
				out.push(...paths.mark(first(source, part), id, op.patches))
			}
		}
		say(out)
	}

	// what is at path in the value of the node under (source, part, id), the read told. path: kept
	// by paths, never change it
	function get(source: Key, part: Part, id: Key, path: readonly Step[] = []): unknown {
		tell(paths.spot(first(source, part), id, path))
		return at(store.get(source, part, id)?.value, path)
	}

	// the change of the node under (source, part, id), the read told at its change spot: any write
	// to the node reruns it. none there: undefined
	function change(source: Key, part: Part, id: Key): ChangeHeader | undefined {
		tell(paths.change(first(source, part), id))
		return store.get(source, part, id)?.change
	}

	// who the scope open says a write is, extra after its pairs. none open: undefined
	function who(extra: Iterable<Pair> = []): Who | undefined {
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
	function header(extra?: Iterable<Pair>): ChangeHeader {
		const w = who(extra)
		if (w === undefined) throw new SchedulerError("unscoped", "a write with no scope open")
		const h: ChangeHeader = { ...w, time: Math.floor(Date.now() / 1000) }
		const site = capture(ours, header)
		if (site) h.external = [site]
		return h
	}

	return { read, event, forget, spot, wrote, get, change, who, header }
}

export type Link = {
	read: (r: PlacesRead) => void
	event: (source: Key, part: Part, id: Key) => void
	forget: (key: unknown) => void
	spot: (key: unknown) => Where | undefined
	wrote: (changed: readonly Wrote[]) => void
	get: (source: Key, part: Part, id: Key, path?: readonly Step[]) => unknown
	change: (source: Key, part: Part, id: Key) => ChangeHeader | undefined
	who: (extra?: Iterable<Pair>) => Who | undefined
	header: (extra?: Iterable<Pair>) => ChangeHeader
}
