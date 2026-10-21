// handlers: how a den is asked to do things from the graph. the method nodes under its node (on/start
// and on/stop, each a function in the value of a node), and the ask another den makes of it. the
// same two things done two ways: a body from a node, a map from a den. which question: how it is told
//
// the den's children { on }, the folder on { start, stop } (method nodes: on/start's value (body) =>
// start's answer, on/stop's (body) => stop's)
// ask(a): another den's: as start or stop, its who given (device: the transport's). no policy:
// refused no "no policy". stop: of a process this den started; else not-there. a start's fields
// (an ask's, on/start's body's) as given, untyped: runner and at no address: []; program neither
// an address nor a map: { id: "" } (an id that is no string: ""); a step that is no string, args
// given that are no list of strings, a cwd given that is no address: PlacesError not-a-name
import createEntry from "@ermine/node/entry"
import type { Address } from "@ermine/boxes"
import { type Id, type Path, PlacesError } from "@ermine/places"
import { NODE } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import type { Inside } from "@ermine/processes/start"
import type { Answer, Target } from "@ermine/protect"
import { type Ctx, isMap, ours, STOPPED } from "./common.ts"
import { refuse } from "./policy.ts"
import type { createStart, NoPermission, Options, Program, Refused } from "./start.ts"

ours.add(import.meta.url)

// the folder a den's methods are in
export const ON = "on"

export type Ask =
	| {
		readonly op: "start"
		readonly who: unknown
		readonly runner: Address
		readonly program: Program
		readonly at: Address
		readonly args?: readonly string[]
		readonly cwd?: Address
	}
	| { readonly op: "stop"; readonly who: unknown; readonly process: Id; readonly reason?: unknown }
// a start's: { id, at }; a stop's: {}; or the refusal
export type Asked = { readonly id: Id; readonly at: Path } | Record<never, never> | Refused

const isNames = (x: unknown): x is string[] =>
	Array.isArray(x) && x.every((s) => typeof s === "string")

export type Deps = {
	readonly start: ReturnType<typeof createStart>
	readonly permit: (who: unknown, op: string, target: Target, remote: boolean) => Answer
	// the den's stop (start's, the den's own here's)
	readonly stop: (p: Id, reason?: unknown) => NoPermission | undefined
}

export function createHandlers(c: Ctx, { start: life, permit, stop }: Deps) {
	const { s, table, scopes, createScope, commit, headerOf } = c
	const { start, begin, halt } = life

	// the den's children { on }, the folder on { start, stop }, each a method node
	function methods(inside: Inside) {
		const folder: Id = `${String(inside.id)}/${ON}`
		commit(upsert(table, "children", inside.id, [ON], folder, headerOf()))
		const on = createScope({ den: ON, [NODE]: folder }, inside.scope)
		scopes.give(on, folder)
		const fns: Record<string, (body: unknown) => unknown> = { start: onStart, stop: onStop }
		const ids: Record<string, Id> = {}
		for (const [name, fn] of Object.entries(fns)) {
			const id: Id = `${String(folder)}/${name}`
			const m = createScope({ den: `${ON}/${name}`, [NODE]: id }, on)
			scopes.give(m, id)
			s.runWithScope(m, () => table.add("value", id, createEntry<unknown>(fn, headerOf())))
			ids[name] = id
		}
		s.runWithScope(on, () => table.add("children", folder, createEntry(ids, headerOf())))
	}

	// on/start: start's answer, the body's runner, program and at
	function onStart(body: unknown): unknown {
		const b = isMap(body) ? body : {}
		const { runner, program, at, options } = shaped(b)
		if (b.pin !== undefined) options.pin = b.pin
		const r = start(runner, program, at, options)
		return "refused" in r ? r : { id: r.id, at: r.at }
	}

	// a start's fields as an untyped caller gives them (another den's ask, on/start's body): runner
	// and at no address: []; program neither an address nor a map: { id: "" }; a step that is no
	// string, args given that are no list of strings, a cwd given that is no address: not-a-name
	function shaped(b: Record<string, unknown>) {
		const steps = (x: unknown): Address | undefined => {
			if (typeof x === "string") return x
			if (!Array.isArray(x)) return undefined
			if (isNames(x)) return x
			throw new PlacesError("not-a-name", String(x.find((s) => typeof s !== "string")))
		}
		const options: Options = {}
		if (b.args !== undefined) {
			if (!isNames(b.args)) throw new PlacesError("not-a-name", "args")
			options.args = b.args
		}
		if (b.cwd !== undefined) {
			const cwd = steps(b.cwd)
			if (cwd === undefined) throw new PlacesError("not-a-name", "cwd")
			options.cwd = cwd
		}
		const program: Address | Program = isMap(b.program)
			? b.program as Program
			: steps(b.program) ?? { id: "" }
		return { runner: steps(b.runner) ?? [], program, at: steps(b.at) ?? [], options }
	}

	// on/stop: stop's answer, the body's process and reason
	function onStop(body: unknown): unknown {
		const b = isMap(body) ? body : {}
		return stop(b.process as Id, b.reason) ?? {}
	}

	function askedBy(a: Ask): Asked {
		if (c.closed) return STOPPED
		if (a.op === "start") {
			const { runner, program, at, options } = shaped(a as unknown as Record<string, unknown>)
			const r = begin(a.who, true, runner, program, at, options)
			return "refused" in r ? r : { id: r.id, at: r.at }
		}
		if (a.op === "stop") {
			const p = c.byId.get(a.process)
			if (p === undefined || p.ended) return { refused: "not-there", process: a.process }
			const allowed = permit(a.who, "stop", { id: p.id, path: [...p.at] }, true)
			if (allowed.answer !== "yes") return refuse("stop", allowed)
			halt(p, a.reason)
			return {}
		}
		throw new TypeError(`not an ask: ${String((a as { op?: unknown }).op)}`)
	}
	return { methods, ask: askedBy }
}
