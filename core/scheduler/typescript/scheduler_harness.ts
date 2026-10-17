// The scheduler on the line protocol (conformance/typescript/harness.ts): one JSON request per line
// in, one answer per line out, in order. Another implementation joins by speaking this (HARNESS).
//
// The harness plays the host: it keeps a value at each key, and when a compute's result is set
// it writes it at the compute's key (to) and says changed([to], the compute), as ermine.ts will.
// Scopes and computations share one namespace of names. Keys are strings, any string, compared
// whole (a NUL inside, the empty one, lone surrogates: each its own key). A change the harness
// makes in a computation's code names that computation as the writer (a write in a run: the run,
// as current().writer gave it at the run's start); the host's own (write, changed) name none. info: a scope's pairs, [[key, value]..]
//
//   {"op":"root","name":s,"info"?:pairs}                                             → {}
//   {"op":"scope","name":s,"info"?:pairs,"parent"?:p}  under p; none: under the one open
//        (at the top nothing is open: unscoped, before empty)
//   {"op":"compute","name":c,"scope":s,"f":e,"to"?:k,"equal"?:"json","declared"?:true,"set"?:e}
//        made with s open                                                           → {}
//        declared: to is also given to the scheduler as the compute's key, its writer from the
//        start (compute's key argument)
//        set: evaluated in each set, after the result is kept at to and marked, given it as
//        value; what it throws, the set throws
//   {"op":"effect","name":c,"scope":s,"f":e,"act":e,"equal"?:"json","early"?:true}  → {}
//        early: made early (it runs and acts in the request)
//        f: evaluated in each run. act: evaluated in each act, given value and previous.
//        equal "json": results compared by their JSON (which has no -0: 0 and -0 equal); else
//        Object.is (0 and -0 differ, a new list is never equal)
//   {"op":"cleanup","scope":s,"do":e}                e when s is cleaned up    → {}
//   {"op":"dispose","scope":s}  disposed already: nothing                            → {}
//        every cleanup runs; one that threw: the first error, after them all (the scope is gone)
//   {"op":"run","scope":s,"do":e}                    e in run(s): untracked    → {"value":v}
//        what e throws is the answer's error; PENDING or a promise: no value, {}
//   {"op":"write","values":{k:v...}}    each kept at its key, then changed(keys) → {"tick":t}
//   {"op":"changed","keys":[k...]}                                            → {"tick":t}
//        one mark of all the keys, in order; no keys: a mark all the same, a tick taken. a key
//        not a string: an error, no tick
//   {"op":"pulse"}                                                                   → {}
//        a pulse past 10000 moments is endless: it is left, and answers {"error":"endless"}
//   {"op":"resolve","promise":p,"value":v}  the promise p made settles, and lands  → {}
//   {"op":"reject","promise":p,"error":s}                                            → {}
//        settled: it lands at the next pulse, not before (no moment till then). settled once:
//        again, "no promise p"
//   {"op":"get","key":k}                     the value kept at k; none: null     → {"value":v}
//   {"op":"log"}            what programs logged since last asked, then forgotten → {"log":[..]}
//   {"op":"moments"}        the moments since last asked, then forgotten     → {"moments":[..]}
//   {"op":"moments","reads":true}   the same, an ends moment with its reads
//   {"op":"forgotten"}  the keys the scheduler stopped tracking (its forget) since last asked
//                                                                             → {"keys":[k...]}
//   {"op":"started"}  the keys that gained their first tracker since last asked (onTrackingStart),
//                     in the order first read: again once forgotten and read again
//                                                                             → {"keys":[k...]}
//   {"op":"tick"}       the tick of the latest mark; none yet: 0                 → {"tick":t}
//   {"op":"current"}   what is open, as the form current shows it              → {"value":v}
//
// ticks: each mark (write, changed, a write form, a compute's set) and each new computation takes
// the next, from 1. a computation made is due at once, at its tick.
//
// a moment, computations by name, an error as below:
//   {"due":c,"tick":t,"writer"?:c}  {"starts":c,"run":n,"rank":r}
//   {"acts":c,"run":n,"early"?:true,"error"?:s}
//   {"ends":c,"run":n,"ended":"done"|"pending"|"failed"|"stopped"|"looping","equal"?:b,
//    "error"?:s,"waits"?:c,"through"?:[c..],"reads"?:[k..]}   reads: when asked for
// moments come as told: due when made due, starts and ends around a run (a run's own marks and
// makings between them), acts after. due: made due by a mark (writer: the computation the change
// named, its run; none, from outside) or by being made (writer: the computation whose run, set,
// act or cleanup made it). one already due is not told again. one mark makes a key's readers due
// in the order they began reading it (one that stopped reading it and read it again: last), its
// keys in order. run: the computation's runs, counted from 1. equal: there when the run had a
// result to compare (done, looping, failed in its set), false for a first one. a run's end told for a
// promise settling has no starts before it. a run disposed in itself is told no end. an act: run,
// the run whose value it is. through: the computations on the loop, each once, in the order they
// were made (not the order along the loop).
// what runs: in rounds. the settled land first, in the order settled; then the due run, lowest
// rank first, then the earliest due (tick), then the order made; one waiting after a due one
// (stopped) later; then the early effects act, then the others, each queue in the order their
// runs ended, an owner's act before what it made. an act whose effect is due again does not act.
// ranks: a computation is after the writers of the keys its last run read and the one it waits
// after; nothing after: 0; else one past the most of those. learned as runs end, so a first run
// is rank 0 unless a key was declared. ranks only rise as edges change (an edge gone lowers
// nothing, even when everything is ranked again); a cycle (a component of more than one) shares one rank, one past what it is after.
// writer: a key's, the compute last named by a change of it, alive then: named by a run of it (in
//   its code, after an await too, the latest run or not) or by it (its set, its cleanup: its
//   latest run); or declared. a change named by an effect, by one gone or not run yet, or by none
//   learns no writer: the one there stays. one gone is the writer of nothing
// stop: a run reading a key whose writer w is another computation, due, stops there (ended
//   stopped, waits w), unless w waits after the reader (its after, that one's after.., reaches it)
//   or a chain kept on w came out of a run of the reader this pulse. the read is tracked. stopped:
//   due again at the tick that made the run due, waiting after w while w is due
// chain (causes.ts): a run's, its computation, then the chains given it: those of every mark on
//   it since its last run that ended done (one on it while due or looping joins too; a cut one
//   too); a run that ends any other way gives them back. a change carries the chain of the run it
//   names, while that run is its computation's latest (named by a computation: its latest run's);
//   else, or from outside, none. a chain from an earlier pulse is cut to its computation alone.
//   all forgotten at the pulse's end
// loop: a mark on c whose chain leads back to a run of c this pulse; the loop, those paths'
//   computations (through)
// flagged: a run whose computation's latest mark before it began was on a loop through it (a cut
//   one aside; one on it while due counts, so one from outside unflags it). a stopped run's flag
//   carries to the next run when no mark came since
// a flagged run: a new result ends looping (not set, not acted on, the last result kept); equal,
//   done, but looping when it cut; failed when it cut, looping, its error told. cut: a loop mark
//   its change makes (in its code, its cleanups before it, after its await) is dropped, that
//   computation not made due; a computation it makes (made due all the same) cuts too. it is
//   flagged till it ends; pending, till it lands and ends
// looping: its computation is made due by no mark on a loop through it; one that is not on one
//   makes it due, and ends it
// owns: what is made with a computation open (scopes, computations, cleanups) in its run, set or
//   act is under it. torn down: a compute's, before each run; an effect's, what was made since its
//   last act before each run, all before each act; all when it goes. a teardown: what is under
//   first, newest first (each the same way), then its cleanups, newest first
// a cleanup's writer open: on a computation, it (its latest run; the run starting, before a run);
//   on a plain scope, the teardown's: by a computation's teardown or clean, that computation; by a
//   dispose, the writer open there (the host's: none)
// info: a scope's pairs, those given then ["owner", the info of the one it is under] (a root:
//   none), made once with it. a computation's, before its first run [["mark",t],["owner",..]], t
//   the tick it was made at; from each run's start [["run",n],["mark",t],["owner",..]], t the tick
//   that made that run due. current: scope, the name (none: null); pairs, its info; writer, the
//   computation of the run open (in a run, its own; in a set, act or a computation's cleanup, it,
//   once it has run; in run(), the one open around it)
// an error: a scheduler error's code ("disposed", "unscoped", "empty"), "pending" for a
// thrown PENDING, else its message. a request that fails answers {"error":s}, and the harness
// goes on. the harness's own: "unknown op o", "unknown form f" (a map of no key: "unknown form
// undefined"), "no scope s", "no promise p", "name taken: s".
//
// an expression e: a number, string, boolean or null is itself; a list, its members evaluated;
// a map of one key is one of:
//   {"read":k}          the key read (tracked in a run), its value (the one kept, no copy); none: null
//   {"sum":[e..]}       added, numbers only; null is 0; none: 0; anything else an error
//   {"mod":[a,b]}       a mod b; null is 0; b 0 an error
//   {"eq":[a,b]}        equal by JSON           {"if":[test,then,else]}   test true, then, else else
//   {"given":"value"}  {"given":"previous"}   in an act: its value, and the one acted on before;
//                       {"given":"previous"} in a run: the computation's last result (a compute's
//                       last given to set, forgotten when its set threw; an effect's last acted
//                       on, not its last run's); none yet: null. in a set: value, the result
//   {"log":e}           e logged; e             {"do":[e..]}     each in order; the last; none: null
//   {"write":[k,e]}     e kept at k, then changed([k], writer); e. writer: in a run (after an await
//                       too), the run (current().writer kept from its start); in a set, act, cleanup or run(), the
//                       computation; else none
//   {"write":[k,e,null]}  the same, said with no writer: from outside
//   {"write":[k,e,"open"]}  the same, by the writer open (current().writer)
//   {"write":[k,e,c]}   the same, by computation c (its latest run; none yet: from outside). an
//                       effect named is told as the writer, but is no key's writer. c not there:
//                       "no scope c", nothing written
//   {"throw":e}         e evaluated: PENDING (below) is thrown as itself, a string as an error of
//                       message e
//   {"pending":null}    PENDING: returned by f, the compute's run ends pending; thrown, the same
//   {"wait":[p]}        a promise named p (evaluated), settled by resolve or reject; what it resolves to
//   {"wait":[p,e]}      the same, then e evaluated after the await (as resolve settles it); e. a
//                       throw there rejects it, PENDING lands pending. after an await nothing is
//                       open: a scope, a cleanup on the scope open, an effect or a within there is
//                       unscoped
//   {"run":e}           e in run(the computation): untracked
//   {"in":[s,e]}        e in run(s): untracked
//   {"scope":[s,info,p?]}  s made under p, else under the one open; null
//   {"within":[info,e]}  e in run(a new scope of info, under the one open, unnamed): untracked
//   {"current":null}    what is open: {"scope":s,"pairs":[[k,v]..],"writer"?:c}, the computation
//                       of the writer; nothing: null
//   {"cleanup":[s,e]}   e when s is cleaned up; s null: the scope open; null
//   {"effect":[c,f,act,early?]}  an effect c made under the scope open (in an act: its effect),
//                       as the effect request's; early true: early. null. c taken by one gone: taken
//                       over
//   {"dispose":s}       s disposed; null
//   {"quote":x}         x as it is
import {
	type Computer,
	createScheduler,
	type Pair,
	PENDING,
	type Run,
	SchedulerError,
	type Scope,
} from "@ermine/scheduler"
import { type Told, trace } from "./trace.ts"
import { serve } from "../../../conformance/typescript/harness.ts"

