// sessions: one world opened on an install's root: a tab, a worker, one run. fresh each start, so
// two tabs never stand for each other and a restart is a new session. a session is here at a node
// while it beats there: its entry in the node's "online" part, { [session]: { install, until } },
// each written as a patch at its own key, so two sessions' beats never write over each other.
// online(node) is the entries whose until is still ahead; a sweep takes the rest out, so whoever
// read them is told. online is for now only: nothing here saves it, and a host's save should leave
// the part out
//
//   const session = startSession(install)        // { id: "ermine:0010…", install: install.id }
//   beat(world, session, den, now + 10_000)      // again before until, on the host's timer
//   online(world, den, now)                      // [{ session, install, until }], tracked
//   sweep(world, den, now)                       // the host's, on its timer
//   leave(world, session, den)                   // at the session's end
//
// what a beat says is only that the session is here, and its install: nothing here checks it (who
// carried it is the carrier's to check)
import { fresh, text } from "@ermine/ids"
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import type { Id, Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Table } from "@ermine/table"

declare module "@ermine/table" {
	interface Tables {
		online: Record<string, Beat>
	}
}

export const ONLINE = "online"

export type Session = { readonly id: string; readonly install: string }
// a session's entry at a node; until: ms, the host's clock
export type Beat = { readonly install: string; readonly until: number }
export type Here = Beat & { readonly session: string }

export type World = {
	table: Table
	places: Pick<Places, "commit" | "readValue">
	scheduler: Pick<Scheduler, "getCurrentScope" | "getRun" | "runWithScope">
	// the scope beats are written in (their header's actor)
	scope: Scope
}

export function startSession(install: { readonly id: string }): Session {
	return { id: text(fresh())!, install: install.id }
}

// the session's entry at node, made or renewed
export function beat(w: World, session: Session, node: Id, until: number) {
	const entry: Beat = { install: session.install, until }
	write(w, (header) => upsert(w.table, ONLINE, node, [session.id], entry, header))
}

// the session's entry at node, out
export function leave(w: World, session: Session, node: Id) {
	remove(w, node, [session.id])
}

// the sessions here at node now, in no order (key order is not part of a value). tracked
export function online(w: World, node: Id, now: number): Here[] {
	const all = w.places.readValue(ONLINE, node)
	if (!isMap(all)) return []
	const here: Here[] = []
	for (const [session, b] of Object.entries(all)) {
		if (isBeat(b) && b.until > now) here.push({ session, install: b.install, until: b.until })
	}
	return here
}

// every entry at node whose until is not ahead of now, out; and any that is no beat
export function sweep(w: World, node: Id, now: number) {
	const all = w.table.get(ONLINE, node)?.value
	if (!isMap(all)) return
	remove(w, node, Object.keys(all).filter((k) => !isBeat(all[k]) || all[k].until <= now))
}

function remove(w: World, node: Id, sessions: string[]) {
	const there = w.table.get(ONLINE, node)
	if (there === undefined || !isMap(there.value)) return
	const value = there.value
	const gone = sessions.filter((s) => Object.hasOwn(value, s))
	if (gone.length === 0) return
	const patches = gone.map((s): Patch => ({ path: [s] }))
	write(w, (header) => {
		update(there, patches, header)
		return [there]
	})
}

// a write made with the world's scope open: the entries f changed, committed
const write = (w: World, f: (header: ChangeHeader) => readonly Entry<unknown>[]) =>
	w.scheduler.runWithScope(w.scope, () => w.places.commit(f(createChangeHeader(w.scheduler))))

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

const isBeat = (v: unknown): v is Beat =>
	isMap(v) && typeof v.install === "string" && typeof v.until === "number"
