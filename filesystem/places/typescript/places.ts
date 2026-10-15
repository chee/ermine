// places: what makes the filesystem real. it walks names from a root through the children table,
// reads values, and connects all of it to tracked paths and the scheduler, set up once by whoever
// makes them. it makes none of them; writes are plain functions on a children entry, and their
// changes are said written here.
//
//   createTable((part, id) => places.onTableChange(part, id))
//   scheduler.onTrackingEnd((key) => places.release(key))
//   const places = createPlaces({ root, table, paths, scheduler })
//   places.commit(place(table.get("children", id)!, name, entry, createChangeHeader(scheduler)))
//
// a children entry's value maps each name to one id; a name is any string but "", ".", ".." and
// "/". a path is names from the root, each looked up as it is (path.ts turns steps with dots into
// these). a box is a places made with another root, by whoever boxes. get, lookup, list and members
// are built on walk and keys, in lib.ts; a write's header, from the scope open, in header.ts
//
// a read is told to the scheduler as a spot (paths'), so a run reading tracks it; after an await
// it counts for nothing. a walk reads each name in the children of the id before it. a write says
// changed the spots its patches mark, at every key the entry is under; a table event the spots of
// its key. both by the run open (the scheduler's getRun()), none: from outside
//
// paths keys a spot by two parts: the part goes into one object per part, made once and kept: the
// same always, so the key is the same by identity, and the id is the second. a spot nobody reads
// any more is let go: the scheduler's onTrackingEnd calls places' release with each key it stops tracking. a spot
// read outside a run is tracked by none, so never let go
//
// describe(key) names a key told to the scheduler: one of this places' spots, held, is where it reads,
// so a run's reads (the scheduler's ends moment) can be named as places in the graph. anything
// else, or a spot let go: undefined
//
// contributors (contributors.org): what answers one step of a walk. children is one; a places can
// be given others, asked in order at each step: the first answer is where the walk goes (get), all
// of them are what is there (lib.ts' entries), and a folder's names are every contributor's, each
// name once (list, members). none given: children alone, and the walk, list and members read just
// as they always have. a contributor reads only through the reads it is handed
//
//   createPlaces({ root, table, paths, scheduler, contributors: [another, children] })
//
// a cache (cache.ts) works answers out outside any run: record(f, into) puts the reads f makes into
// a set in place of the scheduler, and hold keeps a spot past release while the cache reads it
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Key as Step, Patch } from "@ermine/op/apply"
import type { Scheduler } from "@ermine/scheduler"
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

// where a walk has got to: the id it is at, and its path (the names from the root to it). no path:
// a walk from an id alone, where it is from the root not known
export type Here = { readonly id: Id; readonly path?: Path }

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
	// the id it has at here + name; none: undefined
	step(here: Here, name: string, reads: Reads): Id | undefined
	// the names it has directly under here, in its order: each one step answers
	names(here: Here, reads: Reads): string[]
}

// an answer at a path, and the contributor that gave it
export type Answer = { readonly id: Id; readonly from: string }

// a name at a path, and the first contributor that gives it
export type Named = { readonly name: string; readonly from: string }

// where a spot reads: the entry under (part, id), and the path in its value (kept by paths, never
// change it); null: the change spot, reads of the change itself
export type Where = {
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[] | null
}

// a name in a children entry, and the id under it. from: the contributor that gave it (none: a
// places given no contributors, children alone)
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