type Json = unknown
type Request = { op: string; [k: string]: Json }

const store = new Map<string, Json>()
let logged: Json[] = []
// as told; named when asked (a new computer is due before it has a name)
let moments: Told[] = []
let forgotten: unknown[] = []
let started: unknown[] = []
const named = new Map<string, Scope>()
const names = new Map<Scope, string>()
const promises = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

const errorOf = (e: unknown): string =>
	e instanceof SchedulerError
		? e.code
		: e === PENDING
		? "pending"
		: e instanceof Error
		? e.message
		: String(e)
const nameOf = (c: Computer) => names.get(c)!

function moment(m: Told, reads: boolean): Json {
	if ("due" in m) {
		return m.by ? { due: nameOf(m.due), tick: m.tick, writer: nameOf(m.by) } : {
			due: nameOf(m.due),
			tick: m.tick,
		}
	}
	if ("starts" in m) return { starts: nameOf(m.starts), run: m.run, rank: m.rank }
	if ("acts" in m) {
		const out: Record<string, Json> = { acts: nameOf(m.acts), run: m.run }
		if (m.early) out.early = true
		if ("error" in m) out.error = errorOf(m.error)
		return out
	}
	const out: Record<string, Json> = { ends: nameOf(m.ends), run: m.run, ended: m.ended }
	if (m.equal !== undefined) out.equal = m.equal
	if ("error" in m) out.error = errorOf(m.error)
	if (m.waits) out.waits = nameOf(m.waits)
	if (m.through) out.through = m.through.map(nameOf)
	if (reads) out.reads = m.reads
	return out
}

