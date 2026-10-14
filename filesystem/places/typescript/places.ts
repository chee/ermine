// places: what makes the filesystem real. it walks names from a root through the children table,
// reads values, and connects all of it to tracked paths and the scheduler, set up once by whoever
// makes them. it makes none of them; writes are plain functions on a children entry, and their
// changes are said written here.
//
//   createTable((part, id) => places.onTableChange(part, id))
//   createScheduler({ forget: (key) => places.release(key) })
//   const places = createPlaces({ root, table, paths, scheduler })
//   places.markChanged(place(table.get("children", id)!, name, entry, createChangeHeader(scheduler)))
//
// a children entry's value maps each name to one id; a name is any string but "", ".", ".." and
// "/". a path is names from the root, each looked up as it is (path.ts turns steps with dots into
// these). a box is a places made with another root, by whoever boxes. get, lookup, list and members
// are built on walk and keys, in lib.ts; a write's header, from the scope open, in header.ts
//
// a read is told to the scheduler as a spot (paths'), so a run reading tracks it; after an await
// it counts for nothing. a walk reads each name in the children of the id before it. a write says
// changed the spots its patches mark, at every key the entry is under; a table event the spots of
// its key. both by the writer open (the scheduler's current().writer), none: from outside
//
// paths keys a spot by two parts: the part goes into one object per part, made once and kept: the
// same always, so the key is the same by identity, and the id is the second. a spot nobody reads
// any more is let go: the scheduler's forget calls places' release with each key it stops tracking. a spot
// read outside a run is tracked by none, so never let go
//
// describe(key) names a key told to the scheduler: one of this places' spots, held, is where it reads,
// so a run's reads (the scheduler's ends moment) can be named as places in the graph. anything
// else, or a spot let go: undefined
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Key as Step, Patch } from "@ermine/op/apply"
import type { Scheduler } from "@ermine/scheduler"
import type { createPaths, Spot } from "@ermine/scheduler/paths"
import type { Id, Key, Table } from "@ermine/graph/table"

export type { Id }

export type Paths = ReturnType<typeof createPaths<unknown>>

// names from the root, each looked up as it is
export type Path = readonly string[]

export type Setup = {
	// where names start
	root: Id
	table: Pick<Table, "get" | "who">
	paths: Paths
	scheduler: Pick<Scheduler, "read" | "changed" | "current">
}

// where a spot reads: the entry under (part, id), and the path in its value (kept by paths, never
// change it); null: the change spot, reads of the change itself
export type Where = {
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[] | null
}

// a name in a children entry, and the id under it
export type Member = { readonly name: string; readonly id: Id }

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

// the id under name in a children entry; none, or something that is not an id: undefined
function child(children: Entry<unknown> | undefined, name: string): Id | undefined {
	const v = children?.value
	if (!isMap(v) || !Object.hasOwn(v, name)) return undefined
	const id = v[name]
	return isId(id) ? id : undefined
}

export function createPlaces(setup: Setup): Places {
	const { root, table, paths, scheduler } = setup

	const firsts = new Map<Key, { part: Key }>()
	// the one key object of a part
	function first(part: Key) {
		let p = firsts.get(part)
		if (p === undefined) firsts.set(part, p = { part })
		return p
	}

	// this places' spots: their owner, so forget knows them
	const mine = {}
	function tell(s: Spot<unknown>) {
		s.owner = mine
		scheduler.read(s)
	}

	const held = (key: unknown): key is Spot<unknown> =>
		typeof key === "object" && key !== null && (key as Spot<unknown>).owner === mine

	// a key the scheduler stopped tracking: one of this places' spots is released, and is not
	// this places' any more
	function release(key: unknown) {
		if (!held(key)) return
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
		if (spots.length) scheduler.changed(spots, scheduler.current()?.writer)
	}

	// the table's hook: a table event, every spot of its key
	const onTableChange = (part: Key, id: Id) => say(paths.event(first(part), id))

	// what a write changed: the spots each entry's latest patches mark, at every key it is under
	function markChanged(changed: readonly Entry<unknown>[]) {
		const out: unknown[] = []
		for (const entry of changed) {
			const op = entry.change.op
			if (op === undefined) continue
			for (const [part, id] of table.who(entry)) {
				out.push(...paths.mark(first(part as Key), id, op.patches))
			}
		}
		say(out)
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
	function readKeys(part: Key, id: Id, path: readonly Step[] = []): string[] {
		tell(paths.spot(first(part), id, path, true))
		const v = at(table.get(part, id)?.value, path)
		return isMap(v) ? Object.keys(v) : []
	}

	// the steps of a path from an id (none given: the root), each a name and the id under it, one
	// at a time as they are taken, each the read of its name in the children of the id before.
	// nothing under a name: the walk stops there
	function* walk(path: Path, from: Id = root): Generator<Member> {
		let at = from
		for (const name of path) {
			tell(paths.spot(first("children"), at, [name]))
			const id = child(table.get("children", at), name)
			if (id === undefined) return
			yield { name, id }
			at = id
		}
	}

	return {
		root,
		onTableChange,
		release,
		describe,
		markChanged,
		readValue,
		readKeys,
		readChange,
		walk,
	}
}

export type Places = {
	// where names start
	readonly root: Id

	// hooks, handed to the table and the scheduler once
	onTableChange: (part: Key, id: Id) => void
	release: (key: unknown) => void
	describe: (key: unknown) => Where | undefined

	// after a write
	markChanged: (changed: readonly Entry<unknown>[]) => void

	// tracked reads
	readValue: (part: Key, id: Id, path?: readonly Step[]) => unknown
	readKeys: (part: Key, id: Id, path?: readonly Step[]) => string[]
	readChange: (part: Key, id: Id) => ChangeHeader | undefined
	walk: (path: Path, from?: Id) => Generator<Member>
}

// writing: a parent's children entry, given as it is, changed by update. each gives back the
// entries it changed, in order, for markChanged: their change has the patches that landed. refused: it
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
