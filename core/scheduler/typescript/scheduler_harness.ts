// The scheduler on the line protocol (conformance/typescript/harness.ts): one JSON request per line
// in, one answer per line out, in order. Another implementation joins by speaking this (HARNESS).
//
// The harness plays the host: it keeps a value at each key, and when a compute's result is set
// it writes it at the compute's key (to) and says changed([to], the compute), as ermine.ts will.
// Scopes and computations share one namespace of names. Keys are strings. A change the harness
// makes in a computation's code names that computation as by (a write in a run: the run's own
// read); the host's own (write, changed) name none. info: a scope's pairs, [[key, value]..]
//
//   {"op":"root","name":s,"info"?:pairs}                                             → {}
//   {"op":"scope","name":s,"info"?:pairs,"parent"?:p}  under p; none: under the one open
//   {"op":"compute","name":c,"scope":s,"f":e,"to"?:k,"equal"?:"json","declared"?:true} → {}
//        made with s open
//        declared: to is also given to the scheduler as the compute's key, its writer from the
//        start (compute's key argument)
//   {"op":"effect","name":c,"scope":s,"f":e,"act":e,"equal"?:"json"}                → {}
//        f: evaluated in each run. act: evaluated in each act, given value and previous.
//        equal "json": results compared by their JSON; else Object.is
//   {"op":"cleanup","scope":s,"do":e}                e when s is cleaned up    → {}
//   {"op":"dispose","scope":s}                                                       → {}
//   {"op":"run","scope":s,"do":e}                    e in run(s): untracked    → {"value":v}
//   {"op":"write","values":{k:v...}}    each kept at its key, then changed(keys) → {"tick":t}
//   {"op":"changed","keys":[k...]}                                            → {"tick":t}
//   {"op":"pulse"}                                                                   → {}
//        a pulse past 10000 moments is endless: it is left, and answers {"error":"endless"}
//   {"op":"resolve","promise":p,"value":v}  the promise p made settles, and lands  → {}
//   {"op":"reject","promise":p,"error":s}                                            → {}
//   {"op":"get","key":k}                     the value kept at k; none: null     → {"value":v}
//   {"op":"log"}            what programs logged since last asked, then forgotten → {"log":[..]}
//   {"op":"moments"}        the moments since last asked, then forgotten     → {"moments":[..]}
//   {"op":"moments","reads":true}   the same, an ends moment with its reads
//   {"op":"forgotten"}  the keys the scheduler stopped tracking (its forget) since last asked
//                                                                             → {"keys":[k...]}
//   {"op":"tick"}                                                             → {"tick":t}
//   {"op":"current"}   what is open, as the form current shows it              → {"value":v}
//
// a moment, computations by name, an error as below:
//   {"due":c,"tick":t,"by"?:c}  {"starts":c,"run":n,"rank":r}  {"acts":c,"run":n,"error"?:s}
//   {"ends":c,"run":n,"ended":"done"|"pending"|"failed"|"stopped"|"looping","equal"?:b,
//    "error"?:s,"waits"?:c,"through"?:[c..],"reads"?:[k..]}   reads: when asked for
// an error: a scheduler error's code ("stopped", "disposed"), "pending" for a thrown PENDING,
// else its message. a request that fails answers {"error":s}, and the harness goes on.
//
// an expression e: a number, string, boolean or null is itself; a list, its members evaluated;
// a map of one key is one of:
//   {"read":k}          the key read (tracked in a run), its value; none: null
//   {"sum":[e..]}       added; null is 0        {"mod":[a,b]}    a mod b; null is 0
//   {"eq":[a,b]}        equal by JSON           {"if":[test,then,else]}   test true, then, else else
//   {"given":"value"}  {"given":"previous"}   in an act: its value, and the one acted on before
//   {"log":e}           e logged; e             {"do":[e..]}     each in order; the last
//   {"write":[k,e]}     e kept at k, then changed([k], by); e. by: in a run (after an await
//                       too), the run's own read; in a set, act, cleanup or run(), the
//                       computation; else none
//   {"write":[k,e,null]}  the same, said with no by: from outside
//   {"write":[k,e,"open"]}  the same, by the writer open (current().by)
//   {"throw":e}         e evaluated: PENDING (below) is thrown as itself, anything else as an
//                       error of message e
//   {"pending":null}    PENDING: returned by f, the compute's run ends pending; thrown, the same
//   {"wait":[p]}        a promise named p (evaluated), settled by resolve or reject; what it resolves to
//   {"wait":[p,e]}      the same, then e evaluated after the await; e
//   {"run":e}           e in run(the computation): untracked
//   {"in":[s,e]}        e in run(s): untracked
//   {"scope":[s,info,p?]}  s made under p, else under the one open; null
//   {"within":[info,e]}  e in run(a new scope of info, under the one open, unnamed): untracked
//   {"current":null}    what is open: {"scope":s,"pairs":[[k,v]..],"by"?:c}, by the computation
//                       of the writer; nothing: null
//   {"cleanup":[s,e]}   e when s is cleaned up; s null: the scope open; null
//   {"dispose":s}       s disposed; null
//   {"quote":x}         x as it is
import {
	type By,
	type Computation,
	createScheduler,
	type Moment,
	type Pair,
	PENDING,
	type Read,
	SchedulerError,
	type Scope,
} from "@ermine/scheduler"
import { serve } from "../../../conformance/typescript/harness.ts"