// the children table: goes by the id, never the path. the default contributor
export const children: Contributor = {
	from: "children",
	step: ({ id }, name, r) => asId(r.read("children", id, [name])),
	names: ({ id }, r) => r.keys("children", id),
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

export function createPlaces(setup: Setup): Places {
	const { root, table, paths, scheduler } = setup
	// the contributors given; none: children alone, walked as it always was
	const given = setup.contributors
	const asked = given ?? [children]

	const firsts = new Map<Key, { part: Key }>()
	// the one key object of a part
	function first(part: Key) {
		let p = firsts.get(part)
		if (p === undefined) firsts.set(part, p = { part })
		return p
	}

	// this places' spots: their owner, so forget knows them
	const mine = {}
	// where reads go while record runs; none: the scheduler
	let into: Set<unknown> | undefined
	function tell(s: Spot<unknown>) {
		s.owner = mine
		if (into === undefined) scheduler.track(s)
		else into.add(s)
	}

	// f, with every read it makes (a spot, or a contributor's track) put into reads and told to no
	// one: what a cache works out outside any run. inside another record, apart from it
	function record<T>(f: () => T, reads: Set<unknown>): T {
		const was = into
		into = reads
		try {
			return f()
		} finally {
			into = was
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
		return { part, id: key.id as Id, path: key.path }
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
		if (watches.size === 0) return
		const entry = table.get(part, id)
		const patch: Patch = entry?.value === undefined
			? { path: [] }
			: { path: [], value: entry.value }
		tellWatches([{ part, id, patches: [patch], change: entry?.change, entry }])
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
		tellWatches(facts)
	}

	// watches

	// a watch keeps the id its path finds now, and the ids of the folders on its route (the ones
	// whose children it looked in). byId: the watches at an id; onRoute: the watches with an id on
	// their route. both move when a children entry on a route changes
	type Watch = {
		path: Path
		part?: Key
		at?: readonly Step[]
		fn: (fact: Fact) => void
		seq: number
		live: boolean
		id: Id | undefined
		route: Id[]
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
		if (w.id !== undefined) unlink(byId, w.id, w)
		for (const r of w.route) unlink(onRoute, r, w)
		const route: Id[] = []
		let at: Id | undefined = root
		for (const name of w.path) {
			route.push(at)
			at = child(table.get("children", at), name)
			if (at === undefined) break
		}
		w.id = at
		w.route = route
		if (at !== undefined) link(byId, at, w)
		for (const r of route) link(onRoute, r, w)
	}

	// fn told each fact landing at the node at path, from now; gives back the stop
	function watchPath(path: Path, fn: (fact: Fact) => void, options: Watching = {}): () => void {
		const w: Watch = {
			path: [...path],
			part: options.part,
			at: options.at,
			fn,
			seq: seqs++,
			live: true,
			id: undefined,
			route: [],
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
	// on its route finds its path again
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
			if (f.part !== "children") continue
			const set = onRoute.get(f.id)
			if (set !== undefined) { for (const w of set) moved.add(w) }
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

	// the first answer at here + name, each contributor asked in order; none: undefined
	function go(here: Here, name: string): Member | undefined {
		for (const c of asked) {
			const id = c.step(here, name, reads)
			if (id !== undefined) return { name, id, from: c.from }
		}
	}

	// the steps of a path from an id or a here (none given: the root), each a name and the id under
	// it, one at a time as they are taken. nothing under a name: the walk stops there. children
	// alone: each step the read of its name in the children of the id before. contributors given:
	// each asked in order, the first answer taken, with its from; from an id alone (not the root),
	// the path is not known, so a contributor going by path has nothing
	function* walk(path: Path, from: Id | Here = root): Generator<Member> {
		if (given === undefined) {
			let at = typeof from === "object" ? from.id : from
			for (const name of path) {
				tell(paths.spot(first("children"), at, [name]))
				const id = child(table.get("children", at), name)
				if (id === undefined) return
				yield { name, id }
				at = id
			}
			return
		}
		let here: Here = typeof from === "object"
			? from
			: from === root
			? { id: root, path: [] }
			: { id: from }
		for (const name of path) {
			const m = go(here, name)
			if (m === undefined) return
			yield m
			here = { id: m.id, path: here.path && [...here.path, name] }
		}
	}

	// every answer at here + name, in the contributors' order
	function answers(here: Here, name: string): Answer[] {
		const out: Answer[] = []
		for (const c of asked) {
			const id = c.step(here, name, reads)
			if (id !== undefined) out.push({ id, from: c.from })
		}
		return out
	}

	// the names under here, every contributor's in order, each name once: from the first that
	// gives it
	function names(here: Here): Named[] {
		const out: Named[] = []
		const seen = new Set<string>()
		for (const c of asked) {
			for (const name of c.names(here, reads)) {
				if (seen.has(name)) continue
				seen.add(name)
				out.push({ name, from: c.from })
			}
		}
		return out
	}

	return {
		root,
		contributors: given,
		onTableChange,
		release,
		describe,
		commit,
		eachEntryChange,
		watchPath,
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

	// the contributors given; none: children alone
	readonly contributors: readonly Contributor[] | undefined

	// tracked reads
	readValue: (part: Key, id: Id, path?: readonly Step[]) => unknown
	readKeys: (part: Key, id: Id, path?: readonly Step[], ids?: boolean) => string[]
	readChange: (part: Key, id: Id) => ChangeHeader | undefined
	walk: (path: Path, from?: Id | Here) => Generator<Member>
	// every contributor's answer at one step; every contributor's names under a place, each once
	answers: (here: Here, name: string) => Answer[]
	names: (here: Here) => Named[]

	// for a cache: f's reads put into reads, told to no one; a hold on a spot taken or given back
	record: <T>(f: () => T, reads: Set<unknown>) => T
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
