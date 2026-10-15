// a cache per path (contributors.org; chee, per path: "we can just cache instead"): get, entries,
// list and members as lib.ts gives them, each worked out once for a path and kept while someone
// reads it. places without one is places as it always was: nothing here is made or told
//
//   const cache = createPathCache({ places, scheduler })
//   cache.get(["work", "clock"])   // in a run: the run tracks one key for the path, nothing else
//
// an entry: one question (at: every answer at a path; list; members) about one path, its answer,
// the keys its readers track and every key it read working it out
//   - worked out when first asked, there and then, places' reads recorded into the entry (places'
//     record) and told to no one, so the reader's run tracks only the entry's key. an entry at a
//     path reads its folder's entry, one step at a time, so a path's walk is shared by every path
//     under it
//   - a key it read marked (the scheduler's onMark, inside the write): worked out again, there and
//     then, so a read right after a write is fresh. its key is marked, by the writer's run, only
//     when its answer changed (the equal cut); at has two keys, the first answer (get) and all of
//     them (entries), so a change to what is shadowed reruns no get
//   - kept while a run tracks one of its keys or another entry reads one (onTrackingStart,
//     onTrackingEnd, and a count of the entries reading each key); then it goes, and what it read
//     with it. one read outside any run (a host's, an effect's act, runWithScope) keeps nothing:
//     the entry is worked out, answered, and goes
//   - places' spots it reads are held (places' hold), so a run that stops reading a spot an entry
//     reads lets nothing go; the cache lets a spot go once no entry reads it and no run tracks it
//
// open:
//   - every cache hears every mark and every first track and untrack of its scheduler (one shared
//     cache per places, or per mark key, is not decided)
//   - made after runs have tracked spots, it does not know those runs track them, and can let one
//     go under them: make it with the places, before anything reads
//   - between an update and its commit a cached answer is the old one (places' own reads are new)
//   - a reader whose path a write marks runs once before a due writer of a spot under the path, and
//     again after (the key's writer is whoever marked it last)
import type { Run, Scheduler } from "@ermine/scheduler"
import type { Answer, Here, Id, Member, Path, Places } from "./places.ts"

type Kind = "at" | "list" | "members"

// a key readers track: one part of an entry's answer (pick), compared on its own
type Mark = {
	readonly owner: object
	readonly entry: Entry
	readonly pick: (answer: unknown) => unknown
	// a run tracks it now
	runs: boolean
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
	entries: (path: Path) => readonly Answer[]
	list: (path: Path) => readonly string[]
	members: (path: Path) => readonly Member[]
	// what it keeps: entries, and the keys they read
	kept: () => { entries: number; reads: number }
}

const none: readonly never[] = []
const whole = (a: unknown) => a
const firstOf = (a: unknown) => (a as Answer[])[0]

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
	const me = {}
	const entries = new Map<string, Entry>()
	// each key read to the entries reading it
	const readers = new Map<unknown, Set<Entry>>()
	// the keys (but this cache's own) some run tracks now
	const tracked = new Set<unknown>()
	// the latest tick heard
	let now = 0

	const ours = (k: unknown): k is Mark =>
		typeof k === "object" && k !== null && (k as Mark).owner === me

	const nameOf = (kind: Kind, path: Path) => kind + JSON.stringify(path)

	function entryOf(kind: Kind, path: Path): Entry {
		return entries.get(nameOf(kind, path)) ?? make(kind, path)
	}

	// the id at a path, read through its entry's first key
	function idAt(path: Path, reads: Set<unknown>): Id | undefined {
		if (path.length === 0) return places.root
		const up = entryOf("at", path)
		reads.add(up.keys[0])
		return (up.answer as Answer[])[0]?.id
	}

	// an entry's answer, its reads put into reads
	function compute(e: Entry, reads: Set<unknown>): unknown {
		const { kind, path } = e
		if (kind === "at") {
			const up = path.slice(0, -1)
			const id = idAt(up, reads)
			return id === undefined ? none : places.answers({ id, path: up }, path[path.length - 1])
		}
		const id = idAt(path, reads)
		if (id === undefined) return none
		const here: Here = { id, path }
		if (kind === "list") return places.names(here).map((n) => n.name)
		const out: Member[] = []
		for (const { name } of places.names(here)) {
			for (const m of places.walk([name], here)) out.push(m)
		}
		return out
	}

	// worked out, its reads recorded. a throw: whatever it made on the way, unread, goes
	function work(e: Entry): [unknown, Set<unknown>] {
		const reads = new Set<unknown>()
		try {
			return [places.record(() => compute(e, reads), reads), reads]
		} catch (err) {
			for (const k of reads) {
				if (ours(k)) settle(k.entry)
				else if (!readers.has(k) && !tracked.has(k) && places.hold(k, 0) === 0) {
					places.release(k)
				}
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
		const key = (pick: Mark["pick"]): Mark => ({ owner: me, entry: e, pick, runs: false })
		e.keys.push(...(kind === "at" ? [key(firstOf), key(whole)] : [key(whole)]))
		const [answer, reads] = work(e)
		e.answer = answer
		e.reads = reads
		entries.set(name, e)
		for (const k of reads) link(k, e)
		return e
	}

	function link(k: unknown, e: Entry) {
		let set = readers.get(k)
		if (set === undefined) {
			readers.set(k, set = new Set())
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
		if (ours(k)) settle(k.entry)
		else if (places.hold(k, -1) === 0 && !tracked.has(k)) places.release(k)
	}

	// an entry goes when no run tracks its keys and no entry reads them
	function settle(e: Entry) {
		if (!e.live) return
		for (const k of e.keys) if (k.runs || readers.has(k)) return
		e.live = false
		entries.delete(e.name)
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

	s.onMark((keys, run, _due, tick) => {
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
	})

	s.onTrackingStart((k) => {
		if (ours(k)) k.runs = true
		else tracked.add(k)
	})

	s.onTrackingEnd((k) => {
		if (!ours(k)) return void tracked.delete(k)
		k.runs = false
		settle(k.entry)
	})

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
		get: (path) => path.length === 0 ? places.root : (read("at", path, 0) as Answer[])[0]?.id,
		entries: (path) =>
			path.length === 0
				? [{ id: places.root, from: "root" }]
				: read("at", path, 1) as readonly Answer[],
		list: (path) => read("list", path, 0) as readonly string[],
		members: (path) => read("members", path, 0) as readonly Member[],
		kept: () => ({ entries: entries.size, reads: readers.size }),
	}
}
