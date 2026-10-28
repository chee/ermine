// unread: an entry's writes change in place what its own earlier writes copied, until someone
// reads it. a write copies what it changes that it doesn't own (along its paths only, as op's
// copy-on-write does) and owns the copies; the next write changes those in place (op's apply with
// cow: false). a read lets go of all of it: what a reader holds is never changed
// under it, and the next write copies again. so a burst of writes with no read between costs one
// copy, and a write between reads costs what copy-on-write does
//
//   const unread = createUnread()
//   keeping(scheduler, unread, (key) => {   // what a computation keeps past its run is held
//     const where = places.describe(key)     // what a read key gave the run: with places, the
//     return where?.path ? at(table.get(where.part, where.id)?.value, where.path) : undefined
//   })                                       // value at its spot's path
//   unread.update(entry, patches, header)    // in place of node's update
//
// held: what a computation keeps past its run (its result, given to set or to be acted on: the
// scheduler says it at the run's end) lets go of every owned container in it, with all under it
// (kept): a value read and dropped inside a run is never held, so reads cost nothing. a plain
// result holds nothing. the walk stops at what the run was handed (its reads, each a value the
// host names: handed), letting go of what is owned under it, and goes through what the run made.
// what else holds a value past now says so: kept for a value, read for all of an entry (an
// overlay sharing an entry's value), or reading, a table whose gets are reads
//
// owned: only copies made here, from the root down along the paths written (a container's parent
// is owned when it is), and the list a span move takes out (op gives it to owned as it lands).
// never a patch's value (op puts it in as given: the caller's; an owned container in one, of any
// entry, is let go first: a walk over every container in each patch's value), nor what a write
// takes out (its undo holds it): the next write through those copies them. a write that throws
// changes nothing, which container is where and what is owned too: what it lets go of first is
// put back
import type { ChangeHeader, Entry } from "@ermine/core/node/entry"
import apply, { type Patch } from "@ermine/core/changeable/apply"
import type { Scheduler } from "@ermine/core/scheduler"
import type { Id, Table } from "@ermine/core/table"
import { isPojo, isTyped } from "@ermine/core/util/kinds"
import { keep } from "./unread_conformance_hook.ts"

export type Unread = {
	// node's update (op's patches, the change with its op), in place where this owns
	update: <V>(entry: Entry<V>, patches: Iterable<Patch>, change: ChangeHeader) => void
	// what readers hold now: nothing of the entry's is owned, the next write copies
	read: (entry: Entry<unknown>) => void
	// a value held past now (a computation's result): every owned container in it let go, with
	// all under it. walked (lists, maps, typed arrays): one made by a run may hold what a read
	// gave. handed: what the run was given; at one, what is owned under it is let go, no deeper
	kept: (value: unknown, handed?: ReadonlySet<unknown>) => void
}

const container = (v: unknown): v is object => Array.isArray(v) || isPojo(v) || isTyped(v)

export function createUnread(): Unread {
	// an entry → its token: made at its first write since it was last read
	const owns = new WeakMap<Entry<unknown>, object>()
	// a copy → the token it was made under: owned while that is its entry's token. one record
	// per copy; a read gives the entry a new token, letting go of all of it at once
	const owner = new WeakMap<object, object>()
	// in a write, before it lands: what it let go of (each copy, then its token), put back if
	// it throws, so ownership changes only once the write has
	const gone: object[] = []
	let noting = false

	// v owned no longer (noting: noted); whether it was
	const out = (v: object): boolean => {
		if (!noting) return owner.delete(v)
		const t = owner.get(v)
		if (t === undefined) return false
		gone.push(v, t)
		return owner.delete(v)
	}

	// apply's owned: a container a write changes, owned, or its copy, owned from now
	const take = (mine: object) => (v: object): object => {
		if (owner.get(v) === mine) return v
		const c = Array.isArray(v) || isTyped(v) ? v.slice() : { ...v }
		owner.set(c, mine)
		return c
	}

	// what a write took out (its undo holds it) no longer owned: owned containers are connected
	// from the root, so only those are walked, under the top (a span's undo: a list made for it)
	function free(v: unknown, mine: object, top = true) {
		if (!container(v)) return
		const was = owner.get(v) === mine
		if (was) owner.delete(v)
		if (!was && !top || isTyped(v)) return
		for (const x of Array.isArray(v) ? v : Object.values(v)) free(x, mine, false)
	}

	function update<V>(entry: Entry<V>, patches: Iterable<Patch>, change: ChangeHeader) {
		const ps: readonly Patch[] = Array.isArray(patches) ? patches : [...patches]
		// what is let go of before the apply is noted, and put back if it throws
		const was = owns.get(entry)
		noting = true
		const undo: Patch[] = []
		let after: unknown
		try {
			// a run past its body's return (keeping: its set) may hand on what it read: let go of
			// first
			const ws = wired.get(unread)
			if (ws !== undefined) { for (const g of ws) if (g.returned.size) before(g, entry) }
			// what a patch puts is the caller's from now: nothing in it owned
			for (const p of ps) {
				if (p !== null && typeof p === "object" && "value" in p && container(p.value)) {
					kept(p.value)
				}
			}
			let mine = owns.get(entry)
			if (mine === undefined) owns.set(entry, mine = {})
			// one apply, in place where owned: what a patch changes that is not owned yet is copied
			// as it lands, in the tree the patches before it left (one may move a subtree, or put a
			// value in, that the next writes under). a throw changes nothing, what is owned too
			after = apply(entry.value, ps, { undo, cow: false, owned: take(mine) })
		} catch (e) {
			for (let i = 0; i < gone.length; i += 2) owner.set(gone[i], gone[i + 1])
			if (was === undefined) owns.delete(entry)
			else owns.set(entry, was)
			throw e
		} finally {
			noting = false
			gone.length = 0
		}
		const mine = owns.get(entry)!
		// what the runs' reads gave them is let go of: not again
		const ws = wired.get(unread)
		if (ws !== undefined) { for (const g of ws) if (g.returned.size) given(g) }
		for (const u of undo) if ("value" in u) free(u.value, mine)
		if (after === undefined) delete entry.value
		else entry.value = after as V
		entry.change = { ...change, op: { patches: ps, undo } }
	}

	// what is owned under v let go, v too: owned copies are connected from the root, so only those
	// are walked
	function drop(v: unknown) {
		if (!container(v) || !out(v) || isTyped(v)) return
		if (Array.isArray(v)) { for (const x of v) drop(x) }
		else for (const k in v) drop((v as Record<string, unknown>)[k])
	}

	// every container in v let go; at one handed, what is owned under it, no deeper. what was
	// walked is kept from the first step into a container (a value a run made may share, or
	// loop), so a plain or flat one makes nothing
	function kept(v: unknown, handed?: ReadonlySet<unknown>, seen?: Set<object>) {
		if (!container(v)) return
		if (handed?.has(v)) return drop(v)
		if (seen !== undefined) {
			if (seen.has(v)) return
			seen.add(v)
		}
		out(v)
		if (isTyped(v)) return
		if (Array.isArray(v)) {
			for (const x of v) if (container(x)) kept(x, handed, seen ??= new Set([v]))
		} else {
			for (const k in v) {
				const x = (v as Record<string, unknown>)[k]
				if (container(x)) kept(x, handed, seen ??= new Set([v]))
			}
		}
	}

	// a write while runs past their body's return go on: what their reads gave them let go; none
	// known (no handed), all of the entry written
	function before(g: Going, entry: Entry<unknown>) {
		if (!g.handed) return void owns.delete(entry)
		for (const c of g.returned) for (const x of g.runs.get(c)!) drop(x)
	}
	// once the write landed: what their reads gave them, let go of, is not walked again
	function given(g: Going) {
		if (g.handed) { for (const c of g.returned) g.runs.get(c)!.length = 0 }
	}

	const unread: Unread = {
		update,
		read: (entry) => void owns.delete(entry),
		kept: (value, handed) => kept(value, handed),
	}
	keep(unread, (entry) => owns.get(entry))
	return unread
}

