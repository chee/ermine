// scheduler's streams: roots, scopes and computes driven by steps, checked against a model of the harness.
// deno-lint-ignore-file no-explicit-any
import { ordered } from "../typescript/json.ts"
import { line } from "../typescript/form.ts"
import {
	type Answer,
	differs,
	firsts,
	type Generator,
	picker,
	type Request,
	tricky,
	type Violation,
} from "./kit.ts"

const HOST = ["h0", "h1", "h2", "h3"]
const SINKS = ["x0", "x1"]
const STRS = ["t0", "t1"]
const PARTS = ["a", "xy", "é", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\u0000"]

const generator: Generator = {
	streams(seed, o) {
		const { pick, one } = picker(seed)
		const text = () => Array.from({ length: pick(4) }, () => one(PARTS)).join("")
		const out: Request[] = []
		const scopes: string[] = []
		const alive = new Set<string>()
		const promises: string[] = []
		for (let i = 0; i < 3; i++) {
			const name = `o${i}`
			scopes.push(name)
			alive.add(name)
			if (i === 0 || pick(2)) out.push({ op: "root", name, info: { actor: name } })
			else out.push({ op: "scope", name, parent: `o${pick(i)}`, info: { why: name } })
		}
		const values: Record<string, number | string> = {}
		for (const h of HOST) values[h] = pick(6)
		for (const t of STRS) values[t] = text()
		out.push({ op: "write", values })
		const strs = [...STRS]

		const keys = [...HOST]
		const read = () => ({ read: one(keys) })
		const expr = (depth: number): unknown => {
			const k = pick(depth > 0 ? 10 : 3)
			if (k < 2) return read()
			if (k < 3) return pick(4)
			if (k < 6) return { sum: Array.from({ length: 1 + pick(3) }, () => expr(depth - 1)) }
			if (k < 7) return { mod: [expr(depth - 1), 2 + pick(2)] }
			if (k < 9) {
				return { if: [{ eq: [{ mod: [read(), 2] }, 0] }, expr(depth - 1), expr(depth - 1)] }
			}
			return { if: [{ eq: [{ read: one(HOST) }, 5] }, { throw: "five" }, expr(depth - 1)] }
		}
		let computes = 0, effects = 0
		const compute = (scope: string) => {
			const name = `c${computes++}${one(["", "é", "\uD83D", "\uDE00", "\u0000"])}`
			const k = pick(11)
			if (k === 10) {
				const test = { eq: [{ read: one(strs) }, { quote: pick(2) ? text() : one(PARTS) }] }
				const f = { if: [test, { read: one(strs) }, pick(2) ? { read: one(strs) } : text()] }
				const r: Request = { op: "compute", name, scope, f, to: name }
				if (pick(5) === 0) r.equal = "json"
				out.push(r)
				alive.add(name)
				strs.push(name)
				return
			}
			let f = expr(2)
			if (k === 0) {
				const p = `p${name}`
				promises.push(p)
				f = pick(2) ? { wait: [p] } : { wait: [p, f] }
			} else if (k === 1) f = { do: [{ cleanup: [null, { log: ["undo", name] }] }, f] }
			else if (k === 2) f = { do: [{ log: ["run", name] }, f] }
			else if (k === 3) {
				const kid = `${name}k`
				const made = (n: number) =>
					pick(2)
						? {
							compute: [kid, {
								do: [{ cleanup: [null, { log: ["undo", kid, n] }] }, expr(1)],
							}, kid],
						}
						: { effect: [kid, { sum: [read(), n] }, { log: [kid, { given: "value" }] }] }
				const which = { if: [{ eq: [{ mod: [read(), 2] }, 0] }, made(0), made(1)] }
				f = { do: [{ if: [{ eq: [{ mod: [read(), 3] }, 0] }, null, which] }, f] }
			}
			const r: Request = { op: "compute", name, scope, f, to: name }
			if (pick(5) === 0) r.equal = "json"
			if (pick(8) === 0) r.declared = true
			if (pick(6) === 0) r.set = { log: ["set", name, { given: "value" }] }
			out.push(r)
			alive.add(name)
			keys.push(name)
		}
		const effect = (scope: string) => {
			const name = `e${effects++}`
			const words = pick(4) === 0
			const f = words ? { read: one(strs) } : { sum: Array.from({ length: 1 + pick(2) }, read) }
			const act = !words && pick(4) === 0
				? { write: [one(SINKS), { given: "value" }] }
				: { log: [name, { given: "value" }, { given: "previous" }] }
			const r: Request = { op: "effect", name, scope, f, act }
			if (pick(5) === 0) r.early = true
			if (pick(6) === 0) r.equal = "json"
			out.push(r)
			alive.add(name)
		}
		const living = (xs: string[]) => xs.filter((x) => alive.has(x))
		for (let i = 2 + pick(5); i > 0; i--) compute(one(scopes))
		for (let i = 1 + pick(3); i > 0; i--) effect(one(scopes))
		for (const x of SINKS) {
			out.push({
				op: "compute",
				name: `s${x}`,
				scope: "o0",
				f: { sum: [{ read: x }] },
				to: `s${x}`,
			})
		}
		const ask = () => {
			const k = pick(12)
			if (k < 4) out.push(pick(4) === 0 ? { op: "moments", reads: true } : { op: "moments" })
			else if (k < 6) out.push({ op: "log" })
			else if (k < 8) out.push({ op: "get", key: one(keys) })
			else if (k < 9) out.push({ op: "tick" })
			else if (k < 10) out.push({ op: "started" })
			else if (k < 11) out.push({ op: "forgotten" })
			else out.push({ op: "current" })
		}
		out.push({ op: "pulse" })
		ask()
		for (let step = 0; step < 14; step++) {
			const k = pick(20)
			if (k < 8) {
				const w: Record<string, number | string> = {}
				for (let i = 1 + pick(2); i > 0; i--) {
					if (pick(4)) w[one(HOST)] = pick(6)
					else w[one(STRS)] = text()
				}
				out.push({ op: "write", values: w })
			} else if (k < 9) out.push({ op: "changed", keys: [one(HOST), one(keys)] })
			else if (k < 11 && promises.length) {
				const p = one(promises)
				out.push(
					pick(4)
						? { op: "resolve", promise: p, value: pick(6) }
						: { op: "reject", promise: p, error: "no" },
				)
			} else if (k < 13) {
				const c = living([...keys.filter((x) => x.startsWith("c")), "e0", "e1", "e2"])
				if (c.length) {
					const x = one(c)
					alive.delete(x)
					out.push({ op: "dispose", scope: x })
				}
			} else if (k < 14) {
				const s = living(["o1", "o2"])
				if (s.length) {
					const x = one(s)
					alive.delete(x)
					out.push({ op: "dispose", scope: x })
				}
			} else if (k < 16) {
				const s = living(scopes)
				if (s.length) pick(2) ? compute(one(s)) : effect(one(s))
			} else if (k < 17) {
				const s = living(scopes)
				if (s.length) out.push({ op: "cleanup", scope: one(s), do: { log: ["cleanup", step] } })
			} else if (k < 18) {
				const s = living(scopes)
				if (s.length) {
					out.push({
						op: "run",
						scope: one(s),
						do: pick(2)
							? { sum: [read(), 1] }
							: { do: [{ write: [one(HOST), pick(6)] }, read()] },
					})
				}
			} else if (o.wild) {
				out.push(
					one<Request>([
						{ op: "changed", keys: [1] },
						{ op: "run", scope: "o0", do: { mod: [1, 0] } },
						{ op: "run", scope: "o0", do: { sum: ["a", 1] } },
						{ op: "run", scope: "o0", do: { write: ["h0", 1, "nobody"] } },
						{ op: "run", scope: "o0", do: { pending: null } },
						{ op: "run", scope: "o0", do: { wait: ["pw"] } },
						{
							op: "compute",
							name: `z${step}`,
							scope: "o0",
							f: { sum: [{ read: "h0" }, -0] },
							to: `z${step}`,
							equal: "json",
						},
					]),
				)
			}
			if (pick(5)) out.push({ op: "pulse" })
			ask()
			if (pick(2)) ask()
		}
		out.push({ op: "pulse" }, { op: "moments", reads: true }, { op: "log" })
		for (const c of [...keys, ...strs].filter((x) => x.startsWith("c"))) {
			out.push({ op: "get", key: c })
		}
		const names = tricky(seed, [...HOST, ...SINKS, ...STRS])
		return [names.size ? out.map((r) => renamed(r, names) as Request) : out]
	},
}
generator.invariant = invariant
export default generator

function renamed(x: unknown, names: Map<string, string>): unknown {
	if (typeof x === "string") return names.get(x) ?? x
	if (Array.isArray(x)) return x.map((v) => renamed(v, names))
	if (x === null || typeof x !== "object") return x
	const o = x as Record<string, unknown>
	return ordered(Object.keys(o).map((k) => [names.get(k) ?? k, renamed(o[k], names)]))
}

const UNKNOWN = Symbol("unknown")
const NONE = Symbol("none")
class Fail {}
class Unknown {}
class Pending {}

type Result = { ok: true; v: unknown } | { ok: false; unknown: boolean }
type Thing = {
	name: string
	kind: "scope" | "compute" | "effect"
	parent?: Thing
	alive: boolean
	r: Request
	same: (a: unknown, b: unknown) => boolean
	wait?: { p: string; e?: unknown; state: "made" | "ran" | "settled" | "landed"; result?: Result }
	sets: boolean
	setv: unknown
	setLast: unknown
	logs: boolean
	acted: unknown
	sync: boolean
	want: unknown[][]
	actLast: unknown
	cleanups: unknown[]
	goneAt?: number
}
type Told = { started: number; due: boolean; ended?: string }

const isMap = (x: unknown): x is Record<string, any> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const ASKS = new Set(["get", "log", "moments", "tick", "started", "forgotten", "current"])

type Ctx = {
	look: (key: string) => unknown
	write?: (key: string, v: unknown) => void
	known: (name: string) => boolean
}
function ev(e: unknown, c: Ctx): unknown {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map((x) => ev(x, c))
	const fail = (): never => {
		throw new Fail()
	}
	const unknown = (): never => {
		throw new Unknown()
	}
	const keys = Object.keys(e)
	if (keys.length !== 1) return keys.length ? unknown() : fail()
	const arg = (e as Record<string, unknown>)[keys[0]]
	const a = Array.isArray(arg) ? arg : []
	const args = (n: number, m = n) =>
		Array.isArray(arg) && arg.length >= n && arg.length <= m ? arg : unknown()
	const num = (v: unknown, or: () => never) => v === null ? 0 : typeof v === "number" ? v : or()
	switch (keys[0]) {
		case "read": {
			const k = ev(arg, c)
			return typeof k === "string" ? c.look(k) : unknown()
		}
		case "sum":
			return args(0, Infinity).reduce((n: number, x) => n + num(ev(x, c), fail), 0)
		case "mod": {
			args(2)
			const x = num(ev(a[0], c), unknown), y = num(ev(a[1], c), unknown)
			return y === 0 ? fail() : x % y
		}
		case "eq":
			args(2)
			return json(ev(a[0], c), ev(a[1], c))
		case "if":
			args(3)
			return ev(a[0], c) === true ? ev(a[1], c) : ev(a[2], c)
		case "log":
			return ev(arg, c)
		case "do": {
			let v: unknown = null
			for (const x of args(0, Infinity)) v = ev(x, c)
			return v
		}
		case "write": {
			args(2, 3)
			if (!c.write) return unknown()
			const k = ev(a[0], c), v = ev(a[1], c)
			if (typeof k !== "string") return unknown()
			if (a.length > 2 && a[2] !== null && a[2] !== "open" && !c.known(a[2] as string)) fail()
			c.write(k, v)
			return v
		}
		case "throw": {
			const v = ev(arg, c)
			return typeof v === "string" ? fail() : unknown()
		}
		case "pending":
			throw new Pending()
		case "wait":
			args(1, 2)
			throw new Pending()
		case "quote":
			return arg
		case "compute":
		case "effect":
			return typeof args(1, 4)[0] === "string" ? null : fail()
		case "cleanup":
			args(2)
			return null
		case "given":
		case "run":
		case "in":
		case "scope":
		case "within":
		case "current":
		case "dispose":
			return unknown()
		default:
			return fail()
	}
}
function attempt(f: () => unknown): Result {
	try {
		return { ok: true, v: f() }
	} catch (e) {
		if (e instanceof Fail || e instanceof Pending) {
			return { ok: false, unknown: e instanceof Pending }
		}
		if (e instanceof Unknown) return { ok: false, unknown: true }
		throw e
	}
}

const info = (x: unknown) =>
	typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length > 0
const text = (x: unknown) => typeof x === "string"
function shaped(r: Request): boolean {
	switch (r.op) {
		case "root":
			return text(r.name) && info(r.info)
		case "scope":
			return text(r.name) && text(r.parent) && info(r.info)
		case "compute":
			return text(r.name) && text(r.scope) && "f" in r && (r.to === undefined || text(r.to))
		case "effect":
			return text(r.name) && text(r.scope) && "f" in r && "act" in r
		case "cleanup":
			return text(r.scope) && "do" in r
		case "dispose":
			return text(r.scope)
		case "run":
			return text(r.scope) && "do" in r
		case "write":
			return isMap(r.values)
		case "changed":
			return Array.isArray(r.keys)
		case "resolve":
		case "reject":
			return text(r.promise)
		case "get":
			return text(r.key)
		default:
			return true
	}
}

function invariant(
	stream: Request[],
	answers: (Answer | undefined)[],
): Promise<Violation[]> {
	const out: Violation[] = []
	let at = 0
	const bad = (kind: string, why: string) => out.push({ kind, at, why })
	const things = new Map<string, Thing>()
	const told = new Map<string, Told>()
	const store = new Map<string, unknown>()
	const promises = new Set<string>()
	let lost = false
	let tick = 0, exact = true
	const quiet: Record<string, boolean> = {
		moments: true,
		log: true,
		started: true,
		forgotten: true,
	}
	let dirty = false
	let fired: unknown[] = []
	let hidden = false
	let asked = -1

	const value = (k: string) => {
		const v = store.get(k)
		if (v === UNKNOWN) throw new Unknown()
		return v === undefined ? null : v
	}
	const known = (n: string) => {
		const t = things.get(n)
		return t !== undefined && t.kind !== "scope"
	}
	const taken = (n: unknown) => things.get(n as string)?.alive === true
	const under = (t: Thing, o: Thing) => {
		for (let x: Thing | undefined = t; x; x = x.parent) if (x === o) return true
		return false
	}
	const keep = (t: Thing, r: Result) => {
		const to = t.r.to as string | undefined
		if (r.ok) {
			if (to !== undefined) {
				const old = store.get(to)
				if (!store.has(to) || old === UNKNOWN || !t.same(old, r.v)) store.set(to, r.v)
			}
			if (t.sets) t.setv = r.v
		} else if (r.unknown) {
			if (to !== undefined) store.set(to, UNKNOWN)
			if (t.sets) t.setv = UNKNOWN
		}
	}

	function pulse() {
		for (const t of things.values()) {
			if (t.wait?.state === "settled") {
				t.wait.state = "landed"
				if (t.alive) keep(t, t.wait.result!)
			}
		}
		for (const t of things.values()) if (t.wait?.state === "made" && t.alive) t.wait.state = "ran"
		const writers = new Map<string, Thing>()
		for (const t of things.values()) {
			if (t.kind === "compute" && t.alive && !t.wait && typeof t.r.to === "string") {
				writers.set(t.r.to, t)
			}
		}
		const memo = new Map<Thing, Result>()
		const result = (t: Thing): Result => {
			let r = memo.get(t)
			if (r) return r
			memo.set(t, { ok: false, unknown: true })
			r = attempt(() => ev(t.r.f, { look, known }))
			memo.set(t, r)
			return r
		}
		const look = (k: string) => {
			const t = writers.get(k)
			const r = t && result(t)
			if (r && r.ok) return r.v
			if (r && r.unknown) throw new Unknown()
			return value(k)
		}
		for (const t of writers.values()) keep(t, result(t))
		for (const t of things.values()) {
			if (t.kind !== "effect" || !t.alive || !t.logs) continue
			const r = attempt(() => ev(t.r.f, { look: value, known }))
			if (!r.ok) {
				if (r.unknown) t.sync = false
				continue
			}
			if (!t.sync || (t.acted !== NONE && t.same(r.v, t.acted))) continue
			t.want.push([t.name, r.v, t.acted === NONE ? null : t.acted])
			t.acted = r.v
		}
	}

	const refused = (a: Answer, want: boolean, why: string) => {
		const got = typeof a.error === "string"
		if (got === want) return
		bad(
			`refused: ${stream[at].op}`,
			`${line(stream[at])}: ${got ? `refused (${a.error})` : `answered ${line(a)}`}, ${why}`,
		)
		lost = true
	}
	const answered = (a: Answer, want: unknown, what: string) => {
		const d = differs(a, want)
		if (d) bad(what, `${line(stream[at])}: ${line(a)}, not ${line(want)}`)
	}
	const ticked = (got: unknown, step: number) => {
		if (typeof got !== "number" || (exact ? got !== tick + step : got < tick + step)) {
			bad(
				"tick",
				`${line(stream[at])}: tick ${line(got)}, ${exact ? "not" : "below"} ${tick + step}`,
			)
		}
		if (typeof got === "number") tick = got, exact = true
	}
	const making = (r: Request, a: Answer): Thing | undefined => {
		const o = things.get(r.scope)
		refused(
			a,
			!o || !o.alive || taken(r.name),
			o ? `${r.scope} ${o.alive ? "there" : "gone"}` : `no ${r.scope}`,
		)
		if (lost || !o || !o.alive) return
		tick++
		const t: Thing = {
			name: r.name,
			kind: r.op as "compute" | "effect",
			parent: o,
			alive: true,
			r,
			same: r.equal === "json" ? json : Object.is,
			sets: false,
			setv: NONE,
			setLast: NONE,
			logs: false,
			acted: NONE,
			sync: true,
			want: [],
			actLast: NONE,
			cleanups: [],
		}
		things.set(r.name, t)
		return t
	}

	for (at = 0; at < stream.length && !lost; at++) {
		const r = stream[at], a = answers[at]
		if (!isMap(a)) break
		if (!shaped(r)) break
		if (!ASKS.has(r.op) && (r.op !== "pulse" || dirty)) {
			for (const k in quiet) quiet[k] = false
		}
		if (!ASKS.has(r.op) && r.op !== "pulse") dirty = true
		switch (r.op) {
			case "root":
			case "scope": {
				const up = r.op === "scope" ? things.get(r.parent) : undefined
				if (!info(r.info) || (r.op === "scope" && !up)) {
					lost = true
					break
				}
				refused(a, taken(r.name) || (up !== undefined && !up.alive), "a scope")
				if (lost) break
				things.set(r.name, {
					name: r.name,
					kind: "scope",
					parent: up,
					alive: true,
					r,
					same: Object.is,
					sets: false,
					setv: NONE,
					setLast: NONE,
					logs: false,
					acted: NONE,
					sync: true,
					want: [],
					actLast: NONE,
					cleanups: [],
				})
				break
			}
			case "compute": {
				const set = r.set
				const sets = set !== undefined &&
					isMap(set) && Array.isArray(set.log) && set.log.length === 3 &&
					set.log[0] === "set" &&
					set.log[1] === r.name && set.log[2]?.given === "value"
				if (set !== undefined && !sets) {
					lost = true
					break
				}
				const t = making(r, a)
				if (!t) break
				t.sets = sets
				const w = isMap(r.f) && Object.keys(r.f).length === 1 && Array.isArray(r.f.wait)
					? r.f.wait
					: undefined
				if (w) t.wait = { p: w[0], e: w.length > 1 ? w[1] : undefined, state: "made" }
				break
			}
			case "effect": {
				const act = r.act
				const logs = isMap(act) && Array.isArray(act.log) && act.log.length === 3 &&
					act.log[0] === r.name && act.log[1]?.given === "value" &&
					act.log[2]?.given === "previous"
				const sink = isMap(act) && Array.isArray(act.write) && typeof act.write[0] === "string"
					? act.write[0]
					: undefined
				if (!logs && sink === undefined) {
					lost = true
					break
				}
				const t = making(r, a)
				if (!t) break
				t.logs = logs
				if (r.early === true) t.sync = false
				if (sink !== undefined) {
					store.set(sink, UNKNOWN)
					if (r.early === true) exact = false
				}
				break
			}
			case "cleanup": {
				const o = things.get(r.scope)
				refused(a, !o || !o.alive, "a cleanup")
				if (lost || !o) break
				const log = isMap(r.do) && Object.keys(r.do).length === 1 ? r.do.log : undefined
				const v = o.kind === "scope" && log !== undefined
					? attempt(() => ev(log, { look: value, known }))
					: undefined
				if (v?.ok) o.cleanups.push(v.v)
				else hidden = true
				break
			}
			case "dispose": {
				const o = things.get(r.scope)
				refused(a, !o, "a dispose")
				if (lost || !o || !o.alive) break
				for (const t of things.values()) {
					if (!t.alive || !under(t, o)) continue
					t.alive = false
					t.goneAt = at
					fired.push(...t.cleanups)
				}
				break
			}
			case "run": {
				const o = things.get(r.scope)
				if (o && o.kind !== "scope") {
					lost = true
					break
				}
				if (!o || !o.alive) {
					refused(a, true, o ? "gone" : "no scope")
					break
				}
				let v: unknown, how = "value"
				try {
					v = ev(r.do, {
						look: value,
						known,
						write: (k, v) => {
							store.set(k, v)
							tick++
						},
					})
				} catch (e) {
					how = e instanceof Fail ? "fails" : e instanceof Pending ? "pending" : "unknown"
					if (!(e instanceof Fail || e instanceof Pending || e instanceof Unknown)) throw e
				}
				if (how === "unknown") {
					lost = true
					break
				}
				refused(a, how === "fails", `it ${how === "fails" ? "fails" : "gives a value"}`)
				if (lost || how === "fails") break
				answered(a, how === "value" ? { value: v } : {}, "run")
				if (how === "pending" && isMap(r.do) && Array.isArray(r.do.wait)) {
					promises.add(r.do.wait[0])
				}
				break
			}
			case "write": {
				if (!isMap(r.values)) {
					lost = true
					break
				}
				for (const [k, v] of Object.entries(r.values)) store.set(k, v)
				ticked(a.tick, 1)
				break
			}
			case "changed": {
				const strings = Array.isArray(r.keys) &&
					r.keys.every((k: unknown) => typeof k === "string")
				refused(a, !strings, "keys")
				if (strings) ticked(a.tick, 1)
				break
			}
			case "pulse":
				refused(a, false, "a pulse")
				if (dirty) exact = false
				dirty = false
				pulse()
				break
			case "resolve":
			case "reject": {
				const t = [...things.values()].find((t) =>
					t.wait?.p === r.promise && t.wait?.state === "ran"
				)
				refused(a, !t && !promises.has(r.promise), "a promise")
				promises.delete(r.promise)
				if (!t) break
				const w = t.wait!
				w.state = "settled"
				w.result = r.op === "reject"
					? { ok: false, unknown: false }
					: w.e === undefined
					? { ok: true, v: r.value ?? null }
					: attempt(() => ev(w.e, { look: value, known }))
				break
			}
			case "get": {
				if (store.get(r.key) !== UNKNOWN) answered(a, { value: value(r.key) }, "value")
				break
			}
			case "current":
				answered(a, { value: null }, "current")
				break
			case "tick":
				ticked(a.tick, 0)
				break
			case "started":
			case "forgotten":
				if (quiet[r.op] && Array.isArray(a.keys) && a.keys.length) {
					bad(`quiet: ${r.op}`, `${line(a)}, with nothing done since asked`)
				}
				quiet[r.op] = true
				break
			case "moments":
				moments(a.moments)
				quiet.moments = true
				asked = at
				break
			case "log":
				log(a.log)
				quiet.log = true
				break
			default:
				lost = true
		}
	}
	return Promise.resolve(firsts(out))

	function moments(ms: unknown) {
		if (!Array.isArray(ms)) return bad("moments", `${line(ms)}: no list`)
		if (quiet.moments && ms.length) {
			bad("quiet: moments", `${line(ms)}, with nothing done since asked`)
		}
		for (const m of ms) {
			if (!isMap(m)) continue
			const name = m.due ?? m.starts ?? m.ends ?? m.acts
			if (typeof name !== "string") continue
			const t = things.get(name)
			let c = told.get(name)
			if (!c) told.set(name, c = { started: 0, due: false })
			const say = (kind: string, why: string) => bad(`moments: ${kind}`, `${line(m)}: ${why}`)
			if (t?.goneAt !== undefined && t.goneAt < asked) say("gone", "gone")
			if ("due" in m) c.due = true
			else if ("starts" in m) {
				if (m.run !== c.started + 1 && (t !== undefined || m.run !== 1)) {
					say("run count", `after run ${c.started}`)
				}
				if (!c.due && c.ended !== "stopped") {
					say("no reason", "never made due since its last run")
				}
				if (t?.wait && m.run > 1) say("waits again", "a compute that tracks nothing runs again")
				c.due = false, c.started = m.run, c.ended = undefined
			} else if ("ends" in m) {
				if (!(m.run >= 1 && m.run <= c.started)) {
					say("end", `ends a run not started (${c.started})`)
				}
				if (m.ended === "looping" || "through" in m) say("loop", "a loop where none can be")
				c.ended = m.ended
			} else if ("acts" in m) {
				if (t !== undefined && t.kind !== "effect") say("act", "a compute acts")
				if (!(m.run >= 1 && m.run <= c.started)) {
					say("act", `acts on a run not started (${c.started})`)
				}
			}
		}
	}

	function log(entries: unknown) {
		if (!Array.isArray(entries)) return bad("log", `${line(entries)}: no list`)
		if (quiet.log && entries.length) {
			bad("quiet: log", `${line(entries)}, with nothing done since asked`)
		}
		const acts = new Map<Thing, unknown[][]>()
		const cleanups: string[] = []
		for (const e of entries) {
			if (!Array.isArray(e)) continue
			const t = things.get(e[1])
			if (e[0] === "set" && e.length === 3 && t?.sets) {
				if (t.setLast !== NONE && t.same(t.setLast, e[2])) {
					bad("set again", `${t.name} set ${line(e[2])}, the value it had`)
				}
				t.setLast = e[2]
				continue
			}
			const u = things.get(e[0])
			if (e.length === 3 && u?.logs) {
				if (u.actLast === NONE ? e[2] !== null : differs(e[2], u.actLast)) {
					bad(
						"previous",
						`${line(e)}: previous not ${u.actLast === NONE ? "null" : line(u.actLast)}`,
					)
				}
				if (u.actLast !== NONE && u.same(e[1], u.actLast)) {
					bad("act again", `${line(e)}: the value it acted on`)
				}
				u.actLast = e[1]
				acts.set(u, [...acts.get(u) ?? [], e])
				continue
			}
			if (e[0] === "cleanup") cleanups.push(line(e))
		}
		const fire = fired.map((x) => line(x))
		if (!hidden && !json(cleanups.sort(), fire.sort())) {
			bad("cleanup", `cleanups ${cleanups.join(" ")}, not ${fire.join(" ")}`)
		}
		fired = []
		for (const t of things.values()) {
			if (t.sets && t.setv !== UNKNOWN) {
				const right = t.setv === NONE
					? t.setLast === NONE
					: t.setLast !== NONE && t.same(t.setLast, t.setv)
				if (!right) {
					bad(
						"set",
						`${t.name} set ${t.setLast === NONE ? "nothing" : line(t.setLast)} last, not ${
							t.setv === NONE ? "nothing" : line(t.setv)
						}`,
					)
				}
			}
			if (t.logs) {
				const got = acts.get(t) ?? []
				if (t.sync && differs(got, t.want)) {
					bad("act", `${t.name} acted ${line(got)}, not ${line(t.want)}`)
				}
				t.want = [], t.acted = t.actLast, t.sync = true
			}
		}
	}
}
