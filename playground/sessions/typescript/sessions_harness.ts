// sessions (sessions.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. one world for the run (a table, places, a scheduler, a root scope the beats are
// written in). sessions and installs are named in requests and answers by the names they were
// started with
//
// { op: "start", name, install }      -> { kind, differs, vouched }   startSession of the install
//    named install (its secret: BLAKE3 of its name, so one name is one install, its id its key's);
//    kind: the session id's (ids' kind); differs: from every session started before it; vouched:
//    vouched(session)
// { op: "vouched", session, as?, from? } -> { vouched }   the session's claim checked; as: claimed
//    for the install named as instead; from: with the vouch of the session named from instead
// { op: "beat", session, node, until } -> {}
// { op: "leave", session, node }      -> {}
// { op: "sweep", node, now }          -> {}
// { op: "online", node, now }         -> { here }   [{ session, install, until }], by name
// { op: "entry", node }               -> { value }   the online entry as stored, by session name;
//    null: none
// { op: "put", node, key, value }    -> {}   value written at key in the node's online entry, as a
//    carrier might bring it ("NaN", "Infinity": those numbers)
// { op: "watch", node, now }          -> {}   an effect reading online(node, now)
// { op: "pulse" }                     -> { seen }   a pulse; what the watch saw at each of its
//    runs since the last pulse (by session name)
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { blake3 } from "@ermine/core/blake3"
import * as ed25519 from "@ermine/core/ed25519"
import { kind, text } from "@ermine/ids"
import { createPlaces } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/core/places/upsert"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createScheduler } from "@ermine/core/scheduler"
import { createTable, type Key } from "@ermine/core/table"
import {
	beat,
	leave,
	ONLINE,
	online,
	type Session,
	startSession,
	sweep,
	vouched,
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

// the install a name stands for: its secret BLAKE3 of the name, its id its key's
async function install(name: string) {
	const secret = blake3(new TextEncoder().encode(name))
	const key = await ed25519.publicKeyOf(secret)
	return { id: text(Uint8Array.of(0xed, 0x01, ...key))!, secret }
}

export async function answer(r: Request): Promise<Record<string, unknown>> {
	switch (r.op) {
		case "start": {
			const s = await startSession(await install(String(r.install)), ed25519)
			const differs = !names.has(s.id)
			sessions.set(String(r.name), s)
			names.set(s.id, String(r.name))
			names.set(s.install, String(r.install))
			return { kind: kind(s.id) ?? null, differs, vouched: await vouched(s, ed25519) }
		}
		case "vouched": {
			const s = session(r.session)
			const claim = {
				id: s.id,
				install: r.as === undefined ? s.install : (await install(String(r.as))).id,
				vouch: r.from === undefined ? s.vouch : session(r.from).vouch,
			}
			return { vouched: await vouched(claim, ed25519) }
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
					.map((h) => ({ ...h, session: nameOf(h.session), install: nameOf(h.install) }))
					.sort((a, b) => a.session < b.session ? -1 : a.session > b.session ? 1 : 0),
			}
		case "entry": {
			const v = table.get(ONLINE, r.node)?.value
			if (v === undefined) return { value: null }
			const named: Record<string, unknown> = {}
			for (const [k, b] of Object.entries(v)) {
				named[nameOf(k)] = { ...b, install: nameOf(b.install) }
			}
			return { value: named }
		}
		case "put": {
			const v = r.value === "NaN" ? NaN : r.value === "Infinity" ? Infinity : r.value
			const b = typeof v === "object" && v !== null && "until" in v
				? { ...v, until: v.until === "NaN" ? NaN : v.until === "Infinity" ? Infinity : v.until }
				: v
			scheduler.runWithScope(scope, () =>
				places.commit(
					upsert(table, ONLINE, r.node, [String(r.key)], b, createChangeHeader(scheduler)),
				))
			return {}
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
