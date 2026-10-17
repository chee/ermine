// places: the filesystem made real. walks names from a root through the children table, reads
// values, and ties them to tracked paths and the scheduler. it makes none of them; writes are plain
// functions on a children entry, said written here with commit.
//
//   createTable((part, id) => places.onTableChange(part, id))
//   scheduler.onTrackingEnd((key) => places.release(key))
//   const places = createPlaces({ root, table, paths, scheduler, contributors: [other, children] })
//   places.commit(place(table.get("children", id)!, name, entry, createChangeHeader(scheduler)))
//   const inside = places.view(folder, [processes(folder), children])   // nothing above folder
//
// a name: any string but "", ".", ".." and "/". a read is told to the scheduler as a spot; after an
// await it counts for nothing; outside a run it is never let go. a write marks the spots its
// patches touch, by the run open. contributors (default: children alone) are asked in order each
// step: the first answer is where get goes, names are all of theirs. pruning: one may answer none
// for a whole subtree, and is not asked again under there (that read is tracked, so something
// arriving reruns the walk). describe(key): a held spot as a place, else undefined.
// watchAll(fn): every fact as it lands (runs.ts). a cache (cache.ts) records reads outside runs:
// commit right after update.
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Key as Step, Patch } from "@ermine/op/apply"
import type { Scheduler } from "@ermine/scheduler"
import { keyOrder } from "@ermine/encoding/cbor"
import type { createPaths, Spot } from "@ermine/scheduler/paths"
import type { Id, Key, Table } from "@ermine/table"

export type { Id }

export type Paths = ReturnType<typeof createPaths<unknown>>

// names from the root, each looked up as it is
export type Path = readonly string[]

export type Setup = {
	// where names start
	root: Id
	table: Pick<Table, "get" | "who">
	paths: Paths
	scheduler: Pick<Scheduler, "track" | "mark" | "getRun">
	// what answers each step, in order; none: children alone
	contributors?: readonly Contributor[]
}

// the id a walk is at on a level (a contributor's level, with no id of its own): not an id of any
// entry, so it is never given as an answer (lib's get: nothing there)
export const level: Id = Symbol("level")

// a contributor's answer: nothing at here + name, nor anywhere under it (step); no names under
// here, nor anywhere deeper (names). a symbol, as level is, so it is one return and costs nothing
export const none: unique symbol = Symbol("none")

// where a walk has got to: the id it is at, its path (the names from the root to it), and gone:
// the contributors that said none at it or above, never asked under it: a bit each, by its place in
// the asker's list (the first 32; any after are always asked). no path: a walk from an id alone,
// where it is from the root not known. no gone: none
export type Here = { readonly id: Id; readonly path?: Path; readonly gone?: number }

// a contributor's bit in gone; past the 32nd: none
const bit = (i: number) => i < 32 ? 1 << i : 0

// what a contributor reads through: places' reads, told as places tells its own (in a run, the
// run tracks them), and track for a key of its own (which it marks itself when it changes)
export type Reads = {
	// what is at path in the value under (part, id), told as a read of all under path
	read(part: Key, id: Id, path?: readonly Step[]): unknown
	// the names at path, told as a read of which names there are: a name coming, going or put over
	// tells it, a change deeper under a name does not. ids: only the names holding an id (whether a
	// name holds one changes only when it is put over, so the read is the same)
	keys(part: Key, id: Id, path?: readonly Step[], ids?: boolean): string[]
	track(key: unknown): void
}

export type Contributor = {
	// what it is called: the from of each answer it gives
	readonly from: string
	// the id it has at here + name; nothing there (maybe deeper): undefined; nothing there or
	// anywhere under it: none
	step(here: Here, name: string, reads: Reads): Id | undefined | typeof none
	// the names it has directly under here, in its order: each one step answers, or a level of its
	// own. none: no names, here or anywhere deeper
	names(here: Here, reads: Reads): string[] | typeof none
	// whether here + name is a level of its own: no id, but names under it, so a walk goes on through
	// it as if it were a folder (see places' walk). none: never
	level?(here: Here, name: string, reads: Reads): boolean
}

