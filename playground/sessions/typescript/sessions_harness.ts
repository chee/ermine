// sessions (sessions.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. one world for the run (a table, places, a scheduler, a root scope the beats are
// written in). sessions are named in requests and answers by the name they were started with
//
// { op: "start", name, install }      -> { kind, differs }   startSession({ id: install })
//    kind: the session id's (ids' kind); differs: from every session started before it
// { op: "beat", session, node, until } -> {}
// { op: "leave", session, node }      -> {}
// { op: "sweep", node, now }          -> {}
// { op: "online", node, now }         -> { here }   [{ session, install, until }], by name
// { op: "entry", node }               -> { value }   the online entry as stored, by session name;
//    null: none
// { op: "watch", node, now }          -> {}   an effect reading online(node, now)
// { op: "pulse" }                     -> { seen }   a pulse; what the watch saw at each of its
//    runs since the last pulse (by session name)
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { kind } from "@ermine/ids"
import { createPlaces } from "@ermine/places"
import { createPaths } from "@ermine/scheduler/paths"
import { createScheduler } from "@ermine/scheduler"
import { createTable, type Key } from "@ermine/table"
import {
	beat,
	leave,
	ONLINE,
	online,
	type Session,
	startSession,
	sweep,
	type World,
} from "./sessions.ts"

const scheduler = createScheduler()
const paths = createPaths<unknown>()
const table = createTable((part, id) => places.onTableChange(part as Key, id))
const places = createPlaces({ root: "R", table, paths, scheduler })
scheduler.onTrackingEnd((k) => places.release(k))
const scope = scheduler.createRootScope({ actor: "host" })
const world: World = { table, places, scheduler, scope }

const sessions = new Map<string, Session>()
const names = new Map<string, string>()
const nameOf = (id: string) => names.get(id) ?? id
const session = (name: unknown) => {
	const s = sessions.get(String(name))
	if (s === undefined) throw new Error(`no session ${name}`)
	return s
}
let seen: unknown[] = []

export function answer(r: Request): Record<string, unknown> {
	switch (r.op) {
		case "start": {
			const s = startSession({ id: String(r.install) })
			const differs = !names.has(s.id)
			sessions.set(String(r.name), s)
			names.set(s.id, String(r.name))
			return { kind: kind(s.id) ?? null, differs }
		}
		case "beat":
			beat(world, session(r.session), r.node, r.until)
			return {}
		case "leave":
			leave(world, session(r.session), r.node)
			return {}
		case "sweep":
			sweep(world, r.node, r.now)
			return {}
		case "online":
			return {
				here: places.peep(() => online(world, r.node, r.now))
					.map((h) => ({ ...h, session: nameOf(h.session) }))
					.sort((a, b) => a.session < b.session ? -1 : a.session > b.session ? 1 : 0),
			}
		case "entry": {
			const v = table.get(ONLINE, r.node)?.value as Record<string, unknown> | undefined
			return {
				value: v === undefined
					? null
					: Object.fromEntries(Object.entries(v).map(([k, x]) => [nameOf(k), x])),
			}
		}
		case "watch":
			scheduler.runWithScope(scope, () =>
				scheduler.createEffect(
					() => online(world, r.node, r.now).map((h) => nameOf(h.session)),
					(here) => void seen.push(here),
				))
			return {}
		case "pulse": {
			scheduler.pulse()
			const out = seen
			seen = []
			return { seen: out }
		}
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

if (import.meta.main) {
	await serve(answer)
}