// a pulse past this many moments is endless: every moment after throws, so the pulse is left
const ENDLESS = 10000
let told = 0
const s = createScheduler()
trace(s, (m) => {
	moments.push(m)
	if (++told > ENDLESS) throw new Error("endless")
})
s.onTrackingEnd((key) => void forgotten.push(key))
s.onTrackingStart((key) => void started.push(key))
// the tick of the latest mark (each mark and each new computer takes the next)
let tick = 0
s.onMark((_keys, _run, _due, t) => void (tick = t))

// a name taken (by one not torn down: else taken over) is refused before anything is made
function vacant(n: string) {
	if (named.get(n)?.state === "alive") throw new Error(`name taken: ${n}`)
}
function name(o: Scope, n: string) {
	named.set(n, o)
	names.set(o, n)
}
function scope(n: Json): Scope {
	const o = named.get(n as string)
	if (!o) throw new Error(`no scope ${n}`)
	return o
}
function computation(n: Json): Computer {
	const o = scope(n)
	if (!("kind" in o)) throw new Error(`not a computation: ${n}`)
	return o as Computer
}

// what is open, by name: the scope, its pairs, and the computer of the run; nothing: null
function current(): Json {
	const o = s.getCurrentScope()
	if (o === undefined) return null
	const out: Record<string, Json> = { scope: names.get(o) ?? null, pairs: s.getInfo()! }
	const run = s.getRun()
	const writer = run && names.get(run.computer)
	if (writer !== undefined) out.writer = writer
	return out
}