// an answer at a path, and the contributor that gave it
export type Answer = { readonly id: Id; readonly from: string }

// a name at a path, and the first contributor that gives it
export type Named = { readonly name: string; readonly from: string }

// every answer at here + name; gone: the contributors gone under it (here's, and those that said
// none), for a walk on from there
export type Answers = Answer[] & { readonly gone: number }

// every name under here; gone: the contributors gone under it (here's, and those whose names said
// none), for a walk of each name from there
export type Names = Named[] & { readonly gone: number }

// where a spot reads: the entry under (part, id), and the path in its value (kept by paths, never
// change it); null: the change spot, reads of the change itself. keys: a read of which names
// there are at path, not what is under them (readKeys)
export type Where = {
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[] | null
	readonly keys?: true
}

// a name in a children entry, and the id under it (a contributor's level: the id level, no id of
// its own). from: the contributor that gave it (none: a places given no contributors, children alone)
export type Member = { readonly name: string; readonly id: Id; readonly from?: string }

// what landed at one key: the patches a write put there (a table event: one at the root, the value
// whole; taken out, one at the root with no value), the change, and the entry now (none: taken out)
export type Fact = {
	readonly part: Key
	readonly id: Id
	readonly patches: readonly Patch[]
	readonly change: ChangeHeader | undefined
	readonly entry: Entry<unknown> | undefined
}

// what a watch is told about: the node at a path from the root, found as each fact lands (the walk
// not told: a watch reads nothing); only part, when given; only the patches touching at (a path in
// the value: one above it, at it or under it), when given
export type Watching = { readonly part?: Key; readonly at?: readonly Step[] }

export type Code = "not-a-name" | "nothing-there" | "already-there"

export class PlacesError extends Error {
	// the name asked about, when there was one
	constructor(readonly code: Code, readonly at?: string) {
		super(at === undefined ? code : `${code} (${at})`)
	}
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)

const isId = (v: unknown): v is Id => typeof v === "string" || typeof v === "symbol"

// v when it is an id; else undefined
export const asId = (v: unknown): Id | undefined => isId(v) ? v : undefined

// the children table: goes by the id, never the path (a level has none: nothing, nothing read). the
// default contributor
export const children: Contributor = {
	from: "children",
	step: ({ id }, name, r) => id === level ? undefined : asId(r.read("children", id, [name])),
	names: ({ id }, r) => id === level ? [] : r.keys("children", id),
}

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

// whether two paths in a value touch: one is the other or above it
function touch(a: readonly Step[], b: readonly Step[]): boolean {
	for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return false
	return true
}

// whether a patch touches a path in the value: where it lands, or where it moves from
const touches = (p: Patch, path: readonly Step[]) =>
	touch(p.path, path) || (p.move !== undefined && touch(p.move.path, path))

// the id under name in a children entry; none, or something that is not an id: undefined
function child(children: Entry<unknown> | undefined, name: string): Id | undefined {
	const v = children?.value
	if (!isMap(v) || !Object.hasOwn(v, name)) return undefined
	const id = v[name]
	return isId(id) ? id : undefined
}

// a places' own: where names start, and the contributors that answer each step (none given: children
// alone, walked as it always was); go, the first answer at one step; gone, the gone under the step
// go took last (here's, and the contributors that said none)
type View = {
	readonly root: Id
	readonly given: readonly Contributor[] | undefined
	readonly go: (here: Here, name: string) => Member | undefined
	readonly gone: () => number
}

