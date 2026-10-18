// runs harness: places' harness (filesystem/places/typescript/places_harness.ts: its world, its
// computes by name, its programs) and the runs (runs.ts), on the line protocol.
// { op: "runs" }                            → {}   the runs listener, made once
// { op: "giveRun", name, id }               → {}   the compute's runs written by node id
// { op: "runOf", id }                       → { run }   outside a run, the policy asked: null |
//    { n, end, error?, timed, reads, writes }; timed: started then ended; read: { part, id, path,
//    keys?, actor } | null; write: { part, id, actor }. refused: { error: "refused" }
// { op: "dropRun", id }                     → {}   the record out (its computer gone)
// { op: "deny", id }                        → {}   from now on the policy says no to reading id
// program e, besides places' harness's:
//   {"run":[id, field?]}        the record as runOf tells it, or that field of it; tracked
import { type Computer, PENDING } from "@ermine/scheduler"
import { createGuard, Refusal } from "@ermine/places/guard"
import { no, yes } from "@ermine/protect"
import {
	answered,
	places,
	s,
	scope,
	table,
} from "../../../filesystem/places/typescript/world_harness.ts"
import {
	answer as placesAnswer,
	forms,
} from "../../../filesystem/places/typescript/places_harness.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { createRuns, type Field, type Run } from "./runs.ts"

type Json = unknown

let runs: ReturnType<typeof createRuns> | undefined
const denied = new Set<string>()
const guard = createGuard({
	places,
	table,
	scheduler: s,
	may: (ask) => denied.has(String(ask.target.id)) ? no("denied") : yes,
})

// a run as runOf tells it
function runJson(run: Run | undefined): Json {
	if (run === undefined) return null
	const actor = (c: { actor: unknown } | undefined) => c === undefined ? null : c.actor ?? null
	return {
		n: run.n,
		end: run.end,
		...(run.error !== undefined && { error: run.error.message }),
		timed: typeof run.started === "number" && run.started <= run.ended,
		reads: run.reads.map((r) =>
			"key" in r ? null : {
				part: r.part,
				id: r.id,
				path: r.path,
				...(r.keys && { keys: true }),
				actor: actor(r.change),
			}
		),
		writes: run.writes.map((w) => ({ part: w.part, id: w.id, actor: actor(w.change) })),
	}
}

forms.push((m) => {
	if (!("run" in m)) return
	if (runs === undefined) throw new Error("no runs")
	const [id, field] = m.run as [string, Field?]
	if (field === undefined) return { value: runJson(runs.read(id, guard)) }
	const v = runs.read(id, field, guard)
	if (v === undefined) return { value: null }
	// as runOf tells it: the one field of a record holding just it
	const one = runJson({ n: 0, ended: 0, end: "done", reads: [], writes: [], [field]: v } as Run)
	return { value: (one as Record<string, Json>)[field] ?? null }
})

function answer(r: Request): Json | undefined {
	switch (r.op) {
		case "runs":
			runs ??= createRuns({ places, table, scheduler: s })
			return {}
		case "giveRun":
			if (runs === undefined) throw new Error("no runs")
			runs.give(scope(r.name) as Computer, r.id)
			return {}
		case "runOf":
			if (runs === undefined) throw new Error("no runs")
			try {
				return { run: runJson(runs.read(r.id, guard)) }
			} catch (e) {
				if (e instanceof Refusal) return { error: "refused" }
				if (e === PENDING) return { error: "pending" }
				throw e
			}
		case "dropRun":
			runs?.drop(r.id)
			return {}
		case "deny":
			denied.add(r.id)
			return {}
	}
	return placesAnswer(r)
}

if (import.meta.main) await serve((r) => answered(answer, r))
