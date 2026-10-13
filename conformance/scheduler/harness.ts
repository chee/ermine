// The reference scheduler on the line protocol: one JSON request per line in, one answer per line
// out, in order. Another implementation joins by speaking this (SCHEDULER_HARNESS).
//
// The harness plays the host: it keeps a value at each key, and when a compute's result is set
// it writes it at the compute's key (to) and says changed([to]), as ermine.ts will. Owners and
// computations share one namespace of names. Keys are strings.
//
//   {"op":"owner","name":o,"parent"?:p}                                              → {}
//   {"op":"compute","name":c,"owner":o,"f":e,"to"?:k,"equal"?:"json"}               → {}
//   {"op":"effect","name":c,"owner":o,"f":e,"act":e,"equal"?:"json"}                → {}
//        f: evaluated in each run. act: evaluated in each act, given value and previous.
//        equal "json": results compared by their JSON; else Object.is
//   {"op":"cleanup","owner":o,"do":e}                                                → {}
//   {"op":"dispose","owner":o}                                                       → {}
//   {"op":"run","owner":o,"do":e}                    e in run(owner): untracked  → {"value":v}
//   {"op":"write","values":{k:v...}}    each kept at its key, then changed(keys) → {"tick":t}
//   {"op":"changed","keys":[k...]}                                            → {"tick":t}
//   {"op":"pulse"}                                                                   → {}
//   {"op":"resolve","promise":p,"value":v}  the promise p made settles, and lands  → {}
//   {"op":"reject","promise":p,"error":s}                                            → {}
//   {"op":"get","key":k}                     the value kept at k; none: null     → {"value":v}
//   {"op":"log"}            what programs logged since last asked, then forgotten → {"log":[..]}
//   {"op":"moments"}        the moments since last asked, then forgotten     → {"moments":[..]}
//   {"op":"tick"}                                                             → {"tick":t}
//
// a moment, computations by name, an error as below:
//   {"due":c,"tick":t}  {"starts":c,"run":n,"rank":r}  {"acts":c,"run":n,"error"?:s}
//   {"ends":c,"run":n,"ended":"done"|"pending"|"failed"|"stopped"|"looping","equal"?:b,
//    "error"?:s,"waits"?:c,"through"?:[c..]}
// an error: a scheduler error's code ("stopped", "disposed"), else its message. a request that
// fails answers {"error":s}, and the harness goes on.
//
// an expression e: a number, string, boolean or null is itself; a list, its members evaluated;
// a map of one key is one of:
//   {"read":k}          the key read (tracked in a run), its value; none: null
//   {"sum":[e..]}       added; null is 0        {"mod":[a,b]}    a mod b; null is 0
//   {"eq":[a,b]}        equal by JSON           {"if":[test,then,else]}   test true, then, else else
//   {"given":"value"}  {"given":"previous"}   in an act: its value, and the one acted on before
//   {"log":e}           e logged; e             {"do":[e..]}     each in order; the last
//   {"write":[k,e]}     e kept at k, then changed([k]); e
//   {"throw":s}         throws an error of message s
//   {"pending":null}    the compute's run ends pending
//   {"wait":[p]}        a promise named p (evaluated), settled by resolve or reject; what it resolves to
//   {"wait":[p,e]}      the same, then e evaluated after the await; e
//   {"run":e}           e in run(the computation): untracked
//   {"cleanup":[o,e]}   e when o is cleaned up; null      {"dispose":o}   o disposed; null
//   {"quote":x}         x as it is
import {
	type Computation,
	createScheduler,
	type Moment,
	type Owner,
	PENDING,
	type Read,
	SchedulerError,
} from "@ermine/scheduler"

type Json = unknown
type Request = { op: string; [k: string]: Json }

const store = new Map<string, Json>()
let logged: Json[] = []
// as told; named when asked (a new computation is due before it has a name)
let moments: Moment[] = []
const named = new Map<string, Owner>()
const names = new Map<Owner, string>()
const promises = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

