// runs harness: places' harness (core/places/typescript/places_harness.ts: its world, its
// computes by name, its programs) and the runs (runs.ts), on the line protocol.
// { op: "runs" }                            → {}   the runs listener, made once
// { op: "giveRun", name, id }               → {}   the compute's runs written by node id
// { op: "runOf", id }                       → { run }   outside a run, the policy asked: null |
//    { n, end, error?, act?, timed, reads, writes }; timed: started then ended; error: the
//    Error's message, else what was thrown as it was; act: { end, error? } the same; read: { part,
//    id, path, keys?, actor } | null; write: { part, id, actor }. refused: { error: "refused" }
// { op: "dropRun", id }                     → {}   the record out (its computer gone)
// { op: "deny", id }                        → {}   from now on the policy says no to reading id
// { op: "effect", name, scope, f, act }     → {}   an effect (the name, as watch's) running f (a
//    list of {"read":[part,id,path?]}, its value the values read) and acting with act: a program of
//    this harness: a value, {"read":[part,id,path?]}, {"if":[c,a,b]}, {"throw":message} (an
//    Error), {"throwRaw":v} (v thrown as it is; typescript only)
// { op: "statusValue", id }                 → { value }   typescript only: the node's status as it is
//    (statusOf tells only an Error's message): null | "pending" | { error } | { thrown }
// program e, besides places' harness's:
//   {"run":[id, field?]}        the record as runOf tells it, or that field of it; tracked
import { type Computer, PENDING } from "@ermine/core/scheduler"
import { status } from "../../../core/places/typescript/status.ts"
import { createGuard, Refusal } from "@ermine/core/places/guard"
import { no, yes } from "@ermine/core/protect"
import {
	answered,
	enroll,
	places,
	s,
	scope,
	table,
} from "../../../core/places/typescript/world_harness.ts"
import { answer as placesAnswer, forms } from "../../../core/places/typescript/places_harness.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { type Act, createRuns, type Field, type Run } from "./runs.ts"

type Json = unknown

let runs: ReturnType<typeof createRuns> | undefined
const denied = new Set<string>()
const guard = createGuard({
	places,
	table,
	scheduler: s,
	may: (ask) => denied.has(String(ask.target.id)) ? no("denied") : yes,
})

// what was thrown as it is told: an Error's message, else the value
const thrown = (e: unknown): Json => e instanceof Error ? e.message : e
const actJson = (a: Act): Json =>
	a.end === "done" ? { end: "done" } : { end: "failed", error: thrown(a.error) }

// a harness program, the small part of it effects use
function evaluate(e: Json): Json {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map(evaluate)
	const m = e as Request
	if ("read" in m) {
		const [part, id, path] = m.read
		return places.readValue(part, id, path) ?? null
	}
	if ("if" in m) {
		const [c, a, b] = m.if
		return evaluate(c) ? evaluate(a) : evaluate(b)
	}
	if ("throw" in m) throw new Error(m.throw)
	if ("throwRaw" in m) throw m.throwRaw
	throw new Error("unknown program")
}

// a run as runOf tells it
function runJson(run: Run | undefined): Json {
	if (run === undefined) return null
	const actor = (c: { actor: unknown } | undefined) => c === undefined ? null : c.actor ?? null
	return {
		n: run.n,
		end: run.end,
		...("error" in run && { error: thrown(run.error) }),
		...(run.act !== undefined && { act: actJson(run.act) }),
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
	if (field === "error") return { value: thrown(v) }
	if (field === "act") return { value: actJson(v as Act) }
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
		case "effect": {
			const w = { runs: 0, value: null as Json }
			const c = s.runWithScope(
				scope(r.scope),
				() =>
					s.createEffect(
						() => (w.runs++, evaluate(r.f)),
						() => void evaluate(r.act),
					),
			)
			enroll(r.name, c, w)
			return {}
		}
		case "statusValue": {
			const v = status(places, r.id)
			return {
				value: v === undefined
					? null
					: v === PENDING
					? "pending"
					: v instanceof Error
					? { error: v.message }
					: { thrown: v },
			}
		}
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