export function createPlaces(setup: Setup): Places {
	const { table, paths, scheduler } = setup

	// everything below but view is shared by every view: spots, holds, record, commit, watches

	const firsts = new Map<Key, { part: Key }>()
	// the one key object of a part
	function first(part: Key) {
		let p = firsts.get(part)
		if (p === undefined) firsts.set(part, p = { part })
		return p
	}

	// this places' spots: their owner, so forget knows them
	const mine = {}
	// where reads go while record runs, and the spots it made (none held before); none: the scheduler
	let into: Set<unknown> | undefined
	let made: Set<unknown> | undefined
	function tell(s: Spot<unknown>) {
		const known = s.owner === mine
		s.owner = mine
		if (into === undefined) scheduler.track(s)
		else {
			into.add(s)
			if (!known) made?.add(s)
		}
	}

	// f, with every read it makes (a spot, or a contributor's track) put into reads and told to no
	// one: what a cache works out outside any run. inside another record, apart from it. made: the
	// spots f read that were not this places' before (so nothing else tracks or holds them)
	function record<T>(f: () => T, reads: Set<unknown>, fresh?: Set<unknown>): T {
		const was = into, wasMade = made
		into = reads
		made = fresh
		try {
			return f()
		} finally {
			into = was
			made = wasMade
		}
	}

	const held = (key: unknown): key is Spot<unknown> =>
		typeof key === "object" && key !== null && (key as Spot<unknown>).owner === mine

	// spots something outside the scheduler reads (a cache's entries), and how many holds each
	const holds = new Map<unknown, number>()

	// a hold on one of this places' spots taken (n 1) or given back (n -1): the holds left. a held
	// spot is not let go by release; the holder calls release once its last hold is given back and
	// no run tracks the spot. anything else: 0, nothing kept
	function hold(key: unknown, n: number): number {
		if (!held(key)) return 0
		const left = (holds.get(key) ?? 0) + n
		if (left > 0) holds.set(key, left)
		else holds.delete(key)
		return Math.max(left, 0)
	}

	// a key the scheduler stopped tracking: one of this places' spots is released, and is not
	// this places' any more. a spot held: kept
	function release(key: unknown) {
		if (!held(key) || (holds.size && holds.has(key))) return
		paths.release(key)
		key.owner = undefined
	}

	// where a key reads, when it is one of this places' spots, held; else undefined
	function describe(key: unknown): Where | undefined {
		if (!held(key)) return undefined
		const { part } = key.source as { part: Key }
		return key.keys
			? { part, id: key.id as Id, path: key.path, keys: true }
			: { part, id: key.id as Id, path: key.path }
	}

	// spots said changed, in one call, by the writer open; none: nothing said
	function say(spots: readonly unknown[]) {
		if (spots.length) scheduler.mark(spots, scheduler.getRun())
	}

	// children and attributes change in place, not on a copy: a place into a folder of n names costs
	// one step, not n (a copy each place made 30k names in one folder take 106 s). set as an entry
	// comes into the table, before anything reads it. a reader is told by its spots: a computer
	// returning a whole map gets the same object back, so its equal check stops there
	function inPlace(part: Key, id: Id) {
		if (part !== "children" && part !== "attributes") return
		const entry = table.get(part, id)
		if (entry !== undefined) entry.cow = false
	}

	// the table's hook: a table event, every spot of its key; the watches told the value whole
	function onTableChange(part: Key, id: Id) {
		inPlace(part, id)
		say(paths.event(first(part), id))
		if (watches.size === 0 && alls.length === 0) return
		const entry = table.get(part, id)
		const patch: Patch = entry?.value === undefined
			? { path: [] }
			: { path: [], value: entry.value }
		const facts = [{ part, id, patches: [patch], change: entry?.change, entry }]
		tellAll(facts)
		tellWatches(facts)
	}

	// what watchAll was given, in the order given
	let alls: ((fact: Fact) => void)[] = []
	function watchAll(fn: (fact: Fact) => void): () => void {
		alls = [...alls, fn]
		return () => void (alls = alls.filter((g) => g !== fn))
	}
	function tellAll(facts: readonly Fact[]) {
		if (alls.length === 0) return
		const told = alls
		for (const f of facts) for (const fn of told) fn(f)
	}

	// what a write changed: a fact for each entry with a latest op, at every key it is under
	function* eachEntryChange(changed: readonly Entry<unknown>[]): Generator<Fact> {
		for (const entry of changed) {
			const op = entry.change.op
			if (op === undefined) continue
			for (const [part, id] of table.who(entry)) {
				yield { part: part as Key, id, patches: op.patches, change: entry.change, entry }
			}
		}
	}

	// a write landed: the spots its patches mark said changed, in one call, by the run open; then
	// each watch told what landed at its node. a watch that writes commits in turn, in the same run
	function commit(changed: readonly Entry<unknown>[]) {
		const facts = [...eachEntryChange(changed)]
		const out: unknown[] = []
		for (const f of facts) out.push(...paths.mark(first(f.part), f.id, f.patches))
		say(out)
		tellAll(facts)
		tellWatches(facts)
	}

	// watches

	// a watch keeps the id its path finds now, and the ids of the folders on its route (the ones
	// whose children it looked in), as the view it was made on finds them (from: its root and
	// contributors). byId: the watches at an id; onRoute: the watches with an id on their route. both
	// move when a children entry on a route changes
	type Watch = {
		path: Path
		part?: Key
		at?: readonly Step[]
		fn: (fact: Fact) => void
		seq: number
		live: boolean
		id: Id | undefined
		route: Id[]
		from: View
	}
	const watches = new Set<Watch>()
	const byId = new Map<Id, Set<Watch>>()
	const onRoute = new Map<Id, Set<Watch>>()
	let seqs = 0

	function link(index: Map<Id, Set<Watch>>, id: Id, w: Watch) {
		let set = index.get(id)
		if (set === undefined) index.set(id, set = new Set())
		set.add(w)
	}
	function unlink(index: Map<Id, Set<Watch>>, id: Id, w: Watch) {
		const set = index.get(id)
		if (set === undefined) return
		set.delete(w)
		if (set.size === 0) index.delete(id)
	}

	// the watch finds its path again, from the table, untold; moves in the indexes
	function refind(w: Watch) {
		const { root, given, go, gone } = w.from
		if (w.id !== undefined) unlink(byId, w.id, w)
		for (const r of w.route) unlink(onRoute, r, w)
		const route: Id[] = []
		let at: Id | undefined = root
		if (given === undefined) {
			for (const name of w.path) {
				route.push(at)
				at = child(table.get("children", at), name)
				if (at === undefined) break
			}
		} else {
			// as get finds it, through the contributors, the reads told to no one
			record(() => {
				let here: Here = { id: root, path: [] }
				for (const name of w.path) {
					if (here.id !== level) route.push(here.id)
					const m = go(here, name)
					if (m === undefined) {
						at = undefined
						break
					}
					at = m.id
					here = { id: m.id, path: [...here.path!, name], gone: gone() }
				}
			}, new Set())
			if (at === level) at = undefined
		}
		w.id = at
		w.route = route
		if (at !== undefined) link(byId, at, w)
		for (const r of route) link(onRoute, r, w)
	}

	// fn told each fact landing at the node at path from the view's root, from now; gives back the stop
	function watchPath(
		from: View,
		path: Path,
		fn: (fact: Fact) => void,
		options: Watching = {},
	): () => void {
		const w: Watch = {
			path: [...path],
			part: options.part,
			at: options.at,
			fn,
			seq: seqs++,
			live: true,
			id: undefined,
			route: [],
			from,
		}
		watches.add(w)
		refind(w)
		return () => {
			if (!w.live) return
			w.live = false
			watches.delete(w)
			if (w.id !== undefined) unlink(byId, w.id, w)
			for (const r of w.route) unlink(onRoute, r, w)
		}
	}

	// each watch told the facts at its node, in the order the watches were made; a fact costs one get
	// in byId. a watch stopped on the way is not told. then each watch with a changed children entry
	// on its route finds its path again (with contributors given, any part but value: theirs)
	function tellWatches(facts: readonly Fact[]) {
		if (watches.size === 0 || facts.length === 0) return
		const hit = new Map<Watch, Fact[]>()
		for (const f of facts) {
			const set = byId.get(f.id)
			if (set === undefined) continue
			for (const w of set) {
				if (w.part !== undefined && f.part !== w.part) continue
				const list = hit.get(w)
				if (list === undefined) hit.set(w, [f])
				else list.push(f)
			}
		}
		if (hit.size) {
			const order = [...hit.keys()].sort((a, b) => a.seq - b.seq)
			for (const w of order) {
				for (const f of hit.get(w)!) {
					if (!w.live) break
					const patches = w.at ? f.patches.filter((p) => touches(p, w.at!)) : f.patches
					if (patches.length) w.fn(patches.length === f.patches.length ? f : { ...f, patches })
				}
			}
		}
		const moved = new Set<Watch>()
		for (const f of facts) {
			const set = onRoute.get(f.id)
			if (set === undefined) continue
			for (const w of set) {
				if (f.part === "children" || (w.from.given !== undefined && f.part !== "value")) {
					moved.add(w)
				}
			}
		}
		for (const w of moved) if (w.live) refind(w)
	}

	// what is at path in the value of the entry under (part, id), the read told. path: kept by
	// paths, never change it
	function readValue(part: Key, id: Id, path: readonly Step[] = []): unknown {
		tell(paths.spot(first(part), id, path))
		return at(table.get(part, id)?.value, path)
	}

	// the change of the entry under (part, id), the read told at its change spot: any write to the
	// entry reruns it. none there: undefined
	function readChange(part: Key, id: Id): ChangeHeader | undefined {
		tell(paths.change(first(part), id))
		return table.get(part, id)?.change
	}

	// which names there are in the value of the entry under (part, id), at path: the read told as a
	// read of names, not of what is under them. no map there: none
	function readKeys(part: Key, id: Id, path: readonly Step[] = [], ids = false): string[] {
		tell(paths.spot(first(part), id, path, true))
		const v = at(table.get(part, id)?.value, path)
		if (!isMap(v)) return []
		return ids ? Object.keys(v).filter((k) => isId(v[k])) : Object.keys(v)
	}

	// what contributors read through
	const reads: Reads = {
		read: readValue,
		keys: readKeys,
		track: (key) => into === undefined ? scheduler.track(key) : void into.add(key),
	}

	// a places from root, asked by its own contributors (none: children alone), sharing all of the above
	function view(root: Id, given?: readonly Contributor[]): Places {
		const asked = given ?? [children]

		// the contributors that said none at the latest go's step, with its here's gone
		let said = 0

		// the first answer at here + name, each contributor asked in order (but here's gone); none:
		// undefined. said: here's gone, and the contributors that said none
		function go(here: Here, name: string): Member | undefined {
			const gone = here.gone ?? 0
			let under = gone
			for (let i = 0; i < asked.length; i++) {
				const b = bit(i)
				if (gone & b) continue
				const id = asked[i].step(here, name, reads)
				if (id === none) under |= b
				else if (id !== undefined) {
					said = under
					return { name, id, from: asked[i].from }
				}
			}
			// might be fishy. TODO is this fishy?
			// no id anywhere, but a contributor has a level there (processes at /dev/clock, with no /dev
			// saved): the walk goes on through it as if it were a folder
			for (let i = 0; i < asked.length; i++) {
				if (under & bit(i)) continue
				const c = asked[i]
				if (c.level?.(here, name, reads)) {
					said = under
					return { name, id: level, from: c.from }
				}
			}
			said = under
		}

		const me: View = { root, given, go, gone: () => said }

		// the steps of a path from an id or a here (none given: the root), each a name and the id under
		// it, one at a time as they are taken. nothing under a name: the walk stops there. children
		// alone: each step the read of its name in the children of the id before. contributors given:
		// each asked in order (but the gone), the first answer taken, with its from; from an id alone
		// (not the root), the path is not known, so a contributor going by path has nothing. its
		// return: the here it got to, with the gone under it; stopped short: undefined
		function* walk(path: Path, from: Id | Here = root): Generator<Member, Here | undefined> {
			if (given === undefined) {
				let at = typeof from === "object" ? from.id : from
				for (const name of path) {
					tell(paths.spot(first("children"), at, [name]))
					const id = child(table.get("children", at), name)
					if (id === undefined) return undefined
					yield { name, id }
					at = id
				}
				const base = typeof from === "object" ? from.path : from === root ? [] : undefined
				return { id: at, path: base && (path.length ? [...base, ...path] : base) }
			}
			let here: Here = typeof from === "object"
				? from
				: from === root
				? { id: root, path: [] }
				: { id: from }
			for (const name of path) {
				const m = go(here, name)
				if (m === undefined) return undefined
				// taken before the yield: whoever reads it may walk again
				const gone = said
				yield m
				here = { id: m.id, path: here.path && [...here.path, name], gone }
			}
			return here
		}

		// every answer at here + name, in the contributors' order (but here's gone)
		function answers(here: Here, name: string): Answers {
			const gone = here.gone ?? 0
			let out: Answer[] = [], under = gone
			for (let i = 0; i < asked.length; i++) {
				const b = bit(i)
				if (gone & b) continue
				const id = asked[i].step(here, name, reads)
				if (id === none) under |= b
				else if (id !== undefined) out.push({ id, from: asked[i].from })
			}
			// none: a level there, if a contributor has one (go's, as the walk takes it)
			if (out.length === 0) {
				for (let i = 0; i < asked.length; i++) {
					if (under & bit(i)) continue
					const c = asked[i]
					if (c.level?.(here, name, reads)) {
						out = [{ id: level, from: c.from }]
						break
					}
				}
			}
			return Object.assign(out, { gone: under })
		}

		// the names under here, every contributor's (but here's gone), each name once (from the first
		// that gives it); when there are several contributors, in the order canonical CBOR gives a
		// map's keys (ermine/encoding)
		function names(here: Here): Names {
			const gone = here.gone ?? 0
			let under = gone
			const out: Named[] = []
			const seen = new Set<string>()
			for (let i = 0; i < asked.length; i++) {
				const b = bit(i)
				if (gone & b) continue
				const c = asked[i]
				const got = c.names(here, reads)
				if (got === none) {
					under |= b
					continue
				}
				for (const name of got) {
					if (seen.has(name)) continue
					seen.add(name)
					out.push({ name, from: c.from })
				}
			}
			if (asked.length > 1) out.sort((a, b) => keyOrder(a.name, b.name))
			return Object.assign(out, { gone: under })
		}

		return {
			root,
			contributors: given,
			view,
			onTableChange,
			release,
			describe,
			commit,
			eachEntryChange,
			watchPath: (path, fn, options) => watchPath(me, path, fn, options),
			watchAll,
			readValue,
			readKeys,
			readChange,
			walk,
			answers,
			names,
			record,
			hold,
		}
	}

	return view(setup.root, setup.contributors)
}