function keep(key: string, v: Json) {
	if (v === undefined) store.delete(key)
	else store.set(key, v)
}

// what an expression is evaluated in: the run (getRun() at its start), the computer, an act's
// values
type Ctx = { run?: Run; self?: Scope; value?: Json; previous?: Json }

const num = (v: Json) => (v === null || v === undefined ? 0 : v as number)

// who a change in this code is by: the run, else the computer
const runOf = (ctx: Ctx): Run | Computer | undefined =>
	ctx.run ?? (ctx.self && "kind" in ctx.self ? ctx.self as Computer : undefined)

function evaluate(e: Json, ctx: Ctx): unknown {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map((x) => evaluate(x, ctx))
	const [form, arg] = Object.entries(e as Record<string, Json>)[0] ?? []
	const a = arg as Json[]
	switch (form) {
		case "read": {
			const k = evaluate(arg, ctx) as string
			s.track(k)
			return store.get(k) ?? null
		}
		case "sum":
			return a.reduce((n: number, x) => n + num(evaluate(x, ctx)), 0)
		case "mod":
			return num(evaluate(a[0], ctx)) % num(evaluate(a[1], ctx))
		case "eq":
			return JSON.stringify(evaluate(a[0], ctx)) === JSON.stringify(evaluate(a[1], ctx))
		case "if":
			return evaluate(a[0], ctx) === true ? evaluate(a[1], ctx) : evaluate(a[2], ctx)
		case "given":
			return arg === "value" ? ctx.value : arg === "previous" ? (ctx.previous ?? null) : null
		case "log": {
			const v = evaluate(arg, ctx)
			logged.push(v)
			return v
		}
		case "do": {
			let v: unknown = null
			for (const x of a) v = evaluate(x, ctx)
			return v
		}
		case "write": {
			const k = evaluate(a[0], ctx) as string
			const v = evaluate(a[1], ctx)
			keep(k, v)
			s.mark(
				[k],
				a.length < 3
					? runOf(ctx)
					: a[2] === "open"
					? s.getRun()
					: a[2] === null
					? undefined
					: computation(a[2]),
			)
			return v
		}
		case "throw": {
			const v = evaluate(arg, ctx)
			if (v === PENDING) throw PENDING
			throw new Error(v as string)
		}
		case "pending":
			return PENDING
		case "wait": {
			const p = evaluate(a[0], ctx) as string
			const promise = new Promise((resolve, reject) => promises.set(p, { resolve, reject }))
			return a.length > 1 ? promise.then(() => evaluate(a[1], ctx)) : promise
		}
		case "run":
			return s.runWithScope(ctx.self!, () => evaluate(arg, { ...ctx, run: undefined }))
		case "in":
			return s.runWithScope(scope(a[0]), () => evaluate(a[1], { ...ctx, run: undefined }))
		case "scope":
			vacant(a[0] as string)
			name(
				s.createScope(a[1] as Pair[], a[2] === undefined ? undefined : scope(a[2])),
				a[0] as string,
			)
			return null
		case "within":
			return s.runWithScope(
				s.createScope(a[0] as Pair[]),
				() => evaluate(a[1], { ...ctx, run: undefined }),
			)
		case "current":
			return current()
		case "cleanup": {
			// on the scope open when it is the one named (or none is), else with that one open
			const f = () => evaluate(a[1], { ...ctx, run: undefined })
			if (a[0] === null) {
				const open = s.getCurrentScope()
				if (open === undefined) throw new SchedulerError("unscoped", "no scope is open")
				s.registerTeardown(open, f)
				return null
			}
			const o = scope(a[0])
			if (s.getCurrentScope() === o) s.registerTeardown(o, f)
			else s.runWithScope(o, () => s.registerTeardown(o, f))
			return null
		}
		case "dispose":
			s.teardown(scope(arg))
			return null
		case "effect": {
			const [f, act] = [a[1], a[2]]
			vacant(a[0] as string)
			let made: Computer | undefined
			const self = () => made ?? s.getCurrentScope()!
			made = s.createEffect(
				(previous) =>
					evaluate(f, { run: s.getRun(), self: self(), previous: previous as Json }),
				(value, previous) => void evaluate(act, { self: self(), value, previous }),
				undefined,
				a[3] === true ? { early: true } : undefined,
			)
			name(made, a[0] as string)
			return null
		}
		case "quote":
			return arg
		default:
			throw new Error(`unknown form ${form}`)
	}
}

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// a computer's f, as the program: evaluated with its last result, and the run kept from its start
// (getRun()), so a write after an await is still the run's
function program(r: Request, self: () => Scope) {
	return (previous: unknown) =>
		evaluate(r.f, { run: s.getRun(), self: self(), previous: previous as Json })
}

