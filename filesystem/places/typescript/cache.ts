// cache: a cache per path (contributors.org). get, gets, list and members as lib.ts gives them,
// worked out once per path and kept while read. places without one is unchanged.
//
//   const cache = createPathCache({ places, scheduler })
//   cache.get(["work", "clock"])   // in a run: the run tracks one key for the path, nothing else
//   cache.stop()                   // its listeners taken away, the spots it holds given back
//
// an entry: one question (at, list, members) about one path, its answer, its keys, what it read.
// worked out when first asked (places' record), a path's entry reading its folder's. a read key
// marked (onMark): worked out again at once; its own key marked only when the answer changed
// (equal cut). at has three keys: first answer (get), all (gets), contributors gone under it. kept
// while a run tracks it or another entry reads it (@ermine/clingy); a read outside any run keeps
// nothing. spots it reads are held; it lets go only spots it made, or inherited once no run tracks
// them. commit right after update: until then a cached answer is the old one.
//
// open: every cache hears every first track and untrack of its scheduler (marks: only its own
// keys, selector.ts keyed). a reader whose path a write marks runs once before a due writer of a
// spot under it, and again after.
import { createClingy } from "@ermine/clingy"
import type { Run, Scheduler } from "@ermine/scheduler"
import { type Holder, keyed } from "@ermine/scheduler/selector"
import {
	type Answer,
	type Answers,
	type Here,
	type Id,
	level,
	type Member,
	type Path,
	type Places,
} from "./places.ts"

type Kind = "at" | "list" | "members"

// a key readers track: one part of an entry's answer (pick), compared on its own
type Mark = {
	readonly owner: object
	readonly entry: Entry
	readonly pick: (answer: unknown) => unknown
}

type Entry = {
	readonly name: string
	readonly kind: Kind
	readonly path: Path
	answer: unknown
	readonly keys: Mark[]
	// every key read working it out: places' spots, contributors' keys, other entries' keys
	reads: Set<unknown>
	// the tick it was last worked out as of
	worked: number
	live: boolean
}

export type PathCache = {
	get: (path: Path) => Id | undefined
	gets: (path: Path) => readonly Answer[]
	list: (path: Path) => readonly string[]
	members: (path: Path) => readonly Member[]
	// what it keeps: entries, and the keys they read
	kept: () => { entries: number; reads: number }
	// its listeners gone and all it holds given back; it is told nothing more, and asked nothing more
	stop: () => void
}

const none: readonly never[] = []
const whole = (a: unknown) => a
// the first answer: an id, never a level
const firstOf = (a: unknown) => (a as Answer[])[0]
// the contributors gone under the path (places' Answers): what an entry under it walks on with
const goneOf = (a: unknown) => (a as Partial<Answers>).gone ?? 0
const idsOf = (a: readonly Answer[]) => a.filter((x) => x.id !== level)

// two answers the same: lists of plain fields, or plain fields
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
	}
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false
	const ka = Object.keys(a)
	return ka.length === Object.keys(b).length &&
		ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

// at before list and members, a folder before what is in it: the order an entry is worked out
// again in, so what it reads is worked out first
const depth = (e: Entry) => 2 * e.path.length + (e.kind === "at" ? 0 : 1)