export type Places = {
	// where names start
	readonly root: Id

	// hooks, handed to the table and the scheduler once
	onTableChange: (part: Key, id: Id) => void
	release: (key: unknown) => void
	describe: (key: unknown) => Where | undefined

	// after a write: say it landed. eachEntryChange: what it landed, as facts (what commit and watch go by)
	commit: (changed: readonly Entry<unknown>[]) => void
	eachEntryChange: (changed: readonly Entry<unknown>[]) => Generator<Fact>
	// fn told each fact landing at the node at a path, as it lands; gives back the stop
	watchPath: (path: Path, fn: (fact: Fact) => void, options?: Watching) => () => void
	// fn told every fact, anywhere, as it lands (after the marks, before watchPath's); gives back
	// the stop
	watchAll: (fn: (fact: Fact) => void) => () => void

	// the contributors given; none: children alone
	readonly contributors: readonly Contributor[] | undefined
	// the same places from root, asked by contributors of its own (none: children alone): one set
	// of spots, holds and watches, one commit and one table hook with this one. its watches find
	// their path from its root
	view: (root: Id, contributors?: readonly Contributor[]) => Places

	// tracked reads
	readValue: (part: Key, id: Id, path?: readonly Step[]) => unknown
	readKeys: (part: Key, id: Id, path?: readonly Step[], ids?: boolean) => string[]
	readChange: (part: Key, id: Id) => ChangeHeader | undefined
	// its return: the here it got to (gone carried); stopped short: undefined
	walk: (path: Path, from?: Id | Here) => Generator<Member, Here | undefined>
	// every contributor's answer at one step (a level, with no id, as one answer with the id level, when none has an id); every contributor's names under a place, each once. both skip here's gone
	answers: (here: Here, name: string) => Answers
	names: (here: Here) => Names

	// for a cache: f's reads put into reads, told to no one; a hold on a spot taken or given back
	record: <T>(f: () => T, reads: Set<unknown>, fresh?: Set<unknown>) => T
	hold: (key: unknown, n: number) => number
}

