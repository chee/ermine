// The scheduler on the line protocol (conformance/typescript/harness.ts): one JSON request per
// line in, one answer per line out. HARNESS names another implementation that speaks it.
// The harness plays the host. It keeps a value at each key; a compute's result is written at its
// key (to) and told as changed([to], the compute). Scopes and computations share one namespace
// of names. A change made in a computation's code names it as the writer; the host's own write
// and changed name none. Ticks: each mark and each new computation takes the next, from 1.
//
// Requests (info is an object; the answer is {} unless shown):
//   {"op":"root","name":s,"info"?:info}    {"op":"scope","name":s,"info"?:info,"parent"?:p}
//   {"op":"compute","name":c,"scope":s,"f":e,"to"?:k,"equal"?:"json","declared"?:true,"set"?:e,
//    "info"?:info}   declared: to is also the compute's key. set: given the result as value.
//   {"op":"effect","name":c,"scope":s,"f":e,"act":e,"equal"?:"json","early"?:true,"info"?:info}
//       act is given value and previous. early: runs and acts within the request.
//       equal "json" compares by JSON (0 and -0 equal), else Object.is.
//   {"op":"cleanup","scope":s,"do":e}     {"op":"dispose","scope":s}  runs cleanups, throws the first
//   {"op":"retain","scope":s}   {"op":"release","scope":s}
//   {"op":"run","scope":s,"do":e}    e untracked in run(s)      -> {"value":v} ({} if PENDING)
//   {"op":"write","values":{k:v...}}   keep each, then changed(keys)  -> {"tick":t}
//   {"op":"changed","keys":[k...]}     one mark of all the keys        -> {"tick":t}
//   {"op":"pulse"}   past 10000 moments it is left and answers {"error":"endless"}
//   {"op":"resolve","promise":p,"value":v}   {"op":"reject","promise":p,"error":s}
//       lands at the next pulse; settling twice is "no promise p".
//   {"op":"get","key":k} -> {"value":v} (null if none)    {"op":"log"} -> {"log":[..]}
//   {"op":"moments","reads"?:true,"returns"?:true,"pulses"?:true} -> {"moments":[..]}
//   {"op":"forgotten"} / {"op":"started"} -> {"keys":[k...]}  untracked / first-tracked since asked
//   {"op":"tick"} -> {"tick":t}     {"op":"current"} -> {"value":v}  what is open
//   {"op":"listener","on":l,"throw":s,"at"?:x}   throws s once the next time l is told (of x).
//       l: "mark" (x a key), "starts", "returns", "ends", "acts" (x a computation), "forgotten",
//       "started" (x a key), "settles", "pulsed". Else "unknown listener l".
// A listener's or cleanup's error is held until what was going on finishes, then comes out as the
// request's error. One with nothing to throw to (a promise settling) comes out of a pulse.
//
// Moments (computations by name), as told; asked-for ones are marked:
//   {"due":c,"tick":t,"writer"?:c}  {"starts":c,"run":n,"rank":r}  {"acts":c,"run":n,"early"?:true,"error"?:s}
//   {"ends":c,"run":n,"ended":"done"|"pending"|"failed"|"stopped"|"looping","equal"?:b,
//    "error"?:s,"waits"?:c,"through"?:[c..],"reads"?:[k..]}      reads: when asked for
//   {"returns":c,"run":n}  {"pulsed":true}      when asked for (pulsed is not counted toward 10000)
//
// Errors: {"error":s}, and the harness goes on. s is a scheduler error's code ("disposed",
// "unscoped", "empty"), "pending" for a thrown PENDING, else the message. The harness's own are
// "unknown op o", "unknown form f", "no scope s", "no promise p", "name taken: s", "a effect with
// no name" and "a compute with no name". A making checks the scope first, then the name.
//
// Expressions: a number, string, boolean or null is itself; a list evaluates its members; a map
// of one key is one of:
//   {"read":k} tracked, null if none    {"sum":[e..]} null is 0    {"mod":[a,b]} b 0 is an error
//   {"eq":[a,b]} by JSON    {"if":[test,then,else]}    {"log":e} log e, give e
//   {"given":"value"} {"given":"previous"}   in an act; in a run, "previous" is the last result
//   {"do":[e..]} the last (null if none)    {"throw":e} PENDING as itself, a string as an error
//   {"write":[k,e]} keep e at k, then changed([k], writer); writer: the run in a run, the
//       computation in a set, act or cleanup, else none. [k,e,null] none, [k,e,"open"] the writer
//       open, [k,e,c] by c.
//   {"pending":null} PENDING    {"wait":[p]} / {"wait":[p,e]} a promise named p, e after the await
//   {"steps":[e..]} a generator compute's body; {"yield":p} yields promise p    {"await":p}
//   {"run":e} e untracked in run(the computation)   {"in":[s,e]} e untracked in run(s)
//   {"scope":[s,info,p?]} made under p, else the one open    {"within":[info,e]}
//   {"current":null} {"scope":s,"info":{..},"writer"?:c}, or null
//   {"cleanup":[s,e]} s null is the scope open    {"dispose":s}    {"quote":x} x as it is
//   {"effect":[c,f,act,early?]} / {"compute":[c,f,to?]} under the scope open; an old c is claimed
//       with the new code, and one of the other kind becomes this kind.
import {
	type As,
	type Computer,
	createScheduler,
	type Ended,
	type Info,
	PENDING,
	type Run,
	type Scheduler,
	SchedulerError,
	type Scope,
} from "@ermine/reactivity"
import { serve } from "../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../conformance/typescript/form.ts"

