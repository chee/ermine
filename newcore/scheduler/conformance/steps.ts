// programs as data, for the scheduler's conformance: a program is a map of parts, each a list of
// steps, told apart by its keys: {setup} a setup, {compute} a compute, {compute, effect} an
// effect. Any implementation runs them the same way; this one gives scheduler.ts their code.
//
// a step is a map whose "do" says what it is; its fields are expressions, evaluated before it
// runs. "var" (where given) names where its answer goes. each part, handler call and cleanup has
// its own variables; a cleanup or a $steps function starts with a copy of its maker's.
//
//   {"do":"let","var":v,"value":e}
//   {"do":"return","value":e?}                    ends the part with e (none: null)
//   {"do":"pending"}                              ends a compute pending
//   {"do":"log","value":e}                        appended to the harness's log
//   {"do":"throw","code":s}                       ends the part with an error of that code
//   {"do":"if","test":e,"then":[..],"else":[..]?}
//   {"do":"cleanup","steps":[..]}                 onCleanup; told killed as {"$given":"killed"}
//   {"do":"start","address":e,"program":e,...}    name, id, args; var: the pid
//   {"do":"call","address":e,"args":e?}           var: the handler's answer
//   {"do":op,...,"peep":b?}                       op: an interface's (normal.ts), as the harness's
//
// an expression: any JSON, a list or map evaluated member by member, except a map of one key
// starting with "$":
//   {"$var":v}          a variable; none: null
//   {"$given":f}        a field the part was given: value, previous, args, self, name, killed
//   {"$get":[e,k...]}   down e by keys; missing: null
//   {"$add":[a,b]}  {"$eq":[a,b]}  {"$not":e}  {"$len":e}
//   {"$steps":[..]}     a function (live): a handler; called with what a handler call is given
//   {"$quote":x}        x as it is
import type { Code } from "../scheduler.ts"
import { PENDING } from "../scheduler.ts"
import { json, operate } from "./normal.ts"

export class Thrown extends Error {
	constructor(readonly code: string) {
		super(code)
	}
}

class Return {
	constructor(readonly value: unknown) {}
}
class Wait {}

// deno-lint-ignore no-explicit-any
type Given = Record<string, any>
type Vars = Map<string, unknown>

export type Log = (value: unknown) => void

function evaluate(e: unknown, given: Given, vars: Vars, log: Log): unknown {
	if (Array.isArray(e)) return e.map((x) => evaluate(x, given, vars, log))
	if (e === null || typeof e !== "object") return e
	const keys = Object.keys(e)
	if (keys.length === 1 && keys[0].startsWith("$")) {
		const k = keys[0]
		const a = (e as Record<string, unknown>)[k]
		const ev = (x: unknown) => evaluate(x, given, vars, log)
		switch (k) {
			case "$var":
				return vars.has(a as string) ? vars.get(a as string) : null
			case "$given": {
				const v = given[a as string]
				return v === undefined ? null : json(v)
			}
			case "$get": {
				const [first, ...path] = a as unknown[]
				let v = ev(first)
				for (const key of path.map(ev)) {
					if (v === null || typeof v !== "object") return null
					v = (v as Record<string, unknown>)[key as string]
					if (v === undefined) return null
				}
				return v
			}
			case "$add": {
				const [x, y] = (a as unknown[]).map(ev)
				return (x as number) + (y as number)
			}
			case "$eq": {
				const [x, y] = (a as unknown[]).map(ev)
				return JSON.stringify(x) === JSON.stringify(y)
			}
			case "$not":
				return !ev(a)
			case "$len": {
				const v = ev(a)
				return Array.isArray(v) || typeof v === "string" ? v.length : 0
			}
			case "$steps": {
				const steps = a as unknown[]
				const mine = new Map(vars)
				return (g: Given) => part(steps, g, new Map(mine), log)
			}
			case "$quote":
				return a
		}
		throw new Thrown("not-a-step")
	}
	const out: Record<string, unknown> = {}
	for (const k of keys) out[k] = evaluate((e as Record<string, unknown>)[k], given, vars, log)
	return out
}

function steps(list: unknown[], given: Given, vars: Vars, log: Log) {
	for (const raw of list) {
		const s = raw as Record<string, unknown>
		const ev = (x: unknown) => evaluate(x, given, vars, log)
		const set = (v: unknown) => {
			if (typeof s.var === "string") vars.set(s.var, v)
		}
		switch (s.do) {
			case "let":
				vars.set(s.var as string, ev(s.value))
				break
			case "return":
				throw new Return(s.value === undefined ? null : ev(s.value))
			case "pending":
				throw new Wait()
			case "log":
				log(ev(s.value))
				break
			case "throw":
				throw new Thrown(String(ev(s.code)))
			case "if":
				if (ev(s.test)) steps((s.then ?? []) as unknown[], given, vars, log)
				else steps((s.else ?? []) as unknown[], given, vars, log)
				break
			case "cleanup": {
				const body = s.steps as unknown[]
				const mine = new Map(vars)
				given.onCleanup((g: Given) => part(body, { ...given, ...g }, new Map(mine), log))
				break
			}
			case "start": {
				const op: Record<string, unknown> = {
					address: ev(s.address),
					program: program(ev(s.program), log),
				}
				for (const f of ["name", "id", "args"]) if (s[f] !== undefined) op[f] = ev(s[f])
				set(given.start(op).id)
				break
			}
			case "call":
				set(json(given.call(ev(s.address), s.args === undefined ? undefined : ev(s.args))))
				break
			default: {
				const api = s.peep ? given.peep : given.api
				const fields: Record<string, unknown> = {}
				for (const [k, v] of Object.entries(s)) {
					if (k !== "do" && k !== "var" && k !== "peep") fields[k] = ev(v)
				}
				set(operate(api, s.do as string, fields))
			}
		}
	}
}

// a part: its steps run; what it returns, or pending
function part(list: unknown[], given: Given, vars: Vars, log: Log): unknown {
	try {
		steps(list, given, vars, log)
		return null
	} catch (e) {
		if (e instanceof Return) return e.value
		if (e instanceof Wait) return PENDING
		throw e
	}
}

// a program's code; a path (a list) is a path, as it is
export function program(p: unknown, log: Log): unknown {
	if (Array.isArray(p)) return p
	return load(p, log)
}

export function load(p: unknown, log: Log): Code {
	if (p === null || typeof p !== "object") throw new Thrown("not-a-program")
	const m = p as Record<string, unknown>
	const run = (body: unknown) => (g: Given) => part(body as unknown[], g, new Map(), log)
	if (Array.isArray(m.setup)) return run(m.setup) as Code
	if (Array.isArray(m.compute)) {
		const code: { compute: unknown; effect?: unknown } = { compute: run(m.compute) }
		if (Array.isArray(m.effect)) code.effect = run(m.effect)
		return code as Code
	}
	throw new Thrown("not-a-program")
}
