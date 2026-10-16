// trust's host: the world (@ermine/slaygrounds/world) and one process, vault, running program.ts.
// whether a person did something is never handed in: the world reads the window's own event, through
// the native getter it kept before any program ran, and a send carries it as ["trusted", …]
import { get } from "@ermine/places/lib"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

type Pairs = readonly (readonly [string, unknown])[]

// the nearest value of key in pairs, walking outward through the "owner" links (getInfo nests: the
// open scope's pairs, then ["owner", the owner's info], down to the root)
function nearest(pairs: Pairs | undefined, key: string): unknown {
	for (let p = pairs; p !== undefined;) {
		let up: Pairs | undefined
		for (const [k, v] of p) {
			if (k === key) return v
			if (k === "owner") up = v as Pairs
		}
		p = up
	}
}

const world = createWorld({
	render,
	processes: [{ name: "vault" }],
	// two tools, both reads of what the graph already says, the api has no name for them:
	// who(pairs?): the caller and trusted of the call this code runs in (or of pairs, a change's)
	// change(node): the latest change of a node's value (who wrote it, its metadata: the pairs of
	// the scopes it was written in), tracked: any write to the node reruns what read it
	extend: (_api, ctx) => ({
		who(pairs: Pairs | undefined = ctx.scheduler.getInfo()) {
			return { caller: nearest(pairs, "caller"), trusted: nearest(pairs, "trusted") === true }
		},
		change(x: { path?: readonly string[] }) {
			const id = x.path && get(ctx.places, [...x.path])
			return id === undefined ? undefined : ctx.places.readChange("value", id)
		},
	}),
})

export const reload = world.reload
