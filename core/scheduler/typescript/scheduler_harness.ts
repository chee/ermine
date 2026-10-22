// The scheduler on the line protocol (conformance/typescript/harness.ts): one JSON request per line
// in, one answer per line out, in order. Another implementation joins by speaking this (HARNESS).
//
// The harness plays the host: it keeps a value at each key, and when a compute's result is set
// it writes it at the compute's key (to) and says changed([to], the compute), as ermine.ts will.
// Scopes and computations share one namespace of names. Keys are strings, any string, compared
// whole (a NUL inside, the empty one, lone surrogates: each its own key). A change the harness
// makes in a computation's code names that computation as the writer (a write in a run: the run,
// as current().writer gave it at the run's start); the host's own (write, changed) name none. info: a scope's info, an object
//
//   {"op":"root","name":s,"info"?:info}                                             → {}
//   {"op":"scope","name":s,"info"?:info,"parent"?:p}  under p; none: under the one open
//        (at the top nothing is open: unscoped, before empty)
//   {"op":"compute","name":c,"scope":s,"f":e,"to"?:k,"equal"?:"json","declared"?:true,"set"?:e,
//    "info"?:info}  made with s open                                               → {}
//        declared: to is also given to the scheduler as the compute's key, its writer from the
//        start (compute's key argument)
//        set: evaluated in each set, after the result is kept at to and marked, given it as
//        value; what it throws, the set throws
//   {"op":"effect","name":c,"scope":s,"f":e,"act":e,"equal"?:"json","early"?:true,"info"?:info}
//        early: made early (it runs and acts in the request)                        → {}
//        info (compute, effect): the computer's own keys, given as it is made
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
//   {"op":"moments","returns":true}   the same, with each returns moment (left out otherwise)
//   {"op":"moments","pulses":true}    the same, with each pulsed moment (left out otherwise)
//   {"op":"forgotten"}  the keys the scheduler stopped tracking (its forget) since last asked
//                                                                             → {"keys":[k...]}
//   {"op":"started"}  the keys that gained their first tracker since last asked (onTrackingStart),
//                     in the order first read: again once forgotten and read again
//                                                                             → {"keys":[k...]}
//   {"op":"tick"}       the tick of the latest mark; none yet: 0                 → {"tick":t}
//   {"op":"current"}   what is open, as the form current shows it              → {"value":v}
//   {"op":"listener","on":l,"throw":s,"at"?:x}                                       → {}
//        the harness's own listener l throws an error of message s the next time it is told (of
//        x, when given), once: "mark" (onMark; x one of its keys), "starts", "returns", "ends",
//        "acts" (a run's start, its body's return (onRunReturn), its end, an act; x the
//        computation), "forgotten", "started" (onTrackingEnd,
//        onTrackingStart; x the key), "settles" (onSettle; no x), "pulsed" (onAfterPulse; no x). armed again: the last one. else
//        "unknown listener l"
//
// thrown out (finish, then rethrow): what a listener throws, or a cleanup run once the round's runs
// are done, is held while what was going on finishes (every listener told, the run or act or
// dispose or mark all done), then comes out: the first one, as the answer's error of the request
// it came out of. a pulse is left there: what is still due, or to act, waits for the next. a run is done
// before what one threw in it (its start, end, a read's) comes out; a read's, out of the read,
// into the run, so the run fails with it unless it catches it. before an act, what the effect's
// last act made goes: a cleanup's error there is the act's (told with it), a listener's comes out
// once the act is done. a promise settling and a computation's making have nothing to throw to
// (a settling no caller; the making gives back the computation) (mine): what a listener threw in
// one comes out of a pulse, the one going on or else the next, once it is done: its answer's
// error, before the pulse's own (TS: the scheduler holds it; C: sc_escaped after the call, kept
// by the harness till then). a request or form that made it answers as it would have. the error
// of a pulse left past ENDLESS is "endless"
//
// ticks: each mark (write, changed, a write form, a compute's set) and each new computation takes
// the next, from 1. a computation made is due at once, at its tick.
//
// a moment, computations by name, an error as below:
//   {"due":c,"tick":t,"writer"?:c}  {"starts":c,"run":n,"rank":r}
//   {"acts":c,"run":n,"early"?:true,"error"?:s}
//   {"ends":c,"run":n,"ended":"done"|"pending"|"failed"|"stopped"|"looping","equal"?:b,
//    "error"?:s,"waits"?:c,"through"?:[c..],"reads"?:[k..]}   reads: when asked for
//   {"returns":c,"run":n}   when asked for: the run's body returned a value (an awaited one: it
//    landed), before anything is done with it: before its set's marks, before its end; once per
//    run at most (none for a throw, PENDING, a stop). not counted toward ENDLESS
//   {"pulsed":true}   when asked for: a pulse ended (onAfterPulse): nothing due, every act done;
//    not for one left early. not counted toward ENDLESS
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
// ranks (order.ts): a computation is after the writers of the keys its last run read and the one
//   it waits after; nothing after: 0; else one past the most of those. learned as runs end, so a
//   first run is rank 0 unless a key was declared. made whole when first asked (a pick, an early
//   effect's first run), then mended as edges change, only rising (an edge gone, or one gone,
//   lowers nothing); a cycle (a component of more than one) shares one rank, one past what it is
//   after. a mend past 4·ranked+64 steps (ranked: how many have a rank) stops: made whole again
//   at the next pick, from the edges then, where one may fall (103). rank: its computation's, as
//   the run starts
// writer: a key's, the compute last named by a change of it, alive then: named by a run of it (in
//   its code, after an await too, the latest run or not) or by it (its set, its cleanup: its
//   latest run); or declared. a change named by an effect, by one gone or not run yet, or by none
//   learns no writer: the one there stays. one gone is the writer of nothing
// stop: a run reading a key whose writer w is another computation, due, stops there (ended
//   stopped, waits w), unless w waits after the reader (its after, that one's after.., reaches it)
//   or a chain kept on w came out of a run of the reader this pulse. the read is tracked. stopped:
//   due again at the tick that made the run due, waiting after w while w is due
// old reads (chee 10-18: "_any_ throw is pending"): a key a run does not read again is old. a
//   run that ends done (its computation's latest; a promise's as it lands done) stops tracking the
//   old keys, before its end is told (forgotten). one that ends any other way (failed, pending,
//   stopped, looping) tracks every key it read and every old one still: a mark of any makes it
//   due, none is forgotten, and none is started again when read again (its place among a key's
//   readers stays). a mark of an old key is a retry: the chain is held, but it is no loop through
//   it (it flags nothing, cuts nothing), and a change made by its own set, act or cleanup does not
//   reach it. only the keys it read count toward its rank
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
//   its change makes (in its code, its cleanups after it, after its await) is dropped, that
//   computation not made due; a computation it makes, new or claimed (made due all the same),
//   cuts too (132). it is flagged till it ends; pending, till it lands and ends
// looping: its computation is made due by no mark on a loop through it; one that is not on one
//   makes it due, and ends it
// owns: what is made with a computation open (scopes, computations, cleanups) in its run, set or
//   act is under it. a rerun keeps what it makes again (chee 10-17: "a parent rerun does not
//   destroy its children"). as a run starts, what its earlier runs made (a compute's: all; an
//   effect's: all but what its act made) is old: alive as ever while the run goes (it runs when
//   due, is read, writes), and its own cleanups are set aside. made again in the run (the effect
//   and compute forms, by name, under the scope open): claimed: the same computation, its runs
//   counted on, its last result and what it tracks kept, its code the new one; due (a tick, told
//   as a due by the run's computation, or nothing told when it is due already). the run done (done,
//   equal or not): what is still old goes at its end, newest first (each as a teardown; what one
//   throws is thrown out), before its end is told (mine: at the run's end, not the round's, so a
//   child not made again never runs after it); the cleanups set aside run like Solid 2.0 once the
//   round's runs are done, before its acts (the round's commit), each computation's newest first
//   in the order their runs were done, with no catch: the first that throws ends the rest of that
//   computation's, and its error is thrown out (above); queued by a flagged run, a loop mark they
//   make is cut, as that run's own are. a run that ends any other way (failed, pending, stopped,
//   looping) keeps both (chee: "keep them until the parent is actually destroyed"): the next run
//   finds them old with what this one made, and a promise landing done lets them go then. what is
//   made with no name (a plain scope; a computation not made again by name) has nothing to claim
//   it by: it is old at the next run and goes once a run is done (mine). a computation that goes
//   takes what is old and set aside with it. before each act, what the effect's last act made
//   goes and the cleanups made in that act run (every one; the first cleanup's error is the act's,
//   a listener's comes out after the act, above). a teardown (dispose, or one that goes): what is
//   under first, newest first (each the same way; then what is old), then its cleanups, newest
//   first (those set aside older than the rest); every one runs, and the first error is the
//   teardown's, after: a listener's (one under it too), else a cleanup's
// a cleanup's writer open: on a computation, it (its latest run: after a run, that run);
//   on a plain scope, the teardown's: by a computation's teardown or clean, that computation; by a
//   dispose, the writer open there (the host's: none)
// info: a scope's object, as given, nothing added, made once with it. a computation's: its own
//   keys (info, given; none: none) and mark: t, the tick it was made at; from each run's start
//   run: n and mark: t, t the tick that made that run due, set in it. current: scope, the name
//   (none: null); info, a copy of its info as it is then; writer, the
//   computation of the run open (in a run, its own; in a set, act or a computation's cleanup, it,
//   once it has run; in run(), the one open around it)
// an error: a scheduler error's code ("disposed", "unscoped", "empty"), "pending" for a
// thrown PENDING, else its message. a request that fails answers {"error":s}, and the harness
// goes on. the harness's own: "unknown op o", "unknown form f" (a map of no key: "unknown form
// undefined"), "no scope s", "no promise p", "name taken: s", "a effect with no name", "a compute
// with no name" (the form's name not a string: nothing made).
// names (the harness's labels; the scheduler has none): a making checks the scope it is under
// first (no scope), then the name (name taken). a name is taken by one alive and not old (else
// taken over), and by a computation from the start of its making till it is named (mine): what an
// early effect's first run makes at its own name is refused, so a name is never held twice
//
// an expression e: a number, string, boolean or null is itself; a list, its members evaluated;
// a map of one key is one of:
//   {"read":k}          the key read (tracked in a run), its value (the one kept, no copy); none: null
//   {"sum":[e..]}       added, numbers only; null is 0; none: 0; anything else an error
//   {"mod":[a,b]}       a mod b, numbers only; null is 0; b 0 an error; anything else an error
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
//   {"current":null}    what is open: {"scope":s,"info":{..},"writer"?:c}, the computation
//                       of the writer; nothing: null
//   {"cleanup":[s,e]}   e when s is cleaned up; s null: the scope open; null
//   {"effect":[c,f,act,early?]}  an effect c made under the scope open (in an act: its effect),
//                       as the effect request's; early true: early. null. c old under the scope
//                       open (made by an earlier run of it): claimed, its f and act these (early
//                       or not as it was made; a claim is no making: it runs in the round, mine).
//                       c a compute (made again as the other kind): it becomes this effect (chee
//                       10-18: "Swap kind too"), early as this form says; the same computation,
//                       its last result forgotten (its next acted on, equal or not), the writer of
//                       nothing; a compute's own cleanups are set aside at its next run as ever.
//                       c taken by one gone, or old elsewhere: taken over
//   {"compute":[c,f,to?]}  a compute c made under the scope open, f its code, its results kept at
//                       to and marked as the compute request's; null. claimed and taken over as
//                       the effect form's; c an effect: it becomes this compute, its last result
//                       forgotten (its next given to set, equal or not), an act queued dropped,
//                       what its last act made old at its next run, the cleanups made in that act
//                       set aside with its own then (run once that run is done, as a replaced
//                       function's)
//   {"dispose":s}       s disposed; null
//   {"quote":x}         x as it is
import {
	type As,
	type Computer,
	createScheduler,
	type Info,
	PENDING,
	type Run,
	SchedulerError,
	type Scope,
} from "@ermine/scheduler"
import { type Told, trace } from "./trace.ts"
import { serve } from "../../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../../conformance/typescript/form.ts"