// a scheduler's runs going on, as keeping sees them: each run → the values its reads gave it
// (handed: none known, an empty list); returned, those whose body returned (in their set)
type Going = { runs: Map<unknown, unknown[]>; returned: Set<unknown>; handed: boolean }
// an unread → its wirings: its writes read them
const wired = /* @__PURE__ */ new WeakMap<object, Going[]>()

// a scheduler's run ends wired to unread: what a computation keeps past its run is held (kept).
// a plain result holds nothing. handed: the value a key the run tracked gave it (with places,
// the value at its spot's path), so the walk stops there; none: results walked whole. a write
// made in a run's body (before onRunReturn) is the run's own: in place, as any, so what the run
// read can change under it by its own writes. one made after its body returned, before its end
// (its set, given the result): what the run's reads gave it let go first (no handed: all of the
// entry written), so what the run keeps never changes after it returned. a run awaiting goes on
// no longer: its landing's set is not seen. gives back the stop
export function keeping(
	scheduler: Pick<Scheduler, "onRunStart" | "onRunReturn" | "onRunEnd" | "onTrack">,
	unread: Pick<Unread, "kept">,
	handed?: (key: unknown) => unknown,
): () => void {
	const g: Going = { runs: new Map(), returned: new Set(), handed: handed !== undefined }
	let ws = wired.get(unread)
	if (ws === undefined) wired.set(unread, ws = [])
	ws.push(g)
	const start = scheduler.onRunStart((c) => (g.runs.set(c, []), void g.returned.delete(c)))
	const returns = scheduler.onRunReturn((c) => void (g.runs.has(c) && g.returned.add(c)))
	const track = handed === undefined ? () => {} : scheduler.onTrack((key, run) => {
		const given = g.runs.get(run.computer)
		if (given === undefined) return
		const x = handed(key)
		if (container(x)) given.push(x)
	})
	const end = scheduler.onRunEnd((c, _n, _ended, reads, more) => {
		g.runs.delete(c)
		g.returned.delete(c)
		if (!("kept" in more) || !container(more.kept)) return
		if (handed === undefined || reads.length === 0) return unread.kept(more.kept)
		const given = new Set<unknown>()
		for (const key of reads) {
			const x = handed(key)
			if (container(x)) given.add(x)
		}
		unread.kept(more.kept, given)
	})
	return () => {
		const at = ws.indexOf(g)
		if (at < 0) return
		start(), returns(), track(), end()
		ws.splice(at, 1)
	}
}

// a table whose gets are reads: each entry a get gives is read (unread's read) first. give it to
// whatever hands values out (places, an overlay); write through the table itself
export function reading<T extends Pick<Table, "get" | "who">>(table: T, unread: Unread): T {
	function get(a: unknown, b?: unknown): unknown {
		if (arguments.length === 1) {
			const all = (table.get as (id: Id) => [string, Entry<unknown>][])(a as Id)
			for (const [, e] of all) unread.read(e)
			return all
		}
		const got = (table.get as (a: unknown, b: unknown) => unknown)(a, b)
		// (part, id): an entry, read; (part, entry): ids
		if (typeof b === "string" || typeof b === "symbol") {
			if (got !== undefined) unread.read(got as Entry<unknown>)
		}
		return got
	}
	return { ...table, get: get as Table["get"] }
}
