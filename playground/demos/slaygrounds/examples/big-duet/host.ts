// big-duet's host: the world and four processes from one module: duet owns the text, cherry and mint
// are one export (person) placed twice, each told its name by args, and the poet
import { createWorld } from "@ermine/slaygrounds/world"
import * as lib from "@ermine/places/lib"
import { render } from "ermine-h"

// the first value of a key in a change's flat pairs, innermost first
const nearest = (pairs: readonly (readonly [string, unknown])[], key: string): unknown =>
	pairs.find(([k]) => k === key)?.[1]

const world = createWorld({
	render,
	processes: [
		{ name: "duet" },
		{ name: "cherry", export: "person", args: ["cherry"] },
		{ name: "mint", export: "person", args: ["mint"] },
		{ name: "poet", export: "poet" },
	],
	// change(x): the last change of x's value, as a program wants it: its patches and who called, by
	// name. a send's scope says ["caller", <process id>] in its pairs; the host knows
	// which process that is. read in a run, so tracked
	extend: (api, ctx) => ({
		change(x: string | { path?: readonly string[] }) {
			const path = (typeof x === "string" ? api.open(x) : x).path
			const id = path && lib.get(ctx.places, path)
			const c = id === undefined ? undefined : ctx.places.readChange("value", id)
			if (!c) return undefined
			const caller = nearest(c.metadata ?? [], "caller")
			const procs = (globalThis as any).ermine.processes as Map<string, { id: unknown }>
			const who = [...procs].find(([, p]) => p.id === caller)?.[0]
			return { patches: c.op?.patches ?? [], caller: who }
		},
	}),
})
export const reload = world.reload