type Json = unknown
type Request = { op: string; [k: string]: Json }

const store = new Map<string, Json>()
let logged: Json[] = []
// as told; named when asked (a new computer is due before it has a name)
// a run's body returned (onRunReturn): not trace's, shown when asked
type Returns = { returns: Computer; run: number }
// a pulse ended (onAfterPulse): shown when asked
type Pulsed = { pulsed: true }
let moments: (Told | Returns | Pulsed)[] = []
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

function moment(m: Told | Returns | Pulsed, reads: boolean): Json {
	if ("pulsed" in m) return { pulsed: true }
	if ("returns" in m) return { returns: nameOf(m.returns), run: m.run }
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
let pulsing = false
// a listener armed to throw, once: which, at what (a computation's name, or a key), its message
let armed: { on: string; at?: string; error: string } | undefined
const LISTENERS = [
	"mark",
	"starts",
	"returns",
	"ends",
	"acts",
	"forgotten",
	"started",
	"settles",
	"pulsed",
]
function fire(on: string, at: () => string[]) {
	if (armed?.on !== on || (armed.at !== undefined && !at().includes(armed.at))) return
	const e = armed.error
	armed = undefined
	throw new Error(e)
}
const s = createScheduler()
trace(s, (m) => {
	moments.push(m)
	if (pulsing && ++told > ENDLESS) throw new Error("endless")
	if ("starts" in m) fire("starts", () => [nameOf(m.starts)])
	else if ("ends" in m) fire("ends", () => [nameOf(m.ends)])
	else if ("acts" in m) fire("acts", () => [nameOf(m.acts)])
})
s.onRunReturn((c, n) => {
	moments.push({ returns: c, run: n })
	fire("returns", () => [nameOf(c)])
})
s.onAfterPulse(() => {
	moments.push({ pulsed: true })
	fire("pulsed", () => [])
})
s.onTrackingEnd((key) => {
	forgotten.push(key)
	fire("forgotten", () => [key as string])
})
s.onTrackingStart((key) => {
	started.push(key)
	fire("started", () => [key as string])
})
s.onSettle(() => fire("settles", () => []))
// the tick of the latest mark (each mark and each new computer takes the next)
let tick = 0
s.onMark((keys, _run, _due, t) => {
	tick = t
	fire("mark", () => keys as string[])
})

// the names of the computers being made: taken till named (what an early one's run makes under
// the same name is refused, so a name is never held twice: mine)
const naming = new Set<string>()
// a computer made by f and named n (what a listener threw meanwhile comes out of a pulse: the
// scheduler's). given: told it
function making(n: string, f: () => Computer, given: (c: Computer) => void): Computer {
	naming.add(n)
	let c: Computer
	try {
		c = f()
	} finally {
		naming.delete(n)
	}
	given(c)
	name(c, n)
	return c
}

// a name taken (by one being made, or one not torn down and not old: else taken over) is refused
// before anything is made
function vacant(n: string) {
	const o = named.get(n)
	if (naming.has(n) || o?.state === "alive" && !o.old) throw new Error(`name taken: ${n}`)
}

// each computation's code, in place: a claim gives it new code
const codes = new Map<Computer, { f: Json; act?: Json }>()

// the computation n, old under the scope open, claimed and given new code: true. else false. made
// again as the other kind (as: what it becomes, given the computer): it takes that kind too
function claimed(
	n: string,
	code: { f: Json; act?: Json },
	kind: "compute" | "effect",
	as: (c: Computer) => As,
): boolean {
	const o = named.get(n)
	if (o === undefined || !("kind" in o) || !o.old) return false
	if (o.parent !== s.getCurrentScope()) return false
	const c = o as Computer
	codes.set(c, code)
	return s.claim(c, c.kind === kind ? undefined : as(c))
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

// what is open, by name: the scope, its info as it is now, and the computer of the run; nothing:
// null
function current(): Json {
	const o = s.getCurrentScope()
	if (o === undefined) return null
	const out: Record<string, Json> = {
		scope: names.get(o) ?? null,
		info: { ...s.getInfo()! } as Json,
	}
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

// a number for sum and mod: null is 0; anything else not a number an error
function num(v: unknown): number {
	if (v === null || v === undefined) return 0
	if (typeof v !== "number") throw new Error("not a number")
	return v
}

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
		case "mod": {
			const x = num(evaluate(a[0], ctx))
			const y = num(evaluate(a[1], ctx))
			if (y === 0) throw new Error("mod by 0")
			return x % y
		}
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
			// the writer first: one not there writes nothing
			const by = a.length < 3
				? runOf(ctx)
				: a[2] === "open"
				? s.getRun()
				: a[2] === null
				? undefined
				: computation(a[2])
			keep(k, v)
			s.mark([k], by)
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
		case "scope": {
			// the scope under first, then the name
			const up = a[2] === undefined ? undefined : scope(a[2])
			vacant(a[0] as string)
			name(s.createScope((a[1] ?? {}) as Info, up), a[0] as string)
			return null
		}
		case "within":
			return s.runWithScope(
				s.createScope((a[0] ?? {}) as Info),
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
			if (typeof a[0] !== "string") throw new Error("a effect with no name")
			const code = { f: a[1], act: a[2] }
			const as = (c: Computer): As => ({
				kind: "effect",
				f: (previous) =>
					evaluate(codes.get(c)!.f, { run: s.getRun(), self: c, previous: previous as Json }),
				effect: (value, previous) =>
					void evaluate(codes.get(c)!.act, { self: c, value, previous }),
				early: a[3] === true,
			})
			if (claimed(a[0] as string, code, "effect", as)) return null
			vacant(a[0] as string)
			let made: Computer | undefined
			const self = () => made ?? s.getCurrentScope()!
			const now = () => made ? codes.get(made)! : code
			making(a[0] as string, () =>
				s.createEffect(
					(previous) =>
						evaluate(now().f, { run: s.getRun(), self: self(), previous: previous as Json }),
					(value, previous) => void evaluate(now().act, { self: self(), value, previous }),
					undefined,
					a[3] === true ? { early: true } : undefined,
				), (c) => {
				made = c
				codes.set(c, code)
			})
			return null
		}
		case "compute": {
			const [n, f, to] = a as [string, Json, string | undefined]
			if (typeof n !== "string") throw new Error("a compute with no name")
			const code = { f }
			const as = (c: Computer): As => ({
				kind: "compute",
				f: (previous) =>
					evaluate(codes.get(c)!.f, { run: s.getRun(), self: c, previous: previous as Json }),
				set: (v) => {
					if (to === undefined) return
					keep(to, v)
					s.mark([to], c)
				},
			})
			if (claimed(n, code, "compute", as)) return null
			vacant(n)
			let c: Computer
			making(n, () =>
				s.createComputer(
					(previous) =>
						evaluate(codes.get(c)!.f, {
							run: s.getRun(),
							self: c,
							previous: previous as Json,
						}),
					(v) => {
						if (to === undefined) return
						keep(to, v)
						s.mark([to], c)
					},
				), (x) => {
				c = x
				codes.set(x, code)
			})
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
			name(s.createRootScope((r.info ?? {}) as Info), r.name as string)
			return {}
		case "scope": {
			// the scope under first, then the name
			const up = r.parent === undefined ? undefined : scope(r.parent)
			vacant(r.name as string)
			const info = (r.info ?? {}) as Info
			name(s.createScope(info, up), r.name as string)
			return {}
		}
		case "compute": {
			const o = scope(r.scope)
			vacant(r.name as string)
			const to = r.to as string | undefined
			let c: Computer
			making(r.name as string, () =>
				s.runWithScope(o, () =>
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
						r.info as Info | undefined,
					)), (x) => c = x)
			return {}
		}
		case "effect": {
			const o = scope(r.scope)
			vacant(r.name as string)
			// an early one runs and acts before it is given back: itself, the scope open then
			let made: Computer | undefined
			const self = () => made ?? s.getCurrentScope()!
			making(r.name as string, () =>
				s.runWithScope(o, () =>
					s.createEffect(
						program(r, self),
						(value, previous) => void evaluate(r.act, { self: self(), value, previous }),
						r.equal === "json" ? json : undefined,
						r.early === true ? { early: true } : undefined,
						r.info as Info | undefined,
					)), (c) => made = c)
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
			const v = s.runWithScope(o, () => evaluate(r.do, { self: o }))
			// PENDING or a promise: no value
			if (v === PENDING || v instanceof Promise) return {}
			return { value: v ?? null }
		}
		case "current":
			return { value: current() }
		case "write": {
			const values = r.values as Record<string, Json>
			// as values: "/" forms read, -0 is 0, a bigint JS holds exactly its number; given back in
			// their JSON form (get)
			for (const [k, v] of Object.entries(values)) keep(k, revive(v) as Json)
			return { tick: s.mark(Object.keys(values)) }
		}
		case "changed": {
			const keys = r.keys as Json[]
			if (!keys.every((k) => typeof k === "string")) throw new Error("a key not a string")
			return { tick: s.mark(keys) }
		}
		case "pulse":
			told = 0
			pulsing = true
			try {
				s.pulse()
			} finally {
				pulsing = false
			}
			return {}
		case "listener":
			if (!LISTENERS.includes(r.on as string)) throw new Error(`unknown listener ${r.on}`)
			armed = { on: r.on as string, error: r.throw as string }
			if (r.at !== undefined) armed.at = r.at as string
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
			return { value: toJson(store.get(r.key as string) ?? null) }
		case "log": {
			const out = logged
			logged = []
			return { log: out }
		}
		case "moments": {
			const out = moments.filter((m) =>
				(r.returns === true || !("returns" in m)) && (r.pulses === true || !("pulsed" in m))
			)
				.map((m) => moment(m, r.reads === true))
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