// writing: a parent's children entry, given as it is, changed by update. each gives back the
// entries it changed, in order, for commit: their change has the patches that landed. refused: it
// throws, and nothing changes

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

// a name holding anything, an id or not: never written over
const taken = (children: Entry<unknown>, name: string) =>
	isMap(children.value) && Object.hasOwn(children.value, name)

// the patches that make sure the value is a map, first
const base = (children: Entry<unknown>): Patch[] =>
	isMap(children.value) ? [] : [{ path: [], value: {} }]

function write(children: Entry<unknown>, patches: Patch[], header: ChangeHeader) {
	update(children, patches, header)
	return [children]
}

// id placed under name, a name holding nothing: one change
export function place(
	children: Entry<unknown>,
	name: string,
	id: Id,
	header: ChangeHeader,
): Entry<unknown>[] {
	if (bad(name)) throw new PlacesError("not-a-name", name)
	if (taken(children, name)) throw new PlacesError("already-there", name)
	return write(children, [...base(children), { path: [name], value: id }], header)
}

// the id under name taken out, and the name with it: one change
export function unplace(
	children: Entry<unknown>,
	name: string,
	header: ChangeHeader,
): Entry<unknown>[] {
	if (child(children, name) === undefined) throw new PlacesError("nothing-there", name)
	return write(children, [{ path: [name] }], header)
}

// the id under name moved to the name to: one change; to the same name: none
export function rename(
	children: Entry<unknown>,
	name: string,
	to: string,
	header: ChangeHeader,
): Entry<unknown>[] {
	if (bad(to)) throw new PlacesError("not-a-name", to)
	if (child(children, name) === undefined) throw new PlacesError("nothing-there", name)
	if (to === name) return []
	if (taken(children, to)) throw new PlacesError("already-there", to)
	return write(children, [{ path: [to], move: { path: [name] } }], header)
}

// the id under a name in one children entry put under a name in another: the same entry, one
// change (to the same name: none); two entries, a change on each, the one it goes into first
export function move(
	[from, name]: readonly [Entry<unknown>, string],
	[into, to]: readonly [Entry<unknown>, string],
	header: ChangeHeader,
): Entry<unknown>[] {
	if (bad(to)) throw new PlacesError("not-a-name", to)
	const id = child(from, name)
	if (id === undefined) throw new PlacesError("nothing-there", name)
	if (from === into) {
		if (name === to) return []
		if (taken(from, to)) throw new PlacesError("already-there", to)
		return write(from, [{ path: [to], move: { path: [name] } }], header)
	}
	return [...place(into, to, id, header), ...unplace(from, name, header)]
}