async function run(r: Request): Promise<Json> {
	switch (r.op) {
		case "root":
			vacant(r.name as string)
			name(s.createRootScope((r.info ?? []) as Pair[]), r.name as string)
			return {}
		case "scope": {
			vacant(r.name as string)
			const info = (r.info ?? []) as Pair[]
			name(
				s.createScope(info, r.parent === undefined ? undefined : scope(r.parent)),
				r.name as string,
			)
			return {}
		}
		case "compute": {
			vacant(r.name as string)
			const to = r.to as string | undefined
			const c: Computer = s.runWithScope(scope(r.scope), () =>
				s.createComputer(
					program(r, () => c),
					(v) => {
						if (to !== undefined) {
							keep(to, v)
							s.mark([to], c)
						}
						if (r.set !== undefined) evaluate(r.set, { self: c, value: v })
					},
					r.equal === "json" ? json : undefined,
					r.declared === true ? to : undefined,
				))
			name(c, r.name as string)
			return {}
		}
		case "effect": {
			vacant(r.name as string)
			// an early one runs and acts before it is given back: itself, the scope open then
			let made: Computer | undefined
			const self = () => made ?? s.getCurrentScope()!
			const c: Computer = made = s.runWithScope(scope(r.scope), () =>
				s.createEffect(
					program(r, self),
					(value, previous) => void evaluate(r.act, { self: self(), value, previous }),
					r.equal === "json" ? json : undefined,
					r.early === true ? { early: true } : undefined,
				))
			name(c, r.name as string)
			return {}
		}
		case "cleanup": {
			const o = scope(r.scope)
			s.runWithScope(o, () => s.registerTeardown(o, () => evaluate(r.do, { self: o })))
			return {}
		}
		case "dispose":
			s.teardown(scope(r.scope))
			return {}
		case "run": {
			const o = scope(r.scope)
			return { value: s.runWithScope(o, () => evaluate(r.do, { self: o })) ?? null }
		}
		case "current":
			return { value: current() }
		case "write": {
			const values = r.values as Record<string, Json>
			for (const [k, v] of Object.entries(values)) keep(k, v)
			return { tick: s.mark(Object.keys(values)) }
		}
		case "changed":
			return { tick: s.mark(r.keys as string[]) }
		case "pulse":
			told = 0
			s.pulse()
			return {}
		case "resolve":
		case "reject": {
			const p = promises.get(r.promise as string)
			if (!p) throw new Error(`no promise ${r.promise}`)
			promises.delete(r.promise as string)
			if (r.op === "resolve") p.resolve(r.value)
			else p.reject(new Error(r.error as string))
			// the settling, and what waits after it, reach the scheduler
			await new Promise((done) => setTimeout(done, 0))
			return {}
		}
		case "get":
			return { value: store.get(r.key as string) ?? null }
		case "log": {
			const out = logged
			logged = []
			return { log: out }
		}
		case "moments": {
			const out = moments.map((m) => moment(m, r.reads === true))
			moments = []
			return { moments: out }
		}
		case "forgotten": {
			const keys = forgotten
			forgotten = []
			return { keys }
		}
		case "started": {
			const keys = started
			started = []
			return { keys }
		}
		case "tick":
			return { tick }
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

async function answer(r: Request): Promise<Record<string, Json>> {
	try {
		return await run(r) as Record<string, Json>
	} catch (e) {
		return { error: errorOf(e) }
	}
}

if (import.meta.main) await serve(answer as never)
