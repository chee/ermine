import type { Path } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { userActivated } from "../useractivation.ts"
import { ErmineError } from "../features.ts"
import type { Inner, Why } from "../context.ts"
import { go } from "../acting.ts"
import { marked } from "../site.ts"
import { byId, slotAt } from "./addressing.ts"
import { markOf, notHere, notInAct, notInAction, owner, runAs, teardown } from "./scopes.ts"
import { here } from "./setting.ts"
import type { Starting, System, Taken, WithWriter } from "./shapes.ts"
import { getStatusAs } from "./status.ts"

export const addTeardown: System["addTeardown"] = /* @__PURE__ */ marked(function addTeardown(fn) {
	return go(addTeardown, "addTeardown", false, addTeardownAs, fn)
})
export const getArgs: System["getArgs"] = /* @__PURE__ */ marked(function getArgs() {
	return go(getArgs, "getArgs", false, getArgsAs)
})
export const createWriter: System["createWriter"] = /* @__PURE__ */ marked(function createWriter() {
	return go(createWriter, "createWriter", true, createWriterAs)
})
export const start: System["start"] = /* @__PURE__ */ marked(function start(fn, at, options) {
	return go(start, "start", true, startAs, fn, at, options)
})

export function addTeardownAs(inner: Inner, fn: (why: Why) => unknown) {
	const own = owner(inner)
	notInAct(own, "addTeardown")
	notInAction(inner, own)
	teardown(inner, own, fn)
}

const notData = () => new ErmineError("not-a-value", "a writer is not data: it won't serialize")

export function createWriterAs(inner: Inner): WithWriter {
	const { base, parts } = here(inner)
	const own = owner(inner)
	notHere(
		base,
		own,
		"createWriter in a memo or effect: create it in setup or an action, and use the writer there",
	)
	const mark = markOf(inner, own)
	const frame = parts.scheduler.createFrame({}, own.frame)
	const later = function (f: () => unknown) {
		const data = base.writers.get(later)!
		const { inner, parent } = data
		const { s, parts, scope } = here(inner)
		try {
			parts.alive()
			if (typeof f !== "function") {
				throw new ErmineError("not-a-function", "a writer takes a function")
			}
			if (s.getCurrentScope() !== undefined || s.getRun() !== undefined) {
				throw new ErmineError(
					"already-inside",
					"already inside a run: call it directly (a writer is for code that runs with nothing open)",
				)
			}
			if (parent.state !== "alive" || scope.state !== "alive") {
				throw new ErmineError("gone", "gone: what this writer was created in has ended")
			}
		} catch (e) {
			throw base.errored(e, "createWriter")
		}
		return runAs(inner, parent, data.mark, f, userActivated(), data.frame)
	} as unknown as WithWriter & { toJSON: () => never }
	Object.defineProperties(later, {
		toJSON: {
			value: () => {
				throw base.errored(notData(), "createWriter")
			},
		},
		[Symbol.toPrimitive]: {
			value: () => {
				throw base.errored(notData(), "createWriter")
			},
		},
		[Symbol.for("Deno.customInspect")]: { value: () => "[writer]" },
	})
	Object.freeze(later)
	base.writers.set(later, { inner, parent: own, mark, frame })
	return later
}

// start(fn, at, { args }) is asked as the starter, like placing at `at`. The process belongs to the
// scope that started it and stops when that ends. Refused only as { refused: "taken", at }.
export function startAs(
	inner: Inner,
	fn: () => unknown,
	at: string | Path,
	options: { args?: readonly string[] } = {},
): Starting | Taken {
	const { base, places, resolve, ask, context } = here(inner)
	const own = owner(inner)
	notHere(base, own, "start in a memo or effect: start a process in setup or an action")
	if (typeof fn !== "function") {
		throw new ErmineError("not-a-function", "start takes the program: its function")
	}
	const path = resolve(at)
	const asked = () => {
		for (let n = path.length - 1; n >= 0; n--) {
			const folder = get(places, path.slice(0, n))
			if (folder !== undefined) return ask("place", slotAt(path.slice(0, n + 1), folder))
		}
	}
	const mark = markOf(inner, own)
	const asStarter = () => runAs(inner, own, mark, asked)
	asked()
	const made = base.start(fn, path, { args: options.args, places }, own)
	if ("refused" in made) return { refused: "taken", at: made.at }
	const id = made.process.id
	return {
		process: { at: made.process.at, folder: made.process.folder },
		stop: (why) => {
			if (!base.processes.has(id)) return
			asStarter()
			made.stop(why)
		},
		status: () => context.within(() => getStatusAs(inner, byId(inner, id, "value"))),
	}
}

export const getArgsAs = (inner: Inner): readonly string[] => inner.context.args
