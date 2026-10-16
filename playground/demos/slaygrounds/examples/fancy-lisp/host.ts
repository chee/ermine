// fancy-lisp's host: the world (@ermine/slaygrounds/world), one process, lisp, running program.ts,
// and one tool the api does not say (extend, below): a walk up the way a frame was reached, with a
// ceiling and the frames visited told
import { createWorld } from "@ermine/slaygrounds/world"
import type { API, Node } from "@ermine/api"
import { get } from "@ermine/places/lib"
import { render } from "ermine-h"

export type Extra = {
	// places' lookup, written out: the nearest place walking up from `from` (names from the root)
	// where the address is, or none. from itself first, then each folder above it, down to the
	// depth stop (names kept: stop 1 leaves the root out). walk: an array the ids of the places
	// visited are pushed to, deepest first, ending where it was found. what it reads is tracked as
	// any read in a run. its node says its id, and its parent's (the place it was found in)
	up: (
		address: string[],
		from: string[],
		options?: { stop?: number; walk?: string[] },
	) => (Node & { id: string; parent: string }) | undefined
}

const world = createWorld({
	render,
	processes: [{ name: "lisp" }],
	actor: "you@laptop",
	extend: (_api: API, ctx): Extra => ({
		up(address, from, { stop = 0, walk } = {}) {
			for (let k = from.length; k >= stop; k--) {
				const here = k === 0 ? ctx.places.root : get(ctx.places, from.slice(0, k))
				if (typeof here !== "string") continue
				walk?.push(here)
				const path = [...from.slice(0, k), ...address]
				const id = get(ctx.places, path)
				if (typeof id === "string") return { path, part: "value", id, parent: here }
			}
		},
	}),
})

export const reload = world.reload