// The recorder, also used by the tests: turns the scheduler's hooks into one ordered list.
export type Told =
	| { due: Computer; tick: number; by?: Computer }
	| { starts: Computer; run: number; rank: number }
	| {
		ends: Computer
		run: number
		ended: Ended
		reads: readonly unknown[]
		equal?: boolean
		error?: unknown
		waits?: Computer
		through?: Computer[]
	}
	| { acts: Computer; run: number; early?: true; error?: unknown }

export function trace(
	s: Pick<Scheduler, "onMark" | "onRunStart" | "onRunEnd" | "onEffect">,
	f: (told: Told) => void,
): () => void {
	const offs = [
		s.onMark((_, run, due, tick) => {
			for (const c of due) f(run ? { due: c, tick, by: run.computer } : { due: c, tick })
		}),
		s.onRunStart((c, n, rank) => f({ starts: c, run: n, rank })),
		s.onRunEnd((c, n, ended, reads, more) => {
			const t: Told = { ends: c, run: n, ended, reads }
			if (more.equal !== undefined) t.equal = more.equal
			if ("error" in more) t.error = more.error
			if (more.waits) t.waits = more.waits
			if (more.through) t.through = more.through
			f(t)
		}),
		s.onEffect((c, n, more) => {
			const t: Told = { acts: c, run: n }
			if (c.early) t.early = true
			if ("error" in more) t.error = more.error
			f(t)
		}),
	]
	return () => {
		for (const off of offs) off()
	}
}

type Json = unknown
type Request = { op: string; [k: string]: Json }

const store = new Map<string, Json>()
let logged: Json[] = []
// Names are looked up when asked, since a new computer is due before it has a name.
type Returns = { returns: Computer; run: number }
type Pulsed = { pulsed: true }
let moments: (Told | Returns | Pulsed)[] = []
let forgotten: unknown[] = []
let started: unknown[] = []
const named = new Map<string, Scope>()
const names = new Map<Scope, string>()
const promises = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const made = new Map<string, Promise<unknown>>()

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

const ENDLESS = 10000
let told = 0
let pulsing = false
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
let tick = 0
s.onMark((keys, _run, _due, t) => {
	tick = t
	fire("mark", () => keys as string[])
})

// Names of computers being made are taken until named, so an early effect's run cannot reuse one.
const naming = new Set<string>()
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

function vacant(n: string) {
	const o = named.get(n)
	if (naming.has(n) || o?.state === "alive" && !o.old) throw new Error(`name taken: ${n}`)
}

const codes = new Map<Computer, { f: Json; act?: Json }>()

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

type Ctx = { run?: Run; self?: Scope; value?: Json; previous?: Json }

function num(v: unknown): number {
	if (v === null || v === undefined) return 0
	if (typeof v !== "number") throw new Error("not a number")
	return v
}

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
			made.set(p, promise)
			return a.length > 1 ? promise.then(() => evaluate(a[1], ctx)) : promise
		}
		case "steps": {
			const list = a
			return (function* () {
				let last: unknown = null
				for (const x of list) {
					if (x !== null && typeof x === "object" && !Array.isArray(x) && "yield" in x) {
						const p = evaluate((x as { yield: Json }).yield, ctx) as string
						const promise = new Promise((resolve, reject) =>
							promises.set(p, { resolve, reject })
						)
						made.set(p, promise)
						last = yield promise
					} else last = evaluate(x, ctx)
				}
				return last
			})()
		}
		case "await": {
			const p = evaluate(arg, ctx) as string
			const promise = made.get(p)
			if (promise === undefined) throw new Error(`no promise ${p}`)
			return promise
		}
		case "run":
			return s.runWithScope(ctx.self!, () => evaluate(arg, { ...ctx, run: undefined }))
		case "in":
			return s.runWithScope(scope(a[0]), () => evaluate(a[1], { ...ctx, run: undefined }))
		case "scope": {
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

// The run is taken at the start (getRun()) so a write after an await is still the run's.
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
		case "retain":
		case "release":
			scope(r.scope)
			return {}
		case "run": {
			const o = scope(r.scope)
			const v = s.runWithScope(o, () => evaluate(r.do, { self: o }))
			if (v === PENDING || v instanceof Promise) return {}
			return { value: v ?? null }
		}
		case "current":
			return { value: current() }
		case "write": {
			const values = r.values as Record<string, Json>
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
