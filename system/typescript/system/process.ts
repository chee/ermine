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

// public (mod.ts exports them): each runs its implementation below, named with As, as the
// context it finds (acting.ts' go)
export const addTeardown: System["addTeardown"] = /* @__PURE__ */ marked((fn) =>
	go("addTeardown", false, addTeardownAs, fn)
)
export const getArgs: System["getArgs"] = /* @__PURE__ */ marked(() =>
	go("getArgs", false, getArgsAs)
)
// a writer for a function to run later as this one, with nothing open: createWriter in setup or an
// action. it writes nothing itself, but is entered: its frame is under its owner's
export const createWriter: System["createWriter"] = /* @__PURE__ */ marked(() =>
	go("createWriter", true, createWriterAs)
)
// a process running fn at at, belonging to the scope that started it: setup, an action, a writer
export const start: System["start"] = /* @__PURE__ */ marked((fn, at, options) =>
	go("start", true, startAs, fn, at, options)
)

// why a teardown's scope goes: a stop's reason; else, the process still there, its owner ran
// again (replaced), or ended
export function addTeardownAs(inner: Inner, fn: (why: Why) => unknown) {
	const own = owner(inner)
	notInAct(own, "addTeardown")
	notInAction(inner, own)
	teardown(inner, own, fn)
}

const notData = () => new ErmineError("not-a-value", "a writer is not data: it won't serialize")

// createWriter(): in setup or an action
export function createWriterAs(inner: Inner): WithWriter {
	const { base, parts } = here(inner)
	const own = owner(inner)
	notHere(
		base,
		own,
		"createWriter in a memo or effect: create it in setup or an action, and use the writer there",
	)
	const mark = markOf(inner, own)
	// the writer's own frame, under its owner's
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

// start(fn, at, { args }): a process running fn at at [chee 10-27: "processes should be able to start
// and stop processes"]. asked as the starter, as placing at is ("place" on the folder). it belongs to
// the scope that started it (setup's: the starter's; an action's: the scope that placed it; a writer's:
// its parent): it stops as that ends. it is told nothing of its parent. not in a compute or an
// act (a compute would start it every run; an act makes nothing). stop() is asked as
// the starter is, wherever it is called. taken: { refused: "taken", at } only: whose it is (a
// stopped process held by a feature) is for the host's start [holding an id is the permission]
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
	// the folder it is placed in, or the nearest one above that is there (the rest are made)
	const asked = () => {
		for (let n = path.length - 1; n >= 0; n--) {
			const folder = get(places, path.slice(0, n))
			if (folder !== undefined) return ask("place", slotAt(path.slice(0, n + 1), folder))
		}
	}
	// stop() is asked as the starter is, wherever it is called from
	const mark = markOf(inner, own)
	const asStarter = () => runAs(inner, own, mark, asked)
	asked()
	const made = base.start(fn, path, { args: options.args, places }, own)
	// a program gets where the path is held, never whose it is (an id is the permission)
	if ("refused" in made) return { refused: "taken", at: made.at }
	const id = made.process.id
	return {
		process: { at: made.process.at, folder: made.process.folder },
		// the node unplaced, as unplace asks it
		stop: (why) => {
			if (!base.processes.has(id)) return
			asStarter()
			made.stop(why)
		},
		status: () => context.within(() => getStatusAs(inner, byId(inner, id, "value"))),
	}
}

export const getArgsAs = (inner: Inner): readonly string[] => inner.context.args
