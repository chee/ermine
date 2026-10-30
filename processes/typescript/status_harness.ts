// The reference status (status.ts) on places' harness, with its requests and programs plus these.
// { op: "status" }                           → {}   the status listener, made once
// { op: "give", name, id }                   → {}   compute name's status written on node id
// { op: "statusOf", id }                     → { status }   read outside a run: "pending",
//    { error: message }, or null
// a program form: {"status":id}               statusOf: "pending" | { error } | null, tracked
import type { Computer } from "@ermine/reactivity"
import {
	answered,
	id,
	places,
	s,
	scope,
	table,
} from "../../places/typescript/world_harness.ts"
import { answer as placesAnswer, forms } from "../../places/typescript/places_harness.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { createStatus, PENDING, status } from "./status.ts"

type Json = unknown

let statuses: ReturnType<typeof createStatus> | undefined

const statusJson = (v: unknown): Json =>
	v === PENDING ? "pending" : v instanceof Error ? { error: v.message } : null

forms.push((m) => "status" in m ? { value: statusJson(status(places, m.status)) } : undefined)

export function answer(r: Request): Json | undefined {
	switch (r.op) {
		case "status":
			statuses ??= createStatus({ places, table, scheduler: s })
			return {}
		case "give":
			if (statuses === undefined) throw new Error("no status")
			statuses.give(scope(r.name) as Computer, id(r.id))
			return {}
		case "statusOf":
			return { status: statusJson(status(places, id(r.id))) }
	}
	return placesAnswer(r)
}

if (import.meta.main) await serve((r) => answered(answer, r))
