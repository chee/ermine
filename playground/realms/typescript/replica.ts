// a partial replica: a table filled lazily from somewhere else (a realm's, from its page). the hook
// that tells "not loaded yet" from "nothing there": at an id that was pointed to (under a name in a
// children entry, a leaf in a process trie: what came from the page) and not loaded yet, get gives
// a stand-in entry, its change none, whose value, read, tracks the id's load key and throws the
// scheduler's PENDING, asking for the id once. so a read of the value (places' readValue, a walk, a
// write's update, a recipe's draft) is pending, and a look at whether something is there or at its
// change is not (run records name a read of it: no change). places tells its spot before it reads
// the value, so a run reading it ends pending and runs again as it lands (loaded marks the key:
// the parts with nothing there too). every part of an id at once (get(id)): PENDING. an id never
// pointed to (one made here, a memo's node) is the table's as it is: nothing there is nothing there.
// open: an id met only inside a value, never under a name, is never pointed to, so it reads
// as nothing there
//
//   const r = createReplica({ scheduler, want: (id) => port.postMessage({ t: "load", id }) })
//   createPlaces({ root, table: r.table, ... })   // r.raw: the table under it, no hook
//   r.point(root); r.loaded(root)
//
// bad: a part that won't cross: its stand-in's value, read, throws a plain Error saying why
import { PENDING, type Scheduler } from "@ermine/scheduler"
import { createTable, type Event, type Id, type Key, type Table } from "@ermine/table"

type State = "pointed" | "loading" | "loaded"

export type Replica = {
	// the hooked table: for places and the api
	table: Table
	// the table under it: what lands is put here, no hook asked
	raw: Table
	// ids pointed to: not loaded, a get there pending. an id with a state already: as it is
	point: (ids: Iterable<Id>) => void
	// an id's entries landed (put in raw first): its readers marked
	loaded: (id: Id) => void
	// a part that won't cross; none: it will again
	bad: (part: Key, id: Id, why?: string) => void
	// pointed to or loading
	waiting: (id: Id) => boolean
}

export function createReplica(setup: {
	scheduler: Pick<Scheduler, "track" | "mark">
	want: (id: Id) => void
	event?: Event
}): Replica {
	const { scheduler } = setup
	const raw = createTable(setup.event)
	const states = new Map<Id, State>()
	// the key a pending get tracks, by id: a plain object (a run's record names it as it is)
	const keys = new Map<Id, { loading: Id }>()
	const bads = new Map<Id, Map<Key, string>>()

	function check(id: Id) {
		const state = states.get(id)
		if (state !== "pointed" && state !== "loading") return
		let key = keys.get(id)
		if (key === undefined) keys.set(id, key = { loading: id })
		scheduler.track(key)
		if (state === "pointed") {
			states.set(id, "loading")
			setup.want(id)
		}
		throw PENDING
	}

	// an entry standing in for one not here: its value, read, throws (landed since: the one there)
	const standIn = (f: () => unknown) => ({
		get value(): unknown {
			return f()
		},
		change: undefined,
	})

	function get(a: Key | Id, b?: unknown): unknown {
		if (arguments.length === 1) {
			check(a as Id)
			return raw.get(a as Id)
		}
		if (typeof b === "object") return raw.get(a as Key, b as never)
		const why = bads.get(b as Id)?.get(a as Key)
		if (why !== undefined) {
			return standIn(() => {
				throw new Error(`won't cross: ${why}`)
			})
		}
		const state = states.get(b as Id)
		if (state === "pointed" || state === "loading") {
			return standIn(() => {
				check(b as Id)
				return raw.get(a as Key, b as Id)?.value
			})
		}
		return raw.get(a as Key, b as Id)
	}

	const table = { ...raw, get } as Table

	return {
		table,
		raw,
		point(ids) {
			for (const id of ids) if (!states.has(id)) states.set(id, "pointed")
		},
		loaded(id) {
			states.set(id, "loaded")
			const key = keys.get(id)
			if (key === undefined) return
			keys.delete(id)
			scheduler.mark([key])
		},
		bad(part, id, why) {
			let parts = bads.get(id)
			if (why === undefined) {
				parts?.delete(part)
				if (parts?.size === 0) bads.delete(id)
				return
			}
			if (parts === undefined) bads.set(id, parts = new Map())
			parts.set(part, why)
		},
		waiting: (id) => {
			const state = states.get(id)
			return state === "pointed" || state === "loading"
		},
	}
}