const errorOf = (e: unknown): string =>
	e instanceof SchedulerError ? e.code : e instanceof Error ? e.message : String(e)
const nameOf = (c: Computation) => names.get(c)!

function moment(m: Moment): Json {
	if ("due" in m) return { due: nameOf(m.due), tick: m.tick }
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
	return out
}

const s = createScheduler({ hook: (m) => void moments.push(m) })

function name(o: Owner, n: string) {
	if (named.has(n)) throw new Error(`name taken: ${n}`)
	named.set(n, o)
	names.set(o, n)
}
function owner(n: Json): Owner {
	const o = named.get(n as string)
	if (!o) throw new Error(`no owner ${n}`)
	return o
}

function keep(key: string, v: Json) {
	if (v === undefined) store.delete(key)
	else store.set(key, v)
}

// what an expression is evaluated in: the run's read, the computation, an act's values
type Ctx = { read?: Read; self?: Owner; value?: Json; previous?: Json }

const num = (v: Json) => (v === null || v === undefined ? 0 : v as number)

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
			s.changed([k])
			return v
		}
		case "throw":
			throw new Error(arg as string)
		case "pending":
			return PENDING
		case "wait": {
			const p = evaluate(a[0], ctx) as string
			const promise = new Promise((resolve, reject) => promises.set(p, { resolve, reject }))
			return a.length > 1 ? promise.then(() => evaluate(a[1], ctx)) : promise
		}
		case "run":
			return s.run(ctx.self!, () => evaluate(arg, { ...ctx, read: undefined }))
		case "cleanup":
			s.cleanup(owner(a[0]), () => evaluate(a[1], { ...ctx, read: undefined }))
			return null
		case "dispose":
			s.dispose(owner(arg))
			return null
		case "quote":
			return arg
		default:
			throw new Error(`unknown form ${form}`)
	}
}

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// a computation's f, as the program: evaluated with its run's read
function program(r: Request, self: () => Owner) {
	return (read: Read) => evaluate(r.f, { read, self: self() })
}

async function run(r: Request): Promise<Json> {
	switch (r.op) {
		case "owner": {
			const o = s.owner(r.parent === undefined ? undefined : owner(r.parent))
			name(o, r.name as string)
			return {}
		}
		case "compute": {
			const to = r.to as string | undefined
			const c: Computation = s.compute(
				owner(r.owner),
				program(r, () => c),
				(v) => {
					if (to === undefined) return
					keep(to, v)
					s.changed([to])
				},
				r.equal === "json" ? json : undefined,
			)
			name(c, r.name as string)
			return {}
		}
		case "effect": {
			const c: Computation = s.effect(
				owner(r.owner),
				program(r, () => c),
				(value, previous) => void evaluate(r.act, { self: c, value, previous }),
				r.equal === "json" ? json : undefined,
			)
			name(c, r.name as string)
			return {}
		}
		case "cleanup": {
			const o = owner(r.owner)
			s.cleanup(o, () => evaluate(r.do, { self: o }))
			return {}
		}
		case "dispose":
			s.dispose(owner(r.owner))
			return {}
		case "run": {
			const o = owner(r.owner)
			return { value: s.run(o, () => evaluate(r.do, { self: o })) ?? null }
		}
		case "write": {
			const values = r.values as Record<string, Json>
			for (const [k, v] of Object.entries(values)) keep(k, v)
			return { tick: s.changed(Object.keys(values)) }
		}
		case "changed":
			return { tick: s.changed(r.keys as string[]) }
		case "pulse":
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
			const out = moments.map(moment)
			moments = []
			return { moments: out }
		}
		case "tick":
			return { tick: s.tick() }
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

async function answer(r: Request): Promise<Json> {
	try {
		return await run(r)
	} catch (e) {
		return { error: errorOf(e) }
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		text += JSON.stringify(await answer(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