// answers are shared, never copied: never change one
export function createPathCache(setup: {
	places: Places
	scheduler: Pick<Scheduler, "track" | "mark" | "onMark" | "onTrackingEnd" | "onTrackingStart">
}): PathCache {
	const { places, scheduler: s } = setup
	const index = keyed(s)
	const me = {}
	const entries = new Map<string, Entry>()
	// each key read to the entries reading it
	const readers = new Map<unknown, Set<Entry>>()
	// the keys (but this cache's own) some run tracks now
	const tracked = new Set<unknown>()
	// the spots this cache took itself: only these it lets go
	const took = new Set<unknown>()
	// the latest tick heard
	let now = 0

	const ours = (k: unknown): k is Mark =>
		typeof k === "object" && k !== null && (k as Mark).owner === me

	// its keys: whether a run tracks one now; the last tracker gone, it may go
	const clingy = createClingy<Mark>(s, (k) => settle(k.entry))

	const nameOf = (kind: Kind, path: Path) => kind + JSON.stringify(path)

	function entryOf(kind: Kind, path: Path): Entry {
		return entries.get(nameOf(kind, path)) ?? make(kind, path)
	}

	// where a path is: its id (or level) and the gone under it, read through its entry's first and
	// gone keys (the root: itself, none gone; children alone: never any gone, so not read); nothing
	// there: undefined
	function hereAt(path: Path, reads: Set<unknown>): Here | undefined {
		if (path.length === 0) return { id: places.root, path }
		const up = entryOf("at", path)
		reads.add(up.keys[0])
		const id = (up.answer as Answer[])[0]?.id
		if (id === undefined) return undefined
		if (places.contributors === undefined) return { id, path }
		reads.add(up.keys[2])
		return { id, path, gone: goneOf(up.answer) }
	}

	// an entry's answer, its reads put into reads
	function compute(e: Entry, reads: Set<unknown>): unknown {
		const { kind, path } = e
		if (kind === "at") {
			const here = hereAt(path.slice(0, -1), reads)
			return here === undefined ? none : places.answers(here, path[path.length - 1])
		}
		// a level (no id) is a folder to list, as lib's list and members have it
		const here = hereAt(path, reads)
		if (here === undefined) return none
		if (kind === "list") return places.names(here).map((n) => n.name)
		const named = places.names(here)
		// those whose names said none: gone for each name's walk too
		const under = named.gone === (here.gone ?? 0) ? here : { ...here, gone: named.gone }
		const out: Member[] = []
		for (const { name } of named) {
			for (const m of places.walk([name], under)) out.push(m)
		}
		return out
	}

	// worked out, its reads recorded. a throw: whatever it made on the way, unread, goes
	function work(e: Entry): [unknown, Set<unknown>] {
		const reads = new Set<unknown>(), fresh = new Set<unknown>()
		try {
			const answer = places.record(() => compute(e, reads), reads, fresh)
			for (const k of fresh) took.add(k)
			return [answer, reads]
		} catch (err) {
			for (const k of fresh) took.add(k)
			for (const k of reads) {
				if (ours(k)) settle(k.entry)
				else if (!readers.has(k)) letgo(k)
			}
			throw err
		}
	}

	function make(kind: Kind, path: Path): Entry {
		const name = nameOf(kind, path)
		const e: Entry = {
			name,
			kind,
			path,
			answer: none,
			keys: [],
			reads: new Set(),
			worked: now,
			live: true,
		}
		const key = (pick: Mark["pick"]): Mark => ({ owner: me, entry: e, pick })
		e.keys.push(...(kind === "at" ? [key(firstOf), key(whole), key(goneOf)] : [key(whole)]))
		for (const k of e.keys) clingy.add(k)
		const [answer, reads] = work(e)
		e.answer = answer
		e.reads = reads
		entries.set(name, e)
		for (const k of reads) link(k, e)
		return e
	}

	// a spot no entry reads and no run tracks, if the cache took it: let go
	function letgo(k: unknown) {
		if (!took.has(k) || tracked.has(k) || places.hold(k, 0) !== 0) return
		took.delete(k)
		places.release(k)
	}

	function link(k: unknown, e: Entry) {
		let set = readers.get(k)
		if (set === undefined) {
			readers.set(k, set = new Set())
			index.hold(k, listener)
			if (!ours(k)) places.hold(k, 1)
		}
		set.add(e)
	}

	// e reads k no more. the last entry reading it: an entry's key, that entry may go; a spot, let go
	// unless a run tracks it
	function unlink(k: unknown, e: Entry) {
		const set = readers.get(k)
		if (set === undefined || !set.delete(e) || set.size) return
		readers.delete(k)
		index.drop(k, listener)
		if (ours(k)) settle(k.entry)
		else if (places.hold(k, -1) === 0) letgo(k)
	}

	// an entry goes when no run tracks its keys and no entry reads them
	function settle(e: Entry) {
		if (!e.live) return
		for (const k of e.keys) if (clingy.tracked(k) || readers.has(k)) return
		e.live = false
		entries.delete(e.name)
		for (const k of e.keys) clingy.drop(k)
		for (const k of e.reads) unlink(k, e)
	}

	// worked out again as of tick: its keys whose part of the answer changed marked, by run
	function rework(e: Entry, tick: number, run: Run | undefined) {
		const was = e.answer, old = e.reads
		let answer: unknown, reads: Set<unknown>
		try {
			;[answer, reads] = work(e)
		} catch {
			// it cannot be worked out: it goes, and its readers run again to see why
			e.live = false
			entries.delete(e.name)
			for (const k of e.keys) clingy.drop(k)
			for (const k of old) unlink(k, e)
			s.mark(e.keys, run)
			return
		}
		e.answer = answer
		e.reads = reads
		e.worked = tick
		for (const k of reads) if (!old.has(k)) link(k, e)
		for (const k of old) if (!reads.has(k)) unlink(k, e)
		const changed = e.keys.filter((k) => !same(k.pick(was), k.pick(answer)))
		if (changed.length) s.mark(changed, run)
	}

	// the marks of the keys this cache holds (every key an entry reads), through the scheduler's index
	const listener: Holder = {
		marked(keys, run, _due, tick) {
			if (tick > now) now = tick
			let hit: Entry[] | undefined
			for (const k of keys) {
				const set = readers.get(k)
				if (set !== undefined) { for (const e of set) (hit ??= []).push(e) }
			}
			if (hit === undefined) return
			if (hit.length > 1) hit.sort((a, b) => depth(a) - depth(b))
			// worked as of this tick or later (by a mark made inside this one): already fresh
			for (const e of hit) if (e.live && e.worked < tick) rework(e, tick, run)
		},
	}

	// the other keys (spots): tracked by a run or not
	const offs = [
		s.onTrackingStart((k) => {
			if (!ours(k)) tracked.add(k)
		}),
		s.onTrackingEnd((k) => {
			if (ours(k)) return
			// no run tracks it now: if an entry reads it, its release was held back by us, so the
			// spot is ours to let go
			tracked.delete(k)
			if (readers.has(k)) took.add(k)
		}),
	]

	// its listeners taken away, every key read given back: the index told no more, a spot's hold
	// given back, let go if this cache took it and no run tracks it (one a run tracks goes at its
	// untrack, as places' own). tells nothing
	function stop() {
		for (const off of offs) off()
		clingy.stop()
		for (const k of readers.keys()) {
			index.drop(k, listener)
			if (!ours(k) && places.hold(k, -1) === 0) letgo(k)
		}
		for (const e of entries.values()) e.live = false
		entries.clear()
		readers.clear()
		tracked.clear()
		took.clear()
	}

	// the answer at a path, its key told to the run open (outside one: the entry goes at once)
	function read(kind: Kind, path: Path, which: number): unknown {
		const e = entryOf(kind, path)
		try {
			s.track(e.keys[which])
		} finally {
			settle(e)
		}
		return e.answer
	}

	return {
		get: (path) => {
			if (path.length === 0) return places.root
			const id = (read("at", path, 0) as Answer[])[0]?.id
			return id === level ? undefined : id
		},
		gets: (path) =>
			path.length === 0
				? [{ id: places.root, from: "root" }]
				: idsOf(read("at", path, 1) as readonly Answer[]),
		list: (path) => read("list", path, 0) as readonly string[],
		members: (path) => read("members", path, 0) as readonly Member[],
		kept: () => ({ entries: entries.size, reads: readers.size }),
		stop,
	}
}