type Json = unknown
type Request = { op: string; [k: string]: Json }

const store = new Map<string, Json>()
let logged: Json[] = []
// as told; named when asked (a new computation is due before it has a name)
let moments: Moment[] = []
let forgotten: unknown[] = []
const named = new Map<string, Scope>()
const names = new Map<Scope, string>()
// each run's own read, to its computation's name
const readers = new WeakMap<Read, string>()
const promises = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

const errorOf = (e: unknown): string =>
	e instanceof SchedulerError
		? e.code
		: e === PENDING
		? "pending"
		: e instanceof Error
		? e.message
		: String(e)
const nameOf = (c: Computation) => names.get(c)!

function moment(m: Moment, reads: boolean): Json {
	if ("due" in m) {
		return m.by ? { due: nameOf(m.due), tick: m.tick, by: nameOf(m.by) } : {
			due: nameOf(m.due),
			tick: m.tick,
		}
	}
	if ("starts" in m) return { starts: nameOf(m.starts), run: m.run, rank: m.rank }
	if ("acts" in m) {
		const out: Record<string, Json> = { acts: nameOf(m.acts), run: m.run }
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
const s = createScheduler({
	hook: (m) => {
		moments.push(m)
		if (++told > ENDLESS) throw new Error("endless")
	},
	forget: (key) => void forgotten.push(key),
})

function name(o: Scope, n: string) {
	if (named.has(n)) throw new Error(`name taken: ${n}`)
	named.set(n, o)
	names.set(o, n)
}
function scope(n: Json): Scope {
	const o = named.get(n as string)
	if (!o) throw new Error(`no scope ${n}`)
	return o
}

// what is open, by name; nothing: null
function current(): Json {
	const open = s.current()
	if (open === undefined) return null
	const out: Record<string, Json> = { scope: names.get(open.scope) ?? null, pairs: open.pairs }
	const by = open.by === undefined
		? undefined
		: typeof open.by === "function"
		? readers.get(open.by)
		: names.get(open.by)
	if (by !== undefined) out.by = by
	return out
}

function keep(key: string, v: Json) {
	if (v === undefined) store.delete(key)
	else store.set(key, v)
}

// what an expression is evaluated in: the run's read, the computation, an act's values
type Ctx = { read?: Read; self?: Scope; value?: Json; previous?: Json }

const num = (v: Json) => (v === null || v === undefined ? 0 : v as number)

// who a change in this code is by: the run's own read, else the computation
const byOf = (ctx: Ctx): By | undefined =>
	ctx.read ?? (ctx.self && "kind" in ctx.self ? ctx.self as Computation : undefined)

function evaluate(e: Json, ctx: Ctx): unknown {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map((x) => evaluate(x, ctx))
	const [form, arg] = Object.entries(e as Record<string, Json>)[0] ?? []
	const a = arg as Json[]
	switch (form) {
		case "read": {
			const k = evaluate(arg, ctx) as string
			if (ctx.read) ctx.read(k)
			else s.read(k)
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
			s.changed([k], a.length < 3 ? byOf(ctx) : a[2] === "open" ? s.current()?.by : undefined)
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
			return s.run(ctx.self!, () => evaluate(arg, { ...ctx, read: undefined }))
		case "in":
			return s.run(scope(a[0]), () => evaluate(a[1], { ...ctx, read: undefined }))
		case "scope":
			name(s.scope(a[1] as Pair[], a[2] === undefined ? undefined : scope(a[2])), a[0] as string)
			return null
		case "within":
			return s.run(s.scope(a[0] as Pair[]), () => evaluate(a[1], { ...ctx, read: undefined }))
		case "current":
			return current()
		case "cleanup": {
			// on the scope open when it is the one named (or none is), else with that one open
			const f = () => evaluate(a[1], { ...ctx, read: undefined })
			if (a[0] === null) {
				s.cleanup(f)
				return null
			}
			const o = scope(a[0])
			if (s.current()?.scope === o) s.cleanup(f)
			else s.run(o, () => s.cleanup(f))
			return null
		}
		case "dispose":
			s.dispose(scope(arg))
			return null
		case "quote":
			return arg
		default:
			throw new Error(`unknown form ${form}`)
	}
}

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// a computation's f, as the program: evaluated with its run's read
function program(r: Request, self: () => Scope) {
	return (read: Read) => {
		readers.set(read, r.name as string)
		return evaluate(r.f, { read, self: self() })
	}
}

async function run(r: Request): Promise<Json> {
	switch (r.op) {
		case "root":
			name(s.root(r.info as Pair[] | undefined), r.name as string)
			return {}
		case "scope": {
			const info = r.info as Pair[] | undefined
			name(s.scope(info, r.parent === undefined ? undefined : scope(r.parent)), r.name as string)
			return {}
		}
		case "compute": {
			const to = r.to as string | undefined
			const c: Computation = s.run(scope(r.scope), () =>
				s.compute(
					program(r, () => c),
					(v) => {
						if (to === undefined) return
						keep(to, v)
						s.changed([to], c)
					},
					r.equal === "json" ? json : undefined,
					r.declared === true ? to : undefined,
				))
			name(c, r.name as string)
			return {}
		}
		case "effect": {
			const c: Computation = s.run(scope(r.scope), () =>
				s.effect(
					program(r, () => c),
					(value, previous) => void evaluate(r.act, { self: c, value, previous }),
					r.equal === "json" ? json : undefined,
				))
			name(c, r.name as string)
			return {}
		}
		case "cleanup": {
			const o = scope(r.scope)
			s.run(o, () => s.cleanup(() => evaluate(r.do, { self: o })))
			return {}
		}
		case "dispose":
			s.dispose(scope(r.scope))
			return {}
		case "run": {
			const o = scope(r.scope)
			return { value: s.run(o, () => evaluate(r.do, { self: o })) ?? null }
		}
		case "current":
			return { value: current() }
		case "write": {
			const values = r.values as Record<string, Json>
			for (const [k, v] of Object.entries(values)) keep(k, v)
			return { tick: s.changed(Object.keys(values)) }
		}
		case "changed":
			return { tick: s.changed(r.keys as string[]) }
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
		case "tick":
			return { tick: s.tick() }
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
